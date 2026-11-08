// Input types where Space is typed as text (a slider, checkbox, radio, colour
// or file input is not text: Space there plays / pauses the editor instead)
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week'])

/** Is this element taking typed text (so a key like Space belongs to it)? */
export function isTypingTarget(el) {
  if (!el || !el.tagName) return false
  if (el.isContentEditable) return true
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA') return true
  if (tag !== 'INPUT') return false
  return TEXT_INPUT_TYPES.has(String(el.getAttribute?.('type') ?? el.type ?? '').toLowerCase())
}
