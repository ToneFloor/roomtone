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

// @name      Liquid Metal
// @author    ROOMTONE
// @param     blobs    2.00 .. 8.00 = 5.00  "Blob count"
// @param     surface  0.20 .. 2.00 = 1.00  "Surface sharpness"
// @param     flow     0.00 .. 2.00 = 0.80  "Flow speed"
// @feedback  false

// Metaballs: a handful of moving points, each contributing 1/distance to a
// field, thresholded into a surface. Where two of them approach, the field adds
// up and the surface bulges toward the other — which is why they merge like
// mercury instead of overlapping like circles.
//
// No feedback here on purpose. Trails would fog the specular highlight, and the
// highlight is the only thing that makes it look like metal.

uniform sampler2D uSpectrum;
uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uBass, uMid, uHigh, uKick, uTime, uIntensity, uWeight;
uniform float blobs, surface, flow;

out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float t = uTime * flow;
  float n = clamp(blobs, 2.0, 8.0);

  float field = 0.0;
  vec2 grad = vec2(0.0);

  for (float i = 0.0; i < 8.0; i += 1.0) {
    if (i >= n) break;
    float k = i / n;

    // Lissajous paths at coprime-ish rates: they never line up, so the cluster
    // never settles into a pattern you can predict.
    vec2 c = vec2(
      sin(t * (0.41 + k * 0.23) + i * 2.1) * 0.34,
      cos(t * (0.33 + k * 0.19) + i * 1.3) * 0.26
    );

    // Each blob is sized by its own frequency band, so bass blobs are the big
    // slow ones and treble blobs are the small quick ones.
    float band = texture(uSpectrum, vec2(k * 0.9 + 0.05, 0.5)).r;
    float radius = 0.055 + band * 0.10 + uKick * 0.02;

    vec2 d = p - c;
    float dist2 = dot(d, d) + 1e-4;
    float w = radius * radius / dist2;
    field += w;
    // Analytic gradient — the surface normal, for free.
    grad += -2.0 * w * d / dist2;
  }

  // Threshold the field into a surface with a soft shoulder.
  float edge = 0.9 / max(0.05, surface);
  float mass = smoothstep(1.0 - edge * 0.5, 1.0 + edge * 0.5, field);

  vec3 nrm = normalize(vec3(grad * 0.05, 1.0));

  // One key light and one rim. Enough for chrome.
  vec3 key = normalize(vec3(0.45, 0.7, 0.6));
  float lam = max(0.0, dot(nrm, key));
  float spec = pow(max(0.0, dot(reflect(-key, nrm), vec3(0.0, 0.0, 1.0))), 34.0);
  float rim = pow(1.0 - max(0.0, nrm.z), 2.4);

  // Lit side takes the lead colour, shadowed side the second. Real metal
  // reflects a room with more than one light in it; one hue at two brightnesses
  // always looks like painted plastic.
  vec3 body = mix(uArtColor2 * 0.45, uArtColor, lam);
  vec3 col = body * mass
           + vec3(1.0) * spec * mass * (0.5 + uHigh * 1.2)
           + uArtColor2 * rim * mass * (0.4 + uMid * 0.9);

  // The pool the blobs sit in, so the frame is never flat black.
  col += uArtColor * 0.05 * (0.4 + uBass);

  fragColor = vec4(col * uIntensity * uWeight, 1.0);
}
