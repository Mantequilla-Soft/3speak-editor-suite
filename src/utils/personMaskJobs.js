/**
 * Background removal (person key): the matte tracks of this session.
 *
 * - One analysis per source and range at a time (split pieces and duplicates
 *   of a clip share it): startPersonMask(clip) -> Promise<maskUrl>.
 * - Finished tracks are kept decoded under their maskUrl (a blob: URL until
 *   the render or a draft uploads the file), so the preview never refetches.
 * - Progress is observable for the clip settings (subscribePersonMasks).
 */
import { personMaskRange } from './personMask'

const tracks = new Map() // maskUrl -> { header, data }
const loading = new Map() // maskUrl -> Promise<track | null>
const jobs = new Map() // job key -> { promise, progress, error }
const listeners = new Set()

const notify = () => { for (const fn of listeners) { try { fn() } catch { /* a listener's own problem */ } } }

/** Call fn whenever a job starts, moves on or ends. Returns the unsubscribe. */
export function subscribePersonMasks(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The job key of a clip: its source and the range a matte would cover. */
export function personJobKey(clip) {
  const r = personMaskRange(clip.duration, clip.startTime, clip.endTime)
  return `${clip.url}|${r.start.toFixed(2)}|${r.end.toFixed(2)}`
}

/** Does this clip need a matte made (person key on, none yet)? */
export function needsPersonMask(clip) {
  return clip?.type === 'video' && clip.chromaKey?.color === 'person' && clip.chromaKey.enabled !== false &&
    !clip.chromaKey.maskUrl && !!clip.url
}

/** { progress (0-1), error } of the clip's job, or null when none runs. */
export function personMaskStatus(clip) {
  const job = jobs.get(personJobKey(clip))
  return job ? { progress: job.progress, error: job.error } : null
}

/** A decoded track already in memory. */
export function cachedMaskTrack(url) {
  return url ? tracks.get(url) || null : null
}

/** The decoded track of a matte file (cached; null if it cannot be read). */
export function loadMaskTrack(url) {
  if (!url) return Promise.resolve(null)
  if (tracks.has(url)) return Promise.resolve(tracks.get(url))
  if (!loading.has(url)) {
    loading.set(url, (async () => {
      try {
        const { decodeMaskBuffer } = await import('./personSegmenter')
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const track = await decodeMaskBuffer(await res.arrayBuffer())
        if (track) tracks.set(url, track)
        return track
      } catch (err) {
        console.warn('[personMask] could not load the matte:', err?.message || err)
        return null
      } finally {
        loading.delete(url)
      }
    })())
  }
  return loading.get(url)
}

/** Remember a track under a URL (an uploaded copy of a local one). */
export function aliasMaskTrack(fromUrl, toUrl) {
  const t = tracks.get(fromUrl)
  if (t && toUrl) tracks.set(toUrl, t)
}

/**
 * Make the matte of a clip's source (or join the job already running for it).
 * Resolves with the local maskUrl (blob:), rejects when it fails.
 */
export function startPersonMask(clip) {
  const key = personJobKey(clip)
  const running = jobs.get(key)
  if (running && !running.error) return running.promise
  const job = { progress: 0, error: null, promise: null }
  job.promise = (async () => {
    const { analyzePersonMask, encodeMaskBlob } = await import('./personSegmenter')
    const { header, frames } = await analyzePersonMask(clip, {
      onProgress: (p) => { job.progress = p; notify() }
    })
    const blob = await encodeMaskBlob(header, frames)
    const url = URL.createObjectURL(blob)
    tracks.set(url, { header, data: frames })
    return url
  })()
  jobs.set(key, job)
  notify()
  job.promise.then(() => {
    jobs.delete(key)
    notify()
  }, (err) => {
    console.warn('[personMask] finding the person failed:', err?.message || err)
    job.error = err?.message || String(err)
    notify()
  })
  return job.promise
}

/** Forget a failed job, so the next try starts over. */
export function clearPersonMaskError(clip) {
  const key = personJobKey(clip)
  if (jobs.get(key)?.error) {
    jobs.delete(key)
    notify()
  }
}

/** Test helper: forget everything. */
export function _resetPersonMasks() {
  tracks.clear()
  loading.clear()
  jobs.clear()
  listeners.clear()
}
