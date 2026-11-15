import { t, hasKey } from '../i18n'

// The scene engine's own texts (public/scenes/lib/scene-meta.js: scene descriptions, field labels and
// hints, look names, check messages) in the interface language. The engine is vendored and shared
// with the render server, so it stays English; the wizard looks each text up in
// src/locales/<lang>/scenes.json and shows the engine's English when a newer engine brings a text
// that has no key yet. Keys: descriptions by scene type, labels/hints by their English words
// (`slug`), unlabelled fields by field name.
const nice = k => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/([a-z])([A-Z])/g, '$1 $2')
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 12)
  .map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('')
const pick = (key, english, vars) => (hasKey(key) ? t(key, vars) : english)

export const sceneDesc = c => pick(`scenes.desc.${c.type}`, c.desc)
export const fieldLabel = f => (f.label ? pick(`scenes.label.${slug(f.label)}`, f.label) : pick(`scenes.field.${f.k}`, nice(f.k)))
export const fieldHint = f => (f.hint ? pick(`scenes.hint.${slug(f.hint)}`, f.hint) : '')
export const styleName = (k, english) => pick(`scenes.styles.${k}`, english)

// validate()'s messages ('required', `needs at least 2`, ...) as whole sentences
const ISSUES = [
  [/^required$/, () => t('scenes.issue.required')],
  [/^needs at least (\d+)$/, m => t('scenes.issue.atLeast', { count: +m[1] })],
  [/^only the first (\d+) are used$/, m => t('scenes.issue.onlyFirst', { count: +m[1] })],
  [/^long text \(max (\d+)\)$/, m => t('scenes.issue.longText', { max: +m[1] })],
  [/^unknown type (.+)$/, m => t('scenes.issue.unknownType', { type: m[1] })],
  [/^under ([\d.]+) s is hard to read$/, m => t('scenes.issue.hardToRead', { seconds: +m[1] })],
]
export function issueText(msg) {
  for (const [re, fn] of ISSUES) {
    const m = String(msg).match(re)
    if (m) return fn(m)
  }
  return msg
}
