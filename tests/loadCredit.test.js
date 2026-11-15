import { describe, it, expect } from 'vitest'
import { loadCreditOf, isMusicLoad } from '../src/utils/loadCredit'

// 3Speak's "Use this sound": load-media { mediaType: 'audio', music: true, credit }
describe('a sound loaded by 3Speak (load-media music + credit)', () => {
  const credit = { id: 'short_badadib_beat-1', title: 'My beat', artist: '@badadib', source: '3speak', account: 'badadib', sourceUrl: 'https://3speak.tv/sound/short_badadib_beat-1' }

  it('keeps a credit with a string id and title, plain strings only', () => {
    expect(loadCreditOf(credit)).toEqual({
      id: 'short_badadib_beat-1', title: 'My beat', artist: '@badadib', source: '3speak', sourceUrl: 'https://3speak.tv/sound/short_badadib_beat-1',
      license: null, licenseUrl: null, text: null, account: 'badadib'
    })
    expect(loadCreditOf({ ...credit, title: ' Two\nlines ', account: '@BADADIB' })).toMatchObject({ title: 'Two lines', account: 'badadib' })
    expect(loadCreditOf({ ...credit, artist: { evil: 1 }, account: 'not an account!' })).toMatchObject({ artist: null, account: null })
    expect(loadCreditOf({ ...credit, title: 'x'.repeat(500) }).title).toHaveLength(100)
  })

  it('refuses anything without a usable id and title', () => {
    for (const bad of [null, 'credit', [credit], {}, { ...credit, id: 7 }, { ...credit, title: '  ' }, { ...credit, id: { toString: 1 } }]) {
      expect(loadCreditOf(bad)).toBeNull()
    }
  })

  it('only an audio URL marked music goes on the music track', () => {
    const msg = { type: 'load-media', url: 'https://play.test/a.m3u8', mediaType: 'audio', music: true, credit }
    expect(isMusicLoad(msg, null)).toBe(true)
    expect(isMusicLoad({ ...msg, music: 'yes' }, null)).toBe(false)
    expect(isMusicLoad({ ...msg, mediaType: 'video' }, null)).toBe(false)
    expect(isMusicLoad(msg, new Blob(['x']))).toBe(false)
    expect(isMusicLoad({ ...msg, url: undefined }, null)).toBe(false)
  })
})
