import { useState, useEffect, useCallback, useRef } from 'react'
import './OnboardingTour.css'

// The shorts editor's tour (the default).
export const TOUR_STEPS = [
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

// The audio editor's tour (?mode=audio), shown on the first visit to it.
// Targets are the audio-mode controls in App.jsx and Timeline.jsx; a step
// whose target is missing shows centred without a spotlight.
export const AUDIO_TOUR_STEPS = [
  {
    target: '.app-branding',
    title: 'Welcome to the Audio Editor',
    text: 'Cut, clean up and level a podcast, a song or a voice note, then post it on 3Speak. Here is a quick look at what it can do.',
    position: 'below'
  },
  {
    target: '.compact-global-preview',
    title: 'Add your audio',
    text: 'Add a recording, record right here, or pick music from the library. Video files work too: the editor keeps only the sound. Up to 3 hours.',
    position: 'below'
  },
  {
    target: '.compact-timeline-section',
    title: 'Voice and music tracks',
    text: 'Recordings go on voice tracks, music on its own track. Drag a clip to move it, pull its edges to trim. Zoom with the slider, or tap Fit to see the whole thing.',
    position: 'above'
  },
  {
    target: '.compact-side',
    title: 'Clip settings',
    text: 'Select a clip to see its settings. Studio voice takes out noise and rumble and makes the voice clearer and more even. Group voices that were recorded together to keep them in sync.',
    position: 'below',
    fallbackTarget: '.compact-timeline-section'
  },
  {
    target: '[aria-label="Cut silences"]',
    title: 'Cut silences',
    text: 'Finds the pauses in your voice tracks, cuts them out and closes the gaps. Grouped voices are only cut where everyone is quiet.',
    position: 'below'
  },
  {
    target: '[aria-label="Template"]',
    title: 'Your template',
    text: 'Set up an intro, an outro and a music bed once. They go onto every new recording, and your template is kept for good.',
    position: 'below'
  },
  {
    target: '[aria-label="Level loudness"]',
    title: 'Level and duck',
    text: 'Level brings the export to podcast loudness (-16 LUFS). Duck turns the music down while someone talks and back up in the pauses.',
    position: 'below'
  },
  {
    target: '[aria-label="Chapters"]',
    title: 'Chapters',
    text: 'Mark where each part starts (press M to add one at the playhead). Chapters go into the MP3 and into your episode\'s description.',
    position: 'below'
  },
  {
    target: '.compact-render-btn',
    title: 'Export',
    text: 'Export makes an MP3. Listen to it, then use it for your upload or download it. You can also make an Audiogram: a short video teaser to share. Signed in, your project is kept as a draft while you work.',
    position: 'below'
  }
]

export default function OnboardingTour({ onComplete, steps = TOUR_STEPS }) {
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
      // No element found — show centered without spotlight
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
        <div className="tour-tooltip-title">{currentStep.title}</div>
        <div className="tour-tooltip-text">{currentStep.text}</div>
        <div className="tour-tooltip-footer">
          <div className="tour-dots">
            {steps.map((_, i) => (
              <span key={i} className={`tour-dot${i === step ? ' active' : ''}`} />
            ))}
          </div>
          <div className="tour-buttons">
            <button className="tour-skip-btn" onClick={handleSkip}>Skip</button>
            <button className="tour-next-btn" onClick={handleNext}>
              {step === steps.length - 1 ? 'Got it!' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
