// Public surface. Consumers import from here and nowhere else, which is what
// lets the internals move without breaking callers.

export { CURRENCY, DECIMALS, MAX_AMOUNT_CENTS } from './config.mjs'
export { addMoney, formatCents, roundCents, splitEvenly } from './money.mjs'
export { applyDiscount, describeTiers, rateFor, tierFor } from './discount.mjs'
export { Ledger } from './ledger.mjs'
