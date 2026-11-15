import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SCENE_HOST_URL, SCENE_CHROME_CSS, SCENE_TRANSPARENT_CSS, sceneDoc, sceneLength } from '../utils/titleScenes'
import { useT } from '../i18n'

// The scene time a title clip shows at a timeline moment (held at its ends)
export const sceneTimeAt = (clip, position) =>
  Math.max(0, Math.min(sceneLength(clip), (clip.startTime || 0) + (position - (clip.timelineStart ?? clip.timelinePosition ?? 0))))

/**
 * A title (a clip of type 'scene', utils/titleScenes.js) in the preview: the
 * scene engine's host page in a same-origin iframe at the output's real size,
 * scaled onto the canvas, seeked to the playhead. Over the video its page has
 * no background. The playback loop seeks it every frame through `registry`.
 */
export default function SceneLayer({ clip, time, frame, style, registry, ...rest }) {
  const { t } = useT()
  const boxRef = useRef(null)
  const frameRef = useRef(null)
  const [scale, setScale] = useState(0)
  const [ready, setReady] = useState(false)
  const docKey = JSON.stringify([clip.scene, clip.sceneStyle, frame.width, frame.height])
  const transparent = clip.transparent !== false

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return undefined
    const fit = () => setScale(box.clientWidth / frame.width)
    fit()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
    ro?.observe(box)
    return () => ro?.disconnect()
  }, [frame.width])

  const seek = (t) => {
    try { frameRef.current?.contentWindow?.reel?.seek(t) } catch { /* reloading */ }
  }

  // (re)load the doc into the host page, then show the playhead's moment
  useEffect(() => {
    if (!ready) return undefined
    const w = frameRef.current?.contentWindow
    if (!w?.loadDoc) return undefined
    let live = true
    const d = w.document
    let tag = d.getElementById('title-scene-css')
    if (!tag) { tag = d.createElement('style'); tag.id = 'title-scene-css'; d.head.appendChild(tag) }
    // the page's colour scheme follows the editor's, or the browser paints it opaque
    const scheme = getComputedStyle(document.documentElement).colorScheme || 'normal'
    tag.textContent = `:root{color-scheme:${scheme}}${SCENE_CHROME_CSS}${transparent ? SCENE_TRANSPARENT_CSS : ''}`
    w.loadDoc(sceneDoc(clip, frame)).then(info => {
      if (live && info) seek(sceneTimeAt(clip, registry[clip.id]?.position ?? time))
    }).catch(() => {})
    return () => { live = false }
  }, [ready, docKey, transparent]) // eslint-disable-line react-hooks/exhaustive-deps

  // paused or scrubbing: the playhead's moment
  useEffect(() => { seek(sceneTimeAt(clip, time)) }, [time, clip.startTime, clip.timelineStart]) // eslint-disable-line react-hooks/exhaustive-deps

  registry[clip.id] = { clip, seek: (t) => seek(sceneTimeAt(clip, t)), position: time }
  useEffect(() => () => { delete registry[clip.id] }, [clip.id, registry])

  return (
    <div ref={boxRef} style={{ ...style, overflow: 'hidden' }} {...rest}>
      <iframe
        ref={frameRef}
        title={clip.name || t('titles.scene.layerTitle')}
        src={SCENE_HOST_URL}
        tabIndex={-1}
        aria-hidden="true"
        sandbox="allow-scripts allow-same-origin"
        onLoad={() => setReady(true)}
        style={{
          position: 'absolute', left: 0, top: 0, width: frame.width, height: frame.height, border: 0,
          background: 'transparent', transform: `scale(${scale})`, transformOrigin: '0 0', pointerEvents: 'none',
          visibility: scale ? 'visible' : 'hidden'
        }}
      />
    </div>
  )
}

// Every frame while playing: the titles on screen to this moment
export function seekSceneLayers(t, registry) {
  for (const r of Object.values(registry)) r.seek(t)
}
