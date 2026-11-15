#!/usr/bin/env node
/**
 * What is left to translate, as one flat JSON file per language to fill in.
 *
 *   npm run i18n:todo -- --out /some/dir [--lang de,fr]
 *
 * Writes <out>/<code>.json: { "area.key": "English text", ... } for every key the
 * language lacks, with a plural text listed as the forms THAT language needs
 * (Russian: key_one, key_few, key_many, key_other, each showing the English
 * _one or _other text). Replace the English values with the translation (keep
 * every {{placeholder}} and <tag>), then `npm run i18n:merge -- --in <out>`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, readFlat, wantedKeys, baseKey, PLURAL_SUFFIX, languageCodes, arg } from './files.mjs'

const LOCALES = path.join(ROOT, 'src/locales')
const out = arg('--out')
if (!out) { console.error('usage: npm run i18n:todo -- --out <dir> [--lang de,fr]'); process.exit(1) }
const langs = (arg('--lang')?.split(',') || languageCodes()).filter(c => c !== 'en')
const en = readFlat(LOCALES, 'en')
fs.mkdirSync(out, { recursive: true })
for (const code of langs) {
  const tr = readFlat(LOCALES, code)
  const todo = {}
  for (const k of wantedKeys(en, code)) {
    if (k in tr) continue
    const m = k.match(PLURAL_SUFFIX)
    todo[k] = m ? (en[k] ?? (m[1] === 'one' ? en[`${baseKey(k)}_one`] : en[`${baseKey(k)}_other`]) ?? en[`${baseKey(k)}_other`]) : en[k]
  }
  fs.writeFileSync(path.join(out, `${code}.json`), `${JSON.stringify(todo, null, 2)}\n`)
  console.log(`${code}: ${Object.keys(todo).length} to translate`)
}
