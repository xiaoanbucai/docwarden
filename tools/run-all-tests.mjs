#!/usr/bin/env node
/**
 * tools/run-all-tests.mjs —— 一键跑全量回归。
 *
 * 为什么需要它：有 5 个套件（status / persist / ui-status / mcp / leak）硬编码连
 * 127.0.0.1:5173 的**真实服务**。手工跑得先在另一个终端起服务、跑完再自己收掉；
 * 而一旦忘了收，那个进程会一直跑着**启动时载入的旧代码** —— 之后任何改动（重命名文件、
 * 换界面文件名）都会让它静默失效，测试全红，而报错是「找不到界面文件 xxx.html」，
 * 跟测试要验的东西毫无关系。这个坑踩过一次，就不再靠人记得。
 *
 * 这个脚本把「起服务 → 等就绪 → 按序跑 → 收服务」串成一条命令，收服务放在 finally 里，
 * 中途抛错也不会漏掉。
 *
 * 它**不会**去杀掉已经在占用端口的进程 —— 那可能是你正在用的服务。
 * 端口被占就报错退出，由你自己决定怎么处理。
 *
 *   node tools/run-all-tests.mjs                 跑 package.json 里那 10 套
 *   node tools/run-all-tests.mjs --with-retry    连 ui-retry 一起跑（会额外起假模型）
 */
import { spawn, execFile } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI = 'http://127.0.0.1:5173'
const FAKE = 'http://127.0.0.1:5401'
const SUITE_TIMEOUT = 300_000
const WITH_RETRY = process.argv.includes('--with-retry')

// 顺序照 package.json 的 test 脚本抄，方便对账
const SUITES = [
  ['零依赖', 'tools/check-zero-dep.mjs'],
  ['指纹与状态', 'tests/freshness-parity.test.mjs'],
  ['CI 脚本', 'tests/ci-smoke.test.mjs'],
  ['安装器', 'tests/init-smoke.test.mjs'],
  ['界面自检', 'tests/ui-selfcheck.test.mjs'],
  ['状态生命周期', 'tests/status-lifecycle.test.mjs'],
  ['会话持久化', 'tests/ui-persist.test.mjs'],
  ['界面状态', 'tests/ui-status.test.mjs'],
  ['MCP 服务', 'tests/mcp.test.mjs'],
  ['密钥不落盘', 'tests/no-secret-leak.test.mjs'],
]

// 每个后台服务：端口 + 就绪探测。probe 返回 {ok} 或 {ok:false, fatal:true, why}
const SERVICES = [{
  label: '本地界面',
  file: 'docwarden.mjs',
  args: ['--no-open'],
  port: 5173,
  probe: async () => {
    const r = await fetch(UI + '/')
    if (r.status === 200) return { ok: true }
    // 服务在跑但界面读不到 —— 几乎总是「跑的是旧代码 / 旧文件名」，必须直说
    const t = await r.text()
    return { ok: false, fatal: true, why: `本地界面在跑，但 GET / 返回 ${r.status}：${t.slice(0, 140)}` }
  },
}]

if (WITH_RETRY) {
  SUITES.push(['失败重试', 'tests/ui-retry.test.mjs'])
  // ui-retry 要一个「notify 首调故意 500」的假模型，必须外部先起
  SERVICES.push({
    label: '假模型',
    file: 'tests/fake-llm.mjs',
    args: [],
    port: 5401,
    probe: async () => ({ ok: (await fetch(FAKE + '/models')).ok }),
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '127.0.0.1')
  })
}

async function waitFor(label, proc, probe, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  let last = '（一直没有响应）'
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return { ok: false, why: `${label} 提前退出（code ${proc.exitCode}）` }
    try {
      const r = await probe()
      if (r.ok) return { ok: true }
      last = r.why
      if (r.fatal) return { ok: false, why: r.why }
    } catch (e) { last = e.message }
    await sleep(250)
  }
  return { ok: false, why: `${label} 在 ${timeoutMs}ms 内没就绪（最后：${last}）` }
}

function runSuite([name, file]) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file], {
      cwd: ROOT, timeout: SUITE_TIMEOUT, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '')
      resolve({
        name, file,
        ok: !err,
        code: err ? (err.signal || err.code) : 0,
        tail: out.trimEnd().split('\n').slice(-6).join('\n'),
      })
    })
  })
}

console.log(`\n=== 跑全量回归（${SUITES.length} 套）===\n`)

// 先一次性把端口都探一遍，别跑到一半才发现起不来
const busy = []
for (const s of SERVICES) if (!(await portFree(s.port))) busy.push(`${s.label}(${s.port})`)
if (busy.length) {
  console.error(`❌ 端口已被占用：${busy.join('、')}`)
  console.error('   那是别的进程（可能是你正在用的服务），本脚本不会动它。')
  console.error('   确认它没用、要换掉的话：先结束它，再重跑本脚本。')
  process.exit(1)
}

const procs = []
const results = []
try {
  for (const s of SERVICES) {
    const p = spawn(process.execPath, [s.file, ...s.args], { cwd: ROOT, stdio: 'pipe' })
    p.log = ''
    p.stdout.on('data', (d) => { p.log += d })
    p.stderr.on('data', (d) => { p.log += d })
    procs.push(p)

    const ready = await waitFor(s.label, p, s.probe)
    if (!ready.ok) {
      console.error(`❌ ${ready.why}\n`)
      console.error(p.log.split('\n').slice(-10).join('\n'))
      process.exitCode = 1
      throw new Error('service-not-ready')
    }
    console.log(`✅ ${s.label} 已就绪 :${s.port}（临时进程，跑完自动收）`)
  }

  console.log('')
  for (const s of SUITES) {
    const r = await runSuite(s)
    results.push(r)
    console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(14)} ${r.file}`)
    if (!r.ok) {
      console.log('   ' + r.tail.split('\n').join('\n   '))
      console.log(`   → 退出码/信号：${r.code}\n`)
    }
  }
} catch (e) {
  if (e.message !== 'service-not-ready') throw e
} finally {
  for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL')
  await sleep(400)
  const still = []
  for (const s of SERVICES) if (!(await portFree(s.port))) still.push(`${s.label}:${s.port}`)
  console.log(`\n🧹 临时服务已收掉（${still.length ? '仍占用：' + still.join('、') + '，请检查' : '端口全部释放'}）`)
}

const bad = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - bad.length}/${results.length} 套通过 ===`)
if (bad.length) {
  console.log('未通过：' + bad.map((r) => r.name).join('、'))
  process.exitCode = 1
} else {
  console.log('全绿。')
}
