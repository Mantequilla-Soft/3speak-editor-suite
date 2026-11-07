// Recordings made in the browser (MediaRecorder WebM/Ogg) carry no duration:
// an <audio>/<video> element reports Infinity (or NaN) until it has seen the
// end of the file. Seeking far past the end makes it scan there and fire
// durationchange with the real length; then it goes back to the start.

export function isUsableDuration(d) {
  return Number.isFinite(d) && d > 0
}

// Resolves the element's real duration in seconds, or null if it never shows
// one. Call it after loadedmetadata.
export function finiteDuration(el, timeoutMs = 8000) {
  if (isUsableDuration(el.duration)) return Promise.resolve(el.duration)
  return new Promise((resolve) => {
    let done = false
    const check = () => { if (isUsableDuration(el.duration)) finish(el.duration) }
    const finish = (d) => {
      if (done) return
      done = true
      clearTimeout(timer)
      el.removeEventListener('durationchange', check)
      el.removeEventListener('timeupdate', check)
      try { el.currentTime = 0 } catch { /* not seekable */ }
      resolve(d)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    el.addEventListener('durationchange', check)
    el.addEventListener('timeupdate', check)
    try { el.currentTime = 1e101 } catch { finish(null) }
  })
}

// What a duration should be when the file itself can't say: the element's
// value if usable, else the hint (e.g. the recorder's own clock), else null.
export function pickDuration(measured, hint) {
  if (isUsableDuration(measured)) return measured
  if (isUsableDuration(hint)) return hint
  return null
}

// MediaRecorder formats in order of preference. Safari (iPhone/iPad) records
// only audio/mp4, so a fixed audio/webm would make it throw.
export const RECORDER_AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

export function pickRecorderType(isSupported) {
  return RECORDER_AUDIO_TYPES.find(t => { try { return isSupported(t) } catch { return false } }) || ''
}

// File extension for a recorder's mime type ('audio/mp4;codecs=..' -> 'm4a')
export function recordingExtension(mimeType) {
  const base = String(mimeType || '').split(';')[0].trim()
  if (base === 'audio/mp4') return 'm4a'
  if (base === 'audio/ogg') return 'ogg'
  return 'webm'
}
