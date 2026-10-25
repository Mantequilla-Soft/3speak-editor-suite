// Ten more shared scene types (both orientations), registered into window.KitScenes. Styles: lib/scenes-extra3.css.
// Load after lib/scenes-extra2.js and before Kit.run. Numbers in data must be real when the ad is real.
//
//   countdown   split-flap cards count down to the real value, one flip per step
//               { label?, lines[], units: [{ value, label }] (2-4), caption? }
//   poll        a poll card: bars fill to their share, counters run, the winner gets a check
//               { label?, lines[], question, options: [{ text, pct }] (2-4), winner? }
//   badge       a medal drops in on a ribbon, rays turn, a shine sweeps it, confetti bursts (seeded)
//               { label?, lines[], icon, title, sub? }
//   checklist   items tick off one by one (box fills, check draws), a progress bar fills
//               { label?, lines[], title?, items: [text] (3-6) }
//   search      a search box types the query, results drop in with the match highlighted
//               { label?, lines[], query, results: [{ title, sub?, icon? }] (2-4) }
//   calendar    a month grid; active days light up in a sweep, a streak counter runs
//               { label?, lines[], month, days, start (0 = Monday), active: [day numbers], streak? }
//   cube        a 3D cube turns face by face, a word (and optional image) on each face
//               { faces: [{ word ('|' = line break), image? }] (4), label?, line?, step? (a turn lands every step s, on the beat) }
//   podium      three columns rise (2nd, 1st, 3rd), avatars land on top, the winner gets a crown
//               { label?, lines[], places: [{ name, value?, avatar? }] (1st, 2nd, 3rd) }  (real people, with permission)
//   zoomReveal  starts deep inside a detail of an image and pulls back to the whole picture
//               { image, label?, lines[], from?: { x, y (%), zoom }, tag? }
//   kinetic     words slam in one at a time at different sizes and angles, then a line
//               { words: [text] (3-6), line?, step? (s between words, default .32; use the beat, e.g. .5 at 120 BPM) }
//   videoRow    three video cards drop in on the beat, shown WHOLE at 16:9 (no crop, no upscaling), a big word on each
//               { label?, lines[]?, items: [{ image, word, sub?, handle?, duration? }] (3), line? (under the cards), step? (s between cards, default .3) }
(function () {
  const { prog, lerp, clamp, E, $, $$, markup, words, fadeUp, popIn } = window.Reel;
  const icon = (...a) => window.Kit.icon(...a);
  const C = () => window.REEL.brand.colors;
  const B = () => window.REEL.brand;
  const portrait = () => window.REEL.height > window.REEL.width;
  const accents = () => [C().accent, C().accent2, C().accent3];
  const lines = (arr = [], tag = 'h1') => arr.map(l => `<${tag} data-split>${markup(l)}</${tag}>`).join('');
  const label = s => s ? `<div class="label">${markup(s)}</div>` : '';
  const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
  const head = (s, cls = '') => `<div class="xhead ${cls}">${label(s.label)}${lines(s.lines)}</div>`;
  const animHead = (el, t, at = .05) => { fadeUp($('.xhead .label', el), t, at, .4, 20); words($('.xhead', el), t, at + .05, .08, .5); };
  const ph = i => `linear-gradient(135deg, hsl(${(i * 47) % 360} 55% 42%), hsl(${(i * 47 + 60) % 360} 60% 22%))`;
  const imgOr = (src, i) => src ? `${window.Kit.img(src)}` : `<div class="ph" style="background:${ph(i)}"></div>`;
  const seeded = i => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const pad2 = v => String(v).padStart(2, '0');
  const FLIPS = 4, cdStep = (u, k) => .45 + u * .12 + k * .28; // countdown: unit u, flip k (1..FLIPS)

  Object.assign(window.KitScenes = window.KitScenes || {}, {
    countdown: {
      cues: s => s.units.flatMap((_, u) => Array.from({ length: FLIPS }, (_, k) => ({ t: cdStep(u, k + 1) + .12, kind: 'type', gain: -4 }))),
      build: s => `${head(s, 'cd-head')}<div class="cd">${s.units.map(u => `<div class="cd-u"><div class="cd-card">
          <div class="cd-half top"><span></span></div><div class="cd-half bot"><span></span></div>
          <div class="cd-flap up"><span></span></div><div class="cd-flap down"><span></span></div><i class="cd-hinge"></i></div>
          <small>${markup(u.label)}</small></div>`).join('')}</div>${s.caption ? `<div class="cd-cap" data-split>${markup(s.caption)}</div>` : ''}`,
      update(el, t, d, s) {
        animHead(el, t);
        $$('.cd-u', el).forEach((box, u) => {
          fadeUp(box, t, .15 + u * .1, .45, 30);
          const v = s.units[u].value, val = k => pad2(Math.max(0, v + FLIPS - k)); // k flips done -> value shown
          let done = 0; for (let k = 1; k <= FLIPS; k++) if (t >= cdStep(u, k)) done = k;
          const nextK = Math.min(FLIPS, done + 1), a = cdStep(u, nextK), p = done < FLIPS ? prog(t, a - .0001, a + .24) : 1;
          const cur = val(done), nxt = val(Math.min(FLIPS, done + 1)), flipping = done < FLIPS && t >= a;
          const set = (sel, txt) => { $(sel + ' span', box).textContent = txt; };
          set('.cd-half.top', flipping ? nxt : cur); set('.cd-half.bot', cur);
          set('.cd-flap.up', cur); set('.cd-flap.down', nxt);
          const up = $('.cd-flap.up', box), dn = $('.cd-flap.down', box);
          up.style.transform = `perspective(900px) rotateX(${flipping ? -Math.min(90, p * 180) : 0}deg)`; up.style.visibility = flipping && p < .5 ? 'visible' : 'hidden';
          dn.style.transform = `perspective(900px) rotateX(${flipping ? Math.max(0, 90 - (p - .5) * 180) : 0}deg)`; dn.style.visibility = flipping && p >= .5 ? 'visible' : 'hidden';
          if (flipping && p >= 1) set('.cd-half.bot', nxt);
        });
        const cap = $('.cd-cap', el); if (cap) words(cap, t, cdStep(s.units.length - 1, FLIPS) + .3, .06, .5);
      },
    },

    poll: {
      cues: s => [{ t: 1.75, kind: 'tick' }],
      build: s => `${head(s, 'pl-head')}<div class="pl"><div class="pl-q">${markup(s.question)}</div>${s.options.map((o, i) => `<div class="pl-o${i === (s.winner ?? -1) ? ' win' : ''}">
          <i class="pl-bar"></i><span class="pl-t">${markup(o.text)}</span><b class="pl-n">0%</b>${i === (s.winner ?? -1) ? `<span class="pl-ck">${icon('check', C().accent2, 34)}</span>` : ''}</div>`).join('')}</div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const card = $('.pl', el), k = E.outQuint(prog(t, .15, .7)); card.style.opacity = prog(t, .15, .3); card.style.transform = `translateY(${(1 - k) * 60}px)`;
        $$('.pl-o', el).forEach((o, i) => {
          fadeUp(o, t, .35 + i * .1, .35, 14);
          const f = E.outCubic(prog(t, .6 + i * .08, 1.6)), pct = s.options[i].pct;
          $('.pl-bar', o).style.width = `${pct * f}%`;
          $('.pl-n', o).textContent = `${Math.round(pct * f)}%`;
          const ck = $('.pl-ck', o); if (ck) popIn(ck, t, 1.7, .4, .3);
          if (i === s.winner) o.style.borderColor = tint(C().accent2, 70 * prog(t, 1.6, 1.9));
        });
      },
    },

    badge: {
      cues: () => [{ t: .5, kind: 'whoosh', gain: -5 }, { t: 1.05, kind: 'tick' }],
      build: s => `${head(s, 'bd-head')}<div class="bd"><div class="bd-rays">${Array.from({ length: 16 }, (_, i) => `<i style="transform:rotate(${i * 22.5}deg)"></i>`).join('')}</div>
          <div class="bd-rib"><i></i><i></i></div><div class="bd-medal"><div class="bd-in">${icon(s.icon || 'star', '#fff', portrait() ? 150 : 130)}</div><i class="bd-shine"></i></div>
          ${Array.from({ length: 36 }, (_, i) => `<i class="bd-cf" style="background:${accents()[i % 3]}"></i>`).join('')}
          <div class="bd-txt"><b>${markup(s.title)}</b>${s.sub ? `<small>${markup(s.sub)}</small>` : ''}</div></div>`,
      update(el, t, d) {
        animHead(el, t);
        const drop = E.outBack(prog(t, .3, .95));
        $('.bd-medal', el).style.transform = `translate(-50%, -50%) translateY(${(1 - drop) * -420}px) rotate(${(1 - drop) * -25}deg)`;
        $('.bd-medal', el).style.opacity = prog(t, .3, .4);
        $('.bd-rib', el).style.transform = `translateX(-50%) scaleY(${E.outCubic(prog(t, .2, .8))})`;
        const rays = $('.bd-rays', el); rays.style.opacity = .55 * prog(t, .9, 1.3); rays.style.transform = `translate(-50%, -50%) rotate(${t * 18}deg) scale(${lerp(.6, 1, E.outCubic(prog(t, .9, 1.4)))})`;
        $('.bd-shine', el).style.transform = `translateX(${lerp(-160, 160, prog(t, 1.2, 1.8))}%) rotate(25deg)`;
        $$('.bd-cf', el).forEach((c, i) => {
          const a = 1.0, u = t - a; if (u < 0) { c.style.opacity = 0; return; }
          const ang = seeded(i) * Math.PI * 2, sp = 500 + seeded(i + 40) * 700;
          const x = Math.cos(ang) * sp * u, y = Math.sin(ang) * sp * u * .8 + 700 * u * u;
          c.style.opacity = 1 - prog(u, 1.1, 1.8);
          c.style.transform = `translate(${x}px, ${y}px) rotate(${u * (300 + seeded(i + 9) * 500)}deg)`;
        });
        fadeUp($('.bd-txt', el), t, 1.1, .45, 20);
      },
    },

    checklist: {
      cues: s => s.items.map((_, i) => ({ t: .75 + i * .32 + .2, kind: 'click' })),
      build: s => `${head(s, 'ck-head')}<div class="ck">${s.title ? `<div class="ck-title">${markup(s.title)}<span class="ck-count">0/${s.items.length}</span></div>` : ''}
          ${s.items.map(it => `<div class="ck-it"><span class="ck-box"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" pathLength="1"/></svg></span><span class="ck-t">${markup(it)}</span></div>`).join('')}
          <div class="ck-prog"><i></i></div></div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const card = $('.ck', el), k = E.outQuint(prog(t, .15, .7)); card.style.opacity = prog(t, .15, .3); card.style.transform = `translateY(${(1 - k) * 50}px)`;
        let done = 0;
        $$('.ck-it', el).forEach((it, i) => {
          const a = .75 + i * .32, f = prog(t, a, a + .18), c = E.outCubic(prog(t, a + .1, a + .35));
          fadeUp(it, t, .3 + i * .06, .35, 12);
          $('.ck-box', it).style.background = tint(C().accent2, 100 * f);
          $('.ck-box', it).style.borderColor = f > .2 ? C().accent2 : 'rgba(255,255,255,.3)';
          $('.ck-box path', it).style.strokeDasharray = `${c} 1`;
          $('.ck-t', it).style.color = f > .5 ? C().ink : 'rgba(255,255,255,.62)';
          if (t >= a + .2) done = i + 1;
        });
        const cnt = $('.ck-count', el); if (cnt) cnt.textContent = `${done}/${s.items.length}`;
        $('.ck-prog > i', el).style.transform = `scaleX(${E.outCubic(prog(t, .75, .75 + s.items.length * .32 + .1))})`;
      },
    },

    search: {
      cues: s => [...Array.from({ length: Math.ceil(s.query.length / 3) }, (_, i) => ({ t: .55 + i * .12, kind: 'type', gain: -3 })), { t: srAt(s) + .05, kind: 'swish', gain: -6 }],
      build: s => `${head(s, 'sr-head')}<div class="sr"><div class="sr-box">${icon('eye', C().mute, portrait() ? 40 : 34).replace('<svg', '<svg class="sr-ic"')}<span class="sr-q"></span><i class="sr-caret"></i></div>
          <div class="sr-res">${s.results.map((r, i) => `<div class="sr-r"><span class="ic" style="background:${tint(accents()[i % 3], 16)}">${icon(r.icon || 'play', accents()[i % 3], 32)}</span>
            <span><b>${hl(r.title, s.query)}</b>${r.sub ? `<small>${markup(r.sub)}</small>` : ''}</span></div>`).join('')}</div></div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const box = $('.sr', el), k = E.outQuint(prog(t, .1, .6)); box.style.opacity = prog(t, .1, .25); box.style.transform = `translateY(${(1 - k) * 40}px)`;
        const n = Math.round(s.query.length * prog(t, .5, .5 + s.query.length * .045));
        $('.sr-q', el).textContent = s.query.slice(0, n);
        $('.sr-caret', el).style.opacity = n < s.query.length || Math.sin(t * 10) > 0 ? 1 : 0;
        const at = srAt(s), res = $('.sr-res', el);
        res.style.clipPath = `inset(0 0 ${(1 - E.outCubic(prog(t, at, at + .4))) * 100}% 0 round 0 0 28px 28px)`;
        $$('.sr-r', el).forEach((r, i) => fadeUp(r, t, at + .1 + i * .1, .35, 12));
      },
    },

    calendar: {
      cues: s => [{ t: .6, kind: 'swish', gain: -8 }, { t: 2.1, kind: 'tick' }],
      build: s => {
        const cells = Array.from({ length: s.start || 0 }, () => '<i class="cl-d empty"></i>').join('') +
          Array.from({ length: s.days }, (_, i) => `<i class="cl-d${(s.active || []).includes(i + 1) ? ' on' : ''}"><span>${i + 1}</span></i>`).join('');
        return `${head(s, 'cl-head')}<div class="cl"><div class="cl-top"><b>${markup(s.month)}</b>${s.streak ? `<span class="cl-st">${icon('spark', C().accent, 30)}<em>0</em> ${markup(s.streak)}</span>` : ''}</div>
          <div class="cl-wk">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(x => `<i>${x}</i>`).join('')}</div><div class="cl-grid">${cells}</div></div>`;
      },
      update(el, t, d, s) {
        animHead(el, t);
        const card = $('.cl', el), k = E.outQuint(prog(t, .1, .6)); card.style.opacity = prog(t, .1, .25); card.style.transform = `translateY(${(1 - k) * 50}px)`;
        const on = $$('.cl-d.on', el), n = on.length;
        $$('.cl-d', el).forEach((c, i) => { c.style.opacity = prog(t, .2 + i * .008, .4 + i * .008); });
        on.forEach((c, i) => { const a = .6 + i * (1.4 / Math.max(1, n)), f = E.outBack(prog(t, a, a + .3));
          c.style.background = tint(C().accent, 100 * prog(t, a, a + .15)); c.style.transform = `scale(${t >= a ? lerp(.7, 1, f) : 1})`; });
        const st = $('.cl-st em', el); if (st) st.textContent = Math.round(longestRun(s.active || []) * prog(t, .6, 2.0));
      },
    },

    cube: {
      cues: (s, d) => s.faces.slice(1).map((_, i) => ({ t: cbAt(i + 1, d, s.step) - .3, kind: 'swish', gain: -5 })),
      build: s => `<div class="cb-wrap">${label(s.label)}<div class="cb">${s.faces.slice(0, 4).map((f, i) => `<div class="cb-f f${i}">${f.image ? `<div class="cb-img">${imgOr(f.image, i)}</div>` : ''}<b style="font-size:${cbFont(f.word)}px">${markup(f.word).replace(/\|/g, '<br>')}</b></div>`).join('')}</div>
        ${s.line ? `<div class="cb-line" data-split>${markup(s.line)}</div>` : ''}</div>`,
      update(el, t, d, s) {
        fadeUp($('.cb-wrap > .label', el), t, .05, .4, 20);
        const n = Math.min(4, s.faces.length); let rot = 0;
        for (let i = 1; i < n; i++) { const e = cbAt(i, d, s.step); rot += E.inOutCubic(prog(t, e - Math.min(.5, (s.step ? Math.min(s.step, (d - 1) / 3) : 1) * .75), e)) * 90; }
        const k = E.outBack(prog(t, .05, .6));
        $('.cb', el).style.transform = `translateZ(calc(var(--cb) / -2)) rotateX(${-8 + Math.sin(t * 1.2) * 3}deg) rotateY(${-rot}deg) scale(${lerp(.7, 1, k)})`;
        $('.cb', el).style.opacity = prog(t, .05, .2);
        const ln = $('.cb-line', el); if (ln) words(ln, t, d - 1.2, .06, .5);
      },
    },

    podium: {
      cues: () => [0, 1, 2].map(i => ({ t: .5 + i * .25, kind: 'click' })).concat([{ t: 1.6, kind: 'tick' }]),
      build: s => `${head(s, 'pd-head')}<div class="pd">${[1, 0, 2].map(i => { const p = s.places[i] || {}; return `<div class="pd-c p${i}">
          <div class="pd-who">${i === 0 ? `<span class="pd-crown">${icon('star', '#f6c945', portrait() ? 56 : 48)}</span>` : ''}<span class="pd-av">${p.avatar ? `${window.Kit.img(p.avatar)}` : markup((p.name || '?').replace('@', '')[0].toUpperCase())}</span>
            <b>${markup(p.name || '')}</b>${p.value ? `<small>${markup(p.value)}</small>` : ''}</div>
          <div class="pd-col" style="background:linear-gradient(180deg, ${tint(accents()[i], 60)}, ${tint(accents()[i], 15)})"><em>${i + 1}</em></div></div>`; }).join('')}</div>`,
      update(el, t, d) {
        animHead(el, t);
        $$('.pd-c', el).forEach((c, j) => {
          const i = [1, 0, 2][j], a = .4 + [1, 2, 0][j] * .25; // 3rd, 2nd, then 1st
          const col = $('.pd-col', c); col.style.transform = `scaleY(${E.outCubic(prog(t, a, a + .5))})`;
          const who = $('.pd-who', c), k = E.outBack(prog(t, a + .4, a + .8));
          who.style.opacity = prog(t, a + .4, a + .5); who.style.transform = `translateY(${(1 - k) * -60}px)`;
          const cr = $('.pd-crown', c); if (cr) { const ck = E.outBack(prog(t, 1.55, 1.95)); cr.style.opacity = prog(t, 1.55, 1.65); cr.style.transform = `translateX(-50%) rotate(${(1 - ck) * -40 + Math.sin(t * 3) * 4}deg) scale(${ck})`; }
        });
      },
    },

    zoomReveal: {
      cues: () => [{ t: .35, kind: 'whoosh', gain: -4 }],
      build: s => `<div class="zr"><div class="zr-frame">${imgOr(s.image, 2)}</div></div>${s.tag ? `<span class="zr-tag">${markup(s.tag)}</span>` : ''}
        <div class="xhead zr-head">${label(s.label)}${lines(s.lines)}</div>`,
      update(el, t, d, s) {
        const f = s.from || { x: 50, y: 50, zoom: 4 }, k = E.inOutCubic(prog(t, .2, 1.6));
        const fr = $('.zr-frame', el), z = lerp(Math.max(1, Math.min(12, +f.zoom || 4)), 1, k);
        fr.style.transformOrigin = `${Number.isFinite(+f.x) ? +f.x : 50}% ${Number.isFinite(+f.y) ? +f.y : 50}%`;
        fr.style.transform = `scale(${z})`;
        fr.style.borderRadius = `${lerp(0, 28, k)}px`;
        $('.zr', el).style.transform = `scale(${lerp(1, portrait() ? .7 : .58, E.inOutCubic(prog(t, 1.3, 2.1)))})`;
        const tag = $('.zr-tag', el); if (tag) popIn(tag, t, 2.0, .4, .6);
        fadeUp($('.zr-head .label', el), t, 1.8, .4, 20); words($('.zr-head', el), t, 1.85, .08, .5);
      },
    },

    kinetic: {
      cues: (s, d) => s.words.map((_, i) => ({ t: .05 + i * knStep(s, d) + .1, kind: 'hit' })), // a punch as each word slams (lands ~.1 s in)
      build: s => `<div class="kn">${s.words.slice(0, 6).map((w, i) => `<b class="kn-w k${i}">${markup(w)}</b>`).join('')}</div>${s.line ? `<div class="kn-line" data-split>${markup(s.line)}</div>` : ''}`,
      update(el, t, d, s) {
        const L = portrait() ? KN_P : KN_L, n = Math.min(6, s.words.length);
        $$('.kn-w', el).forEach((w, i) => {
          const [x, y, size, rot, acc] = L[i], st = knStep(s, d), a = .05 + i * st, k = E.outBack(prog(t, a, a + .3)), shake = Math.sin((t - a) * 60) * 8 * (1 - prog(t, a + .25, a + .5)) * (t > a + .2 ? 1 : 0);
          if (!w.dataset.k) { // once fonts are in: shrink a word that would leave the frame at this size
            w.style.fontSize = `${size}px`; const room = 2 * Math.min(x, 100 - x) / 100 * el.clientWidth - 60, ww = w.offsetWidth;
            const k = ww > room ? room / ww : 1; if (document.fonts.status === 'loaded') w.dataset.k = k; else w.dataset.kTmp = k;
          }
          w.style.left = `${x}%`; w.style.top = `${y}%`; w.style.fontSize = `${size * +(w.dataset.k || w.dataset.kTmp || 1)}px`; w.style.color = acc ? C().accent : C().ink;
          w.style.opacity = prog(t, a, a + .06) * (i < n - 1 ? lerp(1, .5, prog(t, a + .45, a + .9)) : 1);
          w.style.transform = `translate(-50%, -50%) translate(${shake}px, ${-shake / 2}px) rotate(${rot}deg) scale(${lerp(2.4, 1, k)})`;
        });
        const ln = $('.kn-line', el); if (ln) { const a = .05 + (n - 1) * knStep(s, d) + .35; /* right after the last word lands */ popIn(ln, t, a, .45, .85); words(ln, t, a + .08, .06, .45); }
      },
    },
  });
  // [x %, y %, font px, rotation deg, accent] per word slot
  const KN_L = [[30, 28, 190, -6, 0], [70, 36, 150, 5, 1], [38, 56, 230, 3, 0], [76, 66, 130, -8, 0], [22, 72, 120, 6, 1], [60, 15, 110, -3, 0]]; // all above the line (top 880)
  const KN_P = [[40, 23, 190, -6, 0], [62, 34, 160, 6, 1], [46, 46, 230, 3, 0], [58, 57, 150, -7, 0], [38, 67, 140, 5, 1], [60, 13, 110, -3, 0]]; // all above the line (top 1430)
  function srAt(s) { return .5 + s.query.length * .045 + .25; }
  // cube words are sized by length: data-fit measures through the cube's 3D transforms and gets it wrong
  function cbFont(w) { const side = portrait() ? 700 : 640, len = Math.max(...String(w).replace(/[*_]/g, '').split('|').map(l => [...l].length)); return Math.min(150, Math.floor(side * .84 / (len * .62))); } // '|' = line break
  // kinetic: seconds between words; shortened when the last word + line (~1.3 s) would not fit the duration
  function knStep(s, d) { const n = s.words.length; return Math.max(.15, Math.min(s.step || .32, (d - 1.3) / Math.max(1, n - 1))); }
  function cbAt(i, d, step) { if (step) return i * Math.min(step, (d - 1) / 3); const n = 4, seg = (d - 1.4) / (n - 1); return .5 + i * seg; } // step: a turn lands every `step` s (on the beat)
  function hl(title, q) {
    title = String(title).replace(/[*_]/g, ''); // accent markup does not apply here (the query match is the accent)
    const i = title.toLowerCase().indexOf(String(q).toLowerCase());
    return i < 0 ? esc(title) : `${esc(title.slice(0, i))}<mark>${esc(title.slice(i, i + q.length))}</mark>${esc(title.slice(i + q.length))}`;
  }
  Object.assign(window.KitScenes, {
    videoRow: {
      cues: s => s.items.map((_, i) => ({ t: .12 + i * (s.step || .3), kind: 'swish', gain: -5 })),
      build: s => `${s.lines?.length ? head(s, 'vr-head') : (s.label ? `<div class="vr-lab">${label(s.label)}</div>` : '')}<div class="vr${s.lines?.length ? ' with-head' : ''}">${s.items.slice(0, 3).map((it, i) => `<div class="vr-it">
          <b class="vr-w" style="color:${i === 1 ? C().accent : C().ink}">${markup(it.word)}</b>
          <div class="vr-card">${imgOr(it.image, i)}<span class="vr-play">${icon('play', '#fff', portrait() ? 30 : 26)}</span>${it.duration ? `<span class="vr-dur">${markup(it.duration)}</span>` : ''}</div>
          <div class="vr-meta">${it.handle ? `<span class="vr-h">${markup(it.handle)}</span>` : ''}${it.sub ? `<small>${markup(it.sub)}</small>` : ''}</div></div>`).join('')}</div>
        ${s.line ? `<div class="vr-line" data-split>${markup(s.line)}</div>` : ''}`,
      update(el, t, d, s) {
        if (s.lines?.length) animHead(el, t); else fadeUp($('.vr-lab .label', el), t, .05, .4, 16);
        const st = s.step || .3;
        $$('.vr-it', el).forEach((it, i) => {
          const a = .05 + i * st, k = E.outBack(prog(t, a, a + .45));
          const card = $('.vr-card', it);
          card.style.opacity = prog(t, a, a + .1);
          card.style.transform = `translateY(${(1 - k) * 140}px) rotate(${(1 - k) * (i % 2 ? 6 : -6)}deg) scale(${lerp(.85, 1, k)})`;
          const w = $('.vr-w', it), wk = E.outBack(prog(t, a + .15, a + .5));
          w.style.opacity = prog(t, a + .15, a + .25); w.style.transform = `scale(${lerp(1.6, 1, wk)})`;
          fadeUp($('.vr-meta', it), t, a + .35, .35, 12);
          const im = $('.vr-card > img, .vr-card > .ph', it); if (im) im.style.transform = `scale(${lerp(1.08, 1, prog(t, a, d))})`;
        });
        const ln = $('.vr-line', el); if (ln) words(ln, t, .05 + (Math.min(3, s.items.length) - 1) * st + .45, .06, .45); // after the last card lands
      },
    },
  });
  // calendar streak: the longest run of consecutive day numbers
  function longestRun(days) { const d = [...new Set(days.map(Number))].sort((a, b) => a - b); let best = 0, run = 0;
    d.forEach((x, i) => { run = i && x === d[i - 1] + 1 ? run + 1 : 1; best = Math.max(best, run); }); return best; }
})();
