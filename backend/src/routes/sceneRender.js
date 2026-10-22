// Scene render for the Ad Wizard: plays a scene-engine doc (backend/scene-engine, vendored from
// motiongraphics-cookbook, docs/engine.md) in headless Chromium and records it frame by frame into a silent
// MP4. The wizard then hands that video plus music and sound effects to the normal /api/render job.
//
//   POST /api/scene-render       { doc }  -> { jobId }
//   GET  /api/scene-render/:id            -> { status, progress (0..1), outputUrl, duration, error }
//
// Safety: the doc is sanitised by the engine's own schema; the page may only load the engine files,
// Google Fonts and this backend's uploads. Remote pictures/fonts are fetched here first (https only,
// public addresses only, size-capped) and served as uploads.
import { Router } from 'express'
import { spawn } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import vm from 'vm'
import crypto from 'crypto'
import dns from 'dns/promises'
import net from 'net'
import { fileURLToPath } from 'url'

const router = Router()
const PORT = process.env.PORT || 3100
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
const RENDERED_DIR = process.env.RENDERED_DIR || '/app/rendered'
const ENGINE_DIR = process.env.SCENE_ENGINE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scene-engine')
const HOST = 'file://' + path.join(ENGINE_DIR, 'host/index.html')
const MAX_SECONDS = 61
const JOB_TIMEOUT_MS = 10 * 60 * 1000
const REMOTE_MAX_BYTES = 15 * 1024 * 1024

// the engine's schema, evaluated from the vendored browser script
const SceneMeta = (() => {
  const ctx = { self: {} }
  vm.runInNewContext(readFileSync(path.join(ENGINE_DIR, 'lib/scene-meta.js'), 'utf8'), ctx)
  return ctx.self.SceneMeta
})()

const jobs = new Map()
let queue = Promise.resolve() // one scene render at a time (Chromium ~0.5-1 GB)

function chromiumPath() {
  for (const p of [process.env.CHROMIUM_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium'].filter(Boolean)) if (existsSync(p)) return p
  return undefined // playwright's own download, if any
}

// ---- pictures and fonts: keep the page on uploads only ----
const UPLOAD_PATH = /^\/api\/upload\/files\/([\w.-]+)$/
const localUpload = name => `http://127.0.0.1:${PORT}/api/upload/files/${name}`

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const v = ip.toLowerCase()
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:')
}

// https://… on a public host -> saved as an upload; returns the local URL (or null)
async function fetchRemote(u) {
  let url
  try { url = new URL(u) } catch { return null }
  if (url.protocol !== 'https:') return null
  const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => [])
  if (!addrs.length || addrs.some(a => privateAddress(a.address))) return null
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) }).catch(() => null)
  if (!res?.ok) return null
  const type = res.headers.get('content-type') || ''
  if (!/^(image\/|font\/|application\/(font|x-font|octet-stream|vnd\.ms-opentype))/.test(type)) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > REMOTE_MAX_BYTES) return null
  const ext = (path.extname(url.pathname).match(/^\.[\w]{2,5}$/) || [''])[0]
  const name = `remote-${crypto.createHash('sha256').update(u).digest('hex').slice(0, 24)}${ext}`
  await fs.writeFile(path.join(UPLOAD_DIR, name), buf)
  return localUpload(name)
}

// every picture/font URL in a sanitised doc -> a local upload URL (or dropped)
async function localise(doc) {
  const one = async u => {
    if (typeof u !== 'string' || !u) return undefined
    if (/^data:image\//.test(u)) return u
    let p
    try { p = new URL(u, 'http://x') } catch { return undefined }
    // our own upload: serve it from this backend when the file is here (else: a public copy, e.g. the other backend)
    const m = UPLOAD_PATH.exec(p.pathname)
    if (m && existsSync(path.join(UPLOAD_DIR, m[1]))) return localUpload(m[1])
    return (await fetchRemote(u)) || undefined
  }
  const img = async v => {
    if (v && typeof v === 'object') { const url = await one(v.url); return url ? { ...v, url } : undefined }
    return one(v)
  }
  const walk = async (fields, src) => {
    const o = { ...src }
    for (const f of fields) {
      const v = o[f.k]
      if (v == null) continue
      if (f.kind === 'image') { const x = await img(v); if (x) o[f.k] = x; else delete o[f.k] }
      else if (f.kind === 'images' && Array.isArray(v)) o[f.k] = (await Promise.all(v.map(img))).filter(Boolean)
      else if (f.kind === 'list' && Array.isArray(v)) o[f.k] = await Promise.all(v.map(x => walk(f.of, x)))
      else if (f.kind === 'object' && f.of.length) o[f.k] = await walk(f.of, v)
    }
    return o
  }
  const brand = { ...doc.brand }
  if (brand.logo) { const x = await img(brand.logo); if (x) brand.logo = x; else delete brand.logo }
  if (brand.fontFaces) brand.fontFaces = (await Promise.all(brand.fontFaces.map(async f => ({ ...f, url: await one(f.url) })))).filter(f => f.url)
  return { ...doc, brand, scenes: await Promise.all(doc.scenes.map(s => walk(SceneMeta.TYPES[s.type].fields, s))) }
}

// ---- render ----
async function renderJob(job) {
  const { chromium } = await import('playwright-core')
  const out = path.join(RENDERED_DIR, `scene-${job.id}.mp4`)
  const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox', '--font-render-hinting=none', '--disable-dev-shm-usage'] })
  const kill = setTimeout(() => { job.error = 'timed out'; browser.close().catch(() => {}) }, JOB_TIMEOUT_MS)
  try {
    const page = await browser.newPage({ viewport: { width: job.doc.width, height: job.doc.height }, deviceScaleFactor: 1 })
    // the page may load: the engine files, Google Fonts, this backend's uploads, data: URIs. Nothing else.
    await page.route('**/*', route => {
      const u = route.request().url()
      const ok = u.startsWith('file://' + ENGINE_DIR + '/') || u.startsWith('data:')
        || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u) || u.startsWith(`http://127.0.0.1:${PORT}/api/upload/files/`)
      return ok ? route.continue() : route.abort()
    })
    page.on('pageerror', e => console.warn('[scene-render] page error:', e.message))
    await page.addInitScript(d => { window.__DOC__ = d }, job.doc)
    await page.goto(HOST, { waitUntil: 'networkidle', timeout: 60000 })
    const meta = await page.evaluate(async () => {
      const info = await window.hostReady
      if (!info) throw new Error('scene host did not load the doc')
      return info
    })
    if (meta.duration > MAX_SECONDS) throw new Error(`ad is ${meta.duration.toFixed(1)} s, the limit is ${MAX_SECONDS} s`)
    job.duration = meta.duration
    const fps = meta.fps || 30, frames = Math.round(meta.duration * fps)

    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
    const ffDone = new Promise((resolve, reject) => { ff.on('close', c => (c === 0 ? resolve() : reject(new Error('ffmpeg failed')))); ff.on('error', reject) })
    for (let f = 0; f < frames; f++) {
      if (job.error) throw new Error(job.error)
      await page.evaluate(t => window.reel.seek(t), f / fps)
      const buf = await page.screenshot({ type: 'jpeg', quality: 92 })
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r))
      job.progress = (f + 1) / frames
    }
    ff.stdin.end()
    await ffDone
    job.outputUrl = `/rendered/scene-${job.id}.mp4`
    job.status = 'completed'
  } finally {
    clearTimeout(kill)
    await browser.close().catch(() => {})
  }
}

router.post('/', async (req, res) => {
  try {
    const raw = req.body?.doc
    if (!raw || typeof raw !== 'object') return res.status(400).json({ error: 'doc required' })
    if ([...jobs.values()].filter(j => j.status === 'queued' || j.status === 'processing').length >= 3) return res.status(503).json({ error: 'Server busy', retryAfter: 30 })
    const clean = SceneMeta.sanitize(raw)
    if (!clean.scenes.length) return res.status(400).json({ error: 'no scenes' })
    const problems = SceneMeta.validate(clean).filter(x => x.level === 'error')
    if (problems.length) return res.status(400).json({ error: `scene ${problems[0].scene + 1}: ${problems[0].field} ${problems[0].msg}`, problems })
    const id = crypto.randomUUID()
    const job = { id, status: 'queued', progress: 0, outputUrl: null, duration: null, error: null, createdAt: Date.now() }
    jobs.set(id, job)
    res.json({ jobId: id })
    queue = queue.then(async () => {
      try {
        job.status = 'processing'
        job.doc = await localise(clean)
        await renderJob(job)
      } catch (e) {
        console.error(`[scene-render] ${id} failed:`, e)
        job.status = 'failed'; job.error = job.error || e.message
      } finally { delete job.doc }
    })
  } catch (e) {
    console.error('[scene-render] error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:id', (req, res) => {
  const j = jobs.get(req.params.id)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  res.json({ jobId: j.id, status: j.status, progress: j.progress, outputUrl: j.outputUrl, duration: j.duration, error: j.error })
})

// forget finished jobs after an hour (the files themselves follow the rendered-files cleanup)
setInterval(() => { const cut = Date.now() - 3600e3; for (const [k, j] of jobs) if (j.createdAt < cut && j.status !== 'processing') jobs.delete(k) }, 600e3).unref()

export { router as sceneRenderRouter }
