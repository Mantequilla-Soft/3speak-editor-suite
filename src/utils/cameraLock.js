/**
 * Lock a camera's focus, exposure and white balance at their current values
 * (static-background key: the plate only stays valid while the camera does not
 * re-adjust). Each one is tried on its own, only when the browser and camera
 * list a 'manual' mode for it; nothing here ever throws.
 */
const CONTROLS = [
  // [mode setting, value that pins it, readable name]
  ['focusMode', 'focusDistance', 'focus'],
  ['exposureMode', 'exposureTime', 'exposure'],
  ['whiteBalanceMode', 'colorTemperature', 'white balance']
]

/**
 * Returns { result: { focus, exposure, 'white balance' } -> true when locked,
 *           applied: the constraint sets that worked (to re-apply them to a
 *           restarted camera with applyCameraLock) }.
 */
export async function lockCamera(track) {
  const result = {}
  const applied = []
  if (!track || typeof track.applyConstraints !== 'function') return { result, applied }
  let caps = {}
  let settings = {}
  try { caps = track.getCapabilities?.() || {} } catch { caps = {} }
  try { settings = track.getSettings?.() || {} } catch { settings = {} }
  for (const [mode, value, name] of CONTROLS) {
    result[name] = false
    if (!Array.isArray(caps[mode]) || !caps[mode].includes('manual')) continue
    const c = { [mode]: 'manual' }
    if (caps[value] && typeof settings[value] === 'number') c[value] = settings[value]
    try {
      await track.applyConstraints({ advanced: [c] })
      // 'advanced' sets the camera cannot meet are skipped silently: check
      let now = {}
      try { now = track.getSettings?.() || {} } catch { now = {} }
      if (now[mode] === undefined || now[mode] === 'manual') {
        result[name] = true
        applied.push(c)
      }
    } catch { /* not allowed on this camera */ }
  }
  return { result, applied }
}

/** Put saved lock values on a (restarted) camera track. */
export async function applyCameraLock(track, applied) {
  if (!track || typeof track.applyConstraints !== 'function') return
  for (const c of applied || []) {
    try { await track.applyConstraints({ advanced: [c] }) } catch { /* ignore */ }
  }
}

/** Back to automatic ('continuous') wherever the camera offers it. */
export async function unlockCamera(track) {
  if (!track || typeof track.applyConstraints !== 'function') return
  let caps = {}
  try { caps = track.getCapabilities?.() || {} } catch { caps = {} }
  for (const [mode] of CONTROLS) {
    if (!Array.isArray(caps[mode]) || !caps[mode].includes('continuous')) continue
    try { await track.applyConstraints({ advanced: [{ [mode]: 'continuous' }] }) } catch { /* ignore */ }
  }
}

/** One line for the recorder, from lockCamera's result. */
export function describeCameraLock(r) {
  if (!r) return ''
  const locked = Object.keys(r).filter(k => r[k])
  if (r.focus && r.exposure) return `Camera focus and exposure locked${r['white balance'] ? ', white balance too' : ''}.`
  if (!r.focus) {
    return `Your camera doesn't allow locking focus; avoid moving closer or further.${locked.length ? ` Locked: ${locked.join(', ')}.` : ''}`
  }
  return `Focus locked. Exposure can't be locked on this camera; keep the light steady.`
}
