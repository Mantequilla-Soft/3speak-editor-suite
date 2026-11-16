import { memo, createElement } from 'react'
import { gradeParams, fxParams, svgGradePrimitives, svgFxPrimitives } from '../utils/clipLook'
import { hasLayout } from '../utils/remixLayout'

export const clipColorFilterId = (clipId) => `clipfx-${clipId}`

// The clip changes colour (sliders, a look's split tone) or has effects
const hasLook = (clip) => !!(gradeParams(clip.color, clip.look) || fxParams(clip.look))

// CSS / canvas filter value for a clip's colour and look, or undefined when unchanged
export const clipColorFilter = (clip) =>
  clip && (clip.type === 'video' || clip.type === 'image') && hasLook(clip)
    ? `url(#${clipColorFilterId(clip.id)})`
    : undefined

// SVG attribute names in React's spelling (kernelMatrix etc. are already camelCase)
const REACT_ATTR = { in: 'in', in2: 'in2', 'stop-color': 'stopColor' }
const toReact = ({ tag, attrs, children }, key) => createElement(
  tag,
  { key, ...Object.fromEntries(Object.entries(attrs).map(([k, v]) => [REACT_ATTR[k] || k, v])) },
  ...(children || []).map((c, i) => toReact(c, i))
)

/** One <filter> for a colour grade and look (also used by the look thumbnails). */
export function LookFilter({ id, color, look, aspect }) {
  const prims = [...svgGradePrimitives(color, look), ...svgFxPrimitives(look, aspect)]
  return (
    <filter id={id} colorInterpolationFilters="sRGB" x="0" y="0" width="1" height="1" primitiveUnits="objectBoundingBox">
      {prims.map((p, i) => toReact(p, i))}
    </filter>
  )
}

/**
 * One SVG <filter> per colour-adjusted clip, referenced by the preview
 * (CSS filter: url(#…)) and the browser export (ctx.filter = 'url(#…)').
 * Same maths as the backend render, see utils/clipColor.js and utils/clipLook.js.
 * frame: the output size; the effects are drawn relative to the element the
 * filter is on (the canvas, or a remix layout box).
 */
function ClipColorFilters({ tracks, frame = { width: 1080, height: 1920 } }) {
  const clips = (tracks || []).flatMap(t => t.clips).filter(c => clipColorFilter(c))
  const canvasAspect = frame.width / frame.height
  return (
    <svg width="0" height="0" style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden="true" focusable="false">
      <defs>
        {clips.map(clip => (
          <LookFilter
            key={clip.id}
            id={clipColorFilterId(clip.id)}
            color={clip.color}
            look={clip.look}
            aspect={hasLayout(clip) ? canvasAspect * (clip.layout.w / clip.layout.h) : canvasAspect}
          />
        ))}
      </defs>
    </svg>
  )
}

export default memo(ClipColorFilters)
