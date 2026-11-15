import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Film, Download, Loader2, Eye, EyeOff, ChevronUp, ChevronDown, Upload, Trash2, Scissors, RotateCcw, Lock, HelpCircle, PenLine, Check } from './icons'
import { api, getBackendUrl } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'
import { chapterTime } from '../utils/chapters'
import {
  SIZES, LAYERS, moveLayer, resizeLayer, rotateLayer, squareWave, restack, stackOrder, toggleLayer, withPicture, pieceOf,
  setLogoStyle, dragAngle, AUDIOGRAM_MAX_SECONDS, ROUND_WAVES
} from '../utils/audiogramLayers'
import OnboardingTour, { AUDIOGRAM_TOUR_STEPS, useFirstTimeTour } from './OnboardingTour'
import { AudiogramCaptionsLayer, AudiogramCaptionsField } from './AudiogramCaptions'
import { cleanAudiogramCaptionLook, captionBox, clampCaptionBox } from '../utils/audiogramCaptions'
import { useAudiogramCaptions } from '../hooks/useAudiogramCaptions'
import { useT } from '../i18n'

// labels: t(`audiogram.wave.${id}`) / t(`audiogram.logo.${id}`)
const WAVES = ['bars', 'centered', 'line', 'dots', 'circle', 'ring'].map(id => ({ id, labelKey: `audiogram.wave.${id}` }))
// The 3Speak red, white, the navy lightened for the dark background (no cyan)
const COLORS = ['#e32933', '#f4f5f8', '#7f88ea']
const LOGOS = [
  { id: 'mark', labelKey: 'audiogram.logo.mark' },
  { id: 'full', labelKey: 'audiogram.logo.full' }
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
  const { t, tRich } = useT()
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
        const look = asLook(tpl ? { duration: tpl.duration, wave: tpl.wave, background: tpl.background, line: tpl.line, logo: tpl.logo, layouts: tpl.layouts, captions: tpl.captions } : d.style)
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
  // Captions (utils/audiogramCaptions.js): their look in the style, their box kept clear of the logo
  const capLook = useMemo(() => cleanAudiogramCaptionLook(style?.captions), [style?.captions])
  const capBox = useMemo(() => (layers ? captionBox(capLook, format, size, layers) : null), [capLook, format, size, layers])
  const setCapLook = (patch) => setStyle(s => ({ ...s, captions: { ...cleanAudiogramCaptionLook(s.captions), ...patch } }))
  const ag = useAudiogramCaptions({ outputUrl, piece })
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
    if (selected === 'captions') {
      const step = e.shiftKey ? 10 : 1
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
      if (d && capBox) {
        e.preventDefault()
        setCapLook({ boxes: { ...capLook.boxes, [format]: clampCaptionBox({ ...capBox, x: capBox.x + d[0], y: capBox.y + d[1] }, capLook, size) } })
      }
      return
    }
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
      setJob({ status: 'failed', error: err?.code === 'sign-in' ? t('audiogram.picture.signIn') : err.message })
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
    setJob({ status: 'processing', progress: 0, phase: t('audiogram.make.starting') })
    const used = { ...style, duration: Math.round(seconds) }
    const usedKey = lookKey(style, text)
    try {
      // captions on: the piece's words (listened to first when they are not there yet)
      const words = capLook.on ? (ag.ready ? ag.words : await ag.transcribe()) : null
      if (capLook.on && !words) throw new Error(t('audiogram.make.noWords'))
      setJob({ status: 'processing', progress: 0, phase: t('audiogram.make.starting') })
      const res = await authFetch(api('/api/audiogram'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: outputUrl, start: piece.start, duration: seconds, format, title: text, style: used, ...(words?.length ? { captions: { words, language: ag.language } } : {}) })
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
            setJob({ status: 'failed', error: st.error || t('audiogram.make.failedPlain') })
          } else {
            setJob(st)
          }
        } catch {}
      }, 1000)
    } catch (err) {
      setJob({ status: 'failed', error: err?.code === 'sign-in' ? t('audiogram.make.signIn') : err.message })
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
  // Save and close (there is at least one audiogram): the audiograms stay with
  // this audio anyway; the look as it is now becomes the template for the next
  const saveAndClose = () => {
    if (busy) return
    if (dirty && style) {
      authFetch(api('/api/templates/audiogram'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: { ...style, duration: Math.round(seconds) || style.duration } })
      }).catch(() => {})
    }
    onClose()
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
            <button className="remix-picker-icon-btn" onClick={() => setTourAgain(true)} title={t('audiogram.tour.again')} aria-label={t('audiogram.tour.againLabel')}><HelpCircle size={16} /></button>
          ) : <span className="remix-picker-icon-spacer" />}
          <h3 id="audiogram-title">{t('audiogram.title')}</h3>
          <div className="audiogram-header-actions">
            {audiograms.length > 0 && (
              <button className="compact-render-btn audiogram-save-close" onClick={saveAndClose} disabled={busy} title={t('audiogram.saveAndCloseTitle')}>
                <Check size={14} /> {t('audiogram.saveAndClose')}
              </button>
            )}
            <button className="remix-picker-icon-btn" onClick={requestClose} title={t('common.close')} disabled={busy}><X size={16} /></button>
          </div>
        </div>

        {loadError && <p className="audio-template-error" role="alert">{t('audiogram.loadError', { error: loadError })}</p>}
        {!style && !loadError && <p className="audio-template-intro"><Loader2 size={14} className="encoding-notice-spin" /> {t('audiogram.loadingLook')}</p>}

        {/* First the piece: nothing else until it is picked */}
        {style && layers && !picked && (
          <div className="audiogram-start" data-testid="audiogram-start">
            <Scissors size={22} aria-hidden="true" />
            <h4>{t('audiogram.start.title')}</h4>
            <p>{t('audiogram.start.text', { count: AUDIOGRAM_MAX_SECONDS / 60 })}</p>
            <button className="silence-cut-apply audiogram-pick" onClick={onPickRange}>
              <Scissors size={14} /> {t('audiogram.start.choose')}
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
                aria-label={t('audiogram.stage.label')}
              >
                <iframe
                  ref={frameRef}
                  title={t('audiogram.stage.frameTitle')}
                  src={api('/api/audiogram/page')}
                  sandbox="allow-scripts"
                  width={size.w}
                  height={size.h}
                  style={{ transform: `scale(${scale})` }}
                />
                {guide === 'x' && <div className="audiogram-guide" />}
                {capLook.on && capBox && (
                  <AudiogramCaptionsLayer
                    look={capLook}
                    box={capBox}
                    size={size}
                    scale={scale}
                    words={ag.words}
                    selected={selected === 'captions'}
                    onSelect={() => setSelected('captions')}
                    onBox={(b) => setCapLook({ boxes: { ...capLook.boxes, [format]: b } })}
                  />
                )}
                {LAYERS.filter(l => shown(l.id)).map(({ id }) => {
                  const b = layers[id]
                  const name = t(`audiogram.layer.${id}.name`)
                  return (
                    <div
                      key={id}
                      className={`audiogram-box${selected === id ? ' selected' : ''}`}
                      data-layer={id}
                      title={selected === id ? t(`audiogram.layer.${id}.dragSelected`) : t(`audiogram.layer.${id}.drag`)}
                      style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale, zIndex: id === 'logo' ? 30 : b.z + 1, transform: b.r ? `rotate(${b.r}deg)` : undefined }}
                      onPointerDown={(e) => startDrag(e, id)}
                    >
                      {selected === id && <span className="audiogram-box-name">{b.r ? t('audiogram.stage.turned', { name, angle: b.r }) : name}</span>}
                      {selected === id && CORNERS.map(c => (
                        <span key={c} className={`audiogram-handle ${c}`} data-corner={c} onPointerDown={(e) => startDrag(e, id, c)} />
                      ))}
                      {selected === id && (
                        <span
                          className="audiogram-rotate"
                          data-rotate={id}
                          title={t('audiogram.stage.rotate')}
                          onPointerDown={(e) => startRotate(e, id)}
                          onDoubleClick={(e) => { e.stopPropagation(); setLayers(l => rotateLayer(l, id, 0)) }}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="audiogram-stage-hint">
                {hasTemplate ? t('audiogram.stage.hintTemplate') : t('audiogram.stage.hint')}
              </p>
            </div>

            <div className="audiogram-controls">
              <div className="audiogram-field">
                <span>{t('audiogram.piece.label')}</span>
                <div className="audiogram-piece">
                  <strong data-testid="audiogram-piece">{t('audiogram.piece.range', { from: chapterTime(piece.start), to: chapterTime(piece.end), seconds: Math.round(seconds) })}</strong>
                  {chapterHere && <small>{t('audiogram.piece.inChapter', { title: chapterHere.title })}</small>}
                </div>
                <button className="silence-cut-apply audiogram-pick" onClick={onPickRange} disabled={busy}>
                  <Scissors size={14} /> {t('audiogram.piece.change')}
                </button>
              </div>

              <label className="audiogram-field">
                <span>{t('audiogram.look.title')}</span>
                <input value={text} maxLength={120} onChange={(e) => setText(e.target.value)} aria-label={t('audiogram.look.titleLabel')} />
              </label>
              <label className="audiogram-field">
                <span>{tRich('audiogram.look.line', null, { small: <small /> })}</span>
                <input value={style.line} maxLength={120} onChange={(e) => { const v = e.target.value; setStyle(s => ({ ...s, line: v })) }} aria-label={t('audiogram.look.lineLabel')} />
              </label>

              <div className="audiogram-field">
                <span>{t('audiogram.look.branding')}</span>
                <div className="noise-levels" role="radiogroup" aria-label={t('audiogram.look.logoGroup')}>
                  {LOGOS.map(l => (
                    <button key={l.id} role="radio" aria-checked={logoStyle === l.id} className={logoStyle === l.id ? 'active' : ''} onClick={() => setLogo(l.id)}>{t(l.labelKey)}</button>
                  ))}
                </div>
              </div>

              <div className="audiogram-field">
                <span>{t('audiogram.look.picture')}</span>
                <div className="audiogram-pictures" role="radiogroup" aria-label={t('audiogram.look.picture')}>
                  <button role="radio" aria-checked={!image} className={`audiogram-pic none${!image ? ' active' : ''}`} onClick={() => setImage(null)}>{t('common.none')}</button>
                  <button className="audiogram-pic upload" onClick={() => fileRef.current?.click()} disabled={uploading} title={t('audiogram.picture.upload')}>
                    {uploading ? <Loader2 size={16} className="encoding-notice-spin" /> : <Upload size={16} />}
                  </button>
                  {image && !(playlistCovers || []).some(c => c.url === image) && (
                    <button role="radio" aria-checked className="audiogram-pic active" title={t('audiogram.picture.yours')}><img src={image} alt="" /></button>
                  )}
                  {(playlistCovers || []).map(c => (
                    <button key={c.url} role="radio" aria-checked={image === c.url} className={`audiogram-pic${image === c.url ? ' active' : ''}`} title={c.title ? t('audiogram.picture.coverOf', { title: c.title }) : t('audiogram.picture.playlistCover')} onClick={() => setImage(c.url)}>
                      <img src={c.url} alt="" loading="lazy" />
                    </button>
                  ))}
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
                </div>
                {playlistCovers && playlistCovers.length === 0 && <small className="audiogram-note">{t('audiogram.picture.noCovers')}</small>}
              </div>

              <div className="audiogram-field">
                <span>{t('audiogram.look.waveform')}</span>
                <div className="noise-levels audiogram-wave-types" role="radiogroup" aria-label={t('audiogram.look.waveType')}>
                  {WAVES.map(w => (
                    <button key={w.id} role="radio" aria-checked={style.wave.type === w.id} className={style.wave.type === w.id ? 'active' : ''} onClick={() => setWaveType(w.id)}>{t(w.labelKey)}</button>
                  ))}
                </div>
                <div className="audiogram-colors" role="radiogroup" aria-label={t('audiogram.look.waveColour')}>
                  {COLORS.map(c => (
                    <button key={c} role="radio" aria-checked={style.wave.color === c} aria-label={t('audiogram.look.colour', { colour: c })} className={`audiogram-swatch${style.wave.color === c ? ' active' : ''}`} style={{ background: c }} onClick={() => setStyle(s => ({ ...s, wave: { ...s.wave, color: c } }))} />
                  ))}
                  <label className={`audiogram-swatch custom${!COLORS.includes(style.wave.color) ? ' active' : ''}`} title={t('audiogram.look.anyColour')} style={{ background: COLORS.includes(style.wave.color) ? undefined : style.wave.color }}>
                    <input type="color" value={style.wave.color} aria-label={t('audiogram.look.anyWaveColour')} onChange={(e) => { const v = e.target.value; setStyle(s => ({ ...s, wave: { ...s.wave, color: v } })) }} />
                  </label>
                </div>
              </div>

              <AudiogramCaptionsField look={capLook} onChange={setCapLook} ag={ag} disabled={busy} />

              <div className="audiogram-field">
                <span>{tRich('audiogram.parts.title', null, { small: <small /> })}</span>
                <ul className="audiogram-layers">
                  {order.filter(id => id !== 'cover' || hasCard).map((id, i, list) => {
                    if (id === 'logo') {
                      // always shown, in front, never under its minimum size: it can be moved, resized and turned only
                      return (
                        <li key={id} className={`audiogram-layer-locked${selected === id ? ' selected' : ''}`}>
                          <button className="audiogram-layer-name" onClick={() => setSelected(id)}>{t(`audiogram.layer.${id}.name`)}</button>
                          <span className="audiogram-layer-lock" title={t('audiogram.parts.logoLocked')}><Lock size={12} /> {t('audiogram.parts.alwaysShown')}</span>
                        </li>
                      )
                    }
                    const on = layers[id].on !== false
                    return (
                      <li key={id} className={selected === id ? 'selected' : ''}>
                        <button className="audiogram-layer-name" onClick={() => setSelected(id)}>{t(`audiogram.layer.${id}.name`)}</button>
                        <button className="audiogram-layer-btn" onClick={() => setLayers(l => toggleLayer(l, id))} aria-label={on ? t(`audiogram.layer.${id}.hide`) : t(`audiogram.layer.${id}.show`)} title={on ? t('audiogram.parts.hide') : t('audiogram.parts.show')}>{on ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                        <button className="audiogram-layer-btn" onClick={() => setLayers(l => restack(l, id, 1))} disabled={i <= 1} aria-label={t(`audiogram.layer.${id}.forward`)} title={t('audiogram.parts.forward')}><ChevronUp size={14} /></button>
                        <button className="audiogram-layer-btn" onClick={() => setLayers(l => restack(l, id, -1))} disabled={i === list.length - 1} aria-label={t(`audiogram.layer.${id}.back`)} title={t('audiogram.parts.back')}><ChevronDown size={14} /></button>
                      </li>
                    )
                  })}
                </ul>
                <button className="audiogram-reset" onClick={resetArrangement}><RotateCcw size={12} /> {t('audiogram.parts.tidy')}</button>
              </div>

              {busy && (
                <div className="compact-render-progress" role="status">
                  <div className="compact-render-progress-bar"><div className="compact-render-progress-fill" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div>
                  <span className="compact-render-progress-text">{job.phase || t('audiogram.make.working')}</span>
                </div>
              )}
              {job?.status === 'failed' && <p className="audio-template-error" role="alert">{t('audiogram.make.failed', { error: job.error })}</p>}
              <button className="silence-cut-apply audiogram-make" onClick={make} disabled={busy || length < 3 || seconds < 3}>
                {busy ? <Loader2 size={14} className="encoding-notice-spin" /> : <Film size={14} />} {audiograms.length ? t('audiogram.make.another') : t('audiogram.make.make')}
              </button>
            </div>
          </div>
        )}

        {audiograms.length > 0 && (
          <div className="audiogram-made">
            <h4>{t('audiogram.made.title')}</h4>
            <p className="audiogram-made-hint">{t('audiogram.made.hint')}</p>
            <ul>
              {audiograms.map((a, i) => (
                <li key={a.id} className="audiogram-made-item" data-testid="audiogram-item">
                  <video className={`audiogram-preview ${a.format}`} src={a.url} controls playsInline preload="metadata" />
                  <div className="audiogram-made-info">
                    <strong className="audiogram-made-title">{a.title || t('audiogram.made.fallbackTitle', { n: i + 1 })}</strong>
                    <small className="audiogram-note">{t('audiogram.made.length', { at: chapterTime(a.start), seconds: Math.round(a.duration) })}</small>
                    {inlineText === a.id ? (
                      <textarea
                        className="audiogram-desc"
                        rows={4}
                        maxLength={TEXT_MAX}
                        autoFocus
                        placeholder={t('audiogram.made.textPlaceholder')}
                        value={a.description}
                        onChange={(e) => onUpdateAudiogram(a.id, { description: e.target.value })}
                        onBlur={() => setInlineText(null)}
                        aria-label={t('audiogram.made.textLabel', { n: i + 1 })}
                      />
                    ) : (
                      <button
                        type="button"
                        className={`audiogram-desc audiogram-desc-box${a.description ? '' : ' empty'}`}
                        onClick={() => editText(a)}
                        disabled={editingText === a.id}
                        aria-label={t('audiogram.made.textLabel', { n: i + 1 })}
                        data-testid="audiogram-text"
                      >
                        <span className="audiogram-desc-text">{a.description || t('audiogram.made.textPlaceholder')}</span>
                        <span className="audiogram-desc-edit">{editingText === a.id ? <Loader2 size={12} className="encoding-notice-spin" /> : <PenLine size={12} />} {a.description ? t('audiogram.made.editText') : t('audiogram.made.writeText')}</span>
                      </button>
                    )}
                    <div className="audiogram-made-actions">
                      <a className="audiogram-layer-btn" href={a.url} download target="_blank" rel="noopener noreferrer" title={t('audiogram.made.download')}><Download size={14} /></a>
                      <button className="audiogram-layer-btn" onClick={() => onRemoveAudiogram(a.id)} title={t('common.remove')} aria-label={t('audiogram.made.removeLabel', { n: i + 1 })}><Trash2 size={14} /></button>
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
              <h4 id="audiogram-confirm-title">{t('audiogram.confirm.title')}</h4>
              <p>
                {t('audiogram.confirm.text')}
                {audiograms.length > 0 && <> {t('audiogram.confirm.stays', { count: audiograms.length })}</>}
              </p>
              <div className="audiogram-confirm-actions">
                <button className="compact-btn audiogram-confirm-keep" onClick={() => setConfirmClose(false)} autoFocus>{t('audiogram.confirm.keep')}</button>
                <button className="compact-render-btn" onClick={() => { setConfirmClose(false); onClose() }}>{t('common.close')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
