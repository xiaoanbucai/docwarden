// 验证：使用者填进界面的 API Key，绝不会出现在这个工具写下的任何地方。
//
// 为什么值得单独测：这句话（「不落盘、不进导出物、不进会话记录」）是给使用者看的承诺，
// 而承诺最容易在改动中悄悄失效——加个字段、存个 config，key 就跟着进 localStorage 了。
// 所以这里塞一把特征鲜明的假 key，跑完整流程，然后把项目目录下每个文件都翻一遍。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { JSDOM, VirtualConsole } from 'jsdom'

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const BASE = 'http://127.0.0.1:5173'
const SECRET = 'sk-LEAK-CANARY-9f3a7c21d84b650e-DO-NOT-PERSIST'

const WORK = path.join(os.tmpdir(), 'docwarden-leak-test')
fs.rmSync(WORK, { recursive: true, force: true })
fs.cpSync(path.join(ROOT, 'sample'), WORK, { recursive: true })

const fails = []
const check = (ok, msg) => { console.log(`  ${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg) }

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, out)
    else out.push(p)
  }
  return out
}

const vc = new VirtualConsole()
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) console.log('  [jsdomError] ' + e.message) })
const dom = new JSDOM(fs.readFileSync(ROOT + 'docwarden.ui.html', 'utf8'), {
  url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) {
    w.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      return fetch(url.startsWith('http') ? url : BASE + url, init)
    }
    w.alert = () => {}
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

try {
  console.log('=== 跑一遍完整流程（界面里填上一把特征鲜明的假 key）===')
  $('dir').value = WORK
  $('btnScan').click()
  await waitFor(() => doc.querySelectorAll('#modTable tbody tr').length > 0, 20000, '扫描')
  $('btnAll').click()

  // 演示模式不真调模型，key 只是走一遍客户端代码路径，正好用来抓泄漏
  $('apiKey').value = SECRET
  $('verifyBy').value = '测试'
  $('btnGen').click()
  await waitFor(() => !$('btnGen').disabled, 90000, '生成')
  $('btnToPreview').click()
  $('btnExport').click()
  await waitFor(() => /已写入/.test($('exportInfo').textContent), 30000, '导出')
  await waitFor(() => doc.querySelectorAll('#statusList tbody tr').length > 0, 20000, '状态栏')

  // 再点一次人工确认，让确认落到文档头部（顺带验证它不会写到别的地方去）
  const vbtn = doc.querySelector('#statusList [data-verify][data-action="validate"]')
  if (vbtn) vbtn.click()
  await sleep(1200)

  console.log('\n=== 1. 确认流程真的跑完了（避免测了个空）===')
  const written = walkFiles(WORK).map((p) => path.relative(WORK, p))
  check(written.some((f) => f.includes(path.join('docs', 'current', 'modules'))), '确实写出了模块文档')
  check(written.some((f) => f.endsWith('INDEX.md')), '确实写出了 INDEX.md')
  // 确认现在写进文档自己的头部，不再单独存文件。
  // 这里既要证明「确认流程确实走完了」，也要证明「它没有跑到别的地方去」。
  const orderMd = fs.readFileSync(path.join(WORK, 'docs', 'current', 'modules', 'order.md'), 'utf8')
  check(/doc_status:\s*validated/.test(orderMd), '人工确认落到了文档头部（确认流程确实走完了）')
  check(!written.some((f) => f.endsWith('status.json')), '全程不产生 status.json（确认随文档走）')

  console.log('\n=== 2. 项目目录下任何文件都不含这把 key ===')
  const hits = []
  for (const p of walkFiles(WORK)) {
    let txt = ''
    try { txt = fs.readFileSync(p, 'utf8') } catch { continue }
    if (txt.includes(SECRET)) hits.push(path.relative(WORK, p))
  }
  check(hits.length === 0, `扫了 ${written.length} 个文件，含 key 的：${hits.length ? hits.join(', ') : '0 个'}`)

  console.log('\n=== 3. 重点文件逐个点名 ===')
  for (const rel of [
    path.join('docs', 'current', 'INDEX.md'),
    path.join('docs', 'current', 'modules', 'order.md'),
  ]) {
    let txt = ''
    try { txt = fs.readFileSync(path.join(WORK, rel), 'utf8') } catch { console.log(`  （${rel} 不存在，跳过）`); continue }
    check(!txt.includes(SECRET), `${rel} 不含 key`)
  }

  console.log('\n=== 4. 浏览器 localStorage 里也没有 ===')
  const ls = dom.window.localStorage
  const dump = []
  for (let i = 0; i < ls.length; i++) dump.push(ls.key(i) + '=' + ls.getItem(ls.key(i)))
  const lsText = dump.join('\n')
  check(!lsText.includes(SECRET), `localStorage 的 ${ls.length} 个键都不含 key`)
  check(lsText.length > 0, '（会话确实写进 localStorage 了，不是空跑）')
  check(!/apiKey/i.test(lsText), 'localStorage 里连 apiKey 这个字段名都没有')

  console.log('\n=== 5. 但模型与 provider 的溯源信息应当照常记录 ===')
  const idx = fs.readFileSync(path.join(WORK, 'docs', 'current', 'INDEX.md'), 'utf8')
  const orderDoc = fs.readFileSync(path.join(WORK, 'docs', 'current', 'modules', 'order.md'), 'utf8')
  check(/model:/.test(orderDoc), 'frontmatter 里记了 model（溯源需要，但里面不该有 key）')
  check(!/model:.*CANARY/.test(orderDoc), 'model 字段没有被 key 污染')
  check(idx.includes('状态'), 'INDEX 里的状态列还在')
} catch (e) {
  fails.push('异常：' + e.message)
  console.log('  [异常] ' + e.message)
} finally {
  fs.rmSync(WORK, { recursive: true, force: true })
}

console.log('\n' + (fails.length ? '✘ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ') : '✔ 全部断言通过'))
process.exit(fails.length ? 1 : 0)
