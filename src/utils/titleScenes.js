// Titles for Shorts from the Ad Wizard's motion scenes (backend/scene-engine,
// public/scenes): lower thirds and titles over the video (the scene's own
// background left out) and intro / outro cards (with it). A title is a clip of
// type 'scene' on a video track:
//   clip.scene = { template, type, duration, fields: { ... } }
//   clip.sceneStyle = { colors: preset name, font }
//   clip.transparent = true: over the video
// The preview plays the scene in the engine's own host page (SceneLayer.jsx),
// the render records the same page frame by frame (backend services/sceneClip.js).
import { COLOR_PRESETS, fontSpec } from '../adwizard/engine'
import { t } from '../i18n'

export const SCENE_HOST_URL = '/scenes/host/index.html'

// What the host page shows of a title: never the progress bar or the brand bug
export const SCENE_CHROME_CSS = '#prog,#bug{display:none !important}'
// Over the video: no background and no glows either
export const SCENE_TRANSPARENT_CSS = 'html,body,#stage{background:transparent !important}#stage>.glow{display:none !important}'

export const TITLE_FONTS = ['Inter', 'Montserrat', 'Poppins', 'Oswald', 'Bebas Neue', 'Anton', 'Archivo Black', 'Playfair Display', 'Permanent Marker', 'Caveat']

// fields: k = the scene field, kind: 'lines' (one per line) | 'text' | 'para'
// Labels and the sample words are read in the interface language when they are
// used (getters): the sample words are what a new title starts from.
const field = (k, kind, label, max) => ({
  k, kind, ...(max ? { max } : {}), labelKey: `titles.templates.fields.${label}`,
  get label() { return t(this.labelKey) }
})
const lines = (key) => t(key).split('\n')
export const TITLE_TEMPLATES = [
  {
    id: 'lower-name', group: 'lower', type: 'hook', get label() { return t('titles.templates.items.lowerName.label') }, transparent: true, placement: 'lower',
    fields: [field('lines', 'lines', 'name', 2), field('sub', 'para', 'role')],
    get values() { return { lines: ['badadib'], sub: t('titles.templates.items.lowerName.sub') } }, duration: 4
  },
  {
    id: 'lower-statement', group: 'lower', type: 'statement', get label() { return t('titles.templates.items.lowerStatement.label') }, transparent: true, placement: 'lower',
    fields: [field('lines', 'lines', 'lines', 3)],
    get values() { return { lines: lines('titles.templates.items.lowerStatement.lines') } }, duration: 3.5
  },
  {
    id: 'title-words', group: 'title', type: 'words', get label() { return t('titles.templates.items.titleWords.label') }, transparent: true,
    fields: [field('words', 'lines', 'words', 5), field('line', 'text', 'lineUnder')],
    get values() { return { words: lines('titles.templates.items.titleWords.words'), line: t('titles.templates.items.titleWords.line') } }, duration: 2.8
  },
  {
    id: 'title-kinetic', group: 'title', type: 'kinetic', get label() { return t('titles.templates.items.titleKinetic.label') }, transparent: true,
    fields: [field('words', 'lines', 'words', 5), field('line', 'text', 'lineUnder')],
    get values() { return { words: lines('titles.templates.items.titleKinetic.words'), line: t('titles.templates.items.titleKinetic.line') } }, duration: 3
  },
  {
    id: 'title-poster', group: 'title', type: 'heroPoster', get label() { return t('titles.templates.items.titlePoster.label') }, transparent: true,
    fields: [field('words', 'lines', 'words', 4), field('sub', 'para', 'lineUnder')],
    get values() { return { words: lines('titles.templates.items.titlePoster.words'), sub: t('titles.templates.items.titlePoster.sub') } }, duration: 3
  },
  {
    id: 'title-marquee', group: 'title', type: 'marquee', get label() { return t('titles.templates.items.titleMarquee.label') }, transparent: true,
    fields: [field('rows', 'lines', 'rows', 5), field('line', 'text', 'lineInFront')],
    get values() { return { rows: lines('titles.templates.items.titleMarquee.rows'), line: t('titles.templates.items.titleMarquee.line') } }, duration: 3
  },
  {
    id: 'card-hook', group: 'card', type: 'hook', get label() { return t('titles.templates.items.cardHook.label') }, transparent: false,
    fields: [field('lines', 'lines', 'headline', 3), field('sub', 'para', 'lineUnderIt')],
    get values() { return { lines: lines('titles.templates.items.cardHook.lines'), sub: t('titles.templates.items.cardHook.sub') } }, duration: 3
  },
  {
    id: 'card-end', group: 'card', type: 'endcard', get label() { return t('titles.templates.items.cardEnd.label') }, transparent: false,
    fields: [field('brand', 'text', 'name'), field('tagline', 'text', 'tagline'), field('cta', 'text', 'cta'), field('footer', 'text', 'smallPrint')],
    get values() { return { brand: 'badadib', tagline: t('titles.templates.items.cardEnd.tagline'), cta: t('titles.templates.items.cardEnd.cta'), footer: '' } }, duration: 3.2
  },
  {
    id: 'card-poster', group: 'card', type: 'endPoster', get label() { return t('titles.templates.items.cardPoster.label') }, transparent: false,
    fields: [field('words', 'lines', 'words', 4), field('cta', 'text', 'cta')],
    get values() { return { words: lines('titles.templates.items.cardPoster.words'), cta: t('titles.templates.items.cardPoster.cta') } }, duration: 3
  }
]

export const TITLE_GROUPS = [
  { id: 'lower', get label() { return t('titles.templates.groups.lower') } },
  { id: 'title', get label() { return t('titles.templates.groups.title') } },
  { id: 'card', get label() { return t('titles.templates.groups.card') } }
]
export const SCENE_DURATION = [1.5, 8]
export const templateOf = (id) => TITLE_TEMPLATES.find(t => t.id === id) || null

// Lower thirds: smaller, low on the left (zoom %, and position as a share of the canvas)
const LOWER = { zoom: 60, x: -0.2, y: 0.3 }

const glow = (hex, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return undefined
  const v = parseInt(m[1], 16)
  return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`
}

const clean = (v, kind, max) => {
  if (kind === 'lines') {
    const list = (Array.isArray(v) ? v : String(v || '').split('\n')).map(s => String(s).trim()).filter(Boolean)
    return list.slice(0, max || 5)
  }
  return String(v ?? '').trim()
}

// A title's scene fields, cleaned: lists as lists, empty optional texts left out
export function sceneFields(template, values) {
  const out = {}
  for (const f of template.fields) {
    const v = clean(values?.[f.k], f.kind, f.max)
    if (f.kind === 'lines' ? v.length : v) out[f.k] = v
  }
  return out
}

/**
 * The scene engine doc for a title clip (docs/engine.md): one scene, the
 * output's size, the chosen colours and font.
 */
export function sceneDoc(clip, frame = { width: 1080, height: 1920 }) {
  const s = clip.scene || {}
  const template = templateOf(s.template)
  const type = s.type || template?.type
  const preset = COLOR_PRESETS.find(p => p.name === clip.sceneStyle?.colors) || COLOR_PRESETS[0]
  const font = TITLE_FONTS.includes(clip.sceneStyle?.font) ? clip.sceneStyle.font : 'Inter'
  const fields = template ? sceneFields(template, s.fields) : { ...(s.fields || {}) }
  const name = fields.brand || t('titles.scene.defaultName')
  const c = preset.colors
  return {
    width: frame.width,
    height: frame.height,
    fps: 30,
    transition: 0,
    brand: {
      name,
      font,
      headFont: font,
      fonts: [fontSpec(font)],
      fontFaces: [],
      colors: { ...c, glow1: glow(c.accent, 0.34), glow2: glow(c.accent3, 0.5), glow3: glow(c.accent2, 0.16) }
    },
    scenes: [{ type, duration: sceneLength(clip), label: '', ...fields }]
  }
}

export const sceneLength = (clip) => {
  const d = Number(clip.scene?.duration)
  return Math.round(Math.max(SCENE_DURATION[0], Math.min(SCENE_DURATION[1], Number.isFinite(d) ? d : 3)) * 10) / 10
}

/**
 * A new title clip's own fields (the timeline adds id, position and track):
 * previewH / previewW: the preview canvas in px (positions are in preview px;
 * without previewW it is taken as 9:16).
 */
export function titleClip(templateId, { values = null, colors = null, font = null, previewH = 640, previewW = null } = {}) {
  const tpl = templateOf(templateId)
  if (!tpl) return null
  const duration = tpl.duration
  const lower = tpl.placement === 'lower'
  const width = previewW || previewH * 9 / 16
  return {
    type: 'scene',
    name: tpl.label,
    scene: { template: tpl.id, type: tpl.type, duration, fields: { ...tpl.values, ...(values || {}) } },
    sceneStyle: { colors: colors || COLOR_PRESETS[0].name, font: font || 'Inter' },
    transparent: tpl.transparent,
    startTime: 0,
    endTime: duration,
    duration,
    zoom: lower ? LOWER.zoom : 100,
    // CSS scale(zoom) then translate(position): the shift is in unzoomed preview px
    positionX: lower ? Math.round((LOWER.x * width) / (LOWER.zoom / 100)) : 0,
    positionY: lower ? Math.round((LOWER.y * previewH) / (LOWER.zoom / 100)) : 0
  }
}

// When a title's fields or look change: the clip update (a new length moves its end)
export function sceneUpdate(clip, patch) {
  const scene = { ...clip.scene, ...(patch.scene || {}) }
  if (patch.fields) scene.fields = { ...clip.scene.fields, ...patch.fields }
  const out = { scene }
  if (patch.sceneStyle) out.sceneStyle = { ...clip.sceneStyle, ...patch.sceneStyle }
  if ('transparent' in patch) out.transparent = !!patch.transparent
  if (patch.scene?.duration != null) {
    const d = sceneLength({ scene })
    scene.duration = d
    out.duration = d
    out.endTime = d
    if (clip.startTime > d - 0.1) out.startTime = 0
  }
  return out
}
