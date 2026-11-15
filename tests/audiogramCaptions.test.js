// Captions on audiograms (frontend side): the shared module is the same file
// the render uses, the piece's words come from the episode's transcript in the
// piece's own seconds, and the studio draws the captions part in its box.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanAudiogramCaptionLook, captionBox, audiogramCaptionEvents, pieceCaptions } from '../src/utils/audiogramCaptions'
import { pieceWords, missingOf } from '../src/hooks/useAudiogramCaptions'
import { addChunk } from '../src/utils/transcript'
import { AudiogramCaptionsLayer, AudiogramCaptionsField } from '../src/components/AudiogramCaptions'

const SIZE = { w: 1080, h: 1920 }
const layers = {
  logo: { x: 340, y: 236, w: 400, h: 80, z: 20, on: true },
  wave: { x: 90, y: 1120, w: 900, h: 360, z: 2, on: true }
}

describe('captions on audiograms', () => {
  it('the preview and the render run the same code', () => {
    for (const f of ['audiogramCaptions.js', 'captions.js']) {
      expect(fs.readFileSync(`src/utils/${f}`, 'utf8')).toBe(fs.readFileSync(`backend/src/utils/${f}`, 'utf8'))
    }
  })

  it('the piece\'s words from the episode transcript, in the piece\'s seconds; what is still missing', () => {
    const t = addChunk(null, { source: 'episode', from: 50, to: 70, words: [{ text: 'before', start: 49.5, end: 49.9 }, { text: 'Hello', start: 60.2, end: 60.6 }, { text: 'badadib', start: 60.7, end: 61.2 }, { text: 'after', start: 75, end: 75.4 }] })
    const piece = { start: 60, end: 90 }
    expect(pieceWords(t, piece)).toEqual([{ text: 'Hello', start: 0.2, end: 0.6 }, { text: 'badadib', start: 0.7, end: 1.2 }, { text: 'after', start: 15, end: 15.4 }])
    expect(missingOf(t, piece)).toEqual([[70, 90]])
    expect(missingOf(null, piece)).toEqual([[60, 90]])
  })

  it('the studio draws the captions in their box, a sample until the words are there', () => {
    const look = cleanAudiogramCaptionLook({ on: true })
    const box = captionBox(look, 'vertical', SIZE, layers)
    const sample = renderToStaticMarkup(createElement(AudiogramCaptionsLayer, { look, box, size: SIZE, scale: 0.25, words: [], selected: true, onSelect: () => {}, onBox: () => {} }))
    expect(sample).toContain('data-layer="captions"')
    expect(sample).toContain('YOUR')
    expect(sample).toContain(`left:${box.x * 0.25}px`)
    expect(sample).toContain('data-edge="e"')
    const words = [{ text: 'Hive', start: 0, end: 0.4 }, { text: 'rocks', start: 0.5, end: 0.9 }]
    const real = renderToStaticMarkup(createElement(AudiogramCaptionsLayer, { look, box, size: SIZE, scale: 0.25, words, selected: false, onSelect: () => {}, onBox: () => {} }))
    expect(real).toContain('HIVE')
    expect(real).not.toContain('data-edge')
    expect(audiogramCaptionEvents(pieceCaptions(words, 5), look, box, SIZE).length).toBe(2)
  })

  it('the Captions field: off until switched on; the look once it is on', () => {
    const ag = { status: { available: true }, job: null, words: [], ready: false, pieceKey: '0-30', transcribe: () => {}, cancel: () => {}, setWordText: () => {} }
    const off = renderToStaticMarkup(createElement(AudiogramCaptionsField, { look: cleanAudiogramCaptionLook({}), onChange: () => {}, ag }))
    expect(off).toContain('Show what is said')
    expect(off).not.toContain('Karaoke')
    const on = renderToStaticMarkup(createElement(AudiogramCaptionsField, { look: cleanAudiogramCaptionLook({ on: true }), onChange: () => {}, ag: { ...ag, ready: true, words: [{ text: 'a', start: 0, end: 1 }] } }))
    expect(on).toContain('Karaoke')
    expect(on).toContain('1 words in this piece')
    const none = renderToStaticMarkup(createElement(AudiogramCaptionsField, { look: cleanAudiogramCaptionLook({}), onChange: () => {}, ag: { ...ag, status: { available: false } } }))
    expect(none).toContain('not available')
  })
})
