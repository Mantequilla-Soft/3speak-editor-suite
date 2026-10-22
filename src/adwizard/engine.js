// Glue between the Ad Wizard and the scene engine vendored in public/scenes (motiongraphics-cookbook,
// docs/engine.md). The engine's schema (SceneMeta) and starter content (SceneSamples) are plain browser
// scripts; loadEngine() puts them on window once.
import { api, getBackendUrl } from '../utils/backendSelector'

export const SCENES_BASE = '/scenes'
export const HOST_URL = `${SCENES_BASE}/host/index.html`

let enginePromise = null
export function loadEngine() {
  if (enginePromise) return enginePromise
  const script = src => new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = resolve
    s.onerror = () => reject(new Error(`could not load ${src}`))
    document.head.appendChild(s)
  })
  enginePromise = script(`${SCENES_BASE}/lib/scene-samples.js`)
    .then(() => script(`${SCENES_BASE}/lib/scene-meta.js`))
    .then(() => window.SceneMeta)
  return enginePromise
}

export const FORMATS = {
  landscape: { label: 'Landscape 16:9', sub: 'in-video spots, websites', width: 1920, height: 1080 },
  portrait: { label: 'Portrait 9:16', sub: 'shorts, stories, reels', width: 1080, height: 1920 },
}

// Google Fonts the wizard offers (body + headline). Each loads the same in the preview and in the render.
export const FONTS = [
  'Inter', 'Inter Tight', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito', 'Raleway', 'Work Sans', 'DM Sans',
  'Manrope', 'Plus Jakarta Sans', 'Outfit', 'Sora', 'Space Grotesk', 'Rubik', 'Urbanist', 'Figtree', 'Lexend', 'Barlow',
  'Barlow Condensed', 'Oswald', 'Bebas Neue', 'Anton', 'Archivo Black', 'Syne', 'Unbounded', 'Righteous', 'Titan One',
  'Fredoka', 'Playfair Display', 'Merriweather', 'Lora', 'DM Serif Display', 'Fraunces', 'Roboto Mono', 'Space Mono',
  'Permanent Marker', 'Caveat',
]
export const fontSpec = f => `${f}:wght@400;500;600;700;800;900`

export const COLOR_PRESETS = [
  { name: 'Ember', colors: { bg: '#0a0b12', ink: '#f4f5f8', mute: '#9aa0b4', accent: '#ff5a36', accent2: '#5ad1c8', accent3: '#8a8cff' } },
  { name: 'Amber', colors: { bg: '#0b0c0f', ink: '#f3f5f9', mute: '#7a8291', accent: '#ffb020', accent2: '#4ade80', accent3: '#3987e5' } },
  { name: 'Ocean', colors: { bg: '#06131f', ink: '#eef6fb', mute: '#8fa6b8', accent: '#2fb6ff', accent2: '#5eead4', accent3: '#a78bfa' } },
  { name: 'Forest', colors: { bg: '#0b1410', ink: '#f1f6f2', mute: '#93a89a', accent: '#3ddc84', accent2: '#f5d547', accent3: '#56b6f7' } },
  { name: 'Berry', colors: { bg: '#140a14', ink: '#fbf2f8', mute: '#b39ab0', accent: '#ff4f9a', accent2: '#ffc857', accent3: '#7c83ff' } },
  { name: 'Paper', colors: { bg: '#f6f3ee', ink: '#17171a', mute: '#6b6b72', accent: '#e4572e', accent2: '#2a9d8f', accent3: '#3d5a80' } },
]

// soft glows behind the scenes, derived from the accents
const glow = (hex, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return undefined
  const n = parseInt(m[1], 16)
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`
}

export const ROLES = [
  { key: 'all', label: 'All' },
  { key: 'opener', label: 'Openers' },
  { key: 'middle', label: 'Middle' },
  { key: 'closer', label: 'Closers' },
]

export const newId = () => Math.random().toString(36).slice(2, 10)

export function defaultState() {
  return {
    version: 1,
    format: 'landscape',
    transition: 0.25,
    brand: {
      name: 'Your brand', monogram: '', logo: null,
      font: 'Inter', headFont: 'Inter', fontFaces: [],
      colors: { ...COLOR_PRESETS[0].colors },
    },
    scenes: [],
    music: null, // { url, title, credit, duration, start, volume, fadeIn, fadeOut, peaks }
    sfx: { auto: true, gain: 0, removed: [], clips: [] }, // clips: manual [{ id, url, name, at, volume, duration }]
  }
}

// relative upload URLs -> absolute, so the render backend (and the preview iframe) can load them
// (/api/… and /rendered/… live on the editor backend; everything else, e.g. /scenes/sfx, on this frontend)
export const absUrl = u => {
  if (!u || /^(https?:|data:|blob:)/.test(u)) return u
  const onBackend = /^\/(api|rendered)\//.test(u)
  return new URL(u, (onBackend && getBackendUrl()) || window.location.origin).href
}
const absImage = v => (v && typeof v === 'object' ? { ...v, url: absUrl(v.url) } : absUrl(v))

// Wizard state -> engine doc (docs/engine.md). Pictures become absolute URLs.
export function toDoc(state, SceneMeta) {
  const f = FORMATS[state.format]
  const b = state.brand
  const fams = [...new Set([b.font, b.headFont].filter(Boolean))].filter(x => !b.fontFaces.some(ff => ff.family === x))
  const walk = (fields, src) => {
    const o = { ...src }
    for (const fd of fields) {
      const v = o[fd.k]
      if (v == null) continue
      if (fd.kind === 'image') o[fd.k] = absImage(v)
      else if (fd.kind === 'images' && Array.isArray(v)) o[fd.k] = v.map(absImage)
      else if (fd.kind === 'list' && Array.isArray(v)) o[fd.k] = v.map(x => walk(fd.of, x))
      else if (fd.kind === 'object' && fd.of?.length) o[fd.k] = walk(fd.of, v)
    }
    return o
  }
  return {
    width: f.width, height: f.height, fps: 30, transition: state.transition,
    brand: {
      name: b.name || 'Brand',
      ...(b.monogram ? { monogram: b.monogram } : {}),
      ...(b.logo ? { logo: absImage(b.logo) } : {}),
      font: b.font, headFont: b.headFont,
      fonts: fams.map(fontSpec),
      fontFaces: b.fontFaces.map(ff => ({ ...ff, url: absUrl(ff.url) })),
      colors: { ...b.colors, glow1: glow(b.colors.accent, .34), glow2: glow(b.colors.accent3, .5), glow3: glow(b.colors.accent2, .16) },
    },
    scenes: state.scenes.map(({ id, ...s }) => (SceneMeta?.TYPES[s.type] ? walk(SceneMeta.TYPES[s.type].fields, s) : s)),
  }
}

// ---- automatic sound effects from the engine's cues (same mapping as the cookbook renderer) ----
const KINDS = {
  trans: { files: ['trans-1', 'trans-2', 'trans-3', 'trans-4', 'trans-5'], gain: -7, peak: .21 },
  whoosh: { files: ['whoosh-1', 'whoosh-2', 'whoosh-3'], gain: -7, peak: .45 },
  swish: { files: ['swish-1', 'swish-2', 'swish-3', 'swish-4'], gain: -9, peak: .42 },
  tick: { files: ['tick'], gain: -8, peak: .06 },
  click: { files: ['click-1', 'click-2', 'click-3'], gain: -15, peak: .003 },
  type: { files: ['type-1', 'type-2', 'type-3'], gain: -17, peak: .003 },
  hit: { files: ['hit-1', 'hit-2', 'hit-3'], gain: -7, peak: .02 },
}
// dB -> the editor's 0..100 clip volume (linear); the renderer mixes music around -16 LUFS
const dbToVol = db => Math.max(0, Math.min(100, Math.round(100 * Math.pow(10, db / 20))))

// cues [{t, kind, scene, gain?}] -> [{ key, url, at, volume, kind, auto: true }]
export function autoSfx(cues, sfx) {
  if (!sfx.auto || !cues?.length) return []
  const used = {}
  const out = []
  for (const c of cues) {
    const k = KINDS[c.kind]
    if (!k) continue
    const n = (used[c.kind] = (used[c.kind] ?? -1) + 1)
    const key = `${c.kind}:${c.scene}:${n}`
    if (sfx.removed.includes(key)) continue
    out.push({
      key, kind: c.kind, auto: true,
      url: absUrl(`${SCENES_BASE}/sfx/${k.files[n % k.files.length]}.wav`),
      at: Math.max(0, c.t - k.peak),
      volume: dbToVol(k.gain + (c.gain || 0) + (sfx.gain || 0)), // same levels as the cookbook renderer (music around -16 LUFS)
    })
  }
  return out
}

// ---- backend calls ----
export async function uploadFile(file, onProgress) {
  const form = new FormData()
  form.append('file', file)
  const res = await new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('POST', api('/api/upload'))
    x.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total)
    x.onload = () => (x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error(`upload failed (${x.status})`)))
    x.onerror = () => reject(new Error('upload failed'))
    x.send(form)
  })
  return res.url || `/api/upload/files/${res.filename}`
}

export async function pollJob(url, onStatus, { every = 1500, signal } = {}) {
  for (;;) {
    if (signal?.aborted) throw new Error('aborted')
    const r = await fetch(url, { cache: 'no-store' })
    const d = await r.json()
    onStatus?.(d)
    if (d.status === 'completed') return d
    if (d.status === 'failed' || d.status === 'aborted') throw new Error(d.error || d.status)
    await new Promise(res => setTimeout(res, every))
  }
}
