import { useRef, useState } from 'react'
import { X, Upload, Scissors, Trash2, Loader2, LogIn, Wand2, Check } from 'lucide-react'
import { slotFromClip, slotLength, BED_DEFAULT_VOLUME, TEMPLATE_ROLES } from '../utils/audioTemplate'
import { formatLength } from '../utils/limits'

const LABELS = {
  intro: { title: 'Intro', hint: 'Plays first, before your recording.' },
  outro: { title: 'Outro', hint: 'Plays right after your recording ends.' },
  bed: { title: 'Music bed', hint: 'Quiet music under the whole recording, looped to fit, faded out at the end.' }
}

// Length of a picked file, read by the browser (null if it cannot tell)
function probeDuration(file) {
  return new Promise(resolve => {
    const el = document.createElement('audio')
    const src = URL.createObjectURL(file)
    const done = (d) => { URL.revokeObjectURL(src); resolve(Number.isFinite(d) && d > 0 ? d : null) }
    el.preload = 'metadata'
    el.onloadedmetadata = () => done(el.duration)
    el.onerror = () => done(null)
    setTimeout(() => done(null), 8000)
    el.src = src
  })
}

/**
 * The creator's one audio template: intro, outro and music bed, plus what to
 * do with every new recording (cut the silences, level the loudness). Kept on
 * the editor backend for good; applying it puts the parts around the content.
 */
export default function AudioTemplateDialog({
  template, selectedClip, uploadFile, onSave, onApply, onRemove, onClose,
  signedIn, canSignIn, onSignIn, silenceSettings, master, saving
}) {
  const [slots, setSlots] = useState(() => ({ ...(template?.slots || {}) }))
  const [loudness, setLoudness] = useState(template ? template.master?.loudness !== false : master?.loudness !== false)
  const [duck, setDuck] = useState(template ? template.master?.duck === true : master?.duck === true)
  // How far: what was saved with the template, else -12 dB
  const duckDb = template?.master?.duckDb ?? -12
  const [cutSilences, setCutSilences] = useState(!!template?.silence?.enabled)
  const [autoApply, setAutoApply] = useState(template ? template.autoApply !== false : true)
  const [busy, setBusy] = useState(null) // role being uploaded
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const inputs = useRef({})

  const selectedSlot = (role) => (selectedClip ? slotFromClip(selectedClip, role) : null)
  const setSlot = (role, slot) => setSlots(s => {
    const next = { ...s }
    if (slot) next[role] = slot
    else delete next[role]
    return next
  })

  const pickFile = async (role, file) => {
    if (!file) return
    setError(null)
    setBusy(role)
    setProgress(0)
    try {
      const [info, duration] = await Promise.all([uploadFile(file, file.name, setProgress), probeDuration(file)])
      const length = duration || info.duration
      if (!length) throw new Error('length')
      setSlot(role, {
        url: info.url,
        name: file.name.replace(/\.[a-z0-9]{2,4}$/i, ''),
        duration: length,
        startTime: 0,
        endTime: length,
        volume: role === 'bed' ? BED_DEFAULT_VOLUME : 100,
        fadeIn: 0,
        fadeOut: role === 'bed' ? 2 : 0,
        ...(role === 'bed' ? { loop: true } : {})
      })
    } catch (err) {
      setError(err?.code === 'sign-in' ? 'Sign in on 3Speak to upload.' : 'That file could not be uploaded. Try another one.')
    } finally {
      setBusy(null)
    }
  }

  const build = () => ({
    slots,
    master: { loudness, duck, duckDb },
    silence: silenceSettings ? { enabled: cutSilences, ...silenceSettings } : { enabled: cutSilences },
    autoApply
  })

  if (!signedIn) {
    return (
      <div className="remix-picker-overlay" onClick={onClose}>
        <div className="remix-picker audio-template" role="dialog" aria-modal="true" aria-labelledby="audio-template-title" onClick={e => e.stopPropagation()}>
          <div className="remix-picker-header">
            <span className="remix-picker-icon-spacer" />
            <h3 id="audio-template-title">Your template</h3>
            <button className="remix-picker-icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
          </div>
          <p className="audio-template-intro">
            Save your intro, outro and music bed once, and every new recording gets them in one click.
            Your template is kept for good, so it needs your 3Speak sign-in.
          </p>
          {canSignIn ? (
            <button className="silence-cut-apply audio-template-signin" onClick={onSignIn}><LogIn size={14} /> Sign in to use a template</button>
          ) : (
            <p className="audio-template-hint">Log in on 3Speak to use a template.</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="remix-picker-overlay" onClick={onClose}>
      <div className="remix-picker audio-template" role="dialog" aria-modal="true" aria-labelledby="audio-template-title" onClick={e => e.stopPropagation()}>
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="audio-template-title">Your template</h3>
          <button className="remix-picker-icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
        </div>
        <p className="audio-template-intro">One template, kept for good. Saving replaces the one you had.</p>

        <div className="audio-template-slots">
          {TEMPLATE_ROLES.map(role => {
            const slot = slots[role]
            const fromSelection = selectedSlot(role)
            return (
              <div key={role} className="audio-template-slot" data-role={role}>
                <div className="audio-template-slot-head">
                  <strong>{LABELS[role].title}</strong>
                  <small>{LABELS[role].hint}</small>
                </div>
                <div className="audio-template-slot-body">
                  {slot ? (
                    <span className="audio-template-file" title={slot.name}>
                      {slot.name} <em>{formatLength(slotLength(slot))}</em>
                    </span>
                  ) : (
                    <span className="audio-template-file empty">None</span>
                  )}
                  <div className="audio-template-slot-actions">
                    <button
                      onClick={() => setSlot(role, fromSelection)}
                      disabled={!fromSelection || !!busy}
                      title={fromSelection ? `Use "${fromSelection.name}" (the part you trimmed it to)` : 'Select an uploaded audio clip on the timeline first'}
                    >
                      <Scissors size={13} /> Selected clip
                    </button>
                    <button onClick={() => inputs.current[role]?.click()} disabled={!!busy}>
                      {busy === role ? <><Loader2 size={13} className="encoding-notice-spin" /> {Math.round(progress * 100)}%</> : <><Upload size={13} /> File</>}
                    </button>
                    {slot && (
                      <button className="audio-template-clear" onClick={() => setSlot(role, null)} disabled={!!busy} title={`No ${LABELS[role].title.toLowerCase()}`}>
                        <X size={13} />
                      </button>
                    )}
                    <input
                      ref={el => { inputs.current[role] = el }}
                      type="file"
                      accept="audio/*,video/*"
                      hidden
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; pickFile(role, f) }}
                    />
                  </div>
                </div>
                {role === 'bed' && slot && (
                  <div className="audio-template-bed">
                    <label className="property-slider">
                      <span>Volume</span>
                      <input
                        type="range" min="0" max="100" value={slot.volume ?? BED_DEFAULT_VOLUME}
                        onChange={(e) => setSlot('bed', { ...slot, volume: parseInt(e.target.value, 10) })}
                        aria-label="Music bed volume"
                      />
                      <span>{slot.volume ?? BED_DEFAULT_VOLUME}%</span>
                    </label>
                    <label className="audio-template-check">
                      <input type="checkbox" checked={slot.loop !== false} onChange={(e) => setSlot('bed', { ...slot, loop: e.target.checked })} />
                      Loop to fill the whole recording
                    </label>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="audio-template-options">
          <label className="audio-template-check">
            <input type="checkbox" checked={cutSilences} onChange={(e) => setCutSilences(e.target.checked)} />
            <span>Cut the silences out of every new recording <small>(with your Cut silences settings)</small></span>
          </label>
          <label className="audio-template-check">
            <input type="checkbox" checked={loudness} onChange={(e) => setLoudness(e.target.checked)} />
            <span>Normalize the loudness for podcasts <small>(-16 LUFS, applied when exporting)</small></span>
          </label>
          <label className="audio-template-check">
            <input type="checkbox" checked={duck} onChange={(e) => setDuck(e.target.checked)} />
            <span>Duck the music while someone talks <small>({duckDb} dB on the music bed; change it in the clip&apos;s settings)</small></span>
          </label>
          <label className="audio-template-check">
            <input type="checkbox" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} />
            <span>Apply it by itself when I open a recording</span>
          </label>
        </div>

        {error && <p className="audio-template-error" role="alert">{error}</p>}

        <div className="silence-cut-actions audio-template-actions">
          {template && (
            confirmDelete ? (
              <button className="silence-cut-cancel audio-template-delete" onClick={onRemove}><Trash2 size={13} /> Delete it for good</button>
            ) : (
              <button className="silence-cut-cancel" onClick={() => setConfirmDelete(true)}><Trash2 size={13} /> Delete template</button>
            )
          )}
          <span className="audio-template-spacer" />
          <button className="silence-cut-cancel" onClick={() => onSave(build())} disabled={!!busy || saving}>
            {saving ? <Loader2 size={13} className="encoding-notice-spin" /> : <Check size={13} />} Save
          </button>
          <button className="silence-cut-apply" onClick={() => onApply(build())} disabled={!!busy || saving}>
            <Wand2 size={14} /> Save and apply
          </button>
        </div>
      </div>
    </div>
  )
}
