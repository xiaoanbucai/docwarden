// 验证「文档新鲜度」机制的完整生命周期。
// 核心要证明的一句话：**人的确认绑定到具体那一版内容** ——
// 源码变了要失效，正文变了也要失效，两者都没变就该继续有效。
//
// 用真实服务端（127.0.0.1:5173）+ 一个临时复制的样例目录，
// 因为测试需要真的去改源码文件，不能动 sample 本体。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const BASE = 'http://127.0.0.1:5173'

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return r.json()
}

// 准备一个可随意糟蹋的副本
const WORK = path.join(os.tmpdir(), 'docwarden-status-test')
fs.rmSync(WORK, { recursive: true, force: true })
fs.cpSync(path.join(ROOT, 'sample'), WORK, { recursive: true })

const fails = []
const check = (ok, msg) => { console.log(`  ${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg) }

const MSGS = {
  a: '## 模块职责\n\n版本甲：描述了 order 模块。\n\n## 对外接口\n\n| 名称 | 作用 |\n|---|---|\n| createOrder | 下单 |\n',
  b: '## 模块职责\n\n版本乙：内容被换过了，人的确认应当作废。\n',
}
const docFile = (name) => path.join(WORK, 'docs', 'current', 'modules', name + '.md')
// 逐行解析：不能用 `^key:\s*(.*)$`，`\s` 会吃掉换行让空值字段吞掉下一行
const readFm = (file, key) => {
  const block = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0 && line.slice(0, i).trim() === key) return line.slice(i + 1).trim()
  }
  return ''
}
const statusOf = async (name) => {
  const s = await post('/api/scan', { dir: WORK })
  const all = (s.modules || []).concat(s.small || [])
  const m = all.find((x) => x.name === name)
  return m && m.doc ? m.doc.status : '(模块不存在)'
}
const exportOrder = (markdown) => post('/api/export', {
  dir: WORK,
  docs: [{ name: 'order', markdown, lines: 83, fileCount: 3, files: ['src/order/repo.js', 'src/order/service.js', 'src/order/state.js'], provider: 'mock', model: 'test' }],
})

try {
  console.log('=== 1. 什么都没生成时 ===')
  check(await statusOf('order') === 'missing', '未生成 → 状态是 missing（待生成）')

  console.log('\n=== 2. 导出后应当是「候选」 ===')
  await exportOrder(MSGS.a)
  check(await statusOf('order') === 'candidate', '刚生成 → 候选（没人确认过）')
  check(readFm(docFile('order'), 'doc_status') === 'candidate', 'frontmatter 里也写着 candidate（字段名 doc_status）')
  check(/^[0-9a-f]{16}$/.test(readFm(docFile('order'), 'source_fingerprint')), '记录了源码指纹')
  check(/^[0-9a-f]{16}$/.test(readFm(docFile('order'), 'body_fingerprint')), '记录了正文指纹')
  const fp1 = readFm(docFile('order'), 'source_fingerprint')

  console.log('\n=== 3. 人工确认为「已验证」 ===')
  const v = await post('/api/verify', { dir: WORK, module: 'order', action: 'validate', by: '测试' })
  check(v.ok === true, '确认接口返回成功')
  check(await statusOf('order') === 'validated', '状态变为 validated（已验证）')
  check(readFm(docFile('order'), 'doc_status') === 'validated', '确认写进了 frontmatter 的 doc_status')
  check(readFm(docFile('order'), 'validated_by') === '测试', '记录了确认人')
  check(/^[0-9a-f]{16}$/.test(readFm(docFile('order'), 'validated_body_fingerprint')), '锁定了被确认那一版正文的指纹')
  check(!fs.existsSync(path.join(WORK, 'docs', 'current', 'status.json')), '全程不产生 status.json（确认随文档走）')

  console.log('\n=== 4. 重新导出「完全一样」的内容 ===')
  await exportOrder(MSGS.a)
  check(await statusOf('order') === 'validated', '内容没变 → 确认继续有效（不该白掉）')

  console.log('\n=== 5. 改源码 ===')
  const srcFile = path.join(WORK, 'src', 'order', 'service.js')
  const original = fs.readFileSync(srcFile, 'utf8')
  fs.writeFileSync(srcFile, original + '\n// 加一行，源码就变了\n', 'utf8')
  const staleStatus = await statusOf('order')
  check(staleStatus === 'stale', `源码变了 → 已失效（实际 ${staleStatus}）`)
  const s = await post('/api/scan', { dir: WORK })
  const orderMod = (s.modules || []).find((x) => x.name === 'order')
  check(!!(orderMod.doc.reason || '').length, '给出了失效原因：' + (orderMod.doc.reason || '（空）'))

  console.log('\n=== 6. 把源码改回去（指纹是内容哈希，应当自动复原）===')
  fs.writeFileSync(srcFile, original, 'utf8')
  check(await statusOf('order') === 'validated', '源码恢复原样 → 确认自动重新生效')

  console.log('\n=== 7. 源码没变、但正文被重新生成了（换了模型/说法）===')
  await exportOrder(MSGS.b)
  check(await statusOf('order') === 'candidate', '正文变了 → 确认作废，回到候选')
  check(readFm(docFile('order'), 'source_fingerprint') === fp1, '源码指纹其实没变（说明是正文指纹在起作用）')
  check(readFm(docFile('order'), 'validated_by') === '', 'frontmatter 里的确认人已被清空')

  console.log('\n=== 8. 重新确认，再导出同一版 ===')
  await post('/api/verify', { dir: WORK, module: 'order', action: 'validate', by: '测试' })
  check(await statusOf('order') === 'validated', '重新确认生效')
  await exportOrder(MSGS.b)
  check(await statusOf('order') === 'validated', '同一版内容再导出 → 确认仍有效')

  console.log('\n=== 9. 撤销确认 ===')
  await post('/api/verify', { dir: WORK, module: 'order', action: 'reset' })
  check(await statusOf('order') === 'candidate', '撤销后回到候选')

  console.log('\n=== 10. 未导出就确认，应当被拒绝 ===')
  const bad = await post('/api/verify', { dir: WORK, module: 'notify', action: 'validate', by: '测试' })
  check(bad.ok === false, '没有文档时确认被拒绝：' + (bad.error || ''))

  console.log('\n=== 11. 索引里应当有状态列 ===')
  await post('/api/verify', { dir: WORK, module: 'order', action: 'validate', by: '测试' })
  await exportOrder(MSGS.b)
  const idx = fs.readFileSync(path.join(WORK, 'docs', 'current', 'INDEX.md'), 'utf8')
  check(/\|\s*状态\s*\|/.test(idx), '索引含「状态」列')
  check(idx.includes('已验证'), '索引标出了已验证的模块')
} catch (e) {
  fails.push('异常：' + e.message)
  console.log('  [异常] ' + e.message)
} finally {
  fs.rmSync(WORK, { recursive: true, force: true })
}

console.log('\n' + (fails.length ? '✘ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ') : '✔ 全部断言通过'))
process.exit(fails.length ? 1 : 0)
