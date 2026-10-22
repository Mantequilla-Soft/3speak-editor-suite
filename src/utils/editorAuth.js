// Sign-in for the editor's backend. Uploads, renders and clip work need a 3Speak sign-in: a short-lived editor
// token minted by the 3Speak page that opened us (POST /api/editor-token there, only for a VERIFIED session),
// the same token the drafts use. The page sends it as 'drafts-session' { session: { token } }; when we have
// none (or it is about to expire) we ask with 'drafts-sign-in', and the page answers with a new session:
// silently when the person already has a session there, after one wallet signature otherwise.
//
// Import this module early (main.jsx) so the first 'drafts-session' is not missed.
let token = null
let pending = null // one sign-in request at a time, however many uploads ask

const expOf = t => {
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || 0 } catch { return 0 }
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', e => {
    if (e.source !== window.parent || e.data?.type !== 'drafts-session') return
    token = e.data.session?.token || null
    if (pending) { const p = pending; pending = null; p.resolve({ token, reason: e.data.reason || null }) }
  })
}

/** The token if it is still good for at least a minute (never asks). */
export function currentToken() {
  return token && expOf(token) > Date.now() + 60000 ? token : null
}

/** Forget the token (the backend refused it). */
export function dropToken() { token = null }

export function signInError(reason) {
  const e = new Error(reason === 'logged-out'
    ? 'Log in on 3Speak to use the editor.'
    : 'Sign in on 3Speak to upload and render (the sign-in was cancelled or did not work).')
  e.code = 'sign-in'
  e.reason = reason
  return e
}

/** A valid token, asking the 3Speak page for one when needed. Rejects with code 'sign-in'. */
export async function ensureToken() {
  const t = currentToken()
  if (t) return t
  if (typeof window === 'undefined' || window.parent === window) throw signInError('standalone')
  if (!pending) {
    let resolve
    const promise = new Promise(r => { resolve = r })
    pending = { promise, resolve }
    window.parent.postMessage({ source: '3speak-editor', type: 'drafts-sign-in' }, '*')
    setTimeout(() => { if (pending?.promise === promise) { pending = null; resolve({ token: null, reason: 'timeout' }) } }, 120000)
  }
  const res = await pending.promise
  if (!res.token) throw signInError(res.reason)
  return res.token
}

/** { Authorization } for a backend call. */
export async function authHeaders() {
  return { Authorization: `Bearer ${await ensureToken()}` }
}

/**
 * fetch() with the sign-in token; on 401 the token is dropped, a fresh one is asked for and the call is
 * repeated once. Use for every call that starts work on the backend (uploads, renders, clip jobs).
 */
export async function authFetch(url, opts = {}) {
  const go = async () => fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...(await authHeaders()) } })
  let res = await go()
  if (res.status === 401) { dropToken(); res = await go() }
  return res
}
