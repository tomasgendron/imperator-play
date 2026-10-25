// Deterministic RNG (PLAN 7). sfc32 seeded from a text seed through cyrb128. No Math.random, Date or crypto here.
// The generator state is plain data `{algo, s:[4 uint32], draws}` that lives inside the game state, so a save resumes
// exactly and replays are reproducible. Every function that draws MUTATES the rng object it is given (the draft state's).

const U32 = 4294967296;

/** cyrb128: text -> four uint32 */
export function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** Next raw uint32 (sfc32). */
export function nextU32(rng) {
  let [a, b, c, d] = rng.s;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  rng.s = [a >>> 0, b >>> 0, c >>> 0, d >>> 0];
  rng.draws += 1;
  return t >>> 0;
}

/** New generator from a text seed (the UI creates the seed from crypto.getRandomValues; the engine never does). */
export function createRng(seed) {
  if (typeof seed !== 'string' || seed.length === 0) throw new Error('createRng: seed must be a non-empty string');
  const rng = { algo: 'sfc32', s: cyrb128(seed), draws: 0 };
  for (let i = 0; i < 15; i++) nextU32(rng);   // warm-up
  rng.draws = 0;
  return rng;
}

/** Uniform integer 1..sides by rejection sampling (no modulo bias). */
export function int(rng, sides) {
  if (!Number.isInteger(sides) || sides < 1 || sides > U32) throw new Error('int: bad number of sides ' + sides);
  const limit = U32 - (U32 % sides);
  let x;
  do { x = nextU32(rng); } while (x >= limit);
  return (x % sides) + 1;
}

/**
 * A die roll. `rigged` is the optional test queue (array of values, consumed from the front): a value is returned
 * instead of drawing, and an empty queue throws "rigged dice exhausted" so a test states exactly how many dice it uses.
 * Rigged values do not advance `rng.s` (they do count in `draws`, so `drawIndex` stays unique).
 */
export function die(rng, sides, rigged = null) {
  if (rigged) {
    if (rigged.length === 0) throw new Error('rigged dice exhausted');
    const v = rigged.shift();
    if (!Number.isInteger(v) || v < 1 || v > sides) throw new Error(`rigged die ${v} is not a d${sides}`);
    rng.draws += 1;
    return v;
  }
  return int(rng, sides);
}
export const d6 = (rng, rigged) => die(rng, 6, rigged);
export const d10 = (rng, rigged) => die(rng, 10, rigged);

/** Fisher-Yates from the end. Returns a NEW array (never rigged). */
export function shuffle(rng, array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = int(rng, i + 1) - 1;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
