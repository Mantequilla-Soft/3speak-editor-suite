// Audio mode render: the planning maths, and real renders through ffmpeg
// (timing, drift over many cuts, overlaps, fades, loudness, MP3 output).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-render-'))
process.env.WORK_DIR = dir
const {
  planLanes, laneEntries, segmentFilter, segmentArgs, mixArgs, parseLoudnorm, concatList,
  audioTimelineEnd, renderAudioTimeline, SEGMENT_RATE, OUTPUT_RATE, LOUDNESS_TARGET,
  cleanDuck, duckExpr, duckFilter, cleanChapters, chapterMetadata
} = await import('../src/services/audioRender.js')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const clip = (id, extra = {}) => ({ id, type: 'audio', name: id, duration: 10, startTime: 0, endTime: 1, timelinePosition: 0, volume: 100, ...extra })
const track = (id, clips, extra = {}) => ({ id, type: 'audio', name: id, clips, ...extra })

describe('planLanes', () => {
  test('keeps audio tracks only, drops muted tracks, switched-off and empty clips', () => {
    const lanes = planLanes([
      { id: 'v', type: 'video', clips: [clip('v1')] },
      track('a', [clip('a1'), clip('off', { audioEnabled: false, timelinePosition: 2 }), clip('empty', { startTime: 3, endTime: 3, timelinePosition: 4 })]),
      track('m', [clip('m1')], { muted: true })
    ])
    assert.deepEqual(lanes.map(l => [l.trackId, l.clips.map(c => c.id)]), [['a', ['a1']]])
  })

  test('sorts clips by position and moves overlapping clips to an extra lane', () => {
    const lanes = planLanes([track('a', [
      clip('late', { timelinePosition: 5 }),
      clip('first', { timelinePosition: 0, endTime: 2 }),
      clip('overlap', { timelinePosition: 1 }),
      clip('touch', { timelinePosition: 2 })
    ])])
    assert.deepEqual(lanes.map(l => l.clips.map(c => c.id)), [['first', 'touch', 'late'], ['overlap']])
  })

  test('negative positions are treated as 0', () => {
    assert.equal(planLanes([track('a', [clip('x', { timelinePosition: -3 })])])[0].clips[0].timelinePosition, 0)
  })

  test('audioTimelineEnd is where the last sounding clip ends', () => {
    assert.equal(audioTimelineEnd([track('a', [clip('x', { timelinePosition: 4, startTime: 1, endTime: 3.5 })]), track('m', [clip('y', { endTime: 9 })], { muted: true })]), 6.5)
    assert.equal(audioTimelineEnd([]), 0)
  })
})

describe('laneEntries', () => {
  test('gaps become silence counted in whole samples, clips keep their length', () => {
    const entries = laneEntries({ clips: [clip('a', { timelinePosition: 0.5, endTime: 1 }), clip('b', { timelinePosition: 2, startTime: 3, endTime: 3.25 })] })
    assert.deepEqual(entries.map(e => [e.kind, e.samples]), [
      ['silence', 0.5 * SEGMENT_RATE], ['clip', SEGMENT_RATE], ['silence', 0.5 * SEGMENT_RATE], ['clip', 0.25 * SEGMENT_RATE]
    ])
  })

  test('back-to-back parts with float noise never drift: total = last end in samples', () => {
    // 500 parts of 0.1 s packed back to back, positions summed in floats like the editor does
    const clips = []
    let pos = 0
    for (let i = 0; i < 500; i++) {
      clips.push(clip(`p${i}`, { startTime: i * 0.37, endTime: i * 0.37 + 0.1, timelinePosition: pos }))
      pos += 0.1
    }
    const entries = laneEntries({ clips })
    const total = entries.reduce((n, e) => n + e.samples, 0)
    assert.ok(Math.abs(total - Math.round(pos * SEGMENT_RATE)) <= 1, `total ${total} vs ${pos * SEGMENT_RATE}`)
    assert.ok(entries.filter(e => e.kind === 'silence').every(e => e.samples <= 1), 'no real gaps appear')
  })
})

describe('segmentFilter / segmentArgs', () => {
  test('nothing to do for a plain clip', () => {
    assert.equal(segmentFilter(clip('a')), null)
  })

  test('fades are clamped to the clip and volume is applied', () => {
    assert.equal(segmentFilter(clip('a', { endTime: 2, fadeIn: 0.5, fadeOut: 5, volume: 50 })),
      'afade=t=in:st=0:d=0.500,afade=t=out:st=0.000:d=2.000,volume=0.500')
  })

  test('cuts at the clip start, pads and stops at the exact sample count', () => {
    const args = segmentArgs(clip('a', { startTime: 1.5, endTime: 2.5 }), '/in.wav', 48000, '/out.flac')
    assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2), ['-ss', '1.500000'])
    assert.ok(args.includes('/in.wav'))
  assert.equal(segmentArgs(clip('a'), '/m.wav', 10, '/o.flac', { channels: 1 })[segmentArgs(clip('a'), '/m.wav', 10, '/o.flac', { channels: 1 }).indexOf('-af') + 1].split(',')[1], 'pan=stereo|c0=c0|c1=c0')
    assert.equal(args[args.indexOf('-af') + 1], 'aresample=48000,aformat=channel_layouts=stereo,apad=whole_len=48000,atrim=end_sample=48000')
    assert.ok(!args.includes('-frames:a'), '-frames:a counts packets, not samples')
  })

  test('a source without audio becomes silence of the same length', () => {
    const args = segmentArgs(clip('a'), '/video.mp4', 1234, '/out.flac', { hasAudio: false })
    assert.ok(args.join(' ').includes('anullsrc'))
    assert.ok(!args.includes('/video.mp4'))
    assert.equal(args[args.indexOf('-af') + 1], 'apad=whole_len=1234,atrim=end_sample=1234')
  })
})

describe('mixArgs / parseLoudnorm / concatList', () => {
  test('one lane: limiter only; several: amix without dividing the volume', () => {
    assert.match(mixArgs(['/a.txt'], '/o.mp3').join(' '), /\[0:a\]alimiter=/)
    const two = mixArgs(['/a.txt', '/b.txt'], '/o.mp3').join(' ')
    assert.match(two, /amix=inputs=2:duration=longest:dropout_transition=0:normalize=0/)
    assert.match(two, /libmp3lame -b:a 192k -ar 44100/)
  })

  test('measure pass prints loudnorm JSON and writes nothing; apply pass is linear with the measured values', () => {
    const measure = mixArgs(['/a.txt'], null, { level: true, mode: 'measure' })
    assert.deepEqual(measure.slice(-3), ['-f', 'null', '-'])
    assert.match(measure.join(' '), /print_format=json/)
    const apply = mixArgs(['/a.txt'], '/o.mp3', { level: true, measured: { input_i: -30, input_tp: -9, input_lra: 4, input_thresh: -40, target_offset: 0.3 } }).join(' ')
    assert.match(apply, new RegExp(`loudnorm=I=${LOUDNESS_TARGET.i}:TP=${LOUDNESS_TARGET.tp}:LRA=${LOUDNESS_TARGET.lra}:measured_I=-30:measured_TP=-9:measured_LRA=4:measured_thresh=-40:offset=0.3:linear=true`))
  })

  test('no levelling: no loudnorm at all', () => {
    assert.doesNotMatch(mixArgs(['/a.txt'], '/o.mp3', { level: false }).join(' '), /loudnorm/)
  })

  test('title goes into the ID3 tag, trimmed', () => {
    const args = mixArgs(['/a.txt'], '/o.mp3', { title: 'x'.repeat(200) })
    assert.equal(args[args.indexOf('-metadata') + 1], `title=${'x'.repeat(120)}`)
  })

  test('parseLoudnorm reads the last JSON block and rejects junk', () => {
    const stderr = 'noise {"bad": 1}\n[Parsed_loudnorm_0 @ 0x1]\n{\n "input_i" : "-23.10",\n "input_tp" : "-4.00",\n "input_lra" : "3.10",\n "input_thresh" : "-33.40",\n "target_offset" : "0.20"\n}\n'
    assert.deepEqual(parseLoudnorm(stderr), { input_i: -23.1, input_tp: -4, input_lra: 3.1, input_thresh: -33.4, target_offset: 0.2 })
    assert.equal(parseLoudnorm('no json here'), null)
    assert.equal(parseLoudnorm('{"input_i": "-inf"}'), null)
  })

  test('concat list quotes paths with apostrophes', () => {
    assert.equal(concatList(["/tmp/it's.flac", '/a.flac']), "file '/tmp/it'\\''s.flac'\nfile '/a.flac'\n")
  })
})

describe('auto-duck / chapters', () => {
  const duck = { gain: 0.25, attack: 0.4, release: 0.8, spans: [[2, 5], [10, 12]], tracks: ['m'] }

  test('cleanDuck keeps a good plan, merges ramps that would overlap, rejects junk', () => {
    assert.deepEqual(cleanDuck(duck), duck)
    assert.deepEqual(cleanDuck({ ...duck, spans: [[2, 5], [5.5, 7]] }).spans, [[2, 7]])
    for (const bad of [null, {}, { ...duck, gain: 1 }, { ...duck, gain: -0.1 }, { ...duck, attack: 0 }, { ...duck, spans: [] },
      { ...duck, tracks: [] }, { ...duck, spans: [[5, 2]] }, { ...duck, spans: [['a', 2]] }, { ...duck, spans: Array.from({ length: 2001 }, (_, i) => [i * 3, i * 3 + 1]) }]) {
      assert.equal(cleanDuck(bad), null, JSON.stringify(bad)?.slice(0, 60))
    }
  })

  test('duckExpr is the same trapezoid as the editor (evaluated here by hand)', () => {
    const expr = duckExpr(duck)
    // ffmpeg's clip/min, in JS, on the expression itself
    const f = new Function('t', 'clip', 'min', `return ${expr}`)
    const clip = (x, a, b) => Math.min(b, Math.max(a, x))
    const at = (t) => f(t, clip, Math.min)
    assert.equal(at(0), 1)
    assert.ok(Math.abs(at(1.8) - (1 - 0.75 * 0.5)) < 1e-9, 'half way down the ramp')
    assert.equal(at(3), 0.25)
    assert.ok(Math.abs(at(5.4) - (1 - 0.75 * 0.5)) < 1e-9, 'half way back up')
    assert.equal(at(7), 1)
    assert.equal(at(11), 0.25)
    assert.match(duckFilter(duck), /^asetnsamples=n=480:p=0,volume=eval=frame:volume='1-0\.75\*\(/)
    assert.equal(duckFilter(null), null)
  })

  test('mixArgs puts a lane filter before the mix and maps the chapters', () => {
    const args = mixArgs(['/a.txt', '/b.txt'], '/o.mp3', { laneFilters: [null, 'volume=0.5'], chaptersFile: '/c.txt' })
    const graph = args[args.indexOf('-filter_complex') + 1]
    assert.match(graph, /^\[1:a\]volume=0\.5\[d1\];\[0:a\]\[d1\]amix=inputs=2/)
    assert.equal(args[args.indexOf('-map_chapters') + 1], '2')
    assert.ok(args.includes('/c.txt'))
    const measure = mixArgs(['/a.txt'], null, { level: true, mode: 'measure', chaptersFile: '/c.txt' })
    assert.ok(!measure.includes('/c.txt') && !measure.includes('-map_chapters'), 'the measuring pass has no chapters')
  })

  test('cleanChapters: in order, inside the episode, titled; metadata escaped', () => {
    const list = cleanChapters([
      { start: 0, end: 10, title: ' Intro ' },
      { start: 5, end: 12, title: 'overlaps, dropped' },
      { start: 10, end: 99, title: 'Talk = #1; done' },
      { start: 30, end: 30.2, title: 'too short' },
      { start: 20, end: 25, title: '' },
      'junk'
    ], 40)
    assert.deepEqual(list, [{ start: 0, end: 10, title: 'Intro' }, { start: 10, end: 40, title: 'Talk = #1; done' }])
    assert.equal(chapterMetadata(list), ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=10000\ntitle=Intro\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=10000\nEND=40000\ntitle=Talk \\= \\#1\\; done\n')
    assert.deepEqual(cleanChapters(null, 10), [])
  })
})

// ---- Real renders ----
const tone = (name, f, d, extra = []) => {
  const file = path.join(dir, name)
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${f}:d=${d}:sample_rate=44100`, ...extra, file])
  return file
}
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', file], { encoding: 'utf8' }))
const peakDb = (file, ss, t) => {
  const r = execFileSync('sh', ['-c', `ffmpeg -nostats -ss ${ss} -t ${t} -i "${file}" -af volumedetect -f null - 2>&1 | grep max_volume || true`], { encoding: 'utf8' })
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r)
  return m ? (m[1] === '-inf' ? -Infinity : +m[1]) : -Infinity
}
const integratedLufs = (file) => {
  const r = execFileSync('sh', ['-c', `ffmpeg -nostats -i "${file}" -af ebur128 -f null - 2>&1 | grep -A1 'Integrated loudness' | tail -1`], { encoding: 'utf8' })
  return parseFloat(/I:\s+(-?[\d.]+)/.exec(r)[1])
}

let toneA, toneB, quiet
// lavfi's sine is generated at 1/8 of full scale
const SRC_DB = -18
before(() => {
  if (!hasFfmpeg) return
  toneA = tone('a.mp3', 440, 30, ['-c:a', 'libmp3lame', '-b:a', '128k'])
  toneB = tone('b.wav', 880, 10)
  quiet = tone('quiet.m4a', 300, 10, ['-af', 'volume=-30dB', '-c:a', 'aac'])
})

async function render(name, tracks, { master, files, chapters } = {}) {
  const downloadedFiles = new Map()
  for (const t of tracks) for (const c of t.clips) downloadedFiles.set(c.id, files?.[c.id] || toneA)
  const jobDir = path.join(dir, `job-${name}`)
  fs.mkdirSync(jobDir, { recursive: true })
  const out = path.join(dir, `${name}.mp3`)
  const phases = []
  await renderAudioTimeline({ timeline: { output: 'audio', tracks, master, title: name, chapters }, downloadedFiles, outputPath: out, jobDir, onProgress: (p, ph) => phases.push([p, ph]) })
  return { out, phases }
}

test('renders an MP3 of the right length, gaps silent, clips audible', { skip: !hasFfmpeg }, async () => {
  const { out, phases } = await render('basic', [track('v', [
    clip('one', { startTime: 0, endTime: 2, timelinePosition: 0 }),
    clip('two', { startTime: 5, endTime: 7, timelinePosition: 4 })
  ])], { master: { loudness: false } })
  const p = probe(out)
  assert.equal(p.streams[0].codec_name, 'mp3')
  assert.equal(+p.streams[0].sample_rate, OUTPUT_RATE)
  assert.ok(Math.abs(+p.format.duration - 6) < 0.08, `duration ${p.format.duration}`)
  assert.ok(Math.abs(peakDb(out, 0.5, 1) - SRC_DB) < 1.5, 'first clip at the level of its source (mono to both sides, no -3 dB)')
  assert.ok(peakDb(out, 2.3, 1.4) < -80, 'the gap is silent')
  assert.ok(Math.abs(peakDb(out, 4.5, 1) - SRC_DB) < 1.5, 'second clip audible')
  assert.equal(phases.at(-1)[1], 'Complete')
})

test('120 back-to-back cuts end exactly where the timeline ends (no drift)', { skip: !hasFfmpeg }, async () => {
  const clips = []
  let pos = 0
  for (let i = 0; i < 120; i++) {
    clips.push(clip(`c${i}`, { startTime: (i * 0.23) % 25, endTime: ((i * 0.23) % 25) + 0.15, timelinePosition: pos }))
    pos += 0.15
  }
  // a click at the very end shows where the last clip landed
  clips.push(clip('end', { startTime: 0, endTime: 0.5, timelinePosition: pos, volume: 100 }))
  const { out } = await render('drift', [track('v', clips)], { master: { loudness: false }, files: { end: toneB } })
  const d = +probe(out).format.duration
  assert.ok(Math.abs(d - (pos + 0.5)) < 0.06, `duration ${d} vs ${pos + 0.5}`)
})

test('every segment is exactly as long as its clip, even past the end of the file', { skip: !hasFfmpeg }, async () => {
  const out = path.join(dir, 'seg.flac')
  // asks for 2 s from 29 s of a 30 s file: 1 s of sound, 1 s of padding
  execFileSync('ffmpeg', segmentArgs(clip('s', { startTime: 29, endTime: 31 }), toneA, 96000, out))
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=duration_ts,sample_rate', '-of', 'json', out], { encoding: 'utf8' }))
  assert.equal(+p.streams[0].duration_ts, 96000)
  assert.equal(+p.streams[0].sample_rate, SEGMENT_RATE)
})

test('overlapping clips on one track both play (extra lane)', { skip: !hasFfmpeg }, async () => {
  const solo = await render('solo', [track('v', [clip('x', { endTime: 2 })])], { master: { loudness: false } })
  const both = await render('overlap', [track('v', [clip('x', { endTime: 2 }), clip('y', { endTime: 2, timelinePosition: 0 })])], { master: { loudness: false } })
  assert.ok(peakDb(both.out, 0.5, 1) > peakDb(solo.out, 0.5, 1) + 3, 'two overlapping copies add up')
})

test('muted tracks are silent, volume and fades are applied', { skip: !hasFfmpeg }, async () => {
  const { out } = await render('fades', [
    track('v', [clip('x', { endTime: 4, fadeIn: 1, fadeOut: 1, volume: 50 })]),
    track('m', [clip('loud', { endTime: 4, volume: 200 })], { muted: true })
  ], { master: { loudness: false } })
  const middle = peakDb(out, 1.5, 1)
  assert.ok(Math.abs(middle - (SRC_DB - 6)) < 1.5, `half volume is 6 dB under the source, got ${middle}`)
  assert.ok(peakDb(out, 0, 0.05) < middle - 20, 'fade in starts silent')
  assert.ok(peakDb(out, 3.93, 0.06) < middle - 15, 'fade out ends silent')
})

test('loudness levelling brings a quiet recording to about -16 LUFS', { skip: !hasFfmpeg }, async () => {
  const raw = await render('quiet-raw', [track('v', [clip('q', { endTime: 8 })])], { master: { loudness: false }, files: { q: quiet } })
  const levelled = await render('quiet-level', [track('v', [clip('q', { endTime: 8 })])], { master: { loudness: true }, files: { q: quiet } })
  assert.ok(integratedLufs(raw.out) < -35, 'source is quiet')
  const lufs = integratedLufs(levelled.out)
  assert.ok(Math.abs(lufs - LOUDNESS_TARGET.i) < 1.5, `levelled to ${lufs} LUFS`)
  assert.ok(peakDb(levelled.out, 0, 8) <= -1, 'true peak stays under the ceiling')
  assert.ok(levelled.phases.some(([, ph]) => /Measuring loudness/.test(ph)))
})

test('a clip whose file has no audio stream keeps its time as silence', { skip: !hasFfmpeg }, async () => {
  const picture = path.join(dir, 'picture.mp4')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=3', '-c:v', 'libx264', picture])
  const { out } = await render('no-audio', [track('v', [clip('pic', { endTime: 2 }), clip('after', { timelinePosition: 2, endTime: 1 })])],
    { master: { loudness: false }, files: { pic: picture, after: toneB } })
  assert.ok(peakDb(out, 0.2, 1.5) < -80)
  assert.ok(peakDb(out, 2.2, 0.6) > SRC_DB - 2)
})

test('segments are cached: an unchanged second render cuts nothing new', { skip: !hasFfmpeg }, async () => {
  const tracks = [track('v', [clip('cache-a', { startTime: 1, endTime: 2 })])]
  await render('cache-1', tracks, { master: { loudness: false } })
  const segDir = path.join(dir, 'cache', 'audio-segments')
  const before = fs.readdirSync(segDir).length
  await render('cache-2', tracks, { master: { loudness: false } })
  assert.equal(fs.readdirSync(segDir).length, before)
})

test('auto-duck: the music is 12 dB down under the voice and back up in the pause', { skip: !hasFfmpeg }, async () => {
  const tracks = [
    track('v', [clip('talk1', { endTime: 3, timelinePosition: 2 }), clip('talk2', { endTime: 2, timelinePosition: 9 })]),
    track('m', [clip('bed', { endTime: 12, timelinePosition: 0 })], { music: true })
  ]
  const files = { talk1: toneB, talk2: toneB, bed: toneA }
  const duck = { gain: 0.2512, attack: 0.4, release: 0.8, spans: [[2, 5], [9, 11]], tracks: ['m'] }
  const { out } = await render('duck', tracks, { master: { loudness: false, duck }, files })
  // Only the music: the voice muted, so the levels are the bed's own
  const music = await render('duck-music', [{ ...tracks[0], muted: true }, tracks[1]], { master: { loudness: false, duck }, files })
  const full = peakDb(music.out, 0.3, 1)
  const under = peakDb(music.out, 3, 1.5)
  const pause = peakDb(music.out, 6.5, 1.5)
  assert.ok(Math.abs(full - SRC_DB) < 1.5, `before the voice: full (${full})`)
  assert.ok(Math.abs(under - (full - 12)) < 1.5, `under the voice: 12 dB down (${under} vs ${full})`)
  assert.ok(Math.abs(pause - full) < 1.5, `in the pause: back up (${pause})`)
  assert.ok(Math.abs(+probe(out).format.duration - 12) < 0.08)
  // An unusable plan is ignored, not an error
  const junk = await render('duck-junk', [{ ...tracks[0], muted: true }, tracks[1]], { master: { loudness: false, duck: { gain: 5 } }, files })
  assert.ok(Math.abs(peakDb(junk.out, 3, 1.5) - full) < 1.5)
})

test('chapters end up in the MP3 as ID3 chapters', { skip: !hasFfmpeg }, async () => {
  const { out } = await render('chapters', [track('v', [clip('ch', { endTime: 9 })])], {
    master: { loudness: true },
    chapters: [{ start: 0, end: 4, title: 'Intro' }, { start: 4, end: 9, title: 'Q&A = fun; really' }]
  })
  const { chapters } = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', out], { encoding: 'utf8' }))
  assert.equal(chapters.length, 2)
  assert.equal(chapters[0].tags.title, 'Intro')
  assert.equal(chapters[1].tags.title, 'Q&A = fun; really')
  assert.ok(Math.abs(+chapters[1].start_time - 4) < 0.01 && Math.abs(+chapters[1].end_time - 9) < 0.01)
})

test('nothing to render is an error, not an empty file', { skip: !hasFfmpeg }, async () => {
  await assert.rejects(render('empty', [track('v', [])]), /Nothing to render/)
})
