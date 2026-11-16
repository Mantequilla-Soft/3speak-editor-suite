import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Wand2, Scissors, Search, Copy, Check, ChevronUp, ChevronDown, X, RotateCcw } from './icons'
import { wordAt, cutRangesForWords, transcriptTime, transcriptText } from '../utils/transcript'
import { cutLength } from '../utils/ripple'
import { rowOffsets, visibleRows, estimateHeight } from '../utils/virtualList'
import { normalWord } from '../utils/fillers'
import './WordTools.css'
import { useT, t, languageName as nameOf, formatNumber } from '../i18n'

// a spoken language's name in the interface language ('auto': let the server find it)
const languageName = (code) => (code === 'auto' ? t('transcript.language.auto') : nameOf(code))
// a length of recording in a sentence: the seconds key under 90 s, else the minutes key, with { n }
const lengthText = (secondsKey, minutesKey, sec) => (sec < 90
  ? t(secondsKey, { n: Math.max(1, Math.round(sec)) })
  : t(minutesKey, { n: Math.round(sec / 60) }))
// (useLayoutEffect in the page; tests draw it on the server, where it would only warn)
const useLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect
const FOLLOW_PAUSE_MS = 4000 // after the person scrolls, the view stops following the playback this long

// One paragraph: the speaker, its time, its words (memoised: only the ones whose
// active word or selection changed are drawn again while the show plays)
const Paragraph = memo(function Paragraph({ p, words, active, selFrom, selTo, matches, onWordDown, onWordEnter, onSeek }) {
  const { t } = useT()
  const list = []
  for (let i = p.from; i <= p.to; i++) {
    const w = words[i]
    const cls = `transcript-word${i === active ? ' active' : ''}${i >= selFrom && i <= selTo ? ' selected' : ''}${matches?.has(i) ? ' match' : ''}`
    list.push(<span key={i} className={cls} data-i={i} onPointerDown={(e) => onWordDown(e, i)} onPointerEnter={(e) => onWordEnter(e, i)}>{w.text}</span>, ' ')
  }
  return (
    <div className={`transcript-para speaker-${p.speakerIndex % 4}`}>
      <div className="transcript-para-head">
        <span className="transcript-speaker">{p.speaker}</span>
        <button className="transcript-time" onClick={() => onSeek(p.start)} title={t('transcript.goThere')}>{transcriptTime(p.start)}</button>
      </div>
      <p className="transcript-text">{list}</p>
    </div>
  )
})

/**
 * The transcript view (both editors; the audio editor's main tool for long
 * shows): the words of every voice, by speaker (each voice track is a
 * speaker), in time. Click a word to go there, drag over words (or Shift+click)
 * to select them, Delete cuts them out of the recording, closing the gap on
 * every track (one undo step; Undo brings them back). Search finds words;
 * found ones can be cut the same way. Only the paragraphs in sight are drawn,
 * so an hour-long show stays quick.
 * `tr`: useTranscript; onCut(ranges, what) does the cut.
 */
export default function TranscriptPanel({ tr, playheadPosition = 0, playing = false, onSeek, onCut, onOpenFillers }) {
  const { t } = useT()
  const { words, paragraphs, job, status } = tr
  const [language, setLanguage] = useState('auto')
  const [sel, setSel] = useState(null) // { anchor, focus } word indexes
  const [query, setQuery] = useState('')
  const [matchAt, setMatchAt] = useState(0)
  const [copied, setCopied] = useState(false)
  const running = job?.status === 'running'
  const available = status?.available === true
  const scrollRef = useRef(null)
  const dragRef = useRef(null)
  const followRef = useRef(0)

  // a cut (or undo) changes the words: the selection no longer means the same words
  useEffect(() => { setSel(null) }, [words])

  const selFrom = sel ? Math.min(sel.anchor, sel.focus) : -1
  const selTo = sel ? Math.max(sel.anchor, sel.focus) : -2
  const selected = selFrom >= 0 ? selTo - selFrom + 1 : 0
  const active = wordAt(words, playheadPosition)

  // Search: runs of words matching the query (one word, or several in a row)
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().split(/\s+/).map(normalWord).filter(Boolean)
    if (!q.length) return []
    const out = []
    for (let i = 0; i + q.length <= words.length; i++) {
      let ok = true
      for (let k = 0; k < q.length && ok; k++) {
        const w = normalWord(words[i + k].text)
        ok = k === q.length - 1 && q.length === 1 ? w.includes(q[k]) : w === q[k]
      }
      if (ok) out.push([i, i + q.length - 1])
    }
    return out
  }, [query, words])
  const matchSet = useMemo(() => (matches.length ? new Set(matches.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k))) : null), [matches])

  // ---- the window of paragraphs drawn ----
  const heights = useRef(new Map()) // paragraph start index -> measured px
  const [measureTick, setMeasureTick] = useState(0)
  const [view, setView] = useState({ top: 0, height: 600 })
  const offsets = useMemo(() => rowOffsets(paragraphs.length, (i) => {
    const p = paragraphs[i]
    const known = heights.current.get(`${p.from}:${p.to}`)
    if (known) return known
    let chars = 0
    for (let k = p.from; k <= p.to; k++) chars += words[k].text.length + 1
    return estimateHeight(chars)
  }), [paragraphs, words, measureTick]) // eslint-disable-line react-hooks/exhaustive-deps
  const { from, to } = visibleRows(offsets, view.top, view.height)

  const onScroll = useCallback((e) => {
    const el = e.currentTarget
    setView({ top: el.scrollTop, height: el.clientHeight })
  }, [])
  const markUserScroll = () => { followRef.current = Date.now() }
  useLayout(() => {
    const el = scrollRef.current
    if (!el) return undefined
    setView({ top: el.scrollTop, height: el.clientHeight })
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [paragraphs.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  // drawn paragraphs report their real height (changes re-lay the list once a frame at most)
  const rowsRef = useRef(null)
  useLayout(() => {
    const box = rowsRef.current
    if (!box) return
    let changed = false
    for (const el of box.children) {
      const key = el.dataset.key
      const h = el.offsetHeight
      if (key && h && heights.current.get(key) !== h) { heights.current.set(key, h); changed = true }
    }
    if (changed) setMeasureTick(t => t + 1)
  })

  const paraOfWord = useCallback((i) => {
    let lo = 0
    let hi = paragraphs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (paragraphs[mid].from <= i) lo = mid
      else hi = mid - 1
    }
    return lo
  }, [paragraphs])
  const scrollToWord = useCallback((i, smooth = true) => {
    const el = scrollRef.current
    if (!el || i < 0 || !paragraphs.length) return
    const p = paraOfWord(i)
    const top = offsets[p]
    const bottom = offsets[p + 1]
    if (top < el.scrollTop + 40 || bottom > el.scrollTop + el.clientHeight - 40) el.scrollTo({ top: Math.max(0, top - el.clientHeight / 3), behavior: smooth ? 'smooth' : 'auto' })
  }, [paraOfWord, offsets, paragraphs.length])

  // follow the playback (unless the person just scrolled or is selecting)
  useEffect(() => {
    if (!playing || active < 0 || sel || Date.now() - followRef.current < FOLLOW_PAUSE_MS) return
    scrollToWord(active, false)
  }, [playing, active]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- selecting ----
  const onWordDown = useCallback((e, i) => {
    if (e.button !== 0) return
    e.preventDefault()
    if (e.shiftKey) {
      setSel(s => ({ anchor: s ? s.anchor : i, focus: i }))
    } else {
      setSel({ anchor: i, focus: i })
      onSeek(words[i].start)
    }
    dragRef.current = true
    scrollRef.current?.focus({ preventScroll: true })
    const up = () => { dragRef.current = false; window.removeEventListener('pointerup', up) }
    window.addEventListener('pointerup', up)
  }, [words, onSeek])
  const onWordEnter = useCallback((e, i) => {
    if (dragRef.current) setSel(s => (s ? { ...s, focus: i } : { anchor: i, focus: i }))
  }, [])

  const cutSelection = () => {
    if (!selected) return
    const idx = Array.from({ length: selected }, (_, k) => selFrom + k)
    onCut(cutRangesForWords(words, idx), { kind: 'words', count: selected })
    setSel(null)
  }
  const cutMatches = () => {
    if (!matches.length) return
    onCut(cutRangesForWords(words, matches.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k))), { kind: 'found', count: matches.length })
  }
  const onKeyDown = (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault()
      e.stopPropagation()
      cutSelection()
    } else if (e.key === 'Escape' && sel) {
      e.stopPropagation()
      setSel(null)
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && sel) {
      // Shift+arrows grow the selection a word at a time
      e.preventDefault()
      e.stopPropagation()
      const d = e.key === 'ArrowRight' ? 1 : -1
      setSel(s => {
        const focus = Math.min(words.length - 1, Math.max(0, s.focus + d))
        return e.shiftKey ? { ...s, focus } : { anchor: focus, focus }
      })
    }
  }

  const gotoMatch = (k) => {
    if (!matches.length) return
    const n = ((k % matches.length) + matches.length) % matches.length
    setMatchAt(n)
    const [a, b] = matches[n]
    setSel({ anchor: a, focus: b })
    onSeek(words[a].start)
    scrollToWord(a)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(transcriptText(words, paragraphs))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  const languagePicker = (
    <select className="font-select transcript-language" value={language} onChange={e => setLanguage(e.target.value)} disabled={running} aria-label={t('transcript.language.label')}>
      {(status?.languages || ['auto']).map(l => <option key={l} value={l}>{languageName(l)}</option>)}
    </select>
  )
  const progress = running && (
    <div className="captions-progress" role="status" aria-live="polite">
      <div className="captions-progress-bar"><div style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div>
      <span><Loader2 size={13} className="encoding-notice-spin" /> {job.phase || t('transcript.listening')}</span>
      <button className="silence-cut-cancel" onClick={tr.cancel}>{t('transcript.stop')}</button>
    </div>
  )
  const failed = job?.status === 'failed' && <p className="captions-error" role="alert">{job.error}</p>

  if (!words.length && !running) {
    return (
      <div className="transcript-panel">
        <div className="prop-group">
          <div className="prop-group-label">{t('transcript.intro.title')}</div>
          <p className="captions-text">{t('transcript.intro.text')}</p>
          {status === null ? (
            <p className="captions-text"><Loader2 size={13} className="encoding-notice-spin" /> {t('transcript.intro.checking')}</p>
          ) : !available ? (
            <p className="captions-error" role="status">{t('transcript.intro.unavailable')}</p>
          ) : tr.missingSeconds <= 0 && tr.count === 0 ? (
            <p className="captions-text">{t('transcript.intro.noSpeech')}</p>
          ) : (
            <>
              <label className="transcript-field"><span>{t('transcript.language.label')}</span>{languagePicker}</label>
              <button className="silence-cut-apply captions-go" onClick={() => tr.transcribe(language)}>
                <Wand2 size={16} /> {lengthText('transcript.intro.transcribeSeconds', 'transcript.intro.transcribeMinutes', tr.missingSeconds)}
              </button>
              {tr.missingSeconds > 1800 && <p className="captions-text">{t('transcript.intro.longShow')}</p>}
            </>
          )}
          {failed}
        </div>
      </div>
    )
  }

  const speakers = [...new Map(paragraphs.map(p => [p.speakerIndex, p.speaker])).entries()]

  return (
    <div className="transcript-panel">
      <div className="transcript-tools">
        <div className="transcript-search">
          <Search size={14} />
          <input
            type="search"
            className="text-input"
            placeholder={t('transcript.search.placeholder')}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setMatchAt(0) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? matchAt - 1 : (sel ? matchAt + 1 : matchAt)) } }}
            aria-label={t('transcript.search.label')}
          />
          {query.trim() && (
            <>
              <span className="transcript-count" aria-live="polite">{matches.length ? `${matchAt + 1}/${matches.length}` : '0'}</span>
              <button className="transcript-icon" onClick={() => gotoMatch(matchAt - 1)} disabled={!matches.length} title={t('transcript.search.previous')} aria-label={t('transcript.search.previousLabel')}><ChevronUp size={14} /></button>
              <button className="transcript-icon" onClick={() => gotoMatch(matchAt + 1)} disabled={!matches.length} title={t('transcript.search.next')} aria-label={t('transcript.search.nextLabel')}><ChevronDown size={14} /></button>
            </>
          )}
        </div>
        <div className="transcript-actions">
          {selected > 0 ? (
            <>
              <span className="transcript-count">{t('transcript.selection.count', { count: selected, seconds: formatNumber(cutLength(cutRangesForWords(words, Array.from({ length: selected }, (_, k) => selFrom + k))), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span>
              <button className="compact-render-btn transcript-cut" onClick={cutSelection} title={t('transcript.selection.cutTitle')}><Scissors size={14} /> {t('transcript.selection.cut')}</button>
              <button className="transcript-icon" onClick={() => setSel(null)} title={t('transcript.selection.clearTitle')} aria-label={t('transcript.selection.clearLabel')}><X size={14} /></button>
            </>
          ) : query.trim() && matches.length > 0 ? (
            <button className="silence-cut-apply" onClick={cutMatches} title={t('transcript.found.cutAllTitle')}><Scissors size={14} /> {t('transcript.found.cutAll', { count: matches.length })}</button>
          ) : (
            <>
              {onOpenFillers && <button className="silence-cut-apply" onClick={onOpenFillers} title={t('transcript.fillersTitle')}><Wand2 size={14} /> {t('transcript.fillers')}</button>}
              <button className="transcript-icon" onClick={copy} title={t('transcript.copy')} aria-label={t('transcript.copy')}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
            </>
          )}
        </div>
      </div>
      {speakers.length > 1 && (
        <div className="transcript-speakers" aria-label={t('transcript.speakers')}>
          {speakers.map(([i, name]) => <span key={i} className={`transcript-speaker speaker-${i % 4}`}>{name}</span>)}
        </div>
      )}
      {progress}
      {failed}
      {!running && tr.missingSeconds > 1 && available && (
        <div className="transcript-missing">
          <span>{lengthText('transcript.missing.seconds', 'transcript.missing.minutes', tr.missingSeconds)}</span>
          <button className="silence-cut-cancel" onClick={() => tr.transcribe(tr.language || language)}><RotateCcw size={12} /> {t('transcript.missing.transcribe')}</button>
        </div>
      )}

      <div
        className="transcript-scroll"
        ref={scrollRef}
        tabIndex={0}
        onScroll={onScroll}
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onKeyDown={onKeyDown}
        aria-label={t('transcript.scrollLabel')}
      >
        <div className="transcript-rows" style={{ height: offsets[paragraphs.length] }}>
          <div ref={rowsRef} className="transcript-window" style={{ transform: `translateY(${offsets[from] || 0}px)` }}>
            {paragraphs.slice(from, to + 1).map((p) => (
              <div key={`${p.from}:${p.to}`} data-key={`${p.from}:${p.to}`}>
                <Paragraph
                  p={p}
                  words={words}
                  active={active >= p.from && active <= p.to ? active : -1}
                  selFrom={selFrom <= p.to && selTo >= p.from ? selFrom : -1}
                  selTo={selFrom <= p.to && selTo >= p.from ? selTo : -2}
                  matches={matchSet}
                  onWordDown={onWordDown}
                  onWordEnter={onWordEnter}
                  onSeek={onSeek}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="transcript-hint">{t('transcript.hint', { count: words.length })}</p>
    </div>
  )
}
