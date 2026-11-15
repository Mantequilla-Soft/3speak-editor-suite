import { api, getBackendUrl } from './backendSelector'
import { authFetch, currentToken } from './editorAuth'
import { outputSize } from './outputSize'
import { isReframable, normalizeReframe } from './reframe'
import { cleanAspect } from './projectFormat'

// "Export as": one project rendered in other shapes too (9:16, 1:1, 16:9, 4:3).
// Footage framed as it came (utils/reframe.js isReframable) is cut to the new
// shape around its face path; the rest (text, stickers, moved clips) keeps its
// place relative to the frame. Each shape is its own normal render job.

const GATEWAY_URL = (import.meta.env?.VITE_GATEWAY_URL || '').replace(/\/+$/, '')
export const EXPORT_ASPECTS = ['9:16', '1:1', '16:9', '4:3']

/** A clip's reframe as the render gets it when the shape differs (null: framed as it is). */
export function reframeForRender(clip, trackType, reframing) {
  if (!reframing || trackType !== 'video' || !isReframable(clip)) return null
  return normalizeReframe(clip.reframe) || normalizeReframe({ path: [] })
}

/** The known shape nearest to a width / height ratio. */
export function nearestAspect(ratio) {
  let best = '16:9'
  let gap = Infinity
  for (const a of EXPORT_ASPECTS) {
    const [w, h] = a.split(':').map(Number)
    const d = Math.abs(Math.log(ratio / (w / h)))
    if (d < gap) { gap = d; best = a }
  }
  return best
}

/**
 * Output and preview sizes of a render in `aspect`, from the preview as it is
 * measured (previewWidth x previewHeight, in whatever shape it shows now). When
 * the preview shows that very shape the sizes go as they are; else the preview
 * size given to the backend is scaled so that text and stickers keep their size
 * relative to the frame's shorter side (backend scaleFactor = output / preview).
 */
export function exportSizes(aspect, previewWidth, previewHeight) {
  const out = outputSize(cleanAspect(aspect))
  if (!(previewWidth > 0) || !(previewHeight > 0)) return { outputWidth: out.width, outputHeight: out.height, previewWidth: out.width, previewHeight: out.height }
  const shown = nearestAspect(previewWidth / previewHeight)
  if (shown === cleanAspect(aspect)) return { outputWidth: out.width, outputHeight: out.height, previewWidth, previewHeight }
  const own = outputSize(shown)
  // how a render of the shown shape scales its preview, then the same for the shorter side
  const s = (Math.min(out.width, out.height) / Math.min(own.width, own.height)) * (own.width / previewWidth)
  return { outputWidth: out.width, outputHeight: out.height, previewWidth: Math.round(out.width / s), previewHeight: Math.round(out.height / s) }
}

/** Where a job's status is asked (the gateway knows which backend has it). */
function jobUrl(jobId, backendEndpoint, tail = '') {
  if (GATEWAY_URL && backendEndpoint) return `${GATEWAY_URL}/api/render/${jobId}${tail}?backend=${encodeURIComponent(backendEndpoint)}`
  return api(`/api/render/${jobId}${tail}`)
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Stopped', 'AbortError')) }, { once: true })
})

/**
 * Render a payload ({ timeline, mediaUrls }) as a job: resolves { outputUrl,
 * subtitles? } with absolute URLs. onStatus({ progress, phase }). A busy server
 * (503) is asked again after the time it says.
 */
export async function runRenderJob(payload, { onStatus = () => {}, signal = null } = {}) {
  const renderUrl = GATEWAY_URL ? `${GATEWAY_URL}/api/render` : api('/api/render')
  let job = null
  for (let tries = 0; !job; tries++) {
    const res = await authFetch(renderUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal })
    const data = await res.json().catch(() => ({}))
    if (res.status === 503 && tries < 40) {
      onStatus({ progress: 0, phase: 'The server is busy, trying again...' })
      await wait(Math.min(60, Math.max(5, Number(data.retryAfter) || 15)) * 1000, signal)
      continue
    }
    if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`)
    job = data
  }
  const abort = () => {
    const tok = currentToken()
    fetch(jobUrl(job.jobId, job.backendEndpoint, '/abort'), { method: 'POST', keepalive: true, headers: tok ? { Authorization: `Bearer ${tok}` } : {} }).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for (let misses = 0; ;) {
      await wait(1500, signal)
      let data
      try {
        const res = await fetch(jobUrl(job.jobId, job.backendEndpoint), { cache: 'no-store' })
        data = await res.json()
        if (res.status === 404) throw new Error('The render job was lost (the server restarted?)')
        misses = 0
      } catch (err) {
        if (/lost/.test(err.message) || ++misses > 10) throw err
        continue
      }
      if (data.status === 'completed') {
        const base = job.backendEndpoint || getBackendUrl() || window.location.origin
        const abs = (u) => new URL(u, base).href
        return {
          outputUrl: abs(data.outputUrl),
          ...(data.subtitles ? { subtitles: { ...data.subtitles, vttUrl: abs(data.subtitles.vttUrl), srtUrl: abs(data.subtitles.srtUrl) } } : {})
        }
      }
      if (data.status === 'failed' || data.status === 'aborted') throw new Error(data.error || 'The render failed')
      onStatus({ progress: Number(data.progress) || 0, phase: data.phase || 'Rendering...' })
    }
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
