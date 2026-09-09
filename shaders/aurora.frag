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

// @name      Aurora
// @author    ROOMTONE
// @param     curtains 1.00 .. 6.00 = 3.00  "Curtain count"
// @param     drift    0.00 .. 2.00 = 0.70  "Drift speed"
// @param     height   0.20 .. 1.20 = 0.70  "Curtain height"
// @feedback  true

// The calm one. Vertical sheets of light that lean and fold, the way an aurora
// does, with the fold driven by mids rather than by the clock — so it breathes
// with the track instead of looping on a timer.
//
// No noise texture: three sine waves at unrelated frequencies never repeat
// visibly, and cost almost nothing.

uniform sampler2D uPrevFrame;
uniform sampler2D uSpectrum;
uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uBass, uMid, uHigh, uKick, uTime, uIntensity, uWeight;
uniform float curtains, drift, height;

out vec4 fragColor;

float sheet(vec2 uv, float seed, float t, float energy) {
  // Horizontal wander of this curtain.
  float x = uv.x + sin(uv.y * 2.1 + t * 0.6 + seed) * 0.16
                 + sin(uv.y * 4.7 - t * 0.37 + seed * 2.3) * 0.07 * (0.4 + energy);

  // A soft vertical band, narrow at the top.
  //
  // Squared by multiplication, not pow(). GLSL leaves pow() undefined for a
  // negative base, and this one is negative for every pixel left of the
  // curtain — on some drivers that is a NaN and half the screen goes black.
  float w = 0.055 + 0.045 * sin(t * 0.4 + seed * 3.1) + energy * 0.05;
  float g = (x - 0.5 - sin(seed * 5.0) * 0.28) / w;
  float band = exp(-(g * g));

  // Fade with altitude; auroras are brightest low and dissolve upward.
  float fall = smoothstep(height + 0.35, 0.02, uv.y);
  return band * fall;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float t = uTime * drift;

  float n = clamp(curtains, 1.0, 6.0);
  vec3 col = vec3(0.0);

  for (float i = 0.0; i < 6.0; i += 1.0) {
    if (i >= n) break;
    // Each curtain listens to its own slice of the spectrum.
    float band = texture(uSpectrum, vec2((i + 0.5) / n, 0.5)).r;
    float s = sheet(uv, i * 1.9, t, band);

    // Colour walks from the cover's lead hue to its second one across the
    // curtains. It used to walk toward a fixed green — which looked like an
    // aurora but had nothing to do with the album. Two hues from the same
    // artwork give the same effect and actually belong to the record.
    vec3 tint = mix(uArtColor, uArtColor2, i / max(1.0, n - 1.0) * 0.85);
    col += tint * s * (0.25 + band * 1.7);
  }

  // Ground haze.
  col += uArtColor * pow(1.0 - smoothstep(0.0, 0.30, uv.y), 2.4) * (0.10 + uBass * 0.45);

  // Highs put a cold shimmer along the top edges of the sheets.
  col += vec3(0.7, 0.9, 1.0) * uHigh * 0.10 * smoothstep(0.3, 1.0, uv.y);

  col *= uIntensity;

  vec3 prev = texture(uPrevFrame, uv).rgb * 0.86;
  col = max(col, prev * 0.94);

  fragColor = vec4(col * uWeight, 1.0);
}
