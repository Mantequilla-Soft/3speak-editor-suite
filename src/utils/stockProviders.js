/**
 * Live stock search (Pexels / Pixabay) through the editor backend
 * (backend/src/routes/stock.js). The API keys stay on the server; the browser
 * only sees search results, and a picked file is copied to our server before
 * it is used (Pixabay does not allow hotlinking). Without keys on the backend
 * no provider is offered and the editor uses only its own library.
 */
import { api, getBackendUrl } from './backendSelector'
import { authFetch } from './editorAuth'

export const PROVIDER_LABELS = { pexels: 'Pexels', pixabay: 'Pixabay' }

// Our server's URLs come back relative: make them absolute for the backend we talk to
const absolute = (u) => {
  if (!u || !u.startsWith('/')) return u
  const b = getBackendUrl()
  return b ? `${b}${u}` : u
}
const withAbsoluteFile = (it) => ({ ...it, file: absolute(it.file), thumb: absolute(it.thumb) })

/** Providers the backend can search (ids), [] when none or unreachable. */
export async function stockProviders() {
  try {
    const res = await fetch(api('/api/stock/providers'))
    if (!res.ok) return []
    const { providers } = await res.json()
    return Array.isArray(providers) ? providers.filter(p => PROVIDER_LABELS[p]) : []
  } catch {
    return []
  }
}

/** Search results in the library item shape (thumbnails are the provider's, for display only). */
export async function searchStockProvider(provider, query, type = 'video') {
  const q = new URLSearchParams({ provider, q: query, type })
  const res = await authFetch(api(`/api/stock/search?${q}`))
  if (!res.ok) throw new Error(res.status === 429 ? 'Too many searches, wait a moment.' : 'The search did not work, try again.')
  const { items } = await res.json()
  return Array.isArray(items) ? items : []
}

/** Copy one result to our server: the item with `file` on our server. */
export async function fetchStockProviderItem(provider, id, type) {
  const res = await authFetch(api('/api/stock/fetch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, id, type })
  })
  if (!res.ok) throw new Error('That file could not be copied to the server.')
  return withAbsoluteFile(await res.json())
}
