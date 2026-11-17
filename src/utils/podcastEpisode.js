// An episode 3Speak already published, for the video podcast without an export
// first (open-video-podcast, sent by the audio page's "Video podcast"):
//   { url, title?, cover?, durationSec? }
// The url goes to the backend like an export's (POST /api/video-podcast fetches
// it); only https is taken. A missing length is read from the audio itself.

const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\/\S+$/.test(v) && v.length <= 2000 ? v : null)

/** The episode from the message, or null when it has no usable https url. */
export function podcastEpisodeOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const url = httpsUrl(raw.url)
  if (!url) return null
  const title = typeof raw.title === 'string' ? raw.title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) : ''
  const d = Number(raw.durationSec)
  return { url, title, cover: httpsUrl(raw.cover), durationSec: Number.isFinite(d) && d > 0 ? d : null }
}

/** The covers the dialog offers: the episode's own first, then the playlists' (no repeats). */
export function episodeCovers(episode, playlistCovers) {
  const list = Array.isArray(playlistCovers) ? playlistCovers : []
  if (!episode?.cover) return list
  return [{ title: episode.title, url: episode.cover }, ...list.filter(c => c.url !== episode.cover)]
}
