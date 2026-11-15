// Titles in the Shorts editor (src/utils/titleScenes.js): a clip of type
// 'scene' carries a scene engine doc (sceneDoc). It is recorded here frame by
// frame in headless Chromium, the same host page the editor's preview plays
// (routes/sceneRender.js does the same for the Ad Wizard), over a transparent
// page when it goes over the video, then placed on a frame-sized transparent
// layer with the clip's zoom and position, like the preview's CSS.
import { spawn } from 'child_process'
import { SceneMeta, localise, launchSceneBrowser, openScenePage, enqueueScene } from '../routes/sceneRender.js'

const CHROME_CSS = '#prog,#bug{display:none !important}'
const TRANSPARENT_CSS = 'html,body,#stage{background:transparent !important}#stage>.glow{display:none !important}'
const MAX_SECONDS = 15

// The checked doc of a title clip (the engine's own schema), or an error
export function titleDoc(clip, w, h) {
  if (!clip.sceneDoc || typeof clip.sceneDoc !== 'object') throw new Error('title without a scene')
  const doc = SceneMeta.sanitize({ ...clip.sceneDoc, width: w, height: h, fps: 30, transition: 0 })
  if (doc.scenes.length !== 1) throw new Error('a title is one scene')
  const problems = SceneMeta.validate(doc).filter(x => x.level === 'error')
  if (problems.length) throw new Error(`title: ${problems[0].field} ${problems[0].msg}`)
  return doc
}

/**
 * Where a title's picture goes on the frame: { sw, sh, x, y } (its size after
 * the zoom, its top left corner). Positions are preview px, as for other clips:
 * CSS scale(zoom) then translate(position) around the frame's centre.
 */
export function titlePlacement(clip, w, h, scaleFactor = 1) {
  const z = clip.zoom && clip.zoom !== 100 ? Math.max(0.1, Math.min(5, clip.zoom > 10 ? clip.zoom / 100 : clip.zoom)) : 1
  const sw = Math.max(2, Math.round(w * z / 2) * 2)
  const sh = Math.max(2, Math.round(h * z / 2) * 2)
  const x = Math.round((w - sw) / 2 + (clip.positionX || 0) * scaleFactor * z)
  const y = Math.round((h - sh) / 2 + (clip.positionY || 0) * scaleFactor * z)
  return { sw, sh, x, y }
}

/**
 * Record a title clip into outputPath (QuickTime Animation with alpha, the
 * frame's size): the scene from clip.startTime to clip.endTime at fps.
 */
export function renderSceneClip(clip, outputPath, w, h, fps, signal, scaleFactor = 1) {
  return enqueueScene(async () => {
    if (signal?.aborted) throw new Error('Job aborted')
    const doc = await localise(titleDoc(clip, w, h))
    const transparent = clip.transparent !== false
    const length = Math.min(MAX_SECONDS, Math.max(0.1, clip.endTime - clip.startTime))
    const frames = Math.max(1, Math.round(length * fps))
    const { sw, sh, x, y } = titlePlacement(clip, w, h, scaleFactor)
    const browser = await launchSceneBrowser()
    const onAbort = () => browser.close().catch(() => {})
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const { page, meta } = await openScenePage(browser, doc, { css: CHROME_CSS + (transparent ? TRANSPARENT_CSS : '') })
      const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y',
        '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
        '-f', 'lavfi', '-i', `color=c=black@0:s=${w}x${h}:r=${fps},format=rgba`,
        '-filter_complex', `[0:v]format=rgba,scale=${sw}:${sh}[t];[1:v][t]overlay=${x}:${y}:shortest=1:format=auto,format=argb[out]`,
        '-map', '[out]', '-frames:v', String(frames), '-c:v', 'qtrle', '-pix_fmt', 'argb', '-r', String(fps), outputPath],
      { stdio: ['pipe', 'ignore', 'pipe'] })
      let err = ''
      ff.stderr.on('data', d => { err += d })
      const done = new Promise((resolve, reject) => {
        ff.on('close', c => (c === 0 ? resolve() : reject(new Error(`title encode failed: ${err.slice(-300)}`))))
        ff.on('error', reject)
      })
      ff.stdin.on('error', () => {}) // ffmpeg stopping early shows up as its exit code
      for (let f = 0; f < frames; f++) {
        if (signal?.aborted) throw new Error('Job aborted')
        const t = Math.min(meta.duration, clip.startTime + f / fps)
        await page.evaluate(s => window.reel.seek(s), t)
        const buf = await page.screenshot({ type: 'png', omitBackground: transparent })
        if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r))
      }
      ff.stdin.end()
      await done
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await browser.close().catch(() => {})
    }
  })
}
