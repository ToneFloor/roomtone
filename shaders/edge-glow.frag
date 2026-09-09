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

// @name      Edge Glow
// @author    ROOMTONE
// @param     reach    0.30 .. 2.00 = 1.00  "Edge reach"
// @param     warmth   0.00 .. 1.00 = 0.35  "Bloom warmth"
// @feedback  true

// The simplest preset, and the one to read first if you are writing your own.
// Light spills in from the four edges of the screen, scaled by bass. The
// feedback line at the bottom is what gives it weight: without it the glow
// snaps on and off, with it the room keeps a little light between kicks.

uniform sampler2D uPrevFrame;
uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uBass, uMid, uHigh, uKick, uTime, uIntensity, uWeight;
uniform float reach, warmth;

out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  // Distance to the nearest edge, 0 at the frame, 1 in the middle.
  vec2 d = min(uv, 1.0 - uv) * 2.0;
  float edge = min(d.x, d.y);

  float spread = 0.42 * reach * (0.35 + uBass * 1.25);
  float glow = pow(1.0 - smoothstep(0.0, spread, edge), 2.2);

  // The bottom edge carries more weight — light in a room falls from surfaces,
  // not from a perfect square.
  float floorLift = pow(1.0 - smoothstep(0.0, spread * 1.5, uv.y), 2.6) * 0.55;

  // Left and right edges take different hues from the cover. In a dark room
  // that is the difference between one lamp and two.
  vec3 sideways = mix(uArtColor, uArtColor2, smoothstep(0.35, 0.65, uv.x));
  vec3 warm = mix(sideways, vec3(1.0, 0.86, 0.72), warmth * uHigh * 0.5);
  vec3 col = warm * (glow + floorLift) * (0.55 + uBass * 1.1) * uIntensity;

  // Kick pushes a flat lift across the whole frame for a moment.
  col += uArtColor * uKick * 0.10 * uIntensity;

  // Feedback: last frame, faded. Trails live here.
  vec3 prev = texture(uPrevFrame, uv).rgb * (0.74 + uMid * 0.10);
  col = max(col, prev * 0.92);

  fragColor = vec4(col * uWeight, 1.0);
}
