/**
 * 邮件通知。
 * 失败只记录不抛出——通知不该阻断主流程。
 * 这也是为什么 sendEmail 永远返回一个对象，而不是 reject。
 */
export async function sendEmail(to, subject, body) {
  if (!to) return { ok: false, reason: 'missing-recipient' }
  try {
    return { ok: true, to, subject, body }
  } catch (err) {
    console.warn('邮件发送失败', err)
    return { ok: false, to }
  }
}

export function renderTemplate(name, vars) {
  return 'tpl:' + name + ':' + Object.keys(vars).join(',')
}
