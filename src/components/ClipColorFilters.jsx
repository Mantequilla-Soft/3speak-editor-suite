import { memo } from 'react'
import { colorParams, saturateMatrix } from '../utils/clipColor'

export const clipColorFilterId = (clipId) => `clipfx-${clipId}`

// CSS / canvas filter value for a clip's colour, or undefined when unchanged
export const clipColorFilter = (clip) =>
  clip && (clip.type === 'video' || clip.type === 'image') && colorParams(clip.color)
    ? `url(#${clipColorFilterId(clip.id)})`
    : undefined

/**
 * One SVG <filter> per colour-adjusted clip, referenced by the preview
 * (CSS filter: url(#…)) and the browser export (ctx.filter = 'url(#…)').
 * Same maths as the backend render, see utils/clipColor.js.
 */
function ClipColorFilters({ tracks }) {
  const clips = (tracks || []).flatMap(t => t.clips).filter(c => clipColorFilter(c))
  return (
    <svg width="0" height="0" style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden="true" focusable="false">
      <defs>
        {clips.map(clip => {
          const p = colorParams(clip.color)
          const func = (ch) => ({
            type: 'gamma',
            amplitude: p.channels[ch].A,
            exponent: p.gamma,
            offset: p.channels[ch].O
          })
          const m = saturateMatrix(p.saturation)
          return (
            <filter key={clip.id} id={clipColorFilterId(clip.id)} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
              <feComponentTransfer>
                <feFuncR {...func('r')} />
                <feFuncG {...func('g')} />
                <feFuncB {...func('b')} />
              </feComponentTransfer>
              {p.saturation !== 1 && (
                <feColorMatrix
                  type="matrix"
                  values={`${m[0]} ${m[1]} ${m[2]} 0 0  ${m[3]} ${m[4]} ${m[5]} 0 0  ${m[6]} ${m[7]} ${m[8]} 0 0  0 0 0 1 0`}
                />
              )}
            </filter>
          )
        })}
      </defs>
    </svg>
  )
}

export default memo(ClipColorFilters)
