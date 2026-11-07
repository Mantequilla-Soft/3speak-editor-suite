import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/utils/serverAnalysis', () => ({ serverAnalysis: vi.fn(), isServerUpload: (u) => /\/api\/upload\/files\//.test(u || '') }))
const { serverAnalysis } = await import('../src/utils/serverAnalysis')
const { serializeProject, defaultName, projectMode } = await import('../src/hooks/useDrafts')
const { rulerInterval, zoomRange } = await import('../src/components/Timeline')
const { audioFileName } = await import('../src/utils/audioTemplate')
const { loadLoudness } = await import('../src/utils/silenceDetect')
const { getPeaks } = await import('../src/utils/peakCache')
const { projectMeta } = await import('../src/components/DraftsDialogs')

const up = (n) => `https://editor.example/api/upload/files/${n}.wav`

describe('drafts remember their editor', () => {
  const tracks = [
    { id: 'v', type: 'audio', name: 'Voice', clips: [
      { id: 'i', type: 'audio', name: 'Jingle.mp3', url: up('i'), templateRole: 'intro', startTime: 0, endTime: 2 },
      { id: 'a', type: 'audio', name: 'Part 2 · Episode 12.wav', url: 'blob:x', serverUrl: up('a'), startTime: 0, endTime: 9, file: {} }
    ] },
    { id: 'm', type: 'audio', name: 'Music', music: true, clips: [] }
  ]
  it('an audio project stores mode and finishing settings; local references are dropped', () => {
    const { state, pending } = serializeProject(tracks, [], new Map(), { mode: 'audio', master: { loudness: false } })
    expect(state.mode).toBe('audio')
    expect(state.master).toEqual({ loudness: false })
    expect(pending).toBe(0)
    const a = state.tracks[0].clips.find(c => c.id === 'a')
    expect(a.url).toBe(up('a'))
    expect(a.file).toBeUndefined()
    expect(state.tracks[1].music).toBe(true)
  })
  it('a video project has no mode (as before)', () => {
    const { state } = serializeProject([{ id: 'v', type: 'video', clips: [] }], [])
    expect(state.mode).toBeUndefined()
    expect(state.master).toBeUndefined()
  })
  it('projectMode: old summaries are video', () => {
    expect(projectMode({ mode: 'audio' })).toBe('audio')
    expect(projectMode({})).toBe('video')
    expect(projectMode(null)).toBe('video')
  })
  it('an audio draft is named after the recording, not the intro', () => {
    expect(defaultName(tracks, 'audio')).toMatch(/^Episode 12 · /)
    expect(defaultName([{ type: 'audio', clips: [] }], 'audio')).toMatch(/^Episode · /)
  })
  it('the replace list marks audio drafts and shows hours', () => {
    expect(projectMeta({ mode: 'audio', clips: 12, length: 3725, updatedAt: Date.now() })).toMatch(/^Audio · 12 clips · 1:02:05 · edited just now$/)
    expect(projectMeta({ clips: 1, length: 30, updatedAt: Date.now() })).toMatch(/^1 clip · 0:30/)
  })
})

describe('timeline for long audio', () => {
  it('ruler labels stay readable at every zoom', () => {
    expect(rulerInterval(100)).toBe(1)
    expect(rulerInterval(33)).toBe(2)
    expect(rulerInterval(1)).toBe(60)
    expect(rulerInterval(0.1)).toBe(600)
    expect(rulerInterval(0.02)).toBe(3600)
    for (const z of [200, 50, 10, 3, 0.5, 0.05]) expect(rulerInterval(z) * z).toBeGreaterThanOrEqual(56)
  })
  it('the audio editor zooms out far enough for 3 hours on a phone', () => {
    const { min } = zoomRange(true)
    expect(3 * 3600 * min).toBeLessThanOrEqual(600)
    expect(zoomRange(false)).toEqual({ min: 10, max: 200 })
  })
})

describe('audioFileName', () => {
  it('slugs the title for the MP3 3Speak receives', () => {
    expect(audioFileName('My Show: Episode 4!')).toBe('my-show-episode-4.mp3')
    expect(audioFileName('Café Über Ålesund')).toBe('cafe-uber-alesund.mp3')
    expect(audioFileName('')).toBe('edited-audio.mp3')
    expect(audioFileName(null)).toBe('edited-audio.mp3')
    expect(audioFileName('日本語')).toBe('edited-audio.mp3')
    expect(audioFileName('x'.repeat(200)).length).toBe(64)
  })
})

describe('the backend measures what the browser cannot', () => {
  beforeEach(() => serverAnalysis.mockReset())

  it('loadLoudness: a file over the browser limit is measured by the backend', async () => {
    serverAnalysis.mockResolvedValue({ step: 0.02, duration: 3600, db: [-20, -90, -25], peaks: [0.5, 0, 0.4] })
    const huge = { size: 400 * 1024 * 1024, arrayBuffer: () => { throw new Error('should not read') } }
    Object.setPrototypeOf(huge, Blob.prototype)
    const l = await loadLoudness(huge, { analysisUrl: up('big') })
    expect(serverAnalysis).toHaveBeenCalledWith(up('big'), expect.anything())
    expect(Array.from(l.db)).toEqual([-20, -90, -25])
    expect(l.step).toBe(0.02)
    expect(l.duration).toBe(3600)
  })

  it('loadLoudness: without an upload it still says the file is too large', async () => {
    const huge = { size: 400 * 1024 * 1024 }
    Object.setPrototypeOf(huge, Blob.prototype)
    await expect(loadLoudness(huge)).rejects.toThrow('too-large')
    expect(serverAnalysis).not.toHaveBeenCalled()
  })

  it('getPeaks: undecodable in the browser, peaks from the backend once uploaded', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 415 })
    expect(await getPeaks('blob:local-1')).toBeNull()
    serverAnalysis.mockResolvedValue({ step: 0.02, duration: 2, db: [-10, -10], peaks: [0.25, 0.75] })
    const env = await getPeaks('blob:local-1', { analysisUrl: up('p') })
    expect(Array.from(env.peaks)).toEqual([0.25, 0.75])
    expect(env.step).toBe(0.02)
  })
})
