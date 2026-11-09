// Flags: numbered, coloured markers that follow the recording like chapters do.
import { describe, it, expect } from 'vitest'
import { addFlag, moveFlag, removeFlag, resolveFlags, cleanFlags, flagColor, FLAG_COLORS, MAX_FLAGS } from '../src/utils/flags.js'

const voice = (clips) => ({ id: 'v', type: 'audio', clips })
const piece = (id, at, from, to) => ({ id, type: 'audio', libraryId: 'rec', timelinePosition: at, startTime: from, endTime: to })

describe('flags', () => {
  const tracks = [voice([piece('a', 0, 0, 10), piece('b', 10, 20, 30)])]

  it('are numbered in the order they are set, each number its own colour', () => {
    let f = addFlag([], tracks, 3, 'x')
    f = addFlag(f, tracks, 1, 'y')
    expect(f.map(x => x.n)).toEqual([1, 2])
    expect(resolveFlags(tracks, f).map(x => [x.n, x.at])).toEqual([[2, 1], [1, 3]]) // shown by time
    expect(flagColor(1)).not.toBe(flagColor(2))
    expect(new Set(FLAG_COLORS).size).toBe(FLAG_COLORS.length)
    expect(flagColor(FLAG_COLORS.length + 1)).toBe(flagColor(1)) // the colours come round again
  })

  it('a removed number is not reused: the next flag gets max + 1', () => {
    let f = addFlag(addFlag(addFlag([], tracks, 1, 'a'), tracks, 2, 'b'), tracks, 3, 'c')
    f = removeFlag(f, 'b')
    f = addFlag(f, tracks, 4, 'd')
    expect(f.map(x => x.n)).toEqual([1, 3, 4])
  })

  it('follow the recording when a cut moves it; a flag over no recording keeps its time', () => {
    const f = addFlag(addFlag([], tracks, 12, 'in-b'), tracks, 50, 'empty') // 12 s = 22 s of the recording
    const cut = [voice([piece('a', 0, 0, 10), piece('b', 5, 20, 30)])] // a 5 s gap closed
    expect(resolveFlags(cut, f).map(x => [x.id, x.at])).toEqual([['in-b', 7], ['empty', 50]])
    expect(resolveFlags(cut, f, 20).find(x => x.id === 'empty').at).toBe(20) // never past the end
  })

  it('a move pins the flag to what is under it now', () => {
    const f = moveFlag(addFlag([], tracks, 1, 'x'), tracks, 'x', 15)
    expect(f[0]).toMatchObject({ at: 15, anchor: { libraryId: 'rec', t: 25 } })
  })

  it('a saved draft keeps only well-formed flags, at most MAX_FLAGS', () => {
    expect(cleanFlags([{ id: 'a', n: 1, at: 2 }, { id: 'b', n: 0, at: 1 }, null, { n: 2, at: 1 }, { id: 'c', n: 3, at: 'x' }]).map(f => f.id)).toEqual(['a'])
    expect(cleanFlags('nope')).toEqual([])
    expect(cleanFlags(Array.from({ length: 150 }, (_, i) => ({ id: `f${i}`, n: i + 1, at: i }))).length).toBe(MAX_FLAGS)
  })
})
