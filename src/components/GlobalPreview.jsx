import { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import { Play, Pause, SkipBack, Minus, Plus, Maximize, Minimize2, Repeat } from 'lucide-react'
import { isHlsUrl, attachHls, destroyHls } from '../utils/hlsHelper'

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const SIZES = ['small', 'medium', 'large', 'xlarge', 'xxlarge', 'xxxlarge', 'huge', 'massive', 'giant', 'max', 'fullscreen']
const UI_UPDATE_INTERVAL = 50 // ~20fps for React state updates during playback

import InlineRecorder from './InlineRecorder'
import usePhoneLayout from '../hooks/usePhoneLayout'
import { REMIX_LAYOUTS, hasLayout, clampLayout, layoutPan, layoutZoom, LAYOUT_ZOOM_MIN, LAYOUT_ZOOM_MAX } from '../utils/remixLayout'

// In stitch mode the preview sits in its own column with its own controls;
// otherwise this renders the preview as-is.
function PreviewColumn({ own, controls, children }) {
  if (!own) return children
  return (
    <div className="preview-own-player">
      {children}
      {controls}
    </div>
  )
}

// The 9:16 output canvas contained in .preview-layer-container (a size container)
const CANVAS_W = 'min(100cqw, 56.25cqh)'
const CANVAS_H = 'min(100cqh, 177.7778cqw)'

// Reaction layouts offered on the phone record stage
const STAGE_LAYOUTS = [
  { mode: 'tileTop', label: 'Tile above' },
  { mode: 'tileBottom', label: 'Tile below' },
  { mode: 'overlay', label: 'Overlay' }
]

const ASPECT_RATIOS = ['auto', '16:9', '9:16', '4:3', '1:1']
const RATIO_LABELS = { 'auto': 'Auto', '16:9': '16:9', '9:16': '9:16', '4:3': '4:3', '1:1': '1:1' }

function GlobalPreview({ tracks, playheadPosition, onSetPlayhead, isVerticalVideo, activeAspectRatio, aspectRatioOverride, onSetAspectRatio, selectedClipId, onUpdateClip, onSelectClip, compact, inlineRecording, onRecordedInline, onCloseInlineRecorder, recorderSize, onSetRecorderSize, recorderGuide, onChangeRemixMode, onChangeStageLayout, controlRef }) {
  const videoRefs = useRef({}) // Map of clip ID to video element
  const hlsRefs = useRef({}) // Map of clip ID to HLS instance
  const animationRef = useRef(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const isPlayingRef = useRef(false)
  const [size, setSize] = useState('xlarge')
  const [compactSize, setCompactSize] = useState('full') // 'full' or 'half'
  const [loop, setLoop] = useState(false)
  const loopRef = useRef(false)
  const previewContainerRef = useRef(null)

  // Refs for playback loop — avoid React re-renders during animation
  const playbackPosRef = useRef(playheadPosition)
  const lastUiUpdateRef = useRef(0)
  const activeTopClipIdRef = useRef(null)

  // Set video source, using HLS.js for .m3u8 URLs
  const setVideoSource = useCallback((videoEl, clipId, url) => {
    if (!videoEl || !url) return
    if (hlsRefs.current[clipId]) {
      destroyHls(hlsRefs.current[clipId])
      hlsRefs.current[clipId] = null
    }
    if (isHlsUrl(url)) {
      const hls = attachHls(videoEl, url)
      if (hls) {
        hlsRefs.current[clipId] = hls
      }
    } else {
      videoEl.src = url
    }
  }, [])

  // A clip's <video> can be REPLACED by a new element (e.g. when it moves into a
  // layout box, or the preview moves into the stitch player column). The new
  // element has no source, but loadedUrlsRef still says "loaded", so nothing
  // would ever load it again and it stays black. Load it here on attach.
  const boundVideoElsRef = useRef({})
  const bindVideoEl = (el, clip) => {
    videoRefs.current[clip.id] = el
    if (!el) return
    el.muted = true // Audio comes from the audio track
    if (boundVideoElsRef.current[clip.id] === el) return // same element, re-render
    boundVideoElsRef.current[clip.id] = el
    if (!loadedUrlsRef.current[clip.id]) return // first load: the effects handle it
    setVideoSource(el, clip.id, clip.url)
    loadedUrlsRef.current[clip.id] = clip.url
    el.addEventListener('loadeddata', () => {
      el.currentTime = latestRef.current.getMediaTime(clip, playbackPosRef.current)
      if (isPlayingRef.current) el.play().catch(() => {})
    }, { once: true })
  }

  // Cleanup all HLS instances on unmount
  useEffect(() => {
    return () => {
      Object.values(hlsRefs.current).forEach(destroyHls)
      hlsRefs.current = {}
    }
  }, [])

  // Get all video/image clips with their timeline positions (respecting track visibility)
  const videoClips = useMemo(() => {
    return (tracks || [])
      .filter(t => t.type === 'video' && t.visible !== false)
      .flatMap(t => t.clips)
      .map(clip => ({
        ...clip,
        timelineStart: clip.timelinePosition || 0,
        timelineEnd: (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
      }))
      .sort((a, b) => a.timelineStart - b.timelineStart)
  }, [tracks])

  // Get all audio clips with their timeline positions (respecting track mute)
  const audioRefs = useRef({})
  const audioClips = useMemo(() => {
    return (tracks || [])
      .filter(t => t.type === 'audio' && t.muted !== true)
      .flatMap(t => t.clips)
      .filter(c => c.audioEnabled !== false)
      .map(clip => ({
        ...clip,
        timelineStart: clip.timelinePosition || 0,
        timelineEnd: (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
      }))
  }, [tracks])

  const currentAudioClips = useMemo(() => {
    return audioClips.filter(clip =>
      playheadPosition >= clip.timelineStart && playheadPosition < clip.timelineEnd
    )
  }, [audioClips, playheadPosition])

  // Calculate total duration based on all timeline positions
  const totalDuration = useMemo(() => {
    const allClips = [...videoClips, ...audioClips]
    if (allClips.length === 0) return 0
    return Math.max(...allClips.map(c => c.timelineEnd))
  }, [videoClips, audioClips])

  // Pre-compute clip to track index mapping
  const clipTrackIndexMap = useMemo(() => {
    const map = new Map()
    ;(tracks || []).forEach((track, trackIndex) => {
      track.clips.forEach(clip => {
        map.set(clip.id, trackIndex)
      })
    })
    return map
  }, [tracks])

  // Find clips at a given position (can be multiple for layering)
  const findClipsAtPosition = useCallback((position) => {
    return videoClips.filter(clip =>
      position >= clip.timelineStart && position < clip.timelineEnd
    ).sort((a, b) => {
      const aIndex = clipTrackIndexMap.get(a.id) ?? Infinity
      const bIndex = clipTrackIndexMap.get(b.id) ?? Infinity
      return bIndex - aIndex
    })
  }, [videoClips, clipTrackIndexMap])

  // Get the topmost clip at current position (for rendering)
  const currentClips = useMemo(() =>
    findClipsAtPosition(playheadPosition),
    [findClipsAtPosition, playheadPosition]
  )

  const topClip = currentClips[0] || null
  const reversedClips = useMemo(() => [...currentClips].reverse(), [currentClips])

  // Clean up resources when clips leave the viewport
  useEffect(() => {
    const renderedIds = new Set(currentClips.filter(c => c.type !== 'image').map(c => c.id))
    for (const id of Object.keys(loadedUrlsRef.current)) {
      if (!renderedIds.has(id)) {
        delete loadedUrlsRef.current[id]
      }
    }
    for (const id of Object.keys(hlsRefs.current)) {
      if (!renderedIds.has(id)) {
        destroyHls(hlsRefs.current[id])
        delete hlsRefs.current[id]
      }
    }
  }, [currentClips])

  // Calculate the media time within a clip
  const getMediaTime = useCallback((clip, position) => {
    const offsetInClip = position - clip.timelineStart
    return clip.startTime + offsetInClip
  }, [])

  // Track which URL is loaded per clip
  const loadedUrlsRef = useRef({})

  // Stable ref to latest values — RAF loop reads these without triggering re-renders
  const latestRef = useRef({})
  latestRef.current = { findClipsAtPosition, getMediaTime, totalDuration, onSetPlayhead, setVideoSource, audioClips }
  loopRef.current = loop

  // Jump while playing: move the clock and every playing element to `pos`.
  // (The load/seek effect below leaves playing clips alone, so without this a
  // scrub during playback moves the timeline but not the picture or sound.)
  const seekWhilePlaying = (pos) => {
    const { findClipsAtPosition: find, getMediaTime: gmt, audioClips: allAudio } = latestRef.current
    playbackPosRef.current = pos
    const visible = find(pos)
    const visibleIds = new Set(visible.map(c => c.id))
    visible.forEach(clip => {
      if (clip.type === 'image' || clip.type === 'text' || clip.type === 'color') return
      const el = videoRefs.current[clip.id]
      if (el && el.readyState >= 1) el.currentTime = gmt(clip, pos)
    })
    Object.entries(videoRefs.current).forEach(([id, el]) => {
      if (el && !visibleIds.has(id) && !el.paused) el.pause()
    })
    allAudio.forEach(clip => {
      const el = audioRefs.current[clip.id]
      if (!el) return
      if (pos >= clip.timelineStart && pos < clip.timelineEnd) {
        if (el.readyState >= 1) el.currentTime = gmt(clip, pos)
      } else if (!el.paused) {
        el.pause()
      }
    })
  }

  // Keep playbackPosRef in sync with external scrubs (timeline, arrow keys).
  // While playing, the loop itself reports the playhead every ~50ms, so only a
  // clear jump away from the clock counts as a seek.
  useEffect(() => {
    if (!isPlayingRef.current) {
      playbackPosRef.current = playheadPosition
    } else if (Math.abs(playheadPosition - playbackPosRef.current) > 0.25) {
      seekWhilePlaying(playheadPosition)
    }
  }, [playheadPosition]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load sources and seek video elements — runs during both playback and scrubbing
  // During playback: loads sources for new clips, skips seeking for the playing top clip
  // When paused: fully seeks all clips
  useEffect(() => {
    currentClips.forEach((clip, index) => {
      if (clip.type === 'image') return
      const videoEl = videoRefs.current[clip.id]
      if (!videoEl) return

      const mediaTime = getMediaTime(clip, playheadPosition)
      const isPlayingClip = isPlayingRef.current

      // Always ensure source is loaded
      if (loadedUrlsRef.current[clip.id] !== clip.url) {
        setVideoSource(videoEl, clip.id, clip.url)
        loadedUrlsRef.current[clip.id] = clip.url

        const onReady = () => {
          videoEl.currentTime = mediaTime
          if (isPlayingClip) videoEl.play().catch(() => {})
          videoEl.removeEventListener('loadeddata', onReady)
        }
        videoEl.addEventListener('loadeddata', onReady)
        return
      }

      // During playback, let all clips play naturally — don't seek clips that are playing
      if (isPlayingClip && !videoEl.paused) return

      // Seek when paused (scrubbing) or when clip needs syncing
      const timeDiff = Math.abs(videoEl.currentTime - mediaTime)
      if (timeDiff > 0.1) {
        videoEl.currentTime = mediaTime
      }
    })
  }, [playheadPosition, currentClips, getMediaTime, setVideoSource])

  // Sync muted/volume state imperatively after every render.
  // Video clips are all muted — audio comes from the audio track clips.
  // Audio clips play at their individual volume levels.
  useEffect(() => {
    // Mute all video elements (audio is handled by audio track)
    currentClips.forEach((clip) => {
      if (clip.type === 'image' || clip.type === 'text') return
      const videoEl = videoRefs.current[clip.id]
      if (videoEl) videoEl.muted = true
    })

    // Set volume on audio elements
    currentAudioClips.forEach((clip) => {
      const audioEl = audioRefs.current[clip.id]
      if (audioEl) {
        audioEl.muted = false
        audioEl.volume = (clip.volume || 100) / 100
      }
    })
  }, [currentClips, currentAudioClips, isPlaying])

  // Handle playback — ref-driven animation loop
  useEffect(() => {
    if (!isPlaying) {
      isPlayingRef.current = false
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
      // Sync final position to React state
      if (playbackPosRef.current !== playheadPosition) {
        onSetPlayhead(playbackPosRef.current)
      }
      // Pause all video and audio elements
      Object.values(videoRefs.current).forEach(el => {
        if (el && !el.paused) el.pause()
      })
      Object.values(audioRefs.current).forEach(el => {
        if (el && !el.paused) el.pause()
      })
      activeTopClipIdRef.current = null
      return
    }

    isPlayingRef.current = true
    let lastTime = performance.now()
    lastUiUpdateRef.current = lastTime

    // Start ALL visible video clips playing (layered playback)
    // play() is already called from handlePlayPause (click context) for autoplay policy.
    const startClips = latestRef.current.findClipsAtPosition(playbackPosRef.current)
    const startTop = startClips[0]
    startClips.forEach(clip => {
      if (clip.type === 'image') return
      const videoEl = videoRefs.current[clip.id]
      if (!videoEl) return
      if (loadedUrlsRef.current[clip.id] !== clip.url) {
        latestRef.current.setVideoSource(videoEl, clip.id, clip.url)
        loadedUrlsRef.current[clip.id] = clip.url
      }
      videoEl.muted = true // Audio comes from audio track
      if (videoEl.paused) {
        const mediaTime = latestRef.current.getMediaTime(clip, playbackPosRef.current)
        const beginPlay = () => {
          if (!isPlayingRef.current) return
          videoEl.currentTime = mediaTime
          videoEl.play().catch(() => {})
        }
        if (videoEl.readyState >= 2) {
          beginPlay()
        } else {
          videoEl.addEventListener('loadeddata', function onReady() {
            videoEl.removeEventListener('loadeddata', onReady)
            beginPlay()
          })
        }
      }
    })
    activeTopClipIdRef.current = startTop?.id || null

    // Start audio clips at current position
    const startAudioClips = latestRef.current.audioClips.filter(clip =>
      playbackPosRef.current >= clip.timelineStart && playbackPosRef.current < clip.timelineEnd
    )
    startAudioClips.forEach(clip => {
      const audioEl = audioRefs.current[clip.id]
      if (audioEl) {
        audioEl.muted = false
        audioEl.volume = (clip.volume || 100) / 100
        const mediaTime = latestRef.current.getMediaTime(clip, playbackPosRef.current)
        audioEl.currentTime = mediaTime
        audioEl.play().catch(() => {})
      }
    })

    const animate = (currentTime) => {
      if (!isPlayingRef.current) return

      const deltaMs = currentTime - lastTime
      lastTime = currentTime

      const { findClipsAtPosition, getMediaTime, totalDuration, onSetPlayhead } = latestRef.current

      // Advance position via ref (no React re-render)
      const newPosition = playbackPosRef.current + (deltaMs / 1000)

      if (newPosition >= totalDuration) {
        if (loopRef.current) {
          playbackPosRef.current = 0
          onSetPlayhead(0)
        } else {
          playbackPosRef.current = totalDuration
          isPlayingRef.current = false
          setIsPlaying(false)
          onSetPlayhead(totalDuration)
          return
        }
      }

      playbackPosRef.current = newPosition

      // Throttled UI update for timeline cursor, time display, etc.
      if (currentTime - lastUiUpdateRef.current >= UI_UPDATE_INTERVAL) {
        lastUiUpdateRef.current = currentTime
        onSetPlayhead(newPosition)
      }

      // Check for clip transitions
      const clipsAtPos = findClipsAtPosition(newPosition)
      const newTopClip = clipsAtPos[0]
      const newTopId = newTopClip?.id || null

      if (newTopId !== activeTopClipIdRef.current) {
        // Top clip changed — pause old top if it's no longer visible at all
        if (activeTopClipIdRef.current) {
          const stillVisible = clipsAtPos.some(c => c.id === activeTopClipIdRef.current)
          if (!stillVisible) {
            const oldEl = videoRefs.current[activeTopClipIdRef.current]
            if (oldEl && !oldEl.paused) oldEl.pause()
          }
        }

        activeTopClipIdRef.current = newTopId
      }

      // Ensure ALL visible video clips are playing (layered playback)
      clipsAtPos.forEach(clip => {
        if (clip.type === 'image') return
        const videoEl = videoRefs.current[clip.id]
        if (!videoEl) return
        videoEl.muted = true // Audio comes from audio track

        const seekAndPlay = () => {
          if (!isPlayingRef.current) return
          videoEl.currentTime = getMediaTime(clip, newPosition)
          videoEl.play().catch(() => {})
        }

        if (loadedUrlsRef.current[clip.id] !== clip.url) {
          latestRef.current.setVideoSource(videoEl, clip.id, clip.url)
          loadedUrlsRef.current[clip.id] = clip.url
          videoEl.addEventListener('loadeddata', function onReady() {
            videoEl.removeEventListener('loadeddata', onReady)
            seekAndPlay()
          })
        } else if (videoEl.paused) {
          if (videoEl.readyState >= 2) {
            seekAndPlay()
          } else {
            videoEl.addEventListener('loadeddata', function onReady() {
              videoEl.removeEventListener('loadeddata', onReady)
              seekAndPlay()
            })
          }
        }
      })

      // Sync audio clips — start/stop as they enter/leave playhead
      const { audioClips: allAudioClips, getMediaTime: gmt } = latestRef.current
      allAudioClips.forEach(clip => {
        const audioEl = audioRefs.current[clip.id]
        if (!audioEl) return
        const inRange = newPosition >= clip.timelineStart && newPosition < clip.timelineEnd
        if (inRange) {
          audioEl.volume = (clip.volume || 100) / 100
          if (audioEl.paused) {
            audioEl.currentTime = gmt(clip, newPosition)
            audioEl.play().catch(() => {})
          }
        } else if (!audioEl.paused) {
          audioEl.pause()
        }
      })

      animationRef.current = requestAnimationFrame(animate)
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
    }
  }, [isPlaying]) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePlayPause = () => {
    if (videoClips.length === 0 && audioClips.length === 0) return
    if (isPlaying) {
      // Stopping: sync position and refs before state update so the
      // source-loading effect (which runs before the playback effect)
      // knows playback has stopped and can safely seek clips.
      isPlayingRef.current = false
      activeTopClipIdRef.current = null
      onSetPlayhead(playbackPosRef.current)
    } else {
      // Start ALL visible video clips from click handler (satisfies browser autoplay policy)
      const clips = latestRef.current.findClipsAtPosition(playbackPosRef.current)
      const top = clips[0]
      clips.forEach(clip => {
        if (clip.type === 'image') return
        const videoEl = videoRefs.current[clip.id]
        if (videoEl) {
          videoEl.muted = true // Audio comes from audio track
          const mediaTime = latestRef.current.getMediaTime(clip, playbackPosRef.current)
          if (Math.abs(videoEl.currentTime - mediaTime) > 0.05) {
            videoEl.currentTime = mediaTime
          }
          videoEl.play().catch(() => {})
        }
      })
      // Start audio clips from click handler (for autoplay policy)
      const audioAtPos = audioClips.filter(c =>
        playbackPosRef.current >= c.timelineStart && playbackPosRef.current < c.timelineEnd
      )
      audioAtPos.forEach(clip => {
        const audioEl = audioRefs.current[clip.id]
        if (audioEl) {
          audioEl.muted = false
          audioEl.volume = (clip.volume || 100) / 100
          const mt = getMediaTime(clip, playbackPosRef.current)
          audioEl.currentTime = mt
          audioEl.play().catch(() => {})
        }
      })

      isPlayingRef.current = true
      activeTopClipIdRef.current = top?.id || null
    }
    setIsPlaying(!isPlaying)
  }

  const handleReset = () => {
    onSetPlayhead(0)
    playbackPosRef.current = 0
    isPlayingRef.current = false
    setIsPlaying(false)
    Object.values(videoRefs.current).forEach(el => { if (el) el.pause() })
    Object.values(audioRefs.current).forEach(el => { if (el) el.pause() })
  }

  // Seek the (paused) preview to a timeline position
  const seekTo = (pos) => {
    const p = Math.max(0, Math.min(pos, totalDuration || pos))
    playbackPosRef.current = p
    onSetPlayhead(p)
  }

  // Start playback at a timeline position (reactions, reviewing a take)
  const playFrom = (pos) => {
    if (isPlayingRef.current) handlePlayPause()
    seekTo(pos)
    // Let the seek render (clips at pos mounted) before starting playback
    requestAnimationFrame(() => requestAnimationFrame(() => controlRef?.current?.togglePlay()))
  }

  // Imperative handle for App (spacebar, guided remix recording)
  if (controlRef) {
    controlRef.current = {
      togglePlay: handlePlayPause,
      pause: () => { if (isPlayingRef.current) handlePlayPause() },
      playFrom,
      seek: (pos) => { if (isPlayingRef.current) playFrom(pos); else seekTo(pos) },
      getPosition: () => playbackPosRef.current
    }
  }

  // Reaction takes are reviewed in step with the original: the recorder's
  // playback drives the preview and follows its scrubber.
  const reviewSync = recorderGuide?.sync ? {
    start: recorderGuide.timelineStart || 0,
    playhead: playheadPosition,
    previewPlaying: isPlaying,
    playFrom: (pos) => controlRef?.current?.playFrom(pos),
    seek: (pos) => controlRef?.current?.seek(pos),
    pause: () => controlRef?.current?.pause(),
    getPosition: () => playbackPosRef.current
  } : null

  const handleSyncRecord = () => {
    if (recorderGuide?.sync) playFrom(recorderGuide.timelineStart || 0)
    else if (!isPlaying) handlePlayPause()
  }
  const handleRecordingStopped = () => {
    if (recorderGuide && isPlayingRef.current) handlePlayPause()
  }

  const scrubberRef = useRef(null)

  const seekFromX = useCallback((clientX) => {
    if (!scrubberRef.current) return
    const rect = scrubberRef.current.getBoundingClientRect()
    const x = clientX - rect.left
    const percent = x / rect.width
    const newPosition = percent * totalDuration
    const clamped = Math.max(0, Math.min(newPosition, totalDuration))
    if (isPlayingRef.current) seekWhilePlaying(clamped)
    else playbackPosRef.current = clamped
    onSetPlayhead(clamped)
  }, [totalDuration, onSetPlayhead])

  const handleSeek = (e) => {
    seekFromX(e.clientX)
  }

  // Touch drag for scrubber
  const [isScrubbing, setIsScrubbing] = useState(false)

  const handleScrubberTouchStart = (e) => {
    e.preventDefault()
    setIsScrubbing(true)
    seekFromX(e.touches[0].clientX)
  }

  useEffect(() => {
    if (!isScrubbing) return
    const handleTouchMove = (e) => {
      e.preventDefault()
      seekFromX(e.touches[0].clientX)
    }
    const handleTouchEnd = () => setIsScrubbing(false)
    document.addEventListener('touchmove', handleTouchMove, { passive: false })
    document.addEventListener('touchend', handleTouchEnd)
    return () => {
      document.removeEventListener('touchmove', handleTouchMove)
      document.removeEventListener('touchend', handleTouchEnd)
    }
  }, [isScrubbing, seekFromX])

  const increaseSize = () => {
    const currentIndex = SIZES.indexOf(size)
    if (currentIndex < SIZES.length - 1) {
      setSize(SIZES[currentIndex + 1])
    }
  }

  const decreaseSize = () => {
    const currentIndex = SIZES.indexOf(size)
    if (currentIndex > 0) {
      setSize(SIZES[currentIndex - 1])
    }
  }

  const canIncrease = SIZES.indexOf(size) < SIZES.length - 1
  const canDecrease = SIZES.indexOf(size) > 0

  const handleFullscreen = useCallback(() => {
    const el = previewContainerRef.current
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      el.requestFullscreen()
    }
  }, [])

  // Build CSS transform for visual properties - memoized
  const getClipStyle = useCallback((clip) => {
    if (!clip) return {}

    const transforms = []
    const zoom = (clip.zoom || 100) / 100
    const posX = clip.positionX || 0
    const posY = clip.positionY || 0

    if (zoom !== 1) {
      transforms.push(`scale(${zoom})`)
    }
    if (posX !== 0 || posY !== 0) {
      transforms.push(`translate(${posX}px, ${posY}px)`)
    }

    const opacity = clip.opacity ?? 100

    const style = {
      transform: transforms.length > 0 ? transforms.join(' ') : undefined,
      opacity: opacity < 100 ? opacity / 100 : undefined,
    }

    const cropX = clip.cropX || 0
    const cropY = clip.cropY || 0
    const cropW = clip.cropWidth || 100
    const cropH = clip.cropHeight || 100

    if (cropX !== 0 || cropY !== 0 || cropW !== 100 || cropH !== 100) {
      const left = cropX
      const top = cropY
      const right = cropX + cropW
      const bottom = cropY + cropH
      style.clipPath = `polygon(${left}% ${top}%, ${right}% ${top}%, ${right}% ${bottom}%, ${left}% ${bottom}%)`
    }

    return style
  }, [])

  // Drag-to-reposition state
  //   plain drag            -> move the clip (layout box, or positionX/Y)
  //   long press, then drag -> pan the media inside its layout box
  const LONG_PRESS_MS = 350
  const MOVE_SLOP_PX = 6
  const isDraggingRef = useRef(false)
  const dragDataRef = useRef(null)
  const longPressTimerRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)
  const [panningClipId, setPanningClipId] = useState(null)

  // Phone record stage: its two boxes ride the same gestures as layout clips,
  // under the ids 'stage:source' / 'stage:recording', and report back to the
  // remix session instead of the timeline. Other clips stay put meanwhile.
  const stageActiveRef = useRef(false)
  const onChangeStageLayoutRef = useRef(onChangeStageLayout)
  onChangeStageLayoutRef.current = onChangeStageLayout
  const applyLayout = (clipId, layout) => {
    if (typeof clipId === 'string' && clipId.startsWith('stage:')) {
      onChangeStageLayoutRef.current?.(clipId.slice(6), layout)
    } else {
      onUpdateClip(clipId, { layout })
    }
  }

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  const handleClipPointerDown = useCallback((e, clip) => {
    const stageBox = typeof clip.id === 'string' && clip.id.startsWith('stage:')
    if (stageActiveRef.current && !stageBox) return
    // Second finger of a pinch: the gesture stays on the first finger's clip
    if (e.touches && e.touches.length >= 2 && dragDataRef.current) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    // Clicking a clip in the preview selects it (and so the timeline follows)
    if (!stageBox && onSelectClip && clip.id !== selectedClipId) {
      onSelectClip(clip.id)
    }
    if (!onUpdateClip) return
    e.preventDefault()
    e.stopPropagation()

    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const clientY = e.touches ? e.touches[0].clientY : e.clientY

    // Layout boxes are relative to the 9:16 canvas contained in the layer container
    const rect = e.currentTarget.closest('.preview-layer-container')?.getBoundingClientRect()
    const canvasW = rect ? Math.min(rect.width, rect.height * 9 / 16) : 1
    const container = { width: canvasW, height: canvasW * 16 / 9 }

    const layout = hasLayout(clip) ? clip.layout : null

    // How far the zoomed, cover-fitted media overflows its box, in preview px (for panning)
    const el = e.currentTarget
    // The camera box holds a live and a playback video; measure the shown one
    const media = el.matches('video, img')
      ? el
      : [...el.querySelectorAll('video, img')].find(m => m.style.display !== 'none') || null
    const box = el.getBoundingClientRect()
    const mediaW = media?.videoWidth || media?.naturalWidth || 0
    const mediaH = media?.videoHeight || media?.naturalHeight || 0
    let overflowX = 0
    let overflowY = 0
    if (mediaW && mediaH && box.width && box.height) {
      const scale = Math.max(box.width / mediaW, box.height / mediaH) * (layout ? layoutZoom(layout) : 1)
      overflowX = mediaW * scale - box.width
      overflowY = mediaH * scale - box.height
    }


    dragDataRef.current = {
      clipId: clip.id,
      mode: 'pending', // pending -> move | pan
      startMouseX: clientX,
      startMouseY: clientY,
      startPosX: clip.positionX || 0,
      startPosY: clip.positionY || 0,
      // Layout clips move in canvas fractions, not preview pixels
      startLayout: layout,
      // Fixed boxes (tiles) only pan and zoom; a plain drag does nothing
      movable: clip.movable !== false,
      // Mirrored live camera: the media moves the other way under the finger
      mirror: !!clip.mirror,
      startPan: layout ? layoutPan(layout) : null,
      overflowX,
      overflowY,
      containerW: container?.width || 1,
      containerH: container?.height || 1
    }
    isDraggingRef.current = true
    setIsDragging(true)

    // Holding still turns the drag into panning inside the box
    clearLongPress()
    if (layout && (overflowX > 1 || overflowY > 1)) {
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null
        const d = dragDataRef.current
        if (!d || d.mode !== 'pending') return
        d.mode = 'pan'
        setPanningClipId(d.clipId)
        try { navigator.vibrate?.(15) } catch { /* not supported */ }
      }, LONG_PRESS_MS)
    }
  }, [onUpdateClip, onSelectClip, selectedClipId])

  useEffect(() => {
    if (!isDragging) return

    const handlePointerMove = (e) => {
      const d = dragDataRef.current
      if (!isDraggingRef.current || !d) return
      // A second finger on a layout clip turns any drag into pinch-to-zoom
      if (d.mode !== 'pinch' && d.startLayout && e.touches && e.touches.length >= 2) {
        clearLongPress()
        const [t1, t2] = [e.touches[0], e.touches[1]]
        d.mode = 'pinch'
        d.startZoom = layoutZoom(d.startLayout)
        d.startDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY) || 1
        setPanningClipId(null)
      }
      if (d.mode === 'pinch') {
        if (!e.touches || e.touches.length < 2) return
        if (e.cancelable) e.preventDefault()
        const [t1, t2] = [e.touches[0], e.touches[1]]
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY)
        const zoom = Math.min(LAYOUT_ZOOM_MAX, Math.max(LAYOUT_ZOOM_MIN, d.startZoom * dist / d.startDist))
        applyLayout(d.clipId, { ...d.startLayout, zoom: Math.round(zoom * 100) / 100 })
        return
      }
      const clientX = e.touches ? e.touches[0].clientX : e.clientX
      const clientY = e.touches ? e.touches[0].clientY : e.clientY
      const deltaX = clientX - d.startMouseX
      const deltaY = clientY - d.startMouseY

      if (d.mode === 'pending') {
        if (Math.abs(deltaX) < MOVE_SLOP_PX && Math.abs(deltaY) < MOVE_SLOP_PX) return
        clearLongPress()
        d.mode = d.movable ? 'move' : 'none'
      }
      if (e.cancelable) e.preventDefault()
      if (d.mode === 'none') return

      if (d.mode === 'pan') {
        // Dragging right reveals more of the left side (object-position goes down)
        const dx = d.mirror ? -deltaX : deltaX
        const panX = d.overflowX > 1 ? Math.min(1, Math.max(0, d.startPan.panX - dx / d.overflowX)) : d.startPan.panX
        const panY = d.overflowY > 1 ? Math.min(1, Math.max(0, d.startPan.panY - deltaY / d.overflowY)) : d.startPan.panY
        applyLayout(d.clipId, { ...d.startLayout, panX, panY })
        return
      }

      if (d.startLayout) {
        applyLayout(d.clipId, clampLayout({
          ...d.startLayout,
          x: d.startLayout.x + deltaX / d.containerW,
          y: d.startLayout.y + deltaY / d.containerH
        }))
        return
      }
      onUpdateClip(d.clipId, {
        positionX: Math.round(d.startPosX + deltaX),
        positionY: Math.round(d.startPosY + deltaY)
      })
    }

    const handlePointerUp = () => {
      clearLongPress()
      isDraggingRef.current = false
      dragDataRef.current = null
      setIsDragging(false)
      setPanningClipId(null)
    }

    document.addEventListener('mousemove', handlePointerMove)
    document.addEventListener('mouseup', handlePointerUp)
    document.addEventListener('touchmove', handlePointerMove, { passive: false })
    document.addEventListener('touchend', handlePointerUp)
    document.addEventListener('touchcancel', handlePointerUp)
    return () => {
      document.removeEventListener('mousemove', handlePointerMove)
      document.removeEventListener('mouseup', handlePointerUp)
      document.removeEventListener('touchmove', handlePointerMove)
      document.removeEventListener('touchend', handlePointerUp)
      document.removeEventListener('touchcancel', handlePointerUp)
    }
  }, [isDragging, onUpdateClip]) // eslint-disable-line react-hooks/exhaustive-deps

  // Stitch: the original gets its own small player (play/pause, time, scrubber)
  // next to the camera, and the shared controls below are hidden meanwhile.
  // Phones: a guided recording takes over the screen, TikTok style. Reactions
  // show the canvas as it will come out (original in its layout box, camera in
  // the recording's box); stitch stacks the original above the camera.
  const phone = usePhoneLayout()
  const stage = !!(phone && inlineRecording && recorderGuide)
  const stageLayout = stage && recorderGuide.mode !== 'stitch'
    ? recorderGuide.layouts || REMIX_LAYOUTS[recorderGuide.mode] || null
    : null
  stageActiveRef.current = stage
  const recSize = stage ? (stageLayout ? 'stage' : 'big') : (recorderSize || 'small')
  const stageRecorderBox = stageLayout ? (() => {
    const b = stageLayout.recording
    return {
      position: 'absolute',
      top: `calc((100cqh - ${CANVAS_H}) / 2 + ${b.y} * ${CANVAS_H})`,
      left: `calc((100cqw - ${CANVAS_W}) / 2 + ${b.x} * ${CANVAS_W})`,
      width: `calc(${b.w} * ${CANVAS_W})`,
      height: `calc(${b.h} * ${CANVAS_H})`
    }
  })() : null

  const ownPlayer = !!(inlineRecording && recSize === 'big' && recorderGuide && !recorderGuide.sync)

  const scrubber = (
    <div className="global-preview-scrubber" ref={scrubberRef} onClick={handleSeek} onTouchStart={handleScrubberTouchStart}>
      <div className="scrubber-track" />
      <div
        className="scrubber-progress"
        style={{ width: `${totalDuration > 0 ? (playheadPosition / totalDuration) * 100 : 0}%` }}
      />
      <div
        className="scrubber-thumb"
        style={{ left: `${totalDuration > 0 ? (playheadPosition / totalDuration) * 100 : 0}%` }}
      />
    </div>
  )

  const ownControls = ownPlayer ? (
    <div className="preview-own-controls">
      <div className="global-preview-controls">
        <button onClick={handlePlayPause} title={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <span className="time-display">
          {formatTime(playheadPosition)} / {formatTime(totalDuration)}
        </span>
      </div>
      {scrubber}
    </div>
  ) : null

  return (
    <div ref={previewContainerRef} className={`global-preview${stage ? ` remix-stage remix-stage-${recorderGuide.mode}` : ''}${compact ? ` compact-global-preview compact-${compactSize}` : ` size-${size}`}${isVerticalVideo ? ' vertical-video' : ''} aspect-${activeAspectRatio?.replace(':', '-') || '16-9'}`}>
      {!compact && (
        <div className="global-preview-header">
          <h3>Timeline Preview</h3>
          <div className="size-controls">
            <button
              onClick={decreaseSize}
              disabled={!canDecrease}
              title="Smaller"
            >
              <Minus size={14} />
            </button>
            <button
              onClick={increaseSize}
              disabled={!canIncrease}
              title="Larger"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      )}

      <div className={`global-preview-video-wrap${inlineRecording && recSize === 'big' ? ' with-big-recorder' : ''}${isVerticalVideo ? ' vertical-layout' : ''}`}>
        <PreviewColumn own={ownPlayer} controls={ownControls}>
        <div className="global-preview-video">
          {videoClips.length > 0 ? (
            <div className="preview-layer-container">
              {currentClips.length > 0 ? (
                reversedClips.map((clip, reverseIndex) => {
                  const layerIndex = currentClips.length - 1 - reverseIndex
                  const isTopClip = layerIndex === 0
                  const zIndex = currentClips.length - reverseIndex

                  const isSelected = clip.id === selectedClipId
                  const canDrag = isSelected && onUpdateClip

                  const stageSource = !!(stageLayout?.source && clip.id === recorderGuide.sourceClipId)
                  const box = stageSource
                    ? stageLayout.source
                    : hasLayout(clip) ? clip.layout : null
                  // On the stage the original's tile pans and zooms but stays in place
                  const gestureClip = stageSource
                    ? { id: 'stage:source', layout: box, movable: false }
                    : clip
                  const layerStyle = {
                    ...(box
                      ? { opacity: (clip.opacity ?? 100) < 100 ? clip.opacity / 100 : undefined }
                      : getClipStyle(clip)),
                    position: 'absolute',
                    top: box ? `calc((100cqh - ${CANVAS_H}) / 2 + ${box.y} * ${CANVAS_H})` : 0,
                    left: box ? `calc((100cqw - ${CANVAS_W}) / 2 + ${box.x} * ${CANVAS_W})` : 0,
                    width: box ? `calc(${box.w} * ${CANVAS_W})` : '100%',
                    height: box ? `calc(${box.h} * ${CANVAS_H})` : '100%',
                    objectFit: box ? 'cover' : 'contain',
                    objectPosition: box ? `${layoutPan(box).panX * 100}% ${layoutPan(box).panY * 100}%` : undefined,
                    WebkitTouchCallout: 'none',
                    userSelect: 'none',
                    zIndex,
                    cursor: panningClipId === gestureClip.id ? 'move' : canDrag ? (isDragging ? 'grabbing' : 'grab') : (onUpdateClip ? 'pointer' : undefined),
                    // Stage: no selection border, only a dashed one while panning
                    outline: (stage ? panningClipId === gestureClip.id : isSelected && onUpdateClip)
                      ? `2px ${panningClipId === gestureClip.id ? 'dashed' : 'solid'} var(--accent-primary)`
                      : undefined,
                    outlineOffset: '-2px'
                  }

                  // Layout clips: the positioned layer is a clipping box, and the media
                  // inside is zoomed (cover fit x zoom) and panned. Same math as the
                  // backend's scale + crop: visible offset = pan * (zoomed cover - box).
                  let boxMediaStyle = null
                  if (box) {
                    const { panX, panY } = layoutPan(box)
                    const z = layoutZoom(box)
                    boxMediaStyle = {
                      position: 'absolute',
                      width: `${z * 100}%`,
                      height: `${z * 100}%`,
                      left: `${-(z - 1) * panX * 100}%`,
                      top: `${-(z - 1) * panY * 100}%`,
                      maxWidth: 'none',
                      objectFit: 'cover',
                      objectPosition: `${panX * 100}% ${panY * 100}%`,
                      transform: 'none',
                      pointerEvents: 'none'
                    }
                    delete layerStyle.objectFit
                    delete layerStyle.objectPosition
                    layerStyle.overflow = 'hidden'
                  }
                  // The zoomed media paints over the box's own outline, so the
                  // selection border is drawn as a layer on top of it
                  const boxOutline = box && layerStyle.outline ? (
                    <span
                      style={{
                        position: 'absolute',
                        inset: 0,
                        border: layerStyle.outline,
                        pointerEvents: 'none',
                        zIndex: 1
                      }}
                    />
                  ) : null

                  if (clip.type === 'text') {
                    const hAlign = clip.textHAlign || 'center'
                    const textStyle = {
                      ...layerStyle,
                      display: 'flex',
                      alignItems: clip.textAlign === 'center' ? 'center' : clip.textAlign === 'bottom' ? 'flex-end' : 'flex-start',
                      justifyContent: hAlign === 'left' ? 'flex-start' : hAlign === 'right' ? 'flex-end' : 'center',
                      fontSize: `${clip.fontSize || 48}px`,
                      fontFamily: `'${clip.fontFamily || 'Roboto'}', sans-serif`,
                      fontWeight: clip.fontWeight || 'normal',
                      color: clip.fontColor || '#ffffff',
                      textAlign: hAlign,
                      padding: '20px',
                      boxSizing: 'border-box',
                      textShadow: '2px 2px 4px rgba(0,0,0,0.8)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word'
                    }
                    const boxEnabled = clip.textBoxEnabled || false
                    const boxStyle = boxEnabled ? {
                      backgroundColor: (() => {
                        const c = clip.textBoxColor || '#000000'
                        const opacity = (clip.textBoxOpacity ?? 80) / 100
                        const r = parseInt(c.slice(1, 3), 16)
                        const g = parseInt(c.slice(3, 5), 16)
                        const b = parseInt(c.slice(5, 7), 16)
                        return `rgba(${r},${g},${b},${opacity})`
                      })(),
                      padding: `${clip.textBoxPadding ?? 12}px`,
                      borderRadius: `${clip.textBoxRadius ?? 8}px`,
                      border: (clip.textBoxBorderWidth ?? 0) > 0
                        ? `${clip.textBoxBorderWidth}px solid ${clip.textBoxBorderColor || '#ffffff'}`
                        : 'none',
                      display: 'inline-block'
                    } : {}
                    return (
                      <div
                        key={clip.id}
                        // Full-canvas layer: only the text itself takes clicks, so
                        // clips underneath stay clickable
                        style={{ ...textStyle, pointerEvents: 'none' }}
                      >
                        <span
                          style={{ ...boxStyle, pointerEvents: 'auto' }}
                          onMouseDown={(e) => handleClipPointerDown(e, clip)}
                          onTouchStart={(e) => handleClipPointerDown(e, clip)}
                        >
                          {clip.text || 'Text'}
                        </span>
                      </div>
                    )
                  } else if (clip.type === 'color') {
                    const bg = clip.gradientEnabled
                      ? `linear-gradient(${clip.gradientAngle || 180}deg, ${clip.backgroundColor || '#000'}, ${clip.gradientEndColor || '#fff'})`
                      : (clip.backgroundColor || '#000000')
                    return (
                      <div
                        key={clip.id}
                        style={{ ...layerStyle, background: bg }}
                        onMouseDown={(e) => handleClipPointerDown(e, clip)}
                        onTouchStart={(e) => handleClipPointerDown(e, clip)}
                      />
                    )
                  } else if (clip.type === 'image' && box) {
                    return (
                      <div
                        key={clip.id}
                        className="preview-layout-box"
                        style={layerStyle}
                        onMouseDown={(e) => handleClipPointerDown(e, clip)}
                        onTouchStart={(e) => handleClipPointerDown(e, clip)}
                        onContextMenu={(e) => e.preventDefault()}
                      >
                        <img src={clip.url} alt={clip.name} crossOrigin="anonymous" style={boxMediaStyle} draggable={false} />
                        {boxOutline}
                      </div>
                    )
                  } else if (clip.type === 'image') {
                    return (
                      <img
                        key={clip.id}
                        src={clip.url}
                        alt={clip.name}
                        crossOrigin="anonymous"
                        style={layerStyle}
                        onMouseDown={(e) => handleClipPointerDown(e, clip)}
                        onTouchStart={(e) => handleClipPointerDown(e, clip)}
                        onContextMenu={(e) => e.preventDefault()}
                        draggable={false}
                      />
                    )
                  } else if (box) {
                    return (
                      <div
                        key={clip.id}
                        className="preview-layout-box"
                        style={layerStyle}
                        onMouseDown={(e) => handleClipPointerDown(e, gestureClip)}
                        onTouchStart={(e) => handleClipPointerDown(e, gestureClip)}
                        onContextMenu={(e) => e.preventDefault()}
                      >
                        <video
                          preload="auto"
                          ref={el => bindVideoEl(el, clip)}
                          crossOrigin="anonymous"
                          playsInline
                          style={boxMediaStyle}
                        />
                        {boxOutline}
                      </div>
                    )
                  } else {
                    return (
                      <video
                        key={clip.id}
                        preload="auto"
                        ref={el => bindVideoEl(el, clip)}
                        crossOrigin="anonymous"
                        style={layerStyle}
                        onMouseDown={(e) => handleClipPointerDown(e, clip)}
                        onTouchStart={(e) => handleClipPointerDown(e, clip)}
                        onContextMenu={(e) => e.preventDefault()}
                      />
                    )
                  }
                })
              ) : (
                <div className="no-clip-at-position">No clip at this position</div>
              )}

              {inlineRecording && recSize === 'stage' && (
                <InlineRecorder
                  onRecorded={onRecordedInline}
                  onClose={onCloseInlineRecorder}
                  onSyncRecord={handleSyncRecord}
                  onRecordingStopped={handleRecordingStopped}
                  guide={recorderGuide}
                  reviewSync={reviewSync}
                  pipSize="stage"
                  boxStyle={stageRecorderBox}
                  boxLayout={stageLayout.recording}
                  onBoxPointerDown={onChangeStageLayout ? (e, { mirror }) => handleClipPointerDown(e, {
                    id: 'stage:recording',
                    layout: stageLayout.recording,
                    movable: recorderGuide.mode === 'overlay',
                    mirror
                  }) : undefined}
                  layoutChoices={onChangeRemixMode ? STAGE_LAYOUTS : null}
                  onChangeLayout={onChangeRemixMode}
                />
              )}
            </div>
          ) : (
            <div className="no-video">No clips on timeline</div>
          )}

          {/* Hidden audio elements for audio track playback */}
          {audioClips.map(clip => (
            <video
              key={`audio-${clip.id}`}
              ref={el => { audioRefs.current[clip.id] = el }}
              preload="auto"
              style={{ display: 'none' }}
              src={clip.url}
            />
          ))}

          {inlineRecording && recSize === 'small' && (
            <InlineRecorder
              onRecorded={onRecordedInline}
              onClose={onCloseInlineRecorder}
              onSyncRecord={handleSyncRecord}
              onRecordingStopped={handleRecordingStopped}
              guide={recorderGuide}
              reviewSync={reviewSync}
              pipSize="small"
              onToggleSize={() => onSetRecorderSize && onSetRecorderSize('big')}
            />
          )}
        </div>
        </PreviewColumn>

        {inlineRecording && recSize === 'big' && (
          <InlineRecorder
            onRecorded={onRecordedInline}
            onClose={onCloseInlineRecorder}
            onSyncRecord={handleSyncRecord}
            onRecordingStopped={handleRecordingStopped}
            guide={recorderGuide}
            reviewSync={reviewSync}
            pipSize="big"
            onToggleSize={stage ? undefined : () => onSetRecorderSize && onSetRecorderSize('small')}
          />
        )}
      </div>

      {!ownPlayer && <div className="global-preview-controls">
        <button onClick={handleReset} title="Reset">
          <SkipBack size={14} />
        </button>
        <button onClick={handlePlayPause} title={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className={loop ? 'loop-active' : ''} onClick={() => setLoop(v => !v)} title={loop ? 'Loop: On' : 'Loop: Off'}>
          <Repeat size={14} />
        </button>
        {onSetAspectRatio && (
          <button
            className={`orientation-toggle ${aspectRatioOverride !== 'auto' ? 'orientation-override' : ''}`}
            onClick={() => {
              const idx = ASPECT_RATIOS.indexOf(aspectRatioOverride)
              const next = ASPECT_RATIOS[(idx + 1) % ASPECT_RATIOS.length]
              onSetAspectRatio(next)
            }}
            title={`Aspect ratio: ${aspectRatioOverride === 'auto' ? `Auto (${activeAspectRatio})` : aspectRatioOverride}`}
          >
            <span style={{ fontSize: '10px', fontWeight: 600, lineHeight: 1 }}>{RATIO_LABELS[aspectRatioOverride === 'auto' ? 'auto' : activeAspectRatio]}</span>
          </button>
        )}
        <span className="time-display">
          {formatTime(playheadPosition)} / {formatTime(totalDuration)}
        </span>
        {compact && (
          <div className="compact-size-controls">
            <button
              className={compactSize === 'half' ? 'active' : ''}
              onClick={() => setCompactSize(compactSize === 'half' ? 'full' : 'half')}
              title={compactSize === 'half' ? 'Full size' : 'Half size'}
            >
              <Minimize2 size={14} />
            </button>
            <button onClick={handleFullscreen} title="Fullscreen">
              <Maximize size={14} />
            </button>
          </div>
        )}
      </div>}

      {!ownPlayer && scrubber}

      {topClip && size !== 'small' && (
        <div className="current-clip-info">
          {topClip.name}
          {topClip.url && (
            <span className="source-indicator" style={{ marginLeft: 8, fontSize: '10px', opacity: 0.6 }}>
              {isHlsUrl(topClip.url) ? '(HLS stream)' : topClip.serverUrl ? '(uploaded)' : topClip.url.startsWith('blob:') ? '(local)' : '(file)'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export default GlobalPreview
