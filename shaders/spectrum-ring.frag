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

// @name      Spectrum Ring
// @author    ROOMTONE
// @param     radius   0.15 .. 0.60 = 0.30  "Ring radius"
// @param     depth    0.20 .. 2.00 = 1.00  "Bar depth"
// @param     spin     -2.00 .. 2.00 = 0.35 "Spin speed"
// @feedback  true

// The clearest demonstration of why the spectrum arrives as a texture rather
// than as three numbers: every angle around the ring samples a different
// frequency. With three scalars this preset could not exist.

uniform sampler2D uPrevFrame;
uniform sampler2D uSpectrum;
uniform vec2  uResolution;
uniform vec3  uArtColor;
uniform float uBass, uMid, uHigh, uKick, uBeat, uTime, uIntensity, uWeight;
uniform float radius, depth, spin;

out vec4 fragColor;

const float TAU = 6.28318530718;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float r = length(p);
  float a = atan(p.y, p.x) / TAU + 0.5;

  // Mirror the ring so the spectrum reads outward from the bottom both ways,
  // which is far more legible than one continuous sweep.
  float sa = fract(a + uTime * spin * 0.05);
  float f = abs(sa * 2.0 - 1.0);

  float mag = texture(uSpectrum, vec2(f, 0.5)).r;

  float base = radius * (1.0 + uKick * 0.05);
  float bar = base + mag * 0.22 * depth;

  // The ring itself.
  float band = smoothstep(bar, bar - 0.012, r) * smoothstep(base - 0.02, base, r);

  // A soft halo that breathes with the low end.
  float halo = exp(-pow((r - base) * 7.0, 2.0)) * (0.25 + uBass * 0.85);

  vec3 col = uArtColor * (band * (0.5 + mag * 1.4) + halo) * uIntensity;

  // Highs sparkle on the outer rim.
  col += vec3(1.0) * band * uHigh * 0.35 * uIntensity;

  vec3 prev = texture(uPrevFrame, uv).rgb * 0.90;
  col = max(col, prev * 0.90);

  fragColor = vec4(col * uWeight, 1.0);
}
