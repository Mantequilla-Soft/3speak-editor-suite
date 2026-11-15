import { useState, useEffect, useCallback, useRef } from 'react'
import './OnboardingTour.css'
import { useT } from '../i18n'

// Step text is a key (tour.json), looked up when the step shows, so it follows the
// interface language. Targets are class names: an aria-label changes with the language.

// The shorts editor's tour (the default).
export const TOUR_STEPS = [
  {
    target: '.app-branding',
    titleKey: 'tour.shorts.welcome.title',
    textKey: 'tour.shorts.welcome.text',
    position: 'below'
  },
  {
    target: '.compact-global-preview',
    titleKey: 'tour.shorts.preview.title',
    textKey: 'tour.shorts.preview.text',
    position: 'below'
  },
  {
    target: '.compact-timeline-section',
    titleKey: 'tour.shorts.timeline.title',
    textKey: 'tour.shorts.timeline.text',
    position: 'above'
  },
  {
    target: '.track-add-btn',
    titleKey: 'tour.shorts.addMedia.title',
    textKey: 'tour.shorts.addMedia.text',
    position: 'above'
  },
  {
    target: '.clip-settings-btn, .action-btn',
    titleKey: 'tour.shorts.clipSettings.title',
    textKey: 'tour.shorts.clipSettings.text',
    position: 'above',
    fallbackTarget: '.compact-timeline-section'
  },
  {
    target: '.compact-render-btn',
    titleKey: 'tour.shorts.render.title',
    textKey: 'tour.shorts.render.text',
    position: 'below'
  }
]

// The audio editor's tour (?mode=audio), shown on the first visit to it.
// Targets are the audio-mode controls in App.jsx and Timeline.jsx; a step
// whose target is missing shows centred without a spotlight.
export const AUDIO_TOUR_STEPS = [
  {
    target: '.app-branding',
    titleKey: 'tour.audio.welcome.title',
    textKey: 'tour.audio.welcome.text',
    position: 'below'
  },
  {
    target: '.compact-global-preview',
    titleKey: 'tour.audio.addAudio.title',
    textKey: 'tour.audio.addAudio.text',
    position: 'below'
  },
  {
    target: '.compact-timeline-section',
    titleKey: 'tour.audio.tracks.title',
    textKey: 'tour.audio.tracks.text',
    position: 'above'
  },
  {
    target: '.compact-side',
    titleKey: 'tour.audio.clipSettings.title',
    textKey: 'tour.audio.clipSettings.text',
    position: 'below',
    fallbackTarget: '.compact-timeline-section'
  },
  {
    target: '.tour-cut-silences',
    titleKey: 'tour.audio.cutSilences.title',
    textKey: 'tour.audio.cutSilences.text',
    position: 'below'
  },
  {
    target: '.tour-template',
    titleKey: 'tour.audio.template.title',
    textKey: 'tour.audio.template.text',
    position: 'below'
  },
  {
    target: '.tour-normalize',
    titleKey: 'tour.audio.normalize.title',
    textKey: 'tour.audio.normalize.text',
    position: 'below'
  },
  {
    target: '.tour-chapters',
    titleKey: 'tour.audio.chapters.title',
    textKey: 'tour.audio.chapters.text',
    position: 'below'
  },
  {
    target: '.compact-render-btn',
    titleKey: 'tour.audio.export.title',
    textKey: 'tour.audio.export.text',
    position: 'below'
  }
]

// The audiogram studio's tour, the first time it opens (targets in AudiogramDialog.jsx)
export const AUDIOGRAM_TOUR_STEPS = [
  {
    target: '.audiogram-studio .remix-picker-header',
    titleKey: 'tour.audiogram.intro.title',
    textKey: 'tour.audiogram.intro.text',
    position: 'below'
  },
  {
    target: '.audiogram-pick',
    titleKey: 'tour.audiogram.piece.title',
    textKey: 'tour.audiogram.piece.text',
    position: 'below'
  },
  {
    target: '.audiogram-stage',
    titleKey: 'tour.audiogram.arrange.title',
    textKey: 'tour.audiogram.arrange.text',
    position: 'below'
  },
  {
    target: '.audiogram-pictures',
    titleKey: 'tour.audiogram.picture.title',
    textKey: 'tour.audiogram.picture.text',
    position: 'below'
  },
  {
    target: '.audiogram-wave-types',
    titleKey: 'tour.audiogram.waveform.title',
    textKey: 'tour.audiogram.waveform.text',
    position: 'below'
  },
  {
    target: '.audiogram-layers',
    titleKey: 'tour.audiogram.parts.title',
    textKey: 'tour.audiogram.parts.text',
    position: 'above'
  },
  {
    target: '.audiogram-make',
    titleKey: 'tour.audiogram.make.title',
    textKey: 'tour.audiogram.make.text',
    position: 'above'
  }
]

// Choosing the audiogram's piece on the timeline, the first time (targets in App.jsx and Timeline.jsx)
export const RANGE_PICK_TOUR_STEPS = [
  {
    target: '.timeline-content',
    titleKey: 'tour.rangePick.startEnd.title',
    textKey: 'tour.rangePick.startEnd.text',
    position: 'above'
  },
  {
    target: '.timeline-toolbar .toolbar-center',
    titleKey: 'tour.rangePick.moveAround.title',
    textKey: 'tour.rangePick.moveAround.text',
    position: 'above'
  },
  {
    target: '.range-pick-play',
    titleKey: 'tour.rangePick.listen.title',
    textKey: 'tour.rangePick.listen.text',
    position: 'above'
  },
  {
    target: '.range-pick-bar',
    titleKey: 'tour.rangePick.use.title',
    textKey: 'tour.rangePick.use.text',
    position: 'above'
  }
]

/**
 * A tour shown the first time something is used: [show, finish]. `key` is the
 * storage key; storage that throws (a sandboxed iframe) shows the tour.
 * `when` false: not now (shows once it turns true and was never finished).
 */
export function useFirstTimeTour(key, when = true) {
  const [done, setDone] = useState(() => {
    try { return !!localStorage.getItem(key) } catch { return false }
  })
  const finish = useCallback(() => {
    try { localStorage.setItem(key, '1') } catch { /* storage blocked */ }
    setDone(true)
  }, [key])
  return [when && !done, finish]
}

export default function OnboardingTour({ onComplete, steps = TOUR_STEPS }) {
  const { t } = useT()
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState(null)
  const tooltipRef = useRef(null)
  const scrolledStepRef = useRef(-1)

  const currentStep = steps[step]

  const updateRect = useCallback(() => {
    if (!currentStep) return
    // Try each selector (comma-separated)
    const selectors = currentStep.target.split(',').map(s => s.trim())
    let el = null
    for (const sel of selectors) {
      el = document.querySelector(sel)
      if (el) break
    }
    // Fallback target if primary not found
    if (!el && currentStep.fallbackTarget) {
      el = document.querySelector(currentStep.fallbackTarget)
    }
    if (el) {
      if (scrolledStepRef.current !== step) {
        scrolledStepRef.current = step
        el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      }
      const r = el.getBoundingClientRect()
      const padding = 6
      setRect({
        top: r.top - padding,
        left: r.left - padding,
        width: r.width + padding * 2,
        height: r.height + padding * 2
      })
    } else {
      // No element found: show centered without spotlight
      setRect(null)
    }
  }, [currentStep, step])

  useEffect(() => {
    updateRect()
    window.addEventListener('resize', updateRect)
    const interval = setInterval(updateRect, 500) // catch layout shifts
    return () => {
      window.removeEventListener('resize', updateRect)
      clearInterval(interval)
    }
  }, [updateRect])

  const handleNext = () => {
    if (step < steps.length - 1) {
      setStep(step + 1)
    } else {
      onComplete()
    }
  }

  const handleSkip = () => {
    onComplete()
  }

  // Calculate tooltip position
  let tooltipStyle = {}
  if (rect) {
    const vw = window.innerWidth
    const tooltipWidth = Math.min(300, vw - 32)
    let left = rect.left + rect.width / 2 - tooltipWidth / 2
    // Clamp to screen
    left = Math.max(12, Math.min(left, vw - tooltipWidth - 12))

    // Flip to the other side when there is no room for the tooltip
    // (or on neither side: then it sits inside the top of the target).
    const room = 190
    const roomAbove = rect.top >= room
    const roomBelow = window.innerHeight - (rect.top + rect.height) >= room
    let position = currentStep.position === 'above' ? 'above' : 'below'
    if (position === 'above' && !roomAbove) position = roomBelow ? 'below' : 'inside'
    else if (position === 'below' && !roomBelow) position = roomAbove ? 'above' : 'inside'

    if (position === 'inside') {
      tooltipStyle = { top: Math.max(12, rect.top + 12), left, width: tooltipWidth }
    } else if (position === 'above') {
      tooltipStyle = { bottom: window.innerHeight - rect.top + 12, left, width: tooltipWidth }
    } else {
      tooltipStyle = { top: rect.top + rect.height + 12, left, width: tooltipWidth }
    }
  } else {
    // Centered fallback
    const tooltipWidth = Math.min(300, window.innerWidth - 32)
    tooltipStyle = {
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: tooltipWidth
    }
  }

  return (
    <div className="tour-overlay">
      {rect && (
        <div
          className="tour-spotlight"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          }}
        />
      )}
      <div
        ref={tooltipRef}
        className="tour-tooltip"
        style={tooltipStyle}
      >
        <div className="tour-tooltip-title">{t(currentStep.titleKey)}</div>
        <div className="tour-tooltip-text">{t(currentStep.textKey)}</div>
        <div className="tour-tooltip-footer">
          <div className="tour-dots">
            {steps.map((_, i) => (
              <span key={i} className={`tour-dot${i === step ? ' active' : ''}`} />
            ))}
          </div>
          <div className="tour-buttons">
            <button className="tour-skip-btn" onClick={handleSkip}>{t('common.skip')}</button>
            <button className="tour-next-btn" onClick={handleNext}>
              {step === steps.length - 1 ? t('tour.buttons.done') : t('common.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
