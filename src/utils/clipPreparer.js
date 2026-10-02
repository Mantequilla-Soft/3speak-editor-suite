import { api, getBackendUrl } from './backendSelector'

/**
 * Request the backend to prepare an HLS clip (download 480p + trim).
 * Returns a promise that resolves with the output URL.
 *
 * @param {string} hlsUrl - The m3u8 URL
 * @param {number} clipStart - Start time in seconds
 * @param {number} clipEnd - End time in seconds
 * @param {function} onProgress - Progress callback (0-1)
 * @returns {Promise<string>} - The URL of the prepared MP4 (e.g. /rendered/clip-xxx.mp4)
 */
export async function prepareClipOnBackend(hlsUrl, clipStart, clipEnd, onProgress = () => {}) {
  const res = await fetch(api('/api/clip/prepare'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: hlsUrl, clipStart, clipEnd })
  })

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(errData.error || `Server responded with ${res.status}`)
  }

  const { jobId } = await res.json()

  // Poll for completion
  return new Promise((resolve, reject) => {
    const poll = setInterval(async () => {
      try {
        const statusRes = await fetch(api(`/api/clip/prepare/${jobId}`))
        if (!statusRes.ok) {
          clearInterval(poll)
          reject(new Error(`Status check failed: ${statusRes.status}`))
          return
        }

        const data = await statusRes.json()
        onProgress(data.progress || 0)

        if (data.status === 'completed') {
          clearInterval(poll)
          const backendUrl = getBackendUrl()
          const outUrl = (backendUrl && data.outputUrl?.startsWith('/')) ? `${backendUrl}${data.outputUrl}` : data.outputUrl
          resolve(outUrl)
        } else if (data.status === 'failed') {
          clearInterval(poll)
          reject(new Error(data.error || 'Clip preparation failed'))
        }
      } catch (err) {
        clearInterval(poll)
        reject(err)
      }
    }, 1000)

    // Safety timeout: 10 minutes
    setTimeout(() => {
      clearInterval(poll)
      reject(new Error('Clip preparation timed out'))
    }, 10 * 60 * 1000)
  })
}
