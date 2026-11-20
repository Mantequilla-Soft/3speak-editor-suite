import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../utils/backendSelector'
import { fetchLandscapeAccess, accessFromRefusal } from '../utils/landscapeAccess'

/**
 * May this user make landscape videos (3Speak Pro, utils/landscapeAccess.js)? Asked from the
 * backend once 3Speak sent the sign-in (the editor only runs in 3Speak's iframe, main.jsx).
 * The audio editor never asks: it is free. `access` is null until answered (nothing locked).
 * markRefused(body): the render route said 403 pro_required, so lock now.
 */
export function useLandscapeAccess({ session, audioMode }) {
  const [access, setAccess] = useState(null)
  const [checking, setChecking] = useState(false)
  const token = session?.token || null
  const user = session?.user || null
  const live = useRef(null)

  const ask = useCallback(async () => {
    if (audioMode || !token) return null
    live.current?.abort()
    const ac = new AbortController()
    live.current = ac
    setChecking(true)
    try {
      const a = await fetchLandscapeAccess({ url: api('/api/pro-status'), token, user, signal: ac.signal })
      if (!ac.signal.aborted) setAccess(a)
      return a
    } catch {
      return null // aborted: a newer question replaced it
    } finally {
      if (live.current === ac) { live.current = null; setChecking(false) }
    }
  }, [audioMode, token, user])

  useEffect(() => {
    ask()
    return () => live.current?.abort()
  }, [ask])

  const markRefused = useCallback((body) => setAccess(accessFromRefusal(body, user)), [user])
  return { access, checking, recheck: ask, markRefused }
}
