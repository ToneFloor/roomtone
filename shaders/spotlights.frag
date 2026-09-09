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

// @name      Spotlights
// @author    ROOMTONE
// @param     beams    2.00 .. 8.00 = 4.00  "Beam count"
// @param     sweep    0.00 .. 2.00 = 0.80  "Sweep speed"
// @param     haze     0.20 .. 2.00 = 1.00  "Haze density"
// @param     spread   0.30 .. 2.00 = 1.00  "Beam width"
// @feedback  true

// Searchlights at a premiere. Beams rake up out of the ground, cross overhead
// and swing back, with the air thick enough to see the light travelling through
// it rather than only where it lands.
//
// The beam is not a drawn triangle. Each light is a point below the bottom of
// the frame with a direction, and a pixel is lit by how close it lies to that
// ray — the perpendicular distance, softened. That is what gives a beam a soft
// edge and a hard core for free, and it means a beam can leave the frame and
// come back without any clipping logic.
//
// Two details do most of the work:
//
//   * **Distance falloff.** A real searchlight loses its beam to the air. The
//     light fades with distance from its source, so the base is bright and the
//     far end dissolves — without that it reads as a painted wedge.
//   * **Sweeps are not synchronised.** Each beam gets its own rate from an
//     irrational-ish multiplier, so they drift in and out of alignment forever
//     instead of pulsing together like a metronome.

uniform sampler2D uPrevFrame;
uniform sampler2D uSpectrum;
uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uBass, uMid, uHigh, uKick, uBeat, uTime, uIntensity, uWeight;
uniform float beams, sweep, haze, spread;

out vec4 fragColor;

/// Perpendicular distance from `p` to the ray leaving `origin` along `dir`.
///
/// Clamped at the origin so the beam does not continue out the back of the
/// lamp, which otherwise puts a second beam below the stage pointing down.
float rayDistance(vec2 p, vec2 origin, vec2 dir, out float along) {
  vec2 rel = p - origin;
  along = max(0.0, dot(rel, dir));
  vec2 nearest = origin + dir * along;
  return length(p - nearest);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;

  // Work in a space where the frame is 1 tall and `aspect` wide, so a beam is
  // the same thickness on an ultrawide as on a 16:9.
  vec2 p = vec2(uv.x * aspect, uv.y);

  float n = clamp(beams, 2.0, 8.0);
  vec3 col = vec3(0.0);

  for (float i = 0.0; i < 8.0; i += 1.0) {
    if (i >= n) break;
    float k = i / n;

    // Lamps sit in a row along the ground, just below the bottom edge.
    vec2 origin = vec2(aspect * (0.12 + 0.76 * (i + 0.5) / n), -0.08);

    // Each beam sweeps at its own rate. The 0.618 keeps the rates from being
    // simple multiples of one another, so the pattern never repeats visibly.
    float rate = 0.35 + fract(i * 0.618) * 0.55;
    float phase = uTime * sweep * rate + i * 2.4;

    // Angle from vertical. Bounded so the beams stay theatrical rather than
    // lying flat along the floor.
    float angle = sin(phase) * 0.85 + sin(phase * 0.37 + i) * 0.22;

    // The kick tightens every beam toward the centre for a moment, which is
    // what a lighting operator does on a drop.
    angle *= 1.0 - uKick * 0.30;

    vec2 dir = normalize(vec2(sin(angle), cos(angle)));

    float along;
    float d = rayDistance(p, origin, dir, along);

    // Each beam answers to its own slice of the spectrum, so on a busy mix the
    // whole row lights up and on a sparse one only some of them do.
    float band = texture(uSpectrum, vec2(0.08 + k * 0.8, 0.5)).r;

    // The beam widens with distance from the lamp, the way a real cone does.
    float width = (0.012 + along * 0.055) * spread * (0.7 + band * 0.8);
    float core = exp(-(d * d) / max(1e-4, width * width));

    // Air. The beam dims along its length; without this it is a wedge of paint.
    float reach = exp(-along * (0.75 / max(0.2, haze)));

    float lit = core * reach * (0.30 + band * 1.6 + uBass * 0.5);

    // Alternate lamp colours down the row — two hues out of the cover, the way
    // a real rig is gelled rather than all one colour.
    vec3 gel = mix(uArtColor, uArtColor2, mod(i, 2.0));
    col += gel * lit;

    // The lamp itself: a hot point at the base of the beam.
    float lamp = exp(-dot(p - origin, p - origin) * 900.0);
    col += mix(gel, vec3(1.0), 0.6) * lamp * (0.6 + uKick * 1.4);
  }

  // Ground haze catching the light, so the beams stand on something.
  float floorFog = exp(-uv.y * 5.0) * (0.10 + uBass * 0.35) * haze;
  col += mix(uArtColor, uArtColor2, 0.5) * floorFog;

  // Highs put a fine sparkle in the air, like dust crossing a beam.
  float dust = fract(sin(dot(floor(p * 260.0), vec2(12.9898, 78.233))) * 43758.5453);
  col += vec3(1.0) * step(0.9992, dust) * uHigh * 0.9;

  col *= uIntensity;

  // Enough feedback to leave a trail of where a beam has just been, which is
  // what makes a sweep read as movement rather than as a series of positions.
  vec3 prev = texture(uPrevFrame, uv).rgb * 0.72;
  col = max(col, prev * 0.90);

  fragColor = vec4(col * uWeight, 1.0);
}
