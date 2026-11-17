import { useCallback, useEffect, useRef, useMemo, useState } from 'react'
import { Undo2, Redo2, ChevronDown, ChevronRight, FolderPlus, Video, X, Download, Upload, Send, Clapperboard, Info, Film, Image as ImageIcon, Music, Mic, AudioWaveform, LayoutTemplate, Gauge, Loader2, Bookmark, HelpCircle, Maximize, Minimize, Scissors, Play, Pause, MousePointerClick, Keyboard, ScrollText, Wand2 } from './components/icons'
import { useFFmpeg } from './hooks/useFFmpeg'
import { useCanvasExport } from './hooks/useCanvasExport'
import { useTimeline } from './hooks/useTimeline'
import { useUndoableState } from './hooks/useHistory'
import { useIframeApi } from './hooks/useIframeApi'
import { STOCK_ENABLED } from './utils/stockLibrary'
import { isHlsUrl } from './utils/hlsHelper'
import { reverseClipOnBackend } from './utils/reverseClip'
import { selectBackend, getBackendUrl, api } from './utils/backendSelector'
import Timeline from './components/Timeline'
import GlobalPreview from './components/GlobalPreview'
// opened on demand, each its own chunk (components/lazyPanels.jsx)
import { ProjectLibrary, VideoPreview, ExportButton, RecordVideo, RecordAudio, RemixModePicker, MusicLibrary, AudioTemplateDialog, ChaptersDialog, AudiogramDialog, BeatSyncModal, StickerPicker, StockLibrary, CaptionsPanel, ShortcutSheet, TitleTemplates } from './components/lazyPanels'
import ClipProperties from './components/ClipProperties'
import { routeAnimatedEdits, mediaView, mediaPartsToClip } from './utils/motionEdits'
import OnboardingTour, { AUDIO_TOUR_STEPS, RANGE_PICK_TOUR_STEPS, useFirstTimeTour } from './components/OnboardingTour'
import MultiClipProperties from './components/MultiClipProperties'
import { soundTargets } from './utils/multiSelect'
import { REMIX_LAYOUTS, hasLayout, clampLayout } from './utils/remixLayout'
import { MAX_TIMELINE_SECONDS, maxTimelineText, getTimelineEnd } from './utils/limits'
import LengthLimitNotice from './components/LengthLimitNotice'
import TooLargeNotice from './components/TooLargeNotice'
import SilenceCutModal, { loadSettings as loadAutoCutSettings } from './components/SilenceCutModal'
import { newChapter, moveChapter, resolveChapters, chapterSpans, chapterTime, MAX_CHAPTERS } from './utils/chapters'
import { duckPlans, clipDuckSetting, applyMasterDuck, DUCK_DEPTHS, DUCK_DEFAULT_DB } from './utils/duck'
import { trackNumbers, trackLabel } from './utils/trackNumbers'
import { addFlag, moveFlag, removeFlag, resolveFlags, cleanFlags } from './utils/flags'
import { useAudioTemplate } from './hooks/useAudioTemplate'
import { applyAudioTemplate, removeAudioTemplate, appliedRoles, hasSlots } from './utils/audioTemplate'
import { loadLoudness, planCuts } from './utils/silenceDetect'
import { combineLoudness, groupSpan, overlappingVoices } from './utils/groupSilence'
import { isAudioMode } from './utils/editorMode'
import { audiogramsToPost } from './utils/audiogramLayers'
import { audioFileName } from './utils/audioTemplate'
import { usePersonMasks } from './hooks/usePersonMasks'
import EncodingNotice from './components/EncodingNotice'
import ClipColorFilters from './components/ClipColorFilters'
import { outputSize } from './utils/outputSize'
import { DraftsPrompt, DraftLimitPicker, CloseDialog, DraftStatus } from './components/DraftsDialogs'
import { useDrafts, savedPlayhead } from './hooks/useDrafts'
import { useAutoCaptions } from './hooks/useAutoCaptions'
import { normalizeCaptions, suggestEmojis, DEFAULT_CAPTION_STYLE } from './utils/captions'
import { voiceTracksOf } from './utils/captionSources'
import ConfirmDialog from './components/ConfirmDialog'
import { useCleaningStatus, cleaningText } from './utils/cleaningStatus'
import { isTypingTarget } from './utils/keyboard'
import { isRenderActive } from './utils/renderQueue'
import { useShortcuts } from './hooks/useShortcuts'
import { useWordTools } from './components/WordTools'
import logo3speak from './assets/3speak.png'
import ProjectFormat from './components/ProjectFormat'
import FormatsPanel from './components/FormatsPanel'
import VideoPodcastDialog from './components/VideoPodcastDialog'
import { episodeCovers } from './utils/podcastEpisode'
import { finiteDuration } from './utils/mediaDuration'
import { useProjectFormat } from './hooks/useProjectFormat'
import { postFormat } from './utils/projectFormat'
import { useT } from './i18n'
import { stripPart } from './utils/partName'

// Audio editor: the talking = clips on audio tracks that are not music and not template parts
function voiceClipsOf(list) {
  return list
    .filter(t => t.type === 'audio' && !t.music && t.muted !== true)
    .flatMap(t => t.clips)
    .filter(c => !c.templateRole && c.audioEnabled !== false)
}

// Audio editor: what Cut silences can work on, clip by clip: any audio clip
// on any track (a voice can end up on the Music track), not template parts
function cuttableClipsOf(list) {
  return list
    .filter(t => t.type === 'audio' && t.muted !== true)
    .flatMap(t => t.clips)
    .filter(c => !c.templateRole && c.audioEnabled !== false)
}

// The audio editor's finishing settings, from a draft, a template or nothing
const masterOf = (m) => ({
  loudness: m?.loudness !== false,
  duck: m?.duck === true,
  duckDb: DUCK_DEPTHS.includes(+m?.duckDb) ? +m.duckDb : DUCK_DEFAULT_DB
})

function App() {
  const { t, lang, formatNumber, formatList } = useT()
  const percent = (p) => formatNumber(p, { style: 'percent', maximumFractionDigits: 0 })
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
    addStockClip,
    fitClipsToBeats,
    loadProjectState,
    addRemixRecording,
    removeFromLibrary,
    selectLibraryItem,
    addLibraryItemToTimeline,

    // Timeline
    tracks,
    selectedClipId,
    selectedClipIds,
    selectClips,
    selectedClip,
    playheadPosition,
    setPlayheadPosition,
    addTrack,
    updateTrack,
    removeTrack,
    removeClip,
    updateClip: updateClipPlain,
    selectClip,
    duplicateClip,
    splitClip,
    splitClipAtPlayhead,
    applySilenceCut,
    applyGroupSilenceCut,
    applyTracks,
    uploadFileToServer,
    removeGapAtPlayhead,
    isPlayheadOnGap,
    rippleTarget,
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
    history,
    lengthNotice,
    dismissLengthNotice,
    rejectedFiles,
    dismissRejectedFiles
  } = useTimeline()
  // An edit of an animated property (slider, drag on the preview) goes to its
  // keyframe at the playhead (utils/motionEdits.js); anything else as it is
  const updateClip = useCallback((clipId, updates) => {
    const clip = tracks.flatMap(t => t.clips).find(c => c.id === clipId)
    updateClipPlain(clipId, routeAnimatedEdits(clip, updates, playheadPosition))
  }, [tracks, playheadPosition, updateClipPlain])

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
    ? t('app.clipStreaming')
    : null
  const autoCutOpenRef = useRef(false)
  // Audio editor: M adds a chapter at the playhead (set further down)
  const addChapterRef = useRef(null)
  const playheadRef = useRef(0)
  // Audio editor: a clip grouped with other voices is cut together with them
  // (only where everyone is quiet, the same cut through every voice)
  const autoCutGroup = useMemo(() => {
    if (!isAudioMode || !autoCutClip?.groupId) return null
    const members = cuttableClipsOf(tracks).filter(c => c.groupId === autoCutClip.groupId)
    if (members.length < 2) return null
    return members.map(c => ({
      clip: c,
      source: fileStoreRef.current.get(c.id) || c.file || (isHlsUrl(c.url) ? null : c.url),
      analysisUrl: c.serverUrl || null
    }))
  }, [autoCutClip, tracks, fileStoreRef])
  const handleAutoCutApply = useCallback((parts, options) => {
    if (autoCutGroup) applyGroupSilenceCut(autoCutGroup.map(m => m.clip.id), parts, options)
    else applySilenceCut(autoCutClipId, mediaPartsToClip(autoCutClip, parts), options) // parts are in media seconds
    setAutoCutClipId(null)
    refitTemplateRef.current?.()
  }, [applySilenceCut, applyGroupSilenceCut, autoCutClipId, autoCutGroup, autoCutClip])
  // (refitTemplate is defined further down, with the template)
  const refitTemplateRef = useRef(null)

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
  playheadRef.current = playheadPosition

  // The audio editor (?mode=audio): podcasts, music, voice. Same timeline and
  // tools; an audio stage instead of the picture, MP3 out, a template.
  const audioMode = isAudioMode
  // Finishing settings of the audio editor (sent with the render, kept in drafts
  // and in the template): loudness levelling, music ducked under the voices
  // (these and the tracks are under undo: hooks/useHistory.js)
  const [master, setMaster, setMasterSilently] = useUndoableState(history, 'master', () => masterOf(null))
  // Chapters (utils/chapters.js): pinned to the recording, resolved to where they are now
  const [chapters, setChapters, setChaptersSilently] = useUndoableState(history, 'chapters', [])
  // The preview is playing (the timeline then keeps the playhead in the middle)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  // The timeline's zoom (px per second): saved with the draft, and handed back
  // to the timeline when a draft opens ({ value, key }: a new key re-applies it)
  const [timelineZoom, setTimelineZoom] = useState(null)
  const [restoreZoom, setRestoreZoom] = useState(null)
  const resolvedChapters = useMemo(() => (audioMode ? resolveChapters(tracks, chapters, timelineEnd) : []), [audioMode, tracks, chapters, timelineEnd])
  // Flags: the creator's own numbered markers (utils/flags.js), kept with the draft
  const [flags, setFlags, setFlagsSilently] = useUndoableState(history, 'flags', [])
  const resolvedFlags = useMemo(() => resolveFlags(tracks, flags, Math.max(timelineEnd, 0)), [tracks, flags, timelineEnd])
  const tracksNowRef = useRef(tracks)
  tracksNowRef.current = tracks
  const handleAddFlag = useCallback((at) => setFlags(f => addFlag(f, tracksNowRef.current, at)), [])
  const handleMoveFlag = useCallback((id, at) => setFlags(f => moveFlag(f, tracksNowRef.current, id, at)), [])
  const handleRemoveFlag = useCallback((id) => setFlags(f => removeFlag(f, id)), [])
  const addFlagRef = useRef(null)
  const chapterList = useMemo(() => chapterSpans(resolvedChapters, timelineEnd), [resolvedChapters, timelineEnd])
  // Every ducked clip's plan (its own Duck setting, or the top bar's for music)
  const duck = useMemo(() => (audioMode ? duckPlans(tracks) : null), [audioMode, tracks])
  // Name of the show: the first recording's name (the MP3's title and file name)
  const audioTitle = useMemo(() => {
    if (!audioMode) return null
    const first = tracks.filter(t => t.type === 'audio' && !t.music).flatMap(t => t.clips).find(c => !c.templateRole)
    return first ? stripPart(first.name).replace(/\.[a-z0-9]{2,4}$/i, '').trim() || null : null
  }, [audioMode, tracks])

  // The project's shape (utils/projectFormat.js): a Short (9:16, up to 2 minutes)
  // or a 16:9, 4:3 or 1:1 video (up to 10). The audio editor keeps the old frame.
  const projectFormat = useProjectFormat()
  const activeAspectRatio = audioMode ? '9:16' : projectFormat.aspect
  const isVerticalVideo = activeAspectRatio === '9:16'
  // Export as (FormatsPanel): the preview may show the project in another shape, reframed
  const [formatsOpen, setFormatsOpen] = useState(false)
  const [viewAspect, setViewAspect] = useState(null)
  const shownAspect = (formatsOpen && viewAspect) || activeAspectRatio
  const [orientationOverride, setOrientationOverride] = useState(null)

  // Auto captions of a Short (utils/captions.js): { words, language, style, burn } or null
  const [captions, setCaptions, setCaptionsSilently] = useUndoableState(history, 'captions', null)
  const [captionsOpen, setCaptionsOpen] = useState(false)

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
    remixing,
    restoreRemixSource,
    remixPrompt,
    clearRemixPrompt,
    playlistCovers,
    requestPlaylistCovers,
    podcastEpisode,
    clearPodcastEpisode,
    editTextInHost,
    buildAndUploadPayload
  } = useIframeApi({ addToLibraryAndTimeline, addMusicClip, tracks, library, playheadPosition, fileStoreRef, activeAspectRatio, onTogglePlay: togglePreviewPlay, audioMode, master, title: audioTitle, chapters: chapterList, captions: audioMode ? null : captions })

  // Word tools (components/WordTools.jsx): the transcript to edit by text,
  // Remove fillers, chapter ideas. wordRefitRef: the audio template refitted
  // after a cut, in the same undo step (set with the template further down)
  const wordRefitRef = useRef(null)
  const wordTools = useWordTools({ tracks, buildAndUploadPayload, applyTracks, undo, fileStoreRef, previewControlRef, setChapters, refitRef: wordRefitRef })

  // Auto captions: speech to text on the backend, then the words go on screen
  const autoCaptions = useAutoCaptions({ enabled: !audioMode })
  const transcribeCaptions = useCallback(async (language) => {
    const voiceTracks = voiceTracksOf(tracks)
    const r = await autoCaptions.start((onPhase) => buildAndUploadPayload(onPhase, { voiceTracks }), language)
    if (!r) return
    setCaptions(c => {
      const style = { ...DEFAULT_CAPTION_STYLE, ...(c?.style || {}) }
      return { words: style.emoji ? suggestEmojis(r.words) : r.words, language: r.language, style, burn: c?.burn !== false }
    })
  }, [tracks, autoCaptions.start, buildAndUploadPayload]) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply theme to document on mount and changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // First visit: the shorts editor and the audio editor each show their own
  // tour once (separate keys, so seeing one doesn't skip the other). Storage
  // can throw in a sandboxed iframe: then the tour just shows.
  const tourKey = isAudioMode ? '3speak-audio-tour-done' : '3speak-tour-done'
  const [showTour, setShowTour] = useState(() => {
    if (!isAudioMode && !compactMode) return false
    try { return !localStorage.getItem(tourKey) } catch { return true }
  })
  const finishTour = () => {
    try { localStorage.setItem(tourKey, '1') } catch { /* storage blocked */ }
    setShowTour(false)
  }
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

  // Full screen: the whole editor (inside 3Speak's popup the iframe allows it)
  const canFullscreen = typeof document !== 'undefined' && !!document.fullscreenEnabled
  const [isFullscreen, setIsFullscreen] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement)
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    else document.documentElement.requestFullscreen?.().catch(() => {})
  }, [])
  const toggleFullscreenRef = useRef(toggleFullscreen)
  toggleFullscreenRef.current = toggleFullscreen

  // "Remove ...?" in the editor's own dialog (components/ConfirmDialog.jsx), never window.confirm()
  const [confirmAsk, setConfirmAsk] = useState(null) // { message, onYes }
  const confirmRef = useRef(null)
  confirmRef.current = confirmAsk
  const askConfirm = useCallback((message, onYes) => setConfirmAsk({ message, onYes }), [])
  const closeConfirm = useCallback(() => setConfirmAsk(null), [])
  const acceptConfirm = useCallback(() => {
    const ask = confirmRef.current
    confirmRef.current = null
    setConfirmAsk(null)
    ask?.onYes()
  }, [])

  const handleRemoveClip = useCallback((clipId) => {
    askConfirm(t('app.confirm.removeClip'), () => removeClip(clipId))
  }, [removeClip, askConfirm])

  const handleRemoveClips = useCallback((clipIds) => {
    askConfirm(t('app.confirm.removeClips', { count: clipIds.length }), () => removeClip(clipIds))
  }, [removeClip, askConfirm])

  const handleRemoveFromLibrary = useCallback((itemId) => {
    askConfirm(t('app.confirm.removeLibraryItem'), () => removeFromLibrary(itemId))
  }, [removeFromLibrary, askConfirm])

  const handleRemoveTrack = useCallback((trackId) => {
    askConfirm(t('app.confirm.removeTrack'), () => removeTrack(trackId))
  }, [removeTrack, askConfirm])

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
      alert(t('app.reverse.failed', { error: err.message }))
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

  // FFmpeg.wasm is for the legacy layout's exports and whole-HLS downloads
  // only: loaded when one of them needs it, never on open (hooks/useFFmpeg.js)
  const legacyLayout = !compactMode && !audioMode
  useEffect(() => { if (legacyLayout) loadFFmpeg() }, [legacyLayout, loadFFmpeg])

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
        } else {
          // Client-side path: download full HLS in browser (FFmpeg.wasm loads for it)
          downloadedHlsRef.current.add(item.id)
          loadFFmpeg().then(ff => { if (ff) startHlsDownload(item.id, item.url, ff) })
        }
      }
    }
  }, [library, hlsDownloads, loadFFmpeg, startHlsDownload, startBackendClipPreparation])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // The Auto cut popup is open over the timeline
      if (autoCutOpenRef.current) {
        if (e.key === 'Escape') { setAutoCutClipId(null); setBeatClipId(null) }
        return
      }
      // A "Remove ...?" question is open: it handles Enter / Escape itself
      if (confirmRef.current) return

      // Space - play/pause the timeline preview, wherever the focus is, except
      // while typing text. A slider, checkbox, dropdown or button just used in
      // the settings keeps the focus, so it is let go first (otherwise its own
      // Space action, a toggle or a click on keyup, would run as well).
      if (e.key === ' ' || e.code === 'Space') {
        if (isTypingTarget(e.target)) return
        e.preventDefault()
        if (e.target !== document.body && typeof e.target.blur === 'function') e.target.blur()
        if (!spaceBlockedRef.current) previewControlRef.current?.togglePlay()
        return
      }

      // Ignore the other shortcuts in an input (arrows move a slider, Backspace edits text)
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return
      }

      // Ctrl/Cmd+A - select every clip on the timeline
      if (e.key === 'a' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        selectClips(tracksRef.current.flatMap(t => t.clips.map(c => c.id)))
        return
      }

      // F - full screen on / off
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && document.fullscreenEnabled) {
        e.preventDefault()
        toggleFullscreenRef.current()
        return
      }

      // Escape - nothing selected
      if (e.key === 'Escape' && (selectedClipIds.length || selectedClipId)) {
        selectClips([])
        return
      }

      // Delete key - remove selected clip (or all selected clips)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClipIds.length > 1) {
          e.preventDefault()
          handleRemoveClips(selectedClipIds)
        } else if (selectedClipId) {
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

      // B - a flag at the playhead
      if (e.key === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey && addFlagRef.current) {
        e.preventDefault()
        addFlagRef.current()
        return
      }

      // M - a chapter at the playhead (audio editor)
      if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey && addChapterRef.current) {
        e.preventDefault()
        addChapterRef.current()
      }

      // T - add text clip (shorts only): at the playhead, selected
      if (!audioMode && e.key === 't' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        const id = addTextClip()
        if (id) selectClip(id)
      }

      // Arrow keys - move playhead
      const PLAYHEAD_STEP = 0.1 // 100ms step
      const PLAYHEAD_STEP_LARGE = 1 // 1 second when holding shift
      const step = e.shiftKey ? PLAYHEAD_STEP_LARGE : PLAYHEAD_STEP

      // (Alt+arrows move between clips: hooks/useShortcuts.js)
      if (e.key === 'ArrowLeft' && !e.altKey) {
        e.preventDefault()
        setPlayheadPosition(prev => Math.max(0, prev - step))
      }

      if (e.key === 'ArrowRight' && !e.altKey) {
        e.preventDefault()
        setPlayheadPosition(prev => prev + step)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedClipId, selectedClipIds, selectClips, selectClip, handleRemoveClips, handleRemoveClip, splitClipAtPlayhead, undo, redo, setPlayheadPosition, ungroupClips, duplicateClip, isPlayheadOnGap, removeGapAtPlayhead, addTextClip, audioMode])

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
  // `place` { trackId, at }: a recording from a track's + menu goes there
  const handleRecordedFiles = useCallback(async (files, place = null) => {
    for (const file of files) {
      const type = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : null
      if (!type) continue

      // Use pre-uploaded URL if InlineRecorder already uploaded it
      const preUploadedUrl = file._serverUrl || null
      const url = preUploadedUrl || URL.createObjectURL(file)
      // durationHint: the recorder's own clock, for recordings that don't carry a length
      const added = await addToLibraryAndTimeline(url, file.name, type, { file, serverUrl: preUploadedUrl, durationHint: file._durationHint, ...(place || {}) })
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
  // The track whose + menu opened Music / Sound effects / Record audio (null:
  // the general add). The new audio goes on it, at the playhead.
  const [addTarget, setAddTarget] = useState(null)
  const openAdd = useCallback((what, trackId = null) => {
    setAddTarget(typeof trackId === 'string' ? trackId : null)
    if (what === 'music') setMusicOpen(true)
    else if (what === 'sfx') setSfxOpen(true)
    else setRecordingAudioOpen(true)
  }, [])
  const [stickersOpen, setStickersOpen] = useState(false)
  // Stock media sheet: null closed, {} adding at the playhead, { underClipId } a background for that clip
  const [stockOpen, setStockOpen] = useState(null)
  const [titlesOpen, setTitlesOpen] = useState(false) // Titles: motion scene templates
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
        title: t('app.remix.stitch'),
        mode,
        sourceClipId: remixSession.sourceClipId,
        hint: t(remixSession.before ? 'app.remix.stitchHintBefore' : 'app.remix.stitchHintAfter', { seconds: Math.floor(maxDuration) }),
        maxDuration,
        sync: false
      }
    }
    return {
      title: t('app.remix.reaction'),
      mode,
      sourceClipId: remixSession.sourceClipId,
      layouts: remixSession.layouts,
      timelineStart: remixSession.timelineStart || 0,
      hint: t('app.remix.reactionHint'),
      maxDuration,
      sync: true
    }
  }, [remixSession, lang]) // eslint-disable-line react-hooks/exhaustive-deps

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
        alert(t('app.remix.originalFillsLimit', { limit: maxTimelineText() }))
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
  // From a track's + menu: on that track at the playhead. The audio editor's
  // general add: a music track at the playhead. Shorts: background music from 0:00.
  const handlePickMusic = useCallback(async (track) => {
    const place = addTarget ? { trackId: addTarget, at: playheadPosition } : audioMode ? { at: playheadPosition } : null
    const clipId = await addMusicClip(track.url, `${track.title} - ${track.artist}`, track.credit, track.bpm, place)
    if (clipId) selectClip(clipId)
  }, [addMusicClip, selectClip, addTarget, playheadPosition, audioMode])

  // Stickers go in at the playhead (on a "Stickers" track above the footage)
  // Add Text (a track's + menu): at the playhead over the video, selected so its settings open
  const addTextHere = useCallback((trackId) => {
    const id = addTextClip(trackId)
    if (id) selectClip(id)
  }, [addTextClip, selectClip])

  // A title (motion scene) at the playhead, above the footage
  const handleAddTitle = useCallback((props) => {
    const clipId = addStickerClip({ kind: 'scene', props }, playheadPosition, props.endTime - props.startTime)
    if (clipId) selectClip(clipId)
  }, [addStickerClip, selectClip, playheadPosition])

  const handlePickSticker = useCallback((sticker) => {
    const clipId = addStickerClip(sticker, playheadPosition)
    if (clipId) selectClip(clipId)
  }, [addStickerClip, selectClip, playheadPosition])

  // Stock media (utils/stockPlacement.js): at the playhead, or behind a clip whose background is removed
  const handlePickStock = useCallback(async (item) => {
    const under = stockOpen?.underClipId || null
    const clipId = await addStockClip(item, playheadPosition, { underClipId: under })
    if (!clipId) return false
    if (!under) selectClip(clipId)
    return true
  }, [addStockClip, selectClip, playheadPosition, stockOpen])

  // Background removal without a green screen: mattes for the clips that have it on
  usePersonMasks(tracks, updateClip)

  // Sound effects go in at the playhead
  const handlePickSfx = useCallback(async (track) => {
    const clipId = await addSfxClip(track.url, track.title, playheadPosition, addTarget)
    if (clipId) selectClip(clipId)
  }, [addSfxClip, selectClip, playheadPosition, addTarget])

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
    return { name: item?.name || t('app.media'), progress: info.progress }
  }, [hlsDownloads, library, lang]) // eslint-disable-line react-hooks/exhaustive-deps

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
        <Film size={22} /> <span>{t('app.empty.addVideo')}</span>
      </button>
      <button type="button" onClick={() => emptyImageInputRef.current?.click()}>
        <ImageIcon size={22} /> <span>{t('app.empty.addImage')}</span>
      </button>
      <button type="button" onClick={() => emptyAudioInputRef.current?.click()}>
        <Music size={22} /> <span>{t('app.empty.addAudio')}</span>
      </button>
      <input ref={emptyVideoInputRef} type="file" accept="video/*" multiple hidden onChange={(e) => addFilesFromEmpty(e, 'video')} />
      <input ref={emptyImageInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFilesFromEmpty(e, 'image')} />
      <input ref={emptyAudioInputRef} type="file" accept="audio/*" multiple hidden onChange={(e) => addFilesFromEmpty(e, 'audio')} />
    </div>
  )

  // Audio editor, empty: add a recording, record one, or start from music
  const emptyAudioActions = (
    <div className="empty-timeline-actions">
      <button type="button" onClick={() => emptyAudioInputRef.current?.click()}>
        <Upload size={22} /> <span>{t('app.empty.addRecording')}</span>
      </button>
      <button type="button" onClick={() => openAdd('record')}>
        <Mic size={22} /> <span>{t('app.empty.record')}</span>
      </button>
      <button type="button" onClick={() => openAdd('music')}>
        <Music size={22} /> <span>{t('app.empty.music')}</span>
      </button>
      <input ref={emptyAudioInputRef} type="file" accept="audio/*,video/*" multiple hidden onChange={(e) => addFilesFromEmpty(e, 'audio')} />
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
    const name = uploading.length > 1 ? t('app.files', { count: uploading.length }) : (uploading[0].name || t('app.media'))
    return { name, progress: total ? done / total : 0, count: uploading.length }
  }, [library, lang]) // eslint-disable-line react-hooks/exhaustive-deps

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
  // A draft opened (not a new recording): its own template parts and settings stay as saved
  const draftLoadedRef = useRef(false)
  const loadSavedProject = useCallback((state) => {
    draftLoadedRef.current = true
    loadProjectState(state)
    // Back where the playhead was when the draft was saved, at the zoom it had
    setPlayheadPosition(savedPlayhead(state))
    if (Number.isFinite(+state?.zoom) && +state.zoom > 0) setRestoreZoom({ value: +state.zoom, key: Date.now() })
    // (silently: the opened draft is the first undo step, see loadProjectState)
    if (state?.master) setMasterSilently(masterOf(state.master))
    setChaptersSilently(Array.isArray(state?.chapters) ? state.chapters.slice(0, MAX_CHAPTERS) : [])
    setFlagsSilently(cleanFlags(state?.flags))
    setCaptionsSilently(normalizeCaptions(state?.captions) ? { ...state.captions, ...normalizeCaptions(state.captions) } : null)
    // the video project's shape (a draft from before shapes is a Short)
    if (!audioMode) { projectFormat.setAspect(state?.aspect); setViewAspect(null) }
    // the transcript (kept out of undo: its words are pinned to the recordings, so undoing a cut brings them back)
    wordTools.tr.load(state?.transcript)
    // a remix draft: its export posts under the original again
    restoreRemixSource(state?.remix || null)
    // and the clip(s) that were selected (those still on the timeline)
    const ids = new Set((state?.tracks || []).flatMap(t => (t.clips || []).map(c => c.id)))
    const sel = Array.isArray(state?.selected) ? state.selected.filter(id => ids.has(id)) : []
    if (sel.length) selectClips(sel)
  }, [loadProjectState, setPlayheadPosition, selectClips, restoreRemixSource, setMasterSilently, setChaptersSilently, setFlagsSilently, setCaptionsSilently, audioMode, projectFormat.setAspect]) // eslint-disable-line react-hooks/exhaustive-deps
  const drafts = useDrafts({
    session: draftSession,
    hasMedia: draftContext.hasMedia,
    tracks,
    library,
    loadProjectState: loadSavedProject,
    onUnauthorized: requestDraftSignIn,
    mode: audioMode ? 'audio' : 'video',
    master: audioMode ? master : null,
    chapters: audioMode ? chapters : null,
    playhead: playheadPosition,
    playing: previewPlaying,
    zoom: timelineZoom,
    flags,
    selected: selectedClipIds.length ? selectedClipIds : (selectedClipId ? [selectedClipId] : []),
    remix: remixing ? remixSource : null,
    captions: audioMode ? null : captions,
    aspect: audioMode ? null : activeAspectRatio,
    transcript: wordTools.tr.transcript
  })
  const canDraftSignIn = isIframe && !draftSession && ['sign-in-needed', 'sign-in-failed', 'signing-in'].includes(draftContext.reason)

  // ---- Audio editor: template, Cut silences for every voice clip ----
  const audioTemplate = useAudioTemplate({ session: draftSession, enabled: audioMode })
  const [templateOpen, setTemplateOpen] = useState(false)
  const [templateNotice, setTemplateNotice] = useState(null) // roles just applied, for the notice
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks

  // Put the saved template back around the content (after cuts moved the end)
  const refitTemplate = useCallback(() => {
    const tpl = audioTemplate.template
    if (!tpl || !appliedRoles(tracksRef.current).length) return
    applyTracks(t => applyAudioTemplate(t, tpl))
  }, [audioTemplate.template, applyTracks])
  wordRefitRef.current = (t) => (audioTemplate.template && appliedRoles(t).length ? applyAudioTemplate(t, audioTemplate.template) : t)

  const voiceClips = useMemo(() => (audioMode ? voiceClipsOf(tracks) : []), [audioMode, tracks])

  // "Cut silences" opens on the selected voice clip, else the longest one
  // Cut silences works on a clip (its group, if it has one): the selected one,
  // on any track; with none selected the longest voice clip, else the longest
  // audio clip
  const cuttableClips = useMemo(() => (audioMode ? cuttableClipsOf(tracks) : []), [audioMode, tracks])
  const openCutSilences = useCallback(() => {
    const longest = (list) => [...list].sort((a, b) => (b.endTime - b.startTime) - (a.endTime - a.startTime))[0]
    const sel = cuttableClips.find(c => c.id === selectedClipId)
    const target = sel || longest(voiceClips) || longest(cuttableClips)
    if (target) setAutoCutClipId(target.id)
  }, [voiceClips, cuttableClips, selectedClipId])

  // The same settings for every voice clip: last on the timeline first, so the
  // clips still to do are not moved by the cuts before them. Each file is read once.
  const [cutProgress, setCutProgress] = useState(null) // { done, total, failed }
  const cutAllSilences = useCallback(async (settings) => {
    setAutoCutClipId(null)
    // Units: a group of voices is cut as one (only where everyone is quiet, in
    // sync); every other voice clip on its own. Last on the timeline first.
    const voices = voiceClipsOf(tracksRef.current)
    const units = []
    const seenGroups = new Set()
    for (const c of voices) {
      const members = c.groupId ? voices.filter(v => v.groupId === c.groupId) : [c]
      if (members.length > 1) {
        if (seenGroups.has(c.groupId)) continue
        seenGroups.add(c.groupId)
      }
      units.push({ members, start: groupSpan(members).from })
    }
    units.sort((a, b) => b.start - a.start)
    if (!units.length) return { cut: 0, failed: 0 }
    const loudness = new Map()
    const loudnessOf = async (c) => {
      const local = fileStoreRef.current.get(c.id) || c.file || null
      const source = local || (isHlsUrl(c.url) ? null : c.url)
      const key = local || c.serverUrl || c.url
      if (!loudness.has(key)) loudness.set(key, await loadLoudness(source || c.serverUrl, { analysisUrl: c.serverUrl || null }))
      return loudness.get(key)
    }
    let cut = 0
    let failed = 0
    setCutProgress({ done: 0, total: units.length, failed: 0 })
    for (let i = 0; i < units.length; i++) {
      const { members } = units[i]
      try {
        if (members.length > 1) {
          const list = []
          for (const m of members) list.push({ clip: m, loudness: await loudnessOf(m) })
          const { from, to } = groupSpan(members)
          const { parts } = planCuts(combineLoudness(list), { from, to, ...settings, mode: 'remove' })
          const kept = parts.reduce((sum, p) => sum + (p.end - p.start), 0)
          if (parts.length && (parts.length > 1 || kept < (to - from) - 0.05)) {
            applyGroupSilenceCut(members.map(m => m.id), parts, { closeGaps: true })
            cut++
          }
        } else {
          const c = members[0]
          const { parts } = planCuts(await loudnessOf(c), { from: c.startTime, to: c.endTime, ...settings, mode: 'remove' })
          const kept = parts.reduce((sum, p) => sum + (p.end - p.start), 0)
          if (parts.length && (parts.length > 1 || kept < (c.endTime - c.startTime) - 0.05)) {
            applySilenceCut(c.id, parts, { closeGaps: true })
            cut++
          }
        }
      } catch (err) {
        console.warn(`[cut silences] ${members.map(m => m.name).join(' + ')}: ${err.message}`)
        failed++
      }
      setCutProgress({ done: i + 1, total: units.length, failed })
    }
    setCutProgress(failed ? { done: units.length, total: units.length, failed, finished: true } : null)
    if (cut) refitTemplate()
    return { cut, failed }
  }, [applySilenceCut, applyGroupSilenceCut, refitTemplate, fileStoreRef])
  refitTemplateRef.current = audioMode ? refitTemplate : null

  // A new recording gets the template by itself (when the creator asked for that):
  // silences cut first, then intro / outro / music bed around what is left.
  // Not for a draft that was opened, and only once per editor session.
  const autoTemplateRef = useRef(false)
  const hasVoice = voiceClips.length > 0
  useEffect(() => {
    if (!audioMode || autoTemplateRef.current || !hasVoice) return
    if (draftLoadedRef.current) { autoTemplateRef.current = true; return }
    const tpl = audioTemplate.template
    if (tpl === undefined) return // not known yet (the sign-in may still come)
    autoTemplateRef.current = true
    if (!tpl || tpl.autoApply === false || appliedRoles(tracksRef.current).length) return
    ;(async () => {
      setMaster(masterOf(tpl.master))
      if (tpl.silence?.enabled) await cutAllSilences({ ...loadAutoCutSettings(), ...tpl.silence })
      if (hasSlots(tpl)) {
        applyTracks(t => applyAudioTemplate(t, tpl))
        setTemplateNotice(Object.keys(tpl.slots || {}))
      }
    })()
  }, [audioMode, hasVoice, audioTemplate.template]) // eslint-disable-line react-hooks/exhaustive-deps

  // "Group with other voices": the clip and what plays at the same time on the
  // other voice tracks become one group (they then move, trim and get cut together)
  const [groupNotice, setGroupNotice] = useState(null)
  const groupWithVoices = useCallback((clipId) => {
    const ids = overlappingVoices(tracksRef.current, clipId)
    if (ids.length < 2) {
      setGroupNotice(t('app.group.nothing'))
      return
    }
    groupClips(ids)
    setGroupNotice(t('app.group.done', { count: ids.length }))
  }, [groupClips])

  // Chapters: added at the playhead (M), renamed, moved, removed
  const [chaptersOpen, setChaptersOpen] = useState(false)
  // Audiograms (after an export): the ones made, the piece of the timeline
  // they are made from, and picking that piece on the timeline
  const [audiogramOpen, setAudiogramOpen] = useState(false)
  // A published episode's length (open-video-podcast): given, or read from the audio
  const [episodeLength, setEpisodeLength] = useState(null)
  useEffect(() => {
    if (!podcastEpisode) { setEpisodeLength(null); return undefined }
    if (podcastEpisode.durationSec) { setEpisodeLength(podcastEpisode.durationSec); return undefined }
    let live = true
    const el = new Audio()
    el.preload = 'metadata'
    el.addEventListener('loadedmetadata', () => { finiteDuration(el).then(d => { if (live) setEpisodeLength(d || 0) }) }, { once: true })
    el.addEventListener('error', () => { if (live) setEpisodeLength(0) }, { once: true })
    el.src = podcastEpisode.url
    return () => { live = false; el.removeAttribute('src') }
  }, [podcastEpisode])

  // Video podcast: the whole episode as a 16:9 video (VideoPodcastDialog)
  const [videoPodcastOpen, setVideoPodcastOpen] = useState(false)
  const [audiograms, setAudiograms] = useState([])
  const [audiogramRange, setAudiogramRange] = useState(null)
  const [pickingRange, setPickingRange] = useState(false)
  const rangeBeforePickRef = useRef(null)
  const addAudiogram = useCallback((a) => setAudiograms(list => [...list, a]), [])
  const updateAudiogram = useCallback((id, patch) => setAudiograms(list => list.map(a => (a.id === id ? { ...a, ...patch } : a))), [])
  const removeAudiogram = useCallback((id) => setAudiograms(list => list.filter(a => a.id !== id)), [])
  // Listening to the piece while picking: plays from its start, stops at its
  // end and goes back to the start (Play the piece, or Space)
  const [rangePreview, setRangePreview] = useState(false)
  const rangeRef = useRef(audiogramRange)
  rangeRef.current = audiogramRange
  const rangePreviewRef = useRef(false)
  rangePreviewRef.current = rangePreview
  const sawRangePlayRef = useRef(false)
  const stopRangePreview = useCallback((rewind = true) => {
    setRangePreview(false)
    previewControlRef.current?.pause()
    if (rewind && rangeRef.current) previewControlRef.current?.seek(rangeRef.current.start)
  }, [])
  const toggleRangePreview = useCallback(() => {
    const r = rangeRef.current
    if (rangePreviewRef.current) { stopRangePreview(); return }
    if (!r || r.end == null || r.end - r.start < 3) return
    sawRangePlayRef.current = false
    setRangePreview(true)
    previewControlRef.current?.playFrom(r.start)
  }, [stopRangePreview])
  useEffect(() => {
    if (!rangePreview) return
    const id = setInterval(() => {
      const pos = previewControlRef.current?.getPosition?.()
      const r = rangeRef.current
      if (!r || r.end == null || (typeof pos === 'number' && pos >= r.end - 0.03)) stopRangePreview()
    }, 25)
    return () => clearInterval(id)
  }, [rangePreview, stopRangePreview])
  // the preview stopped by itself (the end of the episode, or paused elsewhere)
  useEffect(() => {
    if (!rangePreview) return
    if (previewPlaying) sawRangePlayRef.current = true
    else if (sawRangePlayRef.current) stopRangePreview()
  }, [rangePreview, previewPlaying, stopRangePreview])
  // a new piece: stop listening to the old one
  useEffect(() => {
    if (rangePreviewRef.current) stopRangePreview()
  }, [audiogramRange, stopRangePreview])

  const startPickingRange = useCallback(() => {
    previewControlRef.current?.pause()
    rangeBeforePickRef.current = audiogramRange
    // the piece picked before (if any) shows as a band; else the first click marks the start
    setAudiogramOpen(false)
    setPickingRange(true)
  }, [audiogramRange])
  const finishPickingRange = useCallback((keep) => {
    if (rangePreviewRef.current) stopRangePreview(false)
    if (!keep) setAudiogramRange(rangeBeforePickRef.current)
    setPickingRange(false)
    setAudiogramOpen(true)
  }, [stopRangePreview])
  // The first time a piece is picked: a short tour of how
  const [showPickTour, finishPickTour] = useFirstTimeTour('3speak-audiogram-pick-tour-done', audioMode && pickingRange)
  // While picking, the editor is locked (App.css .picking-range): no clicks
  // outside the timeline, and no shortcuts. Escape cancels, Enter uses the
  // piece (on a button of the bar: that button), Space plays or stops the piece.
  useEffect(() => {
    if (!pickingRange) return
    const onKey = (e) => {
      if (e.key === 'Tab') return
      e.stopPropagation()
      // Enter on a button of the bar or the tour: that button
      if (e.key === 'Enter' && e.target.closest?.('.range-pick-bar button, .tour-overlay button')) return
      e.preventDefault()
      const r = rangeRef.current
      if (e.key === 'Escape') finishPickingRange(false)
      else if (e.key === 'Enter' && r && r.end != null && r.end - r.start >= 3) finishPickingRange(true)
      else if (e.key === ' ' && !e.repeat) toggleRangePreview()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pickingRange, finishPickingRange, toggleRangePreview])
  // "Use this audio" / "Send Video": the export goes to 3Speak
  const [askAudiograms, setAskAudiograms] = useState(false)
  const askedAudiogramsRef = useRef(new Set()) // exports already asked about audiograms
  const sendToHostRef = useRef(null)
  const sendToHost = () => sendToHostRef.current?.()
  const cleaning = useCleaningStatus()
  // Duck is a clip setting only. A whole-show Duck (an old draft, or a
  // template with "duck the music") becomes the music clips' own setting.
  useEffect(() => {
    if (!audioMode || !master.duck) return
    applyTracks(ts => applyMasterDuck(ts, master))
    setMaster(m => ({ ...m, duck: false }))
    // part of the step that brought the Duck (a draft, a template), not one of its own
    history.amend()
  }, [audioMode, master.duck]) // eslint-disable-line react-hooks/exhaustive-deps
  const [chapterFocus, setChapterFocus] = useState(null)
  const addChapter = useCallback((at) => {
    setChapters(list => {
      if (list.length >= MAX_CHAPTERS) return list
      const ch = newChapter(tracksRef.current, at, list.length === 0 && at < 1 ? t('app.chapters.intro') : t('app.chapters.numbered', { n: list.length + 1 }))
      setChapterFocus(ch.id)
      return [...list, ch]
    })
  }, [])
  const renameChapter = useCallback((id, title) => setChapters(list => list.map(c => (c.id === id ? { ...c, title: String(title).slice(0, 80) } : c))), [])
  const moveChapterTo = useCallback((id, at) => setChapters(list => list.map(c => (c.id === id ? moveChapter(tracksRef.current, c, at) : c))), [])
  const removeChapter = useCallback((id) => setChapters(list => list.filter(c => c.id !== id)), [])
  // M: a chapter at the playhead (and the list opens so it can be named)
  addChapterRef.current = audioMode ? () => { addChapter(playheadRef.current); setChaptersOpen(true) } : null
  addFlagRef.current = () => handleAddFlag(playheadPositionRef.current)

  const applyTemplateNow = useCallback((tpl) => {
    applyTracks(t => applyAudioTemplate(t, tpl))
    setMaster(masterOf(tpl.master))
    setTemplateNotice(Object.keys(tpl.slots || {}))
  }, [applyTracks])
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

  // waiting in the render queue counts too (utils/renderQueue.js)
  const isBackendRendering = !!renderStatus && isRenderActive(renderStatus.status)

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

  // Audio editor: a change to every clip of one recording (by its uploaded
  // original; Cut silences makes many clips of one file), one undo step
  // Clip by clip, each its own fields, one undo step (voice clean-up)
  const updateClipsEach = useCallback((changes) => {
    if (!changes?.length) return
    const byId = new Map(changes.map(ch => [ch.id, ch.updates]))
    applyTracks(ts => ts.map(t => ({ ...t, clips: t.clips.map(c => (byId.has(c.id) ? { ...c, ...byId.get(c.id) } : c)) })))
  }, [applyTracks])

  // A clip's Duck in the panel: its setting, and what it can listen to (any
  // voice, or one of the other audio tracks)
  const duckInfoFor = (clip) => {
    const track = clip && tracks.find(t => t.type === 'audio' && t.clips.some(c => c.id === clip.id))
    if (!track) return null
    const numbers = trackNumbers(tracks)
    const others = tracks.filter(t => t.type === 'audio' && t.id !== track.id)
    return {
      setting: clipDuckSetting(clip, track),
      // every other track by its number and name, then all voice tracks at once
      sources: [
        ...others.sort((a, b) => numbers.get(a.id) - numbers.get(b.id)).map(t => ({ id: t.id, label: trackLabel(t, numbers) })),
        { id: 'voices', label: t('app.duck.allVoices') }
      ],
      // a new Duck listens to the first other voice track (else the first other track)
      defaultSource: (others.find(t => !t.music) || others[0])?.id || 'voices'
    }
  }

  // Audio clips plus the rest of their groups (not template parts): what the
  // voice clean-up applies to (clip level, except a clip in a group)
  const withGroups = (clips) => {
    const all = tracks.filter(t => t.type === 'audio').flatMap(t => t.clips).filter(c => !c.templateRole)
    const groups = new Set(clips.map(c => c.groupId).filter(Boolean))
    const out = new Map(clips.filter(c => c.type === 'audio').map(c => [c.id, c]))
    for (const c of all) if (groups.has(c.groupId)) out.set(c.id, c)
    return [...out.values()]
  }

  // The audio-track clip a video's sound plays from (same group, type audio)
  const linkedAudioOf = (clip) => (clip?.type === 'video' && clip.groupId
    ? tracks.flatMap(t => t.clips).find(c => c.groupId === clip.groupId && c.type === 'audio') || null
    : null)

  // Clip settings in the compact layout: on phones the clip opened with
  // "Options" (a panel over the timeline); on desktop a sidebar that follows
  // the selected clip
  const sideClip = compactPropertiesClip || (isDesktop ? selectedClip : null)

  // Phones: Select mode, each tap on a clip adds or removes it (the panel
  // waits until Done, as it would cover the timeline)
  const [selectMode, setSelectMode] = useState(false)

  // Group what is selected (their existing groups come along: a video's
  // sound is linked to it through its group), or ungroup a selection that is
  // one group
  const groupSelection = (clipIds) => {
    const all = tracks.flatMap(t => t.clips)
    const clips = all.filter(c => clipIds.includes(c.id))
    const groups = new Set(clips.map(c => c.groupId).filter(Boolean))
    const ids = new Set(clips.map(c => c.id))
    for (const c of all) if (groups.has(c.groupId)) ids.add(c.id)
    groupClips([...ids])
  }

  // Several clips selected: one panel for all of them (volume, mute, voice)
  const multiClips = useMemo(() => {
    if (selectedClipIds.length < 2) return []
    const ids = new Set(selectedClipIds)
    return tracks.flatMap(t => t.clips).filter(c => ids.has(c.id))
  }, [selectedClipIds, tracks])
  const multiTargets = soundTargets(multiClips, linkedAudioOf)
  const updateClips = (updates) => {
    const ids = new Set(multiTargets.map(c => c.id))
    applyTracks(ts => ts.map(t => ({ ...t, clips: t.clips.map(c => (ids.has(c.id) ? { ...c, ...updates } : c)) })))
  }
  const multiPanel = multiClips.length > 1 && !(selectMode && !isDesktop) ? (
          <div className="compact-properties-panel multi-clip-panel">
            <div className="compact-properties-header">
              <span className="compact-properties-title">{t('app.side.clipsSelected', { count: multiClips.length })}</span>
              <button className="compact-btn compact-properties-close" onClick={() => selectClips([])} title={t('app.side.clearSelection')}>
                <X size={14} />
              </button>
            </div>
            <MultiClipProperties
              clips={multiTargets}
              audioMode={audioMode}
              onUpdateClips={updateClips}
              voiceTargets={audioMode ? withGroups(multiTargets) : null}
              onUpdateClipsEach={audioMode ? updateClipsEach : null}
              onRemove={() => handleRemoveClips(multiClips.map(c => c.id))}
              count={multiClips.length}
            />
          </div>
  ) : null
  // Speed, freeze frames and keyframes in the clip settings (SpeedControls, KeyframeControls)
  const retimeCaptions = useCallback((map) => setCaptions(c => (c?.words?.length
    ? { ...c, words: c.words.map(w => ({ ...w, start: map(w.start), end: Math.max(map(w.start), map(w.end)) })) }
    : c)), [])
  const motionKit = { tracks, applyTracks, fileStoreRef, retimeCaptions, setPlayhead: setPlayheadPosition, captions }
  const compactPropertiesPanel = sideClip ? (
          <div className="compact-properties-panel">
            <div className="compact-properties-header">
              <span className="compact-properties-title">{sideClip.name}</span>
              <button
                className="compact-btn compact-properties-close"
                onClick={() => { setCompactPropertiesClipId(null); if (isDesktop) selectClip(null) }}
                title={t('app.side.closeProperties')}
              >
                <X size={14} />
              </button>
            </div>
            <ClipProperties
              clip={sideClip}
              linkedAudio={linkedAudioOf(sideClip)}
              tracks={audioMode ? null : tracks}
              onUpdateLinkedAudio={(u) => { const a = linkedAudioOf(sideClip); if (a) updateClip(a.id, u) }}
              onUpdateClip={(updates) => updateClip(sideClip.id, updates)}
              onSplit={() => splitClip(sideClip.id)}
              voiceTargets={audioMode ? withGroups([sideClip]) : null}
              onUpdateClipsEach={audioMode ? updateClipsEach : null}
              duckInfo={audioMode ? duckInfoFor(sideClip) : null}
              playheadPosition={playheadPosition}
              tabbed={!isDesktop}
              motionKit={audioMode ? null : motionKit}
              onPickBackground={STOCK_ENABLED ? (clipId) => setStockOpen({ underClipId: clipId }) : null}
            />
          </div>
  ) : null

  // Export as: one of the other shapes, rendered by the panel
  const sendFormatToHost = ({ outputUrl, aspect, subtitles }) => {
    if (drafts.hasEdits()) drafts.save().catch(() => {})
    sendToParent('post-to-3speak', {
      outputUrl,
      ...(remixSource && { remixSource }),
      ...(musicCredits.length > 0 && { musicCredits }),
      ...(subtitles && { subtitles }),
      format: postFormat(aspect, timelineEnd)
    })
  }
  const formatsPanel = formatsOpen && !audioMode ? (
    <div className="compact-properties-panel captions-side">
      <div className="compact-properties-header">
        <span className="compact-properties-title">{t('render.exportAs.button')}</span>
        <button className="compact-btn compact-properties-close" onClick={() => { setFormatsOpen(false); setViewAspect(null) }} title={t('render.exportAs.close')}>
          <X size={14} />
        </button>
      </div>
      <FormatsPanel
        projectAspect={activeAspectRatio}
        viewAspect={viewAspect}
        onViewAspect={setViewAspect}
        tracks={tracks}
        fileStore={fileStoreRef.current}
        onUpdateClip={updateClip}
        selectedClipId={selectedClipId}
        onSelectClip={selectClip}
        timelineEnd={timelineEnd}
        buildPayload={(aspect, onPhase) => buildAndUploadPayload(onPhase, { aspect })}
        canRender={videoClips.length > 0 && !activeUpload && !isBackendRendering}
        renderBlocked={activeUpload ? t('render.exportAs.waitUpload') : null}
        canSend={isIframe}
        onSend={sendFormatToHost}
      />
    </div>
  ) : null

  // Auto captions (Shorts editor): in the clip settings' place while open, so
  // the canvas stays in sight and shows every change live
  const captionsPanel = captionsOpen && !audioMode ? (
    <div className="compact-properties-panel captions-side">
      <div className="compact-properties-header">
        <span className="compact-properties-title">{t('app.side.captions')}</span>
        <button className="compact-btn compact-properties-close" onClick={() => setCaptionsOpen(false)} title={t('app.side.closeCaptions')}>
          <X size={14} />
        </button>
      </div>
      <CaptionsPanel
        captions={captions}
        onChange={setCaptions}
        status={autoCaptions.status}
        job={autoCaptions.job}
        onTranscribe={transcribeCaptions}
        onCancel={autoCaptions.cancel}
        onSeek={setPlayheadPosition}
        playheadPosition={playheadPosition}
      />
    </div>
  ) : null

  // The transcript (edit by text), in the same place while open
  const transcriptPanel = wordTools.transcriptPanel({ playheadPosition, playing: previewPlaying, onSeek: setPlayheadPosition })

  // Desktop: the selected clip's settings in a sidebar. The audio editor puts
  // it beside the stage only, so the timeline gets the full width below.
  const sideBesideStage = isDesktop && audioMode
  const sidePanel = (
    <aside className="compact-side">
      {formatsPanel || captionsPanel || transcriptPanel || multiPanel || (sideClip ? compactPropertiesPanel : (
        <div className="compact-side-empty">
          <MousePointerClick size={28} />
          <strong>{t('app.side.noClip')}</strong>
          <p>{t('app.side.noClipHint')}</p>
        </div>
      ))}
    </aside>
  )

  // A voice clean-up running (utils/cleaningStatus.js): stays on screen while
  // other clips are selected, until the cleaned audio is in
  const cleaningNotice = cleaning ? (
    <div className="cleaning-notice" role="status" aria-live="polite">
      <Loader2 size={15} className="encoding-notice-spin" />
      <span>{cleaningText(cleaning)}</span>
      <small>{t('app.cleaningHint')}</small>
    </div>
  ) : null

  // J / K / L, frame steps, moving between clips, the `?` sheet (hooks/useShortcuts.js)
  const shortcuts = useShortcuts({
    previewRef: previewControlRef,
    playing: previewPlaying,
    tracks,
    duration: timelineEnd,
    selectedClipId,
    selectClip,
    setPlayheadPosition,
    openClip: (id) => { if (compactMode || audioMode) setCompactPropertiesClipId(id); else setPropertiesOpen(true) }
  })
  const shortcutLayer = (
    <>
      {shortcuts.sheetOpen && <ShortcutSheet mode={audioMode ? 'audio' : 'video'} onClose={() => shortcuts.setSheetOpen(false)} />}
      <div className="editor-sr-only" role="status" aria-live="polite">{shortcuts.announcement}</div>
    </>
  )

  const confirmDialog = confirmAsk ? (
    <ConfirmDialog message={confirmAsk.message} onConfirm={acceptConfirm} onCancel={closeConfirm} />
  ) : null

  // The audio editor only exists in the compact layout
  if (compactMode || audioMode) {
    // What "Use this audio" / "Send Video" sends (after the audiograms question, if asked)
  sendToHostRef.current = () => {
    setShowPreview(false)
    // Sent: the draft stays, saved as it is now. The upload on 3Speak
    // can still be cancelled; the draft then still has the project.
    // It goes when it expires or a new project replaces it.
    if (drafts.hasEdits()) drafts.save().catch(() => {})
    sendToParent('post-to-3speak', {
      outputUrl: renderStatus.outputUrl,
      ...(audioMode && { mediaType: 'audio', fileName: audioFileName(audioTitle), durationSec: Math.round(timelineEnd * 1000) / 1000 }),
      // [{ start, end, title }]: 3Speak lists them in the description
      ...(audioMode && chapterList.length > 0 && { chapters: chapterList }),
      // The audiograms: 3Speak posts them as Shorts linking to the episode
      ...(audioMode && audiogramsToPost(audiograms).length > 0 && { audiograms: audiogramsToPost(audiograms) }),
      ...(remixSource && { remixSource }),
      ...(musicCredits.length > 0 && { musicCredits }),
      // Auto captions as subtitles: { language, vttUrl, srtUrl, cues: [{ start, end, text }] }
      ...(!audioMode && renderStatus.subtitles && { subtitles: renderStatus.subtitles }),
      // The shape: 3Speak posts a 9:16 render as a Short, the others as a normal video
      ...(!audioMode && { format: postFormat(activeAspectRatio, timelineEnd) })
    })
  }

  return (
      <div className={`app compact${isDesktop ? ' desktop' : ''}${audioMode && pickingRange ? ' picking-range' : ''}`}>
        <ClipColorFilters tracks={tracks} frame={outputSize(activeAspectRatio)} />
        {/* Backend health warning */}
        {backendStatus === 'error' && (
          <div className="backend-warning">
            {t('app.backendDown')}
            <button onClick={() => setBackendStatus('ok')}>{t('app.dismiss')}</button>
          </div>
        )}

        {/* Branding bar */}
        <header className="app-branding">
          <div className="branding-left">
            <img src={logo3speak} alt="3Speak" className="branding-logo" />
            <span className="branding-text">{audioMode ? t('app.branding.audioEditor') : isVerticalVideo ? t('app.branding.shortsEditor') : t('app.branding.videoEditor')} <span className="branding-badge">{t('app.branding.beta')}</span></span>
            {!audioMode && <ProjectFormat aspect={activeAspectRatio} onChange={(a) => { projectFormat.setAspect(a); setViewAspect(null) }} tracks={tracks} />}
            <span className="branding-info" onClick={() => setShowBackendInfo(prev => !prev)}>
              <Info size={14} />
              {showBackendInfo && (
                <span className="branding-info-popup">{selectedBackendUrl ? t('app.branding.backend', { url: selectedBackendUrl }) : t('app.branding.backendSelecting')}</span>
              )}
            </span>
            {audioMode && (
              <button className="branding-help-btn" onClick={() => setShowTour(true)} title={t('app.branding.showTour')} aria-label={t('app.branding.showTour')}>
                <HelpCircle size={15} />
              </button>
            )}
            {isDesktop && (
              <button className="branding-help-btn" onClick={() => shortcuts.setSheetOpen(true)} title={t('app.branding.shortcuts')} aria-label={t('app.branding.shortcutsLabel')}>
                <Keyboard size={15} />
              </button>
            )}
          </div>
          <DraftStatus drafts={drafts} canSignIn={canDraftSignIn} signInState={draftContext.reason} onSignIn={requestDraftSignIn} onOpenLimit={() => drafts.save()} />
          {canFullscreen && (
            <button
              className="branding-close-btn branding-fullscreen-btn"
              onClick={(e) => { e.currentTarget.blur(); toggleFullscreen() }}
              title={isFullscreen ? t('app.branding.leaveFullscreen') : t('app.branding.fullscreen')}
              aria-label={isFullscreen ? t('app.branding.leaveFullscreenLabel') : t('app.branding.fullscreenLabel')}
              aria-pressed={isFullscreen}
            >
              {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
            </button>
          )}
          <button className="branding-close-btn" onClick={handleCloseEditor} title={t('app.branding.closeEditor')}>
            <X size={16} />
          </button>
        </header>

        {/* Compact menu bar: undo/redo + render (centered) */}
        <div className="compact-menu-bar">
          <div className="compact-menu-left">
            <button
              onClick={undo}
              disabled={!canUndo}
              title={t('app.menu.undo')}
              className="compact-btn"
            >
              <Undo2 size={16} />
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              title={t('app.menu.redo')}
              className="compact-btn"
            >
              <Redo2 size={16} />
            </button>
          </div>
          <div className="compact-menu-center">
            <button
              className={renderStatus?.status === 'completed' ? 'compact-download-btn' : 'compact-render-btn'}
              onClick={() => { clearRenderStatus(); requestRender() }}
              disabled={(audioMode ? audioClips.length === 0 : videoClips.length === 0) || (exporting || canvasExporting) || isBackendRendering || overLengthLimit || !!activeUpload || !!cutProgress}
              title={overLengthLimit ? t(audioMode ? 'render.button.trimToExport' : 'render.button.trimToRender', { limit: maxTimelineText() }) : undefined}
            >
              {audioMode ? <AudioWaveform size={14} /> : <Clapperboard size={14} />}
              <span>{isBackendRendering ? (audioMode ? t('render.button.exporting') : t('render.button.rendering')) : activeUpload ? t('render.button.uploading', { percent: percent(activeUpload.progress) }) : renderStatus?.status === 'completed' ? (audioMode ? t('render.button.exportAgain') : t('render.button.reRender')) : (audioMode ? t('common.export') : t('common.render'))}</span>
            </button>
            {!audioMode && (
              <button
                className={`compact-download-btn${formatsOpen ? ' active' : ''}`}
                onClick={() => { setFormatsOpen(o => !o); setViewAspect(null) }}
                disabled={videoClips.length === 0}
                aria-pressed={formatsOpen}
                title={t('render.exportAs.title')}
              >
                <Film size={14} />
                <span>{t('render.exportAs.button')}</span>
              </button>
            )}
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
                  <span>{t('render.done.download')}</span>
                </a>
                {audioMode && (
                  <button className="compact-download-btn" onClick={() => setAudiogramOpen(true)} title={t('render.done.audiogramsTitle')}>
                    <Film size={14} />
                    <span>{audiograms.length ? t('render.done.audiogramsCount', { n: audiograms.length }) : t('render.done.audiograms')}</span>
                  </button>
                )}
                {audioMode && (
                  <button className="compact-download-btn" onClick={() => setVideoPodcastOpen(true)} title={t('render.done.videoPodcastTitle')}>
                    <Film size={14} />
                    <span>{t('render.done.videoPodcast')}</span>
                  </button>
                )}
                {isIframe && (
                  <button
                    className="compact-render-btn"
                    onClick={() => setShowPreview(true)}
                  >
                    <Send size={14} />
                    <span>{audioMode ? t('render.done.useAudio') : t('render.done.sendVideo')}</span>
                  </button>
                )}
              </>
            )}
          </div>
          <div className="compact-menu-right">
            {audioMode && (
              <>
                <button
                  className="compact-btn compact-tool-btn tour-cut-silences"
                  onClick={openCutSilences}
                  disabled={!cuttableClips.length || !!cutProgress}
                  title={t('app.audioTools.cutSilencesTitle')}
                  aria-label={t('app.audioTools.cutSilences')}
                >
                  <AudioWaveform size={15} /><span>{t('app.audioTools.cutSilences')}</span>
                </button>
                <button
                  className={`compact-btn compact-tool-btn tour-template${appliedRoles(tracks).length ? ' active' : ''}`}
                  onClick={() => setTemplateOpen(true)}
                  title={t('app.audioTools.templateTitle')}
                  aria-label={t('app.audioTools.template')}
                >
                  <LayoutTemplate size={15} /><span>{t('app.audioTools.template')}</span>
                </button>
                <button
                  className={`compact-btn compact-tool-btn tour-normalize${master.loudness ? ' active' : ''}`}
                  onClick={() => setMaster(m => ({ ...m, loudness: !m.loudness }))}
                  aria-pressed={master.loudness}
                  aria-label={t('app.audioTools.normalizeLabel')}
                  title={master.loudness ? t('app.audioTools.normalizeOnTitle') : t('app.audioTools.normalizeOffTitle')}
                >
                  <Gauge size={15} /><span>{master.loudness ? t('app.audioTools.normalizeOn') : t('app.audioTools.normalizeOff')}</span>
                </button>
                <button
                  className={`compact-btn compact-tool-btn tour-chapters${chapters.length ? ' active' : ''}`}
                  onClick={() => setChaptersOpen(true)}
                  aria-label={t('app.audioTools.chapters')}
                  title={t('app.audioTools.chaptersTitle')}
                >
                  <Bookmark size={15} /><span>{chapters.length ? t('app.audioTools.chaptersCount', { n: chapters.length }) : t('app.audioTools.chapters')}</span>
                </button>
                <button
                  className={`compact-btn compact-tool-btn${wordTools.transcriptOpen ? ' active' : ''}`}
                  onClick={wordTools.openTranscript}
                  aria-pressed={wordTools.transcriptOpen}
                  aria-label={t('app.audioTools.transcript')}
                  title={t('app.audioTools.transcriptTitle')}
                >
                  <ScrollText size={15} /><span>{t('app.audioTools.transcript')}</span>
                </button>
                <button
                  className="compact-btn compact-tool-btn"
                  onClick={() => wordTools.setFillersOpen(true)}
                  disabled={!audioClips.length}
                  aria-label={t('app.audioTools.fillersLabel')}
                  title={t('app.audioTools.fillersTitle')}
                >
                  <Wand2 size={15} /><span>{t('app.audioTools.fillers')}</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Audio editor: Cut silences over every voice clip */}
        {cutProgress && (
          <div className="compact-render-progress audio-cut-progress" role="status">
            {cutProgress.finished ? (
              <>
                <span className="compact-render-progress-text">
                  {t(activeUpload ? 'app.cutSilences.failedUploading' : 'app.cutSilences.failed', { count: cutProgress.failed })}
                </span>
                <button className="compact-btn" onClick={() => setCutProgress(null)} title={t('app.dismiss')}><X size={12} /></button>
              </>
            ) : (
              <>
                <Loader2 size={14} className="encoding-notice-spin" />
                <span className="compact-render-progress-text">{t('app.cutSilences.progress', { done: cutProgress.done, total: cutProgress.total })}</span>
              </>
            )}
          </div>
        )}
        {groupNotice && (
          <div className="compact-render-progress audio-template-notice" role="status">
            <span className="compact-render-progress-text">{groupNotice}</span>
            <button className="compact-btn" onClick={() => setGroupNotice(null)} title={t('app.dismiss')}><X size={12} /></button>
          </div>
        )}
        {templateNotice && (
          <div className="compact-render-progress audio-template-notice" role="status">
            <span className="compact-render-progress-text">
              {t('app.template.applied', { parts: formatList(templateNotice.filter(r => ['intro', 'outro', 'bed'].includes(r)).map(r => t(`app.template.${r}`))) })}
            </span>
            <button className="compact-btn" onClick={() => { applyTracks(t => removeAudioTemplate(t)); setTemplateNotice(null) }}>{t('app.template.takeOff')}</button>
            <button className="compact-btn" onClick={() => setTemplateNotice(null)} title={t('app.dismiss')}><X size={12} /></button>
          </div>
        )}

        {wordTools.cutNoticeBar}

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
              {renderStatus.phase || percent(renderStatus.progress || 0)}
            </span>
          </div>
        )}

        {/* Render error */}
        {renderStatus?.status === 'failed' && (
          <div className="compact-render-error">
            <span>{t('render.failed', { error: renderStatus.error })}</span>
            <button onClick={clearRenderStatus}><X size={12} /></button>
          </div>
        )}

        {/* Global Preview */}
        <div className={`compact-workspace${isDesktop ? ' desktop' : ''}`}>
        <div className="compact-main">
        <div className={sideBesideStage ? 'compact-top-row' : 'compact-stage-wrap'}>
        <GlobalPreview
          emptyActions={audioMode ? emptyAudioActions : emptyTimelineActions}
          audioMode={audioMode}
          duck={duck}
          chapters={resolvedChapters}
          tracks={tracks}
          playheadPosition={playheadPosition}
          onSetPlayhead={setPlayheadPosition}
          isVerticalVideo={shownAspect === '9:16'}
          activeAspectRatio={shownAspect}
          reframeView={shownAspect !== activeAspectRatio}
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
          onPlayingChange={setPreviewPlaying}
          captions={audioMode ? null : captions}
        />
        {sideBesideStage && sidePanel}
        </div>

        {/* Timeline (includes its own toolbar) */}
        <div className="compact-timeline-section">
          {audioMode && pickingRange && (
            <div className="range-pick-bar" role="status">
              <Scissors size={14} />
              <span>{t('app.rangePick.hint')}</span>
              {audiogramRange && (audiogramRange.end == null
                ? <strong data-testid="range-pick-value">{t('app.rangePick.from', { start: chapterTime(audiogramRange.start) })}</strong>
                : <strong data-testid="range-pick-value">{t('app.rangePick.span', { start: chapterTime(audiogramRange.start), end: chapterTime(audiogramRange.end), seconds: Math.round(audiogramRange.end - audiogramRange.start) })}</strong>)}
              <button
                className={`compact-btn range-pick-play${rangePreview ? ' active' : ''}`}
                onClick={toggleRangePreview}
                disabled={!audiogramRange || audiogramRange.end == null || audiogramRange.end - audiogramRange.start < 3}
                aria-pressed={rangePreview}
                title={t('app.rangePick.listenTitle')}
              >
                {rangePreview ? <Pause size={14} /> : <Play size={14} />} {rangePreview ? t('app.rangePick.stop') : t('app.rangePick.play')}
              </button>
              <span className="range-pick-spacer" />
              <button className="compact-btn" onClick={() => finishPickingRange(false)}>{t('common.cancel')}</button>
              <button className="compact-render-btn" onClick={() => finishPickingRange(true)} disabled={!audiogramRange || audiogramRange.end == null || audiogramRange.end - audiogramRange.start < 3}>{t('app.rangePick.use')}</button>
            </div>
          )}
          <Timeline
            tracks={tracks}
            selectedClipId={selectedClipId}
            selectedClipIds={selectedClipIds}
            onSelectClips={selectClips}
            selectMode={selectMode}
            onSelectModeChange={setSelectMode}
            playheadPosition={playheadPosition}
            onSetPlayhead={setPlayheadPosition}
            onSelectClip={selectClip}
            onRemoveClip={handleRemoveClip}
            onRemoveClips={handleRemoveClips}
            onUpdateClip={updateClip}
            onDuplicateClip={duplicateClip}
            onSplitClip={splitClip}
            onSplitAtPlayhead={splitClipAtPlayhead}
            onRemoveGap={removeGapAtPlayhead}
            isPlayheadOnGap={isPlayheadOnGap}
            rippleTrackId={rippleTarget}
            restoreZoom={restoreZoom}
            onZoomChange={setTimelineZoom}
            flags={resolvedFlags}
            onAddFlag={handleAddFlag}
            onMoveFlag={handleMoveFlag}
            onRemoveFlag={handleRemoveFlag}
            onDuplicate={duplicateClip}
            onGroupClips={groupSelection}
            onUngroupClips={ungroupClips}
            onAddTrack={addTrack}
            onAddTextClip={audioMode ? undefined : addTextHere}
            onAddColorClip={audioMode ? undefined : addColorClip}
            onRemoveTrack={handleRemoveTrack}
            onLibraryDrop={handleTimelineDrop}
            onMoveClipToTrack={moveClipToTrack}
            onAddFilesToTrack={addFilesToTrack}
            onOpenClipSettings={(clipId) => setCompactPropertiesClipId(clipId)}
            onRecordAudio={(trackId) => openAdd('record', trackId)}
            onOpenMusic={(trackId) => openAdd('music', trackId)}
            onOpenSfx={(trackId) => openAdd('sfx', trackId)}
            onOpenStickers={audioMode ? undefined : () => setStickersOpen(true)}
            onOpenStock={audioMode || !STOCK_ENABLED ? undefined : () => setStockOpen({})}
            onOpenTitles={audioMode ? undefined : () => setTitlesOpen(true)}
            onOpenCaptions={audioMode ? undefined : () => { wordTools.setTranscriptOpen(false); setCaptionsOpen(o => !o) }}
            captionsActive={captionsOpen || !!captions}
            onOpenTranscript={audioMode ? undefined : () => { setCaptionsOpen(false); wordTools.openTranscript() }}
            transcriptActive={wordTools.transcriptOpen}
            onRecordVideo={audioMode ? undefined : openRecorder}
            onReverseClip={audioMode ? undefined : handleReverseClip}
            onUpdateTrack={updateTrack}
            onAutoCut={setAutoCutClipId}
            onBeatSync={setBeatClipId}
            isDesktop={isDesktop}
            audioMode={audioMode}
            chapters={audioMode ? resolvedChapters : null}
            onOpenChapters={audioMode ? () => setChaptersOpen(true) : undefined}
            onGroupVoices={audioMode ? groupWithVoices : undefined}
            isPlaying={previewPlaying}
            range={audioMode && pickingRange ? audiogramRange : null}
            rangePicking={audioMode && pickingRange}
            onRangeChange={setAudiogramRange}
          />

          {/* Reversing overlay */}
          {reversingClipId && (
            <div className="hls-download-overlay">
              <div className="hls-download-modal">
                <h3>{t('app.reverse.title')}</h3>
                <p>{t('app.reverse.body')}</p>
              </div>
            </div>
          )}

          {/* Compact properties panel (phones: over the timeline; desktop: the sidebar) */}
          {!isDesktop && (formatsPanel || captionsPanel || transcriptPanel || multiPanel || compactPropertiesPanel)}
        </div>
        </div>
        {/* Desktop shorts editor: the selected clip's settings beside preview and timeline */}
        {isDesktop && !sideBesideStage && sidePanel}
        </div>

        {confirmDialog}
        {shortcutLayer}
        {cleaningNotice}

        {/* Onboarding Tour (the shorts editor's, or the audio editor's) */}
        {showTour && (
          <OnboardingTour steps={audioMode ? AUDIO_TOUR_STEPS : undefined} onComplete={finishTour} />
        )}
        {showPickTour && !showTour && <OnboardingTour steps={RANGE_PICK_TOUR_STEPS} onComplete={finishPickTour} />}

        {/* Remix mode picker (whole video arriving from the remix button) */}
        {remixPrompt && !showTour && <RemixModePicker onChoose={handleRemixChoice} />}
        {rejectedFiles.length > 0 && <TooLargeNotice files={rejectedFiles} onClose={dismissRejectedFiles} />}
        {lengthNotice && !remixPrompt && !showTour && <LengthLimitNotice length={lengthNotice.length} onClose={dismissLengthNotice} />}
        {drafts.prompt && !showTour && drafts.drafts?.length > 0 && (
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
            unavailable={beatClip && !beatSource ? t('app.clipStreaming') : null}
            onSetBeats={(fields) => updateClip(beatClip.id, fields)}
            onFitClips={fitClipsToBeats}
            onClose={() => setBeatClipId(null)}
          />
        )}
        {autoCutClip && (
          <SilenceCutModal
            key={autoCutClip.id}
            clip={mediaView(autoCutClip)}
            source={autoCutSource}
            analysisUrl={autoCutClip.serverUrl || null}
            unavailable={autoCutSource || autoCutClip.serverUrl ? null : autoCutUnavailable}
            onApply={handleAutoCutApply}
            onApplyAll={audioMode ? cutAllSilences : null}
            allCount={audioMode && voiceClips.some(c => c.id === autoCutClip.id) ? voiceClips.length : 0}
            group={autoCutGroup}
            onClose={() => setAutoCutClipId(null)}
          />
        )}

        {/* Kept mounted (hidden) while its piece is picked on the timeline, so its look is not lost */}
        {(audiogramOpen || pickingRange) && renderStatus?.status === 'completed' && renderStatus.outputUrl && (
          <AudiogramDialog
            outputUrl={renderStatus.outputUrl}
            length={timelineEnd}
            hidden={pickingRange}
            title={audioTitle}
            chapters={resolvedChapters}
            range={audiogramRange}
            onPickRange={startPickingRange}
            audiograms={audiograms}
            onAddAudiogram={addAudiogram}
            onUpdateAudiogram={updateAudiogram}
            onRemoveAudiogram={removeAudiogram}
            playlistCovers={playlistCovers}
            onRequestCovers={requestPlaylistCovers}
            onEditText={isIframe ? editTextInHost : undefined}
            onClose={() => setAudiogramOpen(false)}
          />
        )}

        {/* The audio page's "Video podcast": a published episode, no export first */}
        {podcastEpisode && episodeLength != null && (
          <VideoPodcastDialog
            outputUrl={podcastEpisode.url}
            length={episodeLength}
            title={podcastEpisode.title}
            tracks={[]}
            playlistCovers={episodeCovers(podcastEpisode, playlistCovers)}
            onRequestCovers={requestPlaylistCovers}
            canSend={isIframe}
            onSend={(r) => {
              clearPodcastEpisode()
              sendToParent('post-to-3speak', {
                mediaType: 'video',
                outputUrl: r.outputUrl,
                fileName: audioFileName(podcastEpisode.title).replace(/\.mp3$/i, '.mp4'),
                durationSec: r.durationSec,
                format: postFormat('16:9', r.durationSec),
                ...(podcastEpisode.title ? { title: podcastEpisode.title } : {}),
                ...(r.subtitles && { subtitles: r.subtitles })
              })
            }}
            onClose={() => { clearPodcastEpisode(); requestClose() }}
          />
        )}

        {videoPodcastOpen && audioMode && renderStatus?.status === 'completed' && renderStatus.outputUrl && (
          <VideoPodcastDialog
            outputUrl={renderStatus.outputUrl}
            length={timelineEnd}
            title={audioTitle}
            tracks={tracks}
            words={wordTools.tr.words.length && wordTools.tr.missingSeconds < 1 ? wordTools.tr.words : null}
            language={wordTools.tr.language}
            playlistCovers={playlistCovers}
            onRequestCovers={requestPlaylistCovers}
            canSend={isIframe}
            onSend={(r) => {
              setVideoPodcastOpen(false)
              if (drafts.hasEdits()) drafts.save().catch(() => {})
              // 3Speak posts it as a normal video (format), the chapters in its description
              sendToParent('post-to-3speak', {
                mediaType: 'video',
                outputUrl: r.outputUrl,
                fileName: audioFileName(audioTitle).replace(/\.mp3$/i, '.mp4'),
                durationSec: r.durationSec,
                format: postFormat('16:9', r.durationSec),
                ...(audioTitle ? { title: String(audioTitle).slice(0, 120) } : {}),
                ...(chapterList.length > 0 && { chapters: chapterList }),
                ...(musicCredits.length > 0 && { musicCredits }),
                ...(r.subtitles && { subtitles: r.subtitles })
              })
            }}
            onClose={() => setVideoPodcastOpen(false)}
          />
        )}

        {chaptersOpen && (
          <ChaptersDialog
            resolved={resolvedChapters}
            spans={chapterList}
            playheadPosition={playheadPosition}
            focusId={chapterFocus}
            onAdd={addChapter}
            onRename={renameChapter}
            onMove={moveChapterTo}
            onRemove={removeChapter}
            onSeek={(t) => setPlayheadPosition(t)}
            onClose={() => { setChaptersOpen(false); setChapterFocus(null) }}
            suggestions={wordTools.chapterSuggestions({ end: timelineEnd, resolved: resolvedChapters })}
          />
        )}
        {wordTools.fillerDialog}

        {templateOpen && (
          <AudioTemplateDialog
            template={audioTemplate.template || null}
            selectedClip={selectedClip}
            uploadFile={uploadFileToServer}
            signedIn={audioTemplate.enabled}
            canSignIn={canDraftSignIn || (isIframe && draftContext.reason === 'unavailable')}
            onSignIn={requestDraftSignIn}
            silenceSettings={(() => { const st = loadAutoCutSettings(); return { thresholdDb: st.thresholdDb, minSilence: st.minSilence, keepStartMs: st.keepStartMs, keepEndMs: st.keepEndMs } })()}
            master={master}
            saving={audioTemplate.status === 'saving'}
            onSave={async (tpl) => { const r = await audioTemplate.save(tpl); if (r.ok) setTemplateOpen(false) }}
            onApply={async (tpl) => { const r = await audioTemplate.save(tpl); if (r.ok) { setTemplateOpen(false); applyTemplateNow(r.template) } }}
            onRemove={async () => { await audioTemplate.remove(); setTemplateOpen(false) }}
            onClose={() => setTemplateOpen(false)}
          />
        )}

        {musicOpen && <MusicLibrary onPick={handlePickMusic} onClose={() => setMusicOpen(false)} />}

        {sfxOpen && <MusicLibrary kind="sfx" onPick={handlePickSfx} onClose={() => setSfxOpen(false)} />}

        {stickersOpen && <StickerPicker onPick={handlePickSticker} onClose={() => setStickersOpen(false)} />}
        {titlesOpen && <TitleTemplates onAdd={handleAddTitle} onClose={() => setTitlesOpen(false)} frame={outputSize(activeAspectRatio)} />}

        {stockOpen && <StockLibrary purpose={stockOpen.underClipId ? 'background' : 'add'} onPick={handlePickStock} onClose={() => setStockOpen(null)} />}

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
            onRecorded={(files) => handleRecordedFiles(files, addTarget ? { trackId: addTarget, at: playheadPosition } : null)}
            onClose={() => setRecordingAudioOpen(false)}
          />
        )}

        {/* HLS Download Overlay */}
        {activeHlsDownload && (
          <div className="hls-download-overlay">
            <div className="hls-download-modal">
              <Download size={32} className="hls-download-icon" />
              <h3>{t('app.hlsDownload.title')}</h3>
              <p className="hls-download-name">{activeHlsDownload.name}</p>
              <div className="hls-download-progress-bar">
                <div
                  className="hls-download-progress-fill"
                  style={{ width: `${Math.round(activeHlsDownload.progress * 100)}%` }}
                />
              </div>
              <p className="hls-download-percent">{percent(activeHlsDownload.progress)}</p>
              <p className="hls-download-hint">{t('app.hlsDownload.hint')}</p>
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
                <h3>{audioMode ? t('app.sendPreview.titleAudio') : t('app.sendPreview.titleVideo')}</h3>
                <button className="video-preview-close" onClick={() => setShowPreview(false)} title={t('common.close')} aria-label={t('common.close')}>
                  <X size={18} />
                </button>
              </div>
              <div className="video-preview-player">
                {audioMode ? (
                  <audio src={renderStatus.outputUrl} controls autoPlay className="audio-preview-player" />
                ) : (
                  <video
                    src={renderStatus.outputUrl}
                    controls
                    autoPlay
                    playsInline
                    style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 8, background: '#000' }}
                  />
                )}
              </div>
              {askAudiograms ? (
                // No audiograms for this audio yet: offer them before it goes (once per export)
                <div className="video-preview-ask" role="alertdialog" aria-labelledby="ask-audiograms-title">
                  <h4 id="ask-audiograms-title"><Film size={15} /> {t('app.sendPreview.askTitle')}</h4>
                  <p>{t('app.sendPreview.askBody')}</p>
                  <div className="video-preview-actions">
                    <button className="video-preview-back" onClick={() => { askedAudiogramsRef.current.add(renderStatus.outputUrl); setAskAudiograms(false); sendToHost() }}>
                      {t('app.sendPreview.askNo')}
                    </button>
                    <button className="video-preview-send" onClick={() => { askedAudiogramsRef.current.add(renderStatus.outputUrl); setAskAudiograms(false); setShowPreview(false); setAudiogramOpen(true) }}>
                      <Film size={14} />
                      <span>{t('app.sendPreview.askMake')}</span>
                    </button>
                  </div>
                </div>
              ) : (
              <div className="video-preview-actions">
                <button className="video-preview-back" onClick={() => setShowPreview(false)}>
                  {t('app.sendPreview.back')}
                </button>
                <button
                  className="video-preview-send"
                  onClick={() => {
                    if (audioMode && audiograms.length === 0 && !askedAudiogramsRef.current.has(renderStatus.outputUrl)) { setAskAudiograms(true); return }
                    sendToHost()
                  }}
                >
                  <Send size={14} />
                  <span>{audioMode ? t('render.done.useAudio') : t('render.done.sendVideo')}</span>
                </button>
              </div>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <ClipColorFilters tracks={tracks} frame={outputSize(activeAspectRatio)} />
      {/* Backend health warning */}
      {backendStatus === 'error' && (
        <div className="backend-warning">
          {t('app.backendDown')}
          <button onClick={() => setBackendStatus('ok')}>{t('app.dismiss')}</button>
        </div>
      )}

      {/* Branding bar */}
      <header className="app-branding">
        <div className="branding-left">
          <img src={logo3speak} alt="3Speak" className="branding-logo" />
          <span className="branding-text">{t('app.branding.shortsEditor')} <span className="branding-badge">{t('app.branding.beta')}</span></span>
          <span className="branding-info" title={t('app.branding.backend', { url: window.location.origin })}>
            <Info size={14} />
          </span>
        </div>
        <DraftStatus drafts={drafts} canSignIn={canDraftSignIn} signInState={draftContext.reason} onSignIn={requestDraftSignIn} onOpenLimit={() => drafts.save()} />
        <button className="branding-close-btn" onClick={handleCloseEditor} title={t('app.branding.closeEditor')}>
          <X size={18} />
        </button>
      </header>

      <main className={`app-main ${isVerticalVideo ? 'layout-vertical' : ''}`}>
        <div className="left-panel">
          {/* Collapsible Clip Preview */}
          <div className={`collapsible-section ${previewOpen ? 'open' : 'closed'}`}>
            <button className="collapsible-header" onClick={() => setPreviewOpen(p => !p)}>
              {previewOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>{t('common.preview')}</span>
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
              <span>{t('app.legacy.projectLibrary')}</span>
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
              <span className="ffmpeg-loading">{t('app.legacy.loadingFfmpeg', { percent: percent(progress) })}</span>
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
                title={t('app.menu.undo')}
                className="undo-btn"
              >
                <Undo2 size={16} />
              </button>
              <button
                onClick={redo}
                disabled={!canRedo}
                title={t('app.menu.redo')}
                className="redo-btn"
              >
                <Redo2 size={16} />
              </button>
            </div>
            <button className="add-media-btn" onClick={handleAddMedia} title={t('app.legacy.addMediaTitle')}>
              <FolderPlus size={16} />
              <span>{t('app.legacy.addMedia')}</span>
            </button>
            <button className="add-media-btn" onClick={openRecorder} title={t('app.legacy.recordTitle')}>
              <Video size={16} />
              <span>{t('app.legacy.record')}</span>
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
              selectedClipIds={selectedClipIds}
              onSelectClips={selectClips}
              playheadPosition={playheadPosition}
              onSetPlayhead={setPlayheadPosition}
              onSelectClip={selectClip}
              onRemoveClip={handleRemoveClip}
              onRemoveClips={handleRemoveClips}
              onUpdateClip={updateClip}
              onDuplicateClip={duplicateClip}
              onSplitClip={splitClip}
              onSplitAtPlayhead={splitClipAtPlayhead}
              onRemoveGap={removeGapAtPlayhead}
              isPlayheadOnGap={isPlayheadOnGap}
            rippleTrackId={rippleTarget}
            restoreZoom={restoreZoom}
            onZoomChange={setTimelineZoom}
            flags={resolvedFlags}
            onAddFlag={handleAddFlag}
            onMoveFlag={handleMoveFlag}
            onRemoveFlag={handleRemoveFlag}
              onDuplicate={duplicateClip}
              onGroupClips={groupSelection}
              onUngroupClips={ungroupClips}
              onAddTrack={addTrack}
              onAddTextClip={addTextHere}
              onAddColorClip={addColorClip}
              onRemoveTrack={handleRemoveTrack}
              onLibraryDrop={handleTimelineDrop}
              onMoveClipToTrack={moveClipToTrack}
              onAddFilesToTrack={addFilesToTrack}
              onRecordAudio={(trackId) => openAdd('record', trackId)}
              onOpenMusic={(trackId) => openAdd('music', trackId)}
              onOpenSfx={(trackId) => openAdd('sfx', trackId)}
              onOpenStickers={() => setStickersOpen(true)}
              onOpenStock={STOCK_ENABLED ? () => setStockOpen({}) : undefined}
              onOpenTitles={() => setTitlesOpen(true)}
              onOpenCaptions={() => { wordTools.setTranscriptOpen(false); setCaptionsOpen(o => !o) }}
              captionsActive={captionsOpen || !!captions}
              onOpenTranscript={() => { setCaptionsOpen(false); wordTools.openTranscript() }}
              transcriptActive={wordTools.transcriptOpen}
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
              <h3>{t('app.reverse.title')}</h3>
              <p>{t('app.reverse.body')}</p>
            </div>
          </div>
        )}

        {/* Right panel: properties for horizontal, timeline preview for vertical */}
        <div className="right-panel">
          {captionsPanel || transcriptPanel}
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
              captions={captions}
            />
          ) : (
            <div className={`collapsible-section properties-section ${propertiesOpen ? 'open' : 'closed'}`}>
              <button className="collapsible-header" onClick={() => setPropertiesOpen(p => !p)}>
                {propertiesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>{selectedClip ? t('app.legacy.propertiesOf', { name: selectedClip.name }) : t('app.legacy.properties')}</span>
              </button>
              {propertiesOpen && selectedClip && (
                <div className="collapsible-body">
                  <ClipProperties
                    clip={selectedClip}
                    linkedAudio={linkedAudioOf(selectedClip)}
                    tracks={audioMode ? null : tracks}
                    onUpdateLinkedAudio={(u) => { const a = linkedAudioOf(selectedClip); if (a) updateClip(a.id, u) }}
                    onUpdateClip={(updates) => selectedClipId && updateClip(selectedClipId, updates)}
                    onSplit={(time) => selectedClipId && splitClip(selectedClipId, time)}
                    playheadPosition={playheadPosition}
                    motionKit={audioMode ? null : motionKit}
                    onPickBackground={STOCK_ENABLED ? (clipId) => setStockOpen({ underClipId: clipId }) : null}
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
          unavailable={beatClip && !beatSource ? t('app.clipStreaming') : null}
          onSetBeats={(fields) => updateClip(beatClip.id, fields)}
          onFitClips={fitClipsToBeats}
          onClose={() => setBeatClipId(null)}
        />
      )}
      {autoCutClip && (
        <SilenceCutModal
          key={autoCutClip.id}
          clip={mediaView(autoCutClip)}
          source={autoCutSource}
          unavailable={autoCutUnavailable}
          onApply={handleAutoCutApply}
          onClose={() => setAutoCutClipId(null)}
        />
      )}
      {wordTools.fillerDialog}

      {musicOpen && <MusicLibrary onPick={handlePickMusic} onClose={() => setMusicOpen(false)} />}

      {sfxOpen && <MusicLibrary kind="sfx" onPick={handlePickSfx} onClose={() => setSfxOpen(false)} />}

      {stickersOpen && <StickerPicker onPick={handlePickSticker} onClose={() => setStickersOpen(false)} />}
      {titlesOpen && <TitleTemplates onAdd={handleAddTitle} onClose={() => setTitlesOpen(false)} frame={outputSize(activeAspectRatio)} />}

      {stockOpen && <StockLibrary purpose={stockOpen.underClipId ? 'background' : 'add'} onPick={handlePickStock} onClose={() => setStockOpen(null)} />}

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
          onRecorded={(files) => handleRecordedFiles(files, addTarget ? { trackId: addTarget, at: playheadPosition } : null)}
          onClose={() => setRecordingAudioOpen(false)}
        />
      )}

      {/* HLS Download Overlay */}
      {activeHlsDownload && (
        <div className="hls-download-overlay">
          <div className="hls-download-modal">
            <Download size={32} className="hls-download-icon" />
            <h3>{t('app.hlsDownload.title')}</h3>
            <p className="hls-download-name">{activeHlsDownload.name}</p>
            <div className="hls-download-progress-bar">
              <div
                className="hls-download-progress-fill"
                style={{ width: `${Math.round(activeHlsDownload.progress * 100)}%` }}
              />
            </div>
            <p className="hls-download-percent">{percent(activeHlsDownload.progress)}</p>
            <p className="hls-download-hint">{t('app.hlsDownload.hint')}</p>
          </div>
        </div>
      )}

      {/* Upload Progress Overlay */}
      {encodingItems.length > 0 && (
        <EncodingNotice items={encodingItems} onClose={hideEncodingNotice} />
      )}

      {confirmDialog}
      {shortcutLayer}
    </div>
  )
}

export default App
