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

// @name      Ridgeline
// @author    ROOMTONE
// @group     Club
// @param     rows     6.00 .. 16.00 = 12.00 "Row count"
// @param     height   0.30 .. 2.00 = 1.00  "Peak height"
// @param     offset   0.00 .. 2.00 = 1.00  "Row offset"
// @param     idle     0.00 .. 1.00 = 0.50  "Idle ripple"
// @feedback  false

// A spectrum landscape in the manner of a pulsar plot: rows of ridge line
// stacked up the screen, each a slightly shifted copy of the spectrum, the
// nearest rows lowest, widest in amplitude and brightest.
//
// Rows are painted back to front. Each one first fills everything beneath its
// ridge with near-black, which hides the rows behind it, and then draws the
// ridge as a thin bright line on top. That is the whole trick behind the
// occlusion; there is no depth buffer.
//
// There is no history to read a true delay from, so each row instead samples
// the spectrum at its own slowly drifting frequency offset. With no music a
// gentle travelling ripple keeps the landscape moving.

uniform sampler2D uSpectrum;
uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uBass, uKick, uTime, uIntensity, uWeight;
uniform float rows, height, offset, idle;

out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float px = 1.0 / uResolution.y;

  // 0 at the middle of the screen, 1 at either edge. Low notes sit in the
  // centre, so the tallest peaks gather there.
  float f = clamp(abs(uv.x - 0.5) * 2.0, 0.0, 1.0);
  float env = 1.0 - 0.75 * smoothstep(0.45, 1.0, f);

  // A faint backdrop so the rows have something to stand against.
  vec3 col = mix(uArtColor2, uArtColor, uv.y) * (0.03 + uBass * 0.05) * uv.y;

  float n = clamp(rows, 6.0, 16.0);

  for (float j = 0.0; j < 16.0; j += 1.0) {
    if (j >= n) break;

    // 0 = farthest row, 1 = nearest.
    float d = (j + 1.0) / n;

    // Far rows are packed close to the top, near rows spread out below.
    float baseY = 0.68 - 0.58 * d * (0.55 + 0.45 * d);
    float amp = (0.05 + 0.24 * d) * height;

    // This row's own view of the spectrum.
    float shift = offset * 0.05 * sin(j * 1.9 + uTime * 0.25);
    float fx = clamp(f * 0.80 + 0.02 + shift, 0.0, 1.0);
    float lvl = texture(uSpectrum, vec2(fx, 0.5)).r;

    // Idle ripple: a slow wave travelling outward from the centre.
    float wave = 0.5 + 0.5 * sin(f * 9.0 - uTime * 0.55 + j * 0.7);
    float level = lvl * 1.4 + idle * 0.20 * wave;

    float yr = baseY + amp * level * env;
    float dy = uv.y - yr;                       // > 0 above the ridge

    // Fill below the ridge, hiding every row behind this one.
    float fill = 1.0 - smoothstep(-px * 1.5, px * 1.5, dy);

    // Thin line. Widened where the ridge is steep, because dy is a vertical
    // distance and would otherwise thin the line out on slopes.
    float slope = abs(dFdx(yr));
    float thick = (1.1 + 1.5 * d) * px + slope * 0.6;
    float line = 1.0 - smoothstep(thick * 0.35, thick, abs(dy));

    vec3 rowCol = mix(uArtColor, uArtColor2, d);
    vec3 lineCol = mix(rowCol, vec3(1.0), 0.20 * d);

    // Nearer and louder rows are brighter. The kick lifts the lines only.
    float bright = (0.30 + 0.70 * d) * (0.65 + level * 0.70) * (1.0 + uKick * 0.9);

    col = mix(col, rowCol * 0.012, fill);
    col += lineCol * line * bright;

    // A soft light spilling just under the ridge.
    col += rowCol * fill * exp(min(dy, 0.0) * 28.0) * 0.10 * (0.4 + lvl);
  }

  col *= uIntensity;

  fragColor = vec4(col * uWeight, 1.0);
}
