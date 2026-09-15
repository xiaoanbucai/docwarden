#!/usr/bin/env node
/**
 * 文档守护 · docwarden
 * 本地界面（可选辅助入口）—— 零依赖，Node 18+
 *
 * 真正的运行位置是 CI（GitHub Actions / GitLab CI）。这个界面用来在接 CI 之前，
 * 先直观地看一遍「扫描 → 划模块 → 生成 → 逐篇确认」长什么样。两边判定状态用的是
 * 同一份实现（docs-kit/scripts/lib/freshness.mjs），不会各说各话。
 *
 *   node docwarden.mjs                启动并自动打开浏览器
 *   node docwarden.mjs --port 5173    指定端口
 *   node docwarden.mjs --no-open      不自动打开浏览器
 *
 * 它做什么：
 *   1. 读一个本地项目目录，扫出源码文件与行数
 *   2. 按目录树自动划出候选模块（这是整件事里唯一的人工门槛，所以做成了可视化可编辑）
 *   3. 逐模块生成文档：可接任意 OpenAI 兼容接口，也可用内置演示模式
 *   4. 写回 <项目>/docs/current/ 并生成索引页
 *   5. 管住文档的「新鲜度」：源码一变就标已失效；没人确认过的标候选，确认过的标已验证
 *
 * 它不做什么：
 *   - 不改你的任何源码，只往 docs/ 里写
 *   - 没有遥测（除了你自己配置的模型接口，不向任何第三方发东西）
 *   - 不需要 npm install（`lib/knowledge.mjs` 只是同目录的普通模块，不是 npm 依赖；
 *     它被本文件与 docwarden-mcp.mjs 共用，避免状态判定逻辑出现两份实现）
 */

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { exec } from 'node:child_process'
// 文档新鲜度的判定逻辑（指纹、状态、人的确认）与 CI 流水线、MCP 服务共用同一份实现。
// 核心放在 docs-kit/scripts/lib/freshness.mjs —— CI 是主线，它得跟着主线走。
import {
  STATUS_LABEL, fingerprintFiles, fingerprintText, safeNameOf, docPathOf,
  readDocMeta, evaluateDoc, summarizeDocs, matchTextFingerprint,
  buildFrontmatter, applyValidation, clearValidation, migrateLegacyStatusJson,
} from './lib/knowledge.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2)
const getFlag = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return def
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const PORT = Number(getFlag('port', 5173)) || 5173
const NO_OPEN = argv.includes('--no-open')

// ---------------------------------------------------------------- 扫描规则

// 这些目录一律不进扫描：依赖、构建产物、版本库内部
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt',
  '.output', '.svelte-kit', 'coverage', 'vendor', 'target', '__pycache__', '.venv',
  'venv', 'env', '.idea', '.vscode', '.cache', 'tmp', 'temp', '.tmp', 'obj', 'Pods',
  '.gradle', '.mvn', '.turbo', '.parcel-cache', 'bower_components', '.history',
  '.workbuddy', '.qoder', 'miniprogram_npm', 'unpackage',
])

// 参与生成文档的源码类型
const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro',
  '.py', '.rb', '.php', '.go', '.java', '.kt', '.kts', '.scala', '.rs', '.cs',
  '.swift', '.m', '.mm', '.c', '.cc', '.cpp', '.h', '.hpp', '.dart', '.lua', '.r',
  '.sql', '.sh', '.bash', '.ps1', '.wxml', '.wxss', '.wxs', '.axml', '.acss',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.styl',
])

// 纯容器目录：本身不表达业务含义，划模块时剥掉
const CONTAINERS = new Set(['src', 'lib', 'libs', 'source', 'sources', 'code', 'packages', 'app', 'apps'])

const MAX_FILES = 8000          // 扫描上限，防止误选巨型目录
const BIG_FILE = 800 * 1024     // 超过这个大小的文件跳过
const MODULE_FILE_LIMIT = 25    // 一个模块超过这么多文件就考虑下钻
const MODULE_LINE_LIMIT = 1200  // 一个模块超过这么多行就考虑下钻
const MIN_MODULE_LINES = 40     // 更小的分组不值得单独成篇

// ---------------------------------------------------------------- 扫描

async function scanDir(root) {
  const files = []
  let truncated = false
  const walk = async (absDir, rel) => {
    if (files.length >= MAX_FILES) { truncated = true; return }
    let entries
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (files.length >= MAX_FILES) { truncated = true; return }
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(path.join(absDir, e.name), childRel)
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (!CODE_EXT.has(ext)) continue
        const abs = path.join(absDir, e.name)
        let st
        try { st = await fsp.stat(abs) } catch { continue }
        if (st.size > BIG_FILE) continue
        let text = ''
        try { text = await fsp.readFile(abs, 'utf8') } catch { continue }
        files.push({ rel: childRel, abs, lines: text.split('\n').length, text })
      }
    }
  }
  await walk(root, '')
  return { files, truncated }
}

/** 剥掉开头的纯容器目录，得到有业务含义的路径段 */
function meaningfulSegments(rel) {
  let segs = rel.split('/')
  while (segs.length > 2 && CONTAINERS.has(segs[0])) segs = segs.slice(1)
  return segs
}

function moduleKeyFor(rel, depth) {
  const segs = meaningfulSegments(rel)
  const take = Math.min(depth, Math.max(1, segs.length - 1))
  return segs.slice(0, take).join('/')
}

function buildModules(files) {
  // 先按深度 1 分组
  let groups = new Map()
  for (const f of files) {
    const k = moduleKeyFor(f.rel, 1)
    if (!groups.has(k)) groups.set(k, { name: k, files: [] })
    groups.get(k).files.push(f)
  }

  // 过大的分组下钻一层
  const out = []
  for (const g of groups.values()) {
    const lines = g.files.reduce((a, f) => a + f.lines, 0)
    const subKeys = new Set(g.files.map((f) => moduleKeyFor(f.rel, 2)))
    if ((g.files.length > MODULE_FILE_LIMIT || lines > MODULE_LINE_LIMIT) && subKeys.size > 1) {
      const subs = new Map()
      for (const f of g.files) {
        const k = moduleKeyFor(f.rel, 2)
        if (!subs.has(k)) subs.set(k, { name: k, files: [] })
        subs.get(k).files.push(f)
      }
      for (const s of subs.values()) out.push(s)
    } else {
      out.push(g)
    }
  }

  // 汇总
  const ranked = out
    .map((g) => {
      const lines = g.files.reduce((a, f) => a + f.lines, 0)
      return {
        name: g.name,
        fileCount: g.files.length,
        lines,
        files: g.files.map((f) => f.rel),
        sample: g.files.slice(0, 4).map((f) => f.rel),
      }
    })
    .sort((a, b) => b.lines - a.lines)

  // 太小的分组默认不单独成篇，但仍然列出来让用户自己决定——
  // 悄悄丢掉分组是最容易让人不信任一个工具的做法。
  const kept = ranked.filter((m) => m.lines >= MIN_MODULE_LINES)
  const small = ranked.filter((m) => m.lines < MIN_MODULE_LINES).slice(0, 30)
  if (kept.length) return { modules: kept, small, fallback: false }
  // 小项目：全都低于阈值，那就全给出来
  return { modules: ranked.slice(0, 8), small: [], fallback: true }
}

/** 容忍 Git Bash / MSYS 风格路径：/c/Users/me/app → C:/Users/me/app */
function normalizeDir(input) {
  let s = String(input).trim().replace(/^"(.*)"$/, '$1')
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/)
  if (m) s = `${m[1]}:/${m[2]}`
  return s
}

// ---------------------------------------------------------------- 代码收集

function collectCode(root, moduleFiles, cap = 120000) {
  const chunks = []
  let total = 0
  let totalLines = 0
  const used = []
  for (const rel of moduleFiles) {
    const abs = path.join(root, rel)
    let text = ''
    try { text = fs.readFileSync(abs, 'utf8') } catch { continue }
    totalLines += text ? text.split('\n').length : 0
    const head = `\n\n===== ${rel} =====\n`
    if (total + head.length + text.length > cap) {
      const room = cap - total - head.length
      if (room > 2000) {
        chunks.push(head + text.slice(0, room) + '\n/* … 已截断 … */')
        used.push(rel)
      }
      break
    }
    chunks.push(head + text)
    used.push(rel)
    total += head.length + text.length
  }
  return { code: chunks.join(''), chars: total, used, totalLines }
}


// ---------------------------------------------------------------- 演示模式

function detectStructure(code) {
  const out = { exportedFns: [], privateFns: [], classes: [], exports: [], comments: [] }
  const seen = new Set()
  const push = (arr, v) => { if (v && !seen.has(v)) { seen.add(v); arr.push(v) } }

  for (const m of code.matchAll(/export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) push(out.exportedFns, m[1])
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) push(out.exportedFns, m[1])
  for (const m of code.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) push(out.classes, m[1])
  for (const m of code.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const piece of m[1].split(',')) {
      const name = piece.split(/\s+as\s+/).pop().trim()
      if (name) push(out.exports, name)
    }
  }
  for (const m of code.matchAll(/module\.exports\s*=\s*\{([^}]+)\}/g)) {
    for (const piece of m[1].split(',')) {
      const name = piece.split(':')[0].trim()
      if (name) push(out.exports, name)
    }
  }
  // 模块级（不缩进）的 function / def 是可被外部引用的；缩进的属于内部实现
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) push(out.privateFns, m[1])
  for (const m of code.matchAll(/^def\s+([a-zA-Z_]\w*)/gm)) push(out.exportedFns, m[1])
  for (const m of code.matchAll(/^class\s+([A-Z]\w*)/gm)) push(out.classes, m[1])
  // 已经被 export 的，从私有列表里去掉
  out.privateFns = out.privateFns.filter((f) => !out.exportedFns.includes(f))

  const blocks = code.match(/\/\*\*?[\s\S]{10,400}?\*\//g) || []
  for (const b of blocks.slice(0, 6)) {
    const lines = b.split('\n').map((l) => l.replace(/^\s*\/?\*+\s?/, '').trim()).filter((l) => l && !l.startsWith('@'))
    if (lines.length) out.comments.push(lines.slice(0, 4).join(' ').replace(/\s*\/\s*$/, ''))
  }
  for (const m of code.matchAll(/^\s*#\s*(.{10,120})$/gm)) out.comments.push(m[1].trim())
  return out
}

function mockDoc(module, code) {
  const s = detectStructure(code)
  const L = []
  L.push('> ⚠️ **演示模式**：本文档由本地静态分析生成，只用于预览结构与排版，**不代表真实生成质量**。')
  L.push('> 接入模型后重新生成，内容会完全不同。')
  L.push('')
  L.push('## 模块职责')
  const top = module.files.map((f) => f.split('/').pop()).filter((n) => /^(index|main|mod|app)\./i.test(n))
  L.push(`本模块对应 \`${module.name}\`，共 ${module.fileCount} 个文件、约 ${module.lines} 行。`)
  if (top.length) L.push(`入口文件为 ${top.map((t) => '`' + t + '`').join('、')}。`)
  L.push('')
  if (s.comments.length) {
    L.push('## 源码中出现的说明')
    for (const c of s.comments.slice(0, 3)) L.push(`- ${c}`)
    L.push('')
  }
  L.push('## 文件构成')
  L.push('')
  L.push('| 文件 | 说明 |')
  L.push('|---|---|')
  for (const f of module.files.slice(0, 12)) L.push(`| \`${f}\` | [待确认] |`)
  if (module.files.length > 12) L.push(`| … | 另有 ${module.files.length - 12} 个文件 |`)
  L.push('')

  const pub = [
    ...s.exportedFns.map((n) => [n, '函数']),
    ...s.classes.map((n) => [n, '类']),
    ...s.exports.map((n) => [n, '导出']),
  ]
  L.push('## 对外接口')
  L.push('')
  if (pub.length) {
    L.push('| 名称 | 类型 |')
    L.push('|---|---|')
    for (const [n, t] of pub.slice(0, 20)) L.push(`| \`${n}\` | ${t} |`)
  } else {
    L.push('未从代码中识别到对外暴露的符号 [待确认]。')
  }
  L.push('')
  if (s.privateFns.length) {
    L.push('## 模块内部符号')
    L.push('')
    L.push('以下符号没有导出，仅供模块内部使用：' + s.privateFns.slice(0, 12).map((n) => '`' + n + '`').join('、') + '。')
    L.push('')
  }
  L.push('## 注意事项')
  L.push('- 上述内容全部来自本地静态分析，用于验证流程是否跑通。')
  L.push('- 真实生成会补上核心流程、关键设计、边界条件等章节。')
  return L.join('\n')
}

// ---------------------------------------------------------------- 真实模型

const DEFAULT_PROMPT = `你是一位资深工程师，正在为一个真实项目撰写**模块级技术文档**。你的读者是两周后接手这个模块的同事。

## 项目背景
- 模块：{{moduleName}}

## 本模块包含的文件
{{fileList}}

## 这些文件的当前源码
{{code}}

## 你的任务
为「{{moduleName}}」写一份技术文档，让一个没接触过这个模块的工程师能在十分钟内理解它。

## 内容结构
用 Markdown 输出，按以下结构组织（没有内容的章节直接省略，不要写"暂无"）：

### 模块职责
一到三句话说明这个模块解决什么问题、在系统中的位置。

### 核心流程
描述主要业务流程或数据流。用有序列表。只描述代码中确实存在的流程。

### 关键设计
列出这个模块里值得注意的设计选择、约定、约束。

### 对外接口
如果模块对外暴露了函数、组件、事件、API，列出名称、作用、关键参数。用表格。

### 注意事项
容易踩坑的地方：不易察觉的副作用、依赖的执行顺序、特殊场景的处理。

## 硬性约束（必须遵守）
1. **只描述代码中实际存在的行为。** 不要推测、不要脑补、不要"一般来说"。
2. **不要复述源码。** 描述职责与流程，不是代码本身。整篇代码块不超过 3 个。
3. **不确定的地方必须标注 \`[待确认]\`**，不要用模糊语言掩盖。
4. **保留专有名词原样**，用反引号包裹，不翻译不改写。
5. **不要写主观评价。**
6. **不要在结尾加总结段。**
7. **不要加一级标题**，从 \`##\` 开始。
8. **不要写「业务背景」「设计取舍」这类内容**，那部分由人工维护。
9. **不要把「代码里存在」写成「团队认可」。** 临时降级开关、兼容分支、废弃逻辑要如实描述存在与作用，但不得表述为推荐做法或设计模式；判断不了的标 \`[待确认]\`。

## 输出格式
直接输出 Markdown 正文，不要加前言、说明或寒暄，不要用代码块包裹整篇文档。`

async function callModel({ baseUrl, apiKey, model, prompt, temperature, maxTokens, timeoutMs }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 180000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是一位严谨的资深工程师，只输出文档正文。' },
          { role: 'user', content: prompt },
        ],
        temperature: temperature ?? 0.2,
        max_tokens: maxTokens ?? 4096,
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`模型接口返回 ${res.status}${body ? '：' + body.slice(0, 300) : ''}`)
    }
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content
    if (!text) throw new Error('模型返回内容为空')
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- HTTP

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = ''
  req.on('data', (c) => { raw += c; if (raw.length > 5e6) { reject(new Error('请求体过大')); req.destroy() } })
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { reject(new Error('请求体不是合法 JSON')) } })
  req.on('error', reject)
})

async function serveUI(res) {
  const candidates = ['docwarden.ui.html', 'ui.html']
  for (const name of candidates) {
    const p = path.join(__dirname, name)
    try {
      const html = await fsp.readFile(p, 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    } catch { /* 试下一个 */ }
  }
  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('找不到界面文件 docwarden.ui.html，请确认它与 docwarden.mjs 在同一目录。')
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      return await serveUI(res)
    }

    // 拉取模型清单：转发到 {baseUrl}/models，让用户不必盲猜模型名。
    // 用 POST 而非 GET，避免 API Key 出现在 URL 里被日志记录。
    if (req.method === 'POST' && u.pathname === '/api/models') {
      const { baseUrl, apiKey } = await readBody(req)
      if (!baseUrl) return json(res, 400, { ok: false, error: '请先填写接口地址' })
      const url = `${String(baseUrl).replace(/\/+$/, '')}/models`
      try {
        const r = await fetch(url, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(25000),
        })
        if (!r.ok) {
          const body = await r.text().catch(() => '')
          return json(res, 200, {
            ok: false,
            error: `接口返回 ${r.status}${body ? '：' + body.slice(0, 200) : ''}`,
          })
        }
        const data = await r.json()
        const raw = data?.data || data?.models || []
        const ids = raw.map((m) => m?.id || m?.name).filter(Boolean).sort()
        return json(res, 200, { ok: true, models: ids, count: ids.length })
      } catch (e) {
        return json(res, 200, { ok: false, error: `拉取失败：${e?.message || e}` })
      }
    }

    if (req.method === 'POST' && u.pathname === '/api/scan') {
      const { dir } = await readBody(req)
      if (!dir) return json(res, 400, { ok: false, error: '请填写项目目录' })
      const root = path.resolve(normalizeDir(dir))
      let st
      try { st = await fsp.stat(root) } catch { return json(res, 400, { ok: false, error: `目录不存在或无权访问：${root}` }) }
      if (!st.isDirectory()) return json(res, 400, { ok: false, error: '这不是一个目录' })

      const t0 = Date.now()
      const { files, truncated } = await scanDir(root)
      if (!files.length) {
        return json(res, 200, { ok: true, root, empty: true, totalFiles: 0, totalLines: 0, modules: [] })
      }
      const { modules, small, fallback } = buildModules(files)
      // 每个模块都带上它的文档现状，界面才能把「候选 / 已验证 / 已失效」画出来
      const withDoc = (list) => list.map((m) => ({
        ...m,
        doc: evaluateDoc(root, docPathOf(root, m.name), m.files),
      }))
      const modsOut = withDoc(modules)
      const smallOut = withDoc(small)
      return json(res, 200, {
        ok: true,
        root,
        truncated,
        fallback,
        totalFiles: files.length,
        totalLines: files.reduce((a, f) => a + f.lines, 0),
        modules: modsOut,
        small: smallOut,
        docSummary: summarizeDocs(modsOut.concat(smallOut)),
        skipped: 0,
        ms: Date.now() - t0,
      })
    }

    if (req.method === 'POST' && u.pathname === '/api/generate') {
      const { dir, module, provider, config = {} } = await readBody(req)
      if (!dir || !module?.files?.length) return json(res, 400, { ok: false, error: '缺少目录或模块文件清单' })
      const root = path.resolve(normalizeDir(dir))
      const t0 = Date.now()

      const { code, chars, used, totalLines } = collectCode(root, module.files, config.maxCodeChars || 120000)
      if (!code.trim()) return json(res, 400, { ok: false, error: '未能读到任何代码内容' })

      // 兜底：调用方可能只传 name/files，缺 fileCount、lines 时自行推导，
      // 避免 undefined 被直接写进生成的文档。
      const mod = {
        name: module.name || '未命名模块',
        files: module.files,
        fileCount: module.fileCount || module.files.length,
        lines: module.lines || totalLines,
      }

      let markdown
      if (provider === 'mock') {
        // 演示模式加一点延迟，让进度条不是瞬间闪完，便于观察流程
        await new Promise((r) => setTimeout(r, 400))
        markdown = mockDoc({ ...mod, files: used }, code)
      } else {
        const prompt = (config.promptTemplate || DEFAULT_PROMPT)
          .replace(/\{\{moduleName\}\}/g, mod.name)
          .replace(/\{\{moduleTitle\}\}/g, mod.name)
          .replace(/\{\{fileList\}\}/g, used.map((f) => '- ' + f).join('\n'))
          .replace(/\{\{code\}\}/g, code)
        const apiKey = config.apiKey || process.env.LLM_API_KEY || ''
        if (!config.baseUrl || !config.model) {
          return json(res, 400, { ok: false, error: '请填写接口地址（baseUrl）与模型名' })
        }
        markdown = await callModel({
          baseUrl: config.baseUrl,
          apiKey,
          model: config.model,
          prompt,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          timeoutMs: config.timeoutMs,
        })
      }

      return json(res, 200, {
        ok: true,
        markdown,
        stats: { codeChars: chars, docChars: markdown.length, files: used.length, ms: Date.now() - t0 },
      })
    }

    if (req.method === 'POST' && u.pathname === '/api/export') {
      const { dir, docs } = await readBody(req)
      if (!dir || !Array.isArray(docs) || !docs.length) return json(res, 400, { ok: false, error: '没有可导出的文档' })
      const root = path.resolve(normalizeDir(dir))
      const outDir = path.join(root, 'docs', 'current', 'modules')
      await fsp.mkdir(outDir, { recursive: true })

      // 统一之前，人的确认存在独立的 status.json 里。顺手把它搬进文档头部。
      // 搬完那个文件就消失了 —— 确认跟着文档走，才不会在多分支合并时打架。
      const migration = migrateLegacyStatusJson(root)
      if (migration.carried) {
        log(`已把 ${migration.carried} 条历史确认从 status.json 搬入文档头部`)
      }

      const written = []
      // 模块名要当文件名用。统一在这里净化一次，避免「写文件」和「写索引」两处逻辑跑偏。
      const safeName = safeNameOf
      const statusOf = {}
      for (const d of docs) {
        const safe = safeName(d.name)
        const rel = `docs/current/modules/${safe}.md`
        const abs = path.join(root, rel)
        const srcFp = fingerprintFiles(root, d.files)
        // 正文指纹必须算在「实际写进文件的那些字节」上：下面写入时会补一个换行，
        // 这里就得先补上再算。否则指纹与文件内容差一个字符，下一次判定会认为
        // 「正文被改过」，把刚确认好的文档打回候选 —— 这个坑踩过。
        const bodyText = String(d.markdown ?? '') + '\n'
        const bodyFp = fingerprintText(bodyText)

        // 人的确认绑定到「那一版正文」：正文没变则确认继续有效，正文被重新生成过则作废。
        // 这是整个机制的要害 —— 确认的对象是内容，不是模块名。
        // （源码变动不走这里，它由 evaluateDoc 判成「已失效」，优先级压过确认。）
        //
        // 用 matchTextFingerprint 而不是直接比字符串：它能认出统一之前用 sha1 算出的
        // 正文指纹，于是老文档上的人工确认不会因为换了算法就白掉 —— 那是人的劳动。
        // 拿【这一次要写的正文】去比对【当初被确认那一版】的指纹 —— 一致，确认才继续有效。
        // 方向很关键：比「旧文档自己的正文」只能说明旧确认当时是有效的，
        // 说明不了这次生成出来的还是同一份内容。搞反了，「换了模型、换了说法」
        // 也会被判成确认仍然有效 —— 那就等于让一份没人看过的正文顶着别人的担保。
        const prev = readDocMeta(abs)
        const locked = prev ? (prev.validatedBodyFingerprint || prev.bodyFingerprint) : ''
        const keep = !!(prev && prev.docStatus === 'validated' && prev.validatedBy)
          && matchTextFingerprint(bodyText, locked).matched

        statusOf[d.name] = keep ? 'validated' : 'candidate'
        const head = buildFrontmatter({
          generatedBy: 'docwarden',
          generatedAt: new Date().toISOString(),
          module: d.name,
          project: d.project || path.basename(root),
          mode: 'local',
          sourceFingerprint: srcFp,
          bodyFingerprint: bodyFp,
          docStatus: statusOf[d.name],
          validatedBy: keep ? prev.validatedBy : '',
          validatedAt: keep ? prev.validatedAt : '',
          validatedBodyFingerprint: keep ? bodyFp : '',
          sourceFiles: d.files || [],
          extra: { provider: d.provider || 'unknown', model: d.model || 'n/a' },
        })
        await fsp.writeFile(abs, head + bodyText, 'utf8')
        written.push(rel)
      }

      // 索引分两块，服务对象不同：
      //   ① 模块总览 —— 给人导航用
      //   ② 文件 → 模块 —— AI 和人都能用的检索键
      // 整块由脚本从扫描结果算出，**不经模型**：模型会编造不存在的路径，且每次结果不一样。
      // 索引是「导航」，导航错了比地图错了更致命（会把 AI 引到错的文件上继续推理）。
      const fileMap = []
      for (const d of docs) {
        for (const f of d.files || []) fileMap.push([String(f), d.name])
      }
      fileMap.sort((a, b) => a[0].localeCompare(b[0]))

      // 索引里的状态不是重新算的，而是沿用刚才写进 frontmatter 的结果，
      // 保证「文档里写的」和「索引里写的」永远一致。
      const labelOf = { validated: '已验证', candidate: '候选' }
      const nv = docs.filter((d) => statusOf[d.name] === 'validated').length
      const idx = [
        '# 文档索引',
        '',
        `> 由文档守护生成于 ${new Date().toLocaleString('zh-CN')}。共 ${docs.length} 个模块，其中 ${nv} 个已人工确认。`,
        '> 本文件由脚本生成、不经模型，因此不会出现不存在的路径。',
        '> 「候选」= 没人确认过；「已验证」= 有人确认过且源码与正文都没再变过。',
        '',
        '## 模块总览',
        '',
        '| 模块 | 状态 | 行数 | 文件数 | 文档 |',
        '|---|---|---:|---:|---|',
        ...docs.map((d) => `| \`${d.name}\` | ${labelOf[statusOf[d.name]] || '候选'} | ${d.lines ?? '—'} | ${d.fileCount ?? '—'} | [${d.name}.md](./modules/${safeName(d.name)}.md) |`),
        '',
      ]
      if (fileMap.length) {
        idx.push('## 文件 → 模块', '')
        idx.push('| 文件 | 所属模块 |')
        idx.push('|---|---|')
        for (const [f, n] of fileMap) idx.push(`| \`${f}\` | [${n}](./modules/${safeName(n)}.md) |`)
        idx.push('')
      }
      await fsp.writeFile(path.join(root, 'docs', 'current', 'INDEX.md'), idx.join('\n'), 'utf8')
      written.push('docs/current/INDEX.md')

      return json(res, 200, { ok: true, written, outDir })
    }

    // 人工确认：把某个模块标为「已验证」，或撤销确认回到「候选」。
    // 只有人能触发这一步 —— 这正是「维护无感，判断有感」里那个「有感」的落点。
    //
    // 确认直接写进文档自己的头部（谁、何时、锁定的是哪一版正文），
    // 不再有独立的 status.json：那个文件任何模块更新都要改它，
    // 多分支合并必然冲突，而且冲突内容是一串机器哈希，人没法判断该留哪一边。
    // 写进文档后，确认会随文档一起提交、回滚、review。
    if (req.method === 'POST' && u.pathname === '/api/verify') {
      const { dir, module: name, action, by } = await readBody(req)
      if (!dir || !name) return json(res, 400, { ok: false, error: '缺少目录或模块名' })
      const root = path.resolve(normalizeDir(dir))
      const docFile = docPathOf(root, name)

      if (!readDocMeta(docFile)) {
        return json(res, 400, { ok: false, error: '这个模块还没有导出文档，先导出再确认' })
      }

      if (action === 'reset') {
        const r = clearValidation(docFile)
        if (!r.ok) return json(res, 400, { ok: false, error: r.error })
        return json(res, 200, { ok: true, action: 'reset', module: name })
      }

      const who = String(by || '匿名').slice(0, 60)
      const at = new Date().toISOString()
      const r = applyValidation(docFile, { by: who, at })
      if (!r.ok) return json(res, 400, { ok: false, error: r.error })
      return json(res, 200, { ok: true, action: 'validate', module: name, by: who, at })
    }

    json(res, 404, { ok: false, error: '没有这个接口' })
  } catch (err) {
    json(res, 500, { ok: false, error: err?.message || String(err) })
  }
})

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`
  exec(cmd, () => {})
}

function listen(port, tries = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < 12) {
      listen(port + 1, tries + 1)
    } else {
      console.error('启动失败：', err.message)
      process.exit(1)
    }
  })
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`
    console.log('')
    console.log('  文档守护 · 本地界面已启动（可选辅助入口，工具主线在 CI）')
    console.log(`  → ${url}`)
    console.log('')
    console.log('  提示：代码只在你本机读写，除了你自己配置的模型接口外不产生任何外部请求。')
    console.log('  按 Ctrl+C 退出。')
    console.log('')
    if (!NO_OPEN) openBrowser(url)
  })
}

listen(PORT)
