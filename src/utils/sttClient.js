// Ported from the 3Speak frontend (src/utils/sttClient.js). Differences:
//  - the token is passed in (the editor is on another origin, so it cannot call
//    the frontend's /api/stt-token; the parent page mints it, see sttBridge.js)
//  - the AudioWorklet module is bundled as text ("?raw") and loaded from a Blob
//    URL instead of public/ (the frontend Dockerfile only copies src/, and a
//    "?url" import of a file this small gets inlined as a data: URI, which
//    addModule() does not accept everywhere)
//
// Streaming speech-to-text client for the teleprompter.
//
// Taps the SAME MediaStreamTrack that MediaRecorder is recording (via Web Audio —
// no second getUserMedia, so it can't starve the browser recognizer the way a
// second mic capture does), downsamples it in an AudioWorklet, and streams 16 kHz
// mono Int16 PCM to a self-hosted STT server over a WebSocket. Transcripts come
// back as JSON and are handed to `onTranscript`.
//
// Wire protocol (must match the STT server — see the hand-off plan):
//   connect:  `${url}?lang=<bcp47>&token=<exp.hmac>`
//   client → server:  first a text frame {"type":"start","lang":"en-US"}, then
//                     binary frames of PCM16 mono 16 kHz little-endian
//   server → client:  {"type":"partial"|"final","text":"..."}  and
//                     {"type":"error","message":"..."}
//
// Returns a handle with stop(); tears everything down safely.
import workletSource from './sttDownsampler.worklet.js?raw'

let workletUrl = null
function getWorkletUrl() {
  if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }))
  return workletUrl
}

export function createSttStream({ track, url, lang, token, onTranscript, onStatus }) {
  let ctx = null
  let source = null
  let worklet = null
  let ws = null
  let closed = false

  const status = (s, msg) => { try { onStatus?.(s, msg) } catch { /* ignore */ } }

  ;(async () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!AudioCtx || !track) { status('error', 'audio unavailable'); return }
      const openCtx = async (opts) => {
        const c = opts ? new AudioCtx(opts) : new AudioCtx()
        // Editor addition: this runs after the countdown, outside a click, so the
        // context can start 'suspended' under autoplay rules; ask it to run.
        // Raced with a timer: without user activation Safari can leave the promise
        // pending forever.
        try {
          await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 500))])
        } catch { /* stays suspended; status shows no transcript */ }
        await c.audioWorklet.addModule(getWorkletUrl())
        return c
      }
      ctx = await openCtx()
      if (closed) { try { ctx.close() } catch { /* ignore */ } return }

      // Editor addition: Firefox refuses to connect a mic to a context running at
      // another sample rate (NotSupportedError). Reopen the context at the mic's
      // rate (or the usual ones when the track does not report it); the worklet
      // downsamples from whatever rate it gets.
      const mic = new MediaStream([track])
      try {
        source = ctx.createMediaStreamSource(mic)
      } catch (err) {
        const rates = [track.getSettings?.().sampleRate, 48000, 44100]
          .filter((r, i, all) => r && r !== ctx.sampleRate && all.indexOf(r) === i)
        for (const sampleRate of rates) {
          try { ctx.close() } catch { /* ignore */ }
          ctx = await openCtx({ sampleRate })
          if (closed) { try { ctx.close() } catch { /* ignore */ } return }
          try { source = ctx.createMediaStreamSource(mic); break } catch { /* next rate */ }
        }
        if (!source) throw err
      }
      worklet = new AudioWorkletNode(ctx, 'stt-downsampler', { processorOptions: { targetRate: 16000 } })

      const wsUrl = new URL(url)
      wsUrl.searchParams.set('lang', lang || 'en-US')
      if (token) wsUrl.searchParams.set('token', token)
      ws = new WebSocket(wsUrl.toString())
      ws.binaryType = 'arraybuffer'
      status('connecting')

      ws.onopen = () => {
        status('connected')
        try { ws.send(JSON.stringify({ type: 'start', lang: lang || 'en-US' })) } catch { /* ignore */ }
      }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          // isFinal closes the utterance so the matcher restarts its word count.
          if (msg.type === 'partial' || msg.type === 'final') onTranscript?.(msg.text || '', msg.type === 'final')
          else if (msg.type === 'error') status('error', msg.message || 'server error')
        } catch { /* ignore non-JSON */ }
      }
      ws.onerror = () => status('error', 'connection failed')
      ws.onclose = (ev) => { if (closed) return; status('error', ev && ev.code === 4401 ? 'unauthorized' : 'closed') }

      worklet.port.onmessage = (e) => {
        if (ws && ws.readyState === 1) { try { ws.send(e.data) } catch { /* ignore */ } }
      }

      source.connect(worklet)
      worklet.connect(ctx.destination) // pulls the graph; the processor emits silence
    } catch (err) {
      status('error', err?.message || 'stt init failed')
    }
  })()

  return {
    stop() {
      closed = true
      try { ws?.close() } catch { /* ignore */ }
      try { source?.disconnect() } catch { /* ignore */ }
      try { worklet?.disconnect() } catch { /* ignore */ }
      try { ctx?.close() } catch { /* ignore */ }
    },
  }
}

export default createSttStream
