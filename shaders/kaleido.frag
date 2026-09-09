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

// @name      Kaleidoscope
// @author    ROOMTONE
// @param     slices   3.00 .. 16.00 = 6.00 "Mirror count"
// @param     zoom     0.40 .. 2.50 = 1.00  "Zoom"
// @param     churn    0.00 .. 2.00 = 0.70  "Churn"
// @feedback  true

// Mirror symmetry is one line: fold the angle into a wedge with abs() and the
// whole frame becomes a kaleidoscope. Everything else here is just something
// interesting to point it at.
//
// It samples the album cover when there is one, which is what makes this the
// most track-specific preset in the set — the same song always folds the same
// way. With no cover it falls back to a procedural weave so it never goes blank.

uniform sampler2D uPrevFrame;
uniform sampler2D uSpectrum;
uniform sampler2D uCover;
uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uBass, uMid, uHigh, uKick, uBeat, uTime, uIntensity, uWeight, uHasCover;
uniform float slices, zoom, churn;

out vec4 fragColor;

const float TAU = 6.28318530718;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float r = length(p);
  float a = atan(p.y, p.x);

  // Fold into one wedge, then mirror it. abs() is the mirror.
  float n = max(3.0, floor(slices));
  float wedge = TAU / n;
  a = mod(a + uTime * churn * 0.10, wedge);
  a = abs(a - wedge * 0.5);

  // Breathe on the bass, lurch on the kick.
  float scale = zoom * (1.0 - uBass * 0.16 - uKick * 0.06);
  vec2 q = vec2(cos(a), sin(a)) * r / max(0.15, scale);

  // Slow drift so the pattern never sits still.
  q += vec2(sin(uTime * 0.19 * churn), cos(uTime * 0.23 * churn)) * 0.18;

  vec3 src;
  if (uHasCover > 0.5) {
    src = texture(uCover, fract(q * 0.9 + 0.5)).rgb;
  } else {
    // Procedural fallback: two interfering grids read as woven glass.
    float g = sin(q.x * 14.0) * sin(q.y * 14.0)
            + sin((q.x + q.y) * 9.0 + uTime * 0.5) * 0.6;
    // Two hues woven through each other, so the fallback is stained glass
    // rather than one colour at varying brightness.
    src = mix(uArtColor2, uArtColor, g * 0.5 + 0.5) * (0.45 + 0.55 * (g * 0.5 + 0.5));
  }

  // Concentric bands carved by the spectrum: rings light up where the music is.
  float band = texture(uSpectrum, vec2(fract(r * 1.6), 0.5)).r;
  float ring = smoothstep(0.25, 1.0, band) * smoothstep(0.02, 0.10, r);

  vec3 col = src * (0.30 + band * 1.35) + uArtColor * ring * 0.45;

  // Vignette, and a bright seam along every mirror line.
  col *= smoothstep(1.05, 0.22, r);
  col += uArtColor * smoothstep(0.020, 0.0, a * r) * (0.25 + uHigh * 0.9);

  col *= uIntensity;

  // Gentle feedback: enough to smear the fold, not enough to smother the cover.
  vec3 prev = texture(uPrevFrame, uv).rgb * 0.70;
  col = max(col, prev * 0.90);

  fragColor = vec4(col * uWeight, 1.0);
}
