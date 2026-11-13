// Integer-cent arithmetic. Nothing here allocates or rounds implicitly: a
// caller that passes a fraction gets an error, not a silently rounded total.

import { DECIMALS, MAX_AMOUNT_CENTS } from './config.mjs'

function assertInteger(value, name) {
  if (!Number.isInteger(value)) throw new TypeError(name + ' must be an integer number of cents')
}

export function roundCents(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('value must be a number')
  }
  if (!Number.isFinite(value)) throw new TypeError('value must be finite')
  if (Math.abs(value) > MAX_AMOUNT_CENTS) throw new RangeError('value exceeds the maximum amount')
  return Math.sign(value) * Math.round(Math.abs(value))
}

export function addMoney(...amounts) {
  let total = 0
  for (const amount of amounts) {
    assertInteger(amount, 'amount')
    total += amount
  }
  return total
}

export function formatCents(cents) {
  assertInteger(cents, 'cents')
  const sign = cents < 0 ? '-' : ''
  const absolute = Math.abs(cents)
  const whole = Math.trunc(absolute / 100)
  const fraction = String(absolute % 100).padStart(DECIMALS, '0')
  return sign + '$' + whole + '.' + fraction
}

export function splitEvenly(total, parts) {
  assertInteger(total, 'total')
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError('parts must be a positive integer')
  }
  const base = Math.trunc(total / parts)
  const remainder = total - base * parts
  const shares = []
  for (let index = 0; index < parts; index += 1) {
    shares.push(base + (index < remainder ? 1 : 0))
  }
  return shares
}
