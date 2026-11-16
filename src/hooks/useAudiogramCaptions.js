import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranscriptJob } from './useTranscriptJob'
import { addChunk, subtractRanges } from '../utils/transcript'

// The words of each exported episode heard so far, kept while the editor is
// open (closing and opening the audiogram studio again does not listen again)
const episodes = new Map()
const SOURCE = 'episode'

/** The words of the piece [start, end) of the episode, seconds from the piece's start. */
export function pieceWords(transcript, piece) {
  const w = transcript?.sources?.[SOURCE]?.w || []
  return w.filter(x => x[1] >= piece.start - 0.05 && x[1] < piece.end - 0.05)
    .map(([text, a, b]) => ({ text, start: Math.round((a - piece.start) * 1000) / 1000, end: Math.round((Math.min(b, piece.end) - piece.start) * 1000) / 1000 }))
}

/** The parts of the piece not listened to yet ([[from, to]] in the episode). */
export const missingOf = (transcript, piece) => subtractRanges([[piece.start, piece.end]], transcript?.sources?.[SOURCE]?.covered || [], 0.3)

/**
 * Captions for the audiogram studio: the words of the picked piece of the
 * exported episode (speech to text on the backend, the episode's own file, so
 * the times are the audiogram's). transcribe() listens to what is missing and
 * resolves the piece's words; setWordText(i, text) fixes a misheard one
 * (text null: the word goes).
 */
export function useAudiogramCaptions({ outputUrl, piece, enabled = true }) {
  const stt = useTranscriptJob({ enabled })
  const [transcript, setTranscript] = useState(() => episodes.get(outputUrl) || null)
  const ref = useRef(transcript)
  ref.current = transcript
  const keep = (t) => { ref.current = t; episodes.set(outputUrl, t); setTranscript(t) }

  const words = useMemo(() => pieceWords(transcript, piece), [transcript, piece.start, piece.end]) // eslint-disable-line react-hooks/exhaustive-deps
  const missing = useMemo(() => missingOf(transcript, piece), [transcript, piece.start, piece.end]) // eslint-disable-line react-hooks/exhaustive-deps

  const transcribe = useCallback(async () => {
    const need = missingOf(ref.current, piece)
    if (need.length && outputUrl) {
      const ok = await stt.start({
        sources: [{ id: SOURCE, url: outputUrl, ranges: need }],
        language: 'auto',
        verbatim: false, // captions read better without the "um"s
        onChunk: (chunk, language) => keep(addChunk(ref.current, chunk, language))
      })
      if (!ok) return null
    }
    return pieceWords(ref.current, piece)
  }, [outputUrl, piece.start, piece.end, stt.start]) // eslint-disable-line react-hooks/exhaustive-deps

  // A word fixed by hand (index into `words`): its text in the episode's words (null removes it)
  const setWordText = useCallback((i, text) => {
    const t = ref.current
    const target = words[i]
    if (!t || !target) return
    const at = target.start + piece.start
    const hit = (x) => Math.abs(x[1] - at) < 0.0015
    const w = text === null
      ? t.sources[SOURCE].w.filter(x => !hit(x))
      : t.sources[SOURCE].w.map(x => (hit(x) ? [String(text).slice(0, 40), x[1], x[2]] : x))
    keep({ ...t, sources: { ...t.sources, [SOURCE]: { ...t.sources[SOURCE], w } } })
  }, [words, piece.start]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    status: stt.status,
    job: stt.job,
    cancel: stt.cancel,
    words,
    language: transcript?.language || null,
    ready: missing.length === 0,
    pieceKey: `${piece.start}-${piece.end}`,
    transcribe,
    setWordText
  }
}
