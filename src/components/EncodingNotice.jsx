import { Loader2, X, Check } from 'lucide-react'

const pct = (p) => `${Math.round((p || 0) * 100)}%`

/**
 * Shown as soon as footage this browser cannot show (HEVC / HDR phone video)
 * is added: it has to be uploaded and converted to a playable copy before the
 * preview can show it. Closes itself when the copy is in; the X just hides
 * it, the library badge keeps the status.
 */
function EncodingNotice({ items, onClose }) {
  const first = items[0]
  const uploading = !!first.uploading
  const ahead = first.convertAhead || 0
  const name = items.length > 1 ? `${items.length} videos` : first.name

  let convertStatus = 'Next'
  if (!uploading) {
    if (ahead > 0) convertStatus = `Waiting for ${ahead} other video${ahead === 1 ? '' : 's'}`
    else if (first.convertProgress != null) convertStatus = pct(first.convertProgress)
    else convertStatus = 'Starting…'
  }
  // One bar across both steps: upload is the first half, conversion the second
  const overall = uploading ? (first.uploadProgress || 0) / 2 : 0.5 + (first.convertProgress || 0) / 2

  return (
    <div className="hls-download-overlay">
      <div className="hls-download-modal encoding-notice" role="dialog" aria-modal="true" aria-labelledby="encoding-notice-title">
        <button className="remix-picker-icon-btn encoding-notice-close" onClick={onClose} title="Hide">
          <X size={16} />
        </button>
        <Loader2 size={32} className="hls-download-icon encoding-notice-spin" />
        <h3 id="encoding-notice-title">This video needs converting first</h3>
        <p className="hls-download-name">{name}</p>
        <div className="hls-download-progress-bar">
          <div className="hls-download-progress-fill" style={{ width: pct(overall) }} />
        </div>
        <ol className="encoding-notice-steps">
          <li className={uploading ? 'active' : 'done'}>
            {uploading ? <Loader2 size={13} className="encoding-notice-spin" /> : <Check size={13} />}
            <span>Upload</span>
            <strong>{uploading ? pct(first.uploadProgress) : 'Done'}</strong>
          </li>
          <li className={uploading ? '' : 'active'}>
            {uploading ? <span className="encoding-notice-dot" /> : <Loader2 size={13} className="encoding-notice-spin" />}
            <span>Convert to a playable copy</span>
            <strong>{convertStatus}</strong>
          </li>
        </ol>
        <p className="hls-download-hint">
          This browser cannot play this video&apos;s format (HEVC or HDR, common from phones), so it
          shows black until the playable copy is ready. The preview then switches to it by itself.
          You can keep editing meanwhile.
        </p>
      </div>
    </div>
  )
}

export default EncodingNotice
