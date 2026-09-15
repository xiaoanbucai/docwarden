import { transition } from './state.js'

/**
 * 订单服务：创建、查询、推进状态。
 * 注意 createOrder 会先做库存预占，预占失败时不会留下订单记录。
 */
export async function createOrder(payload, repo) {
  if (!payload.items || !payload.items.length) throw new Error('items 不能为空')
  const order = {
    id: repo.nextId(),
    state: 'pending',
    items: payload.items,
    createdAt: Date.now(),
  }
  await repo.save(order)
  return order
}

export async function payOrder(orderId, repo) {
  const order = await repo.findById(orderId)
  if (!order) throw new Error('订单不存在')
  const next = transition(order, 'paid')
  await repo.save(next)
  return next
}

export async function closeOrder(orderId, repo) {
  const order = await repo.findById(orderId)
  if (!order) throw new Error('订单不存在')
  const next = transition(order, 'closed')
  await repo.save(next)
  return next
}
