// The voice clean-up's progress, shown while it runs.
import { describe, it, expect } from 'vitest'
import { startCleaning, getCleaningStatus, subscribeCleaning, cleaningText } from '../src/utils/cleaningStatus.js'

describe('cleaning status', () => {
  it('a job shows from start to end, with its progress', () => {
    const seen = []
    const off = subscribeCleaning(s => seen.push(s && { ...s }))
    const job = startCleaning({ clips: 12, level: 'studio' })
    expect(cleaningText(getCleaningStatus())).toBe('Cleaning up the voice of 12 clips…')
    job.recordings(3)
    job.done(1)
    expect(cleaningText(getCleaningStatus())).toBe('Cleaning up the voice of 12 clips · recording 2 of 3')
    job.end()
    expect(getCleaningStatus()).toBe(null)
    expect(seen.length).toBe(4)
    off()
  })

  it('an older job ending does not clear a newer one', () => {
    const a = startCleaning({ clips: 1, level: 'light' })
    const b = startCleaning({ clips: 2, level: 'light' })
    a.end()
    expect(getCleaningStatus()?.clips).toBe(2)
    a.done(5) // ignored too
    expect(getCleaningStatus().done).toBe(0)
    b.end()
    expect(getCleaningStatus()).toBe(null)
  })

  it('one recording: no "x of y"; one clip: singular', () => {
    expect(cleaningText({ clips: 1, recordings: 1, done: 0, level: 'studio' })).toBe('Cleaning up the voice of 1 clip…')
    expect(cleaningText(null)).toBe('')
  })
})
