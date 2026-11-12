// Camera and microphone access for the recorders.
//
// getUserMedia fails for many reasons that are not "you said no": the camera is
// busy in another app or tab (a video call), the device can't do the requested
// settings, there is no camera, or the system blocks the browser. The recorders
// used to show "Camera access denied" for all of them, so tell them apart and
// try once more with plain settings when the first ask is too specific.

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
// was asked for: 'camera' (camera + microphone) or 'microphone'.
export function mediaErrorMessage(err, devices = 'camera') {
  const both = devices === 'camera' ? 'camera or microphone' : 'microphone'
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return `The ${both} is blocked for this site. Allow it with the icon in the address bar, then try again. If you never said no, your computer's privacy settings may be blocking the browser.`
    case 'SecurityError':
      return `This page is not allowed to use the ${both}. Reload 3Speak and try again.`
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return `Your ${both} is busy in another app or tab (a video call, another recorder). Close it there, then try again.`
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return `No ${both} found. Connect one, then try again.`
    case 'NoMediaDevices':
      return `This browser cannot use the ${both} here.`
    default:
      return `The ${both} could not start${err?.name ? ` (${err.name})` : ''}. Try again.`
  }
}
