// Undo / redo (src/utils/history.js, used by hooks/useHistory.js the way the
// `editor` helper below does: record() in the state updater, sync() after render).
import { describe, it, expect } from 'vitest'
import { createHistory, share, countObjects, changedValues, MAX_HISTORY } from '../src/utils/history.js'

// The history as it was before (useTimeline.js until 2026-11): kept here only
// to pin the bugs the new one fixes. Same code, minus React.
function oldHistory(initial) {
  let tracks = initial
  let history = []
  let index = -1
  let isUndoRedo = false
  const save = (t) => {
    if (isUndoRedo) { isUndoRedo = false; return }
    const h = history.slice(0, index + 1)
    h.push(JSON.parse(JSON.stringify(t)))
    if (h.length > 20) h.shift(); else index++
    history = h
  }
  return {
    edit(fn) { tracks = fn(tracks); save(tracks) },
    undo() { if (index > 0) { index--; isUndoRedo = true; tracks = JSON.parse(JSON.stringify(history[index])) } },
    redo() { if (index < history.length - 1) { index++; isUndoRedo = true; tracks = JSON.parse(JSON.stringify(history[index])) } },
    get tracks() { return tracks },
    get canUndo() { return index > 0 },
    get canRedo() { return index < history.length - 1 }
  }
}

// A stand-in for the React side: fields with live values, edits that record
// in their updater and sync after the "render", like useUndoableState
function editor(fieldsInit, opts = {}) {
  const h = createHistory({ coalesceMs: 0, ...opts })
  const live = { ...fieldsInit }
  for (const key of Object.keys(live)) h.field(key, { get: () => live[key], set: (v) => { live[key] = v } })
  h.sync() // first render: the empty project is the first step
  const api = {
    h,
    live,
    edit(key, fn) {
      const next = fn(live[key])
      if (next !== live[key]) h.record()
      live[key] = next
      h.sync()
    },
    // several fields changed in one event (one render): one step
    editMany(changes) {
      for (const [key, fn] of Object.entries(changes)) {
        const next = fn(live[key])
        if (next !== live[key]) h.record()
        live[key] = next
      }
      h.sync()
    },
    silently(key, v) { live[key] = v; h.sync() },
    undo() { h.undo(); h.sync() },
    redo() { h.redo(); h.sync() }
  }
  return api
}

const clip = (id, at = 0, extra = {}) => ({ id, type: 'video', url: `https://x/api/upload/files/${id}.mp4`, timelinePosition: at, startTime: 0, endTime: 5, duration: 5, ...extra })
const oneTrack = (clips) => [{ id: 't1', type: 'video', clips }]
const move = (id, at) => (tracks) => tracks.map(t => ({ ...t, clips: t.clips.map(c => (c.id === id ? { ...c, timelinePosition: at } : c)) }))
const add = (c) => (tracks) => tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, c] } : t))
const posOf = (tracks, id) => tracks[0].clips.find(c => c.id === id)?.timelinePosition

describe('the old history (pinned bugs)', () => {
  it('lost the first edit after an undo, and redo then threw it away', () => {
    const o = oldHistory(oneTrack([clip('a')]))
    o.edit(move('a', 1))
    o.edit(move('a', 2))
    o.undo() // a at 1
    o.edit(move('a', 7)) // not recorded: the flag from the undo swallowed it
    expect(o.canRedo).toBe(true) // the redo stack was not cleared
    o.redo()
    expect(posOf(o.tracks, 'a')).toBe(2) // ... and redo replaced the edit
  })

  it('could not undo the very first edit of a session, and kept only 20 steps', () => {
    const o = oldHistory(oneTrack([clip('a')]))
    o.edit(move('a', 1))
    expect(o.canUndo).toBe(false)
    for (let i = 2; i < 40; i++) o.edit(move('a', i))
    let undos = 0
    while (o.canUndo) { o.undo(); undos++ }
    expect(undos).toBe(19)
  })
})

describe('undo that never loses an edit', () => {
  it('records the first edit after an undo and clears the redo steps', () => {
    const e = editor({ tracks: oneTrack([clip('a')]) })
    e.edit('tracks', move('a', 1))
    e.edit('tracks', move('a', 2))
    e.undo()
    expect(posOf(e.live.tracks, 'a')).toBe(1)
    e.edit('tracks', move('a', 7))
    expect(e.h.canRedo).toBe(false)
    e.redo() // nothing to redo
    expect(posOf(e.live.tracks, 'a')).toBe(7)
    e.undo()
    expect(posOf(e.live.tracks, 'a')).toBe(1)
    e.redo()
    expect(posOf(e.live.tracks, 'a')).toBe(7)
  })

  it('also after a redo', () => {
    const e = editor({ tracks: oneTrack([clip('a')]) })
    e.edit('tracks', move('a', 1))
    e.edit('tracks', move('a', 2))
    e.undo(); e.undo(); e.redo()
    e.edit('tracks', move('a', 9))
    expect(e.h.canRedo).toBe(false)
    e.undo()
    expect(posOf(e.live.tracks, 'a')).toBe(1)
    e.undo()
    expect(posOf(e.live.tracks, 'a')).toBe(0)
  })

  it('the very first edit can be undone', () => {
    const e = editor({ tracks: oneTrack([clip('a')]) })
    expect(e.h.canUndo).toBe(false)
    e.edit('tracks', move('a', 3))
    expect(e.h.canUndo).toBe(true)
    e.undo()
    expect(posOf(e.live.tracks, 'a')).toBe(0)
  })

  it('an edit that changes nothing is no step (and a repeated updater, as in StrictMode, is one)', () => {
    const e = editor({ tracks: oneTrack([clip('a')]) })
    e.edit('tracks', (t) => t)
    e.edit('tracks', (t) => JSON.parse(JSON.stringify(t))) // same content, new objects
    expect(e.h.size).toBe(1)
    // StrictMode runs an updater twice: record() twice, one sync, one step
    e.h.record(); e.h.record()
    e.live.tracks = move('a', 4)(e.live.tracks)
    e.h.sync(); e.h.sync()
    expect(e.h.size).toBe(2)
  })

  it('keeps 200 steps by default, the oldest go first', () => {
    expect(MAX_HISTORY).toBe(200)
    const e = editor({ tracks: oneTrack([clip('a')]) })
    for (let i = 1; i <= 250; i++) e.edit('tracks', move('a', i))
    expect(e.h.size).toBe(200)
    let undos = 0
    while (e.h.canUndo) { e.undo(); undos++ }
    expect(undos).toBe(199)
    expect(posOf(e.live.tracks, 'a')).toBe(51)
  })

  it('covers any clip field, also ones added later (speed, keyframes, transitions, filters)', () => {
    const e = editor({ tracks: oneTrack([clip('a')]) })
    const set = (fields) => (t) => t.map(tr => ({ ...tr, clips: tr.clips.map(c => ({ ...c, ...fields })) }))
    e.edit('tracks', set({ speed: 2 }))
    e.edit('tracks', set({ keyframes: [{ t: 0, zoom: 100 }, { t: 2, zoom: 140 }] }))
    e.edit('tracks', set({ transitionIn: { type: 'crossfade', duration: 0.5 }, filter: { name: 'warm' } }))
    e.undo()
    expect(e.live.tracks[0].clips[0].transitionIn).toBeUndefined()
    expect(e.live.tracks[0].clips[0].keyframes).toHaveLength(2)
    e.undo(); e.undo()
    expect(e.live.tracks[0].clips[0].speed).toBeUndefined()
    e.redo()
    expect(e.live.tracks[0].clips[0].speed).toBe(2)
  })
})

describe('chapters, flags and master settings are under undo too', () => {
  const fresh = () => editor({ tracks: oneTrack([clip('a')]), chapters: [], flags: [], master: { loudness: true, duck: false, duckDb: -12 } })

  it('each is its own step, in the order made', () => {
    const e = fresh()
    e.edit('chapters', (l) => [...l, { id: 'c1', title: 'Intro', at: 0 }])
    e.edit('flags', (l) => [...l, { id: 'f1', at: 2 }])
    e.edit('master', (m) => ({ ...m, loudness: false }))
    e.edit('tracks', move('a', 4))
    e.undo()
    expect(posOf(e.live.tracks, 'a')).toBe(0)
    expect(e.live.master.loudness).toBe(false)
    e.undo()
    expect(e.live.master.loudness).toBe(true)
    e.undo()
    expect(e.live.flags).toEqual([])
    expect(e.live.chapters).toHaveLength(1)
    e.undo()
    expect(e.live.chapters).toEqual([])
  })

  it('a change of several in one go is one step (a template: tracks + master)', () => {
    const e = fresh()
    e.editMany({ tracks: add(clip('intro', 0)), master: (m) => ({ ...m, loudness: false }) })
    expect(e.h.size).toBe(2)
    e.undo()
    expect(e.live.tracks[0].clips).toHaveLength(1)
    expect(e.live.master.loudness).toBe(true)
  })

  it('an undo only sets what differs (a chapter undo leaves the tracks object alone)', () => {
    const e = fresh()
    e.edit('chapters', (l) => [...l, { id: 'c1', title: 'Intro', at: 0 }])
    const before = e.live.tracks
    e.undo()
    expect(e.live.tracks).toBe(before)
  })

  it('a renamed chapter is undone to its old title', () => {
    const e = fresh()
    e.edit('chapters', () => [{ id: 'c1', title: 'Chapter 1', at: 0 }])
    e.edit('chapters', (l) => l.map(c => ({ ...c, title: 'Interview' })))
    e.undo()
    expect(e.live.chapters[0].title).toBe('Chapter 1')
  })
})

describe('opening a project, background fixes', () => {
  it('an opened draft is the first step: undo never goes back to the empty editor', () => {
    const e = editor({ tracks: oneTrack([]), chapters: [] })
    e.edit('tracks', add(clip('x')))
    e.h.reset()
    e.live.tracks = oneTrack([clip('a'), clip('b', 5)])
    e.live.chapters = [{ id: 'c1', title: 'Intro', at: 0 }]
    e.h.sync()
    expect(e.h.canUndo).toBe(false)
    expect(e.h.canRedo).toBe(false)
    e.edit('chapters', () => [])
    e.undo()
    expect(e.live.chapters).toHaveLength(1) // the draft's chapters, not the old editor's
    expect(e.live.tracks[0].clips).toHaveLength(2)
  })

  it('amend folds a correction into the current step (no step of its own)', () => {
    const e = editor({ tracks: oneTrack([clip('a')]), master: { duck: true } })
    e.edit('tracks', move('a', 2))
    e.h.amend()
    e.live.master = { duck: false }
    e.h.sync()
    expect(e.h.size).toBe(2)
    e.undo(); e.redo()
    expect(e.live.master.duck).toBe(false)
  })

  it('patchAll changes every step (a finished upload): undo never brings the old URL back', () => {
    const e = editor({ tracks: oneTrack([clip('a', 0, { serverUrl: null })]) })
    e.edit('tracks', move('a', 1))
    e.edit('tracks', move('a', 2))
    const patch = (t) => t.map(tr => ({ ...tr, clips: tr.clips.map(c => (c.serverUrl ? c : { ...c, serverUrl: '/api/upload/files/a.mp4' })) }))
    e.h.patchAll('tracks', patch)
    e.live.tracks = patch(e.live.tracks)
    e.undo(); e.undo()
    expect(e.live.tracks[0].clips[0].serverUrl).toBe('/api/upload/files/a.mp4')
    expect(posOf(e.live.tracks, 'a')).toBe(0)
  })

  it('a silent change is no step', () => {
    const e = editor({ tracks: oneTrack([clip('a')]) })
    e.silently('tracks', move('a', 5)(e.live.tracks))
    expect(e.h.size).toBe(1)
  })

  it('undo gives the live state a copy, never the stored (frozen) snapshot', () => {
    const e = editor({ tracks: oneTrack([clip('a')]) })
    e.edit('tracks', move('a', 1))
    e.undo()
    expect(Object.isFrozen(e.live.tracks)).toBe(false)
    e.live.tracks[0].clips[0].timelinePosition = 99 // even a mutation does not reach the history
    e.redo(); e.undo()
    expect(posOf(e.live.tracks, 'a')).toBe(0)
  })
})

describe('long podcast projects stay small (steps share what did not change)', () => {
  it('200 one-clip edits on a 500-clip timeline hold about one timeline, not 200', () => {
    const clips = Array.from({ length: 500 }, (_, i) => clip(`c${i}`, i * 5, { volume: 1, fadeIn: 0, name: `Part ${i}` }))
    const e = editor({ tracks: [{ id: 'v', type: 'audio', clips }, { id: 'm', type: 'audio', music: true, clips: [] }] })
    const one = countObjects([e.h.entries[0]])
    for (let i = 0; i < 199; i++) e.edit('tracks', move(`c${(i * 7) % 500}`, 10000 + i))
    expect(e.h.size).toBe(200)
    const all = countObjects(e.h.entries)
    // full copies would be ~200x one timeline; shared steps add a few objects each
    expect(all).toBeLessThan(one + 199 * 6)
    expect(JSON.stringify(e.h.entries).length).toBeGreaterThan(150 * JSON.stringify(e.h.entries[0]).length) // what copies would cost
  })

  it('a clip inserted at the front still shares every clip after it', () => {
    const clips = Array.from({ length: 50 }, (_, i) => clip(`c${i}`, i))
    const e = editor({ tracks: oneTrack(clips) })
    const before = e.h.entries[0].tracks[0].clips
    e.edit('tracks', (t) => [{ ...t[0], clips: [clip('new'), ...t[0].clips] }])
    const after = e.h.entries[1].tracks[0].clips
    expect(after[1]).toBe(before[0])
    expect(after[50]).toBe(before[49])
  })
})

describe('share', () => {
  it('returns the old value when nothing changed, and new parts frozen', () => {
    const a = share(undefined, { x: [1, { id: 'k', v: 2 }] })
    expect(share(a, { x: [1, { id: 'k', v: 2 }] })).toBe(a)
    const b = share(a, { x: [1, { id: 'k', v: 3 }] })
    expect(b).not.toBe(a)
    expect(Object.isFrozen(b.x[1])).toBe(true)
    expect(share(a, { x: [1, { id: 'k', v: 2 }], y: undefined })).toBe(a) // undefined = no field
  })
})

describe('a slider drag is one step', () => {
  const volume = (v) => (t) => t.map(tr => ({ ...tr, clips: tr.clips.map(c => (c.id === 'a' ? { ...c, volume: v } : c)) }))
  const clocked = () => {
    let t = 1000
    const e = editor({ tracks: oneTrack([clip('a', 0, { volume: 1 }), clip('b', 5, { volume: 1 })]) }, { coalesceMs: 800, now: () => t })
    return { e, tick: (ms) => { t += ms } }
  }

  it('the same value changed again and again within 0.8 s merges into one step', () => {
    const { e, tick } = clocked()
    for (let i = 1; i <= 30; i++) { e.edit('tracks', volume(1 - i / 100)); tick(30) }
    expect(e.h.size).toBe(2)
    e.undo()
    expect(e.live.tracks[0].clips[0].volume).toBe(1)
    e.redo()
    expect(e.live.tracks[0].clips[0].volume).toBeCloseTo(0.7)
  })

  it('a pause, another value, or an add in between makes a new step', () => {
    const { e, tick } = clocked()
    e.edit('tracks', volume(0.5)); tick(100)
    e.edit('tracks', move('b', 9)); tick(100) // another value
    e.edit('tracks', volume(0.4)); tick(900) // after a pause
    e.edit('tracks', volume(0.3)); tick(100)
    e.edit('tracks', add(clip('c', 20))); tick(100) // structural
    e.edit('tracks', add(clip('d', 25)))
    expect(e.h.size).toBe(7)
  })

  it('never merges into a step reached by undo', () => {
    const { e, tick } = clocked()
    e.edit('tracks', volume(0.5)); tick(900)
    e.edit('tracks', volume(0.4)); tick(100)
    e.undo()
    e.edit('tracks', volume(0.2))
    e.undo()
    expect(e.live.tracks[0].clips[0].volume).toBe(0.5)
  })

  it('changedValues names the values, or null for a structural change', () => {
    const a = share(undefined, { tracks: [{ id: 't', clips: [{ id: 'c', v: 1 }] }] })
    expect(changedValues(a, { tracks: [{ id: 't', clips: [{ id: 'c', v: 2 }] }] })).toBe('tracks.t.clips.c.v')
    expect(changedValues(a, { tracks: [{ id: 't', clips: [] }] })).toBe(null)
    expect(changedValues(a, { tracks: [{ id: 't', clips: [{ id: 'c', v: 1, w: 1 }] }] })).toBe(null)
  })
})
