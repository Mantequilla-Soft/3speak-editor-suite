import { describe, it, expect } from 'vitest'
import { podcastEpisodeOf, episodeCovers } from '../src/utils/podcastEpisode'

// The audio page's "Video podcast": open-video-podcast { url, title, cover, durationSec }
describe('a published episode for the video podcast', () => {
  it('takes an https episode with its title, cover and length', () => {
    expect(podcastEpisodeOf({ url: 'https://audio.3speak.tv/a.mp3', title: ' My\nshow ', cover: 'https://img.test/c.jpg', durationSec: 1834.5 }))
      .toEqual({ url: 'https://audio.3speak.tv/a.mp3', title: 'My show', cover: 'https://img.test/c.jpg', durationSec: 1834.5 })
  })

  it('without a length or cover it reads them as missing', () => {
    expect(podcastEpisodeOf({ url: 'https://audio.3speak.tv/a.mp3', cover: 'http://img.test/c.jpg', durationSec: 'x' }))
      .toEqual({ url: 'https://audio.3speak.tv/a.mp3', title: '', cover: null, durationSec: null })
  })

  it('refuses anything that is not an https url', () => {
    for (const raw of [null, [], {}, { url: 'http://a.test/a.mp3' }, { url: 'blob:https://a' }, { url: 'https://a .mp3' }]) {
      expect(podcastEpisodeOf(raw)).toBeNull()
    }
  })

  it('offers the episode cover first, then the playlist covers without repeating it', () => {
    const ep = { title: 'Ep 1', cover: 'https://img.test/c.jpg' }
    const lists = [{ title: 'Show', url: 'https://img.test/c.jpg' }, { title: 'Other', url: 'https://img.test/o.jpg' }]
    expect(episodeCovers(ep, lists)).toEqual([{ title: 'Ep 1', url: 'https://img.test/c.jpg' }, { title: 'Other', url: 'https://img.test/o.jpg' }])
    expect(episodeCovers({ cover: null }, lists)).toBe(lists)
    expect(episodeCovers(ep, null)).toEqual([{ title: 'Ep 1', url: 'https://img.test/c.jpg' }])
  })
})
