import { useRef, useState, useEffect, useCallback } from 'react'
import { X, Circle, Square, RotateCcw, Check, Maximize2, Minimize2 } from 'lucide-react'
import { api, getBackendUrl } from '../utils/backendSelector'
import { layoutPan, layoutZoom } from '../utils/remixLayout'

// guide (remix modes, optional): { title, hint, maxDuration, sync }
//   sync: true  -> only "record + play" (reaction), false -> only plain record (stitch)
//   maxDuration -> recording stops by itself after this many seconds
// pipSize 'stage' (phone record stage): the root covers the preview canvas,
//   the camera sits in boxStyle, framed by boxLayout's pan / zoom;
//   onBoxPointerDown(e, { mirror }) hands its gestures to the preview; layoutChoices [{ mode, label }] +
//   onChangeLayout let the reaction layout change before recording
// reviewSync (reactions, optional): links the take's playback to the timeline
//   preview: { start, playhead, previewPlaying, playFrom, seek, pause, getPosition }
function InlineRecorder({ onRecorded, onClose, onSyncRecord, onRecordingStopped, pipSize, onToggleSize, guide, reviewSync, boxStyle, boxLayout, onBoxPointerDown, layoutChoices, onChangeLayout }) {
  const liveVideoRef = useRef(null)
  const playbackVideoRef = useRef(null)
  const streamRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)

  const [phase, setPhase] = useState('starting') // starting | previewing | countdown | recording | done | uploading
  const [countdown, setCountdown] = useState(0)
  const countdownRef = useRef(null)
  const maxDuration = guide?.maxDuration > 0 ? guide.maxDuration : null
  const syncGuideRef = useRef(false)
  syncGuideRef.current = !!guide
  const [recordedBlob, setRecordedBlob] = useState(null)
  const [playbackUrl, setPlaybackUrl] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState(null)

  // Drag state (only for small PiP mode)
  const [position, setPosition] = useState({ right: 12, bottom: 12 })
  const dragRef = useRef(null)

  const isSmall = pipSize === 'small'
  const isStage = pipSize === 'stage'

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
          setError('Camera access denied')
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
    if (countdownRef.current) {
      clearInterval(countdownRef.current)
      countdownRef.current = null
    }
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
      if (playbackVideoRef.current) {
        playbackVideoRef.current.src = url
        playbackVideoRef.current.load()
        // Guided takes (stitch / reaction) play with sound, so wait for the
        // user to press play instead of starting on their own
        if (!syncGuideRef.current) playbackVideoRef.current.play().catch(() => {})
      }
      setPhase('done')
    }

    recorderRef.current = recorder
    recorder.start(100)
    setElapsed(0)
    setPhase('recording')

    const startTime = Date.now()
    timerRef.current = setInterval(() => {
      const secs = (Date.now() - startTime) / 1000
      setElapsed(Math.floor(secs))
      if (maxDuration && secs >= maxDuration) stopRecordingRef.current?.()
    }, 100)
  }, [maxDuration])

  const stopRecordingRef = useRef(null)

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
    if (onRecordingStopped) onRecordingStopped()
  }, [onRecordingStopped])
  stopRecordingRef.current = stopRecording

  // Sync record: triggers play on GlobalPreview + starts recording
  const handleSyncRecord = useCallback(() => {
    startRecording()
    if (onSyncRecord) onSyncRecord()
  }, [startRecording, onSyncRecord])

  // Guided modes count 3-2-1 before recording starts
  const startWithCountdown = useCallback((start) => {
    setPhase('countdown')
    setCountdown(3)
    let n = 3
    countdownRef.current = setInterval(() => {
      n -= 1
      if (n > 0) {
        setCountdown(n)
        return
      }
      clearInterval(countdownRef.current)
      countdownRef.current = null
      start()
    }, 1000)
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
      setError('Camera access denied')
    }
  }, [playbackUrl])

  const [uploadProgress, setUploadProgress] = useState('')

  // ---- Reviewing a reaction take in step with the original ----
  const review = phase === 'done' ? reviewSync : null
  const reviewRef = useRef(review)
  reviewRef.current = review

  const handleReviewPlay = useCallback(() => {
    const r = reviewRef.current
    const v = playbackVideoRef.current
    if (!r || !v) return
    const pos = r.start + v.currentTime
    // Already running together (e.g. started from the preview's play button)
    if (r.previewPlaying && Math.abs(r.getPosition() - pos) < 0.3) return
    r.playFrom(pos)
  }, [])

  const handleReviewPause = useCallback(() => {
    reviewRef.current?.pause()
  }, [])

  const handleReviewSeeked = useCallback(() => {
    const r = reviewRef.current
    const v = playbackVideoRef.current
    if (!r || !v) return
    const pos = r.start + v.currentTime
    if (Math.abs(r.getPosition() - pos) < 0.1) return
    r.seek(pos)
  }, [])

  // Preview -> take: follow the scrubber while paused, and play/pause along
  // with the preview's own controls.
  const reviewPlayhead = review?.playhead
  const reviewPreviewPlaying = review?.previewPlaying
  useEffect(() => {
    const r = reviewRef.current
    const v = playbackVideoRef.current
    if (!r || !v || !v.duration) return
    const t = Math.max(0, Math.min(v.duration, r.playhead - r.start))
    if (r.previewPlaying) {
      if (v.paused && r.playhead - r.start < v.duration) {
        v.currentTime = t
        v.play().catch(() => {})
      }
    } else {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - t) > 0.1) v.currentTime = t
    }
  }, [reviewPlayhead, reviewPreviewPlaying])

  const handleUseClip = useCallback(async () => {
    if (!recordedBlob) return
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = new File([recordedBlob], `Recording_${timestamp}.webm`, { type: 'video/webm' })

    // Upload to backend for smooth playback
    setPhase('uploading')
    setUploadProgress('Uploading...')
    const uploadStart = Date.now()

    try {
      const formData = new FormData()
      formData.append('file', file, file.name)

      // Use XMLHttpRequest for upload progress tracking
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        // wait=1: the backend answers once the 480p file is ready, so the URL
        // serves the same file to the picture and the sound from the start
        xhr.open('POST', `${api('/api/upload')}?wait=1`)

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100)
            setUploadProgress(`Uploading... ${pct}%`)
          }
        }
        xhr.upload.onload = () => setUploadProgress('Converting...')

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText))
            } catch {
              resolve(null)
            }
          } else {
            reject(new Error(`Upload failed: ${xhr.status}`))
          }
        }

        xhr.onerror = () => reject(new Error('Upload network error'))
        xhr.send(formData)
      })

      if (result?.url) {
        const backendUrl = getBackendUrl()
        file._serverUrl = (backendUrl && result.url.startsWith('/')) ? `${backendUrl}${result.url}` : result.url
      }
    } catch (err) {
      console.warn('[InlineRecorder] Upload failed, using blob URL:', err)
    }

    // Ensure the uploading state is visible for at least 1 second
    const elapsed = Date.now() - uploadStart
    if (elapsed < 1000) {
      await new Promise(r => setTimeout(r, 1000 - elapsed))
    }

    onRecorded([file])
    onClose()
  }, [recordedBlob, onRecorded, onClose])

  const handleClose = useCallback(() => {
    stopEverything()
    onClose()
  }, [stopEverything, onClose])

  // Cleanup blob URL
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

  // Drag handler for PiP repositioning (only in small mode)
  const handleDragStart = useCallback((e) => {
    if (!isSmall) return
    e.preventDefault()
    const pip = e.currentTarget.closest('.inline-recorder-pip')
    if (!pip) return
    const parent = pip.parentElement
    if (!parent) return

    const parentRect = parent.getBoundingClientRect()
    const pipRect = pip.getBoundingClientRect()
    const startX = e.clientX || e.touches?.[0]?.clientX
    const startY = e.clientY || e.touches?.[0]?.clientY
    const startRight = parentRect.right - pipRect.right
    const startBottom = parentRect.bottom - pipRect.bottom

    dragRef.current = { startX, startY, startRight, startBottom, parentRect, pipRect }

    const onMove = (moveEvt) => {
      const clientX = moveEvt.clientX || moveEvt.touches?.[0]?.clientX
      const clientY = moveEvt.clientY || moveEvt.touches?.[0]?.clientY
      const dx = clientX - dragRef.current.startX
      const dy = clientY - dragRef.current.startY
      const maxRight = parentRect.width - pipRect.width
      const maxBottom = parentRect.height - pipRect.height
      setPosition({
        right: Math.max(0, Math.min(maxRight, dragRef.current.startRight - dx)),
        bottom: Math.max(0, Math.min(maxBottom, dragRef.current.startBottom - dy))
      })
    }

    const onEnd = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onEnd)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onEnd)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd)
  }, [isSmall])

  // Stage: the camera is framed like a layout clip (cover x zoom, panned). The
  // live view is mirrored, so it flips the pan to show the same part of the
  // picture the recording will keep.
  const stageMediaStyle = (mirror) => {
    if (!isStage || !boxLayout) return null
    const { panX, panY } = layoutPan(boxLayout)
    const z = layoutZoom(boxLayout)
    const px = mirror ? 1 - panX : panX
    return {
      position: 'absolute',
      width: `${z * 100}%`,
      height: `${z * 100}%`,
      left: `${-(z - 1) * px * 100}%`,
      top: `${-(z - 1) * panY * 100}%`,
      maxWidth: 'none',
      objectFit: 'cover',
      objectPosition: `${px * 100}% ${panY * 100}%`,
      pointerEvents: 'none'
    }
  }
  const handleBoxPointerDown = isStage && onBoxPointerDown
    ? (e) => onBoxPointerDown(e, { mirror: phase !== 'done' && phase !== 'uploading' })
    : undefined

  const pipClassName = `inline-recorder-pip pip-${isSmall ? 'small' : isStage ? 'stage' : 'big'}`
  const pipStyle = isSmall ? { right: position.right, bottom: position.bottom } : {}

  return (
    <div className={pipClassName} style={pipStyle}>
      <div
        className="pip-header"
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
      >
        <span className="pip-title">
          {phase === 'recording'
            ? (maxDuration ? `${formatTime(elapsed)} / ${formatTime(Math.floor(maxDuration))}` : formatTime(elapsed))
            : phase === 'uploading' ? (uploadProgress || 'Uploading...') : (guide?.title || 'Camera')}
        </span>
        <div className="pip-header-actions">
          {onToggleSize && (
            <button className="pip-size-btn" onClick={onToggleSize} title={isSmall ? 'Expand' : 'Shrink'}>
              {isSmall ? <Maximize2 size={10} /> : <Minimize2 size={10} />}
            </button>
          )}
          <button className="pip-close-btn" onClick={handleClose}>
            <X size={12} />
          </button>
        </div>
      </div>

      <div
        className="pip-video-area"
        style={isStage ? boxStyle : undefined}
        onMouseDown={handleBoxPointerDown}
        onTouchStart={handleBoxPointerDown}
        onContextMenu={isStage ? (e) => e.preventDefault() : undefined}
      >
        {error ? (
          <div className="pip-error">{error}</div>
        ) : (
          <>
            <video
              ref={liveVideoRef}
              autoPlay
              muted
              playsInline
              style={{ ...stageMediaStyle(true), transform: 'scaleX(-1)', display: phase !== 'done' && phase !== 'uploading' ? 'block' : 'none' }}
            />
            <video
              ref={playbackVideoRef}
              // On the stage the preview's own play button + scrubber drive the take
              controls={phase !== 'uploading' && !isStage}
              muted={!guide}
              loop={!guide}
              onPlay={reviewSync ? handleReviewPlay : undefined}
              onPause={reviewSync ? handleReviewPause : undefined}
              onSeeked={reviewSync ? handleReviewSeeked : undefined}
              playsInline
              preload="auto"
              style={{ ...stageMediaStyle(false), display: phase === 'done' || phase === 'uploading' ? 'block' : 'none' }}
            />
            {phase === 'uploading' && (
              <div className="pip-uploading-overlay">{uploadProgress || 'Uploading...'}</div>
            )}
          </>
        )}

        {phase === 'recording' && (
          <div className="pip-timer">
            <span className="record-dot" />
            REC
          </div>
        )}

        {phase === 'starting' && !error && (
          <div className="pip-loading">Starting...</div>
        )}

        {phase === 'countdown' && (
          <div className="pip-countdown">{countdown}</div>
        )}
      </div>

      {guide?.hint && (phase === 'previewing' || phase === 'starting') && (
        <div className="pip-guide">
          {guide.hint}
          {handleBoxPointerDown && (
            <span className="pip-guide-gestures">
              Hold and drag a picture to reframe it, pinch to zoom{guide.mode === 'overlay' ? ', drag your camera box to move it' : ''}.
            </span>
          )}
        </div>
      )}

      {isStage && layoutChoices && onChangeLayout && (phase === 'previewing' || phase === 'starting') && (
        <div className="pip-layouts">
          {layoutChoices.map(l => (
            <button
              key={l.mode}
              className={l.mode === guide?.mode ? 'active' : ''}
              onClick={() => onChangeLayout(l.mode)}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}

      <div className="pip-controls">
        {phase === 'previewing' && !guide && (
          <>
            <button className="pip-record-btn" onClick={startRecording} title="Record only">
              <Circle size={14} />
            </button>
            {onSyncRecord && (
              <button className="pip-sync-btn" onClick={handleSyncRecord} title="Record + Play video">
                <Circle size={10} />
                <span className="sync-label">+ Play</span>
              </button>
            )}
          </>
        )}
        {phase === 'previewing' && guide && (
          guide.sync && onSyncRecord ? (
            <button className="pip-sync-btn" onClick={() => startWithCountdown(handleSyncRecord)} title="Record while the original plays">
              <Circle size={10} />
              <span className="sync-label">Record reaction</span>
            </button>
          ) : (
            <button className="pip-sync-btn" onClick={() => startWithCountdown(startRecording)} title="Record">
              <Circle size={10} />
              <span className="sync-label">Record</span>
            </button>
          )
        )}
        {phase === 'recording' && (
          <button className="pip-stop-btn" onClick={stopRecording} title="Stop">
            <Square size={12} />
          </button>
        )}
        {phase === 'done' && (
          <>
            <button className="pip-retake-btn" onClick={handleRetake} title="Retake">
              <RotateCcw size={12} />
            </button>
            <button className="pip-use-btn" onClick={handleUseClip} title="Use Clip">
              <Check size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default InlineRecorder
