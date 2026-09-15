// 端到端验证「文档现状」这一栏在真实界面里是否真的能用。
// 上一次教训：界面上写着「可重试」但代码里没有——所以这里每一步都点真的按钮。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { JSDOM, VirtualConsole } from 'jsdom'

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const BASE = 'http://127.0.0.1:5173'

const WORK = path.join(os.tmpdir(), 'docwarden-ui-status')
fs.rmSync(WORK, { recursive: true, force: true })
fs.cpSync(path.join(ROOT, 'sample'), WORK, { recursive: true })

const vc = new VirtualConsole()
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) console.log('  [jsdomError] ' + e.message) })

const dom = new JSDOM(fs.readFileSync(ROOT + 'docwarden.ui.html', 'utf8'), {
  url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) {
    w.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      return fetch(url.startsWith('http') ? url : BASE + url, init)
    }
    w.alert = (m) => console.log('  [alert] ' + String(m).slice(0, 120))
    w.confirm = () => true
  },
})
const doc = dom.window.document
const $ = (id) => doc.getElementById(id)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(150) }
  throw new Error('等待超时：' + label)
}
const step2Pills = () => [...doc.querySelectorAll('#modTable tbody tr')].map((tr) => {
  const td = tr.querySelectorAll('td')
  return td[2].textContent.trim()
})
const statusRows = () => [...doc.querySelectorAll('#statusList tbody tr')].map((tr) => {
  const td = tr.querySelectorAll('td')
  return { name: td[0].textContent.trim(), status: td[1].textContent.trim(), note: td[2].textContent.trim() }
})
const statusOf = (name) => (statusRows().find((r) => r.name === name) || {}).status

const fails = []
const check = (ok, msg) => { console.log(`  ${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg) }

try {
  console.log('=== 1. 扫描后，第 2 步该显示「待生成」 ===')
  $('dir').value = WORK
  $('btnScan').click()
  await waitFor(() => doc.querySelectorAll('#modTable tbody tr').length > 0, 20000, '扫描')
  const p2 = step2Pills()
  check(p2.length === 4 && p2.every((x) => x === '待生成'), '4 个分组都标「待生成」（实际：' + p2.join('/') + '）')

  console.log('\n=== 2. 用演示模式生成并导出 ===')
  $('btnAll').click()
  $('btnGen').click()
  await waitFor(() => !$('btnGen').disabled, 90000, '生成')
  $('btnToPreview').click()
  $('btnExport').click()
  await waitFor(() => /已写入/.test($('exportInfo').textContent), 30000, '导出完成')
  await waitFor(() => statusRows().length > 0, 20000, '文档现状出现')
  const r1 = statusRows()
  console.log('  ' + r1.map((r) => r.name + '=' + r.status).join(' '))
  check(r1.length === 4 && r1.every((r) => r.status === '候选'), '导出后全部是「候选」')
  check($('statusSummary').textContent.includes('候选'), '顶部汇总也显示了候选数：' + $('statusSummary').textContent)

  console.log('\n=== 3. 点「标记为已验证」 ===')
  $('verifyBy').value = '测试员'
  const btn = doc.querySelector('#statusList [data-verify="order"][data-action="validate"]')
  check(!!btn, 'order 行上有「标记为已验证」按钮（而不是只有文字说明）')
  btn.click()
  await waitFor(() => statusOf('order') === '已验证', 20000, '确认生效')
  check(statusOf('order') === '已验证', 'order 变成「已验证」')
  check(statusRows().find((r) => r.name === 'order').note.includes('测试员'), '记下了确认人')
  check(step2Pills()[0] === '已验证' || step2Pills().includes('已验证'), '第 2 步的状态列同步更新了')

  console.log('\n=== 4. 改源码后点「重新检查」 ===')
  const src = path.join(WORK, 'src', 'order', 'service.js')
  fs.writeFileSync(src, fs.readFileSync(src, 'utf8') + '\n// 改动\n', 'utf8')
  $('btnCheck').click()
  await waitFor(() => statusOf('order') === '已失效', 20000, '查出新失效')
  check(statusOf('order') === '已失效', 'order 变成「已失效」')
  check(statusRows().find((r) => r.name === 'order').note.length > 0, '给出了失效原因')
  check(!!doc.querySelector('#statusList [data-verify="order"][data-action="validate"]'), '已失效的模块仍可重新确认')

  console.log('\n=== 5. 撤销确认 ===')
  $('btnCheck').click()
  await waitFor(() => statusOf('order') === '已失效', 20000, '稳定')
} catch (e) {
  fails.push('异常：' + e.message)
  console.log('  [异常] ' + e.message)
} finally {
  fs.rmSync(WORK, { recursive: true, force: true })
}

console.log('\n' + (fails.length ? '✘ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ') : '✔ 全部断言通过'))
process.exit(fails.length ? 1 : 0)
