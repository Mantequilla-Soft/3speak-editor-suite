import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranscriptJob } from './useTranscriptJob'
import { voiceTracksOf } from '../utils/captionSources'
import { addChunk, cleanTranscript, neededRanges, neededSeconds, placeWords, paragraphsOf, wordCount } from '../utils/transcript'

/**
 * The show's transcript (utils/transcript.js) for the transcript view, Remove
 * fillers and chapter ideas: kept with the draft, pinned to the recordings.
 * transcribe(language) listens to every part of the recordings on the
 * timeline that it does not have yet (all of it the first time; after a trim
 * is pulled out, only the new part), the words coming in chunk by chunk.
 * `buildAndUploadPayload` (useIframeApi) uploads what is not on the backend
 * yet and gives each clip's backend URL.
 */
export function useTranscript({ tracks, buildAndUploadPayload, enabled = true }) {
  const stt = useTranscriptJob({ enabled })
  const [transcript, setTranscriptState] = useState(null)
  const [preparing, setPreparing] = useState(null) // the upload step's phase text
  const [error, setError] = useState(null) // the upload step failed
  const ref = useRef(null)
  const setTranscript = useCallback((t) => { ref.current = t; setTranscriptState(t) }, [])
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks

  const words = useMemo(() => placeWords(tracks, transcript), [tracks, transcript])
  const paragraphs = useMemo(() => paragraphsOf(words), [words])
  const needed = useMemo(() => neededRanges(tracks, transcript), [tracks, transcript])
  const missingSeconds = neededSeconds(needed)

  const transcribe = useCallback(async (language = 'auto') => {
    const now = tracksRef.current
    const need = neededRanges(now, ref.current)
    if (!need.length) return true
    setError(null)
    setPreparing('Preparing the recordings...')
    let urls
    try {
      const payload = await buildAndUploadPayload((phase) => setPreparing(phase), { voiceTracks: voiceTracksOf(now) })
      urls = new Map()
      for (const t of payload?.timeline?.tracks || []) for (const c of t.clips || []) if (c.url) urls.set(c.id, c.url)
    } catch (err) {
      setPreparing(null)
      setError(err?.code === 'sign-in' ? 'Sign in on 3Speak to make a transcript.' : `The recordings could not be uploaded: ${err.message}`)
      return false
    }
    setPreparing(null)
    const libraryUrl = new Map()
    for (const t of voiceTracksOf(now)) for (const c of t.clips) if (urls.has(c.id) && !libraryUrl.has(c.libraryId)) libraryUrl.set(c.libraryId, urls.get(c.id))
    const sources = need.map(e => ({ id: e.libraryId, url: urls.get(e.clipId) || libraryUrl.get(e.libraryId), ranges: e.ranges })).filter(s => s.url && !/^blob:/.test(s.url))
    if (!sources.length) { setError('The recordings are not on the server yet. Try again once they have uploaded.'); return false }
    return stt.start({
      sources,
      language,
      verbatim: true, // "um" and "uh" written down: they can be found and cut
      onChunk: (chunk, lang) => setTranscript(addChunk(ref.current, chunk, lang))
    })
  }, [buildAndUploadPayload, stt.start, stt.cancel, setTranscript]) // eslint-disable-line react-hooks/exhaustive-deps

  /** A draft opened: its transcript (or none). */
  const load = useCallback((raw) => setTranscript(cleanTranscript(raw)), [setTranscript])
  const clear = useCallback(() => { stt.cancel(); setError(null); setTranscript(null) }, [stt.cancel, setTranscript]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    transcript,
    words,
    paragraphs,
    missingSeconds,
    count: wordCount(transcript),
    language: transcript?.language || null,
    status: stt.status,
    job: preparing ? { status: 'running', progress: 0, phase: preparing } : error ? { status: 'failed', progress: 0, error } : stt.job,
    transcribe,
    cancel: stt.cancel,
    load,
    clear
  }
}
