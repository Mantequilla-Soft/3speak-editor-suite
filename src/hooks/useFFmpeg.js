import { useState, useRef, useCallback } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'

export function useFFmpeg() {
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [exportProgress, setExportProgress] = useState(0)
  const [exporting, setExporting] = useState(false)
  const ffmpegRef = useRef(null)

  const loadFFmpeg = useCallback(async () => {
    if (loaded || loading) return

    setLoading(true)
    setProgress(0)

    try {
      const ffmpeg = new FFmpeg()
      ffmpegRef.current = ffmpeg

      ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg]', message)
      })

      ffmpeg.on('progress', ({ progress: p }) => {
        setExportProgress(p)
      })

      // Use esm build with direct URLs
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm'

      // Fetch and create blob URLs to avoid CORS issues
      const coreResponse = await fetch(`${baseURL}/ffmpeg-core.js`)
      const coreBlob = new Blob([await coreResponse.text()], { type: 'text/javascript' })
      const coreURL = URL.createObjectURL(coreBlob)

      const wasmResponse = await fetch(`${baseURL}/ffmpeg-core.wasm`)
      const wasmBlob = new Blob([await wasmResponse.arrayBuffer()], { type: 'application/wasm' })
      const wasmURL = URL.createObjectURL(wasmBlob)

      await ffmpeg.load({
        coreURL,
        wasmURL,
      })

      setLoaded(true)
    } catch (error) {
      console.error('Failed to load FFmpeg:', error)
      // Don't throw - just log the error so the app continues to work
    } finally {
      setLoading(false)
    }
  }, [loaded, loading])

  // Helper to get file data from either File object or blob URL
  const getFileData = async (clip) => {
    if (clip.file && clip.file instanceof File) {
      return await fetchFile(clip.file)
    } else if (clip.url) {
      // Fetch from blob URL
      const response = await fetch(clip.url)
      const blob = await response.blob()
      return new Uint8Array(await blob.arrayBuffer())
    }
    throw new Error('No valid file source for clip: ' + clip.name)
  }

  const processVideo = useCallback(async (clips, backgroundMusic, options = {}) => {
    if (!ffmpegRef.current || !loaded) {
      throw new Error('FFmpeg not loaded')
    }

    if (!clips || clips.length === 0) {
      throw new Error('No clips to export')
    }

    const ffmpeg = ffmpegRef.current
    setExporting(true)
    setExportProgress(0)

    // Quality settings (CRF: 18=high quality, 23=default, 28=low quality/small file)
    const crf = options.crf || 23

    // Helper to run FFmpeg and check for success
    const execWithCheck = async (args, allowFailure = false) => {
      const exitCode = await ffmpeg.exec(args)
      if (exitCode !== 0 && !allowFailure) {
        throw new Error(`FFmpeg command failed with exit code ${exitCode}`)
      }
      return exitCode
    }

    try {
      // Sort clips by timeline position
      const sortedClips = [...clips].sort((a, b) =>
        (a.timelinePosition || 0) - (b.timelinePosition || 0)
      )

      const processedClips = []

      // Process each clip
      for (let i = 0; i < sortedClips.length; i++) {
        const clip = sortedClips[i]

        // Determine file extension based on type
        const ext = clip.type === 'image' ? 'png' : 'mp4'
        const inputName = `input_${i}.${ext}`
        const outputName = `clip_${i}.mp4`

        console.log(`Processing clip ${i}: ${clip.name}`)

        // Write input file using our helper
        const fileData = await getFileData(clip)
        await ffmpeg.writeFile(inputName, fileData)

        // Build FFmpeg command
        const args = []

        if (clip.type === 'image') {
          // For images, create a video with the specified duration
          const duration = clip.endTime - clip.startTime
          args.push(
            '-loop', '1',
            '-i', inputName,
            '-c:v', 'libx264',
            '-crf', crf.toString(),
            '-t', duration.toString(),
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
            '-r', '30',
            '-y', outputName
          )
        } else {
          // For video clips
          // Trim: seek to start position
          if (clip.startTime > 0) {
            args.push('-ss', clip.startTime.toString())
          }

          args.push('-i', inputName)

          // Set duration (trimmed length)
          const duration = clip.endTime - clip.startTime
          args.push('-t', duration.toString())

          // Ensure even dimensions (libx264 requires width & height divisible by 2)
          args.push('-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2')

          // Handle audio
          if (clip.audioEnabled !== false) {
            args.push('-c:v', 'libx264', '-crf', crf.toString(), '-c:a', 'aac', '-preset', 'fast')
          } else {
            args.push('-c:v', 'libx264', '-crf', crf.toString(), '-an', '-preset', 'fast')
          }

          args.push('-y', outputName)
        }

        await execWithCheck(args)
        processedClips.push(outputName)

        // Clean up input
        await ffmpeg.deleteFile(inputName)

        // Update progress
        setExportProgress((i + 1) / (sortedClips.length + 2))
      }

      let finalOutput

      if (processedClips.length === 1) {
        // Single clip, no need to concatenate
        finalOutput = processedClips[0]
      } else {
        // Create concat file
        const concatContent = processedClips.map(name => `file '${name}'`).join('\n')
        await ffmpeg.writeFile('concat.txt', concatContent)

        // Concatenate all clips
        await execWithCheck([
          '-f', 'concat',
          '-safe', '0',
          '-i', 'concat.txt',
          '-c', 'copy',
          '-y', 'concatenated.mp4'
        ])

        // Clean up processed clips
        for (const clipName of processedClips) {
          await ffmpeg.deleteFile(clipName)
        }
        await ffmpeg.deleteFile('concat.txt')

        finalOutput = 'concatenated.mp4'
      }

      // Add background music if present
      if (backgroundMusic && backgroundMusic.file) {
        const musicData = await getFileData(backgroundMusic)
        await ffmpeg.writeFile('music.mp3', musicData)

        // Check if any clip might have audio (not 100% reliable, but a hint)
        const mightHaveAudio = sortedClips.some(c => c.audioEnabled !== false && c.type !== 'image')
        let musicMixed = false

        if (mightHaveAudio) {
          // Try to mix audio: keep original video audio and add background music
          // This may fail if the video doesn't actually have an audio stream
          // allowFailure=true because we have a fallback
          const exitCode = await execWithCheck([
            '-i', finalOutput,
            '-i', 'music.mp3',
            '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]',
            '-map', '0:v',
            '-map', '[aout]',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-shortest',
            '-y', 'final.mp4'
          ], true) // allowFailure = true

          if (exitCode === 0) {
            musicMixed = true
          } else {
            console.log('Audio mixing failed (video may not have audio), falling back to music-only')
          }
        }

        if (!musicMixed) {
          // No video audio or mixing failed, just add music as the audio track
          await execWithCheck([
            '-i', finalOutput,
            '-i', 'music.mp3',
            '-map', '0:v',
            '-map', '1:a',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-shortest',
            '-y', 'final.mp4'
          ])
        }

        await ffmpeg.deleteFile('music.mp3')
        if (finalOutput !== 'final.mp4') {
          await ffmpeg.deleteFile(finalOutput)
        }
        finalOutput = 'final.mp4'
      }

      setExportProgress(0.95)

      // Read output and create download
      const data = await ffmpeg.readFile(finalOutput)
      await ffmpeg.deleteFile(finalOutput)

      const blob = new Blob([data.buffer], { type: 'video/mp4' })
      const url = URL.createObjectURL(blob)

      // Trigger download
      const a = document.createElement('a')
      a.href = url
      a.download = 'edited_video.mp4'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      setExportProgress(1)
      return true
    } catch (error) {
      console.error('Export failed:', error)
      throw error
    } finally {
      setExporting(false)
      setExportProgress(0)
    }
  }, [loaded])

  return {
    ffmpeg: ffmpegRef.current,
    loaded,
    loading,
    progress,
    exporting,
    exportProgress,
    loadFFmpeg,
    processVideo
  }
}
