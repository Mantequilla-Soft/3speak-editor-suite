import { X } from 'lucide-react'
import { MAX_IMPORT_BYTES, formatBytes } from '../utils/limits'

/** Files refused at import because they are over the editor's size limit. */
function TooLargeNotice({ files, onClose }) {
  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div className="remix-picker length-notice" role="dialog" aria-modal="true" aria-labelledby="too-large-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="too-large-title">{files.length === 1 ? 'This file is too big' : 'These files are too big'}</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
        </div>
        <ul className="too-large-list">
          {files.map((f, i) => <li key={`${f.name}-${i}`}><span>{f.name}</span><strong>{formatBytes(f.size)}</strong></li>)}
        </ul>
        <p className="length-notice-text">
          The editor takes files up to {formatBytes(MAX_IMPORT_BYTES)}. Shorten or compress the video first
          (a phone or any video app can export a smaller copy), then add it again.
        </p>
        <button className="length-notice-ok" onClick={onClose} autoFocus>OK</button>
      </div>
    </div>
  )
}

export default TooLargeNotice
