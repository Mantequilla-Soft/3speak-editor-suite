import { useState } from 'react'
import { X, Clock, Check, Loader2, AlertCircle, LogIn, FolderOpen, Crown, ExternalLink } from 'lucide-react'
import { formatUntil, formatKeep, formatAgo } from '../hooks/useDrafts'

const projectMeta = (p) => {
  const secs = Math.round(p.length || 0)
  const len = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  return `${p.clips} clip${p.clips === 1 ? '' : 's'} · ${len} · edited ${formatAgo(p.updatedAt)}`
}

/** On start: continue a saved draft, or start a new project. */
export function DraftsPrompt({ drafts, limits, onLoad, onStartNew }) {
  const [busy, setBusy] = useState(null)
  const single = limits?.maxProjects === 1
  return (
    <div className="remix-picker-overlay">
      <div className="remix-picker drafts-dialog" role="dialog" aria-modal="true" aria-labelledby="drafts-prompt-title">
        <div className="remix-picker-header">
          <FolderOpen size={16} />
          <h3 id="drafts-prompt-title">{drafts.length === 1 ? 'Continue your draft?' : 'Continue a draft?'}</h3>
          <span className="remix-picker-icon-spacer" />
        </div>
        <div className="drafts-list">
          {drafts.map(p => (
            <button key={p.id} className="drafts-item" disabled={!!busy} onClick={async () => { setBusy(p.id); if (!(await onLoad(p.id))) setBusy(null) }}>
              <span className="drafts-item-text">
                <strong>{p.name}</strong>
                <small>{projectMeta(p)}</small>
                <small className="drafts-expiry"><Clock size={11} /> Kept until {formatUntil(p.expiresAt)}</small>
              </span>
              <span className="drafts-item-action">{busy === p.id ? <Loader2 size={14} className="encoding-notice-spin" /> : 'Open'}</span>
            </button>
          ))}
        </div>
        <button className="silence-cut-cancel drafts-new" onClick={onStartNew} disabled={!!busy}>Start a new project</button>
        {single && (
          <p className="drafts-note">
            You can keep one draft. Starting a new project replaces this one as soon as you edit. 3Speak Pro keeps 3 drafts for 30 days.
          </p>
        )}
      </div>
    </div>
  )
}

/** Over the limit: pick a saved project to replace, or do not save this one. */
export function DraftLimitPicker({ projects, limits, onReplace, onSkip }) {
  const [busy, setBusy] = useState(null)
  const max = limits?.maxProjects || projects.length
  return (
    <div className="remix-picker-overlay">
      <div className="remix-picker drafts-dialog" role="dialog" aria-modal="true" aria-labelledby="drafts-limit-title">
        <div className="remix-picker-header">
          <AlertCircle size={16} />
          <h3 id="drafts-limit-title">{max === 1 ? 'Replace your saved draft?' : `You already have ${max} saved projects`}</h3>
          <button className="remix-picker-icon-btn" onClick={onSkip} title="Do not save this project"><X size={16} /></button>
        </div>
        <p className="drafts-note">
          {max === 1
            ? 'You can keep one draft. Saving this project replaces the one below.'
            : `You can keep up to ${max}. Pick one this project replaces:`}
        </p>
        <div className="drafts-list">
          {projects.map(p => (
            <button key={p.id} className="drafts-item" disabled={!!busy} onClick={async () => { setBusy(p.id); await onReplace(p.id); setBusy(null) }}>
              <span className="drafts-item-text">
                <strong>{p.name}</strong>
                <small>{projectMeta(p)}</small>
              </span>
              <span className="drafts-item-action replace">{busy === p.id ? <Loader2 size={14} className="encoding-notice-spin" /> : 'Replace'}</span>
            </button>
          ))}
        </div>
        <button className="silence-cut-cancel drafts-new" onClick={onSkip} disabled={!!busy}>Don&apos;t save this project</button>
      </div>
    </div>
  )
}

/**
 * Closing the studio: save the project (and see for how long it is kept), or
 * not. Without a drafts session: sign in to save, or close and lose the edits.
 */
export function CloseDialog({ drafts, signedOut, canSignIn, signInState, onSignIn, onClose, onCancel, uploading = [] }) {
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
    else if (!r.limit) setError('Could not save. Check your connection and try again.')
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
            <h3 id="close-dialog-title">{canSignIn ? 'Save your project?' : 'Close the editor?'}</h3>
            <button className="remix-picker-icon-btn" onClick={onCancel} title="Keep editing"><X size={16} /></button>
          </div>
          {signInState === 'sign-in-failed' && (
            <p className="drafts-note warn">That did not work. Approve the sign-in request in your wallet and try again, or log out of 3Speak and in again.</p>
          )}
          <p className="drafts-note">
            {canSignIn
              ? 'Sign in once to keep this project as a draft, so you can continue later.'
              : signedOut
                ? 'Your edits will be lost. Log in to 3Speak to keep drafts of your projects.'
                : 'Your edits will be lost.'}
          </p>
          <div className="drafts-actions">
            {canSignIn && (
              <button className="silence-cut-apply" onClick={onSignIn} disabled={signInState === 'signing-in'}>
                {signInState === 'signing-in' ? <Loader2 size={14} className="encoding-notice-spin" /> : <LogIn size={14} />}
                {signInState === 'signing-in' ? 'Signing in…' : 'Sign in to save'}
              </button>
            )}
            <button className="silence-cut-cancel" onClick={onClose}>Close without saving</button>
            <button className="silence-cut-cancel" onClick={onCancel}>Keep editing</button>
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
          <h3 id="close-dialog-title">Keep this project?</h3>
          <button className="remix-picker-icon-btn" onClick={onCancel} title="Keep editing"><X size={16} /></button>
        </div>

        <div className="drafts-keep">
          <Clock size={22} />
          <div>
            <strong>We keep it for {formatKeep(ttl)}</strong>
            <span>until {formatUntil(until)}</span>
          </div>
        </div>
        {!drafts.limits?.pro && <ProUpsell user={drafts.user} />}
        {uploading.length > 0 && (() => {
          // Files, not clips: one upload can be many clips (Auto cut parts, linked audio)
          const total = uploading.reduce((s, f) => s + (f.size || 1), 0)
          const done = uploading.reduce((s, f) => s + (f.size || 1) * (f.progress || 0), 0)
          const name = uploading.length === 1 ? uploading[0].name : `${uploading.length} files`
          return (
            <div className="drafts-uploading">
              <p className="drafts-note">
                <Loader2 size={12} className="encoding-notice-spin" /> {name} is still uploading ({Math.round((done / total) * 100)}%). You can save once it is done.
              </p>
              <div className="export-upload-bar"><div style={{ width: `${Math.round((done / total) * 100)}%` }} /></div>
            </div>
          )
        })()}

        <label className="drafts-name">
          <span>Project name</span>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="Untitled project" />
        </label>
        {error && <p className="drafts-note warn">{error}</p>}

        <div className="drafts-actions">
          <button className="silence-cut-apply" onClick={saveAndClose} disabled={!!busy || uploading.length > 0} title={uploading.length > 0 ? 'Available once the upload is done' : undefined}>
            {busy === 'save' ? <Loader2 size={14} className="encoding-notice-spin" /> : <Check size={14} />} Save and close
          </button>
          <button className="silence-cut-cancel" onClick={discardAndClose} disabled={!!busy}>Delete it and close</button>
          <button className="silence-cut-cancel" onClick={onCancel} disabled={!!busy}>Keep editing</button>
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
  return (
    <div className="drafts-pro">
      <Crown size={18} />
      <div>
        <strong>More with 3Speak Pro</strong>
        <span>Keep up to 3 projects for 30 days each, instead of 1 for 7 days.</span>
      </div>
      <a href={`${siteOrigin()}/wallet/${user || ''}`} target="_blank" rel="noopener noreferrer">
        Get Pro <ExternalLink size={12} />
      </a>
    </div>
  )
}

/** Small autosave status in the header. */
export function DraftStatus({ drafts, canSignIn, signInState, onSignIn, onOpenLimit }) {
  if (!drafts.enabled) {
    if (!canSignIn) return null
    if (signInState === 'signing-in') {
      return <span className="draft-status"><Loader2 size={12} className="encoding-notice-spin" /> Signing in… check your wallet</span>
    }
    return (
      <button className={`draft-status action${signInState === 'sign-in-failed' ? ' warn' : ''}`} onClick={onSignIn} title="Sign in once to save your project as a draft">
        <LogIn size={12} /> {signInState === 'sign-in-failed' ? 'Sign-in failed · try again' : 'Save drafts'}
      </button>
    )
  }
  if (drafts.status === 'limit') {
    return (
      <button className="draft-status warn" onClick={onOpenLimit} title="This project is not saved yet">
        <AlertCircle size={12} /> Not saved: choose a slot
      </button>
    )
  }
  if (drafts.status === 'saving') return <span className="draft-status"><Loader2 size={12} className="encoding-notice-spin" /> Saving…</span>
  if (drafts.status === 'error') return <span className="draft-status warn"><AlertCircle size={12} /> Draft not saved</span>
  if (drafts.saved) {
    return (
      <span className="draft-status" title={`Draft kept until ${formatUntil(drafts.saved.expiresAt)}`}>
        <Check size={12} /> Draft saved · until {formatUntil(drafts.saved.expiresAt)}
      </span>
    )
  }
  return null
}
