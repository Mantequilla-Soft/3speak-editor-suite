import { useEffect, useRef, useState } from 'react'
import { needsPersonMask, personJobKey, startPersonMask, subscribePersonMasks, personMaskStatus } from '../utils/personMaskJobs'

/**
 * Background removal (person key): makes the matte of every clip that has the
 * key on and no matte yet, one source at a time, and puts its maskUrl on all
 * the clips of that source (split pieces, duplicates) when it is done.
 * Mounted once in App; the clip settings show the progress (usePersonMaskStatus).
 */
export function usePersonMasks(tracks, updateClip) {
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const updateRef = useRef(updateClip)
  updateRef.current = updateClip
  const busyRef = useRef(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (busyRef.current) return
    const clip = tracks.flatMap(t => (t.type === 'video' ? t.clips : [])).find(c => needsPersonMask(c) && !personMaskStatus(c)?.error)
    if (!clip) return
    busyRef.current = true
    const key = personJobKey(clip)
    startPersonMask(clip).then((maskUrl) => {
      for (const t of tracksRef.current) {
        for (const c of t.clips) {
          if (needsPersonMask(c) && personJobKey(c) === key) updateRef.current(c.id, { chromaKey: { ...c.chromaKey, maskUrl } })
        }
      }
    }).catch(() => { /* the status shows the error; Try again clears it */ }).finally(() => {
      busyRef.current = false
      setTick(n => n + 1) // look for the next one
    })
  }, [tracks, tick])

  // A cleared error (Try again) starts the clip again
  useEffect(() => subscribePersonMasks(() => setTick(n => n + 1)), [])
}

/** Re-render on job progress; returns the clip's { progress, error } or null. */
export function usePersonMaskStatus(clip) {
  const [, setN] = useState(0)
  useEffect(() => subscribePersonMasks(() => setN(n => n + 1)), [])
  return clip ? personMaskStatus(clip) : null
}
