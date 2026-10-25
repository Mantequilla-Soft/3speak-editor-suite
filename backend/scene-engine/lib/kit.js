// Shared runner for scene-based templates. A template defines its scene types and calls
//   Kit.run(SCENES)
// which reads window.REEL (from content*.js), applies brand colours/fonts, builds every scene,
// lays them end to end and exposes window.reel for the renderer.
//
// Scene type: { build(cfg, brand) -> html, update(el, lt, d, cfg), exitPush?, hideBug? }
// Needs lib/timeline.js first. Page needs #stage, optionally #g1..#g3 glows, #prog, #bug.
(function () {
  const { prog, E, $, $$, markup, splitWords, envelope, ready, googleFonts } = window.Reel;

  const ICONS = {
    heart: c => `<path fill="${c}" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3.1 4.5 6.9 4.5c2.1 0 3.6 1.1 5.1 3 1.5-1.9 3-3 5.1-3 3.8 0 6 3.9 4.5 7.3C19.5 16.4 12 21 12 21z"/>`,
    coin: c => `<circle cx="12" cy="12" r="9" fill="none" stroke="${c}" stroke-width="2.4"/><path d="M12 7v10M9.2 9.6c0-1.2 1.2-1.9 2.8-1.9s2.8.7 2.8 1.9c0 2.6-5.6 1.6-5.6 4.4 0 1.3 1.2 2 2.8 2s2.8-.7 2.8-2" fill="none" stroke="${c}" stroke-width="2"/>`,
    megaphone: c => `<path fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round" d="M3 10v4h3l7 5V5L6 10H3z"/><path fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" d="M17 9a4 4 0 0 1 0 6M19.5 6.5a7.5 7.5 0 0 1 0 11"/>`,
    check: c => `<circle cx="12" cy="12" r="9" fill="none" stroke="${c}" stroke-width="2.4"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
    chat: c => `<path fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round" d="M4 5h16v11H9l-5 4z"/>`,
    globe: c => `<circle cx="12" cy="12" r="9" fill="none" stroke="${c}" stroke-width="2.2"/><path fill="none" stroke="${c}" stroke-width="2" d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>`,
    star: c => `<path fill="${c}" d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>`,
    play: c => `<path fill="${c}" d="M7 4l13 8-13 8z"/>`,
    arrow: c => `<path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    lock: c => `<rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="${c}" stroke-width="2.2"/>`,
    eye: c => `<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="${c}" stroke-width="2.2"/><circle cx="12" cy="12" r="3" fill="${c}"/>`,
    shield: c => `<path d="M12 3l8 3v6c0 4.6-3.4 8.3-8 9-4.6-.7-8-4.4-8-9V6z" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/><path d="M8.5 12l2.5 2.5 4.5-5" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>`,
    clock: c => `<circle cx="12" cy="12" r="9" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M12 7v5l3.5 2" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>`,
    calendar: c => `<rect x="3.5" y="5" width="17" height="15" rx="2" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>`,
    video: c => `<rect x="2.5" y="6" width="13" height="12" rx="2" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M15.5 10.5l6-3.5v10l-6-3.5" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/>`,
    upload: c => `<path d="M12 16V4M7 9l5-5 5 5M4 20h16" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
    cross: c => `<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`,
    user: c => `<circle cx="12" cy="8" r="4" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M4 21c1.2-4 4.3-6 8-6s6.8 2 8 6" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>`,
    spark: c => `<path fill="${c}" d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/>`,
    mic: c => `<rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>`,
    sliders: c => `<path d="M6 4v16M12 4v16M18 4v16" stroke="${c}" stroke-width="2" stroke-linecap="round" opacity=".45"/><path d="M3.5 14h5M9.5 8h5M15.5 16h5" stroke="${c}" stroke-width="3.2" stroke-linecap="round"/>`,
    code: c => `<path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    braces: c => `<path d="M9 4H8a2 2 0 0 0-2 2v3.5a2.5 2.5 0 0 1-2.5 2.5A2.5 2.5 0 0 1 6 14.5V18a2 2 0 0 0 2 2h1M15 4h1a2 2 0 0 1 2 2v3.5a2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0-2.5 2.5V18a2 2 0 0 1-2 2h-1" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    wave: c => `<path d="M3 12h1.5M6.5 8v8M10 4v16M13.5 7v10M17 10v4M20.5 12h.5" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`,
  };
  const icon = (name, c, size = 28) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24">${(ICONS[name] || ICONS.star)(c)}</svg>`;

  // ---- user content safety + images -------------------------------------------------------------
  // Text that goes into HTML outside markup(): attributes, raw labels.
  const esc = (v = '') => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // An image spec is a URL string or { url, scale?, x?, y? }. url() returns the URL if it is one we load
  // (http(s), blob:, data:image/..., or a relative path), else ''.
  function url(spec) {
    const u = String((spec && typeof spec === 'object' ? spec.url : spec) || '').trim();
    if (!u) return '';
    if (/^(https?:|blob:)/i.test(u) || /^data:image\/(png|jpe?g|webp|gif|avif|svg\+xml)[;,]/i.test(u)) return u;
    if (/^file:/i.test(u)) return window.KIT_ALLOW_FILE ? u : ''; // local CLI renders only, never a render server
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//')) return ''; // any other scheme
    return u; // relative path (projects' assets/...)
  }
  // URL for CSS url('...') inside a style="" attribute. Percent-encode by hand: encodeURIComponent leaves ' ( )
  // alone, and a quote or bracket would end the url() and let the rest of the string be CSS.
  const cssUrl = u => u.replace(/[\\'"()\s<>]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  const src = spec => esc(cssUrl(url(spec)));
  // a locale tag the browser accepts, else undefined (toLocaleString throws on a bad tag such as 'de_DE')
  const locale = l => { if (!l) return undefined; try { (0).toLocaleString(l); return l; } catch { return undefined; } };
  const num = (v, a, b, d) => { const n = +v; return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };
  // <img> for a user image. Placement: scale 1..5 = zoom INTO the picture (1 = the scene's own fit), x/y -1..1 = where
  // the picture sits in its frame (object-position, -1 = left/top edge) and the point the zoom keeps still.
  // Zoom crops: the element keeps its box, the scaled picture is clipped back to it, so it never grows out of a frame
  // that does not clip. A scene that rounds a user image sets the radius as --ir (border-radius: var(--ir)) so the clip
  // keeps its corners. All inline and only when set: an unplaced picture keeps the scene's own object-position
  // (screenshots pin to the top). The `scale` property composes with the Ken Burns `transform` the scenes animate.
  function img(spec, cls = '', style = '') {
    // no usable picture: still an <img> (transparent), so scenes that look the element up never crash
    const u = url(spec) || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const o = spec && typeof spec === 'object' ? spec : {};
    const px = 50 + num(o.x, -1, 1, 0) * 50, py = 50 + num(o.y, -1, 1, 0) * 50, s = num(o.scale, 1, 5, 1);
    // the box in the element's own (unscaled) coordinates that lands exactly on its layout box after scale(s) about (px, py)
    const k = 1 - 1 / s, pc = v => `${(v * k).toFixed(3)}%`;
    const at = `${px.toFixed(2)}% ${py.toFixed(2)}%`;
    const vars = [
      o.x != null || o.y != null ? `object-position:${at}` : '',
      s > 1 ? `scale:${s};transform-origin:${at}` : '',
      s > 1 ? `clip-path:inset(${pc(py)} ${pc(100 - px)} ${pc(100 - py)} ${pc(px)} round calc(var(--ir, 0px) / ${s}))` : '',
      style,
    ].filter(Boolean).join(';');
    return `<img class="ui${cls ? ' ' + esc(cls) : ''}" src="${esc(u)}" alt=""${vars ? ` style="${esc(vars).replace(/&#39;/g, "'")}"` : ''}>`;
  }

  // ---- doc defaults ------------------------------------------------------------------------------
  const DEFAULT_BRAND = {
    name: 'Brand', font: 'Inter', fonts: ['Inter:wght@400;500;600;700;800;900'],
    colors: { bg: '#0a0b12', ink: '#f4f5f8', mute: '#9aa0b4', accent: '#ff5a36', accent2: '#5ad1c8', accent3: '#8a8cff',
      glow1: 'rgba(255,90,54,.36)', glow2: 'rgba(60,60,160,.7)', glow3: 'rgba(90,209,200,.18)' },
  };
  function normalize(doc) {
    const brand = { ...DEFAULT_BRAND, ...(doc.brand || {}) };
    brand.colors = { ...DEFAULT_BRAND.colors, ...((doc.brand || {}).colors || {}) };
    return { fps: 30, transition: .25, width: 1920, height: 1080, ...doc, brand, scenes: doc.scenes || [] };
  }

  // uploaded font files: brand.fontFaces = [{ family, url, weight?, style? }] (TTF/OTF/WOFF/WOFF2)
  function fontFaces(list = []) {
    const st = document.createElement('style');
    st.id = 'kit-font-faces';
    st.textContent = list.filter(f => f && f.family && url(f.url)).map(f =>
      `@font-face { font-family: '${String(f.family).replace(/['\\<>]/g, '')}'; src: url('${cssUrl(url(f.url))}');` +
      ` font-weight: ${num(f.weight, 100, 900, 400) | 0}; font-style: ${f.style === 'italic' ? 'italic' : 'normal'}; font-display: block; }`).join('\n');
    document.head.appendChild(st);
  }
  const family = f => String(f || '').split(':')[0].replace(/['";<>\\]/g, '');

  // ---- mount / unmount -----------------------------------------------------------------------------
  let mounted = null; // { classes: [], vars: [] }
  function unmount() {
    if (!mounted) return;
    const stage = $('#stage');
    $$('#stage > .scene, #wm', document).forEach(el => el.remove());
    if (stage) stage.querySelectorAll(':scope > section.scene').forEach(el => el.remove());
    document.body.classList.remove(...mounted.classes);
    mounted.vars.forEach(v => document.documentElement.style.removeProperty(v));
    $$('#kit-font-faces').forEach(el => el.remove());
    const bug = $('#bug'); if (bug) { bug.innerHTML = ''; bug.style.opacity = 0; }
    mounted = null;
    window.reel = undefined;
  }

  // Build a reel from a doc { width, height, fps?, transition?, brand, scenes[], bug?, watermark?, sfx?, wordSfx?,
  // className?, locale?, progress? } and return window.reel. Safe to call again with a new doc (live preview).
  function mount(doc, templateScenes = {}) {
    unmount();
    // shared scene types (lib/scenes*.js) + the template's own; the template wins on a name clash
    const SCENES = { ...(window.KitScenes || {}), ...templateScenes };
    const R = window.REEL = normalize(doc), B = R.brand, C = B.colors, W = R.width, H = R.height;
    const classes = [H > W ? 'portrait' : 'landscape'];
    if (R.className) classes.push(...String(R.className).split(/\s+/).filter(c => /^[\w-]+$/.test(c))); // per-variant styling hook (e.g. a brand.css scope)
    if (R.progress) classes.push('show-prog');
    const root = document.documentElement.style, vars = [];
    const setVar = (k, v) => { if (v == null || v === '') return; root.setProperty(k, String(v).replace(/[;{}<>]/g, '')); vars.push(k); };
    Object.entries({ bg: C.bg, ink: C.ink, mute: C.mute, a1: C.accent, a2: C.accent2, a3: C.accent3, g1: C.glow1, g2: C.glow2, g3: C.glow3 })
      .forEach(([k, v]) => setVar(`--${k}`, v));
    const fams = [B.font, ...(B.fonts || []).map(family), ...(B.fontFaces || []).map(f => f.family)].map(family).filter(Boolean);
    setVar('--font', `${[...new Set(fams)].map(f => `'${f}'`).join(', ')}, sans-serif`);
    if (B.headFont) setVar('--font-head', `'${family(B.headFont)}', ${[...new Set(fams)].map(f => `'${f}'`).join(', ')}, sans-serif`);
    if (B.logoBg) { setVar('--logo-bg', B.logoBg); classes.push('logo-tile'); }
    setVar('--w', W + 'px'); setVar('--h', H + 'px');
    if (R.watermark) classes.push('watermarked');
    document.body.classList.add(...classes);
    mounted = { classes, vars };
    fontFaces(B.fontFaces);
    const fontCss = googleFonts((B.fonts || []).filter(f => /^[\w ]+(:[\w@;.,]+)?$/.test(f)));

    const stage = $('#stage');
    const anchor = $('#bug') || $('#prog') || null;
    let start = 0;
    const plan = R.scenes.map((s, i) => {
      const type = SCENES[s.type];
      if (!type) throw new Error(`unknown scene type "${s.type}" (have: ${Object.keys(SCENES).join(', ')})`);
      const el = document.createElement('section');
      el.className = `scene scene-${s.type}`;
      let t = type;
      try { el.innerHTML = type.build(s, B); }
      catch (e) {
        // one scene with missing/odd content must not take the whole reel down (live editing): show what broke instead
        console.warn(`scene ${i} (${s.type}) failed to build:`, e);
        el.innerHTML = `<div class="kit-broken"><b>${esc(s.type)}</b><span>${esc(e && e.message || e)}</span></div>`;
        t = { build: () => '', update: () => {} };
      }
      const upd = t.update;
      t = { ...t, hideBug: type.hideBug, exitPush: type.exitPush, cues: t === type ? type.cues : undefined,
        update: (el2, lt, d, cfg) => { try { upd(el2, lt, d, cfg); } catch (e) { if (!el2.dataset.err) { el2.dataset.err = 1; console.warn(`scene ${i} (${s.type}) update failed:`, e); } } } };
      stage.insertBefore(el, anchor);
      const item = { s, type: t, el, a: start, b: start + s.duration, first: i === 0, last: i === R.scenes.length - 1 };
      start += s.duration - R.transition;
      return item;
    });
    splitWords(stage);
    const duration = plan.length ? plan[plan.length - 1].b : 0;

    // small persistent brand mark (top-left), on until the first scene that sets hideBug
    const bug = $('#bug');
    const bugOff = (plan.find(p => p.type.hideBug) || { a: duration + 1 }).a;
    if (bug) bug.innerHTML = R.bug === false ? '' : `${B.logo ? img(B.logo) : `<i class="monogram">${esc(B.monogram || (B.name || '?')[0])}</i>`}<span>${markup(B.name)}</span>`;

    // spec/demo ads for someone else's brand: REEL.watermark = { text: 'SAMPLE', note: 'Sample ad by X. Not affiliated with Y.' }
    if (R.watermark) {
      const wm = document.createElement('div');
      wm.id = 'wm';
      const word = esc(R.watermark.text || 'SAMPLE');
      wm.innerHTML = `<div class="pat">${Array.from({ length: 14 }, () => `<span>${Array.from({ length: 8 }, () => word).join(' · ')}</span>`).join('')}</div>
        <div class="big">${word}</div>${R.watermark.note ? `<div class="rib">${markup(R.watermark.note)}</div>` : ''}`;
      stage.appendChild(wm);
    }

    function seek(t) {
      const g = (id, x, y) => { const el = $(id); if (el) el.style.transform = `translate(${x}px, ${y}px)`; };
      g('#g1', -.156 * W + Math.sin(t * .35) * 120, -.463 * H + Math.cos(t * .3) * 80);
      g('#g2', .469 * W + Math.cos(t * .28) * 160, .093 * H + Math.sin(t * .33) * 90);
      g('#g3', .156 * W + Math.sin(t * .22) * 200, .185 * H + Math.cos(t * .25) * 120);
      // fade THROUGH the background: the outgoing scene is gone by the middle of the overlap and the
      // incoming one starts there. A true crossfade (both half-visible) turns text over images to mud.
      const h = R.transition / 2;
      for (const p of plan) {
        const a = p.first ? p.a : p.a + h, b = p.last ? p.b + .01 : p.b - h;
        envelope(p.el, t, a, b, p.first ? .01 : h, p.last ? .01 : h + .05, p.type.exitPush ?? 1.04);
        if (t >= p.a && t <= p.b + .01) p.type.update(p.el, t - p.a, p.s.duration, p.s);
      }
      if (bug) bug.style.opacity = Math.min(prog(t, .1, .4), 1 - prog(t, bugOff - .1, bugOff + .15));
      const pr = $('#prog'); if (pr) pr.style.width = `${(t / duration) * 100}%`;
    }

    // [data-fit]: shrink the font until the text fits its box on one line (wide brand fonts, long names)
    function fitText() {
      $$('[data-fit]').forEach(el => {
        el.style.fontSize = '';
        el.style.whiteSpace = 'nowrap';
        // measure the text itself: centred text overflows to BOTH sides and scrollWidth misses the left half
        // ...against the box as drawn (getBoundingClientRect), so a transform on the element or a parent scales both sides
        const r = document.createRange(), textW = () => { r.selectNodeContents(el); return r.getBoundingClientRect().width; };
        const boxW = () => { const w = el.getBoundingClientRect().width; return w - 8 * (w / (el.clientWidth || 1)); };
        let fs = parseFloat(getComputedStyle(el).fontSize);
        while (textW() > boxW() && fs > 24) { fs *= .96; el.style.fontSize = fs + 'px'; }
      });
    }

    // --fit-h (lib/scenes-fit.css): a text block taller than its --fit-h, or wider than its own box (a long word),
    // gets every font in it scaled down by one factor until it fits (long user headlines, captions, taglines).
    // With --fit-zoom: 1 the block's children are zoomed instead (CSS zoom: text, paddings and icons together), for
    // lists of cards whose fixed paddings would not shrink with the text; the block itself keeps its position.
    // With --fit-zoom: 2 the block (absolutely placed with left + right) gets narrower around its centre, for a column of
    // fixed-aspect cards (16:9 stills) that only gets shorter when it gets narrower; text keeps its size.
    // Measured on layout boxes (offsetHeight, scrollWidth), so the scenes' animated transforms don't matter, with every
    // scene at its END state (see ready below): counters at their final value, typed text complete.
    function fitBoxes() {
      const prop = (el, k) => parseFloat(getComputedStyle(el).getPropertyValue(k)) || 0;
      $$('section.scene *').filter(el => prop(el, '--fit-h') > 0).forEach(el => {
        const maxH = prop(el, '--fit-h'), zoom = prop(el, '--fit-zoom') > 0;
        // width: scrollWidth, and for one-line pieces the text itself against the box (centred text overflows to BOTH
        // sides, scrollWidth misses the left half; only there, the scenes' rotated cards would read as overflow)
        const oneLine = getComputedStyle(el).whiteSpace === 'nowrap', r = document.createRange();
        const wide = () => { if (el.scrollWidth > el.clientWidth + 2) return true; if (!oneLine) return false;
          r.selectNodeContents(el); const t = r.getBoundingClientRect(), b = el.getBoundingClientRect(); return t.left < b.left - 2 || t.right > b.right + 2; };
        const fits = () => el.offsetHeight <= maxH + 1 && !wide();
        if (fits()) return;
        let set;
        if (prop(el, '--fit-zoom') >= 2) {
          const cs = getComputedStyle(el), L = parseFloat(cs.left), R = parseFloat(cs.right), w = el.offsetWidth;
          set = k => { const cut = (1 - k) * w / 2; el.style.left = `${L + cut}px`; el.style.right = `${R + cut}px`; };
        } else if (zoom) {
          const kids = [...el.children];
          set = k => kids.forEach(e => { e.style.zoom = k.toFixed(4); });
        } else {
          // the word-reveal spans splitWords() makes always inherit: leaving them out saves most of the style writes
          const all = [el, ...el.querySelectorAll('*:not(.w):not(.w *)')], base = all.map(e => parseFloat(getComputedStyle(e).fontSize));
          set = k => all.forEach((e, i) => { e.style.fontSize = `${(base[i] * k).toFixed(2)}px`; });
        }
        let lo = .35, hi = 1; // 7 halvings: within 1% of the largest size that fits
        for (let i = 0; i < 7; i++) { const k = (lo + hi) / 2; set(k); if (fits()) lo = k; else hi = k; }
        set(lo);
      });
    }

    // sound cues for the renderer (--sfx): a whoosh as each new scene arrives, plus moments a scene type reports
    // through cues(cfg, duration) -> [{ t (local seconds), kind: 'trans'|'whoosh'|'swish'|'tick'|'click'|'type', gain?: dB }]. REEL.sfx === false turns them off.
    // Every cue also carries the index of the scene it belongs to (scene), so an editor can place them as clips.
    const cues = [];
    if (R.sfx !== false) plan.forEach((p, si) => {
      if (!p.first) cues.push({ t: +(p.a + R.transition / 2).toFixed(3), kind: 'trans', scene: si }); // short pitched whoosh, as long as the fade
      for (const c of (p.type.cues ? p.type.cues(p.s, p.s.duration) : [])) if (c.t >= 0 && c.t < p.s.duration) cues.push({ t: +(p.a + c.t).toFixed(3), kind: c.kind, scene: si, ...(c.gain ? { gain: c.gain } : {}) });
    });
    // a soft click on every word that rises in word by word (split text: headlines, lines, taglines), found by running each
    // scene once at 60 fps and noting when each word passes halfway up its mask. REEL.wordSfx === false turns these off.
    if (R.sfx !== false && R.wordSfx !== false) plan.forEach((p, si) => {
      const spans = $$('.w > span', p.el);
      if (!spans.length) return;
      const seen = new Set(); let last = -1;
      for (let lt = 0; lt <= p.s.duration; lt += 1 / 60) {
        p.type.update(p.el, lt, p.s.duration, p.s);
        spans.forEach((sp, i) => {
          if (seen.has(i)) return;
          const m = /translateY\(([-\d.]+)%\)/.exec(sp.style.transform);
          if (!m || +m[1] >= 55) return;
          seen.add(i);
          if (lt - last >= .05) { cues.push({ t: +(p.a + lt).toFixed(3), kind: 'click', scene: si, gain: -1 }); last = lt; } // no machine-gun on fast staggers
        });
      }
    });
    cues.sort((a, b) => a.t - b.t);

    const allText = R.scenes.flatMap(s => s.words || []).join('') + 'Aa';
    const scenes = plan.map(p => ({ type: p.s.type, start: +p.a.toFixed(3), end: +p.b.toFixed(3) }));
    window.reel = {
      seek, duration, fps: R.fps, width: W, height: H, cues, scenes,
      // fitting measures every scene at its END state: counters final, typed text complete, pop-ins at full size
      ready: fontCss.then(() => ready({ families: [...new Set(fams)], text: allText }))
        .then(() => { for (const p of plan) p.type.update(p.el, p.s.duration, p.s.duration, p.s); fitText(); fitBoxes(); }).then(() => seek(0)),
    };
    seek(0);
    return window.reel;
  }

  // classic entry: the page set window.REEL (content.js) and the template passes its own scene types
  function run(templateScenes) { return mount(window.REEL, templateScenes); }

  // load content.js, or the variant named in ?content=content-foo.js (render.mjs --content)
  function loadContent() {
    const f = new URLSearchParams(location.search).get('content') || 'content.js';
    if (!/^[\w.-]+\.js$/.test(f)) throw new Error('bad content file ' + f);
    document.write(`<script src="${f}"><\/script>`);
  }

  window.Kit = { ICONS, icon, run, mount, unmount, normalize, loadContent, esc, url, src, cssUrl, img, locale, accents: () => [window.REEL.brand.colors.accent, window.REEL.brand.colors.accent2, window.REEL.brand.colors.accent3] };
})();
