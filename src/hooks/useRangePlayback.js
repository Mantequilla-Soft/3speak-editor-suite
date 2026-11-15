import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Listening to one stretch of the timeline (a filler with a second around it,
 * a suggested chapter start): plays the editor's preview from `from` and stops
 * at `to`. `controlRef`: the preview's handle (GlobalPreview / the audio stage:
 * playFrom, pause, getPosition). playing: the { key, from, to } playing, or null.
 */
export function useRangePlayback(controlRef) {
  const [playing, setPlaying] = useState(null)
  const ref = useRef(null)
  ref.current = playing

  const stop = useCallback(() => {
    if (ref.current) controlRef.current?.pause?.()
    setPlaying(null)
  }, [controlRef])

  const play = useCallback((from, to, key = `${from}`) => {
    if (ref.current?.key === key) { stop(); return }
    const start = Math.max(0, from)
    controlRef.current?.playFrom?.(start)
    setPlaying({ key, from: start, to })
  }, [controlRef, stop])

  useEffect(() => {
    if (!playing) return undefined
    const started = Date.now()
    const id = setInterval(() => {
      const pos = controlRef.current?.getPosition?.()
      // past the end, or the preview never got there (stopped by hand)
      if ((typeof pos === 'number' && pos >= playing.to) || Date.now() - started > (playing.to - playing.from + 3) * 1000) stop()
    }, 30)
    return () => clearInterval(id)
  }, [playing, controlRef, stop])

  useEffect(() => () => { if (ref.current) controlRef.current?.pause?.() }, [controlRef])

  return { playing, play, stop }
}
