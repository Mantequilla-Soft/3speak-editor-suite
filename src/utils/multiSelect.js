// Helpers for settings on several selected clips at once.

// The value all items share, or null when they differ (or there are none)
export function commonValue(values) {
  if (!values.length) return null
  return values.every(v => v === values[0]) ? values[0] : null
}

// The distinct recordings (source URLs) a set of clips comes from, in order
export function sourcesOf(clips, sourceOf) {
  const seen = new Set()
  for (const c of clips) {
    const s = sourceOf(c)
    if (s) seen.add(s)
  }
  return [...seen]
}

// What a multi-selection changes the sound of: audio clips as they are, a
// video clip through its linked audio clip, nothing for text/colour/images;
// each clip once
export function soundTargets(clips, linkedAudioOf) {
  const out = new Map()
  for (const c of clips) {
    const target = c.type === 'audio' ? c : c.type === 'video' ? (linkedAudioOf(c) || c) : null
    if (target) out.set(target.id, target)
  }
  return [...out.values()]
}
