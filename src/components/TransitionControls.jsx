import { useEffect } from 'react'
import { TRANSITION_TYPES, TRANSITION_MIN, TRANSITION_MAX, TRANSITION_DEFAULT, VIDEO_FADE_MAX, normalizeTransition, nextClipOf, canTransition, videoFades } from '../utils/transitions'
import { RotateCcw, X } from './icons'
import { useT } from '../i18n'
import './TransitionControls.css'

/**
 * The type and length of a transition: None or one of the types, then its
 * length. value: the normalised transition or null; onChange(type, duration).
 */
export function TransitionPicker({ value, onChange }) {
  const { t } = useT()
  const duration = value?.duration ?? TRANSITION_DEFAULT
  return (
    <div className="transition-picker">
      <div className="transition-chips" role="radiogroup" aria-label={t('look.transition.title')}>
        <button type="button" role="radio" aria-checked={!value} className={`transition-chip${!value ? ' active' : ''}`} onClick={() => onChange(null)}>
          {t('look.transition.none')}
        </button>
        {TRANSITION_TYPES.map(tt => (
          <button
            key={tt.id}
            type="button"
            role="radio"
            aria-checked={value?.type === tt.id}
            className={`transition-chip${value?.type === tt.id ? ' active' : ''}`}
            onClick={() => onChange(tt.id, duration)}
          >
            {t(`look.transition.types.${tt.id}`)}
          </button>
        ))}
      </div>
      {value && (
        <div className="property-slider">
          <input
            type="range"
            min={TRANSITION_MIN}
            max={TRANSITION_MAX}
            step="0.1"
            value={duration}
            onChange={(e) => onChange(value.type, parseFloat(e.target.value))}
            aria-label={t('look.transition.length')}
          />
          <span>{duration.toFixed(1)}s</span>
        </div>
      )}
    </div>
  )
}

// The clip's track and the clip right after it, when one starts where it ends
export function transitionTarget(tracks, clip) {
  const track = (tracks || []).find(t => t.type === 'video' && t.clips.some(c => c.id === clip.id))
  const next = track ? nextClipOf(track, clip.id) : null
  return canTransition(next) ? next : null
}

// The update a picked transition makes on the outgoing clip
export const transitionUpdate = (next, type, duration) => ({
  transition: type && next ? normalizeTransition({ type, duration, to: next.id }) : null
})

/**
 * Fades of a video, image or colour clip's picture (its linked sound fades
 * with it), and the transition into the clip right after it.
 */
export default function TransitionControls({ clip, tracks, onUpdateClip, linkedAudio = null, onUpdateLinkedAudio = null }) {
  const { t } = useT()
  const next = transitionTarget(tracks, clip)
  const current = normalizeTransition(clip.transition)
  const active = current && next && current.to === next.id ? current : null
  const fades = videoFades(clip)
  const length = Math.max(0, clip.endTime - clip.startTime)
  const max = Math.max(0.1, Math.min(VIDEO_FADE_MAX, length))
  const setFade = (key, v) => {
    const value = Math.round(v * 10) / 10
    onUpdateClip({ [key]: value })
    if (linkedAudio && onUpdateLinkedAudio) onUpdateLinkedAudio({ [key]: value })
  }
  const fadeRow = (key, label, ariaLabel) => (
    <div className="property-slider fade-slider">
      <span className="fade-label">{label}</span>
      <input
        type="range"
        min="0"
        max={max}
        step="0.1"
        value={Math.min(max, fades[key])}
        onChange={(e) => setFade(key, parseFloat(e.target.value))}
        aria-label={ariaLabel}
      />
      <span>{Math.min(max, fades[key]).toFixed(1)}s</span>
    </div>
  )
  return (
    <div className="prop-group">
      <div className="prop-group-label">{t('look.transition.title')}</div>
      <div className="property-group">
        <label>
          {t('look.transition.fades')}
          {(fades.fadeIn > 0 || fades.fadeOut > 0) && (
            <button className="prop-reset-btn" onClick={() => { setFade('fadeIn', 0); setFade('fadeOut', 0) }} title={t('look.transition.noFades')}>
              <RotateCcw size={10} />
            </button>
          )}
        </label>
        {fadeRow('fadeIn', t('look.transition.in'), t('look.transition.fadeInSeconds'))}
        {fadeRow('fadeOut', t('look.transition.out'), t('look.transition.fadeOutSeconds'))}
      </div>
      <div className="property-group">
        <label>{t('look.transition.intoNext')}</label>
        {next
          ? <TransitionPicker value={active} onChange={(type, duration) => onUpdateClip(transitionUpdate(next, type, duration))} />
          : <p className="transition-hint">{t('look.transition.needNext')}</p>}
      </div>
    </div>
  )
}

/** The picker as a dialog, for the button on a cut in the timeline. */
export function TransitionDialog({ from, to, onUpdateClip, onClose }) {
  const { t } = useT()
  const current = normalizeTransition(from.transition)
  const value = current && current.to === to.id ? current : null
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="remix-picker-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="remix-picker transition-dialog" role="dialog" aria-modal="true" aria-labelledby="transition-dialog-title">
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="transition-dialog-title">{t('look.transition.title')}</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        <p className="transition-hint">
          {from.name && to.name ? t('look.transition.fromTo', { from: from.name, to: to.name })
            : to.name ? t('look.transition.fromUnnamed', { to: to.name })
              : from.name ? t('look.transition.toUnnamed', { from: from.name })
                : t('look.transition.bothUnnamed')}
        </p>
        <TransitionPicker value={value} onChange={(type, duration) => onUpdateClip(from.id, transitionUpdate(to, type, duration))} />
      </div>
    </div>
  )
}
