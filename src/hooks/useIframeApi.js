import { useEffect, useCallback, useRef, useState } from 'react'
import { api, getBackendUrl } from '../utils/backendSelector'
import { hasLayout } from '../utils/remixLayout'
import { getClipChromaKey } from '../utils/chromaKey'
import { normalizeColor } from '../utils/clipColor'
import { normalizeMotion } from '../utils/stickerMotion'

const isIframe = typeof window !== 'undefined' && window.parent !== window
const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL || '').replace(/\/+$/, '')

export function useIframeApi({ addToLibraryAndTimeline, tracks, library, playheadPosition, fileStoreRef, activeAspectRatio, onTogglePlay }) {
  const parentOriginRef = useRef('*')
  const [renderStatus, setRenderStatus] = useState(null)
  const [theme, setTheme] = useState('dark')
  const [isDesktop, setIsDesktop] = useState(() => {
    // Default: use own viewport when not in iframe, false in iframe until parent tells us
    return !isIframe && typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
  })
  const pollIntervalRef = useRef(null)
  const uploadedPlatesRef = useRef(new Map()) // local clean-plate URL -> server URL
  const activeJobRef = useRef(null) // { jobId, backendEndpoint }
  const remixSourceRef = useRef(null) // { parentAuthor, parentPermlink } when remixing a short
  // Set when a whole video arrives for remixing (no clip range): { clipId, duration }
  // App shows the remix mode picker (stitch / reaction / free edit) for it.
  const [remixPrompt, setRemixPrompt] = useState(null)
  const onTogglePlayRef = useRef(onTogglePlay)
  onTogglePlayRef.current = onTogglePlay

  // Compact mode: default to true in iframe, controllable via URL param or postMessage
  // ?compact=true forces it on even outside iframe; ?compact=false disables it in iframe
  const [compactMode, setCompactMode] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const compactParam = params.get('compact')
    if (compactParam === 'true' || compactParam === '1') return true
    if (compactParam === 'false' || compactParam === '0') return false
    return isIframe // default: compact in iframe, full layout otherwise
  })

  // Read clip range from URL query params (optional)
  const urlClipRange = useRef(() => {
    const params = new URLSearchParams(window.location.search)
    const start = parseFloat(params.get('clipStart') || params.get('start') || '')
    const end = parseFloat(params.get('clipEnd') || params.get('end') || '')
    return {
      clipStart: !isNaN(start) && start >= 0 ? start : null,
      clipEnd: !isNaN(end) && end > 0 ? end : null
    }
  })
  const clipRangeRef = useRef(urlClipRange.current())

  // Drafts: the parent (3Speak) sends who the user is as a signed token
  // ({ token, user, pro, maxProjects, ttlHours } or null + reason), and asks
  // before closing so the editor can offer to save (closeRequest counts up).
  const [draftSession, setDraftSession] = useState(undefined) // undefined = not told yet
  const [draftContext, setDraftContext] = useState({ hasMedia: false, reason: null })
  const [closeRequest, setCloseRequest] = useState(0)

  const sendToParent = useCallback((type, payload = {}) => {
    if (!isIframe) return
    window.parent.postMessage({ source: '3speak-editor', type, ...payload }, parentOriginRef.current)
  }, [])

  // Listen for messages from parent
  useEffect(() => {
    if (!isIframe) return

    const handleMessage = async (event) => {
      const { data } = event
      if (!data || !data.type) return

      if (parentOriginRef.current === '*' && event.origin) {
        parentOriginRef.current = event.origin
      }

      switch (data.type) {
        case 'load-media': {
          const { name, mediaType, clipStart, clipEnd, parentAuthor, parentPermlink } = data
          // A file the creator picked on the parent page (the shorts uploader's
          // "Edit this video"): posted as a File, because the parent's blob: URL
          // is not readable from this origin. Treated like a recording made here,
          // with its own blob URL and the File kept for the render upload.
          const file = data.file instanceof Blob ? data.file : null
          const url = file ? URL.createObjectURL(file) : data.url
          if (url && mediaType) {
            // Track remix source so rendered output posts as a comment under the original short
            if (parentAuthor && parentPermlink) {
              remixSourceRef.current = { parentAuthor, parentPermlink }
            }
            // Clip range: message params override URL params
            const range = {}
            const urlRange = clipRangeRef.current
            if (clipStart != null || urlRange.clipStart != null) {
              range.clipStart = clipStart != null ? clipStart : urlRange.clipStart
            }
            if (clipEnd != null || urlRange.clipEnd != null) {
              range.clipEnd = clipEnd != null ? clipEnd : urlRange.clipEnd
            }
            const added = await addToLibraryAndTimeline(url, name || file?.name || 'Imported Media', mediaType, file ? { ...range, file } : range)
            // The remix picker (stitch / reaction / free edit) is for someone else's
            // video. The creator's own file just goes on the timeline.
            if (added && !file && mediaType === 'video' && range.clipStart == null && range.clipEnd == null) {
              setRemixPrompt(added)
            }
            // Clear URL params after first use so they don't apply to subsequent clips
            clipRangeRef.current = { clipStart: null, clipEnd: null }
          }
          break
        }

        case 'set-theme': {
          const newTheme = data.theme === 'light' ? 'light' : 'dark'
          setTheme(newTheme)
          document.documentElement.setAttribute('data-theme', newTheme)
          break
        }

        case 'set-compact': {
          setCompactMode(data.compact !== false)
          break
        }

        case 'set-desktop': {
          setIsDesktop(data.isDesktop === true)
          break
        }

        case 'toggle-play': {
          onTogglePlayRef.current?.()
          break
        }

        case 'drafts-session': {
          setDraftSession(data.session && typeof data.session.token === 'string' ? data.session : null)
          setDraftContext({ hasMedia: !!data.hasMedia, reason: data.reason || null })
          break
        }

        case 'request-close': {
          setCloseRequest(n => n + 1)
          break
        }

        case 'get-state': {
          sendToParent('state-response', {
            timeline: { tracks, library, playheadPosition }
          })
          break
        }

      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [addToLibraryAndTimeline, tracks, library, playheadPosition, sendToParent])

  // Notify parent that editor is ready
  useEffect(() => {
    if (!isIframe) return
    // `canLoadFile`: load-media takes a `file`. A parent with a local file checks
    // this, since an older editor would ignore the file and open empty.
    // `canSaveDrafts`: the parent may send a drafts session and must ask
    // (request-close) before closing; an older editor gets the plain confirm.
    sendToParent('editor-ready', { canLoadFile: true, canSaveDrafts: true })
  }, [sendToParent])

  // Abort an active render job
  const abortActiveJob = useCallback(() => {
    const job = activeJobRef.current
    if (!job) return

    let abortUrl
    if (GATEWAY_URL && job.backendEndpoint) {
      abortUrl = `${GATEWAY_URL}/api/render/${job.jobId}/abort?backend=${encodeURIComponent(job.backendEndpoint)}`
    } else {
      abortUrl = api(`/api/render/${job.jobId}/abort`)
    }

    fetch(abortUrl, { method: 'POST', keepalive: true }).catch(() => {})

    activeJobRef.current = null
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  // Abort on page close / unmount
  useEffect(() => {
    const onBeforeUnload = () => abortActiveJob()
    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      abortActiveJob()
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
    }
  }, [abortActiveJob])

  /**
   * Upload a local File to the backend, returns the server URL.
   */
  const uploadFile = useCallback(async (file, name) => {
    const formData = new FormData()
    formData.append('file', file, name || file.name)

    const res = await fetch(api('/api/upload'), {
      method: 'POST',
      body: formData
    })

    if (!res.ok) {
      throw new Error(`Upload failed: ${res.status}`)
    }

    const data = await res.json()
    const backendUrl = getBackendUrl()
    if (backendUrl && data.url && data.url.startsWith('/')) {
      return `${backendUrl}${data.url}`
    }
    return data.url
  }, [])

  /**
   * Upload all blob: files and build the timeline payload with server URLs.
   */
  const buildAndUploadPayload = useCallback(async (onProgress) => {
    const fileStore = fileStoreRef?.current
    // Collect clips that have blob: URLs but NO serverUrl (need upload)
    // Clips with a serverUrl already have a backend-accessible path
    const blobClips = []
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clip.url && clip.url.startsWith('blob:') && !clip.serverUrl) {
          const file = fileStore?.get(clip.id) || clip.file
          if (file) {
            blobClips.push({ ...clip, _file: file })
          }
        }
      }
    }

    // Upload blob files, building a map of clipId -> server URL
    const urlOverrides = new Map()

    for (let i = 0; i < blobClips.length; i++) {
      const clip = blobClips[i]
      onProgress(`Uploading ${clip.name || 'file'} (${i + 1}/${blobClips.length})...`)
      const serverUrl = await uploadFile(clip._file, clip.name)
      urlOverrides.set(clip.id, serverUrl)
    }

    // Green screen "static background" clips: their clean plate and its noise
    // map (local PNGs) go up once, the backend keys against them
    const plateUrls = new Map() // clip id -> { plateUrl, noiseUrl } on the server
    const toServer = async (localUrl, name, clip) => {
      if (!localUrl || !/^(blob|data):/.test(localUrl)) return localUrl || null
      let url = uploadedPlatesRef.current.get(localUrl)
      if (!url) {
        onProgress(`Uploading background frame for ${clip.name || 'clip'}...`)
        const blob = await (await fetch(localUrl)).blob()
        url = await uploadFile(blob, name)
        uploadedPlatesRef.current.set(localUrl, url)
      }
      return url
    }
    for (const track of tracks) {
      for (const clip of track.clips) {
        const key = getClipChromaKey(clip)
        if (key?.mode !== 'static' || !key.plateUrl) continue
        plateUrls.set(clip.id, {
          plateUrl: await toServer(key.plateUrl, 'background-plate.png', clip),
          noiseUrl: await toServer(key.noiseUrl, 'background-noise.png', clip)
        })
      }
    }

    // Build the timeline payload with overridden URLs
    // Prefer serverUrl (already on backend, e.g. /rendered/clip-xxx.mp4) over originalUrl (HLS)
    const mediaUrls = []
    // Render what the preview plays: hidden video tracks are not drawn, muted audio tracks and audio clips
    // with their sound off are silent (the backend applies the same rules for other callers).
    const trackData = tracks.filter(track => !(track.type === 'video' && track.visible === false) && !(track.type === 'audio' && track.muted === true)).map(track => ({
      id: track.id,
      type: track.type,
      name: track.name,
      muted: track.muted === true,
      visible: track.visible !== false,
      clips: track.clips.filter(clip => !(track.type === 'audio' && clip.audioEnabled === false)).map(clip => {
        const url = urlOverrides.get(clip.id) || clip.serverUrl || clip.originalUrl || clip.url
        if (url) {
          mediaUrls.push({ id: clip.id, url, type: clip.type })
        }
        const baseClip = {
          id: clip.id,
          type: clip.type,
          url,
          name: clip.name,
          duration: clip.duration,
          startTime: clip.startTime,
          endTime: clip.endTime,
          timelinePosition: clip.timelinePosition || 0,
          zoom: clip.zoom || 100,
          cropX: clip.cropX || 0,
          cropY: clip.cropY || 0,
          cropWidth: clip.cropWidth || 100,
          cropHeight: clip.cropHeight || 100,
          positionX: clip.positionX || 0,
          positionY: clip.positionY || 0,
          rotation: clip.rotation || 0,
          audioEnabled: clip.audioEnabled !== false,
          volume: Number.isFinite(+clip.volume) ? +clip.volume : 100 // 0 is a real setting (silent), not "unset"
        }
        if (hasLayout(clip)) baseClip.layout = clip.layout

        // Colour adjustments (utils/clipColor.js), same maths as the preview
        const color = (clip.type === 'video' || clip.type === 'image') ? normalizeColor(clip.color) : null
        if (color) baseClip.color = color

        // Sticker motion (utils/stickerMotion.js), image and text clips
        const motion = (clip.type === 'image' || clip.type === 'text') ? normalizeMotion(clip.motion) : null
        if (motion) baseClip.motion = motion

        // Green screen: keyed out in the render, over the tracks below
        const key = getClipChromaKey(clip)
        if (key) {
          baseClip.chromaKey = key.mode === 'static'
            ? { color: 'static', similarity: key.similarity, blend: key.blend, spill: key.spill, plateUrl: plateUrls.get(clip.id)?.plateUrl || null, noiseUrl: plateUrls.get(clip.id)?.noiseUrl || null }
            : { color: key.mode, similarity: key.similarity, blend: key.blend, spill: key.spill }
        }

        // Add color-specific properties for color clips
        if (clip.type === 'color') {
          baseClip.backgroundColor = clip.backgroundColor || '#000000'
          baseClip.gradientEnabled = clip.gradientEnabled || false
          baseClip.gradientEndColor = clip.gradientEndColor || '#ffffff'
          baseClip.gradientAngle = clip.gradientAngle ?? 180
        }

        // Add text-specific properties for text clips
        if (clip.type === 'text') {
          baseClip.text = clip.text || 'Text'
          baseClip.fontSize = clip.fontSize || 48
          baseClip.fontFamily = clip.fontFamily || 'Roboto'
          baseClip.fontColor = clip.fontColor || '#ffffff'
          baseClip.fontWeight = clip.fontWeight || 'normal'
          baseClip.textAlign = clip.textAlign || 'center'
          baseClip.textHAlign = clip.textHAlign || 'center'
          baseClip.backgroundColor = clip.backgroundColor || 'transparent'
          // Text background box properties
          baseClip.textBoxEnabled = clip.textBoxEnabled || false
          baseClip.textBoxColor = clip.textBoxColor || '#000000'
          baseClip.textBoxOpacity = clip.textBoxOpacity ?? 80
          baseClip.textBoxPadding = clip.textBoxPadding ?? 12
          baseClip.textBoxRadius = clip.textBoxRadius ?? 8
          baseClip.textBoxBorderColor = clip.textBoxBorderColor || '#ffffff'
          baseClip.textBoxBorderWidth = clip.textBoxBorderWidth ?? 0

          // Measure actual wrapped lines and widths from the preview DOM
          const previewEl = document.querySelector('.preview-layer-container') || document.querySelector('.global-preview-video')
          if (previewEl) {
            const previewWidth = previewEl.clientWidth
            const padding = 20 // matches preview CSS padding
            // Inside a box the text also has to fit within the box's own padding and
            // border, exactly as it wraps in the preview
            const boxInset = baseClip.textBoxEnabled ? baseClip.textBoxPadding + baseClip.textBoxBorderWidth : 0
            const measurer = document.createElement('div')
            measurer.style.cssText = `position:absolute;left:-9999px;top:-9999px;width:${previewWidth - padding * 2 - boxInset * 2}px;font-size:${baseClip.fontSize}px;font-family:'${baseClip.fontFamily}',sans-serif;font-weight:${baseClip.fontWeight};word-break:break-word;white-space:pre-wrap;line-height:1.2`
            measurer.textContent = baseClip.text
            document.body.appendChild(measurer)
            // Use Range API to extract visual lines
            const range = document.createRange()
            const textNode = measurer.firstChild
            if (textNode) {
              const lines = []
              let lastTop = null
              let lineStart = 0
              for (let i = 0; i <= textNode.length; i++) {
                range.setStart(textNode, Math.max(0, i - 1))
                range.setEnd(textNode, i || 1)
                const rect = range.getBoundingClientRect()
                if (lastTop !== null && rect.top > lastTop + 2) {
                  lines.push(baseClip.text.substring(lineStart, i - 1).trim())
                  lineStart = i - 1
                  while (lineStart < textNode.length && baseClip.text[lineStart] === ' ') lineStart++
                }
                lastTop = rect.top
              }
              lines.push(baseClip.text.substring(lineStart).trim())
              baseClip.wrappedLines = lines.filter(l => l.length > 0)

              // Measure each line's pixel width for accurate box sizing
              let maxLineWidth = 0
              const lineMeasurer = document.createElement('span')
              lineMeasurer.style.cssText = `font-size:${baseClip.fontSize}px;font-family:'${baseClip.fontFamily}',sans-serif;font-weight:${baseClip.fontWeight};white-space:nowrap;position:absolute;left:-9999px;top:-9999px`
              document.body.appendChild(lineMeasurer)
              for (const line of baseClip.wrappedLines) {
                lineMeasurer.textContent = line
                maxLineWidth = Math.max(maxLineWidth, lineMeasurer.getBoundingClientRect().width)
              }
              document.body.removeChild(lineMeasurer)
              // Store as ratio of preview width so backend can scale
              baseClip.measuredMaxLineWidth = maxLineWidth
              baseClip.measuredPreviewWidth = previewWidth
            }
            document.body.removeChild(measurer)
          }
        }

        return baseClip
      })
    }))

    // Output dimensions based on aspect ratio
    let outputWidth = 1280
    let outputHeight = 720
    const ratio = activeAspectRatio || '16:9'
    if (ratio === '9:16') {
      outputWidth = 720
      outputHeight = 1280
    } else if (ratio === '4:3') {
      outputWidth = 960
      outputHeight = 720
    } else if (ratio === '1:1') {
      outputWidth = 720
      outputHeight = 720
    }

    // Measure the preview container so backend can scale pixel values
    const previewEl = document.querySelector('.preview-layer-container') || document.querySelector('.global-preview-video')
    const previewWidth = previewEl ? previewEl.clientWidth : outputWidth
    const previewHeight = previewEl ? previewEl.clientHeight : outputHeight

    return {
      timeline: {
        tracks: trackData,
        outputWidth,
        outputHeight,
        previewWidth,
        previewHeight,
        fps: 30
      },
      mediaUrls
    }
  }, [tracks, uploadFile, activeAspectRatio])

  // Poll job status
  const pollJobStatus = useCallback((jobId, backendEndpoint) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)

    pollIntervalRef.current = setInterval(async () => {
      try {
        let pollUrl
        if (GATEWAY_URL && backendEndpoint) {
          pollUrl = `${GATEWAY_URL}/api/render/${jobId}?backend=${encodeURIComponent(backendEndpoint)}`
        } else {
          pollUrl = api(`/api/render/${jobId}`)
        }

        const res = await fetch(pollUrl)
        const data = await res.json()

        if (data.status === 'completed') {
          // Build full URL from the backend that rendered it
          const base = backendEndpoint || window.location.origin
          const fullUrl = new URL(data.outputUrl, base).href
          setRenderStatus({ ...data, outputUrl: fullUrl })
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
          activeJobRef.current = null
          if (isIframe) {
            sendToParent('render-complete', {
              outputUrl: fullUrl,
              ...(remixSourceRef.current && { remixSource: remixSourceRef.current })
            })
          }
        } else if (data.status === 'failed' || data.status === 'aborted') {
          setRenderStatus(data)
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
          activeJobRef.current = null
          if (isIframe) {
            sendToParent('render-failed', { error: data.error })
          }
        } else {
          setRenderStatus(data)
        }
      } catch (err) {
        console.error('[useIframeApi] Poll error:', err)
      }
    }, 1500)
  }, [sendToParent])

  // Submit render job to backend (or gateway if configured)
  const requestRender = useCallback(async () => {
    try {
      setRenderStatus({ status: 'submitting', progress: 0, phase: 'Preparing files...' })

      const payload = await buildAndUploadPayload((phase) => {
        setRenderStatus(prev => ({ ...prev, phase }))
      })

      setRenderStatus({ status: 'submitting', progress: 0, phase: 'Submitting render job...' })

      const renderUrl = GATEWAY_URL ? `${GATEWAY_URL}/api/render` : api('/api/render')
      const res = await fetch(renderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || `Server responded with ${res.status}`)
      }

      const { jobId, backendEndpoint } = await res.json()
      activeJobRef.current = { jobId, backendEndpoint }
      setRenderStatus({ jobId, status: 'processing', progress: 0, phase: 'Starting...' })
      pollJobStatus(jobId, backendEndpoint)
    } catch (err) {
      console.error('[useIframeApi] Render request failed:', err)
      setRenderStatus({ status: 'failed', error: err.message, progress: 0 })
      if (isIframe) {
        sendToParent('render-failed', { error: err.message })
      }
    }
  }, [buildAndUploadPayload, pollJobStatus, sendToParent])

  const clearRenderStatus = useCallback(() => {
    setRenderStatus(null)
  }, [])

  const clearRemixPrompt = useCallback(() => setRemixPrompt(null), [])

  const requestClose = useCallback(() => {
    sendToParent('editor-closed')
  }, [sendToParent])

  // Answer to request-close: close the studio, or stay
  const answerClose = useCallback((close) => {
    sendToParent('close-decision', { close: !!close })
  }, [sendToParent])

  // Ask the parent to sign the user in for drafts (one signature for wallet
  // logins); 'signing-in' until its drafts-session answer arrives
  const requestDraftSignIn = useCallback(() => {
    setDraftContext(c => ({ ...c, reason: 'signing-in' }))
    sendToParent('drafts-sign-in')
  }, [sendToParent])

  return {
    isIframe,
    compactMode,
    isDesktop,
    theme,
    requestRender,
    requestClose,
    sendToParent,
    renderStatus,
    clearRenderStatus,
    remixSource: remixSourceRef.current,
    remixPrompt,
    clearRemixPrompt,
    draftSession,
    draftContext,
    closeRequest,
    answerClose,
    requestDraftSignIn
  }
}
