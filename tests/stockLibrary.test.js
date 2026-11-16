// Stock media library: library.json items, filtering, and where a pick lands on the timeline.
import { describe, it, expect } from 'vitest'
const { normalizeStockItem, loadStockLibraries, filterStock, stockDuration } = await import('../src/utils/stockLibrary')
const { placeStockClip } = await import('../src/utils/stockPlacement')

const LIB = {
  categories: [{ id: 'nature', label: 'Nature' }, { id: 'city', label: 'City' }],
  items: [
    { id: 'wm1', type: 'video', category: 'nature', title: 'Ocean waves', tags: ['ocean', 'waves', 'sea'], file: 'videos/wm1.mp4', thumb: 'thumbs/wm1.jpg', preview: 'previews/wm1.mp4', width: 1920, height: 1080, duration: 15, source: 'Wikimedia Commons', author: 'badadib', license: 'CC0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', sourceUrl: 'https://commons.wikimedia.org/wiki/File:X' },
    { id: 'wm2', type: 'image', category: 'city', title: 'Night skyline', tags: ['city', 'night'], file: 'images/wm2.jpg', thumb: 'thumbs/wm2.jpg' },
    { id: 'wm3', type: 'gif', category: 'nature', title: 'Clouds loop', tags: ['sky'], file: 'gifs/wm3.mp4' },
    { id: 'bad', type: 'audio', file: 'x.mp3' },
    { id: 'nofile', type: 'video' }
  ]
}

describe('library items', () => {
  it('absolute URLs next to the JSON, credit kept, unusable items dropped', async () => {
    const fake = async (url) => ({ ok: true, json: async () => (String(url).includes('a.json') ? LIB : { categories: [{ id: 'nature', label: 'X' }], items: [LIB.items[0]] }) })
    const d = await loadStockLibraries(['/stock/a.json', 'https://cdn.example/b.json'], fake, 'https://editor.example')
    expect(d.categories).toEqual([{ id: 'nature', label: 'Nature' }, { id: 'city', label: 'City' }])
    expect(d.items.map(i => i.id)).toEqual(['wm1', 'wm2', 'wm3'])
    const v = d.items[0]
    expect(v.url).toBe('https://editor.example/stock/videos/wm1.mp4')
    expect(v.previewUrl).toBe('https://editor.example/stock/previews/wm1.mp4')
    expect(v.credit).toMatchObject({ license: 'CC0', author: 'badadib', source: 'Wikimedia Commons' })
    // a photo without a thumbnail shows itself
    expect(normalizeStockItem({ id: 'p', type: 'image', file: 'p.jpg' }, 'https://e/stock/').thumbUrl).toBe('https://e/stock/p.jpg')
    expect(d.failed).toBe(false)
    const none = await loadStockLibraries(['/x.json'], async () => ({ ok: false }), 'https://e')
    expect(none.failed).toBe(true)
  })

  it('filters by kind, category and words (a search looks everywhere)', async () => {
    const { items } = await loadStockLibraries(['/s.json'], async () => ({ ok: true, json: async () => LIB }), 'https://e')
    expect(filterStock(items, { type: 'video' }).map(i => i.id)).toEqual(['wm1'])
    expect(filterStock(items, { category: 'nature' }).map(i => i.id)).toEqual(['wm1', 'wm3'])
    expect(filterStock(items, { category: 'nature', query: 'night' }).map(i => i.id)).toEqual(['wm2'])
    expect(filterStock(items, { query: 'ocean sea' }).map(i => i.id)).toEqual(['wm1'])
    expect(filterStock(items, { type: 'gif', query: 'sky' }).map(i => i.id)).toEqual(['wm3'])
    expect(stockDuration(7.4)).toBe('0:07')
    expect(stockDuration(null)).toBe('')
  })
})

describe('placing a pick', () => {
  let n = 0
  const newTrackId = () => `t${++n}`
  const clip = (id, len, extra = {}) => ({ id, type: 'video', startTime: 0, endTime: len, timelinePosition: 0, ...extra })
  const base = () => [
    { id: 'st', type: 'video', name: 'Stickers', stickers: true, clips: [] },
    { id: 'v', type: 'video', name: 'Video 1', clips: [clip('me', 10)] },
    { id: 'a', type: 'audio', name: 'Audio 1', clips: [] }
  ]

  it('an empty timeline: the main video track, at the playhead', () => {
    const tracks = [{ id: 'v', type: 'video', clips: [] }, { id: 'a', type: 'audio', clips: [] }]
    const r = placeStockClip(tracks, clip('s', 15), { at: 0, newTrackId })
    expect(r.tracks[0].clips.map(c => c.id)).toEqual(['s'])
    expect(r.tracks).toHaveLength(2)
  })

  it('over footage: a B-roll track above the footage, under the stickers, reused when it has room', () => {
    const r = placeStockClip(base(), clip('s', 4), { at: 2, newTrackId })
    expect(r.tracks.map(t => t.name)).toEqual(['Stickers', 'B-roll', 'Video 1', 'Audio 1'])
    expect(r.tracks[1]).toMatchObject({ stock: 'broll', type: 'video' })
    expect(r.clip.timelinePosition).toBe(2)
    const again = placeStockClip(r.tracks, clip('s2', 3), { at: 6, newTrackId })
    expect(again.tracks.filter(t => t.stock === 'broll')).toHaveLength(1)
    const overlap = placeStockClip(again.tracks, clip('s3', 3), { at: 3, newTrackId })
    expect(overlap.tracks.filter(t => t.stock === 'broll').map(t => t.name)).toEqual(['B-roll 2', 'B-roll'])
  })

  it('as a background: right below the keyed clip, same start, never longer', () => {
    const tracks = base()
    tracks[1].clips[0].timelinePosition = 3
    const r = placeStockClip(tracks, clip('bg', 30), { at: 0, underClipId: 'me', newTrackId })
    expect(r.tracks.map(t => t.name)).toEqual(['Stickers', 'Video 1', 'Background', 'Audio 1'])
    expect(r.clip).toMatchObject({ timelinePosition: 3, endTime: 10 })
    const short = placeStockClip(tracks, clip('bg2', 4), { at: 0, underClipId: 'me', newTrackId })
    expect(short.clip.endTime).toBe(4)
  })
})
