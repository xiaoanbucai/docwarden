# 状态写在文档 front-matter，不设集中式 status.json

每篇模块文档的确认状态（candidate / validated / stale）连同指纹、确认人、确认时间，
直接写在该文档自己的 front-matter 里。项目**刻意不设**集中式状态文件（status.json）。

背景：集中式状态文件在多分支并行开发下是灾难——两个分支各自改了同一篇文档的状态，
合并时 status.json 必然冲突，而冲突内容是机器哈希，人没法裁决，只能扔掉一边；
front-matter 则让状态跟着各自分支的文档走，合并时作为普通文本自然汇合。

代价是接受的：front-matter 分散在每篇文档里，"看全局状态"必须跑一次扫描聚合
（`doctor` 与巡检模式已经在做这件事），没有一眼望穿的单文件。这个代价用换来的
可合并性买，值。

## Considered Options

- **status.json（否决）**：读写集中、一眼全局，但多分支合并必然产生不可人工裁决的哈希冲突。
- **git notes（否决）**：不进工作树、多数使用者看不见，状态失去了"贴在文档脸上"的震慑作用。
- **front-matter（采纳）**：状态与文档同生共死，合并冲突是人可读可裁决的文本。

## Consequences

- 新增任何状态字段都必须同时考虑 front-matter 的兼容读取（字段改名要留旧名兼容，如
  `code_hash` → `source_fingerprint`）。
- 任何"建一个集中状态文件会方便很多"的重构提案，都应先重读本 ADR。
