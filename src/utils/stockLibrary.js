/**
 * Stock media library: b-roll videos, photos and animated GIFs that are free
 * to use with no credit (CC0 / public domain), built onto our server by
 * scripts/stock/build_library.py and served at /stock/ (library.json:
 * { categories: [{ id, label }], items: [{ id, type, category, title, tags,
 * file, thumb, preview?, width, height, duration?, source, author, license,
 * licenseUrl, sourceUrl }] }, paths relative to the JSON).
 * Optional live search (Pexels / Pixabay) goes through the editor backend
 * (backend/src/routes/stock.js) and gives items of the same shape.
 */

// Off until the owner is happy with the library: VITE_STOCK_LIBRARY=true at build time shows it.
export const STOCK_ENABLED = import.meta.env?.VITE_STOCK_LIBRARY === 'true'

export const STOCK_SOURCES = (import.meta.env?.VITE_STOCK_SOURCES || '/stock/library.json')
  .split(',').map(s => s.trim()).filter(Boolean)

export const STOCK_TYPES = [
  { id: 'all', label: 'All' },
  { id: 'video', label: 'Videos' },
  { id: 'image', label: 'Photos' },
  { id: 'gif', label: 'GIFs' }
]

// How long a photo stays on the timeline when added (seconds)
export const STOCK_IMAGE_SECONDS = 5

/** One library item with absolute URLs, or null when it is unusable. */
export function normalizeStockItem(it, base) {
  if (!it || !it.id || !it.file || !['video', 'image', 'gif'].includes(it.type)) return null
  const abs = (p) => (p ? new URL(p, base).href : null)
  return {
    key: `${it.provider || 'lib'}:${it.id}`,
    id: String(it.id),
    type: it.type,
    category: it.category || null,
    title: String(it.title || it.id),
    tags: Array.isArray(it.tags) ? it.tags.map(t => String(t).toLowerCase()) : [],
    url: abs(it.file),
    thumbUrl: abs(it.thumb) || (it.type === 'image' ? abs(it.file) : null),
    previewUrl: abs(it.preview),
    width: Number(it.width) || null,
    height: Number(it.height) || null,
    duration: Number(it.duration) || null,
    credit: {
      id: `${it.provider || 'stock'}:${it.id}`,
      title: String(it.title || it.id),
      author: it.author || null,
      source: it.source || null,
      sourceUrl: it.sourceUrl || null,
      license: it.license || null,
      licenseUrl: it.licenseUrl || null
    }
  }
}

/** Every library file's categories and items (duplicates by key dropped). */
export async function loadStockLibraries(sources = STOCK_SOURCES, fetchImpl = fetch, origin = globalThis.location?.origin) {
  const categories = new Map()
  const items = new Map()
  let failed = 0
  await Promise.all(sources.map(async (src) => {
    try {
      const base = new URL(src, origin).href
      // revalidate: the files are cached for a week, the list changes on rebuilds
      const res = await fetchImpl(base, { cache: 'no-cache' })
      if (!res.ok) { failed++; return }
      const lib = await res.json()
      for (const c of lib.categories || []) if (c?.id && !categories.has(c.id)) categories.set(c.id, c.label || c.id)
      for (const raw of lib.items || []) {
        const it = normalizeStockItem(raw, base)
        if (it && !items.has(it.key)) items.set(it.key, it)
      }
    } catch (err) {
      failed++
      console.warn('[StockLibrary] could not load', src, err)
    }
  }))
  return {
    categories: [...categories].map(([id, label]) => ({ id, label })),
    items: [...items.values()],
    failed: failed === sources.length && sources.length > 0
  }
}

/** Items for a type (all | video | image | gif), a category (or null) and a search. */
export function filterStock(items, { type = 'all', category = null, query = '' } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((it) => {
    if (type !== 'all' && it.type !== type) return false
    // a search looks through every category
    if (!words.length) return !category || it.category === category
    const hay = `${it.title.toLowerCase()} ${it.tags.join(' ')} ${it.category || ''}`
    return words.every(w => hay.includes(w))
  })
}

/** A short length label: 0:07 */
export function stockDuration(secs) {
  if (!secs) return ''
  const s = Math.round(secs)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
