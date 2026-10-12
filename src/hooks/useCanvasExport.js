import { useState, useCallback, useRef } from 'react'
import { hasLayout, coverSourceRect, layoutPan, layoutZoom } from '../utils/remixLayout'
import { getClipChromaKey, createKeyer } from '../utils/chromaKey'

const EXPORT_WIDTH = 1280
const EXPORT_HEIGHT = 720
const EXPORT_FPS = 30

export function useCanvasExport(ffmpeg, ffmpegLoaded) {
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportPhase, setExportPhase] = useState('')
  const canvasRef = useRef(null)
  const abortRef = useRef(false)

  // Pre-load all media elements
  const loadMedia = async (tracks) => {
    const mediaElements = new Map()

    const videoTracks = (tracks || []).filter(t => t.type === 'video')

    for (const track of videoTracks) {
      for (const clip of track.clips) {
        if (clip.type === 'video') {
          const video = document.createElement('video')
          video.crossOrigin = 'anonymous'
          video.muted = true
          video.preload = 'auto'
          video.src = clip.url

          await new Promise((resolve, reject) => {
            video.onloadeddata = resolve
            video.onerror = reject
            video.load()
          })

          mediaElements.set(clip.id, { type: 'video', element: video, clip })
        } else if (clip.type === 'image') {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.src = clip.url

          await new Promise((resolve, reject) => {
            img.onload = resolve
            img.onerror = reject
          })

          mediaElements.set(clip.id, { type: 'image', element: img, clip })
        } else if (clip.type === 'text') {
          mediaElements.set(clip.id, { type: 'text', clip })
        }
      }
    }

    return mediaElements
  }

  // Find clips at a specific time position
  const findClipsAtTime = (tracks, time, clipTrackIndexMap) => {
    const videoTracks = (tracks || []).filter(t => t.type === 'video')
    const clips = []

    for (const track of videoTracks) {
      for (const clip of track.clips) {
        const clipStart = clip.timelinePosition || 0
        const clipEnd = clipStart + (clip.endTime - clip.startTime)

        if (time >= clipStart && time < clipEnd) {
          clips.push({
            ...clip,
            timelineStart: clipStart,
            timelineEnd: clipEnd
          })
        }
      }
    }

    // Sort by track index (lower index = top of timeline = render on top)
    // So sort descending - higher index clips first (rendered below)
    return clips.sort((a, b) => {
      const aIndex = clipTrackIndexMap.get(a.id) ?? Infinity
      const bIndex = clipTrackIndexMap.get(b.id) ?? Infinity
      return bIndex - aIndex
    })
  }

  // Green screen clips: one keyer each (same shader as the preview)
  const createKeyers = async (mediaElements) => {
    const keyers = new Map()
    for (const [id, media] of mediaElements) {
      const key = media.type === 'video' ? getClipChromaKey(media.clip) : null
      if (!key) continue
      const keyer = createKeyer(document.createElement('canvas'), { preserveDrawingBuffer: true, maxSide: 4096 })
      if (!keyer) continue
      if (key.mode === 'static' && key.plateUrl) {
        const load = (url) => new Promise((resolve) => {
          if (!url) return resolve(null)
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => resolve(img)
          img.onerror = () => resolve(null)
          img.src = url
        })
        const plate = await load(key.plateUrl)
        if (plate) keyer.setPlate(plate)
        keyer.setNoise?.(await load(key.noiseUrl))
      }
      keyers.set(id, { keyer, key })
    }
    return keyers
  }

  // The keyed picture of a clip's current frame (a canvas the size of the
  // video, or scaled down by the 2D fallback), or null to draw it as is
  const keyedFrame = (keyers, clip, video) => {
    const k = keyers?.get(clip.id)
    if (!k) return null
    try {
      return k.keyer.draw(video, k.key) ? k.keyer.canvas : null
    } catch {
      return null
    }
  }

  // Draw a single frame to the canvas
  // scaleFactor converts preview-pixel values to output-pixel values
  const drawFrame = (ctx, clips, mediaElements, currentTime, scaleFactor = 1, keyers = null) => {
    // Clear canvas with black background
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT)

    // Draw clips in order (first in array = bottom layer)
    for (const clip of clips) {
      const media = mediaElements.get(clip.id)
      if (!media) continue

      // Calculate clip-local time
      const clipLocalTime = currentTime - clip.timelineStart + clip.startTime

      // Remix layout box: cover-fit into a canvas-fraction box, no zoom/crop/position
      if (hasLayout(clip) && (media.type === 'video' || media.type === 'image')) {
        const el = media.element
        if (media.type === 'video') el.currentTime = clipLocalTime
        const srcW = media.type === 'video' ? el.videoWidth : el.naturalWidth
        const srcH = media.type === 'video' ? el.videoHeight : el.naturalHeight
        if (srcW && srcH) {
          const bx = clip.layout.x * EXPORT_WIDTH
          const by = clip.layout.y * EXPORT_HEIGHT
          const bw = clip.layout.w * EXPORT_WIDTH
          const bh = clip.layout.h * EXPORT_HEIGHT
          const { panX, panY } = layoutPan(clip.layout)
          const { sx, sy, sw, sh } = coverSourceRect(srcW, srcH, bw, bh, panX, panY, layoutZoom(clip.layout))
          ctx.save()
          if ((clip.opacity ?? 100) < 100) ctx.globalAlpha = clip.opacity / 100
          const keyed = media.type === 'video' ? keyedFrame(keyers, clip, el) : null
          if (keyed) {
            const kx = keyed.width / srcW
            const ky = keyed.height / srcH
            ctx.drawImage(keyed, sx * kx, sy * ky, sw * kx, sh * ky, bx, by, bw, bh)
          } else {
            ctx.drawImage(el, sx, sy, sw, sh, bx, by, bw, bh)
          }
          ctx.restore()
        }
        continue
      }

      // Save context for transforms
      ctx.save()

      // Apply transforms
      // Position values are in preview-pixel coords — scale to output resolution
      const zoom = (clip.zoom || 100) / 100
      const posX = (clip.positionX || 0) * scaleFactor
      const posY = (clip.positionY || 0) * scaleFactor

      // Center point for transforms
      const centerX = EXPORT_WIDTH / 2
      const centerY = EXPORT_HEIGHT / 2

      // CSS transform is: scale(z) translate(px, py) with transform-origin center
      // which equals: T(cx + z*px, cy + z*py) · S(z) · T(-cx, -cy)
      ctx.translate(centerX + posX * zoom, centerY + posY * zoom)
      ctx.scale(zoom, zoom)
      ctx.translate(-centerX, -centerY)

      // Apply crop using clipping path
      const cropX = clip.cropX || 0
      const cropY = clip.cropY || 0
      const cropW = clip.cropWidth || 100
      const cropH = clip.cropHeight || 100

      if (cropX !== 0 || cropY !== 0 || cropW !== 100 || cropH !== 100) {
        const clipLeft = (cropX / 100) * EXPORT_WIDTH
        const clipTop = (cropY / 100) * EXPORT_HEIGHT
        const clipWidth = (cropW / 100) * EXPORT_WIDTH
        const clipHeight = (cropH / 100) * EXPORT_HEIGHT

        ctx.beginPath()
        ctx.rect(clipLeft, clipTop, clipWidth, clipHeight)
        ctx.clip()
      }

      if (media.type === 'video') {
        const video = media.element

        // Seek video to correct time
        video.currentTime = clipLocalTime

        // Draw video maintaining aspect ratio
        const videoAspect = video.videoWidth / video.videoHeight
        const canvasAspect = EXPORT_WIDTH / EXPORT_HEIGHT

        let drawWidth, drawHeight, drawX, drawY

        if (videoAspect > canvasAspect) {
          drawWidth = EXPORT_WIDTH
          drawHeight = EXPORT_WIDTH / videoAspect
          drawX = 0
          drawY = (EXPORT_HEIGHT - drawHeight) / 2
        } else {
          drawHeight = EXPORT_HEIGHT
          drawWidth = EXPORT_HEIGHT * videoAspect
          drawX = (EXPORT_WIDTH - drawWidth) / 2
          drawY = 0
        }

        ctx.drawImage(keyedFrame(keyers, clip, video) || video, drawX, drawY, drawWidth, drawHeight)

      } else if (media.type === 'image') {
        const img = media.element

        // Draw image maintaining aspect ratio
        const imgAspect = img.naturalWidth / img.naturalHeight
        const canvasAspect = EXPORT_WIDTH / EXPORT_HEIGHT

        let drawWidth, drawHeight, drawX, drawY

        if (imgAspect > canvasAspect) {
          drawWidth = EXPORT_WIDTH
          drawHeight = EXPORT_WIDTH / imgAspect
          drawX = 0
          drawY = (EXPORT_HEIGHT - drawHeight) / 2
        } else {
          drawHeight = EXPORT_HEIGHT
          drawWidth = EXPORT_HEIGHT * imgAspect
          drawX = (EXPORT_WIDTH - drawWidth) / 2
          drawY = 0
        }

        ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)

      } else if (media.type === 'text') {
        // Draw text — match preview's CSS layout:
        // alignItems: flex-start (top) / center / flex-end (bottom)
        // justifyContent: center (horizontal)
        // padding: 20px (in preview coords, scaled to output)
        const fontSize = Math.round((clip.fontSize || 48) * scaleFactor)
        const fontFamily = clip.fontFamily || 'Roboto'
        const fontWeight = clip.fontWeight || 'normal'
        const fontColor = clip.fontColor || '#ffffff'
        const text = clip.text || 'Text'
        const textAlignVal = clip.textAlign || 'top'
        const padding = Math.round(20 * scaleFactor)

        const hAlign = clip.textHAlign || 'center'

        ctx.font = `${fontWeight} ${fontSize}px '${fontFamily}'`
        ctx.fillStyle = fontColor
        ctx.textAlign = hAlign
        ctx.textBaseline = 'middle'

        // Text shadow — matches preview's textShadow: 2px 2px 4px rgba(0,0,0,0.8)
        ctx.shadowColor = 'rgba(0,0,0,0.8)'
        ctx.shadowBlur = Math.round(4 * scaleFactor)
        ctx.shadowOffsetX = Math.round(2 * scaleFactor)
        ctx.shadowOffsetY = Math.round(2 * scaleFactor)

        // Handle multi-line text
        const lines = text.split('\n')
        const lineHeight = fontSize * 1.2
        const totalHeight = lines.length * lineHeight

        // Vertical alignment matching preview's flexbox alignItems
        let startY
        if (textAlignVal === 'center') {
          startY = (EXPORT_HEIGHT - totalHeight) / 2 + lineHeight / 2
        } else if (textAlignVal === 'bottom') {
          startY = EXPORT_HEIGHT - padding - totalHeight + lineHeight / 2
        } else {
          // top (default) — matches preview's alignItems: flex-start with padding
          startY = padding + lineHeight / 2
        }

        // Horizontal position based on alignment
        let textX
        if (hAlign === 'left') {
          textX = padding
        } else if (hAlign === 'right') {
          textX = EXPORT_WIDTH - padding
        } else {
          textX = EXPORT_WIDTH / 2
        }

        lines.forEach((line, i) => {
          ctx.fillText(line, textX, startY + i * lineHeight)
        })

        // Reset shadow
        ctx.shadowColor = 'transparent'
        ctx.shadowBlur = 0
        ctx.shadowOffsetX = 0
        ctx.shadowOffsetY = 0
      }

      ctx.restore()
    }
  }

  // Wait for video to seek to a specific time
  const seekVideo = (video, time) => {
    return new Promise((resolve) => {
      if (Math.abs(video.currentTime - time) < 0.01) {
        resolve()
        return
      }

      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked)
        resolve()
      }

      video.addEventListener('seeked', onSeeked)
      video.currentTime = time
    })
  }

  // Main export function
  const exportCanvas = useCallback(async (tracks, backgroundMusic, options = {}) => {
    if (!ffmpegLoaded || !ffmpeg) {
      throw new Error('FFmpeg not loaded')
    }

    abortRef.current = false
    setExporting(true)
    setExportProgress(0)
    setExportPhase('Loading media...')

    // Measure the preview container to calculate scale factor
    // Clip properties (fontSize, positionX/Y) are in preview-pixel coords
    const previewEl = document.querySelector('.preview-layer-container') || document.querySelector('.global-preview-video')
    const previewWidth = previewEl ? previewEl.clientWidth : EXPORT_WIDTH
    const scaleFactor = EXPORT_WIDTH / previewWidth
    console.log(`[CanvasExport] Preview width: ${previewWidth}px, Output: ${EXPORT_WIDTH}px, Scale factor: ${scaleFactor.toFixed(2)}`)

    let keyers = null
    try {
      // Calculate total duration
      const videoTracks = (tracks || []).filter(t => t.type === 'video')
      let totalDuration = 0

      for (const track of videoTracks) {
        for (const clip of track.clips) {
          const clipEnd = (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
          totalDuration = Math.max(totalDuration, clipEnd)
        }
      }

      if (totalDuration === 0) {
        throw new Error('No clips to export')
      }

      // Build clip to track index map
      const clipTrackIndexMap = new Map()
      videoTracks.forEach((track, trackIndex) => {
        track.clips.forEach(clip => {
          clipTrackIndexMap.set(clip.id, trackIndex)
        })
      })

      // Load all media
      const mediaElements = await loadMedia(tracks)
      keyers = await createKeyers(mediaElements)

      // Create canvas
      const canvas = document.createElement('canvas')
      canvas.width = EXPORT_WIDTH
      canvas.height = EXPORT_HEIGHT
      const ctx = canvas.getContext('2d')
      canvasRef.current = canvas

      setExportPhase('Rendering frames...')

      // Capture stream and set up MediaRecorder
      const stream = canvas.captureStream(EXPORT_FPS)

      // Try different codecs in order of preference
      const codecs = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4'
      ]

      let selectedMimeType = null
      for (const codec of codecs) {
        if (MediaRecorder.isTypeSupported(codec)) {
          selectedMimeType = codec
          console.log('Using codec:', codec)
          break
        }
      }

      if (!selectedMimeType) {
        throw new Error('No supported video codec found for MediaRecorder')
      }

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: selectedMimeType,
        videoBitsPerSecond: 8000000 // 8 Mbps
      })

      const chunks = []
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data)
        }
      }

      // Start recording
      mediaRecorder.start()

      // Render frames
      const frameCount = Math.ceil(totalDuration * EXPORT_FPS)
      const frameDuration = 1 / EXPORT_FPS

      for (let frame = 0; frame < frameCount; frame++) {
        if (abortRef.current) {
          mediaRecorder.stop()
          throw new Error('Export cancelled')
        }

        const currentTime = frame * frameDuration

        // Find clips at this time
        const clips = findClipsAtTime(tracks, currentTime, clipTrackIndexMap)

        // Seek all videos to correct time
        for (const clip of clips) {
          const media = mediaElements.get(clip.id)
          if (media && media.type === 'video') {
            const clipLocalTime = currentTime - clip.timelineStart + clip.startTime
            await seekVideo(media.element, clipLocalTime)
          }
        }

        // Draw frame
        drawFrame(ctx, clips, mediaElements, currentTime, scaleFactor, keyers)

        // Update progress
        setExportProgress((frame + 1) / frameCount * 0.7) // 70% for rendering

        // Small delay to allow encoder to keep up
        if (frame % 10 === 0) {
          await new Promise(r => setTimeout(r, 1))
        }
      }

      // Stop recording and wait for data
      setExportPhase('Encoding video...')

      const videoBlob = await new Promise((resolve) => {
        mediaRecorder.onstop = () => {
          resolve(new Blob(chunks, { type: selectedMimeType }))
        }
        mediaRecorder.stop()
      })

      setExportProgress(0.75)
      setExportPhase('Processing audio...')

      // Determine file extension based on mime type
      const isMP4 = selectedMimeType.includes('mp4')
      const inputExt = isMP4 ? 'mp4' : 'webm'
      const inputFilename = `canvas_video.${inputExt}`

      // Write video to FFmpeg
      const videoData = new Uint8Array(await videoBlob.arrayBuffer())
      await ffmpeg.writeFile(inputFilename, videoData)

      let finalOutput = inputFilename

      // Handle audio
      const audioTracks = (tracks || []).filter(t => t.type === 'audio')
      const hasBackgroundMusic = backgroundMusic && backgroundMusic.file

      // Extract audio from video clips that have audio enabled
      const videoClipsWithAudio = []
      for (const track of videoTracks) {
        for (const clip of track.clips) {
          if (clip.type === 'video' && clip.audioEnabled !== false) {
            videoClipsWithAudio.push(clip)
          }
        }
      }

      // For simplicity, just add background music if present
      // A full implementation would mix all audio sources
      if (hasBackgroundMusic) {
        // Fetch and write background music
        const response = await fetch(backgroundMusic.url)
        const musicBlob = await response.blob()
        const musicData = new Uint8Array(await musicBlob.arrayBuffer())
        await ffmpeg.writeFile('music.mp3', musicData)

        // Combine video with audio
        const withAudioFilename = `with_audio.${inputExt}`
        const exitCode = await ffmpeg.exec([
          '-i', inputFilename,
          '-i', 'music.mp3',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-shortest',
          '-y', withAudioFilename
        ])

        if (exitCode === 0) {
          await ffmpeg.deleteFile('music.mp3')
          await ffmpeg.deleteFile(inputFilename)
          finalOutput = withAudioFilename
        }
      }

      setExportProgress(0.9)
      setExportPhase('Converting to MP4...')

      // Convert to MP4 for better compatibility (pad ensures even dimensions for libx264)
      await ffmpeg.exec([
        '-i', finalOutput,
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:v', 'libx264',
        '-crf', (options.crf || 23).toString(),
        '-preset', 'fast',
        '-c:a', 'aac',
        '-y', 'final.mp4'
      ])

      await ffmpeg.deleteFile(finalOutput)

      setExportProgress(0.95)
      setExportPhase('Preparing download...')

      // Read and download
      const data = await ffmpeg.readFile('final.mp4')
      await ffmpeg.deleteFile('final.mp4')

      const blob = new Blob([data.buffer], { type: 'video/mp4' })
      const url = URL.createObjectURL(blob)

      const a = document.createElement('a')
      a.href = url
      a.download = 'edited_video.mp4'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      // Clean up media elements
      for (const [, media] of mediaElements) {
        if (media.type === 'video') {
          media.element.removeAttribute('src')
        }
      }

      setExportProgress(1)
      setExportPhase('Complete!')

      return true

    } catch (error) {
      console.error('Canvas export failed:', error)
      throw error
    } finally {
      keyers?.forEach(k => k.keyer.dispose())
      setExporting(false)
      setExportProgress(0)
      setExportPhase('')
    }
  }, [ffmpeg, ffmpegLoaded])

  const cancelExport = useCallback(() => {
    abortRef.current = true
  }, [])

  return {
    exporting,
    exportProgress,
    exportPhase,
    exportCanvas,
    cancelExport
  }
}
