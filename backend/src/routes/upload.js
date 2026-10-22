import express, { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs/promises'
import { spawn } from 'child_process'
import crypto from 'crypto'
import { createReadStream } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { requireSignIn } from '../auth.js'

const router = Router()
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'

// Ensure upload dir exists
fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {})

// Content hash (SHA-256) -> what was uploaded, so the same file is never sent
// twice: the editor hashes a file first and asks GET /by-hash. Only hashes the
// server computed itself are indexed. Lives next to the uploads (a volume), so
// it survives redeploys; entries whose files were cleaned up are dropped on lookup.
const HASH_INDEX = path.join(UPLOAD_DIR, '.hash-index.json')
const SHA256 = /^[0-9a-f]{64}$/
let hashIndex = {}
fs.readFile(HASH_INDEX, 'utf8').then(t => { hashIndex = JSON.parse(t) }).catch(() => {})
let saveTimer = null
function saveHashIndex() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    const tmp = `${HASH_INDEX}.tmp`
    await fs.writeFile(tmp, JSON.stringify(hashIndex)).catch(() => {})
    await fs.rename(tmp, HASH_INDEX).catch(() => {})
  }, 1000)
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    createReadStream(filePath)
      .on('data', d => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

const encodedPathOf = (filename) =>
  path.join(UPLOAD_DIR, `${path.basename(filename, path.extname(filename))}_480p.mp4`)

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin'
    cb(null, `${uuidv4()}${ext}`)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB max
})

// Big files arrive in chunks, several at a time, and are joined on complete.
// Chunks live in UPLOAD_DIR/.chunks/<uploadId>/ until then (the cleanup in
// index.js removes abandoned ones).
const CHUNK_DIR = path.join(UPLOAD_DIR, '.chunks')
const CHUNK_SIZE = 8 * 1024 * 1024
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Read what a file holds: duration, video codec, pixel format and transfer
 * (HDR or not). Resolves {} when ffprobe cannot read it.
 */
function probeMedia(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath])
    let out = ''
    proc.stdout.on('data', d => { out += d })
    proc.on('error', () => resolve({}))
    proc.on('close', () => {
      try {
        const info = JSON.parse(out)
        const video = (info.streams || []).find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
        resolve({
          duration: parseFloat(info.format?.duration) || null,
          videoCodec: video?.codec_name || null,
          pixFmt: video?.pix_fmt || null,
          transfer: video?.color_transfer || null
        })
      } catch {
        resolve({})
      }
    })
  })
}

// What every browser can decode: 8-bit 4:2:0 H.264/VP8/VP9/AV1. HEVC (iPhone)
// and 10-bit footage are not, and get their 480p copy first.
function isBrowserSafe(probe) {
  if (!probe.videoCodec) return true
  return ['h264', 'vp8', 'vp9', 'av1'].includes(probe.videoCodec) &&
    ['yuv420p', 'yuvj420p'].includes(probe.pixFmt)
}

const isHdr = (probe) => ['smpte2084', 'arib-std-b67'].includes(probe.transfer)

/**
 * Encode a video file to 480p MP4: 8-bit H.264, so every browser can play it
 * whatever came in (HEVC, 10-bit, HDR, which is tone-mapped to SDR).
 * Writes to a .part file and renames it to _480p.mp4 only when complete, so the
 * GET route never serves a half-written file. Removes the original on success.
 * Resolves true on success, false otherwise.
 */
function encodeTo480p(inputPath, probe = {}, onProgress = null) {
  const baseName = path.basename(inputPath, path.extname(inputPath))
  const finalPath = path.join(path.dirname(inputPath), `${baseName}_480p.mp4`)
  const partPath = path.join(path.dirname(inputPath), `${baseName}_480p.part.mp4`)
  const filters = [
    // HDR (iPhone HLG / PQ) to SDR, else colours come out washed out
    ...(isHdr(probe) ? ['zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv'] : []),
    'scale=iw*sar:ih,scale=854:480:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1',
    // fps=30: browser recordings (MediaRecorder webm) carry a 1ms timebase, and
    // without a fixed rate the MP4 comes out at 1000fps of duplicated frames,
    // which stutters on playback
    'fps=30',
    // 8-bit: 10-bit input would otherwise give High 10 H.264, which browsers cannot play
    'format=yuv420p'
  ]
  const args = [
    '-i', inputPath,
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-y',
    partPath
  ]

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderrTail = ''
    proc.stderr.on('data', d => {
      stderrTail = (stderrTail + d).slice(-600)
      // ffmpeg reports "time=HH:MM:SS.xx" as it goes; as a share of the length
      const times = [...String(d).matchAll(/time=(\d+):(\d+):([\d.]+)/g)]
      if (onProgress && probe.duration && times.length) {
        const [, h, m, sec] = times[times.length - 1]
        onProgress(Math.min(0.99, (Number(h) * 3600 + Number(m) * 60 + Number(sec)) / probe.duration))
      }
    })

    // Safety timeout: 5 minutes, or three times the footage length if longer
    const limitMs = Math.max(5 * 60 * 1000, (probe.duration || 0) * 3 * 1000)
    const timer = setTimeout(() => proc.kill('SIGTERM'), limitMs)

    proc.on('close', async (code) => {
      clearTimeout(timer)
      if (code === 0) {
        try {
          await fs.rename(partPath, finalPath)
          console.log(`[upload] Encode done: ${path.basename(finalPath)}`)
          // Remove original now that encoded version is ready
          await fs.unlink(inputPath).catch(() => {})
          return resolve(true)
        } catch (err) {
          console.warn(`[upload] Could not finalize ${path.basename(finalPath)}: ${err.message}`)
        }
      } else {
        console.warn(`[upload] Encode failed (exit ${code}), keeping original: ${stderrTail.split('\n').filter(Boolean).slice(-2).join(' | ')}`)
      }
      await fs.unlink(partPath).catch(() => {})
      resolve(false)
    })

    proc.on('error', () => {
      clearTimeout(timer)
      console.warn(`[upload] ffmpeg not available for encode`)
      resolve(false)
    })
  })
}

// Background encodes run at most this many at a time so a batch of uploads
// cannot swamp the host's CPU and RAM; the rest wait in line (their URL serves
// the original file meanwhile). Footage a browser cannot play goes to the
// front of the line, since the editor shows it black until its 480p copy is
// ready. Recordings that wait for their file (?wait=1) are short and skip the
// line, so they never hit a timeout.
const MAX_PARALLEL_ENCODES = Math.max(1, parseInt(process.env.MAX_PARALLEL_ENCODES, 10) || 2)
let runningEncodes = 0
const encodeQueue = []
// Uploaded filename -> 'queued' | 'encoding' | 'done' | 'failed', for GET /status
const encodeState = new Map()
// Uploaded filename -> 0..1 while encoding
const encodeProgress = new Map()

function queueEncode(inputPath, probe, { urgent = false, first = false } = {}) {
  const name = path.basename(inputPath)
  encodeState.set(name, 'queued')
  return new Promise((resolve) => {
    const run = () => {
      runningEncodes++
      encodeState.set(name, 'encoding')
      encodeTo480p(inputPath, probe, (p) => encodeProgress.set(name, p)).then((ok) => {
        encodeState.set(name, ok ? 'done' : 'failed')
        encodeProgress.delete(name)
        resolve(ok)
      }).finally(() => {
        runningEncodes--
        if (runningEncodes < MAX_PARALLEL_ENCODES) encodeQueue.shift()?.()
      })
    }
    run.fileName = name
    if (urgent || runningEncodes < MAX_PARALLEL_ENCODES) run()
    else {
      if (first) encodeQueue.unshift(run)
      else encodeQueue.push(run)
      console.log(`[upload] Encode queued (${encodeQueue.length} waiting${first ? ', went first' : ''}): ${name}`)
    }
  })
}

/**
 * A file is fully on disk (single POST or joined chunks): probe it, answer the
 * client and start its 480p encode. `wait` answers only once the encode is done.
 */
async function finishUpload(res, { filename, originalName, size, wait, hash = null }) {
  const url = `/api/upload/files/${filename}`
  const filePath = path.join(UPLOAD_DIR, filename)
  const isVideo = /\.(webm|mp4|mov|avi|mkv|m4v|hevc)$/i.test(filename)
  const probe = await probeMedia(filePath)
  const browserSafe = isBrowserSafe(probe)
  const body = { url, filename, originalName, size, duration: probe.duration, browserSafe, encodes: isVideo }
  if (hash) {
    hashIndex[hash] = { filename, originalName, size, duration: probe.duration, browserSafe, encodes: isVideo, probe }
    saveHashIndex()
  }

  // ?wait=1 (short recordings): answer only once the 480p file is ready, so the
  // URL serves the same bytes on every request. Otherwise the first requests get
  // the original and later range requests the encoded file, which breaks playback.
  if (isVideo && wait) {
    const encoded = await queueEncode(filePath, probe, { urgent: true })
    return res.json({ ...body, encoded })
  }

  // Respond immediately with raw file URL
  res.json(body)

  // Start 480p encoding in the background (fire-and-forget)
  if (isVideo) queueEncode(filePath, probe, { first: !browserSafe })
}

/**
 * POST /api/upload
 * Accepts a single file upload, returns a server-accessible URL immediately.
 * 480p encoding happens in the background — the GET endpoint will serve
 * the encoded version once it's ready.
 */
router.post('/', requireSignIn, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' })
  }

  console.log(`[upload] Saved ${req.file.originalname} -> ${req.file.filename} (${req.file.size} bytes)`)
  await finishUpload(res, {
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    wait: req.query.wait === '1',
    hash: await verifiedHash(path.join(UPLOAD_DIR, req.file.filename), req.query.hash)
  })
})

// The client's hash, if the file really has it (else nothing gets indexed)
async function verifiedHash(filePath, claimed, computed = null) {
  if (!claimed || !SHA256.test(claimed)) return null
  const actual = computed || await sha256File(filePath).catch(() => null)
  if (actual === claimed) return actual
  console.warn(`[upload] Hash mismatch for ${path.basename(filePath)}, not indexed`)
  return null
}

async function readChunkMeta(uploadId) {
  if (!UPLOAD_ID.test(uploadId)) return null
  try {
    return JSON.parse(await fs.readFile(path.join(CHUNK_DIR, uploadId, 'meta.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * POST /api/upload/chunked/init  { name, size }
 * Starts a chunked upload. Returns { uploadId, chunkSize, chunks }.
 */
router.post('/chunked/init', requireSignIn, async (req, res) => {
  const size = Number(req.body?.size)
  const name = String(req.body?.name || 'upload')
  if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    return res.status(400).json({ error: 'Invalid size' })
  }
  const ext = /^\.[a-z0-9]{1,8}$/i.test(path.extname(name)) ? path.extname(name) : '.bin'
  const uploadId = uuidv4()
  const chunks = Math.ceil(size / CHUNK_SIZE)
  await fs.mkdir(path.join(CHUNK_DIR, uploadId), { recursive: true })
  const hash = SHA256.test(String(req.body?.hash || '')) ? req.body.hash : null
  await fs.writeFile(path.join(CHUNK_DIR, uploadId, 'meta.json'), JSON.stringify({ name, ext, size, chunks, hash }))
  res.json({ uploadId, chunkSize: CHUNK_SIZE, chunks })
})

/**
 * PUT /api/upload/chunked/:uploadId/:index  (raw bytes)
 * Stores one chunk. Chunks may arrive in any order and be retried.
 */
router.put('/chunked/:uploadId/:index', requireSignIn,
  express.raw({ type: () => true, limit: CHUNK_SIZE + 1024 }),
  async (req, res) => {
    const meta = await readChunkMeta(req.params.uploadId)
    if (!meta) return res.status(404).json({ error: 'Unknown upload' })
    const index = Number(req.params.index)
    if (!Number.isInteger(index) || index < 0 || index >= meta.chunks) {
      return res.status(400).json({ error: 'Invalid chunk index' })
    }
    const expected = index === meta.chunks - 1 ? meta.size - index * CHUNK_SIZE : CHUNK_SIZE
    if (!Buffer.isBuffer(req.body) || req.body.length !== expected) {
      return res.status(400).json({ error: `Chunk ${index} should be ${expected} bytes` })
    }
    const dir = path.join(CHUNK_DIR, req.params.uploadId)
    await fs.writeFile(path.join(dir, `${index}.part`), req.body)
    await fs.rename(path.join(dir, `${index}.part`), path.join(dir, String(index)))
    res.json({ ok: true })
  }
)

/**
 * POST /api/upload/chunked/:uploadId/complete
 * Joins the chunks into the uploaded file, then answers like POST /api/upload.
 */
router.post('/chunked/:uploadId/complete', requireSignIn, async (req, res) => {
  const meta = await readChunkMeta(req.params.uploadId)
  if (!meta) return res.status(404).json({ error: 'Unknown upload' })
  const dir = path.join(CHUNK_DIR, req.params.uploadId)

  const missing = []
  for (let i = 0; i < meta.chunks; i++) {
    try { await fs.access(path.join(dir, String(i))) } catch { missing.push(i) }
  }
  if (missing.length) return res.status(409).json({ error: 'Missing chunks', missing })

  const filename = `${uuidv4()}${meta.ext}`
  const filePath = path.join(UPLOAD_DIR, filename)
  const out = await fs.open(filePath, 'w')
  const joinedHash = crypto.createHash('sha256')
  try {
    for (let i = 0; i < meta.chunks; i++) {
      const chunk = await fs.readFile(path.join(dir, String(i)))
      joinedHash.update(chunk)
      await out.write(chunk)
    }
  } finally {
    await out.close()
  }
  await fs.rm(dir, { recursive: true, force: true })

  const { size } = await fs.stat(filePath)
  if (size !== meta.size) {
    await fs.unlink(filePath).catch(() => {})
    return res.status(500).json({ error: 'Joined file has the wrong size' })
  }

  console.log(`[upload] Joined ${meta.chunks} chunks of ${meta.name} -> ${filename} (${size} bytes)`)
  await finishUpload(res, {
    filename,
    originalName: meta.name,
    size,
    wait: false,
    hash: await verifiedHash(filePath, meta.hash, joinedHash.digest('hex'))
  })
})

/**
 * GET /api/upload/by-hash/:sha256
 * The same file was uploaded before: answers like a finished upload (plus
 * reused: true and encodeState), so the editor skips the upload. Its files get
 * a fresh timestamp, so footage in use is not cleaned up. 404 when unknown.
 */
router.get('/by-hash/:hash', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const hash = req.params.hash
  const entry = SHA256.test(hash) ? hashIndex[hash] : null
  if (!entry) return res.status(404).json({ error: 'Not uploaded' })

  const originalPath = path.join(UPLOAD_DIR, entry.filename)
  const encodedPath = encodedPathOf(entry.filename)
  const [hasOriginal, hasEncoded] = await Promise.all([exists(originalPath), exists(encodedPath)])
  if (!hasOriginal && !hasEncoded) {
    delete hashIndex[hash]
    saveHashIndex()
    return res.status(404).json({ error: 'Not uploaded' })
  }
  const now = new Date()
  if (hasOriginal) await fs.utimes(originalPath, now, now).catch(() => {})
  if (hasEncoded) await fs.utimes(encodedPath, now, now).catch(() => {})

  let state = encodeStateOf(entry.filename, hasEncoded)
  // Original still here, no copy and no encode running (e.g. after a restart): encode again
  if (entry.encodes && !hasEncoded && hasOriginal && state === 'unknown') {
    queueEncode(originalPath, entry.probe || {}, { first: !entry.browserSafe })
    state = 'queued'
  }
  console.log(`[upload] Reused ${entry.originalName} by hash -> ${entry.filename} (${state})`)
  const { probe, ...info } = entry // eslint-disable-line no-unused-vars
  res.json({ ...info, url: `/api/upload/files/${entry.filename}`, reused: true, encodeState: state })
})

function encodeStateOf(filename, hasEncoded) {
  return encodeState.get(path.basename(filename)) || (hasEncoded ? 'done' : 'unknown')
}

/**
 * GET /api/upload/status/:filename
 * Where the 480p copy of an upload is: { state: queued | encoding | done | failed,
 * progress (0..1, while encoding), ahead (encodes in line before it, while queued) }.
 * After a backend restart the queue is gone: 'done' if the copy exists, else 'unknown'.
 */
router.get('/status/:filename', async (req, res) => {
  const name = path.basename(req.params.filename)
  const state = encodeState.get(name)
  res.set('Cache-Control', 'no-store')
  if (state === 'queued') {
    return res.json({ state, ahead: runningEncodes + Math.max(0, encodeQueue.findIndex(job => job.fileName === name)) })
  }
  if (state) return res.json({ state, progress: encodeProgress.get(name) ?? null })
  const baseName = path.basename(name, path.extname(name))
  try {
    await fs.access(path.join(UPLOAD_DIR, `${baseName}_480p.mp4`))
    return res.json({ state: 'done' })
  } catch {
    return res.json({ state: 'unknown' })
  }
})

/**
 * GET /api/upload/files/:filename
 * Serves an uploaded file. Prefers the 480p encoded version if available.
 */
router.get('/files/:filename', async (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename)
  const baseName = path.basename(req.params.filename, path.extname(req.params.filename))
  const encodedPath = path.join(UPLOAD_DIR, `${baseName}_480p.mp4`)

  // Prefer 480p version
  try {
    await fs.access(encodedPath)
    return res.sendFile(encodedPath)
  } catch {
    // 480p not ready yet, fall through to original
  }

  try {
    await fs.access(filePath)
    res.sendFile(filePath)
  } catch {
    res.status(404).json({ error: 'File not found' })
  }
})

export { router as uploadRouter }
