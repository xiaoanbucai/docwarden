# 接入 MCP —— 让 AI 编程助手能查团队知识库

生成出来的文档，人看是一回事；**让 AI 在写代码时主动去查**是另一回事。
`docwarden-mcp.mjs` 就是干这个的：它把 `<项目>/docs/current/` 暴露成 MCP 工具，
Cursor / Claude Code / Windsurf 之类支持 MCP 的客户端都能调。

它**不依赖 HTTP 工作台**——不需要 `docwarden.mjs` 在跑，直接读磁盘上的文档。
状态和指纹是它自己现算的，所以「源码改过没有」它当场就能告诉你。

## 启动方式

```bash
node docwarden-mcp.mjs --root /path/to/your-project
# 或
DOCWARDEN_ROOT=/path/to/your-project node docwarden-mcp.mjs
```

不给 `--root` 时，依次退回环境变量 `DOCWARDEN_ROOT`、当前工作目录。
**每个工具都还有一个可选的 `dir` 参数**，可以临时查别的项目，不必为每个项目各配一份。

## 客户端配置

### Cursor

项目内 `.cursor/mcp.json`（或全局 `~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "docwarden": {
      "command": "node",
      "args": [
        "/path/to/docwarden-mcp.mjs",
        "--root", "/path/to/your-project"
      ]
    }
  }
}
```

> 把两个路径换成你实际的位置。Windows 上路径写 `C:\\path\\to\\docwarden-mcp.mjs`
> （JSON 里反斜杠要写两个），或者直接用正斜杠也行。
>
> 如果你是用 `npm i -D docwarden` 装的，也可以不写绝对路径，
> 改用 `npx docwarden mcp --root <你的项目>` 起服务。

### Claude Code

```bash
claude mcp add docwarden -- node "/path/to/docwarden-mcp.mjs" --root "/path/to/your-project"
```

或项目内 `.mcp.json`，格式与上面 Cursor 的相同。

### 通用 JSON 配置

任何 MCP 客户端都是同一段：`command` + `args`。

> 如果客户端找不到 `node`，把 `command` 换成 node 的绝对路径。

## 五个工具

| 工具 | 用途 | 典型问法 |
|---|---|---|
| `knowledge_overview` | 列出所有模块与状态 | 「这个项目有什么、哪些有文档？」 |
| `get_module_doc` | 取某个模块的完整文档 | 「pages 模块是干什么的？」 |
| `find_module_for_file` | 文件 → 模块 + 文档 | 「我正在改 `cart.vue`，它有什么约定？」 |
| `search_docs` | 按关键词搜模块名/文件/正文 | 「哪里提过退款？」 |
| `check_freshness` | 查哪些文档已失效/未确认 | 「这些文档现在还能信吗？」 |

## 设计上最要紧的一点：状态跟着内容一起返回

**每份返回给 AI 的文档，开头都带一行状态：**

```
> 文档状态：**候选**
> **这份文档是「候选」，没有任何人确认过**，内容由模型生成、可能不准确。
> 引用它的结论前请自己核对源码。
```

这不是装饰。**如果状态不跟着内容走，前面整套状态机制就等于白做**——
AI 会把模型生成的猜测当成团队共识去用，而那正是我们一开始要防的事：
未经确认的 LLM 输出获得了它不应有的权威性。

三种状态给 AI 的指令是分开的：

| 状态 | 给 AI 的话 |
|---|---|
| 已验证 | 内容可信，且确认之后源码没动过 |
| 候选 | 没人确认过，**可以拿它建立印象，但不能当结论引用** |
| 已失效 | 生成之后源码改了，**以源码为准** |

## 一个副作用（好的那种）

`find_module_for_file` 用的是 INDEX.md 里那张「文件 → 模块」表反推出来的文件清单来重算指纹，
所以**它不重新扫源码树**——只读那些确实被文档覆盖的文件。这让查询很快，
而且那张表本来就是脚本生成的检索键，一物两用。

## 自己验证

```bash
npm run test:mcp     # 走真实 stdio 协议连一遍，26 条断言
```

测试里专门查了两件事：一是 **stdout 必须全是合法 JSON-RPC**（混进一行日志协议流就废了），
二是**状态确实跟着内容返回**（改了源码后，MCP 当场报「已失效」）。
