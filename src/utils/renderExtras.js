// Clip fields the backend render needs from the editor's newer tools, added to
// each clip of the render payload (hooks/useIframeApi.js). Old clips without
// them add nothing, so their payload stays as it was.
import { normalizeLook } from './clipLook'
import { normalizeTransition, videoFades } from './transitions'

export function renderExtras(clip) {
  const out = {}
  const visual = clip.type === 'video' || clip.type === 'image'
  // Looks (utils/clipLook.js): split tone and effects; the preset's colour is in clip.color
  const look = visual ? normalizeLook(clip.look) : null
  if (look) out.look = look
  // Transitions into the next clip and picture fades (utils/transitions.js)
  const transition = visual || clip.type === 'color' ? normalizeTransition(clip.transition) : null
  if (transition) out.transition = transition
  if (visual || clip.type === 'color') {
    const { fadeIn, fadeOut } = videoFades(clip)
    if (fadeIn > 0) out.fadeIn = fadeIn
    if (fadeOut > 0) out.fadeOut = fadeOut
  }
  return out
}
