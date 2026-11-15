// Where the browser gets FFmpeg.wasm's core (about 31 MB of wasm): from this
// editor's own server, built in by scripts/viteFfmpegCore.js from the
// @ffmpeg/core package (same version as in package.json), long cached under a
// versioned path. unpkg stays as the fallback when the own copy is missing.
// Only the legacy layout and downloads of whole HLS videos in the browser use
// it, so it is loaded on first use (hooks/useFFmpeg.js), never on open.

export const FFMPEG_CORE_VERSION = '0.12.6'
export const FFMPEG_CORE_PATH = `ffmpeg/${FFMPEG_CORE_VERSION}`
export const FFMPEG_CORE_FILES = ['ffmpeg-core.js', 'ffmpeg-core.wasm']
const CDN = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`

/** [own, fallback] { coreURL, wasmURL } pairs; base = the app's base URL (import.meta.env.BASE_URL). */
export function coreSources(base = '/', origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost') {
  const root = new URL(`${String(base || '/').replace(/\/?$/, '/')}${FFMPEG_CORE_PATH}/`, origin).href
  return [
    { coreURL: `${root}ffmpeg-core.js`, wasmURL: `${root}ffmpeg-core.wasm`, own: true },
    { coreURL: `${CDN}/ffmpeg-core.js`, wasmURL: `${CDN}/ffmpeg-core.wasm`, own: false }
  ]
}
