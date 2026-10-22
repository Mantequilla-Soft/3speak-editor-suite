// Extra shared scene types (both orientations), registered into window.KitScenes. Styles: lib/scenes-extra.css.
// Load after lib/scenes-more.js and before Kit.run.
//
//   deck     a face-down stack of cards; the top card is dealt off, flips and lands in a fan, one after another
//            { label?, lines[], cards: [{ image? | icon?, title, sub? }] (3-5) }   (opener or middle)
//   sleeve   an album cover slides in, a vinyl record slides out of it and spins (label = the cover), headline beside it
//            { cover, title?, artist?, label?, lines[], sub? }   (opener)
//   adSpot   a video plays in a player; three ad formats take turns inside it, placed like the real player: a video spot
//            at a marker, a ticker band across the top, a banner (60% wide, centred, 6% above the bottom). A list beside it lights up the format on screen
//            { label?, lines[], video (image), spot: { image, title, sub?, cta? }, ticker, banner: { image?, title?, sub? } (no title = the image IS the creative, like a real banner),
//              formats: [{ icon, title, sub? }] (3, in that order) }   (middle)
//   tabs     a browser flips through real pages as tabs (cross-slide), a chip pops per page (e.g. its member count)
//            { label?, lines[], sub?, tabs: [{ title, image, url?, chip?, icon? }] (2-4) }   (opener)
//   growth   an upward curve draws itself, "+1" member bubbles pop along it, then a pulsing outline "Join" pill
//            { label?, lines[], sub?, bubbles?: n (default 4), join? }   (illustration: no numbers on the chart)
//   frontends  browser windows cascade in, each showing the same player + ad banner on a different site
//            { label?, lines[], sub?, sites: [{ url, video, tag? }] (3-5), banner: image }   (middle)
(function () {
  const { prog, lerp, E, $, $$, markup, words, fadeUp, popIn } = window.Reel;
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
  const ph = i => `linear-gradient(135deg, hsl(${(i * 47) % 360} 55% 42%), hsl(${(i * 47 + 60) % 360} 60% 22%))`;
  const imgOr = (src, i) => src ? `${window.Kit.img(src)}` : `<div class="ph" style="background:${ph(i)}"></div>`;

  // deck timing: when card i leaves the stack (shared by update and cues)
  const deckAt = (n, d) => { const a0 = .7, seg = Math.min(.42, (d - 1.9 - a0) / Math.max(1, n - 1)); return i => a0 + i * seg; };

  Object.assign(window.KitScenes = window.KitScenes || {}, {
    deck: {
      cues: (s, d) => { const at = deckAt(s.cards.length, d); return s.cards.map((_, i) => ({ t: at(i) + .12, kind: 'swish', gain: -5 })); },
      build: s => `${head(s)}<div class="dk">${s.cards.map((c, i) => {
          const col = accents()[i % 3];
          const face = c.image ? `<div class="dk-img">${imgOr(c.image, i)}</div>`
            : `<div class="dk-ic" style="background:${tint(col, 16)}">${icon(c.icon, col, portrait() ? 150 : 120)}</div>`;
          return `<div class="dk-card"><div class="dk-face dk-front">${face}<div class="dk-txt"><b>${markup(c.title)}</b>${c.sub ? `<small>${markup(c.sub)}</small>` : ''}</div></div>
            <div class="dk-face dk-back">${logo('dk-mark')}</div></div>`;
        }).join('')}</div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const cards = $$('.dk-card', el), n = cards.length, at = deckAt(n, d), pt = portrait();
        const spread = pt ? 200 : 236, fan = pt ? 9 : 10, arc = pt ? 22 : 26;
        const inK = E.outQuint(prog(t, .1, .65)); // the whole stack rises in
        cards.forEach((c, i) => {
          const a = at(i), k = E.inOutCubic(prog(t, a, a + .55)); // 0 = in the stack, 1 = in its fan slot
          const o = i - (n - 1) / 2, lift = Math.sin(Math.PI * k);
          const settle = prog(t, a + .55, a + 1.2), sway = Math.sin(t * 1.6 + i * 1.3) * settle;
          // in the stack: card i sits (n-1-i) layers down, each layer a few px offset
          const sx = (n - 1 - i) * -3, sy = (n - 1 - i) * 4 + (1 - inK) * 520, sr = (n - 1 - i) * -1.5;
          const fx = o * spread, fy = Math.abs(o) * Math.abs(o) * arc + sway * 6, fr = o * fan + sway * .8;
          const flip = lerp(180, 0, E.inOutCubic(prog(t, a + .08, a + .5)));
          c.style.transform = `translate(-50%, -50%) translate(${lerp(sx, fx, k)}px, ${lerp(sy, fy, k) - lift * 70}px) rotate(${lerp(sr, fr, k)}deg) scale(${1 + lift * .08}) perspective(1600px) rotateY(${flip}deg)`;
          // fade the FACES, not the card: opacity < 1 on a preserve-3d element flattens it and the back face stops hiding
          const op = prog(t, .1 + (n - 1 - i) * .04, .3 + (n - 1 - i) * .04);
          $$('.dk-face', c).forEach(f => { f.style.opacity = op; });
          // dealt cards stay above the stack; the one in the air above everything
          c.style.zIndex = k > 0 ? (k < 1 ? 300 : 100 + i) : n - i;
        });
      },
    },

    sleeve: {
      cues: () => [{ t: .62, kind: 'whoosh', gain: -3 }],
      build: s => `<div class="sv">
          <div class="sv-disc"><div class="sv-grooves"></div><div class="sv-label">${imgOr(s.cover, 1)}<i></i></div><div class="sv-sheen"></div></div>
          <div class="sv-cover">${imgOr(s.cover, 1)}</div></div>
        ${s.title ? `<div class="sv-track">${icon('play', C().accent, portrait() ? 40 : 34)}<span><b>${markup(s.title)}</b>${s.artist ? `<small>${markup(s.artist)}</small>` : ''}</span></div>` : ''}
        <div class="sv-copy">${label(s.label)}${lines(s.lines)}${s.sub ? `<p class="sv-sub" data-split>${markup(s.sub)}</p>` : ''}</div>`,
      update(el, t, d) {
        const pt = portrait(), size = pt ? 560 : 520;
        const cv = $('.sv-cover', el), k = E.outQuint(prog(t, 0, .7));
        cv.style.opacity = prog(t, 0, .15);
        cv.style.transform = `translateX(${(1 - k) * (pt ? -300 : 360)}px) rotate(${(1 - k) * (pt ? -8 : 8)}deg)`;
        // the record slides out to the right and keeps drifting a little; it spins up as it comes out
        const out = E.outCubic(prog(t, .55, 1.35)), drift = prog(t, 1.35, d) * 16;
        const disc = $('.sv-disc', el);
        disc.style.transform = `translateX(${out * size * .55 + drift}px) translateY(${(1 - k) * 0}px)`;
        const spin = Math.max(0, t - .55), ang = spin < .8 ? 110 * spin * spin / .8 * .5 : 110 * .4 + 110 * (spin - .8); // eases up to 110deg/s
        $('.sv-label', el).style.transform = `rotate(${ang}deg)`;
        disc.style.opacity = prog(t, .45, .6);
        fadeUp($('.sv-track', el), t, 1.15, .45, 18);
        fadeUp($('.sv-copy .label', el), t, .15, .4, 20);
        words($('.sv-copy', el), t, .25, .075, .5);
      },
    },

    adSpot: {
      // spot from .85, ticker from 2.25, banner from 3.55 (for a 5 s scene; they scale with the duration)
      cues: (s, d) => { const P = adPhases(d); return [{ t: P[0] + .05, kind: 'tick' }, { t: P[1] + .05, kind: 'swish', gain: -4 }, { t: P[2] + .05, kind: 'swish', gain: -4 }]; },
      build: s => {
        const f = s.formats || [];
        return `${head(s)}<div class="as-list">${f.map((it, i) => `<div class="as-it"><span class="ic">${icon(it.icon, accents()[i % 3], portrait() ? 44 : 40)}</span>
            <span><b>${markup(it.title)}</b>${it.sub ? `<small>${markup(it.sub)}</small>` : ''}</span></div>`).join('')}</div>
          <div class="as-player"><div class="as-screen">
              <div class="as-video">${imgOr(s.video, 3)}</div>
              <div class="as-spot">${imgOr(s.spot.image, 5)}<div class="as-spot-shade"></div>
                <span class="as-pill">Ad</span><span class="as-count">0:05</span>
                <div class="as-spot-txt"><b>${markup(s.spot.title)}</b>${s.spot.sub ? `<small>${markup(s.spot.sub)}</small>` : ''}</div>
                ${s.spot.cta ? `<span class="as-btn">${markup(s.spot.cta)}</span>` : ''}</div>
              <div class="as-ticker"><span class="as-pill">Ad</span><div class="as-tk"><span>${Array.from({ length: 3 }, () => markup(s.ticker || '')).join('<em class="sep">&bull;</em>')}</span></div></div>
              <div class="as-banner${s.banner.title ? '' : ' img-only'}">${s.banner.image ? `<div class="as-bimg">${imgOr(s.banner.image, 6)}</div>` : ''}${s.banner.title ? `<span class="as-btxt"><b>${markup(s.banner.title)}</b>${s.banner.sub ? `<small>${markup(s.banner.sub)}</small>` : ''}</span>` : ''}<span class="as-pill">Ad</span><span class="as-bx">&times;</span></div>
            </div>
            <div class="as-bar"><b>${icon('play', '#fff', 26)}</b><div class="as-track"><i class="as-played"></i><i class="as-mark"></i><i class="as-head"></i></div><span class="as-time">2:41</span></div>
          </div>`;
      },
      update(el, t, d, s) {
        animHead(el, t);
        const P = adPhases(d), pl = $('.as-player', el), k = E.outQuint(prog(t, .15, .8));
        pl.style.opacity = prog(t, .15, .35);
        pl.style.transform = `translateY(${(1 - k) * 70}px)`;
        $('.as-video > *', el).style.transform = `scale(${lerp(1.04, 1.14, prog(t, 0, d))})`;
        // progress: the playhead runs to the marker, the bar turns into the ad segment while the spot plays, then runs on
        const mark = .34, spotEnd = P[1] - .05;
        const pos = t < P[0] ? lerp(.14, mark, prog(t, .2, P[0])) : t < spotEnd ? mark : lerp(mark, .5, prog(t, spotEnd, d));
        $('.as-played', el).style.width = pos * 100 + '%';
        $('.as-head', el).style.left = pos * 100 + '%';
        $('.as-mark', el).style.left = mark * 100 + '%';
        $('.as-mark', el).style.opacity = 1 - prog(t, P[0], P[0] + .2);
        const inSpot = t >= P[0] && t < spotEnd;
        $('.as-played', el).style.background = inSpot ? C().accent2 : C().accent;
        // 1: video spot
        const spot = $('.as-spot', el), sIn = prog(t, P[0], P[0] + .3), sOut = prog(t, spotEnd - .25, spotEnd);
        spot.style.opacity = Math.min(sIn, 1 - sOut);
        $('.as-spot > img, .as-spot > .ph', el).style.transform = `scale(${lerp(1.12, 1.02, E.outCubic(prog(t, P[0], spotEnd)))})`;
        fadeUp($('.as-spot-txt', el), t, P[0] + .2, .4, 20);
        const btn = $('.as-btn', el); if (btn) popIn(btn, t, P[0] + .4, .45, .8);
        $('.as-spot .as-count', el).textContent = `0:0${Math.max(1, 5 - Math.floor(prog(t, P[0], spotEnd) * 4))}`;
        // 2: ticker line slides up and scrolls
        const tk = $('.as-ticker', el), tIn = E.outCubic(prog(t, P[1], P[1] + .35)), tOut = prog(t, P[2] - .1, P[2] + .15);
        tk.style.opacity = Math.min(prog(t, P[1], P[1] + .15), 1 - tOut);
        tk.style.transform = `translateY(${-(1 - tIn) * 100}%)`; // drops in from the top edge, like the player's band
        $('.as-tk span', el).style.transform = `translateX(${(portrait() ? 300 : 360) - Math.max(0, t - P[1]) * 260}px)`;
        // 3: banner rises into its booked box, centred near the bottom of the frame
        const bn = $('.as-banner', el), bK = E.outCubic(prog(t, P[2], P[2] + .45));
        bn.style.opacity = prog(t, P[2], P[2] + .15);
        bn.style.transform = `translateX(-50%) translateY(${(1 - bK) * 30}px)`;
        // list: the format on screen lights up
        const act = t < P[0] ? -1 : t < P[1] ? 0 : t < P[2] ? 1 : 2;
        $$('.as-it', el).forEach((it, i) => {
          fadeUp(it, t, .45 + i * .12, .45, 24);
          const on = i === act;
          it.style.borderColor = on ? accents()[i % 3] : 'rgba(255,255,255,.1)';
          it.style.background = on ? `color-mix(in srgb, ${accents()[i % 3]} 14%, rgba(18,19,28,.95))` : 'rgba(18,19,28,.7)';
          if (+it.style.opacity >= 1) it.style.opacity = on || act < 0 ? 1 : .5;
        });
      },
    },
  });
  // when the spot, the ticker and the banner start
  function adPhases(d) { const a = .85, step = (d - a - 1.15) / 2; return [a, a + step + .05, a + 2 * step + .05]; }
  // ---------- tabs / growth / frontends ----------
  const tabsAt = (n, d) => { const seg = (d - .3) / (n + .4); return k => .3 + k * seg; }; // when tab k becomes active (k >= 1)
  Object.assign(window.KitScenes, {
    tabs: {
      cues: (s, d) => { const at = tabsAt(s.tabs.length, d); return s.tabs.slice(1).map((_, k) => ({ t: at(k + 1) - .05, kind: 'click' })); },
      build: s => `<div class="tb-copy">${label(s.label)}${lines(s.lines)}${s.sub ? `<p class="tb-sub" data-split>${markup(s.sub)}</p>` : ''}</div>
        <div class="tb"><div class="tb-strip">${s.tabs.map(tb => `<div class="tb-tab"><i>${tb.icon ? `${window.Kit.img(tb.icon)}` : ''}</i><span>${markup(tb.title)}</span></div>`).join('')}</div>
          <div class="tb-bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i><div class="url"></div></div>
          <div class="tb-screen">${s.tabs.map((tb, i) => imgOr(tb.image, i).replace('class="ui', 'class="ui tb-scr').replace('class="ph"', 'class="ph tb-scr"')).join('')}</div></div>
        ${s.tabs.map(tb => tb.chip ? `<div class="tb-chip">${icon('user', C().accent2, portrait() ? 40 : 34)}<span>${markup(tb.chip)}</span></div>` : '<div class="tb-chip" style="display:none"></div>').join('')}`,
      update(el, t, d, s) {
        fadeUp($('.tb-copy .label', el), t, .1, .4, 20);
        words($('.tb-copy', el), t, .2, .075, .5);
        const box = $('.tb', el), k = E.outQuint(prog(t, .05, .75));
        box.style.opacity = prog(t, .05, .3);
        box.style.transform = `translateY(${(1 - k) * 80}px) rotateX(${(1 - k) * 8}deg)`;
        const n = s.tabs.length, at = tabsAt(n, d);
        let cur = 0; for (let i = 1; i < n; i++) if (t >= at(i)) cur = i;
        $$('.tb-scr', el).forEach((im, i) => {
          const a = i ? at(i) : 0, x = i ? E.outCubic(prog(t, a, a + .45)) : 1;
          im.style.visibility = i <= cur ? 'visible' : 'hidden';
          im.style.zIndex = i;
          im.style.transform = `translateX(${(1 - x) * 100}%) scale(${lerp(1, 1.06, prog(t, a, a + 2.5))})`;
        });
        $$('.tb-tab', el).forEach((tb, i) => { tb.classList.toggle('on', i === cur); });
        $('.tb-bar .url', el).textContent = s.tabs[cur].url || '';
        $$('.tb-chip', el).forEach((c, i) => { const a = (i ? at(i) : .55) + .2;
          const on = i === cur, kk = E.outBack(prog(t, a, a + .45));
          c.style.opacity = on ? prog(t, a, a + .15) : 0; c.style.transform = `scale(${lerp(.7, 1, kk)})`; });
      },
    },

    growth: {
      cues: s => [...Array.from({ length: s.bubbles || 4 }, (_, i) => ({ t: growthBubbleAt(i, s.bubbles || 4) + .05, kind: 'click' })), { t: 2.55, kind: 'tick' }],
      build(s) {
        const n = s.bubbles || 4, pts = Array.from({ length: 41 }, (_, i) => growthPt(i / 40));
        const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
        return `<div class="xhead gw-head">${label(s.label)}${lines(s.lines)}${s.sub ? `<p class="gw-sub" data-split>${markup(s.sub)}</p>` : ''}</div>
          <div class="gw"><svg viewBox="0 0 1000 640" preserveAspectRatio="none">
            <defs><linearGradient id="gwFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C().accent}" stop-opacity=".38"/><stop offset="1" stop-color="${C().accent}" stop-opacity="0"/></linearGradient>
              <clipPath id="gwClip"><rect class="gw-clip" x="0" y="0" width="0" height="640"/></clipPath></defs>
            ${[160, 320, 480].map(y => `<line x1="0" x2="1000" y1="${y}" y2="${y}" stroke="rgba(255,255,255,.07)" stroke-width="2"/>`).join('')}
            <line x1="0" x2="1000" y1="620" y2="620" stroke="rgba(255,255,255,.18)" stroke-width="3"/>
            <path d="${line} L1000,620 L0,620 Z" fill="url(#gwFill)" clip-path="url(#gwClip)"/>
            <path class="gw-line" d="${line}" pathLength="1" fill="none" stroke="${C().accent}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            ${Array.from({ length: n }, (_, i) => `<div class="gw-b"><span class="av" style="background:${tint(accents()[i % 3], 22)}">${icon('user', accents()[i % 3], portrait() ? 34 : 30)}</span><b>+1</b></div>`).join('')}
            <div class="gw-dot"></div>
            <div class="gw-join">${icon('user', C().accent, portrait() ? 34 : 30)}<span>${markup(s.join || 'Join community')}</span></div></div>`;
      },
      update(el, t, d, s) {
        fadeUp($('.gw-head .label', el), t, .05, .4, 20); words($('.gw-head', el), t, .1, .08, .5);
        const box = $('.gw', el); box.style.opacity = prog(t, .1, .35);
        const p = E.inOutCubic(prog(t, .3, 2.4));
        $('.gw-line', el).style.strokeDasharray = `${p} 1`;
        $('.gw-clip', el).setAttribute('width', 1000 * p);
        const W = box.clientWidth, H = box.clientHeight, at = u => { const q = growthPt(u); return [q[0] / 1000 * W, q[1] / 640 * H]; };
        const [dx, dy] = at(Math.max(.001, p)), dot = $('.gw-dot', el);
        dot.style.transform = `translate(${dx}px, ${dy}px)`; dot.style.opacity = p > 0 ? 1 : 0;
        const n = s.bubbles || 4;
        $$('.gw-b', el).forEach((b, i) => {
          const a = growthBubbleAt(i, n), [x, y] = at(growthU(i, n)), k = E.outBack(prog(t, a, a + .45));
          b.style.opacity = prog(t, a, a + .12);
          b.style.transform = `translate(${x}px, ${y - k * 70}px) scale(${lerp(.5, 1, k)})`;
        });
        const j = $('.gw-join', el), [jx, jy] = at(1), jk = E.outBack(prog(t, 2.45, 2.95));
        j.style.opacity = prog(t, 2.45, 2.6);
        j.style.transform = `translate(${jx}px, ${jy}px) translate(-100%, -150%) scale(${lerp(.6, 1, jk)})`;
        j.style.boxShadow = `0 0 ${24 + Math.sin(t * 6) * 12}px ${tint(C().accent, 35 * prog(t, 2.8, 3.1))}`;
      },
    },

    frontends: {
      cues: s => s.sites.map((_, i) => ({ t: .4 + i * .3, kind: 'swish', gain: -6 })),
      build: s => `<div class="xhead fe-head">${label(s.label)}${lines(s.lines)}${s.sub ? `<p class="fe-sub" data-split>${markup(s.sub)}</p>` : ''}</div>
        <div class="fe">${s.sites.map((st, i) => `<div class="fe-w"><div class="fe-bar"><i></i><i></i><i></i><span>${markup(st.url)}</span></div>
            <div class="fe-body"><i class="fe-l"></i><i class="fe-l s"></i>
              <div class="fe-pl">${imgOr(st.video, i)}<div class="fe-ban">${imgOr(s.banner, 9)}<em>Ad</em></div><div class="fe-pb"><i style="width:${30 + i * 9}%"></i></div></div></div>
            ${st.tag ? `<span class="fe-tag">${markup(st.tag)}</span>` : ''}<div class="fe-dim"></div></div>`).join('')}</div>`,
      update(el, t, d, s) {
        fadeUp($('.fe-head .label', el), t, .05, .4, 20); words($('.fe-head', el), t, .1, .08, .5);
        const wins = $$('.fe-w', el), n = wins.length, pt = portrait();
        wins.forEach((w, i) => {
          const a = .3 + i * .3, k = E.outQuint(prog(t, a, a + .6));
          const x = (pt ? 50 : 96) * i, y = (pt ? 120 : 92) * i;
          w.style.opacity = prog(t, a, a + .15);
          w.style.transform = `translate(${x + (1 - k) * 380}px, ${y + (1 - k) * 40}px) rotate(${(1 - k) * 7}deg)`;
          w.style.zIndex = i + 1;
          // older windows dim a little as newer ones land in front
          $('.fe-dim', w).style.opacity = .3 * prog(t, a + .3 * (n - 1 - i) + .3, a + .3 * (n - i) + .5) * (i < n - 1 ? 1 : 0);
          const ban = $('.fe-ban', w), bk = E.outCubic(prog(t, a + .45, a + .85));
          ban.style.opacity = prog(t, a + .45, a + .6); ban.style.transform = `translateX(-50%) translateY(${(1 - bk) * 14}px)`;
          const tag = $('.fe-tag', w); if (tag) popIn(tag, t, a + .7, .45, .6);
        });
      },
    },
  });
  // growth curve: x across the chart, y rising (SVG units 1000 x 640, baseline 620)
  function growthPt(u) { const f = .06 + .78 * Math.pow(u, 1.7) + .035 * Math.sin(u * 15) * (1 - u * .5); return [u * 1000, 620 - f * 560]; }
  function growthU(i, n) { return .22 + i * (.72 / Math.max(1, n - 1)) * .92; }
  function growthBubbleAt(i, n) { const u = growthU(i, n); let lo = 0, hi = 1; for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; (E.inOutCubic(m) < u ? lo = m : hi = m); } return .3 + lo * 2.1; }
})();
