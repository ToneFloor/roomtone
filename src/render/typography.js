// ROOMTONE — audio-reactive room lighting for Windows.
// Copyright (C) 2026 Robin
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, version 3.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
// more details. You should have received a copy of the licence along with
// this program. If not, see <https://www.gnu.org/licenses/>.

// The video-edit preset: lyric typography.
//
// The reference is the kinetic-typography lyric edit — big condensed caps,
// hard cuts on the beat, the frame reframing itself constantly. What makes
// those edits work is not any single effect, it is that **no two lines are
// composed the same way**. Repetition is the thing to avoid; the eye stops
// looking the moment it can predict where the next word will be.
//
// So a line does not get styled, it gets *cast*: a shot is chosen from a
// deterministic hash of the line, which means the same line always looks the
// same (no flicker between frames) while consecutive lines rarely match.
//
// Rows are built at runtime rather than bound in the template, because a shot
// may want one enormous word or six stacked ones and the count changes per line.

/** Nine-grid anchors. The whole screen is in play, not just the lower third. */
const ANCHORS = {
  tl: [0.06, 0.16, 'left', 'top'],
  tc: [0.50, 0.16, 'center', 'top'],
  tr: [0.94, 0.16, 'right', 'top'],
  ml: [0.07, 0.50, 'left', 'middle'],
  c:  [0.50, 0.50, 'center', 'middle'],
  mr: [0.93, 0.50, 'right', 'middle'],
  bl: [0.06, 0.84, 'left', 'bottom'],
  bc: [0.50, 0.86, 'center', 'bottom'],
  br: [0.94, 0.84, 'right', 'bottom'],
};

/**
 * The shot list.
 *
 * `fill` is the fraction of the screen width the widest row should occupy —
 * this is what makes type actually use the frame instead of floating in the
 * middle of it. `mode` decides how many words are on screen at once.
 */
const SHOTS = [
  { id: 'hero',      anchor: 'c',  fill: 0.88, mode: 'solo',   treat: 'solid',    tilt: 0,    weight: 3 },
  { id: 'hero-left', anchor: 'ml', fill: 0.74, mode: 'solo',   treat: 'solid',    tilt: 0,    weight: 2 },
  { id: 'knockout',  anchor: 'c',  fill: 0.95, mode: 'solo',   treat: 'knockout', tilt: 0,    weight: 2 },
  { id: 'outline',   anchor: 'c',  fill: 0.82, mode: 'solo',   treat: 'outline',  tilt: 0,    weight: 2 },
  { id: 'stack-bl',  anchor: 'bl', fill: 0.58, mode: 'stack2', treat: 'solid',    tilt: 0,    weight: 3 },
  { id: 'stack-tr',  anchor: 'tr', fill: 0.54, mode: 'stack2', treat: 'solid',    tilt: 0,    weight: 2 },
  { id: 'boxed',     anchor: 'bl', fill: 0.50, mode: 'stack1', treat: 'box',      tilt: 0,    weight: 2 },
  { id: 'tilt-l',    anchor: 'ml', fill: 0.68, mode: 'stack2', treat: 'solid',    tilt: -4,   weight: 1 },
  { id: 'tilt-r',    anchor: 'mr', fill: 0.68, mode: 'stack2', treat: 'solid',    tilt: 4,    weight: 1 },
  { id: 'wall',      anchor: 'c',  fill: 0.94, mode: 'wrap',   treat: 'solid',    tilt: 0,    weight: 3 },
  { id: 'corner-tl', anchor: 'tl', fill: 0.50, mode: 'stack3', treat: 'solid',    tilt: 0,    weight: 1 },
  { id: 'corner-br', anchor: 'br', fill: 0.50, mode: 'stack3', treat: 'outline',  tilt: 0,    weight: 1 },
  { id: 'spine',     anchor: 'mr', fill: 0.34, mode: 'solo',   treat: 'solid',    tilt: 90,   weight: 1 },
  { id: 'ticker',    anchor: 'bc', fill: 0.90, mode: 'wrap',   treat: 'box',      tilt: 0,    weight: 1 },
];

const BAG = SHOTS.flatMap((shot) => Array(shot.weight).fill(shot));

/** Deterministic hash, so a line's shot never changes mid-line. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export class Typography {
  constructor() {
    this.stack = null;
    this.rows = [];
    this.lastKey = '';
    this.cutAt = -1;
    this.shot = SHOTS[0];
    this.fit = 1;
    this.fitKey = '';
    this.spots = [];
  }

  /** Rebuild the row pool. Called when the DOM was re-rendered under us. */
  attach(stack) {
    if (this.stack === stack) return;
    this.stack = stack;
    this.rows = [];
    if (stack) stack.replaceChildren();
  }

  rowPool(count) {
    while (this.rows.length < count) {
      const el = document.createElement('div');
      el.setAttribute('data-r', 'erow');
      el.style.cssText =
        "font-family:'Anton',Impact,sans-serif;line-height:0.86;text-transform:uppercase;" +
        'white-space:nowrap;color:#fff;will-change:transform,filter';
      this.stack.appendChild(el);
      this.rows.push(el);
    }
    for (let i = 0; i < this.rows.length; i++) {
      this.rows[i].style.display = i < count ? 'block' : 'none';
    }
    return this.rows.slice(0, count);
  }

  /**
   * Compose the rows for a line.
   *
   * `solo` shows only the word being sung; the stacks accumulate the line as it
   * is delivered; `wrap` lays the whole line out and lights the current word.
   */
  compose(line, wordIndex, shot) {
    const words = line.words.length
      ? line.words.map((w) => w.w)
      : line.text.split(/\s+/).filter(Boolean);

    const upper = words.map((w) => w.toUpperCase());
    const current = upper[wordIndex] || '';

    if (shot.mode === 'solo') return { rows: [current], active: 0 };

    if (shot.mode === 'wrap') {
      const per = upper.length > 8 ? 3 : 2;
      const rows = [];
      let active = 0;
      for (let i = 0; i < upper.length; i += per) {
        if (wordIndex >= i && wordIndex < i + per) active = rows.length;
        rows.push(upper.slice(i, i + per).join(' '));
      }
      return { rows, active };
    }

    const per = shot.mode === 'stack1' ? 1 : shot.mode === 'stack3' ? 3 : 2;
    const rows = [];
    for (let i = 0; i <= wordIndex; i += per) {
      rows.push(upper.slice(i, i + per).join(' '));
    }
    const trimmed = rows.slice(-4);
    return { rows: trimmed, active: trimmed.length - 1 };
  }

  /**
   * @param n     the app's cached node lists
   * @param ctx   { line, lineIndex, wordIndex, now, kick, bass, energy,
   *                accent, cfg, intensity, padB }
   */
  frame(n, ctx) {
    const stack = (n.editStack || [])[0];
    if (!stack) return;
    this.attach(stack);

    const { line, lineIndex, wordIndex, now } = ctx;
    const key = `${lineIndex}:${wordIndex}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.cutAt = now;
      // Re-cast the shot on a new line, not on every word — a line should hold
      // its composition while it is being delivered.
      if (key.split(':')[0] !== this.lastLine) {
        this.lastLine = key.split(':')[0];
        const roll = hash(`${lineIndex}|${line.text}`);
        this.shot = BAG[Math.floor(roll * BAG.length) % BAG.length];
        this.spots = this.scatter(roll);
      }
    }

    const shot = this.shot;
    const W = window.innerWidth, H = window.innerHeight;

    // The cut: a hard displacement that resolves in 150ms. This is the single
    // thing that makes an edit read as *edited* rather than animated.
    const since = (now - this.cutAt) / 1000;
    const cut = Math.max(0, 1 - since / 0.15) * (ctx.cfg.cuts ?? 1);
    const punch = Math.max(ctx.kick, ctx.bass * 0.65);

    const { rows, active } = this.compose(line, wordIndex, shot);
    const els = this.rowPool(rows.length);

    // Chromatic split — grows on the beat and on every cut.
    const split = (punch * 2.2 + cut * 5.0) * (ctx.cfg.rgb ?? 1);
    const fringe = split > 0.4
      ? `${-split}px 0 0 rgba(255,0,92,0.72),${split}px 0 0 rgba(0,238,255,0.72),`
      : '';

    const base = W * 0.06;

    els.forEach((el, i) => {
      el.textContent = rows[i] || '';
      el.style.fontSize = `${base}px`;
      el.style.letterSpacing = shot.treat === 'box' ? '0.01em' : '-0.015em';
      el.style.textAlign = ANCHORS[shot.anchor][2];

      const isActive = i === active;
      const dim = shot.mode === 'solo' ? 1 : isActive ? 1 : 0.32;

      if (shot.treat === 'knockout') {
        // White type through a difference blend: the artwork behind decides the
        // colour, which is why this one never looks like the others.
        el.style.color = '#fff';
        el.style.mixBlendMode = 'difference';
        el.style.webkitTextStroke = '';
        el.style.background = 'transparent';
        el.style.padding = '0';
      } else if (shot.treat === 'outline') {
        el.style.color = isActive ? '#fff' : 'transparent';
        el.style.webkitTextStroke = `2px rgba(255,255,255,${dim})`;
        el.style.mixBlendMode = 'normal';
        el.style.background = 'transparent';
        el.style.padding = '0';
      } else if (shot.treat === 'box') {
        el.style.color = '#0a0a0a';
        el.style.background = isActive ? '#fff' : 'rgba(255,255,255,0.30)';
        el.style.padding = '0.04em 0.16em 0.10em';
        el.style.webkitTextStroke = '';
        el.style.mixBlendMode = 'normal';
        el.style.marginLeft = `${(i % 3) * 0.14}em`;
      } else {
        el.style.color = `rgba(255,255,255,${dim})`;
        el.style.webkitTextStroke = '';
        el.style.mixBlendMode = 'normal';
        el.style.background = 'transparent';
        el.style.padding = '0';
      }

      el.style.textShadow = shot.treat === 'box'
        ? 'none'
        : `${fringe}0 ${2 + punch * 4}px ${18 + punch * 34}px rgba(0,0,0,0.55)`;

      // Only the row being sung takes the cut. The rest hold still, which is
      // what keeps a busy frame readable.
      const jolt = isActive ? cut : cut * 0.25;
      const dx = jolt * (i % 2 ? -14 : 11);
      const dy = jolt * (i % 2 ? 9 : -9);
      const pop = isActive ? 1 + punch * 0.035 + cut * 0.08 : 1;
      el.style.filter = `blur(${jolt * 4.5}px)`;
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${pop})`;
      el.style.alignSelf = ANCHORS[shot.anchor][2] === 'right'
        ? 'flex-end'
        : ANCHORS[shot.anchor][2] === 'center' ? 'center' : 'flex-start';
    });

    // Fit: scale the block so the widest row reaches the shot's fill width.
    const fitKey = `${rows.join('|')}@${Math.round(base)}/${shot.id}/${W}x${H}`;
    if (fitKey !== this.fitKey) {
      this.fitKey = fitKey;
      let widest = 1;
      els.forEach((el) => { if (el.textContent) widest = Math.max(widest, el.scrollWidth); });
      const byWidth = (W * shot.fill) / widest;
      const byHeight = (H * (shot.mode === 'solo' ? 0.34 : 0.52)) / Math.max(1, rows.length * base * 0.92);
      this.fit = Math.max(0.22, Math.min(byWidth, byHeight, 4.0));
    }

    const [ax, ay, hAlign, vAlign] = ANCHORS[shot.anchor];
    const originX = hAlign === 'right' ? '100%' : hAlign === 'center' ? '50%' : '0%';
    const originY = vAlign === 'bottom' ? '100%' : vAlign === 'middle' ? '50%' : '0%';
    const shiftX = hAlign === 'right' ? '-100%' : hAlign === 'center' ? '-50%' : '0%';
    const shiftY = vAlign === 'bottom' ? '-100%' : vAlign === 'middle' ? '-50%' : '0%';

    stack.style.left = `${ax * 100}%`;
    stack.style.top = `${ay * 100}%`;
    stack.style.right = 'auto';
    stack.style.bottom = 'auto';
    stack.style.transformOrigin = `${originX} ${originY}`;
    stack.style.alignItems = hAlign === 'right' ? 'flex-end' : hAlign === 'center' ? 'center' : 'flex-start';
    stack.style.transform =
      `translate(${shiftX}, ${shiftY}) rotate(${shot.tilt}deg) scale(${this.fit})`;

    // Scattered word echoes, placed per line rather than in fixed slots.
    const echoCount = Math.round(ctx.cfg.echo ?? 5);
    const word = (line.words[wordIndex] && line.words[wordIndex].w) || '';
    (n.echo || []).forEach((el, i) => {
      const spot = this.spots[i] || [50, 50];
      const live = word && i < Math.min(echoCount, Math.round((0.35 + punch) * echoCount));
      el.textContent = word.toUpperCase();
      el.style.left = `${spot[0]}%`;
      el.style.top = `${spot[1]}%`;
      el.style.opacity = String(live ? Math.max(0, 0.55 - i * 0.06) : 0);
      el.style.transform = `rotate(${spot[2]}deg) scale(${1 + punch * 0.08})`;
      el.style.filter = `blur(${cut * 2.4}px)`;
    });

    // Background: the frame itself breathes and re-grades on the beat.
    (n.editStage || []).forEach((el) => {
      el.style.transform = `rotate(${punch * 0.2 - cut * 0.35}deg) scale(${1 + cut * 0.012})`;
      el.style.filter = `blur(${cut * 2.0}px)`;
    });
    (n.editArt || []).forEach((el) => {
      el.style.filter =
        `blur(${14 + (1 - punch) * 12}px) saturate(${1.05 + punch * 0.45}) brightness(${0.62 + punch * 0.3})`;
      el.style.transform = `scale(${1.08 + punch * 0.05 + cut * 0.02})`;
    });
    (n.editArtTex || []).forEach((el) => { el.style.opacity = String(0.22 + punch * 0.3); });
    (n.editBg || []).forEach((el) => { el.style.opacity = String(0.44 + punch * 0.2); });
    (n.editScan || []).forEach((el) => { el.style.opacity = String(0.28 + cut * 0.45); });
    (n.editMeta || []).forEach((el) => { el.style.opacity = String(0.4 + punch * 0.4); });
  }

  /** Echo positions, spread around the frame and away from dead centre. */
  scatter(seed) {
    const out = [];
    let s = seed;
    for (let i = 0; i < 8; i++) {
      s = (s * 9301 + 0.49297) % 1;
      const x = 6 + s * 84;
      s = (s * 4177 + 0.31721) % 1;
      const y = 8 + s * 80;
      s = (s * 7919 + 0.11111) % 1;
      const rot = (s - 0.5) * 24;
      // Keep them out of the middle, where the headline lives.
      const pushed = Math.abs(x - 50) < 14 ? x + (x < 50 ? -18 : 18) : x;
      out.push([pushed, y, rot]);
    }
    return out;
  }
}
