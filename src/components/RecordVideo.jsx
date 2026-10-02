import { useRef, useState, useEffect, useCallback } from 'react'
import { X, Circle, Square, RotateCcw, Check } from 'lucide-react'

function RecordVideo({ onRecorded, onClose }) {
  const liveVideoRef = useRef(null)
  const playbackVideoRef = useRef(null)
  const streamRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)

  const [phase, setPhase] = useState('starting') // starting | previewing | recording | done
  const [recordedBlob, setRecordedBlob] = useState(null)
  const [playbackUrl, setPlaybackUrl] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState(null)

  // Start camera on mount
  useEffect(() => {
    let cancelled = false

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: true
        })
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop())
          return
        }
        streamRef.current = stream
        if (liveVideoRef.current) {
          liveVideoRef.current.srcObject = stream
        }
        setPhase('previewing')
      } catch (err) {
        if (!cancelled) {
          setError('Could not access camera. Please allow camera permissions.')
        }
      }
    }

    startCamera()

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
    const recorder = new MediaRecorder(streamRef.current, {
      mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm'
    })

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data)
      }
    }

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' })
      setRecordedBlob(blob)
      const url = URL.createObjectURL(blob)
      setPlaybackUrl(url)
      // Set src imperatively on the already-mounted (but hidden) video element
      if (playbackVideoRef.current) {
        playbackVideoRef.current.src = url
        playbackVideoRef.current.load()
        playbackVideoRef.current.play().catch(() => {})
      }
      setPhase('done')
    }

    recorderRef.current = recorder
    recorder.start(100) // collect data every 100ms
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
    // Stop camera stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }, [])

  const handleRetake = useCallback(async () => {
    if (playbackUrl) URL.revokeObjectURL(playbackUrl)
    if (playbackVideoRef.current) {
      playbackVideoRef.current.pause()
      playbackVideoRef.current.removeAttribute('src')
      playbackVideoRef.current.load()
    }
    setRecordedBlob(null)
    setPlaybackUrl(null)
    setElapsed(0)
    setPhase('starting')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: true
      })
      streamRef.current = stream
      if (liveVideoRef.current) {
        liveVideoRef.current.srcObject = stream
      }
      setPhase('previewing')
    } catch {
      setError('Could not access camera.')
    }
  }, [])

  const handleUseClip = useCallback(() => {
    if (!recordedBlob) return
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = new File([recordedBlob], `Recording_${timestamp}.webm`, { type: 'video/webm' })
    onRecorded([file])
    onClose()
  }, [recordedBlob, onRecorded, onClose])

  const handleClose = useCallback(() => {
    stopEverything()
    onClose()
  }, [stopEverything, onClose])

  // Revoke old playback URL on cleanup
  useEffect(() => {
    return () => {
      if (playbackUrl) URL.revokeObjectURL(playbackUrl)
    }
  }, [playbackUrl])

  const formatTime = (secs) => {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <div className="record-overlay" onClick={handleClose}>
      <div className="record-modal" onClick={e => e.stopPropagation()}>
        <div className="record-modal-header">
          <span>Record Video</span>
          <button className="record-close-btn" onClick={handleClose}>
            <X size={18} />
          </button>
        </div>

        <div className="record-preview">
          {error ? (
            <div className="record-error">{error}</div>
          ) : (
            <>
              <video
                ref={liveVideoRef}
                autoPlay
                muted
                playsInline
                style={{ transform: 'scaleX(-1)', display: phase !== 'done' ? 'block' : 'none' }}
              />
              <video
                ref={playbackVideoRef}
                controls
                muted
                loop
                playsInline
                preload="auto"
                style={{ display: phase === 'done' ? 'block' : 'none' }}
              />
            </>
          )}

          {phase === 'recording' && (
            <div className="record-timer">
              <span className="record-dot" />
              {formatTime(elapsed)}
            </div>
          )}

          {phase === 'starting' && !error && (
            <div className="record-loading">Starting camera...</div>
          )}
        </div>

        <div className="record-controls">
          {phase === 'previewing' && (
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
                <span>Use Clip</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default RecordVideo
