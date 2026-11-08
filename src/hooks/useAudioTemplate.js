import { useCallback, useEffect, useState } from 'react'
import { api } from '../utils/backendSelector'

/**
 * The signed-in creator's audio template (one per person, kept for good) on
 * the editor backend: GET / PUT / DELETE /api/templates/audio, with the same
 * editor token as the drafts (the 'drafts-session' the 3Speak page sends).
 * template: undefined while not known yet, null when there is none.
 */
export function useAudioTemplate({ session, enabled = true }) {
  const [template, setTemplate] = useState(undefined)
  const [status, setStatus] = useState('idle') // idle | loading | saving | saved | error

  const call = useCallback((method, body) => fetch(api('/api/templates/audio'), {
    method,
    headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }), [session])

  useEffect(() => {
    if (!enabled || !session) { setTemplate(session === null ? null : undefined); return }
    let cancelled = false
    setStatus('loading')
    call('GET')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (!cancelled) { setTemplate(d.template || null); setStatus('idle') } })
      .catch(() => { if (!cancelled) { setTemplate(null); setStatus('error') } })
    return () => { cancelled = true }
  }, [session, enabled, call])

  const save = useCallback(async (next) => {
    if (!session) return { ok: false }
    setStatus('saving')
    try {
      const r = await call('PUT', { template: next })
      if (!r.ok) throw new Error(String(r.status))
      const d = await r.json()
      setTemplate(d.template)
      setStatus('saved')
      return { ok: true, template: d.template }
    } catch {
      setStatus('error')
      return { ok: false }
    }
  }, [session, call])

  const remove = useCallback(async () => {
    if (!session) return { ok: false }
    try {
      await call('DELETE')
      setTemplate(null)
      setStatus('idle')
      return { ok: true }
    } catch {
      setStatus('error')
      return { ok: false }
    }
  }, [session, call])

  return { enabled: !!session, template, status, save, remove }
}
