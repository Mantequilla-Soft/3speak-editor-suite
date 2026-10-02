const TARGET_RESOLUTION = parseInt(process.env.HLS_TARGET_RESOLUTION || '480', 10)

/**
 * Fetch and parse an m3u8 master playlist to find the variant URL
 * closest to TARGET_RESOLUTION.
 *
 * @param {string} url - The master m3u8 URL
 * @returns {Promise<string>} - The resolved URL of the selected variant playlist
 */
export async function selectVariantUrl(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch m3u8: ${response.status}`)
  const text = await response.text()
  const lines = text.split('\n').map(l => l.trim()).filter(l => l)

  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))

  if (!isMaster) {
    // Already a media playlist, return as-is
    return url
  }

  const variants = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/)
      const resMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/)
      const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0
      const height = resMatch ? parseInt(resMatch[2]) : 0
      const variantUrl = lines[i + 1]
      if (variantUrl && !variantUrl.startsWith('#')) {
        variants.push({ url: variantUrl, bandwidth, height })
      }
    }
  }

  if (variants.length === 0) throw new Error('No variant streams found in master playlist')

  // Pick closest to target resolution, prefer lower bandwidth on tie
  let best = variants[0]
  let bestDiff = Math.abs(variants[0].height - TARGET_RESOLUTION)

  for (const v of variants) {
    const diff = Math.abs(v.height - TARGET_RESOLUTION)
    if (diff < bestDiff || (diff === bestDiff && v.bandwidth < best.bandwidth)) {
      bestDiff = diff
      best = v
    }
  }

  console.log(`[m3u8Parser] Target: ${TARGET_RESOLUTION}p, selected: ${best.height}p (${(best.bandwidth / 1000).toFixed(0)}kbps)`)
  return new URL(best.url, url).href
}
