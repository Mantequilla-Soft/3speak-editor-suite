// "Auto" colour for a clip: measure a few frames and pick clip.color values
// (see clipColor.js for what each one does). Plain measurements, no AI:
//   levels     contrast + brightness put the darkest/brightest 0.5% near black/white
//   midtones   the median lands around 46% grey
//   balance    warmth + tint neutralise the average of the mid tones (grey world)
//   saturation a small lift only for very flat footage
// Corrections are capped, so stylised footage is nudged rather than flattened.

const SAMPLE_WIDTH = 160
const FRAMES = 6

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
// Tiny corrections are noise: leave them at 0
const slider = (v, cap) => {
  const r = Math.round(clamp(v, -cap, cap))
  return Math.abs(r) < 3 ? 0 : r
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image'))
    img.src = url
  })
}

async function grabVideoFrames(url, from, to, draw) {
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.preload = 'auto'
  video.src = url
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve
    video.onerror = () => reject(new Error('video'))
  })
  for (let i = 0; i < FRAMES; i++) {
    const t = from + ((i + 0.5) / FRAMES) * (to - from)
    await new Promise((resolve) => {
      video.onseeked = resolve
      video.currentTime = t
    })
    draw(video, video.videoWidth, video.videoHeight)
  }
  video.removeAttribute('src')
  video.load()
}

export async function autoColor(clip) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const hist = new Float64Array(256)
  let count = 0
  let sumR = 0, sumG = 0, sumB = 0, mids = 0, chroma = 0

  const draw = (source, w, h) => {
    if (!w || !h) return
    canvas.width = SAMPLE_WIDTH
    canvas.height = Math.max(1, Math.round((SAMPLE_WIDTH * h) / w))
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      hist[Math.min(255, Math.round(l * 255))]++
      count++
      chroma += Math.max(r, g, b) - Math.min(r, g, b)
      if (l > 0.15 && l < 0.85) { sumR += r; sumG += g; sumB += b; mids++ }
    }
  }

  if (clip.type === 'image') {
    const img = await loadImage(clip.url)
    draw(img, img.naturalWidth, img.naturalHeight)
  } else {
    await grabVideoFrames(clip.url, clip.startTime, clip.endTime, draw)
  }
  if (!count) throw new Error('No picture to measure')

  const percentile = (q) => {
    let acc = 0
    for (let i = 0; i < 256; i++) {
      acc += hist[i]
      if (acc >= q * count) return i / 255
    }
    return 1
  }
  const lo = percentile(0.005)
  const hi = percentile(0.995)
  const median = clamp(percentile(0.5), 0.02, 0.98)

  // Levels: c * v + o maps lo -> 0.03 and hi -> 0.97
  const c = clamp(0.94 / Math.max(0.05, hi - lo), 0.6, 1.6)
  const o = 0.03 - c * lo
  const brightnessOffset = o - (0.5 - 0.5 * c)

  // Midtones: c * median^g + o = 0.46
  let gamma = 1
  const want = (0.46 - o) / c
  if (want > 0 && want < 1) gamma = clamp(Math.log(want) / Math.log(median), 0.6, 1.6)

  // White balance on the mid tones. Grey world assumes the scene averages to
  // grey, which is wrong for colourful scenes: correct only partly, and fade
  // the correction out as the scene gets more saturated.
  let warmth = 0, tint = 0
  const meanChroma = chroma / count
  const trust = clamp(1 - (meanChroma - 0.12) / 0.2, 0, 1) * 0.6
  if (mids > 50 && trust > 0) {
    const r = sumR / mids, g = sumG / mids, b = sumB / mids
    warmth = ((b - r) / (b + r) / 0.15) * 100 * trust
    tint = ((1 - (r + b) / (2 * g)) / 0.12) * 100 * trust
  }

  return {
    brightness: slider((brightnessOffset / 0.3) * 100, 40),
    contrast: slider(((c - 1) / 0.8) * 100, 60),
    midtones: slider(-Math.log2(gamma) * 100, 60),
    saturation: chroma / count < 0.12 ? 20 : 0,
    warmth: slider(warmth, 35),
    tint: slider(tint, 25)
  }
}
