/**
 * 用户资料读写。
 * 更新走 patch 合并，不做整体替换——避免调用方漏传字段导致数据被清空。
 */
export function loadProfile(uid, db) {
  return db.get('users', uid) || { uid, nickname: '', avatar: '' }
}

export function updateProfile(uid, patch, db) {
  const cur = loadProfile(uid, db)
  return { ...cur, ...patch, updatedAt: Date.now() }
}

export function removeProfile(uid, db) {
  return db.del('users', uid)
}
