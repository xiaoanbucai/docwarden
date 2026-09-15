#!/usr/bin/env node
/**
 * 文档守护 · MCP 服务
 *
 * 把 `docs/current/` 里的团队知识库暴露给 AI 编程助手（Cursor / Claude Code / Windsurf…），
 * 让它在写代码前能先查「这个模块是干什么的、有什么约定、为什么这么写」。
 *
 *   node docwarden-mcp.mjs --root /path/to/your-project
 *   DOCWARDEN_ROOT=/path/to/your-project node docwarden-mcp.mjs
 *
 * 零依赖：MCP 协议自己用 JSON-RPC 2.0 实现，不依赖官方 SDK，不需要 npm install。
 *
 * 两条硬规矩：
 *   1. **stdout 只能写 JSON-RPC 消息**，一个字节的日志都不能混进去，否则协议流会损坏。
 *      要打日志一律走 stderr。
 *   2. **每份文档的状态必须跟着内容一起返回**。这是整个知识库的前提：
 *      「候选」意味着没人确认过，AI 不能把它当结论用。状态不跟着走，
 *      状态机制就等于白做——AI 会把模型生成的猜测当成团队共识。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import {
  STATUS_LABEL, STATUS_HINT,
  evaluateDoc, evaluateFromDocs, docPathOf,
  readExportedModules, readFileIndex, readModuleIndex,
} from './lib/knowledge.mjs'

const log = (...a) => process.stderr.write('[docwarden-mcp] ' + a.join(' ') + '\n')

// ---------------------------------------------------------------- 目录解析

const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const ROOT_FROM_ARG = rootIdx >= 0 ? argv[rootIdx + 1] : ''
const DEFAULT_ROOT = ROOT_FROM_ARG || process.env.DOCWARDEN_ROOT || process.cwd()

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    '用法：node docwarden-mcp.mjs [--root <项目目录>]\n\n'
    + '不传 --root 时使用环境变量 DOCWARDEN_ROOT，再退回当前工作目录。\n'
    + '每个工具的 dir 参数可以临时指定其他项目。\n',
  )
  process.exit(0)
}

/** 兼容 Git Bash 的 `/c/Users/...` 写法与两侧引号 */
function normalizeDir(d) {
  let s = String(d).trim().replace(/^"|"$/g, '')
  const m = s.match(/^\/([A-Za-z])\/(.*)$/)
  if (m) s = m[1].toUpperCase() + ':/' + m[2]
  return s
}

const resolveRoot = (dir) => path.resolve(normalizeDir(dir && String(dir).trim() ? dir : DEFAULT_ROOT))

// ---------------------------------------------------------------- 读文档库

/**
 * 把文档库读成内存结构。
 * 关键点：模块的「源码文件清单」不是重新扫源码树得来的，而是从 INDEX.md 的
 * 「文件 → 模块」表反推出来的 —— 那张表本来就是脚本生成的检索键，正好一物两用，
 * 而且省掉一次全仓扫描。
 */
function loadLibrary(root) {
  const docsDir = path.join(root, 'docs', 'current')
  if (!fs.existsSync(docsDir)) {
    return {
      ok: false,
      error: `这个目录下没有文档库：${docsDir} 不存在。\n`
        + '先用文档守护（node docwarden.mjs）扫描该项目、生成模块文档并导出，然后再来查。',
    }
  }
  const found = readExportedModules(root)
  if (!found.ok || !found.modules.length) {
    return { ok: false, error: `文档库是空的：${path.join(docsDir, 'modules')} 里没有 .md 文档。` }
  }

  const fileIndex = readFileIndex(root)
  const filesOf = {}
  for (const [f, m] of Object.entries(fileIndex)) (filesOf[m] = filesOf[m] || []).push(f)
  const modIndex = readModuleIndex(root)

  const modules = found.modules.map((m) => {
    const files = (filesOf[m.name] || []).sort()
    // 有文件清单就现算指纹（能发现「源码变了」）；没有就退回只信文档头部写的
    const doc = files.length
      ? evaluateDoc(root, docPathOf(root, m.name), files)
      : evaluateFromDocs(root, m, null)
    const idx = modIndex[m.name] || {}
    return {
      name: m.name,
      files,
      lines: idx.lines,
      fileCount: idx.fileCount ?? (files.length || undefined),
      status: doc.status,
      doc,
      body: m.body.trim(),
      generatedAt: m.generatedAt,
    }
  })
  return { ok: true, root, docsDir, modules }
}

/** 每份返回给 AI 的文档都要带上这句 —— 这是知识库能不能被信任的前提 */
function statusBanner(m) {
  const label = STATUS_LABEL[m.status] || m.status
  const hint = STATUS_HINT[m.status] || ''
  let extra = ''
  if (m.status === 'stale' && m.doc.reason) extra = '（' + m.doc.reason + '）'
  if (m.status === 'validated' && m.doc.by) extra = '（由 ' + m.doc.by + ' 确认' + (m.doc.at ? '，' + String(m.doc.at).slice(0, 10) : '') + '）'
  return `> 文档状态：**${label}** ${extra}\n> ${hint}`
}

function moduleTable(modules) {
  const rows = modules.map((m) => {
    const files = m.files.length ? m.files.join(', ') : '（索引里没有记录）'
    return `| \`${m.name}\` | ${STATUS_LABEL[m.status] || m.status} | ${m.lines ?? '—'} | ${m.fileCount ?? '—'} | ${files} |`
  })
  return ['| 模块 | 状态 | 行数 | 文件数 | 覆盖的文件 |', '|---|---|---:|---:|---|', ...rows].join('\n')
}

function countBy(modules) {
  const c = { validated: 0, candidate: 0, stale: 0, missing: 0 }
  for (const m of modules) if (c[m.status] !== undefined) c[m.status] += 1
  return c
}

function unknownModule(modules, name) {
  const q = String(name).toLowerCase()
  const near = modules
    .map((m) => [m.name, (m.name.toLowerCase().includes(q) || q.includes(m.name.toLowerCase()) ? 1 : 0) + (m.name.toLowerCase()[0] === q[0] ? 1 : 0)])
    .filter((x) => x[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map((x) => x[0])
  return `没有找到名为 \`${name}\` 的模块。`
    + (near.length ? `\n你是不是想找：${near.map((n) => '`' + n + '`').join('、')}？` : '')
    + `\n可用模块：${modules.map((m) => '`' + m.name + '`').join('、')}`
}

// ---------------------------------------------------------------- 工具实现

const T = {}

T.knowledge_overview = ({ dir }) => {
  const root = resolveRoot(dir)
  const lib = loadLibrary(root)
  if (!lib.ok) return lib.error
  const c = countBy(lib.modules)
  return [
    '# 团队知识库总览',
    '',
    `位置：\`${lib.docsDir}\``,
    `模块：${lib.modules.length} 个 —— 已验证 ${c.validated} · 候选 ${c.candidate}`
      + (c.stale ? ` · **已失效 ${c.stale}**` : '') + (c.missing ? ` · 未生成 ${c.missing}` : ''),
    '',
    '`已验证` = 有人确认过且之后源码与正文都没变；`候选` = 没人确认过，内容由模型生成；'
      + '`已失效` = 文档生成之后源码改了，内容很可能过时。**引用任何结论前先看它的状态。**',
    '',
    moduleTable(lib.modules),
    '',
    '想深入了解某个模块，用 `get_module_doc`；想知道某个文件属于哪个模块，用 `find_module_for_file`。',
  ].join('\n')
}

T.get_module_doc = ({ dir, module: name }) => {
  const root = resolveRoot(dir)
  const lib = loadLibrary(root)
  if (!lib.ok) return lib.error
  const want = String(name || '').trim()
  if (!want) return '请给出 module 参数。\n' + unknownModule(lib.modules, '')
  const hit = lib.modules.find((m) => m.name === want)
    || lib.modules.find((m) => m.name.toLowerCase() === want.toLowerCase())
    || lib.modules.find((m) => m.name.toLowerCase().includes(want.toLowerCase()))
  if (!hit) return unknownModule(lib.modules, want)

  return [
    `# ${hit.name}`,
    '',
    statusBanner(hit),
    '',
    hit.files.length ? `覆盖文件（${hit.files.length}）：${hit.files.map((f) => '`' + f + '`').join('、')}` : '',
    hit.generatedAt ? `生成于：${hit.generatedAt}` : '',
    '',
    '---',
    '',
    hit.body,
  ].filter((x) => x !== '').join('\n')
}

T.find_module_for_file = ({ dir, file }) => {
  const root = resolveRoot(dir)
  const lib = loadLibrary(root)
  if (!lib.ok) return lib.error
  const raw = String(file || '').trim()
  if (!raw) return '请给出 file 参数，例如 `src/pages/index/index.vue`。'

  const map = readFileIndex(root)
  const keys = Object.keys(map)
  if (!keys.length) return '索引里没有「文件 → 模块」表。可能这个文档库是旧版本生成的，重新导出一次即可。'

  let p = raw.replace(/\\/g, '/')
  if (path.isAbsolute(p)) p = path.relative(root, p).replace(/\\/g, '/')
  p = p.replace(/^\.?\//, '')

  let rel = null
  let ambiguous = null
  if (map[p]) rel = p
  if (!rel) {
    const suffix = keys.filter((k) => k.endsWith('/' + p) || k.endsWith(p))
    if (suffix.length === 1) rel = suffix[0]
    else if (suffix.length > 1) ambiguous = suffix
  }
  if (!rel && !ambiguous) {
    const base = p.split('/').pop()
    const byBase = keys.filter((k) => k.split('/').pop() === base)
    if (byBase.length === 1) rel = byBase[0]
    else if (byBase.length > 1) ambiguous = byBase
  }

  if (ambiguous) {
    return `\`${raw}\` 匹配到多个文件，请给出更完整的路径：\n`
      + ambiguous.map((k) => `- \`${k}\` → 模块 \`${map[k]}\``).join('\n')
  }
  if (!rel) {
    return `索引里找不到 \`${raw}\`。\n`
      + '可能是路径写错了，也可能是这个文件在生成文档时没有被纳入任何模块。\n'
      + '可以先用 `search_docs` 按关键词找找。'
  }

  const modName = map[rel]
  const hit = lib.modules.find((m) => m.name === modName)
  const head = [
    `\`${rel}\` 属于模块 **\`${modName}\`**。`,
    hit && hit.files.length ? `\n这个模块覆盖的文件：${hit.files.map((f) => '`' + f + '`').join('、')}` : '',
    '',
  ]
  if (!hit) {
    return head.join('\n') + `\n（索引里记录了这个映射，但没找到对应的文档文件。）`
  }
  return [
    ...head,
    statusBanner(hit),
    '',
    '---',
    '',
    hit.body,
  ].join('\n')
}

T.search_docs = ({ dir, query, limit }) => {
  const root = resolveRoot(dir)
  const lib = loadLibrary(root)
  if (!lib.ok) return lib.error
  const q = String(query || '').trim().toLowerCase()
  if (!q) return '请给出 query 参数。'
  const n = Math.max(1, Math.min(20, Number(limit) || 5))

  const scored = []
  for (const m of lib.modules) {
    let score = 0
    const why = []
    if (m.name.toLowerCase().includes(q)) { score += 10; why.push('模块名命中') }
    const fHit = m.files.filter((f) => f.toLowerCase().includes(q))
    if (fHit.length) { score += 8; why.push(`${fHit.length} 个文件路径命中`); if (fHit.length === 1) why[why.length - 1] += `：${fHit[0]}` }
    const lower = m.body.toLowerCase()
    const at = lower.indexOf(q)
    const occurrences = at < 0 ? 0 : lower.split(q).length - 1
    if (occurrences) { score += Math.min(6, occurrences); why.push(`正文出现 ${occurrences} 次`) }

    let snippet = ''
    if (at >= 0) {
      const from = Math.max(0, at - 120)
      const to = Math.min(m.body.length, at + 180)
      snippet = (from > 0 ? '…' : '') + m.body.slice(from, to).replace(/\n+/g, ' ') + (to < m.body.length ? '…' : '')
    }
    if (fHit.length && !snippet) snippet = '命中文件：' + fHit.join('、')

    if (score > 0) scored.push({ m, score, why: why.join('，'), snippet })
  }
  scored.sort((a, b) => b.score - a.score)
  if (!scored.length) {
    return `没有文档提到 \`${query}\`。\n`
      + '可能是这个功能还没被文档覆盖，也可能是换了说法。可以先用 `knowledge_overview` 看看都有哪些模块。'
  }
  const top = scored.slice(0, n)
  return [
    `在文档库里搜 \`${query}\`：命中 ${scored.length} 个模块，列出前 ${top.length} 个。`,
    '',
    ...top.map((s) => [
      `## \`${s.m.name}\`（${STATUS_LABEL[s.m.status] || s.m.status}）`,
      `命中原因：${s.why}`,
      s.snippet ? `\n> ${s.snippet}` : '',
      `\n想看全文用 \`get_module_doc\`（module: ${s.m.name}）`,
      '',
    ].filter((x) => x !== '').join('\n')),
  ].join('\n')
}

T.check_freshness = ({ dir }) => {
  const root = resolveRoot(dir)
  const lib = loadLibrary(root)
  if (!lib.ok) return lib.error
  const c = countBy(lib.modules)
  const group = (st) => lib.modules.filter((m) => m.status === st)

  const out = [
    '# 文档新鲜度检查',
    '',
    `已验证 ${c.validated} · 候选 ${c.candidate} · 已失效 ${c.stale}`,
    '',
  ]
  const stale = group('stale')
  if (stale.length) {
    out.push(`## 已失效 ${stale.length} 个 —— 不要信它们的内容`, '')
    for (const m of stale) out.push(`- \`${m.name}\`：${m.doc.reason || '源码已变更'}`)
    out.push('', '这些文档在生成之后源码被改过。需要重新生成，或者直接读源码。', '')
  }
  const cand = group('candidate')
  if (cand.length) {
    out.push(`## 候选 ${cand.length} 个 —— 内容可用但没人确认过`, '')
    out.push(cand.map((m) => `\`${m.name}\``).join('、'), '')
    out.push('它们由模型生成，没人复核过。可以拿来快速建立印象，**但不要当成团队共识引用**。', '')
  }
  const val = group('validated')
  if (val.length) {
    out.push(`## 已验证 ${val.length} 个 —— 可以放心引用`, '')
    for (const m of val) out.push(`- \`${m.name}\`${m.doc.by ? '（' + m.doc.by + ' 确认）' : ''}`)
    out.push('')
  }
  return out.join('\n')
}

// ---------------------------------------------------------------- 工具定义

const TOOLS = [
  {
    name: 'knowledge_overview',
    description: '列出这个项目的团队知识库里都有哪些模块文档、各自的状态与覆盖的文件。'
      + '当你想先了解「这个项目有什么、哪些有文档」时用它。',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string', description: '项目目录（可选，默认用启动时配置的那个）' } },
    },
    run: T.knowledge_overview,
  },
  {
    name: 'get_module_doc',
    description: '按模块名取该模块的完整说明文档（职责、核心流程、关键设计、对外接口、注意事项）。'
      + '返回值开头会标明文档状态，请务必先看状态再决定能不能引用其中的结论。',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: '模块名，例如 pages、utils、cloudfunctions' },
        dir: { type: 'string', description: '项目目录（可选）' },
      },
      required: ['module'],
    },
    run: T.get_module_doc,
  },
  {
    name: 'find_module_for_file',
    description: '给一个文件路径，找出它属于哪个模块，并返回该模块的文档。'
      + '当你正在改某个文件、想知道「这个文件在整体里是干什么的、有什么约定」时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件路径，绝对路径或相对项目的路径都行' },
        dir: { type: 'string', description: '项目目录（可选）' },
      },
      required: ['file'],
    },
    run: T.find_module_for_file,
  },
  {
    name: 'search_docs',
    description: '在知识库里按关键词搜模块名、文件路径和文档正文，返回命中的模块与上下文片段。'
      + '适合「我记得哪里有提过 X 但不知道在哪个模块」的情形。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词' },
        limit: { type: 'number', description: '最多返回几个模块，默认 5' },
        dir: { type: 'string', description: '项目目录（可选）' },
      },
      required: ['query'],
    },
    run: T.search_docs,
  },
  {
    name: 'check_freshness',
    description: '检查文档库里哪些文档已失效、哪些还没人确认过。'
      + '在准备依赖这些文档下判断之前，先用它确认一下可信度。',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string', description: '项目目录（可选）' } },
    },
    run: T.check_freshness,
  },
]

// ---------------------------------------------------------------- JSON-RPC

const send = (msg) => { process.stdout.write(JSON.stringify(msg) + '\n') }

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', async (line) => {
  const s = line.trim()
  if (!s) return
  let req
  try { req = JSON.parse(s) } catch { log('收到无法解析的行，已忽略'); return }

  const { id, method, params } = req
  const isNotification = id === undefined || id === null

  try {
    if (method === 'initialize') {
      // 回显客户端请求的协议版本：客户端说得出，就按它说的来，兼容性最好
      return send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'docwarden-knowledge', version: '1.0.0' },
        },
      })
    }
    if (method === 'notifications/initialized' || method === 'initialized') return
    if (method === 'ping') { if (!isNotification) send({ jsonrpc: '2.0', id, result: {} }); return }

    if (method === 'tools/list') {
      return send({
        jsonrpc: '2.0', id,
        result: {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      })
    }

    if (method === 'tools/call') {
      const name = params?.name
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) {
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '未知工具：' + name }], isError: true } })
      }
      try {
        const text = await tool.run(params?.arguments || {})
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } })
      } catch (e) {
        // 工具执行失败要按 MCP 的约定放在 result 里带 isError，而不是抛 JSON-RPC error
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '执行出错：' + (e?.message || e) }], isError: true } })
      }
    }

    if (isNotification) return
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } })
  } catch (e) {
    log('处理 ' + method + ' 时异常：' + (e?.stack || e))
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message || e) } })
  }
})

rl.on('close', () => process.exit(0))
log('已启动，默认项目目录：' + DEFAULT_ROOT)
