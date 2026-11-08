import { useState } from 'react'
import { Volume2, RotateCcw, Trash2 } from 'lucide-react'
import { MAX_CLIP_VOLUME } from '../utils/audioGain'
import { AUDIO_NOISE_LEVELS, recordingSource, canCleanClip, cleanVoiceChanges } from './ClipProperties'
import { commonValue, sourcesOf } from '../utils/multiSelect'

/**
 * Settings for several selected clips at once (box select on the timeline):
 * volume and mute for all of them and, in the audio editor, the voice
 * clean-up for them (and the groups they are in), clip by clip.
 *
 * clips: the clips whose sound to change (a video's linked audio clip in its
 * place); onUpdateClips(updates) sets the same fields on all of them;
 * voiceTargets: the clips the clean-up applies to (the selection plus their
 * groups); onUpdateClipsEach([{ id, updates }]) gives each its own fields.
 */
export default function MultiClipProperties({ clips, audioMode = false, onUpdateClips, voiceTargets = null, onUpdateClipsEach = null, onRemove, count }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const volumes = clips.map(c => c.volume ?? 100)
  const volume = commonValue(volumes)
  const shownVolume = volume ?? Math.round(volumes.reduce((a, b) => a + b, 0) / Math.max(1, volumes.length))
  const allMuted = clips.length > 0 && clips.every(c => c.audioEnabled === false)
  const maxVolume = audioMode ? MAX_CLIP_VOLUME : 100

  // Voice clean-up: these clips only (each recording is cleaned once)
  const targets = voiceTargets || clips
  const sources = sourcesOf(targets.filter(canCleanClip), (c) => recordingSource(c) || c.url)
  const level = commonValue(targets.map(c => c.denoise || null))
  const levels = AUDIO_NOISE_LEVELS
  const waiting = targets.some(c => !canCleanClip(c))
  const extra = targets.length - clips.length

  const chooseLevel = async (id) => {
    setError(null)
    setBusy(id ?? 'off')
    try {
      onUpdateClipsEach(await cleanVoiceChanges(targets, id))
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

      {audioMode && onUpdateClipsEach && (
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
              Applies to the {clips.length} selected clips{extra > 0 ? ` and the ${extra} other clip${extra === 1 ? '' : 's'} in their groups` : ''}.
              {waiting ? ' Clips still uploading are left as they are.' : ''}
            </p>
          )}
          {error && <p className="noise-hint error">{error}</p>}
        </div>
      )}

      {onRemove && (
        <div className="property-group">
          <button className="multi-action-btn multi-remove-btn" onClick={onRemove}>
            <Trash2 size={13} /> Remove {count ?? clips.length} clips
          </button>
        </div>
      )}
    </div>
  )
}
