import { useRef, useEffect, useLayoutEffect, useState, useMemo, useCallback, Fragment } from 'react'
import { Play, Pause, SkipBack, Minus, Plus, Maximize, Minimize2, Repeat } from 'lucide-react'
import { isHlsUrl, attachHls, destroyHls } from '../utils/hlsHelper'

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const SIZES = ['small', 'medium', 'large', 'xlarge', 'xxlarge', 'xxxlarge', 'huge', 'massive', 'giant', 'max', 'fullscreen']
const UI_UPDATE_INTERVAL = 50 // ~20fps for React state updates during playback
// Clips starting within this many seconds are mounted (hidden) and seeked to
// their first frame ahead of time, so a cut plays without a flash
const PRELOAD_AHEAD = 1.5
// ...and start playing (hidden / silent) this long before their cut, from the
// matching earlier point of the file, so at the cut they are already running
const PREROLL = 0.4

// Start a hidden/silent element early so it reaches the clip's first frame
// exactly at the cut. `target()` is where it should be right now. Play start-up
// takes a few frames, so once it is really playing it is corrected once.
function prerollElement(el, target) {
  if (Math.abs(el.currentTime - target()) > 0.04) el.currentTime = target()
  el.dataset.preroll = '1'
  el.addEventListener('playing', () => {
    if (Math.abs(el.currentTime - target()) > 0.03) el.currentTime = target()
  }, { once: true })
  el.play().catch(() => {})
}

// A freshly loaded <video> first paints the file's frame 0, and only then
// seeks to where the clip starts. Keep it invisible until it sits at its frame.
// Sticker motion pivots, as offsets from the element's centre (motionStyle):
// text boxes in % of the box itself, images in px of the contain-fit image
function textPivot(motion) {
  const p = pivotPoint(motion, 0, 0, 100, 100)
  return { x: p.x, y: p.y, unit: '%' }
}
function imagePivot(motion, nw, nh, frameW, frameH) {
  if (!nw || !nh || !frameW || !frameH) return null
  const k = Math.min(frameW / nw, frameH / nh)
  const p = pivotPoint(motion, 0, 0, nw * k, nh * k)
  return { x: p.x, y: p.y, unit: 'px' }
}

function hideUntilPositioned(el) {
  el.classList.add('preview-video-pending')
  const reveal = () => {
    el.classList.remove('preview-video-pending')
    el.removeEventListener('seeked', reveal)
  }
  el.addEventListener('seeked', reveal)
  setTimeout(reveal, 1500) // never stay hidden if no seek happens
}

import InlineRecorder from './InlineRecorder'
import { clipColorFilter } from './ClipColorFilters'
import { motionStyle, normalizeMotion, pivotPoint } from '../utils/stickerMotion'
import usePhoneLayout from '../hooks/usePhoneLayout'
import { REMIX_LAYOUTS, hasLayout, clampLayout, layoutPan, layoutZoom, LAYOUT_ZOOM_MIN, LAYOUT_ZOOM_MAX } from '../utils/remixLayout'
import { getClipChromaKey } from '../utils/chromaKey'
import ChromaKeyCanvas from './ChromaKeyCanvas'

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

/**
 * A text clip's text (and its box), shrunk to the widest line.
 *
 * A wrapped box takes the whole available width, so a two-line text box stretched
 * almost edge to edge here while the render hugs the text: the backend sizes the
 * box from the measured widest line (see useIframeApi). Measure the lines the
 * browser actually laid out and give the box exactly that width, plus its padding
 * and border, which is how the backend sizes it too.
 */
function FitTextBox({ measureKey, children, ...rest }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const fit = () => {
      // Measure unrotated and at the natural wrap
      const transform = el.style.transform
      el.style.transform = 'none'
      el.style.width = ''
      const range = document.createRange()
      range.selectNodeContents(el)
      // Line boxes come back in screen pixels: undo the layer's zoom above
      const scale = el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1
      let widest = 0
      for (const r of range.getClientRects()) widest = Math.max(widest, r.width / (scale || 1))
      if (widest > 0) {
        const cs = getComputedStyle(el)
        const edges = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
          + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
        // +1px so sub-pixel rounding can never push the last word onto a new line
        el.style.width = `${Math.ceil(widest + edges) + 1}px`
      }
      el.style.transform = transform
    }
    fit()
    const ro = typeof ResizeObserver !== 'undefined' && el.parentElement ? new ResizeObserver(fit) : null
    ro?.observe(el.parentElement)
    let live = true
    document.fonts?.ready.then(() => { if (live) fit() })
    return () => { live = false; ro?.disconnect() }
  }, [measureKey])
  return <span ref={ref} {...rest}>{children}</span>
}

function GlobalPreview({ tracks, playheadPosition, onSetPlayhead, isVerticalVideo, activeAspectRatio, aspectRatioOverride, onSetAspectRatio, selectedClipId, onUpdateClip, onSelectClip, compact, inlineRecording, onRecordedInline, onCloseInlineRecorder, recorderSize, onSetRecorderSize, recorderGuide, onChangeRemixMode, onChangeStageLayout, controlRef, emptyActions }) {
  const videoRefs = useRef({}) // Map of clip ID to video element
  // Sticker motion: the layer container (= the frame) and the moving clips,
  // which the playback loop moves every frame (React renders only ~20/s)
  const layerContainerRef = useRef(null)
  const motionClipsRef = useRef({}) // clip id -> { motion, start, duration, kind, opacity }
  // Natural sizes of image clips (for an off-centre pivot), learned on load
  const imageSizeRef = useRef({})
  const [, setImageSizeTick] = useState(0)
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

  // Green screen: keyed clips draw through a canvas over their (hidden) video.
  // Clips whose keying failed (no WebGL / 2D, cross-origin video) show unkeyed.
  const [keyFailedIds, setKeyFailedIds] = useState(() => new Set())
  const markKeyFailed = useCallback((id) => {
    setKeyFailedIds(prev => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])
  // Timeline position a camera take started at (a keyed take is layered there)
  const recordStartRef = useRef(null)

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
    hideUntilPositioned(el)
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

  // Audio elements exist only around the playhead (playing, or starting within
  // PRELOAD_AHEAD); a long timeline or many Auto cut parts no longer keep one
  // buffered element per clip
  const mountedAudioClips = useMemo(() => audioClips.filter(clip =>
    clip.timelineEnd > playheadPosition - 0.25 && clip.timelineStart <= playheadPosition + PRELOAD_AHEAD
  ), [audioClips, playheadPosition])

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

  // Video clips about to start (see PRELOAD_AHEAD): rendered hidden after the
  // visible layers and parked at their first frame
  const upcomingClips = useMemo(() => {
    const visibleIds = new Set(currentClips.map(c => c.id))
    return videoClips.filter(c => c.type === 'video' && c.url && !visibleIds.has(c.id) &&
      c.timelineStart > playheadPosition && c.timelineStart - playheadPosition <= PRELOAD_AHEAD)
  }, [videoClips, currentClips, playheadPosition])

  // At a cut the clip that just ended stays on screen underneath, paused on its
  // last frame, until the next clip has actually painted a frame. Otherwise the
  // empty background shows for a moment while the new video gets its first
  // frame onto the screen. Worked out during render (not in an effect), so the
  // ending clip's element is never unmounted in between.
  const holdRef = useRef({ prev: [], held: [], incoming: [] })
  const [holdTick, setHoldTick] = useState(0)
  const heldClips = useMemo(() => {
    const h = holdRef.current
    const nowIds = new Set(currentClips.map(c => c.id))
    if (h.prev !== currentClips) {
      const prevIds = new Set(h.prev.map(c => c.id))
      const incoming = currentClips.filter(c => c.type === 'video' && !prevIds.has(c.id))
      const outgoing = h.prev.filter(c => c.type === 'video' && !nowIds.has(c.id))
      // Hold only across a cut into another video (a gap or the end stays empty)
      if (incoming.length && outgoing.length) {
        h.held = [...h.held.filter(c => !outgoing.some(o => o.id === c.id)), ...outgoing]
        h.incoming = incoming
      }
      h.prev = currentClips
    }
    h.held = h.held.filter(c => !nowIds.has(c.id))
    return h.held
  }, [currentClips, holdTick])

  // Release the held clip once every new clip has painted (600 ms at most)
  useEffect(() => {
    const h = holdRef.current
    const incoming = h.incoming
    if (!incoming.length) return
    h.incoming = []
    const heldIds = heldClips.map(c => c.id)
    let released = false
    const release = () => {
      if (released) return
      released = true
      h.held = h.held.filter(c => !heldIds.includes(c.id))
      setHoldTick(t => t + 1)
    }
    setTimeout(release, 600)
    let waiting = incoming.length
    const painted = () => { if (--waiting <= 0) release() }
    incoming.forEach(clip => {
      const el = videoRefs.current[clip.id]
      if (!el) return painted()
      if (el.requestVideoFrameCallback) el.requestVideoFrameCallback(() => painted())
      else el.addEventListener('timeupdate', painted, { once: true })
    })
  }, [heldClips])

  // Clean up resources when clips leave the viewport
  useEffect(() => {
    const renderedIds = new Set([...heldClips, ...currentClips, ...upcomingClips].filter(c => c.type !== 'image').map(c => c.id))
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
  }, [currentClips, upcomingClips, heldClips])

  // Calculate the media time within a clip
  const getMediaTime = useCallback((clip, position) => {
    const offsetInClip = position - clip.timelineStart
    return clip.startTime + offsetInClip
  }, [])

  // Track which URL is loaded per clip
  const loadedUrlsRef = useRef({})

  // Stable ref to latest values — RAF loop reads these without triggering re-renders
  const latestRef = useRef({})
  latestRef.current = { findClipsAtPosition, getMediaTime, totalDuration, onSetPlayhead, setVideoSource, audioClips, videoClips }
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
        hideUntilPositioned(videoEl)
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

  // Park upcoming clips at their first frame, paused and hidden
  useEffect(() => {
    upcomingClips.forEach(clip => {
      const el = videoRefs.current[clip.id]
      if (!el) return
      if (loadedUrlsRef.current[clip.id] !== clip.url) {
        setVideoSource(el, clip.id, clip.url)
        loadedUrlsRef.current[clip.id] = clip.url
        el.addEventListener('loadedmetadata', () => {
          if (el.paused) el.currentTime = Math.max(0, clip.startTime - PREROLL)
        }, { once: true })
      } else if (el.paused && el.readyState >= 1 && Math.abs(el.currentTime - Math.max(0, clip.startTime - PREROLL)) > 0.05) {
        // Parked where the pre-roll starts, so starting it needs no seek
        el.currentTime = Math.max(0, clip.startTime - PREROLL)
      }
    })
  }, [upcomingClips, setVideoSource])

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
        hideUntilPositioned(videoEl)
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

      // Sticker motion: move the moving layers to this exact moment
      const frameH = layerContainerRef.current?.clientHeight || 0
      layerContainerRef.current?.querySelectorAll('[data-motion-id]').forEach(el => {
        const mc = motionClipsRef.current[el.dataset.motionId]
        if (!mc) return
        const frameW = layerContainerRef.current?.clientWidth || 0
        const pv = mc.kind === 'text'
          ? textPivot(mc.motion)
          : imagePivot(mc.motion, el.naturalWidth, el.naturalHeight, frameW, frameH)
        const st = motionStyle(mc.motion, newPosition - mc.start, mc.duration, frameH, pv)
        el.style.transform = `${el.dataset.motionBase || ''} ${st.transform}`.trim()
        el.style.opacity = String(mc.opacity * st.opacity)
      })

      // Pre-roll clips about to start (see PREROLL): hidden video / silent audio
      const { videoClips: allVideoClips, audioClips: preAudioClips } = latestRef.current
      for (const clip of allVideoClips) {
        if (clip.type !== 'video') continue
        const lead = clip.timelineStart - newPosition
        // A clip starting at the very beginning of its file has nothing to pre-roll from
        if (lead <= 0 || lead > PREROLL || clip.startTime - lead < 0) continue
        const el = videoRefs.current[clip.id]
        if (!el || !el.paused || el.readyState < 2 || loadedUrlsRef.current[clip.id] !== clip.url) continue
        el.muted = true
        prerollElement(el, () => clip.startTime - (clip.timelineStart - playbackPosRef.current))
      }
      for (const clip of preAudioClips) {
        const lead = clip.timelineStart - newPosition
        if (lead <= 0 || lead > PREROLL || clip.startTime - lead < 0) continue
        const el = audioRefs.current[clip.id]
        if (!el || !el.paused || el.readyState < 2) continue
        el.volume = 0 // silent until its clip starts (the loop sets its volume then)
        prerollElement(el, () => clip.startTime - (clip.timelineStart - playbackPosRef.current))
      }

      // Check for clip transitions
      const clipsAtPos = findClipsAtPosition(newPosition)
      const newTopClip = clipsAtPos[0]
      const newTopId = newTopClip?.id || null

      if (newTopId !== activeTopClipIdRef.current) {
        // Show the new clip on the very next frame instead of the next
        // throttled UI update (else the old one stands frozen up to 50ms)
        lastUiUpdateRef.current = currentTime
        onSetPlayhead(newPosition)
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

        // Pre-rolled: already playing; correct only a clear drift
        if (videoEl.dataset.preroll && !videoEl.paused) {
          delete videoEl.dataset.preroll
          const target = getMediaTime(clip, newPosition)
          if (Math.abs(videoEl.currentTime - target) > 0.12) videoEl.currentTime = target
          return
        }

        if (loadedUrlsRef.current[clip.id] !== clip.url) {
          hideUntilPositioned(videoEl)
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
    recordStartRef.current = recorderGuide?.sync ? (recorderGuide.timelineStart || 0) : playbackPosRef.current
    if (recorderGuide?.sync) playFrom(recorderGuide.timelineStart || 0)
    else if (!isPlaying) handlePlayPause()
  }
  // Tell App where the take started (record-only takes: the playhead stays put)
  const handleRecordedInline = (files) => {
    const startPosition = recordStartRef.current ?? playbackPosRef.current
    recordStartRef.current = null
    return onRecordedInline?.(files, { startPosition })
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

  // Mouse: press anywhere on the scrubber (its padding included) and drag
  const handleScrubberMouseDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    seekFromX(e.clientX)
    const move = (ev) => seekFromX(ev.clientX)
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
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
    // Last, so an image turns around its own centre (the layer is the full canvas
    // with the image contain-fit in the middle). Text turns its box instead, below.
    if (clip.type === 'image' && clip.rotation) {
      transforms.push(`rotate(${clip.rotation}deg)`)
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
  // Nothing on the timeline: the big recorder gets the whole area, there is no
  // preview to show beside it (same test as App's openRecorder).
  const hasAnyVideo = (tracks || []).some(t => t.type === 'video' && t.clips.length > 0)

  // The rail is inset from the edges; the padding around it still takes the
  // pointer, and seekFromX measures against the rail (clamped), so pressing
  // left of it lands exactly on 0:00 and right of it on the end.
  const scrubber = (
    <div className="global-preview-scrubber" onMouseDown={handleScrubberMouseDown} onTouchStart={handleScrubberTouchStart}>
      <div className="scrubber-rail" ref={scrubberRef}>
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

      <div className={`global-preview-video-wrap${inlineRecording && recSize === 'big' ? ' with-big-recorder' : ''}${inlineRecording && recSize === 'big' && !hasAnyVideo ? ' no-preview' : ''}${isVerticalVideo ? ' vertical-layout' : ''}`}>
        <PreviewColumn own={ownPlayer} controls={ownControls}>
        <div className="global-preview-video">
          {videoClips.length > 0 ? (
            <div className="preview-layer-container" ref={layerContainerRef}>
              {currentClips.length > 0 ? (
                [...heldClips, ...reversedClips, ...upcomingClips].map((clip) => {
                  // One list for held (just ended, underneath), visible and
                  // upcoming (hidden, preloaded) clips: a clip moving between
                  // those roles keeps its already loaded element
                  const reverseIndex = reversedClips.findIndex(c => c.id === clip.id)
                  const held = reverseIndex === -1 && heldClips.some(c => c.id === clip.id)
                  const preloading = reverseIndex === -1 && !held
                  const layerIndex = currentClips.length - 1 - reverseIndex
                  const isTopClip = reverseIndex !== -1 && layerIndex === 0
                  const zIndex = reverseIndex === -1 ? 0 : currentClips.length - reverseIndex

                  const isSelected = clip.id === selectedClipId
                  const canDrag = isSelected && onUpdateClip
                  // Sticker motion (image / text clips) at the playhead; during
                  // playback the loop above updates it every frame
                  const motion = (clip.type === 'image' || clip.type === 'text') ? normalizeMotion(clip.motion) : null
                  const clipLength = clip.endTime - clip.startTime
                  // Opacity the element has without motion (images: the clip's own)
                  const baseOpacity = clip.type === 'image' ? (clip.opacity ?? 100) / 100 : 1
                  if (motion) motionClipsRef.current[clip.id] = { motion, start: clip.timelineStart, duration: clipLength, kind: clip.type, opacity: baseOpacity }
                  const frameH = layerContainerRef.current?.clientHeight || 0
                  const frameW = layerContainerRef.current?.clientWidth || 0
                  const natural = imageSizeRef.current[clip.url]
                  const pivotNow = motion
                    ? (clip.type === 'text' ? textPivot(motion) : imagePivot(motion, natural?.w, natural?.h, frameW, frameH))
                    : null
                  const motionNowStyle = motion ? motionStyle(motion, playheadPosition - clip.timelineStart, clipLength, frameH, pivotNow) : null
                  const motionNow = motionNowStyle ? motionNowStyle.transform : ''
                  // The pivot, marked on the selected moving sticker while paused
                  const showPivot = !!motion && isSelected && !isPlaying

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
                    outlineOffset: '-2px',
                    // Colour adjustments: SVG filter from ClipColorFilters (same maths as the render)
                    ...(clipColorFilter(clip) ? { filter: clipColorFilter(clip) } : {}),
                    ...(preloading ? { visibility: 'hidden', pointerEvents: 'none' } : {}),
                    ...(held ? { pointerEvents: 'none', outline: undefined } : {})
                  }

                  // Layout clips: the positioned layer is a clipping box, and the media
                  // inside is zoomed (cover fit x zoom) and panned. Same math as the
                  // backend's scale + crop: visible offset = pan * (zoomed cover - box).
                  let boxMediaStyle = null
                  // Images move as a whole layer (they sit centred in it)
                  const imageMotionProps = motion && clip.type === 'image' && !box ? (() => {
                    const base = layerStyle.transform || ''
                    layerStyle.transform = `${base} ${motionNow}`.trim()
                    layerStyle.opacity = baseOpacity * motionNowStyle.opacity
                    return { 'data-motion-id': clip.id, 'data-motion-base': base }
                  })() : {}

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
                      // The render (and the line measurement it gets) use 1.2;
                      // inherited "normal" is ~1.5 for some fonts
                      lineHeight: 1.2,
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
                        <FitTextBox
                          measureKey={[clip.text, clip.fontSize, clip.fontFamily, clip.fontWeight, boxEnabled,
                            clip.textBoxPadding, clip.textBoxBorderWidth, clip.textHAlign].join('|')}
                          style={{
                            ...boxStyle,
                            pointerEvents: 'auto',
                            // Text turns (and moves) its own box, around the box's centre
                            ...((clip.rotation || motion) ? { transform: `${clip.rotation ? `rotate(${clip.rotation}deg)` : ''} ${motionNow}`.trim() } : {}),
                            ...(motionNowStyle ? { opacity: motionNowStyle.opacity } : {}),
                            ...(showPivot ? { '--pivot-x': `${50 + motion.pivotX * 50}%`, '--pivot-y': `${50 + motion.pivotY * 50}%` } : {})
                          }}
                          className={showPivot ? 'motion-pivot-box' : undefined}
                          {...(motion ? { 'data-motion-id': clip.id, 'data-motion-base': clip.rotation ? `rotate(${clip.rotation}deg)` : '' } : {})}
                          onMouseDown={(e) => handleClipPointerDown(e, clip)}
                          onTouchStart={(e) => handleClipPointerDown(e, clip)}
                        >
                          {clip.text || 'Text'}
                        </FitTextBox>
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
                    // The pivot of a selected moving image, marked on the frame: the
                      // layer's transform is scale(zoom) translate(position) rotate(rotation)
                      let pivotDot = null
                      if (showPivot && pivotNow) {
                        const z = (clip.zoom || 100) / 100
                        const r = ((clip.rotation || 0) * Math.PI) / 180
                        const ox = pivotNow.x * Math.cos(r) - pivotNow.y * Math.sin(r)
                        const oy = pivotNow.x * Math.sin(r) + pivotNow.y * Math.cos(r)
                        pivotDot = (
                          <span
                            key={`${clip.id}-pivot`}
                            className="motion-pivot-dot"
                            style={{ left: `calc(50% + ${z * ((clip.positionX || 0) + ox)}px)`, top: `calc(50% + ${z * ((clip.positionY || 0) + oy)}px)` }}
                          />
                        )
                      }
                    return (
                      <Fragment key={clip.id}>
                      <img
                        key={clip.id}
                        src={clip.url}
                        alt={clip.name}
                        crossOrigin="anonymous"
                        style={layerStyle}
                        {...imageMotionProps}
                        onLoad={(e) => {
                          const img = e.currentTarget
                          if (!imageSizeRef.current[clip.url]) {
                            imageSizeRef.current[clip.url] = { w: img.naturalWidth, h: img.naturalHeight }
                            if (motion && (motion.pivotX || motion.pivotY)) setImageSizeTick(n => n + 1)
                          }
                        }}
                        onMouseDown={(e) => handleClipPointerDown(e, clip)}
                        onTouchStart={(e) => handleClipPointerDown(e, clip)}
                        onContextMenu={(e) => e.preventDefault()}
                        draggable={false}
                      />
                      {pivotDot}
                      </Fragment>
                    )
                  }

                  // Green screen: the video keeps playing invisibly underneath a
                  // canvas that draws its keyed picture with the very same CSS
                  const chromaKey = keyFailedIds.has(clip.id) ? null : getClipChromaKey(clip)
                  const keyCanvas = (style) => chromaKey ? (
                    <ChromaKeyCanvas
                      getSource={() => videoRefs.current[clip.id]}
                      keyConfig={chromaKey}
                      style={style}
                      onFail={() => markKeyFailed(clip.id)}
                    />
                  ) : null

                  if (box) {
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
                          style={chromaKey ? { ...boxMediaStyle, opacity: 0 } : boxMediaStyle}
                        />
                        {keyCanvas(boxMediaStyle)}
                        {boxOutline}
                      </div>
                    )
                  } else if (chromaKey) {
                    return (
                      <Fragment key={clip.id}>
                        <video
                          preload="auto"
                          ref={el => bindVideoEl(el, clip)}
                          crossOrigin="anonymous"
                          playsInline
                          style={{ ...layerStyle, opacity: 0, outline: undefined }}
                          onMouseDown={(e) => handleClipPointerDown(e, clip)}
                          onTouchStart={(e) => handleClipPointerDown(e, clip)}
                          onContextMenu={(e) => e.preventDefault()}
                        />
                        {keyCanvas({ ...layerStyle, pointerEvents: 'none' })}
                      </Fragment>
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
                  onRecorded={handleRecordedInline}
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
            (emptyActions && !(tracks || []).some(t => t.clips.length))
              ? emptyActions
              : <div className="no-video">No clips on timeline</div>
          )}

          {/* Audio track playback: <audio> (a video file's picture is never
              decoded for it), mounted only for clips playing now or about to */}
          {mountedAudioClips.map(clip => (
            <audio
              key={`audio-${clip.id}`}
              ref={el => { audioRefs.current[clip.id] = el }}
              preload="auto"
              src={clip.url}
            />
          ))}

          {inlineRecording && recSize === 'small' && (
            <InlineRecorder
              onRecorded={handleRecordedInline}
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
            onRecorded={handleRecordedInline}
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
