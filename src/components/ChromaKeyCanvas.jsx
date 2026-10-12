import { useEffect, useRef } from 'react'
import { createKeyer, keySignature } from '../utils/chromaKey'
import './GreenScreen.css'

/**
 * Draws the keyed picture of a <video> into a canvas that stands in for it.
 *
 * getSource() returns the current video element (it is called every frame, so
 * a replaced element is picked up). The canvas is sized to the video, so the
 * same CSS as the video (object-fit / object-position, transforms, clip-path)
 * frames it identically. Redraws while playing, after seeks and on key changes.
 *
 * keyConfig: normalized key (normalizeChromaKey) or null; onFail() is called
 * once when keying is impossible (no WebGL / 2D context, cross-origin video).
 */
export default function ChromaKeyCanvas({ getSource, keyConfig, style, className, onFail }) {
  const canvasRef = useRef(null)
  const keyerRef = useRef(null)
  const getSourceRef = useRef(getSource)
  getSourceRef.current = getSource
  const keyRef = useRef(keyConfig)
  keyRef.current = keyConfig
  const onFailRef = useRef(onFail)
  onFailRef.current = onFail
  const plateVersionRef = useRef(0)
  const plateUrl = keyConfig?.mode === 'static' ? keyConfig.plateUrl : null
  const noiseUrl = keyConfig?.mode === 'static' ? keyConfig.noiseUrl : null

  // One keyer per canvas, plus the draw loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const keyer = createKeyer(canvas)
    if (!keyer) {
      onFailRef.current?.()
      return
    }
    keyerRef.current = keyer

    let raf = 0
    let failed = false
    let dirty = true
    let bound = null
    let last = { t: -1, sig: '', plate: -1 }
    const markDirty = () => { dirty = true }
    const bind = (el) => {
      if (bound === el) return
      if (bound) {
        bound.removeEventListener('seeked', markDirty)
        bound.removeEventListener('loadeddata', markDirty)
      }
      bound = el
      if (el) {
        el.addEventListener('seeked', markDirty)
        el.addEventListener('loadeddata', markDirty)
      }
      dirty = true
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const src = getSourceRef.current?.()
      bind(src || null)
      if (!src || src.readyState < 2) return
      const sig = keySignature(keyRef.current)
      const live = !!src.srcObject
      if (!dirty && !live && src.paused && src.currentTime === last.t &&
          sig === last.sig && plateVersionRef.current === last.plate) return
      try {
        if (keyer.draw(src, keyRef.current)) {
          dirty = false
          last = { t: src.currentTime, sig, plate: plateVersionRef.current }
        }
      } catch (err) {
        if (!failed) {
          failed = true
          console.warn('[ChromaKeyCanvas] keying unavailable:', err?.message || err)
          cancelAnimationFrame(raf)
          onFailRef.current?.()
        }
      }
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      bind(null)
      keyer.dispose()
      keyerRef.current = null
    }
  }, [])

  // Clean plate for the static-background key
  useEffect(() => {
    if (!plateUrl) {
      keyerRef.current?.setPlate(null)
      plateVersionRef.current++
      return
    }
    let cancelled = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (cancelled || !keyerRef.current) return
      try {
        keyerRef.current.setPlate(img)
      } catch (err) {
        console.warn('[ChromaKeyCanvas] background frame unusable:', err?.message || err)
        keyerRef.current.setPlate(null)
      }
      plateVersionRef.current++
    }
    img.src = plateUrl
    return () => { cancelled = true }
  }, [plateUrl])

  // Its noise map (how much each spot of the plate flickers by itself)
  useEffect(() => {
    if (!noiseUrl) {
      keyerRef.current?.setNoise?.(null)
      plateVersionRef.current++
      return
    }
    let cancelled = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (cancelled || !keyerRef.current) return
      keyerRef.current.setNoise?.(img)
      plateVersionRef.current++
    }
    img.src = noiseUrl
    return () => { cancelled = true }
  }, [noiseUrl])

  return <canvas ref={canvasRef} className={className} style={style} />
}
