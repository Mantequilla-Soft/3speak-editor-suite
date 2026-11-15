import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Search, Stock } from './icons'
import { loadStockLibraries, filterStock, normalizeStockItem, stockDuration, STOCK_TYPES } from '../utils/stockLibrary'
import { stockProviders, searchStockProvider, fetchStockProviderItem, PROVIDER_LABELS } from '../utils/stockProviders'
import './StockLibrary.css'

/**
 * Stock media sheet: b-roll videos, photos and GIFs from our own library
 * (CC0 / public domain, scripts/stock/build_library.py), by kind, category and
 * search, with a moving preview on hover. When the editor backend has a Pexels
 * or Pixabay key, "Search online" looks there too; a picked file is copied to
 * our server first. onPick(item) adds it (resolves when it is on the timeline).
 * `purpose: 'background'`: picking a background for background removal.
 */
function StockLibrary({ onPick, onClose, purpose = 'add' }) {
  const [data, setData] = useState(null)
  const [type, setType] = useState('all')
  const [category, setCategory] = useState(null)
  const [query, setQuery] = useState('')
  const [providers, setProviders] = useState([])
  const [online, setOnline] = useState(null) // provider id while searching online
  const [onlineResults, setOnlineResults] = useState(null)
  const [onlineError, setOnlineError] = useState(null)
  const [busy, setBusy] = useState(null) // key of the item being added
  const [pickError, setPickError] = useState(null)
  const [hover, setHover] = useState(null)

  useEffect(() => {
    let cancelled = false
    loadStockLibraries().then(d => { if (!cancelled) setData(d) })
    stockProviders().then(p => { if (!cancelled) setProviders(p) })
    return () => { cancelled = true }
  }, [])

  // Online search: after a short pause in typing
  const searchSeq = useRef(0)
  useEffect(() => {
    if (!online) return
    const q = query.trim()
    setOnlineError(null)
    if (q.length < 2) { setOnlineResults(null); return }
    const seq = ++searchSeq.current
    const timer = setTimeout(async () => {
      try {
        const items = await searchStockProvider(online, q, type === 'all' ? 'video' : type)
        if (seq === searchSeq.current) setOnlineResults(items.map(it => normalizeStockItem(it, window.location.origin)).filter(Boolean))
      } catch (err) {
        if (seq === searchSeq.current) { setOnlineResults([]); setOnlineError(err.message) }
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [online, query, type])

  const visible = useMemo(() => {
    if (online) return onlineResults || []
    return filterStock(data?.items || [], { type, category, query })
  }, [data, type, category, query, online, onlineResults])

  const pick = async (item) => {
    if (busy) return
    setBusy(item.key)
    setPickError(null)
    try {
      // an online find is copied to our server first, the clip uses that copy
      const use = online ? normalizeStockItem(await fetchStockProviderItem(online, item.id, item.type), window.location.origin) : item
      if (!use) throw new Error('That file could not be copied.')
      const ok = await onPick(use)
      if (ok === false) throw new Error('That file could not be added.')
      onClose()
    } catch (err) {
      setPickError(err?.message || 'That file could not be added.')
      setBusy(null)
    }
  }

  const onlineTypes = STOCK_TYPES.filter(t => t.id === 'video' || t.id === 'image')
  const types = online ? onlineTypes : STOCK_TYPES
  const empty = online
    ? (query.trim().length < 2 ? `Type what you are looking for to search ${PROVIDER_LABELS[online]}.` : onlineResults ? 'Nothing found.' : 'Searching...')
    : data?.failed ? 'The stock library could not be loaded.' : 'Nothing matches.'

  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div className="remix-picker music-library stock-library" role="dialog" aria-modal="true" aria-labelledby="stock-library-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <Stock size={16} />
          <h3 id="stock-library-title">{purpose === 'background' ? 'Pick a background' : 'Stock media'}</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
        </div>

        <div className="music-library-search">
          <Search size={14} />
          <input
            type="search"
            placeholder={online ? `Search ${PROVIDER_LABELS[online]}` : 'Search videos, photos and GIFs'}
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus={!!online}
          />
        </div>

        <div className="music-library-moods" role="group" aria-label="Kind">
          {types.map(t => (
            <button key={t.id} className={type === t.id || (online && type === 'all' && t.id === 'video') ? 'active' : ''} onClick={() => setType(t.id)}>{t.label}</button>
          ))}
          {providers.length > 0 && <span className="stock-library-divider" aria-hidden="true" />}
          {providers.map(p => (
            <button
              key={p}
              className={online === p ? 'active' : ''}
              onClick={() => { setOnline(online === p ? null : p); setOnlineResults(null); if (type === 'gif') setType('all') }}
              title={`Search ${PROVIDER_LABELS[p]} (free to use, copied to our server when you pick one)`}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>

        {!online && data?.categories?.length > 0 && (
          <div className="music-library-moods" role="group" aria-label="Category">
            <button className={!category && !query.trim() ? 'active' : ''} onClick={() => { setCategory(null); setQuery('') }}>Everything</button>
            {data.categories.map(c => (
              <button key={c.id} className={category === c.id && !query.trim() ? 'active' : ''} onClick={() => { setCategory(c.id); setQuery('') }}>{c.label}</button>
            ))}
          </div>
        )}

        <div className="stock-grid">
          {!online && !data && <div className="music-library-empty">Loading the library...</div>}
          {(online || data) && visible.length === 0 && <div className="music-library-empty">{onlineError || empty}</div>}
          {visible.map(item => (
            <button
              key={item.key}
              className={`stock-tile${busy === item.key ? ' busy' : ''}`}
              onClick={() => pick(item)}
              onMouseEnter={() => setHover(item.key)}
              onMouseLeave={() => setHover(h => (h === item.key ? null : h))}
              onFocus={() => setHover(item.key)}
              onBlur={() => setHover(h => (h === item.key ? null : h))}
              disabled={!!busy && busy !== item.key}
              title={`${item.title}${item.credit.author ? ` (${item.credit.author})` : ''}`}
            >
              {item.thumbUrl && <img src={item.thumbUrl} alt={item.title} loading="lazy" draggable={false} />}
              {hover === item.key && item.previewUrl && (
                <video src={item.previewUrl} autoPlay muted loop playsInline preload="none" aria-hidden="true" />
              )}
              <span className="stock-tile-badges">
                {item.type === 'gif' && <span className="stock-badge">GIF</span>}
                {item.duration ? <span className="stock-badge">{stockDuration(item.duration)}</span> : null}
              </span>
              {busy === item.key && <span className="stock-tile-busy">Adding...</span>}
            </button>
          ))}
        </div>
        {pickError && <p className="music-library-note stock-library-error" role="alert">{pickError}</p>}
        <p className="music-library-note">
          {online
            ? `From ${PROVIDER_LABELS[online]}: free to use, also commercially, no credit needed. The file is copied to 3Speak's server when you pick it.`
            : 'Free to use, also commercially, no credit needed (CC0 / public domain from Wikimedia Commons).'}
          {' '}
          {purpose === 'background'
            ? 'It goes behind you, on its own track, as long as your clip.'
            : 'It goes in at the playhead: on an empty timeline as your video, otherwise over it as b-roll.'}
        </p>
      </div>
    </div>
  )
}

export default StockLibrary
