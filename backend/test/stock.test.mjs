// Live stock search (Pexels / Pixabay): only offered with a key, results in
// the editor's item shape, the picked file copied to our uploads, and the
// browser never chooses what gets downloaded. The providers are faked.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-'))
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
process.env.REQUIRE_SIGN_IN = 'false'
process.env.PEXELS_API_KEY = 'test-pexels-key'
delete process.env.PIXABAY_API_KEY
const SP = await import('../src/utils/stockProviders.js')
const express = (await import('express')).default
const { stockRouter } = await import('../src/routes/stock.js')

const PEXELS_VIDEO = {
  id: 123, width: 3840, height: 2160, duration: 12, url: 'https://www.pexels.com/video/waves-on-a-beach-123/',
  image: 'https://images.pexels.com/videos/123/thumb.jpeg', user: { name: 'badadib' },
  video_files: [
    { id: 1, quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, link: 'https://videos.pexels.com/video-files/123/uhd.mp4' },
    { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, link: 'https://videos.pexels.com/video-files/123/hd.mp4' },
    { id: 3, quality: 'sd', file_type: 'video/mp4', width: 640, height: 360, link: 'https://videos.pexels.com/video-files/123/sd.mp4' }
  ]
}
const realFetch = globalThis.fetch
const calls = []
let server, base
before(async () => {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts)
    calls.push({ url: u, auth: opts.headers?.Authorization })
    if (u.startsWith('https://api.pexels.com/videos/search')) return new Response(JSON.stringify({ videos: [PEXELS_VIDEO] }), { status: 200 })
    if (u === 'https://api.pexels.com/videos/videos/123') return new Response(JSON.stringify(PEXELS_VIDEO), { status: 200 })
    if (u === 'https://api.pexels.com/videos/videos/666') return new Response(JSON.stringify({ ...PEXELS_VIDEO, id: 666, video_files: [{ ...PEXELS_VIDEO.video_files[1], link: 'https://evil.example.com/x.mp4' }] }), { status: 200 })
    if (u === 'https://videos.pexels.com/video-files/123/hd.mp4') return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 200 })
    return new Response('{}', { status: 404 })
  }
  const app = express()
  app.use(express.json())
  app.use('/api/stock', stockRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { globalThis.fetch = realFetch; server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

test('providers are offered only with their key', async () => {
  assert.deepEqual(SP.availableProviders({ PEXELS_API_KEY: 'k', PIXABAY_API_KEY: ' ' }), ['pexels'])
  assert.deepEqual(SP.availableProviders({}), [])
  const r = await (await realFetch(`${base}/api/stock/providers`)).json()
  assert.deepEqual(r.providers, ['pexels'])
})

test('Pexels and Pixabay answers become library items, at most 1080p', () => {
  const [v] = SP.parseProviderAnswer('pexels', 'video', { videos: [PEXELS_VIDEO] })
  assert.equal(v.download, 'https://videos.pexels.com/video-files/123/hd.mp4')
  assert.equal(v.item.title, 'Waves on a beach')
  assert.equal(v.item.license, 'Pexels License')
  assert.equal(v.item.author, 'badadib')
  assert.equal(v.item.width, 1920)
  const [p] = SP.parseProviderAnswer('pexels', 'image', { photos: [{ id: 5, width: 4000, height: 3000, alt: 'a cup of coffee', photographer: 'badadib', url: 'https://www.pexels.com/photo/5/', src: { large2x: 'https://images.pexels.com/photos/5/l2.jpeg', medium: 'https://images.pexels.com/photos/5/m.jpeg' } }] })
  assert.equal(p.download, 'https://images.pexels.com/photos/5/l2.jpeg')
  assert.equal(p.item.type, 'image')
  const [x] = SP.parseProviderAnswer('pixabay', 'video', { hits: [{ id: 9, tags: 'city, night', duration: 8, user: 'badadib', pageURL: 'https://pixabay.com/videos/id-9/', videos: { large: { url: 'https://cdn.pixabay.com/l.mp4', width: 3840, height: 2160 }, medium: { url: 'https://cdn.pixabay.com/m.mp4', width: 1920, height: 1080, thumbnail: 'https://cdn.pixabay.com/m.jpg' } } }] })
  assert.equal(x.download, 'https://cdn.pixabay.com/m.mp4')
  assert.deepEqual(x.item.tags, ['city', 'night'])
  assert.equal(x.item.license, 'Pixabay Content License')
  const req = SP.providerRequest('pixabay', 'image', { q: 'sky', env: { PIXABAY_API_KEY: 'k' } })
  assert.match(req.url, /^https:\/\/pixabay\.com\/api\/\?key=k&safesearch=true/)
  assert.match(req.url, /image_type=photo/)
})

test('search goes through the server with the key, the key never comes back', async () => {
  const res = await realFetch(`${base}/api/stock/search?provider=pexels&type=video&q=waves`)
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.ok(!text.includes('test-pexels-key'))
  const { items } = JSON.parse(text)
  assert.equal(items.length, 1)
  assert.equal(items[0].id, '123')
  assert.equal(calls.find(c => c.url.includes('/videos/search')).auth, 'test-pexels-key')
  assert.equal((await realFetch(`${base}/api/stock/search?provider=pixabay&type=video&q=waves`)).status, 400, 'no key, no provider')
  assert.equal((await realFetch(`${base}/api/stock/search?provider=pexels&type=video&q=w`)).status, 400, 'too short')
})

test('fetch copies the looked-up file into the uploads; a foreign file host is refused', async () => {
  const res = await realFetch(`${base}/api/stock/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'pexels', id: 123, type: 'video' }) })
  assert.equal(res.status, 200)
  const item = await res.json()
  assert.match(item.file, /^\/api\/upload\/files\/[0-9a-f-]+\.mp4$/)
  assert.equal(fs.statSync(path.join(process.env.UPLOAD_DIR, path.basename(item.file))).size, 8)
  const evil = await realFetch(`${base}/api/stock/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'pexels', id: 666, type: 'video' }) })
  assert.equal(evil.status, 502)
  const bad = await realFetch(`${base}/api/stock/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'pexels', id: '../x', type: 'video' }) })
  assert.equal(bad.status, 400)
})
