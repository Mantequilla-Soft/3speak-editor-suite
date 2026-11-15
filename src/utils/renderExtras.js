// Clip fields the backend render needs from the editor's newer tools, added to
// each clip of the render payload (hooks/useIframeApi.js). Old clips without
// them add nothing, so their payload stays as it was.
import { normalizeLook } from './clipLook'

export function renderExtras(clip) {
  const out = {}
  const visual = clip.type === 'video' || clip.type === 'image'
  // Looks (utils/clipLook.js): split tone and effects; the preset's colour is in clip.color
  const look = visual ? normalizeLook(clip.look) : null
  if (look) out.look = look
  return out
}
