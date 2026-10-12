/**
 * Static-background key: the low-resolution foreground mask.
 *
 * SHARED FILE: an identical copy lives at backend/src/utils/staticKeyMask.js
 * (the preview runs it per drawn frame, the backend render per video frame).
 * Edit one, copy it to the other; `node scripts/check-static-mask-sync.mjs`
 * fails when the two differ. No imports, plain JS, runs in browsers and Node.
 *
 * Deciding "foreground or background" per pixel and per frame flickers: sensor
 * noise, compression, camera shake, auto exposure / white balance and autofocus
 * all push background across any fixed threshold. So the decision is made on a
 * small frame (~192 px long side), per cell, with memory:
 *
 *  1. Noise model from the plate: while the empty background is shot, the
 *     per-cell spread (std) over several frames is recorded (plateNoiseFromFrames,
 *     sent along as a small "noise map" image). A cell's threshold is
 *       base (Threshold slider) + 3 x its noise + 0.1 x the plate's local contrast
 *     so dark (noisy) corners and busy edges need a bigger change to count.
 *  2. Tolerances: a cell is compared with the 3x3 neighbouring plate cells and
 *     the best match counts (camera shake), and also as a blurred cell against
 *     a blurred plate; the smaller difference wins (autofocus: a background that
 *     only got softer or sharper keeps its blurred colours).
 *  3. Exposure / white balance: per-channel gain = median ratio frame / plate
 *     over quiet, flat, not-dark background cells (a busy screen or an edge must
 *     not steer it), smoothed over time (0.4 s), applied to the plate.
 *  4. Time: the difference (relative to the cell's threshold) is smoothed
 *     (0.12 s); a cell turns foreground above 1.0 and back only below 0.7, and
 *     only after holding the new state for 0.1 s (on) / 0.15 s (off). A
 *     foreground cell that stays below 1.0 for a second is released anyway, so
 *     the path someone walked along cannot stay behind as a ghost. Cells that
 *     are clearly background again (below 0.35) fade and release 3x faster.
 *  5. Shape: tiny specks dropped, small gaps in the outline closed, then the
 *     background is flood-filled from the top, left and right borders; cells it
 *     does not reach are enclosed by the subject and count as foreground. That
 *     "enclosed" verdict also has to hold for 0.15 s (on) / 0.4 s (off), so a
 *     gap that opens for a moment does not flip a whole region.
 *  6. 3x3 blur (soft band at the outline), lightly smoothed over time (0.05 s).
 * All time constants are in seconds of media time, so the preview (which may
 * skip frames) and the backend (every frame) converge on the same result.
 * A jump in time (seek) or new settings start over from the current frame.
 *
 * The full-resolution keyer uses the result m as
 *   alpha = clamp(pixelAlpha + 2 * m - 1, 0, 1)
 */

export const STATIC_MASK_LONG_SIDE = 192
/** Noise map bytes = round(std * NOISE_SCALE), std in |dY|+|dU|+|dV| units */
export const NOISE_SCALE = 4
const DEFAULT_NOISE = 1.5 // std assumed without a noise map
const GAIN_MIN = 0.7, GAIN_STEP = 0.0025, GAIN_BINS = 281 // ratio histogram 0.7 - 1.4

export const STATIC_MASK_TUNING = {
  lowResFactor: 0.6, // low-res base threshold = 765 * similarity * this
  noiseK: 3,
  gradK: 0.1,
  shiftTolerance: true,
  focusTolerance: true,
  temporal: true,
  tauScore: 0.12,
  tauGain: 0.4,
  tauMask: 0.05,
  onLevel: 1.0,
  offLevel: 0.7,
  holdOn: 0.1,
  holdOff: 0.15,
  release: 1.0, // a foreground cell that stayed below onLevel this long goes back
  clearLevel: 0.35, // clearly background: fade and release 3x faster (no trail behind movement)
  fillHoldOn: 0.15,
  fillHoldOff: 0.4,
  maxGap: 0.5 // seconds; a bigger jump in time restarts the state
}

/** Mask size for a source of w x h (both environments use this). */
export function staticMaskSize(w, h) {
  const s = STATIC_MASK_LONG_SIDE / Math.max(w, h, 1)
  return [Math.max(16, Math.round(w * s)), Math.max(16, Math.round(h * s))]
}

const toY = (r, g, b) => 0.256788 * r + 0.504129 * g + 0.097906 * b
const toU = (r, g, b) => -0.148223 * r - 0.290993 * g + 0.439216 * b
const toV = (r, g, b) => 0.439216 * r - 0.367788 * g - 0.071427 * b

/**
 * Noise map from several low-res frames of the empty background (pixel arrays
 * of w x h, `channels` bytes per pixel): per cell std of Y + U + V, as bytes.
 */
export function plateNoiseFromFrames(frames, w, h, channels) {
  const n = w * h
  const out = new Uint8Array(n)
  const k = frames.length
  if (k < 2) return out.fill(Math.round(DEFAULT_NOISE * NOISE_SCALE))
  for (let i = 0, o = 0; i < n; i++, o += channels) {
    let sy = 0, su = 0, sv = 0, qy = 0, qu = 0, qv = 0
    for (const f of frames) {
      const y = toY(f[o], f[o + 1], f[o + 2]), u = toU(f[o], f[o + 1], f[o + 2]), v = toV(f[o], f[o + 1], f[o + 2])
      sy += y; su += u; sv += v; qy += y * y; qu += u * u; qv += v * v
    }
    const sd = (s, q) => Math.sqrt(Math.max(0, q / k - (s / k) ** 2))
    out[i] = Math.min(255, Math.round((sd(sy, qy) + sd(su, qu) + sd(sv, qv)) * NOISE_SCALE))
  }
  return out
}

/**
 * A stateful masker (one per clip / camera view).
 * compute({ frame, plate, noise, w, h, channels, similarity, time }, out)
 *   frame, plate: pixel data of w x h, `channels` bytes per pixel (3 rgb / 4 rgba)
 *   noise:  noise map (w * h bytes) or null
 *   time:   media time of the frame in seconds
 * Returns a Uint8Array(w * h), 0 = background, 255 = foreground.
 */
export function createStaticMasker(tuning = {}) {
  const T = { ...STATIC_MASK_TUNING, ...tuning }
  let st = null // per-size / per-plate state

  const setup = (plate, noise, w, h, channels, similarity) => {
    const n = w * h
    const P = new Float32Array(n * 3) // plate rgb
    const PB = new Float32Array(n * 3) // plate, 3x3 binomial blur
    for (let i = 0, o = 0; i < n; i++, o += channels) { P[i * 3] = plate[o]; P[i * 3 + 1] = plate[o + 1]; P[i * 3 + 2] = plate[o + 2] }
    blur3(P, PB, w, h)
    // per-cell threshold: base + noise + local contrast of the plate
    const base = 765 * similarity * T.lowResFactor
    const thr = new Float32Array(n)
    const quiet = new Uint8Array(n) // cells fit for the exposure estimate
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x
      let grad = 0
      if (x > 0) grad = Math.max(grad, diff3(P, i, P, i - 1))
      if (x < w - 1) grad = Math.max(grad, diff3(P, i, P, i + 1))
      if (y > 0) grad = Math.max(grad, diff3(P, i, P, i - w))
      if (y < h - 1) grad = Math.max(grad, diff3(P, i, P, i + w))
      const sigma = noise ? noise[i] / NOISE_SCALE : DEFAULT_NOISE
      thr[i] = Math.max(1, base + T.noiseK * sigma + T.gradK * grad)
      quiet[i] = sigma <= 3 && grad <= 12 && P[i * 3] > 24 && P[i * 3 + 1] > 24 && P[i * 3 + 2] > 24 ? 1 : 0
    }
    st = {
      plate, noise, w, h, channels, similarity, P, PB, thr, quiet, low: new Float32Array(n),
      hist: new Uint32Array(3 * GAIN_BINS),
      F: new Float32Array(n * 3), FB: new Float32Array(n * 3),
      // per frame: YUV of the frame / gained plate (and their blurred versions)
      fy: new Float32Array(n * 3), py: new Float32Array(n * 3), fby: new Float32Array(n * 3), pby: new Float32Array(n * 3),
      score: new Float32Array(n), fg: new Uint8Array(n), hold: new Float32Array(n),
      fill: new Uint8Array(n), fillHold: new Float32Array(n), prevSolid: new Uint8Array(n),
      soft: new Float32Array(n), gain: [1, 1, 1], time: null, out: new Uint8Array(n)
    }
  }

  return {
    reset() { if (st) st.time = null },
    compute({ frame, plate, noise, w, h, channels, similarity, time }, out) {
      if (!st || st.plate !== plate || st.noise !== noise || st.w !== w || st.h !== h || st.channels !== channels || st.similarity !== similarity) {
        setup(plate, noise, w, h, channels, similarity)
      }
      const s = st
      const n = w * h
      const dt = s.time == null || !T.temporal ? null : time - s.time
      if (dt === 0) { if (out) out.set(s.out); return out || s.out }
      const fresh = dt == null || dt < 0 || dt > T.maxGap
      const k = (tau) => (fresh ? 1 : 1 - Math.exp(-dt / tau))
      s.time = time

      // frame rgb (+ blurred copy for the focus tolerance)
      for (let i = 0, o = 0; i < n; i++, o += channels) { s.F[i * 3] = frame[o]; s.F[i * 3 + 1] = frame[o + 1]; s.F[i * 3 + 2] = frame[o + 2] }
      if (T.focusTolerance) blur3(s.F, s.FB, w, h)

      // exposure / white balance: median frame / plate ratio per channel over
      // quiet background cells (previous state; loosely matching cells when fresh)
      {
        const hist = s.hist
        hist.fill(0)
        let cnt = 0
        for (let i = 0; i < n; i++) {
          if (!s.quiet[i]) continue
          if (fresh ? diff3g(s.F, i, s.P, i, s.gain) > s.thr[i] * 3 : (s.fg[i] || s.fill[i])) continue
          for (let c = 0; c < 3; c++) {
            const r = s.F[i * 3 + c] / s.P[i * 3 + c]
            const b = Math.min(GAIN_BINS - 1, Math.max(0, Math.round((r - GAIN_MIN) / GAIN_STEP)))
            hist[c * GAIN_BINS + b]++
          }
          cnt++
        }
        if (cnt >= n * 0.05) {
          const kg = k(T.tauGain)
          for (let c = 0; c < 3; c++) {
            let acc = 0, b = 0
            while (b < GAIN_BINS - 1 && (acc += hist[c * GAIN_BINS + b]) < cnt / 2) b++
            const target = Math.min(1.33, Math.max(0.75, GAIN_MIN + b * GAIN_STEP))
            s.gain[c] += (target - s.gain[c]) * kg
          }
        }
      }

      // YUV once per cell: the gained plate is clamped like diff3g does
      toYuv(s.F, s.fy, n, null)
      toYuv(s.P, s.py, n, s.gain)
      if (T.focusTolerance) { toYuv(s.FB, s.fby, n, null); toYuv(s.PB, s.pby, n, s.gain) }

      // per-cell difference relative to its threshold, smoothed; hysteresis + hold
      const ks = k(T.tauScore)
      const ksClear = k(T.tauScore / 3)
      const { fy, py, fby, pby, thr, score, fg, hold, low } = s
      const shiftTol = T.shiftTolerance, focusTol = T.focusTolerance
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x
        const i3 = i * 3
        const Y = fy[i3], U = fy[i3 + 1], V = fy[i3 + 2]
        let d = Math.abs(Y - py[i3]) + Math.abs(U - py[i3 + 1]) + Math.abs(V - py[i3 + 2])
        if (shiftTol) {
          const y0 = y > 0 ? y - 1 : y, y1 = y < h - 1 ? y + 1 : y
          const x0 = x > 0 ? x - 1 : x, x1 = x < w - 1 ? x + 1 : x
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              const j3 = (yy * w + xx) * 3
              const e = Math.abs(Y - py[j3]) + Math.abs(U - py[j3 + 1]) + Math.abs(V - py[j3 + 2])
              if (e < d) d = e
            }
          }
        }
        if (focusTol) {
          const e = Math.abs(fby[i3] - pby[i3]) + Math.abs(fby[i3 + 1] - pby[i3 + 1]) + Math.abs(fby[i3 + 2] - pby[i3 + 2])
          if (e < d) d = e
        }
        const r = d / thr[i]
        const clear = r < T.clearLevel
        score[i] += (r - score[i]) * (clear && r < score[i] ? ksClear : ks)
        if (fresh) {
          fg[i] = score[i] > T.onLevel ? 1 : 0
          hold[i] = 0
          low[i] = 0
          continue
        }
        if (fg[i] && score[i] <= T.onLevel) low[i] += dt
        else low[i] = 0
        if (fg[i] && low[i] >= T.release) { fg[i] = 0; hold[i] = 0; low[i] = 0; continue }
        const want = fg[i] ? (score[i] > T.offLevel ? 1 : 0) : (score[i] > T.onLevel ? 1 : 0)
        if (want === fg[i]) { hold[i] = 0; continue }
        hold[i] += dt
        if (hold[i] >= (want ? T.holdOn : clear ? T.holdOff / 3 : T.holdOff)) { fg[i] = want; hold[i] = 0 }
      }

      // shape: specks out, gaps closed, enclosed background filled (with hold)
      const m = new Uint8Array(s.fg)
      removeSmallBlobs(m, w, h, 1, Math.max(4, Math.round(n * 0.003)))
      const tmp = new Uint8Array(n)
      morph(m, tmp, w, h, 2, true)
      morph(tmp, m, w, h, 2, false)
      const reached = floodFromBorders(m, w, h)
      for (let i = 0; i < n; i++) {
        const want = m[i] || !reached[i] ? 1 : 0
        if (fresh || want === s.fill[i]) { s.fill[i] = want; s.fillHold[i] = 0; continue }
        // solid foreground turns on at once, and a cell that was solid (not just
        // enclosed) has had its own hold already: only enclosed areas wait here
        if (m[i] || s.prevSolid[i]) { s.fill[i] = want; s.fillHold[i] = 0; continue }
        s.fillHold[i] += dt
        if (s.fillHold[i] >= (want ? T.fillHoldOn : T.fillHoldOff)) { s.fill[i] = want; s.fillHold[i] = 0 }
      }

      s.prevSolid.set(m)

      // soft band (3x3 box, separable, edges clamped) + light smoothing over time
      const km = k(T.tauMask)
      const res = out || s.out
      const rows = s.rows || (s.rows = new Uint8Array(n))
      const fill = s.fill, soft = s.soft
      for (let y = 0; y < h; y++) {
        const r0 = y * w
        for (let x = 0; x < w; x++) {
          rows[r0 + x] = fill[r0 + (x > 0 ? x - 1 : 0)] + fill[r0 + x] + fill[r0 + (x < w - 1 ? x + 1 : x)]
        }
      }
      for (let y = 0; y < h; y++) {
        const ra = (y > 0 ? y - 1 : 0) * w, rb = y * w, rc = (y < h - 1 ? y + 1 : y) * w
        for (let x = 0; x < w; x++) {
          const i = rb + x
          const sum = rows[ra + x] + rows[rb + x] + rows[rc + x]
          soft[i] += (sum * 255 / 9 - soft[i]) * km
          res[i] = Math.round(soft[i])
        }
      }
      if (res !== s.out) s.out.set(res)
      return res
    }
  }
}

// rgb (optionally scaled by gain, clamped at 255) -> Y U V per cell
function toYuv(src, dst, n, g) {
  for (let i = 0; i < n * 3; i += 3) {
    const r = g ? Math.min(255, src[i] * g[0]) : src[i]
    const gg = g ? Math.min(255, src[i + 1] * g[1]) : src[i + 1]
    const b = g ? Math.min(255, src[i + 2] * g[2]) : src[i + 2]
    dst[i] = toY(r, gg, b); dst[i + 1] = toU(r, gg, b); dst[i + 2] = toV(r, gg, b)
  }
}
function yuvDist(A, i, B, j) {
  return Math.abs(A[i * 3] - B[j * 3]) + Math.abs(A[i * 3 + 1] - B[j * 3 + 1]) + Math.abs(A[i * 3 + 2] - B[j * 3 + 2])
}

// |dY| + |dU| + |dV| between rgb cell i of A and cell j of B (B scaled by gain)
function diff3g(A, i, B, j, g) {
  const dr = A[i * 3] - Math.min(255, B[j * 3] * g[0])
  const dg = A[i * 3 + 1] - Math.min(255, B[j * 3 + 1] * g[1])
  const db = A[i * 3 + 2] - Math.min(255, B[j * 3 + 2] * g[2])
  return Math.abs(toY(dr, dg, db)) + Math.abs(toU(dr, dg, db)) + Math.abs(toV(dr, dg, db))
}
function diff3(A, i, B, j) {
  const dr = A[i * 3] - B[j * 3], dg = A[i * 3 + 1] - B[j * 3 + 1], db = A[i * 3 + 2] - B[j * 3 + 2]
  return Math.abs(toY(dr, dg, db)) + Math.abs(toU(dr, dg, db)) + Math.abs(toV(dr, dg, db))
}

// 3x3 binomial blur ([1 2 1] x [1 2 1] / 16) of an rgb float image, edges clamped
function blur3(src, dst, w, h) {
  const mid = new Float32Array(src.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = (y * w + Math.max(0, x - 1)) * 3, b = (y * w + x) * 3, c = (y * w + Math.min(w - 1, x + 1)) * 3
    for (let k = 0; k < 3; k++) mid[b + k] = (src[a + k] + 2 * src[b + k] + src[c + k]) / 4
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = (Math.max(0, y - 1) * w + x) * 3, b = (y * w + x) * 3, c = (Math.min(h - 1, y + 1) * w + x) * 3
    for (let k = 0; k < 3; k++) dst[b + k] = (mid[a + k] + 2 * mid[b + k] + mid[c + k]) / 4
  }
}

// Background reachable from the top, left and right borders (not the bottom:
// a person is usually cut off there, and wall-coloured patches on a shirt
// would leak out through it)
function floodFromBorders(fg, w, h) {
  const n = w * h
  const reached = new Uint8Array(n)
  const stack = new Int32Array(n)
  let sp = 0
  const seed = (i) => { if (!fg[i] && !reached[i]) { reached[i] = 1; stack[sp++] = i } }
  for (let x = 0; x < w; x++) seed(x)
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1) }
  while (sp > 0) {
    const i = stack[--sp]
    const x = i % w
    if (x > 0) seed(i - 1)
    if (x < w - 1) seed(i + 1)
    if (i >= w) seed(i - w)
    if (i < n - w) seed(i + w)
  }
  return reached
}

// Square dilate (grow 1s) or erode (shrink 1s) by radius r, separable
function morph(src, dst, w, h, r, dilate) {
  const mid = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        const s = src[row + k]
        if (dilate ? s : !s) { v = dilate ? 1 : 0; break }
      }
      mid[row + x] = v
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = dilate ? 0 : 1
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        const s = mid[k * w + x]
        if (dilate ? s : !s) { v = dilate ? 1 : 0; break }
      }
      dst[y * w + x] = v
    }
  }
}

// Set 4-connected components of `value` smaller than minSize to the other value
function removeSmallBlobs(m, w, h, value, minSize) {
  const n = w * h
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  const comp = new Int32Array(n)
  for (let start = 0; start < n; start++) {
    if (seen[start] || m[start] !== value) continue
    let sp = 0, cn = 0
    seen[start] = 1
    stack[sp++] = start
    while (sp > 0) {
      const i = stack[--sp]
      comp[cn++] = i
      const x = i % w
      if (x > 0 && !seen[i - 1] && m[i - 1] === value) { seen[i - 1] = 1; stack[sp++] = i - 1 }
      if (x < w - 1 && !seen[i + 1] && m[i + 1] === value) { seen[i + 1] = 1; stack[sp++] = i + 1 }
      if (i >= w && !seen[i - w] && m[i - w] === value) { seen[i - w] = 1; stack[sp++] = i - w }
      if (i < n - w && !seen[i + w] && m[i + w] === value) { seen[i + w] = 1; stack[sp++] = i + w }
    }
    if (cn < minSize) for (let k = 0; k < cn; k++) m[comp[k]] = value ? 0 : 1
  }
}
