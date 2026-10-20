// Length limit for a rendered short. The timeline itself can run longer
// (the creator trims it down in the editor); rendering is disabled until it fits.
// The 3Speak frontend accepts shorts up to SHORTS_MAX_DURATION_SEC (120 s by
// default, src/utils/config.js there); keep the two in step.
export const MAX_TIMELINE_SECONDS = 120

// Biggest file the editor takes: the backend accepts uploads up to 2 GB, and a
// bigger file could never be rendered (or held by the browser for long)
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024
// Biggest file whose audio the browser analyses in memory (waveform, Auto cut,
// Beat sync): decoding needs several times the file size in RAM
export const MAX_ANALYSE_BYTES = 300 * 1024 * 1024

// "15.2 GB" / "380 MB"
export const formatBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`)

// "2 minutes" / "2-minute" for user-facing messages, derived from the number.
const minutes = MAX_TIMELINE_SECONDS / 60
export const MAX_TIMELINE_TEXT = Number.isInteger(minutes)
  ? `${minutes} minute${minutes === 1 ? '' : 's'}`
  : `${MAX_TIMELINE_SECONDS} seconds`
export const MAX_TIMELINE_ADJ = Number.isInteger(minutes)
  ? `${minutes}-minute`
  : `${MAX_TIMELINE_SECONDS}-second`

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

export function formatLength(seconds) {
  const s = Math.ceil(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
