import { useState, useRef, useCallback, useLayoutEffect } from 'react'
import { Volume2, ZoomIn, Move, Crop, Type, GripVertical, RotateCcw, RotateCw, Droplets, AlignLeft, AlignCenter, AlignRight, Palette, Minus, Plus, Wand2, SunMedium } from 'lucide-react'
import { hasLayout, scaleLayout, layoutZoom, LAYOUT_ZOOM_MIN, LAYOUT_ZOOM_MAX } from '../utils/remixLayout'
import { normalizeChromaKey, defaultChromaKey, KEY_RANGES, grabVideoFrame, canvasToBlobUrl } from '../utils/chromaKey'
import { COLOR_DEFAULTS, normalizeColor } from '../utils/clipColor'
import { EFFECTS, EFFECT_DEFAULTS, normalizeMotion } from '../utils/stickerMotion'
import { Eye, EyeOff } from 'lucide-react'
import { autoColor } from '../utils/autoColor'
import { api, getBackendUrl } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'
import './GreenScreen.css'

// Green screen (chroma key) on a video clip: keyed pixels turn transparent, so
// the clips on the tracks below show through. See utils/chromaKey.js.
const COLOR_SLIDERS = [
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'midtones', label: 'Midtones' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'warmth', label: 'Warmth' },
  { key: 'tint', label: 'Tint' }
]

/**
 * Colour adjustments of a video / image clip (utils/clipColor.js): the preview
 * shows them live and the render applies the same maths. "Auto" measures a
 * few frames and sets levels, midtones and white balance (utils/autoColor.js).
 */
function ColorControls({ clip, onUpdateClip }) {
  const [autoState, setAutoState] = useState(null) // null | 'busy' | 'failed'
  const color = { ...COLOR_DEFAULTS, ...(clip.color || {}) }
  const changed = !!normalizeColor(clip.color)

  const set = (key, value) => onUpdateClip({ color: normalizeColor({ ...color, [key]: value }) })
  const runAuto = async () => {
    setAutoState('busy')
    try {
      onUpdateClip({ color: normalizeColor(await autoColor(clip)) })
      setAutoState(null)
    } catch {
      setAutoState('failed')
    }
  }

  return (
    <div className="prop-group">
      <div className="prop-group-label color-group-label">
        <span>Color</span>
        <span className="color-group-actions">
          <button className="color-auto-btn" onClick={runAuto} disabled={autoState === 'busy'} title="Fix levels, midtones and white balance from this clip's frames">
            <Wand2 size={11} /> {autoState === 'busy' ? 'Measuring…' : 'Auto'}
          </button>
          {changed && (
            <button className="prop-reset-btn" onClick={() => onUpdateClip({ color: null })} title="Reset all colour adjustments">
              <RotateCcw size={10} />
            </button>
          )}
        </span>
      </div>
      {autoState === 'failed' && <p className="color-auto-error">Could not read this clip&apos;s picture.</p>}
      {COLOR_SLIDERS.map(({ key, label }) => (
        <div className="property-group color-slider" key={key}>
          <label>
            {key === 'brightness' ? <SunMedium size={12} /> : null}
            {label}
          </label>
          <div className="property-slider">
            <input
              type="range"
              min="-100"
              max="100"
              value={color[key]}
              onChange={(e) => set(key, parseInt(e.target.value))}
              onDoubleClick={() => set(key, 0)}
              title="Double-click to reset"
            />
            <span>{color[key] > 0 ? `+${color[key]}` : color[key]}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

const EFFECT_GROUPS = [
  { id: 'loop', label: 'Loops' },
  { id: 'in', label: 'Entrances' },
  { id: 'out', label: 'Exits' }
]
const DIRECTION_ARROWS = [['left', '←'], ['right', '→'], ['top', '↑'], ['bottom', '↓']]
// Pivot presets: x, y in -1..1 (centre = 0, 0)
const PIVOT_GRID = [-1, 0, 1].flatMap(y => [-1, 0, 1].map(x => [x, y]))
const PIVOT_NAMES = { '-1,-1': 'top left', '0,-1': 'top', '1,-1': 'top right', '-1,0': 'left', '0,0': 'centre', '1,0': 'right', '-1,1': 'bottom left', '0,1': 'bottom', '1,1': 'bottom right' }

/**
 * Motion of an image / text clip (stickers): a stack of effects (loops,
 * entrances, exits), each with its own speed / strength (and direction for
 * slides), and one pivot they turn and scale around (utils/stickerMotion.js;
 * preview, export and render use the same formulas). Press play to see it.
 */
function MotionControls({ clip, onUpdateClip }) {
  const motion = normalizeMotion(clip.motion)
  const effects = motion?.effects || []
  const pivot = { pivotX: motion?.pivotX || 0, pivotY: motion?.pivotY || 0 }
  const save = (next) => onUpdateClip({ motion: normalizeMotion(next) })
  const setEffect = (i, fields) => save({ ...pivot, effects: effects.map((e, j) => (j === i ? { ...e, ...fields } : e)) })
  const removeEffect = (i) => save({ ...pivot, effects: effects.filter((_, j) => j !== i) })
  const addEffect = (type) => save({ ...pivot, effects: [...effects, { type, ...EFFECT_DEFAULTS }] })
  const setPivot = (x, y) => save({ effects, pivotX: x, pivotY: y })
  // The pivot only matters to effects that turn or scale
  const turns = effects.some(e => !e.hidden && ['pulse', 'wobble', 'spin', 'pop', 'popOut'].includes(e.type))

  return (
    <div className="prop-group">
      <div className="prop-group-label">Motion</div>

      {effects.map((e, i) => {
        const def = EFFECTS.find(x => x.id === e.type)
        return (
          <div className={`motion-effect${e.hidden ? ' hidden-effect' : ''}`} key={`${e.type}-${i}`}>
            <div className="motion-effect-head">
              <strong>{def.label}{e.hidden ? ' (hidden)' : ''}</strong>
              <span className="motion-effect-actions">
                <button
                  className="prop-reset-btn"
                  onClick={() => setEffect(i, { hidden: !e.hidden })}
                  title={e.hidden ? 'Show this effect again' : 'Hide this effect (kept, but not applied)'}
                  aria-pressed={!!e.hidden}
                >
                  {e.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button className="prop-reset-btn" onClick={() => removeEffect(i)} title="Remove this effect">×</button>
              </span>
            </div>
            {def.direction && (
              <div className="motion-directions" role="radiogroup" aria-label={e.type === 'slideIn' ? 'Comes from' : 'Goes to'}>
                <span>{e.type === 'slideIn' ? 'From' : 'To'}</span>
                {DIRECTION_ARROWS.map(([d, arrow]) => (
                  <button key={d} role="radio" aria-checked={e.direction === d} className={e.direction === d ? 'active' : ''} onClick={() => setEffect(i, { direction: d })} title={d}>
                    {arrow}
                  </button>
                ))}
              </div>
            )}
            <div className="property-group">
              <label>Speed</label>
              <div className="property-slider">
                <input type="range" min="0.1" max="4" step="0.1" value={e.speed} onChange={(ev) => setEffect(i, { speed: parseFloat(ev.target.value) })} onDoubleClick={() => setEffect(i, { speed: EFFECT_DEFAULTS.speed })} title="Double-click to reset" />
                <span>{e.speed.toFixed(1)}×</span>
              </div>
            </div>
            {def.amount && (
              <div className="property-group">
                <label>{def.amount}</label>
                <div className="property-slider">
                  <input type="range" min="0" max="100" step="1" value={e.amount} onChange={(ev) => setEffect(i, { amount: parseInt(ev.target.value) })} onDoubleClick={() => setEffect(i, { amount: EFFECT_DEFAULTS.amount })} title="Double-click to reset" />
                  <span>{Math.round(e.amount)}%</span>
                </div>
              </div>
            )}
          </div>
        )
      })}

      <div className="property-group">
        <select className="motion-add" value="" onChange={(ev) => { if (ev.target.value) addEffect(ev.target.value) }}>
          <option value="">{effects.length ? 'Add another effect…' : 'Add an effect…'}</option>
          {EFFECT_GROUPS.map(g => (
            <optgroup key={g.id} label={g.label}>
              {EFFECTS.filter(x => x.group === g.id).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>

      {turns && (
        <div className="property-group">
          <label>Pivot <small className="motion-pivot-name">{PIVOT_NAMES[`${pivot.pivotX},${pivot.pivotY}`] || 'custom'}</small></label>
          <div className="motion-pivot">
            <div className="motion-pivot-grid" role="radiogroup" aria-label="Pivot point">
              {PIVOT_GRID.map(([x, y]) => (
                <button
                  key={`${x},${y}`}
                  role="radio"
                  aria-checked={pivot.pivotX === x && pivot.pivotY === y}
                  className={pivot.pivotX === x && pivot.pivotY === y ? 'active' : ''}
                  onClick={() => setPivot(x, y)}
                  title={PIVOT_NAMES[`${x},${y}`]}
                />
              ))}
            </div>
            <div className="motion-pivot-sliders">
              <div className="property-slider">
                <span>X</span>
                <input type="range" min="-100" max="100" step="5" value={Math.round(pivot.pivotX * 100)} onChange={(ev) => setPivot(parseInt(ev.target.value) / 100, pivot.pivotY)} />
              </div>
              <div className="property-slider">
                <span>Y</span>
                <input type="range" min="-100" max="100" step="5" value={Math.round(pivot.pivotY * 100)} onChange={(ev) => setPivot(pivot.pivotX, parseInt(ev.target.value) / 100)} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const NOISE_LEVELS = [
  { id: null, label: 'Off' },
  { id: 'light', label: 'Light' },
  { id: 'medium', label: 'Medium' },
  { id: 'strong', label: 'Strong' }
]

/**
 * Background-noise reduction for an audio clip: the backend cleans the
 * uploaded file (POST /api/clip/denoise) and the clip switches to the cleaned
 * audio, so preview and render both play it. Off switches back.
 */
function NoiseControls({ clip, onUpdateClip }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  // The uploaded original (kept while a cleaned version is in use)
  const source = clip.denoiseSourceUrl || clip.serverUrl
  const canClean = !!source && /\/api\/upload\/files\//.test(source)

  const choose = async (level) => {
    setError(null)
    if (!level) {
      if (clip.denoise) onUpdateClip({ url: clip.denoiseLocalUrl || source, serverUrl: source, denoise: null, denoiseSourceUrl: null, denoiseLocalUrl: null })
      return
    }
    setBusy(level)
    try {
      const res = await authFetch(api('/api/clip/denoise'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: source, strength: level })
      })
      if (!res.ok) throw new Error(String(res.status))
      const { url } = await res.json()
      const backend = getBackendUrl()
      const cleaned = backend && url.startsWith('/') ? `${backend}${url}` : url
      onUpdateClip({
        url: cleaned,
        serverUrl: cleaned,
        denoise: level,
        denoiseSourceUrl: source,
        // What the preview played before (often the local file), for Off
        denoiseLocalUrl: clip.denoise ? clip.denoiseLocalUrl : clip.url
      })
    } catch {
      setError('Noise reduction failed. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="property-group">
      <label>Reduce background noise</label>
      {canClean ? (
        <div className="noise-levels" role="radiogroup" aria-label="Noise reduction">
          {NOISE_LEVELS.map(({ id, label }) => (
            <button
              key={label}
              role="radio"
              aria-checked={(clip.denoise || null) === id}
              className={(clip.denoise || null) === id ? 'active' : ''}
              disabled={!!busy}
              onClick={() => choose(id)}
            >
              {busy && busy === id ? '…' : label}
            </button>
          ))}
        </div>
      ) : (
        <p className="noise-hint">Available once this clip has finished uploading.</p>
      )}
      {error && <p className="noise-hint error">{error}</p>}
    </div>
  )
}

function GreenScreenControls({ clip, onUpdateClip, playheadPosition }) {
  const [grabbing, setGrabbing] = useState(false)
  const [grabError, setGrabError] = useState(null)
  const key = normalizeChromaKey(clip.chromaKey)
  const isStatic = key?.mode === 'static'
  const ranges = isStatic ? KEY_RANGES.static : KEY_RANGES.chroma

  const setKey = (patch) => onUpdateClip({ chromaKey: { ...clip.chromaKey, ...patch } })
  const setMode = (mode) => {
    if (!key || mode === key.mode) return
    // Green <-> blue keep the sliders; static uses its own scale
    if (mode !== 'static' && !isStatic) setKey({ color: mode })
    else onUpdateClip({ chromaKey: defaultChromaKey(mode, mode === 'static' ? clip.chromaKey?.plateUrl : null, mode === 'static' ? clip.chromaKey?.noiseUrl : null) })
  }

  // The clean plate: the frame at the playhead (or the clip's first frame)
  const grabPlate = async () => {
    setGrabbing(true)
    setGrabError(null)
    try {
      const start = clip.timelinePosition || 0
      const len = clip.endTime - clip.startTime
      const inClip = typeof playheadPosition === 'number' && playheadPosition >= start && playheadPosition < start + len
      const time = inClip ? clip.startTime + (playheadPosition - start) : clip.startTime
      // 12 frames: averaged into the plate, and their spread as the noise map
      const { plate, noise } = await grabVideoFrame(clip.url, time, 1280, 12, true)
      const plateUrl = await canvasToBlobUrl(plate)
      const noiseUrl = noise ? await canvasToBlobUrl(noise) : undefined
      onUpdateClip({ chromaKey: { ...clip.chromaKey, color: 'static', plateUrl, noiseUrl } })
    } catch (err) {
      console.warn('[ClipProperties] background frame:', err)
      setGrabError('Could not grab that frame. Try again, or pick another moment.')
    } finally {
      setGrabbing(false)
    }
  }

  const pct = (v) => Math.round(v * 100)
  return (
    <div className="prop-group">
      <div className="prop-group-label">Green screen</div>
      <div className="property-group">
        <label>
          Remove background
          <label className="toggle-switch" style={{ marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={!!key}
              onChange={(e) => onUpdateClip({ chromaKey: e.target.checked ? defaultChromaKey('green') : undefined })}
            />
            <span className="toggle-slider" />
          </label>
        </label>
        {key && (
          <>
            <div className="text-align-buttons chroma-mode-buttons">
              {[['green', 'Green'], ['blue', 'Blue'], ['static', 'Static (experimental)']].map(([mode, label]) => (
                <button
                  key={mode}
                  className={`text-align-btn ${key.mode === mode ? 'active' : ''}`}
                  onClick={() => setMode(mode)}
                  title={mode === 'static' ? 'Static background (experimental): removes whatever matches a frame of the empty background' : `${label} screen`}
                >
                  {label}
                </button>
              ))}
            </div>
            <small className="layout-hint">
              {isStatic
                ? 'Removes everything that looks like a few frames of the empty background. Small changes (noise, light, focus) are ignored and parts of you that match the wall are kept inside your outline. Needs a camera that does not move; shadows you cast stay visible. If parts of the room keep showing, raise Threshold.'
                : `Removes the ${key.mode} backdrop so the clips on the tracks below show through.`}
            </small>
          </>
        )}
      </div>

      {key && isStatic && (
        <div className="property-group">
          <label>Empty background frame</label>
          {key.plateUrl ? (
            <img className="chroma-plate-thumb" src={key.plateUrl} alt="Empty background" />
          ) : (
            <small className="layout-hint">Move the playhead to a moment that shows only the background, without you in it. Half a second of it is used.</small>
          )}
          <button className="layout-free-btn" onClick={grabPlate} disabled={grabbing}>
            {grabbing ? 'Grabbing frame...' : key.plateUrl ? 'Use the frame at the playhead instead' : 'Use the frame at the playhead'}
          </button>
          {grabError && <small className="layout-hint">{grabError}</small>}
        </div>
      )}

      {key && (
        <>
          <div className="property-group">
            <label title={isStatic ? 'Tolerance: higher ignores more change in the background (noise, light, focus) but can start to remove parts of you' : 'Higher removes more of the screen colour'}>
              Threshold
              <button className="prop-reset-btn" onClick={() => setKey({ similarity: defaultChromaKey(key.mode).similarity })} title="Reset threshold">
                <RotateCcw size={10} />
              </button>
            </label>
            <div className="property-slider">
              <input
                type="range"
                min={pct(ranges.similarity[0])}
                max={pct(ranges.similarity[1])}
                value={pct(key.similarity)}
                onChange={(e) => setKey({ similarity: parseInt(e.target.value) / 100 })}
              />
              <span>{pct(key.similarity)}%</span>
            </div>
          </div>
          <div className="property-group">
            <label>
              Edge softness
              <button className="prop-reset-btn" onClick={() => setKey({ blend: defaultChromaKey(key.mode).blend })} title="Reset softness">
                <RotateCcw size={10} />
              </button>
            </label>
            <div className="property-slider">
              <input
                type="range"
                min={0}
                max={pct(ranges.blend[1])}
                value={pct(key.blend)}
                onChange={(e) => setKey({ blend: parseInt(e.target.value) / 100 })}
              />
              <span>{pct(key.blend)}%</span>
            </div>
          </div>
          <div className="property-group">
            <label title={isStatic ? 'Removes the wall colour from the edges' : `Removes the ${key.mode} tint from the edges`}>
              Despill
              <button className="prop-reset-btn" onClick={() => setKey({ spill: defaultChromaKey(key.mode).spill })} title="Reset despill">
                <RotateCcw size={10} />
              </button>
            </label>
            <div className="property-slider">
              <input
                type="range"
                min={0}
                max={100}
                value={pct(key.spill)}
                onChange={(e) => setKey({ spill: parseInt(e.target.value) / 100 })}
              />
              <span>{pct(key.spill)}%</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// Draggable number input - drag left/right to change value
// On mobile: long press (0.5s) on the label to start dragging
function DraggableNumberInput({ value, onChange, min, max, step = 1, suffix = '', label }) {
  const [isDragging, setIsDragging] = useState(false)
  const dragDataRef = useRef({ startX: 0, startValue: 0 })
  const inputRef = useRef(null)
  const longPressTimer = useRef(null)
  const touchStartRef = useRef(null)

  const startDrag = useCallback((clientX) => {
    setIsDragging(true)
    dragDataRef.current = { startX: clientX, startValue: value }
  }, [value])

  const handleMouseDown = useCallback((e) => {
    if (e.target === inputRef.current) return
    e.preventDefault()
    startDrag(e.clientX)

    const handleMouseMove = (moveEvent) => {
      const delta = moveEvent.clientX - dragDataRef.current.startX
      const multiplier = moveEvent.shiftKey ? 0.1 : 1
      const change = Math.round(delta * multiplier * step)
      let newValue = dragDataRef.current.startValue + change
      if (min !== undefined) newValue = Math.max(min, newValue)
      if (max !== undefined) newValue = Math.min(max, newValue)
      onChange(newValue)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [value, onChange, min, max, step, startDrag])

  const handleTouchStart = useCallback((e) => {
    if (e.target === inputRef.current) return
    const touch = e.touches[0]
    touchStartRef.current = { clientX: touch.clientX, clientY: touch.clientY }

    longPressTimer.current = setTimeout(() => {
      // Long press activated — start drag
      startDrag(touch.clientX)

      const handleTouchMove = (moveEvent) => {
        moveEvent.preventDefault()
        const t = moveEvent.touches[0]
        const delta = t.clientX - dragDataRef.current.startX
        const change = Math.round(delta * step)
        let newValue = dragDataRef.current.startValue + change
        if (min !== undefined) newValue = Math.max(min, newValue)
        if (max !== undefined) newValue = Math.min(max, newValue)
        onChange(newValue)
      }

      const handleTouchEnd = () => {
        setIsDragging(false)
        document.removeEventListener('touchmove', handleTouchMove)
        document.removeEventListener('touchend', handleTouchEnd)
      }

      document.addEventListener('touchmove', handleTouchMove, { passive: false })
      document.addEventListener('touchend', handleTouchEnd)
    }, 500)
  }, [value, onChange, min, max, step, startDrag])

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handleInputChange = (e) => {
    let newValue = parseFloat(e.target.value) || 0
    // Only enforce max while typing — min is enforced on blur
    if (max !== undefined) newValue = Math.min(max, newValue)
    onChange(newValue)
  }

  const handleInputBlur = () => {
    if (min !== undefined && value < min) {
      onChange(min)
    }
  }

  return (
    <div
      className={`draggable-input ${isDragging ? 'dragging' : ''}`}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {label && <span className="drag-label">{label}</span>}
      <input
        ref={inputRef}
        type="number"
        value={value}
        onChange={handleInputChange}
        onBlur={handleInputBlur}
        min={min}
        max={max}
        step={step}
      />
      {suffix && <span className="drag-suffix">{suffix}</span>}
    </div>
  )
}

// 2D drag handle for Position — drag to change both X and Y
// On mobile: long press (0.5s) to activate drag
function PositionDragHandle({ positionX, positionY, onChange }) {
  const [isDragging, setIsDragging] = useState(false)
  const dragDataRef = useRef({ startX: 0, startY: 0, startPosX: 0, startPosY: 0 })
  const longPressTimer = useRef(null)

  const startDrag = useCallback((clientX, clientY) => {
    setIsDragging(true)
    dragDataRef.current = {
      startX: clientX,
      startY: clientY,
      startPosX: positionX,
      startPosY: positionY
    }
  }, [positionX, positionY])

  const handleMouseDown = useCallback((e) => {
    e.preventDefault()
    startDrag(e.clientX, e.clientY)

    const handleMouseMove = (moveEvent) => {
      const dx = moveEvent.clientX - dragDataRef.current.startX
      const dy = moveEvent.clientY - dragDataRef.current.startY
      const multiplier = moveEvent.shiftKey ? 0.1 : 1
      const newX = Math.round(dragDataRef.current.startPosX + dx * multiplier)
      const newY = Math.round(dragDataRef.current.startPosY + dy * multiplier)
      onChange(newX, newY)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [positionX, positionY, onChange, startDrag])

  const handleTouchStart = useCallback((e) => {
    const touch = e.touches[0]

    longPressTimer.current = setTimeout(() => {
      startDrag(touch.clientX, touch.clientY)

      const handleTouchMove = (moveEvent) => {
        moveEvent.preventDefault()
        const t = moveEvent.touches[0]
        const dx = t.clientX - dragDataRef.current.startX
        const dy = t.clientY - dragDataRef.current.startY
        const newX = Math.round(dragDataRef.current.startPosX + dx)
        const newY = Math.round(dragDataRef.current.startPosY + dy)
        onChange(newX, newY)
      }

      const handleTouchEnd = () => {
        setIsDragging(false)
        document.removeEventListener('touchmove', handleTouchMove)
        document.removeEventListener('touchend', handleTouchEnd)
      }

      document.addEventListener('touchmove', handleTouchMove, { passive: false })
      document.addEventListener('touchend', handleTouchEnd)
    }, 500)
  }, [positionX, positionY, onChange, startDrag])

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  return (
    <span
      className={`position-drag-handle ${isDragging ? 'dragging' : ''}`}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      title="Drag to reposition"
    >
      <GripVertical size={12} />
    </span>
  )
}

// The tab a phone user last picked, kept across clips (if the next clip has it)
let lastTab = null

function ClipProperties({ clip, onUpdateClip, onSplit, playheadPosition, linkedAudio = null, onUpdateLinkedAudio = null, tabbed = false }) {
  // Phones (tabbed): one section at a time, a tab per section. The sections
  // differ per clip type and come from several components, so the tabs are
  // read from the rendered sections (.prop-group and its label) after render.
  const groupsRef = useRef(null)
  const [tabs, setTabs] = useState([])
  const [activeTab, setActiveTab] = useState(lastTab)
  useLayoutEffect(() => {
    const root = groupsRef.current
    if (!tabbed || !root) return
    const groups = [...root.children].filter(el => el.classList.contains('prop-group'))
    const names = groups.map(g => {
      const label = g.querySelector('.prop-group-label')
      return label ? (label.querySelector('span')?.textContent || label.textContent).trim() : ''
    })
    if (names.join('|') !== tabs.join('|')) setTabs(names)
    const current = names.includes(activeTab) ? activeTab : names[0]
    groups.forEach((g, i) => { g.style.display = names[i] === current ? '' : 'none' })
    if (current !== activeTab) setActiveTab(current)
  })

  if (!clip) {
    return (
      <div className="clip-properties empty">
        <p>Select a clip to view properties</p>
      </div>
    )
  }

  const isAudio = clip.type === 'audio'
  const isImage = clip.type === 'image'
  const isText = clip.type === 'text'
  const isColor = clip.type === 'color'

  const handleChange = (property, value) => {
    onUpdateClip({ [property]: value })
  }

  return (
    <div className="clip-properties">
      <div className="properties-header">
        <div className="properties-info">
          <span className="clip-name">{clip.name}</span>
          <span className="clip-type">{clip.type}</span>
        </div>
      </div>

      {tabbed && tabs.length > 1 && (
        <div className="properties-tabs" role="tablist">
          {tabs.map(name => (
            <button
              key={name}
              role="tab"
              aria-selected={name === activeTab}
              className={name === activeTab ? 'active' : ''}
              onClick={() => { setActiveTab(name); lastTab = name }}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className={`properties-groups${tabbed ? ' tabbed' : ''}`} ref={groupsRef}>
        {/* GROUP 1: Content / Audio (images have no sound: no such section) */}
        {!isImage && (
        <div className="prop-group">
          <div className="prop-group-label">
            {isText ? 'Content' : isColor ? 'Color' : isAudio ? 'Audio' : 'Audio'}
          </div>

          {/* Text content & style - only for text clips */}
          {isText && (
            <>
              <div className="property-group">
                <label>
                  <Type size={12} />
                  Text
                </label>
                <textarea
                  className="text-input"
                  value={clip.text || ''}
                  onChange={(e) => handleChange('text', e.target.value)}
                  placeholder="Enter text here..."
                  rows={2}
                />
              </div>

              <div className="property-group">
                <label>
                  Font
                  {((clip.fontFamily && clip.fontFamily !== 'Roboto') || (clip.fontWeight && clip.fontWeight !== 'normal')) && (
                    <button className="prop-reset-btn" onClick={() => onUpdateClip({ fontFamily: 'Roboto', fontWeight: 'normal' })} title="Reset font">
                      <RotateCcw size={10} />
                    </button>
                  )}
                </label>
                <div className="property-inputs style-inputs">
                  <select
                    value={clip.fontFamily || 'Roboto'}
                    onChange={(e) => handleChange('fontFamily', e.target.value)}
                    className="font-select"
                  >
                    <optgroup label="Sans Serif">
                      <option value="Roboto" style={{ fontFamily: 'Roboto' }}>Roboto</option>
                      <option value="Open Sans" style={{ fontFamily: 'Open Sans' }}>Open Sans</option>
                      <option value="Lato" style={{ fontFamily: 'Lato' }}>Lato</option>
                      <option value="Montserrat" style={{ fontFamily: 'Montserrat' }}>Montserrat</option>
                      <option value="Poppins" style={{ fontFamily: 'Poppins' }}>Poppins</option>
                      <option value="Nunito" style={{ fontFamily: 'Nunito' }}>Nunito</option>
                      <option value="Raleway" style={{ fontFamily: 'Raleway' }}>Raleway</option>
                      <option value="Inter" style={{ fontFamily: 'Inter' }}>Inter</option>
                    </optgroup>
                    <optgroup label="Serif">
                      <option value="Playfair Display" style={{ fontFamily: 'Playfair Display' }}>Playfair Display</option>
                      <option value="Merriweather" style={{ fontFamily: 'Merriweather' }}>Merriweather</option>
                      <option value="Lora" style={{ fontFamily: 'Lora' }}>Lora</option>
                    </optgroup>
                    <optgroup label="Display">
                      <option value="Oswald" style={{ fontFamily: 'Oswald' }}>Oswald</option>
                      <option value="Bebas Neue" style={{ fontFamily: 'Bebas Neue' }}>Bebas Neue</option>
                      <option value="Anton" style={{ fontFamily: 'Anton' }}>Anton</option>
                      <option value="Archivo Black" style={{ fontFamily: 'Archivo Black' }}>Archivo Black</option>
                      <option value="Righteous" style={{ fontFamily: 'Righteous' }}>Righteous</option>
                      <option value="Titan One" style={{ fontFamily: 'Titan One' }}>Titan One</option>
                      <option value="Fredoka" style={{ fontFamily: 'Fredoka' }}>Fredoka</option>
                      <option value="Lobster" style={{ fontFamily: 'Lobster' }}>Lobster</option>
                    </optgroup>
                    <optgroup label="Handwriting">
                      <option value="Dancing Script" style={{ fontFamily: 'Dancing Script' }}>Dancing Script</option>
                      <option value="Pacifico" style={{ fontFamily: 'Pacifico' }}>Pacifico</option>
                      <option value="Caveat" style={{ fontFamily: 'Caveat' }}>Caveat</option>
                      <option value="Permanent Marker" style={{ fontFamily: 'Permanent Marker' }}>Permanent Marker</option>
                      <option value="Bangers" style={{ fontFamily: 'Bangers' }}>Bangers</option>
                    </optgroup>
                    <optgroup label="Monospace">
                      <option value="Roboto Mono" style={{ fontFamily: 'Roboto Mono' }}>Roboto Mono</option>
                      <option value="Press Start 2P" style={{ fontFamily: 'Press Start 2P' }}>Press Start 2P</option>
                    </optgroup>
                  </select>
                  <select
                    value={clip.fontWeight || 'normal'}
                    onChange={(e) => handleChange('fontWeight', e.target.value)}
                    className="weight-select"
                  >
                    <option value="normal">Normal</option>
                    <option value="bold">Bold</option>
                  </select>
                </div>
              </div>

              <div className="property-group">
                <label>
                  Style
                  {((clip.fontSize && clip.fontSize !== 48) || (clip.fontColor && clip.fontColor !== '#ffffff')) && (
                    <button className="prop-reset-btn" onClick={() => onUpdateClip({ fontSize: 48, fontColor: '#ffffff' })} title="Reset style">
                      <RotateCcw size={10} />
                    </button>
                  )}
                </label>
                <div className="property-inputs">
                  <DraggableNumberInput
                    label="Size"
                    value={clip.fontSize || 48}
                    onChange={(v) => handleChange('fontSize', v)}
                    min={8}
                    max={200}
                    suffix="px"
                  />
                  <div className="color-field">
                    <input
                      type="color"
                      value={clip.fontColor || '#ffffff'}
                      onChange={(e) => handleChange('fontColor', e.target.value)}
                      className="color-input"
                    />
                    <span className="color-value">{clip.fontColor || '#ffffff'}</span>
                  </div>
                </div>
              </div>

              <div className="property-group">
                <label>
                  Alignment
                  {clip.textHAlign && clip.textHAlign !== 'center' && (
                    <button className="prop-reset-btn" onClick={() => handleChange('textHAlign', 'center')} title="Reset alignment">
                      <RotateCcw size={10} />
                    </button>
                  )}
                </label>
                <div className="text-align-buttons">
                  {['left', 'center', 'right'].map((align) => (
                    <button
                      key={align}
                      className={`text-align-btn ${(clip.textHAlign || 'center') === align ? 'active' : ''}`}
                      onClick={() => handleChange('textHAlign', align)}
                      title={`Align ${align}`}
                    >
                      {align === 'left' && <AlignLeft size={14} />}
                      {align === 'center' && <AlignCenter size={14} />}
                      {align === 'right' && <AlignRight size={14} />}
                    </button>
                  ))}
                </div>
              </div>

              <div className="property-group">
                <label>
                  Background Box
                  <label className="toggle-switch" style={{ marginLeft: 'auto' }}>
                    <input
                      type="checkbox"
                      checked={clip.textBoxEnabled || false}
                      onChange={(e) => handleChange('textBoxEnabled', e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </label>
                {clip.textBoxEnabled && (
                  <>
                    <div className="property-inputs">
                      <div className="color-field">
                        <label className="color-label">Fill</label>
                        <input
                          type="color"
                          value={clip.textBoxColor || '#000000'}
                          onChange={(e) => handleChange('textBoxColor', e.target.value)}
                          className="color-input"
                        />
                        <span className="color-value">{clip.textBoxColor || '#000000'}</span>
                      </div>
                      <DraggableNumberInput
                        label="Opacity"
                        value={clip.textBoxOpacity ?? 80}
                        onChange={(v) => handleChange('textBoxOpacity', v)}
                        min={0}
                        max={100}
                        suffix="%"
                      />
                    </div>
                    <div className="property-inputs">
                      <DraggableNumberInput
                        label="Padding"
                        value={clip.textBoxPadding ?? 12}
                        onChange={(v) => handleChange('textBoxPadding', v)}
                        min={0}
                        max={100}
                        suffix="px"
                      />
                      <DraggableNumberInput
                        label="Radius"
                        value={clip.textBoxRadius ?? 8}
                        onChange={(v) => handleChange('textBoxRadius', v)}
                        min={0}
                        max={50}
                        suffix="px"
                      />
                    </div>
                    <div className="property-inputs">
                      <div className="color-field">
                        <label className="color-label">Border</label>
                        <input
                          type="color"
                          value={clip.textBoxBorderColor || '#ffffff'}
                          onChange={(e) => handleChange('textBoxBorderColor', e.target.value)}
                          className="color-input"
                        />
                        <span className="color-value">{clip.textBoxBorderColor || '#ffffff'}</span>
                      </div>
                      <DraggableNumberInput
                        label="Width"
                        value={clip.textBoxBorderWidth ?? 0}
                        onChange={(v) => handleChange('textBoxBorderWidth', v)}
                        min={0}
                        max={20}
                        suffix="px"
                      />
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {/* Color controls - for color clips */}
          {isColor && (
            <>
              <div className="property-group">
                <label>
                  <Palette size={12} />
                  Background Color
                </label>
                <div className="color-field">
                  <input
                    type="color"
                    value={clip.backgroundColor || '#000000'}
                    onChange={(e) => handleChange('backgroundColor', e.target.value)}
                    className="color-input"
                  />
                  <span className="color-value">{clip.backgroundColor || '#000000'}</span>
                </div>
              </div>

              <div className="property-group">
                <label>
                  Gradient
                </label>
                <button
                  className={`mute-btn ${clip.gradientEnabled ? '' : 'muted'}`}
                  onClick={() => handleChange('gradientEnabled', !clip.gradientEnabled)}
                >
                  {clip.gradientEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>

              {clip.gradientEnabled && (
                <>
                  <div className="property-group">
                    <label>End Color</label>
                    <div className="color-field">
                      <input
                        type="color"
                        value={clip.gradientEndColor || '#ffffff'}
                        onChange={(e) => handleChange('gradientEndColor', e.target.value)}
                        className="color-input"
                      />
                      <span className="color-value">{clip.gradientEndColor || '#ffffff'}</span>
                    </div>
                  </div>

                  <div className="property-group">
                    <label>
                      Angle
                      {clip.gradientAngle !== undefined && clip.gradientAngle !== 180 && (
                        <button className="prop-reset-btn" onClick={() => handleChange('gradientAngle', 180)} title="Reset angle">
                          <RotateCcw size={10} />
                        </button>
                      )}
                    </label>
                    <div className="property-slider">
                      <input
                        type="range"
                        min="0"
                        max="360"
                        value={clip.gradientAngle ?? 180}
                        onChange={(e) => handleChange('gradientAngle', parseInt(e.target.value))}
                      />
                      <span>{clip.gradientAngle ?? 180}°</span>
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* Volume control - for non-text, non-color clips */}
          {!isText && !isColor && (() => {
            // A video's sound plays from its linked clip on the audio track (the
            // video clip itself stays silent so nothing plays twice): the volume
            // and mute here are that clip's
            const target = clip.type === 'video' && linkedAudio && onUpdateLinkedAudio ? linkedAudio : clip
            const update = target === clip ? onUpdateClip : onUpdateLinkedAudio
            const volume = target.volume ?? 100
            const on = target.audioEnabled !== false
            return (
              <div className="property-group">
                <label>
                  <Volume2 size={12} />
                  Volume
                  {(volume !== 100 || !on) && (
                    <button className="prop-reset-btn" onClick={() => update({ volume: 100, audioEnabled: true })} title="Reset volume">
                      <RotateCcw size={10} />
                    </button>
                  )}
                </label>
                <div className="property-slider">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={volume}
                    onChange={(e) => update({ volume: parseInt(e.target.value) })}
                  />
                  <span>{volume}%</span>
                </div>
                <button
                  className={`mute-btn ${!on ? 'muted' : ''}`}
                  onClick={() => update({ audioEnabled: !on })}
                >
                  {on ? 'Mute' : 'Unmute'}
                </button>
              </div>
            )
          })()}

          {isAudio && <NoiseControls clip={clip} onUpdateClip={onUpdateClip} />}
        </div>
        )}

        {/* GROUP 2a: Remix layout box (replaces Scale/Position/Crop) */}
        {!isAudio && hasLayout(clip) && (
          <div className="prop-group">
            <div className="prop-group-label">Layout</div>
            <div className="property-group">
              <label>
                <Move size={12} />
                Box size
              </label>
              <div className="layout-size-row">
                <button className="layout-size-btn" onClick={() => onUpdateClip({ layout: scaleLayout(clip.layout, 1 / 1.15) })} title="Smaller">
                  <Minus size={12} />
                </button>
                <span>{Math.round(clip.layout.w * 100)}% x {Math.round(clip.layout.h * 100)}%</span>
                <button className="layout-size-btn" onClick={() => onUpdateClip({ layout: scaleLayout(clip.layout, 1.15) })} title="Larger">
                  <Plus size={12} />
                </button>
              </div>
            </div>
            <div className="property-group">
              <label>
                <ZoomIn size={12} />
                Zoom
                {layoutZoom(clip.layout) !== 1 && (
                  <button className="prop-reset-btn" onClick={() => onUpdateClip({ layout: { ...clip.layout, zoom: 1 } })} title="Reset zoom">
                    <RotateCcw size={10} />
                  </button>
                )}
              </label>
              <div className="property-slider">
                <input
                  type="range"
                  min={LAYOUT_ZOOM_MIN * 100}
                  max={LAYOUT_ZOOM_MAX * 100}
                  value={Math.round(layoutZoom(clip.layout) * 100)}
                  onChange={(e) => onUpdateClip({ layout: { ...clip.layout, zoom: parseInt(e.target.value) / 100 } })}
                />
                <span>{Math.round(layoutZoom(clip.layout) * 100)}%</span>
              </div>
              <small className="layout-hint">Drag the clip to move it. Press and hold, then drag, to move the video inside its box. Pinch to zoom on touch screens.</small>
              <button className="layout-free-btn" onClick={() => onUpdateClip({ layout: undefined })}>
                Switch to free transform
              </button>
            </div>
          </div>
        )}

        {/* GROUP 2: Transform (non-audio only) */}
        {!isAudio && !hasLayout(clip) && (
          <div className="prop-group">
            <div className="prop-group-label">Transform</div>

            <div className="property-group">
              <label>
                <ZoomIn size={12} />
                Scale
                {clip.zoom !== undefined && clip.zoom !== 100 && (
                  <button className="prop-reset-btn" onClick={() => handleChange('zoom', 100)} title="Reset scale">
                    <RotateCcw size={10} />
                  </button>
                )}
              </label>
              <div className="property-slider">
                <input
                  type="range"
                  min="1"
                  max="500"
                  value={clip.zoom || 100}
                  onChange={(e) => handleChange('zoom', parseInt(e.target.value))}
                />
                <span>{clip.zoom || 100}%</span>
              </div>
            </div>

            {/* Images and text (stickers are either) turn around their own centre */}
            {(clip.type === 'image' || clip.type === 'text') && (
              <div className="property-group">
                <label>
                  <RotateCw size={12} />
                  Rotation
                  {clip.rotation ? (
                    <button className="prop-reset-btn" onClick={() => handleChange('rotation', 0)} title="Reset rotation">
                      <RotateCcw size={10} />
                    </button>
                  ) : null}
                </label>
                <div className="property-slider">
                  <input
                    type="range"
                    min="-180"
                    max="180"
                    value={clip.rotation || 0}
                    onChange={(e) => handleChange('rotation', parseInt(e.target.value))}
                  />
                  <span>{clip.rotation || 0}°</span>
                </div>
              </div>
            )}

            <div className="property-group">
              <label>
                <Move size={12} />
                Position
                {(clip.positionX || clip.positionY) ? (
                  <button className="prop-reset-btn" onClick={() => onUpdateClip({ positionX: 0, positionY: 0 })} title="Reset position">
                    <RotateCcw size={10} />
                  </button>
                ) : null}
                <PositionDragHandle
                  positionX={clip.positionX || 0}
                  positionY={clip.positionY || 0}
                  onChange={(x, y) => onUpdateClip({ positionX: x, positionY: y })}
                />
              </label>
              <div className="property-inputs">
                <DraggableNumberInput
                  label="X"
                  value={clip.positionX || 0}
                  onChange={(v) => handleChange('positionX', v)}
                  suffix="px"
                />
                <DraggableNumberInput
                  label="Y"
                  value={clip.positionY || 0}
                  onChange={(v) => handleChange('positionY', v)}
                  suffix="px"
                />
              </div>
            </div>

            <div className="property-group">
              <label>
                <Crop size={12} />
                Crop
                {(clip.cropX || clip.cropY || (clip.cropWidth !== undefined && clip.cropWidth !== 100) || (clip.cropHeight !== undefined && clip.cropHeight !== 100)) && (
                  <button className="prop-reset-btn" onClick={() => onUpdateClip({ cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100 })} title="Reset crop">
                    <RotateCcw size={10} />
                  </button>
                )}
              </label>
              <div className="property-inputs crop-inputs">
                <DraggableNumberInput
                  label="X"
                  value={clip.cropX || 0}
                  onChange={(v) => handleChange('cropX', v)}
                  min={0}
                  max={100}
                  suffix="%"
                />
                <DraggableNumberInput
                  label="Y"
                  value={clip.cropY || 0}
                  onChange={(v) => handleChange('cropY', v)}
                  min={0}
                  max={100}
                  suffix="%"
                />
                <DraggableNumberInput
                  label="W"
                  value={clip.cropWidth || 100}
                  onChange={(v) => handleChange('cropWidth', v)}
                  min={1}
                  max={100}
                  suffix="%"
                />
                <DraggableNumberInput
                  label="H"
                  value={clip.cropHeight || 100}
                  onChange={(v) => handleChange('cropHeight', v)}
                  min={1}
                  max={100}
                  suffix="%"
                />
              </div>
            </div>

            {!isText && (
              <div className="property-group">
                <label>
                  <Droplets size={12} />
                  Opacity
                  {clip.opacity !== undefined && clip.opacity !== 100 && (
                    <button className="prop-reset-btn" onClick={() => handleChange('opacity', 100)} title="Reset opacity">
                      <RotateCcw size={10} />
                    </button>
                  )}
                </label>
                <div className="property-slider">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={clip.opacity ?? 100}
                    onChange={(e) => handleChange('opacity', parseInt(e.target.value))}
                  />
                  <span>{clip.opacity ?? 100}%</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Motion (stickers: image and text clips) */}
        {(isImage || isText) && <MotionControls clip={clip} onUpdateClip={onUpdateClip} />}

        {/* Colour adjustments (video and image clips) */}
        {(clip.type === 'video' || isImage) && (
          <ColorControls clip={clip} onUpdateClip={onUpdateClip} />
        )}

        {/* Green screen (video clips: camera takes, imports, library clips) */}
        {clip.type === 'video' && (
          <GreenScreenControls clip={clip} onUpdateClip={onUpdateClip} playheadPosition={playheadPosition} />
        )}

        {/* GROUP 3: Timing */}
        <div className="prop-group">
          <div className="prop-group-label">Timing</div>

          {/* Duration control for images/text/color */}
          {(isImage || isText || isColor) && (
            <div className="property-group">
              <label>Duration</label>
              <div className="property-inputs">
                <DraggableNumberInput
                  label="Sec"
                  value={parseFloat((clip.endTime - clip.startTime).toFixed(1))}
                  onChange={(v) => handleChange('endTime', clip.startTime + Math.max(0.1, v))}
                  min={0.1}
                  max={600}
                  step={0.1}
                  suffix="s"
                />
              </div>
            </div>
          )}

          <div className="property-group timing">
            <div className="timing-info">
              <div>
                <span>In:</span>
                <span>{clip.startTime?.toFixed(2)}s</span>
              </div>
              <div>
                <span>Out:</span>
                <span>{clip.endTime?.toFixed(2)}s</span>
              </div>
              <div>
                <span>Duration:</span>
                <span>{(clip.endTime - clip.startTime)?.toFixed(2)}s</span>
              </div>
              <div>
                <span>Position:</span>
                <span>{(clip.timelinePosition || 0).toFixed(2)}s</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ClipProperties
