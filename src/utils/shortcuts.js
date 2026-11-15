// Keyboard shortcuts for heavy users (hooks/useShortcuts.js runs them):
// J / K / L shuttle, frame steps, moving between clips, and the list the
// `?` sheet shows (components/ShortcutSheet.jsx), the older App.jsx and
// Timeline.jsx shortcuts included so the sheet is the one place to look.

export const FRAME_RATE = 30 // the editor renders 30 fps (Shorts and audiograms)
export const SHUTTLE_SPEEDS = [1, 2, 4, 8]

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
export const modKey = () => (isMac() ? '⌘' : 'Ctrl')

/**
 * Every shortcut, grouped, for the sheet. `only`: 'audio' / 'video' (the
 * audio editor or the Shorts editor), else both.
 */
export function shortcutList(mod = modKey()) {
  return [
    {
      title: 'Playback',
      items: [
        { keys: ['Space'], label: 'Play / pause' },
        { keys: ['L'], label: 'Play forward; press again for 2x, 4x, 8x' },
        { keys: ['J'], label: 'Play backward; press again for faster' },
        { keys: ['K'], label: 'Stop' },
        { keys: [',', '.'], label: 'One frame back / forward (Shift: 10 frames)' },
        { keys: ['←', '→'], label: 'Move the playhead 0.1 s (Shift: 1 s)' },
        { keys: ['F'], label: 'Full screen on / off' }
      ]
    },
    {
      title: 'Clips',
      items: [
        { keys: ['Tab', 'Shift+Tab'], label: 'Select the next / previous clip' },
        { keys: ['Alt+←', 'Alt+→'], label: 'Previous / next clip on the same track' },
        { keys: ['Alt+↑', 'Alt+↓'], label: 'Clip on the track above / below' },
        { keys: ['Enter'], label: 'Open the selected clip\'s settings' },
        { keys: ['Esc'], label: 'Select nothing' },
        { keys: [`${mod}+A`], label: 'Select every clip' },
        { keys: ['Delete'], label: 'Remove the selected clip(s)' },
        { keys: [`${mod}+R`], label: 'Split the selected clip at the playhead' },
        { keys: [`${mod}+D`], label: 'Duplicate the selected clip' },
        { keys: [`${mod}+Shift+G`], label: 'Ungroup clips' },
        { keys: ['G'], label: 'Close the gap at the playhead' },
        { keys: ['T'], label: 'Add text at the playhead', only: 'video' }
      ]
    },
    {
      title: 'Project',
      items: [
        { keys: [`${mod}+Z`], label: 'Undo' },
        { keys: [`${mod}+Shift+Z`, `${mod}+Y`], label: 'Redo' },
        { keys: ['B'], label: 'Add a flag at the playhead' },
        { keys: ['M'], label: 'Add a chapter at the playhead', only: 'audio' },
        { keys: [`${mod}+=`, `${mod}+-`], label: 'Zoom the timeline in / out' },
        { keys: ['?'], label: 'Show these shortcuts' }
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

/** A track's name for screen readers ("Voice", "Video track 2"). */
export function trackAriaLabel(track, index = 0) {
  const kind = track?.type === 'audio' ? (track.music ? 'Music track' : 'Audio track') : 'Video track'
  return track?.name ? `${track.name} (${kind.toLowerCase()})` : `${kind} ${index + 1}`
}

const KIND = { video: 'Video clip', audio: 'Sound clip', image: 'Image', text: 'Text', color: 'Colour' }

/** What a screen reader says for a clip ("Video clip intro.mp4, 0:03.0 to 0:08.0"). */
export function clipLabel(clip, track = null) {
  if (!clip) return ''
  const kind = KIND[clip.type] || 'Clip'
  const name = clip.type === 'text' ? (clip.text || clip.name || '') : (clip.name || '')
  const where = track?.name ? ` on ${track.name}` : ''
  return `${kind}${name ? ` ${String(name).slice(0, 60)}` : ''}${where}, ${fmt(start(clip))} to ${fmt(end(clip))}`
}
