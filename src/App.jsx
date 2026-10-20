import { useCallback, useEffect, useRef, useMemo, useState } from 'react'
import { Undo2, Redo2, ChevronDown, ChevronRight, FolderPlus, Video, X, Download, Upload, Send, Clapperboard, Info, Film, Image as ImageIcon, Music } from 'lucide-react'
import { useFFmpeg } from './hooks/useFFmpeg'
import { useCanvasExport } from './hooks/useCanvasExport'
import { useTimeline } from './hooks/useTimeline'
import { useIframeApi } from './hooks/useIframeApi'
import { isHlsUrl } from './utils/hlsHelper'
import { reverseClipOnBackend } from './utils/reverseClip'
import { selectBackend, getBackendUrl, api } from './utils/backendSelector'
import ProjectLibrary from './components/ProjectLibrary'
import Timeline from './components/Timeline'
import VideoPreview from './components/VideoPreview'
import GlobalPreview from './components/GlobalPreview'
import ClipProperties from './components/ClipProperties'
import ExportButton from './components/ExportButton'
import RecordVideo from './components/RecordVideo'
import RecordAudio from './components/RecordAudio'
import OnboardingTour from './components/OnboardingTour'
import RemixModePicker from './components/RemixModePicker'
import MusicLibrary from './components/MusicLibrary'
import { REMIX_LAYOUTS, hasLayout, clampLayout } from './utils/remixLayout'
import { MAX_TIMELINE_SECONDS, MAX_TIMELINE_ADJ, MAX_TIMELINE_TEXT, getTimelineEnd } from './utils/limits'
import LengthLimitNotice from './components/LengthLimitNotice'
import TooLargeNotice from './components/TooLargeNotice'
import SilenceCutModal from './components/SilenceCutModal'
import BeatSyncModal from './components/BeatSyncModal'
import StickerPicker from './components/StickerPicker'
import EncodingNotice from './components/EncodingNotice'
import ClipColorFilters from './components/ClipColorFilters'
import { DraftsPrompt, DraftLimitPicker, CloseDialog, DraftStatus } from './components/DraftsDialogs'
import { useDrafts } from './hooks/useDrafts'
import logo3speak from './assets/3speak.png'

function App() {
  const { ffmpeg, loaded, loading, progress, exporting, exportProgress, loadFFmpeg, processVideo } = useFFmpeg()
  const {
    exporting: canvasExporting,
    exportProgress: canvasExportProgress,
    exportPhase,
    exportCanvas,
    cancelExport
  } = useCanvasExport(ffmpeg, loaded)
  const {
    // Library
    library,
    selectedLibraryId,
    selectedLibraryItem,
    addToLibrary,
    addToLibraryAndTimeline,
    addMusicClip,
    addSfxClip,
    addStickerClip,
    fitClipsToBeats,
    loadProjectState,
    addRemixRecording,
    removeFromLibrary,
    selectLibraryItem,
    addLibraryItemToTimeline,

    // Timeline
    tracks,
    selectedClipId,
    selectedClip,
    playheadPosition,
    setPlayheadPosition,
    addTrack,
    updateTrack,
    removeTrack,
    removeClip,
    updateClip,
    selectClip,
    duplicateClip,
    splitClip,
    splitClipAtPlayhead,
    applySilenceCut,
    removeGapAtPlayhead,
    isPlayheadOnGap,
    groupClips,
    ungroupClips,
    moveClipToTrack,
    addTextClip,
    addColorClip,
    addFilesToTrack,
    fileStoreRef,

    // HLS Downloads
    hlsDownloads,
    startHlsDownload,
    startBackendClipPreparation,

    // Undo/Redo
    undo,
    redo,
    canUndo,
    canRedo,
    lengthNotice,
    dismissLengthNotice,
    rejectedFiles,
    dismissRejectedFiles
  } = useTimeline()

  // Auto cut popup: the clip it was opened for
  const [autoCutClipId, setAutoCutClipId] = useState(null)
  const autoCutClip = useMemo(
    () => (autoCutClipId ? tracks.flatMap(t => t.clips).find(c => c.id === autoCutClipId) || null : null),
    [autoCutClipId, tracks]
  )
  // Prefer the creator's own file; HLS streams cannot be decoded in one go
  const autoCutSource = autoCutClip
    ? (fileStoreRef.current.get(autoCutClip.id) || autoCutClip.file || (isHlsUrl(autoCutClip.url) ? null : autoCutClip.url))
    : null
  const autoCutUnavailable = autoCutClip && !autoCutSource
    ? 'This clip is still streaming from 3Speak. Try again once its download has finished.'
    : null
  const autoCutOpenRef = useRef(false)
  const handleAutoCutApply = useCallback((parts, options) => {
    applySilenceCut(autoCutClipId, parts, options)
    setAutoCutClipId(null)
  }, [applySilenceCut, autoCutClipId])

  // Beat sync popup (audio clips): same way of reading the clip's audio as Auto cut
  const [beatClipId, setBeatClipId] = useState(null)
  const beatClip = useMemo(
    () => (beatClipId ? tracks.flatMap(t => t.clips).find(c => c.id === beatClipId) || null : null),
    [beatClipId, tracks]
  )
  const beatSource = beatClip
    ? (fileStoreRef.current.get(beatClip.id) || beatClip.file || (isHlsUrl(beatClip.url) ? null : beatClip.url))
    : null
  // App shortcuts are off while the Auto cut or Beat sync popup is open
  autoCutOpenRef.current = !!autoCutClip || !!beatClip

  // The timeline may run long while editing; rendering waits until it fits
  const timelineEnd = useMemo(() => getTimelineEnd(tracks), [tracks])
  const overLengthLimit = timelineEnd > MAX_TIMELINE_SECONDS + 0.01

  // Locked to 9:16 for shorts
  const activeAspectRatio = '9:16'
  const isVerticalVideo = true
  const [orientationOverride, setOrientationOverride] = useState(null)

  // Imperative handle into GlobalPreview: { togglePlay, pause, playFromStart }
  const previewControlRef = useRef(null)
  const togglePreviewPlay = useCallback(() => previewControlRef.current?.togglePlay(), [])

  const {
    isIframe,
    compactMode,
    isDesktop,
    theme,
    requestRender,
    requestClose,
    draftSession,
    draftContext,
    closeRequest,
    answerClose,
    requestDraftSignIn,
    sendToParent,
    renderStatus,
    clearRenderStatus,
    remixSource,
    remixPrompt,
    clearRemixPrompt
  } = useIframeApi({ addToLibraryAndTimeline, tracks, library, playheadPosition, fileStoreRef, activeAspectRatio, onTogglePlay: togglePreviewPlay })

  // Apply theme to document on mount and changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const [showTour, setShowTour] = useState(() => {
    return compactMode && !localStorage.getItem('3speak-tour-done')
  })
  const [showBackendInfo, setShowBackendInfo] = useState(false)
  const [selectedBackendUrl, setSelectedBackendUrl] = useState('')

  // Backend selection + health check on startup
  const [backendStatus, setBackendStatus] = useState('checking') // 'checking' | 'ok' | 'error'
  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        const url = await selectBackend()
        if (!cancelled) {
          setSelectedBackendUrl(url || window.location.origin)
          // Health check the selected backend
          const res = await fetch(api('/api/health'), { signal: AbortSignal.timeout(5000) })
          if (!cancelled) setBackendStatus(res.ok ? 'ok' : 'error')
        }
      } catch {
        if (!cancelled) setBackendStatus('error')
      }
    }
    init()
    return () => { cancelled = true }
  }, [])

  const handleRemoveClip = useCallback((clipId) => {
    if (window.confirm('Remove this clip from the timeline?')) {
      removeClip(clipId)
    }
  }, [removeClip])

  const handleRemoveFromLibrary = useCallback((itemId) => {
    if (window.confirm('Remove this item from the project library?')) {
      removeFromLibrary(itemId)
    }
  }, [removeFromLibrary])

  const handleRemoveTrack = useCallback((trackId) => {
    if (window.confirm('Remove this track and all its clips?')) {
      removeTrack(trackId)
    }
  }, [removeTrack])

  // Reverse clip: send to backend, get reversed file, swap URL
  const [reversingClipId, setReversingClipId] = useState(null)
  const handleReverseClip = useCallback(async (clipId) => {
    // Find the clip
    let targetClip = null
    for (const track of (tracks || [])) {
      const clip = track.clips.find(c => c.id === clipId)
      if (clip) { targetClip = clip; break }
    }
    if (!targetClip) return

    // Find paired audio clip (linked via sourceVideoClipId or groupId)
    let pairedAudioClip = null
    for (const track of (tracks || [])) {
      const ac = track.clips.find(c =>
        c.sourceVideoClipId === clipId ||
        (c.groupId && c.groupId === targetClip.groupId && c.type === 'audio' && c.id !== clipId)
      )
      if (ac) { pairedAudioClip = ac; break }
    }

    // If already reversed, restore the original URL and serverUrl
    if (targetClip.reversed) {
      updateClip(clipId, {
        reversed: false,
        url: targetClip.reverseOriginalUrl || targetClip.url,
        serverUrl: targetClip.reverseOriginalServerUrl || targetClip.serverUrl,
        reverseOriginalUrl: undefined,
        reverseOriginalServerUrl: undefined
      })
      // Also restore paired audio clip
      if (pairedAudioClip && pairedAudioClip.reversed) {
        updateClip(pairedAudioClip.id, {
          reversed: false,
          url: pairedAudioClip.reverseOriginalUrl || pairedAudioClip.url,
          serverUrl: pairedAudioClip.reverseOriginalServerUrl || pairedAudioClip.serverUrl,
          reverseOriginalUrl: undefined,
          reverseOriginalServerUrl: undefined
        })
      }
      return
    }

    setReversingClipId(clipId)
    try {
      // Prefer serverUrl (backend-local path like /rendered/clip-xxx.mp4) to avoid large uploads
      const sourceUrl = targetClip.serverUrl || targetClip.url
      const reversedUrl = await reverseClipOnBackend(
        sourceUrl,
        targetClip.startTime,
        targetClip.endTime
      )
      updateClip(clipId, {
        reversed: true,
        reverseOriginalUrl: targetClip.url,
        reverseOriginalServerUrl: targetClip.serverUrl || null,
        url: reversedUrl,
        serverUrl: reversedUrl,
        startTime: 0,
        endTime: targetClip.endTime - targetClip.startTime
      })
      // Also reverse paired audio clip (reversed file already contains reversed audio)
      if (pairedAudioClip) {
        updateClip(pairedAudioClip.id, {
          reversed: true,
          reverseOriginalUrl: pairedAudioClip.url,
          reverseOriginalServerUrl: pairedAudioClip.serverUrl || null,
          url: reversedUrl,
          serverUrl: reversedUrl,
          startTime: 0,
          endTime: targetClip.endTime - targetClip.startTime
        })
      }
    } catch (err) {
      console.error('Failed to reverse clip:', err)
      alert('Failed to reverse clip: ' + err.message)
    } finally {
      setReversingClipId(null)
    }
  }, [tracks, updateClip])

  const spaceBlockedRef = useRef(false)

  // Ref for playhead position to avoid recreating keyboard handler on every frame
  const playheadPositionRef = useRef(playheadPosition)
  useEffect(() => {
    playheadPositionRef.current = playheadPosition
  }, [playheadPosition])

  // Warn before closing/refreshing the browser tab
  useEffect(() => {
    const handler = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Auto-load FFmpeg on mount
  useEffect(() => {
    loadFFmpeg()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-download HLS streams when new HLS library items appear
  // If clipStart/clipEnd are set → backend prepares the clip (no FFmpeg needed client-side)
  // Otherwise → client-side HLS download (requires FFmpeg loaded)
  const downloadedHlsRef = useRef(new Set())
  useEffect(() => {
    for (const item of library) {
      if (
        isHlsUrl(item.url) &&
        !downloadedHlsRef.current.has(item.id) &&
        !hlsDownloads[item.id]
      ) {
        if (item.clipStart != null && item.clipEnd != null) {
          // Backend path: download 480p + trim on server
          downloadedHlsRef.current.add(item.id)
          startBackendClipPreparation(item.id, item.url, item.clipStart, item.clipEnd)
        } else if (loaded && ffmpeg) {
          // Client-side path: download full HLS in browser
          downloadedHlsRef.current.add(item.id)
          startHlsDownload(item.id, item.url, ffmpeg)
        }
      }
    }
  }, [library, loaded, ffmpeg, hlsDownloads, startHlsDownload, startBackendClipPreparation])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // The Auto cut popup is open over the timeline
      if (autoCutOpenRef.current) {
        if (e.key === 'Escape') { setAutoCutClipId(null); setBeatClipId(null) }
        return
      }
      // Ignore if typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return
      }

      // Space - play/pause the timeline preview
      if (e.key === ' ' || e.code === 'Space') {
        if (e.target.tagName === 'SELECT' || e.target.isContentEditable) return
        e.preventDefault()
        // A focused button would also fire its click on keyup
        if (e.target.tagName === 'BUTTON') e.target.blur()
        if (!spaceBlockedRef.current) previewControlRef.current?.togglePlay()
        return
      }

      // Delete key - remove selected clip
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClipId) {
          e.preventDefault()
          handleRemoveClip(selectedClipId)
        }
      }

      // Ctrl+R - split clip at playhead
      if (e.key === 'r' && (e.ctrlKey || e.metaKey)) {
        if (selectedClipId) {
          e.preventDefault()
          splitClipAtPlayhead(selectedClipId, playheadPositionRef.current)
        }
      }

      // Ctrl+Z - undo
      if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault()
        undo()
      }

      // Ctrl+Shift+Z or Ctrl+Y - redo
      if ((e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) ||
          (e.key === 'y' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault()
        redo()
      }

      // Ctrl+D - duplicate selected clip
      if (e.key === 'd' && (e.ctrlKey || e.metaKey)) {
        if (selectedClipId) {
          e.preventDefault()
          duplicateClip(selectedClipId)
        }
      }

      // Ctrl+Shift+G - ungroup clips
      if (e.key === 'g' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        if (selectedClipId) {
          e.preventDefault()
          ungroupClips(selectedClipId)
        }
      }

      // G - ripple (remove gap at playhead)
      if (e.key === 'g' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (isPlayheadOnGap) {
          e.preventDefault()
          removeGapAtPlayhead()
        }
      }

      // T - add text clip
      if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        addTextClip()
      }

      // Arrow keys - move playhead
      const PLAYHEAD_STEP = 0.1 // 100ms step
      const PLAYHEAD_STEP_LARGE = 1 // 1 second when holding shift
      const step = e.shiftKey ? PLAYHEAD_STEP_LARGE : PLAYHEAD_STEP

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setPlayheadPosition(prev => Math.max(0, prev - step))
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault()
        setPlayheadPosition(prev => prev + step)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedClipId, handleRemoveClip, splitClipAtPlayhead, undo, redo, setPlayheadPosition, ungroupClips, duplicateClip, isPlayheadOnGap, removeGapAtPlayhead, addTextClip])

  // Prevent external file drops anywhere except the project library
  useEffect(() => {
    const isExternalFileDrop = (e) => {
      const types = Array.from(e.dataTransfer.types)
      // External files have 'Files' type, internal drags have text types
      return types.includes('Files') && !types.some(t => t.startsWith('text/'))
    }

    const preventFileDrop = (e) => {
      // Allow drops on the project library
      if (e.target.closest('.project-library')) {
        return
      }
      // Only block external file drops, allow internal drags
      if (isExternalFileDrop(e)) {
        e.preventDefault()
      }
    }

    const preventDragOver = (e) => {
      if (e.target.closest('.project-library')) {
        return
      }
      if (isExternalFileDrop(e)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'none'
      }
    }

    document.addEventListener('drop', preventFileDrop)
    document.addEventListener('dragover', preventDragOver)

    return () => {
      document.removeEventListener('drop', preventFileDrop)
      document.removeEventListener('dragover', preventDragOver)
    }
  }, [])

  const handleFilesAdded = useCallback((files) => {
    addToLibrary(files)
  }, [addToLibrary])

  // Add recorded files directly to library AND timeline
  const handleRecordedFiles = useCallback(async (files) => {
    for (const file of files) {
      const type = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : null
      if (!type) continue

      // Use pre-uploaded URL if InlineRecorder already uploaded it
      const preUploadedUrl = file._serverUrl || null
      const url = preUploadedUrl || URL.createObjectURL(file)
      const added = await addToLibraryAndTimeline(url, file.name, type, { file, serverUrl: preUploadedUrl })
      // Green screen take from the camera recorder
      if (added?.clipId && type === 'video' && file._chromaKey) updateClip(added.clipId, { chromaKey: file._chromaKey })
    }
  }, [addToLibraryAndTimeline, updateClip])

  // Handle drop from library to timeline
  const handleTimelineDrop = useCallback((e, trackId, insertIndex, dropTime) => {
    const libraryItemId = e.dataTransfer.getData('libraryItemId')
    if (libraryItemId) {
      addLibraryItemToTimeline(libraryItemId, trackId, insertIndex, dropTime)
    }
  }, [addLibraryItemToTimeline])

  // Get clips for export
  const videoClips = (tracks || []).filter(t => t.type === 'video').flatMap(t => t.clips)
  const audioClips = (tracks || []).filter(t => t.type === 'audio').flatMap(t => t.clips)

  // Preview item - show selected clip or selected library item
  const previewItem = selectedClip || selectedLibraryItem

  // Collapsible panel states
  const [previewOpen, setPreviewOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(true)
  const [propertiesOpen, setPropertiesOpen] = useState(true)
  const [recordingOpen, setRecordingOpen] = useState(false)
  const [recordingAudioOpen, setRecordingAudioOpen] = useState(false)
  const [musicOpen, setMusicOpen] = useState(false)
  const [sfxOpen, setSfxOpen] = useState(false)
  const [stickersOpen, setStickersOpen] = useState(false)
  const [inlineRecordingOpen, setInlineRecordingOpen] = useState(false)
  const [recorderSize, setRecorderSize] = useState('small') // 'small' | 'big'

  // ---- Guided remix (stitch / reaction) ----
  // { mode: 'stitch'|'overlay'|'tileTop'|'tileBottom', before (stitch), sourceClipId, maxDuration,
  //   layouts: { source, recording } (reactions; adjusted on the phone record stage) }
  const [remixSession, setRemixSession] = useState(null)

  // The framing chosen per reaction layout (pan / zoom / overlay position) is
  // remembered on this device and comes back for the next remix
  const REMIX_FRAMING_KEY = '3speak-remix-framing'
  const loadRemixLayouts = (mode) => {
    try {
      const saved = JSON.parse(localStorage.getItem(REMIX_FRAMING_KEY) || '{}')[mode]
      const def = REMIX_LAYOUTS[mode]
      // hasLayout checks a clip's .layout
      const valid = (l) => hasLayout({ layout: l })
      return {
        source: def.source && valid(saved?.source) ? clampLayout(saved.source) : def.source,
        recording: valid(saved?.recording) ? clampLayout(saved.recording) : def.recording
      }
    } catch {
      return { ...REMIX_LAYOUTS[mode] }
    }
  }
  const saveRemixLayouts = (mode, layouts) => {
    try {
      const all = JSON.parse(localStorage.getItem(REMIX_FRAMING_KEY) || '{}')
      all[mode] = layouts
      localStorage.setItem(REMIX_FRAMING_KEY, JSON.stringify(all))
    } catch { /* storage unavailable */ }
  }

  const recorderGuide = useMemo(() => {
    if (!remixSession) return null
    const { mode, maxDuration } = remixSession
    if (mode === 'stitch') {
      return {
        title: 'Stitch',
        mode,
        sourceClipId: remixSession.sourceClipId,
        hint: `Record up to ${Math.floor(maxDuration)}s. It plays right ${remixSession.before ? 'before' : 'after'} the original.`,
        maxDuration,
        sync: false
      }
    }
    return {
      title: 'Reaction',
      mode,
      sourceClipId: remixSession.sourceClipId,
      layouts: remixSession.layouts,
      timelineStart: remixSession.timelineStart || 0,
      hint: 'The original plays from the start while you record. Use headphones so it does not echo into your mic.',
      maxDuration,
      sync: true
    }
  }, [remixSession])

  const handleRemixChoice = useCallback((mode) => {
    const sourceClipId = remixPrompt?.clipId
    clearRemixPrompt()
    if (mode === 'free') return

    const source = tracks.flatMap(t => t.clips).find(c => c.id === sourceClipId)
    if (!source) return // original never made it onto the timeline; plain free edit
    const sourceLen = source.endTime - source.startTime
    const sourceEnd = (source.timelinePosition || 0) + sourceLen

    if (mode === 'stitchBefore' || mode === 'stitchAfter') {
      const remaining = MAX_TIMELINE_SECONDS - sourceEnd
      if (remaining < 1) {
        alert(`The original already fills the ${MAX_TIMELINE_ADJ} limit. Trim it on the timeline, then record your stitch with the camera button.`)
        return
      }
      const before = mode === 'stitchBefore'
      setRemixSession({ mode: 'stitch', before, sourceClipId, maxDuration: remaining })
      // Start at the beginning of the original; its own player lets you scrub
      setPlayheadPosition(source.timelinePosition || 0)
    } else {
      // The original stays full frame while recording, so you can see what you
      // react to; the tile layout is applied once the recording is placed.
      setRemixSession({ mode, sourceClipId, maxDuration: sourceLen, timelineStart: source.timelinePosition || 0, layouts: loadRemixLayouts(mode) })
      setPlayheadPosition(source.timelinePosition || 0)
    }
    setRecorderSize('big')
    setInlineRecordingOpen(true)
  }, [remixPrompt, clearRemixPrompt, tracks, setPlayheadPosition])

  // Phone record stage: switch between the reaction layouts before recording
  const handleChangeRemixMode = useCallback((mode) => {
    setRemixSession(s => {
      if (!s || s.mode === 'stitch' || !REMIX_LAYOUTS[mode] || s.mode === mode) return s
      return { ...s, mode, layouts: loadRemixLayouts(mode) }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Phone record stage: pan / zoom / move of the original ('source') or the
  // camera ('recording') box; applied to the tracks when the take is placed
  const handleChangeStageLayout = useCallback((role, layout) => {
    setRemixSession(s => {
      if (!s || !s.layouts) return s
      const layouts = { ...s.layouts, [role]: layout }
      saveRemixLayouts(s.mode, layouts)
      return { ...s, layouts }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Plain "record" entry points: with no video on the timeline there is nothing
  // to record over, so the camera opens full size; otherwise as the small PiP
  // over the preview, as before. (Remix sessions set their own size.)
  const openRecorder = useCallback(() => {
    const hasVideo = tracks.some(t => t.type === 'video' && t.clips.length > 0)
    setRecorderSize(hasVideo ? 'small' : 'big')
    setInlineRecordingOpen(true)
  }, [tracks])

  const handleRecordedInline = useCallback(async (files, { startPosition = 0 } = {}) => {
    // Green screen take: layered on a new top track where recording started, so
    // it is keyed over what plays underneath (appended like any take otherwise)
    const keyedTake = files.find(f => f._chromaKey && f.type.startsWith('video'))
    if (!remixSession && keyedTake) {
      const under = tracks.some(t => t.type === 'video' && t.clips.some(c =>
        startPosition >= (c.timelinePosition || 0) && startPosition < (c.timelinePosition || 0) + (c.endTime - c.startTime)))
      if (under) {
        const clipId = await addRemixRecording(keyedTake, keyedTake._serverUrl || null, { placement: 'layer', timelinePosition: startPosition })
        if (clipId) {
          updateClip(clipId, { chromaKey: keyedTake._chromaKey })
          selectClip(clipId)
          setPlayheadPosition(startPosition)
        }
        return
      }
    }
    if (!remixSession) return handleRecordedFiles(files)
    const file = files.find(f => f.type.startsWith('video'))
    if (!file) return
    const session = remixSession
    const source = tracks.flatMap(t => t.clips).find(c => c.id === session.sourceClipId)
    const options = session.mode === 'stitch'
      ? { placement: session.before ? 'before' : 'after', afterClipId: session.sourceClipId, layout: REMIX_LAYOUTS.stitch.recording, maxDuration: session.maxDuration }
      : {
          placement: 'layer',
          timelinePosition: source?.timelinePosition || 0,
          layout: session.layouts?.recording || REMIX_LAYOUTS[session.mode].recording,
          maxDuration: session.maxDuration
        }
    const sourceLayout = session.mode !== 'stitch' ? (session.layouts?.source || REMIX_LAYOUTS[session.mode].source) : null
    if (sourceLayout) updateClip(session.sourceClipId, { layout: sourceLayout })
    const clipId = await addRemixRecording(file, file._serverUrl || null, options)
    if (clipId && file._chromaKey) updateClip(clipId, { chromaKey: file._chromaKey })
    if (clipId) selectClip(clipId)
    // Land on the seam for a clip after the original; at the start otherwise
    setPlayheadPosition(session.mode === 'stitch' && !session.before
      ? Math.max(0, (source?.timelinePosition || 0) + (source ? source.endTime - source.startTime : 0))
      : 0)
  }, [remixSession, handleRecordedFiles, tracks, updateClip, addRemixRecording, selectClip, setPlayheadPosition])

  // Music library: the song lands on its own track and is selected
  const handlePickMusic = useCallback(async (track) => {
    const clipId = await addMusicClip(track.url, `${track.title} - ${track.artist}`, track.credit, track.bpm)
    if (clipId) selectClip(clipId)
  }, [addMusicClip, selectClip])

  // Stickers go in at the playhead (on a "Stickers" track above the footage)
  const handlePickSticker = useCallback((sticker) => {
    const clipId = addStickerClip(sticker, playheadPosition)
    if (clipId) selectClip(clipId)
  }, [addStickerClip, selectClip, playheadPosition])

  // Sound effects go in at the playhead
  const handlePickSfx = useCallback(async (track) => {
    const clipId = await addSfxClip(track.url, track.title, playheadPosition)
    if (clipId) selectClip(clipId)
  }, [addSfxClip, selectClip, playheadPosition])

  // Credits of the library songs still on the timeline, once each, sent with
  // the video so 3speak.tv can credit them (and pay 3Speak sound creators)
  const musicCredits = useMemo(() => {
    const seen = new Map()
    for (const t of tracks) {
      for (const c of t.clips) {
        if (c.credit?.id && !seen.has(c.credit.id)) seen.set(c.credit.id, c.credit)
      }
    }
    return [...seen.values()]
  }, [tracks])

  const handleCloseInlineRecorder = useCallback(() => {
    setInlineRecordingOpen(false)
    if (remixSession) setRemixSession(null)
  }, [remixSession])

  // Spacebar stays out of the way while the picker or a guided recording is up
  spaceBlockedRef.current = !!remixPrompt || (inlineRecordingOpen && !!remixSession)

  // Active HLS download for overlay
  const activeHlsDownload = useMemo(() => {
    const entries = Object.entries(hlsDownloads)
    const downloading = entries.find(([, d]) => d.status === 'downloading')
    if (!downloading) return null
    const [id, info] = downloading
    const item = library.find(l => l.id === id)
    return { name: item?.name || 'Media', progress: info.progress }
  }, [hlsDownloads, library])

  // Footage this browser cannot show while its playable copy is made; the
  // popup can be hidden per video (the library badge still shows the status)
  const [hiddenEncodingIds, setHiddenEncodingIds] = useState(() => new Set())
  const encodingItems = useMemo(
    () => library.filter(item => item.needsConversion && (item.uploading || item.converting) && !hiddenEncodingIds.has(item.id)),
    [library, hiddenEncodingIds]
  )
  const hideEncodingNotice = useCallback(() => {
    setHiddenEncodingIds(prev => new Set([...prev, ...encodingItems.map(i => i.id)]))
  }, [encodingItems])

  // Empty timeline: quiet "Add video / image / audio" tiles in the preview.
  // Files go straight onto the first matching track (same path as a track's +).
  const emptyVideoInputRef = useRef(null)
  const emptyImageInputRef = useRef(null)
  const emptyAudioInputRef = useRef(null)
  const addFilesFromEmpty = useCallback((e, type) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    const track = tracks.find(t => t.type === (type === 'audio' ? 'audio' : 'video'))
    if (track) addFilesToTrack(files, track.id)
    else addToLibrary(files)
  }, [tracks, addFilesToTrack, addToLibrary])
  const emptyTimelineActions = (
    <div className="empty-timeline-actions">
      <button type="button" onClick={() => emptyVideoInputRef.current?.click()}>
        <Film size={22} /> <span>Add video</span>
      </button>
      <button type="button" onClick={() => emptyImageInputRef.current?.click()}>
        <ImageIcon size={22} /> <span>Add image</span>
      </button>
      <button type="button" onClick={() => emptyAudioInputRef.current?.click()}>
        <Music size={22} /> <span>Add audio</span>
      </button>
      <input ref={emptyVideoInputRef} type="file" accept="video/*" multiple hidden onChange={(e) => addFilesFromEmpty(e, 'video')} />
      <input ref={emptyImageInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFilesFromEmpty(e, 'image')} />
      <input ref={emptyAudioInputRef} type="file" accept="audio/*" multiple hidden onChange={(e) => addFilesFromEmpty(e, 'audio')} />
    </div>
  )

  // Uploads still running in the background; Render waits for them
  const activeUpload = useMemo(() => {
    const uploading = library.filter(item => item.uploading)
    if (uploading.length === 0) return null
    // Uploads run in parallel: overall progress, weighted by file size
    let total = 0
    let done = 0
    for (const item of uploading) {
      const size = item.file?.size || 1
      total += size
      done += size * (item.uploadProgress || 0)
    }
    const name = uploading.length > 1 ? `${uploading.length} files` : (uploading[0].name || 'Media')
    return { name, progress: total ? done / total : 0, count: uploading.length }
  }, [library])

  // Ref for add-media file input
  const addMediaInputRef = useRef(null)

  const handleAddMedia = useCallback(() => {
    addMediaInputRef.current?.click()
  }, [])

  const handleAddMediaFiles = useCallback((e) => {
    const files = Array.from(e.target.files)
    if (files.length > 0) addToLibrary(files)
    e.target.value = ''
  }, [addToLibrary])

  // Drafts (saved projects of signed-in users, see hooks/useDrafts.js)
  const drafts = useDrafts({
    session: draftSession,
    hasMedia: draftContext.hasMedia,
    tracks,
    library,
    loadProjectState,
    onUnauthorized: requestDraftSignIn
  })
  const canDraftSignIn = isIframe && !draftSession && ['sign-in-needed', 'sign-in-failed', 'signing-in'].includes(draftContext.reason)
  const [limitOpen, setLimitOpen] = useState(false)
  useEffect(() => {
    if (drafts.status === 'limit' && drafts.limitProjects.length) setLimitOpen(true)
  }, [drafts.status, drafts.limitProjects])

  // Closing: from our own X ('self') or the site's (it sends request-close: 'parent')
  const [closeDialog, setCloseDialog] = useState(null)
  const closeAfterSaveRef = useRef(false)
  const timelineEmpty = !tracks.some(t => t.clips.length)
  const finishClose = useCallback((close, from) => {
    setCloseDialog(null)
    closeAfterSaveRef.current = false
    if (from === 'parent') answerClose(close)
    else if (close) requestClose()
  }, [answerClose, requestClose])
  const handleCloseEditor = useCallback(() => {
    if (timelineEmpty) requestClose()
    else setCloseDialog('self')
  }, [timelineEmpty, requestClose])
  useEffect(() => {
    if (!closeRequest) return
    if (timelineEmpty) answerClose(true)
    else setCloseDialog('parent')
  }, [closeRequest]) // eslint-disable-line react-hooks/exhaustive-deps

  const isBackendRendering = renderStatus && (renderStatus.status === 'submitting' || renderStatus.status === 'processing')

  // Preview modal state — user must preview rendered video before sending
  const [showPreview, setShowPreview] = useState(false)

  // Compact mode: properties panel for selected clip
  const [compactPropertiesClipId, setCompactPropertiesClipId] = useState(null)
  // An open options panel follows the selection (e.g. a clip clicked in the preview)
  useEffect(() => {
    if (compactPropertiesClipId && selectedClipId && selectedClipId !== compactPropertiesClipId) {
      setCompactPropertiesClipId(selectedClipId)
    }
  }, [selectedClipId]) // eslint-disable-line react-hooks/exhaustive-deps
  const compactPropertiesClip = compactPropertiesClipId
    ? tracks.flatMap(t => t.clips).find(c => c.id === compactPropertiesClipId) || null
    : null

  // The audio-track clip a video's sound plays from (same group, type audio)
  const linkedAudioOf = (clip) => (clip?.type === 'video' && clip.groupId
    ? tracks.flatMap(t => t.clips).find(c => c.groupId === clip.groupId && c.type === 'audio') || null
    : null)

  // Clip settings in the compact layout: on phones the clip opened with
  // "Options" (a panel over the timeline); on desktop a sidebar that follows
  // the selected clip
  const sideClip = compactPropertiesClip || (isDesktop ? selectedClip : null)
  const compactPropertiesPanel = sideClip ? (
          <div className="compact-properties-panel">
            <div className="compact-properties-header">
              <span className="compact-properties-title">{sideClip.name}</span>
              <button
                className="compact-btn compact-properties-close"
                onClick={() => { setCompactPropertiesClipId(null); if (isDesktop) selectClip(null) }}
                title="Close properties"
              >
                <X size={14} />
              </button>
            </div>
            <ClipProperties
              clip={sideClip}
              linkedAudio={linkedAudioOf(sideClip)}
              onUpdateLinkedAudio={(u) => { const a = linkedAudioOf(sideClip); if (a) updateClip(a.id, u) }}
              onUpdateClip={(updates) => updateClip(sideClip.id, updates)}
              onSplit={() => splitClip(sideClip.id)}
              playheadPosition={playheadPosition}
              tabbed={!isDesktop}
            />
          </div>
  ) : null

  if (compactMode) {
    return (
      <div className={`app compact${isDesktop ? ' desktop' : ''}`}>
        <ClipColorFilters tracks={tracks} />
        {/* Backend health warning */}
        {backendStatus === 'error' && (
          <div className="backend-warning">
            Backend server is unreachable. Recording upload, rendering, and media processing will not work.
            <button onClick={() => setBackendStatus('ok')}>Dismiss</button>
          </div>
        )}

        {/* Branding bar */}
        <header className="app-branding">
          <div className="branding-left">
            <img src={logo3speak} alt="3Speak" className="branding-logo" />
            <span className="branding-text">Shorts Editor <span className="branding-badge">beta</span></span>
            <span className="branding-info" onClick={() => setShowBackendInfo(prev => !prev)}>
              <Info size={14} />
              {showBackendInfo && (
                <span className="branding-info-popup">Backend: {selectedBackendUrl || 'selecting...'}</span>
              )}
            </span>
          </div>
          <DraftStatus drafts={drafts} canSignIn={canDraftSignIn} signInState={draftContext.reason} onSignIn={requestDraftSignIn} onOpenLimit={() => drafts.save()} />
          <button className="branding-close-btn" onClick={handleCloseEditor} title="Close editor">
            <X size={16} />
          </button>
        </header>

        {/* Compact menu bar: undo/redo + render (centered) */}
        <div className="compact-menu-bar">
          <div className="compact-menu-left">
            <button
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              className="compact-btn"
            >
              <Undo2 size={16} />
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl+Shift+Z)"
              className="compact-btn"
            >
              <Redo2 size={16} />
            </button>
          </div>
          <div className="compact-menu-center">
            <button
              className={renderStatus?.status === 'completed' ? 'compact-download-btn' : 'compact-render-btn'}
              onClick={() => { clearRenderStatus(); requestRender() }}
              disabled={videoClips.length === 0 || (exporting || canvasExporting) || isBackendRendering || overLengthLimit || !!activeUpload}
              title={overLengthLimit ? `Trim the timeline to ${MAX_TIMELINE_TEXT} or less to render` : undefined}
            >
              <Clapperboard size={14} />
              <span>{isBackendRendering ? 'Rendering...' : activeUpload ? `Uploading ${Math.round(activeUpload.progress * 100)}%` : renderStatus?.status === 'completed' ? 'Re-render' : 'Render'}</span>
            </button>
            {renderStatus?.status === 'completed' && renderStatus.outputUrl && (
              <>
                <a
                  className="compact-download-btn"
                  href={renderStatus.outputUrl}
                  download
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download size={14} />
                  <span>Download</span>
                </a>
                {isIframe && (
                  <button
                    className="compact-render-btn"
                    onClick={() => setShowPreview(true)}
                  >
                    <Send size={14} />
                    <span>Send Video</span>
                  </button>
                )}
              </>
            )}
          </div>
          <div className="compact-menu-right">
          </div>
        </div>

        {/* Render progress bar (shown below menu bar when active) */}
        {isBackendRendering && (
          <div className="compact-render-progress">
            <div className="compact-render-progress-bar">
              <div
                className="compact-render-progress-fill"
                style={{ width: `${Math.round((renderStatus.progress || 0) * 100)}%` }}
              />
            </div>
            <span className="compact-render-progress-text">
              {renderStatus.phase || `${Math.round((renderStatus.progress || 0) * 100)}%`}
            </span>
          </div>
        )}

        {/* Render error */}
        {renderStatus?.status === 'failed' && (
          <div className="compact-render-error">
            <span>Render failed: {renderStatus.error}</span>
            <button onClick={clearRenderStatus}><X size={12} /></button>
          </div>
        )}

        {/* Global Preview */}
        <div className={`compact-workspace${isDesktop ? ' desktop' : ''}`}>
        <div className="compact-main">
        <GlobalPreview
          emptyActions={emptyTimelineActions}
          tracks={tracks}
          playheadPosition={playheadPosition}
          onSetPlayhead={setPlayheadPosition}
          isVerticalVideo={isVerticalVideo}
          activeAspectRatio={activeAspectRatio}
          selectedClipId={selectedClipId}
          onUpdateClip={updateClip}
          onSelectClip={selectClip}
          compact
          inlineRecording={inlineRecordingOpen}
          onRecordedInline={handleRecordedInline}
          onCloseInlineRecorder={handleCloseInlineRecorder}
          recorderGuide={recorderGuide}
          onChangeRemixMode={handleChangeRemixMode}
          onChangeStageLayout={handleChangeStageLayout}
          controlRef={previewControlRef}
          recorderSize={recorderSize}
          onSetRecorderSize={setRecorderSize}
        />

        {/* Timeline (includes its own toolbar) */}
        <div className="compact-timeline-section">
          <Timeline
            tracks={tracks}
            selectedClipId={selectedClipId}
            playheadPosition={playheadPosition}
            onSetPlayhead={setPlayheadPosition}
            onSelectClip={selectClip}
            onRemoveClip={handleRemoveClip}
            onUpdateClip={updateClip}
            onDuplicateClip={duplicateClip}
            onSplitClip={splitClip}
            onSplitAtPlayhead={splitClipAtPlayhead}
            onRemoveGap={removeGapAtPlayhead}
            isPlayheadOnGap={isPlayheadOnGap}
            onDuplicate={duplicateClip}
            onGroupClips={groupClips}
            onUngroupClips={ungroupClips}
            onAddTrack={addTrack}
            onAddTextClip={addTextClip}
            onAddColorClip={addColorClip}
            onRemoveTrack={handleRemoveTrack}
            onLibraryDrop={handleTimelineDrop}
            onMoveClipToTrack={moveClipToTrack}
            onAddFilesToTrack={addFilesToTrack}
            onOpenClipSettings={(clipId) => setCompactPropertiesClipId(clipId)}
            onRecordAudio={() => setRecordingAudioOpen(true)}
            onOpenMusic={() => setMusicOpen(true)}
            onOpenSfx={() => setSfxOpen(true)}
            onOpenStickers={() => setStickersOpen(true)}
            onRecordVideo={openRecorder}
            onReverseClip={handleReverseClip}
            onUpdateTrack={updateTrack}
            onAutoCut={setAutoCutClipId}
            onBeatSync={setBeatClipId}
            isDesktop={isDesktop}
          />

          {/* Reversing overlay */}
          {reversingClipId && (
            <div className="hls-download-overlay">
              <div className="hls-download-modal">
                <h3>Reversing clip...</h3>
                <p>Processing on server, please wait.</p>
              </div>
            </div>
          )}

          {/* Compact properties panel (phones: over the timeline; desktop: the sidebar) */}
          {!isDesktop && compactPropertiesPanel}
        </div>
        </div>
        {/* Desktop: the selected clip's settings beside preview and timeline */}
        {isDesktop && (
          <aside className="compact-side">
            {sideClip ? compactPropertiesPanel : (
              <p className="compact-side-empty">Select a clip on the timeline to see its settings.</p>
            )}
          </aside>
        )}
        </div>

        {/* Onboarding Tour */}
        {showTour && (
          <OnboardingTour onComplete={() => {
            localStorage.setItem('3speak-tour-done', '1')
            setShowTour(false)
          }} />
        )}

        {/* Remix mode picker (whole video arriving from the remix button) */}
        {remixPrompt && !showTour && <RemixModePicker onChoose={handleRemixChoice} />}
        {rejectedFiles.length > 0 && <TooLargeNotice files={rejectedFiles} onClose={dismissRejectedFiles} />}
        {lengthNotice && !remixPrompt && !showTour && <LengthLimitNotice length={lengthNotice.length} onClose={dismissLengthNotice} />}
        {drafts.prompt && drafts.drafts?.length > 0 && (
          <DraftsPrompt drafts={drafts.drafts} limits={drafts.limits} onLoad={drafts.loadDraft} onStartNew={drafts.startNew} />
        )}
        {limitOpen && drafts.limitProjects.length > 0 && (
          <DraftLimitPicker
            projects={drafts.limitProjects}
            limits={drafts.limits}
            onReplace={async (id) => {
              const r = await drafts.resolveLimit(id)
              setLimitOpen(false)
              if (r.ok && closeAfterSaveRef.current) finishClose(true, closeDialog)
            }}
            onSkip={() => { drafts.resolveLimit(null); setLimitOpen(false) }}
          />
        )}
        {closeDialog && !limitOpen && (
          <CloseDialog
            uploading={library.filter(i => i.uploading).map(i => ({ name: i.name, size: i.file?.size || 0, progress: i.uploadProgress || 0 }))}
            drafts={{ ...drafts, save: async (o) => { closeAfterSaveRef.current = true; return drafts.save(o) } }}
            signedOut={draftContext.reason === 'logged-out'}
            canSignIn={canDraftSignIn}
    signInState={draftContext.reason}
            onSignIn={requestDraftSignIn}
            onClose={() => finishClose(true, closeDialog)}
            onCancel={() => finishClose(false, closeDialog)}
          />
        )}
        {beatClip && (
          <BeatSyncModal
            key={beatClip.id}
            clip={beatClip}
            source={beatSource}
            unavailable={beatClip && !beatSource ? 'This clip is still streaming from 3Speak. Try again once its download has finished.' : null}
            onSetBeats={(fields) => updateClip(beatClip.id, fields)}
            onFitClips={fitClipsToBeats}
            onClose={() => setBeatClipId(null)}
          />
        )}
        {autoCutClip && (
          <SilenceCutModal
            key={autoCutClip.id}
            clip={autoCutClip}
            source={autoCutSource}
            unavailable={autoCutUnavailable}
            onApply={handleAutoCutApply}
            onClose={() => setAutoCutClipId(null)}
          />
        )}

        {musicOpen && <MusicLibrary onPick={handlePickMusic} onClose={() => setMusicOpen(false)} />}

        {sfxOpen && <MusicLibrary kind="sfx" onPick={handlePickSfx} onClose={() => setSfxOpen(false)} />}

        {stickersOpen && <StickerPicker onPick={handlePickSticker} onClose={() => setStickersOpen(false)} />}

        {/* Record Video Modal */}
        {recordingOpen && (
          <RecordVideo
            onRecorded={handleRecordedFiles}
            onClose={() => setRecordingOpen(false)}
          />
        )}

        {/* Record Audio Modal */}
        {recordingAudioOpen && (
          <RecordAudio
            onRecorded={handleRecordedFiles}
            onClose={() => setRecordingAudioOpen(false)}
          />
        )}

        {/* HLS Download Overlay */}
        {activeHlsDownload && (
          <div className="hls-download-overlay">
            <div className="hls-download-modal">
              <Download size={32} className="hls-download-icon" />
              <h3>Downloading Media</h3>
              <p className="hls-download-name">{activeHlsDownload.name}</p>
              <div className="hls-download-progress-bar">
                <div
                  className="hls-download-progress-fill"
                  style={{ width: `${Math.round(activeHlsDownload.progress * 100)}%` }}
                />
              </div>
              <p className="hls-download-percent">{Math.round(activeHlsDownload.progress * 100)}%</p>
              <p className="hls-download-hint">Please wait while the media is being prepared...</p>
            </div>
          </div>
        )}

        {/* Upload Progress Overlay */}
        {encodingItems.length > 0 && (
          <EncodingNotice items={encodingItems} onClose={hideEncodingNotice} />
        )}

        {/* Video Preview before Send */}
        {showPreview && renderStatus?.outputUrl && (
          <div className="video-preview-overlay">
            <div className="video-preview-modal">
              <div className="video-preview-header">
                <h3>Preview your video</h3>
                <button className="video-preview-close" onClick={() => setShowPreview(false)}>
                  <X size={18} />
                </button>
              </div>
              <div className="video-preview-player">
                <video
                  src={renderStatus.outputUrl}
                  controls
                  autoPlay
                  playsInline
                  style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 8, background: '#000' }}
                />
              </div>
              <div className="video-preview-actions">
                <button className="video-preview-back" onClick={() => setShowPreview(false)}>
                  Back to Editor
                </button>
                <button
                  className="video-preview-send"
                  onClick={() => {
                    setShowPreview(false)
                    // Sent: the draft has done its job ("Download" keeps it)
                    drafts.deleteCurrent()
                    sendToParent('post-to-3speak', {
                      outputUrl: renderStatus.outputUrl,
                      ...(remixSource && { remixSource }),
                      ...(musicCredits.length > 0 && { musicCredits })
                    })
                  }}
                >
                  <Send size={14} />
                  <span>Send Video</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <ClipColorFilters tracks={tracks} />
      {/* Backend health warning */}
      {backendStatus === 'error' && (
        <div className="backend-warning">
          Backend server is unreachable. Recording upload, rendering, and media processing will not work.
          <button onClick={() => setBackendStatus('ok')}>Dismiss</button>
        </div>
      )}

      {/* Branding bar */}
      <header className="app-branding">
        <div className="branding-left">
          <img src={logo3speak} alt="3Speak" className="branding-logo" />
          <span className="branding-text">Shorts Editor <span className="branding-badge">beta</span></span>
          <span className="branding-info" title={`Backend: ${window.location.origin}`}>
            <Info size={14} />
          </span>
        </div>
        <DraftStatus drafts={drafts} canSignIn={canDraftSignIn} signInState={draftContext.reason} onSignIn={requestDraftSignIn} onOpenLimit={() => drafts.save()} />
        <button className="branding-close-btn" onClick={handleCloseEditor} title="Close editor">
          <X size={18} />
        </button>
      </header>

      <main className={`app-main ${isVerticalVideo ? 'layout-vertical' : ''}`}>
        <div className="left-panel">
          {/* Collapsible Clip Preview */}
          <div className={`collapsible-section ${previewOpen ? 'open' : 'closed'}`}>
            <button className="collapsible-header" onClick={() => setPreviewOpen(p => !p)}>
              {previewOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>Preview</span>
            </button>
            {previewOpen && (
              <div className="collapsible-body">
                <VideoPreview clip={previewItem} isVerticalVideo={isVerticalVideo} />
              </div>
            )}
          </div>

          {/* Collapsible Project Library */}
          <div className={`collapsible-section ${libraryOpen ? 'open' : 'closed'}`}>
            <button className="collapsible-header" onClick={() => setLibraryOpen(p => !p)}>
              {libraryOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>Project Library</span>
            </button>
            {libraryOpen && (
              <div className="collapsible-body">
                <ProjectLibrary
                  library={library}
                  selectedLibraryId={selectedLibraryId}
                  hlsDownloads={hlsDownloads}
                  onSelectItem={selectLibraryItem}
                  onRemoveItem={handleRemoveFromLibrary}
                  onAddToTimeline={addLibraryItemToTimeline}
                  onFilesAdded={handleFilesAdded}
                />
              </div>
            )}
          </div>

          {/* FFmpeg Status - only show while loading */}
          {loading && (
            <div className="ffmpeg-status">
              <span className="ffmpeg-loading">Loading FFmpeg... {Math.round(progress * 100)}%</span>
            </div>
          )}

          {/* Export Button */}
          <ExportButton
            tracks={tracks}
            clips={videoClips}
            backgroundMusic={audioClips[0] || null}
            ffmpegLoaded={loaded}
            ffmpegLoading={loading}
            exporting={exporting || canvasExporting}
            exportProgress={canvasExporting ? canvasExportProgress : exportProgress}
            exportPhase={exportPhase}
            onExport={processVideo}
            onCanvasExport={exportCanvas}
            onCancelExport={cancelExport}
            isIframe={isIframe}
            onRenderRequest={requestRender}
            renderStatus={renderStatus}
            onClearRenderStatus={clearRenderStatus}
            timelineEnd={timelineEnd}
            overLengthLimit={overLengthLimit}
            pendingUpload={activeUpload}
          />
        </div>

        <div className="center-panel">
          {/* Global Preview - only in center for horizontal */}
          {!isVerticalVideo && (
            <GlobalPreview
              emptyActions={emptyTimelineActions}
              tracks={tracks}
              playheadPosition={playheadPosition}
              onSetPlayhead={setPlayheadPosition}
              isVerticalVideo={isVerticalVideo}
              orientationOverride={orientationOverride}
              onSetOrientation={setOrientationOverride}
              selectedClipId={selectedClipId}
              onUpdateClip={updateClip}
              onSelectClip={selectClip}
              inlineRecording={inlineRecordingOpen}
              onRecordedInline={handleRecordedInline}
              onCloseInlineRecorder={handleCloseInlineRecorder}
              recorderGuide={recorderGuide}
              onChangeRemixMode={handleChangeRemixMode}
              onChangeStageLayout={handleChangeStageLayout}
              controlRef={previewControlRef}
              recorderSize={recorderSize}
              onSetRecorderSize={setRecorderSize}
            />
          )}

          {/* Toolbar: undo/redo + add media */}
          <div className="editor-toolbar">
            <div className="undo-redo-buttons">
              <button
                onClick={undo}
                disabled={!canUndo}
                title="Undo (Ctrl+Z)"
                className="undo-btn"
              >
                <Undo2 size={16} />
              </button>
              <button
                onClick={redo}
                disabled={!canRedo}
                title="Redo (Ctrl+Shift+Z)"
                className="redo-btn"
              >
                <Redo2 size={16} />
              </button>
            </div>
            <button className="add-media-btn" onClick={handleAddMedia} title="Add media to library">
              <FolderPlus size={16} />
              <span>Add Media</span>
            </button>
            <button className="add-media-btn" onClick={openRecorder} title="Record video from camera">
              <Video size={16} />
              <span>Record</span>
            </button>
            <input
              ref={addMediaInputRef}
              type="file"
              multiple
              accept="video/*,audio/*,image/*"
              style={{ display: 'none' }}
              onChange={handleAddMediaFiles}
            />
          </div>

          {/* Timeline */}
          <div className="timeline-section">
            <Timeline
              tracks={tracks}
              selectedClipId={selectedClipId}
              playheadPosition={playheadPosition}
              onSetPlayhead={setPlayheadPosition}
              onSelectClip={selectClip}
              onRemoveClip={handleRemoveClip}
              onUpdateClip={updateClip}
              onDuplicateClip={duplicateClip}
              onSplitClip={splitClip}
              onSplitAtPlayhead={splitClipAtPlayhead}
              onRemoveGap={removeGapAtPlayhead}
              isPlayheadOnGap={isPlayheadOnGap}
              onDuplicate={duplicateClip}
              onGroupClips={groupClips}
              onUngroupClips={ungroupClips}
              onAddTrack={addTrack}
              onAddTextClip={addTextClip}
              onAddColorClip={addColorClip}
              onRemoveTrack={handleRemoveTrack}
              onLibraryDrop={handleTimelineDrop}
              onMoveClipToTrack={moveClipToTrack}
              onAddFilesToTrack={addFilesToTrack}
              onRecordAudio={() => setRecordingAudioOpen(true)}
              onOpenMusic={() => setMusicOpen(true)}
              onOpenSfx={() => setSfxOpen(true)}
              onOpenStickers={() => setStickersOpen(true)}
              onRecordVideo={openRecorder}
              onReverseClip={handleReverseClip}
              onUpdateTrack={updateTrack}
              onAutoCut={setAutoCutClipId}
              onBeatSync={setBeatClipId}
              isDesktop={isDesktop}
            />
          </div>
        </div>

        {/* Reversing overlay (full layout) */}
        {reversingClipId && (
          <div className="hls-download-overlay">
            <div className="hls-download-modal">
              <h3>Reversing clip...</h3>
              <p>Processing on server, please wait.</p>
            </div>
          </div>
        )}

        {/* Right panel: properties for horizontal, timeline preview for vertical */}
        <div className="right-panel">
          {isVerticalVideo ? (
            <GlobalPreview
              emptyActions={emptyTimelineActions}
              tracks={tracks}
              playheadPosition={playheadPosition}
              onSetPlayhead={setPlayheadPosition}
              isVerticalVideo={isVerticalVideo}
              orientationOverride={orientationOverride}
              onSetOrientation={setOrientationOverride}
              selectedClipId={selectedClipId}
              onUpdateClip={updateClip}
              onSelectClip={selectClip}
              inlineRecording={inlineRecordingOpen}
              onRecordedInline={handleRecordedInline}
              onCloseInlineRecorder={handleCloseInlineRecorder}
              recorderGuide={recorderGuide}
              onChangeRemixMode={handleChangeRemixMode}
              onChangeStageLayout={handleChangeStageLayout}
              controlRef={previewControlRef}
              recorderSize={recorderSize}
              onSetRecorderSize={setRecorderSize}
            />
          ) : (
            <div className={`collapsible-section properties-section ${propertiesOpen ? 'open' : 'closed'}`}>
              <button className="collapsible-header" onClick={() => setPropertiesOpen(p => !p)}>
                {propertiesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>Properties{selectedClip ? ` — ${selectedClip.name}` : ''}</span>
              </button>
              {propertiesOpen && selectedClip && (
                <div className="collapsible-body">
                  <ClipProperties
                    clip={selectedClip}
                    linkedAudio={linkedAudioOf(selectedClip)}
                    onUpdateLinkedAudio={(u) => { const a = linkedAudioOf(selectedClip); if (a) updateClip(a.id, u) }}
                    onUpdateClip={(updates) => selectedClipId && updateClip(selectedClipId, updates)}
                    onSplit={(time) => selectedClipId && splitClip(selectedClipId, time)}
                    playheadPosition={playheadPosition}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Remix mode picker (whole video arriving from the remix button) */}
      {remixPrompt && <RemixModePicker onChoose={handleRemixChoice} />}
      {rejectedFiles.length > 0 && <TooLargeNotice files={rejectedFiles} onClose={dismissRejectedFiles} />}
      {lengthNotice && !remixPrompt && <LengthLimitNotice length={lengthNotice.length} onClose={dismissLengthNotice} />}
      {drafts.prompt && drafts.drafts?.length > 0 && (
        <DraftsPrompt drafts={drafts.drafts} limits={drafts.limits} onLoad={drafts.loadDraft} onStartNew={drafts.startNew} />
      )}
      {limitOpen && drafts.limitProjects.length > 0 && (
        <DraftLimitPicker
          projects={drafts.limitProjects}
          limits={drafts.limits}
          onReplace={async (id) => {
            const r = await drafts.resolveLimit(id)
            setLimitOpen(false)
            if (r.ok && closeAfterSaveRef.current) finishClose(true, closeDialog)
          }}
          onSkip={() => { drafts.resolveLimit(null); setLimitOpen(false) }}
        />
      )}
      {closeDialog && !limitOpen && (
        <CloseDialog
          uploading={library.filter(i => i.uploading).map(i => ({ name: i.name, size: i.file?.size || 0, progress: i.uploadProgress || 0 }))}
          drafts={{ ...drafts, save: async (o) => { closeAfterSaveRef.current = true; return drafts.save(o) } }}
          signedOut={draftContext.reason === 'logged-out'}
          canSignIn={canDraftSignIn}
    signInState={draftContext.reason}
          onSignIn={requestDraftSignIn}
          onClose={() => finishClose(true, closeDialog)}
          onCancel={() => finishClose(false, closeDialog)}
        />
      )}
      {beatClip && (
        <BeatSyncModal
          key={beatClip.id}
          clip={beatClip}
          source={beatSource}
          unavailable={beatClip && !beatSource ? 'This clip is still streaming from 3Speak. Try again once its download has finished.' : null}
          onSetBeats={(fields) => updateClip(beatClip.id, fields)}
          onFitClips={fitClipsToBeats}
          onClose={() => setBeatClipId(null)}
        />
      )}
      {autoCutClip && (
        <SilenceCutModal
          key={autoCutClip.id}
          clip={autoCutClip}
          source={autoCutSource}
          unavailable={autoCutUnavailable}
          onApply={handleAutoCutApply}
          onClose={() => setAutoCutClipId(null)}
        />
      )}

      {musicOpen && <MusicLibrary onPick={handlePickMusic} onClose={() => setMusicOpen(false)} />}

      {sfxOpen && <MusicLibrary kind="sfx" onPick={handlePickSfx} onClose={() => setSfxOpen(false)} />}

      {stickersOpen && <StickerPicker onPick={handlePickSticker} onClose={() => setStickersOpen(false)} />}

      {/* Record Video Modal */}
      {recordingOpen && (
        <RecordVideo
          onRecorded={handleRecordedFiles}
          onClose={() => setRecordingOpen(false)}
        />
      )}

      {/* Record Audio Modal */}
      {recordingAudioOpen && (
        <RecordAudio
          onRecorded={handleRecordedFiles}
          onClose={() => setRecordingAudioOpen(false)}
        />
      )}

      {/* HLS Download Overlay */}
      {activeHlsDownload && (
        <div className="hls-download-overlay">
          <div className="hls-download-modal">
            <Download size={32} className="hls-download-icon" />
            <h3>Downloading Media</h3>
            <p className="hls-download-name">{activeHlsDownload.name}</p>
            <div className="hls-download-progress-bar">
              <div
                className="hls-download-progress-fill"
                style={{ width: `${Math.round(activeHlsDownload.progress * 100)}%` }}
              />
            </div>
            <p className="hls-download-percent">{Math.round(activeHlsDownload.progress * 100)}%</p>
            <p className="hls-download-hint">Please wait while the media is being prepared...</p>
          </div>
        </div>
      )}

      {/* Upload Progress Overlay */}
      {encodingItems.length > 0 && (
        <EncodingNotice items={encodingItems} onClose={hideEncodingNotice} />
      )}

    </div>
  )
}

export default App
