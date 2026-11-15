import { useEffect, useRef } from 'react'
import { X } from './icons'
import { shortcutsFor } from '../utils/shortcuts'

/** The `?` sheet: every keyboard shortcut of this editor (utils/shortcuts.js). */
export default function ShortcutSheet({ mode = 'video', onClose }) {
  const closeRef = useRef(null)
  const returnTo = useRef(typeof document !== 'undefined' ? document.activeElement : null)
  // onClose by ref: the listener stays the same while the editor re-renders
  // (a re-render during the key press would otherwise swap it out and miss it)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current() } }
    window.addEventListener('keydown', onKey)
    const back = returnTo.current
    return () => {
      window.removeEventListener('keydown', onKey)
      back?.focus?.({ preventScroll: true })
    }
  }, [])
  const groups = shortcutsFor(mode)
  return (
    <div className="remix-picker-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="remix-picker shortcut-sheet" role="dialog" aria-modal="true" aria-labelledby="shortcut-sheet-title">
        <div className="remix-picker-header">
          <span className="remix-picker-icon-spacer" />
          <h3 id="shortcut-sheet-title">Keyboard shortcuts</h3>
          <button ref={closeRef} className="remix-picker-icon-btn" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="shortcut-sheet-groups">
          {groups.map(g => (
            <section key={g.title} className="shortcut-sheet-group" aria-label={g.title}>
              <h4>{g.title}</h4>
              <dl>
                {g.items.map(item => (
                  <div key={item.label} className="shortcut-sheet-row">
                    <dt>
                      {item.keys.map((k, i) => (
                        <span key={k}>{i > 0 && <span className="shortcut-sheet-or"> / </span>}<kbd>{k}</kbd></span>
                      ))}
                    </dt>
                    <dd>{item.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
