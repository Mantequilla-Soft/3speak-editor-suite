// Keyboard shortcuts for heavy users (hooks/useShortcuts.js runs them):
// J / K / L shuttle, frame steps, moving between clips, and the list the
// `?` sheet shows (components/ShortcutSheet.jsx), the older App.jsx and
// Timeline.jsx shortcuts included so the sheet is the one place to look.

import { t } from '../i18n'

export const FRAME_RATE = 30 // the editor renders 30 fps (Shorts and audiograms)
export const SHUTTLE_SPEEDS = [1, 2, 4, 8]

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
export const modKey = () => (isMac() ? '⌘' : t('shortcuts.keys.ctrl'))

/**
 * Every shortcut, grouped, for the sheet. `only`: 'audio' / 'video' (the
 * audio editor or the Shorts editor), else both. Built when called, in the
 * interface language (key names too: Space, Enter...).
 */
export function shortcutList(mod = modKey()) {
  const k = (name) => t(`shortcuts.keys.${name}`)
  const item = (keys, name, only) => ({ id: name, keys, label: t(`shortcuts.items.${name}`), ...(only ? { only } : {}) })
  const shift = k('shift')
  const alt = k('alt')
  return [
    {
      id: 'playback',
      title: t('shortcuts.groups.playback'),
      items: [
        item([k('space')], 'playPause'),
        item(['L'], 'playForward'),
        item(['J'], 'playBackward'),
        item(['K'], 'stop'),
        item([',', '.'], 'frameStep'),
        item(['←', '→'], 'nudge'),
        item(['F'], 'fullscreen')
      ]
    },
    {
      id: 'clips',
      title: t('shortcuts.groups.clips'),
      items: [
        item([k('tab'), `${shift}+${k('tab')}`], 'nextPrevClip'),
        item([`${alt}+←`, `${alt}+→`], 'clipLeftRight'),
        item([`${alt}+↑`, `${alt}+↓`], 'clipUpDown'),
        item([k('enter')], 'openClip'),
        item([k('esc')], 'selectNone'),
        item([`${mod}+A`], 'selectAll'),
        item([k('delete')], 'remove'),
        item([`${mod}+R`], 'split'),
        item([`${mod}+D`], 'duplicate'),
        item([`${mod}+${shift}+G`], 'ungroup'),
        item(['G'], 'closeGap'),
        item(['T'], 'addText', 'video')
      ]
    },
    {
      id: 'project',
      title: t('shortcuts.groups.project'),
      items: [
        item([`${mod}+Z`], 'undo'),
        item([`${mod}+${shift}+Z`, `${mod}+Y`], 'redo'),
        item(['B'], 'addFlag'),
        item(['M'], 'addChapter', 'audio'),
        item([`${mod}+=`, `${mod}+-`], 'zoom'),
        item(['?'], 'showSheet')
      ]
    }
  ]
}

/** The shortcut list for one editor ('audio' or 'video'). */
export function shortcutsFor(mode, mod = modKey()) {
  return shortcutList(mod)
    .map(g => ({ ...g, items: g.items.filter(i => !i.only || i.only === mode) }))
    .filter(g => g.items.length)
}

/**
 * J / K / L: the next shuttle speed (negative = backward, 0 = stopped,
 * 1 = normal playback). L from stopped or backward plays at 1x, again 2x,
 * 4x, 8x; J the same backward; K stops.
 */
export function nextShuttleSpeed(speed, key) {
  const k = String(key).toLowerCase()
  if (k === 'k') return 0
  const dir = k === 'l' ? 1 : k === 'j' ? -1 : 0
  if (!dir) return speed
  if (Math.sign(speed) !== dir) return dir
  const i = SHUTTLE_SPEEDS.indexOf(Math.abs(speed))
  return dir * SHUTTLE_SPEEDS[Math.min(SHUTTLE_SPEEDS.length - 1, i + 1)]
}

/** The playhead one (or `frames`) frame(s) on, on a frame boundary, never below 0. */
export function stepFrames(position, frames, fps = FRAME_RATE) {
  const frame = Math.round((position || 0) * fps)
  return Math.max(0, (frame + frames) / fps)
}

/** What a key press does here, or null (not ours). e: a KeyboardEvent (or like it). */
export function shortcutAction(e) {
  const mod = e.ctrlKey || e.metaKey
  if (mod) return null
  const k = e.key
  if (!e.altKey) {
    if (k === '?') return 'sheet'
    if (k === 'j' || k === 'J' || k === 'k' || k === 'K' || k === 'l' || k === 'L') return e.shiftKey ? null : `shuttle-${k.toLowerCase()}`
    if (k === ',' || k === '<') return 'frame-back'
    if (k === '.' || k === '>') return 'frame-forward'
    if (k === 'Tab') return e.shiftKey ? 'clip-prev' : 'clip-next'
    if (k === 'Enter' && !e.shiftKey) return 'clip-open'
    return null
  }
  if (e.shiftKey) return null
  return { ArrowLeft: 'clip-left', ArrowRight: 'clip-right', ArrowUp: 'clip-up', ArrowDown: 'clip-down' }[k] || null
}

const start = (c) => c.timelinePosition || 0
const end = (c) => start(c) + Math.max(0, (c.endTime ?? c.duration ?? 0) - (c.startTime || 0))

/**
 * The tracks top to bottom as the timeline draws them: video tracks first
 * (in their order), then the audio tracks.
 */
export function visualTracks(tracks) {
  const list = tracks || []
  return [...list.filter(t => t.type !== 'audio'), ...list.filter(t => t.type === 'audio')]
}

/** Every clip, track by track (top to bottom), each track in time order: the Tab order. */
export function clipOrder(tracks) {
  return visualTracks(tracks).flatMap(t => [...(t.clips || [])].sort((a, b) => start(a) - start(b)))
}

/**
 * The clip to select from `clipId` in direction dir ('next', 'prev',
 * 'left', 'right', 'up', 'down'). Nothing selected: next/right/down start at
 * the first clip, prev/left/up at the last. At an end: null (stay).
 */
export function neighbourClip(tracks, clipId, dir) {
  const order = clipOrder(tracks)
  if (!order.length) return null
  const i = order.findIndex(c => c.id === clipId)
  if (i < 0) return (dir === 'prev' || dir === 'left' || dir === 'up' ? order[order.length - 1] : order[0]).id
  if (dir === 'next') return order[i + 1]?.id || null
  if (dir === 'prev') return order[i - 1]?.id || null
  const vt = visualTracks(tracks)
  const ti = vt.findIndex(t => (t.clips || []).some(c => c.id === clipId))
  const clip = order[i]
  if (dir === 'left' || dir === 'right') {
    const same = [...vt[ti].clips].sort((a, b) => start(a) - start(b))
    const j = same.findIndex(c => c.id === clipId)
    return same[dir === 'left' ? j - 1 : j + 1]?.id || null
  }
  // up / down: the nearest track that has clips, the clip there closest in time
  const mid = (start(clip) + end(clip)) / 2
  for (let t = ti + (dir === 'up' ? -1 : 1); t >= 0 && t < vt.length; t += dir === 'up' ? -1 : 1) {
    const clips = vt[t].clips || []
    if (!clips.length) continue
    const overlapping = clips.filter(c => start(c) <= mid && end(c) >= mid)
    const pool = overlapping.length ? overlapping : clips
    return pool.reduce((best, c) => (Math.abs((start(c) + end(c)) / 2 - mid) < Math.abs((start(best) + end(best)) / 2 - mid) ? c : best)).id
  }
  return null
}

const fmt = (s) => {
  const t = Math.max(0, s || 0)
  const m = Math.floor(t / 60)
  const sec = t - m * 60
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`
}
export { fmt as formatSpokenTime }

/** A track's name for screen readers ("Voice (audio track)", "Video track 2"). */
export function trackAriaLabel(track, index = 0) {
  const kind = track?.type === 'audio' ? (track.music ? 'music' : 'audio') : 'video'
  return track?.name
    ? t(`timeline.track.aria.named.${kind}`, { name: track.name })
    : t(`timeline.track.aria.numbered.${kind}`, { number: index + 1 })
}

const KIND = { video: 'video', audio: 'audio', image: 'image', text: 'text', color: 'color' }

/** What a screen reader says for a clip ("Video clip intro.mp4, 0:03.0 to 0:08.0"). */
export function clipLabel(clip, track = null) {
  if (!clip) return ''
  const kind = t(`timeline.clip.kind.${KIND[clip.type] || 'other'}`)
  const name = String(clip.type === 'text' ? (clip.text || clip.name || '') : (clip.name || '')).slice(0, 60)
  const vars = { kind, name, track: track?.name || '', from: fmt(start(clip)), to: fmt(end(clip)) }
  const form = name ? (track?.name ? 'namedOnTrack' : 'named') : (track?.name ? 'onTrack' : 'plain')
  return t(`timeline.clip.aria.${form}`, vars)
}
