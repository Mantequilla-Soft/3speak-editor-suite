// Auto-duck: the music tracks get quieter while someone talks and come back up
// in the pauses, so a music bed never fights the voice. "Someone talks" = a
// voice clip plays there (after Cut silences the clips are the talking).
//
// The editor works the spans out (here) and sends them with the render; the
// backend applies the same ramps (audioRender.js duckExpr), the preview plays
// them through duckGainAt, so both sound the same.

export const DUCK_DEPTHS = [-6, -12, -18] // dB under the voice
export const DUCK_DEFAULT_DB = -12
export const DUCK_ATTACK = 0.4 // seconds: the music starts going down before the first word
export const DUCK_RELEASE = 0.8 // seconds: and comes back up after the last one

const pos = (c) => c.timelinePosition || 0
const len = (c) => Math.max(0, c.endTime - c.startTime)

/** dB -> the gain the music keeps under the voice (0..1). */
export const duckGain = (db) => Math.min(1, Math.max(0, 10 ** ((Number.isFinite(+db) ? +db : DUCK_DEFAULT_DB) / 20)))

/**
 * Where the voices talk: [[start, end], ...] in timeline seconds, merged where
 * the gap between them is shorter than a whole ramp down and up (the music would
 * only bob for a breath). Muted tracks, clips with their sound off and the
 * template's intro / outro (those are music themselves) do not count.
 */
export function voiceSpans(tracks, { attack = DUCK_ATTACK, release = DUCK_RELEASE } = {}) {
  const raw = []
  for (const t of tracks || []) {
    if (t.type !== 'audio' || t.music || t.muted === true) continue
    for (const c of t.clips) {
      if (c.templateRole || c.audioEnabled === false || len(c) < 0.01) continue
      raw.push([pos(c), pos(c) + len(c)])
    }
  }
  raw.sort((a, b) => a[0] - b[0])
  const spans = []
  for (const [s, e] of raw) {
    const last = spans[spans.length - 1]
    if (last && s - last[1] < attack + release) last[1] = Math.max(last[1], e)
    else spans.push([s, e])
  }
  return spans
}

/**
 * The duck for a render or the preview: { gain, attack, release, spans, tracks }
 * (`tracks`: ids of the music tracks it applies to), or null when it is off or
 * there is nothing to duck.
 */
export function duckPlan(tracks, master) {
  if (!master?.duck) return null
  const music = (tracks || []).filter(t => t.type === 'audio' && t.music && t.muted !== true && t.clips.length)
  if (!music.length) return null
  const spans = voiceSpans(tracks)
  if (!spans.length) return null
  return {
    gain: Math.round(duckGain(master.duckDb) * 10000) / 10000,
    attack: DUCK_ATTACK,
    release: DUCK_RELEASE,
    spans: spans.map(([s, e]) => [Math.round(s * 1000) / 1000, Math.round(e * 1000) / 1000]),
    tracks: music.map(t => t.id)
  }
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
