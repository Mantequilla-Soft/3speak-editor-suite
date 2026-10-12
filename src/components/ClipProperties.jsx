import { useState, useRef, useCallback } from 'react'
import { Volume2, ZoomIn, Move, Crop, Type, GripVertical, RotateCcw, Droplets, AlignLeft, AlignCenter, AlignRight, Palette, Minus, Plus } from 'lucide-react'
import { hasLayout, scaleLayout, layoutZoom, LAYOUT_ZOOM_MIN, LAYOUT_ZOOM_MAX } from '../utils/remixLayout'
import { normalizeChromaKey, defaultChromaKey, KEY_RANGES, grabVideoFrame, canvasToBlobUrl } from '../utils/chromaKey'
import './GreenScreen.css'

// Green screen (chroma key) on a video clip: keyed pixels turn transparent, so
// the clips on the tracks below show through. See utils/chromaKey.js.
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

function ClipProperties({ clip, onUpdateClip, onSplit, playheadPosition }) {
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

      <div className="properties-groups">
        {/* GROUP 1: Content / Audio */}
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
          {!isText && !isColor && (
            <div className="property-group">
              <label>
                <Volume2 size={12} />
                Volume
                {(clip.volume !== undefined && clip.volume !== 100) && (
                  <button className="prop-reset-btn" onClick={() => onUpdateClip({ volume: 100, audioEnabled: true })} title="Reset volume">
                    <RotateCcw size={10} />
                  </button>
                )}
              </label>
              <div className="property-slider">
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={clip.volume || 100}
                  onChange={(e) => handleChange('volume', parseInt(e.target.value))}
                />
                <span>{clip.volume || 100}%</span>
              </div>
              <button
                className={`mute-btn ${!clip.audioEnabled ? 'muted' : ''}`}
                onClick={() => handleChange('audioEnabled', !clip.audioEnabled)}
              >
                {clip.audioEnabled ? 'Mute' : 'Unmute'}
              </button>
            </div>
          )}
        </div>

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
