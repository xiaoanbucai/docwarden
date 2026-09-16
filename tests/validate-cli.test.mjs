// 验证 `validate` 模式（人工确认命令）的完整行为。
// 核心要证明的三句话：
//   1. 候选文档可以确认，署名与时间写进 front-matter；
//   2. 失效文档默认拒绝直接确认，--force 才放行，且放行时源码指纹必须跟上当前代码；
//   3. 全程不产生 status.json、不调模型 —— 确认是纯本地动作。
//
// 本套件不起本地服务（区别于 status-lifecycle），直接以子进程跑 docs-update.mjs --mode validate。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fingerprintFiles, fingerprintText } from '../docs-kit/scripts/lib/freshness.mjs'

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const SCRIPT = 'docs-kit/scripts/docs-update.mjs'
const WORK = path.join(os.tmpdir(), 'docwarden-validate-test')

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'src/order'), { recursive: true })
fs.mkdirSync(path.join(WORK, 'src/user'), { recursive: true })

fs.writeFileSync(path.join(WORK, '.knowledge.mjs'), `export default {
  project: 'test-app',
  modules: [
    { name: 'order', title: '订单', prefixes: ['src/order/'] },
    { name: 'user', title: '用户', prefixes: ['src/user/'] },
  ],
  sourceRoots: ['src/'],
  ignorePaths: ['node_modules/'],
}
`)
fs.writeFileSync(path.join(WORK, 'src/order/service.js'), 'export function createOrder() { return 1 }\n')
fs.writeFileSync(path.join(WORK, 'src/order/repo.js'), 'export const repo = { save: () => 1 }\n')
fs.writeFileSync(path.join(WORK, 'src/user/auth.js'), 'export function login() { return true }\n')

const docFile = path.join(WORK, 'docs', 'current', 'modules', 'order.md')
fs.mkdirSync(path.dirname(docFile), { recursive: true })

const orderFiles = ['src/order/repo.js', 'src/order/service.js']
const BODY = '## 模块职责\n\n订单模块负责下单。\n'
const writeDoc = () => {
  fs.writeFileSync(docFile, `---
project: test-app
module: order
mode: incremental
generated_by: test
generated_at: 2026-09-16T00:00:00.000Z
source_fingerprint: ${fingerprintFiles(WORK, orderFiles)}
body_fingerprint: ${fingerprintText(BODY)}
doc_status: candidate
---

${BODY}
`, 'utf8')
}
writeDoc()

// 逐行解析 frontmatter（不能 \s 贪吃换行，见 status-lifecycle 同款注释）
const readFm = (key) => {
  const block = fs.readFileSync(docFile, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0 && line.slice(0, i).trim() === key) return line.slice(i + 1).trim()
  }
  return ''
}

const runValidate = (args, env = process.env) => spawnSync(process.execPath, [SCRIPT, '--mode', 'validate', ...args, '--root', WORK], {
  cwd: ROOT, encoding: 'utf8', env,
})
const combined = (r) => String(r.stdout || '') + String(r.stderr || '')

const fails = []
const check = (ok, msg) => { console.log(`  ${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg) }

try {
  console.log('=== 1. 候选文档，--by 显式署名 ===')
  let r = runValidate(['--module=order', '--by=张三'])
  check(r.status === 0, '命令成功退出')
  check(readFm('doc_status') === 'validated', 'frontmatter 里 doc_status 变为 validated')
  check(readFm('validated_by') === '张三', '确认人写进 validated_by')
  check(/^\d{4}-\d{2}-\d{2}T/.test(readFm('validated_at')), '记录了确认时间')
  check(/^[0-9a-f]{16}$/.test(readFm('validated_body_fingerprint')), '锁定了被确认那一版正文的指纹')
  check(!fs.existsSync(path.join(WORK, 'docs', 'current', 'status.json')), '全程不产生 status.json')

  console.log('\n=== 2. 源码变了，不带 --force 应当被拒绝 ===')
  const fpBefore = readFm('source_fingerprint')
  const svc = path.join(WORK, 'src', 'order', 'service.js')
  fs.writeFileSync(svc, fs.readFileSync(svc, 'utf8') + '\n// 加一行，源码就变了\n', 'utf8')
  r = runValidate(['--module=order', '--by=张三'])
  check(r.status !== 0, '命令失败退出')
  check(combined(r).includes('--force'), '报错里指路了 --force')
  check(readFm('source_fingerprint') === fpBefore, '拒绝时什么都不写（源码指纹原样）')
  check(readFm('doc_status') === 'validated', '拒绝时不碰文档状态字段')

  console.log('\n=== 3. --force 背书当前源码 ===')
  const currentFp = fingerprintFiles(WORK, orderFiles)
  r = runValidate(['--module=order', '--by=张三', '--force=true'])
  check(r.status === 0, '命令成功退出')
  check(readFm('source_fingerprint') === currentFp, '源码指纹更新为当前代码的指纹（否则确认完仍是 stale，白确认）')
  check(readFm('doc_status') === 'validated', '状态为已验证')

  console.log('\n=== 4. 没有文档的模块应当被拒绝 ===')
  r = runValidate(['--module=user', '--by=张三'])
  check(r.status !== 0, '命令失败退出')
  check(combined(r).includes('还没有文档'), '报错说明先跑生成：' + combined(r).trim().split('\n')[0])

  console.log('\n=== 5. 不存在的模块名 ===')
  r = runValidate(['--module=nope', '--by=张三'])
  check(r.status !== 0, '命令失败退出')
  check(combined(r).includes('order'), '报错里列出可用模块名')

  console.log('\n=== 6. 不带 --module ===')
  r = runValidate(['--by=张三'])
  check(r.status !== 0, '命令失败退出')
  check(combined(r).includes('--module'), '报错里指路 --module')

  console.log('\n=== 7. 取不到 git 署名时要求 --by ===')
  const emptyGit = path.join(WORK, '.empty-git-config')
  fs.writeFileSync(emptyGit, '', 'utf8')
  r = runValidate(['--module=order'], {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyGit,
    GIT_CONFIG_SYSTEM: emptyGit,
  })
  check(r.status !== 0, '命令失败退出')
  check(combined(r).includes('--by'), '报错里指路 --by（确认是要署名的）')

  console.log('\n=== 8. --dry-run 只说不写 ===')
  fs.writeFileSync(svc, fs.readFileSync(svc, 'utf8') + '\n// 再变一次\n', 'utf8')
  const fpDry = readFm('source_fingerprint')
  r = runValidate(['--module=order', '--by=张三', '--force=true', '--dry-run=true'])
  check(r.status === 0, '命令成功退出')
  check(readFm('source_fingerprint') === fpDry, 'dry-run 不写任何文件')
} catch (e) {
  fails.push('异常：' + e.message)
  console.log('  [异常] ' + e.message)
} finally {
  fs.rmSync(WORK, { recursive: true, force: true })
}

console.log('\n' + (fails.length ? '✘ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ') : '✔ 全部断言通过'))
process.exit(fails.length ? 1 : 0)
