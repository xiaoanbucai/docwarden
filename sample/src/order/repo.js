/**
 * 订单仓储。上层不关心底层是内存还是数据库，只依赖这三个方法。
 */
export class OrderRepo {
  constructor(db) {
    this.db = db
  }

  nextId() {
    return 'o_' + Math.random().toString(36).slice(2, 10)
  }

  async findById(id) {
    return this.db.get('orders', id)
  }

  async save(order) {
    return this.db.put('orders', order)
  }

  async listByState(state) {
    return this.db.query('orders', { state })
  }
}
