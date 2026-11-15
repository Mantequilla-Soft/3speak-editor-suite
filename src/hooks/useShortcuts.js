import { useState, useRef, useEffect, useCallback } from 'react'
import { isTypingTarget } from '../utils/keyboard'
import '../styles/shortcuts.css'
import { t } from '../i18n'
import { shortcutAction, nextShuttleSpeed, stepFrames, neighbourClip, clipLabel, FRAME_RATE } from '../utils/shortcuts'

// The shuttle moves the playhead itself (the preview paused) at 2x and more,
// and backward; this often a second (smooth enough, light on the timeline)
const SHUTTLE_TICK_MS = 50

// Keys that belong to a control with the focus (a button's Enter, a list's Tab)
const ownsKeys = (el) => !!el && el !== document.body && !el.closest?.('.timeline-clip-v2')
// A dialog is open: its own keys
const dialogOpen = () => !!document.querySelector('.remix-picker-overlay, [aria-modal="true"]')

/**
 * The heavy-user shortcuts (utils/shortcuts.js). preview = the GlobalPreview
 * handle ({ togglePlay, pause, seek, getPosition }), playing = it plays now.
 * Returns { sheetOpen, setSheetOpen, announcement } for the `?` sheet and
 * the screen reader line.
 */
export function useShortcuts({ previewRef, playing, tracks, duration, selectedClipId, selectClip, setPlayheadPosition, openClip, enabled = true }) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const sheetOpenRef = useRef(false)
  sheetOpenRef.current = sheetOpen
  const [announcement, setAnnouncement] = useState('')
  const speedRef = useRef(0) // shuttle: 0 stopped, 1 normal play, 2/4/8, negative = backward
  const timerRef = useRef(null)
  const live = useRef({})
  live.current = { playing, tracks, duration, selectedClipId, selectClip, setPlayheadPosition, openClip }

  const stopShuttle = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    speedRef.current = 0
  }, [])

  const runShuttle = useCallback((speed) => {
    const preview = previewRef.current
    if (!preview) return
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    speedRef.current = speed
    if (speed === 0) { preview.pause?.(); return }
    if (speed === 1) {
      // normal playback, with sound
      if (!live.current.playing) preview.togglePlay?.()
      return
    }
    // faster, or backward: the preview paused, the playhead moved along
    preview.pause?.()
    let last = performance.now()
    timerRef.current = setInterval(() => {
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      const end = live.current.duration || 0
      const at = (preview.getPosition?.() ?? 0) + speedRef.current * dt
      const pos = Math.max(0, Math.min(end, at))
      preview.seek?.(pos)
      if (pos <= 0 || pos >= end) stopShuttle()
    }, SHUTTLE_TICK_MS)
  }, [previewRef, stopShuttle])

  // The normal playback stopped (end of the timeline, a click on pause): so does L
  useEffect(() => { if (!playing && speedRef.current === 1) speedRef.current = 0 }, [playing])
  useEffect(() => stopShuttle, [stopShuttle])

  const say = useCallback((text) => setAnnouncement(text), [])

  const selectAndFocus = useCallback((id) => {
    const { tracks: ts, selectClip: sel } = live.current
    sel(id)
    const track = ts.find(t => t.clips.some(c => c.id === id))
    const clip = track?.clips.find(c => c.id === id)
    say(t('shortcuts.announce.selected', { clip: clipLabel(clip, track) }))
    // the clip itself gets the focus (screen readers read it), in view
    requestAnimationFrame(() => {
      const el = document.querySelector(`.timeline-clip-v2[data-clip-id="${CSS.escape(id)}"]`)
      if (!el) return
      el.focus?.({ preventScroll: true })
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    })
  }, [say])

  useEffect(() => {
    if (!enabled) return
    const onKey = (e) => {
      // anything else than J / K / L ends a running shuttle
      const action = shortcutAction(e)
      if (timerRef.current && !(action && action.startsWith('shuttle-'))) stopShuttle()
      if (!action || e.defaultPrevented) return
      if (isTypingTarget(e.target)) return
      if (dialogOpen()) {
        if (action === 'sheet' && sheetOpenRef.current) { e.preventDefault(); setSheetOpen(false) }
        return
      }
      const { selectedClipId: sel, tracks: ts, setPlayheadPosition: setPos, openClip: open } = live.current
      const tag = e.target?.tagName
      const inControl = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'

      if (action === 'sheet') {
        e.preventDefault()
        setSheetOpen(true)
        return
      }
      if (action.startsWith('shuttle-')) {
        if (inControl) return
        e.preventDefault()
        const speed = nextShuttleSpeed(speedRef.current === 1 && !live.current.playing ? 0 : speedRef.current, action.slice(-1))
        runShuttle(speed)
        say(speed === 0 ? t('shortcuts.announce.stopped') : t(speed < 0 ? 'shortcuts.announce.backward' : 'shortcuts.announce.forward', { speed: Math.abs(speed) }))
        return
      }
      if (action === 'frame-back' || action === 'frame-forward') {
        if (inControl) return
        e.preventDefault()
        const preview = previewRef.current
        if (live.current.playing) preview?.pause?.()
        const n = (action === 'frame-back' ? -1 : 1) * (e.shiftKey ? 10 : 1)
        const at = preview?.getPosition?.() ?? 0
        const next = Math.min(live.current.duration || Infinity, stepFrames(at, n, FRAME_RATE))
        if (preview?.seek) preview.seek(next)
        else setPos(next)
        return
      }
      // Clips: Tab and Enter only from the timeline (elsewhere they move
      // between and press the controls, as always); Alt+arrows anywhere
      // but in a form control
      if (inControl) return
      if (action === 'clip-open') {
        if (!sel || ownsKeys(document.activeElement)) return
        e.preventDefault()
        open?.(sel)
        return
      }
      if (action === 'clip-next' || action === 'clip-prev') {
        if (!sel || ownsKeys(document.activeElement)) return
      }
      const dir = action.slice(5) // next prev left right up down
      const id = neighbourClip(ts, sel, dir)
      if (action === 'clip-next' || action === 'clip-prev') {
        if (!id) return // past the last clip: Tab goes on to the controls
      }
      e.preventDefault()
      if (id) selectAndFocus(id)
    }
    const onPointer = () => { if (timerRef.current) stopShuttle() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [enabled, previewRef, runShuttle, stopShuttle, selectAndFocus, say])

  return { sheetOpen, setSheetOpen, announcement, stopShuttle }
}
