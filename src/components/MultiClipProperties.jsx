import { useState } from 'react'
import { Loader2, Volume2, RotateCcw, Trash2 } from './icons'
import { MAX_CLIP_VOLUME } from '../utils/audioGain'
import { AUDIO_NOISE_LEVELS, recordingSource, canCleanClip, cleanVoiceChanges } from './ClipProperties'
import { useCleaningStatus, cleaningText } from '../utils/cleaningStatus'
import { commonValue, sourcesOf } from '../utils/multiSelect'
import { useT } from '../i18n'

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
  const { t } = useT()
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const running = useCleaningStatus()

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
      setError(t('clip.multi.failed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="clip-properties multi-clip-properties">
      <div className="property-group">
        <label>
          <Volume2 size={12} />
          {volume == null ? t('clip.multi.volumeMixed') : t('clip.multi.volume')}
          {(volume !== 100 || allMuted) && (
            <button className="prop-reset-btn" onClick={() => onUpdateClips({ volume: 100, audioEnabled: true })} title={t('clip.volume.reset')}>
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
            aria-label={t('clip.multi.volumeAll')}
          />
          <span>{volume == null ? '-' : `${volume}%`}</span>
        </div>
        <button className={`mute-btn ${allMuted ? 'muted' : ''}`} onClick={() => onUpdateClips({ audioEnabled: allMuted })}>
          {allMuted ? t('clip.multi.unmuteAll') : t('clip.multi.muteAll')}
        </button>
      </div>

      {audioMode && onUpdateClipsEach && (
        <div className="property-group">
          <label>{t('clip.multi.cleanVoice')}</label>
          {sources.length ? (
            <div className="noise-levels" role="radiogroup" aria-label={t('clip.multi.cleanGroup')}>
              {levels.map(({ id, label, title }) => (
                <button
                  key={String(id)}
                  title={title}
                  role="radio"
                  aria-checked={level === id}
                  className={level === id ? 'active' : ''}
                  disabled={!!busy || !!running}
                  onClick={() => chooseLevel(id)}
                >
                  {busy && busy === (id ?? 'off') ? <Loader2 size={12} className="encoding-notice-spin" aria-label={t('clip.noise.working')} /> : label}
                </button>
              ))}
            </div>
          ) : (
            <p className="noise-hint">{t('clip.multi.afterUpload')}</p>
          )}
          {(busy || running) && (
            <p className="noise-busy" role="status"><Loader2 size={14} className="encoding-notice-spin" /> {running ? cleaningText(running) : t('clip.noise.workingDots')}</p>
          )}
          {sources.length > 0 && (
            <p className="noise-hint">
              {extra > 0 ? t('clip.multi.appliesWithGroups', { selected: clips.length, count: extra }) : t('clip.multi.applies', { count: clips.length })}
              {waiting ? ` ${t('clip.multi.stillUploading')}` : ''}
            </p>
          )}
          {error && <p className="noise-hint error">{error}</p>}
        </div>
      )}

      {onRemove && (
        <div className="property-group">
          <button className="multi-action-btn multi-remove-btn" onClick={onRemove}>
            <Trash2 size={13} /> {t('clip.multi.remove', { count: count ?? clips.length })}
          </button>
        </div>
      )}
    </div>
  )
}
