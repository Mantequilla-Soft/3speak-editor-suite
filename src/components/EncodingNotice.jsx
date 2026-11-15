import { Loader2, X, Check } from './icons'
import { useT, formatNumber } from '../i18n'

// shown text ("45 %" in some languages) and the bar's CSS width are not the same thing
const pct = (p) => formatNumber(p || 0, { style: 'percent', maximumFractionDigits: 0 })
const cssPct = (p) => `${Math.round((p || 0) * 100)}%`

/**
 * Shown as soon as footage this browser cannot show (HEVC / HDR phone video)
 * is added: it has to be uploaded and converted to a playable copy before the
 * preview can show it. Closes itself when the copy is in; the X just hides
 * it, the library badge keeps the status.
 */
function EncodingNotice({ items, onClose }) {
  const { t } = useT()
  const first = items[0]
  const uploading = !!first.uploading
  const ahead = first.convertAhead || 0
  const name = items.length > 1 ? t('notices.encoding.videos', { count: items.length }) : first.name

  let convertStatus = t('notices.encoding.next')
  if (!uploading) {
    if (ahead > 0) convertStatus = t('notices.encoding.waiting', { count: ahead })
    else if (first.convertProgress != null) convertStatus = pct(first.convertProgress)
    else convertStatus = t('notices.encoding.starting')
  }
  // One bar across both steps: upload is the first half, conversion the second
  const overall = uploading ? (first.uploadProgress || 0) / 2 : 0.5 + (first.convertProgress || 0) / 2

  return (
    <div className="hls-download-overlay">
      <div className="hls-download-modal encoding-notice" role="dialog" aria-modal="true" aria-labelledby="encoding-notice-title">
        <button className="remix-picker-icon-btn encoding-notice-close" onClick={onClose} title={t('notices.encoding.hide')}>
          <X size={16} />
        </button>
        <Loader2 size={32} className="hls-download-icon encoding-notice-spin" />
        <h3 id="encoding-notice-title">{t('notices.encoding.title')}</h3>
        <p className="hls-download-name">{name}</p>
        <div className="hls-download-progress-bar">
          <div className="hls-download-progress-fill" style={{ width: cssPct(overall) }} />
        </div>
        <ol className="encoding-notice-steps">
          <li className={uploading ? 'active' : 'done'}>
            {uploading ? <Loader2 size={13} className="encoding-notice-spin" /> : <Check size={13} />}
            <span>{t('notices.encoding.upload')}</span>
            <strong>{uploading ? pct(first.uploadProgress) : t('common.done')}</strong>
          </li>
          <li className={uploading ? '' : 'active'}>
            {uploading ? <span className="encoding-notice-dot" /> : <Loader2 size={13} className="encoding-notice-spin" />}
            <span>{t('notices.encoding.convert')}</span>
            <strong>{convertStatus}</strong>
          </li>
        </ol>
        <p className="hls-download-hint">
          {t('notices.encoding.hint')}
        </p>
      </div>
    </div>
  )
}

export default EncodingNotice
