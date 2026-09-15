// 安装器的冒烟测试：`npx docwarden init` 是使用者走的第一条路径，
// 它坏了就没有后面任何事。所以这里不测「函数返回值对不对」，而是**真的装一遍再验收**。
//
// 重点验的是三件容易出错、又不容易发现的事：
//   1. 幂等 —— 第二次 init 绝不能把人改过的 .knowledge.mjs 冲掉
//   2. 预演 —— --dry-run 必须一个字节都不写
//   3. 装完真能跑 —— 在装好的项目里跑一次 --mode audit（不调模型，零成本）
//
// 另外顺带守住「模块推断」那条曲线：一个 src/modules/ 下分了四个业务目录的项目，
// 必须切到 src/modules/<业务>/ 那一层，而不是停在 src/modules/ 上一锅端。
// 打分曲线本身（尺度不敏感、同分偏浅这两个坑）在「场景七」里用纯函数铺开测。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'

// 场景十要一边跑假模型服务、一边跑被测脚本，所以那一处必须用异步版：
// execFileSync 会阻塞本进程的事件循环，同进程里的假模型永远收不到请求，
// 于是子进程等响应、父进程等子进程 —— 直接死锁（写这版时踩过）。
const pexec = promisify(execFile)

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const CLI = path.join(ROOT, 'bin', 'cli.mjs')
const { runInit, runDoctor, requiredFiles, detectInstallMode, stripYamlComments } = await import(
  new URL('../src/install.mjs', import.meta.url).href
)

const WORK = path.join(os.tmpdir(), 'docwarden-init-smoke')
const DRY = path.join(os.tmpdir(), 'docwarden-init-dry')
const ONLY_GL = path.join(os.tmpdir(), 'docwarden-init-gitlab')
const REF = path.join(os.tmpdir(), 'docwarden-init-ref')
const fails = []
const check = (ok, msg) => { console.log(`  ${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg) }
const silent = () => {}

/** 造一个「像真实项目」的夹具：src/modules 下四个业务目录 + utils/components。 */
function makeFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  const put = (rel, n) => {
    fs.mkdirSync(path.join(dir, rel), { recursive: true })
    for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(dir, rel, `file${i}.js`), `export const a = ${i}\n`)
  }
  put('src/modules/order', 7)
  put('src/modules/user', 6)
  put('src/modules/payment', 5)
  put('src/modules/notify', 4)
  put('src/utils', 4)
  put('src/components', 3)
  fs.writeFileSync(path.join(dir, 'src/main.js'), '// 入口\n')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/shop-miniapp', version: '1.0.0' }, null, 2))
  // 这几类目录必须被探测忽略，否则模块划分会被噪音带偏
  for (const junk of ['node_modules/pkg', 'dist', 'docs/current']) {
    fs.mkdirSync(path.join(dir, junk), { recursive: true })
    fs.writeFileSync(path.join(dir, junk, 'junk.js'), '// 不该被扫到\n')
  }
}

const readCfg = (dir) => fs.readFileSync(path.join(dir, '.knowledge.mjs'), 'utf8')

try {
  // ── 场景一：装进一个干净项目 ───────────────────────────────
  console.log('\n▸ 干净项目：init --platform=both')
  makeFixture(WORK)
  const r1 = runInit({ target: WORK, platform: 'both', log: silent })

  for (const rel of requiredFiles('both')) {
    check(fs.existsSync(path.join(WORK, rel)), `产出 ${rel}`)
  }
  check(fs.existsSync(path.join(WORK, '.gitlab/merge_request_templates/Default.md')), '产出 GitLab MR 模板')
  check(fs.existsSync(path.join(WORK, 'docs/README.md')), '产出 docs/README.md（给同事的说明）')
  check(fs.existsSync(path.join(WORK, 'docs/decisions')), '产出 docs/decisions/（人写的地方）')
  check(fs.readFileSync(path.join(WORK, '.gitignore'), 'utf8').includes('.docs-preview.md'), '.gitignore 含 .docs-preview.md')

  // ── 场景二：模块推断的粒度 ─────────────────────────────────
  console.log('\n▸ 模块推断')
  const cfg = readCfg(WORK)
  const names = r1.detection.modules.map((m) => m.name)
  check(names.includes('order') && names.includes('payment'), '切到了 src/modules/<业务>/ 这一层，没有停在 src/modules/')
  check(!names.includes('modules'), '没有把 src/modules/ 整个当成一个模块')
  check(names.includes('utils') || names.includes('components'), '落空的兄弟目录（utils/components）被补收成模块')
  check(r1.detection.sourceRoots.join(',') === 'src/', 'sourceRoots 取到源码树顶层 src/（否则巡检发现不了漏配目录）')
  check(!r1.detection.files.some((f) => f.startsWith('node_modules/')), '探测没有把 node_modules 下的文件算进来')
  check(!r1.detection.modules.some((m) => m.prefix.includes('node_modules')), '生成的模块前缀没有指进 node_modules')
  check(r1.detection.modules.every((m) => !m.name.includes('junk')), '噪音目录没有变成模块（junk.js 在 node_modules/dist/docs 下）')
  check(!r1.detection.files.some((f) => f.startsWith('dist/') || f.startsWith('docs/')), '探测忽略了 dist/ 与 docs/')

  // 生成的配置必须是**能加载**的 ESM，而不是看起来像
  let loaded = null
  try {
    loaded = (await import(new URL(`file://${path.join(WORK, '.knowledge.mjs').replace(/\\/g, '/')}?t=1`).href)).default
  } catch (e) {
    check(false, `.knowledge.mjs 能被 Node 加载（报错：${e.message}）`)
  }
  if (loaded) {
    check(loaded.project === 'shop-miniapp', `项目名去掉了 npm scope（得到 "${loaded.project}"）`)
    check(Array.isArray(loaded.modules) && loaded.modules.length >= 4, `配置里写出了 ${loaded.modules?.length} 个模块`)
    check(loaded.modules.every((m) => Array.isArray(m.prefixes) && m.prefixes.every((p) => p.endsWith('/'))), '每个模块的 prefixes 都以 / 结尾（否则前缀会误匹配同名前缀目录）')
    check(loaded.guard && loaded.guard.maxChangedFiles > 0, '护栏配置被带过来了（不会被模板漏掉）')
  }

  // ── 模型配置必须留空：工具不替使用者决定「源码发给谁」────────
  // 查源码文本而不是查加载后的值（环境变量可能恰好被设着，那就验不出模板里预填了没有）；
  // 同时**剔掉注释行** —— 模板里的注释带了几种常见填法当参考，
  // 那是给人看的示例，不是预填值，不剔掉会把自己的说明文字当成违规。
  const cfgCode = cfg.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  check(!/baseUrl:\s*['"]https?:/.test(cfgCode), '可执行的配置行里没有写死任何模型接口地址（不预填厂商）')
  check(!/model:\s*['"][^'"]+['"]/.test(cfgCode), '可执行的配置行里没有预填模型名')
  check(/baseUrl:\s*process\.env\.LLM_BASE_URL \|\| ''/.test(cfgCode), 'baseUrl 从空串起，可由环境变量覆盖')
  check(/model:\s*process\.env\.LLM_MODEL \|\| ''/.test(cfgCode), 'model 从空串起，可由环境变量覆盖')
  check(/本地 Ollama|127\.0\.0\.1:11434/.test(cfg), '但注释里给了填写参考（留空不等于让人摸黑）')

  // ── 场景三：幂等 —— 人的改动不能被冲掉 ─────────────────────
  console.log('\n▸ 幂等：重跑不能覆盖人改过的配置')
  const mine = readCfg(WORK) + '\n// 我手工加的：把 order 拆成 order-create / order-list\n'
  fs.writeFileSync(path.join(WORK, '.knowledge.mjs'), mine)
  const r2 = runInit({ target: WORK, platform: 'both', log: silent })
  check(readCfg(WORK) === mine, '第二次 init 原样保留了 .knowledge.mjs（这是使用者逐字改过的文件）')
  check(r2.written === 0, `第二次 init 一个文件都没写（实际写了 ${r2.written} 个）`)
  check(fs.readFileSync(path.join(WORK, '.gitignore'), 'utf8').split('.docs-preview.md').length - 1 === 1, '.gitignore 没有被重复追加')

  // ── 场景四：预演不落盘 ─────────────────────────────────────
  console.log('\n▸ --dry-run：不能写任何文件')
  makeFixture(DRY)
  const r3 = runInit({ target: DRY, platform: 'both', dryRun: true, log: silent })
  check(r3.dryRun && r3.written > 0, `预演报告了「将写 ${r3.written} 个文件」`)
  check(!fs.existsSync(path.join(DRY, 'scripts/docs-update.mjs')), '预演没有写出主脚本')
  check(!fs.existsSync(path.join(DRY, '.knowledge.mjs')), '预演没有写出配置')
  // 夹具里本来就有 docs/current（当作噪音目录），所以查的是 init 才会创建的那几个子目录
  check(!fs.existsSync(path.join(DRY, 'docs/decisions')), '预演没有创建 docs/decisions/')
  check(!fs.existsSync(path.join(DRY, 'docs/current/modules')), '预演没有创建 docs/current/modules/')
  check(!fs.existsSync(path.join(DRY, 'docs/README.md')), '预演没有写出 docs/README.md')

  // ── 场景五：平台开关 ───────────────────────────────────────
  console.log('\n▸ --platform 只装对应平台')
  makeFixture(ONLY_GL)
  runInit({ target: ONLY_GL, platform: 'gitlab', log: silent })
  check(fs.existsSync(path.join(ONLY_GL, '.gitlab-ci.yml')), 'gitlab：装了 .gitlab-ci.yml')
  check(!fs.existsSync(path.join(ONLY_GL, '.github')), 'gitlab：没有多装 .github/')
} catch (e) {
  check(false, `安装场景：${e.message}`)
}

// ── 场景五之二：引用模式（不往别人仓库里塞脚本）────────────────
// 这是「放到 GitHub 上跑」的主推方式：CI 里 uses: 直接调这个工具，
// 使用者仓库里只留配置，不留代码。
try {
  console.log('\n▸ 引用模式：--no-vendor')
  makeFixture(REF)
  const r = runInit({ target: REF, platform: 'github', noVendor: true, log: silent })

  check(!fs.existsSync(path.join(REF, 'scripts')), '引用模式：没有往仓库里塞 scripts/')
  check(fs.existsSync(path.join(REF, '.knowledge.mjs')), '引用模式：配置照常生成（推断模块是这工具的价值，不能省）')
  check(fs.existsSync(path.join(REF, 'docs/decisions')), '引用模式：目录照常建好')

  const wf = fs.readFileSync(path.join(REF, '.github/workflows/docs.yml'), 'utf8')
  // 只看可执行行：两份 workflow 的头部都写了对方的示例（互相教怎么切换），
  // 把注释也算进来的话，断言会被自己的说明文字骗过。
  const wfCode = stripYamlComments(wf)
  check(/^\s*uses:\s*\S*docwarden@/m.test(wfCode), '引用模式：workflow 真的在用 uses: 调工具')
  check(!/node scripts\/docs-update\.mjs/.test(wfCode), '引用模式：可执行行里没有残留的 node scripts/… 调用')

  check(requiredFiles('github', { noVendor: true }).every((f) => !f.startsWith('scripts/')), '引用模式的必检清单不含 scripts/')
  check(requiredFiles('github').some((f) => f.startsWith('scripts/')), 'vendor 模式的必检清单含 scripts/')
  check(detectInstallMode(REF) === 'reference', 'detectInstallMode 认出引用模式')
  check(detectInstallMode(WORK) === 'vendored', 'detectInstallMode 认出 vendor 模式')
  check(r.detection.modules.length >= 3, `引用模式照样推断出了 ${r.detection.modules.length} 个模块`)

  // 装完就该能跑：模板里不许再留占位符。这条同时守住「发出去的那个模板文件本身」。
  const tpl = fs.readFileSync(path.join(ROOT, 'docs-kit/ci/github-action-only.yml'), 'utf8')
  check(!/your-org/.test(tpl), '发出去的引用模式模板里没有残留占位符')

  const d1 = await runDoctor({ target: REF, log: silent })
  check(!d1.results.some((x) => x.level === 'fail' && /占位符/.test(x.name)), '装完就没有占位符，doctor 不因它报警')
  check(!d1.results.some((x) => x.level === 'fail' && /scripts/.test(x.name)), 'doctor 不会因为「引用模式没有 scripts/」而误报')

  // 但人手改回去、或从带占位符的旧版本升上来，仍会有占位符 —— 护栏得在。
  // 刻意不依赖模板内容，而是**注入**一个占位符来验它。
  const wfPlaceholder = wf.replace(/^([ \t]*uses:[ \t]*)\S*docwarden@/gm, '$1your-org/docwarden@')
  check(wfPlaceholder !== wf, '测试确实把 workflow 改成了占位符版本')
  fs.writeFileSync(path.join(REF, '.github/workflows/docs.yml'), wfPlaceholder, 'utf8')
  const d2 = await runDoctor({ target: REF, log: silent })
  check(d2.fails > 0, 'doctor 拦住了「workflow 里还是占位符」')
  check(d2.results.some((x) => x.level === 'fail' && /占位符/.test(x.name)), 'doctor 明确指出是占位符')
} catch (e) {
  check(false, `引用模式场景：${e.message}`)
}

// ── 场景六：CLI 参数解析 ─────────────────────────────────────
console.log('\n▸ CLI 入口')
try {
  execFileSync(process.execPath, [CLI, 'init', '--dir', REF, '--platform=both', '--no-vendor'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  check(false, '--no-vendor 配 GitLab 应当非零退出，但它正常返回了')
} catch (e) {
  const msg = String(e.stderr || '') + String(e.stdout || '')
  check(e.status === 1, `--no-vendor + GitLab 被拒绝（退出码 ${e.status}）`)
  check(/只支持 GitHub/.test(msg) && /原因/.test(msg), '拒绝时说明了原因，而不是只说「不支持」')
}
try {
  // 顺带验证 --no-vendor 这个开关真的接到了 runInit（不是个摆设参数）
  const out = execFileSync(process.execPath, [CLI, 'init', '--dir', REF, '--no-vendor', '--dry-run'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  check(/引用模式/.test(out), 'CLI 的 --no-vendor 真的传到了安装逻辑（预演里标注了引用模式）')
} catch (e) {
  check(false, `CLI --no-vendor 预演：${e.message}`)
}
try {
  execFileSync(process.execPath, [CLI, 'init', '--dir', DRY, '--platform=travic'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  check(false, '非法 --platform 应当非零退出，但它正常返回了')
} catch (e) {
  const msg = String(e.stderr || '') + String(e.stdout || '')
  check(e.status === 1, `非法 --platform 以退出码 1 结束（实际 ${e.status}）`)
  check(msg.includes('--platform 只能是'), '报错信息说清了合法取值，而不是一串栈')
}
try {
  const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  check(/init/.test(help) && /doctor/.test(help) && /mcp/.test(help), '--help 列出了全部子命令')
  check(/\n\s{2}init\s/.test(help), '错误命令时也会打出用法（使用者不用去翻文档）')
} catch (e) {
  check(false, `--help 应当以 0 退出：${e.message}`)
}

// ── 场景七：模块推断的打分曲线（两个真实踩过的回归缺陷）──────────
// 这一节用纯函数直接喂文件清单，不碰磁盘，所以能把边界情况铺开测。
//
// 缺陷 A（尺度不敏感）：groupScore 按**文件数**给分，于是「12 个文件一锅端」和
//   「切成 3 个各 4 文件的模块」得分完全相同（12×3）。当时唯一的裁决者是层级惩罚，
//   而它偏向更浅 —— 结果把一个分好了三个业务目录的项目压成 `src/` 一个大模块。
// 缺陷 B（同分偏向更浅）：40 个文件挤在 `src/modules/` 时推出 `src/` 作前缀。
//   `src/` 会吞掉整个源码树，之后新增目录永远落不空、巡检永远不报警。
console.log('\n▸ 模块推断的打分曲线')
{
  const { suggestModules } = await import(new URL('../src/detect.mjs', import.meta.url).href)
  /** 按「目录 → 文件数」造一份相对路径清单 */
  const spec = (map) => {
    const out = []
    for (const [dir, n] of Object.entries(map)) {
      for (let i = 1; i <= n; i++) out.push(dir + 'f' + i + '.js')
    }
    return out
  }
  const infer = (map) => suggestModules(spec(map))

  // 缺陷 A 的最小复现：12 个文件，三个业务目录各 4 个
  const small = infer({ 'src/modules/order/': 4, 'src/modules/cart/': 4, 'src/modules/auth/': 4 })
  const smallNames = small.modules.map((m) => m.name).sort()
  check(
    smallNames.join(',') === 'auth,cart,order',
    `12 个文件分在三个业务目录 → 切出 3 个模块（实际 ${smallNames.join(',') || '无'}，level=${small.level}）`,
  )
  check(
    !small.modules.some((m) => m.prefix === 'src/'),
    '没有把整个 src/ 当成一个模块（缺陷 A：切粗切细同分时会退化成这样）',
  )

  // 缺陷 B：同分时应取更具体的那一层
  const fat = infer({ 'src/modules/': 40 })
  check(
    fat.modules.every((m) => m.prefix !== 'src/'),
    `40 个文件挤在 src/modules/ → 前缀不该放宽到 src/（实际 ${fat.modules.map((m) => m.prefix).join(',')}）`,
  )
  check(
    fat.warnings.some((w) => /拆细/.test(w)),
    '超大模块给的是「建议拆细」这种可行动的提示',
  )

  // 不该退化的另一边：已经很细的项目不能因为奖励「模块数」就继续切碎
  const tiny = infer({ 'src/a/': 2, 'src/b/': 2, 'src/c/': 2 })
  check(tiny.modules.length <= 1, `每个目录只有 2 个文件时不切成碎片（实际 ${tiny.modules.length} 个模块）`)

  // 大项目仍要切到业务目录那一层，且每个模块都落在建议区间内
  const big = infer({
    'src/a/': 9, 'src/b/': 8, 'src/c/': 8, 'src/d/': 7,
    'src/e/': 7, 'src/f/': 7, 'src/g/': 7, 'src/h/': 7,
  })
  check(big.modules.length === 8, `8 个业务目录 → 8 个模块（实际 ${big.modules.length}）`)
  check(
    big.modules.every((m) => m.files.length >= 3 && m.files.length <= 30),
    '每个模块的文件数都落在 3~30 的建议区间内',
  )
  check(big.leftovers.length === 0, '没有文件被漏掉（落空 = 静默无文档）')
}

// ── 场景八：doctor 能发现问题，也能确认没问题 ────────────────
try {
  console.log('\n▸ doctor')
  const good = await runDoctor({ target: WORK, log: silent })
  check(good.fails === 0, `装好的项目上 doctor 无阻塞项（fails=${good.fails}）`)
  // 模型接口没配只算 warn 不算 fail（audit 巡检不需要模型），但必须**被说出来** ——
  // 不预填之后，这是使用者最可能踩的第一脚。
  const modelConfigured = !!(process.env.LLM_BASE_URL && process.env.LLM_MODEL)
  const modelCheck = good.results.find((r) => /模型接口/.test(r.name))
  check(!!modelCheck, 'doctor 报告了模型接口的状态（配了/没配）')
  check(modelCheck?.level === (modelConfigured ? 'ok' : 'warn'), `模型接口那一项的级别符合当前配置（${modelCheck?.level}）`)
  if (!modelConfigured) {
    check(/baseUrl/.test(modelCheck?.hint || ''), '没配时给出的是可行动的提示（去哪儿填、填什么）')
  }

  // 把 order 目录改名 → 这就是最危险的「配置腐烂」：静默停更、不报错
  fs.renameSync(path.join(WORK, 'src/modules/order'), path.join(WORK, 'src/modules/orders'))
  const bad = await runDoctor({ target: WORK, log: silent })
  check(bad.fails > 0, '目录改名后 doctor 报出问题（配置腐烂必须能被主动发现）')
  check(bad.results.some((r) => r.level === 'fail' && /前缀/.test(r.name)), 'doctor 明确指出是模块前缀指向了不存在的目录')
  fs.renameSync(path.join(WORK, 'src/modules/orders'), path.join(WORK, 'src/modules/order'))
} catch (e) {
  check(false, `doctor 场景：${e.message}`)
}

// ── 场景八：装完的仓库真的能跑 ───────────────────────────────
try {
  console.log('\n▸ 端到端：在装好的项目里跑 --mode audit')
  const git = (args) => execFileSync('git', args, { cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@local'])
  git(['config', 'user.name', 'test'])
  git(['config', 'core.autocrlf', 'false'])
  git(['add', '-A'])
  git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])

  const out = execFileSync(process.execPath, ['scripts/docs-update.mjs', '--mode', 'audit'], {
    cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  check(/INDEX\.md/.test(out), 'audit 跑通并写出了 INDEX.md')
  check(fs.existsSync(path.join(WORK, 'docs/current/INDEX.md')), 'INDEX.md 真的落到磁盘上')
  check(!fs.existsSync(path.join(WORK, 'docs/current/status.json')), '没有产生独立的 status.json（状态只写在文档头部）')
} catch (e) {
  check(false, `audit 端到端：${String(e.stdout || '') + String(e.stderr || '') || e.message}`)
}

// ── 场景九：没配模型时必须「开工前失败」，不能偷偷发给某个默认地址 ──
// 这条守的是一次可能造成实际损失的事故：如果模板预填了某家厂商的地址，
// 一个没读文档的人跑起来会直接成功 —— 然后在毫不知情的情况下把整个仓库的
// 源码发到一个公共站点去。相比之下，报错要好得多。
try {
  console.log('\n▸ 没配模型时的行为')
  const env = { ...process.env }
  delete env.LLM_BASE_URL
  delete env.LLM_MODEL
  delete env.LLM_API_KEY

  const modulesDir = path.join(WORK, 'docs/current/modules')
  const before = fs.existsSync(modulesDir) ? fs.readdirSync(modulesDir).length : 0

  let boom = null
  try {
    execFileSync(process.execPath, ['scripts/docs-update.mjs', '--mode', 'incremental', '--base=HEAD~1'], {
      cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
    })
  } catch (e) {
    boom = String(e.stdout || '') + String(e.stderr || '')
  }

  check(boom !== null, '没配模型就生成 → 非零退出（而不是静默发到某个默认地址）')
  check(/还没配置模型接口/.test(boom || ''), '报错直说「还没配置模型接口」')
  check(/\.knowledge\.mjs/.test(boom || '') && /LLM_BASE_URL/.test(boom || ''), '报错给出两种配法（改配置文件 / 设环境变量）')
  check(/audit/.test(boom || ''), '报错里指出了「只想零成本体检就跑 audit」这条路')
  const after = fs.existsSync(modulesDir) ? fs.readdirSync(modulesDir).length : 0
  check(after === before, '失败时一个文档文件都没写（在开工之前就停了）')

  // 另一半同样重要：零成本的巡检不能被模型配置拖累，否则「随时可跑」就是空话
  const auditOut = execFileSync(process.execPath, ['scripts/docs-update.mjs', '--mode', 'audit'], {
    cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
  })
  check(/INDEX\.md/.test(auditOut), 'audit 在没配模型、也没有密钥的情况下照常跑通')
} catch (e) {
  check(false, `没配模型的场景：${String(e.stdout || '') + String(e.stderr || '') || e.message}`)
}

// ── 场景十：配了模型时真的能跑通，并且把「谁生成的」记下来 ────────────
// 这条补的是前面所有场景都没覆盖的那一段：**真的调一次模型、真的写出一份文档**。
// 守两件事，都是「看起来能跑、其实结果不对」的类型：
//
//   1. 功能清单的解析。模型见过我们自己写进索引的「 :: 」，照抄很常见；
//      只认冒号会把它切成「: 创建订单」—— 索引里就会出现一批带多余冒号的
//      功能点，而「按功能提问」正是靠这张表检索的。
//   2. 生成溯源。文档头部必须记下 model / prompt_version：换模型之后新旧文档
//      混在一起，没有这两个字段就查不出「这批是哪个模型写的」。
try {
  console.log('\n▸ 配了模型：端到端跑一次增量生成')
  const git = (args) => execFileSync('git', args, { cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  // 代码量必须抬过 guard.minCodePerModule（低于门槛的模块会被直接跳过，压根不调模型）
  const orderDir = path.join(WORK, 'src/modules/order')
  for (let i = 1; i <= 7; i++) {
    fs.writeFileSync(path.join(orderDir, `file${i}.js`), [
      `export function step${i}(order) {`,
      '  // 占位逻辑：仅用于把模块代码量抬过「跳过门槛」',
      '  const total = order.items.reduce((s, it) => s + it.price * it.qty, 0)',
      "  return { total, currency: 'CNY', step: " + i + ' }',
      '}',
      '',
    ].join('\n'))
  }
  git(['add', '-A'])
  git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'feat: order module'])

  // 假模型。它同时充当记账本 —— 记下自己收到了什么，供下面断言。
  const seen = []
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const payload = raw ? JSON.parse(raw) : {}
      seen.push({ model: payload.model, auth: req.headers.authorization || '' })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: [
              '## 模块职责',
              '',
              '这个模块负责把订单条目换算成应付金额，并返回订单的初始状态。',
              '金额一律以分为单位在模块间传递，避免浮点误差在结算链路上累积。',
              '',
              '## 核心流程',
              '',
              '1. 收集订单条目，逐条校验数量与单价为正数。',
              '2. 累加得到总额，连同币种一并返回。',
              '3. 把订单推进到待支付状态，交给支付模块继续处理。',
              '',
              '## 关键设计',
              '',
              '金额用整数分表示，币种随金额一起传递 —— 两者拆开很容易在跨模块时错配。',
              '条目校验失败时不做部分计算，直接整单拒绝，避免出现半截金额。',
              '',
              '<!-- FEATURES',
              '下单 :: 创建订单并返回订单号',
              '退款：按原支付渠道退回',
              '-->',
            ].join('\n'),
          },
        }],
      }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${srv.address().port}/v1`
  const KEY = 'sk-test-not-a-real-key'

  let out = ''
  let boom = null
  let timedOut = false
  try {
    const r = await pexec(process.execPath, ['scripts/docs-update.mjs', '--mode', 'incremental', '--base=HEAD~1'], {
      cwd: WORK,
      env: { ...process.env, LLM_BASE_URL: baseUrl, LLM_MODEL: 'fake-doc-model', LLM_API_KEY: KEY },
      // 限时是必需的：这一段有真实网络往返，子进程一旦卡住，整个套件会无限期挂住 ——
      // 现象是日志停在场景标题、没有任何报错，最难查。限时之后最坏也只是这一条失败，
      // 而且失败原因可读，不会拖死全量回归。
      timeout: 90_000,
      killSignal: 'SIGKILL',
    })
    out = r.stdout
  } catch (e) {
    timedOut = e.killed === true || /timeout/i.test(String(e.message || ''))
    boom = String(e.stdout || '') + String(e.stderr || '') || String(e.message || '')
  } finally {
    // 必须清掉残留连接再 close：子进程被强杀时它的 socket 可能还开着，
    // 只调 close() 会让本进程等下去（于是一条测试失败变成整个套件不结束）。
    srv.closeAllConnections?.()
    srv.close()
  }

  // 失败时把子进程输出整段打出来 —— 这类失败的原因（模块被跳过 / 校验没过 /
  // 提示词找不到）全在那几行日志里，压成一句摘要等于让人重新猜一遍。
  if (boom) console.log(boom.split('\n').map((l) => '      │ ' + l).join('\n'))
  check(boom === null, timedOut
    ? '增量生成在 90 秒内没有结束（子进程卡住，见上方输出）'
    : `增量生成跑通（${boom ? '见上方输出' : out.trim().split('\n').slice(-1)[0]}）`)

  const docPath = path.join(WORK, 'docs/current/modules/order.md')
  check(fs.existsSync(docPath), '生成了 order 模块的文档')
  const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : ''

  check(/^doc_status: candidate$/m.test(doc), '新文档是候选状态（模型写的默认没人担保）')
  check(/^model: fake-doc-model$/m.test(doc), '头部记下了生成用的模型名')
  check(/^prompt_version: [0-9a-f]{16}$/m.test(doc), '头部记下了提示词版本（模板内容指纹）')
  check(!/127\.0\.0\.1|baseUrl/.test(doc), '不把接口地址写进文档（那可能是内网地址）')
  check(!doc.includes(KEY), '密钥不落盘（只走请求头）')

  check(doc.includes('  - 下单 :: 创建订单并返回订单号\n'), '模型照抄 :: 时，说明没有被切成「: 创建订单」')
  check(doc.includes('  - 退款 :: 按原支付渠道退回\n'), '全角冒号那条也解析正确')
  check(!/::\s*:/.test(doc), '没有「:: :」这种套娃残留')
  check(!doc.includes('FEATURES'), 'FEATURES 标记已从正文中移除')

  const idx = fs.readFileSync(path.join(WORK, 'docs/current/INDEX.md'), 'utf8')
  check(idx.includes('| 下单 | 创建订单并返回订单号 | order |'), '功能索引里排出了正确的一行')
  check(idx.includes('| 退款 | 按原支付渠道退回 | order |'), '全角冒号那条也进了索引')

  check(seen.length > 0, '模型真的被调用了')
  check(seen[0]?.model === 'fake-doc-model', '请求里带的是配置的模型名')
  check(/^Bearer sk-/.test(seen[0]?.auth || ''), '密钥通过请求头送出')
} catch (e) {
  check(false, `配了模型的场景：${String(e.stdout || '') + String(e.stderr || '') || e.message}`)
}

console.log('')
if (fails.length) {
  console.log(`✘ init 冒烟测试失败：${fails.length} 项`)
  for (const f of fails) console.log(`   · ${f}`)
  process.exit(1)
}
console.log('✔ init 冒烟测试全部通过')
