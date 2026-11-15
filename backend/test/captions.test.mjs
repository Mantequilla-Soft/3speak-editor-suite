// Auto captions: whisper word times -> pages / highlights -> ASS burn-in, emoji
// overlays and WebVTT / SRT files; the speech-to-text route degrades cleanly
// when whisper is not installed. A real render checks the burn-in and the
// 1080x1920 output; a real whisper run happens when WHISPER_TEST_BIN and
// WHISPER_TEST_MODEL point at a whisper-cli and a model (skipped otherwise).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captions-'))
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
process.env.WORK_DIR = path.join(dir, 'work')
process.env.RENDERED_DIR = path.join(dir, 'rendered')
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
process.env.WHISPER_BIN = path.join(dir, 'no-whisper-here')
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true })

const C = await import('../src/utils/captions.js')
const { whisperArgs, hasAssFilter, transcribeWav, toWav } = await import('../src/services/stt.js')
const { emojiDownloads, writeSubtitleFiles, emojiKey } = await import('../src/services/captionBurn.js')
const { buildAndRunFFmpeg } = await import('../src/services/ffmpeg.js')
const express = (await import('express')).default
const { captionsRouter } = await import('../src/routes/captions.js')

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const canBurn = hasFfmpeg && await hasAssFilter()

const FRAME = { width: 1080, height: 1920 }
const seg = (from, to, text) => ({ offsets: { from, to }, text })
const WHISPER = {
  result: { language: 'en' },
  transcription: [
    seg(0, 0, ''), seg(0, 400, ' Hello'), seg(400, 420, ','), seg(420, 900, ' badadib'),
    seg(900, 1300, ' fans'), seg(1300, 1340, '.'), seg(1400, 1500, ' [BLANK_AUDIO]'),
    seg(2600, 3000, ' This'), seg(3000, 3300, ' is'), seg(3300, 3600, ' on'), seg(3600, 4100, ' fire'), seg(4100, 4500, ' today')
  ]
}
const words = C.parseWhisperJson(WHISPER)
const caps = (style = {}) => ({ words: C.suggestEmojis(words), language: 'en', style })

let server, base
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/captions', captionsRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

test('whisper JSON -> words: pieces joined, punctuation kept, non-speech dropped', () => {
  assert.deepEqual(words.map(w => w.text), ['Hello,', 'badadib', 'fans.', 'This', 'is', 'on', 'fire', 'today'])
  assert.deepEqual(words[0], { text: 'Hello,', start: 0, end: 0.42 })
  assert.equal(words[6].start, 3.6)
  assert.deepEqual(C.parseWhisperJson(WHISPER, 10)[0], { text: 'Hello,', start: 10, end: 10.42 })
  assert.deepEqual(C.parseWhisperJson({}), [])
})

test('normalizeCaptions: cleans words and clamps the style', () => {
  const c = C.normalizeCaptions({ words: [{ text: ' b ', start: 2, end: 1 }, { text: '', start: 0, end: 1 }, { text: 'a', start: 1, end: 1.5, emoji: 'nope' }], style: { size: 99, y: -5, preset: 'x', color: 'red' } })
  assert.deepEqual(c.words, [{ text: 'a', start: 1, end: 1.5 }, { text: 'b', start: 2, end: 2.2 }])
  assert.equal(c.style.size, 9)
  assert.equal(c.style.y, 8)
  assert.equal(c.style.preset, 'karaoke')
  assert.equal(c.style.color, '#ffffff')
  assert.equal(C.normalizeCaptions({ words: [] }), null)
  assert.equal(C.normalizeCaptionStyle({ preset: 'pop' }).wordsPerPage, 1)
})

test('karaoke: pages break at sentences and pauses, one event per word with that word active', () => {
  const pages = C.captionPages(caps({ preset: 'karaoke', wordsPerPage: 3 }), FRAME)
  assert.deepEqual(pages.map(p => p.lines.flat()), [[0, 1, 2], [3, 4, 5], [6, 7]])
  // a page holds a moment after its last word; the next page starts on its first word
  assert.equal(pages[0].end, 1.59)
  assert.equal(pages[2].start, 3.6)
  const events = C.captionEvents(caps({ preset: 'karaoke' }), FRAME)
  const firstPage = events.filter(e => e.page === 0)
  assert.equal(firstPage.length, 3)
  assert.deepEqual(firstPage.map(e => e.lines.flat().findIndex(w => w.active)), [0, 1, 2])
  assert.equal(firstPage[0].lines.flat()[0].text, 'HELLO,', 'upper case by default')
  assert.equal(C.captionAt(events, 0.5).lines.flat()[1].active, true)
  assert.equal(C.captionAt(events, 2), null, 'nothing in the pause')
})

test('pop: one word at a time, popping in; plain: whole lines, nothing highlighted', () => {
  const pop = C.captionEvents(caps({ preset: 'pop' }), FRAME)
  assert.equal(pop.length, words.length)
  assert.ok(pop.every(e => e.pop && e.lines.flat().length === 1 && !e.lines.flat()[0].active))
  const plain = C.captionEvents(caps({ preset: 'plain', uppercase: false }), FRAME)
  assert.deepEqual(plain.map(e => e.lines.flat().map(w => w.text).join(' ')), ['Hello, badadib fans.', 'This is on fire today'])
  assert.ok(plain.every(e => !e.pop))
})

test('ASS: frame size, font, colours, highlight tags and pop animation', () => {
  const ass = C.buildAss(caps({ preset: 'karaoke', highlight: '#e53935', font: 'Anton' }), FRAME)
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/)
  // Anton at 4.5% of 1920 (86.4 px em) = 149.77 as an ASS size (line height 1.7334 em)
  assert.match(ass, /^Style: Cap,Anton,149\.77,&H00FFFFFF,/m)
  const dialogue = ass.split('\n').filter(l => l.startsWith('Dialogue:'))
  assert.equal(dialogue.length, 8)
  assert.match(dialogue[0], /^Dialogue: 0,0:00:00\.00,0:00:00\.42,Cap,,0,0,0,,\{\\an5\\pos\(540,1296\)\}\{\\c&H3539E5&\}HELLO,\{\\c&HFFFFFF&\} BADADIB/)
  const pop = C.buildAss(caps({ preset: 'pop' }), FRAME)
  assert.match(pop, /\\fscx70\\fscy70\\t\(0,120,\\fscx100\\fscy100\)\}HELLO,$/m)
  const plain = C.buildAss(caps({ preset: 'plain' }), FRAME)
  assert.match(plain, /^Style: Cap,Poppins,[\d.]+,&H00FFFFFF,&H00FFFFFF,&H50000000,&H80000000,-1,0,0,0,100,100,0,0,3,/m, 'boxed')
  // braces and backslashes cannot open override tags
  const odd = C.buildAss({ words: [{ text: '{\\b1}x', start: 0, end: 1 }] }, FRAME)
  assert.match(odd, /\(\/B1\)X/)
})

test('emoji accents: suggested from words, one overlay per page above the text', () => {
  assert.equal(C.emojiFor('Fire!'), '1f525')
  assert.equal(C.emojiFor('table'), null)
  const withEmoji = caps({ preset: 'karaoke', emoji: true })
  assert.equal(withEmoji.words[6].emoji, '1f525')
  assert.equal(withEmoji.words[0].emoji, '1f44b', 'hello waves')
  const o = C.emojiOverlays(withEmoji, FRAME)
  assert.deepEqual(o.map(x => [x.emoji, x.start, x.end]), [['1f44b', 0, 1.59], ['1f525', 3.6, 4.75]])
  const L = C.captionLayout(withEmoji.style, FRAME, 1)
  assert.ok(o[1].y + o[1].size <= L.centerY - L.lineHeight / 2, 'above the caption')
  assert.deepEqual(C.emojiOverlays(caps({ emoji: false }), FRAME), [])
  // a word set to no emoji by hand gets no suggestion
  assert.equal(C.suggestEmojis([{ text: 'fire', start: 0, end: 1, emoji: '' }])[0].emoji, '')
  // the render downloads only the emojis on screen, from http(s) or own URLs
  const timeline = { outputWidth: 1080, outputHeight: 1920, captions: { ...withEmoji, emojiUrls: { '1f525': 'https://editor.example/stickers/emoji/1f525.png', '2764': 'https://x/2764.png' } } }
  assert.deepEqual(emojiDownloads(timeline), [{ cp: '1f525', url: 'https://editor.example/stickers/emoji/1f525.png' }])
  assert.deepEqual(emojiDownloads({ ...timeline, captions: { ...timeline.captions, emojiUrls: { '1f525': 'file:///etc/passwd' } } }), [])
})

test('subtitle files: WebVTT and SRT cues in the spoken case', async () => {
  const vtt = C.toVtt(caps({ uppercase: true }))
  assert.equal(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.340\nHello, badadib fans.\n\n00:00:02.600 --> 00:00:04.500\nThis is on fire today\n\n')
  assert.equal(C.toSrt(caps()), '1\n00:00:00,000 --> 00:00:01,340\nHello, badadib fans.\n\n2\n00:00:02,600 --> 00:00:04,500\nThis is on fire today\n\n')
  const out = fs.mkdtempSync(path.join(dir, 'subs-'))
  const r = await writeSubtitleFiles({ captions: caps() }, out, 'job1')
  assert.deepEqual([r.language, r.vtt, r.srt, r.cues.length], ['en', 'job1.vtt', 'job1.srt', 2])
  assert.equal(fs.readFileSync(path.join(out, 'job1.vtt'), 'utf8'), vtt)
  assert.equal(await writeSubtitleFiles({ output: 'audio', captions: caps() }, out, 'x'), null)
})

test('whisper arguments: word segments, JSON, known language or auto', () => {
  const a = whisperArgs({ model: '/m.bin', threads: 2 }, '/a.wav', '/a', 'de')
  assert.deepEqual(a, ['-m', '/m.bin', '-f', '/a.wav', '-t', '2', '-l', 'de', '-ml', '1', '-sow', '-oj', '-of', '/a', '-np', '-pp'])
  assert.equal(whisperArgs({ model: 'm', threads: 1 }, 'a', 'a', 'xx; rm')[7], 'auto')
})

test('without whisper: status says unavailable and transcribe answers 503', async () => {
  const s = await (await fetch(`${base}/api/captions/status`)).json()
  assert.equal(s.available, false)
  assert.equal(s.reason, 'no-binary')
  assert.ok(s.languages.includes('auto'))
  const mid = Buffer.from(JSON.stringify({ u: 'badadib', exp: Date.now() + 60000 })).toString('base64url')
  const token = `v1.${mid}.${crypto.createHmac('sha256', 'test-secret').update(mid).digest('hex')}`
  const r = await fetch(`${base}/api/captions/transcribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ timeline: { tracks: [] } }) })
  assert.equal(r.status, 503)
  assert.equal((await r.json()).code, 'unavailable')
  assert.equal((await fetch(`${base}/api/captions/transcribe`, { method: 'POST' })).status, 401)
})

// ---- real renders ----

const probe = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim()
const frameAt = (f, t) => execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 << 20 })
// how many pixels of a band differ between two frames
const changed = (a, b, y0, y1, w = 1080) => { let n = 0; for (let i = y0 * w; i < y1 * w; i++) if (Math.abs(a[i] - b[i]) > 40) n++; return n }

async function render(name, captions) {
  const work = fs.mkdtempSync(path.join(dir, `job-${name}-`))
  const src = path.join(dir, 'portrait.mp4')
  if (!fs.existsSync(src)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x336699:s=1080x1920:r=30:d=5', '-f', 'lavfi', '-i', 'sine=d=5', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src])
  }
  const timeline = {
    outputWidth: 1080, outputHeight: 1920, previewWidth: 360, previewHeight: 640, fps: 30,
    tracks: [{ id: 't1', type: 'video', clips: [{ id: 'c1', type: 'video', url: 'x', startTime: 0, endTime: 5, duration: 5, timelinePosition: 0, audioEnabled: false }] }],
    ...(captions ? { captions } : {})
  }
  const downloaded = new Map([['c1', src]])
  if (captions?.style?.emoji) {
    const png = path.join(dir, 'emoji.png')
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=64x64', '-frames:v', '1', png])
    downloaded.set(emojiKey('1f525'), png) // (the wave of page 1 has no image: left out)
  }
  const out = path.join(dir, `${name}.mp4`)
  await buildAndRunFFmpeg({ timeline, downloadedFiles: downloaded, outputPath: out, jobDir: work, onProgress: () => {} })
  return out
}

test('a Short renders at 1080x1920 with the captions burnt in where the preview shows them', { skip: !canBurn, timeout: 180000 }, async () => {
  const plainOut = await render('plain', null)
  assert.equal(probe(plainOut), '1080,1920')
  const style = { preset: 'karaoke', y: 68, size: 4.5, emoji: true }
  const capOut = await render('captioned', caps(style))
  assert.equal(probe(capOut), '1080,1920')
  const L = C.captionLayout(C.normalizeCaptionStyle(style), FRAME, 1)
  const band = [Math.round(L.centerY - L.lineHeight), Math.round(L.centerY + L.lineHeight)]
  // 3.8 s: "THIS IS ON / FIRE TODAY" page is up (fire = active, with its emoji)
  const a = frameAt(plainOut, 3.8)
  const b = frameAt(capOut, 3.8)
  assert.ok(changed(a, b, band[0], band[1]) > 2000, 'caption text in its band')
  assert.ok(changed(a, b, 0, 1000) < 50, 'nothing above the caption and its emoji')
  const o = C.emojiOverlays(caps(style), FRAME).find(x => x.emoji === '1f525')
  assert.ok(changed(a, b, o.y + 5, o.y + o.size - 5) > o.size * 10, 'emoji drawn above the caption')
  // in the pause between the pages (2 s) there is no caption
  assert.ok(changed(frameAt(plainOut, 2), frameAt(capOut, 2), band[0], band[1]) < 50, 'no caption in the pause')
})

const WHISPER_BIN = process.env.WHISPER_TEST_BIN
const WHISPER_MODEL = process.env.WHISPER_TEST_MODEL
const SPEECH = process.env.WHISPER_TEST_AUDIO
test('a real whisper run gives words with times', { skip: !(WHISPER_BIN && WHISPER_MODEL && SPEECH), timeout: 300000 }, async () => {
  process.env.WHISPER_BIN = WHISPER_BIN
  process.env.WHISPER_MODEL = WHISPER_MODEL
  const wav = await toWav(SPEECH, path.join(dir, 'speech.wav'))
  const progress = []
  const r = await transcribeWav(wav, { durationSec: 20, onProgress: p => progress.push(p) })
  process.env.WHISPER_BIN = path.join(dir, 'no-whisper-here')
  assert.ok(r.words.length > 10, `${r.words.length} words`)
  assert.ok(r.language)
  for (let i = 1; i < r.words.length; i++) assert.ok(r.words[i].start >= r.words[i - 1].start)
  assert.ok(r.words.every(w => w.end >= w.start && w.end <= 21))
  console.log(`whisper: ${r.words.length} words, ${r.language}, first: ${JSON.stringify(r.words.slice(0, 3))}, progress steps ${progress.length}`)
})
