import { RotateCcw } from './icons'
import { normalizePersonKey, PERSON_DEFAULTS, PERSON_RANGES, BLUR_RANGE, BLUR_DEFAULT } from '../utils/personMask'
import { clearPersonMaskError } from '../utils/personMaskJobs'
import { usePersonMaskStatus } from '../hooks/usePersonMasks'
import { useT, formatNumber } from '../i18n'

const BACKGROUNDS = ['none', 'blur', 'color']

/**
 * Background removal without a green screen (clip settings, "Person" in the
 * green screen box): progress while the editor finds the person in the clip,
 * the edge, and what goes behind (see-through, blur, a colour, or a stock
 * picture / clip placed on a track below: onPickBackground(clipId)).
 */
export default function PersonKeyControls({ clip, onUpdateClip, onPickBackground }) {
  const { t } = useT()
  const key = normalizePersonKey(clip.chromaKey)
  const status = usePersonMaskStatus(key.maskUrl ? null : clip)
  const set = (patch) => onUpdateClip({ chromaKey: { ...clip.chromaKey, ...patch } })
  const setBg = (patch) => set({ background: { ...key.background, ...patch } })
  const pct = (v) => Math.round(v * 100)

  return (
    <>
      <div className="property-group">
        {key.maskUrl ? (
          <small className="layout-hint">{t('clip.personKey.ready')}</small>
        ) : status?.error ? (
          <>
            <small className="layout-hint">{t('clip.personKey.failed', { error: status.error })}</small>
            <button className="layout-free-btn" onClick={() => clearPersonMaskError(clip)}>{t('common.retry')}</button>
          </>
        ) : (
          <>
            <small className="layout-hint">
              {status ? t('clip.personKey.findingProgress', { percent: formatNumber(status.progress || 0, { style: 'percent', maximumFractionDigits: 0 }) }) : t('clip.personKey.finding')}
            </small>
            <div className="person-key-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((status?.progress || 0) * 100)}>
              <span style={{ width: `${Math.round((status?.progress || 0) * 100)}%` }} />
            </div>
          </>
        )}
      </div>

      <div className="property-group">
        <label>{t('clip.personKey.behind')}</label>
        <div className="text-align-buttons chroma-mode-buttons">
          {BACKGROUNDS.map((kind) => (
            <button key={kind} className={`text-align-btn ${key.background.kind === kind ? 'active' : ''}`} onClick={() => setBg({ kind })} title={t(`clip.personKey.backgrounds.${kind}Title`)}>
              {t(`clip.personKey.backgrounds.${kind}`)}
            </button>
          ))}
        </div>
        {key.background.kind === 'none' && onPickBackground && (
          <button className="layout-free-btn" onClick={() => onPickBackground(clip.id)}>
            {t('clip.personKey.pickStock')}
          </button>
        )}
        {key.background.kind === 'color' && (
          <label className="person-key-color">
            {t('clip.personKey.colour')}
            <input type="color" value={key.background.color} onChange={(e) => setBg({ color: e.target.value })} />
          </label>
        )}
      </div>

      {key.background.kind === 'blur' && (
        <div className="property-group">
          <label>
            {t('clip.personKey.blur')}
            <button className="prop-reset-btn" onClick={() => setBg({ blur: BLUR_DEFAULT })} title={t('clip.personKey.resetBlur')}><RotateCcw size={10} /></button>
          </label>
          <div className="property-slider">
            <input
              type="range"
              min={Math.round(BLUR_RANGE[0] * 1000)}
              max={Math.round(BLUR_RANGE[1] * 1000)}
              value={Math.round(key.background.blur * 1000)}
              onChange={(e) => setBg({ blur: parseInt(e.target.value) / 1000 })}
            />
            <span>{Math.round(key.background.blur * 1000) / 10}%</span>
          </div>
        </div>
      )}

      <div className="property-group">
        <label title={t('clip.personKey.thresholdTitle')}>
          {t('clip.greenScreen.threshold')}
          <button className="prop-reset-btn" onClick={() => set({ threshold: PERSON_DEFAULTS.threshold })} title={t('clip.greenScreen.resetThreshold')}><RotateCcw size={10} /></button>
        </label>
        <div className="property-slider">
          <input
            type="range"
            min={pct(PERSON_RANGES.threshold[0])}
            max={pct(PERSON_RANGES.threshold[1])}
            value={pct(key.threshold)}
            onChange={(e) => set({ threshold: parseInt(e.target.value) / 100 })}
          />
          <span>{pct(key.threshold)}%</span>
        </div>
      </div>
      <div className="property-group">
        <label>
          {t('clip.greenScreen.softness')}
          <button className="prop-reset-btn" onClick={() => set({ softness: PERSON_DEFAULTS.softness })} title={t('clip.greenScreen.resetSoftness')}><RotateCcw size={10} /></button>
        </label>
        <div className="property-slider">
          <input
            type="range"
            min={pct(PERSON_RANGES.softness[0])}
            max={pct(PERSON_RANGES.softness[1])}
            value={pct(key.softness)}
            onChange={(e) => set({ softness: parseInt(e.target.value) / 100 })}
          />
          <span>{pct(key.softness)}%</span>
        </div>
      </div>
    </>
  )
}
