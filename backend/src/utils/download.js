import { spawn } from 'child_process'
import { createWriteStream } from 'fs'
import fs from 'fs/promises'
import https from 'https'
import http from 'http'
import path from 'path'

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
const RENDERED_DIR = process.env.RENDERED_DIR || '/app/rendered'

/**
 * Download a media file from a URL to a local path.
 * Handles: local uploads (/api/upload/files/...), rendered clips (/rendered/...), HLS (.m3u8), direct URLs.
 */
export async function downloadMedia(url, clipId, workDir) {
  // Local uploaded file — just copy from uploads dir
  if (url.startsWith('/api/upload/files/')) {
    const filename = url.split('/').pop()
    const srcPath = path.join(UPLOAD_DIR, filename)
    const ext = path.extname(filename) || '.bin'
    const destPath = path.join(workDir, `${clipId}${ext}`)
    await fs.copyFile(srcPath, destPath)
    console.log(`[download] Local copy: ${srcPath} -> ${destPath}`)
    return destPath
  }

  // Already-rendered/prepared clip — copy from rendered dir
  if (url.startsWith('/rendered/')) {
    const filename = url.split('/').pop()
    const srcPath = path.join(RENDERED_DIR, filename)
    const ext = path.extname(filename) || '.mp4'
    const destPath = path.join(workDir, `${clipId}${ext}`)
    await fs.copyFile(srcPath, destPath)
    console.log(`[download] Rendered copy: ${srcPath} -> ${destPath}`)
    return destPath
  }

  if (url.includes('.m3u8')) {
    return downloadHls(url, clipId, workDir)
  }
  return downloadDirect(url, clipId, workDir)
}

/**
 * Download HLS stream via ffmpeg -c copy.
 */
function downloadHls(url, clipId, workDir) {
  const outputPath = path.join(workDir, `${clipId}.mp4`)

  return new Promise((resolve, reject) => {
    const args = [
      '-i', url,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-y',
      outputPath
    ]

    console.log(`[download] HLS: ffmpeg ${args.join(' ')}`)
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code === 0) resolve(outputPath)
      else reject(new Error(`HLS download failed (exit ${code}): ${stderr.slice(-500)}`))
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`))
    })

    setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('HLS download timed out'))
    }, 5 * 60 * 1000)
  })
}

/**
 * Download a direct file URL via http/https.
 */
function downloadDirect(url, clipId, workDir) {
  let ext = '.mp4'
  try {
    const urlExt = path.extname(new URL(url).pathname)
    if (['.mp4', '.webm', '.mp3', '.wav', '.ogg', '.png', '.jpg', '.jpeg', '.gif'].includes(urlExt.toLowerCase())) {
      ext = urlExt.toLowerCase()
    }
  } catch { /* use default */ }

  const outputPath = path.join(workDir, `${clipId}${ext}`)

  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http

    const request = client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadDirect(response.headers.location, clipId, workDir).then(resolve).catch(reject)
        return
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`))
        return
      }

      const fileStream = createWriteStream(outputPath)
      response.pipe(fileStream)

      fileStream.on('finish', () => {
        fileStream.close()
        resolve(outputPath)
      })

      fileStream.on('error', (err) => {
        reject(new Error(`File write error: ${err.message}`))
      })
    })

    request.on('error', (err) => {
      reject(new Error(`Download failed: ${err.message}`))
    })

    request.setTimeout(5 * 60 * 1000, () => {
      request.destroy()
      reject(new Error('Download timed out'))
    })
  })
}
