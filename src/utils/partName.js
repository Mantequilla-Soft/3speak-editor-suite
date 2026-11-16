import { t } from '../i18n'

// The pieces of a clip cut at its pauses (Cut silences, Group with other voices) are
// named "Part 2 · interview.wav" in the interface language. Code that wants the
// original name back (titles, draft names, templates) strips that again: the English
// form, and the form of the language in use.
export const partName = (n, name) => t('timeline.partName', { n, name })

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function stripPart(name) {
  const s = String(name || '').replace(/^Part \d+ · /, '')
  const shape = partName('\u0000', '\u0001')
  const at = shape.indexOf('\u0001')
  if (at < 0) return s
  const [before, after] = [shape.slice(0, at), shape.slice(at + 1)].map(x => escapeRe(x).replace('\u0000', '\\d+'))
  const m = s.match(new RegExp(`^${before}([\\s\\S]*)${after}$`))
  return m && (before || after) ? m[1] : s
}
