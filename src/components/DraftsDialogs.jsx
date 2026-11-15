import { useState } from 'react'
import { X, Clock, Check, Loader2, AlertCircle, LogIn, FolderOpen, Crown, ExternalLink } from './icons'
import { formatUntil } from '../hooks/useDrafts'
import { formatLength } from '../utils/limits'
import { useT, t, formatNumber } from '../i18n'

// "edited 2 h ago" (in the interface language)
function editedAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return t('drafts.meta.edited.justNow')
  if (s < 3600) return t('drafts.meta.edited.minutes', { count: Math.round(s / 60) })
  if (s < 86400) return t('drafts.meta.edited.hours', { count: Math.round(s / 3600) })
  return t('drafts.meta.edited.days', { count: Math.round(s / 86400) })
}

// "Audio · 12 clips · 1:02:05 · edited 2 h ago" (the replace list shows both editors' drafts)
export const projectMeta = (p) => t(p.mode === 'audio' ? 'drafts.meta.audioLine' : 'drafts.meta.line', {
  clips: t('drafts.meta.clips', { count: p.clips }),
  length: formatLength(p.length || 0),
  edited: editedAgo(p.updatedAt)
})

// "We keep it for 7 days" (whole days from 2 days up, else hours)
const keepText = (ttlHours) => (ttlHours >= 48 && ttlHours % 24 === 0
  ? t('drafts.close.keepDays', { count: ttlHours / 24 })
  : t('drafts.close.keepHours', { count: ttlHours }))

/** On start: continue a saved draft, or start a new project. */
export function DraftsPrompt({ drafts, limits, onLoad, onStartNew }) {
  const { t } = useT()
  const [busy, setBusy] = useState(null)
  const single = limits?.maxProjects === 1
  return (
    <div className="remix-picker-overlay">
      <div className="remix-picker drafts-dialog" role="dialog" aria-modal="true" aria-labelledby="drafts-prompt-title">
        <div className="remix-picker-header">
          <FolderOpen size={16} />
          <h3 id="drafts-prompt-title">{drafts.length === 1 ? t('drafts.prompt.titleOne') : t('drafts.prompt.titleMany')}</h3>
          <span className="remix-picker-icon-spacer" />
        </div>
        <div className="drafts-list">
          {drafts.map(p => (
            <button key={p.id} className="drafts-item" disabled={!!busy} onClick={async () => { setBusy(p.id); if (!(await onLoad(p.id))) setBusy(null) }}>
              <span className="drafts-item-text">
                <strong>{p.name}</strong>
                <small>{projectMeta(p)}</small>
                <small className="drafts-expiry"><Clock size={11} /> {t('drafts.prompt.keptUntil', { date: formatUntil(p.expiresAt) })}</small>
              </span>
              <span className="drafts-item-action">{busy === p.id ? <Loader2 size={14} className="encoding-notice-spin" /> : t('drafts.prompt.open')}</span>
            </button>
          ))}
        </div>
        <button className="silence-cut-cancel drafts-new" onClick={onStartNew} disabled={!!busy}>{t('drafts.prompt.startNew')}</button>
        {single && (
          <p className="drafts-note">
            {t('drafts.prompt.singleNote')}
          </p>
        )}
      </div>
    </div>
  )
}

/** Over the limit: pick a saved project to replace, or do not save this one. */
export function DraftLimitPicker({ projects, limits, onReplace, onSkip }) {
  const { t } = useT()
  const [busy, setBusy] = useState(null)
  const max = limits?.maxProjects || projects.length
  return (
    <div className="remix-picker-overlay">
      <div className="remix-picker drafts-dialog" role="dialog" aria-modal="true" aria-labelledby="drafts-limit-title">
        <div className="remix-picker-header">
          <AlertCircle size={16} />
          <h3 id="drafts-limit-title">{max === 1 ? t('drafts.limit.titleOne') : t('drafts.limit.titleMany', { n: max })}</h3>
          <button className="remix-picker-icon-btn" onClick={onSkip} title={t('drafts.limit.skipTitle')}><X size={16} /></button>
        </div>
        <p className="drafts-note">
          {max === 1
            ? t('drafts.limit.noteOne')
            : t('drafts.limit.noteMany', { n: max })}
        </p>
        <div className="drafts-list">
          {projects.map(p => (
            <button key={p.id} className="drafts-item" disabled={!!busy} onClick={async () => { setBusy(p.id); await onReplace(p.id); setBusy(null) }}>
              <span className="drafts-item-text">
                <strong>{p.name}</strong>
                <small>{projectMeta(p)}</small>
              </span>
              <span className="drafts-item-action replace">{busy === p.id ? <Loader2 size={14} className="encoding-notice-spin" /> : t('drafts.limit.replace')}</span>
            </button>
          ))}
        </div>
        <button className="silence-cut-cancel drafts-new" onClick={onSkip} disabled={!!busy}>{t('drafts.limit.skip')}</button>
      </div>
    </div>
  )
}

/**
 * Closing the studio: save the project (and see for how long it is kept), or
 * not. Without a drafts session: sign in to save, or close and lose the edits.
 */
export function CloseDialog({ drafts, signedOut, canSignIn, signInState, onSignIn, onClose, onCancel, uploading = [] }) {
  const { t } = useT()
  const [name, setName] = useState(drafts.name || '')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const ttl = drafts.limits?.ttlHours || 7 * 24
  const until = Date.now() + ttl * 3600 * 1000

  const saveAndClose = async () => {
    setBusy('save')
    setError(null)
    const r = await drafts.save({ saveName: name })
    setBusy(null)
    if (r.ok) onClose()
    else if (!r.limit) setError(t('drafts.close.saveError'))
    // limit: the picker opens; closing goes on from there
  }
  const discardAndClose = async () => {
    setBusy('discard')
    await drafts.deleteCurrent()
    onClose()
  }

  if (!drafts.enabled) {
    return (
      <div className="remix-picker-overlay" onClick={onCancel}>
        <div className="remix-picker drafts-dialog" role="dialog" aria-modal="true" aria-labelledby="close-dialog-title" onClick={e => e.stopPropagation()}>
          <div className="remix-picker-header">
            <span className="remix-picker-icon-spacer" />
            <h3 id="close-dialog-title">{canSignIn ? t('drafts.close.saveTitle') : t('drafts.close.closeTitle')}</h3>
            <button className="remix-picker-icon-btn" onClick={onCancel} title={t('drafts.close.keepEditing')}><X size={16} /></button>
          </div>
          {signInState === 'sign-in-failed' && (
            <p className="drafts-note warn">{t('drafts.close.signInFailed')}</p>
          )}
          <p className="drafts-note">
            {canSignIn
              ? t('drafts.close.signInToKeep')
              : signedOut
                ? t('drafts.close.signedOutLost')
                : t('drafts.close.lost')}
          </p>
          <div className="drafts-actions">
            {canSignIn && (
              <button className="silence-cut-apply" onClick={onSignIn} disabled={signInState === 'signing-in'}>
                {signInState === 'signing-in' ? <Loader2 size={14} className="encoding-notice-spin" /> : <LogIn size={14} />}
                {signInState === 'signing-in' ? t('drafts.close.signingIn') : t('drafts.close.signInToSave')}
              </button>
            )}
            <button className="silence-cut-cancel" onClick={onClose}>{t('drafts.close.withoutSaving')}</button>
            <button className="silence-cut-cancel" onClick={onCancel}>{t('drafts.close.keepEditing')}</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="remix-picker-overlay" onClick={onCancel}>
      <div className="remix-picker drafts-dialog" role="dialog" aria-modal="true" aria-labelledby="close-dialog-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="close-dialog-title">{t('drafts.close.keepTitle')}</h3>
          <button className="remix-picker-icon-btn" onClick={onCancel} title={t('drafts.close.keepEditing')}><X size={16} /></button>
        </div>

        <div className="drafts-keep">
          <Clock size={22} />
          <div>
            <strong>{keepText(ttl)}</strong>
            <span>{t('drafts.close.until', { date: formatUntil(until) })}</span>
          </div>
        </div>
        {!drafts.limits?.pro && <ProUpsell user={drafts.user} />}
        {uploading.length > 0 && (() => {
          // Files, not clips: one upload can be many clips (Auto cut parts, linked audio)
          const total = uploading.reduce((s, f) => s + (f.size || 1), 0)
          const done = uploading.reduce((s, f) => s + (f.size || 1) * (f.progress || 0), 0)
          const percent = formatNumber(done / total, { style: 'percent', maximumFractionDigits: 0 })
          return (
            <div className="drafts-uploading">
              <p className="drafts-note">
                <Loader2 size={12} className="encoding-notice-spin" /> {uploading.length === 1
                  ? t('drafts.close.uploadingOne', { name: uploading[0].name, percent })
                  : t('drafts.close.uploadingFiles', { count: uploading.length, percent })}
              </p>
              <div className="export-upload-bar"><div style={{ width: `${Math.round((done / total) * 100)}%` }} /></div>
            </div>
          )
        })()}

        <label className="drafts-name">
          <span>{t('drafts.close.name')}</span>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder={t('drafts.close.namePlaceholder')} />
        </label>
        {error && <p className="drafts-note warn">{error}</p>}

        <div className="drafts-actions">
          <button className="silence-cut-apply" onClick={saveAndClose} disabled={!!busy || uploading.length > 0} title={uploading.length > 0 ? t('drafts.close.afterUpload') : undefined}>
            {busy === 'save' ? <Loader2 size={14} className="encoding-notice-spin" /> : <Check size={14} />} {t('drafts.close.saveAndClose')}
          </button>
          <button className="silence-cut-cancel" onClick={discardAndClose} disabled={!!busy}>{t('drafts.close.deleteAndClose')}</button>
          <button className="silence-cut-cancel" onClick={onCancel} disabled={!!busy}>{t('drafts.close.keepEditing')}</button>
        </div>
      </div>
    </div>
  )
}

// The 3Speak page that hosts the editor (where Pro is sold): the parent's origin
const siteOrigin = () => {
  try { return document.referrer ? new URL(document.referrer).origin : 'https://3speak.tv' } catch { return 'https://3speak.tv' }
}

/** Free users: what 3Speak Pro adds to drafts, and where to get it. */
function ProUpsell({ user }) {
  const { t } = useT()
  return (
    <div className="drafts-pro">
      <Crown size={18} />
      <div>
        <strong>{t('drafts.pro.title')}</strong>
        <span>{t('drafts.pro.text')}</span>
      </div>
      <a href={`${siteOrigin()}/wallet/${user || ''}`} target="_blank" rel="noopener noreferrer">
        {t('drafts.pro.get')} <ExternalLink size={12} />
      </a>
    </div>
  )
}

/** Small autosave status in the header. */
export function DraftStatus({ drafts, canSignIn, signInState, onSignIn, onOpenLimit }) {
  const { t } = useT()
  if (!drafts.enabled) {
    if (!canSignIn) return null
    if (signInState === 'signing-in') {
      return <span className="draft-status"><Loader2 size={12} className="encoding-notice-spin" /> {t('drafts.status.signingIn')}</span>
    }
    return (
      <button className={`draft-status action${signInState === 'sign-in-failed' ? ' warn' : ''}`} onClick={onSignIn} title={t('drafts.status.signInTitle')}>
        <LogIn size={12} /> {signInState === 'sign-in-failed' ? t('drafts.status.signInFailed') : t('drafts.status.saveDrafts')}
      </button>
    )
  }
  if (drafts.status === 'limit') {
    return (
      <button className="draft-status warn" onClick={onOpenLimit} title={t('drafts.status.notSavedTitle')}>
        <AlertCircle size={12} /> {t('drafts.status.chooseSlot')}
      </button>
    )
  }
  if (drafts.status === 'saving') return <span className="draft-status"><Loader2 size={12} className="encoding-notice-spin" /> {t('drafts.status.saving')}</span>
  if (drafts.status === 'error') return <span className="draft-status warn"><AlertCircle size={12} /> {t('drafts.status.notSaved')}</span>
  if (drafts.saved) {
    return (
      <span className="draft-status" title={t('drafts.status.keptUntil', { date: formatUntil(drafts.saved.expiresAt) })}>
        <Check size={12} /> {t('drafts.status.savedUntil', { date: formatUntil(drafts.saved.expiresAt) })}
      </span>
    )
  }
  return null
}
