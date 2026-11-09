import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo } from 'react'
import { boxFrom, clipIdsInBox, toggleInSelection, clipIdsInRange } from '../utils/marquee'
import { trackNumbers } from '../utils/trackNumbers'
import { Trash2, Flag, Film, Music, Type, Scissors, ArrowLeftToLine, ArrowRightLeft, Copy, Link, Unlink, Plus, Settings, ChevronDown, FolderPlus, Mic, Video, MoreHorizontal, Magnet, Eye, EyeOff, Volume2, VolumeX, Palette, AudioWaveform, AudioLines, Music2, Sticker, Maximize2, ListChecks } from 'lucide-react'
import { isHlsUrl, attachHls, destroyHls } from '../utils/hlsHelper'
import { getGroupColor } from '../hooks/useTimeline'
import { MAX_TIMELINE_SECONDS } from '../utils/limits'
import { timelineBeats } from '../utils/beatDetect'
import { getPeaks, peaksForRange } from '../utils/peakCache'

function formatTime(seconds) {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(mins).padStart(2, '0')}:${secs}` : `${Math.floor(s / 60)}:${secs}`
}

// Waveform bars per clip: a long podcast clip zoomed in would otherwise be
// tens of thousands of elements; past this the bars just get wider
const MAX_WAVE_BARS = 3000
// Ruler steps (seconds); the first that keeps labels this far apart is used
// Track heights in px (track.height); 60 is the default
export const TRACK_HEIGHT = 60
export const clampTrackHeight = (h) => (Number.isFinite(+h) && +h > 0 ? Math.min(240, Math.max(36, Math.round(+h))) : TRACK_HEIGHT)

const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
const RULER_MIN_GAP_PX = 56
export const rulerInterval = (pxPerSecond) => RULER_STEPS.find(s => s * pxPerSecond >= RULER_MIN_GAP_PX) || 7200
// Zoom range in px per second: the audio editor zooms out to a 3-hour show
export const zoomRange = (audioMode) => (audioMode ? { min: 0.05, max: 200 } : { min: 10, max: 200 })

// Generate a stable pseudo-random sequence based on a seed (fallback)
function seededRandom(seed) {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

function generateFallbackWaveform(clipId, count) {
  const seed = clipId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return Array.from({ length: count }, (_, i) => 30 + seededRandom(seed + i) * 50)
}

// ===== Sprite / thumbnail strip extraction =====
const spriteCache = new Map() // url -> { sprites: [dataURL], interval, duration }
const spritePendingCallbacks = new Map() // url -> [resolve]

const SPRITE_HEIGHT = 52 // matches track height minus padding
const SPRITE_INTERVAL = 2 // one frame every N seconds

function extractSprites(url, duration, startTime, endTime) {
  const cacheKey = url
  if (spriteCache.has(cacheKey)) return Promise.resolve(spriteCache.get(cacheKey))

  // If already extracting for this URL, queue up
  if (spritePendingCallbacks.has(cacheKey)) {
    return new Promise(resolve => {
      spritePendingCallbacks.get(cacheKey).push(resolve)
    })
  }

  spritePendingCallbacks.set(cacheKey, [])

  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.preload = 'auto'

    let hlsInstance = null

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const sprites = []

    // Calculate how many frames we need across the full duration
    const totalDur = duration || (endTime - startTime) || 10
    const frameCount = Math.max(1, Math.ceil(totalDur / SPRITE_INTERVAL))
    let currentFrame = 0

    const finishAndResolve = (result) => {
      spriteCache.set(cacheKey, result)
      resolve(result)
      const pending = spritePendingCallbacks.get(cacheKey) || []
      pending.forEach(cb => cb(result))
      spritePendingCallbacks.delete(cacheKey)
      if (hlsInstance) {
        destroyHls(hlsInstance)
        hlsInstance = null
      }
      video.removeAttribute('src')
      video.load()
    }

    const captureFrame = () => {
      // Size canvas to maintain aspect ratio at SPRITE_HEIGHT
      const aspectRatio = video.videoWidth / (video.videoHeight || 1)
      const w = Math.round(SPRITE_HEIGHT * aspectRatio)
      canvas.width = w
      canvas.height = SPRITE_HEIGHT

      try {
        ctx.drawImage(video, 0, 0, w, SPRITE_HEIGHT)
        sprites.push(canvas.toDataURL('image/jpeg', 0.5))
      } catch {
        // CORS or other error - push placeholder
        sprites.push(null)
      }

      currentFrame++
      if (currentFrame < frameCount) {
        const nextTime = Math.min(currentFrame * SPRITE_INTERVAL, totalDur - 0.1)
        video.currentTime = nextTime
      } else {
        finishAndResolve({ sprites, interval: SPRITE_INTERVAL, duration: totalDur })
      }
    }

    video.onseeked = captureFrame

    video.onerror = () => {
      finishAndResolve({ sprites: [], interval: SPRITE_INTERVAL, duration: totalDur })
    }

    // Use HLS.js for .m3u8 URLs
    if (isHlsUrl(url)) {
      hlsInstance = attachHls(video, url)
      if (hlsInstance) {
        // Wait for HLS to parse manifest and load first segment
        video.onloadeddata = () => {
          video.currentTime = 0
        }
      } else {
        // Safari native HLS or unsupported - video.src already set by attachHls
        video.onloadeddata = () => {
          video.currentTime = 0
        }
      }
    } else {
      video.onloadeddata = () => {
        video.currentTime = 0
      }
      video.src = url
    }
  })
}

const SNAP_THRESHOLD = 10 // pixels

const TimelineClip = memo(function TimelineClip({
  clip,
  isSelected,
  selectedGroupId,
  pixelsPerSecond,
  trackIndex,
  trackId,
  trackType,
  allTracks,
  onSelect,
  onRemove,
  onUpdateClip,
  onDuplicate,
  onTrimStart,
  onTrimEnd,
  onPositionChange,
  onMoveToTrack,
  getSnapPoints,
  onOpenSettings,
  onDragPreviewChange
}) {
  const clipRef = useRef(null)
  const [isDragging, setIsDragging] = useState(null) // 'move', 'trimStart', 'trimEnd'
  const [dragPreview, setDragPreview] = useState(null) // { left, trackId } for visual feedback
  const dragDataRef = useRef({ startX: 0, startY: 0, initialValues: {}, currentTrackId: null })

  const clipDuration = clip.endTime - clip.startTime
  const clipWidth = clipDuration * pixelsPerSecond
  const clipLeft = (clip.timelinePosition || 0) * pixelsPerSecond

  const isAudio = clip.type === 'audio'
  const isImage = clip.type === 'image'
  const isText = clip.type === 'text'
  const isColor = clip.type === 'color'

  // Sprite thumbnails for video clips
  const [spriteData, setSpriteData] = useState(null)
  const isVideo = clip.type === 'video'

  useEffect(() => {
    if (!isVideo || !clip.url) return
    let cancelled = false
    extractSprites(clip.url, clip.duration, clip.startTime, clip.endTime).then(data => {
      if (!cancelled && data && data.sprites.length > 0) setSpriteData(data)
    })
    return () => { cancelled = true }
  }, [isVideo, clip.url, clip.duration, clip.startTime, clip.endTime])

  // Waveform data: try real audio, fall back to generated
  const barCount = useMemo(() => Math.min(MAX_WAVE_BARS, Math.max(3, Math.floor(clipWidth / 6))), [clipWidth])
  // The file's peaks, decoded once and shared by all its clips (utils/peakCache)
  const [peakEnvelope, setPeakEnvelope] = useState(null)

  useEffect(() => {
    if (!isAudio || !clip.url) return
    let cancelled = false
    // the backend measures files this browser cannot decode (once uploaded)
    getPeaks(clip.url, { analysisUrl: clip.serverUrl || null }).then(env => {
      if (cancelled) return
      if (env) setPeakEnvelope(env)
      else setWaveformFailed(true)
    })
    return () => { cancelled = true }
  }, [isAudio, clip.url, clip.serverUrl])

  // This clip's own stretch of the file (trim / zoom only re-read it)
  const realWaveform = useMemo(
    () => peaksForRange(peakEnvelope, clip.startTime, clip.endTime, barCount),
    [peakEnvelope, clip.startTime, clip.endTime, barCount]
  )

  const [waveformFailed, setWaveformFailed] = useState(false)
  const waveformBars = useMemo(() => {
    if (realWaveform) return realWaveform
    if (waveformFailed) return Array.from({ length: barCount }, () => 10)
    return generateFallbackWaveform(clip.id, barCount)
  }, [realWaveform, waveformFailed, clip.id, barCount])

  // Calculate snapped position
  const calculateSnappedPosition = useCallback((rawPosition) => {
    if (!getSnapPoints) return rawPosition

    const snapPoints = getSnapPoints(clip.id, dragDataRef.current.currentTrackId || trackId)
    const clipEndPosition = rawPosition + clipDuration

    let snappedPosition = rawPosition
    let minDistance = SNAP_THRESHOLD / pixelsPerSecond

    // Check snap to start of other clips
    for (const point of snapPoints) {
      // Snap our start to their start/end
      const distToStart = Math.abs(rawPosition - point)
      if (distToStart < minDistance) {
        minDistance = distToStart
        snappedPosition = point
      }

      // Snap our end to their start/end
      const distToEnd = Math.abs(clipEndPosition - point)
      if (distToEnd < minDistance) {
        minDistance = distToEnd
        snappedPosition = point - clipDuration
      }
    }

    // Snap to 0
    if (rawPosition < SNAP_THRESHOLD / pixelsPerSecond) {
      snappedPosition = 0
    }

    return Math.max(0, snappedPosition)
  }, [clip.id, clipDuration, getSnapPoints, pixelsPerSecond, trackId])

  const startDrag = (clientX, clientY, action) => {
    setIsDragging(action)
    dragDataRef.current = {
      startX: clientX,
      startY: clientY,
      initialValues: {
        startTime: clip.startTime,
        endTime: clip.endTime,
        duration: clip.duration,
        timelinePosition: clip.timelinePosition || 0
      },
      currentTrackId: trackId,
      clipElement: clipRef.current
    }
  }

  const handleMouseDown = (e, action) => {
    e.stopPropagation()
    e.preventDefault()
    startDrag(e.clientX, e.clientY, action)
  }

  // Long-press touch handling: long-press starts clip drag, short touch allows scroll
  const longPressRef = useRef(null)

  const handleTouchStart = (e, action) => {
    // Let 2-finger pinch-to-zoom bubble up to the scroll container
    if (e.touches.length >= 2) return
    e.stopPropagation()
    const touch = e.touches[0]
    const startX = touch.clientX
    const startY = touch.clientY

    longPressRef.current = {
      action,
      startX,
      startY,
      fired: false,
      timer: setTimeout(() => {
        longPressRef.current.fired = true
        // Vibration feedback when drag starts
        if (navigator.vibrate) navigator.vibrate(30)
        startDrag(startX, startY, action)
      }, 400)
    }
  }

  const handleTouchMoveClip = useCallback((e) => {
    if (!longPressRef.current) return
    const touch = e.touches[0]

    // If long-press hasn't fired yet, check if finger moved too far (cancel long-press, allow scroll)
    if (!longPressRef.current.fired) {
      const dx = touch.clientX - longPressRef.current.startX
      const dy = touch.clientY - longPressRef.current.startY
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        clearTimeout(longPressRef.current.timer)
        longPressRef.current = null
      }
      return
    }

    // Long-press fired — we're dragging, prevent scroll
    e.preventDefault()
  }, [])

  const handleTouchEndClip = useCallback(() => {
    if (!longPressRef.current) return
    clearTimeout(longPressRef.current.timer)
    longPressRef.current = null
  }, [])

  useEffect(() => {
    if (!isDragging) return

    const handlePointerMove = (e) => {
      const clientX = e.touches ? e.touches[0].clientX : e.clientX
      const clientY = e.touches ? e.touches[0].clientY : e.clientY
      const { startX, startY, initialValues } = dragDataRef.current
      const deltaX = clientX - startX
      const deltaY = clientY - startY
      const deltaTime = deltaX / pixelsPerSecond

      if (isDragging === 'move') {
        const rawPosition = Math.max(0, initialValues.timelinePosition + deltaTime)
        const snappedPosition = calculateSnappedPosition(rawPosition)

        // Check for track change (vertical movement)
        // Tracks have their own heights: the row under the pointer (above the
        // first / below the last compatible row: that one)
        const compatibleTracks = allTracks.filter(t => t.type === trackType)
        const rows = compatibleTracks
          .map(t => ({ id: t.id, box: document.querySelector(`.timeline-track-v2[data-track-id="${t.id}"]`)?.getBoundingClientRect() }))
          .filter(r => r.box)
        let newTrackId = trackId
        if (rows.length && deltaY !== 0) {
          const hit = rows.find(r => clientY >= r.box.top && clientY < r.box.bottom)
          newTrackId = hit ? hit.id : (clientY < rows[0].box.top ? rows[0].id : (clientY >= rows[rows.length - 1].box.bottom ? rows[rows.length - 1].id : trackId))
        }

        dragDataRef.current.currentTrackId = newTrackId

        // Update preview for visual feedback
        const preview = {
          left: snappedPosition * pixelsPerSecond,
          trackId: newTrackId,
          position: snappedPosition,
          width: clipWidth
        }
        setDragPreview(preview)
        if (onDragPreviewChange && newTrackId !== trackId) {
          onDragPreviewChange({ ...preview, clipName: clip.name, clipType: clip.type })
        } else if (onDragPreviewChange) {
          onDragPreviewChange(null)
        }

        // If same track, update position directly
        if (newTrackId === trackId) {
          onPositionChange(snappedPosition)
        }
      } else if (isDragging === 'trimStart') {
        const maxStart = initialValues.endTime - 0.1
        const newStartTime = Math.max(0, Math.min(initialValues.startTime + deltaTime, maxStart))
        const timeDiff = newStartTime - initialValues.startTime
        let newPosition = Math.max(0, initialValues.timelinePosition + timeDiff)

        // Snap the trim-start edge to other clip boundaries
        if (getSnapPoints) {
          const snapPoints = getSnapPoints(clip.id, dragDataRef.current.currentTrackId || trackId)
          const threshold = SNAP_THRESHOLD / pixelsPerSecond
          for (const point of snapPoints) {
            if (Math.abs(newPosition - point) < threshold) {
              const snappedDiff = point - initialValues.timelinePosition
              const snappedStart = initialValues.startTime + snappedDiff
              if (snappedStart >= 0 && snappedStart < maxStart) {
                onTrimStart(snappedStart, point)
                return
              }
            }
          }
        }
        onTrimStart(newStartTime, newPosition)
      } else if (isDragging === 'trimEnd') {
        const minEnd = initialValues.startTime + 0.1
        const maxEnd = (isImage || isText || isColor) ? 600 : initialValues.duration
        const newEndTime = Math.max(minEnd, Math.min(initialValues.endTime + deltaTime, maxEnd))
        const newClipEnd = (initialValues.timelinePosition || 0) + (newEndTime - initialValues.startTime)

        // Snap the trim-end edge to other clip boundaries
        if (getSnapPoints) {
          const snapPoints = getSnapPoints(clip.id, dragDataRef.current.currentTrackId || trackId)
          const threshold = SNAP_THRESHOLD / pixelsPerSecond
          for (const point of snapPoints) {
            if (Math.abs(newClipEnd - point) < threshold) {
              const snappedEnd = initialValues.startTime + (point - (initialValues.timelinePosition || 0))
              if (snappedEnd > minEnd && snappedEnd <= maxEnd) {
                onTrimEnd(snappedEnd)
                return
              }
            }
          }
        }
        onTrimEnd(newEndTime)
      }
    }

    const handlePointerUp = () => {
      if (isDragging === 'move' && dragPreview && dragPreview.trackId !== trackId) {
        onMoveToTrack(dragPreview.trackId, dragPreview.position)
      }
      setIsDragging(null)
      setDragPreview(null)
      if (onDragPreviewChange) onDragPreviewChange(null)
    }

    document.addEventListener('mousemove', handlePointerMove)
    document.addEventListener('mouseup', handlePointerUp)
    document.addEventListener('touchmove', handlePointerMove, { passive: false })
    document.addEventListener('touchend', handlePointerUp)

    return () => {
      document.removeEventListener('mousemove', handlePointerMove)
      document.removeEventListener('mouseup', handlePointerUp)
      document.removeEventListener('touchmove', handlePointerMove)
      document.removeEventListener('touchend', handlePointerUp)
    }
  }, [isDragging, pixelsPerSecond, onPositionChange, onTrimStart, onTrimEnd, calculateSnappedPosition, allTracks, trackType, trackId, onMoveToTrack, dragPreview])

  return (
    <div
      ref={clipRef}
      className={`timeline-clip-v2 ${isAudio ? 'audio' : ''} ${isImage ? 'image' : ''} ${isText ? 'text' : ''} ${isColor ? 'color' : ''} ${isSelected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${clip.groupId ? 'grouped' : ''} ${clip.groupId && selectedGroupId === clip.groupId && !isSelected ? 'group-highlighted' : ''}`}
      style={{
        width: `${Math.max(clipWidth, 20)}px`,
        left: `${clipLeft}px`,
        ...(clip.groupId ? { borderLeftColor: getGroupColor(clip.groupId), borderLeftWidth: '3px', borderLeftStyle: 'solid' } : {})
      }}
      data-clip-id={clip.id}
      onClick={(e) => { e.stopPropagation(); onSelect(e) }}
    >
      {/* Trim handle - start */}
      <div
        className="trim-handle start"
        onMouseDown={(e) => handleMouseDown(e, 'trimStart')}
        onTouchStart={(e) => handleTouchStart(e, 'trimStart')}
        onTouchMove={handleTouchMoveClip}
        onTouchEnd={handleTouchEndClip}
      />

      {/* Clip content - draggable (long-press on touch) */}
      <div
        className="clip-content"
        onMouseDown={(e) => handleMouseDown(e, 'move')}
        onTouchStart={(e) => handleTouchStart(e, 'move')}
        onTouchMove={handleTouchMoveClip}
        onTouchEnd={handleTouchEndClip}
      >
        {isAudio ? (
          <div className="clip-waveform">
            <div className="waveform-visual">
              {waveformBars.map((height, i) => (
                <div key={i} className="wave-bar" style={{ height: `${height}%` }} />
              ))}
            </div>
            <div className="waveform-label">
              <Music size={12} />
              <span className="clip-name">{clip.name}</span>
              <span className="clip-duration">{formatTime(clipDuration)}</span>
            </div>
          </div>
        ) : isText ? (
          <div className="clip-text-preview">
            <Type size={16} />
            <span className="text-preview">{clip.text?.substring(0, 20) || 'Text'}{clip.text?.length > 20 ? '...' : ''}</span>
          </div>
        ) : isColor ? (
          <div className="clip-color-preview" style={{
            background: clip.gradientEnabled
              ? `linear-gradient(${clip.gradientAngle || 180}deg, ${clip.backgroundColor || '#000'}, ${clip.gradientEndColor || '#fff'})`
              : (clip.backgroundColor || '#000'),
            width: '100%', height: '100%', borderRadius: 3
          }}>
            <span className="clip-name" style={{ position: 'absolute', left: 4, top: 2, fontSize: 10, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>{clip.name}</span>
          </div>
        ) : (
          <div className="clip-thumbnail">
            {isImage ? (
              <img src={clip.url} alt={clip.name} />
            ) : spriteData && spriteData.sprites.length > 0 ? (
              <div className="clip-sprite-strip">
                {spriteData.sprites.map((src, i) => {
                  // Calculate which portion of the sprite strip is visible based on trim
                  const spriteTime = i * spriteData.interval
                  const spriteEndTime = (i + 1) * spriteData.interval
                  // Only show sprites that overlap with the trimmed region
                  if (spriteEndTime < clip.startTime || spriteTime > clip.endTime) return null
                  return src ? (
                    <img key={i} src={src} alt="" className="sprite-frame" />
                  ) : (
                    <div key={i} className="sprite-frame sprite-placeholder" />
                  )
                })}
              </div>
            ) : clip.url && !isHlsUrl(clip.url) ? (
              <video src={clip.url} muted />
            ) : (
              <div className="sprite-frame sprite-placeholder" />
            )}
          </div>
        )}
        {!isAudio && (
          <div className="clip-label">
            <span className="clip-name">{clip.reversed && <ArrowRightLeft size={10} style={{ marginRight: 3, opacity: 0.7 }} />}{clip.name}</span>
            <span className="clip-duration">{formatTime(clipDuration)}</span>
          </div>
        )}
        {/* Group indicator */}
        {clip.groupId && (
          <div className="group-indicator" style={{ backgroundColor: getGroupColor(clip.groupId) }}>
            <Link size={8} />
          </div>
        )}
        {/* Layer indicator */}
        {trackIndex !== undefined && (
          <div className="layer-indicator">L{trackIndex + 1}</div>
        )}
      </div>

      {/* Settings button */}
      {onOpenSettings && isSelected && (
        <button
          className="clip-settings-btn"
          onClick={(e) => { e.stopPropagation(); onOpenSettings(clip.id) }}
          title="Clip settings"
        >
          <Settings size={12} />
        </button>
      )}

      {/* Trim handle - end */}
      <div
        className="trim-handle end"
        onMouseDown={(e) => handleMouseDown(e, 'trimEnd')}
        onTouchStart={(e) => handleTouchStart(e, 'trimEnd')}
        onTouchMove={handleTouchMoveClip}
        onTouchEnd={handleTouchEndClip}
      />
    </div>
  )
}, (prevProps, nextProps) => {
  // Custom comparison - only re-render when these props change
  return (
    prevProps.clip === nextProps.clip &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.selectedGroupId === nextProps.selectedGroupId &&
    prevProps.pixelsPerSecond === nextProps.pixelsPerSecond &&
    prevProps.trackIndex === nextProps.trackIndex &&
    prevProps.trackId === nextProps.trackId &&
    prevProps.trackType === nextProps.trackType &&
    prevProps.allTracks === nextProps.allTracks &&
    prevProps.onOpenSettings === nextProps.onOpenSettings
  )
})

function Timeline({
  tracks,
  selectedClipId,
  selectedClipIds = null,
  onSelectClips,
  selectMode = false,
  onSelectModeChange,
  onRemoveClips,
  playheadPosition,
  onSetPlayhead,
  onSelectClip,
  onRemoveClip,
  onUpdateClip,
  onDuplicateClip,
  onSplitClip,
  onSplitAtPlayhead,
  onRemoveGap,
  rippleTrackId = null,
  restoreZoom = null,
  onZoomChange,
  flags = null,
  onAddFlag,
  onMoveFlag,
  onRemoveFlag,
  isPlayheadOnGap,
  onDuplicate,
  onGroupClips,
  onUngroupClips,
  onAddTrack,
  onAddTextClip,
  onAddColorClip,
  onRemoveTrack,
  onLibraryDrop,
  onMoveClipToTrack,
  onAddFilesToTrack,
  onOpenClipSettings,
  onRecordAudio,
  onOpenMusic,
  onOpenSfx,
  onOpenStickers,
  onRecordVideo,
  onReverseClip,
  onUpdateTrack,
  onAutoCut,
  onBeatSync,
  isDesktop,
  audioMode = false,
  onGroupVoices,
  chapters = null,
  onOpenChapters,
  isPlaying = false,
  // A piece of the timeline being picked (the audiograms) while
  // `rangePicking`: { start, end } in seconds, end null while only the start
  // is marked
  range = null,
  rangePicking = false,
  rangeMax = 120,
  onRangeChange
}) {
  const { min: MIN_ZOOM, max: MAX_ZOOM } = zoomRange(audioMode)
  const [zoom, setZoom] = useState(33) // pixels per second
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [showClipActions, setShowClipActions] = useState(false)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [trackAddPopup, setTrackAddPopup] = useState(null) // trackId of open popup, or null
  const [trackAddPopupPos, setTrackAddPopupPos] = useState(null) // { top, left } for fixed positioning
  const [crossTrackGhost, setCrossTrackGhost] = useState(null) // { trackId, left, width, clipName }
  const addMenuRef = useRef(null)
  const clipActionsRef = useRef(null)
  const trackAddPopupRef = useRef(null)
  const timelineContentRef = useRef(null)
  const sidebarRef = useRef(null) // the track labels scroll up and down with the tracks
  const rulerRef = useRef(null)
  const pinchRef = useRef({ active: false, initialDistance: 0, initialZoom: 0 })

  // Refs for per-track file inputs (for "+" add media buttons)
  const trackFileInputRefs = useRef({})

  const pixelsPerSecond = zoom
  // The clips are memoised (TimelineClip): a callback that is new on every
  // render (App passes an inline arrow) would re-render all of them on every
  // playhead tick. One stable function that calls the latest one.
  const openSettingsRef = useRef(onOpenClipSettings)
  openSettingsRef.current = onOpenClipSettings
  const openClipSettings = useCallback((clipId) => openSettingsRef.current?.(clipId), [])

  // Several clips selected (box select, Ctrl/Cmd+A, Shift-click). Clips are
  // memoised without their callbacks, so the click handler reads refs.
  const selectedSet = useMemo(() => new Set(selectedClipIds || []), [selectedClipIds])
  // Several selected: are they all one group already (then Ungroup)?
  const multiClips = useMemo(() => (selectedSet.size > 1 ? (tracks || []).flatMap(t => t.clips).filter(c => selectedSet.has(c.id)) : []), [selectedSet, tracks])
  const multiGroupId = multiClips.length > 1 && multiClips[0].groupId && multiClips.every(c => c.groupId === multiClips[0].groupId) ? multiClips[0].groupId : null
  const selectionRef = useRef({})
  selectionRef.current = { selectedClipId, selectedClipIds: selectedClipIds || [], onSelectClip, onSelectClips, selectMode }
  const currentSelection = () => {
    const { selectedClipId: one, selectedClipIds: many } = selectionRef.current
    return many.length ? many : (one ? [one] : [])
  }
  // Shift-click selects from this clip (the last one clicked or Ctrl-clicked) to the clicked one
  const anchorRef = useRef(null)
  const handleClipSelect = useCallback((clipId, e) => {
    const { onSelectClip: one, onSelectClips: many, selectMode: picking, tracksInOrder } = selectionRef.current
    const current = currentSelection()
    // Shift: everything between the anchor and this clip (the anchor stays put)
    if (many && e?.shiftKey && !picking) {
      const anchor = current.includes(anchorRef.current) ? anchorRef.current : current[current.length - 1]
      const ids = clipIdsInRange(tracksInOrder || [], anchor, clipId)
      if (!anchor) anchorRef.current = clipId
      if (ids.length > 1) many(ids)
      else one(clipId)
      return
    }
    // Select mode (phones: the Select button) or Ctrl/Cmd: each tap adds or removes a clip
    if (many && (picking || e?.metaKey || e?.ctrlKey)) {
      const next = toggleInSelection(current, clipId)
      if (next.includes(clipId)) anchorRef.current = clipId
      many(next)
      return
    }
    anchorRef.current = clipId
    one(clipId)
  }, [])

  // Box select (mouse): press on an empty spot of the tracks and drag over
  // clips; Shift/Ctrl/Cmd adds to what is selected. A plain click on an empty
  // spot clears the selection.
  const [marquee, setMarquee] = useState(null) // { x, y, w, h } in content px
  const handleContentMouseDown = (e) => {
    if (rangePicking) return // picking has the press already (pickCapture)
    if (e.button !== 0 || !onSelectClips) return
    if (e.target.closest('.timeline-clip-v2, .timeline-playhead, .timeline-ruler, .timeline-chapter, button, input, select, a')) return
    const content = timelineContentRef.current
    if (!content) return
    e.preventDefault() // no text selection while dragging
    const toContent = (cx, cy) => {
      const r = content.getBoundingClientRect()
      return { x: cx - r.left + content.scrollLeft, y: cy - r.top + content.scrollTop }
    }
    const origin = { x: e.clientX, y: e.clientY }
    const start = toContent(e.clientX, e.clientY)
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    const base = additive ? currentSelection() : []
    let moved = false
    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 4) return
      moved = true
      const box = boxFrom(start, toContent(ev.clientX, ev.clientY))
      setMarquee(box)
      const r = content.getBoundingClientRect()
      const rects = [...content.querySelectorAll('.timeline-clip-v2[data-clip-id]')].map(el => {
        const c = el.getBoundingClientRect()
        return { id: el.dataset.clipId, x: c.left - r.left + content.scrollLeft, y: c.top - r.top + content.scrollTop, w: c.width, h: c.height }
      })
      onSelectClips([...new Set([...base, ...clipIdsInBox(box, rects)])])
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setMarquee(null)
      if (!moved && !additive) onSelectClips([])
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Find the selected clip and its groupId (for group/ungroup button state)
  const selectedClip = useMemo(() => {
    if (!selectedClipId) return null
    for (const track of (tracks || [])) {
      const clip = track.clips.find(c => c.id === selectedClipId)
      if (clip) return clip
    }
    return null
  }, [selectedClipId, tracks])

  const selectedClipGroupId = selectedClip?.groupId || null

  // Calculate total timeline duration based on all clips
  const calculateTotalDuration = useCallback(() => {
    let maxEnd = 0
    for (const track of (tracks || [])) {
      for (const clip of track.clips) {
        const clipEnd = (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
        maxEnd = Math.max(maxEnd, clipEnd)
      }
    }
    return Math.max(maxEnd + 10, 60) // At least 60 seconds, plus 10s padding
  }, [tracks])

  const totalDuration = calculateTotalDuration()
  const timelineWidth = totalDuration * pixelsPerSecond

  // Calculate max clip end position (for clamping playhead)
  const maxClipEnd = useMemo(() => {
    let maxEnd = 0
    for (const track of (tracks || [])) {
      for (const clip of track.clips) {
        const clipEnd = (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
        maxEnd = Math.max(maxEnd, clipEnd)
      }
    }
    return maxEnd
  }, [tracks])

  // Keep tracks in natural order - first track is at top
  // Video tracks displayed first (top), then audio tracks (bottom)
  const videoTracks = useMemo(() => (tracks || []).filter(t => t.type === 'video'), [tracks])
  const audioTracks = useMemo(() => (tracks || []).filter(t => t.type === 'audio'), [tracks])
  // Track numbers as shown (the clip settings name tracks the same way: "2 · Music")
  const numbers = useMemo(() => trackNumbers(tracks), [tracks])
  // As shown, top to bottom (for Shift-click ranges)
  selectionRef.current.tracksInOrder = [...videoTracks, ...audioTracks]

  // Get snap points for a clip (excluding itself)
  // When snap is enabled, includes clip boundaries from ALL tracks for cross-track snapping
  const getSnapPoints = useCallback((excludeClipId, targetTrackId) => {
    if (!snapEnabled) return []

    const points = [0] // Always snap to 0
    const tracksToCheck = tracks || []

    for (const track of tracksToCheck) {
      for (const clip of track.clips) {
        if (clip.id === excludeClipId) continue
        const clipStart = clip.timelinePosition || 0
        const clipEnd = clipStart + (clip.endTime - clip.startTime)
        points.push(clipStart, clipEnd)
      }
    }
    // Beats of music clips that show them (Beat sync)
    points.push(...timelineBeats(tracksToCheck))
    return points
  }, [tracks, snapEnabled])

  const isExternalFileDrop = (e) => {
    const types = Array.from(e.dataTransfer.types)
    return types.includes('Files') && !types.includes('text/plain')
  }

  const handleContainerDragOver = (e) => {
    if (isExternalFileDrop(e)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'none'
    }
  }

  const handleContainerDrop = (e) => {
    if (isExternalFileDrop(e)) {
      e.preventDefault()
    }
  }

  const handleTrackDrop = (e, trackId) => {
    if (isExternalFileDrop(e)) return

    e.preventDefault()
    const libraryItemId = e.dataTransfer.getData('libraryItemId')
    if (libraryItemId && onLibraryDrop) {
      // Calculate drop position in seconds
      const rect = e.currentTarget.getBoundingClientRect()
      const x = e.clientX - rect.left + (e.currentTarget.scrollLeft || 0)
      const dropTime = x / pixelsPerSecond
      onLibraryDrop(e, trackId, undefined, dropTime)
    }
  }

  const handleTrackDragOver = (e, trackId) => {
    if (isExternalFileDrop(e)) {
      e.dataTransfer.dropEffect = 'none'
      return
    }
    e.preventDefault()
  }

  // Snap playhead to clip boundaries when snapping is enabled
  const PLAYHEAD_SNAP_PX = 8
  const snapPlayheadTime = useCallback((rawTime) => {
    if (!snapEnabled) return rawTime
    const snapPoints = getSnapPoints(null)
    const threshold = PLAYHEAD_SNAP_PX / pixelsPerSecond
    let best = rawTime
    let bestDist = threshold
    for (const point of snapPoints) {
      const dist = Math.abs(rawTime - point)
      if (dist < bestDist) {
        bestDist = dist
        best = point
      }
    }
    return best
  }, [snapEnabled, getSnapPoints, pixelsPerSecond])

  // Playhead handling
  const handleRulerClick = (e) => {
    if (!rulerRef.current) return
    const rect = rulerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const time = x / pixelsPerSecond
    const clamped = Math.max(0, Math.min(time, maxClipEnd))
    onSetPlayhead(snapPlayheadTime(clamped))
  }

  // Dragging the ruler (mouse) scrolls the timeline; a short click still moves
  // the playhead. Past a few pixels it is a drag: the click that the browser
  // fires on release is swallowed, so the playhead stays where it was.
  // (Touch scrolls the ruler natively, like the rest of the timeline.)
  const RULER_DRAG_PX = 4
  const [isDraggingRuler, setIsDraggingRuler] = useState(false)
  // Picking a piece (at most rangeMax long). The timeline still moves: the
  // wheel, the zoom, and dragging the ruler scroll it as always.
  //   a click marks the start (the old end goes), the next click the end;
  //   dragging across the tracks draws a whole piece;
  //   the piece's edges can be dragged.
  // Every press goes here, never to a clip, a flag or the playhead.
  const round1 = (t) => Math.round(t * 10) / 10
  const pickTimeAt = (cx) => {
    const content = timelineContentRef.current
    const r = content.getBoundingClientRect()
    return Math.max(0, Math.min(Math.max(maxClipEnd, 0), (cx - r.left + content.scrollLeft) / pixelsPerSecond))
  }
  const swallowNextClick = () => {
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault() }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
  }
  // the latest piece, also between two quick clicks (before the next render)
  const liveRangeRef = useRef(range)
  useEffect(() => { liveRangeRef.current = range }, [range])
  const setPiece = (r) => { liveRangeRef.current = r; onRangeChange(r) }
  const markAt = (t) => {
    const r = liveRangeRef.current
    if (r && r.end == null) {
      // the end: on either side of the start, at most rangeMax from it
      const anchor = r.start
      const a = t < anchor ? Math.max(t, anchor - rangeMax) : anchor
      const b = t < anchor ? anchor : Math.min(t, anchor + rangeMax)
      setPiece({ start: round1(a), end: round1(b) })
    } else {
      setPiece({ start: round1(t), end: null })
    }
  }
  const startPickPress = (e) => {
    const content = timelineContentRef.current
    if (!content || !onRangeChange) return
    e.preventDefault()
    e.stopPropagation()
    const onRuler = !!e.target.closest('.timeline-ruler')
    const t0 = pickTimeAt(e.clientX)
    const startX = e.clientX
    const startScroll = content.scrollLeft
    let dragging = false
    const onMove = (ev) => {
      const dx = ev.clientX - startX
      if (!dragging && Math.abs(dx) < RULER_DRAG_PX) return
      if (!dragging && onRuler) setIsDraggingRuler(true)
      dragging = true
      if (onRuler) { content.scrollLeft = startScroll - dx; return }
      const t1 = pickTimeAt(ev.clientX)
      const a = t1 >= t0 ? t0 : Math.max(t1, t0 - rangeMax)
      const b = t1 >= t0 ? Math.min(t1, t0 + rangeMax) : t0
      setPiece({ start: round1(a), end: round1(b) })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (dragging && onRuler) setIsDraggingRuler(false)
      if (!dragging) markAt(t0)
      swallowNextClick()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  const startEdgeDrag = (e, edge) => {
    const base = liveRangeRef.current
    if (!base || !onRangeChange) return
    e.preventDefault()
    e.stopPropagation()
    // where on the edge it was grabbed: the edge moves with the pointer, no jump
    const grab = pickTimeAt(e.clientX) - (edge === 'start' ? base.start : base.end)
    const onMove = (ev) => {
      const t = pickTimeAt(ev.clientX) - grab
      if (edge === 'start') {
        const start = base.end == null ? t : Math.max(base.end - rangeMax, Math.min(t, base.end - 1))
        setPiece({ start: round1(start), end: base.end })
      } else {
        setPiece({ start: base.start, end: round1(Math.min(base.start + rangeMax, Math.max(t, base.start + 1))) })
      }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      swallowNextClick()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  const pickCapture = (e) => {
    if (e.button !== 0) { e.stopPropagation(); return }
    const edge = e.target.closest('[data-range-edge]')
    if (edge) startEdgeDrag(e, edge.dataset.rangeEdge)
    else startPickPress(e)
  }
  const blockWhilePicking = (e) => { e.stopPropagation() }

  const handleRulerMouseDown = (e) => {
    if (e.button !== 0) return
    const content = timelineContentRef.current
    if (!content) return
    const startX = e.clientX
    const startScroll = content.scrollLeft
    let dragging = false
    const onMove = (ev) => {
      const dx = ev.clientX - startX
      if (!dragging && Math.abs(dx) < RULER_DRAG_PX) return
      if (!dragging) { dragging = true; setIsDraggingRuler(true) }
      ev.preventDefault()
      content.scrollLeft = startScroll - dx
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (!dragging) return
      setIsDraggingRuler(false)
      // The click after a drag (on the ruler, a chapter mark, anything) is not a click
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const handlePlayheadMouseDown = (e) => {
    e.stopPropagation()
    setIsDraggingPlayhead(true)
  }

  const handlePlayheadTouchStart = (e) => {
    e.stopPropagation()
    e.preventDefault()
    setIsDraggingPlayhead(true)
  }

  useEffect(() => {
    if (!isDraggingPlayhead) return

    const handlePointerMove = (e) => {
      if (!timelineContentRef.current) return
      const clientX = e.touches ? e.touches[0].clientX : e.clientX
      const rect = timelineContentRef.current.getBoundingClientRect()
      const x = clientX - rect.left + timelineContentRef.current.scrollLeft
      const time = Math.max(0, Math.min(x / pixelsPerSecond, maxClipEnd))
      onSetPlayhead(snapPlayheadTime(time))
      if (e.touches) e.preventDefault()
    }

    const handlePointerUp = () => {
      setIsDraggingPlayhead(false)
    }

    document.addEventListener('mousemove', handlePointerMove)
    document.addEventListener('mouseup', handlePointerUp)
    document.addEventListener('touchmove', handlePointerMove, { passive: false })
    document.addEventListener('touchend', handlePointerUp)

    return () => {
      document.removeEventListener('mousemove', handlePointerMove)
      document.removeEventListener('mouseup', handlePointerUp)
      document.removeEventListener('touchmove', handlePointerMove)
      document.removeEventListener('touchend', handlePointerUp)
    }
  }, [isDraggingPlayhead, pixelsPerSecond, onSetPlayhead, maxClipEnd, snapPlayheadTime])

  // Generate ruler marks - memoized to avoid recreating on every render
  const rulerMarks = useMemo(() => {
    const marks = []
    const interval = audioMode ? rulerInterval(zoom) : (zoom >= 80 ? 1 : zoom >= 40 ? 2 : zoom >= 20 ? 5 : 10)
    for (let t = 0; t <= totalDuration; t += interval) {
      marks.push(
        <div
          key={t}
          className="ruler-mark"
          style={{ left: `${t * pixelsPerSecond}px` }}
        >
          <div className="ruler-tick" />
          <span className="ruler-label">{formatTime(t)}</span>
        </div>
      )
    }
    // Beat ticks (Beat sync), skipped when zoomed out too far to tell them apart
    const beats = timelineBeats(tracks)
    const spacing = beats.length > 1 ? ((beats[beats.length - 1] - beats[0]) / (beats.length - 1)) * pixelsPerSecond : 0
    if (spacing >= 4) {
      for (const b of beats) {
        marks.push(<div key={`beat-${b}`} className="ruler-beat" style={{ left: `${b * pixelsPerSecond}px` }} />)
      }
    }
    // Chapter flags (audio editor): click to go there, double click for the list
    for (const ch of chapters || []) {
      marks.push(
        <div
          key={`ch-${ch.id}`}
          className="ruler-chapter"
          style={{ left: `${ch.at * pixelsPerSecond}px` }}
          title={`${ch.title} (${formatTime(ch.at)})`}
          onClick={(e) => { e.stopPropagation(); onSetPlayhead(ch.at) }}
          onDoubleClick={(e) => { e.stopPropagation(); onOpenChapters?.() }}
        >
          <span>{ch.title}</span>
        </div>
      )
    }
    return marks
  }, [zoom, totalDuration, pixelsPerSecond, tracks, audioMode, chapters, onSetPlayhead, onOpenChapters])

  const handleZoomIn = () => setZoom(z => Math.min(MAX_ZOOM, z * 1.5))
  const handleZoomOut = () => setZoom(z => Math.max(MIN_ZOOM, z / 1.5))

  // Audio editor: "Fit" shows the whole show; it also fits by itself when the
  // first recording lands (a 1-hour file at the shorts zoom is 120,000 px wide)
  const fitToView = useCallback(() => {
    const width = (timelineContentRef.current?.clientWidth || 600) - 24
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, width / Math.max(1, maxClipEnd))))
  }, [maxClipEnd, MIN_ZOOM, MAX_ZOOM])
  const hadContentRef = useRef(false)
  // A draft opened: back to the zoom it was saved with (and no Fit below, which
  // would run in the same render because the timeline just got its clips)
  useEffect(() => {
    const z = +restoreZoom?.value
    if (!Number.isFinite(z) || z <= 0) return
    hadContentRef.current = true
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)))
  }, [restoreZoom?.key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!audioMode) return
    if (maxClipEnd > 0 && !hadContentRef.current) fitToView()
    hadContentRef.current = maxClipEnd > 0
  }, [audioMode, maxClipEnd > 0]) // eslint-disable-line react-hooks/exhaustive-deps
  // The zoom goes into the draft (App -> useDrafts)
  const onZoomChangeRef = useRef(onZoomChange)
  onZoomChangeRef.current = onZoomChange
  useEffect(() => { onZoomChangeRef.current?.(zoom) }, [zoom])

  // Ctrl+= zoom in, Ctrl+- zoom out
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        handleZoomIn()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault()
        handleZoomOut()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Pinch-to-zoom handlers for touch devices
  const handleTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      pinchRef.current = {
        active: true,
        initialDistance: Math.hypot(dx, dy),
        initialZoom: zoom
      }
    }
  }, [zoom])

  const handleTouchMove = useCallback((e) => {
    if (!pinchRef.current.active || e.touches.length !== 2) return
    e.preventDefault()
    const dx = e.touches[0].clientX - e.touches[1].clientX
    const dy = e.touches[0].clientY - e.touches[1].clientY
    const distance = Math.hypot(dx, dy)
    const scale = distance / pinchRef.current.initialDistance
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchRef.current.initialZoom * scale))
    setZoom(newZoom)
  }, [MIN_ZOOM, MAX_ZOOM])

  const handleTouchEnd = useCallback(() => {
    pinchRef.current.active = false
  }, [])

  // Close "+" menu on click outside
  useEffect(() => {
    if (!showAddMenu) return
    const handleClickOutside = (e) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target)) {
        setShowAddMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showAddMenu])

  // Close clip actions menu on click outside
  useEffect(() => {
    if (!showClipActions) return
    const handleClickOutside = (e) => {
      if (clipActionsRef.current && !clipActionsRef.current.contains(e.target)) {
        setShowClipActions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showClipActions])

  // Close clip actions when clip is deselected
  useEffect(() => {
    if (!selectedClipId) setShowClipActions(false)
  }, [selectedClipId])

  // Close track add popup on click outside
  useEffect(() => {
    if (!trackAddPopup) return
    const handleClickOutside = (e) => {
      if (trackAddPopupRef.current && !trackAddPopupRef.current.contains(e.target)) {
        setTrackAddPopup(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [trackAddPopup])

  // Handle "+" button click per track — show popup instead of directly opening file input
  const handleTrackAddClick = useCallback((trackId, e) => {
    if (trackAddPopup === trackId) {
      setTrackAddPopup(null)
      setTrackAddPopupPos(null)
    } else {
      const btn = e.currentTarget
      const rect = btn.getBoundingClientRect()
      setTrackAddPopupPos({ top: rect.top, left: rect.right + 6, anchorBottom: rect.bottom })
      setTrackAddPopup(trackId)
    }
  }, [trackAddPopup])

  // The popup opens beside the "+" going down; on a low track (or a short
  // window, e.g. the editor inside 3Speak) that runs off the bottom. Once it
  // is on screen, move it up to end level with the "+" (and in from the right
  // edge) when it does not fit. Runs before paint, so it never shows cut off.
  useLayoutEffect(() => {
    if (!trackAddPopupPos || trackAddPopupPos.fitted) return
    const el = trackAddPopupRef.current?.querySelector('.track-add-popup')
    if (!el) return
    const margin = 8
    const h = el.offsetHeight
    const w = el.offsetWidth
    let { top, left } = trackAddPopupPos
    if (top + h > window.innerHeight - margin) top = trackAddPopupPos.anchorBottom - h
    top = Math.max(margin, Math.min(top, window.innerHeight - h - margin))
    if (left + w > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - w - margin)
    setTrackAddPopupPos(p => (p ? { ...p, top, left, fitted: true } : p))
  }, [trackAddPopupPos])

  // Actually click the hidden file input (called from popup)
  const handleTrackFileInputClick = useCallback((trackId) => {
    const input = trackFileInputRefs.current[trackId]
    if (input) input.click()
  }, [])

  // Files from a track's + menu: audio goes in at the playhead (useTimeline)
  const playheadNowRef = useRef(playheadPosition)
  playheadNowRef.current = playheadPosition
  const handleTrackFileChange = useCallback((e, trackId) => {
    const files = Array.from(e.target.files)
    if (files.length > 0 && onAddFilesToTrack) {
      onAddFilesToTrack(files, trackId, playheadNowRef.current)
    }
    e.target.value = ''
  }, [onAddFilesToTrack])

  // Track heights: each track its own (track.height, saved with the draft); the
  // handle under a track label drags it, a double-click resets it
  const [resizing, setResizing] = useState(null) // { id, h } while a handle is dragged
  const heightOf = (t) => (resizing?.id === t.id ? resizing.h : clampTrackHeight(t.height))
  const startTrackResize = (e, track) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    el.setPointerCapture?.(e.pointerId)
    const startY = e.clientY
    const startH = clampTrackHeight(track.height)
    let h = startH
    const onMove = (ev) => {
      h = clampTrackHeight(startH + (ev.clientY - startY))
      setResizing({ id: track.id, h })
    }
    const onUp = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      setResizing(null)
      if (h !== startH) onUpdateTrack?.(track.id, { height: h })
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }
  const resizeHandle = (track) => (onUpdateTrack ? (
    <div
      className="track-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Height of ${track.name || 'this track'}`}
      title="Drag to make the track taller or shorter (double-click: back to normal)"
      onPointerDown={(e) => startTrackResize(e, track)}
      onDoubleClick={() => onUpdateTrack(track.id, { height: undefined })}
    />
  ) : null)
  // Everything below the ruler, for the lines that run through all tracks
  const contentHeight = 24 + [...videoTracks, ...audioTracks].reduce((sum, t) => sum + heightOf(t), 0) + (audioTracks.length ? 2 : 0)

  // Flags: click jumps there, a drag moves the flag, right-click removes it
  const [flagDrag, setFlagDrag] = useState(null) // { id, at } while a flag is dragged
  const startFlagDrag = (e, flag) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const content = timelineContentRef.current
    if (!content) return
    const startX = e.clientX
    let moved = false
    let at = flag.at
    const onMove = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 4) return
      moved = true
      const rect = content.getBoundingClientRect()
      at = Math.max(0, (ev.clientX - rect.left + content.scrollLeft) / pixelsPerSecond)
      setFlagDrag({ id: flag.id, at })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setFlagDrag(null)
      if (moved) onMoveFlag?.(flag.id, at)
      else onSetPlayhead(flag.at)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const playheadLeft = playheadPosition * pixelsPerSecond

  // While playing, the timeline scrolls along so the playhead stays in the
  // middle (at the very start and end it can't: the scroll stops at the edge).
  // Paused, it only scrolls when the playhead lands out of sight (a draft
  // reopened, arrow keys, zooming in), and then puts it in the middle too.
  // Scrolling away from a resting playhead (ruler drag, wheel) is left alone.
  const followedLeftRef = useRef(null)
  const lastFollowRef = useRef(null) // the scroll the follow set last while playing
  // The view's width, kept by a ResizeObserver: reading clientWidth on every
  // playhead tick forced a layout each time
  const viewWidthRef = useRef(0)
  useEffect(() => {
    const el = timelineContentRef.current
    if (!el) return
    viewWidthRef.current = el.clientWidth
    const ro = new ResizeObserver(() => { viewWidthRef.current = el.clientWidth })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    const el = timelineContentRef.current
    if (!el || isDraggingPlayhead || isDraggingRuler) return
    const view = viewWidthRef.current || el.clientWidth
    if (!view) return
    if (!isPlaying) lastFollowRef.current = null
    const moved = followedLeftRef.current !== playheadLeft
    followedLeftRef.current = playheadLeft
    const centre = Math.max(0, playheadLeft - view / 2)
    if (isPlaying) {
      // what we set last (reading scrollLeft back would force a layout every tick)
      if (lastFollowRef.current == null || Math.abs(lastFollowRef.current - centre) >= 1) {
        el.scrollLeft = centre
        lastFollowRef.current = centre
      }
    } else if (moved && (playheadLeft < el.scrollLeft || playheadLeft > el.scrollLeft + view - 2)) {
      el.scrollLeft = centre
    }
  }, [playheadLeft, isPlaying, isDraggingPlayhead, isDraggingRuler])

  // Mouse wheel over the timeline: scroll it sideways (a sideways trackpad
  // swipe scrolls natively). Shift + wheel: zoom, keeping the moment under the
  // mouse where it is. Ctrl + wheel stays the browser's (pinch zoom).
  const scrollContainerRef = useRef(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const zoomAnchorRef = useRef(null) // { time, x }: put `time` back under `x` after the zoom renders
  useEffect(() => {
    const box = scrollContainerRef.current
    if (!box) return
    const onWheel = (e) => {
      const content = timelineContentRef.current
      if (!content || e.ctrlKey || e.metaKey) return
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? content.clientWidth : 1
      // Shift turns a wheel into deltaX in some browsers: take whichever moved
      const dy = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit
      if (e.shiftKey) {
        if (!dy) return
        e.preventDefault()
        const { min, max } = zoomRange(audioMode)
        const z = zoomRef.current
        const next = Math.min(max, Math.max(min, z * Math.exp(-dy * 0.0015)))
        if (next === z) return
        const x = Math.max(0, e.clientX - content.getBoundingClientRect().left)
        zoomAnchorRef.current = { time: (x + content.scrollLeft) / z, x }
        zoomRef.current = next
        setZoom(next)
        return
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return // sideways swipe: native
      if (!e.deltaY) return
      e.preventDefault()
      // Over the track labels, or with Alt: up and down (taller tracks); else along the time
      if (e.altKey || e.target.closest?.('.timeline-sidebar')) content.scrollTop += e.deltaY * unit
      else content.scrollLeft += e.deltaY * unit
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [audioMode])
  // After a Shift + wheel zoom: the moment that was under the mouse stays there
  // (declared after the follow effect, so this scroll wins in the same render)
  useLayoutEffect(() => {
    const a = zoomAnchorRef.current
    const content = timelineContentRef.current
    if (!a || !content) return
    zoomAnchorRef.current = null
    content.scrollLeft = Math.max(0, a.time * zoom - a.x)
  }, [zoom])

  // Handle moving clip to a different track
  const handleMoveClipToTrack = useCallback((clipId, fromTrackId, toTrackId, newPosition) => {
    if (onMoveClipToTrack) {
      onMoveClipToTrack(clipId, fromTrackId, toTrackId, newPosition)
    }
  }, [onMoveClipToTrack])

  return (
    <div
      className="timeline-v2"
      onDragOver={handleContainerDragOver}
      onDrop={handleContainerDrop}
    >
      {/* Timeline toolbar */}
      <div className="timeline-toolbar">
        <div className="toolbar-left" ref={addMenuRef}>
          <button className="add-menu-btn" onClick={() => setShowAddMenu(v => !v)} title="Add track or clip">
            <Plus size={14} />
            <ChevronDown size={10} />
          </button>
          {showAddMenu && (
            <div className="add-menu-dropdown">
              {!audioMode && (
                <button onClick={() => { onAddTrack && onAddTrack('video'); setShowAddMenu(false) }}>
                  <Film size={14} /> Video Track
                </button>
              )}
              <button onClick={() => { onAddTrack && onAddTrack('audio'); setShowAddMenu(false) }}>
                <Music size={14} /> Audio Track
              </button>
              {onOpenMusic && (
                <button onClick={() => { onOpenMusic(); setShowAddMenu(false) }}>
                  <Music size={14} /> Music Library
                </button>
              )}
              {onOpenSfx && (
                <button onClick={() => { onOpenSfx(); setShowAddMenu(false) }}>
                  <AudioLines size={14} /> Sound Effects
                </button>
              )}
              {onOpenStickers && (
                <button onClick={() => { onOpenStickers(); setShowAddMenu(false) }}>
                  <Sticker size={14} /> Stickers
                </button>
              )}
            </div>
          )}
        </div>
        <div className="toolbar-center">
          {audioMode ? (
            <>
              {/* log scale: 0.05 to 200 px/s is too wide a range for a linear slider */}
              <input
                type="range"
                className="zoom-slider"
                min={Math.log(MIN_ZOOM)}
                max={Math.log(MAX_ZOOM)}
                step={0.01}
                value={Math.log(zoom)}
                onChange={(e) => setZoom(Math.exp(Number(e.target.value)))}
                title={`Zoom: ${zoom < 1 ? zoom.toFixed(2) : Math.round(zoom)}px/s`}
                aria-label="Zoom"
              />
              <button className="action-btn zoom-fit-btn" onClick={fitToView} disabled={maxClipEnd <= 0} title="Show the whole timeline">
                <Maximize2 size={14} /> <span>Fit</span>
              </button>
            </>
          ) : (
            <input
              type="range"
              className="zoom-slider"
              min={10}
              max={200}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              title={`Zoom: ${Math.round(zoom)}px/s`}
            />
          )}
        </div>
        <div className="toolbar-right">
          {/* Phones have no box select: tap Select, then tap each clip */}
          {!isDesktop && onSelectClips && onSelectModeChange && (
            <button
              className={`action-btn select-mode-btn${selectMode ? ' active' : ''}`}
              onClick={() => onSelectModeChange(!selectMode)}
              aria-pressed={selectMode}
              title={selectMode ? 'Done selecting' : 'Select several clips: tap each one'}
            >
              <ListChecks size={14} /> <span>{selectMode ? 'Done' : 'Select'}</span>
            </button>
          )}
          <button
            className="action-btn"
            onClick={() => onRemoveGap && onRemoveGap()}
            disabled={!isPlayheadOnGap}
            title={rippleTrackId
              ? `Close the gap at the playhead on track ${numbers.get(rippleTrackId)} (G). Other tracks stay as they are.`
              : (selectedClipId ? 'No gap at the playhead on the selected clip\'s track' : 'Remove gap at playhead (G)')}
          >
            <ArrowLeftToLine size={14} /> <span>Ripple</span>
          </button>
          {onAddFlag && (
            <button
              className="action-btn"
              onClick={() => onAddFlag(playheadPosition)}
              title="Set a flag at the playhead (B): your own marker, numbered and coloured, never exported"
            >
              <Flag size={14} /> <span>Flag</span>
            </button>
          )}
          {selectedClipId && (
            <>
              <button
                className="action-btn"
                onClick={() => { onSplitAtPlayhead && onSplitAtPlayhead(selectedClipId, playheadPosition) }}
                title="Split clip at playhead (Ctrl+R)"
              >
                <Scissors size={14} /> <span>Split</span>
              </button>
              {onAutoCut && (selectedClip?.type === 'video' || selectedClip?.type === 'audio') && (
                <button
                  className="action-btn"
                  onClick={() => onAutoCut(selectedClipId)}
                  title="Find the pauses and cut there"
                >
                  <AudioWaveform size={14} /> <span>Auto cut</span>
                </button>
              )}
              {onBeatSync && selectedClip?.type === 'audio' && (
                <button
                  className="action-btn"
                  onClick={() => onBeatSync(selectedClipId)}
                  title="Find the beat: snap to it, lay clips on it"
                >
                  <Music2 size={14} /> <span>Beats</span>
                </button>
              )}
              <button
                className="action-btn delete-btn"
                onClick={() => onRemoveClip && onRemoveClip(selectedClipId)}
                title="Delete selected clip (Del)"
              >
                <Trash2 size={14} /> <span>Delete</span>
              </button>
              <button
                className="action-btn"
                onClick={() => onOpenClipSettings && onOpenClipSettings(selectedClipId)}
                title="Clip settings"
              >
                <Settings size={14} /> <span>Options</span>
              </button>
              {selectedClipGroupId && onUngroupClips && (
                <button className="action-btn" onClick={() => onUngroupClips(selectedClipId)} title="Ungroup: its clips move and trim on their own again">
                  <Unlink size={14} /> <span>Ungroup</span>
                </button>
              )}
              <div className="clip-actions-wrap" ref={clipActionsRef}>
                <button
                  className="action-btn"
                  onClick={() => setShowClipActions(v => !v)}
                  title="More clip actions"
                >
                  <MoreHorizontal size={14} />
                </button>
                {showClipActions && (
                  <div className="clip-actions-dropdown">
                    <button onClick={() => { onDuplicate && onDuplicate(selectedClipId); setShowClipActions(false) }}>
                      <Copy size={14} /> Duplicate
                    </button>
                    {onGroupVoices && selectedClip?.type === 'audio' && !selectedClip.templateRole && (
                      <button
                        onClick={() => { onGroupVoices(selectedClipId); setShowClipActions(false) }}
                        title="Group with what plays at the same time on the other voice tracks: they move, trim and get their silences cut together"
                      >
                        <Link size={14} /> Group with other voices
                      </button>
                    )}
                    {selectedClip && (selectedClip.type === 'video' || selectedClip.type === 'audio') && onReverseClip && (
                      <button
                        className={selectedClip.reversed ? 'active' : ''}
                        onClick={() => { onReverseClip(selectedClipId); setShowClipActions(false) }}
                      >
                        <ArrowRightLeft size={14} /> {selectedClip.reversed ? 'Unreverse' : 'Reverse'}
                      </button>
                    )}
                    <button className={snapEnabled ? 'active' : ''} onClick={() => setSnapEnabled(v => !v)}>
                      <Magnet size={14} /> Snap {snapEnabled ? 'On' : 'Off'}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          {/* Several clips selected: group them (or ungroup one group), delete them */}
          {multiClips.length > 1 && (
            <>
              {multiGroupId ? (
                onUngroupClips && (
                  <button className="action-btn" onClick={() => onUngroupClips(multiClips[0].id)} title="Ungroup: these clips move and trim on their own again">
                    <Unlink size={14} /> <span>Ungroup</span>
                  </button>
                )
              ) : (
                onGroupClips && (
                  <button className="action-btn" onClick={() => onGroupClips(multiClips.map(c => c.id))} title="Group: these clips move and trim together">
                    <Link size={14} /> <span>Group {multiClips.length}</span>
                  </button>
                )
              )}
              {onRemoveClips && (
                <button className="action-btn delete-btn" onClick={() => onRemoveClips(multiClips.map(c => c.id))} title="Delete the selected clips (Del)">
                  <Trash2 size={14} /> <span>Delete {multiClips.length}</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {selectMode && (
        <div className="timeline-select-hint" role="status">
          <span>{(() => { const n = currentSelection().length; return n ? `${n} clip${n === 1 ? '' : 's'} selected: tap more, or Done` : 'Tap each clip you want to select' })()}</span>
          {currentSelection().length > 0 && (
            <button className="action-btn" onClick={() => onSelectClips([])}>Clear</button>
          )}
          <button className="action-btn" onClick={() => onSelectModeChange(false)}>Done</button>
        </div>
      )}

      {/* Timeline content wrapper */}
      <div
        className="timeline-scroll-container"
        ref={scrollContainerRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="timeline-sidebar" ref={sidebarRef}>
          {/* Empty space for ruler */}
          <div className="sidebar-ruler-space" />

          {/* Video track labels - first track at top */}
          {videoTracks.map((track, index) => (
            <div key={track.id} className={`track-label${track.visible === false ? ' track-hidden' : ''}`} style={{ height: `${heightOf(track)}px` }}>
              {resizeHandle(track)}
              <div className="track-label-top">
                <span className="track-number" title={track.name}>{numbers.get(track.id)}</span>
                <Film size={16} title={track.name} />
                {onUpdateTrack && (
                  <button
                    className="track-toggle-btn"
                    onClick={() => onUpdateTrack(track.id, { visible: track.visible === false ? true : false })}
                    title={track.visible === false ? 'Show track' : 'Hide track'}
                  >
                    {track.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                )}
              </div>
              <div className="track-label-bottom">
                {onRemoveTrack && videoTracks.length > 1 && (
                  <button className="track-delete-btn" onClick={() => onRemoveTrack(track.id)} title="Remove track">
                    <Trash2 size={16} />
                  </button>
                )}
                {onAddFilesToTrack && (
                  <div className="track-add-wrap" ref={trackAddPopup === track.id ? trackAddPopupRef : undefined}>
                    <button
                      className="track-add-btn"
                      onClick={(e) => handleTrackAddClick(track.id, e)}
                      title="Add video, image or text"
                    >
                      <Plus size={18} />
                    </button>
                    {trackAddPopup === track.id && trackAddPopupPos && (
                      <div className="track-add-popup" style={{ top: trackAddPopupPos.top, left: trackAddPopupPos.left }}>
                        <button onClick={() => { handleTrackFileInputClick(track.id); setTrackAddPopup(null) }}>
                          <FolderPlus size={14} /> Add File
                        </button>
                        <button onClick={() => { onAddTextClip && onAddTextClip(track.id); setTrackAddPopup(null) }}>
                          <Type size={14} /> Add Text
                        </button>
                        <button onClick={() => { onAddColorClip && onAddColorClip(track.id); setTrackAddPopup(null) }}>
                          <Palette size={14} /> Add Color
                        </button>
                        {onRecordVideo && (
                          <button onClick={() => { onRecordVideo(); setTrackAddPopup(null) }}>
                            <Video size={14} /> Record Video
                          </button>
                        )}
                        {onOpenStickers && (
                          <button onClick={() => { onOpenStickers(); setTrackAddPopup(null) }}>
                            <Sticker size={14} /> Stickers
                          </button>
                        )}
                      </div>
                    )}
                    <input
                      ref={el => { trackFileInputRefs.current[track.id] = el }}
                      type="file"
                      multiple
                      accept="video/*,image/*"
                      style={{ display: 'none' }}
                      onChange={(e) => handleTrackFileChange(e, track.id)}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}

          {audioTracks.length > 0 && <div className="sidebar-separator" />}

          {/* Audio track labels */}
          {audioTracks.map((track, index) => (
            <div key={track.id} className={`track-label audio${track.muted ? ' track-muted' : ''}`} title={track.name} aria-label={track.name} style={{ height: `${heightOf(track)}px` }}>
              {resizeHandle(track)}
              <div className="track-label-top">
                <span className="track-number" title={track.name}>{numbers.get(track.id)}</span>
                <Music size={16} title={track.name} />
                {onUpdateTrack && (
                  <button
                    className="track-toggle-btn"
                    onClick={() => onUpdateTrack(track.id, { muted: !track.muted })}
                    title={track.muted ? 'Unmute track' : 'Mute track'}
                  >
                    {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                  </button>
                )}
              </div>
              <div className="track-label-bottom">
                {/* the audio editor keeps its last voice track */}
                {onRemoveTrack && audioTracks.length > 1 && !(audioMode && !track.music && audioTracks.filter(t => !t.music).length <= 1) && (
                  <button className="track-delete-btn" onClick={() => onRemoveTrack(track.id)} title="Remove track">
                    <Trash2 size={16} />
                  </button>
                )}
                {onAddFilesToTrack && (
                  <div className="track-add-wrap" ref={trackAddPopup === track.id ? trackAddPopupRef : undefined}>
                    <button
                      className="track-add-btn"
                      onClick={(e) => handleTrackAddClick(track.id, e)}
                      title="Add audio"
                    >
                      <Plus size={18} />
                    </button>
                    {trackAddPopup === track.id && trackAddPopupPos && (
                      <div className="track-add-popup" style={{ top: trackAddPopupPos.top, left: trackAddPopupPos.left }}>
                        <button onClick={() => { handleTrackFileInputClick(track.id); setTrackAddPopup(null) }}>
                          <Music size={14} /> Add Audio File
                        </button>
                        {onOpenMusic && (
                          <button onClick={() => { onOpenMusic(track.id); setTrackAddPopup(null) }}>
                            <Music size={14} /> Music Library
                          </button>
                        )}
                        {onOpenSfx && (
                          <button onClick={() => { onOpenSfx(track.id); setTrackAddPopup(null) }}>
                            <AudioLines size={14} /> Sound Effects
                          </button>
                        )}
                        {onRecordAudio && (
                          <button onClick={() => { onRecordAudio(track.id); setTrackAddPopup(null) }}>
                            <Mic size={14} /> Record Audio
                          </button>
                        )}
                      </div>
                    )}
                    <input
                      ref={el => { trackFileInputRefs.current[track.id] = el }}
                      type="file"
                      multiple
                      accept={audioMode ? 'audio/*,video/*' : 'audio/*'}
                      style={{ display: 'none' }}
                      onChange={(e) => handleTrackFileChange(e, track.id)}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div
          className="timeline-content"
          ref={timelineContentRef}
          onMouseDown={handleContentMouseDown}
          onMouseDownCapture={rangePicking ? pickCapture : undefined}
          onTouchStartCapture={rangePicking ? blockWhilePicking : undefined}
          onDoubleClickCapture={rangePicking ? blockWhilePicking : undefined}
          onContextMenuCapture={rangePicking ? (e) => { e.preventDefault(); e.stopPropagation() } : undefined}
          onScroll={(e) => { if (sidebarRef.current) sidebarRef.current.scrollTop = e.currentTarget.scrollTop }}
        >
          {marquee && (
            <div className="timeline-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
          )}
          {/* Ruler */}
          <div
            className={`timeline-ruler${isDraggingRuler ? ' dragging' : ''}`}
            ref={rulerRef}
            style={{ width: `${timelineWidth}px` }}
            onClick={handleRulerClick}
            onMouseDown={handleRulerMouseDown}
          >
            {rulerMarks}
            {/* Flag heads live in the ruler, so they stay in view when the tracks scroll */}
            {(flags || []).map(fl => (
              <button
                key={fl.id}
                type="button"
                className="timeline-flag-head"
                data-flag={fl.n}
                style={{ left: `${(flagDrag?.id === fl.id ? flagDrag.at : fl.at) * pixelsPerSecond}px`, '--flag-color': fl.color }}
                aria-label={`Flag ${fl.n} at ${formatTime(fl.at)}`}
                title={`Flag ${fl.n} · ${formatTime(fl.at)}: click to jump there, drag to move, right-click to remove`}
                onMouseDown={(e) => startFlagDrag(e, fl)}
                onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRemoveFlag?.(fl.id) }}
              >
                {fl.n}
              </button>
            ))}
          </div>

          {/* The piece being picked (audiograms) */}
          {range && range.end != null && range.end > range.start && (
            <div
              className={`timeline-range${rangePicking ? ' picking' : ''}`}
              data-testid="timeline-range"
              style={{ left: `${range.start * pixelsPerSecond}px`, width: `${(range.end - range.start) * pixelsPerSecond}px`, height: `${contentHeight}px` }}
            >
              <span className="timeline-range-label">{formatTime(range.start)} – {formatTime(range.end)} · {Math.round(range.end - range.start)}s</span>
              {rangePicking && <span className="timeline-range-edge start" data-range-edge="start" title="Drag to move the start" />}
              {rangePicking && <span className="timeline-range-edge end" data-range-edge="end" title="Drag to move the end" />}
            </div>
          )}
          {/* only the start marked: waiting for the click on the end */}
          {range && range.end == null && (
            <div
              className="timeline-range start-only"
              data-testid="timeline-range-start"
              style={{ left: `${range.start * pixelsPerSecond}px`, width: 0, height: `${contentHeight}px` }}
            >
              <span className="timeline-range-label">{formatTime(range.start)} · click where it ends</span>
              {rangePicking && <span className="timeline-range-edge start" data-range-edge="start" title="Drag to move the start" />}
            </div>
          )}

          {/* Past the render limit: only shown once the timeline runs over it */}
          {maxClipEnd > MAX_TIMELINE_SECONDS + 0.01 && (
            <div
              className="timeline-limit-zone"
              style={{
                left: `${MAX_TIMELINE_SECONDS * pixelsPerSecond}px`,
                width: `${Math.max(0, timelineWidth - MAX_TIMELINE_SECONDS * pixelsPerSecond)}px`,
                height: `${contentHeight}px`
              }}
              title="Past the render limit"
            />
          )}

          {/* Playhead */}
          <div
            className="timeline-playhead"
            style={{ left: `${playheadLeft}px`, height: `${contentHeight}px` }}
            onMouseDown={handlePlayheadMouseDown}
            onTouchStart={handlePlayheadTouchStart}
          >
            <div className="playhead-head" />
            <div className="playhead-line" />
          </div>

          {/* Flags: the creator's own numbered markers */}
          {(flags || []).map(fl => (
            <div
              key={fl.id}
              className="timeline-flag"
              style={{ left: `${(flagDrag?.id === fl.id ? flagDrag.at : fl.at) * pixelsPerSecond}px`, height: `${contentHeight}px`, '--flag-color': fl.color }}
            />
          ))}

          {/* Video tracks - first track at top (highest layer) */}
          {videoTracks.map((track, trackIndex) => (
            <div
              key={track.id}
              className="timeline-track-v2"
              data-track-id={track.id}
              style={{ width: `${timelineWidth}px`, height: `${heightOf(track)}px` }}
              onDragOver={(e) => handleTrackDragOver(e, track.id)}
              onDrop={(e) => handleTrackDrop(e, track.id)}
            >
              {track.clips.map(clip => (
                <TimelineClip
                  key={clip.id}
                  clip={clip}
                  isSelected={clip.id === selectedClipId || selectedSet.has(clip.id)}
                  selectedGroupId={selectedClipGroupId}
                  pixelsPerSecond={pixelsPerSecond}
                  trackIndex={trackIndex}
                  trackId={track.id}
                  trackType={track.type}
                  allTracks={tracks}
                  onSelect={(e) => handleClipSelect(clip.id, e)}
                  onRemove={() => onRemoveClip(clip.id)}
                  onUpdateClip={(updates) => onUpdateClip(clip.id, updates)}
                  onDuplicate={() => onDuplicateClip(clip.id)}
                  onTrimStart={(newStart, newPosition) => onUpdateClip(clip.id, { startTime: newStart, timelinePosition: newPosition })}
                  onTrimEnd={(newEnd) => onUpdateClip(clip.id, { endTime: newEnd })}
                  onPositionChange={(newPosition) => onUpdateClip(clip.id, { timelinePosition: newPosition })}
                  onMoveToTrack={(toTrackId, newPosition) => handleMoveClipToTrack(clip.id, track.id, toTrackId, newPosition)}
                  getSnapPoints={getSnapPoints}
                  onOpenSettings={onOpenClipSettings ? openClipSettings : undefined}
                  onDragPreviewChange={setCrossTrackGhost}
                />
              ))}
              {crossTrackGhost && crossTrackGhost.trackId === track.id && (
                <div className="clip-ghost" style={{ left: `${crossTrackGhost.left}px`, width: `${crossTrackGhost.width}px` }} />
              )}
            </div>
          ))}

          {audioTracks.length > 0 && <div className="track-separator-v2" style={{ width: `${timelineWidth}px` }} />}

          {/* Audio tracks */}
          {audioTracks.map((track, trackIndex) => (
            <div
              key={track.id}
              className="timeline-track-v2 audio"
              data-track-id={track.id}
              style={{ width: `${timelineWidth}px`, height: `${heightOf(track)}px` }}
              onDragOver={(e) => handleTrackDragOver(e, track.id)}
              onDrop={(e) => handleTrackDrop(e, track.id)}
            >
              {track.clips.map(clip => (
                <TimelineClip
                  key={clip.id}
                  clip={clip}
                  isSelected={clip.id === selectedClipId || selectedSet.has(clip.id)}
                  selectedGroupId={selectedClipGroupId}
                  pixelsPerSecond={pixelsPerSecond}
                  trackIndex={trackIndex}
                  trackId={track.id}
                  trackType={track.type}
                  allTracks={tracks}
                  onSelect={(e) => handleClipSelect(clip.id, e)}
                  onRemove={() => onRemoveClip(clip.id)}
                  onUpdateClip={(updates) => onUpdateClip(clip.id, updates)}
                  onDuplicate={() => onDuplicateClip(clip.id)}
                  onTrimStart={(newStart, newPosition) => onUpdateClip(clip.id, { startTime: newStart, timelinePosition: newPosition })}
                  onTrimEnd={(newEnd) => onUpdateClip(clip.id, { endTime: newEnd })}
                  onPositionChange={(newPosition) => onUpdateClip(clip.id, { timelinePosition: newPosition })}
                  onMoveToTrack={(toTrackId, newPosition) => handleMoveClipToTrack(clip.id, track.id, toTrackId, newPosition)}
                  getSnapPoints={getSnapPoints}
                  onOpenSettings={onOpenClipSettings ? openClipSettings : undefined}
                  onDragPreviewChange={setCrossTrackGhost}
                />
              ))}
              {crossTrackGhost && crossTrackGhost.trackId === track.id && (
                <div className="clip-ghost" style={{ left: `${crossTrackGhost.left}px`, width: `${crossTrackGhost.width}px` }} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default Timeline
