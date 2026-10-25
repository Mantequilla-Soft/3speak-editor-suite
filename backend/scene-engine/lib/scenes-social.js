// Social-app scene types (both orientations), registered into window.KitScenes next to lib/scenes.js and
// lib/scenes-more.js. Styles: lib/scenes-social.css. Load after lib/scenes-more.js and before Kit.run.
//
//   compose   a post composer: text types itself, tool pills pop, optional photo attaches, Post is pressed, then the
//             posted card collects reactions (counters tick up, hearts float)
//             { label?, lines[], text, avatar?, handle?, image?, tools?: [label], button?, reactions?: [{ icon, value }] }
//   profile   a person spotlight: avatar with a drawing accent ring, name, @handle, role, chips
//             { label?, avatar, name, handle?, role?, chips?: [text] }   (real people only, with their public avatar)
//
// Sound cues (subtle: the owner wants slight sounds that underline the motion, never on top of the music):
// compose = soft 'type' ticks while the text types, a 'click' on Post, a 'tick' as the reactions land;
// profile = a 'tick' as the ring closes and quiet 'click's as the chips pop.
(function () {
  const { prog, lerp, E, $, $$, markup, words, fadeUp, popIn } = window.Reel;
  const icon = (...a) => window.Kit.icon(...a);
  const C = () => window.REEL.brand.colors;
  const B = () => window.REEL.brand;
  const portrait = () => window.REEL.height > window.REEL.width;
  const lines = (arr = [], tag = 'h1') => arr.map(l => `<${tag} data-split>${markup(l)}</${tag}>`).join('');
  const label = s => s ? `<div class="label">${markup(s)}</div>` : '';
  const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
  const head = s => `<div class="xhead">${label(s.label)}${lines(s.lines)}</div>`;
  const animHead = (el, t, at = .05) => { fadeUp($('.xhead .label', el), t, at, .4, 20); words($('.xhead', el), t, at + .05, .08, .5); };
  const avatarHtml = (src, cls) => src ? `${window.Kit.img(src, cls)}`
    : `<div class="${cls} monogram">${B().logo ? `${window.Kit.img(B().logo)}` : window.Kit.esc(B().monogram || (B().name || '?')[0])}</div>`;

  // compose timing, shared by build/update/cues so sounds land on the motion
  const composeT = (s, d) => {
    const n = [...(s.text || '')].length, t0 = .75, typeDur = Math.min(1.7, n * .045);
    const post = Math.max(t0 + typeDur + .55, d - 1.55);
    return { n, t0, typeDur, typeEnd: t0 + typeDur, post };
  };

  Object.assign(window.KitScenes = window.KitScenes || {}, {
    compose: {
      build(s) {
        const tools = (s.tools || []).map(x => `<span class="cp-tool">${markup(x)}</span>`).join('');
        const reacts = (s.reactions || [])
          .map(r => `<span class="cp-react">${icon(r.icon, C().accent, portrait() ? 40 : 34)}<b data-to="${r.value}">0</b></span>`).join('');
        return `${head(s)}<div class="cp">
            <div class="cp-top">${avatarHtml(s.avatar, 'cp-av')}<span class="cp-handle">${markup(s.handle || '@you')}</span><i class="cp-time">now</i></div>
            <div class="cp-text"><span class="cp-typed"></span><i class="cp-caret"></i></div>
            ${s.image ? `<div class="cp-img">${window.Kit.img(s.image)}</div>` : ''}
            <div class="cp-bar"><div class="cp-tools">${tools}</div><span class="cp-btn">${markup(s.button || 'Post')}</span></div>
            <div class="cp-reacts">${reacts}</div>
            <i class="cp-ripple"></i>
            ${[0, 1, 2].map(i => `<i class="cp-heart h${i}">${icon('heart', C().accent, portrait() ? 46 : 40)}</i>`).join('')}
          </div>`;
      },
      cues(s, d) {
        const T = composeT(s, d), out = [];
        for (let t = T.t0 + .05; t < T.typeEnd; t += .2) out.push({ t, kind: 'type', gain: -7 });
        out.push({ t: T.post + .12, kind: 'click', gain: -4 });
        out.push({ t: T.post + .75, kind: 'tick', gain: -8 });
        return out;
      },
      update(el, t, d, s) {
        animHead(el, t);
        const T = composeT(s, d), card = $('.cp', el);
        const cin = E.outQuint(prog(t, .15, .75));
        // after posting the card lifts a little, as if it joined the feed
        const lift = E.inOutCubic(prog(t, T.post + .2, T.post + .65));
        card.style.opacity = prog(t, .15, .4);
        card.style.transform = `translateY(${(1 - cin) * 70 - lift * 24}px) scale(${lerp(.94, 1, cin)})`;
        // typing, character by character, caret blinks only while idle
        const chars = [...(s.text || '')], shown = Math.floor(chars.length * prog(t, T.t0, T.typeEnd));
        $('.cp-typed', el).textContent = chars.slice(0, shown).join('');
        const typing = t >= T.t0 && t < T.typeEnd;
        $('.cp-caret', el).style.opacity = t < T.post + .2 && (typing || Math.floor(t * 2.4) % 2 === 0) ? 1 : 0;
        // photo attaches right after the text
        const img = $('.cp-img', el);
        // (the card grows to make room: no empty gap while the text is still typing)
        if (img) {
          const g = E.outCubic(prog(t, T.typeEnd, T.typeEnd + .4)), x = E.outBack(prog(t, T.typeEnd + .05, T.typeEnd + .5));
          img.style.maxHeight = `${g * (portrait() ? 380 : 300)}px`; img.style.marginTop = `${g * 24}px`;
          img.style.opacity = prog(t, T.typeEnd + .05, T.typeEnd + .2); img.style.transform = `scale(${lerp(.85, 1, x)})`;
        }
        $$('.cp-tool', el).forEach((p, i) => popIn(p, t, .55 + i * .08, .35, .7));
        // Post: press + ripple, then the bar gives way to the reactions
        const btn = $('.cp-btn', el), press = prog(t, T.post, T.post + .12) * (1 - prog(t, T.post + .12, T.post + .3));
        popIn(btn, t, .9, .35, .7);
        if (t > T.post) btn.style.transform = `scale(${1 - press * .12})`;
        const rip = $('.cp-ripple', el), rp = prog(t, T.post + .1, T.post + .6);
        const bb = btn.getBoundingClientRect(), cb = card.getBoundingClientRect();
        rip.style.left = `${bb.left - cb.left + bb.width / 2}px`; rip.style.top = `${bb.top - cb.top + bb.height / 2}px`;
        rip.style.opacity = rp > 0 && rp < 1 ? (1 - rp) * .6 : 0;
        rip.style.transform = `translate(-50%, -50%) scale(${.3 + rp * 3})`;
        const swap = prog(t, T.post + .3, T.post + .55);
        $('.cp-bar', el).style.opacity = 1 - swap;
        const rs = $('.cp-reacts', el);
        rs.style.opacity = swap;
        $$('.cp-react b', rs).forEach((b, i) => { const x = E.outCubic(prog(t, T.post + .45 + i * .1, T.post + 1.2 + i * .1)); b.textContent = Math.round(+b.dataset.to * x); });
        $$('.cp-heart', el).forEach((h, i) => {
          const a = T.post + .5 + i * .18, k = prog(t, a, a + .9);
          h.style.opacity = k > 0 && k < 1 ? Math.sin(k * Math.PI) : 0;
          h.style.transform = `translate(${Math.sin((k + i) * 5) * 16}px, ${-k * (portrait() ? 150 : 120)}px) scale(${lerp(.6, 1.1, k)})`;
        });
      },
    },

    profile: {
      build: s => `<div class="pf">
          <div class="pf-av">${avatarHtml(s.avatar, 'pf-img')}
            <svg class="pf-ring" viewBox="0 0 400 400"><circle cx="200" cy="200" r="190" fill="none" stroke="${C().accent}" stroke-width="7" stroke-linecap="round"/>
              <circle class="pf-ring2" cx="200" cy="200" r="190" fill="none" stroke="${C().accent2}" stroke-width="7" stroke-linecap="round"/></svg></div>
          <div class="pf-copy">${label(s.label)}<h1 class="pf-name" data-split>${markup(s.name)}</h1>
            ${s.handle ? `<div class="pf-handle">${markup(s.handle)}</div>` : ''}
            ${s.role ? `<div class="pf-role" data-split>${markup(s.role)}</div>` : ''}
            <div class="pf-chips">${(s.chips || []).map(c => `<span class="pf-chip">${markup(c)}</span>`).join('')}</div></div>
        </div>`,
      cues: s => [{ t: 1.15, kind: 'tick', gain: -7 }, ...(s.chips || []).map((_, i) => ({ t: 1.35 + i * .14, kind: 'click', gain: -12 }))],
      update(el, t, d, s) {
        const av = $('.pf-av', el), x = E.outBack(prog(t, .05, .65));
        av.style.opacity = prog(t, .05, .25);
        av.style.transform = `scale(${lerp(.6, 1, x)})`;
        $('.pf-img', el).style.transform = `scale(${lerp(1.12, 1, E.outCubic(prog(t, 0, d)))})`;
        const c = 2 * Math.PI * 190, r1 = $('.pf-ring circle', el), r2 = $('.pf-ring2', el);
        const k1 = E.inOutCubic(prog(t, .2, 1.15)), k2 = E.inOutCubic(prog(t, .45, 1.2));
        r1.setAttribute('stroke-dasharray', `${c * k1} ${c}`);
        r2.setAttribute('stroke-dasharray', `${c * .18 * k2} ${c}`);
        $('.pf-ring', el).style.transform = `rotate(${-90 + t * 22}deg)`;
        r2.setAttribute('transform', `rotate(${150 + t * 40} 200 200)`);
        fadeUp($('.pf-copy .label', el), t, .4, .4, 20);
        words($('.pf-copy', el), t, .5, .07, .5);
        fadeUp($('.pf-handle', el), t, .85, .4, 16);
        $$('.pf-chip', el).forEach((ch, i) => popIn(ch, t, 1.3 + i * .14, .4, .7));
      },
    },
  });
})();
