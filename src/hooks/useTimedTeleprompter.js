import { useCallback, useEffect, useRef, useState } from 'react'

// Timed teleprompter: moves the same "read so far" word pointer the voice mode
// uses, but at a steady words-per-minute pace instead of following the reader.
// Works in every browser (no speech recognition), so it is the default where
// Web Speech is not dependable (anything that is not Chromium).
//
// The pointer is fractional internally so a speed change mid-take is smooth; the
// public `matchedCount` only changes when a whole word is passed, which keeps the
// overlay from re-rendering on every animation frame.
export function useTimedTeleprompter(totalWords, { wpm = 130 } = {}) {
  const [matchedCount, setMatchedCount] = useState(0)
  const [running, setRunning] = useState(false)
  const posRef = useRef(0)
  const wpmRef = useRef(wpm)
  wpmRef.current = wpm
  const totalRef = useRef(totalWords)
  totalRef.current = totalWords

  useEffect(() => {
    if (!running) return undefined
    let raf = 0
    let last = performance.now()
    const tick = (now) => {
      const dt = Math.min(250, now - last) // a backgrounded tab must not jump ahead
      last = now
      const total = totalRef.current
      posRef.current = Math.min(total, posRef.current + (dt / 60000) * Math.max(1, wpmRef.current))
      const whole = Math.floor(posRef.current)
      setMatchedCount(prev => (prev === whole ? prev : whole))
      if (posRef.current >= total) { setRunning(false); return }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [running])

  const start = useCallback(() => { if (totalRef.current > 0) setRunning(true) }, [])
  const pause = useCallback(() => setRunning(false), [])
  const reset = useCallback(() => {
    posRef.current = 0
    setMatchedCount(0)
    setRunning(false)
  }, [])
  // Jump to a word (used when voice following fails mid-take and the timer takes
  // over from where the reader was).
  const seek = useCallback((n) => {
    const v = Math.max(0, Math.min(totalRef.current, Number(n) || 0))
    posRef.current = v
    setMatchedCount(Math.floor(v))
  }, [])

  // A new script starts from the top.
  useEffect(() => { reset() }, [totalWords, reset])

  return { matchedCount, running, start, pause, reset, seek }
}

export default useTimedTeleprompter
