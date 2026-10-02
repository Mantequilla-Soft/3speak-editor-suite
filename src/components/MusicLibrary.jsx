import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { X, Play, Pause, Plus, Search, Music } from 'lucide-react'

// Where the song lists come from: comma separated URLs of library.json files
// ({ moods: [{ id, label }], tracks: [...] }), relative to the editor's origin.
// Tracks give `file` (relative to their JSON) or `url`. 3Speak uploads come as
// source '3speak' with the uploader's `account`; they are listed first and
// their creator gets a beneficiary share on the post.
const SOURCES = (import.meta.env.VITE_MUSIC_SOURCES || '/music/library.json')
  .split(',').map(s => s.trim()).filter(Boolean)

function normalizeTrack(t, base) {
  const url = new URL(t.url || t.file, base).href
  const is3speak = t.source === '3speak'
  return {
    key: `${t.source || 'lib'}:${t.id}`,
    title: t.title,
    artist: is3speak && t.account ? `@${t.account}` : t.artist,
    mood: t.mood,
    duration: t.duration || 0,
    // Loudness per slice (0-100), computed when the library is built. Older
    // libraries have none; the timeline then draws flat bars.
    peaks: Array.isArray(t.peaks) && t.peaks.length
      ? t.peaks.map(n => Math.max(0, Math.min(100, Number(n) || 0)))
      : null,
    url,
    is3speak,
    credit: {
      id: `${t.source || 'lib'}:${t.id}`,
      title: t.title,
      artist: t.artist || null,
      source: t.source || null,
      sourceUrl: t.sourceUrl || null,
      license: t.license || null,
      licenseUrl: t.licenseUrl || null,
      account: is3speak ? t.account || null : null,
      text: t.credit || ''
    }
  }
}

async function loadLibraries() {
  const moods = new Map()
  const tracks = []
  await Promise.all(SOURCES.map(async (src) => {
    try {
      const base = new URL(src, window.location.origin).href
      // Revalidate every time: /music/ is served with a week of browser cache for
      // the songs, and the list itself changes when the library is rebuilt
      // (new songs, waveforms). An unchanged list is a cheap 304.
      const res = await fetch(base, { cache: 'no-cache' })
      if (!res.ok) return
      const lib = await res.json()
      for (const m of lib.moods || []) if (!moods.has(m.id)) moods.set(m.id, m.label)
      for (const t of lib.tracks || []) {
        if (t && t.id && t.title && (t.url || t.file)) tracks.push(normalizeTrack(t, base))
      }
    } catch (err) {
      console.warn('[MusicLibrary] could not load', src, err)
    }
  }))
  // 3Speak creators' sounds first, the rest in library order
  tracks.sort((a, b) => Number(b.is3speak) - Number(a.is3speak))
  return { moods: [...moods].map(([id, label]) => ({ id, label })), tracks }
}

const formatDuration = (secs) => {
  const s = Math.round(secs)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const FLAT_PEAKS = Array(60).fill(35)

/**
 * A song's timeline: its real waveform, what has played so far, and a place to
 * click or drag to. On a song that is not playing, seeking starts it there.
 * Works as a slider from the keyboard too (arrows: 5s, Home/End).
 */
function Waveform({ peaks, duration, position, active, onSeek, onScrub, title }) {
  const ref = useRef(null)
  // useId() has colons (or guillemets), which some browsers will not resolve
  // inside an SVG url(#...) reference
  const clipId = `wave${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [drag, setDrag] = useState(null) // fraction, while the pointer is down
  const bars = peaks || FLAT_PEAKS
  const n = bars.length
  const frac = drag ?? (active && duration ? Math.min(1, position / duration) : 0)

  const fracAt = (e) => {
    const r = ref.current.getBoundingClientRect()
    return r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0
  }
  const scrubTo = (f) => { setDrag(f); onScrub?.(f * duration) }
  const end = (e, commit) => {
    if (drag === null) return
    const f = commit ? fracAt(e) : null
    setDrag(null)
    onScrub?.(null)
    if (f !== null && duration) onSeek(f * duration)
  }
  const onKeyDown = (e) => {
    if (!duration) return
    const now = active ? position : 0
    const to = { ArrowLeft: now - 5, ArrowRight: now + 5, Home: 0, End: duration - 1 }[e.key]
    if (to === undefined) return
    e.preventDefault()
    onSeek(Math.max(0, Math.min(duration - 0.5, to)))
  }

  return (
    <div
      ref={ref}
      className={`music-wave${active ? ' active' : ''}${drag !== null ? ' dragging' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={`Timeline: ${title}`}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(frac * duration)}
      aria-valuetext={formatDuration(frac * duration)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        ref.current.setPointerCapture(e.pointerId)
        scrubTo(fracAt(e))
      }}
      onPointerMove={(e) => { if (drag !== null) scrubTo(fracAt(e)) }}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onKeyDown={onKeyDown}
    >
      <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y="0" width={frac * n} height="100" />
          </clipPath>
        </defs>
        {[false, true].map(played => (
          <g key={String(played)} className={played ? 'music-wave-played' : 'music-wave-rest'} clipPath={played ? `url(#${clipId})` : undefined}>
            {bars.map((p, i) => {
              const h = Math.max(6, p)
              return <rect key={i} x={i + 0.15} width={0.7} y={(100 - h) / 2} height={h} rx={0.35} />
            })}
          </g>
        ))}
        {(active || drag !== null) && <rect className="music-wave-head" x={frac * n - 0.15} width={0.3} y="0" height="100" />}
      </svg>
    </div>
  )
}

function MusicLibrary({ onPick, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const [mood, setMood] = useState('all')
  const [query, setQuery] = useState('')
  const [playingKey, setPlayingKey] = useState(null)
  const [adding, setAdding] = useState(null)
  // Where the playing song is, read every frame while it plays: 'timeupdate'
  // fires only a few times a second, which makes the playhead jump.
  const [position, setPosition] = useState(0)
  const [scrubTime, setScrubTime] = useState(null)
  const audioRef = useRef(null)

  useEffect(() => {
    if (!playingKey) return undefined
    let raf = 0
    const tick = () => {
      const a = audioRef.current
      if (a) setPosition(a.currentTime || 0)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playingKey])

  useEffect(() => {
    let cancelled = false
    loadLibraries().then(d => {
      if (cancelled) return
      if (!d.tracks.length) setError(true)
      setData(d)
    })
    return () => { cancelled = true }
  }, [])

  // Stop the preview when the sheet closes
  useEffect(() => () => {
    const a = audioRef.current
    if (a) { a.pause(); a.removeAttribute('src') }
  }, [])

  const visible = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.tracks.filter(t =>
      (mood === 'all' || t.mood === mood) &&
      (!q || t.title.toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q))
    )
  }, [data, mood, query])

  const startAt = (track, seconds) => {
    const a = audioRef.current
    if (!a) return
    if (a.getAttribute('src') !== track.url) a.src = track.url
    a.currentTime = seconds
    setPosition(seconds)
    a.play().then(() => setPlayingKey(track.key)).catch(() => setPlayingKey(null))
  }

  const togglePreview = (track) => {
    const a = audioRef.current
    if (!a) return
    if (playingKey === track.key) {
      a.pause()
      setPlayingKey(null)
      return
    }
    startAt(track, 0)
  }

  // Seeking the playing song moves it; seeking any other song starts it there.
  const seek = (track, seconds) => {
    const a = audioRef.current
    if (!a) return
    if (playingKey === track.key) {
      a.currentTime = seconds
      setPosition(seconds)
    } else {
      startAt(track, seconds)
    }
  }

  const handleAdd = async (track) => {
    audioRef.current?.pause()
    setPlayingKey(null)
    setAdding(track.key)
    try {
      await onPick(track)
      onClose()
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div className="remix-picker music-library" role="dialog" aria-modal="true" aria-labelledby="music-library-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <Music size={16} />
          <h3 id="music-library-title">Music</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="music-library-search">
          <Search size={14} />
          <input
            type="search"
            placeholder="Search songs"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        {data && data.moods.length > 0 && (
          <div className="music-library-moods">
            {[{ id: 'all', label: 'All' }, ...data.moods].map(m => (
              <button key={m.id} className={mood === m.id ? 'active' : ''} onClick={() => setMood(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
        )}

        <div className="music-library-list">
          {!data && <div className="music-library-empty">Loading songs...</div>}
          {data && error && <div className="music-library-empty">The music library could not be loaded.</div>}
          {data && !error && visible.length === 0 && <div className="music-library-empty">No songs match.</div>}
          {visible.map(t => (
            <div key={t.key} className={`music-library-row${playingKey === t.key ? ' playing' : ''}`}>
              <button className="music-library-play" onClick={() => togglePreview(t)} title={playingKey === t.key ? 'Stop' : 'Listen'}>
                {playingKey === t.key ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <div className="music-library-info">
                <div className="music-library-title">
                  {t.title}
                  {t.is3speak && <span className="music-library-badge">3Speak</span>}
                </div>
                <div className="music-library-meta">
                  {t.artist} · {playingKey === t.key
                    ? `${formatDuration(scrubTime ?? position)} / ${formatDuration(t.duration)}`
                    : formatDuration(t.duration)}
                </div>
                <Waveform
                  peaks={t.peaks}
                  duration={t.duration}
                  position={position}
                  active={playingKey === t.key}
                  onSeek={(secs) => seek(t, secs)}
                  onScrub={playingKey === t.key ? setScrubTime : undefined}
                  title={t.title}
                />
              </div>
              <button
                className="music-library-add"
                onClick={() => handleAdd(t)}
                disabled={!!adding}
                title="Add to video"
              >
                {adding === t.key ? '...' : <><Plus size={14} /> Add</>}
              </button>
            </div>
          ))}
        </div>

        <p className="music-library-note">
          The song credit is added to your post automatically. Picking a 3Speak creator's sound gives them 5% of the post rewards.
        </p>
        <audio ref={audioRef} onEnded={() => setPlayingKey(null)} preload="none" />
      </div>
    </div>
  )
}

export default MusicLibrary
