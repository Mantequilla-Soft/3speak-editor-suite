// The editor in German with ?lang=de, from the real locale files (lazy chunk, like in the browser).
import { describe, it, expect, afterAll } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { setLanguage, initialLanguage, getLanguage, t } from '../src/i18n'
import LengthLimitNotice from '../src/components/LengthLimitNotice'
import TooLargeNotice from '../src/components/TooLargeNotice'
import { limitText } from '../src/utils/limits'
import { partName } from '../src/utils/partName'

const de = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/locales/de/notices.json'), 'utf8'))
const deCommon = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/locales/de/common.json'), 'utf8'))

afterAll(() => setLanguage('en'))

describe('the editor in German (?lang=de)', () => {
  it('loads German and renders the notices in it', async () => {
    expect(await setLanguage(initialLanguage('?compact=true&lang=de', null))).toBe('de')
    expect(getLanguage()).toBe('de')
    const html = renderToStaticMarkup(createElement(LengthLimitNotice, { length: 150, onClose: () => {} }))
    expect(html).toContain(de.length.title.replace('{{length}}', '2:30'))
    expect(html).toContain(deCommon.gotIt)
    expect(html).not.toContain('Your timeline is')
    const big = renderToStaticMarkup(createElement(TooLargeNotice, { files: [{ name: 'a.mp4', size: 3 * 1024 ** 3 }, { name: 'b.mp4', size: 3 * 1024 ** 3 }], onClose: () => {} }))
    expect(big).toContain(de.tooLarge.title_other)
    expect(big).toContain('3 GB')
    expect(big).toContain('2 GB')
  })
  it('plurals, numbers and names follow German', async () => {
    await setLanguage('de')
    expect(limitText(60)).toBe(deCommon.duration.minutes_one.replace('{{count}}', '1'))
    expect(limitText(120)).toBe(deCommon.duration.minutes_other.replace('{{count}}', '2'))
    expect(t('notices.encoding.waiting', { count: 2 })).toBe(de.encoding.waiting_other.replace('{{count}}', '2'))
    expect(partName(2, 'take.wav')).not.toMatch(/^Part /)
  })
})
