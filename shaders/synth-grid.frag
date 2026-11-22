#version 300 es
precision highp float;

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

// @name      Synth Grid
// @author    ROOMTONE
// @group     Club
// @param     speed    0.10 .. 3.00 = 1.00  "Scroll speed"
// @param     sun      0.30 .. 1.60 = 1.00  "Sun size"
// @param     bands    0.00 .. 1.00 = 0.70  "Sun banding"
// @param     glow     0.00 .. 2.00 = 1.00  "Horizon glow"
// @feedback  false

// A retro perspective floor running out to a horizon, with a low sun sitting on
// it. No geometry: below the horizon, 1/height is distance, so a handful of
// fract() calls give grid lines that converge on the vanishing point and rush
// toward the viewer.
//
// The floor scrolls on the clock plus the detected tempo, so it never stops in
// silence but follows the song when there is one. The kick only ever lights the
// lines themselves, never the whole frame, and the horizon glow breathes with
// the bass. The sun is cut into stripes whose gaps close as their slice of the
// spectrum gets louder.

uniform sampler2D uSpectrum;
uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uBass, uKick, uBeat, uTime, uIntensity, uWeight;
uniform float speed, sun, bands, glow;

out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  float px = 1.0 / uResolution.y;

  const float HORIZON = 0.42;

  // Frame is 1 tall and `aspect` wide, centred on x = 0.
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);

  float below = HORIZON - uv.y;           // > 0 on the floor
  float b = max(below, 0.004);            // never divide by ~0 at the horizon
  float onFloor = smoothstep(-px, px, below);

  vec3 midCol = mix(uArtColor, uArtColor2, 0.5);

  // Horizon glow level. Slow idle breathing keeps it alive in silence.
  float breathe = glow * (0.30 + uBass * 0.85 + 0.08 * sin(uTime * 0.6));

  // ---- Floor ---------------------------------------------------------------

  // Distance travelled, wrapped so float precision never drifts on long runs.
  float travel = fract((uTime * 0.25 + uBeat * 0.25) * speed);

  // Lines across the floor: depth is 1/b. Adding travel moves them toward us.
  float gz = 0.45 / b + travel;
  float lz = abs(fract(gz + 0.5) - 0.5);                  // distance to a line
  float fz = min(0.45 / (b * b) * px * 1.2, 0.3);         // ~1.2 px, in cycles
  float lineZ = 1.0 - smoothstep(fz * 0.4, fz * 1.4, lz);

  // Lines running away to the horizon: lateral position scales with 1/b.
  float gx = p.x / b * 2.0;
  float lx = abs(fract(gx + 0.5) - 0.5);
  float fx = min(2.4 * px / b, 0.3);
  float lineX = 1.0 - smoothstep(fx * 0.4, fx * 1.4, lx);

  // Lines melt into the horizon rather than aliasing there.
  float fade = smoothstep(0.015, 0.14, below);
  float lines = max(lineZ, lineX) * fade;

  // One spectrum fetch for the floor: low notes near the middle, highs outward.
  float sx = clamp(abs(uv.x - 0.5) * 2.0, 0.0, 1.0);
  float spec = texture(uSpectrum, vec2(sx * 0.85 + 0.02, 0.5)).r;

  float nearness = clamp(b / HORIZON, 0.0, 1.0);          // 0 far .. 1 near
  vec3 lineCol = mix(uArtColor, uArtColor2, nearness);
  float lineGain = 0.55 + spec * 0.9 + uKick * 1.1;

  vec3 floorCol = lineCol * lines * lineGain;
  floorCol += vec3(1.0) * lines * uKick * 0.25;           // kick: lines only
  floorCol += midCol * exp(-b * 9.0) * breathe * 0.45;    // glow on the ground

  // ---- Sky and sun ---------------------------------------------------------

  float aboveD = max(uv.y - HORIZON, 0.0);
  vec3 sky = midCol * exp(-aboveD * 7.0) * breathe * 0.45;

  float sunR = 0.17 * sun;
  vec2 sunC = vec2(0.0, HORIZON + sunR * 0.55);
  float d = length(p - sunC);

  float disc = 1.0 - smoothstep(sunR - px * 1.5, sunR, d);

  // 0 at the bottom of the disc, 1 at the top.
  float ys = clamp((uv.y - (sunC.y - sunR)) / (2.0 * sunR), 0.0, 1.0);

  // Eight stripes, each reading its own slice of the spectrum. Gaps are widest
  // at the bottom and shrink as that slice gets louder.
  float cells = 8.0;
  float cellId = min(floor(ys * cells), cells - 1.0);
  float lvl = texture(uSpectrum, vec2(0.04 + (cellId + 0.5) / cells * 0.7, 0.5)).r;
  float gap = bands * (1.0 - ys) * 0.6 * (1.0 - 0.85 * lvl);
  float vis = smoothstep(gap - 0.08, gap, fract(ys * cells));

  vec3 sunCol = mix(uArtColor2, uArtColor, ys);
  sunCol = mix(sunCol, vec3(1.0), 0.25 * ys);

  sky += sunCol * disc * vis * (0.95 + uBass * 0.30);
  sky += sunCol * exp(-max(d - sunR, 0.0) * 7.0) * (0.12 + uBass * 0.25) * glow;

  // ---- Combine -------------------------------------------------------------

  vec3 col = mix(sky, floorCol, onFloor);

  // The horizon itself: a thin hot line that swells with the bass.
  float dh = abs(uv.y - HORIZON);
  col += mix(midCol, vec3(1.0), 0.4) * exp(-dh * 260.0) * breathe * (0.7 + uKick * 0.5);

  col *= uIntensity;

  fragColor = vec4(col * uWeight, 1.0);
}
