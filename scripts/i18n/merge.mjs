#!/usr/bin/env node
/**
 * Merge filled-in translations (flat JSON files from `npm run i18n:todo`) into
 * src/locales/<code>/, in English's file and key order.
 *
 *   npm run i18n:merge -- --in /some/dir [--lang de,fr]
 *
 * Only keys English has are taken; a value still equal to the English text is
 * skipped unless --keep-same is given (brand words, "OK"). Run
 * `npm run i18n:check` afterwards.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, readFlat, writeLanguage, languageCodes, arg, baseKey } from './files.mjs'

const LOCALES = path.join(ROOT, 'src/locales')
const dir = arg('--in')
if (!dir) { console.error('usage: npm run i18n:merge -- --in <dir> [--lang de,fr]'); process.exit(1) }
const keepSame = process.argv.includes('--keep-same')
const langs = (arg('--lang')?.split(',') || languageCodes()).filter(c => c !== 'en')
const en = readFlat(LOCALES, 'en')
for (const code of langs) {
  const file = path.join(dir, `${code}.json`)
  if (!fs.existsSync(file)) continue
  const add = JSON.parse(fs.readFileSync(file, 'utf8'))
  const flat = readFlat(LOCALES, code)
  let n = 0
  for (const [k, v] of Object.entries(add)) {
    if (typeof v !== 'string' || !v.trim()) continue
    const ref = en[k] ?? en[`${baseKey(k)}_other`]
    if (ref === undefined) continue
    if (!keepSame && v === ref && /[a-z]{3,}/.test(v)) continue
    flat[k] = v
    n++
  }
  writeLanguage(LOCALES, code, flat)
  console.log(`${code}: ${n} merged`)
}
