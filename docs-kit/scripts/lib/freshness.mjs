/**
 * freshness.mjs —— 文档新鲜度的唯一实现：内容指纹、frontmatter 状态、人的确认。
 *
 * 为什么必须只有一份：
 *   CI 流水线（scripts/docs-update.mjs）和本地工作台（docwarden.mjs）、
 *   MCP 服务（docwarden-mcp.mjs）都要回答同一个问题 ——「这份文档现在还算不算数」。
 *   同一套判定要是各写一遍，迟早跑偏，而且跑偏的方式很隐蔽：
 *   一边算出的指纹另一边认不出，于是文档被反复判成「已失效」、反复重新生成，
 *   白烧模型额度。实测踩过这个坑，所以抽成共享模块。
 *
 * 为什么放在 docs-kit 而不是工作台目录：
 *   CI 脚本会随 `docs-kit/` 整个拷进目标仓库，它不能反向依赖工作台目录里的文件。
 *   CI 是主线，共享模块就得跟着主线走，由工作台反过来引用它。
 *
 * 依赖：只用 Node 内置模块，零 npm 依赖。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/* ───────────────────────────── 状态 ───────────────────────────── */

export const STATUS_LABEL = {
  missing: '待生成',
  candidate: '候选',
  validated: '已验证',
  stale: '已失效',
}

/** 对 AI 说话时，每种状态该怎么提醒它 —— 防止它把「没人确认过的」当成结论。 */
export const STATUS_HINT = {
  missing: '这份模块还没有生成文档。',
  candidate: '**这份文档是「候选」，没有任何人确认过**，内容由模型生成、可能不准确。引用它的结论前请自己核对源码。',
  validated: '这份文档已通过人工确认，且确认之后源码没有变动。',
  stale: '**这份文档已失效**：它在生成之后源码发生了变更，内容很可能已经过时。请以源码为准。',
}

/* ───────────────────────────── 指纹 ───────────────────────────── */

/** 指纹统一截断到 16 位十六进制 —— 足够区分内容，又不至于把 frontmatter 撑长。 */
const HASH_LEN = 16

/**
 * 指纹的「算法 + 框法」是参数化的，因为历史上前前后后出现过四种组合。
 *
 *   算法 / 框法          出身
 *   ─────────────────────────────────────────────
 *   sha256 + framed      当前（本文件）
 *   sha1   + framed      早期本地工作台（lib/knowledge.mjs）
 *   sha256 + raw         早期 CI 脚本（scripts/docs-update.mjs）
 *   sha1   + raw         兜底
 *
 * 为什么非要认得旧值：换算法那一天，所有已生成文档的指纹都会对不上新算法算出的值。
 * 若只认新算法，这些文档会被全部判成「源码变了」，然后全量重新生成 ——
 * 账单会很难看，而且是毫无意义的浪费（源码一个字都没动）。
 * 所以判定时要把旧值也算一遍，对得上就说明「源码没变，只是算法换代了」，
 * 就地升级 frontmatter 里的指纹字段即可，一次模型调用都不花。
 *
 * framed（加框）指每个文件写成 `<相对路径> NUL <字节数> NUL <内容> NUL`。
 * 为什么要加框：裸拼接时，「文件 A 的结尾」和「文件 B 的开头」有可能拼出
 * 与另一组文件完全相同的字节流，于是两组不同的文件算出同一个指纹。
 * 带上长度前缀后，文件边界永不含糊。
 */
function digestFiles(root, rels, algo, framed) {
  const h = crypto.createHash(algo)
  for (const rel of [...(rels || [])].map(String).sort()) {
    h.update(rel)
    if (framed) h.update('\0')
    let buf = null
    try {
      buf = fs.readFileSync(path.join(root, rel))
    } catch {
      buf = null
    }
    if (buf) {
      if (framed) h.update(String(buf.length)).update('\0')
      h.update(buf)
      if (framed) h.update('\0')
    } else if (framed) {
      // 读不到也要留下痕迹：否则「文件缺失」和「文件为空」会算出同一个指纹
      h.update('MISSING').update('\0')
    }
  }
  return h.digest('hex').slice(0, HASH_LEN)
}

/** 当前算法算出的源码指纹。传入同一组文件，任何内容变动都会改变它。 */
export function fingerprintFiles(root, rels) {
  return digestFiles(root, rels, 'sha256', true)
}

/** 历史算法算出的源码指纹，用来识别「统一之前生成的文档」。 */
export function legacyFingerprints(root, rels) {
  return [
    digestFiles(root, rels, 'sha1', true),    // 早期本地工作台
    digestFiles(root, rels, 'sha256', false), // 早期 CI 脚本
    digestFiles(root, rels, 'sha1', false),
  ]
}

/**
 * 记录下来的源码指纹，和当前源码对得上吗？
 *
 * 返回 matched 之外还带上 algorithm，是为了区分两种情况：
 *   · algorithm === 'current'          → 完全正常，什么都不用做
 *   · algorithm 是历史算法              → 源码没变，只是指纹换了算法，可原地升级
 */
export function matchSourceFingerprint(root, rels, recorded) {
  const current = fingerprintFiles(root, rels)
  const wanted = String(recorded || '').trim()
  if (!wanted) return { current, matched: false, algorithm: '' }
  if (wanted === current) return { current, matched: true, algorithm: 'current' }
  for (const value of legacyFingerprints(root, rels)) {
    if (wanted === value) return { current, matched: true, algorithm: 'legacy' }
  }
  return { current, matched: false, algorithm: '' }
}

/** 正文（不含 frontmatter）的指纹，用来判断「人确认过的到底是哪一版内容」。 */
export function fingerprintText(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, HASH_LEN)
}

/** 正文指纹也要认旧算法，理由同源码指纹。 */
export function matchTextFingerprint(text, recorded) {
  const cur = fingerprintText(text)
  const wanted = String(recorded || '').trim()
  if (wanted && wanted === cur) return { current: cur, matched: true, algorithm: 'current' }
  const legacy = crypto.createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, HASH_LEN)
  if (wanted && wanted === legacy) return { current: cur, matched: true, algorithm: 'legacy' }
  return { current: cur, matched: false, algorithm: '' }
}

/* ──────────────────── frontmatter 解析与生成 ──────────────────── */

/**
 * 功能点「名称」与「说明」之间的分隔符。
 *
 * 这是**写进 frontmatter** 的格式，所以读取端必须认得它；而模型生成的
 * 功能清单用的是「功能名：说明」，两者的分隔符不是同一个东西。
 * 两边都要认，判定收在 splitFeature 里，别在别处再写一遍。
 */
export const FEATURES_SEP = ' :: '

/**
 * 拆一条功能点。三种写法都认：
 *
 *   `下单：创建订单`   提示词要求的格式，模型正常时就这样（全角冒号）
 *   `下单: 创建订单`   半角冒号，模型偶尔用
 *   `下单 :: 创建订单` 我们自己写进 frontmatter 的格式。模型见过生成出来的
 *                      索引，照着抄并不少见 —— 只认冒号就会把它切成「: 创建订单」
 *
 * 拆不出来就把整行当功能名（说明留空），而不是丢掉：一个没有说明的功能点
 * 仍然能被索引到，丢掉就等于它从检索里消失了。
 */
export function splitFeature(line) {
  const s = String(line ?? '').replace(/^\s*[-*]\s*/, '').trim()
  if (!s) return { name: '', desc: '' }

  let at = s.indexOf(FEATURES_SEP)
  let cut = at === -1 ? -1 : at + FEATURES_SEP.length
  if (at === -1) {
    const i = s.search(/[：:]/)
    if (i !== -1) { at = i; cut = i + 1 }
  }
  if (at === -1) return { name: s, desc: '' }

  return {
    name: s.slice(0, at).trim(),
    // 模型可能写成「下单 :: : 说明」这种套娃，把首部残留的分隔符一并剥掉
    desc: s.slice(cut).replace(/^[\s:：]+/, '').trim(),
  }
}

const unquote = (s) => {
  const v = String(s ?? '').trim()
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * 解析文档头部的 frontmatter。
 *
 * 逐行解析，不用 `^key:\s*(.*)$` 那种正则 —— `\s` 会把换行也吃掉，
 * 于是「空值字段」会把下一行的内容吞成自己的值（实测踩过）。
 *
 * 空值字段既可能是标量（`validated_by:`）也可能是列表头（`features:`），
 * 靠下一行是不是 `- ` 来区分。
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '')
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { fields: {}, lists: {}, body: src, ok: false }

  const lines = m[1].split(/\r?\n/)
  const fields = {}
  const lists = {}
  let currentList = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const item = /^[ \t]+-\s*(.*)$/.exec(line)
    if (item && currentList) {
      lists[currentList].push(item[1].trim())
      continue
    }
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (value === '' && /^[ \t]+-\s*/.test(lines[i + 1] || '')) {
      lists[key] = []
      currentList = key
      continue
    }
    fields[key] = unquote(value)
    currentList = null
  }

  return { fields, lists, body: src.slice(m[0].length), ok: true }
}

/**
 * 读一份文档的元数据与正文。
 * 没有 frontmatter 就返回 null —— 那不是本工具生成的文档，无从判断其新鲜度。
 *
 * 字段名做了兼容读取：`source_fingerprint` ← `code_hash`，`doc_status` ← `status`。
 * 统一字段名那天，已经落在别人仓库里的文档不该因此变成「陌生文件」。
 */
export function readDocMeta(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const { fields, lists, body, ok } = parseFrontmatter(text)
  if (!ok) return null

  const features = (lists.features || []).map(splitFeature).filter((f) => f.name)

  return {
    file,
    // 原始键值对：重组头部时靠它把不认识的字段（provider、model…）原样带走
    raw: fields,
    moduleName: fields.module || '',
    generatedBy: fields.generated_by || '',
    generatedAt: fields.generated_at || '',
    basedOnCommit: fields.based_on_commit || '',
    project: fields.project || '',
    mode: fields.mode || '',
    confidence: fields.confidence || '',
    sourceFingerprint: fields.source_fingerprint || fields.code_hash || '',
    bodyFingerprint: fields.body_fingerprint || '',
    docStatus: fields.doc_status || fields.status || '',
    validatedBy: fields.validated_by || '',
    validatedAt: fields.validated_at || '',
    validatedBodyFingerprint: fields.validated_body_fingerprint || '',
    sourceFiles: lists.source_files || [],
    features,
    body,
  }
}

/** 把元数据拼回 frontmatter。空值字段不写，避免把文档头撑成一堆空行。 */
export function buildFrontmatter(data = {}) {
  const lines = ['---']
  const put = (k, v) => { if (v !== undefined && v !== null && String(v) !== '') lines.push(`${k}: ${v}`) }

  put('generated_by', data.generatedBy || 'docs-bot')
  put('generated_at', data.generatedAt || new Date().toISOString())
  put('based_on_commit', data.basedOnCommit)
  put('project', data.project)
  put('mode', data.mode)
  put('module', data.module)
  put('source_fingerprint', data.sourceFingerprint)
  put('body_fingerprint', data.bodyFingerprint)
  put('doc_status', data.docStatus || 'candidate')
  put('validated_by', data.validatedBy)
  put('validated_at', data.validatedAt)
  put('validated_body_fingerprint', data.validatedBodyFingerprint)
  // 各家生成器特有的字段（provider、model…）。不认识不等于该丢，
  // 原样带走，否则每加一个字段都要回来改这个函数。
  for (const [k, v] of Object.entries(data.extra || {})) put(k, v)
  put('confidence', data.confidence || 'high')

  if (data.features && data.features.length) {
    lines.push('features:')
    for (const f of data.features) lines.push(`  - ${f.name}${FEATURES_SEP}${f.desc || ''}`)
  }
  if (data.sourceFiles && data.sourceFiles.length) {
    lines.push('source_files:')
    for (const f of data.sourceFiles) lines.push(`  - ${f}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

/* ──────────────────────── 状态判定 ──────────────────────── */

/**
 * 算出某个模块文档此刻的真实状态。
 *
 * 优先级：
 *   没有文档                              → 待生成
 *   源码变了（新旧算法都对不上）           → 已失效（压过一切）
 *   人的确认与当前正文对得上               → 已验证
 *   其余                                  → 候选
 *
 * 注意「人的确认」只从文档自身的 frontmatter 读，不再有独立的状态文件。
 * 独立文件的问题：任何模块的更新都会改动同一个文件，多分支合并时必然冲突，
 * 而且冲突内容是一串机器哈希，人工没法判断该保留哪一边。
 * 确认写进文档头部后，它随文档一起提交、回滚、review，零额外文件。
 *
 * @param docFile 文档的绝对路径（CI 与工作台的目录约定不同，所以由调用方传入）
 */
export function evaluateDoc(root, docFile, files) {
  const meta = fs.existsSync(docFile) ? readDocMeta(docFile) : null
  if (!meta) {
    return { status: 'missing', label: STATUS_LABEL.missing, sourceFingerprint: fingerprintFiles(root, files) }
  }

  const src = matchSourceFingerprint(root, files, meta.sourceFingerprint)
  const base = {
    sourceFingerprint: src.current,
    docSourceFingerprint: meta.sourceFingerprint,
    // 源码没变、只是记录的指纹用了旧算法 → 调用方可以原地升级，不必重新生成
    needsUpgrade: src.matched && src.algorithm === 'legacy',
  }

  if (meta.sourceFingerprint && !src.matched) {
    return {
      ...base,
      status: 'stale',
      label: STATUS_LABEL.stale,
      reason: '源码在文档生成之后发生了变化，文档可能已不准确',
    }
  }

  // 人的确认绑定到「那一版正文」。正文被重新生成过，确认就自动作废 ——
  // 这一步是整个机制的关节：确认的对象是内容，不是一个模块名。
  const body = matchTextFingerprint(meta.body, meta.validatedBodyFingerprint || meta.bodyFingerprint)
  if (meta.docStatus === 'validated' && meta.validatedBy && body.matched) {
    return {
      ...base,
      status: 'validated',
      label: STATUS_LABEL.validated,
      by: meta.validatedBy,
      at: meta.validatedAt,
    }
  }

  const wasValidated = meta.docStatus === 'validated' || !!meta.validatedBy
  return {
    ...base,
    status: 'candidate',
    label: STATUS_LABEL.candidate,
    reason: wasValidated ? '内容已重新生成，之前的确认随之作废，需要重新确认' : '',
  }
}

/**
 * 就地改写文档的 frontmatter，正文一个字不动。
 * 人的确认、指纹的算法升级，都走这一条路 —— 全量重写头部不会残留旧字段。
 */
/** 已知字段（含旧名）。不在这里面的一律原样保留，重组头部时不丢。 */
const KNOWN_FIELDS = new Set([
  'generated_by', 'generated_at', 'based_on_commit', 'project', 'mode', 'module',
  'source_fingerprint', 'body_fingerprint', 'doc_status', 'status', 'code_hash',
  'validated_by', 'validated_at', 'validated_body_fingerprint', 'confidence',
  'features', 'source_files',
])

export function rewriteDocMeta(docFile, patch = {}) {
  const meta = readDocMeta(docFile)
  if (!meta) return { ok: false, error: '文档不存在，或头部没有 frontmatter' }

  // 不认识的字段原样带走 —— 重写头部不该顺手删掉别人的东西
  const extra = {}
  for (const [k, v] of Object.entries(meta.raw)) {
    if (!KNOWN_FIELDS.has(k)) extra[k] = v
  }

  const merged = {
    generatedBy: meta.generatedBy,
    generatedAt: meta.generatedAt,
    basedOnCommit: meta.basedOnCommit,
    project: meta.project,
    mode: meta.mode,
    module: meta.moduleName,
    sourceFingerprint: meta.sourceFingerprint,
    bodyFingerprint: meta.bodyFingerprint,
    docStatus: meta.docStatus,
    validatedBy: meta.validatedBy,
    validatedAt: meta.validatedAt,
    validatedBodyFingerprint: meta.validatedBodyFingerprint,
    confidence: meta.confidence,
    features: meta.features,
    sourceFiles: meta.sourceFiles,
    extra,
    ...patch,
  }
  // 旧字段名（status / code_hash）在这里被规范化：写回去的是新名，
  // buildFrontmatter 又不会再输出旧名，所以不会残留两份真值。
  fs.writeFileSync(docFile, buildFrontmatter(merged) + meta.body, 'utf8')
  return { ok: true }
}

/** 人工确认：把「谁、什么时候、确认的是哪一版正文」写进文档自己的头部。 */
export function applyValidation(docFile, { by = '', at = new Date().toISOString() } = {}) {
  const meta = readDocMeta(docFile)
  if (!meta) return { ok: false, error: '没有找到可确认的文档' }
  const now = fingerprintText(meta.body)
  return rewriteDocMeta(docFile, {
    docStatus: 'validated',
    validatedBy: by,
    validatedAt: at,
    validatedBodyFingerprint: now,
    bodyFingerprint: now,
  })
}

/** 撤销确认：退回「候选」，并抹掉确认痕迹（否则下次判定会以为它曾经被担保过）。 */
export function clearValidation(docFile) {
  return rewriteDocMeta(docFile, {
    docStatus: 'candidate',
    validatedBy: '',
    validatedAt: '',
    validatedBodyFingerprint: '',
  })
}

/**
 * 把记录里的旧算法指纹就地换成当前算法。
 * 前提：已经确认过「源码其实没变，只是算法换代了」（needsUpgrade 为真）。
 * 这一步不花任何模型调用 —— 这正是当初设计 legacy 识别的原因。
 */
export function upgradeSourceFingerprint(docFile, root, files) {
  return rewriteDocMeta(docFile, { sourceFingerprint: fingerprintFiles(root, files) })
}

/** 汇总一份「文档现状」计数 */
export function summarizeDocs(list) {
  const out = { validated: 0, candidate: 0, stale: 0, missing: 0 }
  for (const m of list) {
    const s = m && m.doc && m.doc.status
    if (s && out[s] !== undefined) out[s] += 1
  }
  return out
}

/* ──────────────────────── 路径约定 ──────────────────────── */

// 工作台与 MCP 用的固定约定。CI 侧的目录来自 `.knowledge.mjs` 的 output 配置，
// 所以那边不使用这几个函数，而是把路径显式传给 evaluateDoc。
export const safeNameOf = (n) => String(n).replace(/[\\/:*?"<>|]/g, '_')
export const modulesDirOf = (root) => path.join(root, 'docs', 'current', 'modules')
export const indexPathOf = (root) => path.join(root, 'docs', 'current', 'INDEX.md')
export const docPathOf = (root, name) => path.join(modulesDirOf(root), safeNameOf(name) + '.md')

/* ──────────────────── 历史状态文件的迁移 ──────────────────── */

/**
 * 一次性迁移：把旧的独立状态文件里的「人的确认」搬进文档头部。
 *
 * 这个函数存在，只因为历史上确实用过独立状态文件（docs/current/status.json）。
 * 统一之后不再需要它，但**不能删** —— 否则统一那天，所有被人工确认过的文档
 * 会一起退回「候选」。那些确认是人的劳动，不该因为改了个存储位置就丢掉。
 *
 * 搬运前必须核对：只有当「当初确认的那一版正文」和现在完全一致，才把确认继承过来。
 * 否则搬的是一份已经过期的担保 —— 那比没有担保更糟，因为它会让 AI 以为有人核对过。
 */
export function migrateLegacyStatusJson(root, { removeAfter = true } = {}) {
  const file = path.join(root, 'docs', 'current', 'status.json')
  if (!fs.existsSync(file)) return { existed: false, migrated: [], removed: false }

  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { existed: true, migrated: [], removed: false, error: 'status.json 无法解析，已跳过' }
  }

  const records = data && typeof data === 'object' && data.modules ? data.modules : {}
  const migrated = []
  for (const [name, rec] of Object.entries(records)) {
    if (!rec || rec.status !== 'validated') continue
    const docFile = docPathOf(root, name)
    const meta = readDocMeta(docFile)
    if (!meta) {
      migrated.push({ name, carried: false, reason: '找不到对应文档' })
      continue
    }
    // 正文指纹对不上 → 内容已经重新生成过，这次的确认不再成立
    const sameBody = !rec.body_fingerprint || matchTextFingerprint(meta.body, rec.body_fingerprint).matched
    if (!sameBody) {
      migrated.push({ name, carried: false, reason: '正文在确认之后变过，确认不予继承' })
      continue
    }
    const now = fingerprintText(meta.body)
    rewriteDocMeta(docFile, {
      docStatus: 'validated',
      validatedBy: rec.by || '',
      validatedAt: rec.at || '',
      validatedBodyFingerprint: now,
      bodyFingerprint: now,
    })
    migrated.push({ name, carried: true, by: rec.by || '' })
  }

  // 只有当确实搬成功了才删旧文件；一个都没搬成，留着它让人还能手工核对
  const carried = migrated.filter((m) => m.carried).length
  const removed = removeAfter && carried > 0
  if (removed) fs.rmSync(file, { force: true })

  return { existed: true, migrated, removed, carried }
}

