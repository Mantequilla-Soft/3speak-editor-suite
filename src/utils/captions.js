// Auto captions: words with their times -> what stands on screen when, shared
// by the preview (src/) and the burn-in render (backend/src/). Kept
// byte-identical in src/utils/ and backend/src/utils/ (node
// scripts/check-static-mask-sync.mjs checks it), so the render shows exactly
// the pages, lines and highlights the preview showed.
//
// captions: { words: [{ text, start, end, emoji? }], language, style }
//   words   timeline seconds (from speech-to-text, then fixed by hand); emoji
//           = a Noto emoji code point ('1f525') shown above the words, or none
//   style   { preset, font, size, y, color, highlight, uppercase, emoji, wordsPerPage }
//     preset        'karaoke': a few words at a time, the one being said in the highlight colour
//                   'pop':     one (or a few) words at a time, popping in
//                   'plain':   subtitle lines on a dark box
//     size          font size, % of the frame height
//     y             centre of the caption block, % of the frame height from the top
//     emoji         true: words with an emoji show it above the caption
//     wordsPerPage  karaoke 2..5, pop 1..3 (plain: as many as fit two lines)

export const CAPTION_PRESETS = ['karaoke', 'pop', 'plain']

// The fonts captions offer (all in the editor's Google Fonts and in the backend
// image). Metrics from the font files (units per em = 1): `line` is libass's
// line height (usWinAscent + usWinDescent, which is what an ASS font size
// measures), `shift` moves the ASS text so its baseline lands where the
// browser puts it (CSS uses the hhea metrics), `char` is an average character
// width for line breaking (upper case / mixed case).
export const CAPTION_FONTS = {
  Poppins: { weight: 700, line: 1.762, shift: 0.096, char: [0.74, 0.62] },
  Anton: { weight: 400, line: 1.7334, shift: -0.114, char: [0.5, 0.45] },
  'Bebas Neue': { weight: 400, line: 1.3, shift: 0, char: [0.42, 0.42] },
  Bangers: { weight: 400, line: 1.757, shift: -0.1715, char: [0.56, 0.56] },
  'Archivo Black': { weight: 400, line: 1.347, shift: -0.0275, char: [0.78, 0.66] },
  'Titan One': { weight: 400, line: 1.145, shift: 0, char: [0.72, 0.62] }
}

// Highlight / text colours on offer (the burn-in takes any #rrggbb)
export const CAPTION_COLORS = ['#ffffff', '#ffd60a', '#e53935', '#39ff14', '#4fc3f7', '#ff7ab6']

export const DEFAULT_CAPTION_STYLE = {
  preset: 'karaoke',
  font: 'Poppins',
  size: 4.5,
  y: 68,
  color: '#ffffff',
  highlight: '#ffd60a',
  uppercase: true,
  emoji: false,
  wordsPerPage: 3
}

export const MAX_CAPTION_WORDS = 4000
const MAX_WORD_CHARS = 40
const PAGE_GAP = 0.7 // seconds of silence that start a new page
const HOLD = 0.25 // a page stays this long after its last word
const BRIDGE = 0.35 // pages this close follow each other without a blank in between
const OUTLINE = 0.09 // outline width, em
const POP_MS = 120

const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d)
const HEX = /^#[0-9a-f]{6}$/i
const EMOJI_CP = /^[0-9a-f]{4,5}$/
const round3 = (t) => Math.round(t * 1000) / 1000

export function normalizeCaptionStyle(style) {
  const s = style && typeof style === 'object' ? style : {}
  const d = DEFAULT_CAPTION_STYLE
  const preset = CAPTION_PRESETS.includes(s.preset) ? s.preset : d.preset
  return {
    preset,
    font: CAPTION_FONTS[s.font] ? s.font : d.font,
    size: clamp(s.size, 2.5, 9, d.size),
    y: clamp(s.y, 8, 92, d.y),
    color: HEX.test(s.color) ? s.color.toLowerCase() : d.color,
    highlight: HEX.test(s.highlight) ? s.highlight.toLowerCase() : d.highlight,
    uppercase: s.uppercase === undefined ? d.uppercase : !!s.uppercase,
    emoji: !!s.emoji,
    wordsPerPage: Math.round(clamp(s.wordsPerPage, preset === 'pop' ? 1 : 2, preset === 'pop' ? 3 : 5, preset === 'pop' ? 1 : d.wordsPerPage))
  }
}

/** One word as captions keep it, or null (empty / unusable). */
function cleanWord(w) {
  if (!w || typeof w !== 'object') return null
  const text = String(w.text ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_WORD_CHARS)
  const start = +w.start
  if (!text || !Number.isFinite(start) || start < 0) return null
  let end = +w.end
  if (!Number.isFinite(end) || end <= start) end = start + 0.2
  const out = { text, start: round3(start), end: round3(end) }
  // a code point, or '' = no emoji (chosen by hand: no suggestion either)
  if (typeof w.emoji === 'string' && (w.emoji === '' || EMOJI_CP.test(w.emoji))) out.emoji = w.emoji
  return out
}

/** Captions as stored and rendered: words cleaned and in order, style complete. Null without words. */
export function normalizeCaptions(captions) {
  if (!captions || typeof captions !== 'object' || !Array.isArray(captions.words)) return null
  const words = captions.words.slice(0, MAX_CAPTION_WORDS).map(cleanWord).filter(Boolean).sort((a, b) => a.start - b.start)
  if (!words.length) return null
  const language = typeof captions.language === 'string' && /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(captions.language) ? captions.language.toLowerCase() : null
  return { words, language, style: normalizeCaptionStyle(captions.style) }
}

/**
 * Word timings from whisper.cpp's JSON (`-ml 1 -sow -oj`: one segment per
 * word, offsets in ms). Pieces without a leading space continue the word
 * before (punctuation, split tokens); non-speech marks ([BLANK_AUDIO], (music),
 * music notes) are dropped. `offset` (seconds) is added to every time.
 */
export function parseWhisperJson(json, offset = 0) {
  const segments = Array.isArray(json?.transcription) ? json.transcription : []
  const words = []
  for (const seg of segments) {
    const raw = String(seg?.text ?? '')
    const text = raw.trim()
    if (!text) continue
    if (/^[[(*].*[\])*]$/.test(text) || /^[♪♫\s]+$/.test(text)) continue
    const from = Number(seg?.offsets?.from)
    const to = Number(seg?.offsets?.to)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    const start = from / 1000 + offset
    const end = Math.max(to, from) / 1000 + offset
    const last = words[words.length - 1]
    if (last && !/^\s/.test(raw)) {
      last.text += text
      last.end = Math.max(last.end, round3(end))
      continue
    }
    words.push({ text, start: round3(start), end: round3(end) })
  }
  return words.filter(w => /[\p{L}\p{N}]/u.test(w.text))
}

const shown = (text, style) => (style.uppercase ? text.toUpperCase() : text)

/** Characters that fit on one caption line at this size (an estimate; both sides break at the same places). */
export function charsPerLine(style, { width, height }) {
  const font = CAPTION_FONTS[style.font] || CAPTION_FONTS.Poppins
  const px = (style.size / 100) * height
  const perChar = font.char[style.uppercase ? 0 : 1] * px
  return Math.max(6, Math.floor((width * 0.88) / perChar))
}

/** Words (indexes) -> lines (arrays of indexes), greedy, at most `maxLines` (the rest go on the last line). */
function wrap(indexes, words, style, cpl, maxLines = 2) {
  const lines = [[]]
  let len = 0
  for (const i of indexes) {
    const w = shown(words[i].text, style).length
    const line = lines[lines.length - 1]
    if (line.length && len + 1 + w > cpl && lines.length < maxLines) {
      lines.push([i])
      len = w
    } else {
      line.push(i)
      len += (line.length > 1 ? 1 : 0) + w
    }
  }
  return lines
}

/**
 * Pages: the groups of words on screen together, [{ start, end, lines: [[word index]] }].
 * A page ends at the word limit, when two lines are full, after a sentence
 * ends, or at a pause. It stays a moment after its last word (HOLD), and runs
 * on to the next page when that one starts right after (BRIDGE).
 */
export function captionPages(captions, frame) {
  const c = normalizeCaptions(captions)
  if (!c) return []
  const { words, style } = c
  const cpl = charsPerLine(style, frame)
  const maxWords = style.preset === 'plain' ? 12 : style.wordsPerPage
  const groups = []
  let cur = []
  let chars = 0
  words.forEach((w, i) => {
    const len = shown(w.text, style).length
    const prev = words[i - 1]
    const full = cur.length >= maxWords || (cur.length && chars + 1 + len > cpl * 2)
    const pause = prev && w.start - prev.end > PAGE_GAP
    const sentence = prev && /[.!?…]["')\]]*$/.test(prev.text)
    if (cur.length && (full || pause || sentence)) { groups.push(cur); cur = []; chars = 0 }
    chars += (cur.length ? 1 : 0) + len
    cur.push(i)
  })
  if (cur.length) groups.push(cur)
  return groups.map((g, n) => {
    const start = words[g[0]].start
    const next = groups[n + 1] ? words[groups[n + 1][0]].start : Infinity
    let end = words[g[g.length - 1]].end + HOLD
    if (next - end < BRIDGE) end = next
    end = Math.min(end, next)
    return { start, end: round3(Math.max(end, start + 0.05)), lines: wrap(g, words, style, cpl) }
  })
}

/**
 * What is on screen when: [{ start, end, page, lines: [[{ text, active }]], pop, emoji }].
 * Karaoke has one event per word (that word active), the other presets one
 * per page. `emoji`: the first emoji among the page's words (style.emoji on).
 */
export function captionEvents(captions, frame) {
  const c = normalizeCaptions(captions)
  if (!c) return []
  const { words, style } = c
  const events = []
  captionPages(c, frame).forEach((page, n) => {
    const idx = page.lines.flat()
    const emoji = style.emoji ? (idx.map(i => words[i].emoji).find(Boolean) || null) : null
    const linesWith = (active) => page.lines.map(l => l.map(i => ({ text: shown(words[i].text, style), active: i === active })))
    if (style.preset !== 'karaoke') {
      events.push({ start: page.start, end: page.end, page: n, lines: linesWith(-1), pop: style.preset === 'pop', emoji })
      return
    }
    idx.forEach((i, k) => {
      const start = k === 0 ? page.start : Math.max(page.start, words[i].start)
      const end = k === idx.length - 1 ? page.end : Math.min(page.end, Math.max(start, words[idx[k + 1]].start))
      if (end - start < 0.001) return
      events.push({ start: round3(start), end: round3(end), page: n, lines: linesWith(i), pop: false, emoji })
    })
  })
  return events
}

/** The event showing at time t (seconds), or null. */
export function captionAt(events, t) {
  let lo = 0
  let hi = events.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const e = events[mid]
    if (t < e.start) hi = mid - 1
    else if (t >= e.end) lo = mid + 1
    else return e
  }
  return null
}

/**
 * Where things go, in output pixels: font size, line height, the block's
 * centre, and the emoji's box (above the block). The preview uses the same
 * numbers as fractions of its canvas.
 */
export function captionLayout(style, { width, height }, lineCount = 1) {
  const s = normalizeCaptionStyle(style)
  const font = CAPTION_FONTS[s.font]
  const fontPx = (s.size / 100) * height
  const lineHeight = fontPx * font.line
  const centerY = (s.y / 100) * height
  const blockH = lineHeight * Math.max(1, lineCount)
  const emojiSize = Math.round(fontPx * 1.5)
  return {
    fontPx,
    lineHeight,
    outline: fontPx * OUTLINE,
    centerX: width / 2,
    centerY,
    emoji: { size: emojiSize, x: Math.round(width / 2 - emojiSize / 2), y: Math.round(Math.max(0, centerY - blockH / 2 - emojiSize - fontPx * 0.1)) }
  }
}

// ---- burn-in: ASS subtitles for ffmpeg's libass ----

// '#rrggbb' -> ASS colour: &HAABBGGRR in styles (alpha 0 = opaque), &HBBGGRR& in override tags
const bgr = (hex) => { const h = hex.replace('#', '').toUpperCase(); return `${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}` }
const assColor = (hex, alpha = 0) => `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${bgr(hex)}`
const tagColor = (hex) => `&H${bgr(hex)}&`
const assTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}
// ASS has no escape for braces and backslashes: they would start override tags
const assText = (t) => t.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')')

/** The captions as an ASS file for a width x height render (libass draws it with ffmpeg's `ass` filter). */
export function buildAss(captions, frame) {
  const c = normalizeCaptions(captions)
  const { width, height } = frame
  const style = c ? c.style : DEFAULT_CAPTION_STYLE
  const font = CAPTION_FONTS[style.font]
  const L = captionLayout(style, frame)
  const assSize = Math.round(L.fontPx * font.line * 100) / 100
  const plain = style.preset === 'plain'
  const outline = plain ? Math.round(L.fontPx * 0.22) : Math.round(L.outline * 10) / 10
  const primary = assColor(style.color)
  const outlineColor = plain ? assColor('#000000', 0x50) : assColor('#000000')
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${style.font},${assSize},${primary},${primary},${outlineColor},${assColor('#000000', 0x80)},${font.weight >= 700 ? -1 : 0},0,0,0,100,100,0,0,${plain ? 3 : 1},${outline},0,5,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  if (!c) return head.join('\n') + '\n'
  const x = Math.round(L.centerX)
  const y = Math.round(L.centerY + font.shift * L.fontPx)
  const hl = tagColor(style.highlight)
  const normal = tagColor(style.color)
  const lines = captionEvents(c, frame).map(e => {
    const body = e.lines.map(line => line.map(w => (w.active ? `{\\c${hl}}${assText(w.text)}{\\c${normal}}` : assText(w.text))).join(' ')).join('\\N')
    const pop = e.pop ? `\\fscx70\\fscy70\\t(0,${POP_MS},\\fscx100\\fscy100)` : ''
    return `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Cap,,0,0,0,,{\\an5\\pos(${x},${y})${pop}}${body}`
  })
  return [...head, ...lines].join('\n') + '\n'
}

/** Emoji overlays for the burn-in: [{ emoji, start, end, x, y, size }] (one per page that has one). */
export function emojiOverlays(captions, frame) {
  const c = normalizeCaptions(captions)
  if (!c || !c.style.emoji) return []
  const out = []
  for (const e of captionEvents(c, frame)) {
    if (!e.emoji) continue
    const last = out[out.length - 1]
    if (last && last.page === e.page) { last.end = e.end; continue }
    const box = captionLayout(c.style, frame, e.lines.length).emoji
    out.push({ page: e.page, emoji: e.emoji, start: e.start, end: e.end, x: box.x, y: box.y, size: box.size })
  }
  return out.map(({ page, ...o }) => o)
}

// ---- subtitle files (the spoken words, for players and search) ----

const CUE_CHARS = 42
const CUE_SECONDS = 6

/** The words as subtitle cues [{ start, end, text }]: up to 42 characters, split at sentences and pauses. */
export function subtitleCues(captions) {
  const c = normalizeCaptions(captions)
  if (!c) return []
  const cues = []
  let cur = null
  c.words.forEach((w, i) => {
    const prev = c.words[i - 1]
    const breakHere = !cur ||
      cur.text.length + 1 + w.text.length > CUE_CHARS ||
      w.end - cur.start > CUE_SECONDS ||
      (prev && w.start - prev.end > PAGE_GAP) ||
      (prev && /[.!?…]["')\]]*$/.test(prev.text))
    if (breakHere) {
      if (cur) cues.push(cur)
      cur = { start: w.start, end: w.end, text: w.text }
    } else {
      cur.text += ` ${w.text}`
      cur.end = w.end
    }
  })
  if (cur) cues.push(cur)
  return cues
}

const pad = (n, w = 2) => String(n).padStart(w, '0')
function cueTime(seconds, sep) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}${sep}${pad(ms % 1000, 3)}`
}
const cueText = (t) => t.replace(/-->/g, '->')

/** WebVTT of the captions' words. */
export function toVtt(captions) {
  const cues = subtitleCues(captions)
  return 'WEBVTT\n\n' + cues.map(q => `${cueTime(q.start, '.')} --> ${cueTime(q.end, '.')}\n${cueText(q.text)}\n\n`).join('')
}

/** SRT of the captions' words (the layout 3Speak's own captions use). */
export function toSrt(captions) {
  return subtitleCues(captions).map((q, i) => `${i + 1}\n${cueTime(q.start, ',')} --> ${cueTime(q.end, ',')}\n${cueText(q.text)}\n\n`).join('')
}

// ---- emoji accents ----

// Spoken word -> emoji (code points of the editor's sticker library, Noto Emoji).
// English words; other languages get emojis by hand in the words list.
export const EMOJI_WORDS = {
  love: '2764', heart: '2764', loved: '2764', lovely: '1f970',
  fire: '1f525', hot: '1f525', lit: '1f525', burn: '1f525',
  money: '1f4b0', cash: '1f4b0', rich: '1f911', coin: '1fa99', crypto: '1fa99', bitcoin: '1fa99', hive: '1f41d', bee: '1f41d',
  laugh: '1f602', funny: '1f602', lol: '1f602', haha: '1f602', joke: '1f602',
  happy: '1f600', smile: '1f60a', sad: '1f622', cry: '1f62d', crying: '1f62d',
  wow: '1f62e', amazing: '1f929', awesome: '1f929', incredible: '1f929', cool: '1f60e', crazy: '1f92a', mindblowing: '1f92f',
  think: '1f914', thinking: '1f914', idea: '1f4a1', ideas: '1f4a1', smart: '1f9e0', brain: '1f9e0',
  music: '1f3b6', song: '1f3b5', sing: '1f3a4', podcast: '1f3a7',
  party: '1f389', celebrate: '1f389', congrats: '1f38a', congratulations: '1f38a', birthday: '1f382', gift: '1f381',
  rocket: '1f680', launch: '1f680', moon: '1f319', star: '2b50', stars: '1f31f', magic: '2728',
  win: '1f3c6', winner: '1f3c6', won: '1f3c6', champion: '1f3c6', goal: '1f3af', target: '1f3af',
  clap: '1f44f', applause: '1f44f', thanks: '1f64f', thank: '1f64f', pray: '1f64f',
  yes: '2705', wrong: '274c', warning: '26a0', stop: '1f6ab',
  strong: '1f4aa', power: '26a1', energy: '26a1', boom: '1f4a5', bomb: '1f4a3',
  eyes: '1f440',
  hello: '1f44b', kiss: '1f48b',
  growth: '1f4c8', crown: '1f451', king: '1f451', queen: '1f451', diamond: '1f48e', gem: '1f48e',
  ok: '1f44c', okay: '1f44c', perfect: '1f4af', hundred: '1f4af', friends: '1f91d',
  sleep: '1f634', tired: '1f971', angry: '1f621', scared: '1f631', scary: '1f631', ghost: '1f47b', robot: '1f916', ai: '1f916',
  dog: '1f436', cat: '1f431', pizza: '1f355', burger: '1f354', coffee: '2615', beer: '1f37a', delicious: '1f60b', yummy: '1f60b',
  sun: '2600', sunny: '2600', rain: '1f327', snow: '2744', cold: '1f976', rainbow: '1f308', ocean: '1f30a', sea: '1f30a',
  game: '1f3ae', gaming: '1f3ae', phone: '1f4f1', camera: '1f4f7', video: '1f3a5', movie: '1f3ac', laptop: '1f4bb', computer: '1f4bb',
  alarm: '23f0', bell: '1f514', subscribe: '1f514', announcement: '1f4e3'
}

/** The emoji for a spoken word (by its letters, any case), or null. */
export function emojiFor(text) {
  const key = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  return Object.prototype.hasOwnProperty.call(EMOJI_WORDS, key) ? EMOJI_WORDS[key] : null
}

/** Words with emojis suggested where none was chosen (kept where one was, or removed with emoji: ''). */
export function suggestEmojis(words) {
  return (words || []).map(w => (w.emoji !== undefined ? w : (emojiFor(w.text) ? { ...w, emoji: emojiFor(w.text) } : w)))
}
