import { useRef, useState, useEffect, useCallback } from 'react'
import { X, Circle, Square, RotateCcw, Check } from 'lucide-react'
import { finiteDuration, pickRecorderType, recordingExtension } from '../utils/mediaDuration'
import { rmsLevel, levelHistory, drawLevels } from '../utils/voiceGraph'

// Level samples per second for the graph (and the take's shape afterwards)
const LEVEL_RATE = 20
// Seconds shown in the live graph while recording (newest on the right)
const LIVE_WINDOW = 8

function RecordAudio({ onRecorded, onClose }) {
  const streamRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const playbackRef = useRef(null)
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const rafRef = useRef(null)
  const canvasRef = useRef(null)
  const levelsRef = useRef(levelHistory())
  const startedAtRef = useRef(0)
  const durationRef = useRef(0)
  const phaseRef = useRef('starting')

  const [phase, setPhase] = useState('starting') // starting | ready | recording | done
  const [recordedBlob, setRecordedBlob] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState(null)
  const [previewReady, setPreviewReady] = useState(false)
  phaseRef.current = phase

  // The live graph: the mic's level, drawn every frame. Before recording it is
  // a level check; while recording every sample is kept for the take's shape.
  const stopGraph = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    analyserRef.current = null
    const ctx = audioCtxRef.current
    audioCtxRef.current = null
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
  }, [])

  const startGraph = useCallback((stream) => {
    stopGraph()
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(analyser)
    audioCtxRef.current = ctx
    analyserRef.current = analyser
    const buf = new Float32Array(analyser.fftSize)
    let lastSample = 0
    let live = levelHistory()
    const tick = (now) => {
      const a = analyserRef.current
      if (!a) return
      a.getFloatTimeDomainData(buf)
      const level = rmsLevel(buf)
      if (now - lastSample >= 1000 / LEVEL_RATE) {
        lastSample = now
        live.push(level)
        if (phaseRef.current === 'recording') levelsRef.current.push(level)
        if (live.length > LIVE_WINDOW * LEVEL_RATE) live = live.slice(-LIVE_WINDOW * LEVEL_RATE)
      }
      const canvas = canvasRef.current
      if (canvas) drawLevels(canvas, live, { slots: LIVE_WINDOW * LEVEL_RATE, align: 'right' })
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [stopGraph])

  const stopEverything = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    stopGraph()
  }, [stopGraph])

  const openMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    streamRef.current = stream
    startGraph(stream)
    return stream
  }, [startGraph])

  // Request microphone on mount
  useEffect(() => {
    let cancelled = false
    openMic().then(() => {
      if (cancelled) stopEverything()
      else setPhase('ready')
    }, () => {
      if (!cancelled) setError('Could not access microphone. Please allow microphone permissions.')
    })
    return () => {
      cancelled = true
      stopEverything()
    }
  }, [openMic, stopEverything])

  const startRecording = useCallback(() => {
    if (!streamRef.current) return
    // An AudioContext made before the first click can start suspended
    audioCtxRef.current?.resume?.().catch(() => {})

    chunksRef.current = []
    levelsRef.current = levelHistory()
    const mimeType = pickRecorderType((t) => window.MediaRecorder?.isTypeSupported?.(t))
    let recorder
    try {
      recorder = new MediaRecorder(streamRef.current, mimeType ? { mimeType } : undefined)
    } catch {
      setError('This browser cannot record audio here.')
      return
    }

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }

    recorder.onstop = () => {
      durationRef.current = (performance.now() - startedAtRef.current) / 1000
      const type = recorder.mimeType || mimeType || 'audio/webm'
      setRecordedBlob(new Blob(chunksRef.current, { type }))
      setPreviewReady(false)
      setPhase('done')
    }

    recorderRef.current = recorder
    recorder.start(100)
    startedAtRef.current = performance.now()
    setElapsed(0)
    setPhase('recording')

    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((performance.now() - startedAtRef.current) / 1000))
    }, 500)
  }, [])

  const stopRecording = useCallback(() => {
    stopEverything()
  }, [stopEverything])

  const handleRetake = useCallback(async () => {
    setRecordedBlob(null)
    setElapsed(0)
    setPhase('starting')
    try {
      await openMic()
      setPhase('ready')
    } catch {
      setError('Could not access microphone.')
    }
  }, [openMic])

  const handleUseClip = useCallback(() => {
    if (!recordedBlob) return
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const type = recordedBlob.type || 'audio/webm'
    const file = new File([recordedBlob], `Recording_${timestamp}.${recordingExtension(type)}`, { type: type.split(';')[0] })
    // Browser recordings carry no length of their own: the recorder's clock
    // stands in until the file is measured
    file._durationHint = durationRef.current
    onRecorded([file])
    onClose()
  }, [recordedBlob, onRecorded, onClose])

  const handleClose = useCallback(() => {
    stopEverything()
    onClose()
  }, [stopEverything, onClose])

  // Playback: the file has no duration of its own, so measure it before the
  // player shows (otherwise its bar grows while it plays)
  useEffect(() => {
    const el = playbackRef.current
    if (phase !== 'done' || !recordedBlob || !el) return
    const url = URL.createObjectURL(recordedBlob)
    let cancelled = false
    el.onloadedmetadata = async () => {
      await finiteDuration(el)
      if (cancelled) return
      setPreviewReady(true)
      el.play?.().catch(() => {})
    }
    el.src = url
    return () => {
      cancelled = true
      el.onloadedmetadata = null
      el.pause?.()
      URL.revokeObjectURL(url)
    }
  }, [phase, recordedBlob])

  // The whole take's shape, once it's done
  useEffect(() => {
    if (phase !== 'done' || !canvasRef.current) return
    drawLevels(canvasRef.current, levelsRef.current, { align: 'fit' })
  }, [phase])

  const formatTime = (secs) => {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <div className="record-overlay" onClick={handleClose}>
      <div className="record-modal record-audio-modal" onClick={e => e.stopPropagation()}>
        <div className="record-modal-header">
          <span>Record Audio</span>
          <button className="record-close-btn" onClick={handleClose}>
            <X size={18} />
          </button>
        </div>

        <div className="record-audio-preview">
          {error ? (
            <div className="record-error">{error}</div>
          ) : (
            <div className="record-audio-indicator">
              <canvas
                ref={canvasRef}
                className={`record-voice-graph${phase === 'recording' ? ' recording' : ''}`}
                aria-label={phase === 'done' ? 'Your recording' : 'Microphone level'}
                role="img"
              />
              {phase === 'recording' && (
                <div className="record-timer">
                  <span className="record-dot" />
                  {formatTime(elapsed)}
                </div>
              )}
              {phase === 'starting' && (
                <div className="record-loading">Accessing microphone...</div>
              )}
              {phase === 'ready' && (
                <div className="record-loading">Ready to record: speak to check your level</div>
              )}
              {phase === 'done' && (
                <audio ref={playbackRef} controls className={previewReady ? '' : 'record-audio-loading'} />
              )}
            </div>
          )}
        </div>

        <div className="record-controls">
          {phase === 'ready' && (
            <button className="record-start-btn" onClick={startRecording}>
              <Circle size={16} />
              <span>Start Recording</span>
            </button>
          )}

          {phase === 'recording' && (
            <button className="record-stop-btn" onClick={stopRecording}>
              <Square size={14} />
              <span>Stop</span>
            </button>
          )}

          {phase === 'done' && (
            <>
              <button className="record-retake-btn" onClick={handleRetake}>
                <RotateCcw size={14} />
                <span>Retake</span>
              </button>
              <button className="record-use-btn" onClick={handleUseClip}>
                <Check size={14} />
                <span>Use Recording</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default RecordAudio
