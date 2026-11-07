import { spawn } from 'child_process'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { RENDER_CACHE_DIR } from './ffmpeg.js'

/**
 * Audio mode render (podcasts, music, voice): the timeline's audio tracks
 * mixed into one MP3. No picture is made at all.
 *
 * 1. Every clip is cut from its source into a lossless segment (FLAC, 48 kHz
 *    stereo) with its fades and volume. FLAC, not AAC: AAC adds encoder delay
 *    to every piece, and a podcast after "Cut silences" has hundreds of them,
 *    so the timing would drift. Segments are cached like the video clips.
 * 2. Each track becomes one continuous stream: silence for the gaps, its
 *    segments in order, read through ffmpeg's concat demuxer (nothing is
 *    written out at full length). Clips that overlap on one track go to an
 *    extra lane of that track.
 * 3. The lanes are mixed as they are (amix normalize=0, like the video render)
 *    with a limiter against clipping.
 * 4. Optional loudness levelling for podcasts: EBU R128 in two passes (measure,
 *    then apply linearly), -16 LUFS, true peak -1.5 dB. Then MP3.
 *
 * Optional, from the editor: auto-duck (the music tracks' lanes go down while a
 * voice talks, timeline.master.duck, worked out by the editor's utils/duck.js)
 * and chapters (timeline.chapters, written as ID3 chapter frames).
 */

export const SEGMENT_RATE = 48000
export const OUTPUT_RATE = 44100
export const MP3_BITRATE = '192k'
export const LOUDNESS_TARGET = { i: -16, tp: -1.5, lra: 11 }
const SEGMENT_CACHE_VERSION = 2
const SEGMENT_CACHE_DIR = path.join(RENDER_CACHE_DIR, 'audio-segments')
const PCM_ARGS = ['-c:a', 'flac', '-sample_fmt', 's16', '-ar', String(SEGMENT_RATE), '-ac', '2']

const clipVolume = clip => (Number.isFinite(+clip.volume) ? Math.max(0, +clip.volume) : 100) / 100
const clipLength = clip => Math.max(0, (+clip.endTime || 0) - (+clip.startTime || 0))
const round3 = n => Math.round(n * 1000) / 1000

/**
 * The clips that sound, per track, split into lanes so that no two clips of a
 * lane overlap. Returns [{ trackId, clips: [clip...] sorted by position }].
 * Muted tracks, switched-off clips and empty clips are left out (as in the preview).
 */
export function planLanes(tracks) {
  const lanes = []
  for (const track of tracks || []) {
    if (track.type !== 'audio' || track.muted === true) continue
    const clips = (track.clips || [])
      .filter(c => c.audioEnabled !== false && clipLength(c) > 0.001)
      .map(c => ({ ...c, timelinePosition: Math.max(0, +c.timelinePosition || 0) }))
      .sort((a, b) => a.timelinePosition - b.timelinePosition)
    const trackLanes = []
    for (const clip of clips) {
      // First lane whose last clip has ended by the time this one starts
      let lane = trackLanes.find(l => {
        const last = l[l.length - 1]
        return last.timelinePosition + clipLength(last) <= clip.timelinePosition + 0.0005
      })
      if (!lane) { lane = []; trackLanes.push(lane) }
      lane.push(clip)
    }
    for (const l of trackLanes) lanes.push({ trackId: track.id, clips: l })
  }
  return lanes
}

/** Where the last sounding clip ends (seconds). */
export function audioTimelineEnd(tracks) {
  let end = 0
  for (const lane of planLanes(tracks)) {
    for (const c of lane.clips) end = Math.max(end, c.timelinePosition + clipLength(c))
  }
  return end
}

/**
 * A lane as concat-demuxer entries: [{ kind: 'silence', duration } | { kind: 'clip', clip }].
 * Positions are kept exactly: each gap is the distance from where the lane got
 * to (in whole samples) to the clip's own start.
 */
export function laneEntries(lane) {
  const entries = []
  let samplesSoFar = 0
  for (const clip of lane.clips) {
    const startSample = Math.round(clip.timelinePosition * SEGMENT_RATE)
    const gap = startSample - samplesSoFar
    if (gap > 0) entries.push({ kind: 'silence', samples: gap })
    const samples = Math.max(1, Math.round(clipLength(clip) * SEGMENT_RATE))
    entries.push({ kind: 'clip', clip, samples })
    samplesSoFar = Math.max(samplesSoFar, startSample) + samples
  }
  return entries
}

/** ffmpeg filter for a clip's fades and volume (null when it needs none). */
export function segmentFilter(clip) {
  const duration = clipLength(clip)
  const parts = []
  const fi = Math.min(duration, Math.max(0, +clip.fadeIn || 0))
  const fo = Math.min(duration, Math.max(0, +clip.fadeOut || 0))
  if (fi > 0) parts.push(`afade=t=in:st=0:d=${fi.toFixed(3)}`)
  if (fo > 0) parts.push(`afade=t=out:st=${Math.max(0, duration - fo).toFixed(3)}:d=${fo.toFixed(3)}`)
  const vol = clipVolume(clip)
  if (Math.abs(vol - 1) > 0.0001) parts.push(`volume=${vol.toFixed(3)}`)
  return parts.length ? parts.join(',') : null
}

function segmentKey(clip, inputFile, samples, channels) {
  return crypto.createHash('sha256').update(JSON.stringify({
    v: SEGMENT_CACHE_VERSION,
    channels,
    input: path.basename(inputFile || ''),
    start: round3(+clip.startTime || 0),
    samples,
    filter: segmentFilter(clip)
  })).digest('hex').slice(0, 40)
}

/** The ffmpeg arguments that cut one clip into a segment of exactly `samples` samples. */
export function segmentArgs(clip, inputFile, samples, outPath, { hasAudio = true, channels = 2 } = {}) {
  if (!hasAudio) return silenceArgs(samples, outPath)
  const args = ['-hide_banner', '-loglevel', 'error']
  const start = Math.max(0, +clip.startTime || 0)
  if (start > 0) args.push('-ss', start.toFixed(6))
  args.push('-i', inputFile, '-vn')
  // Resample first so the fades and the sample count are in the segment's own rate;
  // padded and trimmed to exactly `samples` (-frames:a would count packets, not samples),
  // so it is exactly as long as the clip even if the file runs short
  // Mono goes to both sides at full level (a plain conversion treats it as a
  // centre channel and loses 3 dB); anything wider is downmixed to stereo
  const chain = [`aresample=${SEGMENT_RATE}`, channels === 1 ? 'pan=stereo|c0=c0|c1=c0' : 'aformat=channel_layouts=stereo']
  const f = segmentFilter(clip)
  if (f) chain.push(f)
  chain.push(...exactLength(samples))
  args.push('-af', chain.join(','), ...PCM_ARGS, '-y', outPath)
  return args
}

const exactLength = (samples) => [`apad=whole_len=${samples}`, `atrim=end_sample=${samples}`]

/** Digital silence of exactly `samples` samples. */
export function silenceArgs(samples, outPath) {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${SEGMENT_RATE}:cl=stereo`,
    '-af', exactLength(samples).join(','), ...PCM_ARGS, '-y', outPath]
}

/** Concat demuxer list for a lane (paths quoted for the demuxer). */
export function concatList(files) {
  return files.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

// Auto-duck limits (a plan is made by the editor; this only checks and applies it)
const MAX_DUCK_SPANS = 2000
const finite = (n) => typeof n === 'number' && Number.isFinite(n)

/**
 * timeline.master.duck checked: { gain 0..1, attack, release (s), spans [[s, e]]
 * sorted and apart, tracks [ids] } or null when absent or unusable.
 */
export function cleanDuck(duck) {
  if (!duck || typeof duck !== 'object') return null
  const { gain, attack, release } = duck
  if (!finite(gain) || gain < 0 || gain >= 1) return null
  if (!finite(attack) || !finite(release) || attack < 0.05 || attack > 5 || release < 0.05 || release > 5) return null
  if (!Array.isArray(duck.tracks) || !duck.tracks.length || !Array.isArray(duck.spans) || !duck.spans.length) return null
  if (duck.spans.length > MAX_DUCK_SPANS) return null
  const spans = []
  for (const sp of duck.spans) {
    if (!Array.isArray(sp) || !finite(sp[0]) || !finite(sp[1]) || sp[1] <= sp[0] || sp[0] < 0) return null
    const last = spans[spans.length - 1]
    // Ramps may not run into each other (the expression adds them up)
    if (last && sp[0] - attack < last[1] + release - 0.0005) {
      last[1] = Math.max(last[1], sp[1])
      continue
    }
    spans.push([sp[0], sp[1]])
  }
  return { gain, attack, release, spans, tracks: duck.tracks.map(String).slice(0, 50) }
}

const n4 = (n) => String(Math.round(n * 10000) / 10000)

/**
 * The volume expression of a ducked lane (ffmpeg `volume`, t = lane seconds):
 * 1 - (1 - gain) * sum of one trapezoid per span (ramp down over `attack`
 * before it, up over `release` after it). The editor's duckGainAt is the same.
 */
export function duckExpr({ gain, attack, release, spans }) {
  const terms = spans.map(([s, e]) => `min(clip((t-${n4(s - attack)})/${n4(attack)},0,1),clip((${n4(e + release)}-t)/${n4(release)},0,1))`)
  return `1-${n4(1 - gain)}*(${terms.join('+')})`
}

/** The filter a lane gets before the mix (null: none). 10 ms frames so the ramps are smooth. */
export function duckFilter(duck) {
  return duck ? `asetnsamples=n=480:p=0,volume=eval=frame:volume='${duckExpr(duck)}'` : null
}

// Chapters (ID3 CHAP frames through an ffmetadata file)
const MAX_CHAPTERS = 100
const metaEscape = (v) => String(v).replace(/[\\=;#\n]/g, c => (c === '\n' ? ' ' : `\\${c}`))

/** timeline.chapters checked: [{ start, end, title }] in order, inside [0, length]. */
export function cleanChapters(chapters, length) {
  if (!Array.isArray(chapters)) return []
  const out = []
  for (const c of chapters.slice(0, MAX_CHAPTERS)) {
    if (!c || !finite(c.start) || !finite(c.end)) continue
    const start = Math.max(0, c.start)
    const end = Math.min(length, c.end)
    const title = String(c.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!title || end - start < 0.5) continue
    if (out.length && start < out[out.length - 1].end - 0.001) continue
    out.push({ start, end, title })
  }
  return out
}

/** The ffmetadata text with the chapters (milliseconds). */
export function chapterMetadata(chapters) {
  let text = ';FFMETADATA1\n'
  for (const c of chapters) {
    text += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.start * 1000)}\nEND=${Math.round(c.end * 1000)}\ntitle=${metaEscape(c.title)}\n`
  }
  return text
}

/**
 * The final mix: one input per lane (concat lists), mixed, limited, optionally
 * loudness-levelled, encoded. `loudness` = null (no levelling) or the measured
 * values from the first pass ({ input_i, input_tp, input_lra, input_thresh, target_offset }).
 * `mode` 'measure' writes nothing (prints the loudnorm JSON).
 */
export function mixArgs(listFiles, outputPath, { level = false, measured = null, mode = 'encode', title = null, laneFilters = [], chaptersFile = null } = {}) {
  const args = ['-hide_banner', '-nostats']
  for (const list of listFiles) args.push('-f', 'concat', '-safe', '0', '-i', list)
  const withChapters = chaptersFile && mode !== 'measure'
  if (withChapters) args.push('-f', 'ffmetadata', '-i', chaptersFile)
  const chain = []
  // A lane with a filter of its own (the duck) goes through it first
  const pre = []
  const inputs = listFiles.map((_, i) => {
    if (!laneFilters[i]) return `[${i}:a]`
    pre.push(`[${i}:a]${laneFilters[i]}[d${i}]`)
    return `[d${i}]`
  }).join('')
  const mixed = listFiles.length > 1
    ? `${inputs}amix=inputs=${listFiles.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false`
    : `${inputs}alimiter=limit=0.95:level=false`
  chain.push(mixed)
  const { i, tp, lra } = LOUDNESS_TARGET
  if (level && mode === 'measure') {
    chain.push(`loudnorm=I=${i}:TP=${tp}:LRA=${lra}:print_format=json`)
  } else if (level && measured) {
    chain.push(`loudnorm=I=${i}:TP=${tp}:LRA=${lra}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
      `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`)
  } else if (level) {
    chain.push(`loudnorm=I=${i}:TP=${tp}:LRA=${lra}`)
  }
  chain.push(`aresample=${OUTPUT_RATE}`)
  args.push('-filter_complex', [...pre, `${chain.join(',')}[out]`].join(';'), '-map', '[out]')
  if (mode === 'measure') {
    args.push('-f', 'null', '-')
  } else {
    if (withChapters) args.push('-map_chapters', String(listFiles.length))
    if (title) args.push('-metadata', `title=${String(title).slice(0, 120)}`)
    args.push('-c:a', 'libmp3lame', '-b:a', MP3_BITRATE, '-ar', String(OUTPUT_RATE), '-id3v2_version', '3', '-y', outputPath)
  }
  return args
}

/** The loudnorm JSON block from a measuring pass's stderr (null if absent or unusable). */
export function parseLoudnorm(stderr) {
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const j = JSON.parse(stderr.slice(start, end + 1))
    const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']
    if (!keys.every(k => Number.isFinite(parseFloat(j[k])))) return null
    return Object.fromEntries(keys.map(k => [k, parseFloat(j[k])]))
  } catch {
    return null
  }
}

function run(args, signal, { timeoutMs = 60 * 60 * 1000, keepStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Job aborted'))
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => {
      stderr += d.toString()
      // The measuring pass needs its JSON at the end; nothing else needs more than a tail
      if (!keepStderr && stderr.length > 20000) stderr = stderr.slice(-4000)
    })
    const onAbort = () => { proc.kill('SIGTERM'); reject(new Error('Job aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('FFmpeg timed out')) }, timeoutMs)
    proc.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve(stderr)
      else reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-800)}`))
    })
    proc.on('error', err => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`))
    })
  })
}

// Channels of a file's first audio stream (0: it has none)
function audioChannels(file) {
  return new Promise(resolve => {
    const proc = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout.on('data', d => { out += d })
    proc.on('close', () => resolve(parseInt(out.trim(), 10) || 0))
    proc.on('error', () => resolve(0))
  })
}

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

/**
 * Render the audio timeline to `outputPath` (MP3).
 * timeline: { tracks, output: 'audio', master?: { loudness?: bool, duck? }, title?, chapters? }
 * downloadedFiles: Map clip id -> local source file.
 */
export async function renderAudioTimeline({ timeline, downloadedFiles, outputPath, jobDir, onProgress = () => {}, signal }) {
  const lanes = planLanes(timeline.tracks)
  if (!lanes.length) throw new Error('Nothing to render: the audio tracks are empty or muted')
  const level = timeline.master?.loudness !== false

  // 1. Segments (cached), plus silence for the gaps
  const allEntries = lanes.map(laneEntries)
  const clipCount = allEntries.reduce((n, e) => n + e.filter(x => x.kind === 'clip').length, 0)
  await fs.mkdir(SEGMENT_CACHE_DIR, { recursive: true })
  const audioCheck = new Map()
  let done = 0
  let reused = 0
  const listFiles = []
  for (let l = 0; l < allEntries.length; l++) {
    const files = []
    for (const entry of allEntries[l]) {
      if (signal?.aborted) throw new Error('Job aborted')
      if (entry.kind === 'silence') {
        // Cached by length: the same gap is made once
        const silence = path.join(SEGMENT_CACHE_DIR, `silence-v${SEGMENT_CACHE_VERSION}-${entry.samples}.flac`)
        if (!(await exists(silence))) {
          const part = `${silence}.${process.pid}.${Date.now()}.part.flac`
          await run(silenceArgs(entry.samples, part), signal)
          await fs.rename(part, silence)
        }
        files.push(silence)
        continue
      }
      const { clip, samples } = entry
      const input = downloadedFiles.get(clip.id) || null
      if (input && !audioCheck.has(input)) audioCheck.set(input, await audioChannels(input))
      const channels = input ? audioCheck.get(input) : 0
      const sounding = channels > 0
      if (!sounding) console.warn(`[audio-render] ${clip.name || clip.id}: no audio, silence in its place`)
      const key = segmentKey(clip, sounding ? input : 'silence', samples, channels)
      const cached = path.join(SEGMENT_CACHE_DIR, `${key}.flac`)
      if (await exists(cached)) {
        const now = new Date()
        await fs.utimes(cached, now, now).catch(() => {})
        reused++
      } else {
        const part = `${cached}.${process.pid}.${Date.now()}.part.flac`
        await run(segmentArgs(clip, input, samples, part, { hasAudio: sounding, channels }), signal)
        await fs.rename(part, cached)
      }
      files.push(cached)
      done++
      onProgress((done / clipCount) * 0.5, `Cutting clip ${done}/${clipCount}`)
    }
    const list = path.join(jobDir, `lane_${l}.txt`)
    await fs.writeFile(list, concatList(files))
    listFiles.push(list)
  }
  if (reused) console.log(`[audio-render] ${reused}/${clipCount} segments unchanged since an earlier render, reused`)

  // Auto-duck on the music tracks' lanes, chapters as metadata
  const duck = cleanDuck(timeline.master?.duck)
  const ducked = duck ? new Set(duck.tracks) : null
  const laneFilters = lanes.map(l => (ducked?.has(String(l.trackId)) ? duckFilter(duck) : null))
  const chapters = cleanChapters(timeline.chapters, audioTimelineEnd(timeline.tracks))
  let chaptersFile = null
  if (chapters.length) {
    chaptersFile = path.join(jobDir, 'chapters.txt')
    await fs.writeFile(chaptersFile, chapterMetadata(chapters))
  }

  // 2. Loudness: measure the mix first
  let measured = null
  if (level) {
    onProgress(0.55, 'Measuring loudness...')
    const stderr = await run(mixArgs(listFiles, null, { level, mode: 'measure', laneFilters }), signal, { keepStderr: true })
    measured = parseLoudnorm(stderr)
    if (!measured) console.warn('[audio-render] Loudness measurement unreadable, levelling in one pass')
  }

  // 3. Mix + encode
  onProgress(0.75, level ? 'Levelling and encoding...' : 'Mixing and encoding...')
  await run(mixArgs(listFiles, outputPath, { level, measured, title: timeline.title || null, laneFilters, chaptersFile }), signal)
  onProgress(1, 'Complete')
}
