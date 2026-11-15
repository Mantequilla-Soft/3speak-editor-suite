import { useCallback, useState } from 'react'
import { cleanAspect, readProjectAspect } from '../utils/projectFormat'
import { setProjectLimit } from '../utils/limits'

/**
 * The video project's shape (utils/projectFormat.js): starts as the page asked
 * (?aspect= / ?format=, else a Short), changes from the top bar, comes back
 * with a draft. The timeline's length limit follows it (utils/limits.js).
 */
export function useProjectFormat() {
  const [aspect, setAspectState] = useState(() => {
    const a = readProjectAspect()
    setProjectLimit(a)
    return a
  })
  const setAspect = useCallback((next) => {
    const a = cleanAspect(next)
    setProjectLimit(a)
    setAspectState(a)
  }, [])
  return { aspect, setAspect }
}
