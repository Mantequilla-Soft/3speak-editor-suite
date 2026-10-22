import { spawn, execFile } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import { createStaticMasker, staticMaskSize } from '../utils/staticKeyMask.js'
import { ffmpegColorFilter } from '../utils/clipColor.js'
import crypto from 'crypto'
import { ffmpegMotionFilter, normalizeMotion, pivotPoint, activeEffects } from '../utils/stickerMotion.js'

// clip volume 0..100 -> gain. 0 means silent: `volume || 100` used to turn it into full volume.
const clipVolume = clip => (Number.isFinite(+clip.volume) ? Math.max(0, +clip.volume) : 100) / 100


// Re-renders reuse what did not change: each clip's processed file is kept
// under a fingerprint of everything that shapes it (its settings, its source
// file, output size / fps / scale). Where a clip sits on the timeline is not
// part of it: that is applied when compositing. Bump CLIP_CACHE_VERSION when
// processClip's output changes for the same input.
const CLIP_CACHE_VERSION = 1
export const RENDER_CACHE_DIR = path.join(process.env.WORK_DIR || '/app/work', 'cache')
const CLIP_CACHE_DIR = path.join(RENDER_CACHE_DIR, 'clips')
const NOT_IN_CLIP_RENDER = new Set(['id', 'name', 'timelinePosition', 'trackId', 'libraryId', 'groupId', 'credit', 'sticker'])

function clipCacheKey(clip, inputFile, w, h, fps, scaleFactor) {
  const shape = {}
  for (const k of Object.keys(clip).sort()) if (!NOT_IN_CLIP_RENDER.has(k)) shape[k] = clip[k]
  return crypto.createHash('sha256')
    .update(JSON.stringify({ v: CLIP_CACHE_VERSION, shape, input: inputFile ? path.basename(inputFile) : null, w, h, fps, scaleFactor }))
    .digest('hex').slice(0, 40)
}

async function fileExists(p) {
  try { await fs.access(p); return true } catch { return false }
}

// A clip's motion when any effect applies (all hidden = no motion at all)
const appliedMotion = (clip) => (activeEffects(clip.motion).length ? normalizeMotion(clip.motion) : null)

/**
 * Build and execute FFmpeg commands to render the timeline.
 */
export async function buildAndRunFFmpeg({ timeline, downloadedFiles, outputPath, jobDir, onProgress, signal }) {
  const outputWidth = timeline.outputWidth || 854
  const outputHeight = timeline.outputHeight || 480
  const fps = timeline.fps || 30

  // Scale factor: clip properties (fontSize, positionX/Y) are in preview-pixel coords
  // Convert to output resolution
  const previewWidth = timeline.previewWidth || outputWidth
  const scaleFactor = outputWidth / previewWidth
  console.log(`[ffmpeg] Preview width: ${previewWidth}px, Output: ${outputWidth}px, Scale factor: ${scaleFactor.toFixed(2)}`)

  // Scoped runner that passes the abort signal to every FFmpeg call
  const run = (args) => runFFmpeg(args, signal)

  // hidden video tracks are not drawn (and their clips' own sound is not mixed), as in the preview
  const videoTracks = timeline.tracks.filter(t => t.type === 'video' && t.visible !== false)
  const audioTracks = timeline.tracks.filter(t => t.type === 'audio')

  // Calculate total timeline duration
  let totalDuration = 0
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const clipEnd = (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
      totalDuration = Math.max(totalDuration, clipEnd)
    }
  }

  if (totalDuration === 0) {
    throw new Error('Timeline has no duration')
  }

  // Collect all clips with track info
  const allClips = []
  for (const track of [...videoTracks, ...audioTracks]) {
    for (const clip of track.clips) {
      allClips.push({ ...clip, trackType: track.type, trackId: track.id })
    }
  }

  // STEP 1: Process each clip (trim, scale)
  onProgress(0, 'Processing individual clips...')

  const processedClips = new Map()
  const processedPlates = new Map() // clip id -> clean plate PNG (static-background key)
  let reusedClips = 0

  for (let i = 0; i < allClips.length; i++) {
    const clip = allClips[i]
    const inputFile = downloadedFiles.get(clip.id)

    // Text and color clips don't need downloaded files
    if (!inputFile && clip.type !== 'text' && clip.type !== 'color') continue

    // Detect image type from file extension if not set correctly
    if (inputFile && (!clip.type || clip.type === 'video')) {
      const inputExt = path.extname(inputFile).toLowerCase()
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(inputExt)) {
        clip.type = 'image'
        console.log(`[DEBUG] Corrected clip type to 'image' based on file extension: ${inputExt}`)
      }
    }

    onProgress((i / allClips.length) * 0.4, `Processing clip ${i + 1}/${allClips.length}: ${clip.name || 'clip'}`)

    // Use .mov for images and text to preserve transparency, .mp4 for others (including color)
    const ext = (clip.type === 'image' || clip.type === 'text') ? '.mov' : '.mp4'
    // Unchanged since an earlier render: reuse its processed file
    const cacheKey = clipCacheKey(clip, inputFile, outputWidth, outputHeight, fps, scaleFactor)
    const cachedPath = path.join(CLIP_CACHE_DIR, `${cacheKey}${ext}`)
    let processedPath
    if (await fileExists(cachedPath)) {
      const now = new Date()
      await fs.utimes(cachedPath, now, now).catch(() => {})
      processedPath = cachedPath
      reusedClips++
      console.log(`[ffmpeg] Clip ${clip.id} unchanged, reused`)
    } else {
      processedPath = path.join(jobDir, `processed_${clip.id}${ext}`)
      await processClip(clip, inputFile, processedPath, outputWidth, outputHeight, fps, signal, scaleFactor)
      // Into the cache (written next to it first, so a half copy is never used)
      try {
        await fs.mkdir(CLIP_CACHE_DIR, { recursive: true })
        const tmp = `${cachedPath}.${process.pid}.${Date.now()}.part`
        await fs.copyFile(processedPath, tmp)
        await fs.rename(tmp, cachedPath)
      } catch (err) {
        console.warn(`[ffmpeg] Clip cache write failed: ${err.message}`)
      }
    }
    processedClips.set(clip.id, processedPath)

    // Static-background key: bring the clean plate into the processed clip's geometry
    const ck = clip.trackType === 'video' ? getChromaKey(clip) : null
    if (ck?.mode === 'static') {
      const plateFile = downloadedFiles.get(`${clip.id}__plate`)
      if (plateFile) {
        const platePath = path.join(jobDir, `processed_${clip.id}_plate.png`)
        const size = await processPlate(clip, plateFile, processedPath, platePath, outputWidth, outputHeight, signal)
        // Foreground mask with holes filled, per frame, by the shared mask module
        const t0 = Date.now()
        const mask = size
          ? await computeStaticMaskFile(clip, inputFile, plateFile, downloadedFiles.get(`${clip.id}__noise`) || null,
            path.join(jobDir, `mask_${clip.id}.gray`), fps, ck, signal)
          : null
        if (mask) console.log(`[ffmpeg] Static key mask for ${clip.id}: ${mask.frames} frames at ${mask.w}x${mask.h} in ${Date.now() - t0} ms`)
        processedPlates.set(clip.id, { plate: platePath, size, mask })
      } else {
        console.warn(`[ffmpeg] Clip ${clip.id}: static background key without a plate, rendering unkeyed`)
      }
    }
  }

  if (reusedClips) console.log(`[ffmpeg] ${reusedClips}/${allClips.length} clips unchanged since an earlier render, reused`)

  // STEP 2: Composite all video clips onto a single canvas
  // Uses overlay with setpts for timing — gaps are naturally transparent
  // because clips are only present during their timeline range.
  onProgress(0.4, 'Compositing video...')

  // Collect clips in layer order: bottom track first (last videoTrack = bottom in UI),
  // then upper tracks overlaid on top.
  const overlayClips = []
  for (const track of [...videoTracks].reverse()) {
    const sorted = [...track.clips].sort((a, b) => (a.timelinePosition || 0) - (b.timelinePosition || 0))
    for (const clip of sorted) {
      if (processedClips.has(clip.id)) {
        overlayClips.push({ clip, file: processedClips.get(clip.id) })
      }
    }
  }

  if (overlayClips.length === 0) {
    throw new Error('No video content to render')
  }

  let videoOutputPath

  // Always composite onto the canvas to ensure correct output dimensions (e.g. 9:16)
  {
    videoOutputPath = path.join(jobDir, 'composited_video.mp4')

    const compArgs = []
    // Input 0: black canvas for the full timeline duration
    compArgs.push('-f', 'lavfi', '-i', `color=c=black:s=${outputWidth}x${outputHeight}:d=${totalDuration}:r=${fps}`)

    // Add each processed clip as an input
    for (const oc of overlayClips) {
      compArgs.push('-i', oc.file)
    }

    // Clean plates (and foreground masks) of static-background keyed clips go after the clips
    const plateInputs = new Map() // overlay index -> { plate, mask } input indexes
    let nextInput = overlayClips.length + 1
    overlayClips.forEach((oc, i) => {
      const p = processedPlates.get(oc.clip.id)
      if (!p) return
      const entry = { plate: nextInput++, mask: null, maskInfo: p.mask, size: p.size }
      compArgs.push('-i', p.plate)
      if (p.mask) {
        entry.mask = nextInput++
        compArgs.push('-f', 'rawvideo', '-pix_fmt', 'gray', '-video_size', `${p.mask.w}x${p.mask.h}`, '-framerate', String(fps), '-i', p.mask.path)
      }
      plateInputs.set(i, entry)
    })

    // Build the filter graph:
    // 1. Key green / blue screen (or a static background) out of keyed clips
    // 2. Delay each clip to its timeline position using setpts
    // 3. Chain overlay filters: base → overlay clip0 → overlay clip1 → ...
    //    Keyed clips carry alpha, so overlay lets the lower layers show through.
    const filterParts = []
    const clipLabels = []

    for (let i = 0; i < overlayClips.length; i++) {
      const oc = overlayClips[i]
      const pos = oc.clip.timelinePosition || 0
      const delay = pos > 0.01 ? `setpts=PTS+${pos.toFixed(3)}/TB` : null
      const key = oc.clip.type === 'video' ? getChromaKey(oc.clip) : null

      if (key && key.mode === 'static' && plateInputs.has(i)) {
        const pi = plateInputs.get(i)
        filterParts.push(...buildStaticKeyFilter({
          clipLabel: `${i + 1}:v`,
          plateLabel: `${pi.plate}:v`,
          maskLabel: pi.mask != null ? `${pi.mask}:v` : null,
          // The mask covers the whole source frame: frame it exactly like the clip
          maskTransform: pi.mask != null
            ? `${withScaleFlags(buildTransformFilter(oc.clip, outputWidth, outputHeight), 'bilinear')},scale=${pi.size.width}:${pi.size.height}:flags=bilinear,setsar=1`
            : null,
          key, i, delay, outLabel: `v${i}`
        }))
        clipLabels.push(keyedColor(oc.clip, i, filterParts))
      } else if (key && key.mode !== 'static') {
        filterParts.push(...buildChromaKeyFilter(`${i + 1}:v`, key, i, delay, `v${i}`))
        clipLabels.push(keyedColor(oc.clip, i, filterParts))
      } else if (delay) {
        filterParts.push(`[${i + 1}:v]${delay}[v${i}]`)
        clipLabels.push(`[v${i}]`)
      } else {
        clipLabels.push(`[${i + 1}:v]`)
      }
    }

    let prev = '0:v'
    for (let i = 0; i < overlayClips.length; i++) {
      const oc = overlayClips[i]
      const out = i === overlayClips.length - 1 ? '[outv]' : `[tmp${i}]`
      const clipLabel = clipLabels[i]

      // Text/image/color clips have position baked into their canvas → overlay at 0:0
      // Video clips need position applied here
      const isFullCanvas = oc.clip.type === 'text' || oc.clip.type === 'image' || oc.clip.type === 'color'
      const overlayPos = isFullCanvas ? '0:0' : getOverlayPosition(oc.clip, outputWidth, outputHeight, scaleFactor)

      filterParts.push(`[${prev}]${clipLabel}overlay=${overlayPos}:eof_action=pass:format=auto${out}`)
      prev = `tmp${i}`
    }

    compArgs.push('-filter_complex', filterParts.join(';'))
    compArgs.push('-map', '[outv]')
    compArgs.push('-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p')
    compArgs.push('-t', totalDuration.toFixed(3))
    compArgs.push('-an')
    compArgs.push('-y', videoOutputPath)

    console.log('[DEBUG] Composite filter:', filterParts.join(';'))
    await run(compArgs)
  }

  // STEP 4: Mix audio
  onProgress(0.75, 'Mixing audio...')

  const audioSources = []

  // Audio from video clips with their own sound on (usually it comes from the
  // linked clip on the audio track instead). The processed video clip has no
  // audio (-an), so cut this clip's sound from its source like an audio clip.
  for (const track of videoTracks) {
    for (const clip of track.clips) {
      const inputFile = downloadedFiles.get(clip.id)
      if (clip.type !== 'video' || clip.audioEnabled === false || !inputFile || !processedClips.has(clip.id)) continue
      const audioPath = path.join(jobDir, `video_audio_${clip.id}.mp4`)
      await processClip({ ...clip, type: 'audio', trackType: 'audio' }, inputFile, audioPath, outputWidth, outputHeight, fps, signal, scaleFactor)
      audioSources.push({
        file: audioPath,
        volume: clipVolume(clip),
        offset: clip.timelinePosition || 0
      })
    }
  }

  // Audio-only tracks (with timeline offset)
  for (const track of audioTracks) {
    if (track.muted === true) continue // a muted track is silent in the preview, so it is silent here
    for (const clip of track.clips) {
      if (clip.audioEnabled === false) continue
      if (processedClips.has(clip.id)) {
        audioSources.push({
          file: processedClips.get(clip.id),
          volume: clipVolume(clip),
          offset: clip.timelinePosition || 0
        })
      }
    }
  }

  // STEP 5: Final encode
  onProgress(0.85, 'Encoding final output...')

  if (audioSources.length > 0) {
    await combineVideoAudio(videoOutputPath, audioSources, outputPath, fps, signal)
  } else {
    await run([
      '-i', videoOutputPath,
      '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
      '-an', '-r', fps.toString(),
      '-y', outputPath
    ])
  }

  onProgress(1.0, 'Complete')
}

/**
 * Process a single clip: trim, scale, normalize, apply transforms.
 */
async function processClip(clip, inputFile, outputPath, w, h, fps, signal, scaleFactor = 1) {
  const duration = clip.endTime - clip.startTime

  // Handle text clips
  if (clip.type === 'text') {
    console.log('[DEBUG] Text clip properties:', JSON.stringify({
      text: clip.text,
      fontSize: clip.fontSize,
      fontColor: clip.fontColor,
      fontFamily: clip.fontFamily,
      positionX: clip.positionX,
      positionY: clip.positionY,
      boxEnabled: clip.boxEnabled,
      boxColor: clip.boxColor,
      boxBorderW: clip.boxBorderW
    }, null, 2))

    const baseFontSize = clip.fontSize || 48
    const fontColor = clip.fontColor || 'white'

    // scaleFactor converts preview-pixel values to output-pixel values
    // zoom is the CSS scale() value (percentage / 100)
    const zoom = (clip.zoom && clip.zoom !== 100) ? clip.zoom / 100 : 1.0
    // Font size: scale from preview coords to output coords, then apply zoom
    const fontSize = Math.round(baseFontSize * scaleFactor * zoom)

    // Map font families to font files
    // Google Fonts (variable fonts use the same file for regular and bold)
    const G = '/usr/share/fonts/google'
    const fontFileMap = {
      // Sans Serif
      'Roboto': `${G}/Roboto[wdth,wght].ttf`,
      'Open Sans': `${G}/OpenSans[wdth,wght].ttf`,
      'Lato': `${G}/Lato-Regular.ttf`,
      'Montserrat': `${G}/Montserrat[wght].ttf`,
      'Poppins': `${G}/Poppins-Regular.ttf`,
      'Nunito': `${G}/Nunito[wght].ttf`,
      'Raleway': `${G}/Raleway[wght].ttf`,
      'Inter': `${G}/Inter[opsz,wght].ttf`,
      // Serif
      'Playfair Display': `${G}/PlayfairDisplay[wght].ttf`,
      'Merriweather': `${G}/Merriweather[opsz,wdth,wght].ttf`,
      'Lora': `${G}/Lora[wght].ttf`,
      // Display
      'Oswald': `${G}/Oswald[wght].ttf`,
      'Bebas Neue': `${G}/BebasNeue-Regular.ttf`,
      'Anton': `${G}/Anton-Regular.ttf`,
      'Archivo Black': `${G}/ArchivoBlack-Regular.ttf`,
      'Righteous': `${G}/Righteous-Regular.ttf`,
      'Titan One': `${G}/TitanOne-Regular.ttf`,
      'Fredoka': `${G}/Fredoka[wdth,wght].ttf`,
      'Lobster': `${G}/Lobster-Regular.ttf`,
      // Handwriting
      'Dancing Script': `${G}/DancingScript[wght].ttf`,
      'Pacifico': `${G}/Pacifico-Regular.ttf`,
      'Caveat': `${G}/Caveat[wght].ttf`,
      'Permanent Marker': `${G}/PermanentMarker-Regular.ttf`,
      'Bangers': `${G}/Bangers-Regular.ttf`,
      // Monospace
      'Roboto Mono': `${G}/RobotoMono[wght].ttf`,
      'Press Start 2P': `${G}/PressStart2P-Regular.ttf`,
      // Legacy fallbacks
      'Arial': `${G}/Roboto[wdth,wght].ttf`,
      'Helvetica': `${G}/Roboto[wdth,wght].ttf`,
      'Sans': `${G}/Roboto[wdth,wght].ttf`,
      'Times New Roman': `${G}/Merriweather[opsz,wdth,wght].ttf`,
      'Georgia': `${G}/Merriweather[opsz,wdth,wght].ttf`,
      'Courier New': `${G}/RobotoMono[wght].ttf`,
      'Impact': `${G}/Oswald[wght].ttf`,
      'Verdana': `${G}/OpenSans[wdth,wght].ttf`
    }
    const fontFileBoldMap = {
      // Sans Serif
      'Roboto': `${G}/Roboto[wdth,wght].ttf`,
      'Open Sans': `${G}/OpenSans[wdth,wght].ttf`,
      'Lato': `${G}/Lato-Bold.ttf`,
      'Montserrat': `${G}/Montserrat[wght].ttf`,
      'Poppins': `${G}/Poppins-Bold.ttf`,
      'Nunito': `${G}/Nunito[wght].ttf`,
      'Raleway': `${G}/Raleway[wght].ttf`,
      'Inter': `${G}/Inter[opsz,wght].ttf`,
      // Serif
      'Playfair Display': `${G}/PlayfairDisplay[wght].ttf`,
      'Merriweather': `${G}/Merriweather[opsz,wdth,wght].ttf`,
      'Lora': `${G}/Lora[wght].ttf`,
      // Display
      'Oswald': `${G}/Oswald[wght].ttf`,
      'Bebas Neue': `${G}/BebasNeue-Regular.ttf`,
      'Anton': `${G}/Anton-Regular.ttf`,
      'Archivo Black': `${G}/ArchivoBlack-Regular.ttf`,
      'Righteous': `${G}/Righteous-Regular.ttf`,
      'Titan One': `${G}/TitanOne-Regular.ttf`,
      'Fredoka': `${G}/Fredoka[wdth,wght].ttf`,
      'Lobster': `${G}/Lobster-Regular.ttf`,
      // Handwriting
      'Dancing Script': `${G}/DancingScript[wght].ttf`,
      'Pacifico': `${G}/Pacifico-Regular.ttf`,
      'Caveat': `${G}/Caveat[wght].ttf`,
      'Permanent Marker': `${G}/PermanentMarker-Regular.ttf`,
      'Bangers': `${G}/Bangers-Regular.ttf`,
      // Monospace
      'Roboto Mono': `${G}/RobotoMono[wght].ttf`,
      'Press Start 2P': `${G}/PressStart2P-Regular.ttf`,
      // Legacy fallbacks
      'Arial': `${G}/Roboto[wdth,wght].ttf`,
      'Helvetica': `${G}/Roboto[wdth,wght].ttf`,
      'Sans': `${G}/Roboto[wdth,wght].ttf`,
      'Times New Roman': `${G}/Merriweather[opsz,wdth,wght].ttf`,
      'Georgia': `${G}/Merriweather[opsz,wdth,wght].ttf`,
      'Courier New': `${G}/RobotoMono[wght].ttf`,
      'Impact': `${G}/Oswald[wght].ttf`,
      'Verdana': `${G}/OpenSans[wdth,wght].ttf`
    }
    const isBold = clip.fontWeight === 'bold'
    const fontFile = (isBold ? fontFileBoldMap[clip.fontFamily] : fontFileMap[clip.fontFamily])
      || fontFileMap[clip.fontFamily]
      || `${G}/Roboto[wdth,wght].ttf`

    // Padding matches preview's CSS padding: 20px, scaled to output resolution
    const padding = Math.round(20 * scaleFactor)

    // Word-wrap text to fit within canvas (matching CSS word-break: break-word)
    // Estimate average character width as ~0.6 × fontSize for proportional fonts
    const isMonospace = ['Courier New', 'Courier', 'Monospace', 'Roboto Mono', 'Press Start 2P'].includes(clip.fontFamily)
    const charWidthRatio = isMonospace ? 0.6 : 0.55
    const avgCharWidth = fontSize * charWidthRatio
    const maxTextWidth = w - padding * 2  // canvas width minus padding on both sides
    const maxCharsPerLine = Math.max(1, Math.floor(maxTextWidth / avgCharWidth))

    const rawText = clip.text || 'Text'
    let wrappedLines
    if (Array.isArray(clip.wrappedLines) && clip.wrappedLines.length > 0) {
      // Use pre-wrapped lines from the frontend (measured from actual DOM layout)
      wrappedLines = clip.wrappedLines
      console.log('[DEBUG] Text wrap (from frontend):', JSON.stringify({ input: rawText, lines: wrappedLines }))
    } else {
      // Fallback: estimate word wrap based on character width
      wrappedLines = []
      for (const paragraph of rawText.split('\n')) {
        if (paragraph === '') {
          wrappedLines.push('')
          continue
        }
        const words = paragraph.split(/(\s+)/)
        let currentLine = ''
        for (const word of words) {
          if ((currentLine + word).length > maxCharsPerLine && currentLine.trim().length > 0) {
            wrappedLines.push(currentLine.trimEnd())
            currentLine = word.trimStart()
          } else {
            currentLine += word
          }
        }
        if (currentLine.length > 0) wrappedLines.push(currentLine)
      }
      console.log('[DEBUG] Text wrap (estimated):', JSON.stringify({ input: rawText, maxCharsPerLine, lines: wrappedLines }))
    }

    // Position: match the preview's CSS layout
    const scaledPosX = Math.round((clip.positionX || 0) * scaleFactor)
    const scaledPosY = Math.round((clip.positionY || 0) * scaleFactor)
    const textAlign = clip.textAlign || 'top'
    const textHAlign = clip.textHAlign || 'center'

    // Line height and vertical positioning (matching CSS line-height: 1.2)
    const lineHeight = Math.round(fontSize * 1.2)
    const totalTextHeight = wrappedLines.length * lineHeight

    // Vertical start Y depends on textAlign (matching CSS alignItems)
    let baseY
    if (textAlign === 'center') {
      baseY = Math.round((h - totalTextHeight) / 2) + scaledPosY
    } else if (textAlign === 'bottom') {
      baseY = h - padding - totalTextHeight + scaledPosY
    } else {
      // top (default)
      baseY = padding + scaledPosY
    }

    // Text background box: compute box dimensions first so text can be centered within it
    const textBoxEnabled = clip.textBoxEnabled === true
    let boxInputArgs = []
    let boxOverlayPrefix = ''
    let boxPadding = 0, boxBorderWidth = 0, boxX = 0, boxY = 0, boxW = 0, boxH = 0, estTextWidth = 0

    if (textBoxEnabled) {
      boxPadding = Math.round((clip.textBoxPadding ?? 12) * scaleFactor)
      const boxRadius = Math.round((clip.textBoxRadius ?? 8) * scaleFactor)
      boxBorderWidth = Math.round((clip.textBoxBorderWidth ?? 0) * scaleFactor)
      const boxColor = clip.textBoxColor || '#000000'
      const boxOpacity = (clip.textBoxOpacity ?? 80) / 100
      const boxBorderColor = clip.textBoxBorderColor || '#ffffff'

      // Use measured text width from frontend if available, otherwise estimate
      if (clip.measuredMaxLineWidth && clip.measuredPreviewWidth) {
        estTextWidth = Math.round(clip.measuredMaxLineWidth * scaleFactor)
      } else {
        const maxLineLen = Math.max(...wrappedLines.map(l => l.length))
        const estCharWidth = fontSize * (isMonospace ? 0.6 : 0.55)
        estTextWidth = Math.round(maxLineLen * estCharWidth)
      }
      boxW = estTextWidth + boxPadding * 2 + boxBorderWidth * 2
      boxH = totalTextHeight + boxPadding * 2 + boxBorderWidth * 2

      // Box position: centered on canvas (adjusted for alignment)
      if (textHAlign === 'left') {
        boxX = padding + scaledPosX - boxPadding - boxBorderWidth
      } else if (textHAlign === 'right') {
        boxX = w - padding + scaledPosX - estTextWidth - boxPadding - boxBorderWidth
      } else {
        boxX = Math.round((w - boxW) / 2) + scaledPosX
      }
      boxY = baseY - boxPadding - boxBorderWidth

      // Generate SVG with rounded rectangle
      const svgPath = outputPath.replace(/\.[^.]+$/, '_box.svg')
      const halfBorder = boxBorderWidth / 2
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}">
  <rect x="${halfBorder}" y="${halfBorder}" width="${boxW - boxBorderWidth}" height="${boxH - boxBorderWidth}"
    rx="${boxRadius}" ry="${boxRadius}"
    fill="${boxColor}" fill-opacity="${boxOpacity}"
    ${boxBorderWidth > 0 ? `stroke="${boxBorderColor}" stroke-width="${boxBorderWidth}"` : 'stroke="none"'} />
</svg>`
      await fs.writeFile(svgPath, svg, 'utf-8')

      // Convert SVG to PNG using rsvg-convert
      const boxPngPath = svgPath.replace('.svg', '.png')
      await new Promise((resolve, reject) => {
        execFile('rsvg-convert', ['-o', boxPngPath, svgPath], (err) => {
          if (err) reject(new Error(`rsvg-convert failed: ${err.message}`))
          else resolve()
        })
      })

      boxInputArgs = ['-i', boxPngPath]
      // Overlay box PNG onto transparent canvas (format=auto doesn't preserve alpha, must keep rgba)
      // colorchannelmixer=aa=0 zeros the alpha (color source has no alpha channel, rgba conversion defaults to opaque)
      boxOverlayPrefix = `[0:v]format=rgba,colorchannelmixer=aa=0[base];[1:v]format=rgba[box];[base][box]overlay=${Math.max(0, boxX)}:${Math.max(0, boxY)}[withbox];[withbox]`

      console.log(`[DEBUG] Text box: x=${boxX}, y=${boxY}, w=${boxW}, h=${boxH}, padding=${boxPadding}, radius=${boxRadius}, border=${boxBorderWidth}, estTextWidth=${estTextWidth}`)
    }

    // Horizontal x expression per line — text_w is evaluated per drawtext instance
    // Both text and box are centered on the canvas, so they share the same center point
    let xExpr
    if (textHAlign === 'left') {
      xExpr = `${padding}+${scaledPosX}`
    } else if (textHAlign === 'right') {
      xExpr = `w-text_w-${padding}+${scaledPosX}`
    } else {
      xExpr = `(w-text_w)/2+${scaledPosX}`
    }

    // Shadow matches preview's textShadow: 2px 2px 4px rgba(0,0,0,0.8)
    const shadowX = Math.round(2 * scaleFactor * zoom)
    const shadowY = Math.round(2 * scaleFactor * zoom)

    // Escape fontFile path for FFmpeg
    const escapedFontFile = fontFile.replace(/:/g, '\\:')

    // Build per-line drawtext filters
    const drawTextFilters = []
    for (let i = 0; i < wrappedLines.length; i++) {
      const lineFilePath = outputPath.replace(/\.[^.]+$/, `_line${i}.txt`)
      await fs.writeFile(lineFilePath, wrappedLines[i] || ' ', 'utf-8')
      const escapedLineFile = lineFilePath.replace(/:/g, '\\:')
      const textYOffset = textBoxEnabled ? Math.round(boxPadding / 2) : 0
      const lineY = baseY + i * lineHeight + textYOffset

      drawTextFilters.push(
        `drawtext=textfile='${escapedLineFile}':fontfile='${escapedFontFile}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${xExpr}:y=${lineY}:shadowcolor=black@0.8:shadowx=${shadowX}:shadowy=${shadowY}`
      )
    }
    const filterChain = drawTextFilters.join(',')

    console.log(`[DEBUG] Text scaleFactor=${scaleFactor.toFixed(2)}, zoom=${zoom}, fontSize=${fontSize}, hAlign=${textHAlign}, vAlign=${textAlign}, lines=${wrappedLines.length}, textBox=${textBoxEnabled}`)
    console.log('[DEBUG] Output path:', outputPath)

    // Rotation turns the text (and its box) around the centre of the text block,
    // like the preview, which rotates the box element itself. The layer is the full
    // frame, and ffmpeg's rotate turns around the FRAME centre: turn it on a
    // canvas big enough for any angle, then lay it back offset so the block's
    // centre lands where it was.
    let rotateTail = '[outv]'
    const motion = appliedMotion(clip)
    if (clip.rotation || motion) {
      const textW = textBoxEnabled
        ? estTextWidth
        : (clip.measuredMaxLineWidth
          ? Math.round(clip.measuredMaxLineWidth * scaleFactor)
          : Math.round(Math.max(...wrappedLines.map(l => l.length)) * fontSize * (isMonospace ? 0.6 : 0.55)))
      const cx = textHAlign === 'left'
        ? padding + scaledPosX + textW / 2
        : textHAlign === 'right'
          ? w - padding + scaledPosX - textW / 2
          : w / 2 + scaledPosX
      const cy = baseY + totalTextHeight / 2
      // Motion (stickers): the finished layer moves around its pivot, a point of
      // the text block (or its box), turned with the block's rotation
      let pivot = { x: cx, y: cy }
      if (motion && (motion.pivotX || motion.pivotY)) {
        const blockW = textBoxEnabled ? boxW : textW
        const blockH = textBoxEnabled ? boxH : totalTextHeight
        const p = pivotPoint(motion, 0, 0, blockW, blockH)
        const o = turnOffset(p.x, p.y, clip.rotation)
        pivot = { x: cx + o.dx, y: cy + o.dy }
      }
      const motionTail = motion
        ? `;[premotion]${ffmpegMotionFilter(motion, { w, h, fps, cx: pivot.x, cy: pivot.y, zoom, duration })}[outv]`
        : ''
      if (!clip.rotation) rotateTail = motion ? `[premotion]${motionTail}` : '[outv]'
      if (clip.rotation) {
        const rad = (clip.rotation * Math.PI) / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        const D = Math.ceil(Math.hypot(w, h) / 2) * 2
        // Where the block centre ends up on the D x D canvas (clockwise, y down)
        const rx = D / 2 + cos * (cx - w / 2) - sin * (cy - h / 2)
        const ry = D / 2 + sin * (cx - w / 2) + cos * (cy - h / 2)
        const ox = Math.round(cx - rx)
        const oy = Math.round(cy - ry)
        rotateTail = `[txt];[txt]format=rgba,rotate=${rad.toFixed(6)}:c=none:ow=${D}:oh=${D}[rot];` +
          `color=c=black@0:s=${w}x${h}:d=${duration}${motion ? `:r=${fps}` : ''},format=rgba,colorchannelmixer=aa=0[rbg];` +
          `[rbg][rot]overlay=${ox}:${oy}${motion ? `[premotion]${motionTail}` : '[outv]'}`
      }
    }

    // Use QuickTime Animation codec to preserve transparency
    const filterComplex = textBoxEnabled
      ? `${boxOverlayPrefix}${filterChain}${rotateTail}`
      : `[0:v]format=rgba,colorchannelmixer=aa=0,${filterChain}${rotateTail}`
    return runFFmpeg([
      '-f', 'lavfi',
      // A moving sticker counts frames: give the layer the timeline's rate
      '-i', `color=c=black@0:s=${w}x${h}:d=${duration}${appliedMotion(clip) ? `:r=${fps}` : ''}`,
      ...boxInputArgs,
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-c:v', 'qtrle',
      '-pix_fmt', 'argb',
      '-r', fps.toString(),
      '-y', outputPath
    ], signal)
  }

  // Handle color clips (solid color or gradient backgrounds)
  if (clip.type === 'color') {
    const bgColor = (clip.backgroundColor || '#000000').replace('#', '0x')

    if (clip.gradientEnabled) {
      const endColor = (clip.gradientEndColor || '#ffffff').replace('#', '0x')
      const angle = clip.gradientAngle ?? 180

      // CSS gradient angle convention: 0°=bottom-to-top, 90°=left-to-right, 180°=top-to-bottom
      // Direction vector in screen coords (Y down): (sin(θ), -cos(θ))
      const rad = (angle * Math.PI) / 180
      const dx = Math.sin(rad)
      const dy = -Math.cos(rad)

      // Projection range across the canvas
      const minProj = Math.min(0, w * dx) + Math.min(0, h * dy)
      const maxProj = Math.max(0, w * dx) + Math.max(0, h * dy)
      const range = maxProj - minProj || 1 // avoid division by zero

      // t = (X*dx + Y*dy - minProj) / range, clamped to [0,1]
      // Blend: A*(1-t) + B*t
      const blendExpr = `A*(1-clip((X*${dx.toFixed(6)}+Y*${dy.toFixed(6)}-${minProj.toFixed(6)})/${range.toFixed(6)},0,1))+B*clip((X*${dx.toFixed(6)}+Y*${dy.toFixed(6)}-${minProj.toFixed(6)})/${range.toFixed(6)},0,1)`

      console.log(`[DEBUG] Gradient: angle=${angle}, dx=${dx.toFixed(4)}, dy=${dy.toFixed(4)}, minProj=${minProj.toFixed(2)}, maxProj=${maxProj.toFixed(2)}, range=${range.toFixed(2)}`)

      return runFFmpeg([
        '-f', 'lavfi', '-i', `color=c=${bgColor}:s=${w}x${h}:d=${duration}:r=${fps}`,
        '-f', 'lavfi', '-i', `color=c=${endColor}:s=${w}x${h}:d=${duration}:r=${fps}`,
        '-filter_complex', `[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]blend=all_expr='${blendExpr}'[outv]`,
        '-map', '[outv]',
        '-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p',
        '-r', fps.toString(),
        '-t', duration.toString(),
        '-y', outputPath
      ], signal)
    }

    // Solid color — simple color source
    return runFFmpeg([
      '-f', 'lavfi', '-i', `color=c=${bgColor}:s=${w}x${h}:d=${duration}:r=${fps}`,
      '-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-r', fps.toString(),
      '-y', outputPath
    ], signal)
  }

  if (clip.type === 'image') {
    let filterChain = withColor(clip, buildTransformFilter(clip, w, h))
    // Rotation (degrees, clockwise like the preview's CSS rotate): turn the scaled
    // image inside a box that fits it, transparent around it. The box keeps the
    // image's centre, so the centred overlay below still lands it where it was.
    if (clip.rotation && !getLayoutBox(clip, w, h)) {
      const a = ((clip.rotation * Math.PI) / 180).toFixed(6)
      filterChain += `,format=rgba,rotate=${a}:c=none:ow=rotw(${a}):oh=roth(${a})`
    }
    let overlayPos = getOverlayPosition(clip, w, h, scaleFactor)

    // Motion (stickers): the layer moves around the image's centre, which the
    // centred overlay puts at the frame centre plus the clip's offset
    const motion = layoutBoxFree(clip, w, h) ? appliedMotion(clip) : null
    let motionChain = ''
    if (motion) {
      const z = clip.zoom && clip.zoom !== 100 ? (clip.zoom > 10 ? clip.zoom / 100 : clip.zoom) : 1
      const cx = w / 2 + (clip.positionX || 0) * scaleFactor * z
      const cy = h / 2 + (clip.positionY || 0) * scaleFactor * z
      // The pivot: the image's own size on the frame (contain-fit like
      // buildTransformFilter, times the zoom), turned with its rotation
      let pivot = { x: cx, y: cy }
      if (motion.pivotX || motion.pivotY) {
        const size = await probeVideoSize(inputFile)
        if (size) {
          const iw = size.width * (clip.cropWidth || 100) / 100
          const ih = size.height * (clip.cropHeight || 100) / 100
          const k = Math.min(w / iw, h / ih) * z
          const p = pivotPoint(motion, 0, 0, iw * k, ih * k)
          const o = turnOffset(p.x, p.y, clip.rotation)
          pivot = { x: cx + o.dx, y: cy + o.dy }
        }
      }
      motionChain = `,${ffmpegMotionFilter(motion, { w, h, fps, cx: pivot.x, cy: pivot.y, zoom: z, duration })}`
    }

    // Use QuickTime Animation codec to preserve transparency
    return runFFmpeg([
      '-loop', '1',
      ...(motion ? ['-framerate', String(fps)] : []),
      '-i', inputFile,
      '-t', duration.toString(),
      '-filter_complex', `color=c=black@0.0:s=${w}x${h}:d=${duration}${motion ? `:r=${fps}` : ''}[bg];[0:v]${filterChain}[scaled];[bg][scaled]overlay=${overlayPos}${motion ? ':format=auto' : ''}${motionChain}[outv]`,
      '-map', '[outv]',
      '-c:v', 'qtrle',
      '-pix_fmt', 'argb',
      '-r', fps.toString(),
      '-y', outputPath
    ], signal)
  }

  if (clip.trackType === 'audio' || clip.type === 'audio') {
    if (!(await hasAudioStream(inputFile))) {
      // No audio stream — generate silence so the pipeline doesn't break
      console.log(`[DEBUG] Audio clip ${clip.id} has no audio stream, generating silence`)
      return runFFmpeg([
        '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
        '-t', duration.toString(),
        '-c:a', 'aac', '-ar', '44100',
        '-y', outputPath
      ], signal)
    }

    const args = []
    if (clip.startTime > 0) args.push('-ss', clip.startTime.toString())
    args.push('-i', inputFile, '-t', duration.toString())
    args.push('-vn', '-c:a', 'aac', '-ar', '44100', '-y', outputPath)
    return runFFmpeg(args, signal)
  }

  // Video clip — scale/crop (and colour, unless keyed), composited onto canvas later
  let filterChain = getChromaKey(clip) ? buildTransformFilter(clip, w, h, fps) : withColor(clip, buildTransformFilter(clip, w, h, fps))

  const args = []
  if (clip.startTime > 0) args.push('-ss', clip.startTime.toString())
  args.push('-i', inputFile, '-t', duration.toString())
  // Keyed clips are keyed in the composite step: keep this intermediate cleaner
  // so a second round of compression does not chew up the key edges
  const crf = getChromaKey(clip) ? '16' : '23'
  args.push(
    '-vf', filterChain,
    '-c:v', 'libx264', '-crf', crf, '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-an',
    '-y', outputPath
  )
  console.log(`[DEBUG] Video clip ffmpeg args: ffmpeg ${args.join(' ')}`)
  console.log(`[DEBUG] clip.type=${clip.type}, clip.id=${clip.id}, input=${inputFile}`)
  return runFFmpeg(args, signal)
}

/**
 * Colour adjustments (src/utils/clipColor.js) in front of a clip's transform.
 * Not part of buildTransformFilter: that one also frames a clean plate and a
 * static-key mask, which must stay untouched.
 */
function withColor(clip, filterChain) {
  const color = ffmpegColorFilter(clip.color)
  return color ? `${color},${filterChain}` : filterChain
}

/**
 * A keyed clip's colour goes on after the key (as in the preview, where the
 * keyed picture is what gets the filter). Returns the label to overlay.
 */
function keyedColor(clip, i, filterParts) {
  const color = ffmpegColorFilter(clip.color)
  if (!color) return `[v${i}]`
  filterParts.push(`[v${i}]${color}[v${i}c]`)
  return `[v${i}c]`
}

/**
 * Build FFmpeg filter chain for zoom/crop/position transforms
 */
function buildTransformFilter(clip, w, h, fps = null) {
  const filters = []

  // Layout box (remix modes): cover-fit into a box given as canvas fractions.
  // zoom/crop/position are ignored for these clips, matching the preview.
  const box = getLayoutBox(clip, w, h)
  if (box) {
    // Zoom scales the cover fit up; the crop then keeps a box-sized window
    filters.push(`scale=${Math.round(box.w * box.zoom)}:${Math.round(box.h * box.zoom)}:force_original_aspect_ratio=increase`)
    // Pan picks which part of the overflow stays visible (0.5 = centered)
    filters.push(`crop=${box.w}:${box.h}:(iw-ow)*${box.panX}:(ih-oh)*${box.panY}`)
    if (fps) filters.push(`fps=${fps}`)
    return filters.join(',')
  }

  // Apply crop — percentage-based (cropX/cropY/cropWidth/cropHeight are 0-100%)
  const cropX = clip.cropX || 0
  const cropY = clip.cropY || 0
  const cropW = clip.cropWidth || 100
  const cropH = clip.cropHeight || 100

  if (cropX !== 0 || cropY !== 0 || cropW !== 100 || cropH !== 100) {
    // Use FFmpeg expressions: iw/ih = input width/height
    filters.push(`crop=iw*${cropW / 100}:ih*${cropH / 100}:iw*${cropX / 100}:ih*${cropY / 100}`)
  }

  // Legacy pixel-based crop (if provided directly)
  if (clip.crop) {
    const { x = 0, y = 0, width, height } = clip.crop
    if (width && height) {
      filters.push(`crop=${width}:${height}:${x}:${y}`)
    }
  }

  // Determine target dimensions
  let scaleW = w
  let scaleH = h

  // Use clip's width/height if specified
  if (clip.width && clip.height) {
    scaleW = clip.width
    scaleH = clip.height
  } else if (clip.width) {
    scaleW = clip.width
    scaleH = -1 // maintain aspect ratio
  } else if (clip.height) {
    scaleW = -1 // maintain aspect ratio
    scaleH = clip.height
  }

  // Apply zoom/scale with safety limits
  if (clip.zoom && clip.zoom !== 1 && clip.zoom !== 100) {
    // Convert percentage to decimal if needed (100 -> 1.0, 200 -> 2.0)
    let zoomValue = clip.zoom
    if (zoomValue > 10) {
      zoomValue = zoomValue / 100
    }

    // Clamp zoom to reasonable range: 0.1 (10%) to 5.0 (500%)
    const safeZoom = Math.max(0.1, Math.min(5.0, zoomValue))
    if (scaleW > 0) scaleW = Math.round(scaleW * safeZoom)
    if (scaleH > 0) scaleH = Math.round(scaleH * safeZoom)
  }

  // Enforce maximum dimensions (4K limit)
  const MAX_DIMENSION = 3840
  if (scaleW > MAX_DIMENSION) scaleW = MAX_DIMENSION
  if (scaleH > MAX_DIMENSION) scaleH = MAX_DIMENSION

  // Scale to target size
  if (scaleW > 0 && scaleH > 0) {
    filters.push(`scale=${scaleW}:${scaleH}:force_original_aspect_ratio=decrease`)
  } else if (scaleW > 0) {
    filters.push(`scale=${scaleW}:-1`)
  } else if (scaleH > 0) {
    filters.push(`scale=-1:${scaleH}`)
  } else {
    // Fit to canvas
    filters.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`)
  }

  // Ensure even dimensions (libx264 requires width & height divisible by 2)
  // Use scale (trunc) instead of pad to avoid adding visible border pixels on PNGs
  filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')

  // Add fps for video clips
  if (fps) {
    filters.push(`fps=${fps}`)
  }

  return filters.join(',')
}

// A pivot offset (from the sticker's centre) turned with the clip's own
// rotation, as the preview's box turns before its motion applies
function turnOffset(dx, dy, rotationDeg) {
  if (!rotationDeg) return { dx, dy }
  const r = (rotationDeg * Math.PI) / 180
  return { dx: dx * Math.cos(r) - dy * Math.sin(r), dy: dx * Math.sin(r) + dy * Math.cos(r) }
}

// Motion only for freely placed clips (a remix layout box stays put)
const layoutBoxFree = (clip, w, h) => !getLayoutBox(clip, w, h)

/**
 * Resolve a clip's layout box (fractions of the canvas) to even output pixels.
 * Returns null when the clip has no valid layout.
 */
function getLayoutBox(clip, w, h) {
  const l = clip.layout
  if (!l || ![l.x, l.y, l.w, l.h].every(v => typeof v === 'number' && isFinite(v))) return null
  if (l.w <= 0 || l.h <= 0) return null
  const even = (v) => Math.max(2, Math.round(v / 2) * 2)
  const bw = Math.min(even(l.w * w), w)
  const bh = Math.min(even(l.h * h), h)
  const bx = Math.max(0, Math.min(w - bw, Math.round(l.x * w)))
  const by = Math.max(0, Math.min(h - bh, Math.round(l.y * h)))
  const pan = (v) => (typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5)
  const zoom = typeof l.zoom === 'number' && isFinite(l.zoom) ? Math.min(4, Math.max(1, l.zoom)) : 1
  return { x: bx, y: by, w: bw, h: bh, panX: pan(l.panX), panY: pan(l.panY), zoom }
}

/**
 * Green screen / static background keying.
 *
 * Mirrors src/utils/chromaKey.js in the frontend (modes, defaults, ranges and
 * the exact math), whose WebGL shader computes the same alpha so the preview
 * matches the render. Keep both files in step.
 *
 * clip.chromaKey: { color: 'green'|'blue'|'static', similarity, blend, spill,
 *                   plateUrl (static only) }
 *
 * Green / blue ("color excess" key, per pixel, channels 0-1):
 *   C = screen channel (G or B), M = max of the other two
 *   e = (C - M) / max(C, 0.3)          how much greener (bluer) than anything neutral
 *   alpha = clamp(((1 - similarity) - e) / blend, 0, 1)
 *   C' = C - spill * max(C - M, 0)     despill: pull the screen cast off the edges
 * Neutrals, skin, yellow and cyan all have e <= 0, so they stay solid; a dim or
 * unevenly lit screen keeps a similar e because of the division by C.
 *
 * Static background: see buildStaticKeyFilter (mask module shared with the preview).
 */
const KEY_DEFAULTS = {
  chroma: { similarity: 0.75, blend: 0.15, spill: 0.8 },
  static: { similarity: 0.05, blend: 0.12, spill: 0.6 }
}
const KEY_RANGES = {
  chroma: { similarity: [0.3, 0.97], blend: [0.001, 0.5] },
  static: { similarity: [0.01, 0.3], blend: [0, 0.5] }
}

function getChromaKey(clip) {
  const ck = clip?.chromaKey
  if (!ck || typeof ck !== 'object' || ck.enabled === false) return null
  const mode = ck.color === 'blue' ? 'blue' : ck.color === 'static' ? 'static' : 'green'
  const kind = mode === 'static' ? 'static' : 'chroma'
  const d = KEY_DEFAULTS[kind]
  const r = KEY_RANGES[kind]
  const num = (v, def, [lo, hi]) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def)
  return {
    mode,
    similarity: num(ck.similarity, d.similarity, r.similarity),
    blend: num(ck.blend, d.blend, r.blend),
    spill: num(ck.spill, d.spill, [0, 1])
  }
}

/**
 * Green / blue screen key as filtergraph parts: [inLabel] -> [outLabel] (gbrap,
 * despilled, alpha = key). Uses only cheap native filters: the planes are
 * split, M = max(other two) via blend=lighten, and lut2 (a 256x256 table)
 * computes alpha and the despilled screen channel from (C, M).
 */
function buildChromaKeyFilter(inLabel, key, i, delay, outLabel) {
  const T = (1 - key.similarity).toFixed(4)
  const B = Math.max(0.001, key.blend).toFixed(4)
  const S = key.spill.toFixed(4)
  const blue = key.mode === 'blue'
  const n = (s) => `[k${i}${s}]`
  // extractplanes emits its pads in fixed r, g, b order whatever the order asked
  // for, so name them by channel: c = screen channel, o1 / o2 = the other two
  const pads = blue ? [n('o1'), n('o2'), n('c')] : [n('o1'), n('c'), n('o2')]
  const alphaExpr = `255*clip((${T}-(x-y)/max(x,76.5))/${B},0,1)`
  const spillExpr = `x-${S}*max(x-y,0)`
  // mergeplanes takes the gbrap planes in order G, B, R, A
  const merged = blue ? [n('o2b'), n('cd'), n('o1b')] : [n('cd'), n('o2b'), n('o1b')]
  return [
    `[${inLabel}]format=gbrp,extractplanes=r+g+b${pads.join('')}`,
    `${n('c')}split${n('ca')}${n('cb')}`,
    `${n('o1')}split${n('o1a')}${n('o1b')}`,
    `${n('o2')}split${n('o2a')}${n('o2b')}`,
    `${n('o1a')}${n('o2a')}blend=all_mode=lighten,split${n('m1')}${n('m2')}`,
    `${n('ca')}${n('m1')}lut2=c0='${alphaExpr}'${n('a')}`,
    `${n('cb')}${n('m2')}lut2=c0='${spillExpr}'${n('cd')}`,
    `${merged.join('')}${n('a')}mergeplanes=map0s=0:map0p=0:map1s=1:map1p=0:map2s=2:map2p=0:map3s=3:map3p=0:format=gbrap` +
      `${delay ? `,${delay}` : ''}[${outLabel}]`
  ]
}

// backgroundkey compares stored YUV; the preview re-derives BT.601 limited YUV
// from decoded RGB, so normalize the clip and the plate to that first
const KEY_NORMALIZE = 'scale=out_color_matrix=bt601:out_range=tv'

/**
 * Static-background (difference) key against a clean plate P, mirroring the
 * preview shader (src/utils/chromaKey.js):
 *   pa    = backgroundkey alpha at full resolution. backgroundkey takes its
 *           reference from the first frame it sees, so the plate goes in front
 *           of the clip and is dropped again; threshold=1 stops it from ever
 *           adopting a later frame as the background.
 *   m     = foreground mask with holes filled (computeStaticMaskFile), framed
 *           like the clip and upscaled bilinearly
 *   alpha = clamp(pa + 2m - 1)                   lut2 on (pa, m)
 *   color = clamp((C - (1 - alpha) * spill * P) / alpha)   unmix the wall from the edge
 * Without a mask (it could not be computed) it falls back to plain backgroundkey.
 */
function buildStaticKeyFilter({ clipLabel, plateLabel, maskLabel, maskTransform, key, i, delay, outLabel }) {
  const prep = `${KEY_NORMALIZE},format=yuva420p,setsar=1`
  const n = (s) => `[s${i}${s}]`
  const bk = `backgroundkey=threshold=1:similarity=${key.similarity.toFixed(4)}:blend=${key.blend.toFixed(4)},` +
    'trim=start_frame=1,setpts=PTS-STARTPTS'
  const end = `${delay ? `,${delay}` : ''}[${outLabel}]`
  if (!maskLabel) {
    return [
      `[${plateLabel}]${prep}${n('kpl')}`,
      `[${clipLabel}]${prep}${n('kcl')}`,
      `${n('kpl')}${n('kcl')}concat=n=2:v=1:a=0,${bk}${end}`
    ]
  }
  const S = key.spill
  const parts = [
    `[${plateLabel}]split${n('pa')}${n('pb')}`,
    `${n('pa')}${prep}${n('kpl')}`,
    `[${clipLabel}]${prep}${n('kcl')}`,
    `${n('kpl')}${n('kcl')}concat=n=2:v=1:a=0,${bk},split${n('k1')}${n('k2')}`,
    `${n('k1')}alphaextract${n('pa8')}`,
    `[${maskLabel}]${maskTransform},format=gray${n('m')}`,
    `${n('pa8')}${n('m')}lut2=c0='clip(x+2*y-255,0,255)'${S > 0 ? `,split${n('a1')}${n('a2')}` : n('a1')}`
  ]
  if (S <= 0) {
    parts.push(`${n('pb')}nullsink`, `${n('k2')}${n('a1')}alphamerge${end}`)
    return parts
  }
  const all = (e) => `c0='${e}':c1='${e}':c2='${e}'`
  parts.push(
    // alpha as an RGB image (three copies of the plane)
    `${n('a2')}split=3${n('ar')}${n('ag')}${n('ab')}`,
    `${n('ag')}${n('ab')}${n('ar')}mergeplanes=map0s=0:map0p=0:map1s=1:map1p=0:map2s=2:map2p=0:format=gbrp,split${n('a3')}${n('a4')}`,
    `${n('pb')}format=gbrp${n('pg')}`,
    // (1 - alpha) * spill * P   (the stream first: the plate is a single frame)
    `${n('a3')}${n('pg')}lut2=${all(`y*(255-x)*${S.toFixed(4)}/255`)}${n('pp')}`,
    `${n('k2')}format=gbrp${n('cg')}`,
    `${n('cg')}${n('pp')}lut2=${all('max(x-y,0)')}${n('dd')}`,
    `${n('dd')}${n('a4')}lut2=${all('clip(x*255/max(y,1),0,255)')}${n('fg')}`,
    `${n('fg')}${n('a1')}alphamerge${end}`
  )
  return parts
}

/** Add flags to every scale filter of a filter chain (e.g. bilinear for masks). */
function withScaleFlags(chain, flags) {
  return chain.split(',').map(f => (f.startsWith('scale=') ? `${f}:flags=${flags}` : f)).join(',')
}

/** Width x height as decoded (rotation applied, like the browser shows it). */
function probeDisplaySize(file) {
  return new Promise((resolve) => {
    const probe = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', file
    ])
    let out = ''
    probe.stdout.on('data', d => { out += d.toString() })
    probe.on('close', () => {
      try {
        const st = JSON.parse(out).streams?.[0]
        if (!st?.width || !st?.height) return resolve(null)
        const rot = Math.abs(Number(st.side_data_list?.find(d => d.rotation != null)?.rotation || 0)) % 180
        resolve(rot === 90 ? { width: st.height, height: st.width } : { width: st.width, height: st.height })
      } catch {
        resolve(null)
      }
    })
    probe.on('error', () => resolve(null))
  })
}

/** Run ffmpeg and collect stdout (small outputs only). */
function ffmpegToBuffer(args, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    proc.stdout.on('data', c => chunks.push(c))
    proc.stderr.on('data', d => { stderr += d.toString() })
    const onAbort = () => proc.kill('SIGTERM')
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('Job aborted'))
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-500)}`))
    })
    proc.on('error', err => reject(err))
  })
}

/**
 * Static-background key, foreground mask pass: ffmpeg decodes the clip's range
 * of the SOURCE (whole frame, like the preview) scaled down to staticMaskSize,
 * the shared (stateful) mask module runs on every frame in order with its media
 * time, and the masks are written as a raw gray stream (w x h bytes per frame
 * at `fps`) for the composite step. noiseFile: the plate's noise map image
 * (optional; the preview made it while shooting the plate).
 * Returns { path, w, h, frames } or null.
 */
async function computeStaticMaskFile(clip, inputFile, plateFile, noiseFile, outPath, fps, key, signal) {
  const src = await probeDisplaySize(inputFile)
  if (!src) return null
  const [w, h] = staticMaskSize(src.width, src.height)
  const scale = `scale=${w}:${h}:flags=area,format=rgb24`
  const frameBytes = w * h * 3
  const plate = await ffmpegToBuffer(['-i', plateFile, '-vf', scale, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], signal)
  if (plate.length < frameBytes) return null
  // Noise map: one byte per cell, stored in the red channel; nearest-neighbour
  // if its size differs (the browser does the same)
  let noise = null
  if (noiseFile) {
    try {
      const rgb = await ffmpegToBuffer(['-i', noiseFile, '-vf', `scale=${w}:${h}:flags=neighbor,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], signal)
      if (rgb.length >= frameBytes) {
        noise = new Uint8Array(w * h)
        for (let i = 0; i < w * h; i++) noise[i] = rgb[i * 3]
      }
    } catch (err) {
      if (err.message === 'Job aborted') throw err
      console.warn(`[ffmpeg] Noise map unusable, using the default noise: ${err.message}`)
    }
  }
  const masker = createStaticMasker()

  const args = ['-v', 'error']
  if (clip.startTime > 0) args.push('-ss', clip.startTime.toString())
  args.push('-i', inputFile, '-t', (clip.endTime - clip.startTime).toString(), '-an',
    '-vf', `fps=${fps},${scale}`, '-f', 'rawvideo', 'pipe:1')

  const out = createWriteStream(outPath)
  const frame = Buffer.allocUnsafe(frameBytes)
  const mask = new Uint8Array(w * h)
  let fill = 0
  let frames = 0
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.stdout.on('data', (chunk) => {
      let off = 0
      while (off < chunk.length) {
        const take = Math.min(frameBytes - fill, chunk.length - off)
        chunk.copy(frame, fill, off, off + take)
        fill += take
        off += take
        if (fill === frameBytes) {
          masker.compute({ frame, plate, noise, w, h, channels: 3, similarity: key.similarity, time: frames / fps }, mask)
          out.write(Buffer.from(mask))
          frames++
          fill = 0
        }
      }
    })
    const onAbort = () => proc.kill('SIGTERM')
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('Job aborted'))
      if (code !== 0) return reject(new Error(`Mask pass failed (exit ${code}): ${stderr.slice(-500)}`))
      out.end(resolve)
    })
    proc.on('error', reject)
  }).catch((err) => {
    out.destroy()
    throw err
  })
  return frames > 0 ? { path: outPath, w, h, frames } : null
}

function probeVideoSize(file) {
  return new Promise((resolve) => {
    const probe = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x',
      file
    ])
    let out = ''
    probe.stdout.on('data', d => { out += d.toString() })
    probe.on('close', () => {
      const m = out.trim().match(/^(\d+)x(\d+)/)
      resolve(m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null)
    })
    probe.on('error', () => resolve(null))
  })
}

/** Scale / crop the clean plate exactly like its clip, to the processed clip's size. */
async function processPlate(clip, plateFile, processedClipPath, outPath, w, h, signal) {
  const size = await probeVideoSize(processedClipPath)
  const filters = [buildTransformFilter(clip, w, h)]
  if (size) filters.push(`scale=${size.width}:${size.height}`)
  filters.push('setsar=1')
  await runFFmpeg(['-i', plateFile, '-vf', filters.join(','), '-frames:v', '1', '-y', outPath], signal)
  return size
}

/**
 * Get overlay position for clip positioning
 */
function getOverlayPosition(clip, w, h, scaleFactor = 1) {
  const box = getLayoutBox(clip, w, h)
  if (box) return `${box.x}:${box.y}`

  // Use positionX/positionY as pixel offset from center
  // Values are in preview-pixel coords → scale to output, then apply zoom
  const offsetX = clip.positionX || (clip.position && clip.position.x) || 0
  const offsetY = clip.positionY || (clip.position && clip.position.y) || 0

  // Apply scaleFactor (preview→output) and zoom (CSS scale behavior)
  let zoomValue = 1
  if (clip.zoom && clip.zoom !== 1 && clip.zoom !== 100) {
    zoomValue = clip.zoom > 10 ? clip.zoom / 100 : clip.zoom
  }
  const scaledX = Math.round(offsetX * scaleFactor * zoomValue)
  const scaledY = Math.round(offsetY * scaleFactor * zoomValue)

  if (scaledX !== 0 || scaledY !== 0) {
    const xExpr = scaledX !== 0 ? `(W-w)/2+${scaledX}` : '(W-w)/2'
    const yExpr = scaledY !== 0 ? `(H-h)/2+${scaledY}` : '(H-h)/2'
    return `${xExpr}:${yExpr}`
  }
  // Default: center the clip
  return '(W-w)/2:(H-h)/2'
}

/**
 * Prepend black frames before a clip for timeline offset.
 */
async function prependBlack(inputFile, outputPath, durationSec, w, h, fps) {
  // Determine if input is transparent (MOV with qtrle) or opaque (MP4)
  const isTransparent = inputFile.endsWith('.mov')
  const blackPath = path.join(path.dirname(outputPath), `black_${Date.now()}${isTransparent ? '.mov' : '.mp4'}`)

  if (isTransparent) {
    // Use transparent black for clips that support alpha
    await runFFmpeg([
      '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:d=${durationSec}:r=${fps}`,
      '-filter_complex', '[0:v]format=rgba,colorchannelmixer=aa=0[outv]',
      '-map', '[outv]',
      '-t', durationSec.toString(),
      '-c:v', 'qtrle',
      '-pix_fmt', 'argb',
      '-y', blackPath
    ])
  } else {
    // Use opaque black for regular video clips
    await runFFmpeg([
      '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:d=${durationSec}:r=${fps}`,
      '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
      '-t', durationSec.toString(),
      '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      '-y', blackPath
    ])
  }

  const listPath = path.join(path.dirname(outputPath), `concat_${Date.now()}.txt`)
  await fs.writeFile(listPath, `file '${blackPath}'\nfile '${inputFile}'\n`)

  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', outputPath])

  await fs.unlink(blackPath).catch(() => {})
  await fs.unlink(listPath).catch(() => {})
}

/**
 * Concatenate clips on a track with black gap-fill.
 */
async function concatenateWithGaps(sortedClips, processedClips, outputPath, jobDir, w, h, fps, trackId) {
  const segments = []
  let currentTime = 0

  // Determine if any clip on this track is transparent (text/image)
  const hasTransparentClips = sortedClips.some(clip => {
    const processedFile = processedClips.get(clip.id)
    return processedFile && processedFile.endsWith('.mov')
  })

  console.log(`[DEBUG] concatenateWithGaps for track ${trackId}: hasTransparentClips=${hasTransparentClips}`)
  sortedClips.forEach(clip => {
    const processedFile = processedClips.get(clip.id)
    console.log(`[DEBUG]   Clip ${clip.id}: processedFile=${processedFile}`)
  })

  for (const clip of sortedClips) {
    const clipStart = clip.timelinePosition || 0
    const clipDuration = clip.endTime - clip.startTime
    const processedFile = processedClips.get(clip.id)
    if (!processedFile) continue

    const gap = clipStart - currentTime
    if (gap > 0.05) {
      const ext = hasTransparentClips ? '.mov' : '.mp4'
      const blackPath = path.join(jobDir, `gap_${trackId}_${currentTime}${ext}`)

      if (hasTransparentClips) {
        // Use transparent black for tracks with text/image clips
        await runFFmpeg([
          '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:d=${gap}:r=${fps}`,
          '-filter_complex', '[0:v]format=rgba,colorchannelmixer=aa=0[outv]',
          '-map', '[outv]',
          '-t', gap.toString(),
          '-c:v', 'qtrle',
          '-pix_fmt', 'argb',
          '-y', blackPath
        ])
      } else {
        // Use opaque black for regular video tracks
        await runFFmpeg([
          '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:d=${gap}:r=${fps}`,
          '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
          '-t', gap.toString(),
          '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-shortest',
          '-y', blackPath
        ])
      }
      segments.push(blackPath)
    }

    segments.push(processedFile)
    currentTime = clipStart + clipDuration
  }

  if (segments.length === 1) {
    await fs.copyFile(segments[0], outputPath)
    return
  }

  const listPath = path.join(jobDir, `concat_${trackId}.txt`)
  await fs.writeFile(listPath, segments.map(f => `file '${f}'`).join('\n'))

  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', outputPath])
}

/**
 * Overlay multiple video track files.
 */
async function overlayTracks(trackFiles, outputPath) {
  console.log('[DEBUG] Overlaying tracks:')
  trackFiles.forEach((tf, i) => {
    const isTransparent = tf.file.endsWith('.mov')
    console.log(`[DEBUG]   Track ${i}: ${tf.file} (${isTransparent ? 'TRANSPARENT .mov' : 'OPAQUE .mp4'})`)
  })

  const args = []
  for (const tf of trackFiles) args.push('-i', tf.file)

  if (trackFiles.length === 2) {
    args.push(
      '-filter_complex', '[0:v][1:v]overlay=0:0:eof_action=pass:format=auto[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-an',
      '-y', outputPath
    )
  } else {
    const parts = []
    let prev = '0:v'
    for (let i = 1; i < trackFiles.length; i++) {
      const out = i === trackFiles.length - 1 ? '[outv]' : `[tmp${i}]`
      parts.push(`[${prev}][${i}:v]overlay=0:0:eof_action=pass:format=auto${out}`)
      prev = `tmp${i}`
    }
    args.push(
      '-filter_complex', parts.join(';'),
      '-map', '[outv]',
      '-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-an',
      '-y', outputPath
    )
  }

  console.log('[DEBUG] Overlay filter:', args[args.indexOf('-filter_complex') + 1])
  await runFFmpeg(args)
}

// Whether a media file has an audio stream
function hasAudioStream(file) {
  return new Promise((resolve) => {
    const probe = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0',
      file
    ])
    let out = ''
    probe.stdout.on('data', d => { out += d.toString() })
    probe.on('close', () => resolve(out.trim().length > 0))
    probe.on('error', () => resolve(false))
  })
}

/**
 * Combine video with audio sources.
 * Handles composited video (no audio track) + separate audio sources with timeline offsets.
 */
async function combineVideoAudio(videoPath, allSources, outputPath, fps, signal) {
  // A source without an audio stream would fail the whole mix (and the render
  // would come out silent), so leave those out
  const audioSources = []
  for (const src of allSources) {
    if (await hasAudioStream(src.file)) audioSources.push(src)
    else console.warn(`[ffmpeg] No audio stream in ${path.basename(src.file)}, left out of the mix`)
  }
  if (audioSources.length === 0) {
    await runFFmpeg(['-i', videoPath, '-c:v', 'copy', '-an', '-y', outputPath], signal)
    return
  }

  // Check if all audio comes from the video file itself (single-clip shortcut)
  const allFromVideo = audioSources.every(a => a.file === videoPath)

  if (allFromVideo && audioSources.length > 0) {
    try {
      await runFFmpeg(['-i', videoPath, '-c:v', 'copy', '-c:a', 'aac', '-y', outputPath], signal)
      return
    } catch (err) {
      if (err.message === 'Job aborted') throw err
      console.warn('[ffmpeg] Copy with audio failed, video may not have audio:', err.message)
      await runFFmpeg(['-i', videoPath, '-c:v', 'copy', '-an', '-y', outputPath], signal)
      return
    }
  }

  // Composited video (no audio) + separate audio sources with timeline offsets
  const args = ['-i', videoPath]

  // Add each audio source as a separate input
  for (const src of audioSources) {
    args.push('-i', src.file)
  }

  // Build audio filter graph using adelay for timeline positioning
  const filterParts = []
  const mixInputs = []

  for (let i = 0; i < audioSources.length; i++) {
    const src = audioSources[i]
    const offset = src.offset || 0
    const vol = src.volume
    const delayMs = Math.round(offset * 1000)

    const filters = []
    if (delayMs > 0) {
      filters.push(`adelay=${delayMs}|${delayMs}`)
    }
    if (vol !== 1) {
      filters.push(`volume=${vol.toFixed(2)}`)
    }

    if (filters.length > 0) {
      filterParts.push(`[${i + 1}:a]${filters.join(',')}[a${i}]`)
      mixInputs.push(`[a${i}]`)
    } else {
      mixInputs.push(`[${i + 1}:a]`)
    }
  }

  if (mixInputs.length === 1) {
    // Single audio source
    if (filterParts.length > 0) {
      filterParts[filterParts.length - 1] = filterParts[filterParts.length - 1].replace(/\[a\d+\]$/, '[aout]')
      args.push(
        '-filter_complex', filterParts.join(';'),
        '-map', '0:v', '-map', '[aout]'
      )
    } else {
      args.push('-map', '0:v', '-map', '1:a')
    }
  } else {
    // Multiple audio sources — mix them together
    // normalize=0: each source keeps the volume it was given (amix's default divides every input by the number
    // of inputs, so music under a few sound effects came out far quieter than in the preview); a limiter
    // catches the peaks when several loud sources overlap.
    filterParts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[aout]`)
    args.push(
      '-filter_complex', filterParts.join(';'),
      '-map', '0:v', '-map', '[aout]'
    )
  }

  args.push('-c:v', 'copy', '-c:a', 'aac', '-y', outputPath)

  try {
    await runFFmpeg(args, signal)
  } catch (err) {
    if (err.message === 'Job aborted') throw err
    console.warn('[ffmpeg] Audio mix failed, falling back to video-only:', err.message)
    await runFFmpeg(['-i', videoPath, '-c:v', 'copy', '-an', '-y', outputPath], signal)
  }
}

/**
 * Run ffmpeg and return a promise.
 * Accepts an optional AbortSignal to kill the process early.
 */
function runFFmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('Job aborted'))
    }

    console.log(`[ffmpeg] ffmpeg ${args.join(' ')}`)

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    const onAbort = () => {
      proc.kill('SIGTERM')
      reject(new Error('Job aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-1000)}`))
    })

    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`))
    })

    // 30 min timeout
    setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('FFmpeg timed out after 30 minutes'))
    }, 30 * 60 * 1000)
  })
}
