# Writing a shader

A ROOMTONE preset is one `.frag` file. There is no registration step, no JSON
sidecar and no code change: drop a file in the folder and it appears in the dock
with its own settings sliders.

```
%APPDATA%\roomtone\shaders\
```

Settings → SHADER PRESETS → **OPEN FOLDER** takes you there. The folder is
watched, so saving a file updates the running app within a couple of seconds —
you can leave ROOMTONE playing on one monitor and edit on the other.

If your shader fails to compile, the dock tile says so and names the line. The
previous working version keeps running; a broken save never blanks the screen.

---

## The smallest possible preset

```glsl
#version 300 es
precision highp float;

// @name  Hello

uniform vec2  uResolution;
uniform vec3  uArtColor;
uniform float uBass, uIntensity, uWeight;

out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 col = uArtColor * uBass * (1.0 - uv.y) * uIntensity;
  fragColor = vec4(col * uWeight, 1.0);
}
```

That is a complete, working preset. Three rules:

1. It must start with `#version 300 es` on the **first line**. This is WebGL2,
   which is GLSL ES 3.00 — the same dialect mobile GPUs use.
2. Declare only the uniforms you actually use. They are looked up by name, so
   unused ones cost nothing and missing ones are not an error.
3. **Always multiply your final colour by `uWeight`.** See below — this is the
   one rule that is easy to miss and looks like a bug when you do.

---

## The header

Lines beginning `// @` at the top of the file configure the preset.

```glsl
// @name      Warp Tunnel
// @author    yourname
// @param     speed   0.10 .. 3.00 = 1.00  "Travel speed"
// @param     twist   0.00 .. 2.00 = 0.60  "Twist"
// @feedback  true
```

| Directive | Meaning |
| --- | --- |
| `@name` | What the dock shows. Without it, the file name is used. |
| `@author` | Shown in the preset's settings group. Optional. |
| `@param` | `name  min .. max = default  "Label"` — creates a slider **and** a uniform of that name. |
| `@feedback` | `true` if you sample `uPrevFrame`. |

Each `@param` becomes a `uniform float` you declare and use like any other. The
slider appears in Settings whenever your preset is the active one, and the value
is remembered across restarts.

---

## Uniforms

### Audio

| Uniform | Range | What it is |
| --- | --- | --- |
| `uBass` | 0–1 | 20–250 Hz, smoothed |
| `uMid` | 0–1 | 250 Hz–4 kHz |
| `uHigh` | 0–1 | 4–16 kHz |
| `uKick` | 0–1 | Onset detection. Spikes on a hit and decays — this is your beat. |
| `uBeat` | rising | A continuous counter advanced by detected tempo. Good for things that should rotate or travel with the song rather than with the clock. |

All of these are already smoothed asymmetrically — fast to rise, slow to fall —
so you do not need to smooth them again. If your preset looks jittery, the cause
is usually that you are multiplying two of them together.

### Colour

| Uniform | |
| --- | --- |
| `uArtColor` | The lead colour from the cover art |
| `uArtColor2` | A second hue from the same cover, at least 40° away on the wheel |

Use both. A darkened copy of one colour reads as a shadow; two real colours out
of the same artwork read as the record. If the cover is monochrome, both fall
back to the app's own accent.

### Textures

| Uniform | |
| --- | --- |
| `uSpectrum` | 128 log-spaced FFT bins in a 1D texture. Sample with `texture(uSpectrum, vec2(x, 0.5)).r` where `x` is 0 (low) to 1 (high). |
| `uPrevFrame` | The last frame. Set `@feedback true` to use it. |
| `uCover` | The album art. `uHasCover` is 1.0 when there is one, 0.0 otherwise — always check it. |

The spectrum being a *texture* rather than three numbers is what makes presets
like Spectrum Ring possible: every pixel can sample a different frequency. If
your idea is "different parts of the screen respond to different parts of the
sound", this is the uniform you want.

### Frame

| Uniform | |
| --- | --- |
| `uResolution` | Canvas size in pixels |
| `uTime` | Seconds since start |
| `uIntensity` | The master Intensity slider. Multiply your output by it. |
| `uWeight` | **Crossfade weight. Multiply your final colour by it.** |

---

## Why `uWeight` matters

Switching presets crossfades them. Both shaders run for about a quarter of a
second, drawn into the same buffer with **additive blending**, and `uWeight` is
each one's share — the two always sum to 1.

Forget it and your preset will look correct on its own and blow out to white
during every transition, because two full-brightness images are being added
together. It is the single most common mistake, and it only shows up when you
switch away.

```glsl
fragColor = vec4(col * uWeight, 1.0);   // always
```

For the same reason, **write 1.0 to alpha and do not rely on blending you did not
set up.** The blend mode is fixed.

---

## Feedback, and how trails work

With `@feedback true` you can read the previous frame:

```glsl
vec3 prev = texture(uPrevFrame, uv).rgb * 0.9;
col = max(col, prev);
```

`max` rather than `+` keeps trails from accumulating into white. Multiply by
slightly less than 1 or the trail never fades.

Sampling at an offset is where this gets interesting. Pulling the previous frame
*toward* the centre turns every bright point into a streak away from it, which is
the whole of the Starfield preset:

```glsl
vec2 back = (uv - 0.5) * 0.97 + 0.5;
vec3 prev = texture(uPrevFrame, back).rgb * 0.8;
```

Feedback buffers are `RGBA16F`, so values above 1.0 survive between frames and
bloom properly instead of clipping.

---

## Things that will bite you

**`pow()` with a negative base is undefined.** This is real: it produced NaN on
some drivers and blacked out half the screen. If the base can go negative, square
it by multiplication:

```glsl
float g = (x - centre) / width;
float band = exp(-(g * g));     // not pow(..., 2.0)
```

**Aspect ratio.** `gl_FragCoord.xy / uResolution` gives 0–1 in both directions,
which stretches circles on a widescreen. Correct it:

```glsl
float aspect = uResolution.x / uResolution.y;
vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
```

**Loops need a constant bound** in GLSL ES 3.00. Loop to a fixed maximum and
`break` on a uniform:

```glsl
for (float i = 0.0; i < 8.0; i += 1.0) {
  if (i >= count) break;
  ...
}
```

**Divide-by-zero at the centre.** `1.0 / length(p)` is infinite in the middle of
the screen. Clamp it: `max(length(p), 0.001)`.

**Everything runs per pixel, sixty times a second, at up to 3.7 megapixels.** A
loop of eight iterations with a texture fetch in each is fine. A loop of five
hundred is not.

---

## Testing without shipping a broken preset

You can compile-check a shader before ROOMTONE ever sees it, using
`glslangValidator` from the [glslang](https://github.com/KhronosGroup/glslang)
tools:

```
glslangValidator yourshader.frag
```

It will not know about ROOMTONE's uniforms, so declare them in the file as you
normally would and it will validate cleanly. This catches the `pow()` trap and
every syntax error without a rebuild.

---

## A worked example

Bars radiating from the centre, one per frequency band, brightening on the kick:

```glsl
#version 300 es
precision highp float;

// @name      Radial Bars
// @author    example
// @param     bars    8.0 .. 64.0 = 24.0  "Bar count"
// @param     length  0.2 .. 1.5  = 0.7   "Bar length"

uniform sampler2D uSpectrum;
uniform vec2  uResolution;
uniform vec3  uArtColor, uArtColor2;
uniform float uKick, uIntensity, uWeight;
uniform float bars, length_;

out vec4 fragColor;

const float TAU = 6.28318530718;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float r = max(length(p), 0.001);
  float a = atan(p.y, p.x) / TAU + 0.5;      // 0..1 around the circle

  // Which bar this pixel is in, and how far across it.
  float slot = floor(a * bars);
  float within = fract(a * bars);

  // Each bar reads its own frequency band.
  float band = texture(uSpectrum, vec2(slot / bars, 0.5)).r;

  // The bar reaches outward as far as its band is loud.
  float reach = 0.1 + band * length_;
  float inBar = step(r, reach) * smoothstep(0.0, 0.1, within)
                               * smoothstep(1.0, 0.9, within);

  vec3 tint = mix(uArtColor, uArtColor2, slot / bars);
  vec3 col = tint * inBar * (0.4 + band + uKick * 0.6) * uIntensity;

  fragColor = vec4(col * uWeight, 1.0);
}
```

Note `length_` with a trailing underscore — `length` is a GLSL built-in and
cannot be a variable name. The `@param` line uses the same spelling.

---

## Sharing

If you make something good, open a pull request. Put the file in `shaders/`, add
it to the list in `src-tauri/src/shaders.rs`, and include a screenshot — nobody
can review a shader from its source.
