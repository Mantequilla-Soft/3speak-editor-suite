// The template-only scene types, ported into the shared library so ONE page (host/index.html) can play every type
// in either orientation:
//   from promo-16x9: logo, statement, product, wall (landscape), endcard (landscape)
//   from promo-9x16: hook, stat, phone, points, wall (portrait), endcard (portrait)
// wall and endcard keep both originals and pick by orientation. The templates still carry their own copies (their
// Kit.run(SCENES) wins on a name clash), so existing projects render exactly as before.
// CSS: lib/scenes-template.css (scoped by .landscape / .portrait and the scene class).
(function () {
  const { prog, lerp, E, $, $$, markup, words, fadeUp, popIn } = window.Reel;
  const { icon } = window.Kit;
  const B = () => window.REEL.brand, C = () => window.REEL.brand.colors;
  const portrait = () => window.REEL.height > window.REEL.width;
  const accents = () => [C().accent, C().accent2, C().accent3];
  const img = (spec, cls = '') => window.Kit.img(spec, cls);
  const logoHtml = cls => B().logo ? img(B().logo, cls) : `<div class="${cls} monogram">${window.Kit.esc(B().monogram || (B().name || '?')[0])}</div>`;
  const lines = (arr = [], tag = 'h1') => arr.map(l => `<${tag} data-split>${markup(l)}</${tag}>`).join('');
  const label = s => s ? `<div class="label">${markup(s)}</div>` : '';
  const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
  const ph = i => `<div class="ph" style="background:linear-gradient(135deg, hsl(${(i * 47) % 360} 55% 42%), hsl(${(i * 47 + 60) % 360} 60% 22%))"></div>`;
  // a chip pinned at x may grow to the frame's right edge (minus a margin); scenes-fit.css shrinks longer text
  const chipRoom = x => (portrait() ? 1080 : 1920) - x - 50;
  const thumb = (imgs, i) => imgs?.length ? img(imgs[i % imgs.length]) : ph(i);
  const esc = s => window.Kit.esc(s);
  // pick an implementation by orientation (both carry build + update; cues/hideBug/exitPush are read from the pair)
  const byOrientation = (land, port) => ({
    build: (s, b) => (portrait() ? port : land).build(s, b),
    update: (el, t, d, s) => (portrait() ? port : land).update(el, t, d, s),
    cues: (s, d) => ((portrait() ? port : land).cues || (() => []))(s, d),
    get hideBug() { return !!(portrait() ? port : land).hideBug; },
    get exitPush() { return (portrait() ? port : land).exitPush; },
  });

  // ---------- from promo-16x9 ----------
  const logo = {
    build: s => `
      <div class="logoWrap">
        <svg class="rings" viewBox="0 0 420 420">
          ${[196, 178, 162].map((r, i) => `<circle cx="210" cy="210" r="${r}" fill="none" stroke="${accents()[i]}" stroke-width="${5 - i}" stroke-linecap="round"/>`).join('')}
        </svg>
        ${logoHtml('mark')}
      </div>
      <div class="wordmark">${[...(s.wordmark || B().wordmark || (B().name || '').toUpperCase())].map(c => `<span>${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('')}</div>`,
    exitPush: 1.25,
    update(el, t) {
      const m = $('.mark', el);
      m.style.opacity = prog(t, .1, .4);
      m.style.transform = `translate(-50%, -50%) scale(${lerp(.4, 1, E.outBack(prog(t, .1, .9)))}) rotate(${(1 - E.outCubic(prog(t, .1, 1))) * -25}deg)`;
      $$('circle', el).forEach((c, i) => {
        const r = +c.getAttribute('r'), a = .25 + i * .15, x = E.inOutCubic(prog(t, a, a + 1));
        c.setAttribute('stroke-dasharray', `${2 * Math.PI * r * x * .82} ${2 * Math.PI * r}`);
        c.setAttribute('transform', `rotate(${[-90, 30, 150][i] + t * 40 + x * 120} 210 210)`);
        c.style.opacity = prog(t, a, a + .15);
      });
      $$('.wordmark span', el).forEach((s, i) => fadeUp(s, t, .9 + i * .06, .5, 30));
    },
  };

  const statement = {
    build: s => `<div class="copy">${label(s.label)}${lines(s.lines)}</div>`,
    update(el, t) {
      fadeUp($('.label', el), t, .05);
      words(el, t, .1, .085, .6);
    },
  };

  const wallLand = {
    build(s) {
      const imgs = s.images?.length ? s.images : null, hot = s.highlight || [];
      const tiles = Array.from({ length: 24 }, (_, i) => {
        const inner = imgs ? img(imgs[i % imgs.length])
          : `<div class="ph" style="background:linear-gradient(135deg, hsl(${(i * 47) % 360} 55% 42%), hsl(${(i * 47 + 60) % 360} 60% 22%))"><span>${String(i + 1).padStart(2, '0')}</span></div>`;
        const badge = hot.includes(i) ? `<span class="play">${icon('play', C().accent, 20)}</span>` : '';
        return `<div class="card${hot.includes(i) ? ' hot' : ''}">${inner}${badge}</div>`;
      }).join('');
      return `<div class="wallPersp"><div class="wall">${tiles}</div></div><div class="shade"></div>
        <div class="copy">${label(s.label)}${lines(s.lines)}
          <div class="topics">${(s.chips || []).map(c => `<span class="topic">${markup(c)}</span>`).join('')}</div></div>`;
    },
    update(el, t, d, s) {
      const pan = E.inOutCubic(prog(t, 0, d)), hot = s.highlight || [];
      $('.wall', el).style.transform = `translateX(${lerp(260, -60, pan)}px) translateY(${lerp(60, -40, pan)}px) rotateX(32deg) rotateZ(-14deg) scale(${lerp(1.18, 1.3, pan)})`;
      $$('.card', el).forEach((c, i) => {
        const col = i % 6, row = Math.floor(i / 6), a = .05 + (5 - col + row) * .045;
        const x = E.outCubic(prog(t, a, a + .7));
        const k = hot.indexOf(i), lift = k >= 0 ? E.outBack(prog(t, 1.35 + k * .35, 1.95 + k * .35)) * 70 : 0;
        c.style.opacity = x;
        c.style.transform = `translateZ(${lerp(-260, 0, x) + lift}px) scale(${lerp(.86, 1, x)})`;
      });
      fadeUp($('.label', el), t, .25);
      words($('.copy', el), t, .35, .11, .6);
      $$('.topic', el).forEach((c, i) => fadeUp(c, t, 1.45 + i * .1, .45, 18));
    },
  };

  const product = {
    build(s) {
      const shot = s.screenshot ? img(s.screenshot, 'shot')
        : `<div class="mock"><div class="mnav"></div><div class="mgrid">${Array.from({ length: 8 }, (_, i) => `<div class="mcard"><i style="background:linear-gradient(135deg, hsl(${(i * 47) % 360} 45% 40%), hsl(${(i * 47 + 60) % 360} 50% 20%))"></i><b></b><b class="s"></b></div>`).join('')}</div></div>`;
      const slots = portrait()
        ? [{ left: 60, top: 1060 }, { left: 520, top: 1190 }, { left: 90, top: 1320 }, { left: 540, top: 1440 }] // all above the 1560 safe line
        : [{ left: 1440, top: 110 }, { left: 1560, top: 470 }, { left: 1180, top: 830 }, { left: 900, top: 60 }];
      const chips = (s.features || []).slice(0, 4).map((f, i) => {
        const c = accents()[i % 3];
        return `<div class="chip" style="left:${slots[i].left}px; top:${slots[i].top}px; max-width:${chipRoom(slots[i].left)}px">
          <span class="ic" style="background:${tint(c, 16)}">${icon(f.icon, c, portrait() ? 40 : 28)}</span>
          <span>${markup(f.title)}<small>${markup(f.sub || '')}</small></span></div>`;
      }).join('');
      return `<div class="browserPersp"><div class="browser"><div class="bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i><div class="url">${esc(s.url || '')}</div></div>${shot}</div></div>
        ${chips}
        <div class="copy">${label(s.label)}${lines(s.lines)}${s.sub ? `<h1 data-split class="sub">${markup(s.sub)}</h1>` : ''}</div>`;
    },
    update(el, t, d) {
      const bIn = E.outQuint(prog(t, 0, .9)), drift = prog(t, 0, d), b = $('.browser', el);
      b.style.opacity = prog(t, 0, .35);
      b.style.transform = portrait()
        ? `translateY(${(1 - bIn) * 320}px) rotateX(${lerp(18, 8, bIn) - drift * 3}deg) scale(${lerp(.92, 1, bIn) + drift * .03})`
        : `translateX(${(1 - bIn) * 420}px) rotateY(${lerp(-34, -16, bIn) + drift * 5}deg) rotateX(${lerp(10, 5, bIn)}deg) scale(${lerp(.92, 1, bIn) + drift * .03})`;
      $$('.chip', el).forEach((c, i) => {
        const a = .75 + i * .25, x = E.outBack(prog(t, a, a + .5));
        c.style.opacity = prog(t, a, a + .2);
        c.style.transform = `translateY(${(1 - x) * 40 + Math.sin((t + i) * 1.6) * 6}px) scale(${lerp(.8, 1, x)})`;
      });
      fadeUp($('.label', el), t, .25);
      words($('.copy', el), t, .35, .1, .6);
    },
  };

  const endLand = {
    cues: () => [{ t: .85, kind: 'tick' }],
    hideBug: true,
    build: s => `<div class="center">${logoHtml('mark')}<div class="brand" data-fit>${markup(s.brand || B().name)}</div>
        ${s.tagline ? `<div class="tag">${markup(s.tagline)}</div>` : ''}
        ${s.cta ? `<div class="cta">${markup(s.cta)} ${icon('arrow', C().accent, 38)}</div>` : ''}</div>
      ${s.footer ? `<div class="foot label">${markup(s.footer)}</div>` : ''}`,
    exitPush: 1,
    update(el, t) {
      const m = $('.mark', el);
      m.style.opacity = prog(t, .05, .25);
      m.style.transform = `scale(${lerp(.5, 1, E.outBack(prog(t, .05, .65)))})`;
      fadeUp($('.brand', el), t, .2, .5, 30);
      fadeUp($('.tag', el), t, .4, .5, 24);
      const cta = $('.cta', el);
      if (cta) { popIn(cta, t, .65, .5, .85); cta.style.boxShadow = `0 0 ${20 + Math.sin(t * 6) * 10}px color-mix(in srgb, ${C().accent} ${25 * prog(t, 1.05, 1.35)}%, transparent)`; }
      fadeUp($('.foot', el), t, .95, .5, 12);
    },
  };

  // ---------- from promo-9x16 ----------
  const hook = {
    build(s) {
      const row = k => `<div class="row">${Array.from({ length: 12 }, (_, i) => {
        const n = i + k * 5;
        return `<div class="tile">${thumb(s.images, n)}${s.badge && n % 3 === 1 ? `<span class="badge">${markup(s.badge)}</span>` : ''}</div>`;
      }).join('')}</div>`;
      const hs = Math.max(40, Math.min(240, +s.size || (portrait() ? 158 : 150)));
      return `<div class="copy" style="--hs:${hs}px">${label(s.label)}${lines(s.lines)}${s.sub ? `<p class="sub" data-split>${markup(s.sub)}</p>` : ''}</div>
        ${s.images?.length ? `<div class="marq">${row(0)}${row(1)}</div>` : ''}`;
    },
    update(el, t) {
      fadeUp($('.label', el), t, 0, .4, 20);
      words(el, t, .05, .075, .5);
      const m = $('.marq', el);
      if (m) {
        const x = E.outCubic(prog(t, .2, .9));
        m.style.opacity = x;
        m.style.transform = `translateY(${(1 - x) * 160}px) rotate(-8deg)`;
        const [r1, r2] = $$('.row', m);
        r1.style.transform = `translateX(${-260 - t * 70}px)`;
        r2.style.transform = `translateX(${-900 + t * 70}px)`;
      }
    },
  };

  const stat = {
    build: s => `<div class="center">${label(s.label)}
        <div class="ringWrap"><svg viewBox="0 0 700 700"><circle class="track" cx="350" cy="350" r="300"/><circle class="arc" cx="350" cy="350" r="300" stroke="${C().accent}"/></svg>
          <div class="num" style="${+s.size ? `font-size:${Math.max(60, Math.min(320, +s.size))}px` : ''}"><span class="pre">${esc(s.prefix || '')}</span><span class="val">0</span><span class="suf">${esc(s.suffix || '')}</span></div></div>
        ${s.caption ? `<h2 data-split>${markup(s.caption)}</h2>` : ''}</div>`,
    update(el, t, d, s) {
      fadeUp($('.label', el), t, 0, .4, 20);
      const x = E.outExpo(prog(t, .15, 1.6)), frac = Math.max(0, Math.min(1, s.ring ?? (+s.value || 0) / (s.max || 100)));
      const c = 2 * Math.PI * 300, arc = $('.arc', el);
      arc.setAttribute('stroke-dasharray', `${c * frac * x} ${c}`);
      const v = (+s.value || 0) * x, loc = window.Kit.locale(s.locale || window.REEL.locale);
      $('.val', el).textContent = loc ? v.toLocaleString(loc, { minimumFractionDigits: s.decimals || 0, maximumFractionDigits: s.decimals || 0 })
        : v.toLocaleString('en-US', { minimumFractionDigits: s.decimals || 0, maximumFractionDigits: s.decimals || 0 });
      popIn($('.num', el), t, .05, .6, .7);
      $('.ringWrap svg', el).style.transform = `rotate(${-90 + t * 8}deg)`;
      words(el, t, .75, .06, .5);
    },
  };

  const wallPort = {
    build(s) {
      const hot = s.highlight || [];
      const tiles = Array.from({ length: 28 }, (_, i) =>
        `<div class="card${hot.includes(i) ? ' hot' : ''}">${thumb(s.images, i)}${hot.includes(i) ? `<span class="play">${icon('play', C().accent, 26)}</span>` : ''}</div>`).join('');
      return `<div class="wallPersp"><div class="wall">${tiles}</div></div><div class="shade"></div>
        <div class="copy">${label(s.label)}${lines(s.lines)}<div class="topics">${(s.chips || []).map(c => `<span class="topic">${markup(c)}</span>`).join('')}</div></div>`;
    },
    update(el, t, d, s) {
      const pan = E.inOutCubic(prog(t, 0, d)), hot = s.highlight || [];
      $('.wall', el).style.transform = `translateY(${lerp(160, -140, pan)}px) rotateX(26deg) rotateZ(-12deg) scale(${lerp(1.22, 1.32, pan)})`;
      $$('.card', el).forEach((c, i) => {
        const col = i % 4, row = Math.floor(i / 4), a = (col + row) * .035;
        const x = E.outCubic(prog(t, a, a + .6));
        const k = hot.indexOf(i), lift = k >= 0 ? E.outBack(prog(t, .9 + k * .3, 1.5 + k * .3)) * 70 : 0;
        c.style.opacity = x;
        c.style.transform = `translateZ(${lerp(-240, 0, x) + lift}px) scale(${lerp(.86, 1, x)})`;
      });
      fadeUp($('.label', el), t, .15);
      words($('.copy', el), t, .2, .09, .55);
      $$('.topic', el).forEach((c, i) => fadeUp(c, t, 1.0 + i * .08, .4, 16));
    },
  };

  const phone = {
    build(s) {
      const screen = s.screenshot ? img(s.screenshot, 'shot')
        : `<div class="mock"><div class="mnav"></div>${Array.from({ length: 6 }, (_, i) => `<div class="mcard">${ph(i)}<b></b><b class="s"></b></div>`).join('')}</div>`;
      const dflt = portrait()
        ? [{ left: 40, top: 840 }, { left: 500, top: 1040 }, { left: 60, top: 1240 }, { left: 480, top: 1430 }] // all above the 1560 safe line
        : [{ left: 1130, top: 170 }, { left: 1290, top: 420 }, { left: 1150, top: 670 }, { left: 1310, top: 900 }];
      const slots = s.slots || dflt;
      const chips = (s.features || []).slice(0, 4).map((f, i) => {
        const c = accents()[i % 3], sl = slots[i] || dflt[i];
        return `<div class="chip" style="left:${+sl.left || 0}px; top:${+sl.top || 0}px; max-width:${chipRoom(+sl.left || 0)}px"><span class="ic" style="background:${tint(c, 16)}">${icon(f.icon, c, 40)}</span>
          <span>${markup(f.title)}${f.sub ? `<small>${markup(f.sub)}</small>` : ''}</span></div>`;
      }).join('');
      return `<div class="phonePersp"><div class="phone"><div class="screen">${screen}</div><i class="notch"></i></div></div>${chips}
        <div class="copy">${label(s.label)}${lines(s.lines)}</div>`;
    },
    update(el, t, d) {
      const pin = E.outQuint(prog(t, 0, .8)), drift = prog(t, 0, d), ph = $('.phone', el);
      ph.style.opacity = prog(t, 0, .3);
      ph.style.transform = `translateY(${(1 - pin) * 380 - drift * 40}px) rotateY(${lerp(-30, -12, pin) + drift * 6}deg) rotateX(${lerp(14, 6, pin)}deg) rotateZ(${lerp(4, 0, pin)}deg)`;
      $$('.chip', el).forEach((c, i) => {
        const a = .55 + i * .22, x = E.outBack(prog(t, a, a + .45));
        c.style.opacity = prog(t, a, a + .15);
        c.style.transform = `translateY(${(1 - x) * 40 + Math.sin((t + i) * 1.7) * 7}px) scale(${lerp(.75, 1, x)})`;
      });
      fadeUp($('.label', el), t, .05);
      words($('.copy', el), t, .1, .08, .5);
    },
  };

  const points = {
    build: s => `<div class="copy">${label(s.label)}${lines(s.lines)}</div>
      <div class="pts">${(s.points || []).slice(0, 4).map((p, i) => {
        const c = accents()[i % 3];
        return `<div class="pt"><span class="ic" style="background:${tint(c, 15)}; border-color:${tint(c, 45)}">${icon(p.icon, c, 56)}</span>
          <span><b>${markup(p.title)}</b>${p.sub ? `<small>${markup(p.sub)}</small>` : ''}</span></div>`;
      }).join('')}</div>`,
    update(el, t) {
      fadeUp($('.label', el), t, .05);
      words($('.copy', el), t, .1, .08, .5);
      $$('.pt', el).forEach((p, i) => {
        const a = .5 + i * .26, x = E.outQuint(prog(t, a, a + .55));
        p.style.opacity = prog(t, a, a + .25);
        p.style.transform = `translateX(${(1 - x) * -120}px)`;
        popIn($('.ic', p), t, a + .05, .5, .5);
      });
    },
  };

  const endPort = {
    cues: () => [{ t: .85, kind: 'tick' }],
    hideBug: true,
    exitPush: 1,
    build: s => `<div class="center">${logoHtml('mark')}<div class="brand" data-fit>${markup(s.brand || B().name)}</div>
        ${s.tagline ? `<div class="tag" data-split>${markup(s.tagline)}</div>` : ''}
        ${s.cta ? `<div class="cta">${markup(s.cta)} ${icon('arrow', C().accent, 52)}</div>` : ''}</div>
      ${s.footer ? `<div class="foot label">${markup(s.footer)}</div>` : ''}`,
    update(el, t) {
      const m = $('.mark', el);
      m.style.opacity = prog(t, 0, .2);
      m.style.transform = `scale(${lerp(.4, 1, E.outBack(prog(t, 0, .6)))}) rotate(${(1 - E.outCubic(prog(t, 0, .7))) * -20}deg)`;
      fadeUp($('.brand', el), t, .15, .5, 30);
      words(el, t, .35, .06, .5);
      const cta = $('.cta', el);
      if (cta) { popIn(cta, t, .7, .5, .8); cta.style.boxShadow = `0 0 ${24 + Math.sin(t * 6) * 12}px ${tint(C().accent, 30 * prog(t, 1.1, 1.4))}`; }
      fadeUp($('.foot', el), t, 1.0, .5, 12);
    },
  };

  Object.assign(window.KitScenes = window.KitScenes || {}, {
    logo, statement, product, hook, stat, phone, points,
    wall: byOrientation(wallLand, wallPort),
    endcard: byOrientation(endLand, endPort),
  });
})();
