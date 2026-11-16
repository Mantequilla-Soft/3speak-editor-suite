// The editor's side of the render queue (backend/src/utils/renderQueue.js):
// a busy or unreachable server is waited for, not reported as "Render failed".
// submitRender() sends the job and tries again by itself (backoff, the
// server's retryAfter) on 503 / 502 / 504 / 429 and network errors;
// pollRender() follows the job ("You are 2nd in line", then the progress)
// and stops at the first hard error instead of asking forever.

import { t, hasKey, getLanguage } from '../i18n'

export const SUBMIT_GIVE_UP_MS = 10 * 60 * 1000 // trying to submit for this long: give up
export const POLL_GIVE_UP_MS = 2 * 60 * 1000 // no answer to status polls for this long: give up
export const POLL_INTERVAL_MS = 1500
const RETRY_FIRST_MS = 2000
const RETRY_MAX_MS = 30000

/** Statuses during which a render is on its way (the Render button waits). */
export function isRenderActive(status) {
  return status === 'submitting' || status === 'queued' || status === 'processing'
}

/** Worth trying again: the server is busy or briefly away. */
export function isRetryable(httpStatus) {
  return httpStatus === 0 || httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504
}

/** Wait before try number `attempt` (1, 2, ...): doubling from 2 s, at most 30 s, at least the server's retryAfter (capped too). */
export function retryDelay(attempt, retryAfterSec = null) {
  const backoff = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, attempt - 1))
  const asked = Number.isFinite(+retryAfterSec) && +retryAfterSec > 0 ? Math.min(RETRY_MAX_MS, +retryAfterSec * 1000) : 0
  return Math.max(backoff, asked)
}

/** "You are next" / "You are 2nd in line" (1 = the next to start). */
export function positionText(position) {
  if (!(position >= 1)) return null
  if (position === 1) return t('render.queue.next')
  const n = Math.floor(position)
  // 2nd / 3rd / 4th: the language's ordinal form (render.queue.inLine.<one|two|few|other>)
  let form = 'other'
  try { form = new Intl.PluralRules(getLanguage(), { type: 'ordinal' }).select(n) } catch { /* old browser */ }
  const key = hasKey(`render.queue.inLine.${form}`) ? `render.queue.inLine.${form}` : 'render.queue.inLine.other'
  return t(key, { n })
}

/** The line shown for a job status from the server. */
export function statusPhase(data) {
  if (data?.status === 'queued') return positionText(data.position) || t('render.queue.waiting')
  return data?.phase || null
}

const defaultSleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

/** fetch → { status, data } (status 0 = no answer) */
async function call(fn) {
  try {
    const res = await fn()
    const data = await res.json().catch(() => ({}))
    return { status: res.status, ok: res.ok, data }
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    return { status: 0, ok: false, data: { error: err?.message || 'Network error' } }
  }
}

/**
 * Send the render job. send() returns a fetch Response. onWait({ seconds, busy })
 * while it waits to try again. Resolves with the server's answer
 * ({ jobId, status, position?, backendEndpoint? }), null when aborted, throws on a hard error.
 */
export async function submitRender({ send, onWait = () => {}, signal = null, sleep = defaultSleep, now = () => Date.now(), giveUpMs = SUBMIT_GIVE_UP_MS }) {
  const started = now()
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) return null
    const r = await call(send)
    if (r.ok) return r.data
    if (!isRetryable(r.status)) throw new Error(r.data?.error || t('errors.render.serverStatus', { status: String(r.status) }))
    const wait = retryDelay(attempt, r.data?.retryAfter)
    if (now() - started + wait > giveUpMs) {
      throw new Error(r.status === 0 ? t('errors.render.unreachable') : t('errors.render.stillBusy'))
    }
    onWait({ seconds: Math.round(wait / 1000), busy: r.status !== 0 })
    await sleep(wait, signal)
  }
}

/**
 * Follow a job until it is done. get() returns a fetch Response for its
 * status. onStatus(data) for every answer while it waits or renders. Resolves
 * with the last answer (status completed / failed / aborted), null when
 * aborted, throws when the job is gone (404, other 4xx) or the server does
 * not answer for giveUpMs.
 */
export async function pollRender({ get, onStatus = () => {}, signal = null, sleep = defaultSleep, now = () => Date.now(), interval = POLL_INTERVAL_MS, giveUpMs = POLL_GIVE_UP_MS }) {
  let failingSince = null
  let failures = 0
  for (;;) {
    if (signal?.aborted) return null
    const r = await call(get)
    if (signal?.aborted) return null
    if (r.ok) {
      failingSince = null
      failures = 0
      const data = r.data || {}
      if (data.status === 'completed' || data.status === 'failed' || data.status === 'aborted') return data
      onStatus(data)
      await sleep(interval, signal)
      continue
    }
    if (r.status === 404) throw new Error(t('errors.render.unknownJob'))
    if (!isRetryable(r.status) && r.status !== 500) throw new Error(r.data?.error || t('errors.render.serverStatus', { status: String(r.status) }))
    failures++
    failingSince ??= now()
    if (now() - failingSince > giveUpMs) throw new Error(t('errors.render.lostContact'))
    onStatus({ reconnecting: true })
    await sleep(Math.min(retryDelay(failures), 10000), signal)
  }
}
