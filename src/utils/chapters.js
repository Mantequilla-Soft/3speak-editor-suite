// Chapters of an episode: named moments ("Intro", "Listener questions"). They
// go into the MP3 (ID3 chapter frames, which podcast apps show) and to 3Speak,
// which lists them in the description.
//
// A chapter is pinned to the recording, not to the clock: { id, title, at,
// anchor: { libraryId, t } } where t is the moment in that recording's own
// file. Cut silences, a trim or a template intro move the recording around, and
// the chapter moves with it (resolveChapters). Without an anchor (placed over
// nothing, or on a template part) it stays at `at`.

export const MAX_CHAPTERS = 100
export const MAX_CHAPTER_TITLE = 80

const pos = (c) => c.timelinePosition || 0
const len = (c) => Math.max(0, c.endTime - c.startTime)
const EPS = 0.001

// The voice clips a chapter can be pinned to: recordings (not music, not template parts)
function voiceClips(tracks) {
  const out = []
  for (const t of tracks || []) {
    if (t.type !== 'audio' || t.music) continue
    for (const c of t.clips) if (!c.templateRole && c.libraryId && len(c) > 0) out.push(c)
  }
  return out.sort((a, b) => pos(a) - pos(b))
}

/** The recording moment under timeline time `at` (null over a gap or a template part). */
export function anchorAt(tracks, at) {
  const c = voiceClips(tracks).find(x => at >= pos(x) - EPS && at < pos(x) + len(x) - EPS)
  return c ? { libraryId: c.libraryId, t: Math.round((c.startTime + (at - pos(c))) * 1000) / 1000 } : null
}

/** Where an anchor is on the timeline now (null when its recording is gone). */
export function anchorPosition(tracks, anchor) {
  if (!anchor?.libraryId) return null
  const pieces = voiceClips(tracks).filter(c => c.libraryId === anchor.libraryId)
  if (!pieces.length) return null
  const inside = pieces.find(c => anchor.t >= c.startTime - EPS && anchor.t < c.endTime - EPS)
  if (inside) return pos(inside) + Math.max(0, anchor.t - inside.startTime)
  // The moment was cut out (a silence): the next piece of the recording after it
  const after = pieces.filter(c => c.startTime >= anchor.t).sort((a, b) => a.startTime - b.startTime)[0]
  if (after) return pos(after)
  // Past the end of what is left: where the recording ends now
  const last = pieces.reduce((a, b) => (b.endTime > a.endTime ? b : a))
  return pos(last) + len(last)
}

export function newChapter(tracks, at, title, id = `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`) {
  const t = Math.max(0, +at || 0)
  return { id, title: cleanTitle(title), at: Math.round(t * 1000) / 1000, anchor: anchorAt(tracks, t) }
}

/** Moved to `at` (pinned again to what is there now). */
export const moveChapter = (tracks, chapter, at) => ({ ...chapter, ...newChapter(tracks, at, chapter.title, chapter.id) })

export const cleanTitle = (title) => String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHAPTER_TITLE)

/**
 * The chapters where they are now: [{ id, title, at }] by time, clamped to the
 * timeline (`end`, when given). Two at the same moment: the later one is kept
 * just after (a chapter needs a length).
 */
export function resolveChapters(tracks, chapters, end = Infinity) {
  const out = (chapters || []).map(ch => {
    const p = anchorPosition(tracks, ch.anchor)
    const at = Math.min(Math.max(0, p ?? (+ch.at || 0)), Math.max(0, end))
    return { id: ch.id, title: cleanTitle(ch.title) || 'Chapter', at: Math.round(at * 1000) / 1000 }
  })
  return out.sort((a, b) => a.at - b.at)
}

/**
 * For the render and 3Speak: [{ start, end, title }] seconds, each running to
 * the next one (the last to the end of the episode). Ones that would be
 * shorter than a second are dropped.
 */
export function chapterSpans(resolved, end) {
  // A chapter less than a second after the one before is left out (the earlier stays)
  const kept = []
  for (const c of resolved || []) {
    if (c.at >= end - 1) break
    if (kept.length && c.at - kept[kept.length - 1].at < 1) continue
    kept.push(c)
    if (kept.length >= MAX_CHAPTERS) break
  }
  return kept.map((c, i) => ({
    start: c.at,
    end: Math.round((i + 1 < kept.length ? kept[i + 1].at : end) * 1000) / 1000,
    title: c.title
  }))
}

/** 75 -> "1:15", 3723 -> "1:02:03" (how chapter lists are written). */
export function chapterTime(sec) {
  const s = Math.max(0, Math.floor(sec + 1e-6))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** The list as text for a description: "0:00 Intro\n12:40 Questions". */
export const chaptersText = (spans) => (spans || []).map(c => `${chapterTime(c.start)} ${c.title}`).join('\n')
