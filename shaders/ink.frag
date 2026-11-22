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

// @name      Ink
// @author    ROOMTONE
// @group     Ambient
// @param     dose    0.20 .. 2.00 = 1.00  "Ink amount"
// @param     swirl   0.00 .. 2.00 = 1.00  "Swirl"
// @param     linger  0.00 .. 1.00 = 0.60  "Linger"
// @feedback  true

// Ink dropped in water. Three slowly wandering points release ink in the two
// album colours; the previous frame is dragged along a divergence-free (curl)
// flow, so the ink blooms, folds and drifts, then fades.
//
// Bass and kicks make the points release more ink, mids speed up the swirl.
// In silence the points keep dripping gently and the flow keeps turning on the
// clock, so it is never empty.
//
// Feedback safety: ink is mixed toward a target colour rather than added, so a
// pixel can never exceed the brighter of what it held and what is being
// injected. Every frame also multiplies by a decay below 1 and clamps. It
// cannot climb to white and it cannot fade to black while points are dripping.

uniform sampler2D uPrevFrame;
uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uBass, uMid, uKick, uTime, uIntensity, uWeight;
uniform float dose, swirl, linger;

out vec4 fragColor;

// Velocity = curl of a stream function made of three sines at unrelated
// frequencies, so the flow never repeats visibly and never converges or
// diverges (ink swirls instead of pooling).
vec2 curlFlow(vec2 p, float t) {
  vec2 k1 = vec2(2.3, 1.7);
  vec2 k2 = vec2(-3.1, 2.6);
  vec2 k3 = vec2(4.4, -3.7);
  float a1 = cos(dot(k1, p) + t * 0.31);
  float a2 = cos(dot(k2, p) - t * 0.23 + 1.7);
  float a3 = cos(dot(k3, p) + t * 0.17 + 4.1);
  return vec2(k1.y, -k1.x) * a1 * 0.45
       + vec2(k2.y, -k2.x) * a2 * 0.30
       + vec2(k3.y, -k3.x) * a3 * 0.18;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 sc = vec2(aspect, 1.0);
  vec2 p = (uv - 0.5) * sc;
  float t = uTime;

  // Pull the previous frame back along the flow. The tiny extra term nudges
  // everything outward so the ink also blooms, not only drifts.
  float stir = swirl * (0.45 + uMid * 1.1);
  vec2 v = curlFlow(p, t) * (0.0010 * stir);
  vec2 back = uv - v / sc - (uv - 0.5) * 0.0005;

  // Centre tap plus a light 4-tap blur so edges soften as the ink spreads.
  vec2 px = 1.0 / uResolution;
  vec3 c0 = texture(uPrevFrame, back).rgb;
  vec3 cx = texture(uPrevFrame, back + vec2(px.x * 1.5, 0.0)).rgb
          + texture(uPrevFrame, back - vec2(px.x * 1.5, 0.0)).rgb;
  vec3 cy = texture(uPrevFrame, back + vec2(0.0, px.y * 1.5)).rgb
          + texture(uPrevFrame, back - vec2(0.0, px.y * 1.5)).rgb;
  vec3 prev = mix(c0, (cx + cy) * 0.25, 0.2);

  // Decay strictly below 1 (0.992 .. 0.9985), plus a hair of subtraction so
  // faint residue reaches true black instead of hanging at 1e-3 forever.
  float decay = mix(0.992, 0.9985, clamp(linger, 0.0, 1.0));
  vec3 col = max(prev * decay - vec3(0.0002), vec3(0.0));

  // How hard the points are dripping: a steady idle trickle, more on bass,
  // a short push on each kick. Capped so a hit never flashes.
  float drive = min((0.016 + 0.045 * uBass + 0.07 * uKick) * dose, 0.18);

  for (float i = 0.0; i < 3.0; i += 1.0) {
    // Slow wander at unrelated rates.
    vec2 c = vec2(
      sin(t * (0.067 + 0.017 * i) + i * 2.4) * 0.30 * aspect,
      cos(t * (0.053 + 0.019 * i) + i * 1.9) * 0.26
    ) + vec2(sin(t * 0.19 + i * 5.0), cos(t * 0.17 + i * 3.0)) * 0.06;

    float r = 0.05 + 0.02 * uBass + 0.015 * sin(t * 0.3 + i);
    vec2 d = p - c;
    float m = exp(-dot(d, d) / (r * r));

    // Each point's colour slides slowly between the two album hues.
    float k = clamp(i * 0.5 + 0.2 * sin(t * 0.17 + i * 3.0), 0.0, 1.0);
    vec3 tint = mix(uArtColor, uArtColor2, k);

    float rate = clamp(m * drive * (0.7 + 0.3 * sin(t * 0.4 + i * 2.0)), 0.0, 0.5);
    col = mix(col, tint * (0.9 * uIntensity), rate);
  }

  col = clamp(col, vec3(0.0), vec3(2.0));

  // The stored frame is this output, so uIntensity lives inside the state and
  // uWeight only scales what leaves the shader (as in the other presets).
  fragColor = vec4(col * uWeight, 1.0);
}
