import { useEffect, useLayoutEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { HOST_URL } from './engine'

// The scene engine's host page in a same-origin iframe, scaled to fit. The page is always the ad's real size
// (1920x1080 or 1080x1920) so every layout is exactly what renders; the wizard calls seek(t) on it directly.
const ScenePreview = forwardRef(function ScenePreview({ doc, onInfo, onError }, ref) {
  const frameRef = useRef(null)
  const boxRef = useRef(null)
  const [scale, setScale] = useState(0.3)
  const [hostReady, setHostReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const lastT = useRef(0)
  const W = doc.width, H = doc.height

  useImperativeHandle(ref, () => ({
    seek(t) {
      lastT.current = t
      const w = frameRef.current?.contentWindow
      try { w?.reel?.seek(Math.max(0, Math.min(w.reel.duration, t))) } catch { /* mid-reload */ }
    },
  }), [])

  // fit the frame into the box
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return undefined
    const fit = () => setScale(Math.min(box.clientWidth / W, box.clientHeight / H))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    return () => ro.disconnect()
  }, [W, H])

  // (re)load the doc, debounced while typing; a newer load supersedes an older one inside the host
  useEffect(() => {
    if (!hostReady) return undefined
    const w = frameRef.current?.contentWindow
    if (!w?.loadDoc) return undefined
    setLoading(true)
    const id = setTimeout(async () => {
      try {
        const info = await w.loadDoc(doc)
        if (!info) return
        w.reel.seek(Math.min(lastT.current, info.duration))
        onInfo?.(info)
        onError?.(null)
      } catch (e) {
        onError?.(e?.message || String(e))
      } finally { setLoading(false) }
    }, 220)
    return () => clearTimeout(id)
  }, [doc, hostReady]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="aw-preview" ref={boxRef}>
      <div className="aw-frame-wrap" style={{ width: W * scale, height: H * scale }}>
        <iframe
          ref={frameRef}
          title="Ad preview"
          src={HOST_URL}
          className="aw-frame"
          style={{ width: W, height: H, transform: `scale(${scale})` }}
          onLoad={() => setHostReady(true)}
          sandbox="allow-scripts allow-same-origin"
        />
        {loading && <div className="aw-frame-busy" aria-hidden="true" />}
      </div>
    </div>
  )
})

export default ScenePreview
