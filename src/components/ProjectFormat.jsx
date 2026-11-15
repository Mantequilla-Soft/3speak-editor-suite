import { useState } from 'react'
import { X, Crop } from './icons'
import { PROJECT_ASPECTS, ASPECT_INFO, aspectValue } from '../utils/projectFormat'
import { limitText, maxSecondsFor, formatLength, getTimelineEnd } from '../utils/limits'
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

/**
 * The project's shape, at the top of the video editor: a chip that says what it
 * is, opening the picker. Changing it keeps every clip; footage is fitted into
 * the new frame (Export as reframes it around faces instead).
 */
export default function ProjectFormat({ aspect, onChange, tracks }) {
  const [open, setOpen] = useState(false)
  const info = ASPECT_INFO[aspect] || ASPECT_INFO['9:16']
  const length = getTimelineEnd(tracks)
  return (
    <>
      <button
        className="project-format-chip"
        onClick={() => setOpen(true)}
        title={`Shape of this project: ${info.label} ${aspect}. Click to change it`}
        aria-label={`Project shape: ${info.label} ${aspect}`}
      >
        <Crop size={13} /><span>{info.label} {aspect}</span>
      </button>
      {open && (
        <div className="remix-picker-overlay" onClick={() => setOpen(false)}>
          <div className="remix-picker project-format-picker" role="dialog" aria-modal="true" aria-labelledby="project-format-title" onClick={e => e.stopPropagation()}>
            <div className="remix-picker-header">
              <span className="remix-picker-icon-spacer" />
              <h3 id="project-format-title">What are you making?</h3>
              <button className="remix-picker-icon-btn" onClick={() => setOpen(false)} title="Close">
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
                      <strong>{ASPECT_INFO[a].label} {a}</strong>
                      <small>
                        {ASPECT_INFO[a].hint}
                        {over ? ` · your timeline is ${formatLength(length)}, trim it to ${limitText(maxSecondsFor('video', a))} to render` : ''}
                      </small>
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="project-format-note">The shape decides how it goes to 3Speak: 9:16 as a Short, the others as a normal video. Export as renders it in other shapes too.</p>
          </div>
        </div>
      )}
    </>
  )
}
