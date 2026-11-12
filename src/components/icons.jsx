// Icons for the editor: Material Symbols Rounded, the set 3Speak's v2 design uses
// (design_handoff_3speak_v2/ICONS.md). The font comes from Google Fonts in
// index.html with an `icon_names=` list, so only these glyphs are downloaded.
//
// The exports keep the names the editor used with lucide-react, so components
// only change their import line. Adding an icon: put it in MATERIAL below; the
// unit test (tests/icons.test.js) fails until index.html lists it too.
//
// Rendered as an empty <i>, so the editor's older `button span` rules never catch
// an icon; the glyph name comes from CSS (.ms-icon::before), so it never shows up
// in a control's text (innerText, copy and paste, tests reading labels).
// Props follow lucide: size (px), className, style, fill (truthy and not 'none'
// = the filled glyph, used for an active state), color, title, aria-*.
export const MATERIAL = {
  AlertCircle: 'error',
  AlignCenter: 'format_align_center',
  AlignLeft: 'format_align_left',
  AlignRight: 'format_align_right',
  ArrowLeftToLine: 'keyboard_tab_rtl',
  ArrowRight: 'arrow_forward',
  ArrowRightLeft: 'swap_horiz',
  AudioLines: 'graphic_eq',
  AudioWaveform: 'graphic_eq',
  Bookmark: 'bookmark',
  Check: 'check',
  ChevronDown: 'keyboard_arrow_down',
  ChevronLeft: 'chevron_left',
  ChevronRight: 'chevron_right',
  ChevronUp: 'keyboard_arrow_up',
  Circle: 'fiber_manual_record',
  Clapperboard: 'movie_edit',
  ClipboardPaste: 'content_paste',
  Clock: 'schedule',
  Cloud: 'cloud_done',
  CloudOff: 'cloud_off',
  Copy: 'content_copy',
  Crop: 'crop',
  Crosshair: 'center_focus_strong',
  Crown: 'workspace_premium',
  Download: 'download',
  Droplets: 'water_drop',
  ExternalLink: 'open_in_new',
  Eye: 'visibility',
  EyeOff: 'visibility_off',
  FilePlus2: 'note_add',
  Film: 'movie',
  Flag: 'flag',
  FolderOpen: 'folder_open',
  FolderPlus: 'create_new_folder',
  Gauge: 'speed',
  GripHorizontal: 'drag_handle',
  GripVertical: 'drag_indicator',
  HelpCircle: 'help',
  Image: 'image',
  Info: 'info',
  LayoutTemplate: 'space_dashboard',
  Link: 'link',
  ListChecks: 'checklist',
  Loader2: 'progress_activity',
  Lock: 'lock',
  LogIn: 'login',
  Magnet: 'align_horizontal_center',
  Maximize: 'fullscreen',
  Maximize2: 'open_in_full',
  Mic: 'mic',
  Minimize: 'fullscreen_exit',
  Minimize2: 'close_fullscreen',
  Minus: 'remove',
  MoreHorizontal: 'more_horiz',
  MousePointerClick: 'touch_app',
  Move: 'open_with',
  Music: 'music_note',
  Music2: 'library_music',
  Palette: 'palette',
  Pause: 'pause',
  PenLine: 'edit',
  Pencil: 'edit',
  Play: 'play_arrow',
  Plus: 'add',
  Redo2: 'redo',
  Repeat: 'repeat',
  RotateCcw: 'undo',
  RotateCw: 'rotate_right',
  ScrollText: 'article',
  Scissors: 'content_cut',
  Search: 'search',
  Send: 'send',
  Settings: 'settings',
  SkipBack: 'skip_previous',
  Sliders: 'tune',
  Square: 'stop',
  Sticker: 'mood',
  SunMedium: 'light_mode',
  Trash2: 'delete',
  Type: 'title',
  Undo2: 'undo',
  Unlink: 'link_off',
  Upload: 'upload',
  Video: 'videocam',
  Volume2: 'volume_up',
  VolumeX: 'volume_off',
  Wand2: 'auto_fix_high',
  X: 'close',
  ZoomIn: 'zoom_in',
}

export function Icon({ name, size = 18, fill = false, className = '', style, color, strokeWidth, absoluteStrokeWidth, ...rest }) {
  const filled = !!fill && fill !== 'none'
  return (
    <i
      aria-hidden={rest['aria-label'] ? undefined : 'true'}
      className={`ms-icon material-symbols-rounded${className ? ` ${className}` : ''}`}
      style={{ fontSize: size, fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' 24`, ...(color ? { color } : null), ...style }}
      data-icon={name}
      {...rest}
    />
  )
}

const make = (lucideName) => {
  const C = ({ size = 24, ...props }) => <Icon name={MATERIAL[lucideName]} size={size} {...props} />
  C.displayName = lucideName
  return C
}

export const AlertCircle = make('AlertCircle')
export const AlignCenter = make('AlignCenter')
export const AlignLeft = make('AlignLeft')
export const AlignRight = make('AlignRight')
export const ArrowLeftToLine = make('ArrowLeftToLine')
export const ArrowRight = make('ArrowRight')
export const ArrowRightLeft = make('ArrowRightLeft')
export const AudioLines = make('AudioLines')
export const AudioWaveform = make('AudioWaveform')
export const Bookmark = make('Bookmark')
export const Check = make('Check')
export const ChevronDown = make('ChevronDown')
export const ChevronLeft = make('ChevronLeft')
export const ChevronRight = make('ChevronRight')
export const ChevronUp = make('ChevronUp')
export const Circle = make('Circle')
export const Clapperboard = make('Clapperboard')
export const ClipboardPaste = make('ClipboardPaste')
export const Clock = make('Clock')
export const Cloud = make('Cloud')
export const CloudOff = make('CloudOff')
export const Copy = make('Copy')
export const Crop = make('Crop')
export const Crosshair = make('Crosshair')
export const Crown = make('Crown')
export const Download = make('Download')
export const Droplets = make('Droplets')
export const ExternalLink = make('ExternalLink')
export const Eye = make('Eye')
export const EyeOff = make('EyeOff')
export const FilePlus2 = make('FilePlus2')
export const Film = make('Film')
export const Flag = make('Flag')
export const FolderOpen = make('FolderOpen')
export const FolderPlus = make('FolderPlus')
export const Gauge = make('Gauge')
export const GripHorizontal = make('GripHorizontal')
export const GripVertical = make('GripVertical')
export const HelpCircle = make('HelpCircle')
export const Image = make('Image')
export const Info = make('Info')
export const LayoutTemplate = make('LayoutTemplate')
export const Link = make('Link')
export const ListChecks = make('ListChecks')
export const Loader2 = make('Loader2')
export const Lock = make('Lock')
export const LogIn = make('LogIn')
export const Magnet = make('Magnet')
export const Maximize = make('Maximize')
export const Maximize2 = make('Maximize2')
export const Mic = make('Mic')
export const Minimize = make('Minimize')
export const Minimize2 = make('Minimize2')
export const Minus = make('Minus')
export const MoreHorizontal = make('MoreHorizontal')
export const MousePointerClick = make('MousePointerClick')
export const Move = make('Move')
export const Music = make('Music')
export const Music2 = make('Music2')
export const Palette = make('Palette')
export const Pause = make('Pause')
export const PenLine = make('PenLine')
export const Pencil = make('Pencil')
export const Play = make('Play')
export const Plus = make('Plus')
export const Redo2 = make('Redo2')
export const Repeat = make('Repeat')
export const RotateCcw = make('RotateCcw')
export const RotateCw = make('RotateCw')
export const ScrollText = make('ScrollText')
export const Scissors = make('Scissors')
export const Search = make('Search')
export const Send = make('Send')
export const Settings = make('Settings')
export const SkipBack = make('SkipBack')
export const Sliders = make('Sliders')
export const Square = make('Square')
export const Sticker = make('Sticker')
export const SunMedium = make('SunMedium')
export const Trash2 = make('Trash2')
export const Type = make('Type')
export const Undo2 = make('Undo2')
export const Unlink = make('Unlink')
export const Upload = make('Upload')
export const Video = make('Video')
export const Volume2 = make('Volume2')
export const VolumeX = make('VolumeX')
export const Wand2 = make('Wand2')
export const X = make('X')
export const ZoomIn = make('ZoomIn')
