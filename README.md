# docwarden（项目文档守护）

**给团队一份敢信的模块文档。** 跑在你的 GitHub Actions / GitLab CI 上自动生成，
源码一变就标回「已失效」，没人确认过的绝不冒充结论。

要求开发者记得同步文档，在任何五人以上的团队里都会失败，这不是态度问题，是必然结果。
新人照着过时的文档操作翻了车，于是不再信任文档，最后连新写的也不看。
这个工具不靠人记得，靠流水线。

零依赖（CI 里不需要 `npm install`）· Node 18+ · MIT · 可作 GitHub Action 直接 `uses:` 引用

> 第一次用先看 [USAGE.md](./USAGE.md)（使用说明）：从装到接 CI 的逐步操作，
> 包含「模型接口怎么配」这一步。本文件讲的是为什么这么设计、两条接入方式怎么选。

---

## 一、接到 CI 上：两条路，挑一条

### A. 引用模式（GitHub 推荐）：脚本不进你的仓库

```bash
npx docwarden init --no-vendor
```

它只往你仓库里放四样必需的东西：`.knowledge.mjs`（配置）、`.github/workflows/docs.yml`、
`.gitignore` 那一行、`docs/` 目录骨架。不塞任何脚本。

生成的 workflow 里仓库地址已经填好了，装完就能跑，长这样：

```yaml
- uses: xiaoanbucai/docwarden@v1
  with:
    mode: incremental
  env:
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
    LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
```

好处是工具升级只改一个版本号，不用动你的仓库；你的仓库里也不多出一堆要维护的脚本。

### B. vendor 模式：脚本拷进你的仓库

```bash
npx docwarden init                     # GitHub
npx docwarden init --platform=gitlab   # GitLab
```

脚本落在 `<你的仓库>/scripts/` 下，CI 里就是 `node scripts/docs-update.mjs`。
CI 不需要联网取工具，公司内网也能跑；提示词就在你眼皮底下，随手可改。

### 怎么选

| | 引用模式（A） | vendor 模式（B） |
|---|---|---|
| 适用平台 | 仅 GitHub | GitHub、GitLab 都可以 |
| 仓库里多出什么 | 只有配置和 workflow | 配置 + `scripts/`（4 个文件）|
| 升级工具 | 改 `@v1` 版本号 | 重新 `init --force` |
| CI 要不要联网 | 要（GitHub 去取 Action） | 不要，内网也能跑 |
| 改提示词 | 把 `scripts/prompts/` 拷进你的仓库即可覆盖 | 直接改 |

> GitLab 只有 B：GitLab CI 没有 `uses:` 这种原生引用机制，引用模式得让 job 先 clone
> 工具仓库，那就变成了联网取工具，还不如直接放进仓库。所以 `--no-vendor` 只对 GitHub 开放，
> 配 GitLab 会被明确拒绝，而不是悄悄做错。

### 装完只做三件事

```bash
# ① 复核模块划分：唯一需要你下判断的地方（推断只看目录，看不懂业务边界）
$EDITOR .knowledge.mjs

# ② 不接模型先跑一次巡检，零成本，随时可以跑
npx docwarden update --mode audit

# ③ 配好模型接口，生成一次，用肉眼验收质量
export LLM_BASE_URL="https://你的服务/v1"
export LLM_API_KEY="sk-xxx"
npx docwarden update --mode incremental --base=HEAD~5 --dry-run
```

> `npx docwarden update` 在两种模式下都能用：你仓库里有脚本就用你的那份，
> 没有（引用模式）就用工具自带的，自动把目标指到你当前目录。

第 ③ 步不能跳过。看生成的文档读起来像不像人话，有没有编造代码里不存在的功能，
描述的是「职责和流程」还是「复述代码」。质量不行，后面全都不用做。
不满意就改提示词模板，不要手改 `docs/current/`，下次生成会覆盖掉。

然后把改动提交，手动触发一次流水线（GitHub 的 `workflow_dispatch` / GitLab 的
Run pipeline），确认链路真的通了，再交给事件自动触发。

随时体检：`npx docwarden doctor`，缺什么、哪里烂了、怎么补。

---

## 二、四个触发契机

接好之后，它自己按这四件事运转：

```
你提 PR        → CI 生成「文档影响预览」，贴在 PR 里（不写入任何文件）
你合并主干     → CI 重生成受影响模块的文档，开一个 PR
你打 Release   → CI 生成版本演进章节，写入 history/
每天凌晨       → CI 巡检，找出文档与代码脱节的模块并修复
```

冷启动时用手动触发（GitHub 的 `workflow_dispatch` / GitLab 的 Run pipeline），
逐条确认没问题，再交给事件。

它不做的事：

- 不记录每个 commit 的流水账（git 已经做得更好）
- 不追踪未合并分支的进度（那属于项目管理工具的职责）
- 不改你手写的 `docs/decisions/`（AI 永不触碰）
- 不判断代码风格（那是 ESLint 的活）

---

## 三、它解决的是「文档腐烂」，不是「没文档」

大部分团队不缺文档，缺的是知道哪份文档还能信。

文档腐烂的终点不是「写得不好」，而是团队不再看文档。新人照着过时的文档操作、翻了车，
于是不再信任文档，最后连新写的也不看。问题不在它错了，而在它错得毫无征兆。
人一忙，第一个被跳过的就是没人催的那一步。

> 跟「给 AI 补上下文」的工具不是一回事。那一类解决的是「让 AI 此刻更懂这个仓库」，
> 用完即弃，不留下产物。这份工具要的是让团队拥有一份可追溯、可评审的知识资产：
> 有产物，才有演进史、有 review 入口、有交接价值。
>
> 两者并不冲突。这份资产可以反过来通过 MCP 喂给 AI 助手（见第五节），
> 只是它比一份临时上下文多带了「谁确认过、什么时候确认的」。

这份工具给出的答案是二元的：每份文档要么被人确认过、且确认之后源码一字未动，
要么就明确标着「已失效」或「候选」。没有中间地带，也不给「大概还行」留位置。

| 状态 | 含义 | 由谁造成 |
|---|---|---|
| 候选 | 模型刚生成，没有任何人确认过 | 生成时自动写入 |
| 已验证 | 有人确认过，且确认之后源码与正文都没再变 | 只有人能把它改成这个 |
| 已失效 | 文档生成之后源码变了 | 判定时自动得出 |

两条规则，压过一切：

1. 源码变了，一律「已失效」。文档在描述旧代码，比没有文档更危险。
2. 正文被重新生成过，确认作废。确认绑定的是那一版内容，不是模块名。

指纹与「谁确认过」都写在文档自己的头部（front-matter），不设独立的 status.json。
任何模块更新都要改动同一个文件，多分支合并必然冲突，而冲突内容是一串机器哈希，
人没法判断该保留哪一边。

> 「已验证」这件事，机器替不了。工具能保证内容新鲜，保证不了内容正确。
> 后者必须有人做，也只能有人做。

---

## 四、模型接口要你自己配，这个工具不代为提供

工具里不含任何 API Key，也不绑定任何厂商。它只要求服务端提供
OpenAI 兼容的 `/chat/completions`，所以换模型不用改代码，只改一个环境变量。

配置文件里的 `llm` 段是故意留空的。把源码发给谁是个决定，不是技术细节。
所以工具不预填任何厂商地址：没配就在开始干活之前直接失败，并告诉你两种配法，
不会先跑起来、把代码悄悄发到一个默认地址去。逐步操作见 [USAGE.md](./USAGE.md)。

| 用途 | baseUrl | 示例模型 |
|---|---|---|
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen3:8b` |
| 本地 vLLM | `http://127.0.0.1:8000/v1` | `Qwen/Qwen3-8B` |
| 智谱 GLM（国内直连） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.7-flash` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-r1:free` |

在 CI 里配成 Secret（GitHub：`Settings → Secrets and variables → Actions`；
GitLab：`Settings → CI/CD → Variables`，勾 Masked），不要写进代码。

模型怎么选：上下文窗口大 > 指令遵循强 > 价格 > 推理能力，和「聊天」的要求不一样。
不必上最贵的（贵模型的优势在推理，这里用不上），也不要用参数太小的：
问题不在「写得不够好」，而是长上下文和禁令遵循会直接失守，输出会退化成源码副本。

两条红线：

1. 云端接口会把源码发出去。填 `https://` 公网地址就意味着源码会完整送到那家厂商。
   公司项目的代码不要这么干，除非确认过安全规定允许。用内网部署的模型没这个问题。
2. GitHub 必须先开写权限：`Settings → Actions → General → Workflow permissions`
   选 **Read and write**。不开的话机器人跑得再对也开不出 PR，而且不会有明显报错。

成本量级、密钥细节、权限清单见 [`docs-kit/SETUP.md`](./docs-kit/SETUP.md)。

---

## 五、让 AI 编程助手也能查到这份知识库

```bash
npx docwarden mcp --root /path/to/your-project
```

MCP 服务把知识库连同每篇的确认状态一起交给 AI。这样它不会把没人确认过的
模型输出当成团队共识。状态跟着内容走，是这套机制能成立的前提。

配置示例与五个工具的说明见 [`MCP.md`](./MCP.md)。

---

## 六、目录结构

```
action.yml                     GitHub Action 入口（引用模式靠这个）
bin/cli.mjs                    npx docwarden 入口
src/detect.mjs                 探测项目结构、推断模块划分
src/install.mjs                把 payload 装进目标仓库；含 doctor 体检
USAGE.md                       ★ 使用说明（使用者先读这份）
docs-kit/                      ★ 装进使用者仓库的那份负载
  ├── scripts/docs-update.mjs  CI 主脚本（四个模式，支持 --root）
  ├── scripts/lib/freshness.mjs 指纹与状态的唯一实现
  ├── scripts/prompts/         提示词模板，质量不满意先改这里
  ├── ci/github-actions.yml    vendor 模式的 workflow
  ├── ci/github-action-only.yml 引用模式的 workflow
  ├── ci/gitlab-ci.yml         GitLab 的 workflow
  └── templates/               PR 模板（强制填决策三问）
docwarden.mjs                本地界面（可选，见文末）
docwarden-mcp.mjs            MCP 服务
tests/                         回归测试，见 tests/README.md
sample/                        可直接试跑的样例项目
```

主脚本、`freshness.mjs`、`docwarden.mjs`、`docwarden-mcp.mjs` 都不依赖任何 npm 包；
`tests/` 里的 jsdom 只在跑测试时用得上。

---

## 七、日常会遇到的问题

按危害排序。前四条不会报错，所以最危险：它们会安静地让你的文档停止更新。

| 问题 | 症状 | 怎么防 |
|---|---|---|
| **配置腐烂** | 目录重构后路径失效，文档静默停更，流水线全绿 | `npx docwarden doctor` 会报「前缀指向不存在的目录」 |
| **新目录漏配** | 新建的功能目录不在配置里，永远没有文档 | `--mode audit` 统计「未覆盖的源码文件」 |
| **幽灵文档** | 模块删了，文档还在描述它 | 巡检列出「已不在配置中的文档」 |
| **无人使用** | 生成了但没人看，慢慢腐烂 | 前两个月观察，没人用就说明产出形式不对 |
| 文档 PR 堆积 | 没人合并，攒了几十个 | 文档 PR 极简，看两眼就能过；或设自动合并 |
| 巨型变更 | 重构或冷启动时一次生成全部模块 | 分批引入，一次一个模块；`maxChangedFiles` 兜底 |
| 大模块生成不完整 | 代码超过两三千行，输出被截断，模型开始自行摘要 | 把模块拆到 1500 行以内；「模块」按行数定义，不按目录 |
| 永远没人补充「为什么」 | 文档只答「是什么」，新人依然卡在设计取舍上 | PR 模板强制三问。这部分 AI 写不出来 |
| 换模型后质量断层 | 新旧模型写的文档混在一起，无法区分 | 元数据记录 `model` / `prompt_version` |

判断标准很简单：如果一个故障不报错，它就必须靠主动巡检发现。

---

## 八、开发

```bash
git clone https://github.com/xiaoanbucai/docwarden.git
cd docwarden
npm install                      # 只装 jsdom，跑测试用

npm run check:deps               # 守住「主程序零依赖」这条承诺
npm run test:freshness           # 指纹与状态只有一份实现，且认得旧算法
npm run test:ci                  # 在真实临时 git 仓库里跑一遍 CI 脚本（不调模型）
npm run test:init                # 安装器：装一遍、验一遍、再装一遍
npm run test:selfcheck           # 界面内联脚本的语法与接线

npm run test:all                 # ★ 全量（11 套）：自动起本地界面 → 跑 → 收服务
```

> **`npm run test:all` 是推荐的跑法。** 有 5 个套件要连 `127.0.0.1:5173` 的真实服务，
> 手工跑得先起服务、跑完再自己收掉。忘了收的话，那个进程会一直跑着启动时载入的旧代码，
> 之后任何文件重命名都会让测试莫名其妙全红。这个脚本把收服务放在 `finally` 里，不会漏。
>
> 想手控也行：`node docwarden.mjs --no-open` 起服务，另开一个终端 `npm test`。

详见 [`tests/README.md`](./tests/README.md) 与 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。
从自己的 fork 发布、要换仓库地址的话，做法也在 CONTRIBUTING 里。

---

## 九、许可

[MIT](./LICENSE)。

---

## 附：本地界面（可选）

跟 CI 上是同一套逻辑（同一个 `freshness.mjs`），用来在接 CI 之前先看效果：

```bash
npx docwarden serve            # 扫描 → 划分模块 → 逐篇生成 → 逐篇人工确认
```

不想配模型也能跑：选「演示模式」零配置秒出结果，用来确认流程和排版。
拿不准就拿自带的 `sample/`（一个虚构的小订单项目）试跑。

它只是个辅助入口，真正的运行位置是 CI。界面里做的「标记为已验证」与 CI 判定的是
同一件事，两边认得的指纹是同一份实现。
