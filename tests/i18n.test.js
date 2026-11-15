import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { t, tRich, setLanguage, getLanguage, matchLanguage, initialLanguage, formatNumber, languageName, __setDictionary, LANGUAGE_CODES } from '../src/i18n'
import { limitText } from '../src/utils/limits'
import { checkLocales } from '../scripts/i18n/check.mjs'

afterEach(async () => { await setLanguage('en') })

describe('i18n: language choice', () => {
  it('matches browser tags to the languages we ship', () => {
    expect(matchLanguage('de-AT')).toBe('de')
    expect(matchLanguage('pt_BR')).toBe('pt')
    expect(matchLanguage('zh-Hans-CN')).toBe('zh')
    expect(matchLanguage('tl')).toBe('fil')
    expect(matchLanguage('FIL')).toBe('fil')
    expect(matchLanguage('ar')).toBe(null)
    expect(matchLanguage('')).toBe(null)
    expect(matchLanguage(undefined)).toBe(null)
  })
  it('?lang= first, then the browser, then English', () => {
    expect(initialLanguage('?compact=true&lang=de', { languages: ['fr-FR'] })).toBe('de')
    expect(initialLanguage('?lang=xx', { languages: ['ar', 'fr-FR'] })).toBe('fr')
    expect(initialLanguage('', { language: 'ja-JP' })).toBe('ja')
    expect(initialLanguage('', { languages: ['ar'] })).toBe('en')
    expect(initialLanguage('', null)).toBe('en')
  })
  it('ships the 21 languages of the 3Speak frontend', () => {
    expect(LANGUAGE_CODES).toHaveLength(21)
    expect([...LANGUAGE_CODES].sort()).toEqual(['bn', 'de', 'en', 'es', 'fil', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'sw', 'th', 'tr', 'uk', 'vi', 'zh'])
  })
})

describe('i18n: t()', () => {
  it('fills placeholders and picks English plural forms', () => {
    expect(t('notices.length.title', { length: '2:30' })).toBe('Your timeline is 2:30 long')
    expect(t('notices.tooLarge.title', { count: 1 })).toBe('This file is too big')
    expect(t('notices.tooLarge.title', { count: 3 })).toBe('These files are too big')
    expect(limitText(60)).toBe('1 minute')
    expect(limitText(90)).toBe('90 seconds')
  })
  it('an unknown key shows the key, never throws', () => {
    expect(t('nothing.here')).toBe('nothing.here')
  })
  it('uses the plural rules of the language (Russian one/few/many)', async () => {
    __setDictionary('ru', { 'x.clips_one': '{{count}} клип', 'x.clips_few': '{{count}} клипа', 'x.clips_many': '{{count}} клипов', 'x.clips_other': '{{count}} клипа' })
    await setLanguage('ru')
    expect(getLanguage()).toBe('ru')
    expect(t('x.clips', { count: 1 })).toBe('1 клип')
    expect(t('x.clips', { count: 3 })).toBe('3 клипа')
    expect(t('x.clips', { count: 5 })).toBe('5 клипов')
    expect(t('x.clips', { count: 21 })).toBe('21 клип')
    // a key the language lacks falls back to English
    expect(t('notices.tooLarge.title', { count: 2 })).toBe('These files are too big')
  })
  it('numbers follow the language', async () => {
    expect(formatNumber(2.5)).toBe('2.5')
    __setDictionary('de', {})
    await setLanguage('de')
    expect(formatNumber(2.5)).toBe('2,5')
    expect(formatNumber(2026)).toBe('2026')
    expect(languageName('fr')).toBe('Französisch')
  })
})

describe('i18n: tRich', () => {
  it('maps tags to React elements', async () => {
    __setDictionary('nl', { 'x.rich': 'Druk op <kbd>Spatie</kbd> om af te spelen<br/>nu' })
    await setLanguage('nl')
    const html = renderToStaticMarkup(createElement('p', null, tRich('x.rich', null, { kbd: createElement('kbd', { className: 'k' }), br: createElement('br') })))
    expect(html).toBe('<p>Druk op <kbd class="k">Spatie</kbd> om af te spelen<br/>nu</p>')
  })
})

describe('i18n: the locale files', () => {
  it('every language has every key, the same placeholders and its own plural forms; every key is used', () => {
    const { errors } = checkLocales(path.resolve(__dirname, '..'))
    expect(errors).toEqual([])
  })
})

describe('i18n: the Ad Wizard scene engine texts', () => {
  it('every description, label, hint, look and check message of the vendored engine has a key', async () => {
    const fs = await import('node:fs')
    const vm = await import('node:vm')
    const ctx = { self: {} }
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/scenes/lib/scene-meta.js'), 'utf8'), ctx)
    const M = ctx.self.SceneMeta
    const { slug, sceneDesc, fieldLabel, fieldHint, styleName, issueText } = await import('../src/adwizard/sceneText.js')
    const { hasKey } = await import('../src/i18n')
    const missing = []
    const walk = fields => { for (const f of fields || []) {
      if (f.label ? !hasKey(`scenes.label.${slug(f.label)}`) : !hasKey(`scenes.field.${f.k}`)) missing.push(`field ${f.k} ${f.label || ''}`)
      if (f.hint && /[a-z]{3,}/i.test(f.hint) && !/^[a-z]{2}-[A-Z]{2}$/.test(f.hint) && !hasKey(`scenes.hint.${slug(f.hint)}`)) missing.push(`hint ${f.hint}`)
      walk(f.of)
    } }
    for (const [type, m] of Object.entries(M.TYPES)) { if (!hasKey(`scenes.desc.${type}`)) missing.push(`desc ${type}`); walk(m.fields) }
    for (const k of Object.keys(M.STYLES)) if (!hasKey(`scenes.styles.${k}`)) missing.push(`style ${k}`)
    expect(missing).toEqual([])
    // English reads as the engine wrote it
    expect(sceneDesc({ type: 'words', desc: 'x' })).toBe(M.TYPES.words.desc)
    expect(fieldLabel({ k: 'cta', label: 'Call to action' })).toBe('Call to action')
    expect(fieldHint({ k: 'cta', hint: 'e.g. your URL' })).toBe('e.g. your URL')
    expect(styleName('images', 'Pictures')).toBe('Pictures')
    // check messages become sentences; an unknown one passes through
    const doc = { scenes: [{ type: 'nope', duration: 1 }] }
    const issues = M.validate(doc)
    expect(issues.length).toBeGreaterThan(0)
    for (const x of issues) expect(issueText(x.msg)).not.toMatch(/scenes\.issue/)
    expect(issueText('needs at least 2')).toBe('needs at least 2')
    expect(issueText('long text (max 40)')).toBe('long text (max 40)')
    expect(issueText('something new')).toBe('something new')
  })
})

describe('i18n: pieces of a cut clip', () => {
  it('names them in the interface language and strips the name again', async () => {
    const { partName, stripPart } = await import('../src/utils/partName.js')
    expect(partName(2, 'talk.wav')).toBe('Part 2 · talk.wav')
    expect(stripPart('Part 12 · talk.wav')).toBe('talk.wav')
    expect(stripPart('talk.wav')).toBe('talk.wav')
    __setDictionary('de', { 'timeline.partName': 'Teil {{n}} · {{name}}' })
    await setLanguage('de')
    expect(partName(3, 'talk.wav')).toBe('Teil 3 · talk.wav')
    expect(stripPart('Teil 3 · talk.wav')).toBe('talk.wav')
    expect(stripPart('Part 3 · talk.wav')).toBe('talk.wav')
    __setDictionary('ja', { 'timeline.partName': '{{name}}(パート{{n}})' })
    await setLanguage('ja')
    expect(stripPart('talk.wav(パート4)')).toBe('talk.wav')
  })
})
