// The editor's interface translations: a small in-house t(), no library.
//
// Strings live in src/locales/<lang>/<area>.json. Each file is one top-level key,
// so src/locales/en/timeline.json -> t('timeline.<key>'); keys may nest
// ({ "split": { "title": ... } } -> t("area.split.title")).
//
// English is bundled (it is the fallback for every missing key). Every other
// language is lazy: its files are separate chunks, fetched once when the language
// is first chosen, so the editor opens as fast in English as before and a viewer
// only ever downloads the language they read.
//
// Same conventions as the 3Speak frontend (i18next style), so its translators and
// its check script read these files the same way:
//   {{name}}          placeholder, t('a.b', { name })
//   key_one/key_other plural forms picked with Intl.PluralRules from { count }
//                     (ru/uk/pl also have _few/_many, see the language's rules)
//   <b>..</b>, <kbd/> tags for tRich(), which maps them to React elements
//
// Language: the URL's ?lang= (3Speak passes it when it opens the editor), then a
// 'set-language' message from the parent page when the viewer switches while the
// editor is open, else the browser's language, else English.
//
// In a component use the hook, so it re-renders when the language changes:
//   const { t } = useT()
// Outside React (utils, error messages) import { t } from '../i18n'. It reads the
// CURRENT language at call time, so never call it at module top level: a label
// computed at import time stays in the language active then.
import { createElement, Fragment, cloneElement, isValidElement, useSyncExternalStore } from 'react'
import { DEFAULT_LANGUAGE, LANGUAGE_CODES, matchLanguage } from './languages'

export { LANGUAGES, LANGUAGE_CODES, DEFAULT_LANGUAGE, matchLanguage } from './languages'

const english = import.meta.glob('../locales/en/*.json', { eager: true, import: 'default' })
const others = import.meta.glob(['../locales/*/*.json', '!../locales/en/*.json'], { import: 'default' })

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else if (typeof v === 'string') out[key] = v
  }
  return out
}
const fileArea = path => path.split('/').pop().replace(/\.json$/, '')
const fileLang = path => path.split('/').slice(-2)[0]

function bundle(entries) {
  const out = {}
  for (const [path, data] of entries) flatten(data, fileArea(path), out)
  return out
}

const dicts = { [DEFAULT_LANGUAGE]: bundle(Object.entries(english)) }
const loaders = {}
for (const [path, load] of Object.entries(others)) (loaders[fileLang(path)] ||= []).push([path, load])

let current = DEFAULT_LANGUAGE
let version = 0
const listeners = new Set()
const notify = () => { version++; for (const fn of listeners) fn() }

export const getLanguage = () => current
export const isLoaded = code => !!dicts[code]

// ---- formatting ----------------------------------------------------------------

const cache = new Map()
function cached(kind, lang, opts, make) {
  const id = `${kind}|${lang}|${opts ? JSON.stringify(opts) : ''}`
  if (!cache.has(id)) {
    try { cache.set(id, make()) } catch { cache.set(id, null) }
  }
  return cache.get(id)
}
const pluralRules = lang => cached('plural', lang, null, () => new Intl.PluralRules(lang))

/** A number in the interface language: 2.5 -> "2,5" in German. Groups only from 10 000 (no "2.026"). */
export function formatNumber(n, opts = {}) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n)
  const o = { maximumFractionDigits: 2, useGrouping: Math.abs(n) >= 10000, ...opts }
  const f = cached('number', current, o, () => new Intl.NumberFormat(current, o))
  return f ? f.format(n) : String(n)
}

/** "a, b and c" in the interface language. */
export function formatList(items, type = 'conjunction') {
  const list = (items || []).map(String)
  const f = cached('list', current, { type }, () => new Intl.ListFormat(current, { style: 'long', type }))
  return f ? f.format(list) : list.join(', ')
}

/** The name of a language ('de', 'pt-BR') in the interface language; the code itself if unknown. */
export function languageName(code) {
  if (!code) return ''
  const f = cached('lang', current, null, () => new Intl.DisplayNames([current, 'en'], { type: 'language' }))
  try { return (f && f.of(code)) || code } catch { return code }
}

// ---- lookup ----------------------------------------------------------------------

const warned = new Set()
function lookup(key, vars) {
  const dict = dicts[current] || dicts[DEFAULT_LANGUAGE]
  const en = dicts[DEFAULT_LANGUAGE]
  const count = vars && typeof vars.count === 'number' ? vars.count : null
  if (count != null) {
    const cat = pluralRules(current)?.select(count) || 'other'
    const enCat = pluralRules(DEFAULT_LANGUAGE)?.select(count) || 'other'
    // zero is a choice in every language (i18next does the same): "No clips"
    const hit = (count === 0 ? dict[`${key}_zero`] : undefined) ?? dict[`${key}_${cat}`] ?? dict[`${key}_other`] ?? dict[key]
    if (hit != null) return hit
    const enHit = (count === 0 ? en[`${key}_zero`] : undefined) ?? en[`${key}_${enCat}`] ?? en[`${key}_other`] ?? en[key]
    if (enHit != null) return enHit
  } else {
    const hit = dict[key] ?? en[key]
    if (hit != null) return hit
  }
  if (!warned.has(key)) { warned.add(key); if (typeof console !== 'undefined') console.warn(`[i18n] missing key ${key}`) }
  return key
}

function interpolate(str, vars) {
  if (!vars) return str
  return str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, name) => {
    if (!(name in vars)) return m
    const v = vars[name]
    return typeof v === 'number' ? formatNumber(v) : v == null ? '' : String(v)
  })
}

/** The text of `key` in the current language, with {{placeholders}} filled from `vars`. */
export function t(key, vars) {
  return interpolate(lookup(key, vars), vars)
}

/** Does the key exist (in English)? For code that picks a key by a value it got from elsewhere. */
export const hasKey = key => key in dicts[DEFAULT_LANGUAGE] || `${key}_other` in dicts[DEFAULT_LANGUAGE]

/**
 * t() for text with markup: tags in the string become React elements.
 *   "Press <kbd>Space</kbd> to play"  tRich(key, null, { kbd: <kbd className="k" /> })
 *   "Line one<br/>line two"           { br: <br /> }
 * A component may also be a function (children) => element. Tags do not nest.
 */
export function tRich(key, vars, components = {}) {
  const str = t(key, vars)
  const parts = []
  const re = /<(\w+)\s*\/>|<(\w+)>([\s\S]*?)<\/\2>/g
  let last = 0
  let m
  let i = 0
  while ((m = re.exec(str))) {
    if (m.index > last) parts.push(str.slice(last, m.index))
    const name = m[1] || m[2]
    const children = m[1] ? undefined : m[3]
    const c = components[name]
    const k = `${name}-${i++}`
    if (typeof c === 'function') parts.push(createElement(Fragment, { key: k }, c(children)))
    else if (isValidElement(c)) parts.push(cloneElement(c, { key: k }, children ?? c.props.children))
    else parts.push(children ?? '')
    last = re.lastIndex
  }
  if (last < str.length) parts.push(str.slice(last))
  return createElement(Fragment, null, ...parts)
}

// ---- switching ----------------------------------------------------------------------

let pending = null
/**
 * Switch the interface to `tag` (any browser tag; one we do not ship means English).
 * Loads the language's files the first time. Resolves to the language now shown.
 */
export async function setLanguage(tag) {
  const code = matchLanguage(tag) || DEFAULT_LANGUAGE
  pending = code
  if (!dicts[code]) {
    try {
      const files = await Promise.all((loaders[code] || []).map(async ([path, load]) => [path, await load()]))
      dicts[code] = bundle(files)
    } catch (e) {
      // offline or a failed chunk: stay in the language we have
      if (typeof console !== 'undefined') console.warn('[i18n] could not load', code, e?.message)
      return current
    }
  }
  if (pending !== code) return current // a later switch won
  if (current !== code) {
    current = code
    if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', code)
    notify()
  }
  return current
}

/** ?lang= first, then the browser's languages, else English. */
export function initialLanguage(search = typeof window !== 'undefined' ? window.location.search : '', nav = typeof navigator !== 'undefined' ? navigator : null) {
  let fromUrl = null
  try { fromUrl = matchLanguage(new URLSearchParams(search).get('lang')) } catch { /* bad query */ }
  if (fromUrl) return fromUrl
  for (const tag of [...(nav?.languages || []), nav?.language]) {
    const code = matchLanguage(tag)
    if (code) return code
  }
  return DEFAULT_LANGUAGE
}

/**
 * Before the first render: pick the language and load it, but never hold the
 * editor up for long (after `maxWaitMs` it opens in English and switches when
 * the files arrive).
 */
export function initI18n({ maxWaitMs = 1500 } = {}) {
  const code = initialLanguage()
  if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', current)
  if (code === DEFAULT_LANGUAGE) return Promise.resolve(DEFAULT_LANGUAGE)
  return Promise.race([setLanguage(code), new Promise(r => setTimeout(() => r(current), maxWaitMs))])
}

/** The parent page (3Speak) says the viewer switched language: { type: 'set-language', lang }. */
export function listenForParentLanguage() {
  if (typeof window === 'undefined' || window.parent === window) return () => {}
  const onMsg = e => {
    if (e.source !== window.parent || e.data?.type !== 'set-language' || typeof e.data.lang !== 'string') return
    setLanguage(e.data.lang)
  }
  window.addEventListener('message', onMsg)
  return () => window.removeEventListener('message', onMsg)
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
const getVersion = () => version

/**
 * In components: const { t, tRich, lang } = useT(). Re-renders the component
 * when the language changes. Put `lang` in the deps of a useMemo that builds text.
 */
export function useT() {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return { t, tRich, lang: current, formatNumber, formatList, languageName }
}

// For tests: drop a loaded language, or inject strings without the files.
export function __setDictionary(code, flat) { dicts[code] = flat }
