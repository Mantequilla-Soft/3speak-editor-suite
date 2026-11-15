import { useEffect, useMemo, useRef, useState } from 'react'
import { TITLE_TEMPLATES, TITLE_GROUPS, templateOf, titleClip } from '../utils/titleScenes'
import { COLOR_PRESETS } from '../adwizard/engine'
import SceneLayer from './SceneLayer'
import { SceneFieldInputs, SceneStyleInputs } from './SceneControls'
import { X, ChevronLeft } from './icons'
import { useT } from '../i18n'
import './TitleTemplates.css'

const PREVIEW_FRAME = { width: 1080, height: 1920 }

// The preview canvas in px (title positions are in preview px)
const previewBox = () => {
  const el = document.querySelector('.preview-layer-container')
  return el ? { previewW: el.clientWidth, previewH: el.clientHeight } : {}
}

/**
 * Titles for a Short (utils/titleScenes.js): lower thirds and titles over the
 * video, intro and outro cards, made from the Ad Wizard's motion scenes. Pick
 * one, change its words and colours (it plays as you type), Add puts it at the
 * playhead above the footage.
 */
export default function TitleTemplates({ onAdd, onClose, frame = PREVIEW_FRAME }) {
  const { t, lang } = useT()
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
  }, [template, values, style, lang])

  // play the title on a loop
  const registry = useRef({})
  useEffect(() => {
    if (!draft) return undefined
    let raf = 0
    const t0 = performance.now()
    const tick = (now) => {
      const at = ((now - t0) / 1000) % (draft.endTime + 0.6)
      registry.current[draft.id]?.seek(Math.min(at, draft.endTime))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [draft])

  const add = () => {
    const c = titleClip(template.id, { values, colors: style.colors, font: style.font, ...previewBox() })
    onAdd(c)
    onClose()
  }

  return (
    <div className="remix-picker-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="remix-picker title-templates" role="dialog" aria-modal="true" aria-labelledby="title-templates-heading">
        <div className="remix-picker-header">
          {template
            ? <button className="remix-picker-icon-btn" onClick={() => setPickedId(null)} title={t('titles.templates.allTitles')}><ChevronLeft size={16} /></button>
            : <span className="remix-picker-icon-spacer" />}
          <h3 id="title-templates-heading">{template ? template.label : t('titles.templates.dialogTitle')}</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title={t('common.close')}>
            <X size={16} />
          </button>
        </div>

        {!template && TITLE_GROUPS.map(g => (
          <section key={g.id} className="title-group">
            <h4>{g.label}</h4>
            <div className="title-grid">
              {TITLE_TEMPLATES.filter(tpl => tpl.group === g.id).map(tpl => (
                <button key={tpl.id} type="button" className="title-card" onClick={() => pick(tpl.id)}>
                  <span className="title-card-name">{tpl.label}</span>
                  <span className="title-card-sub">{tpl.transparent ? t('titles.templates.overVideo') : t('titles.templates.ownBackground')}</span>
                </button>
              ))}
            </div>
          </section>
        ))}

        {template && draft && (
          <div className="title-editor">
            <div className={`title-stage${draft.transparent ? ' over-video' : ''}`} style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
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
              <p className="transition-hint">{t('titles.templates.starsHint')}</p>
              <SceneStyleInputs style={style} onChange={(p) => setStyle(s => ({ ...s, ...p }))} />
            </div>
          </div>
        )}

        {template && (
          <div className="silence-cut-actions">
            <button type="button" className="silence-cut-cancel" onClick={onClose}>{t('common.cancel')}</button>
            <button type="button" className="silence-cut-apply" onClick={add}>{t('titles.templates.addTitle')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
