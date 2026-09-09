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

// @name      Starfield
// @author    ROOMTONE
// @param     density  0.30 .. 3.00 = 1.00  "Star density"
// @param     warp     0.00 .. 3.00 = 1.00  "Warp speed"
// @param     streak   0.00 .. 1.00 = 0.55  "Streak length"
// @feedback  true

// Hyperspace. Stars are not drawn as objects — the screen is cut into polar
// cells, each cell hashes to one star at a fixed angle and a depth that cycles,
// and the cell is coloured by how close the pixel is to it. That way there is
// no particle list, no upper bound on star count, and it costs the same at any
// resolution.
//
// Streaks come from the feedback buffer sampled slightly toward the centre: last
// frame's star is behind this frame's, so each one leaves its own trail.

uniform sampler2D uPrevFrame;
uniform sampler2D uSpectrum;
uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uBass, uMid, uHigh, uKick, uBeat, uTime, uIntensity, uWeight;
uniform float density, warp, streak;

out vec4 fragColor;

const float TAU = 6.28318530718;

float hash(vec2 v) {
  return fract(sin(dot(v, vec2(41.7, 289.1))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float r = max(length(p), 0.0015);
  float a = atan(p.y, p.x) / TAU + 0.5;

  // Kick pushes the whole field forward; that is the jump to lightspeed.
  float travel = uTime * (0.35 + warp * 0.5) + uKick * 0.9 + uBass * 0.35;

  // Cut the disc into wedges. More wedges, more stars.
  float wedges = floor(48.0 * density);
  float wi = floor(a * wedges);
  float wf = fract(a * wedges);

  vec3 col = vec3(0.0);

  // Three layers at different depths give parallax without three passes.
  for (float layer = 0.0; layer < 3.0; layer += 1.0) {
    float seed = hash(vec2(wi, layer * 7.0));
    float rate = 0.35 + seed * 0.55;

    // Depth cycles 0..1; each cycle is one star arriving from the centre.
    float z = fract(seed + travel * rate);

    // Radius from depth. Squaring is what makes it accelerate as it nears you.
    float sr = z * z * 0.95;

    // Distance to this wedge's star, in both directions.
    float dr = abs(r - sr);
    float da = abs(wf - 0.5) / wedges * 3.0;

    float size = 0.0025 + z * 0.006;
    float star = smoothstep(size, 0.0, dr) * smoothstep(0.010, 0.0, da);

    // Stars brighten as they approach and vanish at the frame edge.
    star *= z * z * smoothstep(1.05, 0.75, r);

    // Which band this layer answers to.
    float band = texture(uSpectrum, vec2(0.15 + layer * 0.35, 0.5)).r;

    // Near stars white, far stars tinted, and the two tints differ — depth
    // reads through colour separation as much as through speed.
    vec3 far = mix(uArtColor, uArtColor2, layer * 0.5);
    vec3 tint = mix(vec3(1.0), far, 0.35 + layer * 0.2);
    col += tint * star * (1.0 + band * 2.2);
  }

  col *= uIntensity;

  // A faint core glow so the vanishing point is not a hole.
  col += uArtColor * pow(1.0 - smoothstep(0.0, 0.22, r), 4.0) * (0.10 + uKick * 0.5) * uIntensity;

  // Trails: last frame, pulled toward the centre so it sits behind the star.
  vec2 back = (uv - 0.5) * (1.0 - 0.035 * (0.3 + streak)) + 0.5;
  vec3 prev = texture(uPrevFrame, back).rgb * (0.60 + streak * 0.34);
  col = max(col, prev);

  fragColor = vec4(col * uWeight, 1.0);
}
