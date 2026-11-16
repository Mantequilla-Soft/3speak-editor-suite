import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'
import { t } from '../i18n'

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
    setJob({ status: 'running', progress: 0, phase: t('captions.job.preparing') })
    try {
      const payload = await buildPayload((phase) => setJob(j => ({ ...j, phase })))
      if (!payload?.timeline?.tracks?.length) throw new Error(t('captions.job.noTracks'))
      const res = await authFetch(api('/api/captions/transcribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeline: payload.timeline, language })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('captions.job.serverAnswered', { status: String(res.status) }))
      for (;;) {
        await new Promise(r => setTimeout(r, 1200))
        if (cancelled) return null
        const r = await fetch(api(`/api/captions/${data.jobId}`), { cache: 'no-store' })
        const s = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(s.error || t('captions.job.lost'))
        if (s.status === 'completed') {
          if (!s.words?.length) throw new Error(t('captions.job.noSpeech'))
          setJob(null)
          return { words: s.words, language: s.language || null }
        }
        if (s.status === 'failed') throw new Error(s.error || t('captions.job.failed'))
        setJob({ status: 'running', progress: s.progress || 0, phase: s.phase || t('captions.job.listening') })
      }
    } catch (err) {
      if (!cancelled) setJob({ status: 'failed', progress: 0, error: err.message })
      return null
    }
  }, [])

  const cancel = useCallback(() => { cancelRef.current?.(); setJob(null) }, [])

  return { status, job, start, cancel }
}
