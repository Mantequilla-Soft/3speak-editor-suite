import { lazy, Suspense } from 'react'

// Dialogs and panels that only show after a click (or only in the legacy
// layout): each is its own chunk, fetched when it first opens, so the editor
// opens with less code. Same props as the components themselves.
function lazyPanel(load) {
  const Inner = lazy(load)
  const Panel = (props) => (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  )
  return Panel
}

export const AudiogramDialog = lazyPanel(() => import('./AudiogramDialog'))
export const AudioTemplateDialog = lazyPanel(() => import('./AudioTemplateDialog'))
export const ChaptersDialog = lazyPanel(() => import('./ChaptersDialog'))
export const BeatSyncModal = lazyPanel(() => import('./BeatSyncModal'))
export const StickerPicker = lazyPanel(() => import('./StickerPicker'))
export const MusicLibrary = lazyPanel(() => import('./MusicLibrary'))
export const RecordVideo = lazyPanel(() => import('./RecordVideo'))
export const RecordAudio = lazyPanel(() => import('./RecordAudio'))
export const CaptionsPanel = lazyPanel(() => import('./CaptionsPanel'))
export const RemixModePicker = lazyPanel(() => import('./RemixModePicker'))
export const ShortcutSheet = lazyPanel(() => import('./ShortcutSheet'))
export const TitleTemplates = lazyPanel(() => import('./TitleTemplates'))
// the word tools (components/WordTools.jsx): transcript, Remove fillers, chapter ideas
export const TranscriptPanel = lazyPanel(() => import('./TranscriptPanel'))
export const FillerReviewDialog = lazyPanel(() => import('./FillerReviewDialog'))
export const ChapterSuggestions = lazyPanel(() => import('./ChapterSuggestions'))
// the legacy layout's own parts (3Speak always opens the compact layout)
export const ProjectLibrary = lazyPanel(() => import('./ProjectLibrary'))
export const VideoPreview = lazyPanel(() => import('./VideoPreview'))
export const ExportButton = lazyPanel(() => import('./ExportButton'))
