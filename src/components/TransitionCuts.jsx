import { useState } from 'react'
import { trackCuts, normalizeTransition, TRANSITION_TYPES } from '../utils/transitions'
import { TransitionDialog } from './TransitionControls'
import { ArrowRightLeft } from './icons'

/**
 * A small button on every cut between two clips of a video track: it opens
 * the transition picker for that cut. A cut with a transition shows its
 * button filled, so transitions are visible on the timeline.
 */
export default function TransitionCuts({ track, pixelsPerSecond, onUpdateClip }) {
  const [open, setOpen] = useState(null) // { from, to }
  const cuts = trackCuts(track)
  if (!cuts.length && !open) return null
  const shown = open && cuts.find(c => c.from.id === open.from && c.to.id === open.to)
  return (
    <>
      {cuts.map(({ from, to, cut }) => {
        const t = normalizeTransition(from.transition)
        const on = !!t && t.to === to.id
        const label = on ? `${TRANSITION_TYPES.find(x => x.id === t.type)?.label}, ${t.duration.toFixed(1)}s` : 'Add a transition'
        return (
          <button
            key={`${from.id}-${to.id}`}
            type="button"
            className={`transition-cut${on ? ' on' : ''}`}
            style={{ left: `${cut * pixelsPerSecond}px` }}
            title={label}
            aria-label={label}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setOpen({ from: from.id, to: to.id }) }}
          >
            <ArrowRightLeft size={12} />
          </button>
        )
      })}
      {shown && (
        <TransitionDialog from={shown.from} to={shown.to} onUpdateClip={onUpdateClip} onClose={() => setOpen(null)} />
      )}
    </>
  )
}
