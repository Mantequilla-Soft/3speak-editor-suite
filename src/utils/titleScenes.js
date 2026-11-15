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

export const SCENE_HOST_URL = '/scenes/host/index.html'

// What the host page shows of a title: never the progress bar or the brand bug
export const SCENE_CHROME_CSS = '#prog,#bug{display:none !important}'
// Over the video: no background and no glows either
export const SCENE_TRANSPARENT_CSS = 'html,body,#stage{background:transparent !important}#stage>.glow{display:none !important}'

export const TITLE_FONTS = ['Inter', 'Montserrat', 'Poppins', 'Oswald', 'Bebas Neue', 'Anton', 'Archivo Black', 'Playfair Display', 'Permanent Marker', 'Caveat']

// fields: k = the scene field, kind: 'lines' (one per line) | 'text' | 'para'
export const TITLE_TEMPLATES = [
  {
    id: 'lower-name', group: 'lower', type: 'hook', label: 'Name and role', transparent: true, placement: 'lower',
    fields: [{ k: 'lines', kind: 'lines', label: 'Name', max: 2 }, { k: 'sub', kind: 'para', label: 'Role' }],
    values: { lines: ['badadib'], sub: 'Creator on 3Speak' }, duration: 4
  },
  {
    id: 'lower-statement', group: 'lower', type: 'statement', label: 'Short statement', transparent: true, placement: 'lower',
    fields: [{ k: 'lines', kind: 'lines', label: 'Lines', max: 3 }],
    values: { lines: ['Three things', 'I *learned* today'] }, duration: 3.5
  },
  {
    id: 'title-words', group: 'title', type: 'words', label: 'One word at a time', transparent: true,
    fields: [{ k: 'words', kind: 'lines', label: 'Words', max: 5 }, { k: 'line', kind: 'text', label: 'Line under them' }],
    values: { words: ['Plan.', 'Film.', '*Post.*'], line: 'My week on 3Speak' }, duration: 2.8
  },
  {
    id: 'title-kinetic', group: 'title', type: 'kinetic', label: 'Words slam in', transparent: true,
    fields: [{ k: 'words', kind: 'lines', label: 'Words', max: 5 }, { k: 'line', kind: 'text', label: 'Line under them' }],
    values: { words: ['Fast', 'Simple', 'Yours'], line: 'Made on *3Speak*' }, duration: 3
  },
  {
    id: 'title-poster', group: 'title', type: 'heroPoster', label: 'Giant stacked words', transparent: true,
    fields: [{ k: 'words', kind: 'lines', label: 'Words', max: 4 }, { k: 'sub', kind: 'para', label: 'Line under them' }],
    values: { words: ['Day', 'one.'], sub: 'Starting from zero' }, duration: 3
  },
  {
    id: 'title-marquee', group: 'title', type: 'marquee', label: 'Scrolling rows', transparent: true,
    fields: [{ k: 'rows', kind: 'lines', label: 'Rows', max: 5 }, { k: 'line', kind: 'text', label: 'Line in front' }],
    values: { rows: ['Plan', 'Film', 'Post', 'Repeat'], line: 'Every *week*' }, duration: 3
  },
  {
    id: 'card-hook', group: 'card', type: 'hook', label: 'Intro: opening line', transparent: false,
    fields: [{ k: 'lines', kind: 'lines', label: 'Headline', max: 3 }, { k: 'sub', kind: 'para', label: 'Line under it' }],
    values: { lines: ['How I', 'edit my', '*Shorts*'], sub: 'In under a minute' }, duration: 3
  },
  {
    id: 'card-end', group: 'card', type: 'endcard', label: 'Outro: follow me', transparent: false,
    fields: [{ k: 'brand', kind: 'text', label: 'Name' }, { k: 'tagline', kind: 'text', label: 'Tagline' }, { k: 'cta', kind: 'text', label: 'Call to action' }, { k: 'footer', kind: 'text', label: 'Small print' }],
    values: { brand: 'badadib', tagline: 'New Shorts *every week*', cta: 'Follow on 3Speak', footer: '' }, duration: 3.2
  },
  {
    id: 'card-poster', group: 'card', type: 'endPoster', label: 'Outro: giant words', transparent: false,
    fields: [{ k: 'words', kind: 'lines', label: 'Words', max: 4 }, { k: 'cta', kind: 'text', label: 'Call to action' }],
    values: { words: ['See', 'you', '*soon.*'], cta: 'Follow on 3Speak' }, duration: 3
  }
]

export const TITLE_GROUPS = [
  { id: 'lower', label: 'Lower thirds' },
  { id: 'title', label: 'Titles over the video' },
  { id: 'card', label: 'Intro and outro cards' }
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
  const name = fields.brand || 'Me'
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
 * previewH: the preview canvas height in px (positions are in preview px).
 */
export function titleClip(templateId, { values = null, colors = null, font = null, previewH = 640 } = {}) {
  const t = templateOf(templateId)
  if (!t) return null
  const duration = t.duration
  const lower = t.placement === 'lower'
  const previewW = previewH * 9 / 16
  return {
    type: 'scene',
    name: t.label,
    scene: { template: t.id, type: t.type, duration, fields: { ...t.values, ...(values || {}) } },
    sceneStyle: { colors: colors || COLOR_PRESETS[0].name, font: font || 'Inter' },
    transparent: t.transparent,
    startTime: 0,
    endTime: duration,
    duration,
    zoom: lower ? LOWER.zoom : 100,
    // CSS scale(zoom) then translate(position): the shift is in unzoomed preview px
    positionX: lower ? Math.round((LOWER.x * previewW) / (LOWER.zoom / 100)) : 0,
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
