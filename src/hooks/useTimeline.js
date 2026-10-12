import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { isHlsUrl, getHlsDuration } from '../utils/hlsHelper'
import { downloadHlsToMp4 } from '../utils/hlsDownloader'
import { api, getBackendUrl } from '../utils/backendSelector'
import { MAX_TIMELINE_SECONDS, MAX_TIMELINE_TEXT, MAX_TIMELINE_ADJ } from '../utils/limits'

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

function getMediaDuration(file) {
  return new Promise((resolve) => {
    const isVideo = file.type.startsWith('video/')
    const isAudio = file.type.startsWith('audio/')
    const isImage = file.type.startsWith('image/')

    if (isImage) {
      resolve(5) // Default 5 seconds for images
      return
    }

    const element = document.createElement(isVideo ? 'video' : 'audio')
    element.preload = 'metadata'
    element.onloadedmetadata = () => {
      URL.revokeObjectURL(element.src)
      resolve(element.duration)
    }
    element.onerror = () => {
      resolve(10)
    }
    element.src = URL.createObjectURL(file)
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
  const videoTracks = tracks.filter(t => t.type === 'video')
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
  const videoTracks = tracks.filter(t => t.type === 'video')
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
  const uploadFileToServer = useCallback((file, name, onProgress) => {
    return new Promise((resolve, reject) => {
      const formData = new FormData()
      formData.append('file', file, name || file.name)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', api('/api/upload'))
      if (onProgress) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total)
        })
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText)
            const backendUrl = getBackendUrl()
            if (backendUrl && data.url && data.url.startsWith('/')) {
              resolve(`${backendUrl}${data.url}`)
            } else {
              resolve(data.url)
            }
          } catch { reject(new Error('Invalid response from server')) }
        } else {
          reject(new Error(`Upload failed: ${xhr.status}`))
        }
      }
      xhr.onerror = () => reject(new Error('Upload network error'))
      xhr.send(formData)
    })
  }, [])

  // Update a library item's serverUrl and all timeline clips that reference it.
  // Does NOT change clip.url (keeps the local blob URL for preview).
  const applyServerUrl = useCallback((libraryId, serverUrl) => {
    console.log(`[applyServerUrl] libraryId=${libraryId}, serverUrl=${serverUrl}`)
    setLibrary(prev => prev.map(item =>
      item.id === libraryId ? { ...item, serverUrl } : item
    ))
    // Set serverUrl on all clips that reference this library item (preview keeps blob URL)
    setTracksWithHistory(prev => {
      let matchCount = 0
      const updated = prev.map(track => ({
        ...track,
        clips: track.clips.map(clip => {
          if (clip.libraryId === libraryId) {
            matchCount++
            return { ...clip, serverUrl }
          }
          return clip
        })
      }))
      console.log(`[applyServerUrl] Matched ${matchCount} clips for serverUrl`)
      return updated
    })
  }, [setTracksWithHistory])

  // Add files to library — uploads to backend for 480p encoding first, then makes available
  const MAX_DURATION = MAX_TIMELINE_SECONDS // 2 minutes max (utils/limits.js)
  const addToLibrary = useCallback(async (files) => {
    for (const file of files) {
      const type = getMediaType(file)
      if (!type) continue

      const duration = await getMediaDuration(file)

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
        uploading: true
      }
      setLibrary(prev => [...prev, newItem])

      // Upload video/audio to backend for 480p encoding
      if (type === 'video' || type === 'audio') {
        try {
          console.log(`[addToLibrary] Starting upload for ${file.name} (itemId=${itemId})`)
          const serverUrl = await uploadFileToServer(file, file.name, (p) => {
            setLibrary(prev => prev.map(i =>
              i.id === itemId ? { ...i, uploadProgress: p } : i
            ))
          })
          console.log(`[addToLibrary] Upload complete: ${file.name} -> ${serverUrl}`)
          // Store server URL but keep blob URL for preview
          setLibrary(prev => prev.map(i =>
            i.id === itemId ? { ...i, serverUrl, uploading: false, uploadProgress: 1 } : i
          ))
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
    }
  }, [uploadFileToServer])

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
  const addMusicClip = useCallback(async (url, name, credit) => {
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
      const length = Math.min(duration, contentEnd > 0 ? contentEnd : MAX_DURATION, MAX_DURATION)
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

  // Add media from URL to library AND place on timeline
  // options: { clipStart?: number, clipEnd?: number } — optional trim range
  const addToLibraryAndTimeline = useCallback(async (url, name, mediaType, options = {}) => {
    if (!mediaType || !['video', 'audio', 'image'].includes(mediaType)) return

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

    setTracksWithHistory(prev => {
      const targetTrack = prev.find(t => t.type === targetTrackType)
      if (!targetTrack) return prev

      // Place at the end of existing clips on this track
      let timelinePosition = 0
      for (const clip of targetTrack.clips) {
        const clipEnd2 = (clip.timelinePosition || 0) + (clip.endTime - clip.startTime)
        timelinePosition = Math.max(timelinePosition, clipEnd2)
      }

      // Auto-trim to fit within the timeline limit
      let clipDuration = clipEnd - clipStart
      const remaining = Math.max(0, MAX_DURATION - timelinePosition)
      if (remaining <= 0) {
        setTimeout(() => alert(`Timeline is full (${MAX_TIMELINE_TEXT}). Remove a clip to make room.`), 0)
        return prev
      }
      if (timelinePosition + clipDuration > MAX_DURATION) {
        clipEnd = clipStart + remaining
        clipDuration = remaining
        // Songs are expected to run longer than a short; trim them quietly
        if (!options.quiet) setTimeout(() => alert(`Clip trimmed to ${Math.round(remaining)}s to fit within the ${MAX_TIMELINE_ADJ} timeline.`), 0)
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
    // The updater may run later, so callers look the clip up in `tracks` by id
    return { clipId: newClipId }
  }, [setTracksWithHistory])

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
      if (placement === 'before') {
        // Room left = the timeline limit minus what is already on the timeline
        let used = 0
        for (const t of tracksNext) for (const c of t.clips) used = Math.max(used, (c.timelinePosition || 0) + (c.endTime - c.startTime))
        length = Math.min(length, MAX_DURATION - used)
      } else {
        length = Math.min(length, MAX_DURATION - position)
      }
      if (length <= 0.05) {
        setTimeout(() => alert(`Timeline is full (${MAX_TIMELINE_TEXT}). Remove a clip to make room.`), 0)
        return prev
      }
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

      // Auto-trim to fit within the timeline limit
      const remaining = Math.max(0, MAX_DURATION - timelinePosition)
      if (remaining <= 0) {
        setTimeout(() => alert(`Timeline is full (${MAX_TIMELINE_TEXT}). Remove a clip to make room.`), 0)
        return prev
      }
      let trimmedDuration = libraryItem.duration
      if (timelinePosition + libraryItem.duration > MAX_DURATION) {
        trimmedDuration = remaining
        setTimeout(() => alert(`Clip trimmed to ${Math.round(remaining)}s to fit within the ${MAX_TIMELINE_ADJ} timeline.`), 0)
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
        endTime: trimmedDuration,
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
    for (const file of files) {
      const type = getMediaType(file)
      if (!type) continue

      const duration = await getMediaDuration(file)

      // Allow files longer than the timeline limit — they'll be trimmed when placed on timeline

      const url = URL.createObjectURL(file)
      const libraryId = generateLibraryId()

      // Add to library with uploading state
      const item = { id: libraryId, file, url, name: file.name, duration, type, uploading: type === 'video' || type === 'audio' }
      setLibrary(prev => [...prev, item])

      // Upload video/audio to backend for 480p encoding
      if (type === 'video' || type === 'audio') {
        console.log(`[addFilesToTrack] Starting upload for ${file.name} (libraryId=${libraryId})`)
        uploadFileToServer(file, file.name, (p) => {
          setLibrary(prev => prev.map(i =>
            i.id === libraryId ? { ...i, uploadProgress: p } : i
          ))
        }).then(serverUrl => {
          console.log(`[addFilesToTrack] Upload complete: ${file.name} -> ${serverUrl}`)
          // Store server URL but keep blob URL for preview
          setLibrary(prev => prev.map(i =>
            i.id === libraryId ? { ...i, serverUrl, uploading: false, uploadProgress: 1 } : i
          ))
          applyServerUrl(libraryId, serverUrl)
        }).catch(err => {
          console.error(`[addFilesToTrack] Upload FAILED for ${file.name}:`, err.message)
          setLibrary(prev => prev.map(i =>
            i.id === libraryId ? { ...i, uploading: false, uploadError: err.message } : i
          ))
        })
      }

      // Place on the specified track
      const targetTrackType = type === 'audio' ? 'audio' : 'video'

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

        // Auto-trim to fit within the timeline limit
        const remaining = Math.max(0, MAX_DURATION - maxEnd)
        if (remaining <= 0) {
          setTimeout(() => alert(`Timeline is full (${MAX_TIMELINE_TEXT}). Remove a clip to make room.`), 0)
          return prev
        }
        let trimmedDuration = duration
        if (maxEnd + duration > MAX_DURATION) {
          trimmedDuration = remaining
          setTimeout(() => alert(`Clip trimmed to ${Math.round(remaining)}s to fit within the ${MAX_TIMELINE_ADJ} timeline.`), 0)
        }

        const groupId = type === 'video' ? generateGroupId() : null

        const newClip = {
          id: generateClipId(),
          file,
          url,
          name: file.name,
          duration,
          startTime: 0,
          endTime: trimmedDuration,
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
  }, [setTracksWithHistory])

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

    setTracksWithHistory(prev => prev.map(track => ({
      ...track,
      clips: track.clips.filter(c => !idsToRemove.has(c.id))
    })))

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
    canRedo
  }
}
