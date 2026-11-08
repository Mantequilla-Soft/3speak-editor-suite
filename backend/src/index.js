import express from 'express'
import cors from 'cors'
import fs from 'fs/promises'
import path from 'path'
import { renderRouter, getRenderStats } from './routes/render.js'
import { uploadRouter } from './routes/upload.js'
import { clipRouter } from './routes/clip.js'
import { projectsRouter } from './routes/projects.js'
import { sceneRenderRouter } from './routes/sceneRender.js'
import { adDraftsRouter } from './routes/adDrafts.js'
import { templatesRouter } from './routes/templates.js'
import { audiogramRouter } from './routes/audiogram.js'
import { pinnedUploads, uploadBase } from './utils/pinnedUploads.js'
import { RENDER_CACHE_DIR } from './services/ffmpeg.js'

const app = express()
const PORT = process.env.PORT || 3100
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
const RENDERED_DIR = process.env.RENDERED_DIR || '/app/rendered'
const CLEANUP_MAX_AGE_HOURS = parseInt(process.env.CLEANUP_MAX_AGE_HOURS || '12', 10)
const CLEANUP_INTERVAL_MINUTES = parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '30', 10)

app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Health check
app.get('/api/health', (req, res) => {
  const { activeJobs, maxConcurrentJobs } = getRenderStats()
  res.json({ status: 'ok', timestamp: new Date().toISOString(), activeJobs, maxConcurrentJobs })
})

// Upload routes
app.use('/api/upload', uploadRouter)

// Render routes
app.use('/api/render', renderRouter)

// Clip preparation routes
app.use('/api/clip', clipRouter)

// Saved projects (drafts) of signed-in users
app.use('/api/projects', projectsRouter)
// The one audio template per user (intro / outro / music bed), kept for good
app.use('/api/templates', templatesRouter)
// Audiogram videos of an exported episode (the audio editor's share clip)
app.use('/api/audiogram', audiogramRouter)

// Ad Wizard: scene-engine docs -> silent scene video (headless Chromium), and its drafts
app.use('/api/scene-render', sceneRenderRouter)
app.use('/api/ad-drafts', adDraftsRouter)

// Serve rendered output files (for download)
app.use('/rendered', express.static(RENDERED_DIR))


// Periodic cleanup of old uploaded and rendered files
async function cleanupOldFiles() {
  const maxAge = CLEANUP_MAX_AGE_HOURS * 60 * 60 * 1000
  const now = Date.now()
  let cleaned = 0
  // Uploads a saved project uses stay until that project expires
  const pinned = await pinnedUploads(now)

  // ... and the render cache (downloads, processed clips), refreshed when used
  for (const dir of [UPLOAD_DIR, RENDERED_DIR, path.join(RENDER_CACHE_DIR, 'downloads'), path.join(RENDER_CACHE_DIR, 'clips'), path.join(RENDER_CACHE_DIR, 'audio-segments')]) {
    try {
      const files = await fs.readdir(dir)
      for (const file of files) {
        // .hash-index.json, .projects and .chunks (handled below) are not uploads
        if (file.startsWith('.')) continue
        if (dir === UPLOAD_DIR && pinned.has(uploadBase(file))) continue
        const filePath = path.join(dir, file)
        try {
          const stat = await fs.stat(filePath)
          if (now - stat.mtimeMs > maxAge) {
            await fs.unlink(filePath)
            cleaned++
          }
        } catch {}
      }
    } catch {}
  }

  // Chunked uploads that were never completed
  const chunkDir = path.join(UPLOAD_DIR, '.chunks')
  try {
    for (const id of await fs.readdir(chunkDir)) {
      const dir = path.join(chunkDir, id)
      try {
        const stat = await fs.stat(dir)
        if (now - stat.mtimeMs > maxAge) {
          await fs.rm(dir, { recursive: true, force: true })
          cleaned++
        }
      } catch {}
    }
  } catch {}

  if (cleaned > 0) {
    console.log(`[cleanup] Removed ${cleaned} files older than ${CLEANUP_MAX_AGE_HOURS}h`)
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[backend] Render service listening on port ${PORT}`)

  // Run cleanup on startup and then periodically
  cleanupOldFiles()
  setInterval(cleanupOldFiles, CLEANUP_INTERVAL_MINUTES * 60 * 1000)
})
