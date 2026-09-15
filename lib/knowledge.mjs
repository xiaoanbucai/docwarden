/**
 * 知识库的读取层（工作台与 MCP 服务用）。
 *
 * 核心判定 —— 指纹算法、frontmatter 解析、状态 —— 全在
 * `docs-kit/scripts/lib/freshness.mjs`。这里只做两件事：
 *   1. 把它原样转发出去，让调用方少写一层路径；
 *   2. 补上「读已生成文档库」的部分（索引表、模块清单）—— 这部分 CI 用不到。
 *
 * 为什么核心不放在这里：CI 脚本要随 `docs-kit/` 整个拷进别人的仓库，
 * 不能反向依赖工作台目录。CI 是主线，核心就得跟着主线走，由工作台反过来引用。
 *
 * 顺带一提，这里以前还管着一个 `status.json`（人的确认存在里面）。
 * 那个设计已废弃：任何模块的更新都会改动同一个文件，多分支合并必然冲突，
 * 而冲突内容是一串机器哈希，人没法判断该保留哪一边。现在确认写进文档自己的头部，
 * 随文档一起提交、回滚、review，零额外文件。旧的 status.json 会被自动搬走。
 *
 * 注意：本文件不是 npm 依赖，只是工作台目录下的一个普通模块。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  STATUS_LABEL,
  readDocMeta,
  docPathOf,
  indexPathOf,
  evaluateDoc,
  matchTextFingerprint,
} from '../docs-kit/scripts/lib/freshness.mjs'

// 核心判定原样转发：状态常量、指纹函数、frontmatter 读写、evaluateDoc……一处实现，两处引用
export * from '../docs-kit/scripts/lib/freshness.mjs'

/**
 * 不做扫描、直接从已生成的文档目录读出模块清单。
 * MCP 服务用这个：它只关心「文档库里有什么」，不需要重新扫源码树。
 * 模块名从文件名反推 —— 生成时用的就是 `模块名.md`，两边一致。
 */
export function readExportedModules(root) {
  const dir = path.join(root, 'docs', 'current', 'modules')
  let names
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return { ok: false, reason: 'no-docs-dir', modules: [] }
  }
  const modules = []
  for (const f of names) {
    const meta = readDocMeta(path.join(dir, f))
    if (!meta) continue
    modules.push({
      name: f.replace(/\.md$/, ''),
      docFile: f,
      generatedAt: meta.generatedAt,
      statusInFile: meta.docStatus,
      sourceFingerprintInFile: meta.sourceFingerprint,
      bodyFingerprint: meta.bodyFingerprint,
      body: meta.body,
      validatedBy: meta.validatedBy,
      validatedAt: meta.validatedAt,
    })
  }
  modules.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, modules }
}

/**
 * 在「不重新扫源码树」的前提下判断状态。
 *
 * 只有当初记录的源码指纹能重算时才判得了 stale，否则只能信文档头部写的东西。
 * filesOf(name) 由调用方提供（MCP 场景下取自 INDEX 的「文件 → 模块」表）。
 */
export function evaluateFromDocs(root, mod, files) {
  if (files && files.length) return evaluateDoc(root, docPathOf(root, mod.name), files)

  const meta = readDocMeta(docPathOf(root, mod.name))
  if (!meta) return { status: 'missing', label: STATUS_LABEL.missing }

  const body = matchTextFingerprint(meta.body, meta.validatedBodyFingerprint || meta.bodyFingerprint)
  if (meta.docStatus === 'validated' && meta.validatedBy && body.matched) {
    return { status: 'validated', label: STATUS_LABEL.validated, by: meta.validatedBy, at: meta.validatedAt }
  }
  return { status: 'candidate', label: STATUS_LABEL.candidate, reason: '' }
}

/** 解析 INDEX.md 里的「文件 → 模块」表，得到 文件路径 → 模块名 的映射 */
export function readFileIndex(root) {
  const map = {}
  let txt
  try { txt = fs.readFileSync(indexPathOf(root), 'utf8') } catch { return map }
  let inTable = false
  for (const line of txt.split(/\r?\n/)) {
    if (/^##\s*文件\s*→\s*模块/.test(line)) { inTable = true; continue }
    if (inTable && /^##\s/.test(line)) break
    if (!inTable) continue
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*\[([^\]]+)\]/)
    if (m) map[m[1]] = m[2]
  }
  return map
}

/** 解析 INDEX.md 里的模块总览，得到 模块名 → {lines,fileCount,status} */
export function readModuleIndex(root) {
  const out = {}
  let txt
  try { txt = fs.readFileSync(indexPathOf(root), 'utf8') } catch { return out }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*([\d,]+)\s*\|\s*(\d+)\s*\|/)
    if (m) out[m[1]] = { status: m[2], lines: Number(m[3].replace(/,/g, '')), fileCount: Number(m[4]) }
  }
  return out
}
