import { useRef, useState, useEffect, useCallback } from 'react'
import { X, Circle, Square, RotateCcw, Check, Maximize2, Minimize2, ScrollText } from 'lucide-react'
import { api, getBackendUrl } from '../utils/backendSelector'
import { layoutPan, layoutZoom } from '../utils/remixLayout'
import { defaultChromaKey, normalizeChromaKey, captureSteadyPlate, canvasToBlobUrl, KEY_RANGES } from '../utils/chromaKey'
import { lockCamera, unlockCamera, applyCameraLock, describeCameraLock } from '../utils/cameraLock'
import ChromaKeyCanvas from './ChromaKeyCanvas'
import Teleprompter from './Teleprompter/Teleprompter'

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

  // Green screen: the take is recorded RAW (no keying baked in); the clip it
  // becomes gets the key, and the camera view shows the keyed picture meanwhile.
  // 'static' compares against a frame of the empty background (the plate).
  const [greenScreen, setGreenScreen] = useState(null) // null | 'green' | 'blue' | 'static'
  const [plateUrl, setPlateUrl] = useState(null)
  const [noiseUrl, setNoiseUrl] = useState(null) // how much each spot of the plate flickers
  // Camera lock while a plate is in use: { result, applied, track }
  const [cameraLock, setCameraLock] = useState(null)
  const cameraLockRef = useRef(null)
  cameraLockRef.current = cameraLock
  const [plateCount, setPlateCount] = useState(null) // countdown before the plate is taken (0 = capturing)
  const [keyFailed, setKeyFailed] = useState(false)
  // Threshold (similarity) and Despill (spill) as set here; reset per mode
  const [keyTune, setKeyTune] = useState(null)
  const plateTimerRef = useRef(null)
  const chromaKey = greenScreen ? { ...defaultChromaKey(greenScreen, plateUrl, noiseUrl), ...keyTune } : null
  const keyConfig = chromaKey && !keyFailed ? normalizeChromaKey(chromaKey) : null
  const liveKeyed = !!keyConfig && phase !== 'done' && phase !== 'uploading'

  const videoTrack = () => streamRef.current?.getVideoTracks?.()[0] || null
  const releaseCameraLock = () => {
    const lock = cameraLockRef.current
    if (lock?.track && lock.track.readyState === 'live') unlockCamera(lock.track)
    setCameraLock(null)
  }

  // Plate: 3 seconds to step out of the picture, then the camera re-adjusts to
  // the empty room and settles, focus / exposure / white balance get locked
  // where the camera allows it, and a few raw frames are averaged (plus their
  // noise map, which tells the key how much each spot flickers by itself)
  const capturePlate = () => {
    if (plateTimerRef.current || plateCount != null) return
    let n = 3
    setPlateCount(n)
    plateTimerRef.current = setInterval(async () => {
      n -= 1
      if (n > 0) return setPlateCount(n)
      clearInterval(plateTimerRef.current)
      plateTimerRef.current = null
      setPlateCount(0)
      try {
        const track = videoTrack()
        if (cameraLockRef.current?.track) await unlockCamera(cameraLockRef.current.track)
        let lock = null
        const shot = liveVideoRef.current && await captureSteadyPlate(liveVideoRef.current, {
          beforeCapture: async () => { lock = { ...(await lockCamera(track)), track } }
        })
        if (shot) {
          setPlateUrl(await canvasToBlobUrl(shot.plate))
          setNoiseUrl(shot.noise ? await canvasToBlobUrl(shot.noise) : null)
        }
        setCameraLock(lock)
      } catch (err) {
        console.warn('[InlineRecorder] background frame:', err)
      } finally {
        setPlateCount(null)
      }
    }, 1000)
  }
  useEffect(() => () => { if (plateTimerRef.current) clearInterval(plateTimerRef.current) }, [])
  // A restarted camera (retake) gets the same locked values again
  useEffect(() => {
    const lock = cameraLockRef.current
    const track = videoTrack()
    if (phase !== 'previewing' || !lock || !track || lock.track === track) return
    applyCameraLock(track, lock.applied)
    setCameraLock({ ...lock, track })
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // Teleprompter: a script overlay over the camera view (DOM only, never part of
  // the recorded stream). With a script on, every take gets the 3-2-1 countdown
  // and the script starts scrolling when it ends.
  const tpRef = useRef(null)
  const [tpActive, setTpActive] = useState(false)

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
    // The teleprompter uses the countdown to hand the mic to speech recognition
    // or fetch its STT token; recording waits for that (capped) so the audio
    // track is in place when MediaRecorder starts.
    const tpReady = Promise.race([
      Promise.resolve(tpRef.current?.prepare?.()).catch(() => {}),
      new Promise(r => setTimeout(r, 4500))
    ])
    let n = 3
    countdownRef.current = setInterval(() => {
      n -= 1
      if (n > 0) {
        setCountdown(n)
        return
      }
      clearInterval(countdownRef.current)
      countdownRef.current = null
      tpReady.then(() => { if (streamRef.current) start() })
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

    // Green screen: the placed clip is keyed (static needs its background frame)
    if (chromaKey && (greenScreen !== 'static' || plateUrl)) file._chromaKey = chromaKey

    onRecorded([file])
    onClose()
  }, [recordedBlob, onRecorded, onClose, chromaKey, greenScreen, plateUrl]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const tpRecState = phase === 'countdown' ? 'countdown'
    : phase === 'recording' ? 'recording'
    : (phase === 'done' || phase === 'uploading') ? 'done' : 'idle'

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
        style={liveKeyed
          // Keyed: the stage shows the timeline underneath, the PiP a checkerboard
          ? { ...(isStage ? boxStyle : null), background: isStage ? 'transparent' : 'repeating-conic-gradient(#555 0% 25%, #888 0% 50%) 50% / 16px 16px' }
          : (isStage ? boxStyle : undefined)}
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
              style={{ ...stageMediaStyle(true), transform: 'scaleX(-1)', display: phase !== 'done' && phase !== 'uploading' ? 'block' : 'none', opacity: liveKeyed ? 0 : undefined }}
            />
            {liveKeyed && (
              <ChromaKeyCanvas
                getSource={() => liveVideoRef.current}
                keyConfig={keyConfig}
                onFail={() => setKeyFailed(true)}
                style={{
                  position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover',
                  ...stageMediaStyle(true), transform: 'scaleX(-1)', pointerEvents: 'none'
                }}
              />
            )}
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

        {plateCount != null && (
          <div className="pip-countdown pip-plate-countdown">
            {plateCount > 0 && <span>{plateCount}</span>}
            <small>{plateCount > 0 ? 'Step out of the picture' : 'Shooting the background, stay out...'}</small>
          </div>
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

      {(phase === 'previewing' || phase === 'starting') && !error && (
        <div className="pip-greenscreen">
          <div className="pip-greenscreen-modes" role="group" aria-label="Green screen">
            <span className="pip-greenscreen-label">Green screen</span>
            {[[null, 'Off'], ['green', 'Green'], ['blue', 'Blue'], ['static', 'Static']].map(([mode, label]) => (
              <button
                key={label}
                className={greenScreen === mode ? 'active' : ''}
                onClick={() => {
                  if (mode !== 'static') releaseCameraLock()
                  setGreenScreen(mode); setKeyTune(null); setKeyFailed(false)
                }}
                title={mode === 'static' ? 'Static background (experimental): removes whatever matches a shot of the empty background' : undefined}
              >
                {label}
              </button>
            ))}
          </div>
          {chromaKey && (() => {
            const kc = normalizeChromaKey(chromaKey)
            const range = (greenScreen === 'static' ? KEY_RANGES.static : KEY_RANGES.chroma).similarity
            const pct = (v) => Math.round(v * 100)
            return (
              <div className="pip-greenscreen-sliders">
                <label title={greenScreen === 'static' ? 'Tolerance: higher ignores more change in the background (noise, light, focus) but can start to remove parts of you' : 'Higher removes more of the screen colour'}>
                  <span>Threshold</span>
                  <input
                    type="range"
                    min={pct(range[0])}
                    max={pct(range[1])}
                    value={pct(kc.similarity)}
                    onChange={(e) => setKeyTune(t => ({ ...t, similarity: parseInt(e.target.value) / 100 }))}
                  />
                </label>
                <label title={greenScreen === 'static' ? 'Removes the wall colour from the edges' : `Removes the ${greenScreen} tint from the edges`}>
                  <span>Despill</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={pct(kc.spill)}
                    onChange={(e) => setKeyTune(t => ({ ...t, spill: parseInt(e.target.value) / 100 }))}
                  />
                </label>
              </div>
            )
          })()}
          {greenScreen === 'static' && (
            <div className="pip-greenscreen-plate">
              <button onClick={capturePlate} disabled={plateCount != null}>
                {plateUrl ? 'Retake empty background' : 'Shoot empty background'}
              </button>
              <small>
                {plateUrl
                  ? (describeCameraLock(cameraLock?.result) || 'Experimental. Keep the camera and the light exactly as they are.')
                  : 'Experimental. Fix the camera in place, press the button and step out of the picture.'}
              </small>
            </div>
          )}
          {keyFailed && <small>Live keying is not available here. The clip still gets the green screen setting.</small>}
        </div>
      )}

      <div className="pip-controls">
        {phase === 'previewing' && (
          <button
            className={`pip-tp-btn${tpActive ? ' active' : ''}`}
            onClick={() => tpRef.current?.openEditor()}
            title={tpActive ? 'Edit teleprompter text' : 'Add teleprompter text'}
          >
            <ScrollText size={12} />
            <span className="pip-tp-label">Teleprompter</span>
          </button>
        )}
        {phase === 'previewing' && !guide && (
          <>
            <button className="pip-record-btn" onClick={tpActive ? () => startWithCountdown(startRecording) : startRecording} title="Record only">
              <Circle size={14} />
            </button>
            {onSyncRecord && (
              <button className="pip-sync-btn" onClick={tpActive ? () => startWithCountdown(handleSyncRecord) : handleSyncRecord} title="Record + Play video">
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

      <Teleprompter ref={tpRef} recState={tpRecState} streamRef={streamRef} onActiveChange={setTpActive} />
    </div>
  )
}

export default InlineRecorder
