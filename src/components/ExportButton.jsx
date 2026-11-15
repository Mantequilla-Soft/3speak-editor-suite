import { useState } from 'react'
import { Download, Settings, X, Send, ExternalLink } from './icons'
import { maxTimelineText, formatLength } from '../utils/limits'
import { isRenderActive } from '../utils/renderQueue'
import { useT } from '../i18n'

// Quality presets mapped to CRF values (lower CRF = higher quality, larger file)
const QUALITY_PRESETS = [
  { labelKey: 'render.legacy.qualityHigh', crf: 18, bitrate: '~15-25 Mbps' },
  { labelKey: 'render.legacy.qualityMedium', crf: 23, bitrate: '~8-12 Mbps' },
  { labelKey: 'render.legacy.qualityLow', crf: 28, bitrate: '~3-5 Mbps' },
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
  const { t, formatNumber } = useT()
  const percent = (p) => formatNumber(p, { style: 'percent', maximumFractionDigits: 0 })
  const [error, setError] = useState(null)
  const [quality, setQuality] = useState(23) // Default to medium quality (CRF 23)
  const [showSettings, setShowSettings] = useState(false)
  const [useCanvasExport, setUseCanvasExport] = useState(true) // Default to canvas export

  const isBackendRendering = !!renderStatus && isRenderActive(renderStatus.status)

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
      setError(err.message || t('errors.export.failed'))
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
          {isBackendRendering ? t('render.button.rendering') : exporting ? t('render.button.exporting') : (isIframe ? t('common.render') : t('render.legacy.exportVideo'))}
        </button>
        {exporting && onCancelExport && (
          <button
            className="export-cancel-btn"
            onClick={handleCancel}
            title={t('render.legacy.cancelTitle')}
          >
            <X size={16} />
          </button>
        )}
        {!exporting && !isIframe && (
          <button
            className="export-settings-btn"
            onClick={() => setShowSettings(!showSettings)}
            title={t('render.legacy.settingsTitle')}
          >
            <Settings size={16} />
          </button>
        )}
      </div>

      {pendingUpload && (
        <div className="export-upload-status" role="status">
          <div className="export-upload-bar"><div style={{ width: `${Math.round(pendingUpload.progress * 100)}%` }} /></div>
          <p>
            {t(isIframe ? 'render.legacy.uploadingRender' : 'render.legacy.uploadingExport', { name: pendingUpload.name, percent: percent(pendingUpload.progress) })}
          </p>
        </div>
      )}

      {overLengthLimit && (
        <p className="export-length-hint">
          {t(isIframe ? 'render.legacy.lengthRender' : 'render.legacy.lengthExport', { length: formatLength(timelineEnd), limit: maxTimelineText() })}
        </p>
      )}

      {showSettings && !exporting && !isIframe && (
        <div className="export-settings">
          <div className="export-setting-row">
            <label>{t('render.legacy.method')}</label>
            <div className="export-method-toggle">
              <button
                className={`method-btn ${useCanvasExport ? 'active' : ''}`}
                onClick={() => setUseCanvasExport(true)}
              >
                {t('render.legacy.methodCanvas')}
              </button>
              <button
                className={`method-btn ${!useCanvasExport ? 'active' : ''}`}
                onClick={() => setUseCanvasExport(false)}
              >
                {t('render.legacy.methodFast')}
              </button>
            </div>
            <span className="setting-hint">
              {useCanvasExport
                ? t('render.legacy.canvasHint')
                : t('render.legacy.fastHint')
              }
            </span>
          </div>

          <div className="export-setting-row">
            <label>{t('render.legacy.quality')}</label>
            <select
              value={quality}
              onChange={(e) => setQuality(parseInt(e.target.value))}
              className="quality-select"
            >
              {QUALITY_PRESETS.map(preset => (
                <option key={preset.crf} value={preset.crf}>
                  {t(preset.labelKey)}
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
            {exportPhase || t('render.legacy.processing', { percent: percent(exportProgress) })}
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
            {renderStatus.phase || t('render.legacy.renderingPercent', { percent: percent(renderStatus.progress || 0) })}
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
            {t('render.legacy.downloadRendered')}
          </a>
          <button
            onClick={onClearRenderStatus}
            style={{ marginLeft: '0.5rem', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '12px' }}
          >
            {t('app.dismiss')}
          </button>
        </div>
      )}

      {/* Backend render failed */}
      {renderStatus && renderStatus.status === 'failed' && (
        <div style={{ marginTop: '0.5rem' }}>
          <div className="export-error" style={{ color: 'var(--accent)', fontSize: '14px' }}>
            {t('render.failed', { error: renderStatus.error })}
          </div>
          <button
            onClick={onClearRenderStatus}
            style={{ marginTop: '0.25rem', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '12px' }}
          >
            {t('app.dismiss')}
          </button>
        </div>
      )}

      {error && (
        <div className="export-error" style={{ color: 'var(--accent)', marginTop: '0.5rem', fontSize: '14px' }}>
          {error}
        </div>
      )}

      {!ffmpegLoaded && !isIframe && (
        <div style={{ marginTop: '0.5rem', fontSize: '12px', color: 'var(--muted)' }}>
          {ffmpegLoading ? t('render.legacy.ffmpegLoading') : t('render.legacy.ffmpegNotLoaded')}
        </div>
      )}

      {(isIframe ? true : ffmpegLoaded) && clips.length === 0 && (
        <div style={{ marginTop: '0.5rem', fontSize: '12px', color: 'var(--muted)' }}>
          {t('render.legacy.addClips')}
        </div>
      )}
    </div>
  )
}

export default ExportButton
