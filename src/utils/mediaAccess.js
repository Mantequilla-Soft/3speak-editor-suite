// Camera and microphone access for the recorders.
//
// getUserMedia fails for many reasons that are not "you said no": the camera is
// busy in another app or tab (a video call), the device can't do the requested
// settings, there is no camera, or the system blocks the browser. The recorders
// used to show "Camera access denied" for all of them, so tell them apart and
// try once more with plain settings when the first ask is too specific.
import { t } from '../i18n'

const RETRY_PLAIN = new Set(['OverconstrainedError', 'ConstraintNotSatisfiedError', 'NotReadableError', 'TrackStartError', 'AbortError'])

export async function openCamera({ audio = true, facingMode = 'user', getUserMedia } = {}) {
  const gum = getUserMedia || (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
    ? (c) => navigator.mediaDevices.getUserMedia(c)
    : null)
  if (!gum) {
    const err = new Error('getUserMedia is not available')
    err.name = 'NoMediaDevices'
    throw err
  }
  try {
    return await gum({ video: { facingMode }, audio })
  } catch (err) {
    if (!RETRY_PLAIN.has(err?.name)) throw err
    // a camera that can't do facingMode, or one still being released: ask plainly
    await new Promise(r => setTimeout(r, 300))
    return gum({ video: true, audio })
  }
}

export async function openMicrophone({ getUserMedia } = {}) {
  const gum = getUserMedia || (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
    ? (c) => navigator.mediaDevices.getUserMedia(c)
    : null)
  if (!gum) {
    const err = new Error('getUserMedia is not available')
    err.name = 'NoMediaDevices'
    throw err
  }
  return gum({ audio: true })
}

// What went wrong, in plain words, and what to do next. `devices` names what
// was asked for: 'camera' (camera + microphone) or 'microphone'. Each text has
// both variants as whole sentences (record.media.<cause>.camera / .microphone).
export function mediaErrorMessage(err, devices = 'camera') {
  const which = devices === 'camera' ? 'camera' : 'microphone'
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return t(`record.media.blocked.${which}`)
    case 'SecurityError':
      return t(`record.media.notAllowed.${which}`)
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return t(`record.media.busy.${which}`)
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return t(`record.media.notFound.${which}`)
    case 'NoMediaDevices':
      return t(`record.media.noDevices.${which}`)
    default:
      return err?.name
        ? t(`record.media.failedNamed.${which}`, { name: String(err.name) })
        : t(`record.media.failed.${which}`)
  }
}
