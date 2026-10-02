import { useState, useEffect, useCallback, useRef } from 'react'
import './OnboardingTour.css'

const TOUR_STEPS = [
  {
    target: '.app-branding',
    title: 'Welcome!',
    text: 'Welcome to the 3Speak Shorts Editor. Let\'s take a quick tour of the key features.',
    position: 'below'
  },
  {
    target: '.compact-global-preview',
    title: 'Preview',
    text: 'This is your video preview. You can drag clips to reposition them and pinch to zoom.',
    position: 'below'
  },
  {
    target: '.compact-timeline-section',
    title: 'Timeline',
    text: 'Arrange your clips here. Drag to reorder, resize the edges to trim.',
    position: 'above'
  },
  {
    target: '.track-add-btn',
    title: 'Add Media',
    text: 'Tap + to add video, images, text, audio, or color clips to your tracks.',
    position: 'above'
  },
  {
    target: '.clip-settings-btn, .action-btn',
    title: 'Clip Settings',
    text: 'Select a clip and tap the gear icon to edit its properties like scale, position, and opacity.',
    position: 'above',
    fallbackTarget: '.compact-timeline-section'
  },
  {
    target: '.compact-render-btn',
    title: 'Render',
    text: 'When you\'re done editing, hit Render to export your video. You can then download or send it.',
    position: 'below'
  }
]

export default function OnboardingTour({ onComplete }) {
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState(null)
  const tooltipRef = useRef(null)

  const currentStep = TOUR_STEPS[step]

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
      const r = el.getBoundingClientRect()
      const padding = 6
      setRect({
        top: r.top - padding,
        left: r.left - padding,
        width: r.width + padding * 2,
        height: r.height + padding * 2
      })
    } else {
      // No element found — show centered without spotlight
      setRect(null)
    }
  }, [currentStep])

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
    if (step < TOUR_STEPS.length - 1) {
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

    if (currentStep.position === 'above') {
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
        <div className="tour-tooltip-title">{currentStep.title}</div>
        <div className="tour-tooltip-text">{currentStep.text}</div>
        <div className="tour-tooltip-footer">
          <div className="tour-dots">
            {TOUR_STEPS.map((_, i) => (
              <span key={i} className={`tour-dot${i === step ? ' active' : ''}`} />
            ))}
          </div>
          <div className="tour-buttons">
            <button className="tour-skip-btn" onClick={handleSkip}>Skip</button>
            <button className="tour-next-btn" onClick={handleNext}>
              {step === TOUR_STEPS.length - 1 ? 'Got it!' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
