// 全链路验证「重试失败项」：
// jsdom 跑真实界面代码 → 真实 docwarden 服务(5173) → 假模型(5401，notify 首调故意 500)
// 关键断言：重试只重跑失败模块，已成功模块的耗时数字必须一字不变
import fs from 'node:fs'
// jsdom 只在跑测试时需要，主程序 docwarden.mjs 依旧是零依赖。
// 项目里装了就直接跑；想复用别处的安装，用 JSDOM_PATH 指过去。
const { JSDOM, VirtualConsole } = await import(process.env.JSDOM_PATH || 'jsdom')

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const HTML = fs.readFileSync(ROOT + 'docwarden.ui.html', 'utf8')
const SAMPLE = ROOT + 'sample'
const BASE = 'http://127.0.0.1:5173'

const vc = new VirtualConsole()
vc.on('jsdomError', (e) => console.log('  [jsdomError] ' + e.message))
vc.on('error', (...a) => console.log('  [console.error] ' + a.join(' ')))

const dom = new JSDOM(HTML, { url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc })
const { window } = dom
const doc = window.document
const $ = (id) => doc.getElementById(id)

window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url
  return fetch(url.startsWith('http') ? url : BASE + url, init)
}
const alerts = []
window.alert = (m) => { alerts.push(String(m)); console.log('  [alert] ' + String(m).replace(/\n/g, ' ／ ')) }
window.confirm = (m) => { console.log('  [confirm] ' + String(m).replace(/\n/g, ' ／ ')); return true }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(200) }
  throw new Error('等待超时：' + label)
}
const rows = () => [...doc.querySelectorAll('#genTable tbody tr')].map((tr) => {
  const td = tr.querySelectorAll('td')
  return { name: td[0].textContent.trim(), status: td[1].textContent.trim(), stats: td[2].textContent.trim(), ms: td[3].textContent.trim() }
})
const show = (tag, list) => {
  console.log('  ' + tag)
  for (const r of list) console.log('    ' + r.name.padEnd(10) + r.status.padEnd(8) + r.ms.padEnd(10) + r.stats)
}
const fails = []
const check = (ok, msg) => { console.log(`  ${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg) }

try {
  $('dir').value = SAMPLE
  $('btnScan').click()
  await waitFor(() => doc.querySelectorAll('#modTable tbody tr').length > 0, 20000, '扫描出模块')
  console.log('扫描到 ' + doc.querySelectorAll('#modTable tbody tr').length + ' 个分组')

  $('btnAll').click()
  $('provider').value = 'openai'
  $('baseUrl').value = 'http://127.0.0.1:5401/v1'
  $('model').value = 'fake-doc-model'
  $('timeoutSec').value = '60'

  console.log('\n=== 第一轮：notify 会故意失败 ===')
  $('btnGen').click()
  await waitFor(() => !$('btnGen').disabled, 120000, '第一轮结束')
  const r1 = rows()
  show('第一轮结果：', r1)
  const ok1 = r1.filter((r) => r.status === '完成').map((r) => r.name)
  const bad1 = r1.filter((r) => r.status !== '完成').map((r) => r.name)
  check(bad1.length === 1 && bad1[0] === 'notify', '恰好 notify 一个失败（实际失败：' + bad1.join(',') + '）')
  check(ok1.length === r1.length - 1, '其余全部成功')
  check($('genFail').textContent.includes('失败'), '失败原因已显示在页面上（不再是空白）')
  check(!$('btnRetry').disabled && $('btnRetry').style.display !== 'none', '重试按钮出现且可点')
  check($('btnRetry').textContent.includes('1'), '重试按钮标注了失败数量：' + $('btnRetry').textContent)
  const beforeMs = {}
  for (const r of r1) beforeMs[r.name] = r.ms

  console.log('\n=== 第二轮：点「重试失败项」 ===')
  $('btnRetry').click()
  await waitFor(() => !$('btnGen').disabled, 120000, '重试结束')
  const r2 = rows()
  show('重试后结果：', r2)
  check(r2.every((r) => r.status === '完成'), '全部变为完成')
  check(r2.every((r) => r.status === '失败' || r.status === '已中断' ? false : true), '没有残留失败项')

  const unchanged = r1.filter((r) => r.status === '完成').every((r) => {
    const now = r2.find((x) => x.name === r.name)
    return now && now.ms === r.ms
  })
  check(unchanged, '已成功模块的耗时完全没变 → 证明它们没有被重跑')

  const stat = await fetch('http://127.0.0.1:5402').then((r) => r.json())
  console.log('\n假模型调用记录：' + JSON.stringify(stat.attempts) + '  轨迹：' + stat.log.join(' → '))
  check(stat.attempts.other === 3, '其他 3 个模块各只调用了 1 次（实际 ' + stat.attempts.other + ' 次）')
  check(stat.attempts.notify === 2, 'notify 被调用了 2 次（先失败后成功）')
} catch (e) {
  fails.push('异常：' + e.message)
  console.log('  [异常] ' + e.message)
}

console.log('\n' + (fails.length ? '✘ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ') : '✔ 全部断言通过'))
process.exit(fails.length ? 1 : 0)
