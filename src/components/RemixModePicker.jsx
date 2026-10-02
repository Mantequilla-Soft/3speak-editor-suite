import { useState } from 'react'
import { ChevronLeft, X } from 'lucide-react'

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

const MODES = [
  { id: 'stitch', title: 'Stitch', text: 'Record a clip that plays before or after the original.' },
  { id: 'reaction', title: 'Reaction', text: 'Record yourself while the original plays.' },
  { id: 'free', title: 'Free edit', text: 'Open the editor with the original on the timeline.' }
]

const STITCH_ORDER = [
  { id: 'stitchBefore', diagram: 'stitchBefore', title: 'Before the original', text: 'Your clip plays first, then the original.' },
  { id: 'stitchAfter', diagram: 'stitch', title: 'After the original', text: 'The original plays first, then your clip.' }
]

const REACTION_LAYOUTS = [
  { id: 'overlay', title: 'Overlay', text: 'Your camera in a small box on top of the original. Drag it anywhere.' },
  { id: 'tileTop', title: 'Tile above', text: 'Original shrinks to the bottom half, you on top.' },
  { id: 'tileBottom', title: 'Tile below', text: 'Original shrinks to the top half, you below.' }
]

/**
 * Shown when a whole video arrives for remixing. Calls onChoose with
 * 'stitchBefore' | 'stitchAfter' | 'overlay' | 'tileTop' | 'tileBottom' | 'free'.
 */
function RemixModePicker({ onChoose }) {
  const [step, setStep] = useState('mode') // mode | stitch | reaction

  const options = step === 'mode' ? MODES : step === 'stitch' ? STITCH_ORDER : REACTION_LAYOUTS
  const pick = (id) => {
    if (id === 'reaction' || id === 'stitch') setStep(id)
    else onChoose(id)
  }
  const title = step === 'mode'
    ? 'How do you want to remix?'
    : step === 'stitch' ? 'Where should your clip go?' : 'Where should your reaction go?'

  return (
    <div className="remix-picker-overlay">
      <div className="remix-picker" role="dialog" aria-modal="true" aria-labelledby="remix-picker-title">
        <div className="remix-picker-header">
          {step !== 'mode' ? (
            <button className="remix-picker-icon-btn" onClick={() => setStep('mode')} title="Back">
              <ChevronLeft size={16} />
            </button>
          ) : <span className="remix-picker-icon-spacer" />}
          <h3 id="remix-picker-title">{title}</h3>
          <button className="remix-picker-icon-btn" onClick={() => onChoose('free')} title="Skip, free edit">
            <X size={16} />
          </button>
        </div>

        <div className="remix-picker-options">
          {options.map(opt => (
            <button key={opt.id} className="remix-picker-option" onClick={() => pick(opt.id)}>
              <span className="remix-picker-diagram">{DIAGRAMS[opt.diagram || opt.id]}</span>
              <span className="remix-picker-copy">
                <strong>{opt.title}</strong>
                <small>{opt.text}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default RemixModePicker
