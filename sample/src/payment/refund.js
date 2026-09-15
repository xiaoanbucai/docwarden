/**
 * 退款流程：先建单走审核，审核通过后原路退回。
 *
 * 幂等键由调用方提供——重复提交必须传同一个键，否则会重复退款。
 * 之所以不在这里自动生成，是因为重试方才是唯一知道「这是不是同一次请求」的人。
 */
export async function requestRefund(orderId, idemKey) {
  if (!idemKey) throw new Error('幂等键必填')
  return { refundId: 'r_' + idemKey, orderId, status: 'reviewing' }
}

export async function approveRefund(refundId, operator) {
  if (!operator) throw new Error('缺少审核人')
  return { refundId, status: 'approved', operator, approvedAt: Date.now() }
}

export async function executeRefund(refundId, amount) {
  if (amount <= 0) throw new Error('退款金额必须大于 0')
  return { refundId, status: 'refunded', amount }
}
