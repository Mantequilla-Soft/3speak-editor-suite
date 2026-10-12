// Editor-wide length cap for a timeline (and so for a rendered short).
// The 3Speak frontend accepts shorts up to SHORTS_MAX_DURATION_SEC (120 s by
// default, src/utils/config.js there); keep the two in step.
export const MAX_TIMELINE_SECONDS = 120

// "2 minutes" / "2-minute" for user-facing messages, derived from the number.
const minutes = MAX_TIMELINE_SECONDS / 60
export const MAX_TIMELINE_TEXT = Number.isInteger(minutes)
  ? `${minutes} minute${minutes === 1 ? '' : 's'}`
  : `${MAX_TIMELINE_SECONDS} seconds`
export const MAX_TIMELINE_ADJ = Number.isInteger(minutes)
  ? `${minutes}-minute`
  : `${MAX_TIMELINE_SECONDS}-second`
