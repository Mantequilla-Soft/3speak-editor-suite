/**
 * Background removal (person key) in a render request: every keyed clip's
 * matte file goes to the server (once per file), and the clip carries the
 * key with the server's copy of it. A clip whose matte is still being made is
 * waited for; one that cannot get a matte is rendered without the key.
 */
import { getClipChromaKey } from './chromaKey'
import { startPersonMask, aliasMaskTrack } from './personMaskJobs'

/**
 * clip id -> server URL of its matte. toServer(localUrl, name, clip) uploads a
 * blob:/data: URL and returns the server URL (other URLs come back unchanged).
 */
export async function uploadPersonMasks(tracks, toServer, onProgress = () => {}) {
  const out = new Map()
  for (const track of tracks) {
    if (track.type !== 'video') continue
    for (const clip of track.clips) {
      const key = getClipChromaKey(clip)
      if (key?.mode !== 'person') continue
      let local = key.maskUrl
      if (!local) {
        onProgress(`Finding the person in ${clip.name || 'a clip'}...`)
        try {
          local = await startPersonMask(clip)
        } catch {
          continue
        }
      }
      const url = await toServer(local, 'person-mask.gz', clip)
      if (url && url !== local) aliasMaskTrack(local, url)
      if (url) out.set(clip.id, url)
    }
  }
  return out
}

/** The chromaKey a render gets for a person key (null maskUrl: rendered unkeyed). */
export function personKeyPayload(key, maskUrl) {
  return {
    color: 'person',
    threshold: key.threshold,
    softness: key.softness,
    maskUrl: maskUrl || null,
    background: { kind: key.background.kind, blur: key.background.blur, color: key.background.color }
  }
}
