// The recorder's voice graph: mic levels as mirrored bars on a canvas.

// A list of level samples (0..1), newest last
export const levelHistory = () => []

// RMS of a block of samples, as 0..1 on a -60..0 dB scale (speech shows up
// well; silence stays near the line)
export function rmsLevel(samples) {
  if (!samples || !samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / samples.length)
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

// Squeeze levels into n buckets (the loudest sample of each), for the whole
// take's shape
export function bucketLevels(levels, n) {
  if (n <= 0) return []
  if (levels.length <= n) return levels.slice()
  const out = new Array(n)
  const per = levels.length / n
  for (let i = 0; i < n; i++) {
    let max = 0
    const end = Math.min(levels.length, Math.floor((i + 1) * per))
    for (let j = Math.floor(i * per); j < end; j++) if (levels[j] > max) max = levels[j]
    out[i] = max
  }
  return out
}

// align 'right': a live window of `slots` bars, newest at the right edge.
// align 'fit': all levels squeezed across the width.
export function drawLevels(canvas, levels, { slots = 160, align = 'right' } = {}) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  const color = getComputedStyle(canvas).color || '#e53935'
  const mid = h / 2

  // the centre line, always there
  ctx.globalAlpha = 0.35
  ctx.fillStyle = color
  ctx.fillRect(0, mid - dpr / 2, w, dpr)
  ctx.globalAlpha = 1

  const step = 3 * dpr
  const bars = Math.max(1, Math.floor(w / step))
  let data
  if (align === 'fit') {
    data = bucketLevels(levels, bars)
  } else {
    const count = Math.min(bars, slots)
    data = levels.slice(-count)
  }
  const barW = Math.max(1, step - dpr)
  const x0 = align === 'fit' ? 0 : w - data.length * step
  for (let i = 0; i < data.length; i++) {
    const half = Math.max(dpr / 2, data[i] * (h / 2 - dpr))
    ctx.fillRect(x0 + i * step, mid - half, barW, half * 2)
  }
}
