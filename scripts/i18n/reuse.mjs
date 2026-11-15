#!/usr/bin/env node
/**
 * Reuse the 3Speak frontend's translations: an editor string whose English text is
 * exactly a string of the frontend (new-3speak-tv src/locales) gets that string's
 * translation, so both say "Render", "Short" or a teleprompter hint the same way
 * and nobody translates it twice. Only fills keys a language lacks.
 *
 *   npm run i18n:reuse -- --from ../new-3speak-tv [--lang de,fr] [--dry-run]
 */
import path from 'node:path'
import { ROOT, readFlat, writeLanguage, wantedKeys, baseKey, PLURAL_SUFFIX, languageCodes, arg } from './files.mjs'
import { tokens } from './check.mjs'

const from = arg('--from')
if (!from) { console.error('usage: npm run i18n:reuse -- --from <path to new-3speak-tv> [--lang de,fr] [--dry-run]'); process.exit(1) }
const DRY = process.argv.includes('--dry-run')
const LOCALES = path.join(ROOT, 'src/locales')
const FE = path.join(path.resolve(from), 'src/locales')
const langs = (arg('--lang')?.split(',') || languageCodes()).filter(c => c !== 'en')

const en = readFlat(LOCALES, 'en')
const feEn = readFlat(FE, 'en')
const byText = new Map() // English text -> frontend keys (plain)
const pluralByText = new Map() // "one|other" English texts -> frontend base keys
for (const [k, v] of Object.entries(feEn)) {
  if (typeof v !== 'string') continue
  if (PLURAL_SUFFIX.test(k)) {
    if (!k.endsWith('_other')) continue
    const b = baseKey(k)
    const id = `${feEn[`${b}_one`] ?? ''}|${v}`
    if (!pluralByText.has(id)) pluralByText.set(id, [])
    pluralByText.get(id).push(b)
  } else {
    if (!byText.has(v)) byText.set(v, [])
    byText.get(v).push(k)
  }
}
const sameTokens = (a, b) => tokens(a).join() === tokens(b).join()

for (const code of langs) {
  const fe = readFlat(FE, code)
  const tr = readFlat(LOCALES, code)
  let n = 0
  const done = new Set()
  for (const k of wantedKeys(en, code)) {
    if (k in tr) continue
    const m = k.match(PLURAL_SUFFIX)
    if (!m) {
      const hit = (byText.get(en[k]) || []).map(fk => fe[fk]).find(v => typeof v === 'string' && v.trim() && sameTokens(v, en[k]))
      if (hit) { tr[k] = hit; n++ }
      continue
    }
    const b = baseKey(k)
    if (done.has(b)) continue
    done.add(b)
    const id = `${en[`${b}_one`] ?? ''}|${en[`${b}_other`]}`
    const need = wantedKeys(en, code).filter(x => baseKey(x) === b)
    for (const fb of pluralByText.get(id) || []) {
      const forms = need.map(x => fe[`${fb}_${x.match(PLURAL_SUFFIX)[1]}`])
      if (forms.every(v => typeof v === 'string' && v.trim())) {
        need.forEach((x, i) => { if (!(x in tr)) { tr[x] = forms[i]; n++ } })
        break
      }
    }
  }
  if (!DRY) writeLanguage(LOCALES, code, tr)
  console.log(`${code}: ${n} reused from the frontend${DRY ? ' (dry run)' : ''}`)
}

