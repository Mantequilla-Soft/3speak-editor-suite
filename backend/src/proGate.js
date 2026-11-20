// The landscape video editor is part of 3Speak Pro (owner, 2026-11-20). Shorts (9:16) and the
// audio editor stay free for everyone, and so do the Ad Wizard's renders (an ad in 16:9 is the
// ad product, not the landscape editor).
//
// Who is Pro: `premium: true` in the embed service's `embed-users` collection (the checker's
// premiumSubsSync keeps it in step with the subscriptions contract; manual grants count too).
// This backend has no Mongo of its own, so it asks the checker's read-only GET /premium/:user,
// which reads exactly that row, the same lookup 3Speak itself does when it mints the editor
// token. The user is the VERIFIED one from that token (auth.js), never a name the request sends.
//
//   1. the token says pro (3Speak looked it up when it minted the token, at most 6 hours ago)
//      -> allowed, no lookup
//   2. else ask the checker (cached: Pro 5 min, free 1 min so an upgrade shows up quickly)
//   3. the checker cannot be asked (down, timeout, 5xx) -> allowed, with a log line (fail open):
//      a checker outage must not take renders away from paying users, and the worst case is a
//      free user getting a landscape render while it lasts. The failure is cached for 30 s so
//      an outage does not hammer the checker.
//
// LANDSCAPE_EDITOR_PRO_ONLY=false switches the rule off (default on). CHECKER_URL picks the
// checker, EDITOR_UPGRADE_URL the Pro page ({user} = the account), as on the audio servers.
import fs from 'fs'
import path from 'path'

export const FEATURE = 'landscape_editor'
const PRO_TTL_MS = 5 * 60 * 1000
const FREE_TTL_MS = 60 * 1000
const FAIL_TTL_MS = 30 * 1000
const CACHE_MAX = 5000
const LOOKUP_TIMEOUT_MS = 3000

/** Settings, read on every call so tests (and a restart) see the env as it is. */
export function proGateConfig(env = process.env) {
  return {
    enabled: String(env.LANDSCAPE_EDITOR_PRO_ONLY ?? '').trim().toLowerCase() !== 'false',
    checkerUrl: (env.CHECKER_URL || 'https://checker.3speak.tv').replace(/\/+$/, ''),
    upgradeUrl: env.EDITOR_UPGRADE_URL || 'https://3speak.tv/wallet/{user}#pro',
    renderedDir: env.RENDERED_DIR || '/app/rendered',
  }
}

export const upgradeUrlFor = (user, cfg = proGateConfig()) => cfg.upgradeUrl.replace('{user}', encodeURIComponent(String(user || '').toLowerCase()))

/** The 403 a free user gets for a landscape render. */
export function proRequiredBody(user, cfg = proGateConfig()) {
  return {
    error: 'Pro required',
    code: 'pro_required',
    feature: FEATURE,
    message: 'The landscape video editor is part of 3Speak Pro. Shorts and the audio editor stay free.',
    upgrade_url: upgradeUrlFor(user, cfg),
  }
}

/**
 * What a render makes: 'audio' (the audio editor's MP3), 'short' (9:16) or 'landscape' (16:9,
 * 4:3, 1:1 or anything else). Missing sizes count as the render's own default, 854x480.
 */
export function renderShape(timeline) {
  if (!timeline || timeline.output === 'audio') return 'audio'
  const w = Number(timeline.outputWidth) || 854
  const h = Number(timeline.outputHeight) || 480
  return Math.abs(Math.log((w / h) / (9 / 16))) < 0.02 ? 'short' : 'landscape'
}

// The Ad Wizard: its scene video (routes/sceneRender.js writes /rendered/scene-<uuid>.mp4)
// plus music and sound effects. Only that: every picture is a scene render on this backend's
// disk, everything else is sound.
const SCENE_PATH = /^\/rendered\/(scene-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4)$/
const pathOf = (u) => {
  try { return new URL(String(u), 'http://local').pathname } catch { return '' }
}

/**
 * True when the timeline is an Ad Wizard mix. The scene clips are pointed at the local file
 * (`/rendered/scene-...`), so a look-alike URL on another host can never stand in for one.
 */
export function claimAdSceneRender(timeline, cfg = proGateConfig()) {
  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : []
  const scenes = []
  for (const track of tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : []
    if (track?.type === 'video') {
      for (const c of clips) {
        const m = c && (c.type || 'video') === 'video' && pathOf(c.url).match(SCENE_PATH)
        if (!m || !fs.existsSync(path.join(cfg.renderedDir, m[1]))) return false
        scenes.push([c, `/rendered/${m[1]}`])
      }
    } else if (!clips.every(c => c?.type === 'audio')) {
      return false
    }
  }
  if (!scenes.length) return false
  for (const [c, local] of scenes) c.url = local
  return true
}

// ── Pro lookup ──────────────────────────────────────────────────────────────────
const cache = new Map() // user -> { value: true | false | null, until }
let fetchImpl = (...a) => fetch(...a)

function remember(user, value, ttl) {
  cache.set(user, { value, until: Date.now() + ttl })
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
}

/** true / false from the checker, or null when it could not be asked (fail open). */
export async function lookupPro(user, cfg = proGateConfig()) {
  const key = String(user || '').toLowerCase()
  if (!key) return false
  const hit = cache.get(key)
  if (hit && hit.until > Date.now()) return hit.value
  try {
    const res = await fetchImpl(`${cfg.checkerUrl}/premium/${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`checker answered ${res.status}`)
    const row = await res.json()
    if (!row || typeof row.premium !== 'boolean') throw new Error('checker answer has no premium flag')
    const exp = row.premium_expires_at ? new Date(row.premium_expires_at).getTime() : null
    const pro = row.premium === true && (!exp || !Number.isFinite(exp) || exp > Date.now())
    remember(key, pro, pro ? PRO_TTL_MS : FREE_TTL_MS)
    return pro
  } catch (err) {
    console.warn(`[pro] Pro lookup for ${key} failed, landscape allowed (fail open): ${err.message}`)
    remember(key, null, FAIL_TTL_MS)
    return null
  }
}

/**
 * May this signed-in user (req.signedIn: { user, pro } from auth.js) make landscape videos?
 * -> { allowed, reason: 'disabled' | 'no-sign-in-required' | 'token' | 'pro' | 'lookup_failed' | 'free' }
 */
export async function landscapeAccess(signedIn, cfg = proGateConfig()) {
  if (!cfg.enabled) return { allowed: true, reason: 'disabled' }
  // REQUIRE_SIGN_IN=false (local development): nobody is known, nothing is checked
  if (!signedIn?.user) return { allowed: true, reason: 'no-sign-in-required' }
  if (signedIn.pro === true) return { allowed: true, reason: 'token' }
  const pro = await lookupPro(signedIn.user, cfg)
  if (pro === null) return { allowed: true, reason: 'lookup_failed' }
  return pro ? { allowed: true, reason: 'pro' } : { allowed: false, reason: 'free' }
}

/**
 * The render route's check. Resolves null when the render may go ahead, else the 403 body.
 */
export async function landscapeRenderRefusal(req, timeline, cfg = proGateConfig()) {
  if (!cfg.enabled || renderShape(timeline) !== 'landscape') return null
  if (claimAdSceneRender(timeline, cfg)) return null
  const access = await landscapeAccess(req.signedIn, cfg)
  if (access.allowed) return null
  console.log(`[pro] landscape render refused for ${req.signedIn.user} (${timeline.outputWidth}x${timeline.outputHeight}): not Pro`)
  return proRequiredBody(req.signedIn.user, cfg)
}

// tests only
export const _test = {
  setFetch(fn) { fetchImpl = fn },
  resetFetch() { fetchImpl = (...a) => fetch(...a) },
  clearCache() { cache.clear() },
}
