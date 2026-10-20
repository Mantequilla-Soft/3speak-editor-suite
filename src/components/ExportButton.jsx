import { useState } from 'react'
import { Download, Settings, X, Send, ExternalLink } from 'lucide-react'
import { MAX_TIMELINE_TEXT, formatLength } from '../utils/limits'

// Quality presets mapped to CRF values (lower CRF = higher quality, larger file)
const QUALITY_PRESETS = [
  { label: 'High (larger file)', crf: 18, bitrate: '~15-25 Mbps' },
  { label: 'Medium (recommended)', crf: 23, bitrate: '~8-12 Mbps' },
  { label: 'Low (smaller file)', crf: 28, bitrate: '~3-5 Mbps' },
]

function ExportButton({
  tracks,
  clips,
  backgroundMusic,
  ffmpegLoaded,
  ffmpegLoading,
  exporting,
  exportProgress,
  exportPhase,
  onExport,
  onCanvasExport,
  onCancelExport,
  isIframe,
  onRenderRequest,
  renderStatus,
  onClearRenderStatus,
  timelineEnd = 0,
  overLengthLimit = false,
  pendingUpload = null
}) {
  const [error, setError] = useState(null)
  const [quality, setQuality] = useState(23) // Default to medium quality (CRF 23)
  const [showSettings, setShowSettings] = useState(false)
  const [useCanvasExport, setUseCanvasExport] = useState(true) // Default to canvas export

  const isBackendRendering = renderStatus && (renderStatus.status === 'submitting' || renderStatus.status === 'processing')

  const canExport = !overLengthLimit && !pendingUpload && (isIframe
    ? clips.length > 0 && !exporting && !isBackendRendering
    : ffmpegLoaded && clips.length > 0 && !exporting)

  const handleExport = async () => {
    setError(null)

    // In iframe mode, send to backend render service
    if (isIframe && onRenderRequest) {
      onRenderRequest()
      return
    }

    try {
      if (useCanvasExport && onCanvasExport) {
        // Canvas-based export (captures all visual effects)
        await onCanvasExport(tracks, backgroundMusic, { crf: quality })
      } else {
        // FFmpeg-only export (faster but no visual effects)
        await onExport(clips, backgroundMusic, { crf: quality })
      }
    } catch (err) {
      setError(err.message || 'Export failed')
    }
  }

  const handleCancel = () => {
    if (onCancelExport) {
      onCancelExport()
    }
  }

  const selectedPreset = QUALITY_PRESETS.find(p => p.crf === quality) || QUALITY_PRESETS[1]

  return (
    <div className="export-section">
      <div className="export-controls">
        <button
          className="export-btn"
          onClick={handleExport}
          disabled={!canExport}
        >
          {isIframe
            ? <Send size={20} style={{ marginRight: '0.5rem', verticalAlign: 'middle' }} />
            : <Download size={20} style={{ marginRight: '0.5rem', verticalAlign: 'middle' }} />
          }
          {isBackendRendering ? 'Rendering...' : exporting ? 'Exporting...' : (isIframe ? 'Render' : 'Export Video')}
        </button>
        {exporting && onCancelExport && (
          <button
            className="export-cancel-btn"
            onClick={handleCancel}
            title="Cancel export"
          >
            <X size={16} />
          </button>
        )}
        {!exporting && !isIframe && (
          <button
            className="export-settings-btn"
            onClick={() => setShowSettings(!showSettings)}
            title="Export settings"
          >
            <Settings size={16} />
          </button>
        )}
      </div>

      {pendingUpload && (
        <div className="export-upload-status" role="status">
          <div className="export-upload-bar"><div style={{ width: `${Math.round(pendingUpload.progress * 100)}%` }} /></div>
          <p>
            Uploading {pendingUpload.name} ({Math.round(pendingUpload.progress * 100)}%). Keep editing; {isIframe ? 'Render' : 'Export'} unlocks when it is done.
          </p>
        </div>
      )}

      {overLengthLimit && (
        <p className="export-length-hint">
          Timeline is {formatLength(timelineEnd)}. Trim it to {MAX_TIMELINE_TEXT} or less to {isIframe ? 'render' : 'export'}.
        </p>
      )}

      {showSettings && !exporting && !isIframe && (
        <div className="export-settings">
          <div className="export-setting-row">
            <label>Export Method</label>
            <div className="export-method-toggle">
              <button
                className={`method-btn ${useCanvasExport ? 'active' : ''}`}
                onClick={() => setUseCanvasExport(true)}
              >
                Canvas (WYSIWYG)
              </button>
              <button
                className={`method-btn ${!useCanvasExport ? 'active' : ''}`}
                onClick={() => setUseCanvasExport(false)}
              >
                Fast (no effects)
              </button>
            </div>
            <span className="setting-hint">
              {useCanvasExport
                ? 'Captures all visual effects exactly as shown in preview'
                : 'Faster export but ignores zoom, position, crop, text overlays'
              }
            </span>
          </div>

          <div className="export-setting-row">
            <label>Quality</label>
            <select
              value={quality}
              onChange={(e) => setQuality(parseInt(e.target.value))}
              className="quality-select"
            >
              {QUALITY_PRESETS.map(preset => (
                <option key={preset.crf} value={preset.crf}>
                  {preset.label}
                </option>
              ))}
            </select>
            <span className="quality-hint">{selectedPreset.bitrate}</span>
          </div>
        </div>
      )}

      {/* Client-side export progress */}
      {exporting && (
        <div className="export-progress">
          <div className="export-progress-bar">
            <div className="fill" style={{ width: `${exportProgress * 100}%` }} />
          </div>
          <div className="export-progress-text">
            {exportPhase || `Processing... ${Math.round(exportProgress * 100)}%`}
          </div>
        </div>
      )}

      {/* Backend render progress */}
      {isBackendRendering && (
        <div className="export-progress">
          <div className="export-progress-bar">
            <div className="fill" style={{ width: `${(renderStatus.progress || 0) * 100}%` }} />
          </div>
          <div className="export-progress-text">
            {renderStatus.phase || `Rendering... ${Math.round((renderStatus.progress || 0) * 100)}%`}
          </div>
        </div>
      )}

      {/* Backend render complete */}
      {renderStatus && renderStatus.status === 'completed' && renderStatus.outputUrl && (
        <div className="export-complete" style={{ marginTop: '0.5rem' }}>
          <a
            href={renderStatus.outputUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="export-btn"
            style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', fontSize: '0.85rem' }}
          >
            <ExternalLink size={16} style={{ marginRight: '0.4rem' }} />
            Download Rendered Video
          </a>
          <button
            onClick={onClearRenderStatus}
            style={{ marginLeft: '0.5rem', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Backend render failed */}
      {renderStatus && renderStatus.status === 'failed' && (
        <div style={{ marginTop: '0.5rem' }}>
          <div className="export-error" style={{ color: '#f87171', fontSize: '0.9rem' }}>
            Render failed: {renderStatus.error}
          </div>
          <button
            onClick={onClearRenderStatus}
            style={{ marginTop: '0.25rem', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="export-error" style={{ color: '#f87171', marginTop: '0.5rem', fontSize: '0.9rem' }}>
          {error}
        </div>
      )}

      {!ffmpegLoaded && !isIframe && (
        <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#94a3b8' }}>
          {ffmpegLoading ? 'Loading FFmpeg...' : 'FFmpeg not loaded'}
        </div>
      )}

      {(isIframe ? true : ffmpegLoaded) && clips.length === 0 && (
        <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#94a3b8' }}>
          Add clips to the timeline to export
        </div>
      )}
    </div>
  )
}

export default ExportButton
