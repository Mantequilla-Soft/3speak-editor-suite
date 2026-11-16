import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Search, Stock } from './icons'
import { loadStockLibraries, filterStock, normalizeStockItem, stockDuration, STOCK_TYPES } from '../utils/stockLibrary'
import { stockProviders, searchStockProvider, fetchStockProviderItem, PROVIDER_LABELS } from '../utils/stockProviders'
import { useT, hasKey } from '../i18n'
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
  const { t } = useT()
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
      if (!use) throw new Error(t('stock.errors.notCopied'))
      const ok = await onPick(use)
      if (ok === false) throw new Error(t('stock.errors.notAdded'))
      onClose()
    } catch (err) {
      setPickError(err?.message || t('stock.errors.notAdded'))
      setBusy(null)
    }
  }

  const onlineTypes = STOCK_TYPES.filter(x => x.id === 'video' || x.id === 'image')
  const types = online ? onlineTypes : STOCK_TYPES
  const empty = online
    ? (query.trim().length < 2 ? t('stock.typeToSearch', { provider: PROVIDER_LABELS[online] }) : onlineResults ? t('stock.nothingFound') : t('stock.searching'))
    : data?.failed ? t('stock.loadFailed') : t('stock.nothingMatches')

  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div className="remix-picker music-library stock-library" role="dialog" aria-modal="true" aria-labelledby="stock-library-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <Stock size={16} />
          <h3 id="stock-library-title">{purpose === 'background' ? t('stock.titleBackground') : t('stock.title')}</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title={t('common.close')}><X size={16} /></button>
        </div>

        <div className="music-library-search">
          <Search size={14} />
          <input
            type="search"
            placeholder={online ? t('stock.searchProvider', { provider: PROVIDER_LABELS[online] }) : t('stock.search')}
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus={!!online}
          />
        </div>

        <div className="music-library-moods" role="group" aria-label={t('stock.kind')}>
          {types.map(x => (
            <button key={x.id} className={type === x.id || (online && type === 'all' && x.id === 'video') ? 'active' : ''} onClick={() => setType(x.id)}>{t(`stock.types.${x.id}`)}</button>
          ))}
          {providers.length > 0 && <span className="stock-library-divider" aria-hidden="true" />}
          {providers.map(p => (
            <button
              key={p}
              className={online === p ? 'active' : ''}
              onClick={() => { setOnline(online === p ? null : p); setOnlineResults(null); if (type === 'gif') setType('all') }}
              title={t('stock.searchProviderTitle', { provider: PROVIDER_LABELS[p] })}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>

        {!online && data?.categories?.length > 0 && (
          <div className="music-library-moods" role="group" aria-label={t('stock.category')}>
            <button className={!category && !query.trim() ? 'active' : ''} onClick={() => { setCategory(null); setQuery('') }}>{t('stock.everything')}</button>
            {data.categories.map(c => (
              <button key={c.id} className={category === c.id && !query.trim() ? 'active' : ''} onClick={() => { setCategory(c.id); setQuery('') }}>{hasKey(`stock.categories.${c.id}`) ? t(`stock.categories.${c.id}`) : c.label}</button>
            ))}
          </div>
        )}

        <div className="stock-grid">
          {!online && !data && <div className="music-library-empty">{t('stock.loading')}</div>}
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
              title={item.credit.author ? t('stock.byAuthor', { title: item.title, author: item.credit.author }) : item.title}
            >
              {item.thumbUrl && <img src={item.thumbUrl} alt={item.title} loading="lazy" draggable={false} />}
              {hover === item.key && item.previewUrl && (
                <video src={item.previewUrl} autoPlay muted loop playsInline preload="none" aria-hidden="true" />
              )}
              <span className="stock-tile-badges">
                {item.type === 'gif' && <span className="stock-badge">GIF</span>}
                {item.duration ? <span className="stock-badge">{stockDuration(item.duration)}</span> : null}
              </span>
              {busy === item.key && <span className="stock-tile-busy">{t('stock.adding')}</span>}
            </button>
          ))}
        </div>
        {pickError && <p className="music-library-note stock-library-error" role="alert">{pickError}</p>}
        <p className="music-library-note">
          {online
            ? t('stock.licenceOnline', { provider: PROVIDER_LABELS[online] })
            : t('stock.licence')}
          {' '}
          {purpose === 'background'
            ? t('stock.placeBackground')
            : t('stock.placeAdd')}
        </p>
      </div>
    </div>
  )
}

export default StockLibrary
