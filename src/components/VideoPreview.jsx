import { useRef, useEffect } from 'react'
import { Music } from 'lucide-react'
import { isHlsUrl, attachHls, destroyHls } from '../utils/hlsHelper'

function VideoPreview({ clip, isVerticalVideo }) {
  const mediaRef = useRef(null)
  const hlsRef = useRef(null)
  const loadedUrlRef = useRef(null)

  // Attach HLS or set src when clip changes
  useEffect(() => {
    const el = mediaRef.current
    if (!el || !clip || !clip.url) return
    if (loadedUrlRef.current === clip.url) return

    // Cleanup previous HLS
    if (hlsRef.current) {
      destroyHls(hlsRef.current)
      hlsRef.current = null
    }

    if (clip.type !== 'audio' && clip.type !== 'image' && isHlsUrl(clip.url)) {
      const hls = attachHls(el, clip.url)
      if (hls) {
        hlsRef.current = hls
      }
    } else {
      el.src = clip.url
    }

    loadedUrlRef.current = clip.url
  }, [clip?.id, clip?.url, clip?.type])

  // Seek to startTime (defaults to 0 for library items that don't have startTime)
  useEffect(() => {
    if (mediaRef.current && clip) {
      const seekTime = clip.startTime || 0
      const el = mediaRef.current
      if (el.readyState >= 2) {
        el.currentTime = seekTime
      } else {
        el.addEventListener('loadeddata', function onLoaded() {
          el.removeEventListener('loadeddata', onLoaded)
          el.currentTime = seekTime
        })
      }
    }
  }, [clip?.id, clip?.startTime])

  // Cleanup HLS on unmount
  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        destroyHls(hlsRef.current)
        hlsRef.current = null
      }
    }
  }, [])

  const previewClass = `video-preview${isVerticalVideo ? ' vertical' : ''}`

  if (!clip) {
    return (
      <div className={previewClass}>
        <span className="no-video">Select a clip to preview</span>
      </div>
    )
  }

  if (clip.type === 'audio') {
    return (
      <div className={previewClass}>
        <div className="audio-preview">
          <Music size={48} />
          <audio
            ref={mediaRef}
            controls
            crossOrigin="anonymous"
          />
        </div>
      </div>
    )
  }

  if (clip.type === 'image') {
    return (
      <div className={previewClass}>
        <img src={clip.url} alt={clip.name} crossOrigin="anonymous" />
      </div>
    )
  }

  return (
    <div className={previewClass}>
      <video
        ref={mediaRef}
        controls
        preload="auto"
        muted={!clip.audioEnabled}
        crossOrigin="anonymous"
      />
    </div>
  )
}

export default VideoPreview
