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

// @name      Warp Tunnel
// @author    ROOMTONE
// @param     speed    0.10 .. 3.00 = 1.00  "Travel speed"
// @param     twist    0.00 .. 2.00 = 0.60  "Twist"
// @param     rings    4.00 .. 40.00 = 16.0 "Ring density"
// @feedback  true

// Flying down a corridor. The trick is that a tunnel needs no geometry at all:
// take the polar coordinates of the pixel, use 1/radius as depth, and you have
// perspective for free — near the centre the walls rush past, at the edges they
// crawl.
//
// The distance travelled is not time * speed. It is an accumulator that the
// kick shoves forward, so a beat is a lurch down the corridor rather than a
// change of colour. That is the whole preset.

uniform sampler2D uPrevFrame;
uniform sampler2D uSpectrum;
uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uBass, uMid, uHigh, uKick, uBeat, uTime, uIntensity, uWeight;
uniform float speed, twist, rings;

out vec4 fragColor;

const float TAU = 6.28318530718;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float r = max(length(p), 0.0012);
  float a = atan(p.y, p.x) / TAU + 0.5;

  // Depth. 1/r is what makes the middle of the screen feel infinitely far away.
  float depth = 1.0 / r;

  // Distance travelled: steady drift, plus a shove on every kick.
  float travel = uTime * speed * 0.55 + uKick * 1.6 + uBeat * 0.25;

  // Spin the corridor, faster when the mids are busy.
  float ang = a + travel * twist * 0.08 + uMid * 0.12;

  // The wall pattern: rings along depth, panels around the circumference.
  float z = depth * 0.35 + travel;
  float ring = fract(z * rings * 0.06);
  float panel = fract(ang * 12.0);

  float grid = smoothstep(0.5, 0.0, abs(ring - 0.5)) * 0.75
             + smoothstep(0.42, 0.0, abs(panel - 0.5)) * 0.35;

  // Each ring samples a different band, so the corridor is literally built out
  // of the spectrum rather than merely tinted by it.
  float band = texture(uSpectrum, vec2(fract(z * 0.13), 0.5)).r;
  grid *= 0.30 + band * 1.5;

  // Fog: far away is dark, which is what sells the depth.
  float fog = smoothstep(0.0, 0.55, r);

  // Alternate hue by ring. Two colours receding into the distance separate
  // the walls far better than one colour at two brightnesses.
  vec3 wall = mix(uArtColor, uArtColor2, step(0.5, fract(z * rings * 0.03)));
  vec3 tint = mix(wall, vec3(1.0), uHigh * 0.35);
  vec3 col = tint * grid * fog * (0.5 + uBass * 1.5) * uIntensity;

  // A hot core at the vanishing point.
  col += tint * pow(1.0 - smoothstep(0.0, 0.16, r), 3.0) * (0.25 + uKick * 0.9) * uIntensity;

  // Feedback smeared slightly outward reads as motion blur down the tunnel.
  vec2 back = (uv - 0.5) * 0.985 + 0.5;
  vec3 prev = texture(uPrevFrame, back).rgb * 0.80;
  col = max(col, prev);

  fragColor = vec4(col * uWeight, 1.0);
}
