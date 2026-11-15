import { useState } from 'react'
import { ChevronLeft, ChevronRight, ZoomIn, Loader2 } from './icons'
import { KEYFRAME_PROPS, VISUAL_PROPS, propsFor, keyframesOf, normalizeKeyframes } from '../utils/keyframes'
import { clipTimeAtPlayhead, keyframeIndexAt, setKeyframe, toggleKeyframe, setKeyframeEase, clearKeyframes, valueAtPlayhead, KEN_BURNS, kenBurns } from '../utils/motionEdits'
import { planPunchIns, punchInUpdates, hasPunchIns, removePunchIns } from '../utils/punchIns'
import { loadLoudness } from '../utils/silenceDetect'
import { hasLayout } from '../utils/remixLayout'
import { isHlsUrl } from '../utils/hlsHelper'
import { useT } from '../i18n'
import './ClipMotion.css'

const NEAR = 1 / 30
const shown = (v, unit) => `${Math.round(v)}${unit}`

/**
 * Keyframes of the selected clip: position, scale, rotation, opacity (video,
 * image, text) and volume (audio; a video's volume is its linked sound's).
 * The diamond adds or removes a keyframe at the playhead, the arrows jump to
 * the previous / next one, the slider sets the value at the playhead.
 * Presets: Ken Burns (images), automatic punch-ins (video).
 * `kit` = { setPlayhead, captions, fileStoreRef }.
 */
function KeyframeControls({ clip, playheadPosition, onUpdateClip, linkedAudio = null, onUpdateLinkedAudio = null, kit = null }) {
  const { t } = useT()
  const [punch, setPunch] = useState(null) // { busy } | { note }
  const visual = hasLayout(clip) ? [] : VISUAL_PROPS
  const props = propsFor(clip.type).filter(p => p === 'volume' || visual.includes(p))
  if (!props.length) return null
  // A video's sound is its linked clip on the audio track
  const soundTarget = clip.type === 'video' ? (linkedAudio && onUpdateLinkedAudio ? linkedAudio : null) : clip
  const rows = props.filter(p => p !== 'volume' || soundTarget)
  const targetOf = (p) => (p === 'volume' ? soundTarget : clip)
  const updateOf = (p) => (p === 'volume' && soundTarget !== clip ? onUpdateLinkedAudio : onUpdateClip)
  const onClip = clipTimeAtPlayhead(clip, playheadPosition) !== null
  const toTimeline = (target, kt) => (target.timelinePosition || 0) + (kt - target.startTime)
  const jump = (target, kt) => kit?.setPlayhead?.(Math.max(0, toTimeline(target, kt)))

  // Every keyframe at the playhead, for the ease switch
  const here = rows.flatMap(p => {
    const target = targetOf(p)
    const tt = clipTimeAtPlayhead(target, playheadPosition)
    if (tt === null) return []
    const i = keyframeIndexAt(keyframesOf(target, p), tt)
    return i >= 0 ? [{ p, target, tt, k: keyframesOf(target, p)[i] }] : []
  })
  const eased = here.length > 0 && here.every(h => h.k.ease === 'ease')
  const setEase = (on) => {
    for (const h of here) updateOf(h.p)(setKeyframeEase(h.target, h.p, h.tt, on ? 'ease' : 'linear'))
  }
  const animated = !!normalizeKeyframes(clip.keyframes) || !!(soundTarget && soundTarget !== clip && normalizeKeyframes(soundTarget.keyframes))
  const clearAll = () => {
    if (normalizeKeyframes(clip.keyframes)) onUpdateClip(clearKeyframes(clip))
    if (soundTarget && soundTarget !== clip && normalizeKeyframes(soundTarget.keyframes)) onUpdateLinkedAudio(clearKeyframes(soundTarget))
  }

  const runPunchIns = async () => {
    setPunch({ busy: true })
    const words = kit?.captions?.words?.length ? kit.captions.words : null
    let loudness = null
    const sound = soundTarget || clip
    const source = kit?.fileStoreRef?.current.get(sound.id) || (isHlsUrl(sound.url) ? null : sound.url)
    try {
      if (source || sound.serverUrl) loudness = await loadLoudness(source || sound.serverUrl, { analysisUrl: sound.serverUrl || null })
    } catch { loudness = null }
    const plan = planPunchIns(clip, { words, loudness })
    if (!plan.moments.length) {
      setPunch({ note: words || loudness ? t('motion.punch.noMoments') : t('motion.punch.noSound') })
      return
    }
    onUpdateClip(punchInUpdates(clip, plan.moments))
    const count = plan.moments.length
    setPunch({ note: plan.from === 'captions' ? t('motion.punch.addedCaptions', { count }) : t('motion.punch.addedSound', { count }) })
  }

  return (
    <div className="prop-group">
      <div className="prop-group-label">{t('motion.keyframes.title')}</div>
      {!onClip && <span className="motion-hint">{t('motion.keyframes.moveHere')}</span>}

      {rows.map(p => {
        const def = KEYFRAME_PROPS.find(x => x.id === p)
        const target = targetOf(p)
        const update = updateOf(p)
        const tt = clipTimeAtPlayhead(target, playheadPosition)
        const list = keyframesOf(target, p)
        const at = tt === null ? -1 : keyframeIndexAt(list, tt)
        const prev = tt === null ? null : [...list].reverse().find(k => k.t < tt - NEAR) || null
        const next = tt === null ? null : list.find(k => k.t > tt + NEAR) || null
        const value = valueAtPlayhead(target, p, playheadPosition)
        const max = p === 'volume' && clip.type !== 'audio' ? 100 : def.max
        const name = t(`motion.keyframes.props.${p}`)
        return (
          <div className="kf-row" key={p}>
            <span className="kf-name" title={name}>{name}</span>
            <div className="property-slider">
              <input type="range" min={def.min} max={max} step={def.step} value={Math.round(value)} disabled={tt === null}
                aria-label={name}
                onChange={(e) => {
                  const v = +e.target.value
                  // With keyframes the slider sets the one at the playhead; without, the clip's own value
                  update(list.length ? setKeyframe(target, p, tt, v) : { [def.field]: v })
                }} />
              <span>{shown(value, def.unit)}</span>
            </div>
            <div className="kf-nav">
              <button onClick={() => prev && jump(target, prev.t)} disabled={!prev} title={t('motion.keyframes.prev')} aria-label={t(`motion.keyframes.aria.${p}.prev`)}><ChevronLeft size={14} /></button>
              <button className={`kf-diamond-btn${at >= 0 ? ' on' : ''}${list.length ? ' animated' : ''}`} disabled={tt === null}
                onClick={() => update(toggleKeyframe(target, p, tt))}
                title={at >= 0 ? t('motion.keyframes.remove') : t('motion.keyframes.add')}
                aria-label={at >= 0 ? t(`motion.keyframes.aria.${p}.remove`) : t(`motion.keyframes.aria.${p}.add`)} aria-pressed={at >= 0}>
                <span className="kf-diamond" />
              </button>
              <button onClick={() => next && jump(target, next.t)} disabled={!next} title={t('motion.keyframes.next')} aria-label={t(`motion.keyframes.aria.${p}.next`)}><ChevronRight size={14} /></button>
            </div>
          </div>
        )
      })}

      {here.length > 0 && (
        <div className="kf-ease">
          <label className="toggle-switch">
            <input type="checkbox" checked={eased} onChange={(e) => setEase(e.target.checked)} aria-label={t('motion.keyframes.ease')} />
            <span className="toggle-slider" />
          </label>
          {t('motion.keyframes.ease')}
        </div>
      )}

      {clip.type === 'image' && visual.length > 0 && (
        <div className="property-group">
          <label>{t('motion.kenBurns.title')}</label>
          <div className="motion-chips">
            {KEN_BURNS.map(k => (
              <button key={k.id} className="motion-chip"
                onClick={() => onUpdateClip(kenBurns(clip, k.id, document.querySelector('.preview-layer-container')?.clientWidth || 360))}>
                {k.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {clip.type === 'video' && visual.length > 0 && (
        <div className="property-group">
          <label><ZoomIn size={12} /> {t('motion.punch.title')}</label>
          <span className="motion-hint">{t('motion.punch.hint')}</span>
          <div className="motion-row">
            <button className="mute-btn" onClick={runPunchIns} disabled={!!punch?.busy}>
              {punch?.busy ? <><Loader2 size={12} className="encoding-notice-spin" /> {t('motion.punch.listening')}</> : t('motion.punch.auto')}
            </button>
            {hasPunchIns(clip) && (
              <button className="mute-btn" onClick={() => { onUpdateClip(removePunchIns(clip)); setPunch(null) }}>{t('motion.punch.remove')}</button>
            )}
          </div>
          {punch?.note && <span className="motion-hint" role="status">{punch.note}</span>}
        </div>
      )}

      {animated && (
        <button className="mute-btn" onClick={clearAll}>{t('motion.keyframes.removeAll')}</button>
      )}
    </div>
  )
}

export default KeyframeControls
