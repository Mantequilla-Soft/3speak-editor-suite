// Which editor this page is: the shorts video editor (default) or the audio
// editor (podcasts, music, voice), chosen by the page that opens it:
// ?mode=audio. Fixed for the life of the page.
export function readEditorMode(search = typeof window !== 'undefined' ? window.location.search : '') {
  try {
    return new URLSearchParams(search).get('mode') === 'audio' ? 'audio' : 'video'
  } catch {
    return 'video'
  }
}

export const EDITOR_MODE = readEditorMode()
export const isAudioMode = EDITOR_MODE === 'audio'
