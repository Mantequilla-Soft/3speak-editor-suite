import { useRef, useState } from 'react'
import { Plus, Trash2, ChevronUp, ChevronDown, Upload, X, RotateCcw } from 'lucide-react'
import { uploadFile, absUrl } from './engine'

// Forms generated from the scene engine's schema (lib/scene-meta.js): one field editor per field kind.
const nice = k => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/([a-z])([A-Z])/g, '$1 $2')
const labelOf = f => f.label || nice(f.k)
const imgUrl = v => (v && typeof v === 'object' ? v.url : v) || ''

export function Fields({ fields, value, onChange, icons, path = '' }) {
  return fields.map(f => (
    <Field key={path + f.k} f={f} value={value?.[f.k]} icons={icons}
      onChange={v => {
        const next = { ...(value || {}) }
        if (v === undefined || v === '' || (Array.isArray(v) && !v.length && f.opt)) delete next[f.k]
        else next[f.k] = v
        onChange(next)
      }} />
  ))
}

function Field({ f, value, onChange, icons }) {
  const head = (
    <div className="aw-f-head">
      <span>{labelOf(f)}{!f.opt && f.min !== 0 && <i className="aw-req">*</i>}</span>
      {f.hint && <small>{f.hint}</small>}
    </div>
  )
  switch (f.kind) {
    case 'text':
      return <label className="aw-f">{head}
        <input type="text" value={value ?? ''} maxLength={f.maxLen ? f.maxLen * 2 : undefined} onChange={e => onChange(e.target.value)}
          placeholder={f.opt ? 'optional' : ''} /><Count v={value} max={f.maxLen} /></label>
    case 'para':
      return <label className="aw-f">{head}
        <textarea rows={3} value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder={f.opt ? 'optional' : ''} /><Count v={value} max={f.maxLen} /></label>
    case 'lines': case 'texts':
      return f.options ? <Options f={f} head={head} value={value} onChange={onChange} />
        : <StringList f={f} head={head} value={value} onChange={onChange} />
    case 'number': case 'int': {
      const ranged = f.min != null && f.max != null && f.max - f.min <= 400
      const step = f.kind === 'int' ? 1 : (f.max - f.min) > 20 ? 1 : 0.05
      return <label className="aw-f">{head}
        <div className="aw-num">
          {ranged && <input type="range" min={f.min} max={f.max} step={step} value={value ?? f.min} onChange={e => onChange(+e.target.value)} />}
          <input type="number" min={f.min} max={f.max} step={f.kind === 'int' ? 1 : 'any'} value={value ?? ''} placeholder={f.opt ? 'auto' : ''}
            onChange={e => onChange(e.target.value === '' ? undefined : +e.target.value)} />
        </div></label>
    }
    case 'bool':
      return <label className="aw-f aw-f-inline"><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />{labelOf(f)}</label>
    case 'enum':
      return <label className="aw-f">{head}
        <select value={value ?? ''} onChange={e => onChange(e.target.value || undefined)}>
          {f.opt && <option value="">(none)</option>}
          {f.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select></label>
    case 'icon':
      return <label className="aw-f">{head}
        <select value={value ?? ''} onChange={e => onChange(e.target.value || undefined)}>
          {f.opt && <option value="">(none)</option>}
          {icons.map(o => <option key={o} value={o}>{o}</option>)}
        </select></label>
    case 'color':
      return <label className="aw-f aw-f-inline">{labelOf(f)}
        <input type="color" value={value || '#ffffff'} onChange={e => onChange(e.target.value)} />
        {value && <button type="button" className="aw-icon-btn" onClick={() => onChange(undefined)} title="Clear"><X size={14} /></button>}</label>
    case 'image':
      return <div className="aw-f">{head}<ImageField value={value} adjust={f.adjust !== false} onChange={onChange} /></div>
    case 'images':
      return <div className="aw-f">{head}<ImageList f={f} value={value} onChange={onChange} /></div>
    case 'object':
      if (!f.of.length) return <PairField f={f} head={head} value={value} onChange={onChange} />
      return <fieldset className="aw-group"><legend>{labelOf(f)}{f.opt && <small> optional</small>}</legend>
        <Fields fields={f.of} value={value} onChange={v => onChange(Object.keys(v).length ? v : undefined)} icons={icons} /></fieldset>
    case 'list':
      return <ObjectList f={f} value={value} onChange={onChange} icons={icons} />
    default:
      return null
  }
}

function Count({ v, max }) {
  if (!max || !v) return null
  const n = String(v).length
  return <span className={`aw-count${n > max ? ' over' : ''}`}>{n}/{max}</span>
}

function StringList({ f, head, value, onChange }) {
  const arr = Array.isArray(value) ? value : []
  const max = f.max || 12
  const isInt = f.kindOf === 'int'
  const set = (i, v) => onChange(arr.map((x, k) => (k === i ? v : x)))
  return <div className="aw-f">{head}
    {f.kind === 'lines' && <small className="aw-tip">Wrap a word in *stars* for the accent colour, _underscores_ for the second accent.</small>}
    {arr.map((x, i) => (
      <div className="aw-row" key={i}>
        <input type={isInt ? 'number' : 'text'} value={x} onChange={e => set(i, isInt ? +e.target.value : e.target.value)} />
        <button type="button" className="aw-icon-btn" disabled={i === 0} onClick={() => onChange(swap(arr, i, i - 1))} title="Up"><ChevronUp size={14} /></button>
        <button type="button" className="aw-icon-btn" disabled={arr.length <= (f.min || 0)} onClick={() => onChange(arr.filter((_, k) => k !== i))} title="Remove"><Trash2 size={14} /></button>
      </div>))}
    {arr.length < max && <button type="button" className="aw-add" onClick={() => onChange([...arr, isInt ? 0 : ''])}><Plus size={14} /> Add</button>}
    {f.min > 0 && arr.length < f.min && <small className="aw-warn">needs at least {f.min}</small>}
  </div>
}

function Options({ f, head, value, onChange }) {
  const arr = Array.isArray(value) ? value : []
  return <div className="aw-f">{head}
    <div className="aw-chips">{arr.map((x, i) => (
      <select key={i} value={x} onChange={e => onChange(arr.map((y, k) => (k === i ? e.target.value : y)))}>
        {f.options.map(o => <option key={o}>{o}</option>)}</select>))}
      {arr.length < (f.max || 4) && <button type="button" className="aw-add" onClick={() => onChange([...arr, f.options[0]])}><Plus size={14} /></button>}
      {arr.length > 0 && <button type="button" className="aw-icon-btn" onClick={() => onChange(arr.slice(0, -1))}><Trash2 size={14} /></button>}
    </div></div>
}

function PairField({ f, head, value, onChange }) {
  const [x, y] = Array.isArray(value) ? value : ['', '']
  return <div className="aw-f">{head}
    <div className="aw-row">
      <input type="number" min={0} max={100} placeholder="x %" value={x ?? ''} onChange={e => onChange([+e.target.value, y || 50])} />
      <input type="number" min={0} max={100} placeholder="y %" value={y ?? ''} onChange={e => onChange([x || 50, +e.target.value])} />
      {value && <button type="button" className="aw-icon-btn" onClick={() => onChange(undefined)}><X size={14} /></button>}
    </div></div>
}

function ObjectList({ f, value, onChange, icons }) {
  const arr = Array.isArray(value) ? value : []
  const max = f.max || 12
  const blank = () => Object.fromEntries(f.of.filter(x => !x.opt && (x.kind === 'text' || x.kind === 'para')).map(x => [x.k, '']))
  return <fieldset className="aw-group">
    <legend>{labelOf(f)} <small>{f.min === f.max ? `${f.min}` : `${f.min || 0}-${max}`}</small></legend>
    {arr.map((item, i) => (
      <div className="aw-item" key={i}>
        <div className="aw-item-bar">
          <b>{i + 1}</b>
          <button type="button" className="aw-icon-btn" disabled={i === 0} onClick={() => onChange(swap(arr, i, i - 1))} title="Move up"><ChevronUp size={14} /></button>
          <button type="button" className="aw-icon-btn" disabled={i === arr.length - 1} onClick={() => onChange(swap(arr, i, i + 1))} title="Move down"><ChevronDown size={14} /></button>
          <button type="button" className="aw-icon-btn" disabled={arr.length <= (f.min || 0)} onClick={() => onChange(arr.filter((_, k) => k !== i))} title="Remove"><Trash2 size={14} /></button>
        </div>
        <Fields fields={f.of} value={item} icons={icons} path={`${i}.`} onChange={v => onChange(arr.map((x, k) => (k === i ? v : x)))} />
      </div>))}
    {arr.length < max && <button type="button" className="aw-add" onClick={() => onChange([...arr, blank()])}><Plus size={14} /> Add</button>}
    {f.min > 0 && arr.length < f.min && <small className="aw-warn">needs {f.min}</small>}
  </fieldset>
}

const swap = (arr, a, b) => { const c = [...arr]; [c[a], c[b]] = [c[b], c[a]]; return c }

// A picture: upload or URL, then zoom + drag to place it inside its frame (engine: { url, scale, x, y })
export function ImageField({ value, onChange, adjust = true, accept = 'image/*' }) {
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  const fileRef = useRef(null)
  const padRef = useRef(null)
  const url = imgUrl(value)
  const o = value && typeof value === 'object' ? value : { url }
  const set = patch => onChange({ ...o, ...patch })

  const pick = async file => {
    if (!file) return
    setErr(null); setBusy(0)
    try { onChange(adjust ? { url: await uploadFile(file, p => setBusy(p)) } : await uploadFile(file, p => setBusy(p))) }
    catch (e) { setErr(e.message) } finally { setBusy(null) }
  }
  const drag = e => {
    const r = padRef.current.getBoundingClientRect()
    const move = ev => {
      const p = ev.touches ? ev.touches[0] : ev
      set({ x: +(Math.max(-1, Math.min(1, ((p.clientX - r.left) / r.width) * 2 - 1))).toFixed(2), y: +(Math.max(-1, Math.min(1, ((p.clientY - r.top) / r.height) * 2 - 1))).toFixed(2) })
    }
    move(e)
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  return <div className="aw-img">
    {url ? (
      <div className="aw-img-main">
        <div className="aw-img-pad" ref={padRef} onPointerDown={adjust ? drag : undefined} title={adjust ? 'Drag to choose which part of the picture shows' : ''}>
          <img src={absUrl(url)} alt="" draggable={false} />
          {adjust && <i className="aw-img-dot" style={{ left: `${50 + (o.x || 0) * 50}%`, top: `${50 + (o.y || 0) * 50}%` }} />}
        </div>
        <div className="aw-img-tools">
          {adjust && <label className="aw-f-inline">Zoom
            <input type="range" min={0.5} max={3} step={0.05} value={o.scale ?? 1} onChange={e => set({ scale: +e.target.value })} />
            <span>{(o.scale ?? 1).toFixed(2)}x</span></label>}
          <div className="aw-row">
            {adjust && <button type="button" className="aw-icon-btn" onClick={() => onChange({ url })} title="Reset placement"><RotateCcw size={14} /></button>}
            <button type="button" className="aw-btn-small" onClick={() => fileRef.current?.click()}><Upload size={14} /> Replace</button>
            <button type="button" className="aw-icon-btn" onClick={() => onChange(undefined)} title="Remove"><Trash2 size={14} /></button>
          </div>
        </div>
      </div>
    ) : (
      <div className="aw-img-empty">
        <button type="button" className="aw-btn-small" onClick={() => fileRef.current?.click()} disabled={busy != null}>
          <Upload size={14} /> {busy != null ? `Uploading ${Math.round(busy * 100)}%` : 'Upload picture'}</button>
        <input type="url" placeholder="or paste an https:// link" onBlur={e => e.target.value && onChange(adjust ? { url: e.target.value.trim() } : e.target.value.trim())} />
      </div>
    )}
    {err && <small className="aw-warn">{err}</small>}
    <input ref={fileRef} type="file" accept={accept} hidden onChange={e => { pick(e.target.files[0]); e.target.value = '' }} />
  </div>
}

function ImageList({ f, value, onChange }) {
  const arr = Array.isArray(value) ? value : []
  return <div className="aw-imgs">
    {arr.map((v, i) => <div className="aw-imgs-item" key={i}>
      <ImageField value={v} adjust={f.adjust !== false} onChange={nv => onChange(nv ? arr.map((x, k) => (k === i ? nv : x)) : arr.filter((_, k) => k !== i))} />
    </div>)}
    {arr.length < (f.max || 24) && <ImageField value={null} adjust={f.adjust !== false} onChange={nv => nv && onChange([...arr, nv])} />}
  </div>
}
