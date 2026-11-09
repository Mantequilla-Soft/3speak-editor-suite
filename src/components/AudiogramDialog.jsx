import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Film, Download, Loader2, Eye, EyeOff, ChevronUp, ChevronDown, Upload, Trash2, Send, Scissors, RotateCcw } from 'lucide-react'
import { api, getBackendUrl } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'
import { chapterTime } from '../utils/chapters'
import {
  SIZES, LAYERS, moveLayer, resizeLayer, restack, stackOrder, toggleLayer, withPicture, pieceOf, canBeShort,
  AUDIOGRAM_MAX_SECONDS
} from '../utils/audiogramLayers'

const FORMATS = [
  { id: 'vertical', label: 'Vertical', hint: 'Shorts, Reels, Stories' },
  { id: 'square', label: 'Square', hint: 'Feeds' }
]
const WAVES = [
  { id: 'bars', label: 'Bars' },
  { id: 'centered', label: 'Centered' },
  { id: 'line', label: 'Line' },
  { id: 'dots', label: 'Thin' }
]
// The 3Speak red, white, the navy lightened for the dark background (no cyan)
const COLORS = ['#e32933', '#f4f5f8', '#7f88ea']
const PICTURE_LAYOUTS = [
  { id: 'blur', label: 'Card on a blur' },
  { id: 'fill', label: 'Fill the frame' }
]
const CORNERS = ['nw', 'ne', 'sw', 'se']
const PREVIEW = { vertical: 520, square: 400 } // preview height in px

const absolute = (u) => {
  if (!u || !u.startsWith('/')) return u
  return new URL(u, getBackendUrl() || window.location.origin).href
}

/**
 * Audiograms: short videos of pieces of the exported episode (moving waveform,
 * title, picture, the 3Speak branding) to share as teasers, and to post as
 * Shorts together with the episode ("Post together with the audio").
 *
 * The preview is the backend's own page (GET /api/audiogram/page), so what is
 * shown is what gets made; its parts are boxes to move, resize and stack. The
 * look of the last audiogram made is the person's template (kept on the
 * backend, /api/templates/audiogram), the start of the next one.
 */
export default function AudiogramDialog({
  outputUrl, length, playheadPosition, title, chapters, range, onPickRange,
  audiograms, onAddAudiogram, onUpdateAudiogram, onRemoveAudiogram,
  playlistCovers, onRequestCovers, onClose
}) {
  const [defaults, setDefaults] = useState(null) // { style, coverLayouts }
  const [style, setStyle] = useState(null)
  const [hasTemplate, setHasTemplate] = useState(false)
  const [text, setText] = useState(title || '')
  const [selected, setSelected] = useState(null)
  const [guide, setGuide] = useState(null)
  const [job, setJob] = useState(null) // { status, progress, phase, error }
  const [uploading, setUploading] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const pollRef = useRef(null)
  const frameRef = useRef(null)
  const fileRef = useRef(null)
  const [frameReady, setFrameReady] = useState(false)

  useEffect(() => () => clearInterval(pollRef.current), [])
  useEffect(() => { onRequestCovers?.() }, [onRequestCovers])

  // The first look (no template) and the person's template
  useEffect(() => {
    let gone = false
    ;(async () => {
      try {
        const d = await (await fetch(api('/api/audiogram/defaults'))).json()
        let tpl = null
        try {
          const r = await authFetch(api('/api/templates/audiogram'))
          if (r.ok) tpl = (await r.json()).template
        } catch { /* not signed in: no template */ }
        if (gone) return
        setDefaults(d)
        setHasTemplate(!!tpl)
        setStyle(tpl ? { format: tpl.format, duration: tpl.duration, wave: tpl.wave, background: tpl.background, line: tpl.line, layouts: tpl.layouts } : d.style)
      } catch (err) {
        if (!gone) setLoadError(err.message)
      }
    })()
    return () => { gone = true }
  }, [])

  const format = style?.format || 'vertical'
  const size = SIZES[format]
  const scale = PREVIEW[format] / size.h
  const layers = style?.layouts?.[format]
  const image = style?.background?.image || null
  const piece = pieceOf(range, length, playheadPosition)
  const seconds = Math.round((piece.end - piece.start) * 10) / 10

  const setLayers = useCallback((fn) => {
    setStyle(s => ({ ...s, layouts: { ...s.layouts, [s.format]: fn(s.layouts[s.format]) } }))
  }, [])
  const setImage = (url) => {
    setStyle(s => {
      const next = { ...s, background: { ...s.background, image: url } }
      return url ? { ...next, layouts: withPicture(s.layouts, { hasImage: true, plainDefaults: defaults?.style?.layouts, coverDefaults: defaults?.coverLayouts }) } : next
    })
  }

  // The preview page: told the state on every change
  const pageState = useMemo(() => (style && layers ? {
    width: size.w,
    height: size.h,
    layers,
    title: text,
    line: style.line,
    image: absolute(image),
    imageLayout: style.background.imageLayout,
    wave: style.wave
  } : null), [style, layers, size, text, image])
  useEffect(() => {
    const onMsg = (e) => {
      if (e.source !== frameRef.current?.contentWindow || e.data?.type !== 'audiogram-page-ready') return
      setFrameReady(true)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  useEffect(() => {
    if (frameReady && pageState) frameRef.current?.contentWindow?.postMessage({ type: 'audiogram-state', state: pageState }, '*')
  }, [frameReady, pageState])

  // Move and resize in the preview
  const startDrag = (e, id, corner = null) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSelected(id)
    const sx = e.clientX
    const sy = e.clientY
    const base = layers
    const onMove = (ev) => {
      const dx = (ev.clientX - sx) / scale
      const dy = (ev.clientY - sy) / scale
      if (corner) {
        setLayers(() => resizeLayer(base, id, corner, dx, dy, size, ev.shiftKey || id === 'cover' || id === 'logo'))
      } else {
        const r = moveLayer(base, id, dx, dy, size, !ev.altKey)
        setGuide(r.guide)
        setLayers(() => r.layers)
      }
    }
    const onUp = () => {
      setGuide(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const nudge = (e) => {
    if (!selected || !layers) return
    const step = e.shiftKey ? 10 : 1
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (!d) return
    e.preventDefault()
    setLayers(l => moveLayer(l, selected, d[0], d[1], size, false).layers)
  }

  const upload = async (file) => {
    if (!file) return
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file, file.name || 'picture')
      const res = await authFetch(api('/api/upload'), { method: 'POST', body: form })
      if (!res.ok) throw new Error(`upload ${res.status}`)
      const { url } = await res.json()
      setImage(absolute(url))
    } catch (err) {
      setJob({ status: 'failed', error: err?.code === 'sign-in' ? 'Sign in on 3Speak to add a picture.' : err.message })
    } finally {
      setUploading(false)
    }
  }

  const resetArrangement = () => {
    if (!defaults) return
    const fresh = image ? defaults.coverLayouts[format] : defaults.style.layouts[format]
    setLayers(() => fresh)
  }

  const make = async () => {
    clearInterval(pollRef.current)
    setJob({ status: 'processing', progress: 0, phase: 'Starting...' })
    const used = { ...style, duration: Math.round(seconds) }
    try {
      const res = await authFetch(api('/api/audiogram'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: outputUrl, start: piece.start, duration: seconds, format, title: text, style: used })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      pollRef.current = setInterval(async () => {
        try {
          const st = await (await fetch(api(`/api/audiogram/${data.jobId}`))).json()
          if (st.status === 'completed') {
            clearInterval(pollRef.current)
            setJob(null)
            onAddAudiogram({
              id: data.jobId,
              url: absolute(st.outputUrl),
              format,
              start: piece.start,
              duration: seconds,
              title: text,
              post: false,
              description: ''
            })
            // The last one made is the template for the next ones (kept for good)
            authFetch(api('/api/templates/audiogram'), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ template: used })
            }).then(r => { if (r.ok) setHasTemplate(true) }).catch(() => {})
          } else if (st.status === 'failed' || st.error) {
            clearInterval(pollRef.current)
            setJob({ status: 'failed', error: st.error || 'failed' })
          } else {
            setJob(st)
          }
        } catch {}
      }, 1000)
    } catch (err) {
      setJob({ status: 'failed', error: err?.code === 'sign-in' ? 'Sign in on 3Speak to make an audiogram.' : err.message })
    }
  }

  const busy = job?.status === 'processing'
  const order = layers ? stackOrder(layers) : []
  const shown = (id) => layers?.[id] && layers[id].on !== false && (id !== 'cover' || image)
  const chapterHere = (chapters || []).filter(c => c.at <= piece.start + 0.5).pop()

  return (
    <div className="remix-picker-overlay" onClick={busy ? undefined : onClose}>
      <div className="remix-picker audiogram-studio" role="dialog" aria-modal="true" aria-labelledby="audiogram-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="audiogram-title">Audiograms</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
        </div>

        {loadError && <p className="audio-template-error" role="alert">The audiogram settings could not be loaded: {loadError}</p>}
        {!style && !loadError && <p className="audio-template-intro"><Loader2 size={14} className="encoding-notice-spin" /> Loading your audiogram look…</p>}

        {style && layers && (
          <div className="audiogram-body">
            <div className="audiogram-stage-col">
              <div
                className="audiogram-stage"
                style={{ width: size.w * scale, height: size.h * scale }}
                tabIndex={0}
                onKeyDown={nudge}
                onPointerDown={() => setSelected(null)}
                aria-label="Audiogram preview: drag the parts to move them, the corners to resize"
              >
                <iframe
                  ref={frameRef}
                  title="Audiogram preview"
                  src={api('/api/audiogram/page')}
                  sandbox="allow-scripts"
                  width={size.w}
                  height={size.h}
                  style={{ transform: `scale(${scale})` }}
                />
                {guide === 'x' && <div className="audiogram-guide" />}
                {LAYERS.filter(l => shown(l.id)).map(({ id, name }) => {
                  const b = layers[id]
                  return (
                    <div
                      key={id}
                      className={`audiogram-box${selected === id ? ' selected' : ''}`}
                      data-layer={id}
                      title={`${name}: drag to move${selected === id ? ', corners to resize' : ''}`}
                      style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale, zIndex: b.z + 1 }}
                      onPointerDown={(e) => startDrag(e, id)}
                    >
                      {selected === id && <span className="audiogram-box-name">{name}</span>}
                      {selected === id && CORNERS.map(c => (
                        <span key={c} className={`audiogram-handle ${c}`} data-corner={c} onPointerDown={(e) => startDrag(e, id, c)} />
                      ))}
                    </div>
                  )
                })}
              </div>
              <p className="audiogram-stage-hint">
                Drag the parts, pull a corner to resize (Shift keeps the shape), arrow keys nudge.{hasTemplate ? ' Your last audiogram is the starting point.' : ''}
              </p>
            </div>

            <div className="audiogram-controls">
              <div className="audiogram-field">
                <span>Piece of the episode</span>
                <div className="audiogram-piece">
                  <strong data-testid="audiogram-piece">{chapterTime(piece.start)} – {chapterTime(piece.end)} · {Math.round(seconds)}s</strong>
                  {chapterHere && <small>in “{chapterHere.title}”</small>}
                </div>
                <button className="silence-cut-apply audiogram-pick" onClick={onPickRange} disabled={busy}>
                  <Scissors size={14} /> Choose on the timeline
                </button>
                <small className="audiogram-note">Up to {AUDIOGRAM_MAX_SECONDS / 60} minutes. Drag across the timeline to pick it.</small>
              </div>

              <div className="audiogram-field">
                <span>Shape</span>
                <div className="noise-levels" role="radiogroup" aria-label="Shape">
                  {FORMATS.map(f => (
                    <button key={f.id} role="radio" aria-checked={format === f.id} className={format === f.id ? 'active' : ''} title={f.hint} onClick={() => { setSelected(null); setStyle(s => ({ ...s, format: f.id })) }}>{f.label}</button>
                  ))}
                </div>
              </div>

              <label className="audiogram-field">
                <span>Title</span>
                <input value={text} maxLength={120} onChange={(e) => setText(e.target.value)} aria-label="Title on the video" />
              </label>
              <label className="audiogram-field">
                <span>Line under it <small>(*stars* make it red)</small></span>
                <input value={style.line} maxLength={120} onChange={(e) => { const v = e.target.value; setStyle(s => ({ ...s, line: v })) }} aria-label="Line on the video" />
              </label>

              <div className="audiogram-field">
                <span>Picture</span>
                <div className="audiogram-pictures" role="radiogroup" aria-label="Picture">
                  <button role="radio" aria-checked={!image} className={`audiogram-pic none${!image ? ' active' : ''}`} onClick={() => setImage(null)}>None</button>
                  <button className="audiogram-pic upload" onClick={() => fileRef.current?.click()} disabled={uploading} title="Upload a picture">
                    {uploading ? <Loader2 size={16} className="encoding-notice-spin" /> : <Upload size={16} />}
                  </button>
                  {image && !(playlistCovers || []).some(c => c.url === image) && (
                    <button role="radio" aria-checked className="audiogram-pic active" title="Your picture"><img src={image} alt="" /></button>
                  )}
                  {(playlistCovers || []).map(c => (
                    <button key={c.url} role="radio" aria-checked={image === c.url} className={`audiogram-pic${image === c.url ? ' active' : ''}`} title={c.title ? `Cover of “${c.title}”` : 'Playlist cover'} onClick={() => setImage(c.url)}>
                      <img src={c.url} alt="" loading="lazy" />
                    </button>
                  ))}
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
                </div>
                {playlistCovers && playlistCovers.length === 0 && <small className="audiogram-note">Your playlists have no covers yet.</small>}
                {image && (
                  <div className="noise-levels" role="radiogroup" aria-label="Picture layout">
                    {PICTURE_LAYOUTS.map(p => (
                      <button key={p.id} role="radio" aria-checked={style.background.imageLayout === p.id} className={style.background.imageLayout === p.id ? 'active' : ''} onClick={() => setStyle(s => ({ ...s, background: { ...s.background, imageLayout: p.id } }))}>{p.label}</button>
                    ))}
                  </div>
                )}
              </div>

              <div className="audiogram-field">
                <span>Waveform</span>
                <div className="noise-levels" role="radiogroup" aria-label="Waveform type">
                  {WAVES.map(w => (
                    <button key={w.id} role="radio" aria-checked={style.wave.type === w.id} className={style.wave.type === w.id ? 'active' : ''} onClick={() => setStyle(s => ({ ...s, wave: { ...s.wave, type: w.id } }))}>{w.label}</button>
                  ))}
                </div>
                <div className="audiogram-colors" role="radiogroup" aria-label="Waveform colour">
                  {COLORS.map(c => (
                    <button key={c} role="radio" aria-checked={style.wave.color === c} aria-label={`Colour ${c}`} className={`audiogram-swatch${style.wave.color === c ? ' active' : ''}`} style={{ background: c }} onClick={() => setStyle(s => ({ ...s, wave: { ...s.wave, color: c } }))} />
                  ))}
                  <label className={`audiogram-swatch custom${!COLORS.includes(style.wave.color) ? ' active' : ''}`} title="Any colour" style={{ background: COLORS.includes(style.wave.color) ? undefined : style.wave.color }}>
                    <input type="color" value={style.wave.color} aria-label="Any waveform colour" onChange={(e) => { const v = e.target.value; setStyle(s => ({ ...s, wave: { ...s.wave, color: v } })) }} />
                  </label>
                </div>
              </div>

              <div className="audiogram-field">
                <span>Parts <small>(front to back)</small></span>
                <ul className="audiogram-layers">
                  {order.filter(id => id !== 'cover' || image).map((id, i, list) => {
                    const meta = LAYERS.find(l => l.id === id)
                    const on = layers[id].on !== false
                    return (
                      <li key={id} className={selected === id ? 'selected' : ''}>
                        <button className="audiogram-layer-name" onClick={() => setSelected(id)}>{meta.name}</button>
                        <button className="audiogram-layer-btn" onClick={() => setLayers(l => toggleLayer(l, id))} aria-label={on ? `Hide ${meta.name}` : `Show ${meta.name}`} title={on ? 'Hide' : 'Show'}>{on ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                        <button className="audiogram-layer-btn" onClick={() => setLayers(l => restack(l, id, 1))} disabled={i === 0} aria-label={`Bring ${meta.name} forward`} title="Forward"><ChevronUp size={14} /></button>
                        <button className="audiogram-layer-btn" onClick={() => setLayers(l => restack(l, id, -1))} disabled={i === list.length - 1} aria-label={`Send ${meta.name} back`} title="Back"><ChevronDown size={14} /></button>
                      </li>
                    )
                  })}
                </ul>
                <button className="audiogram-reset" onClick={resetArrangement}><RotateCcw size={12} /> Tidy arrangement</button>
              </div>

              {busy && (
                <div className="compact-render-progress" role="status">
                  <div className="compact-render-progress-bar"><div className="compact-render-progress-fill" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div>
                  <span className="compact-render-progress-text">{job.phase || 'Working...'}</span>
                </div>
              )}
              {job?.status === 'failed' && <p className="audio-template-error" role="alert">The audiogram could not be made: {job.error}</p>}
              <button className="silence-cut-apply audiogram-make" onClick={make} disabled={busy || length < 3 || seconds < 3}>
                {busy ? <Loader2 size={14} className="encoding-notice-spin" /> : <Film size={14} />} {audiograms.length ? 'Make another audiogram' : 'Make audiogram'}
              </button>
            </div>
          </div>
        )}

        {audiograms.length > 0 && (
          <div className="audiogram-made">
            <h4>Your audiograms</h4>
            <ul>
              {audiograms.map((a, i) => (
                <li key={a.id} className="audiogram-made-item" data-testid="audiogram-item">
                  <video className={`audiogram-preview ${a.format}`} src={a.url} controls playsInline preload="metadata" />
                  <div className="audiogram-made-info">
                    <strong>#{i + 1} · {chapterTime(a.start)} · {Math.round(a.duration)}s · {a.format === 'vertical' ? 'Vertical' : 'Square'}</strong>
                    {canBeShort(a) ? (
                      <button
                        className={`audiogram-post${a.post ? ' active' : ''}`}
                        aria-pressed={!!a.post}
                        onClick={() => onUpdateAudiogram(a.id, { post: !a.post })}
                      >
                        <Send size={13} /> Post together with the audio
                      </button>
                    ) : (
                      <small className="audiogram-note">Shorts are vertical: make a vertical one to post it with the audio.</small>
                    )}
                    {a.post && (
                      <textarea
                        className="audiogram-desc"
                        rows={3}
                        maxLength={500}
                        placeholder="Text for the Short (optional). A link to the episode is added for you."
                        value={a.description}
                        onChange={(e) => onUpdateAudiogram(a.id, { description: e.target.value })}
                        aria-label={`Text for Short ${i + 1}`}
                      />
                    )}
                    <div className="audiogram-made-actions">
                      <a className="audiogram-layer-btn" href={a.url} download target="_blank" rel="noopener noreferrer" title="Download"><Download size={14} /></a>
                      <button className="audiogram-layer-btn" onClick={() => onRemoveAudiogram(a.id)} title="Remove" aria-label={`Remove audiogram ${i + 1}`}><Trash2 size={14} /></button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
