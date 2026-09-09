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

// @name      Bass Rings
// @author    you
// @param     spread   0.50 .. 4.00 = 1.80  "Ring spread"
// @feedback  true

// This file lives in %APPDATA%/roomtone/shaders/ — edit it and save, and
// ROOMTONE reloads it while it is running. Rename it and you get a second
// preset in the dock.
//
// The feedback line near the bottom is the one worth understanding: sample the
// previous frame, scaled slightly, and mix it back in. That is what produces
// trails. Everything else here is ordinary maths.

uniform sampler2D uPrevFrame;
uniform vec2  uResolution;
uniform vec3  uArtColor;
uniform float uBass, uKick, uTime, uIntensity, uWeight;
uniform float spread;

out vec4 fragColor;

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float r = length(uv);

  // Rings pushed outward by bass.
  float rings = sin(r * 24.0 / spread - uTime * 2.0 - uBass * 6.0);
  float glow  = smoothstep(0.35, 1.0, rings) * uBass * uIntensity;

  // Feedback: pull in the last frame, slightly scaled, and fade it.
  vec2 fb = (uv * 0.985) * vec2(uResolution.y / uResolution.x, 1.0) + 0.5;
  vec3 prev = texture(uPrevFrame, fb).rgb * 0.93;

  vec3 col = prev + uArtColor * glow + vec3(uKick * 0.06);
  fragColor = vec4(col * uWeight, 1.0);
}
