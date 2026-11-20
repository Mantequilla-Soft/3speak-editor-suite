import { useState } from 'react'
import { X, Crown, ExternalLink, Crop, RefreshCw, Loader2 } from './icons'
import { AspectDiagram, ProBadge } from './ProjectFormat'
import { aspectLabel } from '../utils/projectFormat'
import { useT } from '../i18n'

/**
 * A free user in a landscape, classic or square project (opened with ?aspect=, a draft, or the
 * shape picker): what Pro is, where to get it (a new tab, so the project stays), or back to a
 * Short. Closing it makes a Short too: the landscape editor is not there to stay in.
 */
export default function LandscapeProNotice({ aspect, access, checking, onRecheck, onMakeShort }) {
  const { t } = useT()
  const [asked, setAsked] = useState(false)
  const recheck = async () => {
    setAsked(true)
    await onRecheck()
  }
  return (
    <div className="remix-picker-overlay">
      <div className="remix-picker landscape-pro" role="dialog" aria-modal="true" aria-labelledby="landscape-pro-title" aria-describedby="landscape-pro-text">
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="landscape-pro-title">{t('pro.landscape.title')}</h3>
          <button className="remix-picker-icon-btn" onClick={onMakeShort} title={t('pro.landscape.makeShort')} aria-label={t('pro.landscape.makeShort')}>
            <X size={16} />
          </button>
        </div>
        <div className="landscape-pro-shape">
          <AspectDiagram aspect={aspect} />
          <strong>{aspectLabel(aspect)}</strong>
          <ProBadge />
        </div>
        <p id="landscape-pro-text" className="landscape-pro-text">{t('pro.landscape.text')}</p>
        {asked && !checking && <p className="landscape-pro-note" role="status">{t('pro.landscape.stillFree')}</p>}
        <div className="landscape-pro-actions">
          <a className="landscape-pro-get" href={access?.upgradeUrl} target="_blank" rel="noopener noreferrer">
            <Crown size={16} />{t('pro.landscape.get')}<ExternalLink size={12} />
          </a>
          <button className="silence-cut-cancel" onClick={onMakeShort}>
            <Crop size={14} />{t('pro.landscape.makeShort')}
          </button>
          <button className="silence-cut-cancel" onClick={recheck} disabled={checking}>
            {checking ? <Loader2 size={14} className="encoding-notice-spin" /> : <RefreshCw size={14} />}
            {checking ? t('pro.landscape.checking') : t('pro.landscape.checkAgain')}
          </button>
        </div>
      </div>
    </div>
  )
}
