// Asks the embedding 3Speak page for the teleprompter's speech-to-text settings.
//
// The STT server needs a short-lived signed token that only the 3Speak frontend
// can mint (its server holds the signing secret, behind /api/stt-token). The
// editor runs on another origin, so it cannot call that endpoint itself; instead
// it posts a request to the parent window and EditorModal answers with
//   { type: 'stt-config', requestId, url, token, models }
// (`url` empty = no STT server configured). No answer within the timeout (an
// older parent page, or the editor opened on its own) means "no STT"; callers
// then fall back to the browser's Web Speech or the timed mode.
//
// Self-contained on purpose (its own message listener) so it does not have to
// share useIframeApi's message switch.

const isIframe = typeof window !== 'undefined' && window.parent !== window
let seq = 0

export function requestSttConfig({ timeoutMs = 2500 } = {}) {
  if (!isIframe) return Promise.resolve(null)
  seq += 1
  const requestId = `stt-${Date.now()}-${seq}`
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(value)
    }
    const onMessage = (event) => {
      // Only the window that embeds us may answer.
      if (event.source !== window.parent) return
      const data = event.data
      if (!data || data.type !== 'stt-config' || data.requestId !== requestId) return
      const url = typeof data.url === 'string' ? data.url : ''
      finish(url ? {
        url,
        token: typeof data.token === 'string' ? data.token : '',
        models: Array.isArray(data.models) ? data.models.filter(m => typeof m === 'string') : []
      } : null)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    window.addEventListener('message', onMessage)
    try {
      // The request carries no secret, so any parent origin may receive it; the
      // reply (with the token) is sent by the parent to the editor's own origin.
      window.parent.postMessage({ source: '3speak-editor', type: 'stt-config-request', requestId }, '*')
    } catch {
      finish(null)
    }
  })
}
