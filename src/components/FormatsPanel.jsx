import { useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, Download, Send, Loader2, Check, RotateCcw, Film, ExternalLink } from './icons'
import { AspectDiagram, ProBadge } from './ProjectFormat'
import { ASPECT_INFO, aspectLabel, isShortAspect } from '../utils/projectFormat'
import { EXPORT_ASPECTS, runRenderJob } from '../utils/exportAs'
import { isReframable, normalizeReframe } from '../utils/reframe'
import { trackClipFaces } from '../utils/faceTrack'
import { maxSecondsFor, limitText } from '../utils/limits'
import { isHlsUrl } from '../utils/hlsHelper'
import { isProRefusal } from '../utils/landscapeAccess'
import { useT } from '../i18n'

// A clip's footage the face tracker can open here: its own file, else the
// editing copy on our backend (an HLS stream can not be read frame by frame)
function trackableUrl(clip, fileStore) {
  const file = fileStore?.get(clip.id) || clip.file
  if (file) return { url: URL.createObjectURL(file), local: true }
  for (const u of [clip.url, clip.serverUrl]) {
    if (u && !isHlsUrl(u)) return { url: u, local: false }
  }
  return null
}

/**
 * "Export as": the project in other shapes (9:16, 1:1, 16:9, 4:3) from one
 * timeline. Beside the preview, so the preview can show each shape: footage is
 * cut around the face the browser finds in it (Find faces), and each clip's
 * window can be shifted by hand. Then every ticked shape is rendered as its own
 * video, to download or to send to 3Speak (a 9:16 one as a Short, the others
 * as a normal video). lockedAspects: shapes this user may not render (the landscape editor is
 * 3Speak Pro, utils/landscapeAccess.js), shown with the Pro mark and not ticked.
 */
export default function FormatsPanel({
  projectAspect, viewAspect, onViewAspect, tracks, fileStore, onUpdateClip, selectedClipId, onSelectClip,
  timelineEnd, buildPayload, canRender, renderBlocked, canSend, onSend,
  lockedAspects = [], upgradeUrl = null, onProRequired = () => {}
}) {
  const { t, formatNumber } = useT()
  const percent = (p) => formatNumber(p, { style: 'percent', maximumFractionDigits: 0 })
  const shown = viewAspect || projectAspect
  const clips = useMemo(() => tracks
    .filter(t => t.type === 'video' && t.visible !== false)
    .flatMap(t => t.clips.filter(isReframable)), [tracks])
  const [tracking, setTracking] = useState(null) // { id, progress, done, total }
  const [trackError, setTrackError] = useState(null)
  const [targets, setTargets] = useState(() => EXPORT_ASPECTS.filter(a => a !== projectAspect && !isShortAspect(a)).slice(0, 1))
  const [jobs, setJobs] = useState({}) // aspect -> { status, progress, phase, outputUrl, subtitles, error }
  const stopRef = useRef(null)
  useEffect(() => () => stopRef.current?.abort(), [])

  const selected = clips.find(c => c.id === selectedClipId) || null
  const reframe = selected ? normalizeReframe(selected.reframe) : null
  const tooLongFor = (a) => timelineEnd > maxSecondsFor('video', a) + 0.01
  const lockedFor = (a) => lockedAspects.includes(a)
  const renderable = (a) => targets.includes(a) && !tooLongFor(a) && !lockedFor(a)
  const rendering = Object.values(jobs).some(j => j.status === 'running' || j.status === 'waiting')
  const busy = !!tracking || rendering
  const renderCount = EXPORT_ASPECTS.filter(renderable).length

  const findFaces = async (list) => {
    const ctrl = new AbortController()
    stopRef.current = ctrl
    setTrackError(null)
    try {
      for (let i = 0; i < list.length; i++) {
        const clip = list[i]
        setTracking({ id: clip.id, progress: 0, done: i, total: list.length })
        const src = trackableUrl(clip, fileStore)
        if (!src) { setTrackError(clip.name ? t('formats.faces.streamNamed', { name: clip.name }) : t('formats.faces.streamUnnamed')); continue }
        try {
          const r = await trackClipFaces({
            url: src.url,
            start: clip.startTime || 0,
            end: clip.endTime,
            signal: ctrl.signal,
            onProgress: (p) => setTracking(t => (t ? { ...t, progress: p } : t))
          })
          const old = normalizeReframe(clip.reframe)
          onUpdateClip(clip.id, { reframe: { path: r.path, aspect: r.aspect, offsetX: old?.offsetX || 0, offsetY: old?.offsetY || 0 } })
        } finally {
          if (src.local) URL.revokeObjectURL(src.url)
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') setTrackError(t('formats.faces.failed', { error: err.message }))
    } finally {
      setTracking(null)
      stopRef.current = null
    }
  }

  const shift = (key, value) => {
    if (!selected) return
    const r = normalizeReframe(selected.reframe) || normalizeReframe({ path: [] })
    onUpdateClip(selected.id, { reframe: { ...r, [key]: value } })
  }

  const toggleTarget = (a) => setTargets(t => (t.includes(a) ? t.filter(x => x !== a) : [...t, a]))
  const render = async () => {
    const ctrl = new AbortController()
    stopRef.current = ctrl
    const list = EXPORT_ASPECTS.filter(renderable)
    setJobs(Object.fromEntries(list.map(a => [a, { status: 'waiting', progress: 0, phase: t('formats.job.waiting') }])))
    for (const a of list) {
      const set = (patch) => setJobs(j => ({ ...j, [a]: { ...j[a], ...patch } }))
      try {
        set({ status: 'running', phase: t('formats.job.preparing') })
        const payload = await buildPayload(a, (phase) => set({ phase }))
        const r = await runRenderJob(payload, { signal: ctrl.signal, onStatus: (s) => set(s) })
        set({ status: 'completed', progress: 1, phase: t('formats.job.done'), outputUrl: r.outputUrl, subtitles: r.subtitles || null })
      } catch (err) {
        if (err?.name === 'AbortError') { set({ status: 'stopped', phase: t('formats.job.stopped') }); break }
        if (isProRefusal(err)) { set({ status: 'failed', error: t('pro.refused') }); onProRequired(err.body); continue }
        set({ status: 'failed', error: err.message })
      }
    }
    stopRef.current = null
  }

  return (
    <div className="formats-panel">
      <section className="formats-section">
        <h4>{t('formats.preview.heading')}</h4>
        <div className="formats-chips" role="group" aria-label={t('formats.preview.heading')}>
          {EXPORT_ASPECTS.map(a => (
            <button key={a} className="formats-chip" aria-pressed={shown === a} onClick={() => onViewAspect(a === projectAspect ? null : a)}>
              <AspectDiagram aspect={a} size={22} />{a === projectAspect ? t('formats.preview.yours', { aspect: a }) : a}
            </button>
          ))}
        </div>
        <p>{t(`formats.preview.projectIs.${ASPECT_INFO[projectAspect]?.id || 'short'}`)}</p>
      </section>

      <section className="formats-section">
        <h4>{t('formats.faces.heading')}</h4>
        {clips.length === 0 ? (
          <p>{t('formats.faces.noFootage')}</p>
        ) : (
          <>
            <p>{t('formats.faces.hint')}</p>
            <ul className="formats-clips">
              {clips.map(c => {
                const r = normalizeReframe(c.reframe)
                const state = tracking?.id === c.id
                  ? percent(tracking.progress)
                  : r?.aspect ? (r.path.length ? t('formats.faces.found') : t('formats.faces.noFace')) : t('formats.faces.middle')
                return (
                  <li key={c.id}>
                    <button className="formats-clip" aria-pressed={c.id === selectedClipId} onClick={() => onSelectClip(c.id)}>
                      <Film size={14} />
                      <span className="formats-clip-name">{c.name || t('formats.clipFallback')}</span>
                      <span className="formats-clip-state">{state}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {tracking && (
              <div className="formats-progress" aria-label={t('formats.faces.finding')}><span style={{ width: `${Math.round(((tracking.done + tracking.progress) / tracking.total) * 100)}%` }} /></div>
            )}
            <div className="formats-row">
              {tracking ? (
                <button className="formats-btn" onClick={() => stopRef.current?.abort()}>{t('formats.stop')}</button>
              ) : (
                <button className="formats-btn" onClick={() => findFaces(clips)} disabled={busy}>
                  <Crosshair size={14} />{clips.length === 1 ? t('formats.faces.findOne') : t('formats.faces.findMany', { count: clips.length })}
                </button>
              )}
            </div>
            {trackError && <p className="formats-error" role="alert">{trackError}</p>}
            {selected && (
              <div className="formats-section">
                <h4>{t('formats.faces.moveWindow', { name: selected.name || t('formats.clipFallback') })}</h4>
                <div className="formats-shift">
                  <span>{t('formats.faces.left')}</span>
                  <input type="range" min="-0.5" max="0.5" step="0.01" value={reframe?.offsetX || 0} onChange={e => shift('offsetX', +e.target.value)} aria-label={t('formats.faces.moveX')} />
                  <span>{t('formats.faces.right')}</span>
                  <span>{t('formats.faces.up')}</span>
                  <input type="range" min="-0.5" max="0.5" step="0.01" value={reframe?.offsetY || 0} onChange={e => shift('offsetY', +e.target.value)} aria-label={t('formats.faces.moveY')} />
                  <span>{t('formats.faces.down')}</span>
                </div>
                <div className="formats-row">
                  <button className="formats-btn" onClick={() => findFaces([selected])} disabled={busy}><Crosshair size={14} />{t('formats.faces.findAgain')}</button>
                  <button className="formats-btn" onClick={() => onUpdateClip(selected.id, { reframe: null })} disabled={busy}><RotateCcw size={14} />{t('formats.faces.reset')}</button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="formats-section">
        <h4>{t('formats.render.heading')}</h4>
        <div className="formats-chips" role="group" aria-label={t('formats.render.heading')}>
          {EXPORT_ASPECTS.map(a => (
            <button key={a} className="formats-chip" aria-pressed={targets.includes(a) && !lockedFor(a)} disabled={tooLongFor(a) || lockedFor(a) || rendering} onClick={() => toggleTarget(a)}
              title={lockedFor(a) ? t('pro.shapeTitle') : tooLongFor(a) ? t(isShortAspect(a) ? 'common.limits.atMost.short' : 'common.limits.atMost.video', { limit: limitText(maxSecondsFor('video', a)) }) : undefined}>
              {targets.includes(a) && !lockedFor(a) ? <Check size={14} /> : <AspectDiagram aspect={a} size={22} />}{aspectLabel(a)}{lockedFor(a) && <ProBadge />}
            </button>
          ))}
        </div>
        {lockedAspects.length > 0 && (
          <p>
            {t('pro.exportAs')}{' '}
            {upgradeUrl && <a className="formats-pro-link" href={upgradeUrl} target="_blank" rel="noopener noreferrer">{t('pro.landscape.get')} <ExternalLink size={12} /></a>}
          </p>
        )}
        {EXPORT_ASPECTS.some(tooLongFor) && <p>{t('formats.render.shortsLimit', { limit: limitText(maxSecondsFor('video', '9:16')) })}</p>}
        {renderBlocked && <p className="formats-error">{renderBlocked}</p>}
        <div className="formats-row">
          {rendering ? (
            <button className="formats-btn" onClick={() => stopRef.current?.abort()}>{t('formats.stop')}</button>
          ) : (
            <button className="formats-btn primary" onClick={render} disabled={!canRender || !!tracking || renderCount === 0}>
              <Film size={14} />{t('formats.render.button', { count: renderCount })}
            </button>
          )}
        </div>
        {EXPORT_ASPECTS.filter(a => jobs[a]).map(a => {
          const j = jobs[a]
          return (
            <div key={a} className="formats-result">
              <div className="formats-result-head">
                <AspectDiagram aspect={a} size={22} />
                <span>{aspectLabel(a)}</span>
                {j.status === 'running' && <Loader2 size={14} className="encoding-notice-spin" />}
                <span className="formats-result-phase">{j.status === 'running' ? `${j.phase || ''} ${percent(j.progress || 0)}` : j.status === 'failed' ? '' : j.phase}</span>
              </div>
              {j.status === 'running' && <div className="formats-progress"><span style={{ width: `${Math.round((j.progress || 0) * 100)}%` }} /></div>}
              {j.status === 'failed' && <span className="formats-error">{t('formats.render.failed', { error: j.error })}</span>}
              {j.status === 'completed' && (
                <div className="formats-row">
                  <a className="formats-btn" href={j.outputUrl} download target="_blank" rel="noopener noreferrer"><Download size={14} />{t('formats.render.download')}</a>
                  {canSend && (
                    <button className="formats-btn" onClick={() => onSend({ outputUrl: j.outputUrl, aspect: a, subtitles: j.subtitles })}>
                      <Send size={14} />{isShortAspect(a) ? t('formats.render.postShort') : t('formats.render.postVideo')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </section>
    </div>
  )
}
