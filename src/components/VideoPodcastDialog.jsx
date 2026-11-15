import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Film, Download, Loader2, Upload, Send, Subtitles, Mic } from './icons'
import { api, getBackendUrl } from '../utils/backendSelector'
import { authFetch, currentToken } from '../utils/editorAuth'
import { getPeaks } from '../utils/peakCache'
import { voiceTracks, projectSpeakers } from '../utils/speakers'
import { formatLength } from '../utils/limits'
import { CAPTION_COLORS } from '../utils/captions'
import './ProjectFormat.css'

const WAVES = [
  { id: 'bars', label: 'Bars' },
  { id: 'centered', label: 'Centered' },
  { id: 'line', label: 'Line' },
  { id: 'dots', label: 'Thin' },
  { id: 'circle', label: 'Circle' },
  { id: 'ring', label: 'Circle wave' }
]
// The audiogram studio's colours: the 3Speak red, white, the navy lightened
const COLORS = ['#e32933', '#f4f5f8', '#7f88ea']
const LOGOS = [{ id: 'mark', label: '3S logo' }, { id: 'full', label: '3Speak logo' }]
const W = 1920
const H = 1080
const DEFAULT_LINE = 'Watch and listen on *3speak.tv*'
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
export default function VideoPodcastDialog({ outputUrl, length, title, tracks, playlistCovers, onRequestCovers, canSend, onSend, onClose, words = null, language = null }) {
  // `words`: the show's transcript (the Transcript tool, timeline seconds = the export's) when it has all of it: sent as the captions instead of listening again
  const haveWords = Array.isArray(words) && words.length > 0
  const [server, setServer] = useState(null) // { maxSeconds, captions, burnIn }
  const [text, setText] = useState(title || '')
  const [line, setLine] = useState(DEFAULT_LINE)
  const [wave, setWave] = useState({ type: 'bars', color: '#e32933' })
  const [logo, setLogo] = useState('full')
  const [image, setImage] = useState(null)
  const [captions, setCaptions] = useState(true)
  const voices = useMemo(() => voiceTracks(tracks), [tracks])
  const [names, setNames] = useState(() => Object.fromEntries(voiceTracks(tracks).map((t, i) => [t.id, t.name && !/^voice( \d+)?$/i.test(t.name) ? t.name : `Speaker ${i + 1}`])))
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
      const t = d?.template
      if (gone || !t) return
      if (t.wave?.type) setWave({ type: t.wave.type, color: t.wave.color || '#e32933' })
      if (t.logo === 'mark' || t.logo === 'full') setLogo(t.logo)
      if (t.background?.image) setImage(t.background.image)
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
      setJob({ status: 'failed', error: err?.code === 'sign-in' ? 'Sign in on 3Speak to add a picture.' : err.message })
    } finally {
      setUploading(false)
    }
  }

  const tooLong = server?.maxSeconds && length > server.maxSeconds + 1
  const busy = job?.status === 'running'

  const make = async () => {
    setResult(null)
    setJob({ status: 'running', progress: 0, phase: 'Finding who speaks when...' })
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
      setJob(j => ({ ...j, phase: 'Sending...' }))
      const res = await authFetch(api('/api/video-podcast'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: outputUrl, title: text, line, fps, style: { wave, logo, background: { image } }, captions: { on: captions, language: haveWords ? (language || 'auto') : 'auto', ...(captions && haveWords ? { words: words.map(w => ({ text: w.text, start: w.start, end: w.end })) } : {}) }, speakers })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`)
      jobId = data.jobId
      for (let misses = 0; ;) {
        await new Promise(r => setTimeout(r, 2000))
        if (stopped) { setJob(null); return }
        let s
        try {
          const r = await fetch(api(`/api/video-podcast/${jobId}`), { cache: 'no-store' })
          s = await r.json()
          if (r.status === 404) throw new Error('The job was lost (the server restarted?)')
          misses = 0
        } catch (err) {
          if (/lost/.test(err.message) || ++misses > 15) throw err
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
        if (s.status === 'failed' || s.status === 'aborted') throw new Error(s.error || 'Stopped')
        setJob({ status: 'running', progress: s.progress || 0, phase: s.phase || 'Working...', notice: s.notice || null })
      }
    } catch (err) {
      if (!stopped) setJob({ status: 'failed', error: err?.code === 'sign-in' ? 'Sign in on 3Speak to make a video podcast.' : err.message })
    } finally {
      stopRef.current = null
    }
  }

  const at = SPEAKER_AT[image ? 'cover' : 'plain']
  const sample = voices.length && showNames ? (names[voices[0].id] || 'Speaker 1') : null
  return (
    <div className="remix-picker-overlay" onClick={busy ? undefined : onClose}>
      <div className="remix-picker audiogram-studio video-podcast-studio" role="dialog" aria-modal="true" aria-labelledby="video-podcast-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="video-podcast-title">Video podcast</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close" disabled={busy}><X size={16} /></button>
        </div>
        <p className="audio-template-intro">The whole episode ({formatLength(length)}) as a 16:9 video: the picture, a moving waveform, captions and who is speaking. For 3Speak, YouTube and Spotify video podcasts.</p>
        {server?.unavailable && <p className="audio-template-error" role="alert">This editor server can not make video podcasts yet.</p>}
        {tooLong && <p className="audio-template-error" role="alert">Video podcasts can be up to {formatLength(server.maxSeconds)} long.</p>}

        <div className="audiogram-body">
          <div className="audiogram-stage-col">
            <div className="audiogram-stage" style={{ width: W * scale, height: H * scale }} aria-label="Video podcast preview">
              <iframe ref={frameRef} title="Video podcast preview" src={api('/api/audiogram/page')} sandbox="allow-scripts" width={W} height={H} style={{ transform: `scale(${scale})` }} />
              {/* the burnt-in parts, roughly where the video has them */}
              {sample && <span className="video-podcast-speaker" style={{ left: at.x * scale, top: (at.y - 10) * scale, fontSize: 40 * scale, padding: `${10 * scale}px ${10 * scale}px` }}>{sample}</span>}
              {captions && <span className="video-podcast-caption" style={{ top: 0.89 * H * scale, fontSize: 0.044 * H * scale }}><b style={{ color: CAPTION_COLORS[1] }}>Your</b> words show here</span>}
            </div>
            <p className="audiogram-stage-hint">The waveform moves with the sound, the captions and the name follow the episode.</p>
          </div>

          <div className="audiogram-controls">
            <label className="audiogram-field">
              <span>Title</span>
              <input value={text} maxLength={120} onChange={(e) => setText(e.target.value)} aria-label="Title on the video" />
            </label>
            <label className="audiogram-field">
              <span>Line under it <small>(*stars* make it red)</small></span>
              <input value={line} maxLength={120} onChange={(e) => setLine(e.target.value)} aria-label="Line on the video" />
            </label>

            <div className="audiogram-field">
              <span>Picture</span>
              <div className="audiogram-pictures" role="radiogroup" aria-label="Picture">
                <button role="radio" aria-checked={!image} className={`audiogram-pic none${!image ? ' active' : ''}`} onClick={() => setImage(null)}>None</button>
                <button className="audiogram-pic upload" onClick={() => fileRef.current?.click()} disabled={uploading} title="Upload a picture">
                  {uploading ? <Loader2 size={16} className="encoding-notice-spin" /> : <Upload size={16} />}
                </button>
                {image && !(playlistCovers || []).some(c => c.url === image) && (
                  <button role="radio" aria-checked className="audiogram-pic active" title="Your picture"><img src={absolute(image)} alt="" /></button>
                )}
                {(playlistCovers || []).map(c => (
                  <button key={c.url} role="radio" aria-checked={image === c.url} className={`audiogram-pic${image === c.url ? ' active' : ''}`} title={c.title ? `Cover of “${c.title}”` : 'Playlist cover'} onClick={() => setImage(c.url)}>
                    <img src={c.url} alt="" loading="lazy" />
                  </button>
                ))}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
              </div>
            </div>

            <div className="audiogram-field">
              <span>Waveform</span>
              <div className="noise-levels audiogram-wave-types" role="radiogroup" aria-label="Waveform type">
                {WAVES.map(w => (
                  <button key={w.id} role="radio" aria-checked={wave.type === w.id} className={wave.type === w.id ? 'active' : ''} onClick={() => setWave(v => ({ ...v, type: w.id }))}>{w.label}</button>
                ))}
              </div>
              <div className="audiogram-colors" role="radiogroup" aria-label="Waveform colour">
                {COLORS.map(c => (
                  <button key={c} role="radio" aria-checked={wave.color === c} aria-label={`Colour ${c}`} className={`audiogram-swatch${wave.color === c ? ' active' : ''}`} style={{ background: c }} onClick={() => setWave(v => ({ ...v, color: c }))} />
                ))}
              </div>
            </div>

            <div className="audiogram-field">
              <span>3Speak branding</span>
              <div className="noise-levels" role="radiogroup" aria-label="Logo">
                {LOGOS.map(l => (
                  <button key={l.id} role="radio" aria-checked={logo === l.id} className={logo === l.id ? 'active' : ''} onClick={() => setLogo(l.id)}>{l.label}</button>
                ))}
              </div>
            </div>

            <label className="audiogram-field video-podcast-toggle">
              <span><Subtitles size={14} /> Captions</span>
              <input type="checkbox" checked={captions} disabled={!server?.captions && !haveWords} onChange={(e) => setCaptions(e.target.checked)} />
              <small className="audiogram-note">{haveWords ? 'The words of your transcript.' : server && !server.captions ? 'Speech to text is not available on this server.' : 'The words, found by speech to text on the server. Long episodes take a while.'}</small>
            </label>

            <div className="audiogram-field">
              <label className="video-podcast-toggle">
                <span><Mic size={14} /> Who is speaking</span>
                <input type="checkbox" checked={showNames && voices.length > 0} disabled={!voices.length} onChange={(e) => setShowNames(e.target.checked)} />
              </label>
              {voices.length === 0 && <small className="audiogram-note">No voice track to take names from.</small>}
              {showNames && voices.map((t, i) => (
                <input key={t.id} value={names[t.id] || ''} maxLength={40} placeholder={`Speaker ${i + 1}`} aria-label={`Name for voice track ${i + 1}`} onChange={(e) => { const v = e.target.value; setNames(n => ({ ...n, [t.id]: v })) }} />
              ))}
              {showNames && voices.length > 1 && <small className="audiogram-note">Each voice on its own track: the name of the loudest one shows.</small>}
            </div>

            <div className="audiogram-field">
              <span>Frame rate</span>
              <div className="noise-levels" role="radiogroup" aria-label="Frame rate">
                {[15, 24].map(f => (
                  <button key={f} role="radio" aria-checked={fps === f} className={fps === f ? 'active' : ''} onClick={() => setFps(f)}>{f === 15 ? '15 fps (smaller, faster)' : '24 fps (smoother)'}</button>
                ))}
              </div>
            </div>

            {busy && (
              <div className="compact-render-progress" role="status">
                <div className="compact-render-progress-bar"><div className="compact-render-progress-fill" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div>
                <span className="compact-render-progress-text">{job.phase || 'Working...'} {Math.round((job.progress || 0) * 100)}%</span>
              </div>
            )}
            {job?.status === 'failed' && <p className="audio-template-error" role="alert">The video podcast could not be made: {job.error}</p>}
            {busy ? (
              <button className="compact-btn" onClick={() => stopRef.current?.()}>Stop</button>
            ) : (
              <button className="silence-cut-apply audiogram-make" onClick={make} disabled={!outputUrl || server?.unavailable || tooLong || length < 3}>
                <Film size={14} /> {result ? 'Make it again' : 'Make video podcast'}
              </button>
            )}

            {result && (
              <div className="formats-result" data-testid="video-podcast-result">
                <video className="video-podcast-video" src={result.outputUrl} controls playsInline preload="metadata" />
                {result.notice && <small className="audiogram-note">{result.notice}</small>}
                <div className="formats-row">
                  <a className="formats-btn" href={result.outputUrl} download target="_blank" rel="noopener noreferrer"><Download size={14} />Download MP4</a>
                  {result.subtitles && <a className="formats-btn" href={result.subtitles.srtUrl} download target="_blank" rel="noopener noreferrer"><Download size={14} />Subtitles (SRT)</a>}
                  {canSend && <button className="formats-btn primary" onClick={() => onSend(result)}><Send size={14} />Post on 3Speak as a video</button>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
