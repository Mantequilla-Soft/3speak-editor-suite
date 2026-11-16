import { useMemo, useState } from 'react'
import { captionEvents, captionAt, captionLayout, normalizeCaptions, CAPTION_FONTS } from '../utils/captions'
import { emojiUrl } from '../utils/captionSources'

// The frame the render is made at: captions are laid out in its pixels, then
// shown as fractions of the preview canvas (which has the same shape)
const FRAME = { width: 1080, height: 1920 }

/**
 * Auto captions over the preview canvas, as the render burns them in: the same
 * pages, lines, highlight and emoji (utils/captions.js decides all of it). Sits
 * inside a box exactly the size of the output canvas (a size container, so
 * 1cqh = 1% of the canvas height).
 */
function CaptionsOverlay({ captions, time, frame = FRAME }) {
  const clean = useMemo(() => normalizeCaptions(captions), [captions])
  const events = useMemo(() => (clean ? captionEvents(clean, frame) : []), [clean, frame])
  const [brokenEmoji, setBrokenEmoji] = useState(() => new Set())
  if (!clean || captions?.burn === false) return null
  const event = captionAt(events, time)
  if (!event) return null
  const { style } = clean
  const font = CAPTION_FONTS[style.font]
  const plain = style.preset === 'plain'
  const L = captionLayout(style, frame, event.lines.length)
  const emoji = event.emoji && !brokenEmoji.has(event.emoji) ? event.emoji : null
  return (
    <div className="captions-overlay" aria-hidden="true">
      {emoji && (
        <img
          className="captions-overlay-emoji"
          src={emojiUrl(emoji)}
          alt=""
          onError={() => setBrokenEmoji(s => new Set(s).add(emoji))}
          style={{ left: `${(L.emoji.x / frame.width) * 100}%`, top: `${(L.emoji.y / frame.height) * 100}%`, width: `${(L.emoji.size / frame.height) * 100}cqh`, height: `${(L.emoji.size / frame.height) * 100}cqh` }}
        />
      )}
      <div
        key={event.pop ? `pop-${event.page}` : 'caption'}
        className={`captions-overlay-block${plain ? ' plain' : ''}${event.pop ? ' pop' : ''}`}
        style={{
          top: `${style.y}%`,
          fontFamily: `'${style.font}', sans-serif`,
          fontWeight: font.weight,
          fontSize: `${style.size}cqh`,
          lineHeight: font.line,
          color: style.color,
          '--caption-outline': `${(L.outline / L.fontPx) * 2}em`
        }}
      >
        {event.lines.map((line, i) => (
          <div className="captions-overlay-line" key={i}>
            <span>
              {line.map((w, j) => (
                <span key={j} style={w.active ? { color: style.highlight } : undefined}>{j ? ' ' : ''}{w.text}</span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default CaptionsOverlay
