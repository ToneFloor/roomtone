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

// @name      Video Edit
// @author    ROOMTONE
// @param     grade    0.00 .. 2.00 = 1.00  "Colour grade"
// @param     split    0.00 .. 2.50 = 1.00  "RGB split"
// @param     scan     0.00 .. 1.50 = 0.60  "Scanlines"
// @param     grain    0.00 .. 1.00 = 0.35  "Film grain"
// @param     vignette 0.00 .. 1.50 = 0.80  "Vignette"
// @feedback  false

// The loudest preset: a graded, split, scanned treatment of the cover art,
// built to sit behind big type. Feedback is off here on purpose — this look
// wants hard cuts on the beat, and trails would soften exactly the thing that
// makes it read as an edit.

uniform sampler2D uCover;
uniform float uHasCover;
uniform vec2  uResolution;
uniform vec3  uArtColor;
uniform float uBass, uMid, uHigh, uKick, uBeat, uTime, uIntensity, uWeight;
uniform float grade, split, scan, grain, vignette;

out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;

  float punch = max(uKick, uBass * 0.7);

  // Chromatic split, wider on the beat.
  float amt = (0.002 + punch * 0.008) * split;
  vec2 dir = normalize(vec2(1.0, 0.25));

  vec2 cuv = (uv - 0.5) * (1.14 - punch * 0.035) + 0.5;

  vec3 col;
  if (uHasCover > 0.5) {
    col.r = texture(uCover, cuv + dir * amt).r;
    col.g = texture(uCover, cuv).g;
    col.b = texture(uCover, cuv - dir * amt).b;
  } else {
    col = uArtColor * (0.35 + punch * 0.3);
  }

  // Grade: crush the blacks, push the accent into the midtones.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 graded = mix(vec3(lum), col, 1.25);
  graded = mix(graded, graded * uArtColor * 2.0, 0.35 * grade);
  graded = pow(max(graded, 0.0), vec3(1.0 + 0.35 * grade));
  col = mix(col, graded, grade);

  col *= 0.55 + punch * 0.55;

  // Scanlines, locked to pixels rather than to uv so they stay crisp.
  float line = sin(gl_FragCoord.y * 3.14159) * 0.5 + 0.5;
  col *= 1.0 - line * 0.16 * scan;

  // Grain hides the banding that a heavy grade always produces.
  col += (hash(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5) * 0.06 * grain;

  vec2 v = (uv - 0.5) * vec2(aspect, 1.0);
  col *= 1.0 - smoothstep(0.30, 0.92, length(v)) * 0.85 * vignette;

  fragColor = vec4(max(col, 0.0) * uIntensity * uWeight, 1.0);
}
