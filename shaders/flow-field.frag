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

// @name      Flow Field
// @author    ROOMTONE
// @param     speed    0.10 .. 3.00 = 1.00  "Flow speed"
// @param     scale    0.50 .. 4.00 = 1.60  "Field scale"
// @param     decay    0.80 .. 0.99 = 0.94  "Trail persistence"
// @param     warp     0.00 .. 2.00 = 0.80  "Feedback warp"
// @feedback  true

// The reference implementation for uPrevFrame. Everything you see here is the
// previous frame, sampled at a slightly displaced position and faded — nothing
// else. Read `warped` below: that one line is the whole technique, and it is
// the one most people miss when they try to write a visualizer.

uniform sampler2D uPrevFrame;
uniform sampler2D uSpectrum;
uniform vec2  uResolution;
uniform vec3  uArtColor;
uniform float uBass, uMid, uHigh, uKick, uTime, uIntensity, uWeight;
uniform float speed, scale, decay, warp;

out vec4 fragColor;

// Cheap value noise. Good enough for a flow field; a proper simplex would cost
// more than the difference is worth at this scale.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float t = uTime * 0.20 * speed;

  // The field: an angle at every point, drifting over time.
  float n = noise(p * scale * 2.4 + vec2(t, -t * 0.7));
  float ang = n * 12.566 + uBass * 2.0;
  vec2 flow = vec2(cos(ang), sin(ang));

  // THE technique: read the previous frame from slightly *upstream*, so the
  // image appears to be carried along the field. Fade it, and trails fall out
  // for free.
  vec2 warped = uv - flow * (0.0012 + uBass * 0.0042) * warp * speed;
  vec3 prev = texture(uPrevFrame, warped).rgb * decay;

  // Inject new light where the spectrum is loud at this height.
  float mag = texture(uSpectrum, vec2(uv.y, 0.5)).r;
  float seed = smoothstep(0.55, 1.0, mag) * step(hash(gl_FragCoord.xy + uTime) , 0.06);

  vec3 col = prev;
  col += uArtColor * seed * (0.4 + uMid * 0.8) * uIntensity;

  // Kick flashes a thin sheet through the whole field.
  col += uArtColor * uKick * 0.045 * uIntensity;

  // Highs lift the leading edges, which is what makes the streaks look sharp.
  col += vec3(1.0) * pow(max(prev.r, max(prev.g, prev.b)), 3.0) * uHigh * 0.25;

  fragColor = vec4(min(col, vec3(4.0)) * uWeight, 1.0);
}
