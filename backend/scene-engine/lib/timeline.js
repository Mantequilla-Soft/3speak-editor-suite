// Browser-side helpers for time-driven reels. Loaded with a plain <script>, exposes window.Reel.
//
// The one rule: every visual property is a pure function of t (seconds). No CSS animations,
// no transitions, no requestAnimationFrame. The renderer calls seek(t) once per frame and
// screenshots, so whatever seek(t) draws IS the frame.
(function () {
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  // 0..1 progress of t through [a, b]
  const prog = (t, a, b) => clamp((t - a) / (b - a));
  const lerp = (a, b, x) => a + (b - a) * x;

  const E = {
    linear: x => x,
    inCubic: x => x * x * x,
    outCubic: x => 1 - Math.pow(1 - x, 3),
    outQuint: x => 1 - Math.pow(1 - x, 5),
    outExpo: x => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
    inOutCubic: x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    outBack: x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
  };

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  // "Tools that *work* the _way_ you think" -> accent spans. *x* = .a1, _x_ = .a2
  function markup(s = '') {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*([^*]+)\*/g, '<em class="a1">$1</em>')
      .replace(/_([^_]+)_/g, '<em class="a2">$1</em>');
  }

  // Split every [data-split] element into masked words (.w > span > span.colour).
  // A word may span several nodes: "<em>yours</em>." stays ONE word, no gap before the dot.
  function splitWords(root = document) {
    $$('[data-split]', root).forEach(h => {
      const out = [];
      let glue = false;
      h.childNodes.forEach(n => {
        const cls = n.nodeType === 1 ? n.className : '';
        const txt = n.textContent;
        (txt.match(/\S+/g) || []).forEach((word, i) => {
          const piece = `<span class="${cls}">${word}</span>`;
          if (i === 0 && glue && !/^\s/.test(txt)) out[out.length - 1] += piece;
          else out.push(piece);
        });
        glue = txt.length > 0 && !/\s$/.test(txt);
      });
      h.innerHTML = out.map(w => `<span class="w"><span>${w}</span></span>`).join(' ');
    });
  }

  // Masked rise of every split word inside scope, staggered by `step`.
  function words(scope, t, start, step = 0.07, dur = 0.55) {
    $$('.w > span', scope).forEach((s, i) => {
      const x = E.outQuint(prog(t, start + i * step, start + i * step + dur));
      s.style.transform = `translateY(${(1 - x) * 110}%)`;
    });
  }

  function fadeUp(el, t, a, dur = 0.5, dist = 24) {
    if (!el) return;
    const x = E.outCubic(prog(t, a, a + dur));
    el.style.opacity = x;
    el.style.transform = `translateY(${(1 - x) * dist}px)`;
  }

  function popIn(el, t, a, dur = 0.5, from = 0.8) {
    if (!el) return;
    const x = E.outBack(prog(t, a, a + dur));
    el.style.opacity = prog(t, a, a + dur * 0.4);
    el.style.transform = `scale(${lerp(from, 1, x)})`;
  }

  // Scene envelope: visible on [a, b], fades in over fi, out over fo, pushes forward on exit.
  function envelope(el, t, a, b, fi = 0.25, fo = 0.3, push = 1.04) {
    const on = t >= a && t <= b;
    const i = prog(t, a, a + fi), o = prog(t, b - fo, b);
    el.style.visibility = on ? 'visible' : 'hidden';
    el.style.opacity = on ? Math.min(i, 1 - o) : 0;
    el.style.transform = `scale(${lerp(1, push, E.inCubic(o))})`;
  }

  // Resolves when the given font families have loaded for `text` and every <img> has decoded.
  // Call it AFTER the DOM is built, so dynamically added images are included.
  // Every weight in use must be loaded BEFORE anything measures text: a heavier weight that arrives later
  // is wider, which silently breaks fitted text.
  function ready({ families = [], weights = [400, 500, 600, 700, 800, 900], text = '' } = {}) {
    return Promise.all([
      document.fonts.ready,
      ...families.flatMap(f => weights.map(w => document.fonts.load(`${w} 100px "${f}"`, (text || '') + 'AaBbWwMm0123'))),
      ...$$('img').map(i => i.decode().catch(() => console.warn('image failed', i.src))),
    ]).then(() => document.fonts.ready);
  }

  // Google Fonts <link> for a list like ['Inter Tight:wght@500;600;800;900', 'Noto Sans JP:wght@800'].
  // Resolves once the stylesheet is in: document.fonts.load() before that finds no @font-face
  // and resolves instantly, so await this before ready().
  function googleFonts(specs) {
    if (!specs.length) return Promise.resolve();
    const q = specs.map(s => 'family=' + s.replace(/ /g, '+')).join('&');
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = `https://fonts.googleapis.com/css2?${q}&display=block`;
    const loaded = new Promise(r => { l.onload = r; l.onerror = () => { console.warn('font css failed'); r(); }; });
    document.head.appendChild(l);
    return loaded;
  }

  window.Reel = { clamp, prog, lerp, E, $, $$, markup, splitWords, words, fadeUp, popIn, envelope, ready, googleFonts };
})();
