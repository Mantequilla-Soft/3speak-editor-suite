import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Play, Pause, SkipBack, Plus, Copy, Trash2, ChevronUp, ChevronDown, Upload, Music, AudioLines, Download, X, Check, Loader2, Search, FolderOpen, Cloud, CloudOff, FilePlus2 } from 'lucide-react'
import { selectBackend, api } from '../utils/backendSelector'
import MusicLibrary from '../components/MusicLibrary'
import ScenePreview from './ScenePreview'
import AdTimeline from './AdTimeline'
import { Fields, ImageField } from './FieldEditor'
import PreviewAudio from './previewAudio'
import useAdDrafts from './useAdDrafts'
import { loadEngine, toDoc, autoSfx, defaultState, newId, FORMATS, FONTS, COLOR_PRESETS, ROLES, SCENES_BASE, uploadFile, absUrl, pollJob } from './engine'
import './adwizard.css'

// The Ad Wizard: the editor's second entry mode (?mode=ads). Builds an ad from the scene engine's scenes,
// a brand kit, pictures, music and sound effects, and renders it on the editor's backends.
// The Shorts editor (App.jsx) is not touched by any of this.
//
// Layout: left = steps + the step's controls, centre = preview, transport, timeline, right = properties of
// what is selected (a scene, or a sound effect).
//
// URL (set by the 3Speak page that opens us): ?mode=ads[&format=landscape|portrait][&max=<seconds>][&target=booking]
//   format  locks the ad's shape (a booking knows which placement it bought)
//   max     longest ad allowed (the booked length)
//   target=booking  the finished ad gets a "Use for my campaign" button (posts 'ad-use' to the page)

const STORE = 'adwizard:v1'
const STEPS = [
  { key: 'format', label: 'Format' },
  { key: 'brand', label: 'Brand' },
  { key: 'scenes', label: 'Scenes' },
  { key: 'sound', label: 'Sound' },
  { key: 'render', label: 'Render' },
]
const PARAMS = new URLSearchParams(window.location.search)
const LOCKED_FORMAT = ['landscape', 'portrait'].includes(PARAMS.get('format')) ? PARAMS.get('format') : null
const MAX_AD_SECONDS = Math.max(5, Math.min(120, +PARAMS.get('max') || 60))
const FOR_BOOKING = PARAMS.get('target') === 'booking'
const post = msg => { if (window.parent !== window) window.parent.postMessage({ source: '3speak-editor', ...msg }, '*') }
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16)))

function reducer(s, a) {
  switch (a.type) {
    case 'load': return a.state
    case 'set': return { ...s, ...a.patch }
    case 'brand': return { ...s, brand: { ...s.brand, ...a.patch } }
    case 'colors': return { ...s, brand: { ...s.brand, colors: { ...s.brand.colors, ...a.patch } } }
    case 'scene': return { ...s, scenes: s.scenes.map((x, i) => (i === a.i ? { ...a.scene, id: x.id, type: x.type, duration: a.scene.duration ?? x.duration } : x)) }
    case 'duration': return { ...s, scenes: s.scenes.map((x, i) => (i === a.i ? { ...x, duration: a.d } : x)) }
    case 'addScene': { const sc = [...s.scenes]; sc.splice(a.at, 0, a.scene); return { ...s, scenes: sc } }
    case 'removeScene': return { ...s, scenes: s.scenes.filter((_, i) => i !== a.i) }
    case 'moveScene': { const sc = [...s.scenes]; const [x] = sc.splice(a.i, 1); sc.splice(a.to, 0, x); return { ...s, scenes: sc } }
    case 'music': return { ...s, music: a.music ? { ...(s.music || {}), ...a.music } : null }
    case 'sfx': return { ...s, sfx: { ...s.sfx, ...a.patch } }
    default: return s
  }
}

const freshState = () => {
  const s = defaultState()
  if (LOCKED_FORMAT) s.format = LOCKED_FORMAT
  return s
}

export default function AdWizard() {
  const [state, dispatch] = useReducer(reducer, null, () => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE))
      if (saved?.version === 1) return LOCKED_FORMAT ? { ...saved, format: LOCKED_FORMAT } : saved
    } catch { /* fresh start */ }
    return freshState()
  })
  const [meta, setMeta] = useState(null)
  const [step, setStep] = useState('format')
  const [selected, setSelected] = useState(0)
  const [focus, setFocus] = useState('scene') // what the right panel shows: 'scene' | 'sfx'
  const [info, setInfo] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selectedSfx, setSelectedSfx] = useState(null)
  const [picker, setPicker] = useState(false)
  const previewRef = useRef(null)
  const audioRef = useRef(new PreviewAudio())
  const playRef = useRef(null)
  const drafts = useAdDrafts()

  useEffect(() => { loadEngine().then(setMeta).catch(e => setPreviewError(e.message)); selectBackend() }, [])
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(state)) } catch { /* private mode */ } }, [state])
  // the 3Speak page that opened us: ready (+ drafts handshake), theme, close, brand prefill
  useEffect(() => {
    if (window.parent === window) return undefined
    post({ type: 'editor-ready', mode: 'ads', canSaveDrafts: true })
    const onMsg = e => {
      if (e.source !== window.parent || e.data?.source === '3speak-editor') return
      const d = e.data || {}
      if (d.type === 'request-close') post({ type: 'close-decision', close: true })
      if (d.type === 'set-theme') document.documentElement.setAttribute('data-theme', d.theme === 'dark' ? 'dark' : 'light')
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  // 'ad-prefill' { brand: { name, logo } } from a booking fills the brand kit while it is still the default one
  const prefillRef = useRef(false)
  useEffect(() => {
    const onMsg = e => {
      if (e.source !== window.parent || e.data?.type !== 'ad-prefill' || prefillRef.current) return
      prefillRef.current = true
      const b = e.data.brand || {}
      if (state.brand.name === defaultState().brand.name) dispatch({ type: 'brand', patch: { ...(b.name ? { name: String(b.name).slice(0, 40) } : {}), ...(b.logo && !state.brand.logo ? { logo: b.logo } : {}) } })
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [state.brand.name, state.brand.logo])

  const doc = useMemo(() => (meta ? toDoc(state, meta) : null), [state, meta])
  const sfxAll = useMemo(() => [
    ...autoSfx(info?.cues, state.sfx),
    ...state.sfx.clips.map(c => ({ ...c, url: absUrl(c.url) })),
  ].sort((a, b) => a.at - b.at), [info, state.sfx])
  const duration = info?.duration || 0
  const music = state.music ? { ...state.music, url: absUrl(state.music.url) } : null

  useEffect(() => { audioRef.current.set({ music, sfx: sfxAll }) }, [music?.url, sfxAll]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- server drafts: autosave 3 s after the last change once signed in ----
  const [saveState, setSaveState] = useState('idle') // idle | saving | saved | error | limit
  const [limitDrafts, setLimitDrafts] = useState(null)
  const lastSaved = useRef(null)
  const saveNow = useCallback(async (replace) => {
    if (!drafts.session || !state.scenes.length) return
    const id = state.draftId || uuid()
    const name = state.name || `${state.brand.name || 'Ad'} ${new Date().toISOString().slice(0, 10)}`
    const snapshot = { ...state, draftId: id, name }
    setSaveState('saving')
    try {
      await drafts.save(id, name, snapshot, replace)
      lastSaved.current = JSON.stringify(snapshot)
      if (!state.draftId || !state.name) dispatch({ type: 'set', patch: { draftId: id, name } })
      setSaveState('saved'); setLimitDrafts(null)
    } catch (e) {
      if (e.status === 409 && e.body?.error === 'limit') { setSaveState('limit'); setLimitDrafts(e.body.drafts) }
      else setSaveState('error')
    }
  }, [drafts, state])
  useEffect(() => {
    if (!drafts.session || saveState === 'limit' || !state.scenes.length) return undefined
    if (lastSaved.current === JSON.stringify({ ...state, draftId: state.draftId, name: state.name })) return undefined
    const id = setTimeout(() => saveNow(), 3000)
    return () => clearTimeout(id)
  }, [state, drafts.session]) // eslint-disable-line react-hooks/exhaustive-deps
  const [draftsOpen, setDraftsOpen] = useState(false)
  const openDraft = async id => {
    const d = await drafts.load(id)
    const s = { ...d.state, draftId: d.id, name: d.name }
    if (LOCKED_FORMAT) s.format = LOCKED_FORMAT
    lastSaved.current = JSON.stringify(s)
    dispatch({ type: 'load', state: s }); setSelected(0); setDraftsOpen(false); setStep('scenes')
  }
  const newAd = () => { dispatch({ type: 'load', state: freshState() }); lastSaved.current = null; setSelected(0); setStep('format'); setDraftsOpen(false) }

  // ---- transport ----
  const seek = useCallback(t => {
    const v = Math.max(0, Math.min(duration || 0, t))
    setTime(v); previewRef.current?.seek(v)
  }, [duration])
  const stop = useCallback(() => {
    cancelAnimationFrame(playRef.current?.raf); playRef.current = null
    audioRef.current.stop(); setPlaying(false)
  }, [])
  const play = useCallback(async () => {
    if (!duration) return
    const from = time >= duration - 0.05 ? 0 : time
    audioRef.current.set({ music, sfx: sfxAll })
    const t0 = await audioRef.current.play(from, duration)
    setPlaying(true)
    const tick = () => {
      const t = audioRef.current.now(t0, from)
      if (t >= duration) { seek(duration); stop(); return }
      previewRef.current?.seek(t); setTime(t)
      playRef.current = { raf: requestAnimationFrame(tick) }
    }
    playRef.current = { raf: requestAnimationFrame(tick) }
  }, [duration, time, music, sfxAll, seek, stop])
  useEffect(() => stop, [stop])
  useEffect(() => { if (playRef.current) stop() }, [state]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = e => {
      if (e.code !== 'Space' || /input|textarea|select/i.test(e.target.tagName)) return
      e.preventDefault(); playing ? stop() : play()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [playing, play, stop])

  const selectScene = i => {
    setSelected(i); setFocus('scene')
    const s = info?.scenes?.[i]
    if (s && !playing) seek(s.start + Math.min(1.2, (s.end - s.start) * 0.6))
  }

  // move an auto sound = take it over as a manual clip
  const moveSfx = (s, at) => {
    if (s.auto) {
      const id = newId()
      dispatch({ type: 'sfx', patch: { removed: [...state.sfx.removed, s.key], clips: [...state.sfx.clips, { id, url: s.url, name: s.kind, at, volume: s.volume }] } })
      setSelectedSfx(id)
    } else dispatch({ type: 'sfx', patch: { clips: state.sfx.clips.map(c => (c.id === s.id ? { ...c, at } : c)) } })
  }
  const removeSfx = s => {
    if (!s) return
    if (s.auto) dispatch({ type: 'sfx', patch: { removed: [...state.sfx.removed, s.key] } })
    else dispatch({ type: 'sfx', patch: { clips: state.sfx.clips.filter(c => c.id !== s.id) } })
    setSelectedSfx(null); setFocus('scene')
  }
  const selectSfx = id => { setSelectedSfx(id); setFocus('sfx') }
  const sfxSel = sfxAll.find(s => s.key === selectedSfx || s.id === selectedSfx)
  useEffect(() => {
    const k = e => { if ((e.key === 'Delete' || e.key === 'Backspace') && focus === 'sfx' && sfxSel && !/input|textarea|select/i.test(e.target.tagName)) removeSfx(sfxSel) }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  if (!meta || !doc) return <div className="aw-loading"><Loader2 className="spin" /> Loading the scene engine…</div>

  const tooLong = duration > MAX_AD_SECONDS
  const issues = meta.validate(meta.sanitize(doc))
  const addScene = type => {
    const at = state.scenes.length ? Math.min(selected + 1, state.scenes.length) : 0
    dispatch({ type: 'addScene', at, scene: { ...meta.create(type, state.format), id: newId() } })
    setSelected(at); setFocus('scene'); setPicker(false); setStep('scenes')
  }
  const stepIdx = STEPS.findIndex(s => s.key === step)

  return (
    <div className="aw" data-format={state.format}>
      <header className="aw-top">
        <b className="aw-title">Ad Wizard</b>
        <input className="aw-name" value={state.name || ''} placeholder="Untitled ad" maxLength={80} onChange={e => dispatch({ type: 'set', patch: { name: e.target.value } })} />
        <DraftStatus drafts={drafts} saveState={saveState} onOpen={() => setDraftsOpen(true)} />
        <span className="aw-len">{duration ? `${duration.toFixed(1)} s` : ''}{FOR_BOOKING ? ` / max ${MAX_AD_SECONDS} s` : ''}</span>
      </header>

      <div className="aw-body">
        <aside className="aw-left">
          <nav className="aw-steps">
            {STEPS.map((s, i) => (
              <button key={s.key} type="button" className={step === s.key ? 'on' : ''} onClick={() => setStep(s.key)}>
                <i>{i + 1}</i>{s.label}
              </button>))}
          </nav>
          <div className="aw-controls">
            {step === 'format' && <FormatPanel state={state} dispatch={dispatch} onNew={newAd} />}
            {step === 'brand' && <BrandPanel state={state} dispatch={dispatch} />}
            {step === 'scenes' && <SceneList state={state} dispatch={dispatch} selected={selected} setSelected={selectScene} issues={issues} onAdd={() => setPicker(true)} />}
            {step === 'sound' && <SoundPanel state={state} dispatch={dispatch} sfxAll={sfxAll} selectedSfx={sfxSel} setSelectedSfx={selectSfx}
              removeSfx={removeSfx} time={time} audio={audioRef.current} duration={duration} />}
            {step === 'render' && <RenderPanel state={state} doc={doc} meta={meta} info={info} issues={issues} tooLong={tooLong} music={music} sfxAll={sfxAll} audio={audioRef.current} />}
          </div>
          <div className="aw-nav">
            {stepIdx > 0 && <button type="button" className="aw-btn-ghost" onClick={() => setStep(STEPS[stepIdx - 1].key)}>Back</button>}
            {stepIdx < STEPS.length - 1 && <button type="button" className="aw-btn" onClick={() => setStep(STEPS[stepIdx + 1].key)}>Next</button>}
          </div>
        </aside>

        <section className="aw-stage">
          {state.scenes.length ? <ScenePreview ref={previewRef} doc={doc} onInfo={setInfo} onError={setPreviewError} />
            : <div className="aw-preview aw-empty"><p>Your ad shows here.</p><button type="button" className="aw-btn" onClick={() => setPicker(true)}><Plus size={16} /> Add the first scene</button></div>}
          {previewError && <div className="aw-error">{previewError}</div>}
          <div className="aw-transport">
            <button type="button" className="aw-icon-btn" onClick={() => { stop(); seek(0) }} title="Back to the start"><SkipBack size={16} /></button>
            <button type="button" className="aw-play" onClick={playing ? stop : play} disabled={!duration} title="Play / pause (space)">
              {playing ? <Pause size={18} /> : <Play size={18} />}</button>
            <span className="aw-time">{time.toFixed(1)} / {duration.toFixed(1)} s</span>
            {tooLong && <span className="aw-warn">The ad can be at most {MAX_AD_SECONDS} s</span>}
          </div>
          {state.scenes.length > 0 && <AdTimeline info={info} scenes={state.scenes} meta={meta} time={time} selected={focus === 'scene' ? selected : -1}
            onSelect={i => { selectScene(i); setStep('scenes') }} onSeek={t => { if (playing) stop(); seek(t) }}
            onDuration={(i, d) => dispatch({ type: 'duration', i, d })}
            music={state.music} sfx={sfxAll} selectedSfx={focus === 'sfx' ? selectedSfx : null} onSelectSfx={s => selectSfx(s.key || s.id)} onMoveSfx={moveSfx} />}
        </section>

        <aside className="aw-right">
          {focus === 'sfx' && sfxSel
            ? <SfxProperties s={sfxSel} state={state} dispatch={dispatch} audio={audioRef.current} onRemove={() => removeSfx(sfxSel)} />
            : state.scenes[selected]
              ? <SceneProperties state={state} dispatch={dispatch} meta={meta} selected={selected} issues={issues} />
              : <div className="aw-sec aw-hint"><h2>Properties</h2><p className="aw-tip">Pick a scene in the list or on the timeline to edit it here.</p></div>}
        </aside>
      </div>

      {picker && <ScenePicker meta={meta} format={state.format} onPick={addScene} onClose={() => setPicker(false)} first={!state.scenes.length} />}
      {draftsOpen && <DraftsDialog drafts={drafts} currentId={state.draftId} onOpen={openDraft} onNew={newAd} onClose={() => setDraftsOpen(false)} />}
      {limitDrafts && <LimitDialog list={limitDrafts} onReplace={id => saveNow(id)} onClose={() => { setLimitDrafts(null); setSaveState('idle') }} />}
    </div>
  )
}

// ---------------------------------------------------------------- drafts UI

function DraftStatus({ drafts, saveState, onOpen }) {
  if (!drafts.session) {
    return <div className="aw-draft-status">
      <CloudOff size={15} /><small>{drafts.reason === 'logged-out' ? 'Log in on 3Speak to keep drafts' : 'Drafts stay in this browser'}</small>
      {drafts.reason !== 'logged-out' && drafts.reason !== 'standalone' && <button type="button" className="aw-btn-small" onClick={drafts.signIn} disabled={drafts.signingIn}>
        {drafts.signingIn ? 'Signing in…' : 'Save drafts'}</button>}
    </div>
  }
  return <div className="aw-draft-status">
    <Cloud size={15} /><small>{{ saving: 'Saving…', saved: 'Saved', error: 'Not saved', limit: 'Draft limit reached' }[saveState] || 'Draft'}</small>
    <button type="button" className="aw-btn-small" onClick={onOpen}><FolderOpen size={14} /> Drafts</button>
  </div>
}

function DraftsDialog({ drafts, currentId, onOpen, onNew, onClose }) {
  const [list, setList] = useState(null)
  const [err, setErr] = useState(null)
  const load = useCallback(() => drafts.list().then(setList).catch(e => setErr(e.message)), [drafts])
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="aw-modal" onClick={onClose}>
    <div className="aw-modal-box aw-small" onClick={e => e.stopPropagation()}>
      <div className="aw-modal-head"><b>Your drafts</b>
        {list && <small className="aw-tip">{list.drafts.length} of {list.limits.maxDrafts} · each kept {list.limits.ttlDays} days after its last change</small>}
        <button type="button" className="aw-icon-btn" onClick={onClose}><X size={16} /></button></div>
      <div className="aw-draft-list">
        {err && <div className="aw-error">{err}</div>}
        {!list && !err && <Loader2 className="spin" />}
        {list?.drafts.map(d => <div key={d.id} className={`aw-draft${d.id === currentId ? ' on' : ''}`}>
          <img src={`${SCENES_BASE}/thumbs/${d.format}/${d.first || 'words'}.jpg`} alt="" />
          <span className="aw-grow"><b>{d.name}</b><small>{d.scenes} scene(s) · saved {new Date(d.updatedAt).toLocaleString()} · until {new Date(d.expiresAt).toLocaleDateString()}</small></span>
          {d.id === currentId ? <small>open</small> : <button type="button" className="aw-btn-small" onClick={() => onOpen(d.id)}>Open</button>}
          <button type="button" className="aw-icon-btn" title="Delete" onClick={async () => { if (confirm(`Delete "${d.name}"?`)) { await drafts.remove(d.id); load() } }}><Trash2 size={14} /></button>
        </div>)}
        {list && !list.drafts.length && <p className="aw-tip">No drafts yet. They save themselves while you work.</p>}
      </div>
      <div className="aw-modal-foot"><button type="button" className="aw-btn-ghost" onClick={onNew}><FilePlus2 size={15} /> New ad</button></div>
    </div>
  </div>
}

function LimitDialog({ list, onReplace, onClose }) {
  return <div className="aw-modal" onClick={onClose}>
    <div className="aw-modal-box aw-small" onClick={e => e.stopPropagation()}>
      <div className="aw-modal-head"><b>You have {list.length} drafts already</b><button type="button" className="aw-icon-btn" onClick={onClose}><X size={16} /></button></div>
      <p className="aw-tip" style={{ padding: '0 14px' }}>Pick one to replace with this ad, or close this and keep working without saving.</p>
      <div className="aw-draft-list">
        {list.map(d => <div key={d.id} className="aw-draft">
          <span className="aw-grow"><b>{d.name}</b><small>saved {new Date(d.updatedAt).toLocaleString()}</small></span>
          <button type="button" className="aw-btn-small" onClick={() => onReplace(d.id)}>Replace</button>
        </div>)}
      </div>
    </div>
  </div>
}

// ---------------------------------------------------------------- left panels

function FormatPanel({ state, dispatch, onNew }) {
  return <div className="aw-sec">
    <h2>Format</h2>
    {LOCKED_FORMAT
      ? <p className="aw-lead">Your booking runs as <b>{FORMATS[LOCKED_FORMAT].label}</b>, up to {MAX_AD_SECONDS} s.</p>
      : <p className="aw-lead">Where will the ad run? You can switch later; every scene works in both.</p>}
    <div className="aw-cards">
      {Object.entries(FORMATS).map(([k, f]) => (
        <button key={k} type="button" className={`aw-card${state.format === k ? ' on' : ''}`} disabled={!!LOCKED_FORMAT && k !== LOCKED_FORMAT}
          onClick={() => dispatch({ type: 'set', patch: { format: k } })}>
          <i className={`aw-shape ${k}`} /><b>{f.label}</b><small>{f.sub}</small><small>{f.width}x{f.height}</small>
        </button>))}
    </div>
    <label className="aw-f">Scene change
      <div className="aw-num"><input type="range" min={0.1} max={0.6} step={0.05} value={state.transition}
        onChange={e => dispatch({ type: 'set', patch: { transition: +e.target.value } })} /><span>{state.transition.toFixed(2)} s</span></div></label>
    <p className="aw-tip">Readable ads: about 3 s per scene, 15-30 s in total, the opening line readable within the first second.</p>
    <button type="button" className="aw-btn-ghost aw-danger" onClick={() => { if (confirm('Start a new ad? Your saved drafts stay.')) onNew() }}>New ad</button>
  </div>
}

function BrandPanel({ state, dispatch }) {
  const b = state.brand
  const [fontBusy, setFontBusy] = useState(false)
  const [fontName, setFontName] = useState('')
  const [rights, setRights] = useState(false)
  const fontRef = useRef(null)
  const addFont = async file => {
    if (!file || !fontName.trim() || !rights) return
    setFontBusy(true)
    try {
      const url = await uploadFile(file)
      const family = fontName.trim().replace(/[^\w ]/g, '').slice(0, 40)
      dispatch({ type: 'brand', patch: { fontFaces: [...b.fontFaces.filter(f => f.family !== family), { family, url, weight: 800 }], headFont: family } })
      setFontName('')
    } finally { setFontBusy(false) }
  }
  const fontOptions = [...b.fontFaces.map(f => f.family), ...FONTS]
  return <div className="aw-sec">
    <h2>Brand</h2>
    <label className="aw-f"><div className="aw-f-head"><span>Name</span></div>
      <input type="text" value={b.name} maxLength={40} onChange={e => dispatch({ type: 'brand', patch: { name: e.target.value } })} /></label>
    <div className="aw-f"><div className="aw-f-head"><span>Logo</span><small>square works best; without one the first letter is used</small></div>
      <ImageField value={b.logo} adjust={false} onChange={v => dispatch({ type: 'brand', patch: { logo: v || null } })} /></div>
    <label className="aw-f"><div className="aw-f-head"><span>Monogram</span><small>letter(s) used when there is no logo</small></div>
      <input type="text" value={b.monogram} maxLength={3} placeholder={(b.name || '?')[0]} onChange={e => dispatch({ type: 'brand', patch: { monogram: e.target.value } })} /></label>

    <h3>Colours</h3>
    <div className="aw-presets">{COLOR_PRESETS.map(p => (
      <button key={p.name} type="button" title={p.name} onClick={() => dispatch({ type: 'colors', patch: p.colors })}>
        {['bg', 'accent', 'accent2', 'accent3'].map(k => <i key={k} style={{ background: p.colors[k] }} />)}</button>))}</div>
    <div className="aw-colors">
      {[['bg', 'Background'], ['ink', 'Text'], ['mute', 'Quiet text'], ['accent', 'Accent'], ['accent2', 'Accent 2'], ['accent3', 'Accent 3']].map(([k, l]) => (
        <label key={k} className="aw-color"><input type="color" value={b.colors[k]} onChange={e => dispatch({ type: 'colors', patch: { [k]: e.target.value } })} /><span>{l}</span></label>))}
    </div>
    <p className="aw-tip">Use the accent for highlights (*stars* in text). Call-to-action buttons are drawn as outlines.</p>

    <h3>Fonts</h3>
    <label className="aw-f">Headlines
      <select value={b.headFont} onChange={e => dispatch({ type: 'brand', patch: { headFont: e.target.value } })} style={{ fontFamily: b.headFont }}>
        {fontOptions.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
    <label className="aw-f">Text
      <select value={b.font} onChange={e => dispatch({ type: 'brand', patch: { font: e.target.value } })}>
        {fontOptions.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
    <fieldset className="aw-group"><legend>Your own font file</legend>
      {b.fontFaces.map(f => <div className="aw-row" key={f.family}><span className="aw-grow">{f.family}</span>
        <button type="button" className="aw-icon-btn" onClick={() => dispatch({ type: 'brand', patch: { fontFaces: b.fontFaces.filter(x => x !== f),
          font: b.font === f.family ? 'Inter' : b.font, headFont: b.headFont === f.family ? 'Inter' : b.headFont } })}><Trash2 size={14} /></button></div>)}
      <input type="text" placeholder="Font name, e.g. Acme Display" value={fontName} onChange={e => setFontName(e.target.value)} />
      <label className="aw-f-inline"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} /> I have the right to use this font in videos</label>
      <button type="button" className="aw-btn-small" disabled={!fontName.trim() || !rights || fontBusy} onClick={() => fontRef.current?.click()}>
        <Upload size={14} /> {fontBusy ? 'Uploading…' : 'Upload TTF / OTF / WOFF'}</button>
      <input ref={fontRef} type="file" accept=".ttf,.otf,.woff,.woff2" hidden onChange={e => { addFont(e.target.files[0]); e.target.value = '' }} />
    </fieldset>
  </div>
}

function SceneList({ state, dispatch, selected, setSelected, issues, onAdd }) {
  return <div className="aw-sec">
    <h2>Scenes</h2>
    <ol className="aw-scenes">
      {state.scenes.map((s, i) => {
        const bad = issues.some(x => x.scene === i && x.level === 'error')
        return <li key={s.id} className={`${i === selected ? 'on' : ''}${bad ? ' bad' : ''}`} onClick={() => setSelected(i)}>
          <img src={`${SCENES_BASE}/thumbs/${state.format}/${s.type}.jpg`} alt="" />
          <span><b>{i + 1}. {s.type}</b><small>{s.duration.toFixed(1)} s</small></span>
          <div className="aw-li-tools" onClick={e => e.stopPropagation()}>
            <button type="button" className="aw-icon-btn" disabled={i === 0} onClick={() => { dispatch({ type: 'moveScene', i, to: i - 1 }); setSelected(i - 1) }}><ChevronUp size={14} /></button>
            <button type="button" className="aw-icon-btn" disabled={i === state.scenes.length - 1} onClick={() => { dispatch({ type: 'moveScene', i, to: i + 1 }); setSelected(i + 1) }}><ChevronDown size={14} /></button>
            <button type="button" className="aw-icon-btn" title="Duplicate" onClick={() => { dispatch({ type: 'addScene', at: i + 1, scene: { ...JSON.parse(JSON.stringify(s)), id: newId() } }); setSelected(i + 1) }}><Copy size={14} /></button>
            <button type="button" className="aw-icon-btn" title="Remove" onClick={() => { dispatch({ type: 'removeScene', i }); setSelected(Math.max(0, i - 1)) }}><Trash2 size={14} /></button>
          </div>
        </li>
      })}
    </ol>
    <button type="button" className="aw-btn" onClick={onAdd}><Plus size={16} /> Add a scene</button>
    <p className="aw-tip">The selected scene's text, pictures and length are on the right.</p>
  </div>
}

function SoundPanel({ state, dispatch, sfxAll, selectedSfx, setSelectedSfx, removeSfx, time, audio, duration }) {
  const [lib, setLib] = useState(null)
  const [busy, setBusy] = useState(false)
  const [rights, setRights] = useState(false)
  const fileRef = useRef(null)
  const m = state.music
  const setMusic = patch => dispatch({ type: 'music', music: patch })
  const pickMusic = async t => setMusic({ url: t.url, title: t.title, credit: t.credit || null, duration: t.duration || await audio.durationOf(t.url), start: 0, volume: m?.volume ?? 70, fadeIn: 0.3, fadeOut: 1.2, peaks: t.peaks || null })
  const upload = async file => {
    if (!file || !rights) return
    setBusy(true)
    try { const url = await uploadFile(file); setMusic({ url, title: file.name.replace(/\.[^.]+$/, ''), credit: null, duration: await audio.durationOf(absUrl(url)), start: 0, volume: 70, fadeIn: 0.3, fadeOut: 1.2, peaks: null }) }
    finally { setBusy(false) }
  }
  const addSfx = async t => {
    const id = newId()
    dispatch({ type: 'sfx', patch: { clips: [...state.sfx.clips, { id, url: t.url, name: t.title, at: +time.toFixed(2), volume: 80, duration: t.duration || await audio.durationOf(t.url) }] } })
    setSelectedSfx(id)
  }
  const maxStart = Math.max(0, (m?.duration || 0) - duration)
  return <div className="aw-sec">
    <h2>Sound</h2>
    <h3><Music size={15} /> Music</h3>
    {m ? <div className="aw-music">
      <div className="aw-row"><b className="aw-grow">{m.title}</b><button type="button" className="aw-icon-btn" onClick={() => setMusic(null)} title="Remove"><Trash2 size={14} /></button></div>
      {m.credit && <small className="aw-tip">{m.credit}</small>}
      {m.peaks && <div className="aw-peaks">{m.peaks.map((p, i) => <i key={i} style={{ height: `${10 + p * 90}%` }} />)}
        <span style={{ left: `${(m.start / (m.duration || 1)) * 100}%`, width: `${(duration / (m.duration || 1)) * 100}%` }} /></div>}
      <label className="aw-f">Start in the song <div className="aw-num"><input type="range" min={0} max={maxStart || 0} step={0.1} value={Math.min(m.start, maxStart)}
        onChange={e => setMusic({ start: +e.target.value })} disabled={!maxStart} /><span>{m.start.toFixed(1)} s</span></div></label>
      <label className="aw-f">Volume <div className="aw-num"><input type="range" min={0} max={100} value={m.volume} onChange={e => setMusic({ volume: +e.target.value })} /><span>{m.volume}%</span></div></label>
      <label className="aw-f">Fade in <div className="aw-num"><input type="range" min={0} max={4} step={0.1} value={m.fadeIn} onChange={e => setMusic({ fadeIn: +e.target.value })} /><span>{m.fadeIn.toFixed(1)} s</span></div></label>
      <label className="aw-f">Fade out <div className="aw-num"><input type="range" min={0} max={4} step={0.1} value={m.fadeOut} onChange={e => setMusic({ fadeOut: +e.target.value })} /><span>{m.fadeOut.toFixed(1)} s</span></div></label>
    </div> : <p className="aw-tip">No music yet.</p>}
    <div className="aw-row">
      <button type="button" className="aw-btn-small" onClick={() => setLib('music')}><Music size={14} /> Music library</button>
      <button type="button" className="aw-btn-small" disabled={!rights || busy} onClick={() => fileRef.current?.click()}><Upload size={14} /> {busy ? 'Uploading…' : 'Upload a song'}</button>
    </div>
    <label className="aw-f-inline"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} /> I own or licensed the song I upload</label>
    <input ref={fileRef} type="file" accept="audio/*" hidden onChange={e => { upload(e.target.files[0]); e.target.value = '' }} />

    <h3><AudioLines size={15} /> Sound effects</h3>
    <label className="aw-f-inline"><input type="checkbox" checked={state.sfx.auto} onChange={e => dispatch({ type: 'sfx', patch: { auto: e.target.checked } })} /> Automatic sounds (scene changes, words popping in)</label>
    {state.sfx.auto && <label className="aw-f">Automatic sounds level <div className="aw-num"><input type="range" min={-12} max={12} step={1} value={state.sfx.gain}
      onChange={e => dispatch({ type: 'sfx', patch: { gain: +e.target.value } })} /><span>{state.sfx.gain > 0 ? '+' : ''}{state.sfx.gain} dB</span></div></label>}
    {state.sfx.removed.length > 0 && <button type="button" className="aw-btn-ghost" onClick={() => dispatch({ type: 'sfx', patch: { removed: [] } })}>Restore {state.sfx.removed.length} removed automatic sound(s)</button>}
    <button type="button" className="aw-btn-small" onClick={() => setLib('sfx')}><Plus size={14} /> Add a sound at {time.toFixed(1)} s</button>
    <ul className="aw-sfx">
      {sfxAll.map(s => {
        const id = s.key || s.id, on = selectedSfx && (selectedSfx.key || selectedSfx.id) === id
        return <li key={id} className={`${s.auto ? 'auto' : ''}${on ? ' on' : ''}`} onClick={() => setSelectedSfx(id)}>
          <button type="button" className="aw-icon-btn" onClick={e => { e.stopPropagation(); audio.blip(s.url, s.volume) }} title="Listen"><Play size={12} /></button>
          <span className="aw-grow">{s.name || s.kind}{s.auto && <small> auto</small>}</span><small>{s.at.toFixed(2)} s</small>
          <button type="button" className="aw-icon-btn" onClick={e => { e.stopPropagation(); removeSfx(s) }} title="Remove"><Trash2 size={12} /></button>
        </li>
      })}
    </ul>
    <p className="aw-tip">Drag sounds on the timeline to move them. Moving an automatic sound makes it yours.</p>
    {lib && <MusicLibrary kind={lib} onPick={lib === 'music' ? pickMusic : addSfx} onClose={() => setLib(null)} />}
  </div>
}

function RenderPanel({ state, doc, meta, info, issues, tooLong, music, sfxAll, audio }) {
  const [job, setJob] = useState(null) // { phase, progress, outputUrl, error, length }
  const [used, setUsed] = useState(false)
  const abortRef = useRef(null)
  const errors = issues.filter(x => x.level === 'error')
  const blocked = !state.scenes.length || errors.length > 0 || tooLong
  const render = async () => {
    const ctl = new AbortController(); abortRef.current = ctl
    setUsed(false)
    try {
      setJob({ phase: 'Drawing the scenes…', progress: 0 })
      const r = await fetch(api('/api/scene-render'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc: meta.sanitize(doc) }) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `scene render: ${r.status}`)
      const { jobId } = await r.json()
      const scene = await pollJob(api(`/api/scene-render/${jobId}`), d => setJob(j => ({ ...j, progress: (d.progress || 0) * 0.7 })), { signal: ctl.signal })
      const videoUrl = absUrl(scene.outputUrl)
      const length = scene.duration || info.duration

      setJob({ phase: 'Mixing the sound…', progress: 0.72 })
      const sfxClips = []
      for (const s of sfxAll) {
        const d = s.duration || await audio.durationOf(s.url)
        if (!d || s.at >= length) continue
        sfxClips.push({ id: `sfx-${s.key || s.id}`, type: 'audio', name: s.name || s.kind, url: s.url, duration: d, startTime: 0, endTime: Math.min(d, length - s.at),
          timelinePosition: +s.at.toFixed(3), volume: s.volume ?? 100, audioEnabled: true })
      }
      const tracks = [
        { id: 'v', type: 'video', name: 'Scenes', clips: [{ id: 'scenes', type: 'video', name: 'scenes', url: videoUrl, duration: length, startTime: 0, endTime: length,
          timelinePosition: 0, zoom: 100, cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100, positionX: 0, positionY: 0, rotation: 0, audioEnabled: false, volume: 0 }] },
        ...(music?.url ? [{ id: 'm', type: 'audio', name: 'Music', clips: [{ id: 'music', type: 'audio', name: music.title, url: music.url, duration: music.duration,
          startTime: music.start || 0, endTime: Math.min(music.duration || 1e9, (music.start || 0) + length), timelinePosition: 0, volume: music.volume ?? 70,
          fadeIn: music.fadeIn || 0, fadeOut: music.fadeOut || 0, audioEnabled: true }] }] : []),
        ...(sfxClips.length ? [{ id: 's', type: 'audio', name: 'SFX', clips: sfxClips }] : []),
      ]
      const res = await fetch(api('/api/render'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeline: { tracks, outputWidth: doc.width, outputHeight: doc.height, previewWidth: doc.width, previewHeight: doc.height, fps: 30 } }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `render: ${res.status}`)
      const { jobId: rid } = await res.json()
      const done = await pollJob(api(`/api/render/${rid}`), d => setJob(j => ({ ...j, phase: d.phase || j.phase, progress: 0.72 + (d.progress || 0) / 100 * 0.28 })), { signal: ctl.signal })
      const outputUrl = absUrl(done.outputUrl)
      setJob({ phase: 'Done', progress: 1, outputUrl, length })
      post({ type: 'ad-render-complete', outputUrl, format: state.format, width: doc.width, height: doc.height, duration: length, musicCredits: music?.credit ? [music.credit] : [] })
    } catch (e) {
      if (e.message !== 'aborted') setJob({ error: e.message })
    }
  }
  const useForCampaign = () => {
    post({ type: 'ad-use', outputUrl: job.outputUrl, format: state.format, width: doc.width, height: doc.height, duration: job.length, name: state.name || null })
    setUsed(true)
  }
  return <div className="aw-sec">
    <h2>Render</h2>
    <ul className="aw-checks">
      <li className={state.scenes.length ? 'ok' : ''}>{state.scenes.length} scene(s), {info ? info.duration.toFixed(1) : '0'} s{tooLong ? ` (too long, max ${MAX_AD_SECONDS} s)` : ''}</li>
      <li className={errors.length ? '' : 'ok'}>{errors.length ? `${errors.length} thing(s) to fill in` : 'All required fields filled in'}</li>
      <li className={music ? 'ok' : 'opt'}>{music ? `Music: ${music.title}` : 'No music (optional)'}</li>
      <li className="ok">{sfxAll.length} sound effect(s)</li>
    </ul>
    {errors.slice(0, 8).map((x, i) => <small key={i} className="aw-warn">Scene {x.scene + 1}, {x.field}: {x.msg}</small>)}
    {!job || job.error ? <button type="button" className="aw-btn aw-big" disabled={blocked} onClick={render}>Render the ad ({FORMATS[state.format].width}x{FORMATS[state.format].height})</button> : null}
    {job?.error && <div className="aw-error">{job.error}</div>}
    {job && !job.error && !job.outputUrl && <div className="aw-progress"><div style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /><span>{job.phase} {Math.round((job.progress || 0) * 100)}%</span>
      <button type="button" className="aw-btn-ghost" onClick={() => { abortRef.current?.abort(); setJob(null) }}>Cancel</button></div>}
    {job?.outputUrl && <div className="aw-result">
      <video src={job.outputUrl} controls playsInline />
      {FOR_BOOKING && <button type="button" className="aw-btn aw-big" onClick={useForCampaign} disabled={used}>{used ? <><Check size={16} /> Sent to your campaign</> : 'Use for my campaign'}</button>}
      <div className="aw-row"><a className={FOR_BOOKING ? 'aw-btn-ghost' : 'aw-btn'} href={job.outputUrl} download><Download size={16} /> Download</a>
        <button type="button" className="aw-btn-ghost" onClick={() => setJob(null)}><Check size={16} /> Render again</button></div>
    </div>}
  </div>
}

// ---------------------------------------------------------------- right panel (properties)

function SceneProperties({ state, dispatch, meta, selected, issues }) {
  const sel = state.scenes[selected]
  const m = sel && meta.TYPES[sel.type]
  if (!m) return null
  const mine = issues.filter(x => x.scene === selected)
  return <div className="aw-sec">
    <h2>{selected + 1}. {sel.type}</h2>
    <p className="aw-tip">{m.desc}</p>
    <label className="aw-f">Length
      <div className="aw-num"><input type="range" min={m.dur[0]} max={Math.max(8, m.dur[1] * 2)} step={0.1} value={sel.duration}
        onChange={e => dispatch({ type: 'duration', i: selected, d: +e.target.value })} /><span>{sel.duration.toFixed(1)} s</span></div></label>
    {mine.map((x, k) => <small key={k} className={x.level === 'error' ? 'aw-warn' : 'aw-tip'}>{x.field}: {x.msg}</small>)}
    <Fields fields={m.fields} value={sel} icons={meta.ICONS} onChange={v => dispatch({ type: 'scene', i: selected, scene: v })} />
  </div>
}

function SfxProperties({ s, state, dispatch, audio, onRemove }) {
  const set = patch => dispatch({ type: 'sfx', patch: { clips: state.sfx.clips.map(c => (c.id === s.id ? { ...c, ...patch } : c)) } })
  return <div className="aw-sec">
    <h2>Sound effect</h2>
    <p className="aw-tip">{s.name || s.kind}{s.auto ? ' (automatic: move or change it to make it yours)' : ''}</p>
    <div className="aw-row">
      <button type="button" className="aw-btn-small" onClick={() => audio.blip(s.url, s.volume)}><Play size={14} /> Listen</button>
      <button type="button" className="aw-btn-ghost" onClick={onRemove}><Trash2 size={14} /> Remove</button>
    </div>
    {s.auto
      ? <button type="button" className="aw-btn-small" onClick={() => {
        const id = newId()
        dispatch({ type: 'sfx', patch: { removed: [...state.sfx.removed, s.key], clips: [...state.sfx.clips, { id, url: s.url, name: s.kind, at: s.at, volume: s.volume }] } })
      }}>Make it mine</button>
      : <>
        <label className="aw-f">At <div className="aw-num"><input type="number" step={0.05} min={0} value={s.at} onChange={e => set({ at: Math.max(0, +e.target.value) })} /><span>s</span></div></label>
        <label className="aw-f">Volume <div className="aw-num"><input type="range" min={0} max={100} value={s.volume} onChange={e => set({ volume: +e.target.value })} /><span>{s.volume}%</span></div></label>
      </>}
  </div>
}

// ---------------------------------------------------------------- scene picker

function ScenePicker({ meta, format, onPick, onClose, first }) {
  const [role, setRole] = useState(first ? 'opener' : 'all')
  const [style, setStyle] = useState('all')
  const [q, setQ] = useState('')
  const all = meta.catalogue()
  const list = all.filter(c => (role === 'all' || c.role.includes(role)) && (style === 'all' || c.style === style)
    && (!q || (c.type + ' ' + c.desc).toLowerCase().includes(q.toLowerCase())))
  const count = st => all.filter(c => (role === 'all' || c.role.includes(role)) && (st === 'all' || c.style === st)).length
  return <div className="aw-modal" onClick={onClose}>
    <div className="aw-modal-box" onClick={e => e.stopPropagation()}>
      <div className="aw-modal-head"><b>Add a scene</b>
        <div className="aw-tabs">{ROLES.map(r => <button key={r.key} type="button" className={role === r.key ? 'on' : ''} onClick={() => setRole(r.key)}>{r.label}</button>)}</div>
        <label className="aw-search"><Search size={14} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search" /></label>
        <button type="button" className="aw-icon-btn" onClick={onClose}><X size={16} /></button></div>
      <div className="aw-modal-sub">
        <span className="aw-tip">Look</span>
        <div className="aw-tabs">{[['all', 'All'], ...Object.entries(meta.STYLES)].map(([k, l]) => (
          <button key={k} type="button" className={style === k ? 'on' : ''} onClick={() => setStyle(k)} disabled={!count(k)}>{l} <small>{count(k)}</small></button>))}</div>
      </div>
      <div className={`aw-grid ${format}`}>
        {list.map(c => <button key={c.type} type="button" className="aw-tile" onClick={() => onPick(c.type)}>
          <img src={`${SCENES_BASE}/thumbs/${format}/${c.type}.jpg`} alt="" loading="lazy" />
          <b>{c.type}</b><small>{c.desc}</small></button>)}
        {!list.length && <p className="aw-tip">Nothing matches.</p>}
      </div>
    </div>
  </div>
}
