import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'

/**
 * Auto captions on the render backend (backend/src/routes/captions.js):
 * whether this backend can do them (status: null while asking, then
 * { available, burnIn, languages, maxSeconds } or { available: false }), and
 * a transcription job: start(payload, language) resolves { words, language }.
 * job: null | { status: 'running' | 'failed', progress, phase, error }.
 */
export function useAutoCaptions({ enabled = true } = {}) {
  const [status, setStatus] = useState(null)
  const [job, setJob] = useState(null)
  const cancelRef = useRef(null)

  useEffect(() => {
    if (!enabled) return undefined
    let live = true
    fetch(api('/api/captions/status'), { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { available: false, reason: 'old-backend' }))
      .catch(() => ({ available: false, reason: 'unreachable' }))
      .then(s => { if (live) setStatus(s) })
    return () => { live = false; cancelRef.current?.() }
  }, [enabled])

  const start = useCallback(async (buildPayload, language = 'auto') => {
    cancelRef.current?.()
    let cancelled = false
    cancelRef.current = () => { cancelled = true }
    setJob({ status: 'running', progress: 0, phase: 'Preparing the sound...' })
    try {
      const payload = await buildPayload((phase) => setJob(j => ({ ...j, phase })))
      if (!payload?.timeline?.tracks?.length) throw new Error('There is no speech to caption: add a clip with sound first.')
      const res = await authFetch(api('/api/captions/transcribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeline: payload.timeline, language })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`)
      for (;;) {
        await new Promise(r => setTimeout(r, 1200))
        if (cancelled) return null
        const r = await fetch(api(`/api/captions/${data.jobId}`), { cache: 'no-store' })
        const s = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(s.error || 'The captions job was lost (the server restarted?)')
        if (s.status === 'completed') {
          if (!s.words?.length) throw new Error('No speech found. Is the voice on an audio track that is not muted (music tracks are left out)?')
          setJob(null)
          return { words: s.words, language: s.language || null }
        }
        if (s.status === 'failed') throw new Error(s.error || 'Speech recognition failed')
        setJob({ status: 'running', progress: s.progress || 0, phase: s.phase || 'Listening...' })
      }
    } catch (err) {
      if (!cancelled) setJob({ status: 'failed', progress: 0, error: err.message })
      return null
    }
  }, [])

  const cancel = useCallback(() => { cancelRef.current?.(); setJob(null) }, [])

  return { status, job, start, cancel }
}
