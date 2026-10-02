// Backend URL selection — picks the first healthy backend from the configured list.
// Falls back to relative paths ('') if none are configured or reachable.

const BACKEND_URLS = (import.meta.env.VITE_BACKEND_URLS || '')
  .split(',')
  .map(u => u.trim().replace(/\/+$/, ''))
  .filter(Boolean)

let selectedBackend = '' // default: relative paths (nginx proxy)

/**
 * Check each configured backend URL and pick the first healthy one.
 * Should be called once on app startup.
 */
export async function selectBackend() {
  if (BACKEND_URLS.length === 0) return ''

  for (const url of BACKEND_URLS) {
    try {
      const res = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(3000)
      })
      if (res.ok) {
        selectedBackend = url
        console.log(`[backend] Selected: ${url}`)
        return url
      }
    } catch {
      console.warn(`[backend] Unreachable: ${url}`)
    }
  }

  console.warn('[backend] No healthy backend found, using relative paths')
  selectedBackend = ''
  return ''
}

/**
 * Get the currently selected backend base URL.
 * Returns '' if using relative paths (default nginx proxy).
 */
export function getBackendUrl() {
  return selectedBackend
}

/**
 * Build a full API URL using the selected backend.
 * e.g. api('/api/health') → 'https://3speak-editor2.okinoko.io/api/health'
 * or just '/api/health' if no backend is selected.
 */
export function api(path) {
  return selectedBackend ? `${selectedBackend}${path}` : path
}
