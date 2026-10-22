import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../utils/backendSelector'

// Server drafts for the Ad Wizard (backend /api/ad-drafts: 5 drafts, 90 days after the last save).
// Who the user is comes from the 3Speak page that opened us: it answers 'editor-ready' with
// 'drafts-session' { session: { token, user } | null, reason }, the same handshake as the editor's drafts.
export default function useAdDrafts() {
  const [session, setSession] = useState(null)
  const [reason, setReason] = useState(window.parent === window ? 'standalone' : 'waiting')
  const [signingIn, setSigningIn] = useState(false)
  const tokenRef = useRef(null)

  useEffect(() => {
    const onMsg = e => {
      if (e.source !== window.parent || e.data?.type !== 'drafts-session') return
      const s = e.data.session
      tokenRef.current = s?.token || null
      setSession(s?.token ? { user: s.user } : null)
      setReason(s?.token ? null : (e.data.reason || 'logged-out'))
      setSigningIn(false)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  const signIn = useCallback(() => {
    if (window.parent === window) return
    setSigningIn(true)
    window.parent.postMessage({ source: '3speak-editor', type: 'drafts-sign-in' }, '*')
  }, [])

  const call = useCallback(async (path, opts = {}) => {
    if (!tokenRef.current) throw new Error('not signed in')
    const res = await fetch(api(`/api/ad-drafts${path}`), {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenRef.current}`, ...(opts.headers || {}) },
    })
    const body = await res.json().catch(() => ({}))
    if (res.status === 401) { tokenRef.current = null; setSession(null); setReason('sign-in-needed') }
    if (!res.ok) { const err = new Error(body.error || `drafts ${res.status}`); err.status = res.status; err.body = body; throw err }
    return body
  }, [])

  return {
    session, reason, signingIn, signIn,
    list: () => call(''),
    load: id => call(`/${id}`),
    save: (id, name, state, replace) => call(`/${id}`, { method: 'PUT', body: JSON.stringify({ name, state, ...(replace ? { replace } : {}) }) }),
    remove: id => call(`/${id}`, { method: 'DELETE' }),
  }
}
