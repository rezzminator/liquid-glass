/**
 * liquid-glass — a WebGL "liquid glass" backdrop.
 *
 * Slow white smoke drifts through a dark colour field; a thick, bevelled glass slab refracts it
 * under any element (or rect) you hand it — centre-pull magnification, an outward bevel squeeze,
 * R/B chromatic dispersion along the bevel, a fainter far-face image for thickness, directional
 * light with a bright bevel facing it and shade away from it, a hairline rim, a sheen and inner edge
 * darkening. Two passes: the field into a small texture, the glass over it to the screen.
 *
 * Zero dependencies. Every number below is a live knob: `glass.set({ lensStrength: 0.4 })`.
 *
 * Behaviour: frame-capped (20 fps by default), pauses while the tab is hidden or the window is
 * unfocused, and under `prefers-reduced-motion: reduce` draws ONE still frame (redrawn on resize,
 * on `set()`, on `setLens()`). No WebGL / a shader that fails to build / a context lost mid-session
 * → logged, `onUnavailable(err)` fired once, canvas left blank — put your flat background back.
 */

export const DEFAULTS = Object.freeze({
  /** Where the glass sits: an element (tracked every frame), a `{x,y,width,height}` rect in CSS px
   *  relative to the canvas, or null (the field paints, nothing bends). */
  lens: null,
  /** Called once with the error if WebGL is unavailable, fails to build, or is lost. */
  onUnavailable: null,

  /** The colours the field is painted from (#rrggbb). */
  palette: Object.freeze({
    band: '#071417', // the darkest ground (top-left)
    deep: '#123642', // the mid ground
    mid: '#24647A', // the lightest ground (bottom-right)
    rise: '#3C7C8F', // one slow glow
    veil: '#DCE9ED', // the colour the far smoke is veiled with
    smoke: '#EEF5F3', // the colour the smoke is lit with
  }),

  // ── smoke ──────────────────────────────────────────────────────────────────
  smokeSpeed: 0.05, // field-time per second; ~7 px/s rise on a 1440px canvas
  smokeScale: 1.0, // spatial scale of the smoke (higher = finer wisps)
  smokeFar: 0.42, // weight of the far, broad layer
  smokeNear: 0.55, // weight of the near, fine layer
  veilAmount: 0.4, // how much the far layer is veiled toward `palette.veil`
  glow: 0.35, // weight of the slow `palette.rise` glow

  // ── glass ──────────────────────────────────────────────────────────────────
  lensStrength: 0.22, // centre-pull refraction (how far the field is magnified through the slab)
  bevel: 0.055, // bevel width as a fraction of the slab's short half-size
  dispersion: 0.3, // R/B split in the bevel, in bevel widths
  thickness: 0.22, // weight of the fainter far-face image
  light: 0.34, // brightening of the bevel facing the light
  shade: 0.12, // darkening of the bevel facing away
  hairline: 0.26, // the 2px rim highlight
  sheen: 0.05, // the soft gradient down the pane
  edgeDark: 0.14, // interior darkening toward the edges
  radius: 0, // corner radius of the slab, CSS px (match your element's border-radius)
  lightAngle: 123, // degrees; 0 = light from the right, 90 = from the top, 123 ≈ top-left

  // ── runtime ────────────────────────────────────────────────────────────────
  maxFps: 20,
  fieldDownscale: 3, // the field renders at 1/N of the canvas: soft by design, cheap to paint
  maxDpr: 2,
  respectReducedMotion: true,
});

const VERTEX_SHADER = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FIELD_FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uFieldRes;
uniform float uTime;
uniform vec3 uBand;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uRise;
uniform vec3 uVeil;
uniform vec3 uSmoke;
uniform float uSmokeFar;
uniform float uSmokeNear;
uniform float uVeilAmt;
uniform float uGlowAmt;
uniform float uScale;

float hash(vec2 i) {
  return fract(sin(dot(i, vec2(12.9898, 78.233))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = rot * p * 2.02 + 0.37;
    a *= 0.5;
  }
  return v;
}

// Domain-warped fbm: the warp is what curls the wisps; t carries the rise and the slow churn.
float smoke(vec2 p, float t) {
  p.y -= 0.35 * t;
  vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3) + 0.15 * t));
  vec2 r = vec2(fbm(p + 2.4 * q + vec2(1.7, 9.2) + 0.12 * t), fbm(p + 2.4 * q + vec2(8.3, 2.8) - 0.09 * t));
  return fbm(p + 1.8 * r);
}

float glow(vec2 uv, vec2 centre, vec2 radius, float t) {
  vec2 drift = 0.035 * vec2(sin(t), cos(t * 0.75));
  vec2 d = (uv - centre - drift) / radius;
  return smoothstep(1.0, 0.0, dot(d, d));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uFieldRes;
  vec2 p = vec2(uv.x * uFieldRes.x / uFieldRes.y, uv.y) * uScale;
  float g = clamp(0.35 * uv.x + 0.65 * (1.0 - uv.y), 0.0, 1.0);
  vec3 col = mix(uBand, uDeep, smoothstep(0.0, 0.55, g));
  col = mix(col, uMid, smoothstep(0.45, 1.0, g));
  col = mix(col, uRise, uGlowAmt * glow(uv, vec2(0.18, 0.78), vec2(0.36, 0.42), uTime * 2.0));
  float far = smoothstep(0.40, 0.90, smoke(p * 1.3 + vec2(3.1, 0.0), uTime * 0.6));
  float near = smoothstep(0.44, 0.92, smoke(p * 2.4 + vec2(0.0, 7.7), uTime));
  col = mix(col, uVeil, uVeilAmt * far);
  col = mix(col, uSmoke, uSmokeFar * far * far);
  col = mix(col, uSmoke, uSmokeNear * near * near);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const GLASS_FRAGMENT_SHADER = `
precision mediump float;
uniform vec2 uResolution;
uniform sampler2D uField;
uniform vec2 uLensPos;
uniform vec2 uLensHalf;
uniform float uRadius;
uniform float uLensStrength;
uniform float uBevel;
uniform float uDispersion;
uniform float uThickness;
uniform float uLight;
uniform float uShade;
uniform float uHairline;
uniform float uSheen;
uniform float uEdgeDark;
uniform vec2 uLightDir;

vec3 field(vec2 uv) {
  return texture2D(uField, clamp(uv, 0.0, 1.0)).rgb;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 uv = p / uResolution;
  vec3 col = field(uv);
  if (uLensHalf.x <= 0.0) {
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  vec2 c = uLensPos;
  vec2 h = uLensHalf;
  float r = min(uRadius, min(h.x, h.y));
  vec2 q = abs(p - c) - (h - r);
  float s = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float cover = 1.0 - smoothstep(-1.0, 1.0, s);
  if (cover <= 0.0) {
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  vec2 n = (p - c) / h;
  float inside = -s;
  float bevelPx = uBevel * min(h.x, h.y);
  float bevel = 1.0 - smoothstep(0.0, bevelPx, inside);
  float bevel2 = bevel * bevel;
  vec2 nrm = (q.x > 0.0 && q.y > 0.0) ? normalize(q) : (q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 edgeN = nrm * sign(p - c);
  vec2 cuv = c / uResolution;
  vec2 pull = (uv - cuv) * uLensStrength * (0.3 + 0.7 * dot(n, n));
  vec2 bend = edgeN * (bevel2 * bevelPx * 1.2) / uResolution;
  vec2 suv = uv - pull + bend;
  vec2 disp = edgeN * (bevel * bevelPx * uDispersion) / uResolution;
  vec3 g = vec3(field(suv - disp).r, field(suv).g, field(suv + disp).b);
  g = mix(g, field(cuv + (suv - cuv) * 0.94), uThickness);
  float facing = dot(edgeN, uLightDir);
  g += bevel2 * (uLight * max(facing, 0.0) - uShade * max(-facing, 0.0));
  float hairline = 1.0 - smoothstep(0.0, 2.0, inside);
  g += uHairline * hairline * (0.4 + 0.6 * max(facing, 0.0));
  g += uSheen * (0.5 + 0.5 * n.y) * (0.6 - 0.4 * n.x);
  g *= 1.0 - uEdgeDark * smoothstep(0.55, 1.0, max(abs(n.x), abs(n.y))) * (1.0 - bevel);
  gl_FragColor = vec4(clamp(mix(col, g, cover), 0.0, 1.0), 1.0);
}
`;

/** The GLSL, exported for anyone who would rather lift the shaders than the runtime. */
export const SHADERS = Object.freeze({
  vertex: VERTEX_SHADER,
  field: FIELD_FRAGMENT_SHADER,
  glass: GLASS_FRAGMENT_SHADER,
});

const PALETTE_UNIFORMS = [
  ['band', 'uBand'],
  ['deep', 'uDeep'],
  ['mid', 'uMid'],
  ['rise', 'uRise'],
  ['veil', 'uVeil'],
  ['smoke', 'uSmoke'],
];
const FIELD_UNIFORMS = [
  'uFieldRes', 'uTime', 'uBand', 'uDeep', 'uMid', 'uRise', 'uVeil', 'uSmoke',
  'uSmokeFar', 'uSmokeNear', 'uVeilAmt', 'uGlowAmt', 'uScale',
];
const GLASS_UNIFORMS = [
  'uResolution', 'uField', 'uLensPos', 'uLensHalf', 'uRadius', 'uLensStrength', 'uBevel', 'uDispersion',
  'uThickness', 'uLight', 'uShade', 'uHairline', 'uSheen', 'uEdgeDark', 'uLightDir',
];

/** `#rrggbb` → [r, g, b] in 0..1. Throws on anything else — colours are validated where they enter. */
export function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) throw new TypeError(`LiquidGlass: expected a #rrggbb colour, got ${JSON.stringify(hex)}`);
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader returned null');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${info}`);
  }
  return shader;
}

function linkProgram(gl, fragmentSource) {
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram returned null');
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) ?? '';
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${info}`);
  }
  return program;
}

function locations(gl, program, names) {
  const map = new Map();
  for (const name of names) map.set(name, gl.getUniformLocation(program, name));
  return (name) => map.get(name) ?? null;
}

function mergeOptions(base, patch) {
  const out = { ...base, ...patch };
  if (patch.palette) out.palette = { ...base.palette, ...patch.palette };
  return out;
}

function isRect(v) {
  return v && ['x', 'y', 'width', 'height'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));
}

export class LiquidGlass {
  /** True when this browser can hand out a WebGL context at all. */
  static isSupported() {
    try {
      return !!document.createElement('canvas').getContext('webgl');
    } catch (err) {
      console.error('LiquidGlass.isSupported: probing WebGL threw', err);
      return false;
    }
  }

  /**
   * @param {HTMLCanvasElement} canvas — sized by YOUR css (e.g. `position:absolute; inset:0; width:100%; height:100%`);
   *   the runtime only sets its pixel buffer.
   * @param {Partial<typeof DEFAULTS>} options
   */
  constructor(canvas, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('LiquidGlass: first argument must be a <canvas>');
    this.canvas = canvas;
    this.opts = mergeOptions(DEFAULTS, options);
    this._validate();
    /** False once WebGL is unavailable / lost; `onUnavailable` has fired by then. */
    this.available = false;
    /** Frames rendered so far — sample it once a second for an fps readout. */
    this.frames = 0;
    this._paused = false;
    this._hidden = typeof document !== 'undefined' && document.hidden;
    this._blurred = false;
    this._still = false;
    this._fieldTime = 0;
    this._raf = 0;
    this._last = 0;
    this._dpr = 1;
    this._fw = 1;
    this._fh = 1;
    this._gl = null;
    this._setup();
  }

  /** The current options (frozen view — change them through `set`). */
  get options() {
    return this.opts;
  }

  /** Merge a partial options object live. Palette entries merge one level deep. Returns `this`. */
  set(patch) {
    if (!patch || typeof patch !== 'object') throw new TypeError('LiquidGlass.set: expected an options object');
    this.opts = mergeOptions(this.opts, patch);
    this._validate();
    if (!this.available) return this;
    if ('fieldDownscale' in patch || 'maxDpr' in patch) this._resize();
    if ('respectReducedMotion' in patch) this._loop();
    else if (this._still) this._render();
    return this;
  }

  /** Point the slab at another element / rect, or null to stop bending. */
  setLens(lens) {
    return this.set({ lens });
  }

  /** Freeze the drift (the last frame stays); `resume()` continues without a jump. */
  pause() {
    this._paused = true;
    return this;
  }

  resume() {
    this._paused = false;
    return this;
  }

  /** Release every GL object and listener. The canvas is yours to remove. */
  destroy() {
    const gl = this._gl;
    this._teardown();
    if (gl) gl.getExtension('WEBGL_lose_context')?.loseContext();
    this._gl = null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  _validate() {
    const o = this.opts;
    this._rgb = {};
    for (const [key] of PALETTE_UNIFORMS) this._rgb[key] = hexToRgb01(o.palette[key]);
    if (o.lens != null && typeof o.lens.getBoundingClientRect !== 'function' && !isRect(o.lens)) {
      throw new TypeError('LiquidGlass: `lens` must be an element, a {x,y,width,height} rect, or null');
    }
  }

  _fail(message, err) {
    const error = err instanceof Error ? err : new Error(message);
    console.error(`LiquidGlass: ${message} — leaving the canvas blank`, error);
    const wasAvailable = this.available || this._gl !== null;
    this._teardown();
    this._gl = null;
    if (wasAvailable && typeof this.opts.onUnavailable === 'function') this.opts.onUnavailable(error);
  }

  _setup() {
    const canvas = this.canvas;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false });
    if (!gl) {
      this._gl = null;
      console.error('LiquidGlass: WebGL unavailable — leaving the canvas blank');
      if (typeof this.opts.onUnavailable === 'function') this.opts.onUnavailable(new Error('WebGL unavailable'));
      return;
    }
    this._gl = gl;
    try {
      this._fieldProgram = linkProgram(gl, FIELD_FRAGMENT_SHADER);
      this._glassProgram = linkProgram(gl, GLASS_FRAGMENT_SHADER);
      this._fu = locations(gl, this._fieldProgram, FIELD_UNIFORMS);
      this._gu = locations(gl, this._glassProgram, GLASS_UNIFORMS);
      this._quad = gl.createBuffer();
      this._tex = gl.createTexture();
      this._fbo = gl.createFramebuffer();
      if (!this._quad || !this._tex || !this._fbo) throw new Error('GL buffer/texture/framebuffer allocation failed');
    } catch (err) {
      this._fail('setup failed', err);
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this._onContextLost = (event) => {
      event.preventDefault();
      this._fail('WebGL context lost');
    };
    this._onVisibility = () => {
      this._hidden = document.hidden;
    };
    this._onBlur = () => {
      this._blurred = true;
    };
    this._onFocus = () => {
      this._blurred = false;
    };
    this._onResize = () => {
      this._resize();
      if (this._still) this._render();
    };
    this._onMotionPref = () => this._loop();
    canvas.addEventListener('webglcontextlost', this._onContextLost);
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('focus', this._onFocus);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(canvas);
    } else {
      window.addEventListener('resize', this._onResize);
    }
    this._mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    this._mq?.addEventListener?.('change', this._onMotionPref);

    this.available = true;
    this._resize();
    this._loop();
  }

  _teardown() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.available = false;
    const gl = this._gl;
    const canvas = this.canvas;
    if (this._onContextLost) canvas.removeEventListener('webglcontextlost', this._onContextLost);
    if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._onBlur) window.removeEventListener('blur', this._onBlur);
    if (this._onFocus) window.removeEventListener('focus', this._onFocus);
    if (this._ro) this._ro.disconnect();
    else if (this._onResize) window.removeEventListener('resize', this._onResize);
    this._mq?.removeEventListener?.('change', this._onMotionPref);
    this._onContextLost = this._onVisibility = this._onBlur = this._onFocus = this._onResize = null;
    this._ro = null;
    if (gl && !gl.isContextLost()) {
      if (this._fbo) gl.deleteFramebuffer(this._fbo);
      if (this._tex) gl.deleteTexture(this._tex);
      if (this._quad) gl.deleteBuffer(this._quad);
      if (this._fieldProgram) gl.deleteProgram(this._fieldProgram);
      if (this._glassProgram) gl.deleteProgram(this._glassProgram);
    }
    this._fbo = this._tex = this._quad = this._fieldProgram = this._glassProgram = null;
  }

  _resize() {
    const gl = this._gl;
    if (!gl) return;
    const canvas = this.canvas;
    this._dpr = Math.min(window.devicePixelRatio || 1, this.opts.maxDpr);
    const w = Math.max(1, Math.round(Math.max(1, canvas.clientWidth) * this._dpr));
    const h = Math.max(1, Math.round(Math.max(1, canvas.clientHeight) * this._dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const fw = Math.max(1, Math.ceil(w / this.opts.fieldDownscale));
    const fh = Math.max(1, Math.ceil(h / this.opts.fieldDownscale));
    if (fw !== this._fw || fh !== this._fh) {
      this._fw = fw;
      this._fh = fh;
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
  }

  _loop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._still = !!(this.opts.respectReducedMotion && this._mq && this._mq.matches);
    if (this._still) {
      this._render();
      return;
    }
    const frame = (now) => {
      this._raf = requestAnimationFrame(frame);
      if (this._paused || this._hidden || this._blurred) {
        this._last = now;
        return;
      }
      if (now - this._last < 1000 / Math.max(1, this.opts.maxFps)) return;
      const dt = this._last ? Math.min(now - this._last, 250) / 1000 : 0;
      this._last = now;
      this._fieldTime += dt * this.opts.smokeSpeed;
      this._render();
    };
    this._raf = requestAnimationFrame(frame);
  }

  _lensRect() {
    const lens = this.opts.lens;
    if (!lens) return null;
    if (typeof lens.getBoundingClientRect === 'function') {
      const cr = this.canvas.getBoundingClientRect();
      const er = lens.getBoundingClientRect();
      return { x: er.left - cr.left, y: er.top - cr.top, width: er.width, height: er.height };
    }
    return lens;
  }

  _bindQuad(program) {
    const gl = this._gl;
    const aPosition = gl.getAttribLocation(program, 'aPosition');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
  }

  _render() {
    const gl = this._gl;
    if (!gl || !this.available) return;
    const o = this.opts;
    const canvas = this.canvas;
    const fu = this._fu;
    const gu = this._gu;

    // Pass 1 — the field into its texture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.viewport(0, 0, this._fw, this._fh);
    gl.useProgram(this._fieldProgram);
    this._bindQuad(this._fieldProgram);
    gl.uniform2f(fu('uFieldRes'), this._fw, this._fh);
    gl.uniform1f(fu('uTime'), this._fieldTime);
    for (const [key, name] of PALETTE_UNIFORMS) {
      const [r, g, b] = this._rgb[key];
      gl.uniform3f(fu(name), r, g, b);
    }
    gl.uniform1f(fu('uSmokeFar'), o.smokeFar);
    gl.uniform1f(fu('uSmokeNear'), o.smokeNear);
    gl.uniform1f(fu('uVeilAmt'), o.veilAmount);
    gl.uniform1f(fu('uGlowAmt'), o.glow);
    gl.uniform1f(fu('uScale'), o.smokeScale);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 2 — the glass over the field, to the screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(this._glassProgram);
    this._bindQuad(this._glassProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.uniform1i(gu('uField'), 0);
    gl.uniform2f(gu('uResolution'), canvas.width, canvas.height);
    const rect = this._lensRect();
    const dpr = this._dpr;
    if (rect && rect.width > 0 && rect.height > 0) {
      gl.uniform2f(gu('uLensPos'), (rect.x + rect.width / 2) * dpr, canvas.height - (rect.y + rect.height / 2) * dpr);
      gl.uniform2f(gu('uLensHalf'), (rect.width / 2) * dpr, (rect.height / 2) * dpr);
    } else {
      gl.uniform2f(gu('uLensPos'), 0, 0);
      gl.uniform2f(gu('uLensHalf'), 0, 0);
    }
    gl.uniform1f(gu('uRadius'), Math.max(0, o.radius) * dpr);
    gl.uniform1f(gu('uLensStrength'), o.lensStrength);
    gl.uniform1f(gu('uBevel'), o.bevel);
    gl.uniform1f(gu('uDispersion'), o.dispersion);
    gl.uniform1f(gu('uThickness'), o.thickness);
    gl.uniform1f(gu('uLight'), o.light);
    gl.uniform1f(gu('uShade'), o.shade);
    gl.uniform1f(gu('uHairline'), o.hairline);
    gl.uniform1f(gu('uSheen'), o.sheen);
    gl.uniform1f(gu('uEdgeDark'), o.edgeDark);
    const a = (o.lightAngle * Math.PI) / 180;
    gl.uniform2f(gu('uLightDir'), Math.cos(a), Math.sin(a));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.frames++;
  }
}

export default LiquidGlass;
