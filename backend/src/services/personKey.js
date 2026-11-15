/**
 * Background removal without a green screen (person key) in the render.
 *
 * The editor made the matte in the browser (src/utils/personSegmenter.js) and
 * uploaded it as one gzip file (utils/personMask.js payload). Here it becomes
 * a raw gray stream with one matte frame per OUTPUT frame of the clip (the same
 * nearest-frame pick as the preview), which the composite step frames exactly
 * like the clip, scales up bilinearly and turns into alpha:
 *   alpha = clamp((m - lo) * 255 / (hi - lo))          lut on the upscaled matte
 * background none : the clip keyed, the tracks below show through
 *            blur : the clip's own picture under it, gblur with sigma = blur * height
 *            color: a solid colour under it
 */
import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import zlib from 'zlib'
import { promisify } from 'util'
import {
  normalizePersonKey, parseMaskPayload, resampleMaskIndexes, maskFrame, personAlphaRange, blurSigma
} from '../utils/personMask.js'
import { sourceAt } from '../utils/clipSpeed.js'

const gunzip = promisify(zlib.gunzip)
// A matte file is small (a minute is a few MB); refuse anything absurd
const MAX_MASK_BYTES = 512 * 1024 * 1024

export { normalizePersonKey }

/** A matte file (gzip or plain) -> { header, data }, or null when unusable. */
export async function readMaskFile(file) {
  let bytes = await fs.readFile(file)
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = await gunzip(bytes, { maxOutputLength: MAX_MASK_BYTES })
  }
  return parseMaskPayload(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length))
}

/**
 * Write the clip's matte frames (one per output frame at `fps`, for its
 * startTime..endTime) as a raw gray stream. Returns { path, w, h, frames } or null.
 */
export async function writePersonMaskStream(clip, maskFile, outPath, fps) {
  const track = await readMaskFile(maskFile)
  if (!track) return null
  const { w, h } = track.header
  // the matte is in media seconds: a retimed clip (speed, ramp, freeze) reads it where its frames are
  const idx = resampleMaskIndexes(track.header, clip.startTime || 0, clip.endTime, fps, (c) => sourceAt(clip, c))
  // one spare frame at the end, so the matte never runs out before the picture
  idx.push(idx[idx.length - 1])
  const out = createWriteStream(outPath)
  for (const i of idx) {
    if (!out.write(Buffer.from(maskFrame(track, i)))) await new Promise(r => out.once('drain', r))
  }
  await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve) })
  return { path: outPath, w, h, frames: idx.length }
}

/**
 * Filtergraph parts: [clipLabel] keyed by [maskLabel] -> [outLabel].
 * maskTransform frames the whole-frame matte like the clip (and scales it to
 * the processed clip's size); `hold` (a transition's held first / last frame,
 * tpad) is applied to the matte too, so both stay frame for frame in step;
 * `delay` puts it at its timeline position.
 */
export function buildPersonKeyFilter({ clipLabel, maskLabel, maskTransform, key, i, delay, outLabel, hold = null }) {
  const n = (s) => `[p${i}${s}]`
  const { lo, hi } = personAlphaRange(key)
  const end = `${delay ? `,${delay}` : ''}[${outLabel}]`
  const parts = [
    `[${maskLabel}]${maskTransform},format=gray,lut=c0='clip((val-${lo})*255/${hi - lo},0,255)'${hold ? `,${hold}` : ''}${n('a')}`
  ]
  const bg = key.background
  if (bg.kind === 'none') {
    parts.push(`[${clipLabel}]format=yuva420p${n('c')}`, `${n('c')}${n('a')}alphamerge${end}`)
    return parts
  }
  parts.push(`[${clipLabel}]format=yuva420p,split${n('c')}${n('b')}`)
  if (bg.kind === 'color') {
    parts.push(`${n('b')}drawbox=x=0:y=0:w=iw:h=ih:color=0x${bg.color.slice(1)}@1:t=fill,format=yuv420p${n('bg')}`)
  } else {
    parts.push(`${n('b')}format=yuv420p,gblur=sigma=${bg.blurPx.toFixed(2)}${n('bg')}`)
  }
  parts.push(`${n('c')}${n('a')}alphamerge${n('f')}`, `${n('bg')}${n('f')}overlay=0:0:format=auto${end}`)
  return parts
}

/** The key with the blur in pixels for a clip picture `height` pixels tall. */
export function personKeyForSize(key, height) {
  return { ...key, background: { ...key.background, blurPx: blurSigma(key.background, height) } }
}
