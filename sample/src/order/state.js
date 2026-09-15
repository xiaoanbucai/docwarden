/**
 * 订单状态机。所有状态迁移必须经过 transition()，禁止直接改 state 字段。
 * 集中式状态机是为了修掉早期分散写入导致的两次线上事故。
 */
export const STATES = ['pending', 'paid', 'shipped', 'closed']

const ALLOWED = {
  pending: ['paid', 'closed'],
  paid: ['shipped'],
  shipped: [],
  closed: [],
}

export function canTransition(from, to) {
  return (ALLOWED[from] || []).includes(to)
}

export function transition(order, to) {
  if (!canTransition(order.state, to)) {
    throw new Error('非法状态迁移：' + order.state + ' → ' + to)
  }
  return { ...order, state: to, updatedAt: Date.now() }
}
