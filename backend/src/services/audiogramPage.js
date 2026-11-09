import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/**
 * The page an audiogram is drawn from, in the look of the 3Speak shorts
 * (projects/story-expired-v2 in the motion graphics cookbook): near-black with
 * a red and a navy glow, the 3S mark and "3Speak", Roboto 700 title, a Roboto
 * 500 line with the red accent, the cover in a rounded card. NO cyan except in
 * the mark itself.
 *
 * Everything on it is a layer the person can move, resize, turn and stack
 * (`layers`: logo, cover, title, line, wave, each { x, y, w, h, z, r, on } in
 * pixels of the video, r in degrees). The 3Speak logo always shows: it can
 * not be hidden, keeps its shape and a minimum size (LOGO_STYLES), stays in
 * the frame, in front of the rest. The page builds itself from a state object
 * (window.applyAudiogram(state, part)), so the editor shows the very same page
 * as its preview (GET /api/audiogram/page, state by postMessage) and the
 * backend screenshots it for the video:
 *   part 'below': the background and every layer under the waveform
 *   part 'above': the layers over the waveform, on transparent
 * ffmpeg puts the moving waveform between the two.
 */

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const MARK_SVG = readFileSync(path.join(ASSETS, '3speak-mark.svg'), 'utf8').replace(/<\?xml[^>]*>\s*/, '')

export const BRAND = {
  bg: '#0a0b12', ink: '#f4f5f8', mute: '#dfe2ec', accent: '#E32933',
  glow1: 'rgba(227,41,51,.38)', glow2: 'rgba(49,56,134,.75)'
}
// Vertical only: the shape of a Short
export const SIZES = { vertical: { w: 1080, h: 1920 } }
export const LAYER_IDS = ['logo', 'cover', 'title', 'line', 'wave']
export const DEFAULT_LINE = 'Full episode on *3speak.tv*'
export const LOGO_Z = 20
/**
 * The 3Speak branding: 'full' (the 3S mark and "3Speak") or 'mark' (the 3S
 * only). Its box always has the logo's own shape (w = h * aspect), so it can
 * not be made thin to shrink the logo, and is never under `minH` high.
 */
export const LOGO_STYLES = {
  full: { aspect: 5, minH: 64, defaultH: 80 },
  mark: { aspect: 1.15, minH: 120, defaultH: 140 }
}

/** The logo's box for a style: the logo's shape, at least its minimum, whole in the frame, around (cx, cy). */
export function logoBox(style, { cx, cy, h }, size) {
  const s = LOGO_STYLES[style] || LOGO_STYLES.full
  const maxH = Math.min(size.h, size.w / s.aspect)
  const hh = Math.round(Math.min(maxH, Math.max(s.minH, Number(h) || s.defaultH)))
  const w = Math.round(hh * s.aspect)
  const x = Math.round(Math.min(size.w - w, Math.max(0, cx - w / 2)))
  const y = Math.round(Math.min(size.h - hh, Math.max(0, cy - hh / 2)))
  return { x, y, w, h: hh }
}
/**
 * The round waveforms, in parts of the circle's radius: 'circle' is bars
 * standing out from an inner ring (`cols` bars per half, mirrored, `gap` of
 * each bar's slot empty), 'ring' a wavy line around the middle of the band.
 */
export const CIRCLE_SHAPES = {
  circle: { inner: 0.42, cols: 48, gap: 0.36 },
  ring: { inner: 0.5, cols: 200, gap: 0 }
}
/**
 * How the picture is used: a card on the dark 3Speak background (the one the
 * studio offers), a card on the picture blurred, or the picture over the whole
 * frame (no card). The last two are still drawn for older templates.
 */
export const IMAGE_LAYOUTS = ['card', 'blur', 'fill']

/**
 * The first arrangement (no template yet): a calm stack. Vertical keeps text
 * clear of the Shorts player's own buttons and captions (top 12 %, bottom 15 %).
 * With a cover and without one.
 */
export const DEFAULT_LAYOUTS = {
  vertical: {
    cover: {
      logo: { x: 340, y: 236, w: 400, h: 80, z: 5 },
      cover: { x: 230, y: 380, w: 620, h: 620, z: 1 },
      title: { x: 80, y: 1050, w: 920, h: 280, z: 3 },
      line: { x: 80, y: 1350, w: 920, h: 64, z: 4 },
      wave: { x: 90, y: 1440, w: 900, h: 180, z: 2 }
    },
    plain: {
      logo: { x: 340, y: 236, w: 400, h: 80, z: 5 },
      cover: { x: 230, y: 380, w: 620, h: 620, z: 1, on: false },
      title: { x: 80, y: 520, w: 920, h: 420, z: 3 },
      line: { x: 80, y: 960, w: 920, h: 64, z: 4 },
      wave: { x: 90, y: 1120, w: 900, h: 360, z: 2 }
    }
  }
}

/** The default layers of a shape, with or without a cover: { id: box }. */
export function defaultLayers(format, withCover, logoStyle = 'full') {
  const set = (DEFAULT_LAYOUTS[format] || DEFAULT_LAYOUTS.vertical)[withCover ? 'cover' : 'plain']
  const out = Object.fromEntries(LAYER_IDS.map(id => [id, { on: true, r: 0, ...set[id] }]))
  out.logo.z = LOGO_Z
  if (logoStyle !== 'full') {
    const l = out.logo
    out.logo = { ...l, ...logoBox(logoStyle, { cx: l.x + l.w / 2, cy: l.y + l.h / 2, h: LOGO_STYLES[logoStyle]?.defaultH }, SIZES[format] || SIZES.vertical) }
  }
  return out
}

const num = (v, min, max, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

// Degrees, -180..180 (whole degrees)
const angle = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  const a = ((Math.round(n) + 180) % 360 + 360) % 360 - 180
  return a === -180 ? 180 : a
}

/**
 * Layers as sent, checked against the frame: every box at least 16 px with
 * 16 px of it in the frame, z 0..19, turned -180..180 degrees. The logo: on,
 * in its own shape and at least its minimum (logoBox), whole inside the
 * frame, in front (z 20). Missing ones
 * come from the default arrangement.
 */
export function cleanLayers(input, format, withCover = true, logoStyle = 'full') {
  const size = SIZES[format] || SIZES.vertical
  const base = defaultLayers(format, withCover, logoStyle)
  const src = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const id of LAYER_IDS) {
    const d = base[id]
    const l = src[id] && typeof src[id] === 'object' ? src[id] : {}
    if (id === 'logo') {
      const w = num(l.w, 1, size.w, d.w)
      const h = num(l.h, 1, size.h, d.h)
      const x = num(l.x, -size.w, size.w, d.x)
      const y = num(l.y, -size.h, size.h, d.y)
      out.logo = { ...logoBox(logoStyle, { cx: x + w / 2, cy: y + h / 2, h }, size), z: LOGO_Z, r: angle(l.r), on: true }
      continue
    }
    const w = num(l.w, 16, size.w, d.w)
    const h = num(l.h, 16, size.h, d.h)
    out[id] = {
      x: num(l.x, -w + 16, size.w - 16, d.x),
      y: num(l.y, -h + 16, size.h - 16, d.y),
      w,
      h,
      z: num(l.z, 0, LOGO_Z - 1, Math.min(d.z, LOGO_Z - 1)),
      r: angle(l.r),
      on: typeof l.on === 'boolean' ? l.on : d.on !== false
    }
  }
  return out
}

/** The page (static: the state comes later). `preview` adds web fonts and the messaging. */
export function audiogramPageHtml({ preview = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8">
${preview ? '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Roboto:wght@500;700&display=swap" rel="stylesheet">' : ''}
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{overflow:hidden;background:transparent;font-family:Roboto,'Noto Sans',sans-serif;color:${BRAND.ink}}
#frame{position:relative;overflow:hidden}
#frame.bg{background:${BRAND.bg}}
.bgimg{position:absolute;inset:0;background-position:center;background-size:cover;background-repeat:no-repeat}
.bgimg.blur{inset:-80px;filter:blur(48px) saturate(1.1)}
.shade{position:absolute;inset:0}
.glow{position:absolute;inset:0}
.layer{position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;transform-origin:50% 50%}
.txt{display:block;max-width:100%}
.logo{gap:.28em;white-space:nowrap}
.logo svg{height:1em;width:auto;flex:none}
.logo span{font-weight:700;font-size:.86em;letter-spacing:-.015em;line-height:1}
.cover{overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.55)}
.cover img{width:100%;height:100%;object-fit:cover;display:block}
.title{font-weight:700;line-height:1.08;letter-spacing:-.015em;overflow-wrap:anywhere;text-shadow:0 2px 12px rgba(0,0,0,.35)}
.line{font-weight:500;line-height:1.2;color:${BRAND.mute}}
.line b{font-weight:500;color:${BRAND.accent}}
.wave svg{width:100%;height:100%;display:block}
</style></head><body><div id="frame"></div>
<script>
const MARK = ${JSON.stringify(MARK_SVG)};
const BRAND = ${JSON.stringify(BRAND)};
const CIRCLE = ${JSON.stringify(CIRCLE_SHAPES)};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssUrl = u => 'url("' + String(u).replace(/["\\\\\\n]/g, '') + '")';

// the largest font size at which el's text fits its box
function fit(el, max) {
  let lo = 8, hi = Math.max(8, max);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    el.style.fontSize = mid + 'px';
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) lo = mid; else hi = mid;
  }
  el.style.fontSize = lo + 'px';
}

// a still picture of the waveform kind (preview only: the video draws the real one)
function waveSvg(type, color, w, h) {
  const n = type === 'bars' ? Math.max(12, Math.round(w / 24)) : 160;
  let s = '';
  const amp = i => 0.15 + 0.85 * Math.abs(Math.sin(i * 0.37) * Math.cos(i * 0.11 + 1));
  if (type === 'bars') {
    const step = w / n;
    for (let i = 0; i < n; i++) { const a = amp(i) * h; s += '<rect x="' + (i * step + step * 0.12) + '" y="' + (h - a) / 2 + '" width="' + step * 0.76 + '" height="' + a + '" fill="' + color + '"/>'; }
  } else if (type === 'line') {
    let d = ''; for (let i = 0; i <= n; i++) d += (i ? 'L' : 'M') + (i * w / n) + ' ' + (h / 2 - (amp(i) - 0.5) * h * (i % 2 ? 1 : -1) * 0.8);
    s = '<path d="' + d + '" stroke="' + color + '" stroke-width="3" fill="none"/>';
  } else if (type === 'dots') {
    let d = ''; for (let i = 0; i <= n; i++) d += (i ? 'L' : 'M') + (i * w / n) + ' ' + (h / 2 + Math.sin(i * 0.5) * amp(i) * h * 0.4);
    s = '<path d="' + d + '" stroke="' + color + '" stroke-width="2" fill="none"/>';
  } else if (type === 'circle' || type === 'ring') {
    // round, in the middle of the box, as big as its shorter side (like the video's)
    const g = CIRCLE[type], R = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
    const at = (th, r) => (cx + Math.sin(th) * r).toFixed(1) + ' ' + (cy - Math.cos(th) * r).toFixed(1);
    if (type === 'circle') {
      const n2 = g.cols * 2, inner = R * g.inner, len = R - inner;
      for (let i = 0; i < n2; i++) {
        const th = (i + 0.5) / n2 * Math.PI * 2, k = i < g.cols ? i : n2 - 1 - i;
        s += '<path d="M' + at(th, inner) + 'L' + at(th, inner + len * (0.2 + 0.8 * amp(k))) + '" stroke="' + color + '" stroke-width="' + Math.max(2, Math.PI * 2 * inner / n2 * (1 - g.gap)) + '"/>';
      }
    } else {
      const mid = R * (g.inner + 1) / 2, a = R * (1 - g.inner) / 2;
      let d = ''; const m = 120;
      for (let i = 0; i <= m; i++) { const th = i / m * Math.PI * 2, k = i <= m / 2 ? i : m - i; d += (i ? 'L' : 'M') + at(th, mid + a * 0.8 * (amp(k * 2) - 0.5) * (k % 2 ? 1 : -1)); }
      s = '<path d="' + d + 'Z" stroke="' + color + '" stroke-width="' + Math.max(2, R / 60) + '" fill="none" stroke-linejoin="round"/>';
    }
  } else {
    for (let i = 0; i < n; i++) { const a = amp(i) * h * 0.9; s += '<rect x="' + (i * w / n) + '" y="' + (h - a) / 2 + '" width="' + Math.max(1, w / n * 0.6) + '" height="' + a + '" fill="' + color + '"/>'; }
  }
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' + s + '</svg>';
}

/**
 * state: { width, height, layers, title, line, image, imageLayout: 'card' | 'blur' | 'fill',
 *          wave: { type, color } }; part: 'all' (preview, with a drawn waveform),
 * 'below' (background + layers under the waveform), 'above' (layers over it, transparent)
 */
window.applyAudiogram = function (state, part = 'all') {
  const frame = document.getElementById('frame');
  const W = state.width, H = state.height;
  frame.style.width = W + 'px'; frame.style.height = H + 'px';
  frame.className = part === 'above' ? '' : 'bg';
  const L = state.layers || {};
  const waveZ = L.wave ? L.wave.z : 0;
  const image = state.image || null;
  const layout = image ? (state.imageLayout || 'blur') : 'none';
  let html = '';
  if (part !== 'above') {
    // blur: the picture soft and dark behind its card; fill: the picture itself
    // over the whole frame (no card), dimmed only enough to read the text
    if (layout === 'blur') html += '<div class="bgimg blur" style="background-image:' + cssUrl(image) + '"></div><div class="shade" style="background:rgba(10,11,18,.6)"></div>';
    if (layout === 'fill') html += '<div class="bgimg" style="background-image:' + cssUrl(image) + '"></div><div class="shade" style="background:linear-gradient(rgba(10,11,18,.15),rgba(10,11,18,.35) 45%,rgba(10,11,18,.6))"></div>';
    html += '<div class="glow" style="background:radial-gradient(' + Math.round(W * 0.95) + 'px ' + Math.round(H * 0.42) + 'px at 50% 0%, ' + BRAND.glow1 + ', transparent 70%),radial-gradient(' + Math.round(W * 0.9) + 'px ' + Math.round(H * 0.5) + 'px at 100% 100%, ' + BRAND.glow2 + ', transparent 70%)"></div>';
  }
  const shows = (id) => {
    const l = L[id];
    if (!l || (l.on === false && id !== 'logo')) return false;
    if (id === 'cover' && (!image || layout === 'fill')) return false;
    if (id === 'wave') return part === 'all';
    if (id === 'logo') return part !== 'below';
    if (part === 'below') return l.z < waveZ;
    if (part === 'above') return l.z >= waveZ;
    return true;
  };
  // the logo always in front
  const box = (l, id) => 'left:' + l.x + 'px;top:' + l.y + 'px;width:' + l.w + 'px;height:' + l.h + 'px;z-index:' + (id === 'logo' ? 100 : l.z + 1) + (l.r ? ';transform:rotate(' + Number(l.r) + 'deg)' : '');
  for (const id of ['logo', 'cover', 'title', 'line', 'wave']) {
    if (!shows(id)) continue;
    const l = L[id];
    if (id === 'logo') html += '<div class="layer logo" id="l-logo" style="' + box(l, id) + '">' + MARK + (state.logo === 'mark' ? '' : '<span>3Speak</span>') + '</div>';
    if (id === 'cover') html += '<div class="layer cover" style="' + box(l, id) + ';border-radius:' + Math.round(Math.min(l.w, l.h) * 0.055) + 'px"><img src="' + esc(image) + '" alt=""></div>';
    // the text in one inline box: as flex items the spaces next to the red words would go
    if (id === 'title' && state.title) html += '<div class="layer title" id="l-title" style="' + box(l, id) + '"><span class="txt">' + esc(state.title) + '</span></div>';
    if (id === 'line' && state.line) html += '<div class="layer line" id="l-line" style="' + box(l, id) + '"><span class="txt">' + esc(state.line).replace(/\\*([^*]+)\\*/g, '<b>$1</b>') + '</span></div>';
    if (id === 'wave') html += '<div class="layer wave" style="' + box(l, id) + '">' + waveSvg((state.wave || {}).type, (state.wave || {}).color || BRAND.accent, l.w, l.h) + '</div>';
  }
  frame.innerHTML = html;
  const logo = document.getElementById('l-logo');
  if (logo) {
    // the mark and the name as big as the box allows
    logo.style.fontSize = '100px';
    const k = Math.min(logo.clientWidth / logo.scrollWidth, logo.clientHeight / 100);
    logo.style.fontSize = Math.max(8, Math.floor(100 * Math.min(1, k) * 0.98)) + 'px';
    if (logo.scrollWidth > logo.clientWidth) logo.style.fontSize = Math.floor(parseFloat(logo.style.fontSize) * logo.clientWidth / logo.scrollWidth) + 'px';
  }
  const t = document.getElementById('l-title'); if (t) fit(t, Math.min(140, L.title.h));
  const ln = document.getElementById('l-line'); if (ln) fit(ln, Math.min(60, L.line.h));
  return true;
};
${preview ? `
// The editor's preview: the state comes by message (from the page that framed us)
window.addEventListener('message', (e) => {
  if (e.source !== window.parent || !e.data || e.data.type !== 'audiogram-state') return;
  document.fonts.ready.then(() => window.applyAudiogram(e.data.state, 'all'));
});
window.parent.postMessage({ type: 'audiogram-page-ready' }, '*');
document.fonts.ready.then(() => window.parent.postMessage({ type: 'audiogram-page-ready' }, '*'));` : ''}
</script></body></html>`
}

export function chromiumPath() {
  for (const p of [process.env.CHROMIUM_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium'].filter(Boolean)) if (existsSync(p)) return p
  return undefined // playwright's own download, if any
}

const even = (n) => Math.round(n / 2) * 2

/**
 * Where the moving waveform goes: { cx, cy, w, h, r } (its middle, its size
 * in even pixels, turned r degrees), or null when it is off. The round ones
 * are square, as big as the box's shorter side. ffmpeg places it by its
 * middle, so a box partly out of the frame or turned needs no clipping.
 */
export function waveBox(wave, type) {
  if (!wave || wave.on === false) return null
  const round = type === 'circle' || type === 'ring'
  const side = even(Math.max(64, Math.min(wave.w, wave.h)))
  return {
    cx: Math.round(wave.x + wave.w / 2),
    cy: Math.round(wave.y + wave.h / 2),
    w: round ? side : even(Math.max(16, wave.w)),
    h: round ? side : even(Math.max(16, wave.h)),
    r: Number(wave.r) || 0
  }
}

/**
 * The two stills of an audiogram: `below` (opaque PNG) and `above` (transparent
 * PNG, or null when nothing is over the waveform). The page loads nothing from
 * the network: the picture comes as a data: URI. Returns the waveform's place
 * too (waveBox).
 */
export async function renderStills({ state, belowFile, aboveFile, timeoutMs = 30000 }) {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless: false,
    args: ['--headless=new', '--no-sandbox', '--font-render-hinting=none', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio'] })
  const kill = setTimeout(() => browser.close().catch(() => {}), timeoutMs)
  try {
    const page = await browser.newPage({ viewport: { width: state.width, height: state.height }, deviceScaleFactor: 1 })
    await page.route('**/*', route => (route.request().url().startsWith('data:') ? route.continue() : route.abort()))
    await page.setContent(audiogramPageHtml(), { waitUntil: 'load', timeout: timeoutMs })
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(s => window.applyAudiogram(s, 'below'), state)
    await page.evaluate(() => Promise.all([...document.images].map(i => (i.complete ? null : new Promise(r => { i.onload = i.onerror = r })))))
    await page.screenshot({ path: belowFile, type: 'png', clip: { x: 0, y: 0, width: state.width, height: state.height } })
    const L = state.layers
    const coverShows = state.image && state.imageLayout !== 'fill'
    const anyAbove = Object.entries(L).some(([id, l]) => id !== 'wave' && l.on !== false && l.z >= L.wave.z && (id !== 'cover' || coverShows))
    let above = null
    if (anyAbove) {
      await page.evaluate(s => window.applyAudiogram(s, 'above'), state)
      await page.screenshot({ path: aboveFile, type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: state.width, height: state.height } })
      above = aboveFile
    }
    return { below: belowFile, above, box: waveBox(L.wave, state.wave?.type) }
  } finally {
    clearTimeout(kill)
    await browser.close().catch(() => {})
  }
}
