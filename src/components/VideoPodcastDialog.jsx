import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Film, Download, Loader2, Upload, Send, Subtitles, Mic } from './icons'
import { api, getBackendUrl } from '../utils/backendSelector'
import { authFetch, currentToken } from '../utils/editorAuth'
import { getPeaks } from '../utils/peakCache'
import { voiceTracks, projectSpeakers } from '../utils/speakers'
import { formatLength } from '../utils/limits'
import { CAPTION_COLORS } from '../utils/captions'
import { useT, t as i18nT, tEnglish } from '../i18n'
import './ProjectFormat.css'

// The audiogram studio's shapes and logos (labels: audiogram.wave.*, audiogram.logo.*)
const WAVES = ['bars', 'centered', 'line', 'dots', 'circle', 'ring'].map(id => ({ id, labelKey: `audiogram.wave.${id}` }))
// The audiogram studio's colours: the 3Speak red, white, the navy lightened
const COLORS = ['#e32933', '#f4f5f8', '#7f88ea']
const LOGOS = [{ id: 'mark', labelKey: 'audiogram.logo.mark' }, { id: 'full', labelKey: 'audiogram.logo.full' }]
const W = 1920
const H = 1080
// Where the burnt-in parts sit (backend/src/services/videoPodcast.js PODCAST_LAYOUTS)
const SPEAKER_AT = { cover: { x: 1335, y: 616 }, plain: { x: 960, y: 594 } }

const absolute = (u) => (u && u.startsWith('/') ? new URL(u, getBackendUrl() || window.location.origin).href : u)

// The look the audiogram page draws for a 16:9 frame (its own layout, the same as the backend's)
function pageLayers(withCover, logo) {
  const cover = { x: 150, y: 190, w: 620, h: 620, z: 1, r: 0, on: withCover }
  const set = withCover
    ? { logo: { x: 900, y: 170, w: 360, h: 72 }, title: { x: 900, y: 270, w: 870, h: 250 }, line: { x: 900, y: 540, w: 870, h: 56 }, wave: { x: 900, y: 690, w: 870, h: 150 } }
    : { logo: { x: 780, y: 120, w: 360, h: 72 }, title: { x: 260, y: 230, w: 1400, h: 250 }, line: { x: 260, y: 500, w: 1400, h: 56 }, wave: { x: 260, y: 680, w: 1400, h: 170 } }
  // the mark alone is nearly square: its box keeps the logo's shape (the backend sizes it the same way)
  const l = set.logo
  const logoBox = logo === 'mark' ? { x: Math.round(l.x + l.w / 2 - 63 * 1.15), y: Math.round(l.y + l.h / 2 - 63), w: Math.round(126 * 1.15), h: 126 } : l
  return {
    logo: { ...logoBox, z: 20, r: 0, on: true },
    cover,
    title: { ...set.title, z: 3, r: 0, on: true },
    line: { ...set.line, z: 4, r: 0, on: true },
    wave: { ...set.wave, z: 2, r: 0, on: true }
  }
}

/**
 * Video podcast: the whole exported episode as a 16:9 video (1920x1080) with
 * the cover, a moving waveform, captions and the name of whoever speaks, made
 * by the backend's audiogram engine (POST /api/video-podcast) in one streaming
 * run, so hours long episodes work. Result: an MP4 to download (YouTube,
 * Spotify video podcasts) or to post on 3Speak as a normal video.
 */
// A voice track still under its default name ("Voice", "Voice 2", in English or in the
// language it was made in) shows as "Speaker N"; a name the creator gave it stays
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function isDefaultVoiceName(name) {
  if (/^voice( \d+)?$/i.test(name)) return true
  if (name === i18nT('timeline.trackName.voice') || name === i18nT('podcast.template.voiceTrack')) return true
  const numbered = escapeRe(i18nT('timeline.trackName.voiceNumbered', { number: '#' })).replace('#', '\\d+')
  return new RegExp(`^${numbered}$`, 'i').test(name)
}

export default function VideoPodcastDialog({ outputUrl, length, title, tracks, playlistCovers, onRequestCovers, canSend, onSend, onClose, words = null, language = null }) {
  // `words`: the show's transcript (the Transcript tool, timeline seconds = the export's) when it has all of it: sent as the captions instead of listening again
  const { t, tRich, formatNumber } = useT()
  const haveWords = Array.isArray(words) && words.length > 0
  const [server, setServer] = useState(null) // { maxSeconds, captions, burnIn }
  const [text, setText] = useState(title || '')
  // The line is burnt into the video: it starts in English, not in the editor's language
  const [line, setLine] = useState(() => tEnglish('podcast.video.defaultLine'))
  const [wave, setWave] = useState({ type: 'bars', color: '#e32933' })
  const [logo, setLogo] = useState('full')
  const [image, setImage] = useState(null)
  const [captions, setCaptions] = useState(true)
  const voices = useMemo(() => voiceTracks(tracks), [tracks])
  const [names, setNames] = useState(() => Object.fromEntries(voiceTracks(tracks).map((v, i) => [v.id, v.name && !isDefaultVoiceName(v.name) ? v.name : t('podcast.video.speaker', { n: i + 1 })])))
  const [showNames, setShowNames] = useState(true)
  const [fps, setFps] = useState(15)
  const [job, setJob] = useState(null) // { status, progress, phase, notice, error }
  const [result, setResult] = useState(null) // { outputUrl, subtitles, durationSec, notice }
  const [uploading, setUploading] = useState(false)
  const frameRef = useRef(null)
  const fileRef = useRef(null)
  const stopRef = useRef(null)
  const [frameReady, setFrameReady] = useState(false)
  const scale = Math.min(0.25, Math.max(0.15, ((typeof window !== 'undefined' ? window.innerWidth : 800) - 64) / W))

  useEffect(() => { onRequestCovers?.() }, [onRequestCovers])
  useEffect(() => () => stopRef.current?.(), [])
  useEffect(() => {
    let gone = false
    fetch(api('/api/video-podcast/status'), { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null)).catch(() => null)
      .then(s => { if (!gone) { setServer(s || { unavailable: true }); if (s && !s.captions && !haveWords) setCaptions(false) } })
    // the person's audiogram look (template) as the starting point
    authFetch(api('/api/templates/audiogram')).then(r => (r.ok ? r.json() : null)).catch(() => null).then(d => {
      const tpl = d?.template
      if (gone || !tpl) return
      if (tpl.wave?.type) setWave({ type: tpl.wave.type, color: tpl.wave.color || '#e32933' })
      if (tpl.logo === 'mark' || tpl.logo === 'full') setLogo(tpl.logo)
      if (tpl.background?.image) setImage(tpl.background.image)
    })
    return () => { gone = true }
  }, [])

  const pageState = useMemo(() => ({
    width: W, height: H, layers: pageLayers(!!image, logo), title: text, line, image: absolute(image), imageLayout: 'card', wave, logo
  }), [text, line, image, wave, logo])
  const stateRef = useRef(pageState)
  stateRef.current = pageState
  useEffect(() => {
    const onMsg = (e) => {
      if (e.source !== frameRef.current?.contentWindow || e.data?.type !== 'audiogram-page-ready') return
      setFrameReady(true)
      e.source.postMessage({ type: 'audiogram-state', state: stateRef.current }, '*')
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  useEffect(() => {
    if (frameReady) frameRef.current?.contentWindow?.postMessage({ type: 'audiogram-state', state: pageState }, '*')
  }, [frameReady, pageState])

  const upload = async (file) => {
    if (!file) return
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file, file.name || 'picture')
      const res = await authFetch(api('/api/upload'), { method: 'POST', body: form })
      if (!res.ok) throw new Error(`upload ${res.status}`)
      setImage(absolute((await res.json()).url))
    } catch (err) {
      setJob({ status: 'failed', error: err?.code === 'sign-in' ? t('audiogram.picture.signIn') : err.message })
    } finally {
      setUploading(false)
    }
  }

  const tooLong = server?.maxSeconds && length > server.maxSeconds + 1
  const busy = job?.status === 'running'

  const make = async () => {
    setResult(null)
    setJob({ status: 'running', progress: 0, phase: t('podcast.video.finding') })
    let stopped = false
    let jobId = null
    stopRef.current = () => {
      stopped = true
      if (jobId) {
        const tok = currentToken()
        fetch(api(`/api/video-podcast/${jobId}/abort`), { method: 'POST', keepalive: true, headers: tok ? { Authorization: `Bearer ${tok}` } : {} }).catch(() => {})
      }
    }
    try {
      const speakers = showNames && voices.length ? await projectSpeakers(tracks, names, length, getPeaks) : []
      if (stopped) return
      setJob(j => ({ ...j, phase: t('podcast.video.sending') }))
      const res = await authFetch(api('/api/video-podcast'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: outputUrl, title: text, line, fps, style: { wave, logo, background: { image } }, captions: { on: captions, language: haveWords ? (language || 'auto') : 'auto', ...(captions && haveWords ? { words: words.map(w => ({ text: w.text, start: w.start, end: w.end })) } : {}) }, speakers })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('podcast.video.serverAnswered', { status: String(res.status) }))
      jobId = data.jobId
      for (let misses = 0; ;) {
        await new Promise(r => setTimeout(r, 2000))
        if (stopped) { setJob(null); return }
        let s
        try {
          const r = await fetch(api(`/api/video-podcast/${jobId}`), { cache: 'no-store' })
          s = await r.json()
          if (r.status === 404) throw Object.assign(new Error(t('podcast.video.lost')), { lost: true })
          misses = 0
        } catch (err) {
          if (err.lost || ++misses > 15) throw err
          continue
        }
        if (s.status === 'completed') {
          setJob(null)
          setResult({
            outputUrl: absolute(s.outputUrl),
            durationSec: s.durationSec || length,
            notice: s.notice || null,
            subtitles: s.subtitles ? { ...s.subtitles, vttUrl: absolute(s.subtitles.vttUrl), srtUrl: absolute(s.subtitles.srtUrl) } : null
          })
          return
        }
        if (s.status === 'failed' || s.status === 'aborted') throw new Error(s.error || t('podcast.video.stopped'))
        setJob({ status: 'running', progress: s.progress || 0, phase: s.phase || t('podcast.video.working'), notice: s.notice || null })
      }
    } catch (err) {
      if (!stopped) setJob({ status: 'failed', error: err?.code === 'sign-in' ? t('podcast.video.signIn') : err.message })
    } finally {
      stopRef.current = null
    }
  }

  const at = SPEAKER_AT[image ? 'cover' : 'plain']
  const sample = voices.length && showNames ? (names[voices[0].id] || t('podcast.video.speaker', { n: 1 })) : null
  return (
    <div className="remix-picker-overlay" onClick={busy ? undefined : onClose}>
      <div className="remix-picker audiogram-studio video-podcast-studio" role="dialog" aria-modal="true" aria-labelledby="video-podcast-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="video-podcast-title">{t('podcast.video.title')}</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title={t('common.close')} disabled={busy}><X size={16} /></button>
        </div>
        <p className="audio-template-intro">{t('podcast.video.intro', { length: formatLength(length) })}</p>
        {server?.unavailable && <p className="audio-template-error" role="alert">{t('podcast.video.unavailable')}</p>}
        {tooLong && <p className="audio-template-error" role="alert">{t('podcast.video.tooLong', { length: formatLength(server.maxSeconds) })}</p>}

        <div className="audiogram-body">
          <div className="audiogram-stage-col">
            <div className="audiogram-stage" style={{ width: W * scale, height: H * scale }} aria-label={t('podcast.video.preview')}>
              <iframe ref={frameRef} title={t('podcast.video.preview')} src={api('/api/audiogram/page')} sandbox="allow-scripts" width={W} height={H} style={{ transform: `scale(${scale})` }} />
              {/* the burnt-in parts, roughly where the video has them */}
              {sample && <span className="video-podcast-speaker" style={{ left: at.x * scale, top: (at.y - 10) * scale, fontSize: 40 * scale, padding: `${10 * scale}px ${10 * scale}px` }}>{sample}</span>}
              {captions && <span className="video-podcast-caption" style={{ top: 0.89 * H * scale, fontSize: 0.044 * H * scale }}>{tRich('podcast.video.sampleCaption', null, { b: <b style={{ color: CAPTION_COLORS[1] }} /> })}</span>}
            </div>
            <p className="audiogram-stage-hint">{t('podcast.video.stageHint')}</p>
          </div>

          <div className="audiogram-controls">
            <label className="audiogram-field">
              <span>{t('audiogram.look.title')}</span>
              <input value={text} maxLength={120} onChange={(e) => setText(e.target.value)} aria-label={t('audiogram.look.titleLabel')} />
            </label>
            <label className="audiogram-field">
              <span>{tRich('audiogram.look.line', null, { small: <small /> })}</span>
              <input value={line} maxLength={120} onChange={(e) => setLine(e.target.value)} aria-label={t('audiogram.look.lineLabel')} />
            </label>

            <div className="audiogram-field">
              <span>{t('audiogram.look.picture')}</span>
              <div className="audiogram-pictures" role="radiogroup" aria-label={t('audiogram.look.picture')}>
                <button role="radio" aria-checked={!image} className={`audiogram-pic none${!image ? ' active' : ''}`} onClick={() => setImage(null)}>{t('common.none')}</button>
                <button className="audiogram-pic upload" onClick={() => fileRef.current?.click()} disabled={uploading} title={t('audiogram.picture.upload')}>
                  {uploading ? <Loader2 size={16} className="encoding-notice-spin" /> : <Upload size={16} />}
                </button>
                {image && !(playlistCovers || []).some(c => c.url === image) && (
                  <button role="radio" aria-checked className="audiogram-pic active" title={t('audiogram.picture.yours')}><img src={absolute(image)} alt="" /></button>
                )}
                {(playlistCovers || []).map(c => (
                  <button key={c.url} role="radio" aria-checked={image === c.url} className={`audiogram-pic${image === c.url ? ' active' : ''}`} title={c.title ? t('audiogram.picture.coverOf', { title: c.title }) : t('audiogram.picture.playlistCover')} onClick={() => setImage(c.url)}>
                    <img src={c.url} alt="" loading="lazy" />
                  </button>
                ))}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
              </div>
            </div>

            <div className="audiogram-field">
              <span>{t('audiogram.look.waveform')}</span>
              <div className="noise-levels audiogram-wave-types" role="radiogroup" aria-label={t('audiogram.look.waveType')}>
                {WAVES.map(w => (
                  <button key={w.id} role="radio" aria-checked={wave.type === w.id} className={wave.type === w.id ? 'active' : ''} onClick={() => setWave(v => ({ ...v, type: w.id }))}>{t(w.labelKey)}</button>
                ))}
              </div>
              <div className="audiogram-colors" role="radiogroup" aria-label={t('audiogram.look.waveColour')}>
                {COLORS.map(c => (
                  <button key={c} role="radio" aria-checked={wave.color === c} aria-label={t('audiogram.look.colour', { colour: c })} className={`audiogram-swatch${wave.color === c ? ' active' : ''}`} style={{ background: c }} onClick={() => setWave(v => ({ ...v, color: c }))} />
                ))}
              </div>
            </div>

            <div className="audiogram-field">
              <span>{t('audiogram.look.branding')}</span>
              <div className="noise-levels" role="radiogroup" aria-label={t('audiogram.look.logoGroup')}>
                {LOGOS.map(l => (
                  <button key={l.id} role="radio" aria-checked={logo === l.id} className={logo === l.id ? 'active' : ''} onClick={() => setLogo(l.id)}>{t(l.labelKey)}</button>
                ))}
              </div>
            </div>

            <label className="audiogram-field video-podcast-toggle">
              <span><Subtitles size={14} /> {t('podcast.video.captions')}</span>
              <input type="checkbox" checked={captions} disabled={!server?.captions && !haveWords} onChange={(e) => setCaptions(e.target.checked)} />
              <small className="audiogram-note">{haveWords ? t('podcast.video.captionsTranscript') : server && !server.captions ? t('podcast.video.captionsNoStt') : t('podcast.video.captionsStt')}</small>
            </label>

            <div className="audiogram-field">
              <label className="video-podcast-toggle">
                <span><Mic size={14} /> {t('podcast.video.whoSpeaks')}</span>
                <input type="checkbox" checked={showNames && voices.length > 0} disabled={!voices.length} onChange={(e) => setShowNames(e.target.checked)} />
              </label>
              {voices.length === 0 && <small className="audiogram-note">{t('podcast.video.noVoices')}</small>}
              {showNames && voices.map((v, i) => (
                <input key={v.id} value={names[v.id] || ''} maxLength={40} placeholder={t('podcast.video.speaker', { n: i + 1 })} aria-label={t('podcast.video.speakerLabel', { n: i + 1 })} onChange={(e) => { const value = e.target.value; setNames(n => ({ ...n, [v.id]: value })) }} />
              ))}
              {showNames && voices.length > 1 && <small className="audiogram-note">{t('podcast.video.loudest')}</small>}
            </div>

            <div className="audiogram-field">
              <span>{t('podcast.video.frameRate')}</span>
              <div className="noise-levels" role="radiogroup" aria-label={t('podcast.video.frameRate')}>
                {[15, 24].map(f => (
                  <button key={f} role="radio" aria-checked={fps === f} className={fps === f ? 'active' : ''} onClick={() => setFps(f)}>{f === 15 ? t('podcast.video.fps15') : t('podcast.video.fps24')}</button>
                ))}
              </div>
            </div>

            {busy && (
              <div className="compact-render-progress" role="status">
                <div className="compact-render-progress-bar"><div className="compact-render-progress-fill" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div>
                <span className="compact-render-progress-text">{job.phase || t('podcast.video.working')} {formatNumber(Math.round((job.progress || 0) * 100) / 100, { style: 'percent' })}</span>
              </div>
            )}
            {job?.status === 'failed' && <p className="audio-template-error" role="alert">{t('podcast.video.failed', { error: job.error })}</p>}
            {busy ? (
              <button className="compact-btn" onClick={() => stopRef.current?.()}>{t('podcast.video.stop')}</button>
            ) : (
              <button className="silence-cut-apply audiogram-make" onClick={make} disabled={!outputUrl || server?.unavailable || tooLong || length < 3}>
                <Film size={14} /> {result ? t('podcast.video.again') : t('podcast.video.make')}
              </button>
            )}

            {result && (
              <div className="formats-result" data-testid="video-podcast-result">
                <video className="video-podcast-video" src={result.outputUrl} controls playsInline preload="metadata" />
                {result.notice && <small className="audiogram-note">{result.notice}</small>}
                <div className="formats-row">
                  <a className="formats-btn" href={result.outputUrl} download target="_blank" rel="noopener noreferrer"><Download size={14} />{t('podcast.video.download')}</a>
                  {result.subtitles && <a className="formats-btn" href={result.subtitles.srtUrl} download target="_blank" rel="noopener noreferrer"><Download size={14} />{t('podcast.video.subtitles')}</a>}
                  {canSend && <button className="formats-btn primary" onClick={() => onSend(result)}><Send size={14} />{t('podcast.video.post')}</button>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
