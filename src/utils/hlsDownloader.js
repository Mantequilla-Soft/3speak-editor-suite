import { isHlsUrl } from './hlsHelper'

// Target resolution height for HLS downloads (e.g. 480 for 480p)
const TARGET_RESOLUTION = parseInt(import.meta.env.VITE_HLS_TARGET_RESOLUTION || '480')

/**
 * Parse an m3u8 playlist and return segment URLs.
 * Handles both master playlists (picks variant matching target resolution)
 * and media playlists (returns segments directly).
 */
async function parsePlaylist(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch playlist: ${response.status}`)
  const text = await response.text()
  const lines = text.split('\n').map(l => l.trim()).filter(l => l)

  // Check if this is a master playlist (has #EXT-X-STREAM-INF)
  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))

  if (isMaster) {
    // Parse all variants with their resolution and bandwidth
    const variants = []

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/)
        const resMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/)
        const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0
        const height = resMatch ? parseInt(resMatch[2]) : 0
        // Next non-comment line is the variant URL
        const variantUrl = lines[i + 1]
        if (variantUrl && !variantUrl.startsWith('#')) {
          variants.push({ url: variantUrl, bandwidth, height })
        }
      }
    }

    if (variants.length === 0) throw new Error('No variant streams found in master playlist')

    // Pick variant matching target resolution, fallback to closest
    let bestVariant = variants[0]
    let bestDiff = Math.abs(variants[0].height - TARGET_RESOLUTION)

    for (const v of variants) {
      const diff = Math.abs(v.height - TARGET_RESOLUTION)
      if (diff < bestDiff || (diff === bestDiff && v.bandwidth < bestVariant.bandwidth)) {
        bestDiff = diff
        bestVariant = v
      }
    }

    console.log(`[hlsDownloader] Target: ${TARGET_RESOLUTION}p, selected: ${bestVariant.height}p (${(bestVariant.bandwidth / 1000).toFixed(0)}kbps)`)

    // Resolve relative URL
    const resolvedUrl = new URL(bestVariant.url, url).href
    return parsePlaylist(resolvedUrl)
  }

  // Media playlist - extract segment URLs
  const segments = []
  for (const line of lines) {
    if (!line.startsWith('#') && line.length > 0) {
      segments.push(new URL(line, url).href)
    }
  }

  return segments
}

/**
 * Download an HLS stream, concatenate segments, and remux to MP4 using FFmpeg.
 * Returns a blob URL to a local MP4 file.
 *
 * @param {string} hlsUrl - The m3u8 URL
 * @param {object} ffmpeg - The FFmpeg.wasm instance (must be loaded)
 * @param {function} onProgress - Progress callback (0-1)
 * @returns {Promise<string>} blob URL of the downloaded MP4
 */
export async function downloadHlsToMp4(hlsUrl, ffmpeg, onProgress = () => {}) {
  if (!isHlsUrl(hlsUrl)) throw new Error('Not an HLS URL')
  if (!ffmpeg) throw new Error('FFmpeg not available')

  // Phase 1: Parse playlist (5% of progress)
  onProgress(0)
  const segmentUrls = await parsePlaylist(hlsUrl)

  if (segmentUrls.length === 0) throw new Error('No segments found in playlist')
  console.log(`[hlsDownloader] Found ${segmentUrls.length} segments`)

  // Phase 2: Download segments (85% of progress)
  // Download into temporary array, then consolidate into one buffer and free originals
  const segments = []
  let totalBytes = 0

  for (let i = 0; i < segmentUrls.length; i++) {
    const res = await fetch(segmentUrls[i])
    if (!res.ok) throw new Error(`Failed to download segment ${i}: ${res.status}`)
    const buffer = await res.arrayBuffer()
    segments.push(buffer)
    totalBytes += buffer.byteLength
    onProgress(0.05 + (i / segmentUrls.length) * 0.85)
  }

  // Concatenate into a single Uint8Array, freeing each segment as we go
  let tsData = new Uint8Array(totalBytes)
  let offset = 0
  for (let i = 0; i < segments.length; i++) {
    tsData.set(new Uint8Array(segments[i]), offset)
    offset += segments[i].byteLength
    segments[i] = null // Free segment buffer for GC
  }
  segments.length = 0

  console.log(`[hlsDownloader] Downloaded ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)

  // Phase 3: Remux to MP4 with FFmpeg (5% of progress)
  onProgress(0.90)

  const inputName = `hls_input_${Date.now()}.ts`
  const outputName = `hls_output_${Date.now()}.mp4`

  await ffmpeg.writeFile(inputName, tsData)
  tsData = null // Free — FFmpeg has its own copy in WASM memory

  const exitCode = await ffmpeg.exec([
    '-i', inputName,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', outputName
  ])

  await ffmpeg.deleteFile(inputName)

  if (exitCode !== 0) {
    throw new Error('FFmpeg remux failed')
  }

  let data = await ffmpeg.readFile(outputName)
  await ffmpeg.deleteFile(outputName)

  const blob = new Blob([data.buffer], { type: 'video/mp4' })
  data = null // Free — Blob holds its own copy
  const blobUrl = URL.createObjectURL(blob)

  onProgress(1)
  console.log(`[hlsDownloader] Remuxed to MP4: ${(blob.size / 1024 / 1024).toFixed(1)} MB`)

  return blobUrl
}
