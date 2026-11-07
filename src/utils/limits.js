import { EDITOR_MODE } from './editorMode'

// Length limit for a rendered short. The timeline itself can run longer
// (the creator trims it down in the editor); rendering is disabled until it fits.
// The 3Speak frontend accepts shorts up to SHORTS_MAX_DURATION_SEC (120 s by
// default, src/utils/config.js there); keep the two in step.
export const MAX_SHORT_SECONDS = 120
// The audio editor (podcasts): up to 3 hours. The backend refuses longer audio
// renders (MAX_AUDIO_RENDER_SECONDS in backend/src/routes/render.js); keep in step.
export const MAX_AUDIO_SECONDS = 3 * 60 * 60

export const maxSecondsFor = (mode) => (mode === 'audio' ? MAX_AUDIO_SECONDS : MAX_SHORT_SECONDS)
// The limit of this page's editor (the mode is fixed per page, see editorMode.js)
export const MAX_TIMELINE_SECONDS = maxSecondsFor(EDITOR_MODE)

// Biggest file the editor takes: the backend accepts uploads up to 2 GB, and a
// bigger file could never be rendered (or held by the browser for long)
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024
// Biggest file whose audio the browser analyses in memory (waveform, Auto cut,
// Beat sync): decoding needs several times the file size in RAM
export const MAX_ANALYSE_BYTES = 300 * 1024 * 1024

// "15.2 GB" / "380 MB"
export const formatBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`)

// "2 minutes" / "2-minute" / "3 hours" for user-facing messages, derived from the number.
export function limitText(seconds) {
  const hours = seconds / 3600
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`
  const minutes = seconds / 60
  return Number.isInteger(minutes) ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${seconds} seconds`
}
export function limitAdjective(seconds) {
  const hours = seconds / 3600
  if (Number.isInteger(hours)) return `${hours}-hour`
  const minutes = seconds / 60
  return Number.isInteger(minutes) ? `${minutes}-minute` : `${seconds}-second`
}
export const MAX_TIMELINE_TEXT = limitText(MAX_TIMELINE_SECONDS)
export const MAX_TIMELINE_ADJ = limitAdjective(MAX_TIMELINE_SECONDS)

// Where the last clip on any track ends, i.e. how long a render would be.
// The timeline itself is not capped; only rendering is held to the limit.
export function getTimelineEnd(tracks) {
  let end = 0
  for (const track of tracks || []) {
    for (const clip of track.clips) {
      end = Math.max(end, (clip.timelinePosition || 0) + (clip.endTime - clip.startTime))
    }
  }
  return end
}

// Small tolerance so float drift from trims does not block a 2:00.00 edit
export const isOverTimelineLimit = (tracks) => getTimelineEnd(tracks) > MAX_TIMELINE_SECONDS + 0.01

// "1:05" / "1:02:05" (hours only when there are some)
export function formatLength(seconds) {
  const s = Math.ceil(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${Math.floor(s / 60)}:${sec}`
}
