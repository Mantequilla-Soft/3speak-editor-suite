// End-to-end check that the editor speaks the viewer's language, in a real browser
// against a real backend (like motion.e2e.mjs: throwaway folders and token secret).
// 3Speak's side (e2e/host.html) opens the editor with ?lang=, as EditorModal does,
// and later sends 'set-language', as when the viewer switches language on 3Speak.
//   - the Shorts editor opens in German (?lang=de), then switches to French
//   - the audio editor opens in Russian, the Ad Wizard in Japanese
//   - no raw key and no "[i18n] missing key" anywhere
// The expected texts are read from src/locales, so a reworded translation does not
// break the test, only a missing or unused one does.
//
//   node e2e/language.e2e.mjs        (Chromium as for the other e2e scripts)
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const require = createRequire(path.join(ROOT, 'backend', 'package.json'))
const { chromium } = require('playwright-core')
const CHROME = process.env.E2E_CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1148/chrome-linux/chrome')
const { readFlat } = await import(path.join(ROOT, 'scripts/i18n/files.mjs'))
const LOCALES = path.join(ROOT, 'src/locales')
const lang = Object.fromEntries(['en', 'de', 'fr', 'ru', 'ja'].map(c => [c, readFlat(LOCALES, c)]))
const KEY_RE = new RegExp(`\\b(${Object.keys(lang.en).map(k => k.split('.')[0]).filter((a, i, all) => all.indexOf(a) === i).join('|')})\\.[a-z][\\w]*\\.[\\w.]+\\b`)

const S = fs.mkdtempSync(path.join(os.tmpdir(), 'language-e2e-'))
const DATA = path.join(S, 'data')
const HOST_DIR = path.join(S, 'host')
for (const d of ['uploads', 'rendered', 'work']) fs.mkdirSync(path.join(DATA, d), { recursive: true })
fs.mkdirSync(HOST_DIR)
fs.copyFileSync(path.join(ROOT, 'e2e', 'host.html'), path.join(HOST_DIR, 'index.html'))

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const [BACKEND_PORT, HOST_PORT, EDITOR_PORT] = [await freePort(), await freePort(), await freePort()]
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`
const HOST = `http://127.0.0.1:${HOST_PORT}`
const EDITOR = `http://127.0.0.1:${EDITOR_PORT}`
const SECRET = crypto.randomBytes(24).toString('hex')

const children = []
const backend = spawn(process.execPath, ['src/index.js'], {
  cwd: path.join(ROOT, 'backend'),
  env: { ...process.env, PORT: String(BACKEND_PORT), EDITOR_TOKEN_SECRET: SECRET, UPLOAD_DIR: path.join(DATA, 'uploads'), UPLOADS_DIR: path.join(DATA, 'uploads'), RENDERED_DIR: path.join(DATA, 'rendered'), WORK_DIR: path.join(DATA, 'work'), CHROMIUM_PATH: CHROME },
  stdio: ['ignore', 'ignore', 'inherit']
})
children.push(backend)
execFileSync('npx', ['vite', 'build', '--outDir', path.join(S, 'dist'), '--emptyOutDir', '--logLevel', 'error'], {
  cwd: ROOT, stdio: 'inherit', env: { ...process.env, VITE_BACKEND_URLS: BACKEND, VITE_GATEWAY_URL: '' }
})
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.wav': 'audio/wav' }
const serve = (dir, port, spa) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = spa ? path.join(dir, 'index.html') : file
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  }).listen(port, '127.0.0.1', () => resolve(server))
})
const servers = [await serve(HOST_DIR, HOST_PORT, false), await serve(path.join(S, 'dist'), EDITOR_PORT, true)]
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(250)
  }
}
await until(async () => { try { return (await fetch(`${BACKEND}/api/health`)).ok } catch { return false } }, 'backend up', 20000)

const results = []
const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    results.push(['PASS', name])
    console.log(`PASS ${name} (${Date.now() - t0} ms)`)
  } catch (err) {
    results.push(['FAIL', name])
    console.log(`FAIL ${name}: ${err.stack || err.message}`)
  }
}

const browser = await chromium.launch({ executablePath: CHROME })
const consoleErrors = []
const missingKeys = []
async function open(mode, code, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, locale: 'en-US' })
  const page = await ctx.newPage()
  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push(m.text())
    if (/\[i18n\] missing key/.test(m.text())) missingKeys.push(`${mode}/${code}: ${m.text()}`)
  })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
  await page.addInitScript((origin) => { if (location.href.startsWith(origin)) { localStorage.setItem('3speak-tour-done', '1'); localStorage.setItem('3speak-audio-tour-done', '1') } }, EDITOR)
  await page.goto(`${HOST}/index.html?editor=${encodeURIComponent(EDITOR)}&mode=${mode}&lang=${code}`)
  const frame = await until(async () => page.frames().find(f => f.url().startsWith(EDITOR)), 'editor frame')
  await until(() => page.evaluate(() => window.__messages.some(m => m.type === 'editor-ready')), 'editor-ready')
  return { ctx, page, frame }
}
const htmlLang = (frame) => frame.evaluate(() => document.documentElement.getAttribute('lang'))
const shows = async (frame, text, what) => {
  assert.ok(text, `no text for ${what}`)
  await frame.getByText(text, { exact: false }).first().waitFor({ timeout: 15000 })
}
const shot = async (page, name) => { if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `language-${name}.png`) }) }
const noRawKeys = async (frame, what) => {
  const body = await frame.evaluate(() => document.body.innerText)
  const m = body.match(KEY_RE)
  assert.equal(m, null, `${what}: a raw key on screen: ${m?.[0]}`)
}

try {
  await step('the Shorts editor opens in German with ?lang=de', async () => {
    const { ctx, page, frame } = await open('video', 'de')
    await until(async () => (await htmlLang(frame)) === 'de', 'html lang=de')
    await shows(frame, lang.de['app.empty.addVideo'], 'app.empty.addVideo')
    await shows(frame, lang.de['app.empty.addAudio'], 'app.empty.addAudio')
    assert.notEqual(lang.de['app.empty.addVideo'], lang.en['app.empty.addVideo'])
    assert.equal(await frame.getByText(lang.en['app.empty.addVideo'], { exact: true }).count(), 0, 'English "Add video" still shown')
    await noRawKeys(frame, 'video/de')
    await shot(page, 'video-de')

    // the viewer switches to French on 3Speak while the editor is open
    await page.evaluate(() => window.__send({ type: 'set-language', lang: 'fr' }))
    await until(async () => (await htmlLang(frame)) === 'fr', 'html lang=fr')
    await shows(frame, lang.fr['app.empty.addVideo'], 'fr app.empty.addVideo')
    assert.equal(await frame.getByText(lang.de['app.empty.addVideo'], { exact: true }).count(), 0, 'German still shown after the switch')
    // the timeline's own labels follow too (an aria-label, not text)
    assert.ok(await frame.locator(`[aria-label="${lang.fr['timeline.aria.timeline']}"]`).count() > 0, 'timeline aria-label in French')
    await noRawKeys(frame, 'video/fr')
    await ctx.close()
  })

  await step('the audio editor opens in Russian', async () => {
    const { ctx, frame } = await open('audio', 'ru')
    await until(async () => (await htmlLang(frame)) === 'ru', 'html lang=ru')
    await shows(frame, lang.ru['app.empty.addRecording'], 'app.empty.addRecording')
    await shows(frame, lang.ru['app.empty.music'], 'app.empty.music')
    await noRawKeys(frame, 'audio/ru')
    await ctx.close()
  })

  await step('the Ad Wizard opens in Japanese', async () => {
    const { ctx, page, frame } = await open('ads', 'ja')
    await until(async () => (await htmlLang(frame)) === 'ja', 'html lang=ja')
    await shows(frame, lang.ja['adwizard.steps.format'], 'adwizard.steps.format')
    await noRawKeys(frame, 'ads/ja')
    await shot(page, 'ads-ja')
    await ctx.close()
  })

  await step('a language 3Speak does not ship falls back to English', async () => {
    const { ctx, frame } = await open('video', 'xx')
    await until(async () => (await htmlLang(frame)) === 'en', 'html lang=en')
    await shows(frame, lang.en['app.empty.addVideo'], 'en app.empty.addVideo')
    await ctx.close()
  })

  for (const [mode, code] of [['video', 'de'], ['audio', 'ru'], ['ads', 'de']]) {
    await step(`phone, ${mode} editor in ${code}: no sideways scrolling with the longer words`, async () => {
      const { ctx, page, frame } = await open(mode, code, { width: 390, height: 844 })
      await until(async () => (await htmlLang(frame)) === code, `html lang=${code}`)
      await sleep(500)
      const { sw, w } = await frame.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }))
      assert.ok(sw <= w + 1, `page is ${sw}px wide in a ${w}px frame`)
      await noRawKeys(frame, `${mode}/${code} phone`)
      await shot(page, `phone-${mode}-${code}`)
      await ctx.close()
    })
  }

  await step('no missing keys were asked for', async () => {
    assert.deepEqual(missingKeys, [])
  })
} finally {
  await browser.close()
  for (const s of servers) s.close()
  for (const c of children) c.kill('SIGTERM')
  if (!process.env.KEEP_E2E) fs.rmSync(S, { recursive: true, force: true })
  else console.log(`kept ${S}`)
  const relevant = consoleErrors.filter(e => !/favicon|ERR_ABORTED|net::ERR_BLOCKED|by-hash|status of (401|404|409)/.test(e))
  console.log(`\nconsole errors: ${relevant.length}`)
  for (const e of relevant.slice(0, 15)) console.log('  ' + e.slice(0, 300))
  console.log(`\n${results.filter(r => r[0] === 'PASS').length}/${results.length} steps passed`)
  if (relevant.length || results.some(r => r[0] === 'FAIL')) process.exitCode = 1
}
