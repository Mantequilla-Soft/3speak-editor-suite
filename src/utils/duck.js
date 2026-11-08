// Auto-duck: a clip gets quieter while its sidechain source plays and comes
// back up in the pauses, so a music bed never fights the voice. It is a clip
// setting (clip.duck): { db, source } with source 'voices' (any voice track)
// or one track's id, or { off: true }. A clip without one follows Duck in the
// top bar (master.duck), which ducks the music tracks under the voices.
//
// The editor works the spans out (here) and sends each ducked clip its own
// with the render; the backend applies the same ramps (audioRender.js
// duckExpr), the preview plays them through duckGainAt, so both sound the same.

export const DUCK_DEPTHS = [-6, -12, -18] // dB under the voice
export const DUCK_DEFAULT_DB = -12
export const DUCK_ATTACK = 0.4 // seconds: the music starts going down before the first word
export const DUCK_RELEASE = 0.8 // seconds: and comes back up after the last one

const pos = (c) => c.timelinePosition || 0
const len = (c) => Math.max(0, c.endTime - c.startTime)

/** dB -> the gain the music keeps under the voice (0..1). */
export const duckGain = (db) => Math.min(1, Math.max(0, 10 ** ((Number.isFinite(+db) ? +db : DUCK_DEFAULT_DB) / 20)))

// Merge spans where the gap between them is shorter than a whole ramp down
// and up (the ducked clip would only bob for a breath)
function mergeSpans(raw, attack, release) {
  raw.sort((a, b) => a[0] - b[0])
  const spans = []
  for (const [s, e] of raw) {
    const last = spans[spans.length - 1]
    if (last && s - last[1] < attack + release) last[1] = Math.max(last[1], e)
    else spans.push([s, e])
  }
  return spans
}

// A clip that plays and counts as sound
const sounding = (c) => c.audioEnabled !== false && len(c) >= 0.01

/**
 * Where the voices talk: [[start, end], ...] in timeline seconds, merged.
 * Muted tracks, clips with their sound off and the template's intro / outro
 * (those are music themselves) do not count. `exceptTrackId`: leave that
 * track out (a voice is never ducked by itself).
 */
export function voiceSpans(tracks, { attack = DUCK_ATTACK, release = DUCK_RELEASE, exceptTrackId = null } = {}) {
  const raw = []
  for (const t of tracks || []) {
    if (t.type !== 'audio' || t.music || t.muted === true || t.id === exceptTrackId) continue
    for (const c of t.clips) {
      if (c.templateRole || !sounding(c)) continue
      raw.push([pos(c), pos(c) + len(c)])
    }
  }
  return mergeSpans(raw, attack, release)
}

/** Where a sidechain source plays: 'voices', or one track (never the ducked clip's own). */
export function sourceSpans(tracks, source, ownTrackId, opts = {}) {
  const { attack = DUCK_ATTACK, release = DUCK_RELEASE } = opts
  if (!source || source === DUCK_SOURCE_VOICES) return voiceSpans(tracks, { attack, release, exceptTrackId: ownTrackId })
  if (source === ownTrackId) return []
  const track = (tracks || []).find(t => t.id === source && t.type === 'audio' && t.muted !== true)
  if (!track) return []
  return mergeSpans(track.clips.filter(sounding).map(c => [pos(c), pos(c) + len(c)]), attack, release)
}

export const DUCK_SOURCE_VOICES = 'voices'

/**
 * What a clip's duck is: its own setting, or Duck in the top bar for a clip on
 * a music track. { db, source, inherited } or null (not ducked).
 */
export function clipDuckSetting(clip, track, master) {
  if (!clip || !track || track.type !== 'audio') return null
  const own = clip.duck
  if (own?.off) return null
  if (own && Number.isFinite(+own.db)) return { db: +own.db, source: own.source || DUCK_SOURCE_VOICES, inherited: false }
  if (track.music && master?.duck) return { db: Number.isFinite(+master.duckDb) ? +master.duckDb : DUCK_DEFAULT_DB, source: DUCK_SOURCE_VOICES, inherited: true }
  return null
}

const r3 = (n) => Math.round(n * 1000) / 1000

/**
 * Every ducked clip's plan, for the preview and the render:
 * { [clipId]: { gain, attack, release, spans } } with spans in timeline
 * seconds (only those that reach the clip). Clips with nothing to duck under
 * are left out; null when no clip is ducked.
 */
export function duckPlans(tracks, master) {
  const plans = {}
  const cache = new Map()
  for (const t of tracks || []) {
    if (t.type !== 'audio' || t.muted === true) continue
    for (const c of t.clips) {
      const setting = clipDuckSetting(c, t, master)
      if (!setting || !sounding(c)) continue
      const key = `${setting.source}|${t.id}`
      if (!cache.has(key)) cache.set(key, sourceSpans(tracks, setting.source, t.id))
      const from = pos(c) - DUCK_RELEASE
      const to = pos(c) + len(c) + DUCK_ATTACK
      const spans = cache.get(key).filter(([s, e]) => s < to && e > from)
      if (!spans.length) continue
      plans[c.id] = {
        gain: Math.round(duckGain(setting.db) * 10000) / 10000,
        attack: DUCK_ATTACK,
        release: DUCK_RELEASE,
        spans: spans.map(([s, e]) => [r3(s), r3(e)])
      }
    }
  }
  return Object.keys(plans).length ? plans : null
}

/** A clip's plan for the render: its spans in the clip's own seconds (0 = where it starts). */
export function localDuckPlan(plan, clip) {
  if (!plan) return null
  const p0 = pos(clip)
  return { gain: plan.gain, attack: plan.attack, release: plan.release, spans: plan.spans.map(([s, e]) => [r3(s - p0), r3(e - p0)]) }
}

/**
 * How far down the music is at timeline time t (1 = full, plan.gain = ducked):
 * a linear ramp down over `attack` before a span, flat under it, a ramp up over
 * `release` after it. Spans never ramp into each other (voiceSpans merges those).
 */
export function duckGainAt(plan, t) {
  if (!plan?.spans?.length) return 1
  const { spans, attack, release, gain } = plan
  // Last span starting (ramp included) at or before t
  let lo = 0
  let hi = spans.length - 1
  let k = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid][0] - attack <= t) { k = mid; lo = mid + 1 } else hi = mid - 1
  }
  if (k < 0) return 1
  const [s, e] = spans[k]
  const up = Math.min(1, Math.max(0, (t - (s - attack)) / attack))
  const down = Math.min(1, Math.max(0, (e + release - t) / release))
  const shape = Math.min(up, down)
  return 1 - (1 - gain) * shape
}
