// Shared by the i18n scripts: read a language as flat keys, write it back as the
// nested per-area files in English's order (so diffs stay small and reviewable).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/
export const FORMS = ['zero', 'one', 'two', 'few', 'many', 'other']
export const baseKey = k => k.replace(PLURAL_SUFFIX, '')

export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}

/** All strings of a language under `localesDir/<code>/*.json`, flat: { 'area.a.b': '...' }. */
export function readFlat(localesDir, code) {
  const dir = path.join(localesDir, code)
  const out = {}
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    Object.assign(out, flatten(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), f.replace(/\.json$/, '')))
  }
  return out
}

export function pluralCategories(code) {
  try { return new Intl.PluralRules(code).resolvedOptions().pluralCategories } catch { return ['one', 'other'] }
}

/**
 * The keys `code` needs, in English's order: plain keys as in English, a plural
 * group as the forms of THIS language (ru: _one _few _many _other).
 */
export function wantedKeys(en, code) {
  const cats = pluralCategories(code).filter(c => c !== 'zero')
  const out = []
  const seen = new Set()
  for (const k of Object.keys(en)) {
    if (!PLURAL_SUFFIX.test(k)) { out.push(k); continue }
    const b = baseKey(k)
    if (seen.has(b)) continue
    seen.add(b)
    const forms = FORMS.filter(c => cats.includes(c) || (c === 'zero' && `${b}_zero` in en))
    for (const c of forms) out.push(`${b}_${c}`)
  }
  return out
}

function setDeep(obj, parts, value) {
  let o = obj
  for (const p of parts.slice(0, -1)) o = o[p] ||= {}
  o[parts[parts.length - 1]] = value
}

/** Write `flat` as src/locales/<code>/<area>.json, English's files and key order; keys English lacks are dropped. */
export function writeLanguage(localesDir, code, flat) {
  const en = readFlat(localesDir, 'en')
  const files = {}
  for (const k of wantedKeys(en, code)) {
    if (typeof flat[k] !== 'string') continue
    const [area, ...rest] = k.split('.')
    setDeep(files[area] ||= {}, rest, flat[k])
  }
  const dir = path.join(localesDir, code)
  fs.mkdirSync(dir, { recursive: true })
  for (const [area, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${area}.json`), `${JSON.stringify(data, null, 2)}\n`)
  return Object.keys(files).length
}

export function languageCodes(root = ROOT) {
  const src = fs.readFileSync(path.join(root, 'src/i18n/languages.js'), 'utf8')
  return [...src.matchAll(/code:\s*'([\w-]+)'/g)].map(m => m[1])
}

export function arg(name, argv = process.argv.slice(2)) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
