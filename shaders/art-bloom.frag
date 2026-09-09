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

// @name      Art Bloom
// @author    ROOMTONE
// @param     bloom    0.20 .. 2.00 = 1.00  "Bloom amount"
// @param     softness 0.30 .. 3.00 = 1.20  "Blur radius"
// @param     drift    0.00 .. 1.00 = 0.40  "Drift speed"
// @feedback  true

// The cover art used as a light source rather than a picture: threshold the
// bright parts, blur them wide, add them back. This is the fallback preset —
// it is what plays when a track has no lyrics, which is most of them, so it
// has to look deliberate rather than like an empty state.

uniform sampler2D uPrevFrame;
uniform sampler2D uCover;
uniform float uHasCover;
uniform vec2  uResolution;
uniform vec3  uArtColor;
uniform float uBass, uMid, uHigh, uKick, uTime, uIntensity, uWeight;
uniform float bloom, softness, drift;

out vec4 fragColor;

// Nine taps in a rotated ring. Cheap, and at this radius the banding a proper
// gaussian would avoid is invisible anyway.
vec3 blurCover(vec2 uv, float radius) {
  vec3 sum = texture(uCover, uv).rgb;
  float a = uTime * 0.12;
  for (int i = 0; i < 8; i++) {
    float t = float(i) * 0.7853981634 + a;
    vec2 o = vec2(cos(t), sin(t)) * radius;
    sum += texture(uCover, uv + o).rgb;
  }
  return sum / 9.0;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;

  // A slow wander so a static cover never looks like a still image.
  vec2 wander = vec2(sin(uTime * 0.11), cos(uTime * 0.083)) * 0.035 * drift;
  vec2 cuv = (uv - 0.5) * vec2(1.0, 1.0) * (1.18 - uBass * 0.06) + 0.5 + wander;

  vec3 src = uHasCover > 0.5 ? blurCover(cuv, 0.035 * softness) : uArtColor * 0.5;

  // Threshold: keep only what is already bright, so the bloom reads as light
  // rather than as a washed-out copy of the artwork.
  float lum = dot(src, vec3(0.2126, 0.7152, 0.0722));
  vec3 bright = src * smoothstep(0.22, 0.72, lum);

  float pulse = 0.45 + uBass * 0.95 + uKick * 0.35;
  vec3 col = bright * pulse * bloom * uIntensity * 1.6;

  // Tint toward the extracted accent so the room agrees with the cover even
  // where the cover itself is dark.
  col += uArtColor * (0.10 + uMid * 0.22) * bloom * uIntensity;

  // Vignette keeps the eye in the middle where the DOM text sits.
  vec2 v = (uv - 0.5) * vec2(aspect, 1.0);
  col *= 1.0 - smoothstep(0.35, 0.95, length(v)) * 0.55;

  vec3 prev = texture(uPrevFrame, uv).rgb * (0.80 + uHigh * 0.06);
  col = max(col, prev * 0.90);

  fragColor = vec4(col * uWeight, 1.0);
}
