// The credit of a sound 3Speak hands the editor with load-media ("Use this
// sound": { music: true, credit }). It rides on the music clip like a library
// song's credit (MusicLibrary.jsx) and goes back in the post's musicCredits
// while the clip is on the timeline. 3Speak checks the credits again on its
// side; here only plain, short strings are kept.

const TEXT_FIELDS = { artist: 100, source: 60, sourceUrl: 500, license: 40, licenseUrl: 500, text: 300 }
const ACCOUNT = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '')

/** A credit from load-media, or null when it has no usable string id and title. */
export function loadCreditOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = text(raw.id, 300)
  const title = text(raw.title, 100)
  if (!id || !title) return null
  const credit = { id, title }
  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    const v = text(raw[key], max)
    credit[key] = v || null
  }
  const account = text(raw.account, 16).toLowerCase().replace(/^@/, '')
  credit.account = ACCOUNT.test(account) ? account : null
  return credit
}

/** A load-media message that puts a sound on the music track: audio by URL, `music: true`. */
export const isMusicLoad = (data, file) =>
  !!data && data.music === true && data.mediaType === 'audio' && !file && typeof data.url === 'string'
