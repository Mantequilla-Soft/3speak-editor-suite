import { describe, it, expect } from 'vitest'
import { voiceTracks, trackLevels, speakerSegments, projectSpeakers, LEVEL_STEP } from '../src/utils/speakers'

// A file's peaks (10 ms each) that are loud in the given [from, to) seconds
function env(seconds, loud, level = 0.6, floor = 0.01) {
  const peaks = new Float32Array(Math.round(seconds / 0.01)).fill(floor)
  for (const [a, b] of loud) for (let i = Math.round(a / 0.01); i < Math.round(b / 0.01); i++) peaks[i] = level
  return { peaks, step: 0.01 }
}
const values = (seconds, loud, level = 0.6, floor = 0.01) => {
  const v = new Float32Array(Math.ceil(seconds / LEVEL_STEP)).fill(floor)
  for (const [a, b] of loud) for (let i = Math.round(a / LEVEL_STEP); i < Math.round(b / LEVEL_STEP); i++) v[i] = level
  return v
}

describe('who is speaking', () => {
  it('only voice tracks count: no music, no sound effects, nothing muted, no template parts', () => {
    const tracks = [
      { id: 'a', type: 'audio', name: 'badadib', clips: [{ id: 1, url: 'u1' }, { id: 2, url: 'u2', templateRole: 'intro' }] },
      { id: 'm', type: 'audio', music: true, clips: [{ id: 3, url: 'u3' }] },
      { id: 'x', type: 'audio', muted: true, clips: [{ id: 4, url: 'u4' }] },
      { id: 'v', type: 'video', clips: [{ id: 5, url: 'u5' }] },
      { id: 'e', type: 'audio', clips: [] }
    ]
    const v = voiceTracks(tracks)
    expect(v.map(t => t.id)).toEqual(['a'])
    expect(v[0].clips.map(c => c.id)).toEqual([1])
  })

  it('a track is as loud as its clips where they sit, read from their own part of the file, times their volume', () => {
    const e = env(20, [[10, 12]])
    // the clip plays 10..14 s of its file from 2 s on the timeline, at half volume
    const track = { clips: [{ url: 'u', timelinePosition: 2, startTime: 10, endTime: 14, volume: 50 }] }
    const lv = trackLevels(track, () => e, 8)
    expect(lv.length).toBe(32)
    expect(lv[Math.floor(2.5 / LEVEL_STEP)]).toBeCloseTo(0.3)
    expect(lv[Math.floor(4.5 / LEVEL_STEP)]).toBeCloseTo(0.005)
    expect(lv[Math.floor(1 / LEVEL_STEP)]).toBe(0)
    expect(trackLevels(track, () => null, 8).every(v => v === 0)).toBe(true)
  })

  it('takes turns: the clearly louder voice, held through short pauses, a quick interjection ignored', () => {
    const host = values(30, [[0, 8], [8.5, 10], [20, 30]])
    const guest = values(30, [[10, 19.5], [25, 25.5]])
    const turns = speakerSegments([{ name: 'badadib', values: host }, { name: 'fan', values: guest }])
    expect(turns.map(t => t.name)).toEqual(['badadib', 'fan', 'badadib'])
    expect(turns[0].start).toBe(0)
    expect(turns[1].start).toBeCloseTo(10, 0)
    expect(turns[2].start).toBeCloseTo(20, 0)
    expect(turns[2].end).toBe(30)
    for (let i = 1; i < turns.length; i++) expect(turns[i].start).toBeGreaterThanOrEqual(turns[i - 1].end)
  })

  it('bleed of the other voice into a microphone does not count, and long silence ends a turn', () => {
    const host = values(20, [[0, 5]], 0.6)
    const guest = values(20, [[0, 5]], 0.3) // the host, heard through the guest's microphone
    const turns = speakerSegments([{ name: 'badadib', values: host }, { name: 'fan', values: guest }])
    expect(turns).toEqual([{ start: 0, end: 5, name: 'badadib' }])
    expect(speakerSegments([])).toEqual([])
  })

  it('builds the turns of a project from its clips\' peaks, with the names given', async () => {
    const tracks = [
      { id: 'h', type: 'audio', name: 'Voice', clips: [{ id: 1, url: 'host', timelinePosition: 0, startTime: 0, endTime: 20 }] },
      { id: 'g', type: 'audio', name: 'Voice 2', clips: [{ id: 2, url: 'guest', timelinePosition: 0, startTime: 0, endTime: 20 }] }
    ]
    const files = { host: env(20, [[0, 9]]), guest: env(20, [[10, 20]]) }
    const turns = await projectSpeakers(tracks, { h: 'badadib', g: 'fan' }, 20, async (url) => files[url])
    expect(turns.map(t => t.name)).toEqual(['badadib', 'fan'])
  })
})
