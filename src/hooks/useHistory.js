import { useState, useRef, useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import { createHistory, MAX_HISTORY } from '../utils/history'

/** One undo history for the editor (utils/history.js); re-renders when it changes (canUndo / canRedo). */
export function useHistoryStore(limit = MAX_HISTORY) {
  const ref = useRef(null)
  if (!ref.current) ref.current = createHistory({ limit })
  const h = ref.current
  useSyncExternalStore(h.subscribe, h.getVersion, h.getVersion)
  return h
}

/**
 * useState whose changes are undo steps. Returns [value, set, setSilently]:
 * `set` makes an undo step (one per render, however many calls), `setSilently`
 * changes the value without one (loading a draft, a correction).
 * Any project state can join the history this way:
 *   const [chapters, setChapters] = useUndoableState(history, 'chapters', [])
 */
export function useUndoableState(history, key, initial) {
  const [value, setValue] = useState(initial)
  const valueRef = useRef(value)
  valueRef.current = value

  useLayoutEffect(() => history.field(key, { get: () => valueRef.current, set: setValue }), [history, key])
  // After the change is on screen: store the step (or the opened project)
  useEffect(() => { history.sync() }, [history, value])

  const set = useCallback((updater) => {
    setValue(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      if (next !== prev) history.record()
      return next
    })
  }, [history])
  return [value, set, setValue]
}
