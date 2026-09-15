/**
 * 支付网关适配层。业务代码只认这一层，换支付渠道不需要动上游。
 *
 * 注意 charge() 是幂等的前提由调用方保证，本层不做去重。
 */
const CHANNELS = ['wechat', 'alipay', 'balance']

export async function charge(channel, amount, orderId) {
  if (!CHANNELS.includes(channel)) throw new Error('不支持的支付渠道：' + channel)
  if (amount <= 0) throw new Error('金额必须大于 0')
  return { channel, amount, orderId, tradeNo: 'T' + Date.now() }
}

export async function queryTrade(tradeNo) {
  return { tradeNo, status: 'success' }
}

export async function closeTrade(tradeNo) {
  return { tradeNo, status: 'closed' }
}
