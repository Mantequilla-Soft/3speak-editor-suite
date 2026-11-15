import { useEffect, useRef } from 'react'
import { createKeyer, keySignature } from '../utils/chromaKey'
import { maskFrameIndex, maskFrame } from '../utils/personMask'
import { cachedMaskTrack, loadMaskTrack } from '../utils/personMaskJobs'
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
 *
 * Person key (background removal without a green screen): the matte comes from
 * the clip's track (keyConfig.maskUrl, utils/personMaskJobs.js) and, until that
 * exists, from the segmenter running on the frame shown (the camera recorder
 * always works that way).
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
  const isPerson = keyConfig?.mode === 'person'
  const maskUrl = isPerson ? keyConfig.maskUrl : null
  const maskTrackRef = useRef(null)
  const liveMatteRef = useRef(null)
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
    // Person key: the clip's matte track at the frame's media time, else live
    keyer.setPersonMask?.((src, time) => {
      const track = maskTrackRef.current
      if (track) return { mask: maskFrame(track, maskFrameIndex(track.header, time)), w: track.header.w, h: track.header.h }
      return liveMatteRef.current ? liveMatteRef.current.get(src) : null
    })

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
      // a person key without its track segments live: redraw while playing
      const live = !!src.srcObject || (keyRef.current?.mode === 'person' && !maskTrackRef.current && !src.paused)
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

  // Person key: its matte track, or the live segmenter until there is one
  useEffect(() => {
    if (!isPerson) {
      maskTrackRef.current = null
      return
    }
    let cancelled = false
    const bump = () => { plateVersionRef.current++ }
    maskTrackRef.current = cachedMaskTrack(maskUrl)
    if (!maskTrackRef.current && maskUrl) {
      loadMaskTrack(maskUrl).then((t) => { if (!cancelled) { maskTrackRef.current = t; bump() } })
    }
    if (!maskTrackRef.current && !liveMatteRef.current) {
      import('../utils/personSegmenter').then(({ createLiveMatte }) => {
        if (!cancelled && !liveMatteRef.current) liveMatteRef.current = createLiveMatte({ onReady: bump })
        bump()
      }).catch(() => onFailRef.current?.())
    }
    bump()
    return () => { cancelled = true }
  }, [isPerson, maskUrl])

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
