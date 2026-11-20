import { useState } from 'react'
import { X, Crop, Crown } from './icons'
import { PROJECT_ASPECTS, ASPECT_INFO, aspectValue, aspectLabel } from '../utils/projectFormat'
import { limitText, maxSecondsFor, formatLength, getTimelineEnd } from '../utils/limits'
import { isProAspect } from '../utils/landscapeAccess'
import { useT } from '../i18n'
import './ProjectFormat.css'

/** A small picture of a shape: a frame of its aspect in a 40 x 40 box. */
export function AspectDiagram({ aspect, size = 40 }) {
  const r = aspectValue(aspect)
  const w = r >= 1 ? size - 6 : (size - 6) * r
  const h = r >= 1 ? (size - 6) / r : size - 6
  return (
    <svg className="aspect-diagram" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <rect x={(size - w) / 2} y={(size - h) / 2} width={w} height={h} rx="3" />
    </svg>
  )
}

/** The "Pro" mark next to a shape a free user can not make (the landscape editor is 3Speak Pro). */
export function ProBadge() {
  const { t } = useT()
  return <span className="pro-badge" title={t('pro.shapeTitle')}><Crown size={11} />{t('pro.badge')}</span>
}

/**
 * The project's shape, at the top of the video editor: a chip that says what it
 * is, opening the picker. Changing it keeps every clip; footage is fitted into
 * the new frame (Export as reframes it around faces instead). proLocked: a free user, so the
 * landscape, classic and square shapes carry the Pro mark (picking one shows the Pro notice).
 */
export default function ProjectFormat({ aspect, onChange, tracks, proLocked = false }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const shape = aspectLabel(ASPECT_INFO[aspect] ? aspect : '9:16')
  const length = getTimelineEnd(tracks)
  return (
    <>
      <button
        className="project-format-chip"
        onClick={() => setOpen(true)}
        title={t('formats.chip.title', { shape })}
        aria-label={t('formats.chip.aria', { shape })}
      >
        <Crop size={13} /><span>{shape}</span>
      </button>
      {open && (
        <div className="remix-picker-overlay" onClick={() => setOpen(false)}>
          <div className="remix-picker project-format-picker" role="dialog" aria-modal="true" aria-labelledby="project-format-title" onClick={e => e.stopPropagation()}>
            <div className="remix-picker-header">
              <span className="remix-picker-icon-spacer" />
              <h3 id="project-format-title">{t('formats.picker.title')}</h3>
              <button className="remix-picker-icon-btn" onClick={() => setOpen(false)} title={t('common.close')}>
                <X size={16} />
              </button>
            </div>
            <div className="remix-picker-options">
              {PROJECT_ASPECTS.map(a => {
                const over = length > maxSecondsFor('video', a) + 0.01
                return (
                  <button
                    key={a}
                    className={`remix-picker-option${a === aspect ? ' project-format-current' : ''}`}
                    aria-pressed={a === aspect}
                    onClick={() => { onChange(a); setOpen(false) }}
                  >
                    <span className="remix-picker-diagram"><AspectDiagram aspect={a} /></span>
                    <span className="remix-picker-copy">
                      <strong>{aspectLabel(a)}{proLocked && isProAspect(a) && <ProBadge />}</strong>
                      <small>
                        {t(ASPECT_INFO[a].hintKey)}
                        {over ? ` · ${t('formats.picker.tooLong', { length: formatLength(length), limit: limitText(maxSecondsFor('video', a)) })}` : ''}
                      </small>
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="project-format-note">{t('formats.picker.note')}</p>
          </div>
        </div>
      )}
    </>
  )
}
