// The landscape video editor (16:9, 4:3, 1:1) is part of 3Speak Pro; Shorts (9:16) and the audio
// editor stay free. The backend decides (backend/src/proGate.js: the render route answers 403
// pro_required); the editor asks GET /api/pro-status once it has the 3Speak sign-in, so a free
// user sees the Pro notice while editing instead of a refused render at the end. When the
// question cannot be answered the editor does not lock anything (the backend fails open too).
import { isShortAspect } from './projectFormat'

export const PRO_ASPECTS = ['16:9', '4:3', '1:1']
export const isProAspect = (aspect) => !isShortAspect(aspect)

// Where Pro is sold when the backend did not name the page (an older backend, no sign-in)
const SITE = 'https://3speak.tv'
export const fallbackUpgradeUrl = (user) => (user ? `${SITE}/wallet/${encodeURIComponent(String(user).toLowerCase())}#pro` : SITE)

/** The answer of /api/pro-status as the editor uses it: { allowed, pro, reason, upgradeUrl }. */
export function normalizeAccess(data, user = null) {
  if (!data || typeof data.landscapeAllowed !== 'boolean') return { allowed: true, pro: null, reason: 'unknown', upgradeUrl: fallbackUpgradeUrl(user) }
  return {
    allowed: data.landscapeAllowed,
    pro: typeof data.pro === 'boolean' ? data.pro : null,
    reason: data.reason || null,
    upgradeUrl: typeof data.upgradeUrl === 'string' && /^https:\/\//.test(data.upgradeUrl) ? data.upgradeUrl : fallbackUpgradeUrl(data.user || user),
  }
}

/** Ask the backend. Never throws: a failed question allows (fail open, as the backend). */
export async function fetchLandscapeAccess({ url, token = null, user = null, fetchImpl = (...a) => fetch(...a), signal } = {}) {
  try {
    const res = await fetchImpl(url, { cache: 'no-store', signal, headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!res.ok) return normalizeAccess(null, user)
    return normalizeAccess(await res.json(), user)
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    return normalizeAccess(null, user)
  }
}

/** A render refusal from the backend (403 pro_required) as an access answer. */
export function accessFromRefusal(body, user = null) {
  return {
    allowed: false,
    pro: false,
    reason: 'free',
    upgradeUrl: typeof body?.upgrade_url === 'string' && /^https:\/\//.test(body.upgrade_url) ? body.upgrade_url : fallbackUpgradeUrl(user),
  }
}

export const isProRefusal = (x) => x?.code === 'pro_required'

/** The editor shows the Pro notice instead of the landscape editor. */
export function landscapeLocked(access, aspect, audioMode = false) {
  return !audioMode && access?.allowed === false && isProAspect(aspect)
}

/** The shapes Export as may not render for this user. */
export const lockedExportAspects = (access, audioMode = false) => (!audioMode && access?.allowed === false ? PRO_ASPECTS : [])
