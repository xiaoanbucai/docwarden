/**
 * detect.mjs —— 探测一个仓库该怎么切成模块
 *
 * 这个文件只做一件事：**给出一个像样的初稿，让人改，而不是让人从零写。**
 *
 * 为什么值得单独写一个文件来做这件事：
 *   `.knowledge.mjs` 里最需要人下判断的就是 modules。对着空白数组发呆，
 *   和对着「你这仓库大概该切成 8 个模块，其中 order 有 42 个文件、建议拆细」
 *   开始改，是两种完全不同的体验。
 *
 * 推断方法（不做任何魔法，纯目录统计）：
 *   逐层试切 —— 第 1 层、第 2 层、第 3 层各切一次，比对哪种切法
 *   落在「每块 3~80 个文件」这个可用区间里的文件最多。落在区间外会扣分：
 *   切得太粗（一个大块包住全仓库）和切得太细（每块一两个文件）都会被自然淘汰。
 *
 * 它的结论**只是建议**。真正的划分依据是业务边界，那只有人知道。
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, sep, extname, basename, resolve } from 'node:path'

/** 参与文档生成的源码后缀。按需在 .knowledge.mjs 里再加。 */
export const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
  '.vue', '.svelte', '.astro',
  '.py', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.kts',
  '.cs', '.swift', '.dart', '.scala', '.lua', '.ex', '.exs', '.erl',
])

/**
 * 探测时跳过的目录。
 * 注意这只影响**探测**，最终由 .knowledge.mjs 里的 ignorePaths 决定脚本行为。
 */
export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor', 'third_party',
  'dist', 'build', 'out', 'output', 'coverage', 'unpackage',
  '.next', '.nuxt', '.output', '.svelte-kit', '.vercel', '.turbo',
  '.venv', 'venv', '__pycache__', '.gradle', 'target', 'obj',
  'tmp', 'temp', 'docs', 'public', 'static', 'assets', 'migrations',
])

const MAX_DEPTH = 6
const MIN_FILES_PER_MODULE = 3     // 少于这个数，不值得单独成模块
export const SWEET_SPOT = 12       // 这个规模附近的模块最理想，给最高单价
export const SOFT_MAX_FILES = 30   // 超过这个数就提示「建议拆细」
const HARD_MAX_FILES = 80          // 超过这个数，当成噪音而不是模块

/**
 * 一个分组的「值多少分」。
 *
 * 这张曲线是整个推断的核心，所以解释一下它为什么长这样：
 *
 *   太小（< 3）      → 0 分。一两个文件撑不起一篇文档，宁可不覆盖。
 *   好用（3~12）     → 3 分/文件。最理想，重奖。
 *   能用（12~30）    → 1 分/文件。可以接受，但明显不如切细。
 *   太大（> 30）     → 0.2 分/文件。接近惩罚，**鼓励继续往下切一层**。
 *
 * 关键在最后两档的落差：`src/modules/` 里塞着 22 个文件（含 order/user/payment/notify
 * 四个子目录）得 22 分，而切到下一层变成 7+6+5+4 得 66 分 —— 于是脚本会选择继续切。
 * 没有这个落差，贪心的「覆盖文件数最多」会让它停在最粗的那一层上。
 */
function groupScore(size, min, softMax) {
  if (size < min) return 0
  if (size <= SWEET_SPOT) return size * 3
  if (size <= softMax) return size * 1
  return size * 0.2
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 扫出所有源码文件（相对 root 的 posix 路径）。
 * 不跟符号链接，权限错误的目录直接跳过 —— 探测失败不该让整个安装中断。
 */
export function walkCodeFiles(root, opts = {}) {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH
  const ignore = opts.ignore ?? DEFAULT_IGNORE_DIRS
  const out = []
  const seen = new Set()

  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue          // .git / .github / 各种点文件
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (ignore.has(e.name)) continue
        walk(full, depth + 1)
        continue
      }
      if (!e.isFile()) continue                     // 符号链接、设备文件都不跟
      if (e.name.endsWith('.min.js') || e.name.endsWith('.d.ts')) continue
      if (!CODE_EXT.has(extname(e.name).toLowerCase())) continue
      const rel = relative(root, full).split(sep).join('/')
      if (rel.startsWith('..') || seen.has(rel)) continue
      seen.add(rel)
      out.push(rel)
    }
  }

  walk(root, 1)
  return out.sort()
}

/**
 * 给出模块划分初稿。
 *
 * @param {string[]} files 相对路径列表（来自 walkCodeFiles）
 * @returns {{modules: Array, sourceRoots: string[], leftovers: string[], level: number, warnings: string[]}}
 */
export function suggestModules(files, opts = {}) {
  const min = opts.minFilesPerModule ?? MIN_FILES_PER_MODULE
  const hardMax = opts.hardMaxFiles ?? HARD_MAX_FILES
  const maxModules = opts.maxModules ?? 15
  const warnings = []

  if (!files.length) {
    return {
      modules: [], sourceRoots: [], leftovers: [], level: 0,
      warnings: ['这个目录里一个源码文件都没扫到。模块划分需要你手工填写 —— 见 .knowledge.mjs 里的说明。'],
    }
  }

  const atLevel = (rel, n) => {
    const p = rel.split('/')
    return p.length > n ? p.slice(0, n).join('/') : null
  }

  // ── 逐层试切，选得分最高的那一层 ──────────────────────────────
  // 评分规则见 groupScore 的注释：核心是让「继续切细」在划算时有分可拿。
  //
  // ⚠️ 为什么还要加一个「可用模块数」奖励：
  // groupScore 是**按文件数**给分的，于是「12 个文件一锅端」和「切成 3 个各 4 文件的模块」
  // 得分完全相同（都是 12×3）。此时唯一能分出高下的就是层级惩罚，而它偏向更浅 ——
  // 结果是把一个明明分好了三个业务目录的项目压成 `src/` 一个大模块。
  // （实测踩到过：src/modules/{order,cart,auth} 各 4 个文件 → 只推断出 `src/`。）
  //
  // 但一份模块文档就是一份产出：切出 3 个都落在理想区间的模块，比 1 个臃肿的大模块
  // 有用得多。所以每个「够格成模块」的组都额外记一笔，让细分在**不让任何组掉出可用区间**
  // 的前提下胜出。掉出可用区间的组（< min）不计入，所以它也没有鼓励切碎片的副作用。
  const VIABLE_BONUS = 1.5
  let best = null
  for (let level = 1; level <= 3; level++) {
    const groups = new Map()
    for (const f of files) {
      const k = atLevel(f, level)
      if (k == null) continue
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(f)
    }
    let score = 0
    let viable = 0
    for (const [, arr] of groups) {
      const size = arr.length
      score += groupScore(size, min, opts.softMaxFiles ?? SOFT_MAX_FILES)
      if (size >= min && size <= hardMax) viable++
    }
    score += viable * VIABLE_BONUS
    // 真出现同分时，取**更深、更具体**的那一层：`src/modules/` 优于 `src/`。
    // 反过来（偏向更浅）会把前缀一路放宽到 `src/`，那等于把整个源码树吞成一个模块，
    // 之后新增任何目录都自动落进它，永远不报警 —— 而「新目录漏配」正是最隐蔽的故障。
    // 惩罚刻意做得极小，只为裁决平手，不影响任何按文件数分出的高下。
    score += level * 0.5
    if (!best || score > best.score) best = { level, groups, score }
  }

  const { level, groups } = best

  // ── 挑选成模块的组 ────────────────────────────────────────────
  const entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  const chosen = entries.filter(([, arr]) => arr.length >= min && arr.length <= hardMax).slice(0, maxModules)

  const taken = new Set()
  const modules = chosen.map(([key, arr], i) => {
    const parts = key.split('/')
    const last = parts[parts.length - 1]
    let name = slug(last)
    if (!name) name = 'm' + (i + 1)
    if (taken.has(name)) {
      const prev = parts[parts.length - 2]
      name = slug((prev ? prev + '-' : '') + last) || 'm' + (i + 1)
    }
    taken.add(name)
    return {
      name,
      title: last,               // 目录名原样保留，中文目录名会比较可读
      prefix: key + '/',
      files: arr,
    }
  })

  // ── 源码根目录 ────────────────────────────────────────────────
  // 取模块前缀的第一段（`src/modules/order/` → `src/`）。
  //
  // 刻意取到最上面那一层：巡检要干的事是「找出新建了、但忘了配模块的目录」，
  // 如果只报到 `src/modules/`，那么新出现的 `src/utils/` 就永远发现不了 ——
  // 而这正是最危险的一类问题：静默无文档、不报错。
  let sourceRoots = [...new Set(modules.map((m) => m.prefix.split('/')[0] + '/'))].sort()

  // ── 补漏：把源码树里落空、又够大的目录收成模块 ─────────────────
  // 逐层试切只选**一层**，于是同层的兄弟目录（下面是 src/utils、src/components）
  // 会整块落空。落空等于静默无文档，所以这里按「目录内文件数 ≥ min」再收一遍。
  //
  // 三点克制，避免把配置、脚本这类边角目录也收进来：
  //   · 只收源码根目录下的**第一段**子目录
  //   · 与已有模块前缀重叠的一律不要（前缀会互相吞并，`src/` 能吃掉一切）
  //   · 最多补 4 个
  {
    const covered = new Set()
    for (const m of modules) for (const f of m.files) covered.add(f)
    const moduleDirs = modules.map((m) => m.prefix)
    const byDir = new Map()
    for (const f of files) {
      if (covered.has(f)) continue
      const root = sourceRoots.find((r) => f.startsWith(r))
      if (!root) continue
      const rel = f.slice(root.length)
      if (!rel.includes('/')) continue            // 直接躺在源码根下的散文件，不收（前缀会吃掉全局）
      const prefix = root + rel.split('/')[0] + '/'
      if (moduleDirs.some((d) => prefix.startsWith(d) || d.startsWith(prefix))) continue
      if (!byDir.has(prefix)) byDir.set(prefix, [])
      byDir.get(prefix).push(f)
    }
    const sweep = [...byDir.entries()]
      .filter(([, arr]) => arr.length >= min)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, opts.maxExtraModules ?? 4)
    for (const [prefix, arr] of sweep) {
      const last = prefix.slice(0, -1).split('/').pop()
      let name = slug(last) || 'm' + (modules.length + 1)
      while (taken.has(name)) name += '-2'
      taken.add(name)
      modules.push({ name, title: last, prefix, files: arr, swept: true })
    }
  }

  for (const [key, arr] of entries) {
    if (arr.length > hardMax) {
      warnings.push(`\`${key}/\` 下有 ${arr.length} 个文件，太粗了，没敢直接当模块 —— 建议按业务再切一层。`)
    }
  }
  for (const m of modules) {
    if (m.files.length > SOFT_MAX_FILES) {
      warnings.push(`模块 \`${m.name}\` 有 ${m.files.length} 个文件，超过了建议上限 ${SOFT_MAX_FILES} —— 生成会变慢、也更容易写不完整，建议拆细。`)
    }
  }
  if (entries.length > maxModules) {
    warnings.push(`可用分组有 ${entries.length} 个，只取了前 ${maxModules} 个（按文件数排序），其余请手工补进 .knowledge.mjs。`)
  }

  // ── 仍然没被覆盖的文件 ────────────────────────────────────────
  // 这些文件按设计会被忽略（不写进知识库）。列出来是为了让人知道「我漏了什么」，
  // 因为漏配的后果是完全静默的：没有文档，也没有任何报错。
  const coveredAll = new Set()
  for (const m of modules) for (const f of m.files) coveredAll.add(f)
  const leftovers = files.filter((f) => !coveredAll.has(f))

  return { modules, sourceRoots, leftovers, level, warnings }
}

/** 读项目名：优先 package.json 的 name，其次目录名 */
function detectName(root) {
  const pkgPath = join(root, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg.name) return String(pkg.name).replace(/^@[^/]+\//, '')
    } catch {
      // package.json 坏了不该让 init 失败 —— 这不是我们的文件
    }
  }
  return basename(resolve(root)) || 'my-project'
}

/**
 * 完整探测：给 init 用的一份报告。
 *
 * @param {string} root 目标仓库根目录
 */
export function detectProject(root) {
  const warnings = []
  const files = walkCodeFiles(root)
  const { modules, sourceRoots, leftovers, level, warnings: mw } = suggestModules(files)
  warnings.push(...mw)

  const byExt = {}
  for (const f of files) {
    const e = extname(f).toLowerCase()
    byExt[e] = (byExt[e] || 0) + 1
  }

  // monorepo 提示：这类仓库一次性装到根目录，模块划分会非常难看。
  const pkgPath = join(root, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const ws = pkg.workspaces
      const list = Array.isArray(ws) ? ws : ws && Array.isArray(ws.packages) ? ws.packages : null
      if (list && list.length) {
        warnings.push(`检测到 monorepo（workspaces: ${list.slice(0, 3).join(', ')}${list.length > 3 ? ' …' : ''}）。建议对每个子包分别 init，而不是只在根目录装一次 —— 否则模块划分会把几个不相干的子包混在一起。`)
      }
    } catch { /* 同上，忽略 */ }
  }

  return {
    name: detectName(root),
    root: resolve(root),
    files,
    fileCount: files.length,
    byExt,
    modules,
    sourceRoots,
    leftovers,
    level,
    warnings,
  }
}

/** 人话版的一句话摘要，供 CLI 打印 */
export function summarizeDetection(d) {
  const top = Object.entries(d.byExt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([e, n]) => `${e}×${n}`)
    .join('  ')
  return `${d.fileCount} 个源码文件（${top}），切在第 ${d.level} 层目录`
}
