import { api } from './backendSelector'
import { authFetch } from './editorAuth'

// Loudness + peaks of an uploaded file, measured by the editor backend
// (POST /api/clip/audio-analysis): for files the browser cannot decode in
// memory (a long WAV podcast) or at all. One request per file and page.
// Resolves { step, duration, db: number[], peaks: number[] } or null.
const UPLOAD_URL = /\/api\/upload\/files\/[A-Za-z0-9_.-]+/
const results = new Map()

export const isServerUpload = (url) => typeof url === 'string' && UPLOAD_URL.test(url)

export function serverAnalysis(url, { signal } = {}) {
  if (!isServerUpload(url)) return Promise.resolve(null)
  if (results.has(url)) return results.get(url)
  const job = authFetch(api('/api/clip/audio-analysis'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal
  })
    .then(res => (res.ok ? res.json() : null))
    .then(d => (d && Array.isArray(d.db) && Array.isArray(d.peaks) && d.step > 0 ? d : null))
    .catch(() => null)
    .then(d => {
      if (!d) results.delete(url) // a later try may work (sign-in, upload finished)
      return d
    })
  results.set(url, job)
  return job
}
