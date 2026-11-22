# ROOMTONE — roadmap

What is built, what is next, and what is parked. Kept honest: nothing is listed
as done until it has been run and checked on a real machine.

## Done

- WASAPI loopback capture, 2048-point FFT, 512-sample hop, ~21 ms measured
  pipeline from speaker to pixel
- Beat and onset detection (aubio), with a confidence gate on the tempo
- Spotify PKCE authentication with no backend and no client secret, surviving
  restarts
- Track metadata, artwork, and a locally interpolated playback position
- Eleven WebGL2 shader presets, hot-reloaded from disk, with settings sliders
  generated from a header comment in each `.frag`
- LRCLIB timed lyrics with a local SQLite cache, per-track offset memory, and a
  syllable-weighted word timing model
- Kinetic typography and a video-edit preset driven by those word timings
- Karaoke mode: word-by-word wipe, count-in dots, running over the live shader
- Borderless fullscreen sized to whichever monitor the window is on
- Setup remembered across launches; start with Windows
- Per-app audio capture: listen to one application rather than the whole speaker
  mix, so a notification does not land in the visual. Falls back to the device
  when the app closes or the Windows build is too old
- A full palette from the cover art — a lead hue, a genuinely different second
  hue, and a dark ground — reaching both the interface and the shaders
- A photosensitivity guard applied at the uniform level, so it covers every
  preset including ones written later
- Every keyboard-only feature promoted to a switch in settings, with the full
  key map listed in the app
- Twelve presets, including Spotlights — sweeping searchlight beams with
  volumetric haze
- Sixteen presets in three dock groups (Club, Ambient, Lyrics): Synth Grid,
  Ridgeline, Ink and Lava Lamp added, each with its own thumbnail; `@group` in
  the shader header decides where a preset sits
- Lyric timing: real word times from enhanced LRC when a file has them, a
  syllable-rate cap so a line's words stop when the singing does rather than
  stretching across an instrumental gap, pauses at punctuation, and sensible
  splitting for Chinese, Japanese, Korean, Cyrillic and Greek
- Setup fits one screen: START stays in reach (or press Enter), the Spotify
  walkthrough folds away until asked for, and choices no longer scroll the page
  back to the top
- Lighter on the machine: no shader pass behind an opaque panel, no CSS-layer
  work while shaders are on, layout measured twice a second instead of every
  frame, 30 fps when nothing is playing, and no audio frames sent to a
  minimised window
- Favourites (the star on each tile, or V) and auto-cycle: on a timer or on
  every new track, through the favourites when there are two or more
- Live dock thumbnails from a second, tiny WebGL context, so the main pass is
  never stalled by them; the drawn sketches remain underneath as the fallback
- Automatic lyric sync: an onset-correlation estimator with a confidence
  measure, applied only when two readings in a row agree; manual nudges win
- More screens: a borderless ROOMTONE per extra monitor, each with its own
  preset and settings, reopened on the next launch
- A render-quality setting (Performance, Balanced, Full)
- Motion polish: every panel animates out as well as in, and the transitions
  that the stylesheet had always declared actually run
- The interface reports its own uncaught errors into the log, and the log
  rotates instead of growing forever

## Next

- **Publish.** README, credits, contributing guide, shader-authoring docs,
  architecture notes, issue templates, GPL-3.0 headers, and a full scrub: no
  paths, machine names, usernames, or account details anywhere in the repo or in
  the commit history. The photosensitivity warning belongs in the README, and
  the guard setting should be named there.

## Parked — bigger pieces, not scheduled

### Shader authoring inside the app

Right now a preset is a `.frag` file you write in a text editor. The goal is for
somebody with no GLSL experience to make something that looks good.

- A shader editor in the app: edit the source, see it compile live against the
  music, with the error and its line number shown in place rather than in a log
- A parameter designer, so the `// @param` header can be built by clicking
  rather than by remembering the syntax
- Save, duplicate, rename and delete presets from the interface
- A gallery format: one file that carries the shader and its tuned parameter
  values, so a look can be shared as a single file
- Written documentation for the shader format — the uniforms available, what
  each one means musically, and a worked example built up from nothing

### AI-assisted shader creation

Describe the look you want, get a working preset. The pieces that would need
deciding first:

- Where the model runs, and whether a user brings their own API key. Nothing in
  ROOMTONE talks to a server today, and that is worth protecting.
- Compile and validate before anything is written to disk, so a generated shader
  can never break the dock
- Iterate on the result — "slower", "less red", "more reactive to bass" — against
  the actual uniform set rather than in the abstract

### Android

The renderer is already GLSL ES 3.00 and WebGL2, so the visual half would port
close to unchanged. The blockers are audio capture policy on Android and the
fact that Android Auto does not permit animated content while driving. A
dash-mounted standalone app is the realistic shape. See the notes in the project
discussion.

### Smaller ideas

- Multi-monitor output: a separate window per display, each with its own preset
- Record a clip of the visualizer to a video file
- MIDI or DMX out, so the room lights follow the same beat detection
- A preset that reacts to lyric *sentiment* rather than only to amplitude
