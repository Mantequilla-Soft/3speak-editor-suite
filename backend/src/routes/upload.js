import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs/promises'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'

const router = Router()
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'

// Ensure upload dir exists
fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {})

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

/**
 * Encode a video file to 480p MP4.
 * Writes to a .part file and renames it to _480p.mp4 only when complete, so the
 * GET route never serves a half-written file. Removes the original on success.
 * Resolves true on success, false otherwise.
 */
function encodeTo480p(inputPath) {
  const baseName = path.basename(inputPath, path.extname(inputPath))
  const finalPath = path.join(path.dirname(inputPath), `${baseName}_480p.mp4`)
  const partPath = path.join(path.dirname(inputPath), `${baseName}_480p.part.mp4`)
  const args = [
    '-i', inputPath,
    // fps=30: browser recordings (MediaRecorder webm) carry a 1ms timebase, and
    // without a fixed rate the MP4 comes out at 1000fps of duplicated frames,
    // which stutters on playback
    '-vf', 'scale=iw*sar:ih,scale=854:480:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,fps=30',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-y',
    partPath
  ]

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })

    // Safety timeout: 5 minutes
    const timer = setTimeout(() => proc.kill('SIGTERM'), 5 * 60 * 1000)

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
        console.warn(`[upload] Encode failed (exit ${code}), keeping original`)
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

/**
 * POST /api/upload
 * Accepts a single file upload, returns a server-accessible URL immediately.
 * 480p encoding happens in the background — the GET endpoint will serve
 * the encoded version once it's ready.
 */
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' })
  }

  console.log(`[upload] Saved ${req.file.originalname} -> ${req.file.filename} (${req.file.size} bytes)`)

  const url = `/api/upload/files/${req.file.filename}`
  const filePath = path.join(UPLOAD_DIR, req.file.filename)
  const isVideo = /\.(webm|mp4|mov|avi|mkv|m4v)$/i.test(req.file.filename)

  // ?wait=1 (short recordings): answer only once the 480p file is ready, so the
  // URL serves the same bytes on every request. Otherwise the first requests get
  // the original and later range requests the encoded file, which breaks playback.
  if (isVideo && req.query.wait === '1') {
    const encoded = await encodeTo480p(filePath)
    return res.json({
      url,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      encoded
    })
  }

  // Respond immediately with raw file URL
  res.json({
    url,
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size
  })

  // Start 480p encoding in the background (fire-and-forget)
  if (isVideo) encodeTo480p(filePath)
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
