import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Mic, GripHorizontal, Sliders, ChevronDown, ChevronUp, Pencil, Pause, Play, EyeOff, Info, Minus, Plus } from 'lucide-react'
import { useVoiceTeleprompter } from '../../hooks/useVoiceTeleprompter'
import { useTimedTeleprompter } from '../../hooks/useTimedTeleprompter'
import { detectScriptLang, modelIdToTag } from '../../utils/detectLang'
import { webSpeechUsable, isAndroid, isChromium } from '../../utils/speechSupport'
import { createSttStream } from '../../utils/sttClient'
import { requestSttConfig } from '../../utils/sttBridge'
import './Teleprompter.css'

// Teleprompter for the editor's camera recorder (InlineRecorder), ported from the
// 3Speak frontend's EmbedCameraRecord: script entry, text style, one-tap presets,
// a draggable + resizable script box, voice-following scroll (Web Speech, or the
// self-hosted STT server through the parent page) with the "heard" line and the
// matched/total pill, plus a TIMED mode (steady words per minute, any browser) and
// a mirror-text toggle.
//
// Everything here is a DOM overlay portaled to <body>, over the camera preview.
// It is never part of what gets recorded: InlineRecorder's MediaRecorder records
// the raw getUserMedia stream, and DOM overlays are not in that stream.
//
// The parent drives it with `recState`:
//   'idle' (camera preview) -> 'countdown' (3-2-1) -> 'recording' [-> 'paused'] -> 'done'
// Scrolling starts when the countdown ends, pauses/resumes with 'paused', and
// stops with the take. Before the countdown ends the parent awaits `prepare()`
// (ref method) so the mic hand-off and the STT token are ready on time.

const SETTINGS_KEY = 'tp-overlay-settings'
const BOX_KEY = 'tp-overlay-box'
const SCRIPT_KEY = 'tp-script'
const DEFAULT_SETTINGS = {
  fontSize: 26, fontColor: '#ffffff', bgColor: '#000000', bgOpacity: 0.5, lang: 'auto',
  // editor additions
  mode: 'auto', // 'auto' | 'voice' | 'timed'; auto = voice when it works here, else timed
  wpm: 130,
  mirrorText: false
}
const MIN_W = 150
// Low enough that the two-line "Front cam" strip can also be reached by dragging
// the resize corner, not just by tapping the preset.
const MIN_H = 44
// Must match .tp-scroll in Teleprompter.css (line-height, and top+bottom padding),
// so a preset can size the box to an exact number of text lines.
const LINE_HEIGHT = 1.7
const SCROLL_PAD_Y = 24
const WPM_MIN = 60
const WPM_MAX = 240
// Speed step of the menu's scroll-speed control.
const WPM_STEP = 10

const LANG_OPTIONS = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'es-ES', label: 'Español' },
  { value: 'pt-BR', label: 'Português (BR)' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'it-IT', label: 'Italiano' },
  { value: 'nl-NL', label: 'Nederlands' },
  { value: 'ru-RU', label: 'Русский' },
  { value: 'hi-IN', label: 'हिन्दी' },
  { value: 'ar-SA', label: 'العربية' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'zh-CN', label: '中文' },
]
const ALL_LANG_TAGS = LANG_OPTIONS.map((o) => o.value)
const langLabel = (tag) => LANG_OPTIONS.find((o) => o.value === tag)?.label || tag

// Recognizer errors that mean voice following is not going to work this take.
const FATAL_SPEECH_ERRORS = ['network', 'not-allowed', 'service-not-allowed', 'audio-capture']

function speechErrorLabel(err) {
  switch (err) {
    case 'network': return 'Speech service unreachable. Recognition needs an internet connection (Chrome sends audio to Google to transcribe).'
    case 'audio-capture': return 'No audio reached recognition. The mic may be busy, try a headset.'
    case 'not-allowed':
    case 'service-not-allowed': return 'Microphone permission is blocked for speech recognition.'
    case 'no-speech':
    case 'aborted':
    case '': return ''
    default: return `Speech recognition error: ${err}`
  }
}

function hexToRgba(hex, a) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '')
  if (!m) return `rgba(0,0,0,${a})`
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`
}

function loadJson(key, fallback) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null')
    return raw && typeof raw === 'object' ? { ...fallback, ...raw } : fallback
  } catch { return fallback }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}
function loadScript() {
  try { return localStorage.getItem(SCRIPT_KEY) || '' } catch { return '' }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const winW = () => (typeof window !== 'undefined' ? window.innerWidth : 375)
const winH = () => (typeof window !== 'undefined' ? window.innerHeight : 667)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Keep a saved box inside the current viewport (the iframe can be a phone one day
// and a desktop modal the next, and both share this origin's storage).
function fitBox(b) {
  const W = winW()
  const H = winH()
  const w = clamp(b.w, Math.min(MIN_W, W), W)
  const h = clamp(b.h, Math.min(MIN_H, H), H)
  return { x: clamp(b.x, 0, W - w), y: clamp(b.y, 0, H - h), w, h }
}

// Reusable move-only draggable, position persisted (from the frontend). `handleProps`
// go on the drag grip, `surfaceProps` on the moving element (which the grip's
// pointer is captured to). Position is applied via direct DOM during the drag,
// committed on release.
function useMovable(storageKey, makeDefault) {
  const [pos, setPos] = useState(() => loadJson(storageKey, makeDefault()))
  const ref = useRef(null)
  const drag = useRef(null)
  const posRef = useRef(pos)
  posRef.current = pos
  const onPointerDown = (e) => {
    e.preventDefault()
    e.stopPropagation()
    try { ref.current?.setPointerCapture?.(e.pointerId) } catch { /* ignore */ }
    drag.current = { sx: e.clientX, sy: e.clientY, ox: posRef.current.x, oy: posRef.current.y, cur: { ...posRef.current } }
  }
  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    const el = ref.current
    const w = el ? el.offsetWidth : 0
    const h = el ? el.offsetHeight : 0
    const x = clamp(d.ox + (e.clientX - d.sx), 4, window.innerWidth - w - 4)
    const y = clamp(d.oy + (e.clientY - d.sy), 4, window.innerHeight - h - 4)
    d.cur = { x, y }
    if (el) { el.style.left = `${x}px`; el.style.top = `${y}px` }
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (d) { setPos(d.cur); saveJson(storageKey, d.cur) }
  }
  // Rotating the phone swaps viewport dimensions: re-clamp so a saved position
  // (e.g. bottom-right in portrait) doesn't end up off-screen in landscape.
  useEffect(() => {
    const onResize = () => {
      const el = ref.current
      const w = el ? el.offsetWidth : 0
      const h = el ? el.offsetHeight : 0
      setPos((p) => {
        const nx = clamp(p.x, 4, Math.max(4, window.innerWidth - w - 4))
        const ny = clamp(p.y, 4, Math.max(4, window.innerHeight - h - 4))
        if (nx === p.x && ny === p.y) return p
        const np = { x: nx, y: ny }
        saveJson(storageKey, np)
        return np
      })
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [storageKey])
  return { pos, ref, handleProps: { onPointerDown }, surfaceProps: { onPointerMove, onPointerUp, onPointerCancel: onPointerUp } }
}

// Events must not leak through the portal into the editor behind (React bubbles
// portal events up the component tree: the preview's gesture handlers would see
// them otherwise).
const stopProp = (e) => e.stopPropagation()
const shieldProps = {
  onMouseDown: stopProp,
  onTouchStart: stopProp,
  onPointerDown: stopProp,
  onClick: stopProp,
  onWheel: stopProp,
  onKeyDown: stopProp,
  onContextMenu: stopProp
}

const Teleprompter = forwardRef(function Teleprompter({ recState = 'idle', streamRef, onActiveChange }, ref) {
  const [script, setScript] = useState(loadScript)
  const [enabled, setEnabled] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [settings, setSettings] = useState(() => loadJson(SETTINGS_KEY, { ...DEFAULT_SETTINGS }))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [menuCollapsed, setMenuCollapsed] = useState(() => !!loadJson('tp-menu-collapsed', { v: false }).v)
  const [testing, setTesting] = useState(false)
  const [userPaused, setUserPaused] = useState(false)
  const [voiceFailed, setVoiceFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const [sttStatus, setSttStatus] = useState('') // '', 'connecting', 'connected', 'error:<msg>', 'closed'
  // STT server (via the parent page): null = none / not known yet.
  const [stt, setStt] = useState(null) // { url, models }
  const sttTokenRef = useRef({ token: '', at: 0 })
  const sttRef = useRef(null)
  const sttAskedRef = useRef(false)

  useEffect(() => { try { localStorage.setItem(SCRIPT_KEY, script) } catch { /* ignore */ } }, [script])
  useEffect(() => { saveJson(SETTINGS_KEY, settings) }, [settings])
  useEffect(() => { saveJson('tp-menu-collapsed', { v: menuCollapsed }) }, [menuCollapsed])
  const setSetting = (patch) => setSettings((s) => ({ ...s, ...patch }))

  const menu = useMovable('tp-menu-pos', () => ({ x: 12, y: Math.round(winH() * 0.5) }))
  const settingsMov = useMovable('tp-settings-pos', () => ({ x: 12, y: 80 }))

  // ---- which scroll source ----------------------------------------------------
  const webOk = useMemo(() => webSpeechUsable(), [])
  // Speech-to-text ("Follow voice") is only supported in Chromium browsers for
  // now (owner's call, 2026-10-12). Keyed on the browser, not on whether an STT
  // server answered, so the notice is the same for everyone on that browser.
  const chromium = useMemo(() => isChromium(), [])
  const speechNotice = !chromium && (
    <div className="tp-speech-notice" role="note">
      <Info size={18} aria-hidden="true" />
      <div>
        <strong>Voice following only works in Chromium browsers for now.</strong>
        <span> Use Chrome, Edge, Brave or Opera to have the script scroll as you speak. In this browser it scrolls at a steady speed you can set.</span>
      </div>
    </div>
  )
  // The frontend prefers the STT server whenever one is configured: it taps the
  // recording's own audio track, so it cannot fight the recorder for the mic.
  // Outside Chromium nothing follows the voice, STT server included (see the
  // notice below): the product only supports it on Chromium for now.
  const voiceVia = !isChromium() ? null : (stt?.url ? 'stt' : (webOk ? 'web' : null))
  // 'auto' picks voice only on Chromium (where the frontend's teleprompter is
  // tested); elsewhere it starts in timed mode. Outside Chromium "Follow voice"
  // can still be chosen by hand when an STT server is configured.
  const effectiveMode = settings.mode === 'timed'
    ? 'timed'
    : settings.mode === 'voice'
      ? (voiceVia ? 'voice' : 'timed')
      : (webOk && voiceVia ? 'voice' : 'timed')
  const voiceForcedButMissing = settings.mode === 'voice' && !voiceVia

  // Ask the parent once (lazily, the first time the teleprompter is used) whether
  // an STT server is configured. The reply also carries a fresh token.
  const askStt = useCallback(async () => {
    if (sttAskedRef.current) return
    sttAskedRef.current = true
    const cfg = await requestSttConfig()
    if (cfg) {
      sttTokenRef.current = { token: cfg.token, at: Date.now() }
      setStt({ url: cfg.url, models: cfg.models })
    }
  }, [])

  // Tokens are short-lived (5 min on the frontend server): reuse one for 2 min.
  const getSttToken = useCallback(async () => {
    const t = sttTokenRef.current
    if (t.token && Date.now() - t.at < 120000) return t.token
    const cfg = await requestSttConfig()
    if (cfg) { sttTokenRef.current = { token: cfg.token, at: Date.now() }; return cfg.token }
    return ''
  }, [])

  // ---- language ---------------------------------------------------------------
  const serverLangs = useMemo(
    () => (voiceVia === 'stt' ? (stt?.models || []).map(modelIdToTag).filter(Boolean) : []),
    [voiceVia, stt]
  )
  const availableLangs = serverLangs.length ? serverLangs : ALL_LANG_TAGS
  const detectedLang = useMemo(
    () => detectScriptLang(script, { allowed: availableLangs }),
    [script, availableLangs]
  )
  // 'auto' (default) follows the script; an explicit pick is honoured only if the
  // recognizer supports it, else we fall back to the detected one.
  const effectiveLang = settings.lang === 'auto' || !availableLangs.includes(settings.lang)
    ? detectedLang
    : settings.lang

  const tp = useVoiceTeleprompter(script, { lang: effectiveLang })
  const timed = useTimedTeleprompter(tp.totalWords, { wpm: settings.wpm })

  const active = enabled && tp.totalWords > 0
  useEffect(() => { onActiveChange?.(active) }, [active, onActiveChange])

  // Timed mode, or voice that failed mid-take and handed over to the timer.
  const timerDriven = effectiveMode === 'timed' || voiceFailed
  const pointer = timerDriven ? timed.matchedCount : tp.matchedCount

  // Latest values for the imperative handle and the recState effect.
  const live = useRef({})
  live.current = { active, effectiveMode, voiceVia, voiceFailed, effectiveLang, tp, timed, getSttToken, streamRef }

  // ---- voice sources ------------------------------------------------------------
  const stopStt = useCallback(() => {
    try { sttRef.current?.stop() } catch { /* ignore */ }
    sttRef.current = null
  }, [])

  const startStt = useCallback(async () => {
    const L = live.current
    const track = L.streamRef?.current?.getAudioTracks?.()[0]
    if (!track || !stt?.url) { setSttStatus('error:no microphone'); return }
    stopStt()
    setSttStatus('connecting')
    const token = await L.getSttToken()
    sttRef.current = createSttStream({
      track,
      url: stt.url,
      lang: L.effectiveLang,
      token,
      onTranscript: (text, isFinal) => live.current.tp.ingestTranscript(text, isFinal),
      onStatus: (s, msg) => setSttStatus(msg ? `${s}:${msg}` : s)
    })
  }, [stt, stopStt])

  const stopVoice = useCallback(() => {
    live.current.tp.stop()
    stopStt()
  }, [stopStt])

  const stopTest = useCallback(() => {
    setTesting(false)
    setUserPaused(false)
    stopVoice()
    // A scroll test leaves the text where it stopped; the next test or take starts at the top.
    live.current.timed.pause()
    live.current.timed.reset()
  }, [stopVoice])

  // Timed mode: scroll the script without recording, to find the right speed.
  const toggleScrollTest = useCallback(() => {
    if (testing) { stopTest(); return }
    timed.reset()
    setUserPaused(false)
    setTesting(true)
    timed.start()
  }, [testing, stopTest, timed])

  const toggleVoiceTest = useCallback(() => {
    if (testing) { stopTest(); return }
    tp.reset()
    setVoiceFailed(false)
    setTesting(true)
    if (voiceVia === 'stt') startStt()
    else tp.start()
  }, [testing, stopTest, tp, voiceVia, startStt])

  // Start (or resume) the active scroll source.
  const beginScroll = useCallback(() => {
    const L = live.current
    if (L.effectiveMode === 'timed' || L.voiceFailed) { L.timed.start(); return }
    if (L.voiceVia === 'stt') { if (!sttRef.current) startStt(); return }
    L.tp.start() // no-op when prepare() already started it
  }, [startStt])

  const haltScroll = useCallback(() => {
    live.current.timed.pause()
    stopVoice()
  }, [stopVoice])

  // ---- follow the recorder -----------------------------------------------------
  const prevStateRef = useRef(recState)
  useEffect(() => {
    const prev = prevStateRef.current
    prevStateRef.current = recState
    if (prev === recState) return
    const L = live.current
    if (recState === 'countdown') {
      setTesting(false)
      setUserPaused(false)
      setNotice('')
      setSttStatus('') // a stale 'error:' from the last take must not trip the fallback
      L.timed.reset()
      L.tp.reset()
      return
    }
    if (recState === 'recording') {
      if (prev !== 'paused') {
        // Drop anything picked up during the countdown; start from the top.
        L.timed.reset()
        L.tp.reset()
        setUserPaused(false)
      }
      if (L.active) beginScroll()
      return
    }
    if (recState === 'paused') { haltScroll(); return }
    // 'idle' (retake / back to preview) or 'done' (reviewing the take)
    setTesting(false)
    haltScroll()
    if (recState === 'idle') { L.timed.reset(); L.tp.reset(); setVoiceFailed(false) }
  }, [recState, beginScroll, haltScroll])

  // Voice died mid-take (STT server gone, recognizer blocked): carry on with the
  // timer from where the reader was, so the take is not ruined.
  const fatalVoice = effectiveMode === 'voice' && recState === 'recording' && !voiceFailed && (
    (voiceVia === 'stt' && sttStatus.startsWith('error')) ||
    (voiceVia === 'web' && FATAL_SPEECH_ERRORS.includes(tp.error))
  )
  useEffect(() => {
    if (!fatalVoice) return
    setVoiceFailed(true)
    stopVoice()
    timed.seek(tp.matchedCount)
    timed.start()
  }, [fatalVoice]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up the STT socket when the recorder goes away (the voice hook stops
  // its own recognizer on unmount).
  useEffect(() => () => stopStt(), [stopStt])

  // ---- imperative API for InlineRecorder ---------------------------------------
  useImperativeHandle(ref, () => ({
    openEditor() {
      askStt()
      setEditorOpen(true)
    },
    isActive: () => live.current.active,
    // Called when the 3-2-1 countdown starts; the recorder waits for it (with a
    // cap) before it starts recording.
    async prepare() {
      const L = live.current
      setTesting(false)
      setVoiceFailed(false)
      setNotice('')
      stopVoice()
      if (!L.active || L.effectiveMode !== 'voice') return
      if (L.voiceVia === 'stt') { await L.getSttToken(); return }
      if (L.voiceVia !== 'web') return

      // Web Speech. From the frontend: holding a getUserMedia audio track starves
      // the Web Speech recognizer (it opens its own capture, gets silence, raises
      // no error). The frontend therefore opens the camera video-only, starts
      // recognition while the mic is free, and only then opens the recording's
      // audio. The editor's recorder already holds an audio track, so on Android
      // (where that starvation happens) we hand the mic over the same way: drop
      // the track, start recognition, then re-open the mic and put the new track
      // back into the SAME stream the recorder will record. Desktop Chrome shares
      // the mic fine, so there we leave the stream alone. (iOS never gets here:
      // Web Speech is Chromium-only, and iOS would also need a user gesture for
      // getUserMedia, which we no longer have after the await below.)
      const stream = L.streamRef?.current
      const oldAudio = stream ? stream.getAudioTracks() : []
      if (!isAndroid() || !oldAudio.length) { L.tp.start(); return }

      oldAudio.forEach((t) => { stream.removeTrack(t); try { t.stop() } catch { /* ignore */ } })
      L.tp.start()
      await sleep(500) // let recognition settle
      const reopen = () => navigator.mediaDevices.getUserMedia({ audio: true })
      let audio
      try {
        audio = await reopen()
      } catch {
        // Recognition may be holding the mic exclusively: the recording's sound
        // matters more than the scroll, so give the mic back and use the timer.
        L.tp.stop()
        setVoiceFailed(true)
        try { audio = await reopen() } catch { audio = null }
      }
      const stillLive = L.streamRef?.current === stream && stream.getVideoTracks().some((t) => t.readyState === 'live')
      if (!audio) {
        setNotice('Recording without a microphone (mic unavailable).')
        return
      }
      if (!stillLive) { audio.getTracks().forEach((t) => t.stop()); return }
      audio.getAudioTracks().forEach((t) => stream.addTrack(t))
    }
  }), [askStt, stopVoice])

  // ---- auto-scroll the box to the current word ---------------------------------
  // Scrolls the box's own scroller directly instead of scrollIntoView(), which
  // would also scroll every ancestor (the editor page, and inside an iframe even
  // the embedding page).
  const scrollRef = useRef(null)
  const currentWordRef = useRef(null)
  const showBox = active && !editorOpen && recState !== 'done'
  useEffect(() => {
    if (!showBox) return
    const sc = scrollRef.current
    const w = currentWordRef.current
    if (!sc) return
    if (!w) { if (pointer === 0) sc.scrollTo({ top: 0 }); return }
    const scRect = sc.getBoundingClientRect()
    const wRect = w.getBoundingClientRect()
    const top = sc.scrollTop + (wRect.top - scRect.top) - sc.clientHeight / 2 + wRect.height / 2
    sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [pointer, showBox])

  // ---- draggable + resizable teleprompter box ---------------------------------
  const boxRef = useRef(null)
  const dragRef = useRef(null)
  const [box, setBox] = useState(() => {
    const saved = loadJson(BOX_KEY, null)
    return saved && saved.w ? fitBox(saved) : null
  })
  const boxRef2 = useRef(box)
  boxRef2.current = box

  // Full-width layouts start below the recorder's own top bar on the phone stage
  // (its header with the close button, and the layout chips), measured rather
  // than guessed so safe-area insets are accounted for automatically.
  const measureTopSafe = () => {
    let topSafe = 8
    try {
      const H = winH()
      document.querySelectorAll('.pip-stage .pip-header, .pip-stage .pip-layouts').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.height > 0 && r.top < H * 0.3) topSafe = Math.max(topSafe, Math.round(r.bottom) + 8)
      })
    } catch { /* keep the fallback */ }
    return topSafe
  }

  // One-tap layouts for the script overlay. Each sets BOTH the box geometry and
  // the text size, since "front cam overlay" is really a position + size combo.
  const presetRect = useCallback((name) => {
    const W = winW()
    const H = winH()
    const topSafe = measureTopSafe()
    // Wide desktop windows: keep the lines a readable length.
    const capW = (w) => Math.min(w, 900)
    let w; let h; let y; let patch
    if (name === 'frontcam') {
      // Tucked right under the top edge (where the selfie lens sits): tiny type,
      // and only TWO lines tall so the strip is as shallow as it can be while
      // still showing the word after the one you're on. Keeps your eyeline on the
      // lens.
      const fs = 12
      w = capW(Math.round(W * 0.68))
      h = Math.round(fs * LINE_HEIGHT * 2 + SCROLL_PAD_Y)
      y = 4
      patch = { fontSize: fs, bgOpacity: 0.28 }
    } else if (name === 'max') {
      // Big type for reading the phone from a distance.
      w = capW(Math.round(W * 0.96))
      y = Math.max(Math.round(H * 0.08), topSafe)
      h = Math.round(Math.min(H * 0.55, H - y - 24))
      patch = { fontSize: 46, bgOpacity: 0.55 }
    } else { // 'top'
      w = capW(Math.round(W * 0.92))
      y = Math.max(Math.round(H * 0.05), topSafe)
      h = Math.round(Math.min(H * 0.34, H - y - 24))
      patch = { fontSize: 26, bgOpacity: 0.5 }
    }
    return { rect: fitBox({ x: Math.round((W - w) / 2), y, w, h }), patch }
  }, [])

  const applyPreset = useCallback((name) => {
    const { rect, patch } = presetRect(name)
    setBox(rect)
    saveJson(BOX_KEY, rect)
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [presetRect])

  // First use: place the box like the "Top lines" preset (text size untouched).
  useEffect(() => {
    if (showBox && !boxRef2.current) setBox(presetRect('top').rect)
  }, [showBox, presetRect])

  // Keep the box on screen when the viewport changes (rotation, modal resize).
  useEffect(() => {
    const onResize = () => setBox((b) => {
      if (!b) return b
      const f = fitBox(b)
      return (f.x === b.x && f.y === b.y && f.w === b.w && f.h === b.h) ? b : f
    })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const applyBoxStyle = (r) => {
    const el = boxRef.current
    if (!el) return
    el.style.left = `${r.x}px`
    el.style.top = `${r.y}px`
    el.style.width = `${r.w}px`
    el.style.height = `${r.h}px`
  }

  const beginDrag = (mode) => (e) => {
    if (!boxRef2.current) return
    e.preventDefault()
    e.stopPropagation()
    try { boxRef.current?.setPointerCapture?.(e.pointerId) } catch { /* ignore */ }
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, orig: { ...boxRef2.current }, rect: { ...boxRef2.current } }
  }

  const onBoxPointerMove = (e) => {
    const d = dragRef.current
    if (!d) return
    const maxW = winW()
    const maxH = winH()
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    let r
    if (d.mode === 'move') {
      r = { ...d.orig, x: clamp(d.orig.x + dx, 0, maxW - d.orig.w), y: clamp(d.orig.y + dy, 0, maxH - d.orig.h) }
    } else {
      r = { ...d.orig, w: clamp(d.orig.w + dx, MIN_W, maxW - d.orig.x), h: clamp(d.orig.h + dy, MIN_H, maxH - d.orig.y) }
    }
    d.rect = r
    applyBoxStyle(r)
  }

  const endDrag = () => {
    const d = dragRef.current
    dragRef.current = null
    if (d) {
      setBox(d.rect)
      saveJson(BOX_KEY, d.rect)
    }
  }

  // ---- script editor actions ---------------------------------------------------
  const closeEditor = () => setEditorOpen(false)
  const showOnCamera = () => {
    setEnabled(!!script.trim())
    setEditorOpen(false)
    tp.reset()
    timed.reset()
  }
  const hideTeleprompter = () => {
    stopTest()
    setEnabled(false)
    setEditorOpen(false)
    setSettingsOpen(false)
  }
  const editScript = () => {
    stopTest()
    setEditorOpen(true)
  }

  const toggleUserPause = () => {
    if (userPaused) { setUserPaused(false); beginScroll() } else { setUserPaused(true); haltScroll() }
  }

  // ---- render --------------------------------------------------------------------
  const isRecording = recState === 'recording'
  const scrollLocked = recState === 'countdown' || isRecording || recState === 'paused'

  const langOptions = [
    { value: 'auto', label: `Auto-detect (${langLabel(detectedLang)})` },
    ...LANG_OPTIONS.filter((o) => availableLangs.includes(o.value))
  ]

  const overlaySettingsPanel = (
    <>
      <div className="tp-presets">
        <button type="button" onClick={() => applyPreset('frontcam')} title="Small strip under the selfie lens, least obvious that you're reading">
          Front cam
        </button>
        <button type="button" onClick={() => applyPreset('max')} title="Large type for reading from a distance">
          Max size
        </button>
        <button type="button" onClick={() => applyPreset('top')} title="Several lines across the top">
          Top lines
        </button>
      </div>

      <div className="tp-set-row">
        <span>Scroll</span>
        <div className="tp-seg" role="group" aria-label="Scroll mode">
          <button
            type="button"
            className={effectiveMode === 'voice' ? 'is-on' : ''}
            disabled={!voiceVia || scrollLocked}
            onClick={() => { stopTest(); setSetting({ mode: 'voice' }) }}
            title={voiceVia ? 'Scrolls as you read the script aloud' : 'Needs Chrome, Edge or another Chromium browser'}
          >
            Follow voice
          </button>
          <button
            type="button"
            className={effectiveMode === 'timed' ? 'is-on' : ''}
            disabled={scrollLocked}
            onClick={() => { stopTest(); setSetting({ mode: 'timed' }) }}
            title="Scrolls at a steady speed"
          >
            Timed
          </button>
        </div>
      </div>
      {chromium && !voiceVia && (
        <div className="tp-set-note">
          {voiceForcedButMissing ? 'Voice following is not available here, using timed scroll. ' : ''}
          Voice following is not available in this browser.
        </div>
      )}

      <label className="tp-set-row">
        <span>Font size</span>
        <input type="range" min="10" max="52" step="1" value={settings.fontSize}
          onChange={(e) => setSetting({ fontSize: Number(e.target.value) })} />
        <span className="tp-set-val">{settings.fontSize}px</span>
      </label>
      <div className="tp-set-colors">
        <label className="tp-set-color">
          <span>Text</span>
          <input type="color" value={settings.fontColor} onChange={(e) => setSetting({ fontColor: e.target.value })} />
        </label>
        <label className="tp-set-color">
          <span>Background</span>
          <input type="color" value={settings.bgColor} onChange={(e) => setSetting({ bgColor: e.target.value })} />
        </label>
        <label className="tp-set-row tp-set-opacity">
          <span>BG opacity</span>
          <input type="range" min="0" max="1" step="0.05" value={settings.bgOpacity}
            onChange={(e) => setSetting({ bgOpacity: Number(e.target.value) })} />
          <span className="tp-set-val">{Math.round(settings.bgOpacity * 100)}%</span>
        </label>
      </div>
      <label className="tp-set-check">
        <input type="checkbox" checked={!!settings.mirrorText} onChange={(e) => setSetting({ mirrorText: e.target.checked })} />
        <span>Mirror text (for a teleprompter mirror)</span>
      </label>
      {effectiveMode === 'voice' && (
        <label className="tp-set-row">
          <span>Voice language</span>
          <select
            className="tp-lang-select"
            value={langOptions.some((o) => o.value === settings.lang) ? settings.lang : 'auto'}
            onChange={(e) => setSetting({ lang: e.target.value })}
          >
            {langOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      )}
    </>
  )

  const settingsGearBtn = (
    <button type="button" className={`tp-gear${settingsOpen ? ' is-on' : ''}`} onClick={() => { askStt(); setSettingsOpen((o) => !o) }}>
      <Sliders size={15} /> Text style
    </button>
  )

  const settingsPopupEl = settingsOpen ? (
    <div ref={settingsMov.ref} className="tp-settings-pop" style={{ left: settingsMov.pos.x, top: settingsMov.pos.y }} {...settingsMov.surfaceProps}>
      <div className="tp-pop-header" {...settingsMov.handleProps}>
        <GripHorizontal size={14} />
        <span className="tp-pop-title">Text style</span>
        <button type="button" className="tp-pop-close" onPointerDown={stopProp} onClick={() => setSettingsOpen(false)} aria-label="Close">
          <X size={15} />
        </button>
      </div>
      <div className="tp-pop-body">{overlaySettingsPanel}</div>
    </div>
  ) : null

  // ---- status strip under the box: heard line / warnings + matched pill -------
  const usingStt = voiceVia === 'stt' && (isRecording || testing)
  const voiceLive = effectiveMode === 'voice' && !voiceFailed && (isRecording || recState === 'countdown' || testing)
  let statusText = ''
  let statusWarn = false
  if (voiceFailed && (isRecording || recState === 'paused')) {
    statusWarn = true
    statusText = usingStt || voiceVia === 'stt'
      ? `Speech server error (${sttStatus.slice(6) || 'unreachable'}). Switched to timed scroll.`
      : `${speechErrorLabel(tp.error) || 'Voice following stopped.'} Switched to timed scroll.`
  } else if (voiceLive) {
    if (usingStt && sttStatus.startsWith('error')) {
      statusWarn = true
      statusText = `Speech server error (${sttStatus.slice(6) || 'unreachable'}).`
    } else if (!usingStt && speechErrorLabel(tp.error)) {
      statusWarn = true
      statusText = speechErrorLabel(tp.error)
    } else {
      statusText = tp.interimText
        || (usingStt
          ? (sttStatus === 'connected' ? 'Listening (server), start reading' : 'Connecting to speech server…')
          : (tp.listening ? 'Listening, start reading aloud' : 'Starting mic…'))
    }
  } else if (timerDriven && (isRecording || recState === 'paused')) {
    statusText = userPaused || recState === 'paused' ? 'Scroll paused' : `Timed scroll, ${settings.wpm} wpm`
  } else if (timerDriven && testing) {
    statusText = `Scroll test, ${settings.wpm} wpm`
  }
  if (notice && (isRecording || recState === 'countdown')) {
    statusWarn = true
    statusText = notice
  }
  const showPill = isRecording || recState === 'paused' || testing
  // Timed scrolling (always the case outside Chromium) gets a prominent control
  // bar under the box instead of the status strip: speed and, during a take,
  // back / pause / forward. The strip's text moves into the bar.
  // Timed scrolling shows no strip (owner's call): only warnings get through.
  // Voice following keeps it, the "heard" line is how you know the mic works.
  const showStatus = showBox && (statusWarn || (!timerDriven && (statusText || showPill)))
  const nudgeWpm = (d) => setSetting({ wpm: clamp(settings.wpm + d, WPM_MIN, WPM_MAX) })

  const boxStyle = box
    ? { left: box.x, top: box.y, width: box.w, height: box.h }
    : { left: '5%', top: '6%', width: '90%', height: '38%' }
  // Status strip below the box, or above it when the box sits at the bottom.
  const statusBelow = !box || box.y + box.h + 40 < winH()
  const statusStyle = box
    ? (statusBelow
      ? { left: box.x, width: box.w, top: box.y + box.h + 6 }
      : { left: box.x, width: box.w, top: Math.max(4, box.y - 34) })
    : { left: '5%', width: '90%', top: '45%' }
  const scrollStyle = { color: settings.fontColor, fontSize: `${settings.fontSize}px` }
  const boxBg = hexToRgba(settings.bgColor, settings.bgOpacity)

  const showMenu = active && !editorOpen && recState !== 'done'

  if (!editorOpen && !showBox && !settingsOpen) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="tp-layer" {...shieldProps}>
      {editorOpen && (
        <div className="tp-script-phase">
          <div className="tp-script-head">
            <button type="button" className="tp-icon-btn" onClick={closeEditor} aria-label="Close"><X size={22} /></button>
            <span className="tp-title">Teleprompter</span>
            <span style={{ width: 40 }} />
          </div>
          {speechNotice}
          <textarea
            className="tp-script-full"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="Write or paste your script here. While you record it scrolls as you read it aloud, or at a steady speed in timed mode."
            autoFocus
          />
          <div className="tp-script-bar">
            <span className="tp-script-mode">
              {effectiveMode === 'voice' ? 'Scroll: follows your voice' : `Scroll: timed, ${settings.wpm} wpm`}
            </span>
            {settingsGearBtn}
          </div>
          <div className="tp-script-controls">
            {enabled && (
              <button type="button" className="tp-btn tp-btn--ghost" onClick={hideTeleprompter}>
                <EyeOff size={16} /> Hide
              </button>
            )}
            <button type="button" className="tp-btn tp-btn--accent" onClick={showOnCamera} disabled={!script.trim()}>
              Show on camera
            </button>
          </div>
        </div>
      )}

      {showBox && (
        <div
          ref={boxRef}
          className="tp-box"
          style={{ ...boxStyle, background: boxBg }}
          onPointerMove={onBoxPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="tp-scroll" ref={scrollRef} style={scrollStyle}>
            <div className={`tp-text${settings.mirrorText ? ' tp-text--mirror' : ''}`}>
              {tp.words.map((w, i) => (
                <React.Fragment key={i}>
                  {/* the author's own line/paragraph breaks, capped at one blank line */}
                  {w.br > 0 && Array.from({ length: Math.min(w.br, 2) }, (_, k) => <br key={k} />)}
                  <span
                    ref={i === pointer ? currentWordRef : null}
                    className={
                      i < pointer ? 'tp-word tp-word--read'
                        : i === pointer ? 'tp-word tp-word--current' : 'tp-word'
                    }
                  >
                    {w.text}{' '}
                  </span>
                </React.Fragment>
              ))}
            </div>
          </div>
          {/* small corner grip instead of a header bar, so the script can sit
              right under the front lens without an obvious UI strip above it */}
          <div className="tp-grip" onPointerDown={beginDrag('move')} title="Drag to move">
            <GripHorizontal size={13} />
          </div>
          <div className="tp-resize" onPointerDown={beginDrag('resize')} title="Drag to resize" />
        </div>
      )}

      {showStatus && (
        <div className={`tp-status${statusWarn ? ' tp-status--warn' : ''}`} style={statusStyle}>
          {voiceLive && !statusWarn && <Mic size={13} />}
          <span className="tp-status-text">{statusText}</span>
          {showPill && (
            <span className={`tp-pill${(voiceLive && tp.listening) || timed.running ? ' tp-pill--on' : ''}`}>
              {pointer}/{tp.totalWords}
            </span>
          )}
        </div>
      )}

      {showMenu && (
        <div ref={menu.ref} className="tp-menu" style={{ left: menu.pos.x, top: menu.pos.y }} {...menu.surfaceProps}>
          <div className="tp-menu-head" {...menu.handleProps}>
            <GripHorizontal size={14} />
            <span className="tp-menu-title">Teleprompter</span>
            <button type="button" className="tp-menu-collapse" onPointerDown={stopProp} onClick={() => setMenuCollapsed((c) => !c)} aria-label={menuCollapsed ? 'Expand menu' : 'Collapse menu'}>
              {menuCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          </div>
          {!menuCollapsed && (
            <div className="tp-menu-body">
              {recState === 'idle' && (
                <>
                  <button type="button" className="tp-menu-btn" onClick={editScript}>
                    <Pencil size={15} /> Edit script
                  </button>
                  {effectiveMode === 'voice' && (
                    <button type="button" className={`tp-menu-btn${testing ? ' is-on' : ''}`} onClick={toggleVoiceTest}>
                      <Mic size={15} /> {testing ? 'Stop voice test' : 'Test voice'}
                    </button>
                  )}
                </>
              )}
              {timerDriven && (
                <div className="tp-menu-speed" onPointerDown={stopProp}>
                  <span className="tp-menu-speed-label">Scroll speed</span>
                  <div className="tp-menu-speed-row">
                    <button type="button" className="tp-sb-btn tp-sb-btn--sm" onClick={() => nudgeWpm(-WPM_STEP)} disabled={settings.wpm <= WPM_MIN} aria-label="Slower" title="Slower">
                      <Minus size={16} />
                    </button>
                    <span className="tp-sb-speed">
                      <strong>{settings.wpm}</strong>
                      <small>words/min</small>
                    </span>
                    <button type="button" className="tp-sb-btn tp-sb-btn--sm" onClick={() => nudgeWpm(WPM_STEP)} disabled={settings.wpm >= WPM_MAX} aria-label="Faster" title="Faster">
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
              )}
              {recState === 'idle' && timerDriven && (
                <button type="button" className={`tp-menu-btn${testing ? ' is-on' : ''}`} onClick={toggleScrollTest}>
                  {testing ? <Pause size={15} /> : <Play size={15} />} {testing ? 'Stop scroll test' : 'Test scroll'}
                </button>
              )}
              {isRecording && timerDriven && (
                <button type="button" className="tp-menu-btn" onClick={toggleUserPause}>
                  {userPaused ? <Play size={15} /> : <Pause size={15} />} {userPaused ? 'Resume scroll' : 'Pause scroll'}
                </button>
              )}
              {settingsGearBtn}
              {recState === 'idle' && (
                <button type="button" className="tp-menu-btn" onClick={hideTeleprompter}>
                  <EyeOff size={15} /> Hide teleprompter
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {settingsPopupEl}
    </div>,
    document.body
  )
})

export default Teleprompter
