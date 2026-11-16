import fs from 'fs/promises'
import path from 'path'

// The files of one video upload <base><ext> in UPLOAD_DIR:
//   <base><ext>          the original as uploaded (kept: renders read it)
//   <base>_480p.mp4      the editing proxy: what the preview plays (GET /files/<name>)
//   <base>_master.mp4    the render copy, only for originals a render should not
//                        read as they are (HDR, bigger than 1920 on the long side,
//                        a codec outside RENDER_CODECS). It replaces the original.
// Uploads from before originals were kept only have the 480p file: renders fall
// back to it.

export const MASTER_LONG_SIDE = 1920
// Codecs a render reads straight from the original
export const RENDER_CODECS = ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'prores', 'mjpeg']

const baseOf = (name) => path.basename(name, path.extname(name))
export const proxyName = (name) => `${baseOf(name)}_480p.mp4`
export const masterName = (name) => `${baseOf(name)}_master.mp4`

export const isHdr = (probe) => ['smpte2084', 'arib-std-b67'].includes(probe?.transfer)

/**
 * Why a video original needs a render copy (master), or null when renders can
 * read it as it is. Unreadable probes ({}) get none: the encode fails for them too.
 */
export function masterReason(probe = {}) {
  if (!probe.videoCodec) return null
  if (isHdr(probe)) return 'hdr'
  if (Math.max(+probe.width || 0, +probe.height || 0) > MASTER_LONG_SIDE) return 'large'
  if (!RENDER_CODECS.includes(probe.videoCodec)) return 'codec'
  return null
}

/**
 * ffmpeg scale for the master: the long side fits MASTER_LONG_SIDE, never
 * upscaled, even sizes, square pixels.
 */
export function masterScaleFilter(long = MASTER_LONG_SIDE) {
  return `scale=iw*sar:ih,scale='if(gte(iw,ih),min(${long},iw),-2)':'if(gte(iw,ih),-2,min(${long},ih))',scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1`
}

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

/**
 * The file a render reads for an upload: its master, else the original, else
 * the 480p proxy (old uploads). `pendingMaster` (a master is on its way, see
 * upload.js) marks the answer as not final: the master will replace it, so
 * render caches must not keep it. While a master is pending for HDR footage
 * the proxy (tone-mapped) stands in when it exists, else the original.
 * Resolves { path, kind: 'master' | 'original' | 'proxy', final } or null.
 */
export async function renderSource(dir, name, { pendingMaster = false, hdr = false } = {}) {
  const file = path.basename(name)
  const master = path.join(dir, masterName(file))
  const original = path.join(dir, file)
  const proxy = path.join(dir, proxyName(file))
  // A derived file asked for by its own name (a _480p / _dn-* / _master file): just that file
  if (/(_480p|_master)\.mp4$/.test(file)) return (await exists(original)) ? { path: original, kind: 'original', final: true } : null
  if (await exists(master)) return { path: master, kind: 'master', final: true }
  const [hasOriginal, hasProxy] = await Promise.all([exists(original), exists(proxy)])
  if (pendingMaster && hdr && hasProxy) return { path: proxy, kind: 'proxy', final: false }
  if (hasOriginal) return { path: original, kind: 'original', final: !pendingMaster }
  if (hasProxy) return { path: proxy, kind: 'proxy', final: true }
  return null
}

// Our upload URLs: /api/upload/files/<name>, relative or on any editor backend
const UPLOAD_URL = /^((?:https?:\/\/[^/?#]+)?\/api\/upload\/files\/)([A-Za-z0-9_.-]+)(?:\?[^#]*)?$/

/**
 * The URL a render downloads for a clip: an upload URL asks for the render
 * source (?for=render: master or original, see renderSource) instead of the
 * 480p proxy the preview plays. Any other URL is returned unchanged.
 */
export function renderUrlOf(url) {
  const m = typeof url === 'string' ? url.match(UPLOAD_URL) : null
  return m ? `${m[1]}${m[2]}?for=render` : url
}

/** The upload file name in one of our upload URLs, else null. */
export function uploadNameOf(url) {
  const m = typeof url === 'string' ? url.match(UPLOAD_URL) : null
  return m ? m[2] : null
}

// Upload name -> { hdr } while its master is being made (set and cleared by
// upload.js queueEncode; read by renderSource callers: GET ?for=render and the
// local render copy in download.js)
export const pendingMasters = new Map()
