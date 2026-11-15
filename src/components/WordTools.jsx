import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from './icons'
import TranscriptPanel from './TranscriptPanel'
import FillerReviewDialog from './FillerReviewDialog'
import ChapterSuggestions from './ChapterSuggestions'
import { useTranscript } from '../hooks/useTranscript'
import { useRangePlayback } from '../hooks/useRangePlayback'
import { rippleCutRanges, cutLength } from '../utils/ripple'
import { newChapter, MAX_CHAPTERS } from '../utils/chapters'
import { isHlsUrl } from '../utils/hlsHelper'

/**
 * The editor's word tools in one place, so App only places them: the
 * transcript (edit by text), Remove fillers, chapter ideas. Cuts go through
 * rippleCutRanges (utils/ripple.js) as one undo step; `refitRef.current(tracks)`
 * (the audio template refitted to the new length) runs in the same step.
 */
export function useWordTools({ tracks, buildAndUploadPayload, applyTracks, undo, fileStoreRef, previewControlRef, setChapters, refitRef, enabled = true }) {
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [fillersOpen, setFillersOpen] = useState(false)
  // the backend is asked whether it can transcribe when a tool opens (by then the editor has picked its backend)
  const tr = useTranscript({ tracks, buildAndUploadPayload, enabled: enabled && (transcriptOpen || fillersOpen) })
  const player = useRangePlayback(previewControlRef)
  const [cutNotice, setCutNotice] = useState(null) // { what, seconds }
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks

  useEffect(() => {
    if (!cutNotice) return undefined
    const id = setTimeout(() => setCutNotice(null), 8000)
    return () => clearTimeout(id)
  }, [cutNotice])

  /** Cut timeline stretches out of every track and close them up (one undo step). */
  const cutTimeline = useCallback((ranges, what = '') => {
    if (!ranges?.length) return
    player.stop()
    applyTracks(prev => {
      const { tracks: next, copies } = rippleCutRanges(prev, ranges)
      for (const [id, fromId] of copies) {
        const file = fileStoreRef.current.get(fromId)
        if (file) fileStoreRef.current.set(id, file)
      }
      return refitRef?.current ? refitRef.current(next) : next
    })
    setCutNotice({ what, seconds: cutLength(ranges) })
  }, [applyTracks, fileStoreRef, refitRef, player])

  const seek = useCallback((t) => {
    player.stop()
    previewControlRef.current?.seek?.(t)
  }, [player, previewControlRef])

  const sourceOf = useCallback((c) => fileStoreRef.current.get(c.id) || c.file || (isHlsUrl(c.url) ? null : c.url), [fileStoreRef])

  const addChapters = useCallback((list) => {
    setChapters(prev => [...prev, ...list.map(s => newChapter(tracksRef.current, s.at, s.title))].slice(0, MAX_CHAPTERS))
  }, [setChapters])

  const openTranscript = useCallback(() => setTranscriptOpen(o => !o), [])

  /** The transcript side panel (null when closed): in the clip settings' place, like Captions. */
  const transcriptPanel = ({ playheadPosition, playing, onSeek }) => (transcriptOpen ? (
    <div className="compact-properties-panel captions-side transcript-side">
      <div className="compact-properties-header">
        <span className="compact-properties-title">Transcript</span>
        <button className="compact-btn compact-properties-close" onClick={() => setTranscriptOpen(false)} title="Close the transcript"><X size={14} /></button>
      </div>
      <TranscriptPanel tr={tr} playheadPosition={playheadPosition} playing={playing} onSeek={onSeek || seek} onCut={cutTimeline} onOpenFillers={() => setFillersOpen(true)} />
    </div>
  ) : null)

  const fillerDialog = fillersOpen ? <FillerReviewDialog tr={tr} player={player} onApply={cutTimeline} onClose={() => setFillersOpen(false)} /> : null

  const chapterSuggestions = ({ end, resolved }) => (
    <ChapterSuggestions tracks={tracks} words={tr.words} language={tr.language} end={end} resolved={resolved} sourceOf={sourceOf} player={player} onAccept={addChapters} onSeek={seek} />
  )

  const cutNoticeBar = cutNotice ? (
    <div className="compact-render-progress audio-template-notice" role="status">
      <span className="compact-render-progress-text">Cut {cutNotice.what ? `${cutNotice.what}: ` : ''}{cutNotice.seconds.toFixed(1)} s shorter.</span>
      {undo && <button className="compact-btn" onClick={() => { undo(); setCutNotice(null) }}>Undo</button>}
      <button className="compact-btn" onClick={() => setCutNotice(null)} title="Dismiss"><X size={12} /></button>
    </div>
  ) : null

  return { tr, player, transcriptOpen, setTranscriptOpen, openTranscript, fillersOpen, setFillersOpen, cutTimeline, transcriptPanel, fillerDialog, chapterSuggestions, cutNoticeBar }
}
