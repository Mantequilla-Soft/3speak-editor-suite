import { X } from './icons'
import { MAX_IMPORT_BYTES, formatBytes } from '../utils/limits'
import { useT } from '../i18n'

/** Files refused at import because they are over the editor's size limit. */
function TooLargeNotice({ files, onClose }) {
  const { t } = useT()
  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div className="remix-picker length-notice" role="dialog" aria-modal="true" aria-labelledby="too-large-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="too-large-title">{t('notices.tooLarge.title', { count: files.length })}</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title={t('common.close')}><X size={16} /></button>
        </div>
        <ul className="too-large-list">
          {files.map((f, i) => <li key={`${f.name}-${i}`}><span>{f.name}</span><strong>{formatBytes(f.size)}</strong></li>)}
        </ul>
        <p className="length-notice-text">
          {t('notices.tooLarge.body', { size: formatBytes(MAX_IMPORT_BYTES) })}
        </p>
        <button className="length-notice-ok" onClick={onClose} autoFocus>{t('common.ok')}</button>
      </div>
    </div>
  )
}

export default TooLargeNotice
