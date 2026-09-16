# 使用说明

从零到跑通，按这份走一遍就行。全程大约二十分钟，其中十分钟在第二步。

> 先说清它产出的是什么：给同事看的知识资产，不是给 AI 补上下文的临时物料。
> 提示词第一句就是「你的读者是两周后接手这个模块的同事」，所以文档必须可追溯、
> 可评审、能交接。这就是每篇文档都带着「谁确认过」的原因，
> 也是它跟「让 AI 此刻更懂这个仓库」那一类工具的区别。

- 只想先看看能不能用 → 跳到 [第三步：零成本试一遍](#第三步零成本试一遍)，那条命令不花钱、不调模型。
- 想知道为什么会有这个工具、它不做什么 → 看 [README.md](./README.md)。
- 想深究模型选型、成本量级、密钥与权限细节 → 看 [docs-kit/SETUP.md](./docs-kit/SETUP.md)。

---

## 开工前需要三样东西

| 需要 | 说明 |
|---|---|
| **Node 18+** | `node -v` 看一眼。工具零依赖，不需要 `npm install` |
| **一个 git 仓库** | 它靠 git diff 判断哪些模块的代码变了，所以必须在 git 仓库里跑 |
| **一个模型接口** | 你自己提供。不预填、不绑定厂商，配法见[第二步](#第二步配置模型接口必须你自己配) |

> 模型接口是唯一需要花钱的地方，其余全免费。单个模块一次生成，量级是几分钱；
> 一个月两百次模块生成，量级几十元。详见 [SETUP.md 第七节](./docs-kit/SETUP.md)。

---

## 第一步：装进你的仓库

在**你自己的仓库根目录**执行，两条路挑一条：

> 下面的 `npx docwarden …` 从 npm 取这个工具；npm 那边还没发、或者你的机器不方便连
> registry 时，把 `docwarden` 换成 `github:xiaoanbucai/docwarden` 就行，其余照抄：
> `npx github:xiaoanbucai/docwarden init --no-vendor`。

```bash
# A. 引用模式（GitHub 推荐）：脚本不进你的仓库
npx docwarden init --no-vendor

# B. vendor 模式：脚本拷进你的仓库（GitLab 只能走这条）
npx docwarden init
npx docwarden init --platform=gitlab     # 或者两个平台都要：--platform=both
```

不确定选哪条，看这张表：

| | A. 引用模式 | B. vendor 模式 |
|---|---|---|
| 平台 | 仅 GitHub | GitHub + GitLab |
| 仓库里多出什么 | 只有 `.knowledge.mjs` 和一份 workflow | 再加上 `scripts/`（4 个文件） |
| 工具升级 | 改 `@v1` 版本号 | 重新 `init --force` |
| CI 要不要联网 | 要（Actions 去取工具） | **不要，内网也能跑** |
| 改提示词 | 把 `prompts/` 拷进仓库即可覆盖 | 直接改 |

装之前想先看看它会写哪些文件，加 `--dry-run`（一个字节都不落地）：

```bash
npx docwarden init --dry-run
```

装完可以随时体检：

```bash
npx docwarden doctor
```

`doctor` 只会报告，不会改你的东西。它最有用的能力是发现「配置腐烂」：目录重构之后
模块前缀指向了不存在的目录，文档从此静默停更、流水线全绿、没有任何报错。这是这个工具
最容易出现的故障，靠人眼看代码发现不了。

---

## 第二步：配置模型接口（必须你自己配）

**`.knowledge.mjs` 里的 `llm` 段是故意留空的。**

这个脚本干的事是把你仓库里的源码读出来发给模型。填哪个地址，就等于把源码交给谁。
这是个决定，只能由你的项目来做。所以工具不预填任何厂商，也不会偷偷用一个默认地址跑起来：
没配就报错，报错里告诉你怎么填，而不是先跑成功了、代码已经发出去了。

### 两种配法，任选一种

**① 改 `.knowledge.mjs`**（适合固定用某个模型）

```js
llm: {
  baseUrl: 'https://你的服务/v1',   // 注意以 /v1 这类路径结尾，脚本会自动接 /chat/completions
  model: '模型名',
  temperature: 0.2,
  maxTokens: 4096,
  timeoutMs: 120000,
},
```

**② 用环境变量**（CI 里就是这么配的，本地临时试也方便）

```bash
export LLM_BASE_URL="https://你的服务/v1"
export LLM_MODEL="模型名"
export LLM_API_KEY="sk-xxx"        # 密钥只能走这里，见下
```

注意配置模板里那两行本身就是从环境变量读的（`baseUrl: process.env.LLM_BASE_URL || ''`），
所以设了环境变量就等于配好了；如果你把地址直接写死在配置里，就以配置文件为准。
换模型不用改代码，改一个变量、或者改一行配置都行。

### 只要满足一个条件

服务端提供 **OpenAI 兼容的 `/chat/completions`** 就能用。常见填法：

| 用途 | baseUrl | model 示例 |
|---|---|---|
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen3:8b` |
| 本地 vLLM | `http://127.0.0.1:8000/v1` | `Qwen/Qwen3-8B` |
| 智谱 GLM（国内直连） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.7-flash` |
| 公司内网服务 | `https://你们的内网地址/v1` | 按服务端给的填 |

### ⚠️ 一条红线

**`baseUrl` 填 `https://` 公网地址，就意味着源码会完整送到那家厂商。**

公司项目请先确认安全规定；要用就用内网部署的模型（那是本机/内网地址，不出网），
脚本本身不用改。这条没有技术上的变通办法，源码要生成文档，就必须被模型读到。

### 密钥放哪

**只放环境变量，不要写进 `.knowledge.mjs`，更不要提交进仓库。**

```bash
# 本地临时跑
export LLM_API_KEY="sk-xxx"

# GitHub：Settings → Secrets and variables → Actions → New repository secret
# GitLab：Settings → CI/CD → Variables（勾上 Masked）
```

工具有一条专门的测试守着这件事：跑完整流程后把项目目录里每个文件翻一遍，确认 key
没落盘（`npm run test:leak`）。

### 密钥贴进对话/issue 之后

密钥一旦出现在聊天记录、issue、日志里，就等同于公开。到控制台吊销并重新生成一个，
不要只是删掉那条消息。

### 模型怎么选

和「聊天」的要求不一样，按这个优先级：**上下文窗口大 > 指令遵循强 > 价格 > 推理能力**。

不必上最贵的（贵模型的优势在推理，这里用不上），但也不要用参数太小的：
问题不在「写得不够好」，而是长上下文和禁令遵循会直接失守，输出会退化成源码副本。
详细的对比与成本测算见 [SETUP.md](./docs-kit/SETUP.md)。

---

## 第三步：零成本试一遍

先别急着花钱。这条命令不调模型、不需要配密钥，只是扫一遍代码和文档，告诉你哪些模块
的文档已经和代码脱节了：

```bash
npx docwarden update --mode audit
```

跑得通，说明安装是好的、git 也是好的。你随时可以再跑它，不花一分钱。

然后复核模块划分，这是整个工具里唯一需要你下判断的地方。

```bash
$EDITOR .knowledge.mjs
```

`init` 会依据你的目录结构推断一份初稿，但推断只看得见目录，看不见业务边界。
它可能把两个本该合并的目录拆成了两个，也可能把不相关的东西归到一块。

> 判断标准：一个模块 **5~30 个文件**最合适。太细 → 文档碎片化；太粗 → 每次小改动都
> 重生成一大堆，白花钱。另外注意，模块是按**行数**算成本的，某个目录文件不多但单文件
> 特别大时，也该拆开。

---

## 第四步：生成一次，用肉眼验收质量

配好模型之后：

```bash
# 只看结果，不写任何文件
npx docwarden update --mode incremental --base=HEAD~5 --dry-run

# 满意了再去掉 --dry-run，真正写入
npx docwarden update --mode incremental --base=HEAD~5
```

看生成的文档，只关注一件事：有没有编造代码里不存在的功能。这是最需要警惕的错误类型，
措辞、篇幅、结构都容易调。另外看它描述的是「职责和流程」，还是在复述代码。

质量不行，后面全都不用做。不满意就改提示词模板，不要手改 `docs/current/` 下的文件
（下次生成会覆盖掉）：

- vendor 模式：改 `scripts/prompts/module.md`
- 引用模式：把 `prompts/` 拷到你仓库的 `scripts/prompts/`，同名文件会优先采用

生成出来的文档头部标着 `doc_status: candidate`（候选），意思是没有任何人确认过。
这是给使用者看的：模型写的东西默认不算数。规则见 [README 第三节](./README.md)。

一份生成的文档头部长这样（真实输出，未删减）：

```yaml
---
generated_by: docs-update-bot
generated_at: 2026-09-15T03:43:34.983Z
based_on_commit: 97c5e85201d5f308345722d41b3258054b2fec20
project: shop-miniapp
mode: incremental
source_fingerprint: 34cae76397c4ae75   # 生成时代码的指纹，用来判断文档是否已失效
body_fingerprint: 6f2ca374606b054d     # 当时正文的指纹，人来确认时锁的就是它
doc_status: candidate                  # 候选 / 已验证 / 已失效
model: qwen3:8b                        # 用了哪个模型（换模型后靠它区分质量断层）
prompt_version: d42d14b175fd1ed5       # 提示词模板的内容指纹，改一个字就换一版
confidence: high
features:                              # 自动提取的功能清单，汇总进 INDEX.md 的功能索引
  - 下单 :: 创建订单并返回订单号
  - 退款 :: 按原支付渠道退回
source_files:
  - src/modules/order/file1.js
---
```

> 记的是模型名，不记接口地址。地址可能是内网地址或某家的私有网关，
> 写进随代码提交的文档里等于把它公开。密钥同理，从来只走环境变量。

---

## 第五步：接到 CI 上

配置 `init` 已经放好了（GitHub → `.github/workflows/docs.yml`，GitLab → `.gitlab-ci.yml`），
剩下三件事：

**1. 开写权限**（漏了会很安静地不工作）

- GitHub：`Settings → Actions → General → Workflow permissions` 选 **Read and write**
- GitLab：加一个带 `write_repository` + `api` 权限的 `DOCS_BOT_TOKEN`

**2. 配 Secret**：`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`（后两个也可以在配置文件里写死）

**3. 手动触发一次**（GitHub 的 `workflow_dispatch` / GitLab 的 Run pipeline）

先让它在你的仓库里真跑一遍，看它开出来的那个 PR，别一上来就交给事件自动触发。
链路通了、产出也合格，再交给下面这四种事件：

```
你提 PR        → 生成「文档影响预览」，贴在 PR 里（不写入任何文件）
你合并主干     → 重生成受影响模块的文档，开一个 PR
你打 Release   → 生成版本演进章节，写入 history/
每天凌晨       → 巡检，找出文档与代码脱节的模块
```

接的时候有四个坑（机器人提交不触发下游、自我触发死循环、首次推送基准为空、
定时任务里 `changes:` 恒真），现象与处理都在 [docs-kit/README.md](./docs-kit/README.md)。

---

## 日常怎么用

**看文档**：`docs/current/INDEX.md` 是入口，模块清单 + 功能索引 + 每篇的新鲜度状态。

**用文档**：让 AI 编程助手直接查，它会连状态一起拿到，不会把没人确认过的内容当团队共识：

```bash
npx docwarden mcp --root /path/to/your-project
```

配置见 [MCP.md](./MCP.md)。

**确认文档**：这是唯一必须由人做的一步，也是这套机制能成立的前提。

最顺手的方式是一条命令（写文档头部，不调模型、不碰 git）：

```bash
npx docwarden validate order             # 确认单个模块
npx docwarden validate order user        # 一次确认多个
npx docwarden validate order --by=张三   # 取不到 git 署名时显式指定确认人
npx docwarden validate order --force     # 失效文档直接背书当前版本（慎用）
```

确认人自动取 git 提交署名（`user.name`），和提交同源；取不到时必须 `--by` 显式给。
它是一份声明，不是鉴权——名字谁都能填，可信度来自"敢用真名署名"。

| 状态 | 含义 |
|---|---|
| **候选** | 模型刚生成，没有任何人确认过 |
| **已验证** | 有人确认过，且确认之后源码与正文都没再变 |
| **已失效** | 文档生成之后源码变了。它在描述旧代码，比没有文档更危险 |

失效的文档，`validate` 默认拒绝直接确认——正常路径是重新生成一份再确认。
如果你确认这次源码变更确实不影响这篇文档的结论，加 `--force` 直接背书当前版本。

想用界面来点确认（`npx docwarden serve`）也行，或者直接在文档头部把 `doc_status`
改成 `validated`、填上 `validated_by`。两边认的是同一套指纹，改哪边都算数。

一个会有点意外的行为，先说明：**代码回滚会让失效的文档自动恢复「已验证」**。
指纹重新对上了，文档与代码再次一致，它就重新可信；若失效期间有人改正文，正文指纹
对不上，不会静默复活。这是设计，不是 bug。

---

## 想调整的时候

| 想改什么 | 改哪里 |
|---|---|
| 模块划分 | `.knowledge.mjs` 的 `modules`，改完跑一次 `doctor` 确认前缀都对得上 |
| 文档风格、详细程度 | `scripts/prompts/module.md` |
| 版本章节怎么写 | `scripts/prompts/chapter.md` |
| 换模型 | 改 `LLM_BASE_URL` / `LLM_MODEL` 环境变量，不用动代码 |
| 成本护栏（单次最多处理多少文件等） | `.knowledge.mjs` 的 `guard` |
| 人写的说明（AI 永不覆盖） | 用 `<!-- MANUAL:BEGIN -->` … `<!-- MANUAL:END -->` 包起来 |

---

## 出问题了先看这几条

| 症状 | 原因 / 处理 |
|---|---|
| 报「还没配置模型接口」 | 正常，`.knowledge.mjs` 的 `llm` 段是空的，按[第二步](#第二步配置模型接口必须你自己配)填 |
| 报「缺少环境变量 LLM_API_KEY」 | 只配了地址和模型名，密钥还没给。见[第二步](#密钥放哪) |
| 流水线全绿，但文档一直没更新 | 最危险的一种。跑 `npx docwarden doctor`，多半是配置腐烂 |
| 新建的功能目录永远没有文档 | 模块没配到它。`--mode audit` 会统计「未覆盖的源码文件」 |
| 文档还在描述已经删掉的模块 | 巡检会列出「已不在配置中的文档」 |
| 开到 PR 但一直没触发下游 CI | 用默认 Token 创建的 PR 不会触发其他 workflow。见 docs-kit/README.md |
| 文档任务无限循环触发 | 少了 `paths-ignore: docs/**`（GitLab 侧是 `changes:` 里别写 `docs/**`） |
| 生成内容像是把源码抄了一遍 | 模块太大了。拆到 1500 行以内；「模块」按行数定义，不按目录 |
| 想确认某处改动有没有生效 | `npx docwarden doctor` + `--mode audit`，两条都不花钱 |

判断方法：如果一个故障不报错，它就得靠主动巡检发现。所以 `--mode audit` 值得放进定时任务。

---

## 命令速查

```bash
npx docwarden init [--platform=github|gitlab|both] [--no-vendor] [--dry-run] [--force]
npx docwarden doctor                      # 体检：缺什么、哪里烂了、怎么补
npx docwarden update --mode audit         # 零成本巡检
npx docwarden update --mode preview --base=HEAD~5        # PR 阶段的影响预览
npx docwarden update --mode incremental --base=HEAD~5    # 刷受影响模块的文档
npx docwarden update --mode chapter --version=v1.2.0     # 版本演进章节
npx docwarden serve [--port 5173] [--no-open]            # 本地界面（可选）
npx docwarden mcp --root <路径>                           # 给 AI 编程助手查
npx docwarden --help
```

> 命令加 `--dry-run` 就只打印、不写文件；加 `--force` 才会忽略代码指纹重新生成。
> `--mode` 之外的参数会原样转给脚本。
