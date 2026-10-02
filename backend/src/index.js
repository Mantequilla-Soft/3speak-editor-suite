import express from 'express'
import cors from 'cors'
import fs from 'fs/promises'
import path from 'path'
import { renderRouter, getRenderStats } from './routes/render.js'
import { uploadRouter } from './routes/upload.js'
import { clipRouter } from './routes/clip.js'

const app = express()
const PORT = process.env.PORT || 3100
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
const RENDERED_DIR = process.env.RENDERED_DIR || '/app/rendered'
const CLEANUP_MAX_AGE_HOURS = parseInt(process.env.CLEANUP_MAX_AGE_HOURS || '2', 10)
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

// Serve rendered output files (for download)
app.use('/rendered', express.static(RENDERED_DIR))

// Periodic cleanup of old uploaded and rendered files
async function cleanupOldFiles() {
  const maxAge = CLEANUP_MAX_AGE_HOURS * 60 * 60 * 1000
  const now = Date.now()
  let cleaned = 0

  for (const dir of [UPLOAD_DIR, RENDERED_DIR]) {
    try {
      const files = await fs.readdir(dir)
      for (const file of files) {
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
