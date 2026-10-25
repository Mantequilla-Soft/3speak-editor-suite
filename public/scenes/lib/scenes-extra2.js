// Ten more shared scene types (both orientations), registered into window.KitScenes. Styles: lib/scenes-extra2.css.
// Load after lib/scenes-extra.js and before Kit.run. Real numbers only in copy and data: these are frames, not claims.
//
//   map            dotted world map; pins drop at real places, arcs fly from the first pin to the others
//                  { label?, lines[], pins: [{ lon, lat, label? }], caption? }
//   receipt        a paper slip prints line by line, a total, then a stamp
//                  { label?, lines[], title?, items: [{ name, value }], total?: { name, value }, stamp?, note? }
//   timeline       a line draws itself; milestones pop above/below it (portrait: down the left), "now" pulses
//                  { label?, lines[], items: [{ date, title, icon? }], now?: index }
//   phoneStack     three phones fan in, each screen scrolls its own (tall) screenshot, captions under them
//                  { label?, lines[], phones: [{ image, caption? }] (3) }
//   spotlightGrid  a dimmed grid of tiles; a round spotlight glides from pick to pick with a caption
//                  { label?, lines[], tiles: [{ image?, title? }] (9), picks: [{ index, caption }] (2-4) }
//   stopwatch      a stopwatch dial sweeps while the readout counts, then snaps to a result with a check
//                  { label?, lines[], seconds: n, result?, caption? }
//   split3         three full-height panels slide in staggered, a word on each, an optional line on top at the end
//                  { panels: [{ image?, word, sub? }] (3), line? }
//   ticket         an event ticket slides in, the stub tears off, a stamp lands
//                  { label?, lines[], event, date, time?, place?, stamp?, code? }
//   magnifier      a lens glides over a screenshot and enlarges small details, a caption per stop
//                  { label?, lines[], image, stops: [{ x, y (% of the image), caption? }] (2-4), zoom? }
//   flow           nodes joined by lines that draw themselves, dots keep travelling along them
//                  { label?, lines[], nodes: [{ icon, title, sub? }] (3-5) }
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
  const logo = cls => B().logo ? `${window.Kit.img(B().logo, cls)}` : `<div class="${cls} monogram">${window.Kit.esc(B().monogram || (B().name || '?')[0])}</div>`;
  const seeded = i => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

  // Natural Earth 110m land (public domain), rasterised to 96 x 46 dots, lat 82 to -56, equirectangular. One hex row per line.
  const LAND = ["0000033bfff0060400c00000", "00008063ffe0080000000000", "000000807fe0000101f80000", "0001f6f07fc000022fffd700", "0fffd1cc3f800fc1ffffffff", "dfffff8c38301d9fffffffff", "0ffffe0418003bffffffffff", "061ffe18000079ffffffff90", "0407ff8f000233fffffff820", "0003ffdf80053ffffffffc20", "0003ffff0000fffffffff800", "0001fffe0001fffffffff800", "0001fffe0000ef37fffff000", "0001fff80003975bffffe000", "0001fff0000701fbfffe4400", "0000fff00002e03fffff3800", "00007fe00003f47fffff0000", "00007e000007ffffffff8000", "00001c20000fffb9ffff0000", "00000c00000fffbf3ffe0000", "00000c90000fffdf1e700000", "00000700000fffde0c708000", "000001c0001ffff808380000", "00000040000fffe408384000", "0000003f000ffff804204000", "0000001fc0077ff800010000", "0000001fc0001ff000320000", "0000001fe0003fe000160000", "0000001ffc001fe000109c00", "0000001ffe001fc000080640", "0000001ffe001fe000000100", "0000001ffc000fe000001800", "0000000ffc001fe800007208", "00000007f8001fc800007e00", "00000007f8000f880001ff00", "00000007e0000f880003ff80", "00000007e0000f800003ff80", "00000007e00007000001ff80", "00000007c000060000018f00", "000000078000000000000702", "0000000e0000000000000002", "000000060000000000000000", "0000000c000000000000000c", "0000000c0000000000000000", "0000000c8000000000000000", "000000040000000000000000"];
  const MW = 96, MH = 46, LAT0 = 82, LAT1 = -56;
  const land = (c, r) => { const h = LAND[r] || ''; const bits = BigInt('0x' + (h || '0')).toString(2).padStart(MW, '0'); return bits[c] === '1'; };
  const lonlatPct = (lon, lat) => [(lon + 180) / 360 * 100, (LAT0 - lat) / (LAT0 - LAT1) * 100];

  Object.assign(window.KitScenes = window.KitScenes || {}, {
    map: {
      cues: s => s.pins.map((_, i) => ({ t: .7 + i * .22, kind: 'click' })),
      build(s) {
        let dots = '';
        for (let r = 0; r < MH; r++) for (let c = 0; c < MW; c++) if (land(c, r)) dots += `<circle cx="${c + .5}" cy="${r + .5}" r=".34" data-d="${Math.hypot(c - MW / 2, (r - MH / 2) * 1.6).toFixed(1)}"/>`;
        const [x0, y0] = lonlatPct(s.pins[0].lon, s.pins[0].lat);
        const arcs = s.pins.slice(1).map(p => { const [x, y] = lonlatPct(p.lon, p.lat), mx = (x0 + x) / 2 * MW / 100, my = Math.min(y0, y) * MH / 100 - Math.abs(x - x0) * .12;
          return `<path d="M${x0 * MW / 100},${y0 * MH / 100} Q${mx},${my} ${x * MW / 100},${y * MH / 100}" pathLength="1"/>`; }).join('');
        return `${head(s, 'mp-head')}<div class="mp"><svg class="mp-svg" viewBox="0 0 ${MW} ${MH}"><g class="mp-dots">${dots}</g><g class="mp-arcs" stroke="${C().accent2}">${arcs}</g></svg>
          ${s.pins.map((p, i) => { const [x, y] = lonlatPct(p.lon, p.lat); return `<div class="mp-pin${x > 76 ? ' lft' : ''}" style="left:${x}%;top:${y}%"><i class="ring"></i><i class="pin" style="background:${i ? C().accent2 : C().accent}"></i>${p.label ? `<span>${markup(p.label)}</span>` : ''}</div>`; }).join('')}</div>
          ${s.caption ? `<div class="mp-cap" data-split>${markup(s.caption)}</div>` : ''}`;
      },
      update(el, t, d, s) {
        animHead(el, t);
        $$('.mp-dots circle', el).forEach(c => { const k = prog(t, .05 + +c.dataset.d * .012, .35 + +c.dataset.d * .012); c.style.opacity = .16 + .3 * k; c.setAttribute('r', (.34 * k).toFixed(3)); });
        $$('.mp-pin', el).forEach((p, i) => {
          const a = .7 + i * .22, k = E.outBack(prog(t, a, a + .4));
          p.style.opacity = prog(t, a, a + .1);
          $('.pin', p).style.transform = `translate(-50%, -100%) translateY(${(1 - k) * -40}px) rotate(-45deg)`;
          const ring = $('.ring', p), rp = ((t - a) % 1.6) / 1.6;
          ring.style.opacity = t > a ? (1 - rp) * .8 : 0; ring.style.transform = `translate(-50%, -50%) scale(${.3 + rp * 2.2})`;
          const lb = $('span', p); if (lb) fadeUp(lb, t, a + .25, .35, 10);
        });
        $$('.mp-arcs path', el).forEach((a, i) => { const st = .8 + (i + 1) * .22; const k = E.inOutCubic(prog(t, st, st + .7)); a.style.strokeDasharray = `${k} 1`; });
        const cap = $('.mp-cap', el); if (cap) words(cap, t, .9 + s.pins.length * .22, .06, .5);
      },
    },

    receipt: {
      cues: s => [...s.items.map((_, i) => ({ t: .75 + i * .26, kind: 'type' })), ...(s.stamp ? [{ t: 1.0 + s.items.length * .26 + .45, kind: 'tick' }] : [])],
      build: s => `${head(s, 'rc-head')}<div class="rc"><div class="rc-slot"></div><div class="rc-paper">
          <div class="rc-top">${logo('rc-mark')}<b>${markup(s.title || B().name)}</b></div><i class="rc-sep"></i>
          ${s.items.map(it => `<div class="rc-row"><span>${markup(it.name)}</span><b>${markup(it.value)}</b></div>`).join('')}
          ${s.total ? `<i class="rc-sep"></i><div class="rc-row rc-total"><span>${markup(s.total.name)}</span><b>${markup(s.total.value)}</b></div>` : ''}
          ${s.note ? `<div class="rc-note">${markup(s.note)}</div>` : ''}<div class="rc-edge"></div>
          ${s.stamp ? `<div class="rc-stamp">${markup(s.stamp)}</div>` : ''}</div></div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const paper = $('.rc-paper', el), n = s.items.length, end = .75 + n * .26 + .3;
        $('.rc', el).style.opacity = prog(t, .1, .3);
        const k = E.outCubic(prog(t, .25, end));
        paper.style.clipPath = `inset(0 -40px ${(1 - k) * 100}% -40px)`;
        paper.style.transform = `translateY(${(k - 1) * 120}px)`;
        $$('.rc-row', el).forEach((r, i) => fadeUp(r, t, .7 + i * .26, .3, 8));
        const st = $('.rc-stamp', el);
        if (st) { const a = end + .2, sk = E.outBack(prog(t, a, a + .35)); st.style.opacity = prog(t, a, a + .1); st.style.transform = `rotate(-14deg) scale(${lerp(2.2, 1, sk)})`; }
      },
    },

    timeline: {
      cues: s => s.items.map((_, i) => ({ t: tlAt(i, s.items.length) + .05, kind: 'click' })),
      build: s => `${head(s, 'tl-head')}<div class="tl"><i class="tl-line"><i></i></i>${s.items.map((it, i) => {
          const col = accents()[i % 3];
          return `<div class="tl-it ${i % 2 ? 'dn' : 'up'}${i === s.now ? ' now' : ''}"><i class="tl-dot" style="border-color:${col}">${it.icon ? icon(it.icon, col, 30) : ''}</i>
            <div class="tl-card"><small style="color:${col}">${markup(it.date)}</small><b>${markup(it.title)}</b></div></div>`; }).join('')}</div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const n = s.items.length, pt = portrait();
        const k = E.inOutCubic(prog(t, .3, tlAt(n - 1, n) + .2));
        $('.tl-line > i', el).style.transform = pt ? `scaleY(${k})` : `scaleX(${k})`;
        $$('.tl-it', el).forEach((it, i) => {
          const pos = n === 1 ? .5 : i / (n - 1);
          if (pt) it.style.top = `${pos * 100}%`; else it.style.left = `${pos * 100}%`;
          const a = tlAt(i, n), dk = E.outBack(prog(t, a, a + .4));
          $('.tl-dot', it).style.transform = `translate(-50%, -50%) scale(${dk})`;
          const card = $('.tl-card', it); card.style.opacity = prog(t, a + .1, a + .3);
          card.style.translate = pt ? `${(1 - E.outCubic(prog(t, a + .1, a + .5))) * 30}px 0` : `0 ${(1 - E.outCubic(prog(t, a + .1, a + .5))) * (i % 2 ? -30 : 30)}px`;
          if (i === s.now) $('.tl-dot', it).style.boxShadow = `0 0 0 ${8 + Math.sin(t * 5) * 6}px ${tint(C().accent, 30 * prog(t, a + .4, a + .7))}`;
        });
      },
    },

    phoneStack: {
      cues: () => [{ t: .35, kind: 'swish', gain: -4 }],
      build: s => `${head(s, 'ps-head')}<div class="ps">${s.phones.slice(0, 3).map((p, i) => `<div class="ps-ph p${i}"><div class="ps-scr">${imgOr(p.image, i)}</div><i class="notch"></i></div>`).join('')}</div>
        <div class="ps-caps">${s.phones.slice(0, 3).map((p, i) => `<div class="ps-cap c${i}">${p.caption ? markup(p.caption) : ''}</div>`).join('')}</div>`,
      update(el, t, d) {
        animHead(el, t);
        const pt = portrait(), sp = pt ? 300 : 380, k = E.outQuint(prog(t, .2, 1.0));
        $$('.ps-ph', el).forEach((p, i) => {
          const o = [-1, 0, 1][i], back = Math.abs(o);
          p.style.opacity = prog(t, .2, .4);
          p.style.zIndex = 3 - back;
          p.style.transform = `translateX(-50%) translateX(${o * sp * k}px) translateY(${back * 40 * k + (1 - k) * 120}px) rotate(${o * 7 * k}deg) scale(${1 - back * .1})`;
          const im = $('.ps-scr > *', p); // slow scroll down the screenshot, staggered per phone
          if (im) im.style.objectPosition = `50% ${E.inOutCubic(prog(t, .9 + i * .2, d - .3)) * 100}%`;
        });
        $$('.ps-cap', el).forEach((c, i) => fadeUp(c, t, .9 + i * .12, .4, 14));
      },
    },

    spotlightGrid: {
      cues: (s, d) => s.picks.map((_, i) => ({ t: sgAt(i, s.picks.length, d) + .1, kind: 'swish', gain: -6 })),
      build: s => `${head(s, 'sg-head')}<div class="sg"><div class="sg-grid">${s.tiles.slice(0, 9).map((tl, i) => `<div class="sg-t">${imgOr(tl.image, i)}${tl.title ? `<span>${markup(tl.title)}</span>` : ''}</div>`).join('')}</div>
        <div class="sg-dim"></div><i class="sg-ring"></i>${s.picks.map(p => `<div class="sg-cap">${markup(p.caption || '')}</div>`).join('')}</div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const box = $('.sg', el), tiles = $$('.sg-t', el);
        $$('.sg-t', el).forEach((tl, i) => { tl.style.opacity = prog(t, .1 + i * .04, .35 + i * .04); });
        box.style.opacity = 1;
        const centre = i => { const tl = tiles[s.picks[i].index] || tiles[0]; return [tl.offsetLeft + tl.offsetWidth / 2, tl.offsetTop + tl.offsetHeight / 2]; };
        const n = s.picks.length; let x, y, cur = 0;
        [x, y] = centre(0);
        for (let i = 1; i < n; i++) { const a = sgAt(i, n, d), m = E.inOutCubic(prog(t, a - .45, a)); const [x1, y1] = centre(i); x = lerp(x, x1, m); y = lerp(y, y1, m); if (t >= a - .2) cur = i; }
        const rad = (portrait() ? 190 : 170) * E.outBack(prog(t, .55, 1.0)), on = prog(t, .5, .8);
        const dim = $('.sg-dim', el);
        dim.style.opacity = .82 * on;
        dim.style.webkitMaskImage = dim.style.maskImage = `radial-gradient(circle ${Math.max(1, rad)}px at ${x}px ${y}px, transparent 96%, #000 100%)`;
        const ring = $('.sg-ring', el); ring.style.opacity = on; ring.style.width = ring.style.height = `${rad * 2}px`; ring.style.transform = `translate(${x - rad}px, ${y - rad}px)`;
        $$('.sg-cap', el).forEach((c, i) => {
          const a = i ? sgAt(i, n, d) : .9, shown = i === cur;
          c.style.opacity = shown ? prog(t, a - .05, a + .2) : 0;
          c.style.transform = `translate(${x}px, ${y + rad + 18}px) translateX(-50%) translateY(${shown ? (1 - E.outCubic(prog(t, a - .05, a + .3))) * 14 : 14}px)`;
        });
      },
    },

    stopwatch: {
      cues: (s, d) => [...Array.from({ length: 8 }, (_, i) => ({ t: .55 + i * .2, kind: 'type', gain: -4 })), { t: 2.25, kind: 'tick' }],
      build: s => `${head(s, 'sw-head')}<div class="sw"><i class="sw-crown"></i><i class="sw-btn"></i><div class="sw-face">
          <svg viewBox="-100 -100 200 200">${Array.from({ length: 60 }, (_, i) => `<line x1="0" y1="${i % 5 ? -86 : -80}" x2="0" y2="-92" transform="rotate(${i * 6})" stroke="rgba(255,255,255,${i % 5 ? .25 : .7})" stroke-width="${i % 5 ? 1.2 : 2.6}"/>`).join('')}
            <circle class="sw-arc" r="70" fill="none" stroke="${C().accent}" stroke-width="10" pathLength="1" transform="rotate(-90)"/></svg>
          <i class="sw-hand"></i><i class="sw-hub"></i><div class="sw-read">0</div>
          <div class="sw-done">${icon('check', C().accent2, portrait() ? 64 : 56)}<b>${markup(s.result || '')}</b></div></div></div>
        ${s.caption ? `<div class="sw-cap" data-split>${markup(s.caption)}</div>` : ''}`,
      update(el, t, d, s) {
        animHead(el, t);
        const box = $('.sw', el), k = E.outBack(prog(t, .1, .6)); box.style.opacity = prog(t, .1, .25); box.style.transform = `scale(${lerp(.8, 1, k)})`;
        const run = E.inOutCubic(prog(t, .5, 2.2)), secs = s.seconds || 60;
        $('.sw-hand', el).style.transform = `translate(-50%, -100%) rotate(${run * 360}deg)`;
        $('.sw-arc', el).style.strokeDasharray = `${run} 1`;
        const read = $('.sw-read', el); read.textContent = Math.round(run * secs); read.style.opacity = s.result ? 1 - prog(t, 2.2, 2.35) : 1;
        const done = $('.sw-done', el), dk = E.outBack(prog(t, 2.25, 2.7)); done.style.opacity = s.result ? prog(t, 2.25, 2.4) : 0; done.style.transform = `translate(-50%, -50%) scale(${lerp(.5, 1, dk)})`;
        $('.sw-btn', el).style.transform = `translateX(-50%) translateY(${t > 2.15 && t < 2.3 ? 8 : 0}px)`;
        const cap = $('.sw-cap', el); if (cap) words(cap, t, 2.4, .06, .5);
      },
    },

    split3: {
      cues: () => [0, 1, 2].map(i => ({ t: .1 + i * .18, kind: 'swish', gain: -5 })),
      build: s => `<div class="s3">${s.panels.slice(0, 3).map((p, i) => `<div class="s3-p"><div class="s3-img">${imgOr(p.image, i + 3)}</div><div class="s3-shade"></div>
          <div class="s3-txt"><b data-fit>${markup(p.word)}</b>${p.sub ? `<small>${markup(p.sub)}</small>` : ''}</div></div>`).join('')}</div>
        ${s.line ? `<div class="s3-line" data-split>${markup(s.line)}</div>` : ''}`,
      update(el, t, d, s) {
        const pt = portrait();
        $$('.s3-p', el).forEach((p, i) => {
          const a = .05 + i * .18, k = E.outQuint(prog(t, a, a + .7)), dir = i % 2 ? 1 : -1;
          p.style.clipPath = 'inset(0)';
          p.style.transform = pt ? `translateX(${dir * (1 - k) * 110}%)` : `translateY(${dir * (1 - k) * 110}%)`;
          const im = $('.s3-img > *', p); if (im) im.style.transform = `scale(${lerp(1.18, 1.05, prog(t, a, d))})`;
          fadeUp($('.s3-txt', p), t, a + .45, .45, 24);
        });
        const ln = $('.s3-line', el); if (ln) { const a = d - 1.4; popIn(ln, t, a, .5, .85); words(ln, t, a + .08, .06, .45); }
      },
    },

    ticket: {
      cues: () => [{ t: .2, kind: 'whoosh', gain: -4 }, { t: 1.35, kind: 'swish', gain: -2 }, { t: 1.75, kind: 'tick' }],
      build: s => `${head(s, 'tk-head')}<div class="tk"><div class="tk-main"><div class="tk-top">${logo('tk-mark')}<span class="label">${markup(B().name)}</span></div>
          <b class="tk-ev">${markup(s.event)}</b><div class="tk-meta"><span>${icon('calendar', C().accent2, 30)}${markup(s.date)}</span>${s.time ? `<span>${icon('clock', C().accent2, 30)}${markup(s.time)}</span>` : ''}${s.place ? `<span>${icon('globe', C().accent2, 30)}${markup(s.place)}</span>` : ''}</div>
</div>
          <div class="tk-stub"><div class="tk-bars">${Array.from({ length: 26 }, (_, i) => `<i style="width:${(2 + seeded(i + 3) * 7).toFixed(1)}px"></i>`).join('')}</div><small>${markup(s.code || 'ADMIT ONE')}</small></div>${s.stamp ? `<div class="tk-stamp">${markup(s.stamp)}</div>` : ''}</div>`, // stamp outside the masked ticket so it can overlap the edge
      update(el, t, d) {
        animHead(el, t);
        const tk = $('.tk', el), k = E.outQuint(prog(t, .05, .75));
        tk.style.opacity = prog(t, .05, .2);
        tk.style.transform = `translateX(${(1 - k) * 500}px) rotate(${(1 - k) * 12 - 3}deg)`;
        const tear = E.inOutCubic(prog(t, 1.2, 1.7)), stub = $('.tk-stub', el);
        stub.style.transform = portrait() ? `translate(${tear * 30}px, ${tear * 60}px) rotate(${tear * 9}deg)` : `translate(${tear * 70}px, ${tear * 40}px) rotate(${tear * 10}deg)`;
        const st = $('.tk-stamp', el);
        if (st) { const sk = E.outBack(prog(t, 1.7, 2.05)); st.style.opacity = prog(t, 1.7, 1.8); st.style.transform = `rotate(-12deg) scale(${lerp(2.3, 1, sk)})`; }
      },
    },

    magnifier: {
      cues: (s, d) => s.stops.map((_, i) => ({ t: mgAt(i, s.stops.length, d) + .05, kind: 'swish', gain: -7 })),
      build: s => `${head(s, 'mg-head')}<div class="mg">${window.Kit.img(s.image, 'mg-img')}<div class="mg-lens"><div class="mg-zoom" style="background-image:url('${window.Kit.src(s.image)}')"></div></div>
        ${s.stops.map(st => `<div class="mg-cap">${markup(st.caption || '')}</div>`).join('')}</div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const box = $('.mg', el), k = E.outQuint(prog(t, .1, .7)); box.style.opacity = prog(t, .1, .3); box.style.transform = `translateY(${(1 - k) * 60}px)`;
        const W = box.clientWidth, H = box.clientHeight, n = s.stops.length, z = s.zoom || 2.4, R = portrait() ? 170 : 150;
        let x = s.stops[0].x, y = s.stops[0].y, cur = 0;
        for (let i = 1; i < n; i++) { const a = mgAt(i, n, d), m = E.inOutCubic(prog(t, a - .55, a)); x = lerp(x, s.stops[i].x, m); y = lerp(y, s.stops[i].y, m); if (t >= a - .15) cur = i; }
        const px = x / 100 * W, py = y / 100 * H, lens = $('.mg-lens', el), lk = E.outBack(prog(t, .6, 1.0));
        lens.style.opacity = prog(t, .6, .75);
        lens.style.width = lens.style.height = `${R * 2}px`;
        lens.style.transform = `translate(${px - R}px, ${py - R}px) scale(${lk})`;
        // the screenshot is object-fit: cover, pinned to the top: zoom the same drawn image, not the box
        const im = $('.mg-img', el), nw = im.naturalWidth || W, nh = im.naturalHeight || H, sc = Math.max(W / nw, H / nh), dw = nw * sc, dh = nh * sc, ox = (W - dw) / 2;
        const zm = $('.mg-zoom', el);
        zm.style.backgroundSize = `${dw * z}px ${dh * z}px`;
        zm.style.backgroundPosition = `${R + 8 - (px - ox) * z}px ${R + 8 - py * z}px`;
        $$('.mg-cap', el).forEach((c, i) => {
          const a = i ? mgAt(i, n, d) : 1.0, on = i === cur;
          c.style.opacity = on ? prog(t, a, a + .2) : 0;
          const right = px < W * .62;
          c.style.transform = `translate(${right ? px + R + 24 : px - R - 24}px, ${py}px) translate(${right ? 0 : -100}%, -50%)`;
        });
      },
    },

    flow: {
      cues: s => s.nodes.map((_, i) => ({ t: flAt(i) + .05, kind: 'click' })),
      build: s => `${head(s, 'fl-head')}<div class="fl">${s.nodes.map((nd, i) => {
          const col = accents()[i % 3];
          return `${i ? `<div class="fl-link"><i class="fl-ln"></i>${[0, 1, 2].map(() => `<i class="fl-pk" style="background:${C().accent2}"></i>`).join('')}</div>` : ''}
            <div class="fl-node"><span class="ic" style="background:${tint(col, 16)};border-color:${tint(col, 55)}">${icon(nd.icon, col, portrait() ? 64 : 56)}</span><span class="fl-t"><b>${markup(nd.title)}</b>${nd.sub ? `<small>${markup(nd.sub)}</small>` : ''}</span></div>`; }).join('')}</div>`,
      update(el, t, d, s) {
        animHead(el, t);
        const pt = portrait();
        $$('.fl-node', el).forEach((nd, i) => { const a = flAt(i), k = E.outBack(prog(t, a, a + .45)); nd.style.opacity = prog(t, a, a + .12); nd.style.transform = `scale(${lerp(.6, 1, k)})`; });
        $$('.fl-link', el).forEach((ln, i) => {
          const a = flAt(i) + .25, k = E.inOutCubic(prog(t, a, flAt(i + 1)));
          $('.fl-ln', ln).style.transform = pt ? `scaleY(${k})` : `scaleX(${k})`;
          $$('.fl-pk', ln).forEach((p, j) => {
            const u = ((t - flAt(i + 1) - j * .33) % 1 + 1) % 1, live = t > flAt(i + 1) + j * .33;
            p.style.opacity = live ? Math.sin(Math.PI * u) : 0;
            if (pt) p.style.top = `${u * 100}%`; else p.style.left = `calc(40px + (100% - 80px) * ${u.toFixed(4)})`; // ride the drawn line
          });
        });
      },
    },
  });

  // shared timings
  function tlAt(i, n) { return .45 + i * Math.min(.45, 1.8 / Math.max(1, n - 1)); }
  // the gap between picks/stops shrinks when they would not fit: the last one lands >= .6 s before the end
  function sgAt(i, n, d) { return i === 0 ? .55 : .9 + i * Math.max(.5, Math.min(1.05, (d - 1.5) / Math.max(1, n - 1))); }
  function mgAt(i, n, d) { return i === 0 ? .6 : .8 + i * Math.max(.6, Math.min(1.15, (d - 1.4) / Math.max(1, n - 1))); }
  function flAt(i) { return .35 + i * .42; }
})();
