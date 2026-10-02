import { api, getBackendUrl } from './backendSelector'

/**
 * Request the backend to reverse a clip segment.
 * For blob: URLs, uploads the file. For remote URLs, passes the URL.
 *
 * @param {string} url - The source video URL (can be blob: or remote)
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @param {function} onProgress - Progress callback (0-1)
 * @returns {Promise<string>} - The URL of the reversed MP4 (e.g. /rendered/reversed-xxx.mp4)
 */
export async function reverseClipOnBackend(url, startTime, endTime, onProgress = () => {}) {
  const formData = new FormData()
  formData.append('startTime', startTime.toString())
  formData.append('endTime', endTime.toString())

  if (url.startsWith('blob:')) {
    // Fetch the blob and upload as file
    const blobRes = await fetch(url)
    const blob = await blobRes.blob()
    formData.append('file', blob, 'clip.mp4')
  } else {
    formData.append('url', url)
  }

  const res = await fetch(api('/api/clip/reverse'), {
    method: 'POST',
    body: formData
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
        const statusRes = await fetch(api(`/api/clip/reverse/${jobId}`))
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
          reject(new Error(data.error || 'Reverse processing failed'))
        }
      } catch (err) {
        clearInterval(poll)
        reject(err)
      }
    }, 1000)

    setTimeout(() => {
      clearInterval(poll)
      reject(new Error('Reverse processing timed out'))
    }, 10 * 60 * 1000)
  })
}
