// The audio template: what a creator puts around every recording (an intro, an
// outro, a music bed under the talking) plus their finishing settings. One per
// person, kept on the editor backend for good (/api/templates/audio).
//
// Applying it is a pure function of the tracks, so it can be undone in one step
// and applied again: clips it placed carry `templateRole` ('intro' | 'outro' |
// 'bed') and are replaced, never stacked, when it is applied once more.

export const TEMPLATE_ROLES = ['intro', 'outro', 'bed']
export const BED_DEFAULT_VOLUME = 20
export const BED_DEFAULT_FADE_OUT = 2

const UPLOAD_URL = /\/api\/upload\/files\/[A-Za-z0-9_.-]+(\?[^\s"]*)?$/
const length = (c) => Math.max(0, (c.endTime || 0) - (c.startTime || 0))
const end = (c) => (c.timelinePosition || 0) + length(c)

let counter = 0
const defaultId = (prefix) => `${prefix}_tpl_${Date.now().toString(36)}_${(counter++).toString(36)}`

export const isTemplateClip = (clip) => !!clip?.templateRole
export const slotLength = (slot) => (slot ? Math.max(0, slot.endTime - slot.startTime) : 0)
export const hasSlots = (template) => !!template && TEMPLATE_ROLES.some(r => template.slots?.[r])

/**
 * A template slot from a clip on the timeline: only an uploaded clip can be
 * kept (the template outlives this browser), so null for one still uploading.
 */
export function slotFromClip(clip, role) {
  const url = clip?.serverUrl && UPLOAD_URL.test(clip.serverUrl) ? clip.serverUrl : (UPLOAD_URL.test(clip?.url || '') ? clip.url : null)
  if (!url || clip.type !== 'audio') return null
  const slot = {
    url,
    name: String(clip.name || role).replace(/^Part \d+ · /, ''),
    duration: clip.duration || clip.endTime,
    startTime: clip.startTime || 0,
    endTime: clip.endTime,
    volume: Number.isFinite(+clip.volume) ? +clip.volume : (role === 'bed' ? BED_DEFAULT_VOLUME : 100),
    fadeIn: +clip.fadeIn || 0,
    fadeOut: +clip.fadeOut || 0
  }
  if (role === 'bed') slot.loop = true
  return slot
}

/** The creator's own content: every clip the template did not place. */
export function contentSpan(tracks) {
  let start = Infinity
  let stop = 0
  for (const t of tracks) {
    if (t.type !== 'audio' || t.music) continue
    for (const c of t.clips) {
      if (isTemplateClip(c)) continue
      start = Math.min(start, c.timelinePosition || 0)
      stop = Math.max(stop, end(c))
    }
  }
  return start === Infinity ? null : { start, end: stop }
}

const placed = (slot, role, timelinePosition, newId, extra = {}) => ({
  id: newId('clip'),
  type: 'audio',
  name: slot.name || role,
  url: slot.url,
  serverUrl: slot.url,
  duration: slot.duration || slot.endTime,
  startTime: slot.startTime,
  endTime: slot.endTime,
  timelinePosition,
  audioEnabled: true,
  volume: Number.isFinite(+slot.volume) ? +slot.volume : 100,
  fadeIn: +slot.fadeIn || 0,
  fadeOut: +slot.fadeOut || 0,
  libraryId: null,
  groupId: null,
  templateRole: role,
  ...extra
})

/**
 * Put the template around the content: intro at 0:00 (the content moves right
 * to make room), outro straight after the content, the music bed under the
 * content (looped to fill it, faded out at the end). Clips of an earlier
 * application are replaced, and the content moves by the difference in intro
 * length, so applying twice changes nothing and an empty template takes the
 * template back off. Returns new tracks (the input is not changed).
 */
export function applyAudioTemplate(tracks, template, { newId = defaultId } = {}) {
  const slots = template?.slots || {}
  let prevIntro = 0
  for (const t of tracks) for (const c of t.clips) if (c.templateRole === 'intro') prevIntro = Math.max(prevIntro, length(c))
  const introLen = slotLength(slots.intro)
  const shift = introLen - prevIntro

  // Without the old template clips, content moved for the new intro length
  let next = tracks.map(t => ({
    ...t,
    clips: t.clips.filter(c => !isTemplateClip(c)).map(c => (shift ? { ...c, timelinePosition: Math.max(0, (c.timelinePosition || 0) + shift) } : c))
  }))
  // A music track the template made and that is now empty goes too
  next = next.filter(t => !(t.templateTrack && t.clips.length === 0))

  let voice = next.find(t => t.type === 'audio' && !t.music)
  if (!voice && (slots.intro || slots.outro)) {
    voice = { id: newId('track'), type: 'audio', name: 'Voice', clips: [] }
    next = [voice, ...next]
  }

  const span = contentSpan(next)
  const contentStart = span ? span.start : introLen
  const contentEnd = span ? span.end : introLen

  const add = (trackId, clips) => {
    next = next.map(t => (t.id === trackId ? { ...t, clips: [...t.clips, ...clips].sort((a, b) => (a.timelinePosition || 0) - (b.timelinePosition || 0)) } : t))
  }
  if (slots.intro) add(voice.id, [placed(slots.intro, 'intro', 0, newId)])
  if (slots.outro) add(voice.id, [placed(slots.outro, 'outro', contentEnd, newId)])

  const bedSpan = contentEnd - contentStart
  if (slots.bed && span && bedSpan > 0.05) {
    const piece = slotLength(slots.bed)
    const pieces = []
    if (piece > 0.05) {
      let at = contentStart
      const loop = slots.bed.loop !== false
      while (at < contentEnd - 0.05) {
        const len = Math.min(piece, contentEnd - at)
        pieces.push(placed(slots.bed, 'bed', at, newId, {
          endTime: slots.bed.startTime + len,
          fadeIn: pieces.length === 0 ? (+slots.bed.fadeIn || 0) : 0,
          fadeOut: 0
        }))
        at += len
        if (!loop) break
      }
      // The last piece fades out (its own fade, or a short one where the bed is cut off)
      const last = pieces[pieces.length - 1]
      if (last) last.fadeOut = Math.min(length(last), +slots.bed.fadeOut || BED_DEFAULT_FADE_OUT)
    }
    if (pieces.length) {
      // A music track free over the content, else a new one for the bed
      let bedTrack = next.find(t => t.type === 'audio' && t.music && !t.clips.some(c => (c.timelinePosition || 0) < contentEnd && end(c) > contentStart))
      if (!bedTrack) {
        bedTrack = { id: newId('track'), type: 'audio', name: 'Music bed', music: true, templateTrack: true, clips: [] }
        next = [...next, bedTrack]
      }
      add(bedTrack.id, pieces)
    }
  }
  return next
}

/** Take the template back off (and move the content back where it was). */
export const removeAudioTemplate = (tracks) => applyAudioTemplate(tracks, { slots: {} })

/** Which template parts are on the timeline right now. */
export function appliedRoles(tracks) {
  const roles = new Set()
  for (const t of tracks) for (const c of t.clips) if (c.templateRole) roles.add(c.templateRole)
  return TEMPLATE_ROLES.filter(r => roles.has(r))
}

// "My Show: Episode 4!" -> "my-show-episode-4.mp3" (the file 3Speak receives)
export function audioFileName(title) {
  const slug = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `${slug || 'edited-audio'}.mp3`
}
