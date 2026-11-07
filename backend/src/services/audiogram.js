import fs from 'fs'

/**
 * Audiogram: a short video of a piece of an episode for sharing (feeds, Shorts,
 * Reels): flat dark background, the title, a moving waveform in the 3Speak
 * red and "3speak.tv" under it. Square (1080x1080) or vertical (1080x1920).
 * MP4, H.264 + AAC, 30 fps.
 */

export const AUDIOGRAM_MAX_SECONDS = 60
export const AUDIOGRAM_MIN_SECONDS = 3
export const AUDIOGRAM_FORMATS = {
  square: { w: 1080, h: 1080, titleY: 170, waveY: 380, waveH: 360 },
  vertical: { w: 1080, h: 1920, titleY: 420, waveY: 760, waveH: 480 }
}
const BG = '0x0f0f0f'
const WAVE = '0xff5252'
const MUTED = '0x9e9e9e'
const FPS = 30

// First font that exists (Noto covers the most scripts), else fontconfig's sans
const FONT_FILES = [
  '/usr/share/fonts/noto/NotoSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'
]
export function fontOption() {
  const file = FONT_FILES.find(f => { try { return fs.statSync(f).isFile() } catch { return false } })
  return file ? `fontfile=${file}` : 'font=Sans\\:style=Bold'
}

/**
 * The title as lines that fit (about `perLine` characters, at most `maxLines`,
 * the last one cut with an ellipsis). Words longer than a line are broken.
 */
export function wrapTitle(title, perLine = 20, maxLines = 3) {
  const words = String(title || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const lines = []
  let line = ''
  for (let word of words) {
    while (word.length > perLine) {
      if (line) { lines.push(line); line = '' }
      lines.push(word.slice(0, perLine))
      word = word.slice(perLine)
    }
    if (!line) line = word
    else if (line.length + 1 + word.length <= perLine) line += ` ${word}`
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, perLine - 1).trimEnd()}…`
    return kept
  }
  return lines
}

/** Checked options: { start, duration, format } or an error message. */
export function cleanAudiogramOptions(body = {}) {
  const start = Number(body.start)
  const duration = Number(body.duration)
  const format = AUDIOGRAM_FORMATS[body.format] ? body.format : 'square'
  if (!Number.isFinite(start) || start < 0) return { error: 'start must be 0 or more seconds' }
  if (!Number.isFinite(duration) || duration < AUDIOGRAM_MIN_SECONDS || duration > AUDIOGRAM_MAX_SECONDS) {
    return { error: `duration must be ${AUDIOGRAM_MIN_SECONDS} to ${AUDIOGRAM_MAX_SECONDS} seconds` }
  }
  return { start: Math.round(start * 1000) / 1000, duration: Math.round(duration * 1000) / 1000, format }
}

/**
 * ffmpeg arguments: the audio from `start` for `duration`, over a colour
 * background with the waveform and the text (from `titleFile`, so nothing in
 * the title needs escaping).
 */
export function audiogramArgs({ input, output, start, duration, format, titleFile, hasTitle = true, font = fontOption() }) {
  const f = AUDIOGRAM_FORMATS[format] || AUDIOGRAM_FORMATS.square
  const waveW = f.w - 120
  const fade = Math.min(0.5, duration / 4).toFixed(3)
  const parts = [
    `color=c=${BG}:s=${f.w}x${f.h}:r=${FPS}:d=${duration}[bg]`,
    '[0:a]asplit=2[aw][ao]',
    `[aw]aformat=channel_layouts=mono,showwaves=s=${waveW}x${f.waveH}:mode=cline:rate=${FPS}:colors=${WAVE}:scale=sqrt:draw=full[wave]`,
    `[bg][wave]overlay=x=60:y=${f.waveY}:shortest=1${hasTitle ? `,drawtext=${font}:textfile='${titleFile}':fontsize=72:fontcolor=white:line_spacing=14:text_align=C:x=(w-text_w)/2:y=${f.titleY}` : ''}` +
      `,drawtext=${font}:text='3speak.tv':fontsize=40:fontcolor=${MUTED}:x=(w-text_w)/2:y=h-${format === 'vertical' ? 360 : 140}` +
      `,fade=t=in:st=0:d=${fade},fade=t=out:st=${(duration - +fade).toFixed(3)}:d=${fade},format=yuv420p[v]`,
    `[ao]afade=t=in:st=0:d=${fade},afade=t=out:st=${(duration - +fade).toFixed(3)}:d=${fade}[a]`
  ]
  return [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(start), '-t', String(duration), '-i', input,
    '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-movflags', '+faststart', '-t', String(duration), '-y', output
  ]
}
