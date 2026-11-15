import { useState } from 'react'
import { ChevronLeft, X } from './icons'
import { useT } from '../i18n'

// Mini 9:16 diagrams of each arrangement. "S" = the original, "R" = your recording.
function Frame({ children, dashed }) {
  return (
    <svg className="remix-diagram" viewBox="0 0 36 64" aria-hidden="true">
      <rect x="0.5" y="0.5" width="35" height="63" rx="3" className={dashed ? 'rd-frame rd-dashed' : 'rd-frame'} />
      {children}
    </svg>
  )
}
const Src = (props) => <rect className="rd-src" rx="2" {...props} />
const Rec = (props) => <rect className="rd-rec" rx="2" {...props} />

const DIAGRAMS = {
  stitch: (
    <div className="remix-diagram-pair">
      <Frame><Src x="3" y="3" width="30" height="58" /></Frame>
      <span className="remix-diagram-arrow">→</span>
      <Frame><Rec x="3" y="3" width="30" height="58" /></Frame>
    </div>
  ),
  stitchBefore: (
    <div className="remix-diagram-pair">
      <Frame><Rec x="3" y="3" width="30" height="58" /></Frame>
      <span className="remix-diagram-arrow">→</span>
      <Frame><Src x="3" y="3" width="30" height="58" /></Frame>
    </div>
  ),
  reaction: (
    <Frame>
      <Src x="3" y="3" width="30" height="58" />
      <Rec x="19" y="42" width="13" height="17" />
    </Frame>
  ),
  free: (
    <Frame dashed>
      <Src x="6" y="10" width="24" height="44" />
    </Frame>
  ),
  overlay: (
    <Frame>
      <Src x="3" y="3" width="30" height="58" />
      <Rec x="19" y="42" width="13" height="17" />
    </Frame>
  ),
  tileTop: (
    <Frame>
      <Rec x="3" y="3" width="30" height="27.5" />
      <Src x="3" y="33.5" width="30" height="27.5" />
    </Frame>
  ),
  tileBottom: (
    <Frame>
      <Src x="3" y="3" width="30" height="27.5" />
      <Rec x="3" y="33.5" width="30" height="27.5" />
    </Frame>
  )
}

// Each option's title and text: remix.options.<id>.title / .text
const MODES = [{ id: 'stitch' }, { id: 'reaction' }, { id: 'free' }]

const STITCH_ORDER = [
  { id: 'stitchBefore', diagram: 'stitchBefore' },
  { id: 'stitchAfter', diagram: 'stitch' }
]

const REACTION_LAYOUTS = [{ id: 'overlay' }, { id: 'tileTop' }, { id: 'tileBottom' }]

/**
 * Shown when a whole video arrives for remixing. Calls onChoose with
 * 'stitchBefore' | 'stitchAfter' | 'overlay' | 'tileTop' | 'tileBottom' | 'free'.
 */
function RemixModePicker({ onChoose }) {
  const { t } = useT()
  const [step, setStep] = useState('mode') // mode | stitch | reaction

  const options = step === 'mode' ? MODES : step === 'stitch' ? STITCH_ORDER : REACTION_LAYOUTS
  const pick = (id) => {
    if (id === 'reaction' || id === 'stitch') setStep(id)
    else onChoose(id)
  }
  const title = t(`remix.titles.${step}`) // mode | stitch | reaction

  return (
    <div className="remix-picker-overlay">
      <div className="remix-picker" role="dialog" aria-modal="true" aria-labelledby="remix-picker-title">
        <div className="remix-picker-header">
          {step !== 'mode' ? (
            <button className="remix-picker-icon-btn" onClick={() => setStep('mode')} title={t('common.back')}>
              <ChevronLeft size={16} />
            </button>
          ) : <span className="remix-picker-icon-spacer" />}
          <h3 id="remix-picker-title">{title}</h3>
          <button className="remix-picker-icon-btn" onClick={() => onChoose('free')} title={t('remix.skip')}>
            <X size={16} />
          </button>
        </div>

        <div className="remix-picker-options">
          {options.map(opt => (
            <button key={opt.id} className="remix-picker-option" onClick={() => pick(opt.id)}>
              <span className="remix-picker-diagram">{DIAGRAMS[opt.diagram || opt.id]}</span>
              <span className="remix-picker-copy">
                <strong>{t(`remix.options.${opt.id}.title`)}</strong>
                <small>{t(`remix.options.${opt.id}.text`)}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default RemixModePicker
