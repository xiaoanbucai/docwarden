// 验证会话留存：A 实例跑完后把 localStorage 交给 B 实例，B 应能恢复结果而不必重跑
import fs from 'node:fs'
// jsdom 只在跑测试时需要，主程序 docwarden.mjs 依旧是零依赖。
// 项目里装了就直接跑；想复用别处的安装，用 JSDOM_PATH 指过去。
const { JSDOM, VirtualConsole } = await import(process.env.JSDOM_PATH || 'jsdom')

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const HTML = fs.readFileSync(ROOT + 'docwarden.ui.html', 'utf8')
const SAMPLE = ROOT + 'sample'
const BASE = 'http://127.0.0.1:5173'
const SKEY = 'docwarden.session.v1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(150) }
  throw new Error('等待超时：' + label)
}

function makeDom(seedStorage) {
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) console.log('  [jsdomError] ' + e.message) })
  const dom = new JSDOM(HTML, {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url
        return fetch(url.startsWith('http') ? url : BASE + url, init)
      }
      w.alert = () => {}
      w.confirm = () => false
      // localStorage 不跨实例，所以手动把上一次会话灌进去
      if (seedStorage) w.localStorage.setItem(SKEY, seedStorage)
    },
  })
  return dom
}

const rowsOf = (doc) => [...doc.querySelectorAll('#genTable tbody tr')].map((tr) => {
  const td = tr.querySelectorAll('td')
  return { name: td[0].textContent.trim(), status: td[1].textContent.trim(), ms: td[3].textContent.trim() }
})

const fails = []
const check = (ok, msg) => { console.log(`  ${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg) }

try {
  console.log('=== A 实例：正常跑完一轮（演示模式，4 个模块）===')
  const domA = makeDom(null)
  const docA = domA.window.document
  docA.getElementById('dir').value = SAMPLE
  docA.getElementById('btnScan').click()
  await waitFor(() => docA.querySelectorAll('#modTable tbody tr').length > 0, 20000, 'A 扫描')
  docA.getElementById('btnAll').click()
  docA.getElementById('btnGen').click()
  await waitFor(() => !docA.getElementById('btnGen').disabled, 60000, 'A 生成结束')
  const rowsA = rowsOf(docA)
  console.log('  A 结果：' + rowsA.map((r) => r.name + '=' + r.status).join(', '))
  check(rowsA.length === 4 && rowsA.every((r) => r.status === '完成'), 'A 全部生成成功')

  const saved = domA.window.localStorage.getItem(SKEY)
  check(!!saved, '会话已写入 localStorage')
  const parsed = JSON.parse(saved || '{}')
  check(parsed.results && parsed.results.length === 4, '会话里含 4 条结果')
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase()
  check(norm(parsed.dir) === norm(SAMPLE), '会话记录了目录（' + parsed.dir + '）')
  const okBytes = (saved || '').length
  console.log('  会话体积：' + (okBytes / 1024).toFixed(1) + ' KB')

  console.log('\n=== B 实例：全新页面，只灌入上次会话（模拟刷新）===')
  const domB = makeDom(saved)
  const docB = domB.window.document
  // 注意：B 实例没有点过任何按钮，如果结果被恢复，说明是 localStorage 起了作用
  const rowsB = rowsOf(docB)
  console.log('  B 结果：' + rowsB.map((r) => r.name + '=' + r.status).join(', '))
  check(rowsB.length === 4, 'B 自动重建了 4 行（未点扫描）')
  check(rowsB.every((r) => r.status === '完成'), 'B 的 4 行状态都是「完成」——结果被恢复')
  check(rowsB.every((r) => r.ms !== '—'), 'B 保留了各模块耗时数字')
  const noteB = docB.getElementById('scanNote').textContent
  check(noteB.includes('已恢复'), '页面明确告知已恢复上次结果')
  check(!docB.getElementById('nav4').disabled, '预览导出步骤已被解锁')
  check(docB.getElementById('btnRetry').style.display === 'none', '无失败项时不显示重试按钮')

  console.log('\n=== C 实例：恢复的是「有失败项」的会话 ===')
  const partial = JSON.parse(saved)
  partial.results[3] = { name: partial.results[3].name, ok: false, error: '模拟失败', lines: 19, fileCount: 1, files: [] }
  const domC = makeDom(JSON.stringify(partial))
  const docC = domC.window.document
  const rowsC = rowsOf(docC)
  console.log('  C 结果：' + rowsC.map((r) => r.name + '=' + r.status).join(', '))
  check(rowsC.filter((r) => r.status === '完成').length === 3, 'C 恢复了 3 个成功项')
  check(rowsC.filter((r) => r.status === '失败').length === 1, 'C 保留了 1 个失败项')
  const btnC = docC.getElementById('btnRetry')
  check(btnC.style.display !== 'none' && !btnC.disabled, 'C 的重试按钮可用')
  check(docC.getElementById('genFail').textContent.includes('模拟失败'), 'C 显示了失败原因')
} catch (e) {
  fails.push('异常：' + e.message)
  console.log('  [异常] ' + e.message)
}

console.log('\n' + (fails.length ? '✘ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ') : '✔ 全部断言通过'))
process.exit(fails.length ? 1 : 0)
