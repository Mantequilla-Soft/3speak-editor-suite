import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, Fragment } from 'react'
import { normalizeTextStroke, normalizeTextAnim, wordState, splitWords, animEnd, TEXT_ANIMS } from '../src/utils/textAnim'
import { measureWordLayout } from '../src/utils/textMeasure'
import { renderExtras } from '../src/utils/renderExtras'
import { TITLE_TEMPLATES, TITLE_GROUPS, titleClip, sceneDoc, sceneFields, sceneUpdate, sceneLength, templateOf } from '../src/utils/titleScenes'
import { AnimatedText, textStrokeStyle, animatedBoxStyle } from '../src/components/TextFx'
import { sceneTimeAt } from '../src/components/SceneLayer'

describe('text outline and word entrances', () => {
  it('normalises an outline: no width, no outline', () => {
    expect(normalizeTextStroke({ width: 0, color: '#fff' })).toBeNull()
    expect(normalizeTextStroke({ width: 99, color: 'red' })).toEqual({ color: '#000000', width: 12 })
    expect(textStrokeStyle({ textStroke: { width: 3, color: '#FF00AA' } })).toEqual({ WebkitTextStroke: '6px #ff00aa', paintOrder: 'stroke fill' })
    expect(textStrokeStyle({})).toEqual({})
  })

  it('normalises an entrance and staggers the words', () => {
    expect(TEXT_ANIMS.map(a => a.id)).toEqual(['pop', 'fadeUp', 'typewriter', 'slide'])
    expect(normalizeTextAnim({ type: 'bounce' })).toBeNull()
    expect(normalizeTextAnim({ type: 'pop' })).toEqual({ type: 'pop', stagger: 0.12, duration: 0.35 })
    expect(normalizeTextAnim({ type: 'typewriter', duration: 1 }).duration).toBe(0)
    const a = { type: 'fadeUp', stagger: 0.2, duration: 0.4 }
    expect(wordState(a, 2, 0.39).opacity).toBe(0)
    expect(wordState(a, 2, 0.6).opacity).toBeCloseTo(0.5)
    expect(wordState(a, 2, 0.6).dy).toBeGreaterThan(0)
    expect(wordState(a, 2, 2)).toEqual({ opacity: 1, dx: 0, dy: 0, scale: 1 })
    expect(wordState({ type: 'pop', stagger: 0.1, duration: 0.5 }, 0, 0.3).scale).toBeCloseTo(1.12)
    expect(wordState({ type: 'slide' }, 0, 0).dx).toBeCloseTo(-0.6)
    expect(wordState(null, 0, 0)).toEqual({ opacity: 1, dx: 0, dy: 0, scale: 1 })
    expect(animEnd(a, 3)).toBeCloseTo(0.8)
    expect(splitWords('  Hello\n badadib  fans ')).toEqual(['Hello', 'badadib', 'fans'])
  })

  it('the preview draws one span per word over a hidden copy of the text', () => {
    const registry = {}
    const clip = { id: 'c1', text: 'Hi  there\nyou', textAnim: { type: 'typewriter', stagger: 0.5 } }
    const html = renderToStaticMarkup(createElement(Fragment, null, AnimatedText({ clip, time: 10.6, start: 10, registry })))
    expect(html).toContain('<span style="visibility:hidden">Hi  there\nyou</span>')
    expect(html.match(/data-word="c1:\d"/g)).toEqual(['data-word="c1:0"', 'data-word="c1:1"', 'data-word="c1:2"'])
    expect(html).toMatch(/data-word="c1:2" style="display:inline-block;opacity:0"/)
    expect(html).toMatch(/data-word="c1:1" style="display:inline-block;opacity:1"/)
    expect(registry.c1.start).toBe(10)
    expect(AnimatedText({ clip: { id: 'p', text: 'plain' }, time: 0, start: 0, registry })).toBe('plain')
    expect(animatedBoxStyle(clip)).toEqual({ position: 'relative', display: 'inline-block' })
  })

  it('measures where each word of each line sits (for the render)', () => {
    const rects = { Hello: [0, 40], badadib: [46, 60], fans: [0, 30] }
    const doc = {
      createTextNode: (t) => ({ t }),
      createElement: () => {
        const el = { style: {}, kids: [], textContent: '', appendChild(k) { this.kids.push(k) } }
        el.getBoundingClientRect = () => {
          if (el.kids.length) return { left: 100, width: el.kids.filter(k => k.textContent).reduce((m, k) => Math.max(m, rects[k.textContent][0] + rects[k.textContent][1]), 0) }
          const r = rects[el.textContent] || [0, 0]
          return { left: 100 + r[0], width: r[1] }
        }
        Object.defineProperty(el, 'textContent', { get() { return this._t || '' }, set(v) { this._t = v; if (v === '') this.kids = [] } })
        return el
      },
      body: { appendChild() {}, removeChild() {} }
    }
    expect(measureWordLayout({ wrappedLines: ['Hello badadib', 'fans'], fontSize: 30 }, doc)).toEqual({
      lines: [{ width: 106, words: [{ x: 0, w: 40 }, { x: 46, w: 60 }] }, { width: 30, words: [{ x: 0, w: 30 }] }]
    })
    expect(measureWordLayout({ wrappedLines: [] }, doc)).toBeNull()
  })

  it('outline and entrance go to the render with a text clip', () => {
    expect(renderExtras({ type: 'text', textStroke: { width: 2, color: '#000000' }, textAnim: { type: 'slide' } })).toEqual({
      textStroke: { color: '#000000', width: 2 }, textAnim: { type: 'slide', stagger: 0.12, duration: 0.35 }
    })
  })
})

describe('titles from motion scenes', () => {
  it('offers lower thirds, titles and cards, each a known scene type', () => {
    const vm = readFileSync(new URL('../public/scenes/lib/scene-meta.js', import.meta.url), 'utf8')
    for (const t of TITLE_TEMPLATES) {
      expect(TITLE_GROUPS.some(g => g.id === t.group)).toBe(true)
      expect(vm).toContain(`${t.type}: {`)
    }
    expect(TITLE_TEMPLATES.filter(t => t.group === 'lower').length).toBeGreaterThanOrEqual(2)
  })

  it('a lower third comes in smaller, low on the left, over the video', () => {
    const c = titleClip('lower-name', { previewH: 640 })
    expect(c).toMatchObject({ type: 'scene', transparent: true, zoom: 60, startTime: 0, endTime: 4 })
    expect(c.positionX).toBeLessThan(0)
    expect(c.positionY).toBeGreaterThan(0)
    expect(titleClip('card-end')).toMatchObject({ transparent: false, zoom: 100, positionX: 0 })
    expect(titleClip('nope')).toBeNull()
  })

  it('builds the engine doc: one scene, the output size, colours and font', () => {
    const c = { ...titleClip('title-words', { values: { words: 'Plan.\n\nFilm.\n', line: '  ' }, colors: 'Ocean', font: 'Anton' }) }
    const d = sceneDoc(c, { width: 1080, height: 1920 })
    expect(d).toMatchObject({ width: 1080, height: 1920, fps: 30, transition: 0 })
    expect(d.scenes).toEqual([{ type: 'words', duration: 2.8, label: '', words: ['Plan.', 'Film.'] }])
    expect(d.brand.font).toBe('Anton')
    expect(d.brand.fonts[0]).toMatch(/^Anton:wght@/)
    expect(d.brand.colors.accent).toBe('#2fb6ff')
    expect(sceneFields(templateOf('card-end'), { brand: 'badadib', footer: '' })).toEqual({ brand: 'badadib' })
  })

  it('editing a title keeps the rest, and a new length moves its end', () => {
    const c = titleClip('title-kinetic')
    const u = sceneUpdate(c, { fields: { line: 'Hi' }, sceneStyle: { font: 'Caveat' } })
    expect(u.scene.fields).toMatchObject({ words: ['Fast', 'Simple', 'Yours'], line: 'Hi' })
    expect(u.sceneStyle).toEqual({ colors: 'Ember', font: 'Caveat' })
    const longer = sceneUpdate(c, { scene: { duration: 20 } })
    expect(longer).toMatchObject({ endTime: 8, duration: 8 })
    expect(sceneLength({ scene: { duration: 0.2 } })).toBe(1.5)
  })

  it('the preview shows the scene time of the playhead, held at the ends', () => {
    const c = { ...titleClip('title-words'), timelineStart: 5 }
    expect(sceneTimeAt(c, 6)).toBe(1)
    expect(sceneTimeAt(c, 2)).toBe(0)
    expect(sceneTimeAt(c, 99)).toBe(2.8)
  })

  it('a title goes to the render with its doc', () => {
    const c = { ...titleClip('lower-statement'), id: 'x' }
    const out = renderExtras(c, { frame: { width: 720, height: 1280 } })
    expect(out.transparent).toBe(true)
    expect(out.sceneDoc).toMatchObject({ width: 720, height: 1280 })
    expect(out.sceneDoc.scenes[0].type).toBe('statement')
  })

  it('the preview and the render share the text animation file', () => {
    const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    expect(read('backend/src/utils/textAnim.js')).toBe(read('src/utils/textAnim.js'))
  })
})
