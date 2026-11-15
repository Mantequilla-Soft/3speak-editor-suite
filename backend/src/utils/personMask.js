/**
 * Background removal without a green screen ("person" key), shared by the
 * preview (src/utils/) and the backend render (backend/src/utils/): the two
 * copies must stay identical (scripts/check-static-mask-sync.mjs).
 *
 * The matte is indexed by MEDIA seconds of the source: a clip with a speed,
 * ramp or freeze (utils/clipSpeed.js) looks it up at the media time it shows.
 *
 * The browser finds the person in every frame of the clip's source with
 * MediaPipe's selfie segmenter (src/utils/personSegmenter.js) and keeps the
 * result as a low-resolution grayscale matte track: MASK_FPS frames a second,
 * MASK_LONG_SIDE pixels on the long side, 0 = background, 255 = person, for the
 * whole source (or, for a very long source, the part the clip uses). It goes to
 * the server as one gzip file (the payload below) and the render scales it up
 * to the clip, frame for frame, exactly like the preview.
 *
 * clip.chromaKey (video clips):
 *   { color: 'person', threshold, softness, maskUrl?, background? }
 *   background: { kind: 'none' | 'blur' | 'color', blur, color }
 *     none  : the background is see-through, the tracks below show (like a green screen)
 *     blur  : the clip's own picture, blurred, behind the person
 *     color : a solid colour behind the person
 *
 * Alpha from the matte value m (0-255, sampled bilinearly from the upscaled matte):
 *   lo = 255 * (threshold - softness / 2), hi = 255 * (threshold + softness / 2)
 *   alpha = clamp((m - lo) / (hi - lo), 0, 1)
 * Blur: a gaussian with sigma = blur * the clip picture's height.
 */

export const PERSON_DEFAULTS = { threshold: 0.5, softness: 0.3 }
export const PERSON_RANGES = { threshold: [0.1, 0.9], softness: [0.02, 0.8] }
export const BLUR_DEFAULT = 0.025
export const BLUR_RANGE = [0.005, 0.08]
export const MASK_FPS = 15
export const MASK_LONG_SIDE = 256
// Sources up to this long get a matte for all of it (trims and splits stay
// covered); longer ones only for the part the clip uses
export const MASK_WHOLE_SOURCE_SECONDS = 600
export const MASK_MAGIC = '3SPM1'

const HEX = /^#[0-9a-f]{6}$/i
const clampNum = (v, def, [lo, hi]) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def)

/** The background setting of a person key, normalized. */
export function normalizeBackground(bg) {
  const kind = bg && (bg.kind === 'blur' || bg.kind === 'color') ? bg.kind : 'none'
  return {
    kind,
    blur: clampNum(bg?.blur, BLUR_DEFAULT, BLUR_RANGE),
    color: typeof bg?.color === 'string' && HEX.test(bg.color) ? bg.color.toLowerCase() : '#000000'
  }
}

/** The person key settings of a chromaKey value (color 'person'), normalized. */
export function normalizePersonKey(ck) {
  return {
    mode: 'person',
    threshold: clampNum(ck?.threshold, PERSON_DEFAULTS.threshold, PERSON_RANGES.threshold),
    softness: clampNum(ck?.softness, PERSON_DEFAULTS.softness, PERSON_RANGES.softness),
    maskUrl: typeof ck?.maskUrl === 'string' && ck.maskUrl ? ck.maskUrl : null,
    background: normalizeBackground(ck?.background)
  }
}

/** The matte values (0-255) where alpha starts and reaches 1: { lo, hi }, hi > lo. */
export function personAlphaRange(key) {
  const t = key.threshold * 255
  const half = (key.softness * 255) / 2
  let lo = Math.max(0, Math.round(t - half))
  let hi = Math.min(255, Math.round(t + half))
  if (hi - lo < 2) {
    if (hi >= 255) lo = hi - 2
    else hi = lo + 2
  }
  return { lo, hi }
}

/** Alpha (0-255) of a matte value, the same formula as the preview shader and the render's lut. */
export function personAlpha(m, range) {
  return Math.min(255, Math.max(0, Math.round(((m - range.lo) * 255) / (range.hi - range.lo))))
}

/** Matte size for a source of sw x sh: MASK_LONG_SIDE on the long side, even, at least 8. */
export function personMaskSize(sw, sh) {
  if (!sw || !sh) return [MASK_LONG_SIDE, MASK_LONG_SIDE]
  const even = (v) => Math.max(8, Math.round(v / 2) * 2)
  return sw >= sh
    ? [MASK_LONG_SIDE, even((MASK_LONG_SIDE * sh) / sw)]
    : [even((MASK_LONG_SIDE * sw) / sh), MASK_LONG_SIDE]
}

/**
 * The source range a matte covers for a clip: the whole source when it is not
 * too long, else the clip's own range. { start, end } in source seconds.
 */
export function personMaskRange(duration, startTime = 0, endTime = duration) {
  const d = Number(duration) || 0
  if (d > 0 && d <= MASK_WHOLE_SOURCE_SECONDS) return { start: 0, end: d }
  const s = Math.max(0, Number(startTime) || 0)
  return { start: s, end: Math.max(s + 1 / MASK_FPS, Number(endTime) || s) }
}

/** Number of matte frames for a range at fps. */
export function personMaskFrames(range, fps = MASK_FPS) {
  return Math.max(1, Math.ceil((range.end - range.start) * fps - 1e-6))
}

/** The matte frame that shows source time `t` (nearest frame, clamped to the track). */
export function maskFrameIndex(header, t) {
  const i = Math.round((t - header.start) * header.fps)
  return Math.min(header.frames - 1, Math.max(0, i))
}

/**
 * Matte frame for each output frame of a clip: output frame j is at clip time
 * startTime + j / fps, which shows media second mediaAt(that clip time) (the
 * clip's speed / ramp / freeze, utils/clipSpeed.js sourceAt; media time = clip
 * time without one). Returns an array of matte frame indexes.
 */
export function resampleMaskIndexes(header, startTime, endTime, fps, mediaAt = (t) => t) {
  const n = Math.max(1, Math.round((endTime - startTime) * fps))
  const out = new Array(n)
  for (let j = 0; j < n; j++) out[j] = maskFrameIndex(header, mediaAt(startTime + j / fps))
  return out
}

/** Is `h` a usable matte header? */
export function validMaskHeader(h) {
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi
  return !!h && h.v === 1 && int(h.w, 8, 1024) && int(h.h, 8, 1024) && int(h.frames, 1, 100000) &&
    typeof h.fps === 'number' && h.fps > 0 && h.fps <= 60 && typeof h.start === 'number' && isFinite(h.start) && h.start >= 0
}

/**
 * The matte file before compression: "3SPM1\n" + JSON header + "\n" + frames
 * (w * h bytes each, in order). header: { v: 1, w, h, fps, start, frames }.
 */
export function buildMaskPayload(header, frames) {
  const head = new TextEncoder().encode(`${MASK_MAGIC}\n${JSON.stringify(header)}\n`)
  const out = new Uint8Array(head.length + frames.length)
  out.set(head, 0)
  out.set(frames, head.length)
  return out
}

/** Parse an uncompressed matte payload: { header, data } (data = the frames), or null. */
export function parseMaskPayload(bytes) {
  if (!bytes || bytes.length < 16) return null
  const magic = new TextDecoder().decode(bytes.subarray(0, MASK_MAGIC.length + 1))
  if (magic !== `${MASK_MAGIC}\n`) return null
  let nl = -1
  for (let i = MASK_MAGIC.length + 1; i < Math.min(bytes.length, 4096); i++) {
    if (bytes[i] === 10) { nl = i; break }
  }
  if (nl < 0) return null
  let header
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(MASK_MAGIC.length + 1, nl)))
  } catch {
    return null
  }
  if (!validMaskHeader(header)) return null
  const data = bytes.subarray(nl + 1)
  if (data.length < header.w * header.h * header.frames) return null
  return { header, data }
}

/** One matte frame (a w * h view) of a parsed track. */
export function maskFrame(track, i) {
  const size = track.header.w * track.header.h
  return track.data.subarray(i * size, (i + 1) * size)
}

/** Blur sigma in pixels for a picture `height` pixels tall. */
export function blurSigma(background, height) {
  return Math.max(0.5, background.blur * height)
}
