// Pre-styled text boxes for the sticker picker. Each is an ordinary text clip
// with these properties, so the text stays editable and the preview, export
// and render draw it like any text clip (text box = textBox* properties).

export const TEXT_PRESETS = [
  {
    id: 'caption', title: 'Caption', text: 'Your caption here',
    props: { fontFamily: 'Montserrat', fontWeight: 'bold', fontSize: 44, fontColor: '#ffffff', textBoxEnabled: true, textBoxColor: '#000000', textBoxOpacity: 75, textBoxRadius: 10, textBoxPadding: 14, textBoxBorderWidth: 0 }
  },
  {
    id: 'highlight', title: 'Highlight', text: 'Must see!',
    props: { fontFamily: 'Montserrat', fontWeight: 'bold', fontSize: 48, fontColor: '#111111', textBoxEnabled: true, textBoxColor: '#ffd60a', textBoxOpacity: 100, textBoxRadius: 6, textBoxPadding: 12, textBoxBorderWidth: 0 }
  },
  {
    id: 'brand', title: '3Speak red', text: 'New video',
    props: { fontFamily: 'Poppins', fontWeight: 'bold', fontSize: 46, fontColor: '#ffffff', textBoxEnabled: true, textBoxColor: '#e53935', textBoxOpacity: 100, textBoxRadius: 12, textBoxPadding: 14, textBoxBorderWidth: 0 }
  },
  {
    id: 'bubble', title: 'Bubble', text: 'Hey there!',
    props: { fontFamily: 'Nunito', fontWeight: 'bold', fontSize: 44, fontColor: '#111111', textBoxEnabled: true, textBoxColor: '#ffffff', textBoxOpacity: 100, textBoxRadius: 32, textBoxPadding: 18, textBoxBorderWidth: 0 }
  },
  {
    id: 'outline', title: 'Outline', text: 'Look at this',
    props: { fontFamily: 'Inter', fontWeight: 'bold', fontSize: 42, fontColor: '#ffffff', textBoxEnabled: true, textBoxColor: '#000000', textBoxOpacity: 0, textBoxRadius: 12, textBoxPadding: 14, textBoxBorderWidth: 4, textBoxBorderColor: '#ffffff' }
  },
  {
    id: 'neon', title: 'Neon', text: 'TONIGHT',
    props: { fontFamily: 'Bebas Neue', fontWeight: 'normal', fontSize: 64, fontColor: '#39ff14', textBoxEnabled: true, textBoxColor: '#0b0b12', textBoxOpacity: 85, textBoxRadius: 14, textBoxPadding: 14, textBoxBorderWidth: 4, textBoxBorderColor: '#39ff14' }
  },
  {
    id: 'title', title: 'Big title', text: 'BIG NEWS',
    props: { fontFamily: 'Anton', fontWeight: 'normal', fontSize: 80, fontColor: '#ffffff', textBoxEnabled: false }
  },
  {
    id: 'comic', title: 'Comic', text: 'BOOM!',
    props: { fontFamily: 'Bangers', fontWeight: 'normal', fontSize: 72, fontColor: '#ffd60a', textBoxEnabled: true, textBoxColor: '#e53935', textBoxOpacity: 100, textBoxRadius: 8, textBoxPadding: 12, textBoxBorderWidth: 5, textBoxBorderColor: '#111111' }
  },
  {
    id: 'marker', title: 'Marker', text: 'handmade',
    props: { fontFamily: 'Permanent Marker', fontWeight: 'normal', fontSize: 52, fontColor: '#ffffff', textBoxEnabled: false }
  },
  {
    id: 'quote', title: 'Quote', text: '“Say it well.”',
    props: { fontFamily: 'Lora', fontWeight: 'normal', fontSize: 44, fontColor: '#ffffff', textBoxEnabled: true, textBoxColor: '#000000', textBoxOpacity: 55, textBoxRadius: 4, textBoxPadding: 16, textBoxBorderWidth: 0 }
  },
  {
    id: 'tag', title: 'Hashtag', text: '#3speak',
    props: { fontFamily: 'Poppins', fontWeight: 'bold', fontSize: 36, fontColor: '#ffffff', textBoxEnabled: true, textBoxColor: '#2f80ed', textBoxOpacity: 100, textBoxRadius: 40, textBoxPadding: 12, textBoxBorderWidth: 0 }
  },
  {
    id: 'minimal', title: 'Minimal', text: 'simple and clean',
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
