// The interface languages of the editor: the same list as the 3Speak frontend
// (new-3speak-tv src/i18n/languages.js), so the editor speaks every language the
// page that opens it speaks. Adding one: a folder src/locales/<code>/ (copy en/)
// and a line here; `npm run i18n:check` tells what is missing.
export const LANGUAGES = [
  { code: 'en', native: 'English' },
  { code: 'es', native: 'Español' },
  { code: 'pt', native: 'Português' },
  { code: 'de', native: 'Deutsch' },
  { code: 'fr', native: 'Français' },
  { code: 'it', native: 'Italiano' },
  { code: 'pl', native: 'Polski' },
  { code: 'ru', native: 'Русский' },
  { code: 'tr', native: 'Türkçe' },
  { code: 'id', native: 'Bahasa Indonesia' },
  { code: 'ko', native: '한국어' },
  { code: 'ja', native: '日本語' },
  { code: 'zh', native: '中文' },
  { code: 'hi', native: 'हिन्दी' },
  { code: 'bn', native: 'বাংলা' },
  { code: 'vi', native: 'Tiếng Việt' },
  { code: 'fil', native: 'Filipino' },
  { code: 'th', native: 'ไทย' },
  { code: 'sw', native: 'Kiswahili' },
  { code: 'uk', native: 'Українська' },
  { code: 'nl', native: 'Nederlands' },
]

export const DEFAULT_LANGUAGE = 'en'
export const LANGUAGE_CODES = LANGUAGES.map(l => l.code)

// Browser tags that are not "<code>" or "<code>-<region>" of one of ours.
const ALIASES = { tl: 'fil', in: 'id', iw: 'he', nb: 'no', zh_hans: 'zh' }

/** 'de-AT' -> 'de', 'pt_BR' -> 'pt', 'tl' -> 'fil'; null for a language we do not ship. */
export function matchLanguage(tag) {
  if (typeof tag !== 'string' || !tag.trim()) return null
  const lower = tag.trim().toLowerCase().replace(/_/g, '-')
  if (LANGUAGE_CODES.includes(lower)) return lower
  const base = lower.split('-')[0]
  const code = ALIASES[base] || base
  return LANGUAGE_CODES.includes(code) ? code : null
}
