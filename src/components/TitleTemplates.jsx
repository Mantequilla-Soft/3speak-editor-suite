import { useEffect, useMemo, useRef, useState } from 'react'
import { TITLE_TEMPLATES, TITLE_GROUPS, templateOf, titleClip } from '../utils/titleScenes'
import { COLOR_PRESETS } from '../adwizard/engine'
import SceneLayer from './SceneLayer'
import { SceneFieldInputs, SceneStyleInputs } from './SceneControls'
import { X, ChevronLeft } from './icons'
import './TitleTemplates.css'

const PREVIEW_FRAME = { width: 1080, height: 1920 }

// The preview canvas's height in px (title positions are in preview px)
const previewHeight = () => document.querySelector('.preview-layer-container')?.clientHeight || 640

/**
 * Titles for a Short (utils/titleScenes.js): lower thirds and titles over the
 * video, intro and outro cards, made from the Ad Wizard's motion scenes. Pick
 * one, change its words and colours (it plays as you type), Add puts it at the
 * playhead above the footage.
 */
export default function TitleTemplates({ onAdd, onClose, frame = PREVIEW_FRAME }) {
  const [pickedId, setPickedId] = useState(null)
  const [values, setValues] = useState({})
  const [style, setStyle] = useState({ colors: COLOR_PRESETS[0].name, font: 'Inter' })
  const template = templateOf(pickedId)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pick = (id) => { setPickedId(id); setValues({ ...templateOf(id).values }) }
  const draft = useMemo(() => {
    if (!template) return null
    const c = titleClip(template.id, { values, colors: style.colors, font: style.font })
    // shown whole and centred in the dialog
    return { ...c, id: 'title-preview', zoom: 100, positionX: 0, positionY: 0, timelineStart: 0 }
  }, [template, values, style])

  // play the title on a loop
  const registry = useRef({})
  useEffect(() => {
    if (!draft) return undefined
    let raf = 0
    const t0 = performance.now()
    const tick = (now) => {
      const t = ((now - t0) / 1000) % (draft.endTime + 0.6)
      registry.current[draft.id]?.seek(Math.min(t, draft.endTime))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [draft])

  const add = () => {
    const c = titleClip(template.id, { values, colors: style.colors, font: style.font, previewH: previewHeight() })
    onAdd(c)
    onClose()
  }

  return (
    <div className="remix-picker-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="remix-picker title-templates" role="dialog" aria-modal="true" aria-labelledby="title-templates-heading">
        <div className="remix-picker-header">
          {template
            ? <button className="remix-picker-icon-btn" onClick={() => setPickedId(null)} title="All titles"><ChevronLeft size={16} /></button>
            : <span className="remix-picker-icon-spacer" />}
          <h3 id="title-templates-heading">{template ? template.label : 'Titles'}</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        {!template && TITLE_GROUPS.map(g => (
          <section key={g.id} className="title-group">
            <h4>{g.label}</h4>
            <div className="title-grid">
              {TITLE_TEMPLATES.filter(t => t.group === g.id).map(t => (
                <button key={t.id} type="button" className="title-card" onClick={() => pick(t.id)}>
                  <span className="title-card-name">{t.label}</span>
                  <span className="title-card-sub">{t.transparent ? 'Over the video' : 'Own background'}</span>
                </button>
              ))}
            </div>
          </section>
        ))}

        {template && draft && (
          <div className="title-editor">
            <div className={`title-stage${draft.transparent ? ' over-video' : ''}`}>
              <SceneLayer
                clip={draft}
                time={0}
                frame={frame}
                registry={registry.current}
                style={{ position: 'absolute', inset: 0 }}
              />
            </div>
            <div className="title-fields">
              <SceneFieldInputs template={template} values={values} onChange={(p) => setValues(v => ({ ...v, ...p }))} />
              <p className="transition-hint">Put *stars* around a word to colour it.</p>
              <SceneStyleInputs style={style} onChange={(p) => setStyle(s => ({ ...s, ...p }))} />
            </div>
          </div>
        )}

        {template && (
          <div className="silence-cut-actions">
            <button type="button" className="silence-cut-cancel" onClick={onClose}>Cancel</button>
            <button type="button" className="silence-cut-apply" onClick={add}>Add title</button>
          </div>
        )}
      </div>
    </div>
  )
}
