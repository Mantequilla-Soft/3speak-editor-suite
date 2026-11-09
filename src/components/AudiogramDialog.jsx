import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Film, Download, Loader2, Eye, EyeOff, ChevronUp, ChevronDown, Upload, Trash2, Send, Scissors, RotateCcw, Lock, HelpCircle } from 'lucide-react'
import { api, getBackendUrl } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'
import { chapterTime } from '../utils/chapters'
import {
  SIZES, LAYERS, moveLayer, resizeLayer, rotateLayer, squareWave, restack, stackOrder, toggleLayer, withPicture, pieceOf, canBeShort,
  AUDIOGRAM_MAX_SECONDS, ROUND_WAVES
} from '../utils/audiogramLayers'
import OnboardingTour, { AUDIOGRAM_TOUR_STEPS, useFirstTimeTour } from './OnboardingTour'

const WAVES = [
  { id: 'bars', label: 'Bars' },
  { id: 'centered', label: 'Centered' },
  { id: 'line', label: 'Line' },
  { id: 'dots', label: 'Thin' },
  { id: 'circle', label: 'Circle' },
  { id: 'ring', label: 'Circle wave' }
]
// The 3Speak red, white, the navy lightened for the dark background (no cyan)
const COLORS = ['#e32933', '#f4f5f8', '#7f88ea']
const PICTURE_LAYOUTS = [
  { id: 'card', label: 'Card', hint: 'The picture as a card on the dark 3Speak background' },
  { id: 'blur', label: 'Card on a blur', hint: 'The picture as a card, and soft and dark behind it' },
  { id: 'fill', label: 'Fill the frame', hint: 'The picture over the whole video, no card' }
]
const CORNERS = ['nw', 'ne', 'sw', 'se']
const FORMAT = 'vertical' // the shape of a Short
const PREVIEW_HEIGHT = 520 // px

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
        const look = tpl ? { format: FORMAT, duration: tpl.duration, wave: tpl.wave, background: tpl.background, line: tpl.line, layouts: tpl.layouts } : { ...d.style, format: FORMAT }
        // a template from before the logo was fixed: it shows again (the backend does the same)
        const own = look.layouts?.[FORMAT] || d.style.layouts[FORMAT]
        look.layouts = { [FORMAT]: { ...own, logo: { ...own.logo, on: true } } }
        setStyle(look)
      } catch (err) {
        if (!gone) setLoadError(err.message)
      }
    })()
    return () => { gone = true }
  }, [])

  const format = FORMAT
  const size = SIZES[format]
  const scale = PREVIEW_HEIGHT / size.h
  const stageRef = useRef(null)
  const layers = style?.layouts?.[format]
  const image = style?.background?.image || null
  const piece = pieceOf(range, length, playheadPosition)
  const seconds = Math.round((piece.end - piece.start) * 10) / 10

  const setLayers = useCallback((fn) => {
    setStyle(s => ({ ...s, layouts: { ...s.layouts, [FORMAT]: fn(s.layouts[FORMAT]) } }))
  }, [])
  const setWaveType = (type) => {
    setStyle(s => {
      const next = { ...s, wave: { ...s.wave, type } }
      // a round one fills a square: square the box when coming from a straight one
      if (ROUND_WAVES.includes(type) && !ROUND_WAVES.includes(s.wave.type)) next.layouts = { ...s.layouts, [FORMAT]: squareWave(s.layouts[FORMAT], SIZES[FORMAT]) }
      return next
    })
  }
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
        const keep = ev.shiftKey || id === 'cover' || id === 'logo' || (id === 'wave' && ROUND_WAVES.includes(style.wave.type))
        setLayers(() => resizeLayer(base, id, corner, dx, dy, size, keep))
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
  // Turn with the handle over the box: around its middle (Shift: 15 degree steps)
  const startRotate = (e, id) => {
    if (e.button !== 0 || !stageRef.current) return
    e.preventDefault()
    e.stopPropagation()
    setSelected(id)
    const rect = stageRef.current.getBoundingClientRect()
    const base = layers
    const b = base[id]
    const cx = rect.left + (b.x + b.w / 2) * scale
    const cy = rect.top + (b.y + b.h / 2) * scale
    const onMove = (ev) => {
      const deg = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90
      setLayers(() => rotateLayer(base, id, deg, ev.shiftKey ? 15 : 0))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const nudge = (e) => {
    if (!selected || !layers) return
    if (e.key === '[' || e.key === ']') {
      e.preventDefault()
      const by = (e.key === ']' ? 1 : -1) * (e.shiftKey ? 15 : 1)
      setLayers(l => rotateLayer(l, selected, (l[selected].r || 0) + by, 0))
      return
    }
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

  // The first time: a tour of the studio (once its controls are there)
  const [firstTour, finishFirstTour] = useFirstTimeTour('3speak-audiogram-tour-done', !!(style && layers))
  const [tourAgain, setTourAgain] = useState(false) // the ? button
  const showTour = firstTour || tourAgain
  const finishTour = () => { finishFirstTour(); setTourAgain(false) }

  const busy = job?.status === 'processing'
  const order = layers ? stackOrder(layers) : []
  const pictureLayout = style?.background?.imageLayout || 'blur'
  // the picture card: only with a picture that is not filling the frame
  const hasCard = !!image && pictureLayout !== 'fill'
  const shown = (id) => layers?.[id] && layers[id].on !== false && (id !== 'cover' || hasCard)
  const chapterHere = (chapters || []).filter(c => c.at <= piece.start + 0.5).pop()

  return (
    <div className="remix-picker-overlay" onClick={busy || showTour ? undefined : onClose}>
      {showTour && <OnboardingTour steps={AUDIOGRAM_TOUR_STEPS} onComplete={finishTour} />}
      <div className="remix-picker audiogram-studio" role="dialog" aria-modal="true" aria-labelledby="audiogram-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          {style && layers ? (
            <button className="remix-picker-icon-btn" onClick={() => setTourAgain(true)} title="Show the tour again" aria-label="Show the audiogram tour again"><HelpCircle size={16} /></button>
          ) : <span className="remix-picker-icon-spacer" />}
          <h3 id="audiogram-title">Audiograms</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
        </div>

        {loadError && <p className="audio-template-error" role="alert">The audiogram settings could not be loaded: {loadError}</p>}
        {!style && !loadError && <p className="audio-template-intro"><Loader2 size={14} className="encoding-notice-spin" /> Loading your audiogram look…</p>}

        {style && layers && (
          <div className="audiogram-body">
            <div className="audiogram-stage-col">
              <div
                ref={stageRef}
                className="audiogram-stage"
                style={{ width: size.w * scale, height: size.h * scale }}
                tabIndex={0}
                onKeyDown={nudge}
                onPointerDown={() => setSelected(null)}
                aria-label="Audiogram preview: drag the parts to move them, the corners to resize, the round handle to turn"
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
                      title={`${name}: drag to move${selected === id ? ', corners to resize, the round handle to turn' : ''}`}
                      style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale, zIndex: id === 'logo' ? 30 : b.z + 1, transform: b.r ? `rotate(${b.r}deg)` : undefined }}
                      onPointerDown={(e) => startDrag(e, id)}
                    >
                      {selected === id && <span className="audiogram-box-name">{name}{b.r ? ` · ${b.r}°` : ''}</span>}
                      {selected === id && CORNERS.map(c => (
                        <span key={c} className={`audiogram-handle ${c}`} data-corner={c} onPointerDown={(e) => startDrag(e, id, c)} />
                      ))}
                      {selected === id && (
                        <span
                          className="audiogram-rotate"
                          data-rotate={id}
                          title="Turn (Shift: 15° steps). Double-click: straight"
                          onPointerDown={(e) => startRotate(e, id)}
                          onDoubleClick={(e) => { e.stopPropagation(); setLayers(l => rotateLayer(l, id, 0)) }}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="audiogram-stage-hint">
                Drag the parts, pull a corner to resize (Shift keeps the shape), the round handle to turn. Arrow keys nudge, [ and ] turn.{hasTemplate ? ' Your last audiogram is the starting point.' : ''}
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
                      <button key={p.id} role="radio" aria-checked={pictureLayout === p.id} className={pictureLayout === p.id ? 'active' : ''} title={p.hint} onClick={() => setStyle(s => ({ ...s, background: { ...s.background, imageLayout: p.id } }))}>{p.label}</button>
                    ))}
                  </div>
                )}
              </div>

              <div className="audiogram-field">
                <span>Waveform</span>
                <div className="noise-levels audiogram-wave-types" role="radiogroup" aria-label="Waveform type">
                  {WAVES.map(w => (
                    <button key={w.id} role="radio" aria-checked={style.wave.type === w.id} className={style.wave.type === w.id ? 'active' : ''} onClick={() => setWaveType(w.id)}>{w.label}</button>
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
                  {order.filter(id => id !== 'cover' || hasCard).map((id, i, list) => {
                    const meta = LAYERS.find(l => l.id === id)
                    if (id === 'logo') {
                      // always shown and in front: it can be moved, resized and turned only
                      return (
                        <li key={id} className={`audiogram-layer-locked${selected === id ? ' selected' : ''}`}>
                          <button className="audiogram-layer-name" onClick={() => setSelected(id)}>{meta.name}</button>
                          <span className="audiogram-layer-lock" title="The 3Speak logo is always shown, in front"><Lock size={12} /> Always shown</span>
                        </li>
                      )
                    }
                    const on = layers[id].on !== false
                    return (
                      <li key={id} className={selected === id ? 'selected' : ''}>
                        <button className="audiogram-layer-name" onClick={() => setSelected(id)}>{meta.name}</button>
                        <button className="audiogram-layer-btn" onClick={() => setLayers(l => toggleLayer(l, id))} aria-label={on ? `Hide ${meta.name}` : `Show ${meta.name}`} title={on ? 'Hide' : 'Show'}>{on ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                        <button className="audiogram-layer-btn" onClick={() => setLayers(l => restack(l, id, 1))} disabled={i <= 1} aria-label={`Bring ${meta.name} forward`} title="Forward"><ChevronUp size={14} /></button>
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
                    <strong>#{i + 1} · {chapterTime(a.start)} · {Math.round(a.duration)}s</strong>
                    {canBeShort(a) ? (
                      <button
                        className={`audiogram-post${a.post ? ' active' : ''}`}
                        aria-pressed={!!a.post}
                        onClick={() => onUpdateAudiogram(a.id, { post: !a.post })}
                      >
                        <Send size={13} /> Post together with the audio
                      </button>
                    ) : (
                      <small className="audiogram-note">Only vertical audiograms up to 2 minutes can go out as Shorts.</small>
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
