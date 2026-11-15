// Clip fields the backend render needs from the editor's newer tools, added to
// each clip of the render payload (hooks/useIframeApi.js). Old clips without
// them add nothing, so their payload stays as it was.
import { normalizeLook } from './clipLook'
import { normalizeTransition, videoFades } from './transitions'
import { normalizeTextStroke, normalizeTextAnim } from './textAnim'
import { sceneDoc } from './titleScenes'

// ctx.frame: the output size ({ width, height }), for titles
export function renderExtras(clip, ctx = {}) {
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
  // Text: outline and word by word entrance (utils/textAnim.js)
  if (clip.type === 'text') {
    const stroke = normalizeTextStroke(clip.textStroke)
    if (stroke) out.textStroke = stroke
    const anim = normalizeTextAnim(clip.textAnim)
    if (anim) out.textAnim = anim
  }
  // Titles (utils/titleScenes.js): the scene engine doc, recorded by the backend
  if (clip.type === 'scene') {
    out.sceneDoc = sceneDoc(clip, ctx.frame || { width: 1080, height: 1920 })
    out.transparent = clip.transparent !== false
  }
  return out
}
