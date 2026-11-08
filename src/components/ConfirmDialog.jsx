import { useEffect, useRef } from 'react'
import { AlertCircle } from 'lucide-react'

/**
 * The editor's own "are you sure?" box. window.confirm() is not used: once a
 * viewer ticks the browser's "don't let this page create more dialogs" (or the
 * browser blocks dialogs in the embedded editor), confirm() answers "no" at
 * once, with no dialog and no console error, and nothing could be removed.
 * Enter confirms, Escape (or a click beside the box) cancels.
 */
export default function ConfirmDialog({ message, confirmLabel = 'Remove', onConfirm, onCancel }) {
  const yesRef = useRef(null)
  useEffect(() => {
    yesRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      else if (e.key === 'Enter') { e.preventDefault(); onConfirm() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onConfirm, onCancel])
  return (
    <div className="remix-picker-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="remix-picker confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-text">
        <p id="confirm-dialog-text" className="confirm-dialog-text"><AlertCircle size={16} /> {message}</p>
        <div className="silence-cut-actions">
          <button type="button" className="silence-cut-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="silence-cut-apply" ref={yesRef} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
