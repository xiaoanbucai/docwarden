# 参与开发

欢迎提 Issue 和 PR。这个工具解决的问题很具体，**说清你遇到的具体场景，比说「优化一下体验」有用得多。**

## 这个工具的几条硬约束

改动之前请先了解，它们不是风格偏好，背后都有事故：

| 约束 | 原因 |
|---|---|
| **主程序零依赖** | `docwarden serve` / `mcp` / `docs-update.mjs` 不能 `import` 任何 npm 包。CI 里不跑 `npm install`，装了包就等于要求使用者联网装依赖。测试用的 `jsdom` 只在 `devDependencies`。 |
| **指纹与状态只有一份实现** | 只能放在 `docs-kit/scripts/lib/freshness.mjs`。两边各写一份 → 互相认不出对方的产出 → 把「源码没变」误判成「源码变了」→ 全量重新生成，纯烧额度。 |
| **不写独立的 `status.json`** | 任何模块的更新都会改这个文件，多分支合并必然冲突，而冲突内容是一串哈希，人工没法决定留哪边。状态写在文档 front-matter 里。 |
| **不改用户的源码** | 导出前后源码逐字节一致，这条有测试守着。 |
| **API Key 不许落盘** | 不写进任何文件、不进导出内容、不进浏览器持久化。`npm run test:leak` 会跑完整流程后把项目目录翻一遍。 |
| **换指纹算法不许重新生成** | 必须认得历史算法的旧指纹，就地升级头部即可。为算法换代重跑一遍模型是纯浪费。 |

## 本地开发

```bash
git clone https://github.com/xiaoanbucai/docwarden.git
cd docwarden
npm install          # 只装 jsdom，跑测试用
```

跑测试需要先在另一个终端起主服务：

```bash
node docwarden.mjs --no-open     # 终端 A
npm test                            # 终端 B
```

> `jsdom` 钉在 `^26.1.0`，**别随手升级**。它是唯一的开发依赖，而 CI 要在 Node 18 上
> 跑整套回归 —— 因为工具对使用者承诺了 `engines: >=18`，最低版本上也必须绿。
> jsdom 27 起要求 Node 20+，jsdom 30 起要求 22.22+，升上去 18/20 两个 job 就必红，
> 而且红的原因跟测试本身无关（Node 18 上是 ESM 依赖 `require()` 不了）。
> 等哪天决定不再支持 Node 18，把它升级、同时把 CI 矩阵改掉，两件事必须一起动。

`npm test` 里有一部分是**真跑界面**的端到端测试（jsdom 执行真实 UI 代码 → 真实服务 → 假模型），
连不上 `127.0.0.1:5173` 就会失败 —— 这是刻意的，静态检查查不出「界面写了、代码没接」那类问题。

详见 [`tests/README.md`](./tests/README.md)。

### 只想跑不需要服务的部分

```bash
npm run test:freshness   # 指纹与状态的一致性
npm run test:ci          # 在真实临时 git 仓库里跑一遍 CI 脚本（不调模型）
npm run test:selfcheck   # 界面内联脚本语法与接线
```

这三个不需要起服务，改了对应模块先跑它们。

## 提 PR 时

1. **说清问题**：什么仓库结构、什么操作、期望什么、实际什么。有日志就贴日志。
2. **带上测试**：修 bug 要有一个**先失败、改完通过**的测试，否则同类 bug 会回来。
   历史上 `test:status` 一上线就抓出一个解析 bug，很值。
3. **不要放宽护栏**：`maxChangedFiles`、倍数熔断这类阈值都是防「一次全量重构把额度打爆」的。
   觉得误杀了，请说明具体场景，不要直接调大默认值。
4. **中文注释**：代码注释和文档都用中文，说明**为什么这么做**，而不是复述代码在做什么。

## 提交信息

约定式提交，中文描述：

```
feat(init): 支持 monorepo 下多子包安装
fix(freshness): 相容 sha1 + 长度前缀的历史指纹
docs(readme): 补上 init 的完整参数说明
```

## 发布（仓库主理人看这节）

仓库里所有指向本仓库的地址都填成了 `xiaoanbucai/docwarden`。**如果你 fork 到别处、
打算从自己的地址发布**，先整个换一遍。漏掉的话，npm 页面的仓库链接、Issue 链接、
CHANGELOG 里的 compare 链接、以及**引用模式 workflow 里的 `uses:`** 全是死的
（最后这条最要命：Action 会直接找不到）。

```bash
# 换成你自己的 org / 用户名
grep -rl "xiaoanbucai" \
    --include="*.md" --include="*.json" --include="*.yml" --include="*.yaml" --include="*.html" . \
  | grep -v node_modules | grep -v "^./docs/" \
  | xargs sed -i 's|xiaoanbucai|你的org或用户名|g'

# 确认没有漏网的
grep -rn "xiaoanbucai" --include="*.md" --include="*.json" --include="*.yml" . | grep -v node_modules
```

涉及 `package.json`、`README.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、
`action.yml`、`docs-kit/ci/github-action-only.yml`。

换完验一遍：`npx docwarden doctor --dir <一个刚 init --no-vendor 的目录>`。
装好的 workflow 里如果还留着占位符，doctor 会把它当阻塞项报出来。

发布顺序：

```bash
npm test                       # 先全绿
npm pack                       # 打包，并核对内容清单
npm publish --access public    # 名称被占就改 package.json 的 name
git tag v1.2.0 && git push --tags
```

引用模式的 workflow 写的是 `@v1`，所以还需要一个**跟着走的 `v1` 标签**指向同一个提交。
少了它，所有人的 `uses: xiaoanbucai/docwarden@v1` 都会找不到东西：

```bash
git tag -f v1 && git push -f origin v1     # 每个版本发布后都把它挪一次
```

`npm publish` 之前建议**先在一台干净的机器或容器里 `npm install <tgz>` 装一遍，
再跑一次 `npx docwarden init`** —— `npm pack` 的清单只能告诉你「打了什么」，
告诉不了你「装出来能不能用」。

## 目录说明

```
bin/cli.mjs                    npx docwarden 入口（init / update / serve / mcp / doctor）
src/detect.mjs                 探测项目结构，推断模块划分
src/install.mjs                把 payload 装进目标仓库
src/templates/                 生成给使用者的配置文件模板
docs-kit/                      ★ 要装进使用者仓库的 payload 本体
  ├── scripts/docs-update.mjs  CI 主脚本（四个模式）
  ├── scripts/lib/freshness.mjs 指纹与状态的唯一实现
  ├── scripts/prompts/         提示词模板，质量不满意先改这里
  ├── ci/                      GitHub / GitLab 两套流水线配置
  └── templates/               PR 模板
docwarden.mjs                本地工作台（HTTP + 界面）
docwarden-mcp.mjs            MCP 服务
lib/knowledge.mjs              工作台侧读层（指纹实现 re-export 自 docs-kit）
tests/                         回归测试
sample/                        可直接试跑的样例项目
```

改 `bin/`、`src/`、`docwarden*.mjs`、`lib/` 属于**工具自身**；
改 `docs-kit/` 属于**装进别人仓库的那份负载** —— 后者影响面更大，请同时改
`docs-kit/README.md` 和 `docs-kit/SETUP.md`。
