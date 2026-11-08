// The audio editor's first-visit tour points at controls by selector. If a
// control is renamed or dropped, its step silently loses the spotlight, so
// check every target still exists in the audio-mode markup.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { AUDIO_TOUR_STEPS, TOUR_STEPS } from '../src/components/OnboardingTour.jsx'

const source = ['src/App.jsx', 'src/components/Timeline.jsx', 'src/components/GlobalPreview.jsx']
  .map(f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))
  .join('\n')

// '.foo' -> className containing foo; '[aria-label="Foo"]' -> aria-label="Foo"
function inSource(selector) {
  const aria = selector.match(/^\[aria-label="(.+)"\]$/)
  if (aria) return source.includes(`aria-label="${aria[1]}"`)
  const cls = selector.match(/^\.([\w-]+)$/)
  if (cls) return new RegExp(`className=[{"\`'][^\\n]*\\b${cls[1]}\\b`).test(source)
  return false
}

describe('audio editor tour', () => {
  it('has its own steps, separate from the shorts tour', () => {
    expect(AUDIO_TOUR_STEPS.length).toBeGreaterThan(5)
    expect(AUDIO_TOUR_STEPS).not.toBe(TOUR_STEPS)
    expect(AUDIO_TOUR_STEPS[0].title).toMatch(/Audio Editor/)
  })

  it('every step targets a control that exists', () => {
    for (const step of AUDIO_TOUR_STEPS) {
      const selectors = [step.target, step.fallbackTarget].filter(Boolean).flatMap(s => s.split(',').map(x => x.trim()))
      expect(selectors.some(inSource), `${step.title}: ${selectors.join(' | ')}`).toBe(true)
    }
  })

  it('every step has a title and text, and the copy has no em dashes', () => {
    for (const step of AUDIO_TOUR_STEPS) {
      expect(step.title).toBeTruthy()
      expect(step.text).toBeTruthy()
      expect(step.title + step.text).not.toMatch(/—/)
    }
  })
})
