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

// The WebGL2 renderer.
//
// One fullscreen canvas under the DOM. Every preset is a fragment shader that
// runs over the whole frame; the DOM sits on top and owns text and click
// targets, because browser-rendered text beats shader-rendered text and stays
// selectable.
//
// ## The feedback buffer
//
// Two textures, ping-ponged. Each frame renders into one while sampling the
// other as `uPrevFrame`. That single arrangement is what produces trails,
// smoke, bloom accumulation and flow fields — effects CSS cannot express at
// all, because CSS composites every frame independently and throws the last
// one away.
//
// ## Crossfading
//
// Presets do not switch, they cross-dissolve. Both shaders render in the same
// pass with additive blending and weights that sum to one, over a shared
// feedback buffer — so the trails carry through the transition rather than
// being cut off and restarted.

const VERTEX = `#version 300 es
// A single triangle covering the screen. Cheaper than two, and avoids the
// diagonal seam that a quad produces in some drivers.
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COPY = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uResolution;
out vec4 fragColor;
void main() {
  vec3 c = texture(uSrc, gl_FragCoord.xy / uResolution).rgb;
  // Reinhard-ish roll-off so accumulated feedback saturates gracefully instead
  // of clipping to flat white.
  c = c / (1.0 + c * 0.55);
  fragColor = vec4(c, 1.0);
}`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    this.ok = !!this.gl;
    this.error = this.ok ? null : 'WebGL2 is not available in this webview';
    if (!this.ok) return;

    const gl = this.gl;

    // Float targets let feedback accumulate past 1.0 before the copy pass rolls
    // it back down. Without this, trails clip and go grey.
    this.float = !!gl.getExtension('EXT_color_buffer_half_float');

    this.programs = new Map();  // id -> { program, uniforms }
    this.copy = this.build(COPY, '__copy');

    this.spectrum = this.makeTexture(gl.R8, gl.RED, 128, 1);
    this.cover = this.makeTexture(gl.RGBA8, gl.RGBA, 1, 1);
    this.hasCover = 0;

    this.targets = [null, null];
    this.size = [0, 0];
    this.frames = 0;
    this.gpuMs = 0;
  }

  /* -- resources --------------------------------------------------------- */

  makeTexture(internal, format, w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w, h, internal, format };
  }

  resize(w, h) {
    if (w === this.size[0] && h === this.size[1]) return;
    const gl = this.gl;
    this.size = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;

    for (const t of this.targets) {
      if (t) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); }
    }

    const internal = this.float ? gl.RGBA16F : gl.RGBA8;
    this.targets = [0, 1].map(() => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fbo };
    });
    this.write = 0;
  }

  /* -- shader compilation ------------------------------------------------ */

  build(source, id) {
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, VERTEX);
    if (typeof vs === 'string') return { error: vs };

    const fs = this.compile(gl.FRAGMENT_SHADER, source);
    if (typeof fs === 'string') {
      gl.deleteShader(vs);
      return { error: fs };
    }

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program) || 'link failed';
      gl.deleteProgram(program);
      return { error };
    }

    // Cache every active uniform location once. Shaders declare only what they
    // use, so a missing name is normal, not an error.
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(program, i).name.replace(/\[\d+\]$/, '');
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms, id };
  }

  compile(type, source) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || 'compile failed';
      gl.deleteShader(sh);
      return log.trim();
    }
    return sh;
  }

  /**
   * Compile a preset. Returns null on success, or the compiler's own message —
   * which is the useful thing to show someone writing a shader, verbatim.
   */
  load(preset) {
    if (!this.ok) return this.error;
    const existing = this.programs.get(preset.id);
    const built = this.build(preset.source, preset.id);
    if (built.error) return built.error;

    if (existing?.program) this.gl.deleteProgram(existing.program);
    this.programs.set(preset.id, built);
    return null;
  }

  /* -- per-frame inputs -------------------------------------------------- */

  uploadSpectrum(bytes) {
    if (!this.ok || !bytes || bytes.length === 0) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.spectrum.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bytes.length, 1, gl.RED, gl.UNSIGNED_BYTE, bytes);
  }

  uploadCover(image) {
    if (!this.ok) return;
    const gl = this.gl;
    if (!image) { this.hasCover = 0; return; }

    gl.deleteTexture(this.cover.tex);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.cover = { tex, w: image.width, h: image.height };
    this.hasCover = 1;
  }

  /* -- the frame --------------------------------------------------------- */

  /**
   * @param layers  [{ preset, weight, params }] — every preset with weight > 0
   * @param u       the shared uniform values for this frame
   */
  draw(layers, u) {
    if (!this.ok || !this.targets[0]) return;
    const gl = this.gl;
    const started = performance.now();

    const read = this.targets[this.write ^ 1];
    const target = this.targets[this.write];

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, this.size[0], this.size[1]);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Weights sum to one across the crossfade, so additive blending gives a
    // true dissolve rather than a double exposure.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    for (const layer of layers) {
      const built = this.programs.get(layer.preset.id);
      if (!built || built.error) continue;

      gl.useProgram(built.program);
      const U = built.uniforms;

      const set1f = (n, v) => { if (U[n]) gl.uniform1f(U[n], v); };

      set1f('uBass', u.bass); set1f('uMid', u.mid); set1f('uHigh', u.high);
      set1f('uKick', u.kick); set1f('uBeat', u.beat); set1f('uTime', u.time);
      set1f('uIntensity', u.intensity);
      set1f('uWeight', layer.weight);
      set1f('uHasCover', this.hasCover);

      if (U.uResolution) gl.uniform2f(U.uResolution, this.size[0], this.size[1]);
      if (U.uArtColor) gl.uniform3f(U.uArtColor, u.art[0], u.art[1], u.art[2]);
      // The cover's second hue. Shaders that do not declare it are unaffected —
      // uniforms are looked up by name, so an older preset simply never sees it.
      if (U.uArtColor2) {
        const a2 = u.art2 || u.art;
        gl.uniform3f(U.uArtColor2, a2[0], a2[1], a2[2]);
      }

      // The preset's own @param sliders.
      for (const p of layer.preset.params) {
        set1f(p.key, layer.params[p.key] ?? p.value);
      }

      if (U.uPrevFrame) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, read.tex);
        gl.uniform1i(U.uPrevFrame, 0);
      }
      if (U.uSpectrum) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.spectrum.tex);
        gl.uniform1i(U.uSpectrum, 1);
      }
      if (U.uCover) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.cover.tex);
        gl.uniform1i(U.uCover, 2);
      }

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.disable(gl.BLEND);

    // Composite to the screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.size[0], this.size[1]);
    gl.useProgram(this.copy.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    if (this.copy.uniforms.uSrc) gl.uniform1i(this.copy.uniforms.uSrc, 0);
    if (this.copy.uniforms.uResolution) {
      gl.uniform2f(this.copy.uniforms.uResolution, this.size[0], this.size[1]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.write ^= 1;
    this.frames++;
    this.gpuMs = this.gpuMs * 0.9 + (performance.now() - started) * 0.1;
  }
}

/** base64 → Uint8Array, for the spectrum arriving in the audio event. */
export function decodeSpectrum(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
