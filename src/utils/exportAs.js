import { api, getBackendUrl } from './backendSelector'
import { authFetch, currentToken } from './editorAuth'
import { outputSize } from './outputSize'
import { isReframable, normalizeReframe } from './reframe'
import { cleanAspect } from './projectFormat'
import { submitRender, pollRender, statusPhase } from './renderQueue'
import { t } from '../i18n'

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

/**
 * Render a payload ({ timeline, mediaUrls }) as a job: resolves { outputUrl,
 * subtitles? } with absolute URLs. onStatus({ progress, phase }). Busy servers
 * and the line work as for Render (utils/renderQueue.js).
 */
export async function runRenderJob(payload, { onStatus = () => {}, signal = null } = {}) {
  const renderUrl = GATEWAY_URL ? `${GATEWAY_URL}/api/render` : api('/api/render')
  const body = JSON.stringify(payload)
  const job = await submitRender({
    send: () => authFetch(renderUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }),
    signal,
    onWait: ({ seconds, busy }) => onStatus({ progress: 0, phase: t(busy ? 'formats.job.busy' : 'formats.job.offline', { seconds }) })
  })
  if (!job) throw new DOMException('Stopped', 'AbortError')
  onStatus({ progress: 0, phase: statusPhase(job) || t('formats.job.starting') })
  const abort = () => {
    const tok = currentToken()
    fetch(jobUrl(job.jobId, job.backendEndpoint, '/abort'), { method: 'POST', keepalive: true, headers: tok ? { Authorization: `Bearer ${tok}` } : {} }).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const data = await pollRender({
      get: () => fetch(jobUrl(job.jobId, job.backendEndpoint), { cache: 'no-store', signal }),
      signal,
      onStatus: (d) => { if (!d.reconnecting) onStatus({ progress: Number(d.progress) || 0, phase: statusPhase(d) || t('formats.job.rendering') }) }
    })
    if (!data) throw new DOMException('Stopped', 'AbortError')
    if (data.status !== 'completed') throw new Error(data.error || t('formats.job.failed'))
    const base = job.backendEndpoint || getBackendUrl() || window.location.origin
    const abs = (u) => new URL(u, base).href
    return {
      outputUrl: abs(data.outputUrl),
      ...(data.subtitles ? { subtitles: { ...data.subtitles, vttUrl: abs(data.subtitles.vttUrl), srtUrl: abs(data.subtitles.srtUrl) } } : {})
    }
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
