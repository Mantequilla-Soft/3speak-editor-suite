import { useEffect, useMemo, useState } from 'react'
import { X, Search, Sticker } from 'lucide-react'
import { TEXT_PRESETS, presetPreviewStyle } from '../utils/stickerPresets'

// Image stickers (emojis, badges, shapes, branding): library.json files built
// by scripts/stickers/build_library.py, { categories, items: [{ id, category,
// title, file, keywords }] }, `file` relative to the JSON. Text boxes come
// from utils/stickerPresets.js (editable text clips, not images).
const SOURCES = (import.meta.env.VITE_STICKER_SOURCES || '/stickers/library.json')
  .split(',').map(s => s.trim()).filter(Boolean)

// Starting size per kind (image clip zoom, % of the frame)
const ZOOM = { emoji: 30, badges: 50, shapes: 40, branding: 35 }

async function loadStickers() {
  const categories = new Map()
  const items = []
  await Promise.all(SOURCES.map(async (src) => {
    try {
      const base = new URL(src, window.location.origin).href
      const res = await fetch(base, { cache: 'no-cache' })
      if (!res.ok) return
      const lib = await res.json()
      for (const c of lib.categories || []) if (!categories.has(c.id)) categories.set(c.id, c.label)
      for (const it of lib.items || []) {
        if (!it?.id || !it.file) continue
        items.push({
          key: `img:${it.id}`,
          kind: 'image',
          category: it.category,
          title: it.title || it.id,
          keywords: (it.keywords || []).join(' ').toLowerCase(),
          url: new URL(it.file, base).href
        })
      }
    } catch (err) {
      console.warn('[StickerPicker] could not load', src, err)
    }
  }))
  return { categories: [...categories].map(([id, label]) => ({ id, label })), items }
}

const textItems = TEXT_PRESETS.map(p => ({
  key: `text:${p.id}`, kind: 'text', category: 'text', title: p.title, keywords: p.text.toLowerCase(), preset: p
}))

/**
 * Sticker sheet: emojis, pre-styled text boxes, badges, arrows & shapes,
 * branding, with a filter tab per kind and a search. Picking one adds it at
 * the playhead (onPick gets the sticker for useTimeline.addStickerClip).
 */
function StickerPicker({ onPick, onClose }) {
  const [data, setData] = useState(null)
  const [tab, setTab] = useState('emoji')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    loadStickers().then(d => { if (!cancelled) setData(d) })
    return () => { cancelled = true }
  }, [])

  // Emojis first, then text boxes, then the rest of the library's categories
  const tabs = useMemo(() => {
    const cats = data?.categories || []
    const emoji = cats.filter(c => c.id === 'emoji')
    const rest = cats.filter(c => c.id !== 'emoji')
    return [...emoji, { id: 'text', label: 'Text boxes' }, ...rest]
  }, [data])

  const visible = useMemo(() => {
    const all = [...(data?.items || []).filter(i => i.category === 'emoji'), ...textItems, ...(data?.items || []).filter(i => i.category !== 'emoji')]
    // Searching looks through every kind at once; otherwise the open tab
    const q = query.trim().toLowerCase()
    if (q) return all.filter(i => i.title.toLowerCase().includes(q) || i.keywords.includes(q))
    return all.filter(i => i.category === tab)
  }, [data, tab, query])

  const pick = (item) => {
    if (item.kind === 'text') {
      onPick({ kind: 'text', name: item.title, text: item.preset.text, props: item.preset.props })
    } else {
      onPick({ kind: 'image', name: item.title, url: item.url, zoom: ZOOM[item.category] || 40 })
    }
    onClose()
  }

  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div className="remix-picker music-library sticker-picker" role="dialog" aria-modal="true" aria-labelledby="sticker-picker-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <Sticker size={16} />
          <h3 id="sticker-picker-title">Stickers</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
        </div>

        <div className="music-library-search">
          <Search size={14} />
          <input type="search" placeholder="Search stickers" value={query} onChange={e => setQuery(e.target.value)} />
        </div>

        <div className="music-library-moods">
          {tabs.map(t => (
            <button key={t.id} className={tab === t.id && !query.trim() ? 'active' : ''} onClick={() => { setTab(t.id); setQuery('') }}>{t.label}</button>
          ))}
        </div>

        <div className="sticker-grid">
          {!data && <div className="music-library-empty">Loading stickers...</div>}
          {data && visible.length === 0 && <div className="music-library-empty">No stickers match.</div>}
          {visible.map(item => (
            <button
              key={item.key}
              className={`sticker-tile${item.kind === 'text' ? ' text' : ''}${item.category === 'emoji' ? ' emoji' : ''}`}
              onClick={() => pick(item)}
              title={`${item.title} (adds at the playhead)`}
            >
              {item.kind === 'text'
                ? <span className="sticker-text-preview" style={presetPreviewStyle(item.preset.props)}>{item.preset.text}</span>
                : <img src={item.url} alt={item.title} loading="lazy" draggable={false} />}
            </button>
          ))}
        </div>
        <p className="music-library-note">Stickers go in at the playhead for 3 seconds. Drag, resize or trim them like any clip; text boxes stay editable.</p>
      </div>
    </div>
  )
}

export default StickerPicker
