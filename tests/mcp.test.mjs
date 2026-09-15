// 用真实 stdio 协议连一遍 MCP 服务。
// 这里要防两类问题：
//   ① 协议层：stdout 混进日志就会损坏 JSON-RPC 流 —— 所以每一行都必须能 JSON.parse
//   ② 语义层：文档状态必须真的跟着内容返回，否则 AI 会把「候选」当结论用
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const BASE = 'http://127.0.0.1:5173'
const NODE = process.execPath

const post = async (p, body) => (await fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json()

const WORK = path.join(os.tmpdir(), 'docwarden-mcp-test')
fs.rmSync(WORK, { recursive: true, force: true })
fs.cpSync(path.join(ROOT, 'sample'), WORK, { recursive: true })

const DOC_ORDER = '## 模块职责\n\n负责订单的创建、支付、关闭。\n\n## 关键设计\n\n状态机集中管理，非法流转直接拒绝。\n'
const DOC_PAYMENT = '## 模块职责\n\n负责扣款与退款。\n\n## 注意事项\n\n退款需要审批。\n'

const fails = []
const check = (ok, msg) => { console.log(`  ${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg) }

// ---------------------------------------------------------------- MCP 客户端

class McpClient {
  constructor(root) {
    this.proc = spawn(NODE, [path.join(ROOT, 'docwarden-mcp.mjs'), '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.buf = ''
    this.waiting = new Map()
    this.rawLines = []
    this.stderr = ''
    this.proc.stdout.on('data', (d) => {
      this.buf += d.toString('utf8')
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line) continue
        this.rawLines.push(line)
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id !== undefined && this.waiting.has(msg.id)) {
          this.waiting.get(msg.id)(msg)
          this.waiting.delete(msg.id)
        }
      }
    })
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString() })
    this.id = 0
  }
  send(method, params) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 ' + method + ' 超时')), 20000)
      this.waiting.set(id, (m) => { clearTimeout(timer); resolve(m) })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  async call(name, args) {
    const r = await this.send('tools/call', { name, arguments: args })
    const c = r.result && r.result.content && r.result.content[0]
    return { text: c ? c.text : '', isError: !!(r.result && r.result.isError), raw: r }
  }
  kill() { try { this.proc.kill() } catch { /* ignore */ } }
}

const client = new McpClient(WORK)

try {
  console.log('=== 0. 准备：造出两份文档，其中 order 人工确认 ===')
  await post('/api/export', {
    dir: WORK,
    docs: [
      { name: 'order', markdown: DOC_ORDER, lines: 83, fileCount: 3, files: ['src/order/repo.js', 'src/order/service.js', 'src/order/state.js'], provider: 'mock' },
      { name: 'payment', markdown: DOC_PAYMENT, lines: 42, fileCount: 2, files: ['src/payment/gateway.js', 'src/payment/refund.js'], provider: 'mock' },
    ],
  })
  const v = await post('/api/verify', { dir: WORK, module: 'order', action: 'validate', by: '测试员' })
  check(v.ok === true, 'order 已标记为已验证（准备阶段）')

  console.log('\n=== 1. 握手 ===')
  const init = await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  check(init.result?.protocolVersion === '2025-06-18', '回显了客户端请求的协议版本（协商）')
  check(!!init.result?.capabilities?.tools, '声明了 tools 能力')
  check(init.result?.serverInfo?.name === 'docwarden-knowledge', 'serverInfo.name 正确')
  client.notify('notifications/initialized', {})
  const pong = await client.send('ping', {})
  check(!!pong.result, 'ping 有响应')

  console.log('\n=== 2. tools/list ===')
  const list = await client.send('tools/list', {})
  const names = (list.result?.tools || []).map((t) => t.name)
  check(names.length === 5, '暴露 5 个工具（实际 ' + names.length + '）')
  check(names.includes('get_module_doc') && names.includes('find_module_for_file'), '关键工具都在：' + names.join(', '))
  check(list.result.tools.every((t) => t.description && t.inputSchema && t.inputSchema.type === 'object'), '每个工具都有 description 与 object 型 inputSchema')

  console.log('\n=== 3. knowledge_overview ===')
  const ov = await client.call('knowledge_overview', {})
  check(ov.text.includes('order') && ov.text.includes('payment'), '列出了两个模块')
  check(ov.text.includes('已验证 1') && ov.text.includes('候选 1'), '状态计数正确：' + (ov.text.match(/模块：.*/) || [''])[0])

  console.log('\n=== 4. get_module_doc：状态必须跟着内容走 ===')
  const od = await client.call('get_module_doc', { module: 'order' })
  check(od.text.includes('文档状态：**已验证**'), 'order 的文档带「已验证」状态标注')
  check(od.text.includes('测试员'), '标出了确认人')
  check(od.text.includes('状态机集中管理'), '正文内容返回了')

  const pd = await client.call('get_module_doc', { module: 'payment' })
  check(pd.text.includes('文档状态：**候选**'), 'payment 的文档带「候选」状态标注')
  check(/没有任何人确认过|可能不准确/.test(pd.text), '候选状态下给出了「不可当结论」的提醒：' + (pd.text.match(/^> .*$/m) || [''])[0].slice(0, 60))

  console.log('\n=== 5. find_module_for_file ===')
  const f1 = await client.call('find_module_for_file', { file: 'src/order/service.js' })
  check(f1.text.includes('属于模块 **`order`**'), '相对路径能定位')
  check(f1.text.includes('文档状态'), '返回里也带了状态')
  const f2 = await client.call('find_module_for_file', { file: path.join(WORK, 'src', 'payment', 'refund.js') })
  check(f2.text.includes('属于模块 **`payment`**'), '绝对路径能定位')
  const f3 = await client.call('find_module_for_file', { file: 'refund.js' })
  check(f3.text.includes('payment'), '只给文件名也能定位（唯一匹配）')

  console.log('\n=== 6. search_docs ===')
  const s1 = await client.call('search_docs', { query: '退款' })
  check(s1.text.includes('payment'), '按正文关键词能搜到 payment')
  const s2 = await client.call('search_docs', { query: 'state.js' })
  check(s2.text.includes('order'), '按文件路径能搜到 order')
  const s3 = await client.call('search_docs', { query: '压根不存在的词xyzzy' })
  check(/没有文档提到/.test(s3.text), '搜不到时给出可行动的说明')

  console.log('\n=== 7. check_freshness ===')
  const fr = await client.call('check_freshness', {})
  check(fr.text.includes('已验证 1') && fr.text.includes('候选 1'), '分组计数正确')
  check(fr.text.includes('不要当成团队共识引用'), '对候选项有明确警告')

  console.log('\n=== 8. 改源码后，MCP 应当立刻报「已失效」 ===')
  const src = path.join(WORK, 'src', 'order', 'service.js')
  fs.writeFileSync(src, fs.readFileSync(src, 'utf8') + '\n// 改动\n', 'utf8')
  const od2 = await client.call('get_module_doc', { module: 'order' })
  check(od2.text.includes('文档状态：**已失效**'), 'order 变为已失效（MCP 自己算的指纹，没找 HTTP 服务）')
  check(/以源码为准/.test(od2.text), '已失效时提醒以源码为准')
  const fr2 = await client.call('check_freshness', {})
  check(fr2.text.includes('不要信它们的内容'), '新鲜度检查把已失效单列警告')

  console.log('\n=== 9. 错误处理 ===')
  const e1 = await client.call('get_module_doc', { module: '不存在的模块' })
  check(/没有找到名为/.test(e1.text) && /可用模块/.test(e1.text), '模块名写错时给出候选与全部可用项')
  const e2 = await client.call('find_module_for_file', { file: 'src/nope/nothing.js' })
  check(/索引里找不到/.test(e2.text), '路径找不到时说明原因')
  const e3 = await client.send('tools/call', { name: 'no_such_tool', arguments: {} })
  check(e3.result?.isError === true, '未知工具按 MCP 约定返回 isError（而不是 JSON-RPC error）')
  const e4 = await client.send('tools/call', { name: 'get_module_doc', arguments: {} })
  check(e4.result?.content?.[0]?.text?.length > 0, '缺必填参数时也有可读提示')

  console.log('\n=== 10. 不存在的项目目录 ===')
  const bad = new McpClient(path.join(os.tmpdir(), 'definitely-not-here-xyz'))
  const b1 = await bad.call('knowledge_overview', {})
  check(/没有文档库/.test(b1.text) && /node docwarden.mjs/.test(b1.text), '友好提示怎么生成文档')
  bad.kill()

  console.log('\n=== 11. stdout 纯净性（协议流的生命线）===')
  let badLine = 0
  for (const l of client.rawLines) { try { JSON.parse(l) } catch { badLine++ } }
  check(badLine === 0, `stdout 的 ${client.rawLines.length} 行全部是合法 JSON-RPC（非 JSON 行 ${badLine} 条）`)
  check(client.rawLines.length > 0, '确实收到了响应行')
  check(!client.stderr.includes('undefined'), 'stderr 里没有 undefined 之类的异常痕迹')
} catch (e) {
  fails.push('异常：' + e.message)
  console.log('  [异常] ' + e.stack)
} finally {
  client.kill()
  fs.rmSync(WORK, { recursive: true, force: true })
}

console.log('\n' + (fails.length ? '✘ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ') : '✔ 全部断言通过'))
process.exit(fails.length ? 1 : 0)
