// Shared scene types, usable by every template in both orientations (body.portrait / body.landscape,
// set by lib/kit.js). A template's own scene of the same name wins. Styles live in lib/scenes.css.
//
//   words     kinetic one-word flashes            { words: ['Watch.', 'Create.', '*Earn.*'], line?, hold?, label? }
//             hold = seconds the line is on screen at the end (default 1.1; ~3 for a full sentence)
//   compare   "elsewhere" vs "here" columns       { label?, lines, left: { title, items[] }, right: { title, items[] } }
//   steps     numbered steps with a drawing line  { label?, lines, steps: [{ title, sub? }] }
//   notify    phone-style notifications            { label?, lines, items: [{ title, text, time?, icon? }] }
//   spotlight one image, slow zoom, name tag      { image, tag?: { title, sub? }, label?, lines }
//   quote     a REAL quote with attribution        { quote, name, handle?, avatar? }
//   cards     feature cards fanning out of a stack { label?, lines, cards: [{ icon, title, sub? }] }
//   greetings cycle through words, land on the last { label?, words[], line?, strip?, hold? }
(function () {
  const { prog, lerp, E, $, $$, markup, words, fadeUp, popIn } = window.Reel;
  const icon = (...a) => window.Kit.icon(...a);
  const C = () => window.REEL.brand.colors;
  const B = () => window.REEL.brand;
  const accents = () => [C().accent, C().accent2, C().accent3];
  const lines = (arr = [], tag = 'h1') => arr.map(l => `<${tag} data-split>${markup(l)}</${tag}>`).join('');
  const label = s => s ? `<div class="label">${markup(s)}</div>` : '';
  const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
  const head = s => `<div class="xhead">${label(s.label)}${lines(s.lines)}</div>`;
  const animHead = (el, t, at = .05) => { fadeUp($('.xhead .label', el), t, at, .4, 20); words($('.xhead', el), t, at + .05, .08, .5); };
  const brandTile = () => B().logo ? `${window.Kit.img(B().logo)}` : `<i class="monogram">${window.Kit.esc(B().monogram || (B().name || '?')[0])}</i>`;
  const portrait = () => window.REEL.height > window.REEL.width;

  window.KitScenes = {
    words: {
      cues: (s, d) => { const n = s.words.length, seg = kwSpan(s, d) / n;
        return s.words.map((_, i) => ({ t: i * seg + .03, kind: 'click' })); },
      build: s => `${label(s.label)}<div class="kw">${s.words.map(w => `<div class="kw-word">${markup(w)}</div>`).join('')}</div>
        ${s.line ? `<div class="kw-line" data-split>${markup(s.line)}</div>` : ''}`,
      update(el, t, d, s) {
        fadeUp($(':scope > .label', el), t, 0, .4, 20);
        const n = s.words.length, span = kwSpan(s, d), seg = span / n;
        $$('.kw-word', el).forEach((w, i) => {
          const a = i * seg, xin = E.outExpo(prog(t, a, a + .3));
          const xout = i === n - 1 ? 0 : prog(t, a + seg - .1, a + seg);
          w.style.opacity = xin * (1 - xout);
          w.style.transform = `scale(${lerp(1.35, 1, xin) - xout * .08}) translateY(${(1 - xin) * 20}px)`;
        });
        if (s.line) words(el, t, span + .05, .07, .5);
      },
    },

    compare: {
      build(s) {
        const col = (c, kind) => `<div class="cmp-col ${kind}"><div class="cmp-title">${markup(c.title)}</div>
          ${c.items.map(it => `<div class="cmp-item"><span class="mk">${kind === 'old' ? icon('cross', C().mute, 34) : icon('check', C().accent2, 36)}</span><span>${markup(it)}</span></div>`).join('')}</div>`;
        return `${head(s)}<div class="cmp">${col(s.left, 'old')}${col(s.right, 'new')}</div>`;
      },
      update(el, t, d, s) {
        animHead(el, t);
        const nl = s.left.items.length, pt = portrait();
        const slide = (c, a, from) => { const x = E.outQuint(prog(t, a, a + .5)); c.style.opacity = prog(t, a, a + .25); c.style.transform = pt ? `translateY(${(1 - x) * from}px)` : `translateX(${(1 - x) * from}px)`; return x; };
        const old = $('.cmp-col.old', el), nu = $('.cmp-col.new', el);
        slide(old, .3, pt ? 60 : -80);
        $$('.cmp-item', old).forEach((it, i) => fadeUp(it, t, .5 + i * .16, .4, 14));
        const b = .55 + nl * .16;
        slide(nu, b, pt ? 60 : 80);
        $$('.cmp-item', nu).forEach((it, i) => fadeUp(it, t, b + .2 + i * .16, .4, 14));
        const done = b + .25 + s.right.items.length * .16;
        const pop = E.outBack(prog(t, done, done + .5));
        nu.style.boxShadow = `0 0 ${60 * pop}px ${tint(C().accent2, 22 * pop)}`;
        nu.style.borderColor = tint(C().accent2, 20 + 40 * pop);
      },
    },

    steps: {
      build: s => `${head(s)}<div class="stp" style="--n:${s.steps.length}"><i class="stp-line"><i></i></i>${s.steps.map((st, i) =>
        `<div class="st"><span class="num">${i + 1}</span><span class="txt"><b>${markup(st.title)}</b>${st.sub ? `<small>${markup(st.sub)}</small>` : ''}</span></div>`).join('')}</div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const n = s.steps.length, step = Math.min(.5, (d - 1.6) / n), a0 = .45;
        const fill = $('.stp-line > i', el), lp = E.inOutCubic(prog(t, a0, a0 + (n - 1) * step));
        fill.style.transform = portrait() ? `scaleY(${lp})` : `scaleX(${lp})`;
        $$('.st', el).forEach((st, i) => {
          const a = a0 + i * step;
          popIn($('.num', st), t, a, .45, .4);
          fadeUp($('.txt', st), t, a + .1, .45, 18);
        });
      },
    },

    notify: {
      build: s => `${head(s)}<div class="nt">${s.items.map(it => {
        const ic = it.icon ? `<span class="app" style="background:${tint(C().accent, 18)}">${icon(it.icon, it.color || C().accent, 40)}</span>` : `<span class="app brand">${brandTile()}</span>`;
        return `<div class="toast">${ic}<span class="body"><span class="top"><b>${markup(it.title)}</b><i>${window.Kit.esc(it.time || 'now')}</i></span><span class="msg">${markup(it.text)}</span></span></div>`;
      }).join('')}</div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const step = Math.min(.45, (d - 1.5) / s.items.length);
        $$('.toast', el).forEach((to, i) => {
          const a = .45 + i * step, x = E.outBack(prog(t, a, a + .45));
          to.style.opacity = prog(t, a, a + .15);
          to.style.transform = `translateY(${(1 - x) * -50}px) scale(${lerp(.9, 1, x)})`;
        });
      },
    },

    spotlight: {
      build: s => {
        const ph = 'linear-gradient(135deg, hsl(200 55% 40%), hsl(280 50% 22%))';
        return `<div class="sp-bg" style="background:${s.image ? `url('${window.Kit.src(s.image)}') center/cover` : ph}"></div><div class="sp-dim"></div>
        <div class="sp-card">${s.image ? `${window.Kit.img(s.image)}` : `<div class="img" style="background:${ph}"></div>`}${s.tag ? `<div class="sp-tag"><span class="dot">${icon('play', C().accent, 26)}</span><span><b>${markup(s.tag.title)}</b>${s.tag.sub ? `<small>${markup(s.tag.sub)}</small>` : ''}</span></div>` : ''}</div>
        ${head(s)}`;
      },
      update(el, t, d) {
        const z = prog(t, 0, d);
        $('.sp-card img, .sp-card .img', el).style.transform = `scale(${lerp(1.06, 1.2, z)}) translate(${lerp(-1.5, 1.5, z)}%, ${lerp(1, -1, z)}%)`;
        const card = $('.sp-card', el), x = E.outQuint(prog(t, 0, .7));
        card.style.opacity = prog(t, 0, .25);
        card.style.transform = `translateY(${(1 - x) * 80}px) scale(${lerp(.94, 1, x)})`;
        const tag = $('.sp-tag', el);
        if (tag) { const y = E.outBack(prog(t, .55, 1.0)); tag.style.opacity = prog(t, .55, .7); tag.style.transform = `translateX(${(1 - y) * -60}px)`; }
        animHead(el, t, .3);
      },
    },

    quote: {
      build: s => `<div class="qt"><div class="qmark">&ldquo;</div><h2 data-split>${markup(s.quote)}</h2>
        <div class="who">${s.avatar ? `${window.Kit.img(s.avatar)}` : `<i class="monogram">${window.Kit.esc((s.name || '?')[0])}</i>`}<span><b>${markup(s.name || '')}</b>${s.handle ? `<small>${markup(s.handle)}</small>` : ''}</span></div></div>`,
      update(el, t, d, s) {
        popIn($('.qmark', el), t, .05, .5, .5);
        const nw = s.quote.split(/\s+/).length, step = Math.min(.06, 1.2 / nw);
        words(el, t, .2, step, .45);
        fadeUp($('.who', el), t, .3 + nw * step, .5, 20);
      },
    },

    cards: {
      build: s => `${head(s)}<div class="fc3">${s.cards.map((c, i) => {
        const col = accents()[i % 3];
        return `<div class="fc"><span class="ic" style="background:${tint(col, 16)}; border-color:${tint(col, 45)}">${icon(c.icon, col, 54)}</span><b>${markup(c.title)}</b>${c.sub ? `<small>${markup(c.sub)}</small>` : ''}</div>`;
      }).join('')}</div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const pt = portrait(), rot = [-3, 2, -1.5, 2.5];
        $$('.fc', el).forEach((c, i) => {
          const a = .4 + i * .12, x = E.outBack(prog(t, a, a + .6));
          const off = pt ? `translateY(${-(1 - x) * i * (c.offsetHeight + 40)}px)` : `translateX(${-(1 - x) * i * (c.offsetWidth + 40)}px)`;
          c.style.opacity = prog(t, .35, .55);
          c.style.transform = `${off} rotate(${lerp(rot[i % 4] * 3, rot[i % 4], x)}deg)`;
          c.style.zIndex = 10 - i;
        });
      },
    },

    greetings: {
      cues: (s, d) => { const n = s.words.length, end = grEnd(s, d);
        return Array.from({ length: n - 1 }, (_, i) => { const k = i + 1, p = 1 - Math.pow(1 - (k - .5) / (n - 1), 1 / 1.5);
          return { t: .05 + p * (end - .05), kind: 'type' }; }); },
      build: s => `<div class="gr">${label(s.label)}<div class="hello"></div>${s.line ? `<h2 data-split>${markup(s.line)}</h2>` : ''}</div>
        ${s.strip ? `<div class="strip">${window.Kit.esc(s.strip)}</div>` : ''}<div class="preload">${window.Kit.esc(s.words.join(' '))}</div>`,
      update(el, t, d, s) {
        fadeUp($('.gr > .label', el), t, .05);
        const n = s.words.length, end = grEnd(s, d); // hold = seconds the last word + line stay
        const gp = (1 - Math.pow(1 - prog(t, .05, end), 1.5)) * (n - 1), gi = Math.round(gp);
        const h = $('.hello', el), settle = prog(t, end - .05, end + .25);
        if (!h.dataset.fs) { // once: shrink the slot's font until the widest word fits the frame (fonts are loaded by then)
          h.textContent = widest(s.words); h.style.fontSize = ''; let fs = parseFloat(getComputedStyle(h).fontSize);
          const r = document.createRange(), wide = () => { r.selectNodeContents(h); return r.getBoundingClientRect().width > el.clientWidth - 80; };
          while (wide() && fs > 30) { fs *= .95; h.style.fontSize = `${fs}px`; }
          if (document.fonts.status === 'loaded') h.dataset.fs = fs;
        }
        h.textContent = s.words[gi];
        h.style.opacity = prog(t, 0, .15);
        h.style.color = gi === n - 1 ? C().ink : `color-mix(in srgb, ${C().ink} 78%, ${C().bg})`;
        h.style.transform = `translateY(${settle >= 1 ? 0 : (gp - Math.floor(gp) - .5) * -16 * (1 - settle)}px)`;
        words(el, t, end - .2, .07, .55);
        const strip = $('.strip', el);
        if (strip) { strip.style.opacity = .9 * prog(t, .25, .75); strip.style.transform = portrait() ? 'none' : `translateX(${t * -30}px)`; }
      },
    },
  };
  // words: seconds the words get (the line holds for `hold` after them); a hold too long for the duration is cut so
  // every word still shows for at least .3 s
  function kwSpan(s, d) { return s.line ? d - Math.min(s.hold || 1.1, Math.max(.3, d - .3 * s.words.length)) : d - .4; }
  // greetings: when the cycle ends; a hold too long for the duration is cut so each word gets at least .2 s
  function grEnd(s, d) { return d - Math.min(s.hold || .75, Math.max(.3, d - .05 - .2 * s.words.length)); }
  // the word that sets the size of a cycling one-line slot (wide scripts count double)
  function widest(words) { const w = x => [...String(x)].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0); return words.reduce((a, b) => (w(b) > w(a) ? b : a), ''); }
})();
