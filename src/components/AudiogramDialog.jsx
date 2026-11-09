import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Film, Download, Loader2, Eye, EyeOff, ChevronUp, ChevronDown, Upload, Trash2, Scissors, RotateCcw, Lock, HelpCircle, PenLine } from 'lucide-react'
import { api, getBackendUrl } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'
import { chapterTime } from '../utils/chapters'
import {
  SIZES, LAYERS, moveLayer, resizeLayer, rotateLayer, squareWave, restack, stackOrder, toggleLayer, withPicture, pieceOf,
  setLogoStyle, dragAngle, AUDIOGRAM_MAX_SECONDS, ROUND_WAVES
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
const LOGOS = [
  { id: 'mark', label: '3S logo' },
  { id: 'full', label: '3Speak logo' }
]
const CORNERS = ['nw', 'ne', 'sw', 'se']
const FORMAT = 'vertical' // the shape of a Short
const PREVIEW_HEIGHT = 520 // px
const TEXT_MAX = 5000

const absolute = (u) => {
  if (!u || !u.startsWith('/')) return u
  return new URL(u, getBackendUrl() || window.location.origin).href
}

// The look as the studio uses it: vertical, the picture as a card
const asLook = (s) => ({ ...s, format: FORMAT, background: { ...(s.background || {}), imageLayout: 'card' }, logo: s.logo === 'mark' ? 'mark' : 'full' })
const lookKey = (style, text) => JSON.stringify([style, text])

/**
 * Audiograms: short videos of pieces of the exported episode (moving waveform,
 * title, picture, the 3Speak branding) that go out as 3Speak Shorts together
 * with the episode, each linking to it.
 *
 * It goes step by step without a stepper: first the piece is picked on the
 * timeline, then the look shows. The preview is the backend's own page (GET
 * /api/audiogram/page), so what is shown is what gets made; its parts are
 * boxes to move, resize, turn and stack. The look of the last audiogram made
 * is the person's template (kept on the backend, /api/templates/audiogram).
 *
 * While the piece is picked the dialog stays mounted, only hidden (`hidden`),
 * so the look being worked on is not lost. Closing with a look that is not in
 * an audiogram yet asks first.
 */
export default function AudiogramDialog({
  outputUrl, length, title, chapters, range, onPickRange, hidden = false,
  audiograms, onAddAudiogram, onUpdateAudiogram, onRemoveAudiogram,
  playlistCovers, onRequestCovers, onEditText, onClose
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
  const [confirmClose, setConfirmClose] = useState(false)
  const [inlineText, setInlineText] = useState(null) // an audiogram's id: its text typed here (no 3Speak editor)
  const [editingText, setEditingText] = useState(null) // an audiogram's id: its text open in 3Speak's editor
  const savedLookRef = useRef(null)
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
        const look = asLook(tpl ? { duration: tpl.duration, wave: tpl.wave, background: tpl.background, line: tpl.line, logo: tpl.logo, layouts: tpl.layouts } : d.style)
        // a template from before the logo was fixed: it shows again (the backend does the same)
        const own = look.layouts?.[FORMAT] || d.style.layouts[FORMAT]
        look.layouts = { [FORMAT]: { ...own, logo: { ...own.logo, on: true } } }
        savedLookRef.current = lookKey(look, title || '')
        setStyle(look)
      } catch (err) {
        if (!gone) setLoadError(err.message)
      }
    })()
    return () => { gone = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const format = FORMAT
  const size = SIZES[format]
  const scale = PREVIEW_HEIGHT / size.h
  const stageRef = useRef(null)
  const layers = style?.layouts?.[format]
  const image = style?.background?.image || null
  const logoStyle = style?.logo || 'full'
  // Step by step: nothing else until a piece is picked
  const picked = !!(range && range.end != null && range.end - range.start >= 3)
  const piece = pieceOf(picked ? range : null, length, 0)
  const seconds = Math.round((piece.end - piece.start) * 10) / 10
  // The look is not in an audiogram yet (closing asks first)
  const dirty = !!style && savedLookRef.current !== null && lookKey(style, text) !== savedLookRef.current

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
  const setLogo = (logo) => {
    setStyle(s => (s.logo === logo ? s : { ...s, logo, layouts: { ...s.layouts, [FORMAT]: setLogoStyle(s.layouts[FORMAT], logo, SIZES[FORMAT]) } }))
  }
  const setImage = (url) => {
    setStyle(s => {
      const next = { ...s, background: { ...s.background, image: url, imageLayout: 'card' } }
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
    imageLayout: 'card',
    wave: style.wave,
    logo: logoStyle
  } : null), [style, layers, size, text, image, logoStyle])
  // A preview page that says it is ready gets the state at once: the frame is
  // made anew whenever the studio shows again (after picking the piece), and
  // the new one must not wait for the next change.
  const pageStateRef = useRef(null)
  pageStateRef.current = pageState
  useEffect(() => {
    const onMsg = (e) => {
      if (e.source !== frameRef.current?.contentWindow || e.data?.type !== 'audiogram-page-ready') return
      setFrameReady(true)
      if (pageStateRef.current) e.source.postMessage({ type: 'audiogram-state', state: pageStateRef.current }, '*')
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
        setLayers(() => resizeLayer(base, id, corner, dx, dy, size, keep, logoStyle))
      } else {
        const r = moveLayer(base, id, dx, dy, size, !ev.altKey, logoStyle)
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
  // Turn with the round handle, around the part's middle: by how far the
  // pointer goes round from where it was pressed (Shift: 15 degree steps)
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
    const angleAt = (ev) => (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI
    const start = angleAt(e)
    const onMove = (ev) => {
      setLayers(() => rotateLayer(base, id, dragAngle(b.r, start, angleAt(ev)), ev.shiftKey ? 15 : 0))
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
    setLayers(l => moveLayer(l, selected, d[0], d[1], size, false, logoStyle).layers)
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
    setLayers(() => (logoStyle === 'full' ? fresh : setLogoStyle(fresh, logoStyle, size)))
  }

  const make = async () => {
    clearInterval(pollRef.current)
    setJob({ status: 'processing', progress: 0, phase: 'Starting...' })
    const used = { ...style, duration: Math.round(seconds) }
    const usedKey = lookKey(style, text)
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
            savedLookRef.current = usedKey // that look is in an audiogram now
            onAddAudiogram({
              id: data.jobId,
              url: absolute(st.outputUrl),
              format,
              start: piece.start,
              duration: seconds,
              title: text,
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

  // An audiogram's text for its Short: in 3Speak's own post editor, else typed here
  const editText = async (a) => {
    if (!onEditText) { setInlineText(a.id); return }
    setEditingText(a.id)
    const r = await onEditText(a.description || '', { kind: 'short-text', maxLength: TEXT_MAX })
    setEditingText(null)
    if (r?.unsupported) setInlineText(a.id)
    else if (typeof r?.value === 'string') onUpdateAudiogram(a.id, { description: r.value })
  }

  // The first time: a tour of the studio (once its controls show, after the piece is picked)
  const [firstTour, finishFirstTour] = useFirstTimeTour('3speak-audiogram-tour-done', !!(style && layers && picked && !hidden))
  const [tourAgain, setTourAgain] = useState(false) // the ? button
  const showTour = (firstTour || tourAgain) && !hidden
  const finishTour = () => { finishFirstTour(); setTourAgain(false) }

  const busy = job?.status === 'processing'
  const requestClose = () => {
    if (busy) return
    if (dirty) setConfirmClose(true)
    else onClose()
  }
  const order = layers ? stackOrder(layers) : []
  const hasCard = !!image
  const shown = (id) => layers?.[id] && layers[id].on !== false && (id !== 'cover' || hasCard)
  const chapterHere = (chapters || []).filter(c => c.at <= piece.start + 0.5).pop()

  return (
    <div className="remix-picker-overlay" style={hidden ? { display: 'none' } : undefined} onClick={busy || showTour || confirmClose ? undefined : requestClose}>
      {showTour && <OnboardingTour steps={AUDIOGRAM_TOUR_STEPS} onComplete={finishTour} />}
      <div className="remix-picker audiogram-studio" role="dialog" aria-modal="true" aria-labelledby="audiogram-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          {style && layers && picked ? (
            <button className="remix-picker-icon-btn" onClick={() => setTourAgain(true)} title="Show the tour again" aria-label="Show the audiogram tour again"><HelpCircle size={16} /></button>
          ) : <span className="remix-picker-icon-spacer" />}
          <h3 id="audiogram-title">Audiograms</h3>
          <button className="remix-picker-icon-btn" onClick={requestClose} title="Close" disabled={busy}><X size={16} /></button>
        </div>

        {loadError && <p className="audio-template-error" role="alert">The audiogram settings could not be loaded: {loadError}</p>}
        {!style && !loadError && <p className="audio-template-intro"><Loader2 size={14} className="encoding-notice-spin" /> Loading your audiogram look…</p>}

        {/* First the piece: nothing else until it is picked */}
        {style && layers && !picked && (
          <div className="audiogram-start" data-testid="audiogram-start">
            <Scissors size={22} aria-hidden="true" />
            <h4>Pick a piece of the episode</h4>
            <p>An audiogram is a short video of a piece of your episode, up to {AUDIOGRAM_MAX_SECONDS / 60} minutes. It goes out as a 3Speak Short together with the audio. Start by marking its start and end on the timeline.</p>
            <button className="silence-cut-apply audiogram-pick" onClick={onPickRange}>
              <Scissors size={14} /> Choose on the timeline
            </button>
          </div>
        )}

        {style && layers && picked && (
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
                  <Scissors size={14} /> Change the piece
                </button>
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
                <span>3Speak branding</span>
                <div className="noise-levels" role="radiogroup" aria-label="Logo">
                  {LOGOS.map(l => (
                    <button key={l.id} role="radio" aria-checked={logoStyle === l.id} className={logoStyle === l.id ? 'active' : ''} onClick={() => setLogo(l.id)}>{l.label}</button>
                  ))}
                </div>
              </div>

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
                      // always shown, in front, never under its minimum size: it can be moved, resized and turned only
                      return (
                        <li key={id} className={`audiogram-layer-locked${selected === id ? ' selected' : ''}`}>
                          <button className="audiogram-layer-name" onClick={() => setSelected(id)}>{meta.name}</button>
                          <span className="audiogram-layer-lock" title="The 3Speak logo is always shown, in front, and never smaller than a set size"><Lock size={12} /> Always shown</span>
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
            <p className="audiogram-made-hint">They go out as 3Speak Shorts together with the audio, each with a link to the audio’s post, snap or comment.</p>
            <ul>
              {audiograms.map((a, i) => (
                <li key={a.id} className="audiogram-made-item" data-testid="audiogram-item">
                  <video className={`audiogram-preview ${a.format}`} src={a.url} controls playsInline preload="metadata" />
                  <div className="audiogram-made-info">
                    <strong className="audiogram-made-title">{a.title || `Audiogram ${i + 1}`}</strong>
                    <small className="audiogram-note">{chapterTime(a.start)} · {Math.round(a.duration)}s</small>
                    {inlineText === a.id ? (
                      <textarea
                        className="audiogram-desc"
                        rows={4}
                        maxLength={TEXT_MAX}
                        autoFocus
                        placeholder="Text for the Short (optional). A link to the audio is added for you."
                        value={a.description}
                        onChange={(e) => onUpdateAudiogram(a.id, { description: e.target.value })}
                        onBlur={() => setInlineText(null)}
                        aria-label={`Text for Short ${i + 1}`}
                      />
                    ) : (
                      <button
                        type="button"
                        className={`audiogram-desc audiogram-desc-box${a.description ? '' : ' empty'}`}
                        onClick={() => editText(a)}
                        disabled={editingText === a.id}
                        aria-label={`Text for Short ${i + 1}`}
                        data-testid="audiogram-text"
                      >
                        <span className="audiogram-desc-text">{a.description || 'Text for the Short (optional). A link to the audio is added for you.'}</span>
                        <span className="audiogram-desc-edit">{editingText === a.id ? <Loader2 size={12} className="encoding-notice-spin" /> : <PenLine size={12} />} {a.description ? 'Edit text' : 'Write text'}</span>
                      </button>
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

        {/* Closing with a look that is not in an audiogram yet */}
        {confirmClose && (
          <div className="audiogram-confirm" role="alertdialog" aria-modal="true" aria-labelledby="audiogram-confirm-title">
            <div className="audiogram-confirm-card">
              <h4 id="audiogram-confirm-title">Close without making it?</h4>
              <p>Your changes to the look are not in an audiogram yet. They are lost when you close.</p>
              <div className="audiogram-confirm-actions">
                <button className="compact-btn audiogram-confirm-keep" onClick={() => setConfirmClose(false)} autoFocus>Keep editing</button>
                <button className="compact-render-btn" onClick={() => { setConfirmClose(false); onClose() }}>Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
