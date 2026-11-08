import { useSyncExternalStore } from 'react'

// A voice clean-up in progress (cleanVoiceChanges in ClipProperties): every
// recording among the clips goes through the backend one after the other,
// which takes a while for long recordings or many clips. The clip panel and
// the editor's notice both show it, and the notice stays while you select
// other clips. null = nothing running.
//   { id, clips, recordings (null while the sources are worked out), done, level }
let status = null
const listeners = new Set()

export function getCleaningStatus() { return status }

export function subscribeCleaning(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function publish(next) {
  status = next
  for (const fn of listeners) fn(status)
}

let nextId = 1
/** Start a job; returns its controls. Only the job that is shown can clear it. */
export function startCleaning({ clips, level }) {
  const id = nextId++
  publish({ id, clips, recordings: null, done: 0, level })
  const mine = () => status?.id === id
  return {
    recordings: (n) => { if (mine()) publish({ ...status, recordings: n }) },
    done: (n) => { if (mine()) publish({ ...status, done: n }) },
    end: () => { if (mine()) publish(null) }
  }
}

export function useCleaningStatus() {
  return useSyncExternalStore(subscribeCleaning, getCleaningStatus, getCleaningStatus)
}

/** "Cleaning up the voice of 12 clips · recording 2 of 3" */
export function cleaningText(s) {
  if (!s) return ''
  const what = s.level ? `Cleaning up the voice of ${s.clips} clip${s.clips === 1 ? '' : 's'}` : `Switching ${s.clips} clip${s.clips === 1 ? '' : 's'} back`
  if (s.recordings == null) return `${what}…`
  return s.recordings > 1 ? `${what} · recording ${Math.min(s.done + 1, s.recordings)} of ${s.recordings}` : `${what}…`
}
