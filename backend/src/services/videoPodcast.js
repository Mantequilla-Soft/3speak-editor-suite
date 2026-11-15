import { cleanAudiogramStyle, waveFilter, CIRCLE_WAVES } from './audiogram.js'
import { logoBox, LOGO_STYLES } from './audiogramPage.js'
import { buildAss, subtitleCues, MAX_CAPTION_WORDS } from '../utils/captions.js'

/**
 * Video podcast: a whole episode as a 16:9 video (1920x1080) for 3Speak and
 * for YouTube / Spotify video podcasts, drawn by the audiogram engine: the
 * still parts (background, cover, title, line, logo) from the audiogram page
 * (services/audiogramPage.js), the moving waveform from ffmpeg between them,
 * and over everything, with libass, the captions (the episode's words, E4
 * word timings) and the name of whoever is speaking (from the voice tracks'
 * loudness, worked out in the editor, utils/speakers.js there).
 *
 * Episodes run to hours, so it is one streaming ffmpeg run at a low frame rate
 * (15 or 24 fps): the stills loop, the waveform is drawn as the audio goes by,
 * memory stays flat whatever the length.
 */

export const PODCAST_SIZE = { w: 1920, h: 1080 }
export const PODCAST_FPS = [15, 24]
export const DEFAULT_PODCAST_FPS = 15
export const VIDEO_PODCAST_MAX_SECONDS = Math.max(60, parseInt(process.env.VIDEO_PODCAST_MAX_SECONDS, 10) || 3 * 60 * 60)
export const MAX_SPEAKERS = 8
export const PODCAST_LINE = 'Watch and listen on *3speak.tv*'
export const MAX_SPEAKER_SEGMENTS = 20000
export const MAX_PODCAST_WORDS = 60000
const CAPTION_CHUNK = Math.min(3500, MAX_CAPTION_WORDS)
const SPEAKER_NAME_MAX = 40

// Where things go, px of the 1920x1080 frame. With a cover: the cover card on
// the left, the text column on the right; without one: one centred column.
// `speaker`: the top centre of the speaker's name (ASS alignment 8), under the line.
export const PODCAST_LAYOUTS = {
  cover: {
    cover: { x: 150, y: 190, w: 620, h: 620, z: 1 },
    logo: { x: 900, y: 170, w: 360, h: 72, z: 20 },
    title: { x: 900, y: 270, w: 870, h: 250, z: 3 },
    line: { x: 900, y: 540, w: 870, h: 56, z: 4 },
    wave: { x: 900, y: 690, w: 870, h: 150, z: 2 },
    speaker: { x: 1335, y: 616, align: 8 }
  },
  plain: {
    cover: { x: 650, y: 190, w: 620, h: 620, z: 1, on: false },
    logo: { x: 780, y: 120, w: 360, h: 72, z: 20 },
    title: { x: 260, y: 230, w: 1400, h: 250, z: 3 },
    line: { x: 260, y: 500, w: 1400, h: 56, z: 4 },
    wave: { x: 260, y: 680, w: 1400, h: 170, z: 2 },
    speaker: { x: 960, y: 594, align: 8 }
  }
}

// The captions of a video podcast: karaoke, five words, near the bottom, not in capitals
export const PODCAST_CAPTION_STYLE = Object.freeze({ preset: 'karaoke', font: 'Poppins', size: 4.4, y: 89, color: '#ffffff', highlight: '#ffd60a', uppercase: false, emoji: false, wordsPerPage: 5 })

/** The layers of the page for this look: { logo, cover, title, line, wave }, each { x, y, w, h, z, r, on }. */
export function podcastLayers(withCover, logoStyle = 'full') {
  const set = PODCAST_LAYOUTS[withCover ? 'cover' : 'plain']
  const out = {}
  for (const id of ['logo', 'cover', 'title', 'line', 'wave']) out[id] = { r: 0, on: true, ...set[id] }
  if (!withCover) out.cover.on = false
  const s = LOGO_STYLES[logoStyle] ? logoStyle : 'full'
  const l = out.logo
  out.logo = { ...l, ...logoBox(s, { cx: l.x + l.w / 2, cy: l.y + l.h / 2, h: LOGO_STYLES[s].defaultH * 0.9 }, PODCAST_SIZE), z: 20 }
  return out
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN)
const cleanName = (v) => String(v ?? '').replace(/[\r\n\t{}\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SPEAKER_NAME_MAX)

/** Who speaks when: [{ start, end, name }] in order, not overlapping, at most MAX_SPEAKERS names. */
export function cleanSpeakers(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const names = new Set()
  for (const s of list.slice(0, MAX_SPEAKER_SEGMENTS)) {
    if (!s || typeof s !== 'object') continue
    const start = num(s.start)
    const end = num(s.end)
    const name = cleanName(s.name)
    if (!name || !(start >= 0) || !(end > start)) continue
    if (!names.has(name)) {
      if (names.size >= MAX_SPEAKERS) continue
      names.add(name)
    }
    out.push({ start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100, name })
  }
  out.sort((a, b) => a.start - b.start)
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) out[i - 1].end = out[i].start
  return out.filter(s => s.end > s.start)
}

/** Caption words, checked: [{ text, start, end }] in order, a limited number. */
export function cleanWords(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const w of list.slice(0, MAX_PODCAST_WORDS)) {
    const start = num(w?.start)
    const end = num(w?.end)
    const text = String(w?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!text || !(start >= 0) || !(end >= start)) continue
    out.push({ text, start, end })
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * Checked options of a video podcast:
 * { title, line, style, fps, captions: { on, language, words }, speakers } or { error }.
 */
export function cleanVideoPodcastOptions(body = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const style = cleanAudiogramStyle({ ...(b.style || {}), format: 'vertical' })
  const fps = PODCAST_FPS.includes(Number(b.fps)) ? Number(b.fps) : DEFAULT_PODCAST_FPS
  const c = b.captions && typeof b.captions === 'object' ? b.captions : {}
  const language = typeof c.language === 'string' && /^[a-z]{2,3}$|^auto$/.test(c.language) ? c.language : 'auto'
  return {
    title: String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    line: typeof b.line === 'string' ? b.line.replace(/\s+/g, ' ').trim().slice(0, 120) : PODCAST_LINE,
    style: { wave: style.wave, background: { image: style.background.image, imageLayout: 'card' }, logo: style.logo },
    fps,
    captions: { on: c.on === true, language, words: cleanWords(c.words) },
    speakers: cleanSpeakers(b.speakers)
  }
}

/** What the audiogram page draws for this video podcast (its applyAudiogram state). */
export function podcastPageState({ title, line, style, image }) {
  return {
    width: PODCAST_SIZE.w,
    height: PODCAST_SIZE.h,
    layers: podcastLayers(!!image, style.logo),
    title,
    line,
    image: image || null,
    imageLayout: 'card',
    wave: style.wave,
    logo: style.logo
  }
}

const bgr = (hex) => { const h = hex.replace('#', '').toUpperCase(); return `${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}` }
const assTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100))
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/**
 * The ASS file of a video podcast: the captions (the shared caption code, in
 * chunks, since it pages a few thousand words at a time) and the speaker's
 * name as a red label (style Spk) while they speak. null when there is neither.
 */
export function podcastAss({ words = [], speakers = [], withCover = true, language = null }) {
  if (!words.length && !speakers.length) return null
  const frame = { width: PODCAST_SIZE.w, height: PODCAST_SIZE.h }
  const chunks = []
  for (let i = 0; i < words.length; i += CAPTION_CHUNK) chunks.push(words.slice(i, i + CAPTION_CHUNK))
  const head = buildAss(chunks.length ? { words: chunks[0], language, style: PODCAST_CAPTION_STYLE } : null, frame)
    .split('\n').filter(l => !l.startsWith('Dialogue:') && l !== '')
  const events = chunks.flatMap(ch => buildAss({ words: ch, language, style: PODCAST_CAPTION_STYLE }, frame).split('\n').filter(l => l.startsWith('Dialogue:')))
  const at = PODCAST_LAYOUTS[withCover ? 'cover' : 'plain'].speaker
  // the 3Speak red box (BorderStyle 3: the outline colour fills a box), white Roboto
  const spk = `Style: Spk,Roboto,40,&H00FFFFFF,&H00FFFFFF,&H00${bgr('#e32933')},&H00${bgr('#e32933')},-1,0,0,0,100,100,0,0,3,10,0,${at.align},0,0,0,1`
  const out = []
  for (const l of head) {
    out.push(l)
    if (l.startsWith('Style: ')) {
      if (!chunks.length) out.pop() // no captions: only the speaker style
      out.push(spk)
    }
    if (l.startsWith('[Events]')) break
  }
  out.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')
  for (const s of speakers) {
    const name = s.name.replace(/[{}\\]/g, '')
    out.push(`Dialogue: 1,${assTime(s.start)},${assTime(s.end)},Spk,,0,0,0,,{\\an${at.align}\\pos(${at.x},${at.y})\\fad(120,120)}${name}`)
  }
  out.push(...events)
  return out.join('\n') + '\n'
}

const pad = (n, w = 2) => String(n).padStart(w, '0')
const cueTime = (seconds, sep) => {
  const ms = Math.max(0, Math.round(seconds * 1000))
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}${sep}${pad(ms % 1000, 3)}`
}

/** The words as subtitle cues (the shared rules, chunk by chunk) and their WebVTT and SRT text. */
export function podcastSubtitles(words, language = null) {
  const cues = []
  for (let i = 0; i < words.length; i += CAPTION_CHUNK) cues.push(...subtitleCues({ words: words.slice(i, i + CAPTION_CHUNK), language, style: PODCAST_CAPTION_STYLE }))
  const text = (t) => t.replace(/-->/g, '->')
  return {
    cues,
    vtt: 'WEBVTT\n\n' + cues.map(q => `${cueTime(q.start, '.')} --> ${cueTime(q.end, '.')}\n${text(q.text)}\n\n`).join(''),
    srt: cues.map((q, i) => `${i + 1}\n${cueTime(q.start, ',')} --> ${cueTime(q.end, ',')}\n${text(q.text)}\n\n`).join('')
  }
}

// A path inside a quoted filter option: no quotes, so nothing can break out
const quoted = (p) => {
  if (/['\n]/.test(p)) throw new Error(`Unusable path for a filter: ${p}`)
  return `'${p}'`
}

/**
 * ffmpeg arguments: the whole episode (input 0), the still under the waveform
 * (input 1), the one over it (input 2, or none), the round waveform's maps,
 * the waveform at `box`, the ASS file (or none) on top. `duration` seconds.
 */
export function videoPodcastArgs({ input, below, above = null, box, maps = null, ass = null, fontsDir = null, output, duration, fps = DEFAULT_PODCAST_FPS, style }) {
  const round = CIRCLE_WAVES.includes(style.wave.type)
  const mapsIn = 2 + (above ? 1 : 0)
  const fade = Math.min(1, duration / 10).toFixed(3)
  const parts = [`[1:v]fps=${fps},format=yuv420p[bg]`]
  let v = 'bg'
  if (box && (!round || maps)) {
    parts.push('[0:a]asplit=2[aw][ao]')
    if (round) {
      parts.push(
        `[aw]aformat=channel_layouts=mono,${waveFilter(style.wave.type, box.w, box.h, style.wave.color, fps)}[strip]`,
        `[strip][${mapsIn}:v][${mapsIn + 1}:v]remap=fill=black@0,format=rgba[w0]`
      )
    } else {
      parts.push(`[aw]aformat=channel_layouts=mono,${waveFilter(style.wave.type, box.w, box.h, style.wave.color, fps)}[w0]`)
    }
    parts.push(`[${v}][w0]overlay=x=${box.cx}-overlay_w/2:y=${box.cy}-overlay_h/2:shortest=1[bw]`)
    v = 'bw'
  } else {
    parts.push('[0:a]anull[ao]')
  }
  if (above) {
    parts.push(`[2:v]fps=${fps},format=rgba[top]`, `[${v}][top]overlay=x=0:y=0:shortest=1[bt]`)
    v = 'bt'
  }
  if (ass) {
    parts.push(`[${v}]ass=filename=${quoted(ass)}${fontsDir ? `:fontsdir=${quoted(fontsDir)}` : ''}[cap]`)
    v = 'cap'
  }
  parts.push(`[${v}]fade=t=in:st=0:d=${fade},format=yuv420p[v]`, '[ao]anull[a]')
  const still = (file) => ['-loop', '1', '-framerate', String(fps), '-t', String(duration), '-i', file]
  return [
    '-hide_banner', '-loglevel', 'error',
    '-i', input,
    ...still(below),
    ...(above ? still(above) : []),
    ...(box && round && maps ? ['-i', maps.x, '-i', maps.y] : []),
    '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', '[a]',
    // mostly still pictures: a keyframe every 10 s keeps it small and seekable
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', String(fps * 10), '-r', String(fps), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-movflags', '+faststart', '-t', String(duration), '-y', output
  ]
}
