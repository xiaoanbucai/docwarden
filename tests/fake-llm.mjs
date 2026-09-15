// 测试用假模型接口：notify 模块第一次调用故意返回 500，第二次起正常。
// 用来造出「部分成功」的局面，从而验证「重试失败项」是否真的只重跑失败模块。
import http from 'node:http'

const attempts = new Map()
const log = []

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'fake-doc-model' }] }))
    }
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404); return res.end('nope')
    }

    // 用唯一的文件路径标记判断这是哪个模块
    const isNotify = raw.includes('src/notify/email.js')
    const key = isNotify ? 'notify' : 'other'
    const n = (attempts.get(key) || 0) + 1
    attempts.set(key, n)
    log.push(`${isNotify ? 'notify' : 'other'} 第 ${n} 次`)

    if (isNotify && n === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: '模拟的首次失败（测试用）' } }))
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: '## 模块职责\n\n这是假模型为测试生成的占位文档。调用序号 ' + n + '。\n\n'
            + '## 对外接口\n\n| 名称 | 作用 |\n|---|---|\n| fake | 占位 |\n',
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }))
  })
})

// 暴露调用记录，便于断言
const stats = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ attempts: Object.fromEntries(attempts), log }))
})

stats.listen(5402)
server.listen(5401, () => console.log('假模型已启动 :5401，统计 :5402'))
