// Tracks are numbered as the timeline shows them, top to bottom (video tracks,
// then audio): the number on the left of each track, and how the clip
// settings name a track ("2 · Music").
export function trackNumbers(tracks) {
  const shown = [...(tracks || []).filter(t => t.type === 'video'), ...(tracks || []).filter(t => t.type === 'audio')]
  return new Map(shown.map((t, i) => [t.id, i + 1]))
}

export const trackLabel = (track, numbers) => `${numbers.get(track.id) ?? '?'} · ${track.name || (track.music ? 'Music' : track.type === 'video' ? 'Video' : 'Voice')}`
