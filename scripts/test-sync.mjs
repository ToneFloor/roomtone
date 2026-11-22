// node scripts/test-sync.mjs
import { estimateOffset, createAutoSync } from '../src/sync.js';

let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + msg); };

function prng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lyric sheet: lines every 2-5 s with occasional instrumental gaps.
function makeLines(rnd, n = 60) {
  const out = []; let t = 5;
  for (let i = 0; i < n; i++) { out.push(t); t += 2 + rnd() * 3 + (rnd() < 0.15 ? 4 : 0); }
  return out;
}

// Log of the last `span` seconds ending at `end`, 20 Hz.
function makeLog(rnd, { starts, offset = 0, related = true, end = 120, span = 45, drums = 1.2, miss = 0.15 }) {
  const t0 = end - span, N = Math.round(span * 20);
  const d = new Float64Array(N);
  for (let i = 0; i < N; i++) d[i] = rnd() < 0.25 ? rnd() * 0.3 : 0; // background wobble
  const put = (t, a) => {
    const i = Math.round((t - t0) * 20);
    if (i >= 0 && i < N) { d[i] += a; if (i + 1 < N) d[i + 1] += a * 0.3; }
  };
  if (related) {
    for (const s of starts) {
      if (rnd() < miss) continue;
      put(s + offset + (rnd() * 2 - 1) * 0.06, 1.5 + rnd() * 2);
    }
    // sung notes inside lines (smaller)
    for (const s of starts) if (rnd() < 0.3) put(s + offset + 0.5 + rnd() * 1.5, 0.5 + rnd());
  } else {
    // unrelated vocal-like onsets
    for (let t = t0; t < end; t += 1.5 + rnd() * 3.5) put(t, 1.5 + rnd() * 2);
  }
  // drum-like onsets, louder, independent of lines
  for (let t = t0 + rnd(); t < end; t += -Math.log(1 - rnd()) / drums) put(t, 2 + rnd() * 6);
  const log = [];
  for (let i = 0; i < N; i++) log.push({ t: t0 + i / 20, d: d[i] });
  return log;
}

// ---- recovery ----
const confs = [];
for (const off of [-1.8, -0.6, 0, 0.4, 1.5]) {
  let worstErr = 0, minConf = 1, okConf = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const rnd = prng(seed * 7919 + Math.round(off * 100));
    const starts = makeLines(rnd);
    const log = makeLog(rnd, { starts, offset: off });
    const r = estimateOffset(log, starts);
    const err = r ? Math.abs(r.offset - off) : Infinity;
    worstErr = Math.max(worstErr, err);
    minConf = Math.min(minConf, r ? r.confidence : 0);
    if (r) confs.push(r.confidence);
    if (r && r.confidence >= 0.6) okConf++;
  }
  // Every estimate must be accurate; confidence must clear 0.6 in at least 4 of 6
  // seeds (the system abstains rather than guesses on the hardest draws).
  check(worstErr <= 0.08 && okConf >= 4,
    `offset ${off}: worst error ${(worstErr * 1000).toFixed(0)} ms, min confidence ${minConf.toFixed(2)}, confident ${okConf}/6`);
}

// ---- noise ----
let low = 0; const noiseConfs = [];
for (let seed = 1; seed <= 10; seed++) {
  const rnd = prng(1000 + seed);
  const starts = makeLines(rnd);
  const log = makeLog(rnd, { starts, related: false });
  const r = estimateOffset(log, starts);
  const c = r ? r.confidence : 0;
  noiseConfs.push(c);
  if (c < 0.6) low++;
}
check(low >= 9, `noise: ${low}/10 trials below 0.6 (confs ${noiseConfs.map((c) => c.toFixed(2)).join(' ')})`);

// ---- null on too little data ----
{
  const rnd = prng(5);
  const starts = makeLines(rnd);
  const short = makeLog(rnd, { starts, span: 10 });
  check(estimateOffset(short, starts) === null, 'null when log < 15 s');
  const log = makeLog(rnd, { starts });
  check(estimateOffset(log, [starts[3], starts[4], starts[5]]) === null, 'null when < 5 lines in span');
  check(estimateOffset([], starts) === null, 'null on empty log');
}

// ---- stateful helper ----
{
  const rnd = prng(42);
  const starts = makeLines(rnd);
  const mk = (off, end) => makeLog(rnd, { starts, offset: off, end });
  const s = createAutoSync();
  const a = s.feed(mk(0.8, 100), starts, 100);
  const b = s.feed(mk(0.8, 104), starts, 104);
  check(a === null, 'first estimate returns nothing');
  check(b && Math.abs(b.offset - 0.8) < 0.1 && b.confidence >= 0.6, 'second agreeing estimate returns decision');
  const c = s.feed(mk(0.8, 108), starts, 108);
  check(c === null, 'unchanged estimate does not re-fire');
  const d1 = s.feed(mk(-0.5, 112), starts, 112);
  const d2 = s.feed(mk(-0.5, 116), starts, 116);
  // log window is 45 s, so the mixed window may be unconfident for a while; feed more.
  let moved = d1 || d2;
  for (let t = 120; t <= 170 && !moved; t += 4) moved = s.feed(mk(-0.5, t), starts, t);
  check(moved && Math.abs(moved.offset + 0.5) < 0.1, 'large move is eventually reported');
  // disagreeing estimates never fire
  const s2 = createAutoSync();
  const r1 = s2.feed(mk(1.5, 100), starts, 100);
  const r2 = s2.feed(mk(-1.0, 104), starts, 104);
  check(r1 === null && r2 === null, 'two disagreeing estimates do not fire');
  s2.reset();
  check(s2.feed(mk(0.4, 108), starts, 108) === null, 'reset clears pending state');
}

console.log(`recovery confidence: min ${Math.min(...confs).toFixed(2)} mean ${(confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(2)}; noise max ${Math.max(...noiseConfs).toFixed(2)}`);
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('all passed');
