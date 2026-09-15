#!/usr/bin/env node
/**
 * tools/check-zero-dep.mjs —— 守住「主程序零依赖」这条承诺
 *
 * 为什么值得单独做一个检查、而不是靠自觉：
 * 零依赖是这个工具的核心卖点之一 —— CI 里不需要 `npm install`，公司内网也能跑。
 * 但它是**一条会悄悄失效的承诺**：某天有人为了省事 `import` 一个 npm 包，
 * 本地开发环境装着依赖，测试照样全绿，直到使用者在一个干净的 CI 里跑才发现。
 *
 * 检查方式：把「看起来像 import 的行」找出来，判定它的来源说明符。
 * 用锚定行首的正则，而不是全文找 `from '...'` —— 后者会被字符串里的
 * `from`（比如代码切片时写的 `slice(from > 0 ? ...)`）误伤，而一条会误报的检查，
 * 别人很快就会开始给它加豁免，然后它就废了。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

/**
 * 必须保持零依赖的文件。
 * 注意 docwarden.mjs / docwarden-mcp.mjs / docs-kit 下的脚本都会**装进使用者机器**，
 * 一旦引入依赖，使用者的 CI 就必须联网装包 —— 那就不是这个工具了。
 */
const MUST_BE_DEP_FREE = [
  'docwarden.mjs',
  'docwarden-mcp.mjs',
  'bin/cli.mjs',
  'src/detect.mjs',
  'src/install.mjs',
  'src/templates/knowledge.mjs.tpl', // 不是代码，但顺手确认它还在
  'docs-kit/scripts/docs-update.mjs',
  'docs-kit/scripts/lib/freshness.mjs',
]

// 三条模式都锚定在行首（前面只允许空白），因此注释里写的 `from 'xxx'` 不会命中。
// 第二条用 `[^'"(]*?` 排除裸括号，这样动态 `import(` 不会被误当成静态导入。
const PATTERNS = [
  { re: /^[ \t]*import\s+['"]([^'"]+)['"]/gm, name: 'import "x"' },
  { re: /^[ \t]*import\s+([^'"(]*?)\s+from\s+['"]([^'"]+)['"]/gm, name: 'import ... from "x"', group: 2 },
  { re: /^[ \t]*export\s+([^'"(]*?)\s+from\s+['"]([^'"]+)['"]/gm, name: 'export ... from "x"', group: 2 },
]

let bad = 0
let scanned = 0
const missing = []

for (const rel of MUST_BE_DEP_FREE) {
  const file = join(ROOT, rel)
  if (!existsSync(file)) {
    missing.push(rel)
    continue
  }
  scanned++
  const src = readFileSync(file, 'utf8')
  for (const { re, name, group = 1 } of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src))) {
      const spec = m[group]
      if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('/')) continue
      const line = src.slice(0, m.index).split('\n').length
      console.log(`❌ ${rel}:${line} 引入了外部依赖 —— ${name} 里的 "${spec}"`)
      bad++
    }
  }
}

for (const rel of missing) console.log(`⚠️  ${rel} 不存在（清单该更新了？）`)

if (bad) {
  console.log(`\n❌ 有 ${bad} 处外部依赖。主程序必须零依赖：CI 里不跑 npm install，装了包就等于要求使用者联网装依赖。`)
  console.log('   确实需要新依赖？那它应该只出现在 tests/ 或 devDependencies 里。')
  process.exit(1)
}
console.log(`✅ 零依赖检查通过（${scanned} 个文件，${missing.length} 个缺失）`)
