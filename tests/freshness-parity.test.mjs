// 验证「统一指纹与状态」这件事真的成立。要证明的是四件事：
//
//   1. **认得统一之前生成的文档**。旧算法算出的指纹必须能识别出来，
//      否则统一那天所有文档都会被判成「源码变了」，然后全量重新生成 ——
//      源码一个字都没动，钱却白烧了。这是本次改动最要紧的一条。
//   2. CI 流水线和工作台用的是**同一个函数**，不是两份长得像的实现。
//   3. 旧的 status.json 里的确认能搬进文档头部；正文变过的不予继承。
//   4. frontmatter 写入/读回往返一致，陌生字段不被顺手删掉。
//
// 纯 Node 跑：不需要主服务，也不需要模型。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')

// 核心实现（CI 主线那边）
const F = await import(pathToFileURL(path.join(ROOT, 'docs-kit', 'scripts', 'lib', 'freshness.mjs')).href)
// 工作台侧的引用层
const K = await import(pathToFileURL(path.join(ROOT, 'lib', 'knowledge.mjs')).href)

const WORK = path.join(os.tmpdir(), 'docwarden-freshness-test')
fs.rmSync(WORK, { recursive: true, force: true })
fs.cpSync(path.join(ROOT, 'sample'), WORK, { recursive: true })

const fails = []
const check = (ok, msg) => { console.log(`  ${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg) }

const FILES = ['src/order/repo.js', 'src/order/service.js', 'src/order/state.js']
const docFile = path.join(WORK, 'docs', 'current', 'modules', 'order.md')
const BODY = '## 模块职责\n\n订单模块，负责下单与状态流转。\n'

/* 复刻「统一之前」的两种算法，用来造历史文档。
   一处在早期工作台（sha1 + 加长度前缀），一处在早期 CI 脚本（sha256 + 裸拼接）。 */
function legacySha1Framed() {
  const h = crypto.createHash('sha1')
  for (const rel of [...FILES].sort()) {
    h.update(rel).update('\0')
    const buf = fs.readFileSync(path.join(WORK, rel))
    h.update(String(buf.length)).update('\0').update(buf)
    h.update('\0')
  }
  return h.digest('hex').slice(0, 16)
}
function legacySha256Raw() {
  const h = crypto.createHash('sha256')
  for (const f of [...FILES].sort()) {
    h.update(f)
    h.update(fs.readFileSync(path.join(WORK, f)))
  }
  return h.digest('hex').slice(0, 16)
}
const sha1Text = (t) => crypto.createHash('sha1').update(t).digest('hex').slice(0, 16)

try {
  console.log('=== 1. CI 与工作台引用的是同一个指纹函数 ===')
  check(F.fingerprintFiles === K.fingerprintFiles, '工作台转发的是同一个函数（不是长得像的第二份实现）')
  check(F.evaluateDoc === K.evaluateDoc, '状态判定同样只有一份')

  console.log('\n=== 2. 指纹的稳定性 ===')
  const fp = F.fingerprintFiles(WORK, FILES)
  console.log('     指纹 ' + fp)
  check(/^[0-9a-f]{16}$/.test(fp), '指纹是 16 位十六进制')
  check(F.fingerprintFiles(WORK, [...FILES].reverse()) === fp, '与文件列表顺序无关（内部会排序）')

  console.log('\n=== 3. 内容变了指纹必须变，改回去必须复原 ===')
  const srcFile = path.join(WORK, 'src', 'order', 'service.js')
  const original = fs.readFileSync(srcFile, 'utf8')
  fs.writeFileSync(srcFile, original + '\n// 改一行\n', 'utf8')
  check(F.fingerprintFiles(WORK, FILES) !== fp, '内容变了 → 指纹变了')
  fs.writeFileSync(srcFile, original, 'utf8')
  check(F.fingerprintFiles(WORK, FILES) === fp, '改回去 → 指纹复原（是内容哈希，不是时间戳）')

  console.log('\n=== 4. 认得统一之前生成的文档 【最要紧的一条】===')
  for (const [label, old] of [
    ['早期工作台的 sha1+前缀', legacySha1Framed()],
    ['早期 CI 的 sha256 裸拼', legacySha256Raw()],
  ]) {
    fs.mkdirSync(path.dirname(docFile), { recursive: true })
    fs.writeFileSync(docFile, F.buildFrontmatter({
      generatedBy: 'legacy',
      generatedAt: '2026-09-01T00:00:00.000Z',
      module: 'order',
      sourceFingerprint: old,
      bodyFingerprint: sha1Text(BODY),
      docStatus: 'validated',
      validatedBy: '老王',
      validatedAt: '2026-09-02T00:00:00.000Z',
      validatedBodyFingerprint: sha1Text(BODY),
      sourceFiles: FILES,
    }) + BODY, 'utf8')

    const doc = F.evaluateDoc(WORK, docFile, FILES)
    check(doc.status === 'validated', `${label}：旧指纹被认出 → 仍是「已验证」，不会被误判成失效`)
    check(doc.needsUpgrade === true, `${label}：标记 needsUpgrade（可原地升级，不必重新生成）`)

    F.upgradeSourceFingerprint(docFile, WORK, FILES)
    const after = fs.readFileSync(docFile, 'utf8')
    check(after.includes(`source_fingerprint: ${fp}`), `${label}：指纹已就地升级为新算法`)
    check(after.includes('老王') && after.includes('订单模块，负责下单'), `${label}：确认与正文都没被动过`)

    const doc2 = F.evaluateDoc(WORK, docFile, FILES)
    check(doc2.status === 'validated' && doc2.needsUpgrade === false, `${label}：升级后状态不变、不再需要升级`)
  }

  console.log('\n=== 5. 源码真变了，就该判失效 ===')
  fs.writeFileSync(srcFile, original + '\n// 真的改了\n', 'utf8')
  const stale = F.evaluateDoc(WORK, docFile, FILES)
  check(stale.status === 'stale', '源码变动 → 已失效（压过人工确认）')
  check(!!stale.reason, '给出了原因：' + stale.reason)
  fs.writeFileSync(srcFile, original, 'utf8')

  console.log('\n=== 6. frontmatter 写入 / 读回往返一致 ===')
  const payload = {
    generatedBy: 'docs-bot',
    generatedAt: '2026-09-15T01:02:03.000Z',
    basedOnCommit: 'abc1234',
    project: 'demo',
    mode: 'incremental',
    module: 'order',
    sourceFingerprint: fp,
    bodyFingerprint: F.fingerprintText(BODY),
    docStatus: 'candidate',
    confidence: 'high',
    features: [{ name: '下单', desc: '创建订单' }, { name: '退款', desc: '' }],
    sourceFiles: FILES,
    extra: { provider: 'openai', model: 'gpt-4o-mini' },
  }
  fs.writeFileSync(docFile, F.buildFrontmatter(payload) + BODY, 'utf8')
  const back = F.readDocMeta(docFile)
  check(back.moduleName === 'order', 'module 读回一致')
  check(back.sourceFingerprint === fp, 'source_fingerprint 读回一致')
  check(back.docStatus === 'candidate', 'doc_status 读回一致')
  check(back.basedOnCommit === 'abc1234', 'based_on_commit 读回一致')
  check(back.features.length === 2 && back.features[0].name === '下单' && back.features[1].desc === '',
    'features 列表（含空说明项）解析正确')
  check(back.sourceFiles.length === 3, 'source_files 列表解析正确')
  check(back.raw.provider === 'openai' && back.raw.model === 'gpt-4o-mini', '陌生字段（provider/model）原样保留')
  check(back.body.trim() === BODY.trim(), '正文原样读回（frontmatter 已剥离）')

  console.log('\n=== 7. 兼容读旧字段名 code_hash / status ===')
  fs.writeFileSync(docFile, [
    '---', 'generated_by: old', 'code_hash: deadbeefdeadbeef', 'status: candidate',
    'body_fingerprint: cafebabecafebabe', '---', '', BODY,
  ].join('\n'), 'utf8')
  const legacyMeta = F.readDocMeta(docFile)
  check(legacyMeta.sourceFingerprint === 'deadbeefdeadbeef', 'code_hash 被当作 source_fingerprint 读出')
  check(legacyMeta.docStatus === 'candidate', 'status 被当作 doc_status 读出')

  console.log('\n=== 8. 就地改写不丢陌生字段 ===')
  fs.writeFileSync(docFile, F.buildFrontmatter({
    ...payload,
    docStatus: 'validated',
    validatedBy: '小李',
    validatedAt: '2026-09-15T02:00:00.000Z',
    validatedBodyFingerprint: F.fingerprintText(BODY),
  }) + BODY, 'utf8')
  F.clearValidation(docFile)
  const cleared = F.readDocMeta(docFile)
  check(cleared.docStatus === 'candidate' && !cleared.validatedBy, '撤销确认 → 回到候选、确认人被清空')
  check(cleared.raw.provider === 'openai', 'provider 仍在（重写头部没顺手删掉别人的字段）')
  check(cleared.moduleName === 'order', 'module 仍在')
  check(cleared.body.trim() === BODY.trim(), '正文一字未动')

  console.log('\n=== 9. 旧 status.json 里的确认能搬进文档头部 ===')
  const statusFile = path.join(WORK, 'docs', 'current', 'status.json')
  fs.writeFileSync(docFile, F.buildFrontmatter({
    generatedBy: 'legacy', generatedAt: '2026-09-01T00:00:00.000Z',
    module: 'order', sourceFingerprint: fp, bodyFingerprint: sha1Text(BODY),
    docStatus: 'candidate', sourceFiles: FILES,
  }) + BODY, 'utf8')
  fs.writeFileSync(statusFile, JSON.stringify({
    version: 1,
    modules: {
      order: { status: 'validated', by: '老张', at: '2026-09-03T00:00:00.000Z', body_fingerprint: sha1Text(BODY) },
      ghost: { status: 'validated', by: '老张', at: '2026-09-03T00:00:00.000Z', body_fingerprint: 'ffffffffffffffff' },
    },
  }, null, 2), 'utf8')

  const mig = F.migrateLegacyStatusJson(WORK)
  check(mig.carried === 1, `搬成功 1 条（实际 ${mig.carried}）`)
  check(!!mig.migrated.find((m) => m.name === 'ghost' && !m.carried), '找不到对应文档的模块不予继承')
  check(!fs.existsSync(statusFile), '搬完删掉 status.json')
  const migrated = F.readDocMeta(docFile)
  check(migrated.docStatus === 'validated' && migrated.validatedBy === '老张', '确认（人、时间）搬进了 frontmatter')
  check(F.evaluateDoc(WORK, docFile, FILES).status === 'validated', '状态判定认可这条搬过来的确认')

  console.log('\n=== 10. 正文变过的旧确认不予继承 ===')
  fs.writeFileSync(docFile, F.buildFrontmatter({
    generatedBy: 'legacy', generatedAt: '2026-09-01T00:00:00.000Z',
    module: 'order', sourceFingerprint: fp, docStatus: 'candidate', sourceFiles: FILES,
  }) + '## 模块职责\n\n这版正文和当初确认的那版不一样。\n', 'utf8')
  fs.writeFileSync(statusFile, JSON.stringify({
    version: 1,
    modules: { order: { status: 'validated', by: '老张', at: '2026-09-03T00:00:00.000Z', body_fingerprint: sha1Text(BODY) } },
  }, null, 2), 'utf8')
  const mig2 = F.migrateLegacyStatusJson(WORK)
  check(mig2.carried === 0, '正文指纹对不上 → 不继承（搬一份过期担保比不搬更糟）')
  check(fs.existsSync(statusFile), '一条都没搬成 → 保留 status.json 让人还能手工核对')
  check(F.readDocMeta(docFile).docStatus === 'candidate', '文档仍是候选')

  console.log('\n=== 11. 一条功能点怎么拆：三种分隔符都得认 ===')
  // 模型见过我们自己写进索引的「 :: 」，照着抄并不少见。只认冒号的话，
  // 说明会被切成「: 创建订单」—— 索引里就会出现一张带多余冒号的功能清单。
  const feq = (got, name, desc) => got.name === name && got.desc === desc
  const sp = F.splitFeature
  check(feq(sp('下单：创建订单'), '下单', '创建订单'), '全角冒号（提示词要求的格式）')
  check(feq(sp('下单: 创建订单'), '下单', '创建订单'), '半角冒号')
  check(feq(sp('下单 :: 创建订单'), '下单', '创建订单'), '分隔符是 :: 时，说明不带多余的冒号')
  check(feq(sp('下单 :: : 创建订单'), '下单', '创建订单'), '套娃分隔符（:: :）一并剥掉')
  check(feq(sp('- 退款：原路退回'), '退款', '原路退回'), '列表符号被剥掉')
  check(feq(sp('退款'), '退款', ''), '没有分隔符 → 整行当功能名，不丢')
  check(sp('   ').name === '', '空行不产出功能点')

  // 「写进 frontmatter」和「从 frontmatter 读回来」是两处代码，
  // 靠一次往返把两端钉在一起 —— 否则改了写的那边，读的那边会静默错位。
  const rt = F.buildFrontmatter({ module: 'order', features: [{ name: '下单', desc: '创建订单并返回订单号' }] })
  check(rt.includes('  - 下单 :: 创建订单并返回订单号\n'), '写出的功能行是「名称 :: 说明」，没有多出来的冒号')
  fs.writeFileSync(docFile, rt + BODY, 'utf8')
  const rtBack = F.readDocMeta(docFile)
  check(rtBack.features.length === 1 && feq(rtBack.features[0], '下单', '创建订单并返回订单号'),
    '名称与说明原样读回')
} catch (e) {
  fails.push('异常：' + e.message)
  console.log('  [异常] ' + (e.stack || e.message))
} finally {
  fs.rmSync(WORK, { recursive: true, force: true })
}

console.log('\n' + (fails.length ? '✘ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ') : '✔ 全部断言通过'))
process.exit(fails.length ? 1 : 0)
