#!/usr/bin/env node
/**
 * Check the editor's interface translations in src/locales/.
 *
 *   npm run i18n:check             every problem fails
 *   npm run i18n:check -- --same   also list strings a language left identical to English
 *
 * English (src/locales/en) is the source of truth. Every other language must:
 *   - have the same files, valid JSON, string values only, nothing empty
 *   - have every English key, and no key English does not have
 *   - give a plural text exactly the forms its language uses (Intl.PluralRules:
 *     ru/uk/pl one, few, many, other; ja/zh/ko/th/vi/id other only, ...)
 *   - keep every {{placeholder}} and <tag> of the English text
 * And the code must use every English key (a string literal equal to the key, or a
 * template `area.prefix.${x}` that covers it) and every t('key') / tRich('key') in
 * src/ must exist in English. tests/i18n.test.js runs the same checks.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/
const FORMS = ['zero', 'one', 'two', 'few', 'many', 'other']
const baseKey = k => k.replace(PLURAL_SUFFIX, '')

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}

export const tokens = s => [
  ...[...String(s).matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map(m => `{{${m[1]}}}`),
  ...[...String(s).matchAll(/<\/?(\w+)\s*\/?>/g)].map(m => `<${m[1]}>`),
].sort()

function pluralCategories(code) {
  try { return new Intl.PluralRules(code).resolvedOptions().pluralCategories } catch { return ['one', 'other'] }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'locales') walk(p, out) } else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

export function checkLocales(root) {
  const LOCALES = path.join(root, 'src/locales')
  const SRC = path.join(root, 'src')
  const errors = []
  const same = []

  const readLang = code => {
    const dir = path.join(LOCALES, code)
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()
    const flat = {}
    for (const f of files) {
      let data
      try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch (e) { errors.push(`${code}/${f}: invalid JSON (${e.message})`); continue }
      Object.assign(flat, flatten(data, f.replace(/\.json$/, '')))
    }
    return { files, flat }
  }

  // languages.js and the folders agree
  const langSrc = fs.readFileSync(path.join(SRC, 'i18n/languages.js'), 'utf8')
  const declared = [...langSrc.matchAll(/code:\s*'([\w-]+)'/g)].map(m => m[1])
  const folders = fs.readdirSync(LOCALES).filter(n => fs.statSync(path.join(LOCALES, n)).isDirectory())
  for (const c of declared) if (!folders.includes(c)) errors.push(`languages.js lists '${c}' but src/locales/${c}/ does not exist`)
  for (const c of folders) if (!declared.includes(c)) errors.push(`src/locales/${c}/ is not listed in src/i18n/languages.js`)

  const { files: enFiles, flat: en } = readLang('en')
  const enPluralBases = new Set(Object.keys(en).filter(k => k.endsWith('_other')).map(baseKey))
  for (const [k, v] of Object.entries(en)) {
    if (typeof v !== 'string' || !v.trim()) errors.push(`en: ${k} must be a non-empty string`)
    const m = k.match(PLURAL_SUFFIX)
    if (m && !enPluralBases.has(baseKey(k))) errors.push(`en: ${k} has a plural form but no ${baseKey(k)}_other`)
    if (!m && enPluralBases.has(k)) errors.push(`en: ${k} is both a plain text and a plural`)
  }

  const report = []
  for (const code of folders.filter(c => c !== 'en' && declared.includes(c)).sort()) {
    const { files, flat: tr } = readLang(code)
    for (const f of enFiles) if (!files.includes(f)) errors.push(`${code}: ${f} is missing`)
    for (const f of files) if (!enFiles.includes(f)) errors.push(`${code}: ${f} does not exist in English`)
    const cats = pluralCategories(code)
    let missing = 0
    for (const [k, v] of Object.entries(tr)) {
      if (typeof v !== 'string' || !v.trim()) { errors.push(`${code}: ${k} must be a non-empty string`); continue }
      const m = k.match(PLURAL_SUFFIX)
      const b = baseKey(k)
      if (m && enPluralBases.has(b)) {
        if (!cats.includes(m[1]) && !(m[1] === 'zero' && `${b}_zero` in en)) errors.push(`${code}: ${k}: '${m[1]}' is not a plural form of this language (it uses ${cats.join(', ')})`)
      } else if (!(k in en)) {
        errors.push(`${code}: ${k} does not exist in English`)
        continue
      }
      const ref = m && enPluralBases.has(b) ? en[`${b}_other`] : en[k]
      // a plural form may leave out {{count}} ("one clip"), and may use any token of any English form
      const allowed = m ? [...new Set(FORMS.flatMap(c => (`${b}_${c}` in en ? tokens(en[`${b}_${c}`]) : [])))] : tokens(ref)
      const want = tokens(ref).filter(x => !(m && x === '{{count}}'))
      const have = tokens(v)
      const lost = want.filter(x => !have.includes(x))
      const extra = have.filter(x => !allowed.includes(x))
      if (lost.length) errors.push(`${code}: ${k} is missing ${lost.join(' ')} (English: "${ref}")`)
      if (extra.length) errors.push(`${code}: ${k} has unknown ${extra.join(' ')} (English: "${ref}")`)
      if (!m && v === ref && /[a-z]{3,}/.test(v)) same.push(`${code}: ${k} = "${v}"`)
    }
    for (const k of Object.keys(en)) {
      const m = k.match(PLURAL_SUFFIX)
      if (m) {
        if (m[1] !== 'other') continue
        const b = baseKey(k)
        const need = cats.filter(c => c !== 'zero').concat(`${b}_zero` in en ? ['zero'] : [])
        const lacking = need.filter(c => !(`${b}_${c}` in tr))
        if (lacking.length) { missing++; errors.push(`${code}: ${b} lacks plural form(s) ${lacking.join(', ')}`) }
        if (b in tr) errors.push(`${code}: ${b} is a plural in English, give its forms (${need.map(c => `${b}_${c}`).join(', ')})`)
      } else if (!(k in tr)) { missing++; errors.push(`${code}: ${k} is missing`) }
    }
    report.push({ code, missing })
  }

  // code against English: used keys exist, every key is used
  const areas = new Set(enFiles.map(f => f.replace(/\.json$/, '')))
  const sources = walk(SRC).map(f => [f, fs.readFileSync(f, 'utf8')])
  const literals = new Set()
  const prefixes = new Set()
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/['"`]([\w-]+(?:\.[\w-]+)+)['"`]/g)) if (areas.has(m[1].split('.')[0])) literals.add(m[1])
    for (const m of src.matchAll(/`([\w-]+(?:\.[\w-]+)*\.?)\$\{/g)) if (areas.has(m[1].split('.')[0])) prefixes.add(m[1])
    for (const m of src.matchAll(/(?<![\w.$])(?:t|tRich|i18nT)\(\s*['"`]([\w-]+(?:\.[\w-]+)+)['"`]/g)) {
      const key = m[1]
      if (!areas.has(key.split('.')[0])) continue
      if (!(key in en) && !enPluralBases.has(key)) {
        const line = src.slice(0, m.index).split('\n').length
        errors.push(`${path.relative(root, file)}:${line}: t('${key}') is not in src/locales/en`)
      }
    }
  }
  const unused = Object.keys(en).filter(k => {
    const b = baseKey(k)
    if (literals.has(k) || literals.has(b)) return false
    for (const p of prefixes) if (k.startsWith(p)) return false
    return true
  })
  for (const k of unused) errors.push(`en: ${k} is not used anywhere in src/ (remove it, or reference the key in full)`)

  return { errors, same, report, keys: Object.keys(en).length }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const { errors, same, report, keys } = checkLocales(root)
  console.log(`${keys} English strings, ${report.length} other languages`)
  for (const r of report) if (r.missing) console.log(`  ${r.code}: ${r.missing} missing`)
  if (process.argv.includes('--same') && same.length) console.log(`\nSame as English (${same.length}):\n  ${same.join('\n  ')}`)
  if (errors.length) {
    console.error(`\nErrors (${errors.length}):\n  ${errors.slice(0, 400).join('\n  ')}${errors.length > 400 ? `\n  ... and ${errors.length - 400} more` : ''}`)
    process.exit(1)
  }
  console.log('translations OK')
}
