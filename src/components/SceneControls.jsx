import { COLOR_PRESETS } from '../adwizard/engine'
import { TITLE_FONTS, SCENE_DURATION, templateOf, sceneLength, sceneUpdate } from '../utils/titleScenes'

/** The fields of a title template as inputs (shared with the Titles dialog). */
export function SceneFieldInputs({ template, values, onChange }) {
  return template.fields.map(f => {
    const v = values?.[f.k]
    const id = `scene-field-${template.id}-${f.k}`
    return (
      <div className="property-group" key={f.k}>
        <label htmlFor={id}>{f.label}</label>
        {f.kind === 'lines'
          ? (
            <textarea
              id={id}
              className="text-input"
              rows={Math.min(4, f.max || 3)}
              value={Array.isArray(v) ? v.join('\n') : (v || '')}
              onChange={(e) => onChange({ [f.k]: e.target.value.split('\n').slice(0, f.max || 5) })}
              placeholder="One per line"
            />
            )
          : (
            <input id={id} className="text-input" type="text" value={v || ''} maxLength={f.kind === 'para' ? 140 : 80} onChange={(e) => onChange({ [f.k]: e.target.value })} />
            )}
      </div>
    )
  })
}

/** Colour preset chips and the font (shared with the Titles dialog). */
export function SceneStyleInputs({ style, onChange }) {
  return (
    <>
      <div className="property-group">
        <label>Colours</label>
        <div className="transition-chips" role="radiogroup" aria-label="Colours">
          {COLOR_PRESETS.map(p => (
            <button
              key={p.name}
              type="button"
              role="radio"
              aria-checked={style?.colors === p.name}
              className={`transition-chip scene-colors${style?.colors === p.name ? ' active' : ''}`}
              onClick={() => onChange({ colors: p.name })}
            >
              {/* the preset's own colours: content the user picks, like a colour input */}
              <span className="scene-colors-dot" style={{ background: p.colors.bg, borderColor: p.colors.accent }} />
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <div className="property-group">
        <label>Font</label>
        <select className="font-select" value={style?.font || 'Inter'} onChange={(e) => onChange({ font: e.target.value })}>
          {TITLE_FONTS.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
        </select>
      </div>
    </>
  )
}

/**
 * A title clip (motion scene, utils/titleScenes.js): its words, colours, font,
 * length and whether it lies over the video or brings its own background.
 */
export default function SceneControls({ clip, onUpdateClip }) {
  const template = templateOf(clip.scene?.template)
  const length = sceneLength(clip)
  const update = (patch) => onUpdateClip(sceneUpdate(clip, patch))
  return (
    <div className="prop-group">
      <div className="prop-group-label">Title</div>
      {template && <SceneFieldInputs template={template} values={clip.scene?.fields} onChange={(fields) => update({ fields })} />}
      <p className="transition-hint">Put *stars* around a word to colour it.</p>
      <SceneStyleInputs style={clip.sceneStyle} onChange={(sceneStyle) => update({ sceneStyle })} />
      <div className="property-group">
        <label>
          Over the video
          <label className="toggle-switch" style={{ marginLeft: 'auto' }}>
            <input type="checkbox" checked={clip.transparent !== false} onChange={(e) => update({ transparent: e.target.checked })} aria-label="Over the video" />
            <span className="toggle-slider" />
          </label>
        </label>
      </div>
      <div className="property-group">
        <label>Length</label>
        <div className="property-slider">
          <input type="range" min={SCENE_DURATION[0]} max={SCENE_DURATION[1]} step="0.1" value={length} onChange={(e) => update({ scene: { duration: parseFloat(e.target.value) } })} aria-label="Length (seconds)" />
          <span>{length.toFixed(1)}s</span>
        </div>
      </div>
    </div>
  )
}
