// Automatic lyric-offset estimation from a vocal-band onset log.
//
// SIGN CONVENTION (same as `best` in App.autoAlign): the returned `offset` is
// the lag in seconds such that a line the sheet places at time t is actually
// sung at t + offset. Positive = the sheet is early (audio comes later).
// (autoAlign stores trackOffset = -best * 1000, i.e. the negated lag in ms.)
// `lineStarts` must be the RAW sheet times, not times already shifted by a
// previously applied offset; `log[].t` is track position in seconds.
//
// Pure functions, no imports, no DOM.

const DT = 0.025;          // envelope resolution (s)
const SIGMA = 0.04;        // envelope smoothing (s)
const LAG_STEP = 0.025;    // lag search resolution (s)
const WIN = 0.12;          // half window around a line to look for its onset (s)
const WIN_SIGMA = 0.06;    // tolerance weighting inside that window (s)

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

function median(arr) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length & 1 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/**
 * Estimate the global lyric offset.
 * @param {{t:number,d:number}[]} log  onset samples (~20 Hz)
 * @param {number[]} lineStarts        raw line start times (s)
 * @param {object} [opts]
 * @returns {{offset:number, confidence:number, score:number, used:number}|null}
 */
export function estimateOffset(log, lineStarts, opts = {}) {
  const max = opts.max ?? 2.5;
  const minSpan = opts.minSpan ?? 15;
  const minLines = opts.minLines ?? 5;
  if (!Array.isArray(log) || log.length < 2 || !Array.isArray(lineStarts)) return null;

  const samples = log
    .filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.d))
    .map((s) => ({ t: s.t, d: Math.max(0, s.d) }))
    .sort((a, b) => a.t - b.t);
  if (samples.length < 2) return null;
  const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
  if (t1 - t0 < minSpan) return null;

  // Lines whose whole search window (start + lag +- window) can be seen.
  const sorted = lineStarts.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const lo = t0 + WIN, hi = t1 - WIN;
  const lines = [];
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    // Count lines whose centre is inside the logged span; edge lines are
    // handled below by treating unseen regions as empty (score 0).
    if (t < t0 || t > t1) continue;
    const gap = i > 0 ? t - sorted[i - 1] : Infinity;
    lines.push({ t, w: gap > 1.5 ? 2 : 1 });
  }
  if (lines.length < minLines) return null;

  // ---- 1. normalise: divide by a local mean (+ floor), clip outliers ------
  const n = samples.length;
  const globalMean = samples.reduce((a, s) => a + s.d, 0) / n;
  const globalMed = median(samples.map((s) => s.d).filter((d) => d > 0));
  const floor = Math.max(1e-9, 0.25 * Math.max(globalMean, 0.5 * globalMed));
  if (globalMean <= 1e-9) return null;
  const R = 5; // seconds either side for the local level
  const norm = new Float64Array(n);
  {
    let a = 0, b = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      while (b < n && samples[b].t <= samples[i].t + R) sum += samples[b++].d;
      while (a < n && samples[a].t < samples[i].t - R) sum -= samples[a++].d;
      const local = sum / Math.max(1, b - a);
      norm[i] = Math.min(2.5, samples[i].d / (local + floor));
    }
  }

  // ---- 2. envelope on a fine grid, lightly smoothed ----------------------
  const G = Math.ceil((t1 - t0) / DT) + 1;
  const env = new Float64Array(G);
  const rad = Math.ceil((3 * SIGMA) / DT);
  const kern = [];
  for (let k = -rad; k <= rad; k++) kern.push(Math.exp(-0.5 * (k * DT / SIGMA) ** 2));
  for (let i = 0; i < n; i++) {
    if (norm[i] <= 0) continue;
    const c = Math.round((samples[i].t - t0) / DT);
    for (let k = -rad; k <= rad; k++) {
      const j = c + k;
      if (j >= 0 && j < G) env[j] = Math.max(env[j], norm[i] * kern[k + rad]);
    }
  }
  // Remove the mean level so that a dense region does not out-score a sparse
  // one just by being busy; what matters is excess at the line starts.
  let em = 0;
  for (let j = 0; j < G; j++) em += env[j];
  em /= G;

  // ---- 3. score each lag --------------------------------------------------
  const nLag = Math.round((2 * max) / LAG_STEP) + 1;
  const lags = new Float64Array(nLag);
  const scores = new Float64Array(nLag);
  const wsum = lines.reduce((a, l) => a + l.w, 0);
  const wr = Math.ceil(WIN / DT);
  const wk = [];
  for (let k = -wr; k <= wr; k++) wk.push(Math.exp(-0.5 * (k * DT / WIN_SIGMA) ** 2));
  for (let li = 0; li < nLag; li++) {
    const lag = -max + li * LAG_STEP;
    lags[li] = lag;
    let s = 0, vis = 0;
    for (const L of lines) {
      const c = Math.round((L.t + lag - t0) / DT);
      if (c < wr || c >= G - wr) continue; // onset not observable at this lag
      vis += L.w;
      let best = 0; // each line counted once: best weighted onset near it
      for (let k = -wr; k <= wr; k++) {
        const j = c + k;
        if (j < 0 || j >= G) continue;
        const v = (env[j] - em) * wk[k + wr];
        if (v > best) best = v;
      }
      s += L.w * best;
    }
    scores[li] = vis > 0 ? (s / vis) * Math.sqrt(vis / wsum) : 0;
  }

  // ---- 4. pick the peak (prefer small offsets on near-ties) --------------
  let mean = 0;
  for (let i = 0; i < nLag; i++) mean += scores[i];
  mean /= nLag;
  let sd = 0;
  for (let i = 0; i < nLag; i++) sd += (scores[i] - mean) ** 2;
  sd = Math.sqrt(sd / nLag) || 1e-9;
  let rawMax = -Infinity;
  for (let i = 0; i < nLag; i++) rawMax = Math.max(rawMax, scores[i]);
  if (!(rawMax > mean)) return null;
  const tiePenalty = 0.03 * (rawMax - mean) / max; // per second of |lag|
  let pi = 0, pv = -Infinity;
  for (let i = 0; i < nLag; i++) {
    const adj = scores[i] - tiePenalty * Math.abs(lags[i]);
    if (adj > pv) { pv = adj; pi = i; }
  }

  // Parabolic refinement.
  let offset = lags[pi];
  if (pi > 0 && pi < nLag - 1) {
    const a = scores[pi - 1], b = scores[pi], c = scores[pi + 1];
    const den = a - 2 * b + c;
    if (den < 0) offset += clamp(0.5 * (a - c) / den, -1, 1) * LAG_STEP;
  }
  const peak = scores[pi];

  // ---- 5. confidence ------------------------------------------------------
  const z = (peak - mean) / sd;
  // Best competing peak at least 300 ms away.
  const away = Math.round(0.3 / LAG_STEP);
  let rival = -Infinity;
  for (let i = 0; i < nLag; i++) {
    if (Math.abs(i - pi) >= away && scores[i] > rival) rival = scores[i];
  }
  const margin = rival === -Infinity ? 1 : (peak - rival) / Math.max(1e-9, peak - mean);
  const zc = clamp((z - 2.7) / 0.9, 0, 1);
  const mc = clamp(margin / 0.25, 0, 1);
  let confidence = zc * mc;
  // Edge penalty: a peak at the edge of the window is probably a slope of a
  // peak that lies outside it.
  const edge = Math.min(pi, nLag - 1 - pi) * LAG_STEP;
  if (edge < 0.25) confidence *= clamp(edge / 0.25, 0, 1);
  // Few lines = weak evidence.
  confidence *= clamp((lines.length - 2) / 8, 0.4, 1);

  return {
    offset,
    confidence: clamp(confidence, 0, 1),
    score: peak,
    used: lines.length,
  };
}

/**
 * Stateful wrapper: call feed() every few seconds. Returns a decision only
 * after two consecutive confident estimates agree, and again only when the
 * agreed value moves by more than `move` seconds.
 */
export function createAutoSync(opts = {}) {
  const threshold = opts.threshold ?? 0.6;
  const agree = opts.agree ?? 0.12;
  const move = opts.move ?? 0.15;
  const stale = opts.stale ?? 30; // s between feeds before a pending estimate is dropped
  let pending = null;   // { offset, confidence, now }
  let applied = null;   // last returned offset

  return {
    feed(log, lineStarts, now = 0) {
      const est = estimateOffset(log, lineStarts, opts);
      if (!est || est.confidence < threshold) { pending = null; return null; }
      const prev = pending;
      pending = { offset: est.offset, confidence: est.confidence, now };
      if (!prev || now - prev.now > stale || Math.abs(prev.offset - est.offset) > agree) return null;
      const offset = 0.5 * (prev.offset + est.offset);
      const confidence = Math.min(prev.confidence, est.confidence);
      if (applied !== null && Math.abs(offset - applied) <= move) return null;
      applied = offset;
      return { offset, confidence };
    },
    reset() { pending = null; applied = null; },
  };
}
