import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as C from '../src/utils/captions'
import { voiceTracksOf, emojiUrl, emojiUrlsOf } from '../src/utils/captionSources'
import CaptionsOverlay from '../src/components/CaptionsOverlay'

const { serializeProject } = await import('../src/hooks/useDrafts')

const FRAME = { width: 1080, height: 1920 }
const words = [
  { text: 'Hello', start: 0, end: 0.4 },
  { text: 'badadib', start: 0.4, end: 0.9 },
  { text: 'fans.', start: 0.9, end: 1.3 },
  { text: 'This', start: 2.6, end: 3 },
  { text: 'is', start: 3, end: 3.3 },
  { text: 'fire', start: 3.6, end: 4.1 }
]
const caps = (style = {}, extra = {}) => ({ words, language: 'en', style, ...extra })

describe('auto captions, shared with the render', () => {
  it('the preview and the backend run the same captions code', () => {
    expect(fs.readFileSync('backend/src/utils/captions.js', 'utf8')).toBe(fs.readFileSync('src/utils/captions.js', 'utf8'))
  })

  it('every caption font is loaded by the editor and installed in the backend image', () => {
    const html = fs.readFileSync('index.html', 'utf8')
    const docker = fs.readFileSync('backend/Dockerfile', 'utf8')
    for (const font of Object.keys(C.CAPTION_FONTS)) {
      expect(html, font).toContain(`family=${font.replace(/ /g, '+')}`)
      expect(docker, font).toContain(`ofl/${font.toLowerCase().replace(/ /g, '')}`)
    }
  })

  it('style variants: karaoke highlights the spoken word, pop shows one word, plain whole lines', () => {
    const k = C.captionEvents(caps({ preset: 'karaoke' }), FRAME)
    expect(C.captionAt(k, 0.5).lines.flat().map(w => [w.text, w.active])).toEqual([['HELLO', false], ['BADADIB', true], ['FANS.', false]])
    const p = C.captionEvents(caps({ preset: 'pop', uppercase: false }), FRAME)
    expect(C.captionAt(p, 0.5).lines.flat().map(w => w.text)).toEqual(['badadib'])
    expect(C.captionAt(p, 0.5).pop).toBe(true)
    const plain = C.captionEvents(caps({ preset: 'plain', uppercase: false }), FRAME)
    expect(plain.map(e => e.lines.flat().map(w => w.text).join(' '))).toEqual(['Hello badadib fans.', 'This is fire'])
  })
})

describe('the captions overlay on the preview canvas', () => {
  const html = (captions, time) => renderToStaticMarkup(createElement(CaptionsOverlay, { captions, time }))

  it('shows the page at the playhead with the active word in the highlight colour', () => {
    const out = html(caps({ preset: 'karaoke', highlight: '#e53935', y: 70, size: 5, font: 'Anton' }), 0.5)
    expect(out).toContain('HELLO')
    expect(out).toContain('<span style="color:#e53935"> BADADIB</span>')
    expect(out).toContain('top:70%')
    expect(out).toContain('font-size:5cqh')
    expect(out).toContain("font-family:&#x27;Anton&#x27;, sans-serif")
    // the line height is the burn-in's (libass) line height for that font
    expect(out).toContain(`line-height:${C.CAPTION_FONTS.Anton.line}`)
  })

  it('nothing in a pause, nothing when the captions are not burnt in', () => {
    expect(html(caps(), 2)).toBe('')
    expect(html(caps({}, { burn: false }), 0.5)).toBe('')
    expect(html(null, 0.5)).toBe('')
  })

  it('emoji accents sit above the text, from the sticker library', () => {
    const out = html({ ...caps({ emoji: true }), words: C.suggestEmojis(words) }, 3.7)
    expect(out).toContain(emojiUrl('1f525'))
    const L = C.captionLayout(C.normalizeCaptionStyle({ emoji: true }), FRAME, 1)
    expect(out).toContain(`top:${(L.emoji.y / 1920) * 100}%`)
  })
})

describe('what captions listen to', () => {
  it('voice tracks and video clips with their sound on; no music, sound effects or muted tracks', () => {
    const tracks = [
      { id: 'v1', type: 'video', clips: [{ id: 'a', type: 'video', audioEnabled: false }, { id: 'b', type: 'video', audioEnabled: true }, { id: 't', type: 'text' }] },
      { id: 'au', type: 'audio', clips: [{ id: 'c', type: 'audio' }, { id: 'off', type: 'audio', audioEnabled: false }] },
      { id: 'mu', type: 'audio', music: true, clips: [{ id: 'm', type: 'audio' }] },
      { id: 'fx', type: 'audio', sfx: true, clips: [{ id: 's', type: 'audio' }] },
      { id: 'mt', type: 'audio', muted: true, clips: [{ id: 'x', type: 'audio' }] },
      { id: 'empty', type: 'audio', clips: [] }
    ]
    const v = voiceTracksOf(tracks)
    expect(v.map(t => [t.id, t.clips.map(c => c.id)])).toEqual([['au', ['c']], ['captions-video-sound', ['b']]])
    expect(v[1].clips[0].type).toBe('audio')
  })

  it('emoji pictures come from the sticker library as absolute URLs', () => {
    expect(emojiUrl('1f525', 'https://editor.example')).toBe('https://editor.example/stickers/emoji/1f525.png')
    expect(emojiUrlsOf([{ emoji: '2764' }, { emoji: '' }, {}], 'https://e.example')).toEqual({ 2764: 'https://e.example/stickers/emoji/2764.png' })
  })
})

describe('drafts keep the captions', () => {
  const tracks = [{ id: 'v', type: 'video', clips: [{ id: 'c', type: 'video', url: 'https://editor.example/api/upload/files/x.mp4', startTime: 0, endTime: 5 }] }]
  it('words, style and the burn-in switch are saved with a Shorts draft', () => {
    const { state } = serializeProject(tracks, [], new Map(), { captions: caps({ preset: 'pop', size: 50 }, { burn: false }) })
    expect(state.captions.words).toHaveLength(6)
    expect(state.captions.style.preset).toBe('pop')
    expect(state.captions.style.size).toBe(9)
    expect(state.captions.burn).toBe(false)
  })
  it('no captions (or an audio draft): nothing saved', () => {
    expect(serializeProject(tracks, [], new Map(), {}).state.captions).toBeUndefined()
    expect(serializeProject(tracks, [], new Map(), { mode: 'audio', captions: caps() }).state.captions).toBeUndefined()
  })
})
