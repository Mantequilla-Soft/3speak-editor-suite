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
    text: 'Select a clip to see its settings. Clean up the voice (Strong takes out noise and rumble and makes it clearer and more even), and Duck: the clip goes down while another track plays. Group voices that were recorded together to keep them in sync.',
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
    target: '[aria-label="Normalize loudness"]',
    title: 'Normalize',
    text: 'Brings the export to an even podcast loudness (-16 LUFS), so every episode sounds as loud as the last. Turn it off to keep your own levels.',
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
    text: 'Export makes an MP3. Listen to it, then use it for your upload or download it. Signed in, your project is kept as a draft while you work.',
    position: 'below'
  }
]

// The audiogram studio's tour, the first time it opens (targets in AudiogramDialog.jsx)
export const AUDIOGRAM_TOUR_STEPS = [
  {
    target: '.audiogram-studio .remix-picker-header',
    title: 'Audiograms',
    text: 'Short videos of a piece of your episode: a moving waveform, your title and picture, with the 3Speak look. They go out as 3Speak Shorts together with the episode.',
    position: 'below'
  },
  {
    target: '.audiogram-pick',
    title: 'Your piece',
    text: 'The piece you picked on the timeline, up to 2 minutes. Change it here any time.',
    position: 'below'
  },
  {
    target: '.audiogram-stage',
    title: 'Arrange it your way',
    text: 'Drag any part to move it, pull a corner to resize it (Shift keeps the shape), and turn it with the round handle under it. The 3Speak logo always stays in, as the 3S or the full logo.',
    position: 'below'
  },
  {
    target: '[aria-label="Picture"]',
    title: 'A picture',
    text: 'Upload one or take the cover of one of your playlists. It shows as a card you can move and resize like the other parts.',
    position: 'below'
  },
  {
    target: '[aria-label="Waveform type"]',
    title: 'The waveform',
    text: 'Bars, lines, a circle or a circle wave, in the 3Speak red or any colour you like.',
    position: 'below'
  },
  {
    target: '.audiogram-layers',
    title: 'Parts',
    text: 'Hide a part, or bring it forward or send it back when parts overlap.',
    position: 'above'
  },
  {
    target: '.audiogram-make',
    title: 'Make it',
    text: 'Make as many as you like: each goes out as a Short with the episode, with its own text and a link to it. Your last look is kept as your template for the next one.',
    position: 'above'
  }
]

// Choosing the audiogram's piece on the timeline, the first time (targets in App.jsx and Timeline.jsx)
export const RANGE_PICK_TOUR_STEPS = [
  {
    target: '.timeline-content',
    title: 'Click the start, then the end',
    text: 'Click where the piece should start, then where it ends: up to 2 minutes. Pull its edges to adjust it, or drag across the tracks to draw a whole piece. A new click starts over.',
    position: 'above'
  },
  {
    target: '.timeline-toolbar .toolbar-center',
    title: 'Move around',
    text: 'Drag the ruler or scroll to move along the episode. Zoom in with the slider for a precise start, or tap Fit to see the whole episode.',
    position: 'above'
  },
  {
    target: '.range-pick-play',
    title: 'Listen to it',
    text: 'Play the piece (or Space) plays just the part you picked, then goes back to its start.',
    position: 'above'
  },
  {
    target: '.range-pick-bar',
    title: 'Use it',
    text: 'Use this piece (or Enter) takes it back to your audiogram, Cancel (or Escape) keeps the old one. Until then the rest of the editor is locked, so nothing else changes by accident.',
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
