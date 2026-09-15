// CI 主线的冒烟测试：在一个真实 git 仓库里跑 `--mode audit`。
//
// 为什么必须用真实 git 仓库：audit 的入口先要 `git rev-parse HEAD`，
// 没有仓库直接失败。而它真正要验的是那句最要紧的话 ——
// **统一指纹之后，已有的旧文档不会被误判成「源码变了」**。
// 这条只有跑起来才验得了：`node --check` 查得出语法，查不出「未定义变量」这类运行时错误。
//
// audit 不调用模型（只体检 + 比指纹），所以这个测试不花任何额度，随时可以跑。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const F = await import(pathToFileURL(path.join(ROOT, 'docs-kit', 'scripts', 'lib', 'freshness.mjs')).href)

const WORK = path.join(os.tmpdir(), 'docs-kit-ci-smoke')
const BODY = '## 模块职责\n\n订单模块，负责下单与状态流转。\n'
const FILES = ['src/order/repo.js', 'src/order/service.js', 'src/order/state.js']

const fails = []
const check = (ok, msg) => { console.log(`  ${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg) }

const git = (args) => execFileSync('git', args, {
  cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})
/** 跑一次 audit。它不调模型，所以不需要任何密钥。 */
function runAudit() {
  try {
    const out = execFileSync(process.execPath, ['scripts/docs-update.mjs', '--mode', 'audit'], {
      cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { out, code: 0 }
  } catch (e) {
    return { out: String(e.stdout || '') + String(e.stderr || ''), code: e.status }
  }
}

try {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  // 按 SETUP.md 说的摆放：scripts/ 在仓库根，配置在根，源码在 src/
  fs.cpSync(path.join(ROOT, 'docs-kit', 'scripts'), path.join(WORK, 'scripts'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'sample', 'src'), path.join(WORK, 'src'), { recursive: true })

  fs.writeFileSync(path.join(WORK, '.knowledge.mjs'), `export default {
  project: 'smoke',
  modules: [
    { name: 'order', title: '订单', prefixes: ['src/order/'] },
    { name: 'payment', title: '支付', prefixes: ['src/payment/'] },
    { name: 'user', title: '用户', prefixes: ['src/user/'] },
    { name: 'notify', title: '通知', prefixes: ['src/notify/'] },
  ],
  sourceRoots: ['src/'],
  ignorePaths: ['node_modules/', 'docs/'],
  guard: { maxChangedFiles: 60, maxCodePerModule: 120000, minCodePerModule: 400,
           maxOutputRatio: 3, ratioCheckFloor: 2000, minOutputChars: 200, staleDays: 30 },
  llm: { baseUrl: 'http://127.0.0.1:1/v1', model: 'none', temperature: 0.2,
         maxTokens: 4096, timeoutMs: 1000 },
  output: { currentDir: 'docs/current', historyDir: 'docs/history', decisionsDir: 'docs/decisions', index: true },
}
`, 'utf8')

  git(['init', '-q'])
  git(['config', 'user.email', 'test@local'])
  git(['config', 'user.name', 'test'])
  git(['config', 'core.autocrlf', 'false'])
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])

  console.log('=== 1. 脚本能在真实仓库里跑起来（只体检，不调模型）===')
  const first = runAudit()
  check(first.code === 0, 'audit 退出码 0（没有运行时崩掉）')
  check(/配置体检通过/.test(first.out), '配置体检通过（模块路径都有效、没有未覆盖文件）')
  check(/从未生成过文档/.test(first.out), '正确报出「order 从未生成过文档」')

  console.log('\n=== 2. 造一份「统一之前」的文档：不该被判成漂移 ===')
  const docFile = path.join(WORK, 'docs', 'current', 'modules', 'order.md')
  fs.mkdirSync(path.dirname(docFile), { recursive: true })
  const legacyFp = F.legacyFingerprints(WORK, FILES)[0] // 早期工作台的 sha1 + 长度前缀
  const legacyBody = crypto.createHash('sha1').update(BODY).digest('hex').slice(0, 16)
  fs.writeFileSync(docFile, F.buildFrontmatter({
    generatedBy: 'legacy',
    generatedAt: '2026-09-01T00:00:00.000Z',
    module: 'order',
    sourceFingerprint: legacyFp,
    bodyFingerprint: legacyBody,
    docStatus: 'validated',
    validatedBy: '老王',
    validatedAt: '2026-09-02T00:00:00.000Z',
    validatedBodyFingerprint: legacyBody,
    sourceFiles: FILES,
  }) + BODY, 'utf8')

  const second = runAudit()
  check(/全部 4 个模块的文档均与代码一致/.test(second.out) === false, '这次不该说「全部一致」（order 是新造的）')
  check(!/order —— 代码已变更但文档未更新/.test(second.out), '**旧指纹没被误判成「代码已变更」**')
  check(/order 指纹换代，已就地升级头部/.test(second.out), '报了「指纹换代，就地升级」（不占模型额度）')

  const upgraded = F.readDocMeta(docFile)
  check(upgraded.sourceFingerprint === F.fingerprintFiles(WORK, FILES), '头部里的指纹已换成新算法')
  check(upgraded.validatedBy === '老王', '人工确认（老王）原样保留')
  check(upgraded.docStatus === 'validated', '状态仍是「已验证」')
  check(upgraded.body.includes('订单模块，负责下单'), '正文一字未动')

  console.log('\n=== 3. 再跑一次：不该反复报升级 ===')
  const third = runAudit()
  check(!/order 指纹换代/.test(third.out), '已经升过级 → 不再重复升级')

  console.log('\n=== 4. 源码真改了，才该报漂移 ===')
  const svc = path.join(WORK, 'src', 'order', 'service.js')
  fs.writeFileSync(svc, fs.readFileSync(svc, 'utf8') + '\n// 加一行\n', 'utf8')
  const fourth = runAudit()
  check(/order —— 代码已变更但文档未更新/.test(fourth.out), '源码变动 → 正确报出漂移')

  console.log('\n=== 5. 索引被生成，且带「人工确认」列 ===')
  const idx = fs.readFileSync(path.join(WORK, 'docs', 'current', 'INDEX.md'), 'utf8')
  check(/\|\s*人工确认\s*\|/.test(idx), '索引含「人工确认」列')
  check(/已验证（老王/.test(idx), '索引里能看出是老王确认的')

  // 引用模式（GitHub Actions 里 uses: 直接调工具）靠的就是这个：
  // 脚本跑在工具自己的目录里，你的仓库在别处，必须用 --root 指过去。
  // 这一条要是坏了，引用模式会把文档写到工具仓库里去 —— 而现场通常没人会发现。
  console.log('\n=== 6. 引用模式：脚本在工具目录，--root 指向目标仓库 ===')
  const toolScript = path.join(ROOT, 'docs-kit', 'scripts', 'docs-update.mjs')
  const strayIdx = path.join(ROOT, 'docs', 'current', 'INDEX.md')
  const strayBefore = fs.existsSync(strayIdx)
  let refOut = ''
  try {
    refOut = execFileSync(process.execPath, [toolScript, '--root', WORK, '--mode', 'audit'], {
      cwd: os.tmpdir(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    refOut = String(e.stdout || '') + String(e.stderr || '')
  }
  check(/INDEX\.md/.test(refOut), '--root 模式下脚本跑得完（cwd 不是目标仓库）')
  check(/order —— 代码已变更但文档未更新/.test(refOut), '--root 指向的那个仓库被正确巡检')
  check(fs.existsSync(strayIdx) === strayBefore, '工具自己的目录没被当成目标仓库（没往那儿写 INDEX.md）')
} catch (e) {
  fails.push('异常：' + e.message)
  console.log('  [异常] ' + (e.stack || e.message))
} finally {
  fs.rmSync(WORK, { recursive: true, force: true })
}

// ── 7. 随包发出去的 CI 模板不许硬编码厂商 ──────────────────────
// 这几个模板会被 init 直接复制进使用者的仓库，所以它们和配置模板受同一条约束：
// **不替使用者决定源码发给谁**。曾经这里写着 `LLM_MODEL: gpt-4o-mini`（GitHub 三处、
// GitLab 一处），配上一个空的 LLM_BASE_URL 就是「模型名写着某家的、地址却是空的」，
// 使用者拿到的是一句莫名其妙的模型不存在报错，而不是「你还没配模型接口」。
console.log('\n=== 7. CI 模板不预填厂商 ===')
{
  const SKIP_LINE_COMMENT = (src) =>
    src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

  const templates = ['github-actions.yml', 'github-action-only.yml', 'gitlab-ci.yml']
  for (const name of templates) {
    const raw = fs.readFileSync(path.join(ROOT, 'docs-kit', 'ci', name), 'utf8')
    const code = SKIP_LINE_COMMENT(raw)
    const bad = code.split('\n').filter((l) => /LLM_(MODEL|BASE_URL)\s*:/.test(l))
    check(bad.length === 0, `${name}：可执行行里没有写死 baseUrl / model`)
    check(!/gpt-4o|api\.openai\.com/.test(code), `${name}：可执行行里没有出现某家厂商的地址或模型名`)
    // 密钥必须来自 secret / 变量，不能是字面量。
    // 两个平台的机制不同，不能一刀切：GitHub 要显式 env 传进去，
    // GitLab 的 CI/CD 变量是**自动注入**到 job 环境里的，所以模板里本来就不该有这一行 ——
    // 那边要验的是「头部说明了必须建哪些加密变量」。
    const keyLines = code.split('\n').filter((l) => /LLM_API_KEY\s*:/.test(l))
    if (name === 'gitlab-ci.yml') {
      check(
        keyLines.length === 0,
        'gitlab-ci.yml：gitlab 会自动注入 CI/CD 变量，不该在 job 里重复声明（重复声明反而会覆盖成空值）',
      )
      check(/加密变量 LLM_API_KEY/.test(raw), 'gitlab-ci.yml：头部说明了必须建 LLM_API_KEY 这个加密变量')
    } else {
      check(
        keyLines.every((l) => /secrets\.|vars\./.test(l)),
        `${name}：LLM_API_KEY 来自 secret，不是写死的字面量`,
      )
      check(keyLines.length > 0, `${name}：仍然把密钥传给了脚本（别修过头，把该有的也注释掉了）`)
    }
  }
}

console.log('\n' + (fails.length ? '✘ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ') : '✔ 全部断言通过'))
process.exit(fails.length ? 1 : 0)
