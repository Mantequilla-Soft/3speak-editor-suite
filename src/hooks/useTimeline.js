import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { isHlsUrl, getHlsDuration } from '../utils/hlsHelper'
import { downloadHlsToMp4 } from '../utils/hlsDownloader'
import { api, getBackendUrl } from '../utils/backendSelector'
import { MAX_TIMELINE_SECONDS, MAX_IMPORT_BYTES, getTimelineEnd } from '../utils/limits'
import { createSHA256 } from 'hash-wasm'

// Upload requests (whole small files or chunks of big ones) in flight at once,
// shared by every upload; the rest wait for a free slot. Kept under the
// browser's 6 connections per host (the API is HTTP/1.1).
const MAX_PARALLEL_REQUESTS = 4
let activeRequests = 0
const requestQueue = []
function withUploadSlot(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeRequests++
      task().then(resolve, reject).finally(() => {
        activeRequests--
        const next = requestQueue.shift()
        if (next) next()
      })
    }
    if (activeRequests < MAX_PARALLEL_REQUESTS) run()
    else requestQueue.push(run)
  })
}

// Files above this go up in chunks (size set by the backend), several at once
const CHUNKED_FROM_BYTES = 8 * 1024 * 1024
const CHUNK_ATTEMPTS = 4

// One XHR (for upload progress). Resolves the JSON answer; rejects with .status set.
function sendXhr(method, url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url)
    if (body instanceof Blob && !(body instanceof File)) xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total)
      })
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)) } catch { reject(new Error('Invalid response from server')) }
      } else {
        const err = new Error(`Upload failed: ${xhr.status}`)
        err.status = xhr.status
        reject(err)
      }
    }
    xhr.onerror = () => reject(new Error('Upload network error'))
    xhr.send(body)
  })
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  return res.json()
}

// SHA-256 of a file, read in pieces so a big file never sits in memory whole
// (crypto.subtle cannot hash in pieces). About a second per few hundred MB.
async function hashFile(file) {
  const hasher = await createSHA256()
  const piece = 8 * 1024 * 1024
  for (let offset = 0; offset < file.size; offset += piece) {
    hasher.update(new Uint8Array(await file.slice(offset, offset + piece).arrayBuffer()))
  }
  return hasher.digest('hex')
}

// Send a big file as chunks in parallel (retrying each a few times), then
// have the backend join them. Resolves what POST /api/upload would answer.
async function uploadInChunks(file, name, onProgress, hash) {
  const { uploadId, chunkSize, chunks } = await postJson(api('/api/upload/chunked/init'), { name, size: file.size, hash })
  const sent = new Array(chunks).fill(0)
  const report = () => onProgress?.(sent.reduce((a, b) => a + b, 0) / file.size)
  let failed = false

  const sendChunk = async (index) => {
    const blob = file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize))
    for (let attempt = 1; ; attempt++) {
      if (failed) return
      try {
        await withUploadSlot(() => (failed
          ? Promise.resolve()
          : sendXhr('PUT', api(`/api/upload/chunked/${uploadId}/${index}`), blob, (f) => { sent[index] = f * blob.size; report() })))
        sent[index] = blob.size
        report()
        return
      } catch (err) {
        sent[index] = 0
        report()
        // 4xx means the chunk itself is wrong; retrying will not help
        if (attempt >= CHUNK_ATTEMPTS || (err.status >= 400 && err.status < 500)) {
          failed = true
          throw err
        }
        await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)))
      }
    }
  }

  await Promise.all(Array.from({ length: chunks }, (_, i) => sendChunk(i)))
  return postJson(api(`/api/upload/chunked/${uploadId}/complete`), {})
}

let clipIdCounter = 0
let trackIdCounter = 0
let libraryIdCounter = 0
let groupIdCounter = 0

function generateClipId() {
  return `clip_${++clipIdCounter}_${Date.now()}`
}

function generateTrackId() {
  return `track_${++trackIdCounter}_${Date.now()}`
}

function generateLibraryId() {
  return `lib_${++libraryIdCounter}_${Date.now()}`
}

function generateGroupId() {
  return `group_${++groupIdCounter}_${Date.now()}`
}

// Deterministic group colors based on groupId hash
const GROUP_COLORS = [
  '#4a9eff', '#ff6b6b', '#51cf66', '#fcc419', '#cc5de8',
  '#ff922b', '#20c997', '#f06595', '#748ffc', '#63e6be'
]

function getGroupColor(groupId) {
  if (!groupId) return null
  const hash = groupId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return GROUP_COLORS[hash % GROUP_COLORS.length]
}

const MAX_HISTORY = 20

// Duration, and whether this browser can show the picture: HEVC (iPhone) or
// 10-bit video loads in some browsers with sound but no image (or not at all).
function probeMedia(file) {
  const type = getMediaType(file)
  if (type === 'image') return Promise.resolve({ duration: 5, durationKnown: true, playable: true })
  return new Promise((resolve) => {
    const el = document.createElement(type === 'video' ? 'video' : 'audio')
    el.preload = 'auto'
    el.muted = true
    const src = URL.createObjectURL(file)
    let duration = null
    let settled = false
    const finish = (playable) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      el.removeAttribute('src')
      el.load()
      URL.revokeObjectURL(src)
      resolve({ duration: duration ?? 10, durationKnown: duration != null, playable })
    }
    const timer = setTimeout(() => finish(type !== 'video' && duration != null), 8000)
    el.onloadedmetadata = () => {
      duration = el.duration
      if (type !== 'video') finish(true)
    }
    el.onloadeddata = () => finish(el.videoWidth > 0)
    el.onerror = () => finish(false)
    el.src = src
  })
}

function getMediaType(file) {
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('image/')) return 'image'
  return null
}

// Calculate the furthest end point across all tracks (the timeline extent)
function getTimelineExtent(tracks) {
  let maxEnd = 0
  for (const track of tracks) {
    for (const clip of track.clips) {
      const clipEnd = (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
      maxEnd = Math.max(maxEnd, clipEnd)
    }
  }
  return maxEnd
}

// Returns { duration, videoWidth, videoHeight }
function getMediaMetadataFromURL(url, mediaType) {
  if (mediaType === 'image') {
    return Promise.resolve({ duration: 5, videoWidth: 0, videoHeight: 0 })
  }

  // Use HLS.js for .m3u8 streams - get duration, then probe dimensions separately
  if (isHlsUrl(url)) {
    return getHlsDuration(url).then(duration => {
      // Probe HLS video dimensions via a hidden video element
      return new Promise((resolve) => {
        const video = document.createElement('video')
        video.preload = 'auto'
        video.crossOrigin = 'anonymous'
        video.muted = true
        let resolved = false

        const finish = (w, h, hls) => {
          if (resolved) return
          resolved = true
          if (hls) hls.destroy()
          resolve({ duration, videoWidth: w, videoHeight: h })
        }

        // Use HLS.js to load the stream for dimension probing
        import('hls.js').then(({ default: Hls }) => {
          if (Hls.isSupported()) {
            const hls = new Hls()
            hls.loadSource(url)
            hls.attachMedia(video)

            // Use loadeddata (not loadedmetadata) so video frames are decoded and dimensions available
            video.onloadeddata = () => {
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                finish(video.videoWidth, video.videoHeight, hls)
              }
            }

            // Also check on canplay as a fallback
            video.oncanplay = () => {
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                finish(video.videoWidth, video.videoHeight, hls)
              }
            }

            hls.on(Hls.Events.ERROR, (_, data) => {
              if (data.fatal) finish(0, 0, hls)
            })

            // Timeout fallback
            setTimeout(() => {
              finish(video.videoWidth || 0, video.videoHeight || 0, hls)
            }, 8000)
          } else {
            finish(0, 0, null)
          }
        }).catch(() => finish(0, 0, null))
      })
    })
  }

  return new Promise((resolve) => {
    const element = document.createElement(mediaType === 'audio' ? 'audio' : 'video')
    element.preload = 'metadata'
    element.crossOrigin = 'anonymous'
    element.onloadedmetadata = () => {
      resolve({
        duration: element.duration,
        videoWidth: element.videoWidth || 0,
        videoHeight: element.videoHeight || 0
      })
    }
    element.onerror = () => {
      resolve({ duration: 10, videoWidth: 0, videoHeight: 0 })
    }
    element.src = url
  })
}

// Find the paired audio track for a video track.
// Video tracks are prepended (newest first), audio tracks are appended (oldest first),
// so we use mirror indexing: videoTracks[i] pairs with audioTracks[last - i].
function findPairedAudioTrack(tracks, videoTrackId) {
  // Sticker tracks carry no sound: they never pair with an audio track
  const videoTracks = tracks.filter(t => t.type === 'video' && !t.stickers)
  // Music tracks (music library) never pair with a video track
  const audioTracks = tracks.filter(t => t.type === 'audio' && !t.music)
  const videoIndex = videoTracks.findIndex(t => t.id === videoTrackId)
  if (videoIndex === -1) return null
  const audioIndex = videoTracks.length - 1 - videoIndex
  return audioTracks[audioIndex] || null
}

// Create an audio clip from a video clip (same source, timing, position)
// Shares the same groupId so they are treated as a linked pair
function createLinkedAudioClip(videoClip, groupId) {
  return {
    id: generateClipId(),
    file: videoClip.file,
    url: videoClip.url,
    serverUrl: videoClip.serverUrl || null,
    name: videoClip.name + ' (Audio)',
    duration: videoClip.duration,
    startTime: videoClip.startTime,
    endTime: videoClip.endTime,
    timelinePosition: videoClip.timelinePosition,
    audioEnabled: true,
    type: 'audio',
    libraryId: videoClip.libraryId,
    sourceVideoClipId: videoClip.id,
    groupId: groupId || videoClip.groupId || null,
    zoom: 100,
    cropX: 0,
    cropY: 0,
    cropWidth: 100,
    cropHeight: 100,
    positionX: 0,
    positionY: 0,
    volume: videoClip.volume || 100
  }
}

// Ensure there's a paired audio track for every video track
function ensurePairedAudioTracks(tracks) {
  const videoTracks = tracks.filter(t => t.type === 'video' && !t.stickers)
  const audioTracks = tracks.filter(t => t.type === 'audio' && !t.music)

  if (audioTracks.length >= videoTracks.length) return tracks

  const newAudioTracks = []
  for (let i = audioTracks.length; i < videoTracks.length; i++) {
    newAudioTracks.push({
      id: generateTrackId(),
      type: 'audio',
      name: `Audio ${i + 1}`,
      clips: []
    })
  }

  return [...tracks, ...newAudioTracks]
}

export { getGroupColor }

export function useTimeline() {
  // Library: array of { id, file, url, name, duration, type }
  const [library, setLibrary] = useState([])

  // Tracks: array of { id, type: 'video' | 'audio', clips: [] }
  const [tracks, setTracks] = useState([
    { id: generateTrackId(), type: 'video', name: 'Video 1', clips: [] },
    { id: generateTrackId(), type: 'audio', name: 'Audio 1', clips: [] }
  ])
  const [selectedClipId, setSelectedClipId] = useState(null)
  const [selectedLibraryId, setSelectedLibraryId] = useState(null)

  // Set when an import lands on the timeline; the effect below then tells the
  // creator once if the timeline now runs past the render limit.
  const lengthCheckRef = useRef(false)
  // Files refused at import (over MAX_IMPORT_BYTES), for the notice
  const [rejectedFiles, setRejectedFiles] = useState([])
  const dismissRejectedFiles = useCallback(() => setRejectedFiles([]), [])
  const keepImportable = useCallback((files) => {
    const list = Array.from(files)
    const tooBig = list.filter(f => f.size > MAX_IMPORT_BYTES)
    if (tooBig.length) setRejectedFiles(prev => [...prev, ...tooBig.map(f => ({ name: f.name, size: f.size }))])
    return list.filter(f => f.size <= MAX_IMPORT_BYTES)
  }, [])
  const [lengthNotice, setLengthNotice] = useState(null) // { length } in seconds
  const dismissLengthNotice = useCallback(() => setLengthNotice(null), [])
  useEffect(() => {
    if (!lengthCheckRef.current) return
    lengthCheckRef.current = false
    const length = getTimelineEnd(tracks)
    if (length > MAX_TIMELINE_SECONDS + 0.01) setLengthNotice({ length })
  }, [tracks])
  const [playheadPosition, setPlayheadPosition] = useState(0)

  // File store: keeps File references separate from serialized track history
  // Map<clipId, File> — survives JSON.parse(JSON.stringify()) in undo/redo
  const fileStoreRef = useRef(new Map())

  // Undo/Redo history
  const historyRef = useRef([])
  const historyIndexRef = useRef(-1)
  const isUndoRedoRef = useRef(false)

  // Save state to history
  const saveToHistory = useCallback((newTracks) => {
    if (isUndoRedoRef.current) {
      isUndoRedoRef.current = false
      return
    }
    // Remove any future history if we're not at the end
    const newHistory = historyRef.current.slice(0, historyIndexRef.current + 1)
    newHistory.push(JSON.parse(JSON.stringify(newTracks)))
    // Limit history size
    if (newHistory.length > MAX_HISTORY) {
      newHistory.shift()
    } else {
      historyIndexRef.current++
    }
    historyRef.current = newHistory
  }, [])

  // Wrapper for setTracks that saves to history
  const setTracksWithHistory = useCallback((updater) => {
    setTracks(prev => {
      const newTracks = typeof updater === 'function' ? updater(prev) : updater
      saveToHistory(newTracks)
      return newTracks
    })
  }, [saveToHistory])

  // Undo action
  const undo = useCallback(() => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--
      isUndoRedoRef.current = true
      const prevState = historyRef.current[historyIndexRef.current]
      setTracks(JSON.parse(JSON.stringify(prevState)))
    }
  }, [])

  // Redo action
  const redo = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++
      isUndoRedoRef.current = true
      const nextState = historyRef.current[historyIndexRef.current]
      setTracks(JSON.parse(JSON.stringify(nextState)))
    }
  }, [])

  // Check if undo/redo are available
  const canUndo = historyIndexRef.current > 0
  const canRedo = historyIndexRef.current < historyRef.current.length - 1

  // Find clip by ID across all tracks
  const findClip = useCallback((clipId) => {
    for (const track of tracks) {
      const clip = track.clips.find(c => c.id === clipId)
      if (clip) return { clip, track }
    }
    return { clip: null, track: null }
  }, [tracks])

  const selectedClip = selectedClipId ? findClip(selectedClipId).clip : null
  const selectedLibraryItem = library.find(item => item.id === selectedLibraryId)

  // Upload a file to the backend, returns server URL (e.g. /api/upload/files/abc.mp4)
  // When using a remote backend, makes the returned URL absolute
  // onProgress(0..1) is called during upload
  // Upload a file for the backend (480p encode, rendering). The file is hashed
  // first: if the backend already has it, nothing is sent at all (and an HEVC
  // file's converted copy comes along). Otherwise small files go in one
  // request, big ones in parallel chunks. Resolves
  // { url (absolute), filename, duration, browserSafe, encodes, reused?, encodeState? }.
  const uploadFileToServer = useCallback(async (file, name, onProgress) => {
    let data = null
    let hash = null
    try {
      hash = await hashFile(file)
      const res = await fetch(api(`/api/upload/by-hash/${hash}`), { cache: 'no-store' })
      if (res.ok) {
        data = await res.json()
        console.log(`[upload] ${file.name} already on the server, upload skipped (${data.encodeState})`)
        onProgress?.(1)
      }
    } catch (err) {
      console.warn(`[upload] Hash check skipped for ${file.name}: ${err.message}`)
    }
    if (!data && file.size > CHUNKED_FROM_BYTES) {
      data = await uploadInChunks(file, name || file.name, onProgress, hash)
    } else if (!data) {
      const formData = new FormData()
      formData.append('file', file, name || file.name)
      const query = hash ? `?hash=${hash}` : ''
      data = await withUploadSlot(() => sendXhr('POST', api(`/api/upload${query}`), formData, onProgress))
    }
    const backendUrl = getBackendUrl()
    const url = backendUrl && data.url && data.url.startsWith('/') ? `${backendUrl}${data.url}` : data.url
    return { ...data, url }
  }, [])

  // Show the backend's 480p H.264 copy instead of a local file this browser
  // cannot decode (HEVC, 10-bit). The undo history is patched too, so undo
  // never brings the black preview back. Not an undo step itself.
  const switchToPlayableCopy = useCallback((libraryId, url) => {
    const patch = (list) => list.map(t => ({
      ...t,
      clips: t.clips.map(c => (c.libraryId === libraryId ? { ...c, url, serverUrl: url } : c))
    }))
    historyRef.current = historyRef.current.map(patch)
    setTracks(prev => patch(prev))
    setLibrary(prev => prev.map(i => (i.id === libraryId ? { ...i, url, serverUrl: url, converting: false } : i)))
  }, [])

  // After an upload: take the backend's duration when the browser could not
  // read it, and for footage the browser cannot show, wait for the 480p copy
  // and switch the preview to it.
  const afterUpload = useCallback(async (libraryId, probe, info) => {
    if (!probe.durationKnown && info.duration) {
      const fix = (list) => list.map(t => ({
        ...t,
        clips: t.clips.map(c => (c.libraryId === libraryId && c.startTime === 0 && c.endTime === probe.duration
          ? { ...c, duration: info.duration, endTime: info.duration }
          : c))
      }))
      historyRef.current = historyRef.current.map(fix)
      setTracks(prev => fix(prev))
      setLibrary(prev => prev.map(i => (i.id === libraryId ? { ...i, duration: info.duration } : i)))
    }
    if (probe.playable || !info.encodes) return

    // Uploaded before and already converted: use that copy right away
    if (info.encodeState === 'done') {
      switchToPlayableCopy(libraryId, `${info.url}?v=480p`)
      return
    }

    setLibrary(prev => prev.map(i => (i.id === libraryId ? { ...i, converting: true } : i)))
    const deadline = Date.now() + Math.max(10 * 60, (info.duration || 0) * 4) * 1000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000))
      let state = 'unknown'
      try {
        const res = await fetch(api(`/api/upload/status/${encodeURIComponent(info.filename)}`), { cache: 'no-store' })
        const status = await res.json()
        state = status.state
        // For the "making it playable" popup
        setLibrary(prev => prev.map(i => (i.id === libraryId
          ? { ...i, convertProgress: status.progress ?? null, convertAhead: state === 'queued' ? status.ahead : 0 }
          : i)))
      } catch { state = 'retry' }
      if (state === 'done') {
        // New URL so no cached copy of the original is reused
        switchToPlayableCopy(libraryId, `${info.url}?v=480p`)
        return
      }
      if (state === 'failed' || state === 'unknown') break
    }
    console.warn(`[upload] No playable 480p copy for ${info.filename}`)
    setLibrary(prev => prev.map(i => (i.id === libraryId ? { ...i, converting: false, convertFailed: true } : i)))
  }, [switchToPlayableCopy])

  // Update a library item's serverUrl and all timeline clips that reference it.
  // Does NOT change clip.url (keeps the local blob URL for preview).
  const applyServerUrl = useCallback((libraryId, serverUrl) => {
    console.log(`[applyServerUrl] libraryId=${libraryId}, serverUrl=${serverUrl}`)
    setLibrary(prev => prev.map(item =>
      item.id === libraryId ? { ...item, serverUrl } : item
    ))
    // Set serverUrl on all clips that reference this library item (preview keeps
    // blob URL). Uploads finish in the background while the creator edits, so
    // this is not an undo step: the history snapshots get it too, and undo
    // never takes a finished upload away.
    const patch = (list) => list.map(track => ({
      ...track,
      clips: track.clips.map(clip => (clip.libraryId === libraryId && !clip.serverUrl ? { ...clip, serverUrl } : clip))
    }))
    historyRef.current = historyRef.current.map(patch)
    setTracks(prev => patch(prev))
  }, [])

  // Add files to library — uploads to backend for 480p encoding first, then makes available
  // A song on an empty timeline defaults to the render limit (utils/limits.js)
  const MAX_DURATION = MAX_TIMELINE_SECONDS
  const addToLibrary = useCallback(async (files) => {
    // Every file shows up in the library right away (durations read in
    // parallel); the uploads then share the parallel upload slots
    const media = keepImportable(files).filter(f => getMediaType(f))
    const probes = await Promise.all(media.map(f => probeMedia(f)))
    media.forEach(async (file, index) => {
      const type = getMediaType(file)
      const probe = probes[index]
      const duration = probe.duration

      const blobUrl = URL.createObjectURL(file)
      const itemId = generateLibraryId()

      // Add to library immediately with uploading state (preview uses blob URL)
      const newItem = {
        id: itemId,
        file,
        url: blobUrl,
        name: file.name,
        duration,
        type,
        uploading: true,
        // This browser cannot show it: it has to be uploaded and converted first
        needsConversion: type === 'video' && !probe.playable
      }
      setLibrary(prev => [...prev, newItem])

      // Upload video/audio to backend for 480p encoding
      if (type === 'video' || type === 'audio') {
        try {
          console.log(`[addToLibrary] Starting upload for ${file.name} (itemId=${itemId})`)
          const info = await uploadFileToServer(file, file.name, (p) => {
            setLibrary(prev => prev.map(i =>
              i.id === itemId ? { ...i, uploadProgress: p } : i
            ))
          })
          const serverUrl = info.url
          console.log(`[addToLibrary] Upload complete: ${file.name} -> ${serverUrl}`)
          // Store server URL but keep blob URL for preview
          setLibrary(prev => prev.map(i =>
            i.id === itemId ? { ...i, serverUrl, uploading: false, uploadProgress: 1 } : i
          ))
          // Clips already placed from the library while it uploaded
          applyServerUrl(itemId, serverUrl)
          afterUpload(itemId, probe, info)
        } catch (err) {
          console.warn(`[upload] Upload failed for ${file.name}:`, err.message)
          setLibrary(prev => prev.map(i =>
            i.id === itemId ? { ...i, uploading: false, uploadError: err.message } : i
          ))
        }
      } else {
        // Images don't need encoding — mark as ready immediately
        setLibrary(prev => prev.map(i =>
          i.id === itemId ? { ...i, uploading: false } : i
        ))
      }
    })
  }, [uploadFileToServer, afterUpload, applyServerUrl, keepImportable])

  // Remove from library
  const removeFromLibrary = useCallback((itemId) => {
    setLibrary(prev => {
      const item = prev.find(i => i.id === itemId)
      if (item) {
        URL.revokeObjectURL(item.url)
      }
      return prev.filter(i => i.id !== itemId)
    })
    setSelectedLibraryId(prev => prev === itemId ? null : prev)
  }, [])

  // Add media from URL to library (no File object needed)
  const addToLibraryFromURL = useCallback(async (url, name, mediaType) => {
    if (!mediaType || !['video', 'audio', 'image'].includes(mediaType)) return null

    const meta = await getMediaMetadataFromURL(url, mediaType)
    const item = {
      id: generateLibraryId(),
      file: null,
      url,
      name: name || 'Imported Media',
      duration: meta.duration,
      type: mediaType,
      videoWidth: meta.videoWidth,
      videoHeight: meta.videoHeight
    }

    setLibrary(prev => [...prev, item])
    return item
  }, [])

  // Music library: the song goes on its own "Music" track (never paired with a
  // video track), from 0:00, cut to the length of the video content, at half
  // volume so voices stay on top. `credit` rides along into the post.
  const addMusicClip = useCallback(async (url, name, credit, bpm = null) => {
    const meta = await getMediaMetadataFromURL(url, 'audio')
    const duration = meta.duration
    if (!duration) return null
    const libraryId = generateLibraryId()
    setLibrary(prev => [...prev, { id: libraryId, file: null, url, name, duration, type: 'audio', credit: credit || null }])
    const clipId = generateClipId()

    setTracksWithHistory(prev => {
      let contentEnd = 0
      for (const t of prev) {
        if (t.type !== 'video') continue
        for (const c of t.clips) {
          contentEnd = Math.max(contentEnd, (c.timelinePosition || 0) + (c.endTime - c.startTime))
        }
      }
      const length = Math.min(duration, contentEnd > 0 ? contentEnd : MAX_DURATION)
      const clip = {
        id: clipId,
        file: null,
        url,
        serverUrl: null,
        name,
        duration,
        startTime: 0,
        endTime: length,
        timelinePosition: 0,
        audioEnabled: true,
        type: 'audio',
        libraryId,
        groupId: null,
        zoom: 100,
        cropX: 0,
        cropY: 0,
        cropWidth: 100,
        cropHeight: 100,
        positionX: 0,
        positionY: 0,
        volume: 50,
        // The library's tempo, a hint for Beat sync
        ...(bpm ? { bpm } : {}),
        ...(credit ? { credit } : {})
      }
      // Reuse an empty music track, else add one below the others
      const free = prev.find(t => t.type === 'audio' && t.music && t.clips.length === 0)
      if (free) {
        return prev.map(t => (t.id === free.id ? { ...t, clips: [clip] } : t))
      }
      const musicCount = prev.filter(t => t.type === 'audio' && t.music).length
      return [...prev, {
        id: generateTrackId(),
        type: 'audio',
        name: musicCount ? `Music ${musicCount + 1}` : 'Music',
        music: true,
        clips: [clip]
      }]
    })
    return clipId
  }, [setTracksWithHistory])

  /**
   * Open a saved project (useDrafts): its tracks and library replace the
   * current ones, with a fresh undo history (undo must not go back to the
   * empty editor the project was opened into).
   */
  const loadProjectState = useCallback((state) => {
    const nextTracks = Array.isArray(state?.tracks) && state.tracks.length
      ? state.tracks
      : [{ id: generateTrackId(), type: 'video', name: 'Video 1', clips: [] }, { id: generateTrackId(), type: 'audio', name: 'Audio 1', clips: [] }]
    historyRef.current = [JSON.parse(JSON.stringify(nextTracks))]
    historyIndexRef.current = 0
    setTracks(nextTracks)
    setLibrary(Array.isArray(state?.library) ? state.library : [])
    setSelectedClipId(null)
  }, [])

  /**
   * Beat sync: lay the clips of the first video track (in order) on the beat,
   * each `every` beats long, starting on the first beat. `beats` are timeline
   * seconds; past the last one the grid goes on at the same tempo. A video
   * shorter than its slot keeps its length and the next clip starts on the
   * following beat. Linked audio moves and trims with its video. One undo step.
   */
  const fitClipsToBeats = useCallback((beats, every = 1) => {
    if (!beats || beats.length < 2) return
    const period = (beats[beats.length - 1] - beats[0]) / (beats.length - 1)
    const beatAt = (i) => (i < beats.length ? beats[i] : beats[beats.length - 1] + (i - beats.length + 1) * period)
    setTracksWithHistory(prev => {
      const track = prev.find(t => t.type === 'video' && t.clips.length)
      if (!track) return prev
      const ordered = [...track.clips].sort((a, b) => (a.timelinePosition || 0) - (b.timelinePosition || 0))
      const changes = new Map() // clip id -> { timelinePosition, endTime }
      let beat = 0
      for (const clip of ordered) {
        const start = beatAt(beat)
        const slot = beatAt(beat + every) - start
        const isMedia = clip.type === 'video' || clip.type === 'audio'
        const available = isMedia ? Math.max(0.1, (clip.duration || clip.endTime) - clip.startTime) : Infinity
        let length = Math.min(slot, available)
        // Shorter than its slot: next clip on the beat after this one ends
        let used = every
        if (length < slot) {
          used = 1
          while (beatAt(beat + used) - start < length - 0.01) used++
        }
        changes.set(clip.id, { timelinePosition: start, endTime: clip.startTime + length, groupId: clip.groupId })
        beat += used
      }
      return prev.map(t => ({
        ...t,
        clips: t.clips.map(c => {
          const own = changes.get(c.id)
          if (own) return { ...c, timelinePosition: own.timelinePosition, endTime: own.endTime }
          // Linked audio of a moved video: same place, same length
          const twin = c.groupId ? [...changes.entries()].find(([, v]) => v.groupId === c.groupId) : null
          if (twin) {
            const v = ordered.find(o => o.id === twin[0])
            return { ...c, timelinePosition: twin[1].timelinePosition, endTime: c.startTime + (twin[1].endTime - v.startTime) }
          }
          return c
        })
      }))
    })
  }, [setTracksWithHistory])

  /**
   * A sticker at `position` (the playhead) on a "Stickers" video track above
   * the footage: the first one with room there, else a new one on top.
   * `sticker` is either { kind: 'image', url, name, zoom } (emoji, badge,
   * shape, logo: an image clip) or { kind: 'text', name, text, props } (a
   * pre-styled text box: an ordinary, editable text clip). Returns the clip id.
   */
  const addStickerClip = useCallback((sticker, position, length = 3) => {
    const clipId = generateClipId()
    const start = Math.max(0, position || 0)
    const end = start + length
    const base = {
      id: clipId, startTime: 0, endTime: length, duration: length, timelinePosition: start,
      audioEnabled: false, zoom: 100, positionX: 0, positionY: 0, cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100,
      sticker: true
    }
    const clip = sticker.kind === 'text'
      ? { ...base, type: 'text', name: sticker.name, text: sticker.text, textAlign: 'center', backgroundColor: 'transparent', ...sticker.props }
      : { ...base, type: 'image', name: sticker.name, url: sticker.url, serverUrl: null, file: null, zoom: sticker.zoom || 40 }
    setTracksWithHistory(prev => {
      const fits = (t) => t.clips.every(c => {
        const cs = c.timelinePosition || 0
        return cs + (c.endTime - c.startTime) <= start + 0.001 || cs >= end - 0.001
      })
      const free = prev.find(t => t.type === 'video' && t.stickers && fits(t))
      if (free) return prev.map(t => (t.id === free.id ? { ...t, clips: [...t.clips, clip] } : t))
      const count = prev.filter(t => t.type === 'video' && t.stickers).length
      // Track 0 draws on top: stickers go above everything
      return [{ id: generateTrackId(), type: 'video', name: count ? `Stickers ${count + 1}` : 'Stickers', stickers: true, clips: [clip] }, ...prev]
    })
    return clipId
  }, [setTracksWithHistory])

  /**
   * A sound effect at `position` (the playhead), full length, on an "SFX"
   * audio track: the first one with room there, else a new one.
   */
  const addSfxClip = useCallback(async (url, name, position) => {
    const meta = await getMediaMetadataFromURL(url, 'audio')
    const duration = meta.duration
    if (!duration) return null
    const libraryId = generateLibraryId()
    setLibrary(prev => [...prev, { id: libraryId, file: null, url, name, duration, type: 'audio' }])
    const clipId = generateClipId()
    const start = Math.max(0, position || 0)
    const end = start + duration

    setTracksWithHistory(prev => {
      const clip = {
        id: clipId, file: null, url, serverUrl: null, name, duration,
        startTime: 0, endTime: duration, timelinePosition: start,
        audioEnabled: true, type: 'audio', libraryId, groupId: null,
        zoom: 100, cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100, positionX: 0, positionY: 0,
        volume: 100
      }
      const fits = (t) => t.clips.every(c => {
        const cs = c.timelinePosition || 0
        return cs + (c.endTime - c.startTime) <= start + 0.001 || cs >= end - 0.001
      })
      const free = prev.find(t => t.type === 'audio' && t.sfx && fits(t))
      if (free) return prev.map(t => (t.id === free.id ? { ...t, clips: [...t.clips, clip] } : t))
      const count = prev.filter(t => t.type === 'audio' && t.sfx).length
      return [...prev, { id: generateTrackId(), type: 'audio', name: count ? `SFX ${count + 1}` : 'SFX', sfx: true, clips: [clip] }]
    })
    return clipId
  }, [setTracksWithHistory])

  // Add media from URL to library AND place on timeline
  // options: { clipStart?: number, clipEnd?: number } — optional trim range
  const addToLibraryAndTimeline = useCallback(async (url, name, mediaType, options = {}) => {
    if (!mediaType || !['video', 'audio', 'image'].includes(mediaType)) return
    if (options.file && !keepImportable([options.file]).length) return

    const meta = await getMediaMetadataFromURL(url, mediaType)
    const duration = meta.duration
    const libraryId = generateLibraryId()
    const item = {
      id: libraryId,
      file: options.file || null,
      url,
      name: name || 'Imported Media',
      duration,
      type: mediaType,
      videoWidth: meta.videoWidth,
      videoHeight: meta.videoHeight,
      clipStart: options.clipStart != null ? options.clipStart : null,
      clipEnd: options.clipEnd != null ? options.clipEnd : null,
      // Music library tracks carry their credit (and 3speak sound owner) into the post
      credit: options.credit || null
    }

    setLibrary(prev => [...prev, item])

    // Apply clip range trimming if provided
    let clipStart = 0
    let clipEnd = duration
    if (options.clipStart != null && options.clipStart >= 0 && options.clipStart < duration) {
      clipStart = options.clipStart
    }
    if (options.clipEnd != null && options.clipEnd > clipStart && options.clipEnd <= duration) {
      clipEnd = options.clipEnd
    }

    const targetTrackType = mediaType === 'audio' ? 'audio' : 'video'
    const newClipId = generateClipId()

    lengthCheckRef.current = true
    setTracksWithHistory(prev => {
      const targetTrack = prev.find(t => t.type === targetTrackType)
      if (!targetTrack) return prev

      // Place at the end of existing clips on this track
      let timelinePosition = 0
      for (const clip of targetTrack.clips) {
        const clipEnd2 = (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
        timelinePosition = Math.max(timelinePosition, clipEnd2)
      }

      // Generate a groupId for video+audio pairs
      const groupId = mediaType === 'video' ? generateGroupId() : null

      const newClip = {
        id: newClipId,
        file: null,
        url,
        serverUrl: options.serverUrl || null,
        name: item.name,
        duration,
        startTime: clipStart,
        endTime: clipEnd,
        timelinePosition,
        audioEnabled: mediaType === 'video' ? false : true,
        type: mediaType,
        libraryId,
        groupId,
        videoWidth: meta.videoWidth,
        videoHeight: meta.videoHeight,
        zoom: 100,
        cropX: 0,
        cropY: 0,
        cropWidth: 100,
        cropHeight: 100,
        positionX: 0,
        positionY: 0,
        volume: 100,
        ...(options.credit ? { credit: options.credit } : {})
      }

      // Store File reference if available
      if (item.file) {
        fileStoreRef.current.set(newClip.id, item.file)
      }

      let updatedTracks = prev.map(track => {
        if (track.id === targetTrack.id) {
          return { ...track, clips: [...track.clips, newClip] }
        }
        return track
      })

      // Auto-create audio clip for video clips on the paired audio track
      if (mediaType === 'video') {
        updatedTracks = ensurePairedAudioTracks(updatedTracks)
        const pairedAudioTrack = findPairedAudioTrack(updatedTracks, targetTrack.id)
        if (pairedAudioTrack) {
          const audioClip = createLinkedAudioClip(newClip, groupId)
          if (item.file) {
            fileStoreRef.current.set(audioClip.id, item.file)
          }
          updatedTracks = updatedTracks.map(track => {
            if (track.id === pairedAudioTrack.id) {
              return { ...track, clips: [...track.clips, audioClip] }
            }
            return track
          })
        }
      }

      return updatedTracks
    })

    // The creator's own file (from the 3Speak uploader): if this browser cannot
    // show it, upload it now so its 480p copy can stand in for the preview
    if (options.file && mediaType === 'video') {
      probeMedia(options.file).then(probe => {
        if (probe.playable) return
        const patchItem = (fields) => setLibrary(prev => prev.map(i => (i.id === libraryId ? { ...i, ...fields } : i)))
        patchItem({ needsConversion: true, uploading: true, uploadProgress: 0 })
        return uploadFileToServer(options.file, item.name, (p) => patchItem({ uploadProgress: p })).then(info => {
          patchItem({ uploading: false, uploadProgress: 1 })
          applyServerUrl(libraryId, info.url)
          afterUpload(libraryId, { ...probe, duration }, info)
        }, err => {
          patchItem({ uploading: false, uploadError: err.message })
          throw err
        })
      }).catch(err => console.warn(`[load-media] Upload for preview failed: ${err.message}`))
    }

    // The updater may run later, so callers look the clip up in `tracks` by id
    return { clipId: newClipId }
  }, [setTracksWithHistory, uploadFileToServer, applyServerUrl, afterUpload, keepImportable])

  /**
   * Place a finished recording for a remix mode.
   * - placement 'after': appended after the given clip on the same track (stitch)
   * - placement 'before': placed at 0 on that track; everything else on the
   *   timeline shifts right by the recording's length (stitch before)
   * - placement 'layer': on a NEW top video track at `timelinePosition`, with `layout`
   * Paired audio clip goes on the matching audio track either way.
   */
  const addRemixRecording = useCallback(async (file, serverUrl, { placement, afterClipId, timelinePosition = 0, layout = null, maxDuration = null }) => {
    const url = serverUrl || URL.createObjectURL(file)
    const meta = await getMediaMetadataFromURL(url, 'video')
    const duration = meta.duration
    const libraryId = generateLibraryId()
    setLibrary(prev => [...prev, {
      id: libraryId, file, url, serverUrl: serverUrl || null, name: file.name, duration, type: 'video',
      videoWidth: meta.videoWidth, videoHeight: meta.videoHeight
    }])

    const videoClipId = generateClipId()
    const groupId = generateGroupId()

    lengthCheckRef.current = true
    setTracksWithHistory(prev => {
      let tracksNext = prev
      let videoTrack
      let position = timelinePosition

      if (placement === 'after' || placement === 'before') {
        videoTrack = prev.find(t => t.clips.some(c => c.id === afterClipId)) || prev.find(t => t.type === 'video')
        if (!videoTrack) return prev
        if (placement === 'after') {
          for (const c of videoTrack.clips) {
            position = Math.max(position, (c.timelinePosition || 0) + (c.endTime - c.startTime))
          }
        } else {
          position = 0
        }
      } else {
        const count = prev.filter(t => t.type === 'video').length + 1
        videoTrack = { id: generateTrackId(), type: 'video', name: `Video ${count}`, clips: [] }
        tracksNext = ensurePairedAudioTracks([videoTrack, ...prev])
      }

      let length = duration
      if (maxDuration != null) length = Math.min(length, maxDuration)
      if (length <= 0.05) return prev
      if (placement === 'before') {
        // Make room at the start: shift every existing clip right
        tracksNext = tracksNext.map(t => ({
          ...t,
          clips: t.clips.map(c => ({ ...c, timelinePosition: (c.timelinePosition || 0) + length }))
        }))
      }

      const videoClip = {
        id: videoClipId,
        file: null,
        url,
        serverUrl: serverUrl || null,
        name: file.name,
        duration,
        startTime: 0,
        endTime: length,
        timelinePosition: position,
        audioEnabled: false,
        type: 'video',
        libraryId,
        groupId,
        videoWidth: meta.videoWidth,
        videoHeight: meta.videoHeight,
        zoom: 100,
        cropX: 0,
        cropY: 0,
        cropWidth: 100,
        cropHeight: 100,
        positionX: 0,
        positionY: 0,
        volume: 100,
        ...(layout ? { layout } : {})
      }
      const audioClip = createLinkedAudioClip(videoClip, groupId)
      fileStoreRef.current.set(videoClip.id, file)
      fileStoreRef.current.set(audioClip.id, file)

      tracksNext = tracksNext.map(t => t.id === videoTrack.id ? { ...t, clips: [...t.clips, videoClip] } : t)
      const pairedAudioTrack = findPairedAudioTrack(tracksNext, videoTrack.id)
      if (pairedAudioTrack) {
        tracksNext = tracksNext.map(t => t.id === pairedAudioTrack.id ? { ...t, clips: [...t.clips, audioClip] } : t)
      }
      return tracksNext
    })
    return videoClipId
  }, [setTracksWithHistory])

  // Add library item to timeline
  // eslint-disable-next-line no-unused-vars
  const addLibraryItemToTimeline = useCallback((libraryItemId, trackId, _insertIndex, dropTime) => {
    const libraryItem = library.find(i => i.id === libraryItemId)
    if (!libraryItem) return

    // Images go on video tracks, audio on audio tracks
    const targetTrackType = libraryItem.type === 'audio' ? 'audio' : 'video'

    lengthCheckRef.current = true
    setTracksWithHistory(prev => {
      let targetTrack = trackId
        ? prev.find(t => t.id === trackId)
        : prev.find(t => t.type === targetTrackType)

      // Create track if needed
      if (!targetTrack) {
        const newTrack = {
          id: generateTrackId(),
          type: targetTrackType,
          name: targetTrackType === 'video' ? 'Video 1' : 'Audio 1',
          clips: []
        }
        return [newTrack, ...prev] // Prepend new tracks
      }

      // Check compatibility
      if (targetTrack.type !== targetTrackType) return prev

      // Calculate timeline position - either from drop time or at the end of existing clips
      let timelinePosition = dropTime
      if (timelinePosition === undefined) {
        // Find the end of the last clip on this track
        let maxEnd = 0
        for (const clip of targetTrack.clips) {
          const clipEnd = (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
          maxEnd = Math.max(maxEnd, clipEnd)
        }
        timelinePosition = maxEnd
      }

      // Generate a groupId for video+audio pairs
      const groupId = libraryItem.type === 'video' ? generateGroupId() : null

      const newClip = {
        id: generateClipId(),
        file: libraryItem.file,
        url: libraryItem.serverUrl || libraryItem.url,
        serverUrl: libraryItem.serverUrl || null,
        name: libraryItem.name,
        duration: libraryItem.duration,
        startTime: 0,
        endTime: libraryItem.duration,
        timelinePosition,
        audioEnabled: libraryItem.type === 'video' ? false : true,
        type: libraryItem.type,
        libraryId: libraryItem.id,
        groupId,
        // Visual properties
        zoom: 100,
        cropX: 0,
        cropY: 0,
        cropWidth: 100,
        cropHeight: 100,
        positionX: 0,
        positionY: 0,
        volume: 100,
        ...(libraryItem.credit ? { credit: libraryItem.credit } : {})
      }

      // Store File reference in fileStore (survives undo/redo serialization)
      if (libraryItem.file) {
        fileStoreRef.current.set(newClip.id, libraryItem.file)
      }

      let updatedTracks = prev.map(track => {
        if (track.id === targetTrack.id) {
          return { ...track, clips: [...track.clips, newClip] }
        }
        return track
      })

      // Auto-create audio clip for video clips on the paired audio track
      if (libraryItem.type === 'video') {
        updatedTracks = ensurePairedAudioTracks(updatedTracks)
        const pairedAudioTrack = findPairedAudioTrack(updatedTracks, targetTrack.id)
        if (pairedAudioTrack) {
          const audioClip = createLinkedAudioClip(newClip, groupId)
          // Store File for audio clip too
          if (libraryItem.file) {
            fileStoreRef.current.set(audioClip.id, libraryItem.file)
          }
          updatedTracks = updatedTracks.map(track => {
            if (track.id === pairedAudioTrack.id) {
              return { ...track, clips: [...track.clips, audioClip] }
            }
            return track
          })
        }
      }

      return updatedTracks
    })
  }, [library, setTracksWithHistory])

  // Add files directly to a specific track (for compact mode "+" buttons)
  const addFilesToTrack = useCallback(async (files, trackId) => {
    for (const file of keepImportable(files)) {
      const type = getMediaType(file)
      if (!type) continue

      const probe = await probeMedia(file)
      const duration = probe.duration

      // Allow files longer than the timeline limit — they'll be trimmed when placed on timeline

      const url = URL.createObjectURL(file)
      const libraryId = generateLibraryId()

      // Add to library with uploading state
      const item = {
        id: libraryId, file, url, name: file.name, duration, type,
        uploading: type === 'video' || type === 'audio',
        needsConversion: type === 'video' && !probe.playable
      }
      setLibrary(prev => [...prev, item])

      // Upload video/audio to backend for 480p encoding
      if (type === 'video' || type === 'audio') {
        console.log(`[addFilesToTrack] Starting upload for ${file.name} (libraryId=${libraryId})`)
        uploadFileToServer(file, file.name, (p) => {
          setLibrary(prev => prev.map(i =>
            i.id === libraryId ? { ...i, uploadProgress: p } : i
          ))
        }).then(info => {
          const serverUrl = info.url
          console.log(`[addFilesToTrack] Upload complete: ${file.name} -> ${serverUrl}`)
          // Store server URL but keep blob URL for preview
          setLibrary(prev => prev.map(i =>
            i.id === libraryId ? { ...i, serverUrl, uploading: false, uploadProgress: 1 } : i
          ))
          applyServerUrl(libraryId, serverUrl)
          afterUpload(libraryId, probe, info)
        }).catch(err => {
          console.error(`[addFilesToTrack] Upload FAILED for ${file.name}:`, err.message)
          setLibrary(prev => prev.map(i =>
            i.id === libraryId ? { ...i, uploading: false, uploadError: err.message } : i
          ))
        })
      }

      // Place on the specified track
      const targetTrackType = type === 'audio' ? 'audio' : 'video'

      lengthCheckRef.current = true
      setTracksWithHistory(prev => {
        const targetTrack = prev.find(t => t.id === trackId)
        if (!targetTrack) return prev

        // Check compatibility
        if (targetTrack.type !== targetTrackType) return prev

        // Calculate timeline position at the end of existing clips
        let maxEnd = 0
        for (const clip of targetTrack.clips) {
          const clipEnd = (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
          maxEnd = Math.max(maxEnd, clipEnd)
        }

        const groupId = type === 'video' ? generateGroupId() : null

        const newClip = {
          id: generateClipId(),
          file,
          url,
          name: file.name,
          duration,
          startTime: 0,
          endTime: duration,
          timelinePosition: maxEnd,
          audioEnabled: type === 'video' ? false : true,
          type,
          libraryId,
          groupId,
          zoom: 100,
          cropX: 0,
          cropY: 0,
          cropWidth: 100,
          cropHeight: 100,
          positionX: 0,
          positionY: 0,
          volume: 100
        }

        fileStoreRef.current.set(newClip.id, file)

        let updatedTracks = prev.map(track => {
          if (track.id === targetTrack.id) {
            return { ...track, clips: [...track.clips, newClip] }
          }
          return track
        })

        // Auto-create audio clip for video clips
        if (type === 'video') {
          updatedTracks = ensurePairedAudioTracks(updatedTracks)
          const pairedAudioTrack = findPairedAudioTrack(updatedTracks, targetTrack.id)
          if (pairedAudioTrack) {
            const audioClip = createLinkedAudioClip(newClip, groupId)
            fileStoreRef.current.set(audioClip.id, file)
            updatedTracks = updatedTracks.map(track => {
              if (track.id === pairedAudioTrack.id) {
                return { ...track, clips: [...track.clips, audioClip] }
              }
              return track
            })
          }
        }

        return updatedTracks
      })
    }
  }, [setTracksWithHistory, uploadFileToServer, applyServerUrl, afterUpload, keepImportable])

  // Add a new track (prepend so new tracks appear on top)
  const addTrack = useCallback((type = 'video') => {
    const trackCount = tracks.filter(t => t.type === type).length + 1
    const name = type === 'video' ? `Video ${trackCount}` : `Audio ${trackCount}`

    const newTrack = {
      id: generateTrackId(),
      type,
      name,
      clips: []
    }

    setTracksWithHistory(prev => {
      let updatedTracks = [newTrack, ...prev]
      // If adding a video track, ensure a paired audio track exists
      if (type === 'video') {
        updatedTracks = ensurePairedAudioTracks(updatedTracks)
      }
      return updatedTracks
    })
  }, [tracks, setTracksWithHistory])

  // Update track properties (muted, visible, name, etc.)
  const updateTrack = useCallback((trackId, updates) => {
    setTracksWithHistory(prev =>
      prev.map(track => track.id === trackId ? { ...track, ...updates } : track)
    )
  }, [setTracksWithHistory])

  // Add a text clip to a video track
  const addTextClip = useCallback((trackId, dropTime) => {
    setTracksWithHistory(prev => {
      let targetTrack = trackId
        ? prev.find(t => t.id === trackId)
        : prev.find(t => t.type === 'video')

      if (!targetTrack || targetTrack.type !== 'video') {
        // No video track found, create one
        targetTrack = prev.find(t => t.type === 'video')
        if (!targetTrack) return prev
      }

      // Calculate timeline position
      let timelinePosition = dropTime
      if (timelinePosition === undefined) {
        let maxEnd = 0
        for (const clip of targetTrack.clips) {
          const clipEnd = (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
          maxEnd = Math.max(maxEnd, clipEnd)
        }
        timelinePosition = maxEnd
      }

      const newClip = {
        id: generateClipId(),
        name: 'Text Layer',
        type: 'text',
        duration: 5,
        startTime: 0,
        endTime: 5,
        timelinePosition,
        audioEnabled: false,
        // Text-specific properties
        text: 'Enter text here',
        fontSize: 48,
        fontFamily: 'Roboto',
        fontColor: '#ffffff',
        fontWeight: 'normal',
        textAlign: 'center',
        backgroundColor: 'transparent',
        // Visual properties (shared with other clip types)
        zoom: 100,
        positionX: 0,
        positionY: 0,
        cropX: 0,
        cropY: 0,
        cropWidth: 100,
        cropHeight: 100
      }

      return prev.map(track => {
        if (track.id === targetTrack.id) {
          return { ...track, clips: [...track.clips, newClip] }
        }
        return track
      })
    })
  }, [setTracksWithHistory])

  // Add a color clip to a track
  const addColorClip = useCallback((trackId, dropTime) => {
    setTracksWithHistory(prev => {
      let targetTrack = trackId
        ? prev.find(t => t.id === trackId)
        : prev.find(t => t.type === 'video')

      if (!targetTrack || targetTrack.type !== 'video') {
        targetTrack = prev.find(t => t.type === 'video')
        if (!targetTrack) return prev
      }

      let timelinePosition = dropTime
      if (timelinePosition === undefined) {
        let maxEnd = 0
        for (const clip of targetTrack.clips) {
          const clipEnd = (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
          maxEnd = Math.max(maxEnd, clipEnd)
        }
        timelinePosition = maxEnd
      }

      const newClip = {
        id: generateClipId(),
        name: 'Color',
        type: 'color',
        duration: 5,
        startTime: 0,
        endTime: 5,
        timelinePosition,
        audioEnabled: false,
        backgroundColor: '#000000',
        gradientEnabled: false,
        gradientEndColor: '#ffffff',
        gradientAngle: 180,
        zoom: 100,
        positionX: 0,
        positionY: 0,
        cropX: 0,
        cropY: 0,
        cropWidth: 100,
        cropHeight: 100
      }

      return prev.map(track => {
        if (track.id === targetTrack.id) {
          return { ...track, clips: [...track.clips, newClip] }
        }
        return track
      })
    })
  }, [setTracksWithHistory])

  // Remove a track
  const removeTrack = useCallback((trackId) => {
    setTracksWithHistory(prev => {
      const track = prev.find(t => t.id === trackId)
      if (!track) return prev

      const sameTypeTracks = prev.filter(t => t.type === track.type)
      if (sameTypeTracks.length <= 1) return prev

      return prev.filter(t => t.id !== trackId)
    })
  }, [setTracksWithHistory])

  // Remove clip from timeline (group-aware: removes all clips in the same group)
  const removeClip = useCallback((clipId) => {
    // Find the clip's groupId first
    let groupId = null
    for (const track of tracks) {
      const clip = track.clips.find(c => c.id === clipId)
      if (clip) {
        groupId = clip.groupId
        break
      }
    }

    // Collect all IDs to remove
    const idsToRemove = new Set([clipId])
    if (groupId) {
      for (const track of tracks) {
        for (const clip of track.clips) {
          if (clip.groupId === groupId) {
            idsToRemove.add(clip.id)
          }
        }
      }
    }

    // Clean up file store
    for (const id of idsToRemove) {
      fileStoreRef.current.delete(id)
    }

    setTracksWithHistory(prev => prev.map(track => {
      const removed = track.clips.filter(c => idsToRemove.has(c.id))
      if (!removed.length) return track
      const kept = track.clips.filter(c => !idsToRemove.has(c.id))
      // Deleting the first clip of a track ripples: the rest of the track moves
      // left so the next clip starts where the deleted one did (a gap at the
      // start is never wanted). Gaps further along stay as they are.
      const pos = (c) => c.timelinePosition || 0
      const first = track.clips.reduce((a, c) => (pos(c) < pos(a) ? c : a), track.clips[0])
      if (!idsToRemove.has(first.id) || !kept.length) return { ...track, clips: kept }
      // The next clip takes the deleted one's start; the rest keep their spacing
      const shift = Math.min(...kept.map(pos)) - pos(first)
      if (shift <= 0) return { ...track, clips: kept }
      return { ...track, clips: kept.map(c => ({ ...c, timelinePosition: Math.max(0, pos(c) - shift) })) }
    }))

    setSelectedClipId(prev => idsToRemove.has(prev) ? null : prev)
  }, [setTracksWithHistory, tracks])

  // Update clip in any track (group-aware: moves/trims all clips in the same group)
  const updateClip = useCallback((clipId, updates) => {
    setTracksWithHistory(prev => {
      // Find the target clip to check for group membership
      let targetClip = null
      let groupId = null
      for (const track of prev) {
        const clip = track.clips.find(c => c.id === clipId)
        if (clip) {
          targetClip = clip
          groupId = clip.groupId
          break
        }
      }

      // If no group or no position/trim changes, just update the single clip
      const hasPositionChange = 'timelinePosition' in updates
      const hasTrimChange = 'startTime' in updates || 'endTime' in updates
      if (!targetClip || !groupId || (!hasPositionChange && !hasTrimChange)) {
        return prev.map(track => ({
          ...track,
          clips: track.clips.map(clip =>
            clip.id === clipId ? { ...clip, ...updates } : clip
          )
        }))
      }

      // Group-aware update: propagate position delta and trim values to all group members
      const positionDelta = hasPositionChange
        ? updates.timelinePosition - (targetClip.timelinePosition || 0)
        : 0

      return prev.map(track => ({
        ...track,
        clips: track.clips.map(clip => {
          if (clip.id === clipId) {
            return { ...clip, ...updates }
          }
          if (clip.groupId === groupId) {
            const groupUpdates = {}
            if (hasPositionChange) {
              groupUpdates.timelinePosition = (clip.timelinePosition || 0) + positionDelta
            }
            if ('startTime' in updates) {
              groupUpdates.startTime = updates.startTime
            }
            if ('endTime' in updates) {
              groupUpdates.endTime = updates.endTime
            }
            return { ...clip, ...groupUpdates }
          }
          return clip
        })
      }))
    })
  }, [setTracksWithHistory])

  // Reorder clips within a track
  const reorderClips = useCallback((trackId, fromIndex, toIndex) => {
    setTracksWithHistory(prev => prev.map(track => {
      if (track.id !== trackId) return track

      const newClips = [...track.clips]
      const [removed] = newClips.splice(fromIndex, 1)
      newClips.splice(toIndex, 0, removed)
      return { ...track, clips: newClips }
    }))
  }, [setTracksWithHistory])

  // Move clip between tracks (group-aware: moves grouped audio/video to paired track)
  const moveClipToTrack = useCallback((clipId, fromTrackId, toTrackId, newTimelinePosition) => {
    setTracksWithHistory(prev => {
      const fromTrack = prev.find(t => t.id === fromTrackId)
      const toTrack = prev.find(t => t.id === toTrackId)

      if (!fromTrack || !toTrack) return prev

      const clip = fromTrack.clips.find(c => c.id === clipId)
      if (!clip) return prev

      // Check type compatibility (images go on video tracks)
      const clipTrackType = clip.type === 'audio' ? 'audio' : 'video'
      if (clipTrackType !== toTrack.type) return prev

      const positionDelta = newTimelinePosition !== undefined
        ? newTimelinePosition - (clip.timelinePosition || 0)
        : 0

      const movedClip = newTimelinePosition !== undefined
        ? { ...clip, timelinePosition: newTimelinePosition }
        : clip

      // Build a move map: clipId -> { fromTrackId, toTrackId, movedClip }
      const clipMoves = new Map()
      clipMoves.set(clipId, { fromTrackId, toTrackId, movedClip })

      // If clip has a group, find all grouped members across ALL tracks and move them
      if (clip.groupId) {
        // Find the paired audio track for the DESTINATION video track
        const toPairedTrack = findPairedAudioTrack(prev, toTrackId)

        for (const track of prev) {
          for (const otherClip of track.clips) {
            if (otherClip.id !== clipId && otherClip.groupId === clip.groupId) {
              // Audio clips go to the destination's paired audio track
              const destTrackId = (otherClip.type === 'audio' && toPairedTrack)
                ? toPairedTrack.id
                : toTrackId

              clipMoves.set(otherClip.id, {
                fromTrackId: track.id,
                toTrackId: destTrackId,
                movedClip: {
                  ...otherClip,
                  timelinePosition: (otherClip.timelinePosition || 0) + positionDelta
                }
              })
            }
          }
        }
      }

      // Collect which clips to remove from which tracks and which to add
      const removals = new Map() // trackId -> Set<clipId>
      const additions = new Map() // trackId -> [clip]

      for (const [cId, move] of clipMoves) {
        if (!removals.has(move.fromTrackId)) removals.set(move.fromTrackId, new Set())
        removals.get(move.fromTrackId).add(cId)

        if (!additions.has(move.toTrackId)) additions.set(move.toTrackId, [])
        additions.get(move.toTrackId).push(move.movedClip)
      }

      return prev.map(track => {
        const removeSet = removals.get(track.id)
        const addList = additions.get(track.id)
        if (!removeSet && !addList) return track

        let clips = track.clips
        if (removeSet) {
          clips = clips.filter(c => !removeSet.has(c.id))
        }
        if (addList) {
          clips = [...clips, ...addList]
        }
        return { ...track, clips }
      })
    })
  }, [setTracksWithHistory])

  const selectClip = useCallback((clipId) => {
    setSelectedClipId(clipId)
    setSelectedLibraryId(null)
  }, [])

  const selectLibraryItem = useCallback((itemId) => {
    setSelectedLibraryId(itemId)
    setSelectedClipId(null)
  }, [])

  // Duplicate clip (group-aware: duplicates all clips in the same group)
  const duplicateClip = useCallback((clipId) => {
    setTracksWithHistory(prev => {
      // Find the target clip and its group
      let targetGroupId = null
      for (const track of prev) {
        const clip = track.clips.find(c => c.id === clipId)
        if (clip) {
          targetGroupId = clip.groupId
          break
        }
      }

      // Collect all clip IDs to duplicate
      const clipIdsToDuplicate = new Set([clipId])
      if (targetGroupId) {
        for (const track of prev) {
          for (const clip of track.clips) {
            if (clip.groupId === targetGroupId) {
              clipIdsToDuplicate.add(clip.id)
            }
          }
        }
      }

      // Generate new groupId for the duplicated group
      const newGroupId = targetGroupId ? generateGroupId() : null

      return prev.map(track => {
        let modified = false
        const newClips = [...track.clips]
        const inserts = [] // { afterIndex, clip }

        for (let i = 0; i < track.clips.length; i++) {
          const clip = track.clips[i]
          if (!clipIdsToDuplicate.has(clip.id)) continue

          modified = true
          const clipDuration = clip.endTime - clip.startTime
          const newClip = {
            ...clip,
            id: generateClipId(),
            timelinePosition: (clip.timelinePosition || 0) + clipDuration,
            groupId: newGroupId
          }

          // Copy file reference
          const originalFile = fileStoreRef.current.get(clip.id)
          if (originalFile) {
            fileStoreRef.current.set(newClip.id, originalFile)
          }

          inserts.push({ afterIndex: i, clip: newClip })
        }

        if (!modified) return track

        // Insert duplicates after their originals (in reverse to keep indices stable)
        for (let j = inserts.length - 1; j >= 0; j--) {
          newClips.splice(inserts[j].afterIndex + 1, 0, inserts[j].clip)
        }

        return { ...track, clips: newClips }
      })
    })
  }, [setTracksWithHistory])

  // Split clip at playhead position (group-aware: splits all clips in the same group)
  const splitClipAtPlayhead = useCallback((clipId, playheadPos) => {
    setTracksWithHistory(prev => {
      // Find the target clip to get its groupId
      let targetGroupId = null
      for (const track of prev) {
        const clip = track.clips.find(c => c.id === clipId)
        if (clip) {
          targetGroupId = clip.groupId
          break
        }
      }

      // Collect all clip IDs to split (the target clip + all group members)
      const clipIdsToSplit = new Set([clipId])
      if (targetGroupId) {
        for (const track of prev) {
          for (const clip of track.clips) {
            if (clip.groupId === targetGroupId) {
              clipIdsToSplit.add(clip.id)
            }
          }
        }
      }

      // Generate a new groupId for the second halves
      const newGroupId = targetGroupId ? generateGroupId() : null

      return prev.map(track => {
        let modified = false
        const newClips = []

        for (const clip of track.clips) {
          if (!clipIdsToSplit.has(clip.id)) {
            newClips.push(clip)
            continue
          }

          const clipStart = clip.timelinePosition || 0
          const clipDuration = clip.endTime - clip.startTime
          const clipEnd = clipStart + clipDuration

          // Check if playhead is within the clip
          if (playheadPos <= clipStart || playheadPos >= clipEnd) {
            newClips.push(clip)
            continue
          }

          modified = true
          const splitPointInClip = playheadPos - clipStart
          const mediaSplitTime = clip.startTime + splitPointInClip

          const firstClip = {
            ...clip,
            endTime: mediaSplitTime
          }

          const secondClip = {
            ...clip,
            id: generateClipId(),
            startTime: mediaSplitTime,
            timelinePosition: playheadPos,
            groupId: newGroupId
          }

          // Copy file reference for the new split clip
          const originalFile = fileStoreRef.current.get(clip.id)
          if (originalFile) {
            fileStoreRef.current.set(secondClip.id, originalFile)
          }

          newClips.push(firstClip, secondClip)
        }

        return modified ? { ...track, clips: newClips } : track
      })
    })
  }, [setTracksWithHistory])

  /**
   * Auto cut: replace a clip (and its linked audio/video twin) with numbered
   * parts. `parts` are {start, end} in source media seconds, in order.
   * closeGaps false: each part stays where it was (split at the pauses).
   * closeGaps true: parts are packed back to back and everything after the
   * original clip moves left by what was cut out (pauses removed).
   * One undo step.
   */
  const applySilenceCut = useCallback((clipId, parts, { closeGaps = false } = {}) => {
    if (!parts?.length) return
    setTracksWithHistory(prev => {
      let target = null
      for (const t of prev) {
        target = t.clips.find(c => c.id === clipId)
        if (target) break
      }
      if (!target) return prev

      const pos = target.timelinePosition || 0
      const originalLength = target.endTime - target.startTime
      const originalEnd = pos + originalLength
      // The linked twin covers exactly the same media and time span
      const same = (c) => c.id === target.id || (
        target.groupId && c.groupId === target.groupId &&
        Math.abs((c.timelinePosition || 0) - pos) < 0.001 &&
        Math.abs(c.startTime - target.startTime) < 0.001 &&
        Math.abs(c.endTime - target.endTime) < 0.001
      )
      const keptLength = parts.reduce((sum, p) => sum + (p.end - p.start), 0)
      const removed = closeGaps ? Math.max(0, originalLength - keptLength) : 0
      const groupIds = parts.map(() => (target.groupId ? generateGroupId() : null))

      return prev.map(track => {
        if (!track.clips.some(same) && !removed) return track
        const clips = []
        for (const c of track.clips) {
          if (same(c)) {
            const file = fileStoreRef.current.get(c.id)
            const baseName = (c.name || '').replace(/^Part \d+ · /, '')
            let packed = pos
            parts.forEach((p, i) => {
              const part = {
                ...c,
                id: i === 0 ? c.id : generateClipId(),
                name: `Part ${i + 1} · ${baseName}`,
                startTime: p.start,
                endTime: p.end,
                timelinePosition: closeGaps ? packed : pos + (p.start - target.startTime),
                groupId: groupIds[i]
              }
              packed += p.end - p.start
              if (file && i > 0) fileStoreRef.current.set(part.id, file)
              clips.push(part)
            })
          } else if (removed && (c.timelinePosition || 0) >= originalEnd - 0.001) {
            clips.push({ ...c, timelinePosition: (c.timelinePosition || 0) - removed })
          } else {
            clips.push(c)
          }
        }
        return { ...track, clips }
      })
    })
  }, [setTracksWithHistory])

  // Legacy split clip (relative time)
  const splitClip = useCallback((clipId, splitTime) => {
    setTracksWithHistory(prev => prev.map(track => {
      const clipIndex = track.clips.findIndex(c => c.id === clipId)
      if (clipIndex === -1) return track

      const originalClip = track.clips[clipIndex]
      const absoluteSplitTime = originalClip.startTime + splitTime

      if (absoluteSplitTime <= originalClip.startTime || absoluteSplitTime >= originalClip.endTime) {
        return track
      }

      const firstClip = {
        ...originalClip,
        endTime: absoluteSplitTime
      }

      const secondClip = {
        ...originalClip,
        id: generateClipId(),
        startTime: absoluteSplitTime,
        timelinePosition: (originalClip.timelinePosition || 0) + splitTime
      }

      // Copy file reference for the new split clip
      const originalFile = fileStoreRef.current.get(originalClip.id)
      if (originalFile) {
        fileStoreRef.current.set(secondClip.id, originalFile)
      }

      const newClips = [...track.clips]
      newClips.splice(clipIndex, 1, firstClip, secondClip)
      return { ...track, clips: newClips }
    }))
  }, [setTracksWithHistory])

  // Remove gap at playhead position across all tracks
  const removeGapAtPlayhead = useCallback(() => {
    setTracksWithHistory(prev => prev.map(track => {
      // Find the end of the last clip before playhead on this track
      let prevEnd = 0
      for (const c of track.clips) {
        const cEnd = (c.timelinePosition || 0) + (c.endTime - c.startTime)
        if (cEnd <= playheadPosition + 0.01) {
          prevEnd = Math.max(prevEnd, cEnd)
        }
      }

      // Find the start of the first clip after playhead on this track
      let nextStart = Infinity
      for (const c of track.clips) {
        const cStart = c.timelinePosition || 0
        if (cStart >= playheadPosition - 0.01 && cStart > prevEnd - 0.01) {
          nextStart = Math.min(nextStart, cStart)
        }
      }

      if (nextStart === Infinity) return track // No clips after playhead

      const gap = nextStart - prevEnd
      if (gap < 0.01) return track // No gap

      // Shift all clips at or after nextStart left by gap amount
      const newClips = track.clips.map(c => {
        const cStart = c.timelinePosition || 0
        if (cStart >= nextStart - 0.01) {
          return { ...c, timelinePosition: cStart - gap }
        }
        return c
      })

      return { ...track, clips: newClips }
    }))
  }, [setTracksWithHistory, playheadPosition])

  // Check if playhead is on a gap (not inside any clip) and there are clips after it
  const isPlayheadOnGap = useMemo(() => {
    for (const track of tracks) {
      if (track.clips.length === 0) continue

      let onClip = false
      let hasClipAfter = false
      let prevEnd = 0

      for (const c of track.clips) {
        const cStart = c.timelinePosition || 0
        const cEnd = cStart + (c.endTime - c.startTime)

        if (playheadPosition >= cStart - 0.01 && playheadPosition < cEnd + 0.01) {
          onClip = true
        }
        if (cStart > playheadPosition + 0.01) {
          hasClipAfter = true
        }
        if (cEnd <= playheadPosition + 0.01) {
          prevEnd = Math.max(prevEnd, cEnd)
        }
      }

      // Gap exists if playhead is not on a clip, there are clips after, and there's actual space
      if (!onClip && hasClipAfter) {
        return true
      }
      // Also check if playhead is before the first clip (gap at start)
      if (!onClip && playheadPosition < prevEnd) {
        continue
      }
    }
    return false
  }, [tracks, playheadPosition])

  // Group selected clips together
  const groupClips = useCallback((clipIds) => {
    if (!clipIds || clipIds.length < 2) return
    const newGroupId = generateGroupId()
    setTracksWithHistory(prev => prev.map(track => ({
      ...track,
      clips: track.clips.map(clip =>
        clipIds.includes(clip.id) ? { ...clip, groupId: newGroupId } : clip
      )
    })))
  }, [setTracksWithHistory])

  // Ungroup clips (remove groupId from all clips in the group)
  const ungroupClips = useCallback((clipId) => {
    // Find the groupId of the target clip
    let groupId = null
    for (const track of tracks) {
      const clip = track.clips.find(c => c.id === clipId)
      if (clip) {
        groupId = clip.groupId
        break
      }
    }
    if (!groupId) return

    setTracksWithHistory(prev => prev.map(track => ({
      ...track,
      clips: track.clips.map(clip =>
        clip.groupId === groupId ? { ...clip, groupId: null } : clip
      )
    })))
  }, [setTracksWithHistory, tracks])

  // Get total timeline duration
  const getTotalDuration = useCallback(() => {
    let maxDuration = 0
    for (const track of tracks) {
      let trackDuration = 0
      for (const clip of track.clips) {
        trackDuration += clip.endTime - clip.startTime
      }
      maxDuration = Math.max(maxDuration, trackDuration)
    }
    return maxDuration
  }, [tracks])

  // HLS download state: { [libraryId]: { status: 'downloading'|'done'|'error', progress: number } }
  const [hlsDownloads, setHlsDownloads] = useState({})

  // Replace URLs for a library item and all clips that reference it
  // serverUrl: optional backend-accessible URL (e.g. /rendered/clip-xxx.mp4) to avoid re-downloading
  const replaceLibraryItemUrl = useCallback((libraryId, newUrl, originalUrl, trimmedRange, serverUrl) => {
    setLibrary(prev => prev.map(item => {
      if (item.id !== libraryId) return item
      const updated = { ...item, url: newUrl, originalUrl, serverUrl: serverUrl || null, file: null }
      if (trimmedRange) {
        updated.duration = trimmedRange.clipEnd - trimmedRange.clipStart
        updated.clipStart = null
        updated.clipEnd = null
      }
      return updated
    }))
    // Update tracks directly (not through history) to avoid polluting undo stack
    setTracks(prev => prev.map(track => ({
      ...track,
      clips: track.clips.map(clip => {
        if (clip.libraryId !== libraryId) return clip
        if (trimmedRange) {
          // Backend already trimmed the file — clip now spans the full trimmed file
          const newDuration = trimmedRange.clipEnd - trimmedRange.clipStart
          return { ...clip, url: newUrl, originalUrl, serverUrl: serverUrl || null, duration: newDuration, startTime: 0, endTime: newDuration }
        }
        return { ...clip, url: newUrl, originalUrl, serverUrl: serverUrl || null }
      })
    })))
  }, [])

  // Start downloading an HLS stream in the background
  const startHlsDownload = useCallback(async (libraryId, hlsUrl, ffmpeg) => {
    if (!ffmpeg || !hlsUrl || !isHlsUrl(hlsUrl)) return

    setHlsDownloads(prev => ({ ...prev, [libraryId]: { status: 'downloading', progress: 0 } }))

    try {
      const blobUrl = await downloadHlsToMp4(hlsUrl, ffmpeg, (progress) => {
        setHlsDownloads(prev => ({ ...prev, [libraryId]: { status: 'downloading', progress } }))
      })

      replaceLibraryItemUrl(libraryId, blobUrl, hlsUrl)
      setHlsDownloads(prev => ({ ...prev, [libraryId]: { status: 'done', progress: 1 } }))
      console.log(`[useTimeline] HLS download complete for ${libraryId}`)
    } catch (err) {
      console.error('[useTimeline] HLS download failed:', err)
      setHlsDownloads(prev => ({ ...prev, [libraryId]: { status: 'error', progress: 0 } }))
    }
  }, [replaceLibraryItemUrl])

  // Start preparing an HLS clip on the backend (download 480p + trim)
  const startBackendClipPreparation = useCallback(async (libraryId, hlsUrl, clipStart, clipEnd) => {
    if (!hlsUrl) return

    setHlsDownloads(prev => ({ ...prev, [libraryId]: { status: 'downloading', progress: 0 } }))

    try {
      const { prepareClipOnBackend } = await import('../utils/clipPreparer.js')

      const outputUrl = await prepareClipOnBackend(hlsUrl, clipStart, clipEnd, (progress) => {
        // Backend processing takes 0-90% of progress
        setHlsDownloads(prev => ({ ...prev, [libraryId]: { status: 'downloading', progress: progress * 0.9 } }))
      })

      // Fetch the prepared MP4 and create a local blob URL for smooth playback
      setHlsDownloads(prev => ({ ...prev, [libraryId]: { status: 'downloading', progress: 0.9 } }))
      const res = await fetch(outputUrl)
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)

      replaceLibraryItemUrl(libraryId, blobUrl, hlsUrl, { clipStart, clipEnd }, outputUrl)
      setHlsDownloads(prev => ({ ...prev, [libraryId]: { status: 'done', progress: 1 } }))
      console.log(`[useTimeline] Backend clip preparation complete for ${libraryId}`)
    } catch (err) {
      console.error('[useTimeline] Backend clip preparation failed:', err)
      setHlsDownloads(prev => ({ ...prev, [libraryId]: { status: 'error', progress: 0 } }))
    }
  }, [replaceLibraryItemUrl])

  // Track current library for cleanup
  const libraryRef = useRef(library)
  libraryRef.current = library

  // Cleanup: revoke all blob URLs on unmount to free memory
  useEffect(() => {
    return () => {
      for (const item of libraryRef.current) {
        if (item.url && item.url.startsWith('blob:')) {
          URL.revokeObjectURL(item.url)
        }
      }
      fileStoreRef.current.clear()
    }
  }, [])

  return {
    // Library
    library,
    selectedLibraryId,
    selectedLibraryItem,
    addToLibrary,
    addToLibraryFromURL,
    addToLibraryAndTimeline,
    addMusicClip,
    addRemixRecording,
    removeFromLibrary,
    selectLibraryItem,
    addLibraryItemToTimeline,
    addFilesToTrack,

    // Timeline
    tracks,
    selectedClipId,
    selectedClip,
    playheadPosition,
    setPlayheadPosition,
    addTrack,
    updateTrack,
    addTextClip,
    addColorClip,
    removeTrack,
    removeClip,
    updateClip,
    reorderClips,
    moveClipToTrack,
    selectClip,
    duplicateClip,
    splitClip,
    splitClipAtPlayhead,
    removeGapAtPlayhead,
    isPlayheadOnGap,
    groupClips,
    ungroupClips,
    getTotalDuration,
    applySilenceCut,
    addSfxClip,
    addStickerClip,
    fitClipsToBeats,
    loadProjectState,
    findClip,
    fileStoreRef,

    // HLS Downloads
    hlsDownloads,
    startHlsDownload,
    startBackendClipPreparation,

    // Undo/Redo
    undo,
    redo,
    canUndo,
    canRedo,

    // Over-the-limit notice after an import
    lengthNotice,
    dismissLengthNotice,

    // Files refused at import (too big)
    rejectedFiles,
    dismissRejectedFiles
  }
}
