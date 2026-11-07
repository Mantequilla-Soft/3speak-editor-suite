import { useState } from 'react'
import { Volume2, RotateCcw, Trash2, Link, Unlink } from 'lucide-react'
import { MAX_CLIP_VOLUME } from '../utils/audioGain'
import { NOISE_LEVELS, STUDIO_LEVEL, recordingSource, canCleanSource, requestCleanVoice, cleanedFields, uncleanedFields } from './ClipProperties'
import { commonValue, sourcesOf } from '../utils/multiSelect'

/**
 * Settings for several selected clips at once (box select on the timeline):
 * volume and mute for all of them and, in the audio editor, the voice
 * clean-up for every recording they come from.
 *
 * clips: the clips whose sound to change (a video's linked audio clip in its
 * place); onUpdateClips(updates) sets the same fields on all of them;
 * onUpdateRecording(source, updates) changes every piece of one recording.
 */
export default function MultiClipProperties({ clips, audioMode = false, onUpdateClips, onUpdateRecording, onRemove, count, grouped = false, onGroup, onUngroup }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const volumes = clips.map(c => c.volume ?? 100)
  const volume = commonValue(volumes)
  const shownVolume = volume ?? Math.round(volumes.reduce((a, b) => a + b, 0) / Math.max(1, volumes.length))
  const allMuted = clips.length > 0 && clips.every(c => c.audioEnabled === false)
  const maxVolume = audioMode ? MAX_CLIP_VOLUME : 100

  // Voice clean-up: per recording (after Cut silences a recording is many clips)
  const sources = sourcesOf(clips, recordingSource).filter(canCleanSource)
  const level = commonValue(clips.map(c => c.denoise || null))
  const levels = [...NOISE_LEVELS, STUDIO_LEVEL]
  const waiting = clips.some(c => !canCleanSource(recordingSource(c)))

  const chooseLevel = async (id) => {
    setError(null)
    setBusy(id ?? 'off')
    try {
      for (const source of sources) {
        const piece = clips.find(c => recordingSource(c) === source)
        if (!id) {
          if (piece.denoise) onUpdateRecording(source, uncleanedFields(piece, source))
          continue
        }
        const cleaned = await requestCleanVoice(source, id)
        onUpdateRecording(source, cleanedFields(piece, source, id, cleaned))
      }
    } catch {
      setError('Cleaning up the voice failed. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="clip-properties multi-clip-properties">
      <div className="property-group">
        <label>
          <Volume2 size={12} />
          Volume{volume == null ? ' (mixed)' : ''}
          {(volume !== 100 || allMuted) && (
            <button className="prop-reset-btn" onClick={() => onUpdateClips({ volume: 100, audioEnabled: true })} title="Reset volume">
              <RotateCcw size={10} />
            </button>
          )}
        </label>
        <div className="property-slider">
          <input
            type="range"
            min="0"
            max={maxVolume}
            value={Math.min(maxVolume, shownVolume)}
            onChange={(e) => onUpdateClips({ volume: parseInt(e.target.value) })}
            aria-label="Volume of all selected clips"
          />
          <span>{volume == null ? '-' : `${volume}%`}</span>
        </div>
        <button className={`mute-btn ${allMuted ? 'muted' : ''}`} onClick={() => onUpdateClips({ audioEnabled: allMuted })}>
          {allMuted ? 'Unmute all' : 'Mute all'}
        </button>
      </div>

      {audioMode && onUpdateRecording && (
        <div className="property-group">
          <label>Clean up the voice</label>
          {sources.length ? (
            <div className="noise-levels" role="radiogroup" aria-label="Voice clean-up for all selected clips">
              {levels.map(({ id, label, title }) => (
                <button
                  key={label}
                  title={title}
                  role="radio"
                  aria-checked={level === id}
                  className={level === id ? 'active' : ''}
                  disabled={!!busy}
                  onClick={() => chooseLevel(id)}
                >
                  {busy && busy === (id ?? 'off') ? '…' : label}
                </button>
              ))}
            </div>
          ) : (
            <p className="noise-hint">Available once these clips have finished uploading.</p>
          )}
          {sources.length > 0 && (
            <p className="noise-hint">
              Applies to {sources.length === 1 ? 'the whole recording' : `all ${sources.length} recordings`} these clips come from.
              {waiting ? ' Clips still uploading are left as they are.' : ''}
            </p>
          )}
          {error && <p className="noise-hint error">{error}</p>}
        </div>
      )}

      {(onGroup || onRemove) && (
        <div className="property-group">
          {onGroup && (grouped ? (
            <button className="multi-action-btn" onClick={onUngroup}>
              <Unlink size={13} /> Ungroup
            </button>
          ) : (
            <button className="multi-action-btn" onClick={onGroup}>
              <Link size={13} /> Group {count ?? clips.length} clips
            </button>
          ))}
          {onGroup && <p className="noise-hint">{grouped ? 'These clips are one group: they move and trim together.' : 'Grouped clips move and trim together.'}</p>}
          {onRemove && (
            <button className="multi-action-btn multi-remove-btn" onClick={onRemove}>
              <Trash2 size={13} /> Remove {count ?? clips.length} clips
            </button>
          )}
        </div>
      )}
    </div>
  )
}
