// 界面静态自检：内联脚本能不能过语法、新增的 id 与函数是不是既声明又被引用。
// 这个检查很便宜，但能挡住「HTML 改了、JS 里引用的元素却不存在」这类低错。
import fs from 'node:fs'
import vm from 'node:vm'

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const html = fs.readFileSync(ROOT + 'docwarden.ui.html', 'utf8')

const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
console.log(`内联脚本块: ${blocks.length}`)
let bad = 0
blocks.forEach((code, i) => {
  try { new vm.Script(code); console.log(`  块 ${i + 1}: 语法 OK (${code.length} 字符)`) }
  catch (e) { bad++; console.log(`  块 ${i + 1}: 语法错误 → ${e.message}`) }
})

const ids = ['statusList', 'statusSummary', 'verifyBy', 'btnCheck', 'btnRetry', 'genFail', 'timeoutSec', 'maxTokens', 'modelList']
for (const id of ids) {
  const declared = html.includes(`id="${id}"`)
  const used = new RegExp(`\\$\\('${id}'\\)`).test(html)
  const ok = declared && used
  if (!ok) bad++
  console.log(`  ${ok ? 'OK  ' : 'MISS'} #${id}  声明=${declared} 引用=${used}`)
}

const fns = ['statusPill', 'renderStatus', 'doVerify', 'refreshDocStatus', 'statusCounts']
for (const f of fns) {
  const declared = new RegExp(`function ${f}\\s*\\(`).test(html)
  const used = html.includes(f + '(')
  const ok = declared && used
  if (!ok) bad++
  console.log(`  ${ok ? 'OK  ' : 'MISS'} ${f}()  声明=${declared} 调用=${used}`)
}
console.log(bad ? `\n✘ ${bad} 项未通过` : '\n✔ 全部通过')
process.exit(bad ? 1 : 0)
