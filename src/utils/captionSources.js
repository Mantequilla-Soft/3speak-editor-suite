// What auto captions listen to, and where their emoji pictures come from.

/**
 * The tracks whose sound is speech: audio tracks that are not music or sound
 * effects (and not muted), plus the video clips playing their own sound, as
 * one more audio track. The backend mixes them like an audio render, so the
 * word times it finds are timeline times.
 */
export function voiceTracksOf(tracks) {
  const voice = (tracks || [])
    .filter(t => t.type === 'audio' && !t.music && !t.sfx && t.muted !== true)
    .map(t => ({ ...t, clips: t.clips.filter(c => c.audioEnabled !== false && !c.templateRole) }))
  const fromVideo = (tracks || [])
    .filter(t => t.type === 'video' && t.visible !== false)
    .flatMap(t => t.clips.filter(c => c.type === 'video' && c.audioEnabled === true))
    .map(c => ({ ...c, type: 'audio' }))
  if (fromVideo.length) voice.push({ id: 'captions-video-sound', type: 'audio', name: 'Video sound', clips: fromVideo })
  return voice.filter(t => t.clips.length > 0)
}

// The sticker library (scripts/stickers/build_library.py) has the Noto emojis as emoji/<code point>.png
const STICKER_LIBRARY = (import.meta.env?.VITE_STICKER_SOURCES || '/stickers/library.json').split(',').map(s => s.trim()).filter(Boolean)[0]

/** The picture of an emoji (code point '1f525'), as an absolute URL the render backends can fetch. */
export function emojiUrl(cp, origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost') {
  return new URL(`emoji/${cp}.png`, new URL(STICKER_LIBRARY, origin)).href
}

/** { code point: URL } for every emoji the words use. */
export function emojiUrlsOf(words, origin) {
  const out = {}
  for (const w of words || []) if (w.emoji) out[w.emoji] = emojiUrl(w.emoji, origin)
  return out
}
