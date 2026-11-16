/**
 * Live stock search on Pexels and Pixabay, for the editor's Stock sheet. Both
 * need a free API key, kept on this server only (PEXELS_API_KEY,
 * PIXABAY_API_KEY); without one the provider is simply not offered.
 * Results come back in the editor's library item shape (src/utils/stockLibrary.js).
 * A picked file is downloaded to our uploads before it is used: Pixabay does
 * not allow hotlinking, and renders should never depend on a third party.
 *
 * Licences (free, also commercially, no attribution required):
 *   Pexels License https://www.pexels.com/license/
 *   Pixabay Content License https://pixabay.com/service/license-summary/
 */

export const PROVIDERS = {
  pexels: { label: 'Pexels', license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', env: 'PEXELS_API_KEY' },
  pixabay: { label: 'Pixabay', license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/', env: 'PIXABAY_API_KEY' }
}

const PER_PAGE = 24
// At most this size for the copy we keep (the editor renders up to 1080x1920)
const MAX_LONG = 1920
const MAX_SHORT = 1080

/** Provider ids with a key in `env`. */
export function availableProviders(env = process.env) {
  return Object.keys(PROVIDERS).filter(p => typeof env[PROVIDERS[p].env] === 'string' && env[PROVIDERS[p].env].trim())
}

const fits = (w, h) => Math.max(w, h) <= MAX_LONG && Math.min(w, h) <= MAX_SHORT
// The biggest mp4 rendition that fits 1080p (else the smallest one)
function bestVideoFile(files) {
  const mp4 = (files || []).filter(f => f && f.link && (!f.file_type || f.file_type === 'video/mp4') && f.width && f.height)
  if (!mp4.length) return null
  const ok = mp4.filter(f => fits(f.width, f.height)).sort((a, b) => b.width * b.height - a.width * a.height)
  return ok[0] || mp4.sort((a, b) => a.width * a.height - b.width * b.height)[0]
}

const tagsOf = (s) => String(s || '').toLowerCase().split(/[,\s]+/).map(t => t.trim()).filter(t => t.length > 1).slice(0, 12)
const titleOf = (s, fallback) => {
  const t = String(s || '').trim()
  return (t ? t.charAt(0).toUpperCase() + t.slice(1) : fallback).slice(0, 80)
}

/** One Pexels video / photo -> { item, download } (download: the file URL to copy). */
export function fromPexels(raw, type) {
  const base = { provider: 'pexels', source: 'Pexels', license: PROVIDERS.pexels.license, licenseUrl: PROVIDERS.pexels.licenseUrl }
  if (type === 'video') {
    const file = bestVideoFile(raw.video_files)
    if (!file) return null
    const slug = String(raw.url || '').split('/').filter(Boolean).pop() || ''
    return {
      download: file.link,
      item: {
        ...base, id: String(raw.id), type: 'video', category: null,
        title: titleOf(slug.replace(/-\d+$/, '').replace(/-/g, ' '), `Pexels video ${raw.id}`),
        tags: tagsOf(slug.replace(/-\d+$/, '').replace(/-/g, ' ')),
        thumb: raw.image || raw.video_pictures?.[0]?.picture || null,
        width: file.width, height: file.height, duration: Number(raw.duration) || null,
        author: raw.user?.name || null, sourceUrl: raw.url || null
      }
    }
  }
  const src = raw.src || {}
  const download = src.large2x || src.large || src.original
  if (!download) return null
  return {
    download,
    item: {
      ...base, id: String(raw.id), type: 'image', category: null,
      title: titleOf(raw.alt, `Pexels photo ${raw.id}`), tags: tagsOf(raw.alt),
      thumb: src.medium || src.small || download, width: raw.width || null, height: raw.height || null,
      author: raw.photographer || null, sourceUrl: raw.url || null
    }
  }
}

/** One Pixabay hit -> { item, download }. */
export function fromPixabay(raw, type) {
  const base = { provider: 'pixabay', source: 'Pixabay', license: PROVIDERS.pixabay.license, licenseUrl: PROVIDERS.pixabay.licenseUrl }
  if (type === 'video') {
    const v = raw.videos || {}
    const pickV = [v.large, v.medium, v.small, v.tiny].filter(x => x?.url && x.width && fits(x.width, x.height))[0] || v.small || v.tiny
    if (!pickV?.url) return null
    return {
      download: pickV.url,
      item: {
        ...base, id: String(raw.id), type: 'video', category: null,
        title: titleOf(raw.tags?.split(',')[0], `Pixabay video ${raw.id}`), tags: tagsOf(raw.tags),
        thumb: pickV.thumbnail || v.tiny?.thumbnail || null, width: pickV.width || null, height: pickV.height || null,
        duration: Number(raw.duration) || null, author: raw.user || null, sourceUrl: raw.pageURL || null
      }
    }
  }
  const download = raw.largeImageURL || raw.webformatURL
  if (!download) return null
  return {
    download,
    item: {
      ...base, id: String(raw.id), type: 'image', category: null,
      title: titleOf(raw.tags?.split(',')[0], `Pixabay photo ${raw.id}`), tags: tagsOf(raw.tags),
      thumb: raw.webformatURL || raw.previewURL || download, width: raw.imageWidth || null, height: raw.imageHeight || null,
      author: raw.user || null, sourceUrl: raw.pageURL || null
    }
  }
}

/** The request for a search (q) or one item (id). { url, headers } */
export function providerRequest(provider, type, { q = null, id = null, env = process.env } = {}) {
  const key = String(env[PROVIDERS[provider].env] || '').trim()
  if (provider === 'pexels') {
    const path = type === 'video'
      ? (id ? `/videos/videos/${encodeURIComponent(id)}` : `/videos/search?${new URLSearchParams({ query: q, per_page: String(PER_PAGE) })}`)
      : (id ? `/v1/photos/${encodeURIComponent(id)}` : `/v1/search?${new URLSearchParams({ query: q, per_page: String(PER_PAGE) })}`)
    return { url: `https://api.pexels.com${path}`, headers: { Authorization: key } }
  }
  const params = new URLSearchParams({ key, safesearch: 'true', per_page: String(PER_PAGE) })
  if (id) params.set('id', String(id))
  else params.set('q', String(q).slice(0, 100))
  if (type !== 'video') params.set('image_type', 'photo')
  return { url: `https://pixabay.com/api/${type === 'video' ? 'videos/' : ''}?${params}`, headers: {} }
}

/** Results of a provider's answer (search or by id), each { item, download }. */
export function parseProviderAnswer(provider, type, body) {
  if (provider === 'pexels') {
    const list = body?.videos || body?.photos || (body?.id ? [body] : [])
    return list.map(r => fromPexels(r, type)).filter(Boolean)
  }
  return (body?.hits || []).map(r => fromPixabay(r, type)).filter(Boolean)
}
