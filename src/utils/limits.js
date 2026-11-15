import { EDITOR_MODE } from './editorMode'
import { t, formatNumber } from '../i18n'
import { MAX_VIDEO_SECONDS, isShortAspect, readProjectAspect } from './projectFormat'

// Length limit for a rendered short. The timeline itself can run longer
// (the creator trims it down in the editor); rendering is disabled until it fits.
// The 3Speak frontend accepts shorts up to SHORTS_MAX_DURATION_SEC (120 s by
// default, src/utils/config.js there); keep the two in step.
export const MAX_SHORT_SECONDS = 120
// The audio editor (podcasts): up to 3 hours. The backend refuses longer audio
// renders (MAX_AUDIO_RENDER_SECONDS in backend/src/routes/render.js); keep in step.
export const MAX_AUDIO_SECONDS = 3 * 60 * 60

// Landscape, classic and square videos (utils/projectFormat.js): up to 10 minutes
export { MAX_VIDEO_SECONDS }

export const maxSecondsFor = (mode, aspect = '9:16') => (mode === 'audio' ? MAX_AUDIO_SECONDS : isShortAspect(aspect) ? MAX_SHORT_SECONDS : MAX_VIDEO_SECONDS)
// The limit of this page's editor: its mode is fixed per page (editorMode.js),
// the video editor's shape can change (setProjectLimit). Live bindings: every
// module that imports them reads the current value.
export let MAX_TIMELINE_SECONDS = maxSecondsFor(EDITOR_MODE, readProjectAspect())

// Biggest file the editor takes: the backend accepts uploads up to 2 GB, and a
// bigger file could never be rendered (or held by the browser for long)
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024
// Biggest file whose audio the browser analyses in memory (waveform, Auto cut,
// Beat sync): decoding needs several times the file size in RAM
export const MAX_ANALYSE_BYTES = 300 * 1024 * 1024

// "15.2 GB" / "380 MB" (the number in the interface language: "15,2 GB" in German)
export const formatBytes = (n) => (n >= 1024 ** 3 ? `${formatNumber(Math.round(n / 1024 ** 3 * 10) / 10, { maximumFractionDigits: 1 })} GB` : `${formatNumber(Math.round(n / 1024 ** 2))} MB`)

// "2 minutes" / "3 hours" / "90 seconds" in the interface language, derived from the number.
export function limitText(seconds) {
  const hours = seconds / 3600
  if (Number.isInteger(hours)) return t('common.duration.hours', { count: hours })
  const minutes = seconds / 60
  return Number.isInteger(minutes) ? t('common.duration.minutes', { count: minutes }) : t('common.duration.seconds', { count: seconds })
}
// What a render of this project is: 'audio' (an export), 'short' or 'video'. Messages
// pick a whole sentence by it (common.limits.atMost.<kind>), never glue a noun in.
export let RENDER_KIND = EDITOR_MODE === 'audio' ? 'audio' : isShortAspect(readProjectAspect()) ? 'short' : 'video'
// Read at call time, so they follow the language and the project's shape
export const maxTimelineText = () => limitText(MAX_TIMELINE_SECONDS)
/** "A Short can be at most 2 minutes." for this project. */
export const atMostText = () => t(`common.limits.atMost.${RENDER_KIND}`, { limit: maxTimelineText() })

/** The video project's shape changed: its limit follows (2 minutes for a Short, else 10). */
export function setProjectLimit(aspect) {
  if (EDITOR_MODE === 'audio') return MAX_TIMELINE_SECONDS
  MAX_TIMELINE_SECONDS = maxSecondsFor(EDITOR_MODE, aspect)
  RENDER_KIND = isShortAspect(aspect) ? 'short' : 'video'
  return MAX_TIMELINE_SECONDS
}

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
