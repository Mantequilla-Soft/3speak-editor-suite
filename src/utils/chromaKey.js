/**
 * Green screen / static background keying, shared by the preview, the camera
 * recorder and the canvas export.
 *
 * The math here mirrors backend/src/services/ffmpeg.js exactly (modes, defaults,
 * ranges, formulas), so the preview matches the backend render. Keep both in step.
 *
 * clip.chromaKey (video clips only, absent = off):
 *   { color: 'green' | 'blue' | 'static', similarity, blend, spill, plateUrl?, noiseUrl? }
 *   noiseUrl: the plate's noise map (staticKeyMask.js), made while the plate was shot
 *
 * Green / blue ("color excess" key, channels in 0-255):
 *   C = screen channel (G or B), M = max of the other two
 *   e = (C - M) / max(C, 76.5)
 *   alpha = clamp(((1 - similarity) - e) / blend, 0, 1)
 *   C' = C - spill * max(C - M, 0)          (despill)
 *   Neutrals, skin, yellow and cyan have e <= 0 and stay solid.
 *
 * Static background (against a clean plate P of the empty background):
 *   pixel alpha (ffmpeg backgroundkey, BT.601 YUV):
 *     diff = |Y - Yp| + |U - Up| + |V - Vp|,  minDiff = floor(765 * similarity)
 *     pa = blend > 0 ? 1 - clamp((minDiff - diff) / blend, 0, 255) / 255 : diff > minDiff
 *   mask m: low-res foreground mask with holes filled (staticKeyMask.js, shared
 *     with the backend), upscaled bilinearly
 *   alpha = clamp(pa + 2m - 1, 0, 1)   (mask decides inside / outside, pa the outline)
 *   color = clamp((C - (1 - alpha) * spill * P) / alpha)   (unmix the wall from the edge)
 */
import { isHlsUrl, attachHls, destroyHls } from './hlsHelper'
import { createStaticMasker, staticMaskSize, plateNoiseFromFrames } from './staticKeyMask'

export const KEY_DEFAULTS = {
  chroma: { similarity: 0.75, blend: 0.15, spill: 0.8 },
  static: { similarity: 0.05, blend: 0.12, spill: 0.6 }
}
export const KEY_RANGES = {
  chroma: { similarity: [0.3, 0.97], blend: [0.001, 0.5] },
  static: { similarity: [0.01, 0.3], blend: [0, 0.5] }
}

/** Normalized key settings of a chromaKey value, or null when keying is off. */
export function normalizeChromaKey(ck) {
  if (!ck || typeof ck !== 'object' || ck.enabled === false) return null
  const mode = ck.color === 'blue' ? 'blue' : ck.color === 'static' ? 'static' : 'green'
  const kind = mode === 'static' ? 'static' : 'chroma'
  const d = KEY_DEFAULTS[kind]
  const r = KEY_RANGES[kind]
  const num = (v, def, [lo, hi]) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def)
  return {
    mode,
    similarity: num(ck.similarity, d.similarity, r.similarity),
    blend: num(ck.blend, d.blend, r.blend),
    spill: num(ck.spill, d.spill, [0, 1]),
    plateUrl: mode === 'static' && typeof ck.plateUrl === 'string' && ck.plateUrl ? ck.plateUrl : null,
    noiseUrl: mode === 'static' && typeof ck.noiseUrl === 'string' && ck.noiseUrl ? ck.noiseUrl : null
  }
}

/** A fresh chromaKey value for a mode, with that mode's defaults. */
export function defaultChromaKey(mode = 'green', plateUrl = null, noiseUrl = null) {
  const d = mode === 'static' ? KEY_DEFAULTS.static : KEY_DEFAULTS.chroma
  return mode === 'static'
    ? { color: 'static', similarity: d.similarity, blend: d.blend, spill: d.spill, ...(plateUrl ? { plateUrl } : {}), ...(noiseUrl ? { noiseUrl } : {}) }
    : { color: mode, similarity: d.similarity, blend: d.blend, spill: d.spill }
}

export function getClipChromaKey(clip) {
  return clip && clip.type === 'video' ? normalizeChromaKey(clip.chromaKey) : null
}

const keySignature = (k) => (k ? `${k.mode}:${k.similarity}:${k.blend}:${k.spill}` : 'off')

function sourceSize(src) {
  if (!src) return [0, 0]
  if (src.videoWidth !== undefined) return [src.videoWidth, src.videoHeight]
  if (src.naturalWidth !== undefined) return [src.naturalWidth, src.naturalHeight]
  return [src.width || 0, src.height || 0]
}

// ------------------------------------------------- static key: low-res mask

/**
 * Scales the frame and the plate down to the mask size (staticMaskSize) and
 * runs the shared, stateful mask module with the frame's media time. The
 * backend does the same with ffmpeg's area scaler feeding the identical module.
 */
function createLowResMasker() {
  let canvas = null
  let ctx = null
  let plateFor = null // [plate, lw, lh] the cached low-res plate belongs to
  let plateLow = null
  let noiseFor = null
  let noiseLow = null
  let out = null
  const masker = createStaticMasker()
  return {
    compute(src, plate, noiseImg, key, sw, sh, time) {
      const [lw, lh] = staticMaskSize(sw, sh)
      if (!canvas) {
        canvas = document.createElement('canvas')
        ctx = canvas.getContext('2d', { willReadFrequently: true })
      }
      if (canvas.width !== lw || canvas.height !== lh) {
        canvas.width = lw
        canvas.height = lh
      }
      if (!plateFor || plateFor[0] !== plate || plateFor[1] !== lw || plateFor[2] !== lh) {
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.clearRect(0, 0, lw, lh)
        ctx.drawImage(plate, 0, 0, lw, lh)
        plateLow = ctx.getImageData(0, 0, lw, lh).data
        plateFor = [plate, lw, lh]
      }
      if (!noiseFor || noiseFor[0] !== noiseImg || noiseFor[1] !== lw || noiseFor[2] !== lh) {
        noiseLow = null
        if (noiseImg) {
          // one byte per cell in the red channel; nearest-neighbour like the backend
          ctx.imageSmoothingEnabled = false
          ctx.clearRect(0, 0, lw, lh)
          ctx.drawImage(noiseImg, 0, 0, lw, lh)
          const d = ctx.getImageData(0, 0, lw, lh).data
          noiseLow = new Uint8Array(lw * lh)
          for (let i = 0; i < lw * lh; i++) noiseLow[i] = d[i * 4]
        }
        noiseFor = [noiseImg, lw, lh]
      }
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.clearRect(0, 0, lw, lh)
      ctx.drawImage(src, 0, 0, lw, lh)
      const frame = ctx.getImageData(0, 0, lw, lh).data
      if (!out || out.length !== lw * lh) out = new Uint8Array(lw * lh)
      masker.compute({ frame, plate: plateLow, noise: noiseLow, w: lw, h: lh, channels: 4, similarity: key.similarity, time }, out)
      return { mask: out, lw, lh }
    }
  }
}

// media time of a frame (video / camera), or wall-clock time for other sources
const frameTime = (src, time) => (typeof time === 'number' ? time : typeof src?.currentTime === 'number' ? src.currentTime : performance.now() / 1000)

// ---------------------------------------------------------------- WebGL keyer

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_tex;
uniform sampler2D u_plate;
uniform sampler2D u_mask;  // static: low-res foreground mask (holes filled)
uniform int u_mode;        // 0 green, 1 blue, 2 static, 3 pass-through
uniform float u_thr;       // 1 - similarity
uniform float u_blend;
uniform float u_spill;
uniform float u_minDiff;   // static: floor(765 * similarity)
uniform float u_sblend;    // static: blend
varying vec2 v_uv;

vec3 yuv601(vec3 c) {
  vec3 p = c * 255.0;
  return vec3(
    16.0 + dot(p, vec3(0.256788, 0.504129, 0.097906)),
    128.0 + dot(p, vec3(-0.148223, -0.290993, 0.439216)),
    128.0 + dot(p, vec3(0.439216, -0.367788, -0.071427)));
}

void main() {
  vec3 rgb = texture2D(u_tex, v_uv).rgb;
  float a = 1.0;
  if (u_mode == 2) {
    vec3 P = texture2D(u_plate, v_uv).rgb;
    vec3 d = abs(yuv601(rgb) - yuv601(P));
    float diff = d.x + d.y + d.z;
    float pa;
    if (u_sblend > 0.0) pa = floor(255.0 - clamp((u_minDiff - diff) / u_sblend, 0.0, 255.0));
    else pa = diff > u_minDiff ? 255.0 : 0.0;
    float m = floor(texture2D(u_mask, v_uv).r * 255.0 + 0.5);
    a = clamp(pa + 2.0 * m - 255.0, 0.0, 255.0) / 255.0;
    if (a > 0.0) rgb = clamp((rgb - (1.0 - a) * u_spill * P) / a, 0.0, 1.0);
  } else if (u_mode < 2) {
    float x = floor((u_mode == 1 ? rgb.b : rgb.g) * 255.0 + 0.5);
    float y = floor((u_mode == 1 ? max(rgb.r, rgb.g) : max(rgb.r, rgb.b)) * 255.0 + 0.5);
    float e = (x - y) / max(x, 76.5);
    a = clamp((u_thr - e) / u_blend, 0.0, 1.0);
    float c = (x - u_spill * max(x - y, 0.0)) / 255.0;
    if (u_mode == 1) rgb.b = c; else rgb.g = c;
  }
  gl_FragColor = vec4(rgb * a, a);
}`

function createWebGLKeyer(canvas, { preserveDrawingBuffer = false } = {}) {
  let gl = null
  try {
    const opts = { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer }
    gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts)
  } catch { gl = null }
  if (!gl) return null

  const compile = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('[chromaKey] shader:', gl.getShaderInfoLog(s))
      return null
    }
    return s
  }
  const vs = compile(gl.VERTEX_SHADER, VERT)
  const fs = compile(gl.FRAGMENT_SHADER, FRAG)
  if (!vs || !fs) return null
  const prog = gl.createProgram()
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  const makeTex = (unit) => {
    const t = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
    return t
  }
  const tex = makeTex(0)
  const plateTex = makeTex(1)
  const maskTex = makeTex(2)
  const u = (n) => gl.getUniformLocation(prog, n)
  gl.uniform1i(u('u_tex'), 0)
  gl.uniform1i(u('u_plate'), 1)
  gl.uniform1i(u('u_mask'), 2)
  const uMode = u('u_mode')
  const uThr = u('u_thr')
  const uBlend = u('u_blend')
  const uSpill = u('u_spill')
  const uMinDiff = u('u_minDiff')
  const uSBlend = u('u_sblend')
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1) // the mask rows are not 4-byte aligned

  let plate = null
  let noiseImg = null
  const low = createLowResMasker()

  return {
    kind: 'webgl',
    canvas,
    setPlate(img) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, plateTex)
      if (img) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
      plate = img || null
    },
    setNoise(img) {
      noiseImg = img || null
    },
    // Throws on a cross-origin (tainted) source. time: the frame's media time
    // (defaults to src.currentTime); the static key smooths over it.
    draw(src, key, time) {
      const [w, h] = sourceSize(src)
      if (!w || !h) return false
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      gl.viewport(0, 0, w, h)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
      const mode = !key ? 3 : key.mode === 'static' ? (plate ? 2 : 3) : key.mode === 'blue' ? 1 : 0
      if (mode === 2) {
        const { mask, lw, lh } = low.compute(src, plate, noiseImg, key, w, h, frameTime(src, time))
        gl.activeTexture(gl.TEXTURE2)
        gl.bindTexture(gl.TEXTURE_2D, maskTex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, lw, lh, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, mask)
      }
      gl.uniform1i(uMode, mode)
      if (key) {
        gl.uniform1f(uThr, 1 - key.similarity)
        gl.uniform1f(uBlend, Math.max(0.001, key.blend))
        gl.uniform1f(uSpill, key.spill)
        gl.uniform1f(uMinDiff, Math.floor(765 * key.similarity))
        gl.uniform1f(uSBlend, key.blend)
      }
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      return true
    },
    dispose() {
      try { gl.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* already gone */ }
    }
  }
}

// ------------------------------------------------------------ 2D fallback

function create2DKeyer(canvas, { maxSide = 640 } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  let plateImg = null
  let plateData = null // ImageData of the plate at the current canvas size
  let noiseImg = null
  const low = createLowResMasker()

  const yuv = (r, g, b) => [
    16 + 0.256788 * r + 0.504129 * g + 0.097906 * b,
    128 - 0.148223 * r - 0.290993 * g + 0.439216 * b,
    128 + 0.439216 * r - 0.367788 * g - 0.071427 * b
  ]

  return {
    kind: '2d',
    canvas,
    setPlate(img) {
      plateImg = img || null
      plateData = null
    },
    setNoise(img) {
      noiseImg = img || null
    },
    draw(src, key, time) {
      const [sw, sh] = sourceSize(src)
      if (!sw || !sh) return false
      const s = Math.min(1, maxSide / Math.max(sw, sh))
      const w = Math.max(1, Math.round(sw * s))
      const h = Math.max(1, Math.round(sh * s))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        plateData = null
      }
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(src, 0, 0, w, h)
      if (!key || (key.mode === 'static' && !plateImg)) return true
      const img = ctx.getImageData(0, 0, w, h) // throws when tainted
      const p = img.data
      if (key.mode === 'static') {
        const { mask, lw, lh } = low.compute(src, plateImg, noiseImg, key, sw, sh, frameTime(src, time))
        if (!plateData) {
          ctx.drawImage(plateImg, 0, 0, w, h)
          plateData = ctx.getImageData(0, 0, w, h).data
        }
        const minDiff = Math.floor(765 * key.similarity)
        for (let y = 0, i = 0; y < h; y++) {
          // bilinear mask sample at the pixel center, like the WebGL texture
          const my = Math.min(lh - 1, Math.max(0, (y + 0.5) * lh / h - 0.5))
          const y0 = Math.floor(my), y1 = Math.min(lh - 1, y0 + 1), fy = my - y0
          for (let x = 0; x < w; x++, i += 4) {
            const mx = Math.min(lw - 1, Math.max(0, (x + 0.5) * lw / w - 0.5))
            const x0 = Math.floor(mx), x1 = Math.min(lw - 1, x0 + 1), fx = mx - x0
            const top = mask[y0 * lw + x0] * (1 - fx) + mask[y0 * lw + x1] * fx
            const bot = mask[y1 * lw + x0] * (1 - fx) + mask[y1 * lw + x1] * fx
            const m = Math.round(top * (1 - fy) + bot * fy)
            const a = yuv(p[i], p[i + 1], p[i + 2])
            const b = yuv(plateData[i], plateData[i + 1], plateData[i + 2])
            const diff = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
            const pa = key.blend > 0
              ? Math.floor(255 - Math.min(255, Math.max(0, (minDiff - diff) / key.blend)))
              : (diff > minDiff ? 255 : 0)
            const al = Math.min(255, Math.max(0, pa + 2 * m - 255))
            p[i + 3] = al
            if (al > 0) {
              const k = (255 - al) * key.spill
              for (let c = 0; c < 3; c++) p[i + c] = Math.min(255, Math.max(0, (p[i + c] - k * plateData[i + c] / 255) * 255 / al))
            }
          }
        }
      } else {
        const blue = key.mode === 'blue'
        const thr = 1 - key.similarity
        const bl = Math.max(0.001, key.blend)
        const ci = blue ? 2 : 1
        for (let i = 0; i < p.length; i += 4) {
          const x = p[i + ci]
          const y = blue ? Math.max(p[i], p[i + 1]) : Math.max(p[i], p[i + 2])
          const e = (x - y) / Math.max(x, 76.5)
          p[i + 3] = 255 * Math.min(1, Math.max(0, (thr - e) / bl))
          p[i + ci] = x - key.spill * Math.max(x - y, 0)
        }
      }
      ctx.putImageData(img, 0, 0)
      return true
    },
    dispose() {}
  }
}

/**
 * A keyer drawing into `canvas`: WebGL when available, 2D canvas otherwise.
 * keyer.draw(source, normalizedKey) keys the source's current frame into the
 * canvas (sized to the source; the 2D fallback scales down to maxSide).
 * Returns null if neither context is available.
 */
export function createKeyer(canvas, options = {}) {
  return createWebGLKeyer(canvas, options) || create2DKeyer(canvas, options)
}

export { keySignature }

// --------------------------------------------------------------- frame grabs

/** Copy a frame of a video / image / canvas into a new canvas (longest side <= maxSide). */
export function captureFrame(src, maxSide = 1280) {
  const [w, h] = sourceSize(src)
  if (!w || !h) return null
  const s = Math.min(1, maxSide / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.round(w * s)
  c.height = Math.round(h * s)
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height)
  return c
}

/** Average several frames (sources of equal size) into one canvas: less sensor noise. */
function averageFrames(frames) {
  const c = document.createElement('canvas')
  c.width = frames[0].width
  c.height = frames[0].height
  const ctx = c.getContext('2d')
  const acc = new Float32Array(c.width * c.height * 4)
  for (const f of frames) {
    const d = f.getContext('2d').getImageData(0, 0, c.width, c.height).data
    for (let i = 0; i < d.length; i++) acc[i] += d[i]
  }
  const img = ctx.createImageData(c.width, c.height)
  for (let i = 0; i < acc.length; i++) img.data[i] = Math.round(acc[i] / frames.length)
  ctx.putImageData(img, 0, 0)
  return c
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * The static key's noise map from frames of the empty background (canvases):
 * each is scaled to the mask size like the keyer does, the shared module
 * measures the per-cell spread, and it is returned as a canvas (value in red).
 */
function noiseMapFromFrames(frames, sw, sh) {
  if (frames.length < 2) return null
  const [lw, lh] = staticMaskSize(sw, sh)
  const c = document.createElement('canvas')
  c.width = lw
  c.height = lh
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  const lows = frames.map(f => {
    ctx.clearRect(0, 0, lw, lh)
    ctx.drawImage(f, 0, 0, lw, lh)
    return ctx.getImageData(0, 0, lw, lh).data
  })
  const noise = plateNoiseFromFrames(lows, lw, lh, 4)
  const img = ctx.createImageData(lw, lh)
  for (let i = 0; i < lw * lh; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = noise[i]
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}

/**
 * Clean plate from a live camera: wait until the picture holds still (the
 * person has left and the camera finished re-exposing / re-balancing, at most
 * settleMs), call beforeCapture (e.g. lock the camera), then average `count`
 * frames and measure their noise. Same orientation as the recording (the raw
 * stream; the on-screen mirroring is CSS only).
 * Returns { plate: canvas, noise: canvas | null } or null.
 */
export async function captureSteadyPlate(video, { count = 12, interval = 70, settleMs = 3000, maxSide = 1280, beforeCapture } = {}) {
  const probe = document.createElement('canvas')
  probe.width = 32
  probe.height = 18
  const pctx = probe.getContext('2d', { willReadFrequently: true })
  const thumb = () => {
    pctx.drawImage(video, 0, 0, 32, 18)
    return pctx.getImageData(0, 0, 32, 18).data
  }
  let last = thumb()
  let still = 0
  const t0 = Date.now()
  while (still < 3 && Date.now() - t0 < settleMs) {
    await sleep(100)
    const cur = thumb()
    let d = 0
    for (let i = 0; i < cur.length; i += 4) d += Math.abs(cur[i] - last[i]) + Math.abs(cur[i + 1] - last[i + 1]) + Math.abs(cur[i + 2] - last[i + 2])
    still = d / (32 * 18 * 3) < 1.5 ? still + 1 : 0
    last = cur
  }
  if (beforeCapture) {
    try { await beforeCapture() } catch { /* best effort */ }
    await sleep(300) // let a lock settle before the shots
  }
  const frames = []
  for (let i = 0; i < count; i++) {
    const f = captureFrame(video, maxSide)
    if (f) frames.push(f)
    if (i < count - 1) await sleep(interval)
  }
  if (!frames.length) return null
  return { plate: averageFrames(frames), noise: noiseMapFromFrames(frames, video.videoWidth, video.videoHeight) }
}

/** Canvas -> PNG blob: URL (lossless, so the static key compares against a clean plate) */
export function canvasToBlobUrl(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('Could not encode the frame'))), 'image/png')
  })
}

/**
 * Grab the frame at `time` seconds of a video URL into a canvas. With
 * average > 1, that many consecutive frames (1/30 s apart) are averaged, and
 * withNoise also returns their noise map: resolves { plate, noise }.
 */
export function grabVideoFrame(url, time, maxSide = 1280, average = 1, withNoise = false) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    let hls = null
    let done = false
    const finish = (err, canvas) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (hls) destroyHls(hls)
      v.removeAttribute('src')
      v.load()
      if (err) reject(err)
      else resolve(canvas)
    }
    const timer = setTimeout(() => finish(new Error('Timed out loading the video frame')), 15000)
    v.addEventListener('error', () => finish(new Error('Could not load the video')), { once: true })
    v.addEventListener('loadeddata', () => {
      const end = (v.duration || time + 1) - 0.05
      const start = Math.max(0, Math.min(time, end - (average - 1) / 30))
      const frames = []
      const onSeeked = () => {
        try {
          const c = captureFrame(v, maxSide)
          // Throws now (instead of at upload) when the video is cross-origin
          c.getContext('2d').getImageData(0, 0, 1, 1)
          frames.push(c)
        } catch (e) {
          v.removeEventListener('seeked', onSeeked)
          return finish(e)
        }
        if (frames.length >= average) {
          v.removeEventListener('seeked', onSeeked)
          const plate = frames.length > 1 ? averageFrames(frames) : frames[0]
          finish(null, withNoise ? { plate, noise: noiseMapFromFrames(frames, v.videoWidth, v.videoHeight) } : plate)
        } else {
          v.currentTime = Math.min(end, start + frames.length / 30)
        }
      }
      v.addEventListener('seeked', onSeeked)
      v.currentTime = start
    }, { once: true })
    if (isHlsUrl(url)) hls = attachHls(v, url)
    else v.src = url
  })
}
