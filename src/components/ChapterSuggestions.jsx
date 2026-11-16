import { useState } from 'react'
import { Wand2, Plus, X, Play, Pause, Loader2, Check } from './icons'
import { suggestChapters } from '../utils/chapterSuggest'
import { chapterTime, cleanTitle, MAX_CHAPTER_TITLE } from '../utils/chapters'
import { loadLoudness, planCuts, suggestThreshold } from '../utils/silenceDetect'
import { combineLoudness } from '../utils/groupSilence'
import { voiceTracksOf } from '../utils/captionSources'
import { api } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'
import { useT } from '../i18n'
import './WordTools.css'

// Reasons: t(`chapters.suggest.reason.${r}`) (start, topic, pause, scene)
const pos = (c) => c.timelinePosition || 0

/** Scene changes of the video clips on the timeline, in timeline seconds: [{ t, score }] (the backend's scores, POST /api/clip/scenes). */
export async function timelineScenes(tracks, signal) {
  const clips = (tracks || []).filter(t => t.type === 'video' && t.visible !== false).flatMap(t => t.clips.filter(c => c.type === 'video' && /\/api\/upload\/files\//.test(c.serverUrl || '')))
  const byUrl = new Map()
  for (const c of clips) byUrl.set(c.serverUrl, [...(byUrl.get(c.serverUrl) || []), c])
  const out = []
  for (const [url, list] of byUrl) {
    const res = await authFetch(api('/api/clip/scenes'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal }).catch(() => null)
    const scores = res?.ok ? (await res.json()).scores || [] : []
    for (const c of list) for (const [t, score] of scores) if (t >= c.startTime && t < c.endTime) out.push({ t: pos(c) + (t - c.startTime), score })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Pauses of the whole show from the loudness of every voice clip (when there is no transcript): [{ start, end }]. */
export async function loudnessPauses(tracks, sourceOf, end, signal) {
  const clips = voiceTracksOf(tracks).flatMap(t => t.clips)
  const cache = new Map()
  const entries = []
  for (const clip of clips) {
    const key = clip.libraryId || clip.url
    if (!cache.has(key)) {
      const source = sourceOf(clip)
      cache.set(key, source || clip.serverUrl ? loadLoudness(source || clip.serverUrl, { signal, analysisUrl: clip.serverUrl || null }).catch(() => null) : Promise.resolve(null))
    }
    entries.push({ clip, loudness: await cache.get(key) })
  }
  if (!entries.some(e => e.loudness)) return []
  const curve = combineLoudness(entries)
  const to = Math.min(end, curve.duration)
  return planCuts(curve, { from: 0, to, thresholdDb: suggestThreshold(curve, 0, to), minSilence: 2.5, minPart: 0, keepStartMs: 0, keepEndMs: 0, mode: 'remove' }).silences
}

/**
 * Chapter ideas in the Chapters dialog: "Suggest" looks for topic changes in
 * the transcript, long pauses and scene changes (utils/chapterSuggest.js) and
 * lists them; each can be heard, renamed and added, or all at once.
 */
export default function ChapterSuggestions({ tracks, words, language, end, resolved, sourceOf, player, onAccept, onSeek }) {
  const { t } = useT()
  const [list, setList] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const find = async () => {
    setBusy(true)
    setError(null)
    try {
      const [scenes, pauses] = await Promise.all([
        timelineScenes(tracks).catch(() => []),
        words.length ? Promise.resolve(null) : loudnessPauses(tracks, sourceOf, end).catch(() => [])
      ])
      setList(suggestChapters({ words, end, existing: resolved, pauses, scenes, language: language || 'en' }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  const accept = (items) => {
    onAccept(items.map(s => ({ at: s.at, title: cleanTitle(s.title) || t('chapters.defaultTitle') })))
    const ids = new Set(items.map(s => s.id))
    setList(l => l.filter(s => !ids.has(s.id)))
  }
  const rename = (id, title) => setList(l => l.map(s => (s.id === id ? { ...s, title } : s)))

  return (
    <div className="chapter-suggest">
      <div className="chapter-suggest-head">
        <strong>{t('chapters.suggest.title')}</strong>
        <button className="silence-cut-apply" onClick={find} disabled={busy || !(end > 30)} title={t('chapters.suggest.findTitle')}>
          {busy ? <Loader2 size={14} className="encoding-notice-spin" /> : <Wand2 size={14} />} {list ? t('chapters.suggest.again') : t('chapters.suggest.suggest')}
        </button>
        {list?.length > 1 && <button className="silence-cut-apply" onClick={() => accept(list)}><Check size={14} /> {t('chapters.suggest.addAll', { n: list.length })}</button>}
      </div>
      {!words.length && !list && <p className="audio-template-hint">{t('chapters.suggest.withTranscript')}</p>}
      {error && <p className="captions-error" role="alert">{error}</p>}
      {list && list.length === 0 && <p className="audio-template-hint">{t('chapters.suggest.none')}</p>}
      {list && list.length > 0 && (
        <ol className="audio-chapters-list chapter-suggest-list">
          {list.map(s => {
            const key = `sug:${s.id}`
            const isPlaying = player?.playing?.key === key
            return (
              <li key={s.id}>
                <button className="audio-chapters-time" onClick={() => (player ? player.play(s.at, s.at + 6, key) : onSeek(s.at))} title={isPlaying ? t('chapters.suggest.stop') : t('chapters.suggest.listen')}>
                  {isPlaying ? <Pause size={11} /> : <Play size={11} />} {chapterTime(s.at)}
                </button>
                <input value={s.title} maxLength={MAX_CHAPTER_TITLE} aria-label={t('chapters.suggest.titleLabel', { time: chapterTime(s.at) })} onChange={(e) => rename(s.id, e.target.value)} />
                <span className="filler-chip" title={s.reasons.map(r => t(`chapters.suggest.reason.${r}`)).join(' + ')}>{t(`chapters.suggest.reason.${s.reason}`)}{s.reasons.length > 1 ? ' +' : ''}</span>
                <button className="audio-chapters-icon" onClick={() => accept([s])} title={t('chapters.suggest.add')} aria-label={t('chapters.suggest.addLabel', { time: chapterTime(s.at) })}><Plus size={14} /></button>
                <button className="audio-chapters-icon" onClick={() => setList(l => l.filter(x => x.id !== s.id))} title={t('chapters.suggest.drop')} aria-label={t('chapters.suggest.dropLabel', { time: chapterTime(s.at) })}><X size={14} /></button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
