# Architecture

ROOMTONE is three independent paths that meet at the window. The important
property is that they are genuinely independent: **Path A alone is a complete
visualizer.** If Spotify is signed out and LRCLIB is unreachable, the app still
reacts to whatever your speakers are playing.

```
  Path A   speakers ──► WASAPI ──► ring buffer ──► FFT ──► bands ──┐
           audio        ~10 ms     lock-free      2048     + onsets │
                                                                    ├──► window
  Path B   Spotify Web API ──► track, position, cover ──────────────┤     60 Hz
                                                                    │
  Path C   LRCLIB ──► SQLite cache ──► timed words ─────────────────┘
```

Everything below `src-tauri/src/` is Rust; everything under `src/` is the
interface, running in a WebView2 window.

---

## Path A — audio

The only path with a hard latency budget, and the only one that cannot be
allowed to fail.

`audio/capture.rs` opens a WASAPI **loopback** stream through cpal. Loopback is
implicit in cpal: you build an *input* stream on an *output* device and the
backend sets the loopback flag for you. One consequence trips everyone up —
`default_input_config()` refuses on a render endpoint, so the format has to come
from `default_output_config()`.

`audio/process_capture.rs` is the per-app alternative, and it is hand-written COM
because cpal has no equivalent. Windows can capture one process tree's audio
*before* it reaches the speaker mix. It is activated by a magic device path
rather than a device, the target process id is passed in a `PROPVARIANT` blob,
activation is asynchronous, and `GetMixFormat` is unsupported on the resulting
client — you declare a format rather than negotiating one. All four of those fail
silently if you get them wrong.

The audio callback does the least work possible: downmix to mono, push into a
lock-free ring buffer, return. It never allocates and never locks, because a slow
audio callback produces dropouts and dropouts are what make a visualizer feel
broken.

`audio/analysis.rs` runs on its own thread: a 2048-point FFT on a 512-sample hop,
Hann window, three frequency bands, a rolling peak normaliser, and
[aubio](https://aubio.org) for onset and tempo. Band values are smoothed
asymmetrically — fast to rise, slow to fall — which is why the visuals snap on a
hit and settle gently.

The window receives one small event at 60 Hz. The bands are scalars; the spectrum
rides along as 128 bytes of base64. Raw FFT frames are never sent across the
bridge — the serialisation cost shows up as visible jitter.

**Measured, not estimated:** press `D` in the app and every number in the
diagnostics panel is read from the running pipeline.

## Path B — Spotify

`spotify/` handles authentication and polling. Authentication is the **PKCE**
flow, which needs no client secret — there is none in this project, and there is
no backend to hold one.

Two things about this were painful enough to be worth writing down:

- **PKCE rotates refresh tokens, and Spotify often omits the new one.** The
  library drops the old token when the response has no replacement, which
  presents to the user as being silently signed out on the next launch. The fix
  is to carry the previous token forward explicitly.
- **The library could not deserialise the live playback payload** for some
  content types. That one endpoint is read directly with a minimal struct rather
  than through the client.

Playback position is polled every three seconds and interpolated locally between
polls, so the progress bar moves smoothly rather than in steps.

`spotify/artwork.rs` caches cover images by track id and extracts the palette:
the most *saturated* cluster rather than the most common one, because the average
of a cover is always mud. A second hue is chosen only if it is at least 40° away
on the colour wheel — covers are often five shades of one blue, and the runner-up
cluster would be indistinguishable. A cover with no colour in it returns nothing
rather than inventing a hue.

## Path C — lyrics

`lyrics/` fetches from [LRCLIB](https://lrclib.net) — no account, no API key —
parses LRC, and caches in SQLite with a TTL on misses so a track without lyrics
is not requested repeatedly.

LRC gives a timestamp per *line*. Words are distributed across a line by
**syllable weight** rather than evenly, because "the" and "consequences" do not
take the same time to sing. Three corrections stack on top of playback position:
the user's global offset, a remembered per-track offset, and the poll round trip
— Spotify's reported position was true when the server read it, not when the
reply arrived.

---

## The window

`src/` is plain JavaScript with no framework. `runtime.js` is a small template
engine — `data-if`, `data-for`, `{{ }}` — over an HTML template.

The one thing to understand before editing the interface: **`draw()` rebuilds the
entire DOM.** Every element is therefore brand new on each state change, which
means a CSS `transition` has no previous value to interpolate from and silently
does nothing. `anim()` exists for this: it remembers what was last set for a
logical element, gives the new node that value with transitions off, forces the
browser to commit it, then sets the target. Anything that should move must go
through it.

For the same reason, overlays that are removed by `data-if` cannot fade out on
their own — the subtree is gone the instant the flag flips. `closeOverlay()`
keeps them mounted for the length of their exit animation.

`render/gl.js` is the WebGL2 renderer: a fullscreen triangle, ping-pong `RGBA16F`
feedback textures, and additive crossfading between presets whose weights sum to
one. `render/preset.js` parses the header comment out of a `.frag` and generates
the settings sliders from it, which is why adding a preset requires no code.

The **flash guard** is applied to the uniforms rather than inside any shader.
That placement is deliberate: it covers every preset including ones written
later, without a shader author needing to know it exists.

---

## Where things are written

All under `%APPDATA%\roomtone\`. Config is written atomically — the settings and
the Spotify Client ID share a file, and a half-written file would cost the user
their authentication setup as well as their preferences.

The Spotify **refresh token is not in any of these files**; it lives in the
Windows Credential Manager.

---

## Windows integration

`windows/mod.rs` does borderless fullscreen by hand in Win32 rather than through
Tauri, for one specific reason: the shell only hides the taskbar for a window
whose rectangle *equals* its monitor's. Asking Tauri for 1920×1080 produced a
1936×1089 window, because a resizable window keeps an invisible resize border
even with decorations off — so the taskbar stayed on top and the window spilled
onto the next monitor. Stripping to `WS_POPUP` removes that border and lets the
monitor rectangle be applied literally.

`autostart.rs` writes the `Run` key under `HKEY_CURRENT_USER`, never HKLM, so the
toggle needs no administrator rights.
