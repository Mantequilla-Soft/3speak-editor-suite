// More shared scene types (both orientations), registered into window.KitScenes next to lib/scenes.js.
// Styles: lib/scenes-more.css. Load after lib/scenes.js and before Kit.run.
//
// OPENERS
//   heroSplit    photo on one half (slow zoom), headline on the other   { image, label?, lines[], sub? }
//   heroSlides   heroSplit, but the photo half is a carousel             { slides: [{ image, tag? }], label?, lines[], sub? } (3-5)
//   heroPoster   giant stacked words, alternating fill/outline/accent   { words[], label?, sub?, styles?: ['fill'|'out'|'acc'...] }
//   heroCollage  polaroid photos drop into a pile, headline beside it   { images[], label?, lines[], sub? }
// MIDDLE
//   carousel     coverflow cards that advance on their own              { label?, lines[], items: [{ image? | icon?, title, sub? }] }
//   bento        mixed-size tile grid (first tile big, can be a photo)  { label?, lines[], tiles: [{ image?, icon?, value?, title, sub? }] } (5)
//   chat         message bubbles with typing dots                       { label?, lines[], messages: [{ from: 'them'|'me', text, name?, avatar? }] }
//   stats        several numbers counting up at once                     { label?, lines[], items: [{ value, prefix?, suffix?, decimals?, label }] } (2-4)
//   marquee      giant text rows scrolling in opposite directions       { rows[], line?, label?, accentRow? }
//   wipe         before/after with a sweeping divider                   { label?, lines[], before: { title, text?, image? }, after: { ... } }
//   offer        price card: old price struck, badge, deadline           { label?, lines[], price, unit?, was?, badge?, until?, note? }
// CLOSERS (hide the corner brand mark)
//   endPhoto     full-bleed photo, logo, tagline, outline CTA            { image, tagline?, cta?, footer? }
//   endPoster    giant stacked words, logo, outline CTA                 { words[], cta?, footer?, styles? }
//   endSplit     photo on one half, logo + tagline + CTA on the other   { image, tagline?, cta?, footer? }
//   endMosaic    dimmed wall of thumbnails behind a glass CTA card      { images[], tagline?, cta?, footer? }
//   endMarquee   benefit words scrolling above and below a big CTA      { rows[] (2), tagline?, cta?, footer? }
// AUDIO / PRODUCT DEMOS
//   heroWave     live waveform with playhead under a headline (opener)   { label?, lines[], sub?, track?: { title, artist, cover? } }
//   endWave      live waveform behind logo, tagline and CTA (closer)    { tagline?, cta?, footer? }
//   walkthrough  a finger (portrait) or cursor (landscape) taps through real screens in a phone/browser frame
//                { label?, lines[], url?, steps: [{ image, tap?: [x%, y%], caption?, zoom?, origin?: [x%, y%] }] }
//                tap = where to press before the next screen; zoom eases in around origin (default: the tap point)
//   lockscreen   a phone shows the app, locks, and the lock screen keeps a "now playing" card going
//                { label?, lines[], from?: image, time?, date?, source?, title?, caption? }  (show only metadata the
//                site really sets: without the Media Session API the OS shows the site, not the track)
//   embedDemo    embed code types itself out, then real player images appear inside a blog-post mockup
//                { label?, lines[], code, embeds: [{ image, label? }], post?: { title }, site?: 'example.com' (frames the post as a web page) }
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
  const head = s => `<div class="xhead">${label(s.label)}${lines(s.lines)}</div>`;
  const animHead = (el, t, at = .05) => { fadeUp($('.xhead .label', el), t, at, .4, 20); words($('.xhead', el), t, at + .05, .08, .5); };
  const logo = cls => B().logo ? `${window.Kit.img(B().logo, cls)}` : `<div class="${cls} monogram">${window.Kit.esc(B().monogram || (B().name || '?')[0])}</div>`;
  const tagline = (s, cls) => (Array.isArray(s.tagline) ? s.tagline : [s.tagline || B().name]).map(l => `<div class="${cls}" data-split>${markup(l)}</div>`).join('');
  const cta = s => s.cta ? `<div class="xcta">${markup(s.cta)} ${icon('arrow', C().accent, portrait() ? 52 : 40)}</div>` : '';
  const ph = i => `linear-gradient(135deg, hsl(${(i * 47) % 360} 55% 42%), hsl(${(i * 47 + 60) % 360} 60% 22%))`;
  const imgOr = (src, i) => src ? `${window.Kit.img(src)}` : `<div class="ph" style="background:${ph(i)}"></div>`;
  // styles: 'fill' | 'acc' | 'soft' (dimmed fill; 'out' is an alias). No outline-only text: it reads badly.
const posterStyles = (s, i) => (s.styles || ['fill', 'acc'])[i % (s.styles || ['fill', 'acc']).length];
  const kenBurns = (img, t, d, from = 1.04, to = 1.16) => { if (img) img.style.transform = `scale(${lerp(from, to, prog(t, 0, d))})`; };
  const countUp = (el, t, a, it) => {
    const x = E.outExpo(prog(t, a, a + 1.3));
    const loc = it.locale || window.REEL.locale; // e.g. 'de-DE' -> 4,85 and 1.200
    el.textContent = loc ? (it.value * x).toLocaleString(loc, { minimumFractionDigits: it.decimals || 0, maximumFractionDigits: it.decimals || 0 })
      : (it.decimals ? (it.value * x).toFixed(it.decimals) : Math.round(it.value * x)).toLocaleString('en-US');
  };

  Object.assign(window.KitScenes = window.KitScenes || {}, {
    // ---------- openers ----------
    heroSplit: {
      build: s => `<div class="hs-img">${imgOr(s.image, 3)}</div><div class="hs-fade"></div>
        <div class="hs-copy">${label(s.label)}${lines(s.lines)}${s.sub ? `<p class="hs-sub" data-split>${markup(s.sub)}</p>` : ''}</div>`,
      update(el, t, d) {
        const box = $('.hs-img', el), x = E.outQuint(prog(t, 0, .8));
        box.style.clipPath = portrait() ? `inset(0 0 ${(1 - x) * 100}% 0)` : `inset(0 0 0 ${(1 - x) * 100}%)`;
        kenBurns($('.hs-img > *', el), t, d);
        fadeUp($('.hs-copy .label', el), t, .15, .4, 20);
        words($('.hs-copy', el), t, .2, .075, .5);
      },
    },

    // heroSplit's layout with a photo CAROUSEL in the image half: slides push in one after another, each with an
    // optional tag (e.g. the photographer's @handle), plus dots. Last slide holds for the final second.
    heroSlides: {
      build: s => `<div class="hs-img hsl">${s.slides.map(sl => `<div class="hsl-s">${imgOr(sl.image, 2)}
            ${sl.tag ? `<span class="hsl-tag">${markup(sl.tag)}</span>` : ''}</div>`).join('')}
          <div class="hsl-dots">${s.slides.map(() => '<i></i>').join('')}</div></div>
        <div class="hs-fade"></div>
        <div class="hs-copy">${label(s.label)}${lines(s.lines)}${s.sub ? `<p class="hs-sub" data-split>${markup(s.sub)}</p>` : ''}</div>`,
      cues: (s, d) => { const n = s.slides.length, a0 = 1.0, seg = (d - 1.0 - a0) / Math.max(1, n - 1);
        return Array.from({ length: n - 1 }, (_, k) => ({ t: a0 + (k + 1) * seg - .3, kind: 'swish', gain: -5 })); }, // as quiet as carousel slides
      update(el, t, d, s) {
        const box = $('.hs-img', el), x = E.outQuint(prog(t, 0, .8));
        box.style.clipPath = portrait() ? `inset(0 0 ${(1 - x) * 100}% 0)` : `inset(0 0 0 ${(1 - x) * 100}%)`;
        const n = s.slides.length, a0 = 1.0, seg = (d - 1.0 - a0) / Math.max(1, n - 1);
        let p = 0;
        for (let k = 1; k < n; k++) p += E.inOutCubic(prog(t, a0 + k * seg - .55, a0 + k * seg));
        $$('.hsl-s', el).forEach((sl, i) => {
          const o = i - p;
          sl.style.transform = `translateX(${o * 100}%)`;
          sl.style.visibility = Math.abs(o) >= 1 ? 'hidden' : 'visible';
          const shown = i === 0 ? 0 : a0 + i * seg - .55;
          const im = $('img, .ph', sl);
          if (im) im.style.transform = `translateX(${-o * 18}%) scale(${lerp(1.14, 1.03, prog(t, shown, shown + seg + .8))})`;
          const tag = $('.hsl-tag', sl);
          if (tag) fadeUp(tag, t, i === 0 ? .7 : a0 + i * seg - .1, .35, 14);
        });
        const act = Math.round(p);
        $$('.hsl-dots i', el).forEach((dot, i) => {
          dot.style.width = (i === act ? 40 : 12) + 'px';
          dot.style.background = i === act ? C().accent : 'rgba(255,255,255,.4)';
        });
        $('.hsl-dots', el).style.opacity = prog(t, .6, .9);
        fadeUp($('.hs-copy .label', el), t, .15, .4, 20);
        words($('.hs-copy', el), t, .2, .075, .5);
      },
    },

    heroPoster: {
      cues: s => s.words.map((_, i) => ({ t: .08 + i * .13, kind: 'click' })), // a click per stacked word
      build: s => `<div class="hp">${label(s.label)}${s.words.map((w, i) => `<div class="hp-w ${posterStyles(s, i)}" data-fit>${markup(w)}</div>`).join('')}
        ${s.sub ? `<p class="hp-sub" data-split>${markup(s.sub)}</p>` : ''}</div>`,
      update(el, t, d, s) {
        fadeUp($('.hp > .label', el), t, 0, .4, 20);
        $$('.hp-w', el).forEach((w, i) => {
          const x = E.outQuint(prog(t, .05 + i * .13, .6 + i * .13)), dir = i % 2 ? 1 : -1;
          w.style.opacity = prog(t, .05 + i * .13, .25 + i * .13);
          w.style.transform = `translateX(${dir * (1 - x) * 420}px) skewX(${dir * (1 - x) * -8}deg)`;
        });
        words($('.hp', el), t, .25 + s.words.length * .13, .06, .5);
      },
    },

    heroCollage: {
      build(s) {
        const imgs = (s.images || []).slice(0, 5);
        while (imgs.length < 5) imgs.push(null);
        return `<div class="hc">${imgs.map((src, i) => `<div class="pol p${i}">${imgOr(src, i)}</div>`).join('')}</div>
          <div class="hc-copy">${label(s.label)}${lines(s.lines)}${s.sub ? `<p class="hc-sub" data-split>${markup(s.sub)}</p>` : ''}</div>`;
      },
      update(el, t) {
        const pose = [[-170, -110, -9], [175, -150, 7], [-140, 130, 6], [170, 110, -6], [0, 0, 2]];
        $$('.pol', el).forEach((p, i) => {
          const [x, y, r] = pose[i], a = .05 + i * .16, k = E.outBack(prog(t, a, a + .5));
          p.style.opacity = prog(t, a, a + .12);
          p.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y - (1 - k) * 90}px)) rotate(${r + (1 - k) * r * 2}deg) scale(${lerp(1.35, 1, k)})`;
        });
        fadeUp($('.hc-copy .label', el), t, .55, .4, 20);
        words($('.hc-copy', el), t, .6, .075, .5);
      },
    },

    // ---------- middle ----------
    carousel: {
      cues: (s, d) => { const n = s.items.length, a0 = .55, seg = (d - a0 - .25) / n; return Array.from({ length: n - 1 }, (_, k) => ({ t: a0 + (k + 1) * seg - .25, kind: 'swish', gain: -5 })); },
      build: s => `${head(s)}<div class="car">${s.items.map((it, i) => {
          const col = accents()[i % 3];
          const top = it.image ? `<div class="car-img">${imgOr(it.image, i)}</div>`
            : `<div class="car-ic" style="background:${tint(col, 14)}">${icon(it.icon, col, portrait() ? 150 : 120)}</div>`;
          return `<div class="car-card">${top}<div class="car-txt"><b>${markup(it.title)}</b>${it.sub ? `<small>${markup(it.sub)}</small>` : ''}</div></div>`;
        }).join('')}<div class="car-dots">${s.items.map(() => '<i></i>').join('')}</div></div>`,
      update(el, t, d) {
        animHead(el, t);
        const cards = $$('.car-card', el), n = cards.length, a0 = .55, seg = (d - a0 - .25) / n;
        let p = 0;
        for (let k = 1; k < n; k++) p += E.inOutCubic(prog(t, a0 + k * seg - .5, a0 + k * seg));
        const intro = E.outQuint(prog(t, .25, .9)), spread = portrait() ? 560 : 600;
        cards.forEach((c, i) => {
          const o = i - p, ao = Math.abs(o);
          c.style.transform = `translateX(-50%) translateX(${o * spread + (1 - intro) * 300}px) translateZ(${-ao * 260}px) rotateY(${-clamp(o, -2, 2) * 24}deg) scale(${1 - Math.min(ao, 2) * .1})`;
          c.style.opacity = (ao > 2.4 ? 0 : 1 - Math.min(ao, 1.8) * .36) * intro;
          c.style.zIndex = 100 - Math.round(ao * 10);
        });
        const act = Math.round(p);
        $$('.car-dots i', el).forEach((dot, i) => { dot.style.width = (i === act ? 46 : 14) + 'px'; dot.style.background = i === act ? C().accent : 'rgba(255,255,255,.25)'; });
        $('.car-dots', el).style.opacity = intro;
      },
    },

    bento: {
      build: s => `${head(s)}<div class="bento">${s.tiles.slice(0, 5).map((tl, i) => {
          const col = accents()[i % 3];
          return `<div class="bt bt${i}${tl.image ? ' has-img' : ''}">${tl.image ? `<div class="bt-img">${imgOr(tl.image, i)}</div>` : ''}<div class="bt-in">
            ${tl.icon ? `<span class="ic" style="background:${tint(col, 16)}">${icon(tl.icon, col, 46)}</span>` : ''}
            ${tl.value ? `<div class="bt-val" style="color:${col}">${markup(tl.value)}</div>` : ''}
            <b>${markup(tl.title)}</b>${tl.sub ? `<small>${markup(tl.sub)}</small>` : ''}</div></div>`;
        }).join('')}</div>`,
      update(el, t, d) {
        animHead(el, t);
        $$('.bt', el).forEach((b, i) => {
          const a = .35 + i * .13, x = E.outBack(prog(t, a, a + .55));
          b.style.opacity = prog(t, a, a + .2);
          b.style.transform = `translateY(${(1 - x) * 50}px) scale(${lerp(.86, 1, x)})`;
          kenBurns($('.bt-img > *', b), t, d, 1.05, 1.15);
        });
      },
    },

    chat: {
      build: s => `${head(s)}<div class="chat">${s.messages.map(m => {
          const me = m.from === 'me';
          const av = me ? '' : `<span class="av">${m.avatar ? `${window.Kit.img(m.avatar)}` : markup((m.name || '?')[0])}</span>`;
          return `<div class="cm-msg ${me ? 'me' : 'them'}">${av}<div class="bub">${!me && m.name ? `<i>${markup(m.name)}</i>` : ''}${markup(m.text)}</div></div>`;
        }).join('')}<div class="typing"><i></i><i></i><i></i></div></div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const msgs = $$('.cm-msg', el), step = Math.min(.8, (d - 1.3) / msgs.length), ty = $('.typing', el);
        let typing = 0;
        msgs.forEach((m, i) => {
          const a = .5 + i * step, x = E.outBack(prog(t, a, a + .4));
          m.style.opacity = prog(t, a, a + .12);
          m.style.transform = `translateY(${(1 - x) * 30}px) scale(${lerp(.92, 1, x)})`;
          if (s.messages[i].from !== 'me' && t > a - .45 && t < a) { typing = 1; ty.style.top = m.offsetTop + 'px'; }
        });
        ty.style.opacity = typing;
        $$('.typing i', el).forEach((dot, i) => { dot.style.transform = `translateY(${Math.sin(t * 9 - i * .9) * -6}px)`; });
      },
    },

    stats: {
      build: s => `${head(s)}<div class="sts">${s.items.map((it, i) => `<div class="st1"><div class="v" style="color:${i === 0 ? C().accent : C().ink}">
          <span>${window.Kit.esc(it.prefix || '')}</span><span class="n">0</span><span class="suf">${window.Kit.esc(it.suffix || '')}</span></div>
          <i class="bar"><i style="background:${accents()[i % 3]}"></i></i><small>${markup(it.label)}</small></div>`).join('')}</div>`,
      update(el, t, d, s) {
        animHead(el, t);
        $$('.st1', el).forEach((row, i) => {
          const a = .35 + i * .22;
          fadeUp(row, t, a, .45, 24);
          countUp($('.n', row), t, a, s.items[i]);
          $('.bar > i', row).style.transform = `scaleX(${E.outQuint(prog(t, a + .1, a + 1))})`;
        });
      },
    },

    marquee: {
      build: s => `<div class="mq">${s.rows.map((r, i) => `<div class="mq-row ${i % 2 ? 'out' : ''} ${i === (s.accentRow ?? 1) ? 'acc' : ''}"><span>${Array.from({ length: 6 }, () => markup(r)).join('<em class="sep">&bull;</em>')}</span></div>`).join('')}</div>
        <div class="mq-front">${label(s.label)}${s.line ? `<div class="mq-line" data-split>${markup(s.line)}</div>` : ''}</div>`,
      update(el, t) {
        $$('.mq-row', el).forEach((r, i) => {
          const dir = i % 2 ? 1 : -1, x = E.outCubic(prog(t, i * .08, .6 + i * .08));
          r.style.opacity = x;
          $('span', r).style.transform = `translateX(${(dir > 0 ? -1400 : -200) + dir * t * 160 + dir * (1 - x) * -300}px)`;
        });
        const f = $('.mq-front', el);
        popIn(f, t, .45, .55, .8);
        words(f, t, .55, .07, .5);
      },
    },

    wipe: {
      cues: () => [{ t: 1.45, kind: 'whoosh' }],
      build(s) {
        const panel = (p, kind, i) => `<div class="wp-${kind}">${p.image ? imgOr(p.image, i) : `<div class="wp-txt"><b>${markup(p.title)}</b>${p.text ? `<small>${markup(p.text)}</small>` : ''}</div>`}
          <span class="wp-tag">${p.image ? markup(p.title) : (kind === 'before' ? 'Before' : 'After')}</span></div>`;
        return `${head(s)}<div class="wp">${panel(s.after, 'after', 2)}${panel(s.before, 'before', 5)}<i class="wp-line"><span>${icon('arrow', C().bg, 34)}</span></i></div>`;
      },
      update(el, t, d) {
        animHead(el, t);
        const box = $('.wp', el), x = E.outQuint(prog(t, .2, .8));
        box.style.opacity = prog(t, .2, .4);
        box.style.transform = `translateY(${(1 - x) * 60}px)`;
        const w = E.inOutCubic(prog(t, 1.0, 2.1)) * 100; // % of the before panel wiped away, right to left
        $('.wp-before', el).style.clipPath = `inset(0 ${w}% 0 0)`;
        const line = $('.wp-line', el);
        line.style.left = `${100 - w}%`;
        line.style.opacity = prog(t, .9, 1.05) * (1 - prog(t, 2.1, 2.4));
      },
    },

    offer: {
      cues: () => [{ t: 1.55, kind: 'tick' }],
      build: s => `${head(s)}<div class="of">
          ${s.badge ? `<div class="of-badge">${markup(s.badge)}</div>` : ''}
          ${s.was ? `<div class="of-was"><span>${markup(s.was)}</span><i></i></div>` : ''}
          <div class="of-price" data-fit>${markup(s.price)}</div>${s.unit ? `<div class="of-unit">${markup(s.unit)}</div>` : ''}
          ${s.until ? `<div class="of-until">${icon('clock', C().accent2, 34)}<span>${markup(s.until)}</span></div>` : ''}
          ${s.note ? `<div class="of-note">${markup(s.note)}</div>` : ''}</div>`,
      update(el, t) {
        animHead(el, t);
        const card = $('.of', el), x = E.outQuint(prog(t, .3, .9));
        card.style.opacity = prog(t, .3, .5);
        card.style.transform = `translateY(${(1 - x) * 70}px)`;
        const strike = $('.of-was i', el);
        if (strike) strike.style.transform = `scaleX(${E.inOutCubic(prog(t, .8, 1.15))})`;
        popIn($('.of-price', el), t, 1.1, .55, .7);
        fadeUp($('.of-unit', el), t, 1.3, .4, 14);
        const b = $('.of-badge', el);
        if (b) { const k = E.outBack(prog(t, 1.4, 1.9)); b.style.opacity = prog(t, 1.4, 1.55); b.style.transform = `rotate(${lerp(-40, 12, k) + Math.sin(t * 2) * 3}deg) scale(${lerp(.3, 1, k)})`; }
        fadeUp($('.of-until', el), t, 1.6, .45, 14);
        fadeUp($('.of-note', el), t, 1.8, .45, 14);
      },
    },

    // ---------- closers ----------
    endPhoto: {
      cues: () => [{ t: .95, kind: 'tick' }],
      hideBug: true,
      exitPush: 1,
      build: s => `<div class="ep-bg">${imgOr(s.image, 1)}</div><div class="ep-shade"></div>
        <div class="ep">${logo('mark')}${tagline(s, 'ep-tag')}${cta(s)}</div>
        ${s.footer ? `<div class="ep-foot label">${markup(s.footer)}</div>` : ''}`,
      update(el, t, d) {
        kenBurns($('.ep-bg > *', el), t, d, 1.15, 1.04);
        popIn($('.ep .mark', el), t, .1, .5, .6);
        words($('.ep', el), t, .25, .07, .5);
        const c = $('.xcta', el);
        if (c) { popIn(c, t, .75, .5, .8); c.style.boxShadow = `0 0 ${24 + Math.sin(t * 6) * 12}px ${tint(C().accent, 35 * prog(t, 1.1, 1.4))}`; }
        fadeUp($('.ep-foot', el), t, 1.0, .5, 12);
      },
    },

    endPoster: {
      cues: s => [...s.words.map((_, i) => ({ t: .13 + i * .12, kind: 'click' })), { t: .95, kind: 'tick' }],
      hideBug: true,
      exitPush: 1,
      build: s => `<div class="epo">${logo('mark')}${s.words.map((w, i) => `<div class="hp-w ${posterStyles(s, i)}" data-fit>${markup(w)}</div>`).join('')}${cta(s)}</div>
        ${s.footer ? `<div class="ep-foot label">${markup(s.footer)}</div>` : ''}`,
      update(el, t) {
        popIn($('.epo .mark', el), t, 0, .5, .6);
        $$('.hp-w', el).forEach((w, i) => {
          const x = E.outQuint(prog(t, .1 + i * .12, .6 + i * .12));
          w.style.opacity = prog(t, .1 + i * .12, .3 + i * .12);
          w.style.transform = `translateY(${(1 - x) * 80}px) scale(${lerp(1.15, 1, x)})`;
        });
        const c = $('.xcta', el);
        if (c) { popIn(c, t, .6, .5, .8); c.style.boxShadow = `0 0 ${24 + Math.sin(t * 6) * 12}px ${tint(C().accent, 35 * prog(t, 1.0, 1.3))}`; }
        fadeUp($('.ep-foot', el), t, .9, .5, 12);
      },
    },
  });

  // ---------- more closers ----------
  const glow = (el, t, a) => { const c = $('.xcta', el); if (c) { popIn(c, t, a, .5, .8); c.style.boxShadow = `0 0 ${24 + Math.sin(t * 6) * 12}px ${tint(C().accent, 35 * prog(t, a + .4, a + .7))}`; } };
  Object.assign(window.KitScenes, {
    endSplit: {
      cues: () => [{ t: .95, kind: 'tick' }],
      hideBug: true,
      exitPush: 1,
      build: s => `<div class="hs-img es-img">${imgOr(s.image, 4)}</div><div class="hs-fade"></div>
        <div class="es">${logo('mark')}${tagline(s, 'es-tag')}${cta(s)}</div>
        ${s.footer ? `<div class="ep-foot label">${markup(s.footer)}</div>` : ''}`,
      update(el, t, d) {
        const box = $('.es-img', el), x = E.outQuint(prog(t, 0, .8));
        box.style.clipPath = portrait() ? `inset(${(1 - x) * 100}% 0 0 0)` : `inset(0 ${(1 - x) * 100}% 0 0)`;
        kenBurns($('.es-img > *', el), t, d, 1.12, 1.02);
        popIn($('.es .mark', el), t, .2, .5, .6);
        words($('.es', el), t, .35, .07, .5);
        glow(el, t, .8);
        fadeUp($('.ep-foot', el), t, 1.1, .5, 12);
      },
    },

    endMosaic: {
      cues: () => [{ t: .95, kind: 'tick' }],
      hideBug: true,
      exitPush: 1,
      build(s) {
        const n = portrait() ? 24 : 24, imgs = s.images || [];
        return `<div class="em-grid">${Array.from({ length: n }, (_, i) => `<div class="em-t">${imgOr(imgs.length ? imgs[i % imgs.length] : null, i)}</div>`).join('')}</div><div class="em-dim"></div>
          <div class="em-card">${logo('mark')}${tagline(s, 'em-tag')}${cta(s)}</div>
          ${s.footer ? `<div class="ep-foot label">${markup(s.footer)}</div>` : ''}`;
      },
      update(el, t, d) {
        $('.em-grid', el).style.transform = `scale(${lerp(1.18, 1.05, E.outCubic(prog(t, 0, d)))}) rotate(-4deg)`;
        $$('.em-t', el).forEach((tile, i) => { tile.style.opacity = E.outCubic(prog(t, (i % 7) * .05 + Math.floor(i / 7) * .04, .5 + (i % 7) * .05)); });
        const card = $('.em-card', el), k = E.outBack(prog(t, .35, .9));
        card.style.opacity = prog(t, .35, .5);
        card.style.transform = `translate(-50%, -50%) scale(${lerp(.85, 1, k)})`;
        words(card, t, .55, .07, .5);
        glow(el, t, .9);
        fadeUp($('.ep-foot', el), t, 1.2, .5, 12);
      },
    },

    endMarquee: {
      cues: () => [{ t: .95, kind: 'tick' }],
      hideBug: true,
      exitPush: 1,
      build: s => `${(s.rows || []).slice(0, 2).map((r, i) => `<div class="emq emq${i}"><span>${Array.from({ length: 6 }, () => markup(r)).join('<em class="sep">&bull;</em>')}</span></div>`).join('')}
        <div class="emq-c">${logo('mark')}${tagline(s, 'emq-tag')}${cta(s)}</div>
        ${s.footer ? `<div class="ep-foot label">${markup(s.footer)}</div>` : ''}`,
      update(el, t) {
        $$('.emq', el).forEach((r, i) => {
          const dir = i ? 1 : -1;
          r.style.opacity = E.outCubic(prog(t, i * .1, .5 + i * .1));
          $('span', r).style.transform = `translateX(${(dir > 0 ? -1500 : -300) + dir * t * 120}px)`;
        });
        popIn($('.emq-c .mark', el), t, .15, .5, .6);
        words($('.emq-c', el), t, .3, .07, .5);
        glow(el, t, .75);
        fadeUp($('.ep-foot', el), t, 1.1, .5, 12);
      },
    },
  });

  // ---------- audio / product demos ----------
  const seeded = i => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
  const waveBars = n => Array.from({ length: n }, (_, i) => `<i style="--b:${(.25 + .75 * Math.pow(seeded(i), .7)).toFixed(3)}"></i>`).join('');
  const animWave = (el, t, d, a = 0) => {
    const bars = $$('.wv i', el), n = bars.length, head = prog(t, a + .3, d - .2);
    bars.forEach((b, i) => {
      const k = +b.style.getPropertyValue('--b'), live = .55 + .45 * Math.sin(t * 7 + i * .55) * Math.sin(t * 2.3 + i * .21);
      const grow = E.outCubic(prog(t, a + i * .008, a + .5 + i * .008));
      b.style.transform = `scaleY(${Math.max(.06, k * live * grow)})`;
      b.style.background = i / n < head ? C().accent : 'rgba(255,255,255,.28)';
    });
    const ph = $('.wv-head', el); if (ph) ph.style.left = `${head * 100}%`;
  };
  Object.assign(window.KitScenes, {
    heroWave: {
      build: s => `<div class="hw">${label(s.label)}${lines(s.lines)}</div>
        <div class="wv-wrap"><span class="wv-play">${icon('play', C().accent, portrait() ? 64 : 52)}</span><div class="wv">${waveBars(portrait() ? 46 : 70)}<b class="wv-head"></b></div></div>
        ${s.track ? `<div class="wv-track">${s.track.cover ? `${window.Kit.img(s.track.cover)}` : ''}<span><b>${markup(s.track.title)}</b><small>${markup(s.track.artist || '')}</small></span></div>` : ''}
        ${s.sub ? `<p class="hw-sub" data-split>${markup(s.sub)}</p>` : ''}`,
      update(el, t, d) {
        fadeUp($('.hw .label', el), t, 0, .4, 20);
        words($('.hw', el), t, .05, .075, .5);
        animWave(el, t, d, .2);
        popIn($('.wv-play', el), t, .15, .5, .5);
        fadeUp($('.wv-track', el), t, .7, .5, 20);
        const sub = $('.hw-sub', el); if (sub) words(sub, t, .9, .06, .5);
      },
    },

    endWave: {
      cues: () => [{ t: .95, kind: 'tick' }],
      hideBug: true,
      exitPush: 1,
      build: s => `<div class="wv-wrap wv-end"><div class="wv">${waveBars(portrait() ? 46 : 70)}<b class="wv-head"></b></div></div>
        <div class="ew">${logo('mark')}${tagline(s, 'ew-tag')}${cta(s)}</div>
        ${s.footer ? `<div class="ep-foot label">${markup(s.footer)}</div>` : ''}`,
      update(el, t, d) {
        animWave(el, t, d, 0);
        popIn($('.ew .mark', el), t, .15, .5, .6);
        words($('.ew', el), t, .3, .07, .5);
        glow(el, t, .75);
        fadeUp($('.ep-foot', el), t, 1.1, .5, 12);
      },
    },

    walkthrough: {
      cues: (s, d) => { const n = s.steps.length, a0 = .45, seg = (d - a0 - .2) / n;
        return s.steps.flatMap((st, i) => st.tap ? [{ t: a0 + i * seg + seg - .75 + .5, kind: 'tick' }] : []); },
      build: s => {
        const pt = portrait();
        const screens = s.steps.map((st, i) => st.image ? `${window.Kit.img(st.image, 'wt-scr', `opacity:${i ? 0 : 1}`)}`
          : `<div class="wt-scr ph" style="opacity:${i ? 0 : 1}; background:${ph(i + 2)}"></div>`).join('');
        const frame = pt ? `<div class="wt-phone"><div class="wt-screen">${screens}</div><i class="notch"></i></div>`
          : `<div class="wt-browser"><div class="bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i><div class="url">${window.Kit.esc(s.url || '')}</div></div><div class="wt-screen">${screens}</div></div>`;
        const pointer = pt ? '<i class="wt-finger"></i>' : `<svg class="wt-cursor" width="44" height="44" viewBox="0 0 24 24"><path d="M4 2l15 11-7 1 4 8-3 1-4-8-5 5z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
        return `${head(s)}<div class="wt">${frame}<i class="wt-ripple"></i>${pointer}</div>
          <div class="wt-caps">${s.steps.map((st, i) => st.caption ? `<div class="wt-cap"><span>${i + 1}</span>${markup(st.caption)}</div>` : '<div class="wt-cap" style="display:none"></div>').join('')}</div>`;
      },
      update(el, t, d, s) {
        animHead(el, t);
        const n = s.steps.length, a0 = .45, seg = (d - a0 - .2) / n;
        const box = $('.wt', el), x = E.outQuint(prog(t, .1, .8));
        box.style.opacity = prog(t, .1, .35);
        box.style.transform = `translateY(${(1 - x) * 80}px)`;
        const scr = $$('.wt-scr', el), caps = $$('.wt-cap', el), screen = $('.wt-screen', el);
        const pt = portrait(), ptr = $(pt ? '.wt-finger' : '.wt-cursor', el), rip = $('.wt-ripple', el);
        // which screen: switch at the end of each segment, right after its tap
        let cur = 0;
        for (let i = 1; i < n; i++) if (t >= a0 + i * seg) cur = i;
        const zoomOf = i => { const st = s.steps[i] || {}; const z = st.zoom || 1, o = st.origin || st.tap || [50, 50];
          return { z: lerp(1, z, E.outCubic(prog(t, a0 + i * seg + .05, a0 + i * seg + .85))), o }; };
        scr.forEach((im, i) => {
          const zm = zoomOf(i);
          im.style.transformOrigin = `${zm.o[0]}% ${zm.o[1]}%`; im.style.transform = `scale(${zm.z})`;
          const fadeIn = i === 0 ? 1 : prog(t, a0 + i * seg, a0 + i * seg + .25);
          im.style.opacity = i <= cur ? fadeIn : 0;
          im.style.zIndex = i;
        });
        caps.forEach((c, i) => { const on = i === cur; c.style.opacity = on ? prog(t, a0 + i * seg, a0 + i * seg + .2) : 0; c.style.transform = `translateY(${on ? (1 - E.outCubic(prog(t, a0 + i * seg, a0 + i * seg + .35))) * 20 : 20}px)`; });
        // pointer travels to this step's tap target and presses it near the end of the segment
        const st = s.steps[cur], tap = st && st.tap, sb = screen.getBoundingClientRect(), bb = box.getBoundingClientRect();
        if (tap && cur < n) {
          const ta = a0 + cur * seg + seg - .75, press = prog(t, ta + .45, ta + .6);
          const prev = (cur > 0 && s.steps[cur - 1].tap) || [50, 70];
          const mv = E.inOutCubic(prog(t, ta, ta + .45)), zm = zoomOf(cur);
          const zx = v => zm.o[0] + (v - zm.o[0]) * zm.z, zy = v => zm.o[1] + (v - zm.o[1]) * zm.z; // where a screenshot % lands after zoom
          const px = sb.left - bb.left + sb.width * lerp(zx(prev[0]), zx(tap[0]), mv) / 100, py = sb.top - bb.top + sb.height * lerp(zy(prev[1]), zy(tap[1]), mv) / 100;
          ptr.style.opacity = prog(t, ta - .2, ta) * (1 - prog(t, ta + .75, ta + .9));
          ptr.style.transform = `translate(${px}px, ${py}px) scale(${1 - .2 * Math.sin(Math.PI * press)})`;
          const r = prog(t, ta + .5, ta + .9);
          rip.style.opacity = r > 0 && r < 1 ? 1 - r : 0;
          rip.style.transform = `translate(${px}px, ${py}px) scale(${.3 + r * 1.6})`;
        } else { ptr.style.opacity = 0; rip.style.opacity = 0; }
      },
    },

    embedDemo: {
      build: s => `${head(s)}<div class="ed-code"><span class="ed-tag"><b>&lt;/&gt;</b> embed</span><code class="ed-txt"></code><i class="ed-caret"></i></div>
        <div class="ed-post${s.site ? ' ed-web' : ''}">${s.site ? `<div class="ed-site"><i></i><i></i><i></i><span>${markup(s.site)}</span></div>` : ''}<div class="ed-title">${markup((s.post && s.post.title) || 'My blog post')}</div><i class="ed-line"></i><i class="ed-line s"></i>
          ${s.embeds.map(e => `<div class="ed-emb">${e.image ? `${window.Kit.img(e.image)}` : `<div class="ed-mock"><b>${icon('play', '#fff', 26)}</b><span class="wv">${waveBars(36)}</span></div>`}${e.label ? `<span>${markup(e.label)}</span>` : ''}</div>`).join('')}<i class="ed-line"></i><i class="ed-line m"></i></div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const code = $('.ed-code', el), x = E.outQuint(prog(t, .2, .7));
        code.style.opacity = prog(t, .2, .35); code.style.transform = `translateY(${(1 - x) * 30}px)`;
        const n = Math.round(s.code.length * prog(t, .4, 1.5));
        $('.ed-txt', el).textContent = s.code.slice(0, n);
        $('.ed-caret', el).style.opacity = Math.sin(t * 10) > 0 || n < s.code.length ? 1 : 0;
        const post = $('.ed-post', el), y = E.outQuint(prog(t, .7, 1.3));
        post.style.opacity = prog(t, .7, .9); post.style.transform = `translateY(${(1 - y) * 60}px)`;
        $$('.ed-emb', el).forEach((e, i) => popIn(e, t, 1.4 + i * .35, .55, .7));
      },
    },
  });

  Object.assign(window.KitScenes, {
    lockscreen: {
      cues: () => [{ t: 1.0, kind: 'tick' }],
      build: s => `${head(s)}<div class="ls"><div class="wt-phone ls-phone"><div class="wt-screen ls-screen">
          ${s.from ? `${window.Kit.img(s.from, 'ls-app')}` : ''}<div class="ls-lock">
            <span class="ls-pad">${icon('lock', '#fff', 30)}</span><div class="ls-time">${window.Kit.esc(s.time || '9:41')}</div><div class="ls-date">${markup(s.date || 'Tuesday, 14 October')}</div>
            <div class="ls-card"><div class="ls-src">${markup(s.source || B().name)}</div>${s.title ? `<div class="ls-title">${markup(s.title)}</div>` : '<div class="ls-title">Playing</div>'}
              <div class="ls-bar"><i></i></div><div class="ls-ctl">${icon('arrow', '#fff', 30).replace('<svg', '<svg style="transform:scaleX(-1)"')}<b>${icon('play', '#111', 30)}</b>${icon('arrow', '#fff', 30)}</div>
              <div class="wv ls-wv">${waveBars(30)}</div></div></div></div><i class="notch"></i></div></div>
        ${s.caption ? `<div class="wt-caps"><div class="wt-cap" style="opacity:1"><span>${icon('lock', C().accent, 30)}</span>${markup(s.caption)}</div></div>` : ''}`,
      update(el, t, d) {
        animHead(el, t);
        const box = $('.ls', el), x = E.outQuint(prog(t, .05, .7));
        box.style.opacity = prog(t, .05, .3); box.style.transform = `translateY(${(1 - x) * 70}px)`;
        const lockAt = .9, app = $('.ls-app', el), lock = $('.ls-lock', el);
        if (app) app.style.opacity = 1 - prog(t, lockAt, lockAt + .15);
        lock.style.opacity = prog(t, lockAt + .1, lockAt + .45);
        $('.ls-bar i', el).style.transform = `scaleX(${.18 + prog(t, 0, d) * .5})`;
        const cardK = E.outBack(prog(t, lockAt + .35, lockAt + .85)), card = $('.ls-card', el);
        card.style.opacity = prog(t, lockAt + .35, lockAt + .5); card.style.transform = `translateY(${(1 - cardK) * 40}px)`;
        $$('.ls-wv i', el).forEach((b, i) => { const k = +b.style.getPropertyValue('--b'); b.style.transform = `scaleY(${Math.max(.1, k * (.55 + .45 * Math.sin(t * 7 + i * .6)))})`; });
        const cap = $('.wt-caps', el); if (cap) fadeUp(cap, t, lockAt + .6, .45, 20);
      },
    },
  });
})();
