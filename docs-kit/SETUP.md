# 配置指南 · 从零到跑通

面向第一次上手的人。照着做即可，不需要读源码。

真正必须配的只有两件事：**告诉脚本用哪个 AI**、**告诉脚本怎么划分模块**。其余都是调优。

> **按步骤走的话，请配合 [USAGE.md](../USAGE.md)（使用说明）一起看** ——
> 那份是操作手册，这份是细节参考（选型、成本、密钥与权限）。

---

## 一、AI 相关的配置在哪

全部集中在仓库根目录的 `.knowledge.mjs`：

```js
llm: {
  baseUrl: process.env.LLM_BASE_URL || '',   // ← 空着，要你自己填
  model: process.env.LLM_MODEL || '',        // ← 空着，要你自己填
  temperature: 0.2,
  maxTokens: 4096,
  timeoutMs: 120000,
}
```

**`baseUrl` 和 `model` 是刻意留空的。** 这个脚本会把你仓库里的源码读出来发给模型，
填哪个地址就等于把源码交给谁 —— 这是个决定，只能由你的项目来做。所以工具不预填任何
厂商，也不会偷偷用一个默认地址跑起来：**没配就在开工之前直接失败**，并在报错里给出
两种配法，而不是先跑成功了、代码已经发出去了。

| 字段 | 作用 | 建议 |
|---|---|---|
| `baseUrl` | **决定用哪家 AI**。要求服务端提供 OpenAI 兼容接口 | **必须你自己填**（或用 `LLM_BASE_URL`）|
| `model` | 模型名，各家命名不同 | **必须你自己填**（或用 `LLM_MODEL`）；见第三节选型标准 |
| `temperature` | 生成随机性 | 保持 `0.2`。写文档不需要创意，温度高会让模型开始"发挥" |
| `maxTokens` | 单篇文档长度上限 | `4096` 够用；调太大会抬高单次失败的成本 |
| `timeoutMs` | 单次请求超时 | `120000`。大模块要读几万字符代码，给足时间 |

两种配法，任选一种。注意上面的模板里那两行**本身就是从环境变量读的**
（`process.env.LLM_BASE_URL || ''`），所以设了环境变量就等于配好了；
如果你把地址直接写死在配置里，则以配置文件为准。CI 里用环境变量
（配成 Secret / 加密变量），本地临时试也方便。

**注意：`apiKey` 故意不在这里。** 这个文件要提交进 git，密钥不能进仓库。它从环境变量 `LLM_API_KEY` 读取——第四节讲怎么放。

---

## 二、为什么改 `baseUrl` 就够了

脚本只要求服务端提供 **OpenAI 兼容的 `/chat/completions`** 接口（请求体是 `{model, messages, temperature, max_tokens}` 这种格式）。市面上绝大多数模型服务都提供这一层兼容。

所以：**换模型不用改代码，只改一个环境变量。**

| 来源 | `baseUrl` 长什么样 | 适合 | 代价 |
|---|---|---|---|
| 公有云 API | `https://api.openai.com/v1` | 最快验证效果 | 整个模块源码会发到境外，多数公司的合规过不了 |
| 国内云 API | 各家的兼容端点，形如 `https://xxx.com/v1`（具体地址查各家文档的「OpenAI 兼容」章节） | 延迟低、数据合规可控 | 低价档位的指令遵循能力偏弱，容易开始复述源码 |
| 私有化部署 | vLLM：`http://内网IP:8000/v1`<br>Ollama：`http://localhost:11434/v1` | 代码完全不出内网 | 需要 GPU 和运维 |

**推荐顺序**：先用公有云或国内云把「生成质量到底行不行」这件事验证掉，质量过了再考虑私有化。因为换的只是一个 URL，不要在这个阶段纠结部署形态。

---

## 三、模型怎么选

写文档这个任务的要求和「聊天」不一样。按重要性排序：

| 要求 | 为什么 | 优先级 |
|---|---|---|
| **上下文窗口大** | 一次要喂进整个模块的代码（配置上限 12 万字符）。窗口不够，代码在进模型前就被截断，生成质量直接崩 | 第一 |
| **指令遵循强** | 提示词里有 7 条禁令（禁复述源码、禁推测、禁写「为什么」）。指令遵循弱的模型会开始抄代码 | 第二 |
| **价格** | 每次调用几万 token，用得越多越明显 | 第三 |
| **推理能力** | 几乎不需要——这不是让模型"想"，是让它"读懂了照着说" | 最低 |

结论：**不必上最贵的模型。** 贵模型的优势在推理，这里用不上。

反过来说，**参数量太小的模型不要用**——问题不在于"写得不够好"，而是在长上下文处理和禁令遵循这两个环节会直接失守，输出会退化成源码的副本。

---

## 四、密钥怎么放

### GitHub

两处设置，第二处最容易被忘：

1. `Settings → Secrets and variables → Actions → New repository secret`，添加：
   - `LLM_API_KEY`
   - `LLM_BASE_URL`
2. `Settings → Actions → General → Workflow permissions` → 选 **Read and write permissions**

> ⚠️ 第 2 条不开，机器人跑得再对也**开不了 PR**，而且不会有明显报错——属于典型的静默失效。

### GitLab

1. `Settings → CI/CD → Variables`，添加：
   - `LLM_API_KEY`（勾 **Masked**，防止日志泄露）
   - `LLM_BASE_URL`（勾 Masked）
   - `DOCS_BOT_TOKEN` —— 一个具备 `write_repository` 与 `api` 权限的 Project Access Token，用来推分支、开 MR
2. 确认流水线有推送权限：`Settings → Repository → Protected branches` 不要挡住 `docs/*` 分支

Token 权限给到刚够用即可，不要用 Owner 级账号的 Token。

---

## 五、接上 CI

### 先装进项目（一条命令）

```bash
npx docwarden init                     # GitHub + vendor 模式（脚本进你的仓库）
npx docwarden init --no-vendor         # GitHub + 引用模式（脚本不进你的仓库）
npx docwarden init --platform=gitlab   # GitLab（只有 vendor 模式）
npx docwarden init --dry-run           # 先看会写哪些文件，一个字节都不落地
```

它会探测你的目录结构、推断模块划分、生成 `.knowledge.mjs` 初稿，并把 CI 配置放到
正确的位置。装完跑一次 `npx docwarden doctor` 逐项复查。

**两种接入方式**：

| | 引用模式（`--no-vendor`） | vendor 模式（默认） |
|---|---|---|
| 平台 | 仅 GitHub | GitHub + GitLab |
| 你的仓库里 | 只有配置和 workflow | 配置 + `scripts/`（4 个文件）|
| CI 怎么调 | `uses: <org>/docwarden@v1` | `node scripts/docs-update.mjs` |
| 提示词怎么改 | 把 `scripts/prompts/` 拷进仓库即可覆盖 | 直接改 |

引用模式下脚本跑在 Action 自己的目录里，靠 `--root` 指到你的工作区
（workflow 里已经写好了，不用手动加）。手工跑就是：

```bash
node <工具目录>/docs-kit/scripts/docs-update.mjs --root "$PWD" --mode audit
```

<details>
<summary>不想用命令、要手工拷的话，对照这张表</summary>

| 拷什么 | 放到哪 | 说明 |
|---|---|---|
| `scripts/docs-update.mjs` | `scripts/` | 主脚本 |
| `scripts/lib/freshness.mjs` | `scripts/lib/` | 指纹与状态的唯一实现，**不能漏** |
| `scripts/prompts/` | `scripts/prompts/` | 提示词模板；质量不好先改这里 |
| `.knowledge.mjs` | 仓库根目录 | 模块划分与模型配置 |
| `ci/github-actions.yml` | `.github/workflows/docs.yml` | GitHub 的四个触发契机 |
| `ci/gitlab-ci.yml` | `.gitlab-ci.yml` | GitLab 的四个触发契机 |
| `templates/pull_request_template.md` | `.github/` 或 `.gitlab/merge_request_templates/` | 强制填写决策三问 |

</details>

> ⚠️ `scripts/lib/freshness.mjs` 最容易被当成「附属文件」漏掉。主脚本用相对路径
> `./lib/freshness.mjs` 引用它，少了它一启动就报找不到模块。
>
> 它单独存在也是有理由的：指纹算法如果两边各写一份，就会互相认不出对方的产出，
> 于是把「源码没变」误判成「源码变了」，反复重新生成 —— 那是纯浪费。

别忘了给 `.gitignore` 加一行 `.docs-preview.md`（PR 预览是临时产物，不该提交）。
`init` 会自动处理这一行；手工拷贝时记得自己加。

CI 通过环境变量把密钥传给脚本：

```yaml
env:
  LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
  # baseUrl / model 通常从 .knowledge.mjs 读，不必写在这里。
  # 想放 Secret 就打开下面两行 —— 但不能给**空值**，脚本会把空值当成「没配」。
  # LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
  # LLM_MODEL: ${{ secrets.LLM_MODEL }}
run: node scripts/docs-update.mjs --mode incremental
```

### 一个必须检查的配置

workflow 里必须有 `paths-ignore: docs/**`（GitLab 侧则是 `changes:` 里**刻意不写** `docs/**`）。

**漏了会死循环**：文档提交 → 触发文档任务 → 又生成文档提交 → 继续触发。

### 首次上线用手动触发

GitHub 用 `workflow_dispatch`，GitLab 在 Pipelines 页面手动 Run pipeline。确认整条链路通了，再交给事件自动触发。

---

## 六、（可选）本地先跑一次，不占 CI 配额

不接 CI 也能先用起来。**本地与 CI 是同一份实现**，所以本地看到什么，CI 上就是什么。

```bash
export LLM_BASE_URL="https://你的服务/v1"
export LLM_API_KEY="sk-xxx"

# 只看结果，不写任何文件
npx docwarden update --mode incremental --base=HEAD~5 --dry-run

# 确认没问题再真正写入
npx docwarden update --mode incremental --base=HEAD~5

# 不花钱的巡检，随时可跑
npx docwarden update --mode audit
```

> vendor 模式下这三条等价于 `node scripts/docs-update.mjs --mode …`；
> 引用模式下没有 `scripts/`，就用上面的写法（工具会自动把目标指到你当前目录）。

`--dry-run` 只打印将要写入的文件与字数，不动磁盘。**第一次务必先用它。**

看生成结果时，只关注一件事：**有没有编造代码里不存在的功能。** 这是最需要警惕的错误类型；措辞、长度之类都容易调。

质量不满意时，改提示词模板 —— vendor 模式改 `scripts/prompts/module.md`；引用模式下把
`prompts/` 拷进你仓库的 `scripts/prompts/` 即可覆盖工具自带的那份。不要去手动改
`docs/current/` 下的文件，下次生成会覆盖掉。

> 生成出来的文档，头部标着 `doc_status: candidate`（候选）——意思是**没有任何人确认过**。
> 这是给使用者看的：模型写的东西默认不算数。确认之后才会变成 `validated`，
> 并锁住当时那一版正文的指纹；以后源码或正文任一变过，这条确认自动失效。
> 详细规则见 [README 第六节](README.md)。

---

## 七、成本与安全

**成本量级**：单个模块一次生成，输入约几万 token，按中等价位模型算**单次几分钱**；一个月两百次模块生成，量级在几十元。

真正会烧钱的不是日常使用，而是**没被挡住的批量变更**——一次全量代码格式化若没被过滤，能在一小时里跑掉一个月的额度。脚本里已经有对应护栏（`maxChangedFiles`、纯格式变化检测），不要为了"覆盖更全"把它们调得过大。

**上线前检查清单**：

- [ ] 密钥只放 CI Secrets / 加密变量，不进仓库、不进日志
- [ ] `.docs-preview.md` 已加入 `.gitignore`
- [ ] 机器人 Token 权限最小化（`write_repository` + `api` 足够）
- [ ] 已确认代码是否可以送往外部模型服务；不能则改私有化部署
- [ ] 敏感目录（密钥配置、内部地址）已加进 `.knowledge.mjs` 的 `ignorePaths`

---

## 八、配置类问题排查

| 现象 | 原因 | 怎么修 |
|---|---|---|
| CI 全绿但文档没更新 | 变更文件没命中任何模块 | 检查 `modules.prefixes` 是否覆盖到相关目录 |
| 报「缺少环境变量 LLM_API_KEY」 | Secret 没配，或名字写错 | 核对 Secrets 名称与 workflow 里的引用是否一致 |
| 跑完没有 PR 产生 | Workflow permissions 没开写权限 | 改成 Read and write |
| 文档提交后 CI 又跑一遍 | 没配 `paths-ignore: docs/**` | 补上 |
| 报「找不到配置文件」 | `.knowledge.mjs` 不在仓库根目录 | 移到根目录 |
| 提示输出过短 / 拒绝写入 | 触发熔断校验 | 看日志里的具体原因；确认是误判再调 `guard` 阈值 |
| 单次运行处理文件过多 | 一次重构或冷启动 | 分批处理，或调小 `maxChangedFiles` |
| 模型返回超时 | 模块过大或服务不稳定 | 拆小模块；或提高 `timeoutMs` |
