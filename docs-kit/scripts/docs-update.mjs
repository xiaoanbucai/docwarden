#!/usr/bin/env node
/**
 * docs-update.mjs —— 从代码变更生成 / 刷新 docs/ 文档
 *
 * 零依赖，Node 18+（用到内置 fetch、crypto）
 *
 * 四种模式，分别对应四个触发契机：
 *   incremental  主干合并后，刷新受影响模块的 current/ 文档
 *   preview      PR 阶段，只产出影响预览，不写任何正式文件
 *   chapter      打 Release tag 后，生成版本演进章节
 *   audit        定时巡检，找出「代码变了但文档没跟上」的模块
 *
 * 用法：
 *   node scripts/docs-update.mjs --mode incremental
 *   node scripts/docs-update.mjs --mode preview
 *   node scripts/docs-update.mjs --mode chapter --version=v1.0
 *   node scripts/docs-update.mjs --mode audit
 *   node scripts/docs-update.mjs --mode audit --fix      # 巡检并直接修复
 *   node scripts/docs-update.mjs --mode incremental --base=HEAD~5 --force
 *
 *   # 不 vendor、直接引用工具时（GitHub Actions 里 `uses: <org>/docwarden@v1`），
 *   # 脚本与目标仓库不在同一个地方，要用 --root 指过去：
 *   node /path/to/docwarden/docs-kit/scripts/docs-update.mjs --root /path/to/your-repo --mode incremental
 *
 * 环境变量：
 *   LLM_API_KEY    必填。密钥一律走环境变量，不要写进 .knowledge.mjs
 *   LLM_BASE_URL   模型接口地址。**没有默认值** —— 见下方说明
 *   LLM_MODEL      模型名。**没有默认值**
 *
 * 关于「没有默认值」：这个脚本干的事是把你仓库里的源码读出来发给模型。
 * 填哪个 baseUrl，就等于把源码交给谁 —— 这是个决定，不是个技术细节，
 * 只能由使用者的项目来做。所以这里刻意不预填任何厂商地址：
 * 没配就在开始干活之前直接失败，并说清怎么配；而不是先跑起来、
 * 把代码悄悄发到一个默认地址去。配置方式见 USAGE.md（使用说明）。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve, relative, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// 指纹与状态的判定只有一份实现，放在 lib/freshness.mjs。
// 本地工作台和 MCP 服务引用的是同一个文件 —— 两边各写一份的代价见该文件开头的说明。
import {
  fingerprintFiles,
  matchSourceFingerprint,
  fingerprintText,
  readDocMeta,
  buildFrontmatter,
  upgradeSourceFingerprint,
  splitFeature,
} from './lib/freshness.mjs'

/**
 * 参数解析。两种写法都支持：
 *   --mode incremental
 *   --mode=incremental
 * 注意不能简单地把「不以 -- 开头的参数」当成独立 flag，
 * 否则 `--mode incremental` 会被解析成 mode=true。
 *
 * 这段刻意排在所有常量之前 —— 因为 ROOT 也要从参数里取（见下）。
 */
const args = new Map()
{
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq !== -1) {
      args.set(a.slice(2, eq), a.slice(eq + 1))
    } else {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        args.set(a.slice(2), next)
        i++
      } else {
        args.set(a.slice(2), 'true')
      }
    }
  }
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * 目标仓库的根目录 —— 也就是「要给哪个仓库生成文档」。
 *
 * 两种用法都要照顾到：
 *
 *   1. vendor 模式（`docwarden init` 装进你仓库的那一份）
 *      脚本躺在 <你的仓库>/scripts/ 下，上一级就是仓库根，不用传参数。
 *
 *   2. 引用模式（GitHub Actions 里直接 `uses: <org>/docwarden@v1`）
 *      脚本跑在 Action 自己的目录里，你的仓库在工作区，两者不是一个地方，
 *      必须显式指过去 —— Action 会传 `--root $GITHUB_WORKSPACE`。
 *
 * git 操作、配置读取、文档读写全部以 ROOT 为基准，所以这个值必须对。
 */
const ROOT = args.get('root') ? resolve(String(args.get('root'))) : resolve(SCRIPT_DIR, '..')
const PREVIEW_PATH = resolve(ROOT, '.docs-preview.md')

// 人写内容用标记块隔离，重生成时原样保留、一个字不动
const MANUAL_RE = /<!--\s*MANUAL:BEGIN\s*-->[\s\S]*?<!--\s*MANUAL:END\s*-->/g

// 模型在正文末尾附带的功能点清单。脚本提取后从正文中移除，写进 front-matter，
// 再汇总成跨模块的功能索引 —— 用于解决「人按功能提问、文档按模块组织」的错位。
const FEATURES_RE = /<!--\s*FEATURES\s*\n?([\s\S]*?)-->/i
// 功能点怎么拆、用什么分隔符，统一由 lib/freshness.mjs 的 splitFeature 定义 ——
// 那边既负责写进 frontmatter，也负责读回来，两边各写一份迟早会分叉。

// 提示词模板名。取名字出来当常量，是为了让「读模板」和「记 prompt_version」
// 用的是同一个名字 —— 写成两处字符串字面量，改一处忘一处就记错版本了。
const PROMPT_MODULE = 'module.md'
const PROMPT_CHAPTER = 'chapter.md'

const MODE = args.get('mode') || 'incremental'
const DRY_RUN = args.get('dry-run') === 'true'
const FORCE = args.get('force') === 'true'
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'unpackage', 'coverage', '.next', '.nuxt',
])

let errors = 0
const previewChunks = []

const log = (m) => console.log(`[docs] ${m}`)
const warn = (m) => console.log(`[docs] ⚠ ${m}`)

/* ─────────────────────────── git ─────────────────────────── */

function git(argv) {
  return execFileSync('git', argv, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function resolveRange() {
  const env = process.env
  let base = args.get('base') || ''
  let head = args.get('head') || ''

  if (!base) {
    base =
      env.CI_MERGE_REQUEST_DIFF_BASE_SHA ||
      env.CI_COMMIT_BEFORE_SHA ||
      env.GITHUB_EVENT_BEFORE ||
      ''
  }
  if (!head) head = env.CI_COMMIT_SHA || env.GITHUB_SHA || 'HEAD'

  // 新分支首次推送 / force push 时，before 会是一串 0，必须回退
  if (!base || /^0+$/.test(base)) base = 'HEAD~1'

  return { base, head }
}

function changedFiles(base, head) {
  const out = git(['diff', '--name-only', '--diff-filter=ACMR', `${base}...${head}`])
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

/**
 * 判断文件是否只是格式变化（空白、缩进）。
 * 手法：对比普通 diff 与 -w（忽略空白）diff。
 * 一次 Prettier 全量格式化如果不挡掉，会被当成「重大架构变更」。
 */
function isFormatOnly(file, base, head) {
  try {
    const normal = git(['diff', '--numstat', `${base}...${head}`, '--', file])
    if (!normal.trim()) return false
    const wsIgnored = git(['diff', '-w', '--numstat', `${base}...${head}`, '--', file])
    if (!wsIgnored.trim()) return true
    return wsIgnored.split('\n').filter(Boolean).every((l) => /^0\t0\t/.test(l))
  } catch {
    return false
  }
}

/* ─────────────────────── 配置与提示词 ─────────────────────── */

async function loadConfig() {
  const p = resolve(ROOT, '.knowledge.mjs')
  if (!existsSync(p)) throw new Error(`找不到配置文件：${p}`)
  const mod = await import(pathToFileURL(p).href)
  return mod.default
}

/**
 * 提示词模板。
 *
 * 先看你仓库里有没有：`<ROOT>/scripts/prompts/<name>` ——
 * 引用模式下（Action 直接跑），仓库里通常没有这个目录，那就用工具自带的那份；
 * 想调提示词又不想整包 vendor 的话，把 prompts/ 拷进仓库即可，这里会让你的那份优先。
 */
function loadPrompt(name) {
  for (const dir of [resolve(ROOT, 'scripts', 'prompts'), resolve(SCRIPT_DIR, 'prompts')]) {
    const p = resolve(dir, name)
    if (existsSync(p)) return readFileSync(p, 'utf8')
  }
  throw new Error(`找不到提示词模板：${name}（找过 ${relative(ROOT, resolve(ROOT, 'scripts', 'prompts'))} 与工具自带目录）`)
}

function render(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''))
}

/**
 * 提示词版本 —— 模板内容的指纹。
 *
 * 不手工维护版本号，是因为它会忘：改了提示词但没人记得加一版，
 * 于是新旧文档看起来"同一版产出"，质量断层就查不出来。
 * 拿内容算指纹就没这个问题 —— 改一个字，版本自然就变了。
 *
 * 注意算的是**实际用到的那份模板**（仓库里那份优先，见 loadPrompt），
 * 所以团队自己改了提示词，版本也会跟着变。
 */
function promptVersion(name) {
  try {
    return fingerprintText(loadPrompt(name))
  } catch {
    return ''
  }
}

/* ────────────────── 模块文件枚举与内容指纹 ────────────────── */

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      walk(p, out)
    } else if (e.isFile()) {
      out.push(relative(ROOT, p).split(sep).join('/'))
    }
  }
  return out
}

/** 列出某个模块的全部源文件（不是只看本次变更的文件） */
function listModuleFiles(mod, config) {
  const files = []
  for (const prefix of mod.prefixes) {
    if (prefix.endsWith('/')) {
      walk(resolve(ROOT, prefix), files)
    } else if (existsSync(resolve(ROOT, prefix))) {
      files.push(prefix)
    }
  }
  const seen = new Set()
  return files.filter((f) => {
    if (seen.has(f)) return false
    seen.add(f)
    return !config.ignorePaths.some((p) => f.includes(p))
  })
}

// hashModule 已移入 lib/freshness.mjs（fingerprintFiles）。
// 在这里再留一份是行不通的：工作台那边算出的指纹这里认不出，
// 同一个项目两条路都会把对方的产出判成「源码变了」，然后白跑一遍模型。

/* ──────────── 生成状态：只读文档自身，不用额外文件 ──────────── */

/**
 * 指纹与状态一律从文档头部的 frontmatter 读，**不设独立状态文件**。
 *
 * 这条是硬的，不是偏好：
 *   1. 集中存放意味着任何模块的更新都会改动同一个文件，多分支合并时必然冲突，
 *      且冲突内容是一串机器哈希，人工无法判断该保留哪一边；
 *   2. 指纹与文档分离，就多出一处真值，存在不一致的可能；
 *   3. 写进文档头部后，「指纹」和「谁确认过」随文档一起提交、回滚、review，零额外文件。
 *
 * 解析在 lib/freshness.mjs。这里只留一个把相对路径转绝对的薄封装。
 */
const metaOf = (relPath) => readDocMeta(resolve(ROOT, relPath))

/* ─────────────────── 人写内容的保护 ─────────────────── */

function extractManual(text) {
  return text.match(MANUAL_RE) || []
}

/**
 * 把旧文档里的人写块原样搬回新生成的文档末尾。
 * AI 只负责它该负责的部分，人手写的东西一个字都不动。
 * 同时剥掉模型可能误输出的 MANUAL 标记，避免伪造。
 */
function mergeManual(newBody, blocks) {
  const cleaned = newBody.replace(MANUAL_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd()
  if (!blocks.length) return cleaned + '\n'
  return `${cleaned}\n\n${blocks.join('\n\n')}\n`
}

/* ─────────────────── 功能点清单与索引 ─────────────────── */

/** 从模型输出里摘出功能清单，并从正文中移除该段 */
function parseFeatures(text) {
  const m = FEATURES_RE.exec(text)
  if (!m) return { body: text, features: [] }

  // 一条功能点怎么拆由 lib/freshness.mjs 的 splitFeature 说了算 ——
  // 这里写的格式和那边读的格式必须是同一套，两边各写一份迟早会分叉。
  const features = m[1].split('\n').map(splitFeature).filter((f) => f.name)

  const body = text.replace(FEATURES_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd()
  return { body, features }
}

// 原先这里有一份自己的 frontmatter 解析（正则逐个字段抠），已删除。
// 现在统一用 lib/freshness.mjs 的 readDocMeta —— 它按行解析，避开了
// `^key:\s*(.*)$` 里 `\s` 吃掉换行、让空值字段把下一行吞成自己值的坑。

/**
 * 汇总所有模块文档的元数据，生成 docs/current/INDEX.md：
 *   · 模块清单 + 新鲜度（多久没更新、是否可能过期）
 *   · 功能索引（功能点 → 涉及哪些模块）
 *
 * 人提问的最小单位是「功能」，文档的最小单位是「模块」，两者并不重合。
 * 「退款」横跨 order / payment / finance，任何单篇模块文档都答不完整 —— 这张表补的就是这个缺口。
 */
function buildIndex(config) {
  const now = Date.now()
  const staleDays = config.guard.staleDays ?? 30
  const rows = []
  const featureMap = new Map()

  for (const mod of config.modules) {
    const rel = `${config.output.currentDir}/modules/${mod.name}.md`
    const meta = metaOf(rel)
    const days =
      meta?.generatedAt && !Number.isNaN(Date.parse(meta.generatedAt))
        ? Math.floor((now - Date.parse(meta.generatedAt)) / 86400000)
        : null
    rows.push({ mod, meta, days })

    for (const f of meta?.features || []) {
      if (!featureMap.has(f.name)) featureMap.set(f.name, { desc: f.desc, modules: new Set() })
      const entry = featureMap.get(f.name)
      if (!entry.desc && f.desc) entry.desc = f.desc
      entry.modules.add(mod.name)
    }
  }

  const missing = rows.filter((r) => !r.meta)
  const out = [
    '# 文档索引',
    '',
    '> 本文件由脚本自动生成，请勿手动编辑。数据来自各模块文档头部的元数据。',
    '',
    `生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    '',
    '## 模块清单',
    '',
  ]

  if (!rows.length) {
    out.push('尚未配置任何模块。')
  } else {
    out.push('| 模块 | 文档 | 最近更新 | 距今天数 | 状态 | 人工确认 |')
    out.push('|---|---|---|---|---|---|')
    for (const r of rows) {
      const link = r.meta ? `[${r.mod.name}.md](modules/${r.mod.name}.md)` : '—'
      const when = r.meta?.generatedAt ? r.meta.generatedAt.slice(0, 10) : '—'
      const age = r.days === null ? '—' : `${r.days} 天`
      let status = '最新'
      if (!r.meta) status = '从未生成'
      else if (r.days !== null && r.days > staleDays) status = `可能过期（超过 ${staleDays} 天未更新）`
      // 「人工确认」直接反映文档头部，不维护任何额外状态文件。
      // 和「状态」列的区别：状态列看时间，确认列看有没有人担保过内容。
      const confirm = r.meta?.docStatus === 'validated' && r.meta?.validatedBy
        ? `已验证（${r.meta.validatedBy}${r.meta.validatedAt ? ' · ' + String(r.meta.validatedAt).slice(0, 10) : ''}）`
        : '—（无人确认）'
      out.push(`| ${r.mod.title || r.mod.name} | ${link} | ${when} | ${age} | ${status} | ${confirm} |`)
    }
  }

  out.push('', '## 功能索引', '')
  if (!featureMap.size) {
    out.push('暂无功能数据。功能点由模块文档生成时自动提取，首次生成后这里会出现内容。')
  } else {
    out.push('一个功能点可能横跨多个模块 —— 这正是这张表存在的意义。', '')
    out.push('| 功能点 | 说明 | 涉及模块 |')
    out.push('|---|---|---|')
    const sorted = [...featureMap.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))
    for (const [name, v] of sorted) {
      out.push(`| ${name} | ${v.desc || '—'} | ${[...v.modules].join(' / ')} |`)
    }
  }

  if (missing.length) {
    out.push('', '## 待补', '')
    out.push(`以下模块还没有文档，可能是新增模块或生成失败：${missing.map((r) => r.mod.name).join('、')}`)
  }
  out.push('')

  return { text: out.join('\n'), featureCount: featureMap.size, missingCount: missing.length }
}

function writeIndex(config) {
  if (config.output.index === false) return
  const rel = `${config.output.currentDir}/INDEX.md`
  const { text, featureCount, missingCount } = buildIndex(config)
  if (DRY_RUN) {
    log(`[dry-run] 将写入 ${rel}（${featureCount} 个功能点，${missingCount} 个模块待补）`)
    return
  }
  writeDoc(rel, text)
}

/* ─────────────────────── 模型调用 ─────────────────────── */

/**
 * 模型接口必须由使用者自己填 —— 这里刻意不预填任何厂商地址。
 *
 * 为什么宁可直接失败，也不给一个「看起来能用」的默认值：
 * 这个脚本会把你的源码读出来发给模型，填哪个地址就等于把源码交给哪家。
 * 有默认值的话，一个没配过的人跑起来会直接成功，然后在毫不知情的情况下
 * 把代码发到一个公共站点去 —— 报错都比这好。
 *
 * audit 模式不调模型，所以不经过这里（它是零成本、随时可跑的巡检）。
 */
function assertModelReady(config) {
  const { baseUrl, model } = config.llm ?? {}
  const missing = []
  if (!baseUrl) missing.push('baseUrl（接口地址）')
  if (!model) missing.push('model（模型名）')
  if (!missing.length) return

  throw new Error([
    `还没配置模型接口，缺：${missing.join('、')}`,
    '',
    '两种配法，任选一种：',
    '',
    '  ① 改仓库根目录的 .knowledge.mjs（适合固定用某个模型）：',
    "       llm: { baseUrl: 'https://你的服务/v1', model: '模型名', ... }",
    '',
    '  ② 用环境变量（CI 里就是这么配的，本地临时试也方便）：',
    '       export LLM_BASE_URL="https://你的服务/v1"',
    '       export LLM_MODEL="模型名"',
    '       export LLM_API_KEY="sk-xxx"',
    '',
    '只要服务端提供 OpenAI 兼容的 /chat/completions 就行。',
    '接口选择、密钥放哪、常见服务商怎么填 —— 见 USAGE.md（使用说明）。',
    '',
    '只想做一次零成本的体检（不调模型、不需要配置）可以跑：',
    '    --mode audit',
  ].join('\n'))
}

async function callLLM(prompt, config) {
  const key = process.env.LLM_API_KEY
  if (!key) {
    throw new Error([
      '缺少环境变量 LLM_API_KEY（模型服务要的密钥）。',
      '',
      '  本地：export LLM_API_KEY="sk-xxx"',
      '  GitHub：Settings → Secrets and variables → Actions 里加 LLM_API_KEY',
      '  GitLab：Settings → CI/CD → Variables 里加 LLM_API_KEY（勾 Masked）',
      '',
      '密钥不要写进 .knowledge.mjs 或任何提交进仓库的文件。',
    ].join('\n'))
  }

  const { baseUrl, model, temperature, maxTokens, timeoutMs } = config.llm
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`模型返回 ${res.status}：${(await res.text()).slice(0, 300)}`)
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content
    if (!text) throw new Error('模型返回内容为空')
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}

/* ─────────────────────── 校验 ─────────────────────── */

function validate(md, codeChars, config) {
  const g = config.guard
  const problems = []

  if (md.length < g.minOutputChars) problems.push(`输出过短（${md.length} 字）`)

  // 倍数校验只在代码量足够时生效，小模块的文档本来就可能比代码长
  if (codeChars >= g.ratioCheckFloor && md.length > codeChars * g.maxOutputRatio) {
    problems.push(`输出 ${md.length} 字，超过输入代码 ${codeChars} 字的 ${g.maxOutputRatio} 倍，疑似幻觉`)
  }

  const fences = (md.match(/```/g) || []).length
  if (fences > 6) problems.push(`代码块过多（约 ${Math.floor(fences / 2)} 个），疑似在复述源码`)

  return problems
}

/* ─────────────────────── 输出 ─────────────────────── */

/**
 * 生成文档头部。字段约定由 lib/freshness.mjs 定义 —— 那边读什么，这边就写什么。
 *
 * 每次生成的文档一律 `doc_status: candidate`：模型写的东西默认没人担保。
 * 只有人点了确认，它才会变成 validated，并锁住当时那一版正文的指纹。
 * 这一步机器替不了，也不该替 —— 这正是「候选」这个状态存在的意义。
 */
function buildHeader({
  project, commit, files, mode, sourceFingerprint, features, bodyFingerprint,
  model, promptName,
}) {
  return buildFrontmatter({
    generatedBy: 'docs-update-bot',
    generatedAt: new Date().toISOString(),
    basedOnCommit: commit,
    project,
    mode,
    sourceFingerprint,
    bodyFingerprint,
    docStatus: 'candidate',
    confidence: 'high',
    features,
    sourceFiles: files,
    // 生成溯源：换了模型、改了提示词之后，新旧文档的质量断层靠这两个字段区分。
    // 只记**模型名**，不记 baseUrl —— 地址可能是内网地址或某家的私有网关，
    // 写进随代码提交的文档里等于把它公开。密钥同理，从来只走环境变量。
    extra: {
      model: model || '',
      prompt_version: promptName ? promptVersion(promptName) : '',
    },
  })
}

function writeDoc(relPath, content) {
  const abs = resolve(ROOT, relPath)
  if (DRY_RUN) {
    log(`[dry-run] 将写入 ${relPath}（${content.length} 字）`)
    return
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  log(`已写入 ${relPath}（${content.length} 字）`)
}

function collectCode(files, maxChars) {
  let total = 0
  const parts = []
  for (const f of files) {
    const abs = resolve(ROOT, f)
    if (!existsSync(abs)) continue
    let code
    try {
      code = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    if (total + code.length > maxChars) {
      parts.push(`--- FILE: ${f} ---\n（内容过长，已截断）`)
      break
    }
    parts.push(`--- FILE: ${f} ---\n${code}`)
    total += code.length
  }
  return { text: parts.join('\n\n'), chars: total }
}

/* ─────────────────── 单个模块的生成 ─────────────────── */

async function generateModule({ name, mod, files, config, headSha }) {
  const hash = fingerprintFiles(ROOT, files)
  const docPath = `${config.output.currentDir}/modules/${name}.md`
  const prev = metaOf(docPath)

  if (!FORCE && prev) {
    const src = matchSourceFingerprint(ROOT, files, prev.sourceFingerprint)
    if (src.matched) {
      if (src.algorithm === 'legacy') {
        // 源码一个字都没动，只是文档里记的指纹还停留在统一之前的算法。
        // 就地升级头部即可 —— 为算法换代重新生成，等于白烧一次额度。
        upgradeSourceFingerprint(resolve(ROOT, docPath), ROOT, files)
        log(`模块 ${name} 源码未变（指纹换代，已就地升级），跳过`)
      } else {
        const note = prev.docStatus === 'validated' ? '，且已人工确认' : ''
        log(`模块 ${name} 源码未变（指纹 ${hash}），跳过${note} —— 省一次调用`)
      }
      return { name, result: 'skipped' }
    }
  }

  const { text: code, chars } = collectCode(files, config.guard.maxCodePerModule)
  if (chars < config.guard.minCodePerModule) {
    log(`模块 ${name} 有效代码仅 ${chars} 字，低于门槛，跳过`)
    return { name, result: 'skipped' }
  }

  const prompt = render(loadPrompt(PROMPT_MODULE), {
    moduleName: name,
    moduleTitle: mod.title || name,
    project: config.project,
    fileList: files.map((f) => `- ${f}`).join('\n'),
    code,
  })

  const raw = await callLLM(prompt, config)

  const problems = validate(raw, chars, config)
  if (problems.length) {
    warn(`模块 ${name} 校验未通过：${problems.join('；')}`)
    return { name, result: 'failed' }
  }

  // 先把功能清单摘出来：正文里不留，写进 front-matter 供索引汇总
  const { body: generated, features } = parseFeatures(raw)
  if (!features.length) {
    warn(`模块 ${name} 未解析出功能清单，功能索引将缺少该模块`)
  }

  // 再把旧文档里的人写内容原样摘出来，生成完放回。
  // 这一步保证「AI 出错」的影响面被限制在 AI 区域内。
  const absDoc = resolve(ROOT, docPath)
  const oldText = existsSync(absDoc) ? readFileSync(absDoc, 'utf8') : ''
  const manualBlocks = extractManual(oldText)
  if (manualBlocks.length) {
    log(`模块 ${name} 保留了 ${manualBlocks.length} 处人写内容`)
  }
  const body = mergeManual(generated, manualBlocks)

  const header = buildHeader({
    project: config.project,
    commit: headSha,
    files,
    mode: MODE,
    sourceFingerprint: hash,
    features,
    // 正文指纹算在「人写块合并之后」的最终正文上 ——
    // 人写块也是文档的一部分，它被改了，之前的确认同样应当作废。
    bodyFingerprint: fingerprintText(body),
    model: config.llm?.model,
    promptName: PROMPT_MODULE,
  })

  if (MODE === 'preview') {
    const shown = body.length > 6000 ? body.slice(0, 6000) + '\n\n…（内容过长已截断）' : body
    const changed = prev
      ? '本次变更会重新生成这个模块的文档'
      : '这个模块还没有文档，合并后会新建'
    previewChunks.push(
      `### 模块 \`${name}\`${mod.title ? ` · ${mod.title}` : ''}\n\n` +
        `> ${changed}\n\n` +
        `<details><summary>展开预览（合并后将写入 \`${docPath}\`）</summary>\n\n` +
        `${shown}\n\n</details>\n`,
    )
  } else {
    writeDoc(docPath, header + body)
  }

  return { name, result: 'ok' }
}

/* ─────────────────── 模式一 / 二：增量与预览 ─────────────────── */

async function runIncremental(config, headSha) {
  const { base, head } = resolveRange()
  log(`模式 ${MODE}｜比对范围 ${base}...${head}`)

  let files = changedFiles(base, head)
  log(`检测到 ${files.length} 个变更文件`)

  const beforeIgnore = files.length
  files = files.filter((f) => !config.ignorePaths.some((p) => f.includes(p)))
  if (files.length !== beforeIgnore) log(`按规则忽略 ${beforeIgnore - files.length} 个文件`)

  const beforeFormat = files.length
  files = files.filter((f) => !isFormatOnly(f, base, head))
  if (files.length !== beforeFormat) {
    log(`跳过纯格式变化 ${beforeFormat - files.length} 个文件（否则格式化会被当成架构变更）`)
  }

  if (!files.length) {
    log('没有需要处理的变更，结束')
    return
  }

  const max = config.guard.maxChangedFiles
  if (files.length > max) {
    warn(`变更文件 ${files.length} 个，超过上限 ${max}，本次只处理前 ${max} 个`)
    files = files.slice(0, max)
  }

  const hits = new Map()
  for (const file of files) {
    for (const mod of config.modules) {
      if (mod.prefixes.some((p) => file.startsWith(p))) {
        if (!hits.has(mod.name)) hits.set(mod.name, mod)
      }
    }
  }

  if (!hits.size) {
    log('变更文件未命中任何已配置模块，结束')
    return
  }

  log(`命中 ${hits.size} 个模块：${[...hits.keys()].join('、')}`)

  for (const [name, mod] of hits) {
    try {
      // 注意：这里喂给模型的是「模块的全部文件」，不是本次变更的那几个文件。
      // 只喂 diff 会让模型看不到模块全貌，生成的文档必然残缺。
      const modFiles = listModuleFiles(mod, config)
      const r = await generateModule({ name, mod, files: modFiles, config, headSha })
      if (r.result === 'failed') errors += 1
    } catch (e) {
      warn(`模块 ${name} 处理失败：${e.message}`)
      errors += 1
    }
  }

  writeIndex(config)
}

function flushPreview() {
  if (MODE !== 'preview') return

  const body = previewChunks.length
    ? [
        '## 文档影响预览',
        '',
        `本次改动会影响 **${previewChunks.length}** 个模块的文档。以下内容是**预览**，尚未写入仓库；合并进主干后才会正式生效。`,
        '',
        '如果预览结果与你的预期不符，通常说明代码结构或提示词需要调整，**建议在合并前处理**。',
        '',
        previewChunks.join('\n---\n\n'),
      ].join('\n')
    : [
        '## 文档影响预览',
        '',
        '本次改动**没有**影响任何已配置模块的文档，无需更新。',
        '',
        '如果你认为这里应该有变化，可能是模块划分（`.knowledge.mjs`）没有覆盖到相关目录。',
      ].join('\n')

  writeFileSync(PREVIEW_PATH, body + '\n', 'utf8')
  log(`预览已写入 ${relative(ROOT, PREVIEW_PATH)}`)
}

/* ─────────────────── 模式三：版本章节 ─────────────────── */

async function runChapter(config, headSha) {
  const version = args.get('version')
  if (!version) throw new Error('chapter 模式需要 --version=v1.0')
  const tag = `v${version.replace(/^v/, '')}`

  let base
  try {
    base = git(['describe', '--tags', '--abbrev=0', `${tag}^`]).trim()
  } catch {
    base = 'HEAD~50'
    warn(`未找到上一个 tag，回退使用 ${base} 作为起点`)
  }

  log(`生成版本章节 ${tag}，范围 ${base}...${tag}`)

  let files
  try {
    files = changedFiles(base, tag)
  } catch {
    files = changedFiles(base, 'HEAD')
  }

  const beforeIgnore = files.length
  files = files.filter((f) => !config.ignorePaths.some((p) => f.includes(p)))
  if (files.length !== beforeIgnore) log(`按规则忽略 ${beforeIgnore - files.length} 个文件`)

  if (!files.length) {
    log('该区间没有有效变更，结束')
    return
  }

  const commits = git(['log', '--oneline', `${base}..HEAD`]).split('\n').filter(Boolean)

  const prompt = render(loadPrompt(PROMPT_CHAPTER), {
    version: tag,
    project: config.project,
    commitList: commits.map((c) => `- ${c}`).join('\n'),
    fileList: files.map((f) => `- ${f}`).join('\n'),
    commitCount: commits.length,
    fileCount: files.length,
  })

  const md = await callLLM(prompt, config)
  const problems = validate(md, 0, config)
  if (problems.length) {
    warn(`章节校验未通过：${problems.join('；')}`)
    errors += 1
    return
  }

  const header = buildHeader({
    project: config.project,
    commit: headSha,
    files: files.slice(0, 50),
    mode: 'chapter',
    model: config.llm?.model,
    promptName: PROMPT_CHAPTER,
  })

  writeDoc(`${config.output.historyDir}/releases/${tag}/chapter.md`, header + md + '\n')
}

/* ─────────────────── 模式四：定时巡检 ─────────────────── */

/** 检查配置里声明的路径是否还真实存在 —— 这是最容易静默腐烂的地方 */
function checkConfigHealth(config) {
  const problems = []

  for (const mod of config.modules) {
    const existing = mod.prefixes.filter((p) =>
      p.endsWith('/') ? existsSync(resolve(ROOT, p)) : existsSync(resolve(ROOT, p)),
    )
    if (!existing.length) {
      problems.push({
        kind: '路径失效',
        detail: `模块 ${mod.name} 的路径全部不存在，文档会永远停留在旧版本`,
        hint: `请检查 ${mod.prefixes.join('、')}`,
      })
    }
  }

  // 找出没有被任何模块覆盖的源码文件 —— 这些功能不会有文档
  const roots = config.sourceRoots || []
  if (roots.length) {
    const covered = config.modules.flatMap((m) => m.prefixes.filter((p) => p.endsWith('/')))
    const uncovered = []
    for (const root of roots) {
      for (const f of walk(resolve(ROOT, root), [])) {
        if (config.ignorePaths.some((p) => f.includes(p))) continue
        if (!covered.some((c) => f.startsWith(c))) uncovered.push(f)
      }
    }
    if (uncovered.length) {
      problems.push({
        kind: '存在未覆盖的文件',
        detail: `${uncovered.length} 个源码文件不属于任何模块，它们不会有文档`,
        hint: uncovered.slice(0, 5).join('、') + (uncovered.length > 5 ? ' 等' : ''),
      })
    }
  }

  // 找出代码里已经不存在、但文档还留着的模块
  const dir = resolve(ROOT, config.output.currentDir, 'modules')
  if (existsSync(dir)) {
    const known = new Set(config.modules.map((m) => `${m.name}.md`))
    const ghosts = readdirSync(dir).filter((f) => f.endsWith('.md') && !known.has(f))
    if (ghosts.length) {
      problems.push({
        kind: '幽灵文档',
        detail: `${ghosts.length} 份文档对应的模块已不在配置中，它们可能在描述已删除的代码`,
        hint: ghosts.join('、'),
      })
    }
  }

  return problems
}

async function runAudit(config, headSha) {
  log('巡检模式：检查配置健康度，并找出文档与代码不一致的模块')
  log('')

  const issues = checkConfigHealth(config)
  if (issues.length) {
    warn('配置体检发现问题：')
    for (const i of issues) {
      log(`  · [${i.kind}] ${i.detail}`)
      log(`    ${i.hint}`)
    }
    log('')
  } else {
    log('配置体检通过：所有模块路径有效，没有未覆盖的文件，没有幽灵文档')
    log('')
  }

  const stale = []
  for (const mod of config.modules) {
    const files = listModuleFiles(mod, config)
    if (!files.length) continue
    const docPath = `${config.output.currentDir}/modules/${mod.name}.md`
    const prev = metaOf(docPath)

    if (!prev) {
      stale.push({ mod, files, reason: '从未生成过文档' })
      continue
    }
    // 用同一套指纹判定：旧算法算出的指纹也算数。
    // 那种情况只需把头部升个级，不该占一次模型调用。
    const src = matchSourceFingerprint(ROOT, files, prev.sourceFingerprint)
    if (!src.matched) {
      stale.push({ mod, files, reason: '代码已变更但文档未更新' })
    } else if (src.algorithm === 'legacy') {
      upgradeSourceFingerprint(resolve(ROOT, docPath), ROOT, files)
      log(`  · ${mod.name} 指纹换代，已就地升级头部（未占用模型额度）`)
    }
  }

  if (!stale.length) {
    log(`全部 ${config.modules.length} 个模块的文档均与代码一致`)
  } else {
    warn(`发现 ${stale.length} 个模块的文档已漂移：`)
    for (const s of stale) log(`  · ${s.mod.name} —— ${s.reason}`)
  }

  if (args.get('fix') !== 'true') {
    if (stale.length) log('如需直接重生成，请加 --fix 参数')
    writeIndex(config)
    return
  }

  if (!stale.length) {
    writeIndex(config)
    return
  }

  log('')
  log('开始修复漂移...')
  for (const s of stale) {
    try {
      const r = await generateModule({
        name: s.mod.name, mod: s.mod, files: s.files, config, headSha,
      })
      if (r.result === 'failed') errors += 1
    } catch (e) {
      warn(`模块 ${s.mod.name} 处理失败：${e.message}`)
      errors += 1
    }
  }

  writeIndex(config)
}

/* ─────────────────────────── 入口 ─────────────────────────── */

async function main() {
  const config = await loadConfig()

  // 先把「模型配没配」检查在前面：这一步不通过就没必要往下走，
  // 更没必要先去扫一遍全仓库。audit 模式不调模型，跳过这项检查。
  if (MODE !== 'audit') assertModelReady(config)

  const headSha = git(['rev-parse', 'HEAD']).trim()

  if (MODE === 'chapter') {
    await runChapter(config, headSha)
  } else if (MODE === 'audit') {
    await runAudit(config, headSha)
  } else {
    await runIncremental(config, headSha)
  }

  flushPreview()

  if (errors > 0) {
    warn(`本次有 ${errors} 处失败，详见上方日志`)
    process.exitCode = 1
  } else {
    log('完成')
  }
}

main().catch((e) => {
  const msg = String(e?.message ?? e)
  // 多行消息是我们自己写的「怎么配」指引，不该被压成一行前缀里的一句话
  if (msg.includes('\n')) console.error(`\n❌ ${msg}\n`)
  else console.error(`[docs] 运行失败：${msg}`)
  process.exit(1)
})
