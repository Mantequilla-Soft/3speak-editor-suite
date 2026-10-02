import Hls from 'hls.js'

/**
 * Check if a URL is an HLS stream (.m3u8)
 * Also matches proxied manifests whose .m3u8 target sits in the query string,
 * e.g. https://player.example/hls?u=https%3A%2F%2F...%2Fmanifest.m3u8
 */
export function isHlsUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const { pathname, searchParams } = new URL(url)
    if (pathname.endsWith('.m3u8')) return true
    for (const value of searchParams.values()) {
      try {
        if (new URL(value).pathname.endsWith('.m3u8')) return true
      } catch {}
    }
    return false
  } catch {
    return url.includes('.m3u8')
  }
}

/**
 * Attach HLS.js to a video/audio element if the URL is HLS.
 * Returns the Hls instance (for cleanup) or null if not HLS.
 */
export function attachHls(element, url) {
  if (!element || !url) return null
  if (!isHlsUrl(url)) return null

  // Safari has native HLS support
  if (element.canPlayType('application/vnd.apple.mpegurl')) {
    element.src = url
    return null
  }

  if (!Hls.isSupported()) {
    console.warn('[hlsHelper] HLS.js not supported in this browser')
    return null
  }

  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    // Use anonymous crossOrigin to work with COEP: credentialless
    xhrSetup: (xhr) => {
      xhr.withCredentials = false
    }
  })

  hls.loadSource(url)
  hls.attachMedia(element)

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    console.log('[hlsHelper] Manifest parsed, levels:', hls.levels.length)
  })

  hls.on(Hls.Events.ERROR, (event, data) => {
    console.error('[hlsHelper] HLS error:', data.type, data.details, data.fatal ? '(FATAL)' : '')
    if (data.fatal) {
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        console.log('[hlsHelper] Retrying load...')
        hls.startLoad()
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        console.log('[hlsHelper] Recovering media error...')
        hls.recoverMediaError()
      }
    }
  })

  return hls
}

/**
 * Destroy an HLS instance safely.
 */
export function destroyHls(hlsInstance) {
  if (hlsInstance) {
    hlsInstance.destroy()
  }
}

/**
 * Get duration of an HLS stream by loading metadata.
 * Returns a promise that resolves with the duration in seconds.
 */
export function getHlsDuration(url) {
  return new Promise((resolve) => {
    if (!Hls.isSupported()) {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.src = url
      video.onloadedmetadata = () => {
        resolve(video.duration)
        video.removeAttribute('src')
      }
      video.onerror = () => resolve(10)
      return
    }

    const video = document.createElement('video')
    const hls = new Hls({
      enableWorker: false,
      xhrSetup: (xhr) => {
        xhr.withCredentials = false
      }
    })

    const cleanup = () => {
      hls.destroy()
      video.removeAttribute('src')
    }

    hls.loadSource(url)
    hls.attachMedia(video)

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.onloadedmetadata = () => {
        const duration = video.duration
        cleanup()
        resolve(isFinite(duration) ? duration : 10)
      }
    })

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        cleanup()
        resolve(10)
      }
    })

    setTimeout(() => {
      cleanup()
      resolve(10)
    }, 10000)
  })
}
