import { useRef, useState, useEffect, useCallback } from 'react'
import { X, Circle, Square, RotateCcw, Check, Mic } from 'lucide-react'

function RecordAudio({ onRecorded, onClose }) {
  const streamRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const playbackRef = useRef(null)

  const [phase, setPhase] = useState('starting') // starting | ready | recording | done
  const [recordedBlob, setRecordedBlob] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState(null)

  // Request microphone on mount
  useEffect(() => {
    let cancelled = false

    async function startMic() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop())
          return
        }
        streamRef.current = stream
        setPhase('ready')
      } catch {
        if (!cancelled) {
          setError('Could not access microphone. Please allow microphone permissions.')
        }
      }
    }

    startMic()

    return () => {
      cancelled = true
      stopEverything()
    }
  }, [])

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
  }, [])

  const startRecording = useCallback(() => {
    if (!streamRef.current) return

    chunksRef.current = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    const recorder = new MediaRecorder(streamRef.current, { mimeType })

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      setRecordedBlob(blob)
      setPhase('done')
    }

    recorderRef.current = recorder
    recorder.start(100)
    setElapsed(0)
    setPhase('recording')

    const startTime = Date.now()
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 500)
  }, [])

  const stopRecording = useCallback(() => {
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
  }, [])

  const handleRetake = useCallback(async () => {
    setRecordedBlob(null)
    setElapsed(0)
    setPhase('starting')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      setPhase('ready')
    } catch {
      setError('Could not access microphone.')
    }
  }, [])

  const handleUseClip = useCallback(() => {
    if (!recordedBlob) return
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = new File([recordedBlob], `Recording_${timestamp}.webm`, { type: 'audio/webm' })
    onRecorded([file])
    onClose()
  }, [recordedBlob, onRecorded, onClose])

  const handleClose = useCallback(() => {
    stopEverything()
    onClose()
  }, [stopEverything, onClose])

  // Set playback source when done
  useEffect(() => {
    if (phase === 'done' && recordedBlob && playbackRef.current) {
      playbackRef.current.src = URL.createObjectURL(recordedBlob)
    }
  }, [phase, recordedBlob])

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
          ) : phase === 'done' ? (
            <audio ref={playbackRef} controls autoPlay />
          ) : (
            <div className="record-audio-indicator">
              <Mic size={48} className={phase === 'recording' ? 'recording-pulse' : ''} />
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
                <div className="record-loading">Ready to record</div>
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
