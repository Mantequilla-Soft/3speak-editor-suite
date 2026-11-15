import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'

const POLL_MS = 1500

/**
 * Transcripts on the render backend (backend/src/routes/transcript.js):
 * whether it can make them (status: null while asking, then { available,
 * languages, maxSeconds } or { available: false }), and a job: start({
 * sources, language, verbatim, onChunk }) listens to the sources' ranges and
 * calls onChunk(chunk, language) for every finished chunk (the words come in
 * while the rest is still being listened to); it resolves true when all is
 * done, false when it failed or was cancelled.
 * job: null | { status: 'running' | 'failed', progress, phase, error }.
 */
export function useTranscriptJob({ enabled = true } = {}) {
  const [status, setStatus] = useState(null)
  const [job, setJob] = useState(null)
  const runRef = useRef(null) // { cancelled, jobId }

  useEffect(() => {
    if (!enabled) return undefined
    let live = true
    fetch(api('/api/transcript/status'), { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { available: false, reason: 'old-backend' }))
      .catch(() => ({ available: false, reason: 'unreachable' }))
      .then(s => { if (live) setStatus(s) })
    return () => { live = false }
  }, [enabled])

  // Leaving: the backend need not go on listening
  useEffect(() => () => {
    const run = runRef.current
    if (run && !run.cancelled) {
      run.cancelled = true
      if (run.jobId) authFetch(api(`/api/transcript/${run.jobId}`), { method: 'DELETE' }).catch(() => {})
    }
  }, [])

  const start = useCallback(async ({ sources, language = 'auto', verbatim = true, onChunk }) => {
    const prev = runRef.current
    if (prev && !prev.cancelled) prev.cancelled = true
    const run = { cancelled: false, jobId: null }
    runRef.current = run
    setJob({ status: 'running', progress: 0, phase: 'Starting...' })
    try {
      const res = await authFetch(api('/api/transcript'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources, language, verbatim })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`)
      run.jobId = data.jobId
      let next = 0
      for (;;) {
        await new Promise(r => setTimeout(r, POLL_MS))
        if (run.cancelled) return false
        const r = await fetch(api(`/api/transcript/${data.jobId}?from=${next}`), { cache: 'no-store' })
        const s = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(s.error || 'The transcript job was lost (the server restarted?)')
        if (run.cancelled) return false
        for (const chunk of s.chunks || []) onChunk?.(chunk, s.language || null)
        next = s.next ?? next
        if (s.status === 'completed') { setJob(null); return true }
        if (s.status === 'failed') throw new Error(s.error || 'Speech recognition failed')
        if (s.status === 'cancelled') { setJob(null); return false }
        setJob({ status: 'running', progress: s.progress || 0, phase: s.phase || 'Listening...' })
      }
    } catch (err) {
      if (!run.cancelled) setJob({ status: 'failed', progress: 0, error: err?.code === 'sign-in' ? 'Sign in on 3Speak to make a transcript.' : err.message })
      return false
    }
  }, [])

  const cancel = useCallback(() => {
    const run = runRef.current
    if (run && !run.cancelled) {
      run.cancelled = true
      if (run.jobId) authFetch(api(`/api/transcript/${run.jobId}`), { method: 'DELETE' }).catch(() => {})
    }
    setJob(null)
  }, [])

  return { status, job, start, cancel }
}
