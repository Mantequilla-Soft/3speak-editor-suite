// A long list drawn in a window: only the rows in sight (and a few around
// them) are in the page, the rest are space. Rows have their own heights,
// measured once drawn and estimated before.

/** Running tops: offsets[i] = top of row i, offsets[n] = the whole height. */
export function rowOffsets(count, heightOf) {
  const offsets = new Float64Array(count + 1)
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + Math.max(1, heightOf(i))
  return offsets
}

/** The first row whose bottom is below y. */
export function rowAt(offsets, y) {
  let lo = 0
  let hi = offsets.length - 2
  if (hi < 0) return 0
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1] <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The rows to draw for a view from `top` that is `height` high: { from, to } (to inclusive), `overscan` px more each way. */
export function visibleRows(offsets, top, height, overscan = 600) {
  const n = offsets.length - 1
  if (n <= 0) return { from: 0, to: -1 }
  return { from: rowAt(offsets, Math.max(0, top - overscan)), to: Math.min(n - 1, rowAt(offsets, top + height + overscan)) }
}

/** A first guess at a paragraph's height in px before it was drawn: its text in lines of `charsPerLine`. */
export const estimateHeight = (chars, { charsPerLine = 48, lineHeight = 22, extra = 30 } = {}) => extra + lineHeight * Math.max(1, Math.ceil(chars / charsPerLine))
