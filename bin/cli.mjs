#!/usr/bin/env node
/**
 * bin/cli.mjs —— `docwarden` 命令入口
 *
 * 一条命令装进任何仓库：
 *   npx docwarden init
 *
 * 五个子命令，按一个使用者会走的顺序排列：
 *   init     装进当前仓库（探测结构 → 生成配置 → 拷贝脚本与 CI）
 *   doctor   体检：缺什么、哪里烂了、怎么补
 *   update   在本地跑一次 CI 用的那份脚本
 *   serve    起本地工作台（浏览器界面）
 *   mcp      起 MCP 服务，把知识库连同状态交给 AI 编程助手
 *
 * 参数解析刻意做得很笨：只认 `--k=v` 和 `--k v` 两种写法，不做别名、不做简写。
 * 一个安装器如果连自己的参数都猜，使用者排查起来会很痛苦。
 */

import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PKG_ROOT, PLATFORMS, runInit, runDoctor } from '../src/install.mjs'

const argv = process.argv.slice(2)

function parseArgs(list) {
  const flags = new Map()
  const rest = []
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (!a.startsWith('--')) { rest.push(a); continue }
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1))
    } else {
      const next = list[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags.set(a.slice(2), next); i++ }
      else flags.set(a.slice(2), 'true')
    }
  }
  return { flags, rest }
}

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))

const HELP = `
docwarden v${pkg.version} —— 在你的 GitHub Actions / GitLab CI 上，把代码库扫成一套管得住新鲜度的模块文档

用法
  npx docwarden <命令> [选项]

接到 CI 上（主线）
  init      装进当前仓库：探测目录结构 → 推断模块划分 → 生成配置与 CI 配置。
            两种接入方式：
              vendor（默认）  脚本拷进你的仓库，CI 不联网取工具，内网也能跑
              引用            不拷脚本，CI 里用 uses: 直接调（目前仅 GitHub）
  doctor    体检安装是否完整，逐项给出「缺什么、怎么补」。
  update    跑一次 CI 用的那份脚本，四种模式：
              --mode incremental   主干合并后刷新受影响模块的文档
              --mode preview       PR 阶段的影响预览（不写正式文件）
              --mode chapter       Release 后的版本演进章节
              --mode audit         巡检漂移（不调模型，零成本，随时可跑）
            引用模式下会自动用工具自带的脚本，并把 --root 指向你当前目录。

本地辅助（可选，跟 CI 上是同一套逻辑，用来先看效果）
  serve     起本地界面：扫描 → 划分模块 → 逐篇生成 → 逐篇人工确认。
  mcp       把知识库连同每篇的确认状态交给 AI 编程助手（MCP）。

init 选项
  --dir <路径>            装到哪个仓库，默认当前目录
  --platform <平台>       github | gitlab | both，默认 github
  --no-vendor             引用模式：脚本不进你的仓库，CI 里用 uses: 调（仅 GitHub）
  --force                 覆盖已存在的文件（默认一律不覆盖）
  --dry-run               只打印计划，不写任何文件
  --yes                   不问任何问题（本工具默认就不问，这个参数是给脚本用的）

update 选项
  其余参数原样转给 docs-update.mjs，例如：
    npx docwarden update --mode audit
    npx docwarden update --mode incremental --base=HEAD~5 --dry-run
    npx docwarden update --mode chapter --version=v1.2.0

serve / mcp 选项
  --port <端口>           serve 的监听端口，默认 5173
  --no-open               serve 不自动打开浏览器
  --root <路径>           mcp 的知识库根目录，默认当前目录

例
  npx docwarden init                      # 默认：GitHub + vendor 模式
  npx docwarden init --no-vendor          # GitHub + 引用模式（不往你仓库塞脚本）
  npx docwarden init --platform=gitlab    # GitLab
  npx docwarden init --dry-run            # 先看看会写哪些文件
  npx docwarden doctor                    # 装完先体检
  npx docwarden update --mode audit       # 不花钱的巡检，随时可跑

文档
  USAGE.md             ★ 使用说明：从零到跑通的逐步操作（含模型怎么配）
  README.md            为什么需要它、两种接入方式怎么选
  docs-kit/SETUP.md    模型怎么选、密钥放哪、权限怎么开
  docs-kit/README.md   装进仓库之后的日常使用
`

function runNodeScript(file, args) {
  if (!existsSync(file)) {
    console.error(`\n❌ 找不到 ${file}\n   先跑一次：npx docwarden init\n`)
    process.exit(1)
  }
  const child = spawn(process.execPath, [file, ...args], { stdio: 'inherit' })
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0))
  child.on('error', (e) => { console.error(`❌ 启动失败：${e.message}`); process.exit(1) })
}

const cmd = argv[0]

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(HELP)
  process.exit(0)
}

if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  console.log(pkg.version)
  process.exit(0)
}

const { flags, rest } = parseArgs(argv.slice(1))
const targetDir = resolve(flags.get('dir') || flags.get('cwd') || process.cwd())

switch (cmd) {
  case 'init': {
    const platform = String(flags.get('platform') || 'github')
    if (!PLATFORMS.includes(platform)) {
      console.error(`\n❌ --platform 只能是 ${PLATFORMS.join(' | ')}，收到的是 "${platform}"\n`)
      process.exit(1)
    }
    const noVendor = flags.get('no-vendor') === 'true'
    if (noVendor && platform !== 'github') {
      console.error([
        '',
        `❌ --no-vendor（引用模式）目前只支持 GitHub，你指定的是 --platform=${platform}。`,
        '   原因：GitHub Actions 有原生的 uses: 机制可以直接引用这个工具；',
        '   GitLab 没有对应的东西 —— 那边只能把脚本放进仓库（也就是默认的 vendor 模式）。',
        '',
        '   想两个平台都要：npx docwarden init --platform=both',
        '',
      ].join('\n'))
      process.exit(1)
    }
    try {
      runInit({
        target: targetDir,
        platform,
        noVendor,
        force: flags.get('force') === 'true',
        dryRun: flags.get('dry-run') === 'true',
      })
    } catch (e) {
      console.error(`\n❌ 安装失败：${e.message}\n`)
      process.exit(1)
    }
    break
  }

  case 'doctor': {
    const { fails } = await runDoctor({ target: targetDir })
    process.exit(fails ? 1 : 0)
    break
  }

  case 'update': {
    const rest = argv.slice(1)
    const local = join(targetDir, 'scripts/docs-update.mjs')

    // 优先跑**你仓库里那份** —— 你改过 prompts 和 .knowledge.mjs，必须用你的。
    if (existsSync(local)) {
      runNodeScript(local, rest)
      break
    }

    // 引用模式：脚本不在你仓库里。用工具自带的那份，把目标仓库指过去。
    const bundled = join(PKG_ROOT, 'docs-kit/scripts/docs-update.mjs')
    if (!existsSync(bundled)) {
      console.error([
        '',
        `❌ 既没有 ${local}，工具自带的脚本也不在（安装包不完整？）`,
        '   跑一次 npx docwarden init 可以补齐 vendor 模式所需的一切。',
        '',
      ].join('\n'))
      process.exit(1)
    }
    const hasRoot = rest.some((a) => a === '--root' || a.startsWith('--root='))
    console.log(`（引用模式：用工具自带的脚本，目标仓库 ${targetDir}）`)
    runNodeScript(bundled, hasRoot ? rest : [...rest, '--root', targetDir])
    break
  }

  case 'serve': {
    const args = []
    if (flags.has('port')) args.push('--port', flags.get('port'))
    if (flags.get('no-open') === 'true') args.push('--no-open')
    runNodeScript(join(PKG_ROOT, 'docwarden.mjs'), args)
    break
  }

  case 'mcp': {
    const args = []
    if (flags.has('root')) args.push('--root', flags.get('root'))
    runNodeScript(join(PKG_ROOT, 'docwarden-mcp.mjs'), args)
    break
  }

  default: {
    console.error(`\n❌ 不认识的命令："${cmd}"（多余的参数：${rest.join(' ') || '无'}）`)
    console.log(HELP)
    process.exit(1)
  }
}
