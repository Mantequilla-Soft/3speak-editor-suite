// Pre-styled text boxes for the sticker picker. Each is an ordinary text clip
// with these properties, so the text stays editable and the preview, export
// and render draw it like any text clip (text box = textBox* properties).

import { t } from '../i18n'
// title and text are read in the interface language when used (the text is
// what the new text clip starts with)
export const TEXT_PRESETS = [
  {
    id: 'caption', get title() { return t('stickers.presets.caption.title') }, get text() { return t('stickers.presets.caption.text') },
    props: { fontFamily: 'Montserrat', fontWeight: 'bold', fontSize: 44, fontColor: '#ffffff', textBoxEnabled: true, textBoxColor: '#000000', textBoxOpacity: 75, textBoxRadius: 10, textBoxPadding: 14, textBoxBorderWidth: 0 }
  },
  {
    id: 'highlight', get title() { return t('stickers.presets.highlight.title') }, get text() { return t('stickers.presets.highlight.text') },
    props: { fontFamily: 'Montserrat', fontWeight: 'bold', fontSize: 48, fontColor: '#111111', textBoxEnabled: true, textBoxColor: '#ffd60a', textBoxOpacity: 100, textBoxRadius: 6, textBoxPadding: 12, textBoxBorderWidth: 0 }
  },
  {
    id: 'brand', get title() { return t('stickers.presets.brand.title') }, get text() { return t('stickers.presets.brand.text') },
    props: { fontFamily: 'Poppins', fontWeight: 'bold', fontSize: 46, fontColor: '#ffffff', textBoxEnabled: true, textBoxColor: '#e53935', textBoxOpacity: 100, textBoxRadius: 12, textBoxPadding: 14, textBoxBorderWidth: 0 }
  },
  {
    id: 'bubble', get title() { return t('stickers.presets.bubble.title') }, get text() { return t('stickers.presets.bubble.text') },
    props: { fontFamily: 'Nunito', fontWeight: 'bold', fontSize: 44, fontColor: '#111111', textBoxEnabled: true, textBoxColor: '#ffffff', textBoxOpacity: 100, textBoxRadius: 32, textBoxPadding: 18, textBoxBorderWidth: 0 }
  },
  {
    id: 'outline', get title() { return t('stickers.presets.outline.title') }, get text() { return t('stickers.presets.outline.text') },
    props: { fontFamily: 'Inter', fontWeight: 'bold', fontSize: 42, fontColor: '#ffffff', textBoxEnabled: true, textBoxColor: '#000000', textBoxOpacity: 0, textBoxRadius: 12, textBoxPadding: 14, textBoxBorderWidth: 4, textBoxBorderColor: '#ffffff' }
  },
  {
    id: 'neon', get title() { return t('stickers.presets.neon.title') }, get text() { return t('stickers.presets.neon.text') },
    props: { fontFamily: 'Bebas Neue', fontWeight: 'normal', fontSize: 64, fontColor: '#39ff14', textBoxEnabled: true, textBoxColor: '#0b0b12', textBoxOpacity: 85, textBoxRadius: 14, textBoxPadding: 14, textBoxBorderWidth: 4, textBoxBorderColor: '#39ff14' }
  },
  {
    id: 'title', get title() { return t('stickers.presets.title.title') }, get text() { return t('stickers.presets.title.text') },
    props: { fontFamily: 'Anton', fontWeight: 'normal', fontSize: 80, fontColor: '#ffffff', textBoxEnabled: false }
  },
  {
    id: 'comic', get title() { return t('stickers.presets.comic.title') }, get text() { return t('stickers.presets.comic.text') },
    props: { fontFamily: 'Bangers', fontWeight: 'normal', fontSize: 72, fontColor: '#ffd60a', textBoxEnabled: true, textBoxColor: '#e53935', textBoxOpacity: 100, textBoxRadius: 8, textBoxPadding: 12, textBoxBorderWidth: 5, textBoxBorderColor: '#111111' }
  },
  {
    id: 'marker', get title() { return t('stickers.presets.marker.title') }, get text() { return t('stickers.presets.marker.text') },
    props: { fontFamily: 'Permanent Marker', fontWeight: 'normal', fontSize: 52, fontColor: '#ffffff', textBoxEnabled: false }
  },
  {
    id: 'quote', get title() { return t('stickers.presets.quote.title') }, get text() { return t('stickers.presets.quote.text') },
    props: { fontFamily: 'Lora', fontWeight: 'normal', fontSize: 44, fontColor: '#ffffff', textBoxEnabled: true, textBoxColor: '#000000', textBoxOpacity: 55, textBoxRadius: 4, textBoxPadding: 16, textBoxBorderWidth: 0 }
  },
  {
    id: 'tag', get title() { return t('stickers.presets.tag.title') }, text: '#3speak',
    props: { fontFamily: 'Poppins', fontWeight: 'bold', fontSize: 36, fontColor: '#ffffff', textBoxEnabled: true, textBoxColor: '#2f80ed', textBoxOpacity: 100, textBoxRadius: 40, textBoxPadding: 12, textBoxBorderWidth: 0 }
  },
  {
    id: 'minimal', get title() { return t('stickers.presets.minimal.title') }, get text() { return t('stickers.presets.minimal.text') },
    props: { fontFamily: 'Inter', fontWeight: 'normal', fontSize: 40, fontColor: '#ffffff', textBoxEnabled: false }
  }
]

// CSS for a preset's preview tile (same look as the preview's text clip)
export function presetPreviewStyle(p) {
  const hex = (h, a) => {
    const n = parseInt((h || '#000000').slice(1), 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
  }
  return {
    fontFamily: `'${p.fontFamily}', sans-serif`,
    fontWeight: p.fontWeight === 'bold' ? 700 : 400,
    color: p.fontColor,
    fontSize: `${Math.max(13, Math.min(26, p.fontSize * 0.34))}px`,
    lineHeight: 1.15,
    textShadow: p.textBoxEnabled ? 'none' : '1px 1px 3px rgba(0,0,0,0.8)',
    ...(p.textBoxEnabled ? {
      background: hex(p.textBoxColor, (p.textBoxOpacity ?? 80) / 100),
      borderRadius: `${Math.round((p.textBoxRadius ?? 8) * 0.5)}px`,
      padding: `${Math.round((p.textBoxPadding ?? 12) * 0.45)}px ${Math.round((p.textBoxPadding ?? 12) * 0.7)}px`,
      border: p.textBoxBorderWidth ? `${Math.max(1, Math.round(p.textBoxBorderWidth * 0.5))}px solid ${p.textBoxBorderColor}` : 'none'
    } : {})
  }
}
