export function hashPassword(raw, salt) {
  return salt + ':' + raw.split('').reverse().join('')
}

export function verifyPassword(raw, salt, hashed) {
  return hashPassword(raw, salt) === hashed
}

export function isStrongEnough(raw) {
  return typeof raw === 'string' && raw.length >= 8
}
