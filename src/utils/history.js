// Undo / redo for the whole project: the tracks (every clip field, whatever
// it is called, so new clip settings are covered without touching this file)
// plus the other project state registered with it (chapters, flags, the audio
// editor's master settings, captions).
//
// Each step is a snapshot of the project, but snapshots share every part that
// did not change with the step before (structural sharing): a move of one clip
// in a 500-clip podcast stores one new clip object, one clips array and one
// tracks array, not a copy of the whole timeline. So the history can be long
// (MAX_HISTORY steps) and still stay small.
//
// Snapshots are plain JSON values (what JSON.stringify keeps: no File objects,
// no functions), frozen so nothing can change them, and the live state gets a
// fresh copy on undo / redo, never the stored one.

export const MAX_HISTORY = 200
// Changes to the same values in quick succession (a slider dragged, a number
// typed digit by digit) are one step: the next one within this time merges
export const COALESCE_MS = 800

const isObj = (v) => v !== null && typeof v === 'object'
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

// Arrays of objects with an id (tracks, clips, chapters, flags) are matched by
// id, so inserting at the front still shares every element after it
function byId(list) {
  let map = null
  for (const el of list) {
    if (isObj(el) && !Array.isArray(el) && (typeof el.id === 'string' || typeof el.id === 'number')) {
      if (!map) map = new Map()
      if (!map.has(el.id)) map.set(el.id, el)
    }
  }
  return map
}

/**
 * `next` (a plain JSON value) with every part that deep-equals the same part
 * of `prev` replaced by prev's object. Returns `prev` itself when nothing
 * changed. New parts are frozen.
 */
export function share(prev, next) {
  if (prev === next) return prev
  if (!isObj(prev) || !isObj(next) || Array.isArray(prev) !== Array.isArray(next)) {
    return isObj(next) ? deepFreeze(next) : next
  }
  if (Array.isArray(next)) {
    const ids = byId(prev)
    let same = prev.length === next.length
    const out = next.map((el, i) => {
      const candidate = ids && isObj(el) && el.id !== undefined && ids.has(el.id) ? ids.get(el.id) : prev[i]
      const s = share(candidate, el)
      if (s !== prev[i]) same = false
      return s
    })
    return same ? prev : Object.freeze(out)
  }
  // JSON semantics: a field set to undefined is no field
  const keys = Object.keys(next).filter(k => next[k] !== undefined)
  let same = keys.length === Object.keys(prev).length
  const out = {}
  for (const k of keys) {
    const s = share(prev[k], next[k])
    if (s !== prev[k] || !(k in prev)) same = false
    out[k] = s
  }
  return same ? prev : Object.freeze(out)
}

function deepFreeze(v) {
  if (!isObj(v) || Object.isFrozen(v)) return v
  for (const k of Object.keys(v)) deepFreeze(v[k])
  return Object.freeze(v)
}

/**
 * Which values changed from a to b, as a string ('tracks.t1.clips.c3.volume|...'),
 * or null when it is more than a change of values (a clip added, removed or
 * moved in its list, a field added or dropped): such edits never merge.
 */
export function changedValues(a, b, max = 8) {
  const paths = []
  const walk = (x, y, path) => {
    if (x === y) return true
    if (!isObj(x) || !isObj(y)) {
      if (isObj(x) || isObj(y)) return false
      paths.push(path)
      return paths.length <= max
    }
    if (Array.isArray(x) !== Array.isArray(y)) return false
    if (Array.isArray(x)) {
      if (x.length !== y.length) return false
      for (let i = 0; i < x.length; i++) {
        const idx = isObj(x[i]) && x[i].id !== undefined ? x[i].id : i
        if (isObj(x[i]) && isObj(y[i]) && x[i].id !== y[i].id) return false
        if (!walk(x[i], y[i], `${path}.${idx}`)) return false
      }
      return true
    }
    const kx = Object.keys(x)
    if (kx.length !== Object.keys(y).length) return false
    for (const k of kx) {
      if (!(k in y)) return false
      if (!walk(x[k], y[k], path ? `${path}.${k}` : k)) return false
    }
    return true
  }
  return walk(a, b, '') && paths.length ? paths.join('|') : null
}

/**
 * The history store. Fields (`tracks`, `chapters`...) register a getter for
 * their live value and a setter; the React side (hooks/useHistory.js) calls
 * record() when an undoable change is made and sync() after it is on screen.
 */
export function createHistory({ limit = MAX_HISTORY, coalesceMs = COALESCE_MS, now = () => Date.now() } = {}) {
  const fields = new Map() // key -> { get, set }
  let entries = []
  let index = -1
  // The last step pushed: { at, values } (values: changedValues), while it may still merge
  let last = null
  let pushPending = false
  let amendPending = false
  let version = 0
  const listeners = new Set()

  const bump = () => {
    version++
    for (const l of listeners) l()
  }

  const liveDoc = (base) => {
    const raw = {}
    for (const [key, f] of fields) raw[key] = f.get()
    return share(base || {}, plain(raw))
  }

  const api = {
    /** Register (or update) a field: get() returns its live value, set(v) replaces it without a step. */
    field(key, f) {
      fields.set(key, f)
      return () => { if (fields.get(key) === f) fields.delete(key) }
    },
    /** The next sync() stores the live project as a new step (if it changed). */
    record() { pushPending = true },
    /** The next sync() folds the live project into the current step (a correction, not a step of its own). */
    amend() { amendPending = true },
    /** A new project was opened: its state (at the next sync) is the only step. */
    reset() {
      entries = []
      index = -1
      last = null
      pushPending = false
      amendPending = true
      bump()
    },
    /** Store what record() / amend() / reset() asked for. Called after the change is rendered. */
    sync() {
      if (!fields.size) return false
      if (index < 0 || amendPending) {
        const doc = liveDoc(entries[index])
        if (index < 0) { entries = [doc]; index = 0 } else entries[index] = doc
        last = null
        amendPending = false
        pushPending = false
        bump()
        return true
      }
      if (!pushPending) return false
      pushPending = false
      const doc = liveDoc(entries[index])
      if (doc === entries[index]) return false
      const t = now()
      // The same values again, right after: one step (a slider drag)
      if (last && index > 0 && index === entries.length - 1 && t - last.at < coalesceMs) {
        const values = changedValues(entries[index], doc)
        if (values && values === last.values && changedValues(entries[index - 1], doc) === values) {
          entries[index] = doc
          last.at = t
          bump()
          return true
        }
      }
      last = { at: t, values: changedValues(entries[index], doc) }
      // A new edit after an undo: the steps that were undone are gone
      entries = entries.slice(0, index + 1)
      entries.push(doc)
      if (entries.length > limit) entries = entries.slice(entries.length - limit)
      index = entries.length - 1
      bump()
      return true
    },
    undo() {
      // An edit not stored yet is stored first, so the undo takes back that one
      if (pushPending) api.sync()
      return api.go(index - 1)
    },
    redo() { return api.go(index + 1) },
    go(target) {
      if (target < 0 || target >= entries.length || target === index) return false
      last = null
      index = target
      const doc = entries[index]
      const live = liveDoc(doc)
      for (const [key, f] of fields) {
        if (!(key in doc)) continue
        // Only what differs is set, so an undo of a chapter does not re-render the timeline
        if (live[key] !== doc[key]) f.set(plain(doc[key]))
      }
      bump()
      return true
    },
    /**
     * Change one field in every step without making a step (an upload that
     * finished, a playable copy that is ready): undo must never bring the old
     * value back. fn is called once per distinct value, so sharing is kept.
     */
    patchAll(key, fn) {
      // fn maps immutably (it gets the frozen snapshot); each result is shared
      // with the step before it, so the steps keep sharing what they shared
      const memo = new Map()
      let prevOut
      entries = entries.map(e => {
        if (!(key in e)) return e
        const v = e[key]
        if (!memo.has(v)) {
          prevOut = share(prevOut === undefined ? v : prevOut, fn(v))
          memo.set(v, prevOut)
        }
        const nv = memo.get(v)
        return nv === v ? e : Object.freeze({ ...e, [key]: nv })
      })
      bump()
    },
    get canUndo() { return index > 0 },
    get canRedo() { return index >= 0 && index < entries.length - 1 },
    get size() { return entries.length },
    get index() { return index },
    get entries() { return entries },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
    getVersion() { return version }
  }
  return api
}

/** How many distinct objects all steps hold together (tests: proof that steps share). */
export function countObjects(entries) {
  const seen = new Set()
  const walk = (v) => {
    if (!isObj(v) || seen.has(v)) return
    seen.add(v)
    for (const k of Object.keys(v)) walk(v[k])
  }
  for (const e of entries) walk(e)
  return seen.size
}
