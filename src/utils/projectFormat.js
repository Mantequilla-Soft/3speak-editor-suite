// The shape of a video project: a Short (9:16, up to 2 minutes, posted as a
// 3Speak Short) or a landscape, classic or square video (up to 10 minutes,
// posted as a normal 3Speak video). Picked at the top of the editor, or by the
// page that opens it (?aspect=16:9, or ?format=landscape|classic|square|short).
// Kept with the draft. The audio editor has no shape.

import { t } from '../i18n'

export const PROJECT_ASPECTS = ['9:16', '16:9', '4:3', '1:1']
export const DEFAULT_ASPECT = '9:16'
// The owner's rule: anything that is not a Short is at most 10 minutes
export const MAX_VIDEO_SECONDS = 10 * 60

// Names and hints are keys (formats.json): t(info.labelKey), read at render
export const ASPECT_INFO = {
  '9:16': { id: 'short', labelKey: 'formats.aspect.short.label', hintKey: 'formats.aspect.short.hint', short: true },
  '16:9': { id: 'landscape', labelKey: 'formats.aspect.landscape.label', hintKey: 'formats.aspect.landscape.hint', short: false },
  '4:3': { id: 'classic', labelKey: 'formats.aspect.classic.label', hintKey: 'formats.aspect.classic.hint', short: false },
  '1:1': { id: 'square', labelKey: 'formats.aspect.square.label', hintKey: 'formats.aspect.square.hint', short: false }
}

/** A shape's name in the interface language, with its ratio: "Short 9:16". */
export const aspectLabel = (a) => (ASPECT_INFO[a] ? `${t(ASPECT_INFO[a].labelKey)} ${a}` : a)

const FORMAT_NAMES = { short: '9:16', vertical: '9:16', landscape: '16:9', wide: '16:9', classic: '4:3', square: '1:1' }

export const isProjectAspect = (a) => PROJECT_ASPECTS.includes(a)
export const isShortAspect = (a) => (isProjectAspect(a) ? a : DEFAULT_ASPECT) === '9:16'
export const cleanAspect = (a) => (isProjectAspect(a) ? a : DEFAULT_ASPECT)

/** The shape the page asked for (?aspect= or ?format=), else the Short. */
export function readProjectAspect(search = typeof window !== 'undefined' ? window.location.search : '') {
  try {
    const p = new URLSearchParams(search)
    const a = p.get('aspect')
    if (isProjectAspect(a)) return a
    const f = FORMAT_NAMES[String(p.get('format') || '').toLowerCase()]
    return f || DEFAULT_ASPECT
  } catch {
    return DEFAULT_ASPECT
  }
}

/** width / height of an aspect ('16:9' -> 1.777...). */
export function aspectValue(a) {
  const [w, h] = cleanAspect(a).split(':').map(Number)
  return w / h
}

/**
 * The preview's canvas inside its container, as CSS sizes (container query
 * units): the largest box of the aspect that fits, for remix layout boxes.
 */
export function canvasCss(a) {
  const r = aspectValue(a)
  const fmt = (v) => String(Math.round(v * 10000) / 10000)
  return { w: `min(100cqw, ${fmt(100 * r)}cqh)`, h: `min(100cqh, ${fmt(100 / r)}cqw)` }
}

/** What 3Speak is told about a render of this shape ({ aspect, short }). */
export function postFormat(aspect, durationSec = null) {
  const a = cleanAspect(aspect)
  return { aspect: a, short: isShortAspect(a), ...(Number.isFinite(durationSec) && durationSec > 0 ? { durationSec: Math.round(durationSec * 1000) / 1000 } : {}) }
}
