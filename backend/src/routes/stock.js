import { Router } from 'express'
import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { v4 as uuidv4 } from 'uuid'
import { requireSignIn } from '../auth.js'
import { PROVIDERS, availableProviders, providerRequest, parseProviderAnswer } from '../utils/stockProviders.js'

// Live stock search for the editor's Stock sheet (only with an API key set):
//   GET  /api/stock/providers                          { providers: ['pexels', 'pixabay'] }
//   GET  /api/stock/search?provider&q&type=video|image { items } (thumbnails are the provider's)
//   POST /api/stock/fetch { provider, id, type }       the item, its file copied to our uploads:
//                                                      { ...item, file: '/api/upload/files/<name>' }
// The keys never leave this server. Fetch looks the item up again by id (the
// browser never names the file to download), and only from the provider's
// own hosts. Our own CC0 library is static files (/stock/, host nginx).
const router = Router()
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
const MAX_BYTES = 200 * 1024 * 1024
const FILE_HOSTS = {
  pexels: /(^|\.)pexels\.com$/i,
  pixabay: /(^|\.)pixabay\.com$/i
}

// Per sign-in (or address) limits: searches per minute, copies per 10 minutes
const LIMITS = { search: { n: 30, ms: 60_000 }, fetch: { n: 20, ms: 600_000 } }
const hits = new Map()
function limited(kind, who) {
  const { n, ms } = LIMITS[kind]
  const now = Date.now()
  const key = `${kind}:${who}`
  const list = (hits.get(key) || []).filter(t => now - t < ms)
  if (list.length >= n) { hits.set(key, list); return true }
  list.push(now)
  hits.set(key, list)
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 600_000)) hits.delete(k)
  return false
}
const whoOf = (req) => req.signedIn?.username || req.signedIn?.sub || req.ip || 'anon'

// Small in-memory cache of answers (providers ask for it, and searches repeat)
const answers = new Map()
async function ask(provider, type, opts) {
  const { url, headers } = providerRequest(provider, type, opts)
  const key = `${provider}:${type}:${opts.q || ''}:${opts.id || ''}`
  const hit = answers.get(key)
  if (hit && Date.now() - hit.at < 3600_000) return hit.results
  const res = await (opts.fetchImpl || fetch)(url, { headers: { ...headers, 'User-Agent': '3SpeakEditor/1.0 (+https://3speak.tv)' } })
  if (!res.ok) throw Object.assign(new Error(`${PROVIDERS[provider].label} answered ${res.status}`), { status: res.status })
  const results = parseProviderAnswer(provider, type, await res.json())
  answers.set(key, { at: Date.now(), results })
  if (answers.size > 500) answers.delete(answers.keys().next().value)
  return results
}

const checkArgs = (provider, type) => availableProviders().includes(provider) && (type === 'video' || type === 'image')

router.get('/providers', (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json({ providers: availableProviders() })
})

router.get('/search', requireSignIn, async (req, res) => {
  const provider = String(req.query.provider || '')
  const type = String(req.query.type || 'video')
  const q = String(req.query.q || '').trim().slice(0, 100)
  if (!checkArgs(provider, type) || q.length < 2) return res.status(400).json({ error: 'Bad search' })
  if (limited('search', whoOf(req))) return res.status(429).json({ error: 'Too many searches' })
  try {
    const results = await ask(provider, type, { q })
    res.json({ items: results.map(r => r.item) })
  } catch (err) {
    console.warn(`[stock] ${provider} search failed: ${err.message}`)
    res.status(502).json({ error: 'Search failed' })
  }
})

router.post('/fetch', requireSignIn, async (req, res) => {
  const { provider, id, type } = req.body || {}
  if (!checkArgs(provider, type) || !/^\d{1,15}$/.test(String(id || ''))) return res.status(400).json({ error: 'Bad item' })
  if (limited('fetch', whoOf(req))) return res.status(429).json({ error: 'Too many files' })
  try {
    const [found] = await ask(provider, type, { id: String(id) })
    if (!found || found.item.id !== String(id)) return res.status(404).json({ error: 'Not found' })
    const u = new URL(found.download)
    if (u.protocol !== 'https:' || !FILE_HOSTS[provider].test(u.hostname)) return res.status(502).json({ error: 'Unexpected file host' })
    const ext = type === 'video' ? '.mp4' : (/\.png$/i.test(u.pathname) ? '.png' : '.jpg')
    const name = `${uuidv4()}${ext}`
    const dest = path.join(UPLOAD_DIR, name)
    const file = await fetch(u, { headers: { 'User-Agent': '3SpeakEditor/1.0 (+https://3speak.tv)' } })
    if (!file.ok || !file.body) return res.status(502).json({ error: 'Download failed' })
    if (Number(file.headers.get('content-length') || 0) > MAX_BYTES) return res.status(413).json({ error: 'File too big' })
    let bytes = 0
    const cap = new Transform({
      transform(chunk, enc, cb) {
        bytes += chunk.length
        cb(bytes > MAX_BYTES ? new Error('File too big') : null, chunk)
      }
    })
    await fs.mkdir(UPLOAD_DIR, { recursive: true })
    await pipeline(Readable.fromWeb(file.body), cap, createWriteStream(dest)).catch(async (err) => {
      await fs.unlink(dest).catch(() => {})
      throw err
    })
    console.log(`[stock] ${provider} ${type} ${id} -> ${name} (${bytes} bytes)`)
    res.json({ ...found.item, file: `/api/upload/files/${name}`, thumb: found.item.thumb })
  } catch (err) {
    console.warn(`[stock] ${provider} fetch ${id} failed: ${err.message}`)
    res.status(502).json({ error: 'Copy failed' })
  }
})

export { router as stockRouter }
