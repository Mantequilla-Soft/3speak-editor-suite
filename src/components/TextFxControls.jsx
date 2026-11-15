import { TEXT_ANIMS, STROKE_MAX, STAGGER_RANGE, normalizeTextStroke, normalizeTextAnim } from '../utils/textAnim'
import { RotateCcw } from './icons'
import './TransitionControls.css'

const DEFAULT_STROKE = { color: '#000000', width: 3 }

/**
 * A text clip's outline (colour and width, drawn outside the letters) and its
 * word by word entrance (utils/textAnim.js). The preview and the render draw
 * both the same way.
 */
export default function TextFxControls({ clip, onUpdateClip }) {
  const stroke = normalizeTextStroke(clip.textStroke)
  const anim = normalizeTextAnim(clip.textAnim)
  const setStroke = (patch) => onUpdateClip({ textStroke: normalizeTextStroke({ ...(stroke || DEFAULT_STROKE), ...patch }) })
  const setAnim = (patch) => onUpdateClip({ textAnim: patch ? normalizeTextAnim({ ...(anim || {}), ...patch }) : null })
  return (
    <div className="prop-group">
      <div className="prop-group-label">Text effects</div>
      <div className="property-group">
        <label>
          Outline
          <label className="toggle-switch" style={{ marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={!!stroke}
              onChange={(e) => onUpdateClip({ textStroke: e.target.checked ? { ...DEFAULT_STROKE } : null })}
              aria-label="Outline"
            />
            <span className="toggle-slider" />
          </label>
        </label>
        {stroke && (
          <>
            <div className="color-field">
              <input type="color" value={stroke.color} onChange={(e) => setStroke({ color: e.target.value })} className="color-input" aria-label="Outline colour" />
              <span className="color-value">{stroke.color}</span>
            </div>
            <div className="property-slider">
              <input type="range" min="0.5" max={STROKE_MAX} step="0.5" value={stroke.width} onChange={(e) => setStroke({ width: parseFloat(e.target.value) })} aria-label="Outline width" />
              <span>{stroke.width}px</span>
            </div>
          </>
        )}
      </div>
      <div className="property-group">
        <label>
          Words come in
          {anim && (
            <button className="prop-reset-btn" onClick={() => setAnim(null)} title="All at once">
              <RotateCcw size={10} />
            </button>
          )}
        </label>
        <div className="transition-chips" role="radiogroup" aria-label="Words come in">
          <button type="button" role="radio" aria-checked={!anim} className={`transition-chip${!anim ? ' active' : ''}`} onClick={() => setAnim(null)}>
            At once
          </button>
          {TEXT_ANIMS.map(a => (
            <button key={a.id} type="button" role="radio" aria-checked={anim?.type === a.id} className={`transition-chip${anim?.type === a.id ? ' active' : ''}`} onClick={() => setAnim({ type: a.id })}>
              {a.label}
            </button>
          ))}
        </div>
        {anim && (
          <div className="property-slider fade-slider">
            <span className="fade-label">Gap</span>
            <input
              type="range"
              min={STAGGER_RANGE[0]}
              max={STAGGER_RANGE[1]}
              step="0.01"
              value={anim.stagger}
              onChange={(e) => setAnim({ stagger: parseFloat(e.target.value) })}
              aria-label="Time between words (seconds)"
            />
            <span>{anim.stagger.toFixed(2)}s</span>
          </div>
        )}
      </div>
    </div>
  )
}
