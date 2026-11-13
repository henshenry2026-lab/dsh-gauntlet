/**
 * Deterministic pseudo-random source.
 *
 * Every fault the gauntlet injects has to be reproducible from one integer, so
 * a run can be replayed byte-for-byte on the same machine, on another machine,
 * in DSH or under Codex. `Math.random` cannot do that, and neither can anything
 * that reads the clock, so all randomness in this package flows through here.
 *
 * The generator is mulberry32: 32 bits of state, a handful of integer ops, and
 * a period long enough for the handful of decisions one scenario makes. It is
 * not cryptographic and must never be used for anything security-relevant.
 *
 * @module dsh-gauntlet/engine/rng
 */

/** The largest seed that still fits mulberry32's 32-bit state. */
export const MAX_SEED = 0xffffffff;

/**
 * Derive a stable 32-bit seed from a string, so `--seed silent-truncation` and
 * `--seed 12345` are both usable and neither depends on the platform.
 *
 * FNV-1a: one multiply and one xor per byte, no allocation, and the same output
 * in every JavaScript engine.
 *
 * @param {string} text - Seed text.
 * @returns {number} An unsigned 32-bit seed.
 */
export function seedFromText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  // A surviving zero would make every scenario with that seed identical.
  return (hash >>> 0) || 1;
}

/**
 * Normalize whatever the caller passed as a seed.
 *
 * Accepts an integer, a numeric string, a word, `undefined` or `null`. An
 * absent seed is *not* random: it comes from the scenario id, so "start this
 * scenario" gives the same gauntlet every time until the caller asks for a
 * different one. That default is what makes a run reproducible by accident
 * rather than only on purpose.
 *
 * @param {unknown} raw - Caller-supplied seed.
 * @param {string} fallbackText - Text to derive from when nothing was supplied.
 * @returns {number} An unsigned 32-bit seed.
 */
export function normalizeSeed(raw, fallbackText) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return (Math.trunc(raw) >>> 0) || 1;
  }
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return seedFromText(fallbackText);
  // `Number('12345')` and `Number('')` both parse; the empty case was handled.
  const numeric = Number(text);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= MAX_SEED) {
    return numeric || 1;
  }
  return seedFromText(text);
}

/**
 * A seeded generator with the small vocabulary a scenario actually needs.
 * @param {number} seed - Unsigned 32-bit seed.
 */
export function createRng(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;

  /** Next raw float in [0, 1). */
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * An integer in [min, max], inclusive on both ends.
   * @param {number} min - Lowest value.
   * @param {number} max - Highest value.
   */
  function int(min, max) {
    if (max < min) throw new RangeError(`int(${min}, ${max}) is an empty range`);
    return min + Math.floor(next() * (max - min + 1));
  }

  /**
   * One element of an array. Throws on an empty array rather than returning
   * `undefined`, because every caller here is choosing a fault target and an
   * empty list is a scenario bug, not a value to handle.
   * @template T
   * @param {readonly T[]} items - Non-empty list.
   * @returns {T}
   */
  function pick(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new RangeError('pick() needs a non-empty array');
    }
    return items[int(0, items.length - 1)];
  }

  /**
   * A shuffled copy; the input is never mutated. Fisher-Yates driven by `next`.
   * @template T
   * @param {readonly T[]} items - Source list.
   * @returns {T[]}
   */
  function shuffle(items) {
    const out = items.slice();
    for (let index = out.length - 1; index > 0; index -= 1) {
      const swap = int(0, index);
      const held = out[index];
      out[index] = out[swap];
      out[swap] = held;
    }
    return out;
  }

  /**
   * `true` with probability `p`.
   * @param {number} p - Probability in [0, 1].
   */
  function chance(p) {
    return next() < p;
  }

  /** The seed this generator was built from, echoed for the ledger. */
  function currentSeed() {
    return seed >>> 0;
  }

  return { next, int, pick, shuffle, chance, seed: currentSeed };
}
