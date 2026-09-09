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

// @name      Kinetic Type
// @author    ROOMTONE
// @param     pool     0.20 .. 2.00 = 1.00  "Light pool"
// @param     lift     0.00 .. 1.50 = 0.60  "Word lift"
// @feedback  true

// This preset spans the canvas and the DOM. The words themselves are real HTML
// text on top — browser text beats shader text, and it stays selectable and
// accessible. What this shader draws is the light the words appear to cast:
// a pool beneath them that swells as each word lands.

uniform sampler2D uPrevFrame;
uniform vec2  uResolution;
uniform vec3  uArtColor;
uniform float uBass, uMid, uHigh, uKick, uBeat, uTime, uIntensity, uWeight;
uniform float pool, lift;

out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - vec2(0.5, 0.42)) * vec2(aspect, 1.0);

  // The pool sits slightly below centre, where the type sits.
  float r = length(p / vec2(1.35, 0.85));
  float core = exp(-r * r * (5.2 / pool));

  // Each word landing reads as a swell, not a flash.
  float swell = 0.55 + uKick * 0.75 + uBass * 0.6;

  vec3 col = uArtColor * core * swell * uIntensity * 1.25;

  // A soft floor bar so long words still have something to sit on.
  float floorGlow = exp(-pow((uv.y - 0.14) * 7.0, 2.0)) * (0.25 + uBass * 0.6);
  col += uArtColor * floorGlow * lift * uIntensity;

  // Mids brush a little brightness through the middle band, which keeps
  // vocals visible in the light even when there is no kick.
  col += vec3(1.0) * core * uMid * 0.10 * uIntensity;

  vec3 prev = texture(uPrevFrame, uv).rgb * 0.86;
  col = max(col, prev * 0.93);

  fragColor = vec4(col * uWeight, 1.0);
}
