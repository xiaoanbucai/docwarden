/**
 * install.mjs —— 把 payload 装进目标仓库
 *
 * `npx docwarden init` 的全部实现：探测结构 → 生成配置 → 拷贝脚本与 CI → 打印下一步。
 *
 * 三条设计原则：
 *   1. **只增不改**。已存在的文件一律不覆盖（除非 --force），尤其是 .knowledge.mjs ——
 *      那是使用者逐字改过的。安装器把人家配好的模块划分冲掉，是不可原谅的错误。
 *   2. **可预演**。--dry-run 打印完整计划但一个字节都不写。
 *   3. **装完能用**。缺任何一件东西都会在下面列清楚，配合 `docwarden doctor` 复查。
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync,
} from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { detectProject, summarizeDetection, CODE_EXT, SOFT_MAX_FILES } from './detect.mjs'

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 使用者仓库里真正要落地的所有产物，写在一处，方便核对与测试 */
export const PLATFORMS = ['github', 'gitlab', 'both']

const DOC_DIRS = [
  'docs/current/modules',
  'docs/history/releases',
  'docs/decisions',
]

/**
 * 使用者仓库里真正要落地的所有产物，写在一处，方便核对与测试。
 *
 * `noVendor`（引用模式）下，仓库里不需要 scripts/ 和 prompts/ ——
 * 脚本跑在 Action 自己那边，靠 --root 指过来。所以这两类不列入必检清单。
 */
export function requiredFiles(platform, { noVendor = false } = {}) {
  const list = ['.knowledge.mjs']
  if (!noVendor) {
    list.push(
      'scripts/docs-update.mjs',
      'scripts/lib/freshness.mjs',
      'scripts/prompts/module.md',
      'scripts/prompts/chapter.md',
    )
  }
  if (platform !== 'gitlab') {
    list.push('.github/workflows/docs.yml', '.github/pull_request_template.md')
  }
  if (platform !== 'github') {
    list.push('.gitlab-ci.yml')
  }
  return list
}

function payloadMap(platform, { noVendor = false } = {}) {
  const m = []
  if (!noVendor) {
    m.push(
      ['docs-kit/scripts/docs-update.mjs', 'scripts/docs-update.mjs'],
      ['docs-kit/scripts/lib/freshness.mjs', 'scripts/lib/freshness.mjs'],
      ['docs-kit/scripts/prompts/module.md', 'scripts/prompts/module.md'],
      ['docs-kit/scripts/prompts/chapter.md', 'scripts/prompts/chapter.md'],
    )
  }
  if (platform !== 'gitlab') {
    // 引用模式放的是「用 uses: 的那份」，vendor 模式放「跑 node scripts/… 的那份」
    m.push(noVendor
      ? ['docs-kit/ci/github-action-only.yml', '.github/workflows/docs.yml']
      : ['docs-kit/ci/github-actions.yml', '.github/workflows/docs.yml'])
    m.push(['docs-kit/templates/pull_request_template.md', '.github/pull_request_template.md'])
  }
  if (platform !== 'github') {
    m.push(['docs-kit/ci/gitlab-ci.yml', '.gitlab-ci.yml'])
    m.push(['docs-kit/templates/pull_request_template.md', '.gitlab/merge_request_templates/Default.md'])
  }
  return m
}

/**
 * 判断一个已装好的仓库走的是哪种接入方式。
 *
 * 依据是 workflow 里有没有 `uses: …/docwarden@…`，而不是「有没有 scripts/」——
 * vendor 模式下人可能把 scripts 挪走，但那仍然是 vendor 的意图，报错会误导人。
 *
 * 判定前先剔除注释行：两种 workflow 的头部都写了对方的示例（互相教怎么切换），
 * 不剔的话会被自己的说明文字骗到。
 */
export function detectInstallMode(target) {
  const wf = join(target, '.github/workflows/docs.yml')
  if (!existsSync(wf)) return 'unknown'
  const code = stripYamlComments(readFileSync(wf, 'utf8'))
  return /^\s*uses:\s*\S*docwarden@/m.test(code) ? 'reference' : 'vendored'
}

/** 去掉 YAML 的整行注释（# 在行首或前面只有空白）*/
export function stripYamlComments(src) {
  return src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n')
}

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** 把推断出来的模块渲染成配置里的字面量，并对齐成可读的一列 */
export function renderModulesBlock(modules) {
  if (!modules.length) {
    return [
      "    // 没能自动推断出模块。请照着下面的样子手工填写：",
      "    // { name: 'order', title: '订单', prefixes: ['src/modules/order/'] },",
    ].join('\n')
  }
  const wName = Math.max(...modules.map((m) => m.name.length))
  const wTitle = Math.max(...modules.map((m) => m.title.length))
  // 补白加在引号外面 —— 加在里面会变成字符串内容的一部分，肉眼很像但完全不是一回事
  const lines = []
  for (const m of modules) {
    const gapName = ' '.repeat(Math.max(0, wName - m.name.length))
    const gapTitle = ' '.repeat(Math.max(0, wTitle - m.title.length))
    lines.push(`    // ${String(m.files.length).padStart(3)} 个文件`)
    lines.push(`    { name: ${q(m.name)},${gapName} title: ${q(m.title)},${gapTitle} prefixes: [${q(m.prefix)}] },`)
  }
  return lines.join('\n')
}

/** 生成 .knowledge.mjs 的完整内容 */
export function renderKnowledgeConfig(detection) {
  const note = []
  note.push(`  // 初稿依据：${summarizeDetection(detection)}，共 ${detection.modules.length} 个模块。`)
  if (detection.leftovers.length) {
    const sample = detection.leftovers.slice(0, 3).join('、')
    note.push(`  // 有 ${detection.leftovers.length} 个文件不属于任何模块（如 ${sample}${detection.leftovers.length > 3 ? ' 等' : ''}）——`)
    note.push('  // 它们不会被写进知识库。如果其中有重要的，把它的目录加进某个模块的 prefixes。')
  } else {
    note.push('  // 所有源码文件都被某个模块覆盖了。')
  }

  const tpl = readFileSync(join(PKG_ROOT, 'src/templates/knowledge.mjs.tpl'), 'utf8')
  const roots = detection.sourceRoots.map((s) => (s.endsWith('/') ? s : s + '/'))
  return tpl
    .replace('__PROJECT__', detection.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))
    .replace('__DETECT_NOTE__', note.join('\n'))
    .replace('__MODULES__', renderModulesBlock(detection.modules))
    .replace('__SOURCEROOTS__', roots.length ? `[${roots.map(q).join(', ')}]` : '[]')
}

/** 生成 docs/README.md，给同事一句提醒 */
function renderDocsReadme() {
  return `# docs

本目录内容由 CI 自动生成，描述的是**主干当前状态**。

如果你在 feature 分支上，看到的文档可能对应旧的代码 —— 以代码为准。

| 目录 | 谁写 | 说明 |
|---|---|---|
| \`current/modules/\` | AI 生成 | 各模块文档，**会被下一次生成覆盖**，不要手改 |
| \`current/INDEX.md\` | 脚本生成 | 模块清单 + 功能索引 + 新鲜度 |
| \`history/releases/\` | AI 生成 | 每个版本的演进章节 |
| \`decisions/\` | **人写** | 架构决策、背景与取舍。AI 永不触碰 |

想在模块文档里补自己的说明，用标记块包住，重新生成时会原样保留：

\`\`\`markdown
<!-- MANUAL:BEGIN -->
## 业务背景与取舍
你的补充说明
<!-- MANUAL:END -->
\`\`\`
`
}

function ensureGitignore(target, { dryRun, log }) {
  const p = join(target, '.gitignore')
  const need = '.docs-preview.md'
  if (existsSync(p)) {
    const cur = readFileSync(p, 'utf8')
    if (cur.split(/\r?\n/).some((l) => l.trim() === need)) {
      log(`  · .gitignore 已有 ${need}，跳过`)
      return false
    }
    if (!dryRun) writeFileSync(p, cur.replace(/\n*$/, '\n') + `\n# docwarden 的 PR 预览是临时产物\n${need}\n`, 'utf8')
    log(`  ✓ .gitignore 追加 ${need}`)
    return true
  }
  if (!dryRun) {
    writeFileSync(p, `node_modules/\n${need}\n`, 'utf8')
  }
  log(`  ✓ 新建 .gitignore（含 ${need}）`)
  return true
}

/**
 * 执行安装。
 *
 * @param {object} o
 * @param {string} o.target   目标仓库根目录
 * @param {string} o.platform github | gitlab | both
 * @param {boolean} o.force   覆盖已存在的文件
 * @param {boolean} o.dryRun  只打印计划
 * @param {boolean} o.noVendor 引用模式：不把脚本拷进仓库，CI 里用 `uses:` 调工具
 * @param {(s:string)=>void} o.log
 */
export function runInit(o) {
  const target = resolve(o.target ?? process.cwd())
  const platform = o.platform ?? 'github'
  const force = !!o.force
  const dryRun = !!o.dryRun
  const noVendor = !!o.noVendor
  const log = o.log ?? ((s) => console.log(s))

  if (!existsSync(target)) {
    if (dryRun) {
      log(`  · 目标目录不存在，正式执行时会创建：${target}`)
    } else {
      mkdirSync(target, { recursive: true })
    }
  }

  // ── 1. 探测 ─────────────────────────────────────────────────
  const detection = detectProject(target)
  log('')
  log('📂 探测项目结构')
  log(`   ${summarizeDetection(detection)}`)
  if (detection.modules.length) {
    log('   建议的模块划分：')
    for (const m of detection.modules) {
      const flag = m.files.length > SOFT_MAX_FILES ? '  ⚠ 偏大，建议拆细' : ''
      log(`     ${String(m.files.length).padStart(4)} 个文件   ${m.prefix}${flag}`)
    }
  }
  for (const w of detection.warnings) log(`   ⚠️  ${w}`)

  // ── 2. 要写的东西 ───────────────────────────────────────────
  const copies = payloadMap(platform, { noVendor }).map(([from, to]) => ({
    from: join(PKG_ROOT, from),
    to: join(target, to),
    rel: to,
  }))
  for (const c of copies) {
    if (!existsSync(c.from)) {
      throw new Error(`安装包自身不完整：找不到 ${relative(PKG_ROOT, c.from)}`)
    }
  }

  log('')
  log(`📦 装入仓库（平台：${platform === 'both' ? 'GitHub + GitLab' : platform}；` +
    `接入方式：${noVendor ? '引用模式 —— 脚本不进你的仓库' : 'vendor 模式 —— 脚本拷进你的仓库'}）`)

  let written = 0
  let skipped = 0

  for (const c of copies) {
    if (existsSync(c.to) && !force) {
      log(`  · 已存在，跳过：${c.rel}（要覆盖加 --force）`)
      skipped++
      continue
    }
    if (!dryRun) {
      mkdirSync(dirname(c.to), { recursive: true })
      copyFileSync(c.from, c.to)
    }
    log(`  ✓ ${c.rel}`)
    written++
  }

  // ── 3. 配置文件 ─────────────────────────────────────────────
  log('')
  log('⚙️  生成配置')
  const cfgPath = join(target, '.knowledge.mjs')
  if (existsSync(cfgPath) && !force) {
    log('  · 已存在，跳过：.knowledge.mjs（**这是你改过的文件，默认不动它**）')
    skipped++
  } else {
    if (!dryRun) writeFileSync(cfgPath, renderKnowledgeConfig(detection), 'utf8')
    log('  ✓ .knowledge.mjs')
    written++
  }

  // ── 4. 目录与杂项 ───────────────────────────────────────────
  log('')
  log('🗂  目录与杂项')
  for (const d of DOC_DIRS) {
    const p = join(target, d)
    if (existsSync(p)) {
      log(`  · 已存在：${d}/`)
      continue
    }
    if (!dryRun) mkdirSync(p, { recursive: true })
    log(`  ✓ ${d}/`)
  }

  const docsReadme = join(target, 'docs/README.md')
  if (existsSync(docsReadme)) {
    log('  · 已存在：docs/README.md')
  } else {
    if (!dryRun) writeFileSync(docsReadme, renderDocsReadme(), 'utf8')
    log('  ✓ docs/README.md（给你同事看的说明）')
    written++
  }

  if (!dryRun) ensureGitignore(target, { dryRun, log })
  else log('  ✓ 确认 .gitignore 含 .docs-preview.md（预演模式未检查）')

  // ── 5. 下一步 ───────────────────────────────────────────────
  log('')
  if (dryRun) {
    log(`🧪 预演结束：将写入 ${written} 个文件、跳过 ${skipped} 个。去掉 --dry-run 即真正执行。`)
    return { detection, written, skipped, dryRun: true }
  }

  log(`✅ 安装完成：写入 ${written} 个文件，跳过 ${skipped} 个。`)
  log('')
  log('下一步（按顺序做，别跳过第 1 步）')
  log('')

  let stepNo = 1
  const step = (title, ...lines) => {
    log(`  ${stepNo++}. ${title}`)
    for (const l of lines) log(l)
    log('')
  }

  step('打开 .knowledge.mjs，复核 modules 划分',
    '     ↑ 这是唯一需要你下判断的地方。推断只看目录，看不懂业务边界。')

  if (noVendor) {
    step('知道 workflow 会从哪取代码：',
      '       .github/workflows/docs.yml 用 uses: 引用官方仓库的 Action，',
      '       这一整份脚本会跑在你的 CI 里。想改用你自己的 fork，把那一行换掉。')
  }

  step('不接模型先跑一次体检（零成本）：',
    '       npx docwarden update --mode audit')

  step('配模型接口 —— 这一步只有你能做',
    '       .knowledge.mjs 里的 llm 段是**故意留空的**。填哪个地址就等于把源码',
    '       发给谁，这是你的决定，工具不替你预填，也不会偷偷用默认地址跑。',
    '',
    '       两种配法，任选一种：',
    '         ① 改 .knowledge.mjs 的 llm 段： baseUrl / model',
    '         ② 用环境变量： export LLM_BASE_URL=... LLM_MODEL=...',
    '',
    '       密钥一律走环境变量，不要写进配置文件：',
    '         export LLM_API_KEY="sk-xxx"',
    '',
    '       配好后本地生成一次，用肉眼验收质量：',
    '         npx docwarden update --mode incremental --base=HEAD~5 --dry-run',
    '',
    '       接口怎么选、服务商怎么填、密钥放哪：见 USAGE.md（使用说明）。',
    '',
    noVendor
      ? '       质量不满意就改工具仓库里的 docs-kit/scripts/prompts/module.md，\n       或者把它拷到你的 <仓库>/scripts/prompts/ —— 同名文件会被优先采用。'
      : '       质量不满意就改 scripts/prompts/module.md —— 不要去手改 docs/current/，会被覆盖。')

  if (platform !== 'gitlab') {
    step('GitHub 侧还要做两件事（漏了会很安静地不工作）：',
      '       · Settings → Secrets and variables → Actions 加 LLM_API_KEY / LLM_BASE_URL',
      '       · Settings → Actions → General → Workflow permissions 选 "Read and write"')
  }
  if (platform !== 'github') {
    step('GitLab 侧还要做两件事：',
      '       · Settings → CI/CD → Variables 加 LLM_API_KEY / LLM_BASE_URL（勾 Masked）',
      '       · 加一个带 write_repository + api 权限的 DOCS_BOT_TOKEN，用于推分支、开 MR')
  }

  step('提交，然后手动触发一次流水线',
    '       GitHub：Actions → docs → Run workflow　GitLab：Pipelines → Run pipeline',
    '       确认整条链路通了，再交给事件自动触发。')

  log('  随时体检：npx docwarden doctor')

  return { detection, written, skipped, dryRun: false }
}

// ────────────────────────────────────────────────────────────────
// doctor —— 装完之后体检，逐项说清「缺什么、怎么补」
// ────────────────────────────────────────────────────────────────

export async function runDoctor(o) {
  const target = resolve(o.target ?? process.cwd())
  const log = o.log ?? ((s) => console.log(s))
  const results = []
  const add = (level, name, hint) => results.push({ level, name, hint })

  log('')
  log(`🩺 体检：${target}`)

  // Node 版本
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 18) add('ok', `Node ${process.version}`)
  else add('fail', `Node ${process.version} 太旧`, '脚本用到内置 fetch 与 crypto，需要 Node 18 以上')

  if (!existsSync(target)) {
    add('fail', '目标目录不存在', `确认路径：${target}`)
    return report(results, log)
  }

  // 文件是否齐全 —— 先弄清是哪种接入方式，两种模式的必检清单不一样
  const hasGh = existsSync(join(target, '.github/workflows/docs.yml'))
  const hasGl = existsSync(join(target, '.gitlab-ci.yml'))
  const platform = hasGh && hasGl ? 'both' : hasGl ? 'gitlab' : 'github'
  const mode = detectInstallMode(target)
  const noVendor = mode === 'reference'

  if (mode === 'reference') add('ok', '接入方式：引用模式（CI 里 uses: 调工具，脚本不在你的仓库里）')
  else if (mode === 'vendored') add('ok', '接入方式：vendor 模式（脚本拷在你的仓库里，CI 不联网取工具）')
  else if (hasGl) add('ok', '接入方式：GitLab（脚本拷在你的仓库里）')
  else add('warn', '没找到 .github/workflows/docs.yml', '还没装 GitHub 侧；只要 GitLab 的话可以忽略')

  for (const rel of requiredFiles(platform, { noVendor })) {
    if (existsSync(join(target, rel))) add('ok', rel)
    else add('fail', `缺 ${rel}`, '跑一次 npx docwarden init 补齐')
  }

  if (platform === 'github') {
    add('warn', '没有 .gitlab-ci.yml', '不需要 GitLab 可以忽略；需要就加 --platform=both 重装')
  }
  if (platform === 'gitlab') {
    add('warn', '没有 GitHub workflow', '不需要 GitHub 可以忽略；需要就加 --platform=both 重装')
  }

  // .gitignore
  const gi = join(target, '.gitignore')
  if (existsSync(gi) && readFileSync(gi, 'utf8').includes('.docs-preview.md')) {
    add('ok', '.gitignore 含 .docs-preview.md')
  } else {
    add('warn', '.gitignore 缺 .docs-preview.md', 'PR 预览是临时产物，不忽略会有人误提交')
  }

  // 配置文件能不能读、模块划分对不对得上
  const cfgPath = join(target, '.knowledge.mjs')
  let cfg = null
  if (existsSync(cfgPath)) {
    try {
      const mod = await import(pathToFileURL(cfgPath).href + `?t=${Date.now()}`)
      cfg = mod.default
    } catch (e) {
      add('fail', '.knowledge.mjs 加载失败', `报错：${e.message}`)
    }
    if (cfg) {
      add('ok', '.knowledge.mjs 可加载')
      const mods = Array.isArray(cfg.modules) ? cfg.modules : []
      if (!mods.length) {
        add('fail', '配置里一个模块都没有', '文档不会生成任何内容，先填 modules')
      } else {
        add('ok', `配置了 ${mods.length} 个模块`)
      }
      // 前缀指向的目录是否还在 —— 这就是「配置腐烂」，最危险的一类问题：静默停更
      const gone = []
      const empty = []
      for (const m of mods) {
        const prefixes = m.prefixes ?? (m.prefix ? [m.prefix] : [])
        let hit = 0
        for (const p of prefixes) {
          const abs = join(target, p)
          if (!existsSync(abs)) { gone.push(`${m.name} → ${p}`); continue }
          try {
            if (countCode(abs, 0) > 0) hit++
            else empty.push(`${m.name} → ${p}`)
          } catch { /* 读不动就当空 */ }
        }
        if (!hit && !prefixes.length) gone.push(`${m.name} → (没写 prefixes)`)
      }
      if (gone.length) add('fail', `${gone.length} 个模块的前缀指向不存在的目录`, '目录改名了？改配置。这是静默停更的头号原因：\n      ' + gone.join('\n      '))
      else add('ok', '所有模块前缀都能对上目录')
      if (empty.length) add('warn', `${empty.length} 个前缀下没有源码文件`, empty.join('、'))

      if (!cfg.sourceRoots || !cfg.sourceRoots.length) {
        add('warn', 'sourceRoots 是空的', '巡检就发现不了「新目录忘了配模块」这件事')
      } else {
        const missingRoots = cfg.sourceRoots.filter((s) => !existsSync(join(target, s)))
        if (missingRoots.length) add('warn', `sourceRoots 里有不存在的目录：${missingRoots.join('、')}`, '删掉或改对')
        else add('ok', 'sourceRoots 都真实存在')
      }
    }
  }

  // docs 目录
  for (const d of DOC_DIRS) {
    if (existsSync(join(target, d))) add('ok', `${d}/`)
    else add('warn', `缺目录 ${d}/`, '跑一次 init 会创建')
  }

  // 模型接口配没配。
  // 配置里填了、或环境变量给了，都算配上 —— 两者等价，这是「换模型只改一个变量」的前提。
  //
  // 之所以专门查这一条：这个工具**故意不预填任何厂商地址**（填哪个地址就等于把源码
  // 发给谁，那是使用者的决定），所以「没配模型」会是最常见的第一脚绊。它不算 fail
  // —— audit 巡检不调模型，不配也能跑；但只要想生成文档，这就是第一件要做的事。
  const llm = cfg?.llm ?? {}
  const baseUrl = llm.baseUrl || process.env.LLM_BASE_URL
  const model = llm.model || process.env.LLM_MODEL
  const missingModel = [
    !baseUrl && 'baseUrl（接口地址）',
    !model && 'model（模型名）',
  ].filter(Boolean)

  if (missingModel.length) {
    add('warn', `模型接口还没配，缺：${missingModel.join('、')}`,
      '这个工具不预填厂商地址（填哪个就等于把源码发给谁）。填 .knowledge.mjs 里的 llm.baseUrl / llm.model，或设 LLM_BASE_URL / LLM_MODEL 环境变量，两种等价。见 USAGE.md')
  } else {
    add('ok', `模型接口已配：${model} @ ${baseUrl}`)
    if (!process.env.LLM_API_KEY) {
      add('warn', '没看到 LLM_API_KEY 环境变量',
        'CI 里配成 Secret；本地临时跑 export 一下。密钥不要写进配置文件')
    } else {
      add('ok', 'LLM_API_KEY 已设置')
    }
  }

  // 能不能跑
  const localScript = join(target, 'scripts/docs-update.mjs')
  if (existsSync(localScript)) {
    try {
      const { execFileSync } = await import('node:child_process')
      execFileSync(process.execPath, ['--check', localScript], { stdio: 'pipe' })
      add('ok', '主脚本语法正常')
    } catch (e) {
      add('fail', '主脚本语法检查不通过', String(e.stderr || e.message).slice(0, 300))
    }
  } else if (noVendor) {
    add('ok', '本地没有主脚本（引用模式如此，正常）')
  }

  // 装好的模板里地址是对的，所以这条平时不会响。留着是为了拦住手改 / 从旧版本升上来的情况：
  // 占位符不换，Actions 会直接找不到这个 Action，而失败信息不会指向这里。
  if (noVendor) {
    const wf = stripYamlComments(readFileSync(join(target, '.github/workflows/docs.yml'), 'utf8'))
    const m = wf.match(/^\s*uses:\s*(\S*docwarden@\S+)/m)
    if (m && /your-org/.test(m[1])) {
      add('fail', `workflow 里的仓库地址还是占位符：${m[1]}`,
        '★ 必须换成真的仓库，否则 Actions 找不到这个 Action。官方仓库或用你自己的 fork。')
    } else if (m) {
      add('ok', `引用的是 ${m[1]}`)
    }
  }

  return report(results, log)
}

function countCode(dir, depth) {
  if (depth > 3) return 0
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    if (e.isDirectory()) n += countCode(join(dir, e.name), depth + 1)
    else if (CODE_EXT.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase())) n++
  }
  return n
}

function report(results, log) {
  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' }
  log('')
  for (const r of results) {
    log(`  ${icon[r.level]} ${r.name}`)
    if (r.hint) log(`      → ${r.hint}`)
  }
  const fails = results.filter((r) => r.level === 'fail').length
  const warns = results.filter((r) => r.level === 'warn').length
  log('')
  if (fails) {
    log(`❌ ${fails} 项有问题必须处理，${warns} 项提醒。`)
  } else if (warns) {
    log(`✅ 没有阻塞性问题，${warns} 项提醒（见上，多为提示性的，可忽略）。`)
  } else {
    log('✅ 全部通过。可以开始用了。')
  }
  return { results, fails, warns }
}
