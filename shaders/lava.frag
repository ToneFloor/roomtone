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

// @name      Lava Lamp
// @author    ROOMTONE
// @group     Ambient
// @param     blobs  5.00 .. 7.00 = 6.00  "Blob count"
// @param     rise   0.00 .. 2.00 = 0.70  "Rise speed"
// @param     glow   0.00 .. 2.00 = 1.00  "Inner glow"
// @feedback  false

// A lava lamp: soft blobs drift up and down the glass, merge with each other
// and with a pool at the bottom and a cap at the top. The surface is an
// iso-line of a sum of compact smooth kernels, so edges are soft and merging
// is a gentle bulge, never a hard overlap.
//
// Blobs are tinted by height: the lead album colour low, the second one high.
// Bass swells the blobs slowly; there are no flashes. Motion runs on the clock,
// so silence still looks alive. No feedback — the soft edge is the whole look.

uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uBass, uTime, uIntensity, uWeight;
uniform float blobs, rise, glow;

out vec4 fragColor;

// Compact smooth kernel: 1 at the centre, exactly 0 at distance R, no long
// tail, so far-apart blobs never haze the space between them.
float kernel(vec2 d, float R) {
  float q = clamp(1.0 - dot(d, d) / (R * R), 0.0, 1.0);
  return q * q * q;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float t = uTime * rise;
  float n = clamp(blobs, 5.0, 7.0);
  float swell = 1.0 + 0.16 * uBass;

  // Iso level of the surface. A lone blob of visible radius rv has kernel
  // radius R = rv * 1.84 (the kernel is 0.35 at 0.543 R).
  float iso = 0.35;

  float field = 0.0;
  for (float i = 0.0; i < 7.0; i += 1.0) {
    if (i >= n) break;

    // Each blob rises and sinks on its own slow period (roughly 20-45 s) and
    // wanders sideways on another, so the cluster never repeats.
    vec2 c = vec2(
      sin(t * (0.13 + 0.029 * i) + i * 3.1) * (0.07 + 0.06 * aspect),
      sin(t * (0.21 + 0.037 * i) + i * 2.39) * (0.30 + 0.02 * i)
    );

    float rv = (0.09 + 0.04 * fract(i * 0.618 + 0.2))
             * swell
             * (1.0 + 0.07 * sin(t * 0.4 + i * 1.9));
    field += kernel(p - c, rv * 1.84);
  }

  // Pool at the bottom and a cooler cap at the top, stretched wide so they
  // read as the lamp's reservoirs. Blobs bulge into them and pinch off.
  vec2 pd = vec2(p.x / aspect * 0.47, p.y + 0.58 + 0.03 * sin(t * 0.3));
  vec2 cd = vec2(p.x / aspect * 0.47, p.y - 0.60 + 0.03 * sin(t * 0.25 + 1.0));
  field += kernel(pd, 0.30 * swell);
  field += kernel(cd, 0.26 * swell);

  // Soft iso edge, and how deep inside the surface this pixel is.
  float mass = smoothstep(iso - 0.03, iso + 0.05, field);
  float depth = smoothstep(0.0, 1.0, clamp((field - iso) / (1.0 - iso), 0.0, 1.0));

  // Two art colours blended by height.
  float h = smoothstep(-0.45, 0.45, p.y);
  vec3 base = mix(uArtColor, uArtColor2, h);

  // Body, brighter toward the middle of each blob (the inner glow).
  vec3 col = base * mass * (0.42 + 0.75 * glow * depth);

  // A faint halo just outside the surface.
  float outside = clamp(field / iso, 0.0, 1.0);
  col += base * (outside * outside) * (1.0 - mass) * 0.22 * glow;

  // The glass behind: dim, warmer toward the bottom, never flat black.
  vec3 bg = mix(uArtColor, uArtColor2, uv.y) * 0.05 * (0.6 + 0.4 * (1.0 - uv.y));
  col += bg;

  fragColor = vec4(col * uIntensity * uWeight, 1.0);
}
