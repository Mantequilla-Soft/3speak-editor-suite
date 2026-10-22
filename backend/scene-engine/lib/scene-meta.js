// Machine-readable catalogue of every scene type: role, readable duration, and the fields a UI may fill.
// Browser: window.SceneMeta. Node: require('./scene-meta.js'). Used by the Ad Wizard (forms, picker, checks)
// and by host/index.html + the render server (sanitize() before anything reaches the page).
//
// Field kinds
//   text      one line (markup: *accent* and _accent2_)         lines  list of headline lines (text)
//   texts     list of short strings (words, rows, chips)        para   longer text (sub, quote, code)
//   image     a picture: URL or { url, scale, x, y }           images list of pictures
//   number / int / bool / enum (options) / icon (Kit.ICONS)    color  CSS colour
//   list      list of objects ({ of: [fields] })                object one object ({ of: [fields] })
// Common keys: k (field name), kind, label (UI), opt (optional), min/max (items, or value range), maxLen (chars),
//   hint (UI help), adjust:false (image placement not offered).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SceneMeta = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ICONS = ['heart', 'coin', 'megaphone', 'check', 'chat', 'globe', 'star', 'play', 'arrow', 'lock', 'eye', 'shield', 'clock', 'calendar',
    'spark', 'mic', 'sliders', 'code', 'braces', 'wave'];

  // shorthand builders
  const F = (k, kind, extra = {}) => ({ k, kind, ...extra });
  const label = F('label', 'text', { opt: true, maxLen: 48, label: 'Small label' });
  const lines = (min = 1, max = 3) => F('lines', 'lines', { min, max, maxLen: 44, label: 'Headline lines' });
  const sub = F('sub', 'para', { opt: true, maxLen: 140, label: 'Sub line' });
  const line = F('line', 'text', { opt: true, maxLen: 90, label: 'Closing line' });
  const head = (min, max) => [label, lines(min, max)];
  const closer = [F('tagline', 'text', { opt: true, maxLen: 80, label: 'Tagline' }),
    F('cta', 'text', { opt: true, maxLen: 40, label: 'Call to action', hint: 'e.g. your URL' }), F('footer', 'text', { opt: true, maxLen: 80, label: 'Footer' })];
  const titleSub = (iconToo = true, imageToo = false) => [
    ...(imageToo ? [F('image', 'image', { opt: true })] : []),
    ...(iconToo ? [F('icon', 'icon', { opt: true })] : []),
    F('title', 'text', { maxLen: 48 }), F('sub', 'text', { opt: true, maxLen: 80 })];

  // role: opener | middle | closer. dur: [min readable, default]. orient: both unless noted.
  const TYPES = {
    // ---- lib/scenes.js
    words: { role: ['opener'], dur: [1.8, 2.6], desc: 'One huge word at a time, the last stays, then a line',
      fields: [label, F('words', 'texts', { min: 1, max: 5, maxLen: 16, label: 'Words' }), line, F('hold', 'number', { opt: true, min: .3, max: 4, label: 'Line hold (s)' })] },
    compare: { role: ['middle'], dur: [3, 3.8], desc: '"Elsewhere" panel with crosses, then "here" panel with checks',
      fields: [...head(1, 2), F('left', 'object', { of: [F('title', 'text', { maxLen: 32 }), F('items', 'texts', { min: 2, max: 4, maxLen: 40 })] }),
        F('right', 'object', { of: [F('title', 'text', { maxLen: 32 }), F('items', 'texts', { min: 2, max: 4, maxLen: 40 })] })] },
    steps: { role: ['middle'], dur: [3, 3.6], desc: 'Numbered steps joined by a drawing line',
      fields: [...head(1, 2), F('steps', 'list', { min: 2, max: 4, of: [F('title', 'text', { maxLen: 36 }), F('sub', 'text', { opt: true, maxLen: 60 })] })] },
    notify: { role: ['middle'], dur: [3, 3.6], desc: 'Phone notifications dropping in',
      fields: [...head(1, 2), F('items', 'list', { min: 2, max: 4, of: [F('icon', 'icon', { opt: true }), F('color', 'color', { opt: true }), F('title', 'text', { maxLen: 32 }),
        F('text', 'text', { maxLen: 80 }), F('time', 'text', { opt: true, maxLen: 12 })] })] },
    spotlight: { role: ['middle'], dur: [2.8, 3.4], desc: 'One picture as a card with slow zoom, name tag',
      fields: [...head(1, 2), F('image', 'image', { opt: true }), F('tag', 'object', { opt: true, of: [F('title', 'text', { maxLen: 40 }), F('sub', 'text', { opt: true, maxLen: 60 })] })] },
    quote: { role: ['middle'], dur: [3.5, 4.4], desc: 'Big quote word by word, attribution (real quotes only)',
      fields: [F('quote', 'para', { maxLen: 220 }), F('name', 'text', { maxLen: 40 }), F('handle', 'text', { opt: true, maxLen: 40 }), F('avatar', 'image', { opt: true })] },
    cards: { role: ['middle'], dur: [3, 3.6], desc: 'Feature cards fanning out of a stack',
      fields: [...head(1, 2), F('cards', 'list', { min: 3, max: 4, of: titleSub() })] },
    greetings: { role: ['opener', 'middle'], dur: [2.4, 3.2], desc: 'Cycles through words (any script), lands on the last',
      fields: [label, F('words', 'texts', { min: 2, max: 10, maxLen: 18 }), line, F('strip', 'text', { opt: true, maxLen: 60 }), F('hold', 'number', { opt: true, min: .3, max: 4 })] },

    // ---- lib/scenes-more.js
    heroSplit: { role: ['opener'], dur: [2.6, 3.2], desc: 'Photo on one half, headline on the other',
      fields: [F('image', 'image'), ...head(1, 3), sub] },
    heroSlides: { role: ['opener'], dur: [3, 3.8], desc: 'Photo carousel on one half, headline on the other',
      fields: [F('slides', 'list', { min: 3, max: 5, of: [F('image', 'image'), F('tag', 'text', { opt: true, maxLen: 30 })] }), ...head(1, 3), sub] },
    heroPoster: { role: ['opener'], dur: [2.2, 2.8], desc: 'Giant stacked words, alternating fill and accent',
      fields: [label, F('words', 'texts', { min: 2, max: 4, maxLen: 14 }), F('styles', 'texts', { opt: true, max: 4, options: ['fill', 'acc', 'soft'], label: 'Word styles' }), sub] },
    heroCollage: { role: ['opener'], dur: [2.8, 3.4], desc: 'Five polaroids drop into a pile, headline beside it',
      fields: [F('images', 'images', { min: 1, max: 5 }), ...head(1, 3), sub] },
    carousel: { role: ['middle'], dur: [3.5, 4.2], desc: 'Coverflow cards that advance by themselves (about 1 s per card)',
      fields: [...head(1, 2), F('items', 'list', { min: 3, max: 4, of: titleSub(true, true) })] },
    bento: { role: ['middle'], dur: [3.2, 3.8], desc: 'Mixed-size tile grid; tile 1 is big and can be a photo',
      fields: [...head(1, 2), F('tiles', 'list', { min: 5, max: 5, of: [F('image', 'image', { opt: true }), F('icon', 'icon', { opt: true }),
        F('value', 'text', { opt: true, maxLen: 10, label: 'Big value' }), F('title', 'text', { maxLen: 40 }), F('sub', 'text', { opt: true, maxLen: 60 })] })] },
    chat: { role: ['middle'], dur: [3.2, 3.8], desc: 'Message bubbles with typing dots (no made-up testimonials)',
      fields: [...head(1, 2), F('messages', 'list', { min: 2, max: 4, of: [F('from', 'enum', { options: ['them', 'me'] }), F('name', 'text', { opt: true, maxLen: 24 }),
        F('avatar', 'image', { opt: true }), F('text', 'text', { maxLen: 90 })] })] },
    stats: { role: ['middle'], dur: [3, 3.6], desc: '2 to 4 numbers counting up with colour bars (real numbers only)',
      fields: [...head(1, 2), F('items', 'list', { min: 2, max: 4, of: [F('value', 'number'), F('prefix', 'text', { opt: true, maxLen: 4 }), F('suffix', 'text', { opt: true, maxLen: 6 }),
        F('decimals', 'int', { opt: true, min: 0, max: 3 }), F('label', 'text', { maxLen: 40 }), F('locale', 'text', { opt: true, maxLen: 10, hint: 'de-DE' })] })] },
    marquee: { role: ['opener', 'middle'], dur: [2.4, 3], desc: 'Giant text rows scrolling in opposite directions, a line in front',
      fields: [label, F('rows', 'texts', { min: 2, max: 4, maxLen: 30 }), line, F('accentRow', 'int', { opt: true, min: 0, max: 3 })] },
    wipe: { role: ['middle'], dur: [3, 3.6], desc: 'Before/after card with a sweeping divider',
      fields: [...head(1, 2), ...['before', 'after'].map(k => F(k, 'object', { of: [F('title', 'text', { maxLen: 32 }), F('text', 'text', { opt: true, maxLen: 80 }), F('image', 'image', { opt: true })] }))] },
    offer: { role: ['middle'], dur: [3, 3.6], desc: 'Price card: old price struck, new price, badge, deadline',
      fields: [...head(1, 2), F('price', 'text', { maxLen: 14 }), F('unit', 'text', { opt: true, maxLen: 20 }), F('was', 'text', { opt: true, maxLen: 14 }),
        F('badge', 'text', { opt: true, maxLen: 14 }), F('until', 'text', { opt: true, maxLen: 30 }), F('note', 'text', { opt: true, maxLen: 70 })] },
    endPhoto: { role: ['closer'], dur: [2.6, 3.2], desc: 'Full-bleed photo, logo, tagline, CTA', fields: [F('image', 'image'), ...closer] },
    endPoster: { role: ['closer'], dur: [2.6, 3.2], desc: 'Giant stacked words, logo, CTA',
      fields: [F('words', 'texts', { min: 2, max: 4, maxLen: 14 }), F('styles', 'texts', { opt: true, max: 4, options: ['fill', 'acc', 'soft'] }), ...closer.slice(1)] },
    endSplit: { role: ['closer'], dur: [2.6, 3.2], desc: 'Photo half + logo, tagline, CTA', fields: [F('image', 'image'), ...closer] },
    endMosaic: { role: ['closer'], dur: [2.6, 3.2], desc: 'Dimmed wall of pictures behind a CTA card', fields: [F('images', 'images', { min: 1, max: 24 }), ...closer] },
    endMarquee: { role: ['closer'], dur: [2.8, 3.4], desc: 'Two benefit rows scrolling around logo and CTA',
      fields: [F('rows', 'texts', { min: 2, max: 2, maxLen: 40 }), ...closer] },
    heroWave: { role: ['opener'], dur: [2.8, 3.4], desc: 'Live waveform under a headline, optional track card',
      fields: [...head(1, 3), sub, F('track', 'object', { opt: true, of: [F('title', 'text', { maxLen: 40 }), F('artist', 'text', { opt: true, maxLen: 40 }), F('cover', 'image', { opt: true })] })] },
    endWave: { role: ['closer'], dur: [2.6, 3.2], desc: 'Waveform behind logo, tagline, CTA', fields: [...closer] },
    walkthrough: { role: ['middle'], dur: [3.6, 4.6], desc: 'A finger (portrait) or cursor (landscape) taps through real screens',
      fields: [...head(1, 2), F('url', 'text', { opt: true, maxLen: 60 }), F('steps', 'list', { min: 2, max: 4, of: [F('image', 'image', { adjust: false }),
        F('tap', 'object', { opt: true, hint: '[x%, y%] where the tap lands', of: [] }), F('caption', 'text', { opt: true, maxLen: 50 }),
        F('zoom', 'number', { opt: true, min: 1, max: 3 }), F('origin', 'object', { opt: true, hint: '[x%, y%] zoom centre (default: the tap point)', of: [] })] })] },
    lockscreen: { role: ['middle'], dur: [3.2, 3.8], desc: 'Phone shows the app, locks, a now-playing card keeps going',
      fields: [...head(1, 2), F('from', 'image', { opt: true, label: 'App screenshot' }), F('time', 'text', { opt: true, maxLen: 6 }), F('date', 'text', { opt: true, maxLen: 30 }),
        F('source', 'text', { opt: true, maxLen: 30 }), F('title', 'text', { opt: true, maxLen: 40 }), F('caption', 'text', { opt: true, maxLen: 60 })] },
    embedDemo: { role: ['middle'], dur: [3.6, 4.2], desc: 'Embed code types out, players appear in a blog post',
      fields: [...head(1, 2), F('code', 'para', { maxLen: 160 }), F('embeds', 'list', { min: 1, max: 3, of: [F('image', 'image', { opt: true }), F('label', 'text', { opt: true, maxLen: 30 })] }),
        F('post', 'object', { opt: true, of: [F('title', 'text', { maxLen: 50 })] }), F('site', 'text', { opt: true, maxLen: 40 })] },

    // ---- lib/scenes-extra.js
    deck: { role: ['opener', 'middle'], dur: [3.6, 4.2], desc: 'Cards dealt off a stack, flipped into a fan',
      fields: [...head(1, 2), F('cards', 'list', { min: 3, max: 5, of: titleSub(true, true) })] },
    sleeve: { role: ['opener'], dur: [3, 3.6], desc: 'Album cover slides in, a vinyl slides out and spins',
      fields: [F('cover', 'image'), F('title', 'text', { opt: true, maxLen: 40 }), F('artist', 'text', { opt: true, maxLen: 40 }), ...head(1, 2), sub] },
    adSpot: { role: ['middle'], dur: [4, 4.6], desc: 'A video player shows a spot, a ticker and a banner',
      fields: [...head(1, 2), F('video', 'image', { label: 'Video still' }), F('spot', 'object', { of: [F('image', 'image', { opt: true }), F('title', 'text', { maxLen: 30 }),
        F('sub', 'text', { opt: true, maxLen: 40 }), F('cta', 'text', { opt: true, maxLen: 20 })] }), F('ticker', 'text', { maxLen: 70 }),
        F('banner', 'object', { of: [F('image', 'image', { opt: true }), F('title', 'text', { opt: true, maxLen: 30 }), F('sub', 'text', { opt: true, maxLen: 40 })] }),
        F('formats', 'list', { min: 3, max: 3, of: titleSub() })] },
    tabs: { role: ['opener', 'middle'], dur: [3.6, 4.4], desc: 'A browser flips through real pages as tabs',
      fields: [...head(1, 2), sub, F('tabs', 'list', { min: 2, max: 4, of: [F('title', 'text', { maxLen: 24 }), F('image', 'image', { adjust: false }), F('url', 'text', { opt: true, maxLen: 50 }),
        F('chip', 'text', { opt: true, maxLen: 40 }), F('icon', 'image', { opt: true, label: 'Favicon' })] })] },
    growth: { role: ['middle'], dur: [3, 3.6], desc: 'An upward curve with "+1" bubbles and a Join pill (illustration, no numbers)',
      fields: [...head(1, 2), sub, F('bubbles', 'int', { opt: true, min: 1, max: 8 }), F('join', 'text', { opt: true, maxLen: 16 })] },
    frontends: { role: ['middle'], dur: [3.6, 4.2], desc: 'Browser windows cascade in, each another site with the same banner',
      fields: [...head(1, 2), sub, F('sites', 'list', { min: 3, max: 5, of: [F('url', 'text', { maxLen: 40 }), F('video', 'image', { label: 'Player still' }), F('tag', 'text', { opt: true, maxLen: 20 })] }),
        F('banner', 'image', { opt: true })] },

    // ---- lib/scenes-extra2.js
    map: { role: ['middle'], dur: [3.2, 3.8], desc: 'Dotted world map, pins drop at real places, arcs fly',
      fields: [...head(1, 2), F('pins', 'list', { min: 1, max: 8, of: [F('lon', 'number', { min: -180, max: 180 }), F('lat', 'number', { min: -90, max: 90 }), F('label', 'text', { opt: true, maxLen: 24 })] }),
        F('caption', 'text', { opt: true, maxLen: 60 })] },
    receipt: { role: ['middle'], dur: [3.2, 3.8], desc: 'A slip prints line by line, a total, a stamp (real values only)',
      fields: [...head(1, 2), F('title', 'text', { opt: true, maxLen: 30 }), F('items', 'list', { min: 2, max: 5, of: [F('name', 'text', { maxLen: 30 }), F('value', 'text', { maxLen: 14 })] }),
        F('total', 'object', { opt: true, of: [F('name', 'text', { maxLen: 20 }), F('value', 'text', { maxLen: 14 })] }), F('stamp', 'text', { opt: true, maxLen: 14 }), F('note', 'text', { opt: true, maxLen: 60 })] },
    timeline: { role: ['middle'], dur: [3.4, 4], desc: 'A line draws itself, milestones pop, "now" pulses',
      fields: [...head(1, 2), F('items', 'list', { min: 3, max: 5, of: [F('date', 'text', { maxLen: 14 }), F('title', 'text', { maxLen: 36 }), F('icon', 'icon', { opt: true })] }),
        F('now', 'int', { opt: true, min: 0, max: 4, label: 'Index of "now"' })] },
    phoneStack: { role: ['middle'], dur: [3.4, 4], desc: 'Three phones fan in, each scrolls its own tall screenshot',
      fields: [...head(1, 2), F('phones', 'list', { min: 3, max: 3, of: [F('image', 'image', { adjust: false, hint: 'tall mobile screenshot' }), F('caption', 'text', { opt: true, maxLen: 24 })] })] },
    spotlightGrid: { role: ['middle'], dur: [3.6, 4.2], desc: 'Dimmed 3x3 grid, a round spotlight glides from pick to pick',
      fields: [...head(1, 2), F('tiles', 'list', { min: 9, max: 9, of: [F('image', 'image', { opt: true }), F('title', 'text', { opt: true, maxLen: 24 })] }),
        F('picks', 'list', { min: 1, max: 4, of: [F('index', 'int', { min: 0, max: 8 }), F('caption', 'text', { maxLen: 40 })] })] },
    stopwatch: { role: ['middle'], dur: [3, 3.6], desc: 'A dial sweeps while the readout counts, snaps to a result',
      fields: [...head(1, 2), F('seconds', 'number', { min: 1, max: 3600 }), F('result', 'text', { opt: true, maxLen: 30 }), F('caption', 'text', { opt: true, maxLen: 60 })] },
    split3: { role: ['opener', 'middle'], dur: [2.8, 3.4], desc: 'Three full-height panels slide in, a word on each',
      fields: [F('panels', 'list', { min: 3, max: 3, of: [F('image', 'image', { opt: true }), F('word', 'text', { maxLen: 14 }), F('sub', 'text', { opt: true, maxLen: 30 })] }), line] },
    ticket: { role: ['middle'], dur: [3.2, 3.8], desc: 'An event ticket slides in, the stub tears off, a stamp lands',
      fields: [...head(1, 2), F('event', 'text', { maxLen: 40 }), F('date', 'text', { maxLen: 24 }), F('time', 'text', { opt: true, maxLen: 14 }), F('place', 'text', { opt: true, maxLen: 40 }),
        F('stamp', 'text', { opt: true, maxLen: 14 }), F('code', 'text', { opt: true, maxLen: 20 })] },
    magnifier: { role: ['middle'], dur: [3.4, 4], desc: 'A lens glides over a screenshot and enlarges details',
      fields: [...head(1, 2), F('image', 'image', { adjust: false }), F('stops', 'list', { min: 1, max: 4, of: [F('x', 'number', { min: 0, max: 100, label: 'x %' }), F('y', 'number', { min: 0, max: 100, label: 'y %' }),
        F('caption', 'text', { opt: true, maxLen: 40 })] }), F('zoom', 'number', { opt: true, min: 1.5, max: 4 })] },
    flow: { role: ['middle'], dur: [3.2, 3.8], desc: 'Nodes joined by drawing lines, dots travel along them',
      fields: [...head(1, 2), F('nodes', 'list', { min: 3, max: 5, of: titleSub() })] },

    // ---- lib/scenes-extra3.js
    countdown: { role: ['middle'], dur: [3, 3.6], desc: 'Split-flap cards flip down to the real value',
      fields: [...head(1, 2), F('units', 'list', { min: 2, max: 4, of: [F('value', 'int', { min: 0, max: 99 }), F('label', 'text', { maxLen: 10 })] }), F('caption', 'text', { opt: true, maxLen: 60 })] },
    poll: { role: ['middle'], dur: [3, 3.6], desc: 'A poll card: bars fill, the winner gets a check (real numbers only)',
      fields: [...head(1, 2), F('question', 'text', { maxLen: 60 }), F('options', 'list', { min: 2, max: 4, of: [F('text', 'text', { maxLen: 30 }), F('pct', 'number', { min: 0, max: 100 })] }),
        F('winner', 'int', { opt: true, min: 0, max: 3 })] },
    badge: { role: ['middle'], dur: [2.8, 3.4], desc: 'A medal drops in on a ribbon, rays turn, confetti',
      fields: [...head(1, 2), F('icon', 'icon'), F('title', 'text', { maxLen: 24 }), F('sub', 'text', { opt: true, maxLen: 40 })] },
    checklist: { role: ['middle'], dur: [3, 3.6], desc: 'Items tick off one by one, a counter and bar fill',
      fields: [...head(1, 2), F('title', 'text', { opt: true, maxLen: 30 }), F('items', 'texts', { min: 3, max: 6, maxLen: 40 })] },
    search: { role: ['middle'], dur: [3.2, 3.8], desc: 'A search box types the query, results drop in',
      fields: [...head(1, 2), F('query', 'text', { maxLen: 40 }), F('results', 'list', { min: 2, max: 4, of: titleSub() })] },
    calendar: { role: ['middle'], dur: [3.2, 3.8], desc: 'A month grid; active days light up, a streak counter runs',
      fields: [...head(1, 2), F('month', 'text', { maxLen: 20 }), F('days', 'int', { min: 28, max: 31 }), F('start', 'int', { min: 0, max: 6, hint: '0 = Monday' }),
        F('active', 'texts', { min: 0, max: 31, kindOf: 'int', hint: 'day numbers' }), F('streak', 'text', { opt: true, maxLen: 30 })] },
    cube: { role: ['opener', 'middle'], dur: [2.6, 3.2], desc: 'A 3D cube turns face by face, a word on each',
      fields: [label, F('faces', 'list', { min: 4, max: 4, of: [F('word', 'text', { maxLen: 18, hint: '| breaks a line' }), F('image', 'image', { opt: true })] }), line,
        F('step', 'number', { opt: true, min: .3, max: 1.5, label: 'Seconds per turn' })] },
    podium: { role: ['middle'], dur: [3.2, 3.8], desc: 'Three columns rise, avatars land, the winner gets a crown (real people, with permission)',
      fields: [...head(1, 2), F('places', 'list', { min: 3, max: 3, of: [F('name', 'text', { maxLen: 20 }), F('value', 'text', { opt: true, maxLen: 14 }), F('avatar', 'image', { opt: true })] })] },
    zoomReveal: { role: ['opener'], dur: [2.8, 3.4], desc: 'Starts deep inside a detail and pulls back to the whole picture',
      fields: [F('image', 'image', { adjust: false }), ...head(1, 2), F('from', 'object', { opt: true, of: [F('x', 'number', { min: 0, max: 100 }), F('y', 'number', { min: 0, max: 100 }), F('zoom', 'number', { min: 1, max: 12 })] }),
        F('tag', 'text', { opt: true, maxLen: 30 })] },
    kinetic: { role: ['opener'], dur: [2, 2.8], desc: 'Words slam in at different sizes and angles, then a line',
      fields: [F('words', 'texts', { min: 3, max: 6, maxLen: 14 }), line, F('step', 'number', { opt: true, min: .2, max: 1, label: 'Seconds between words' })] },
    videoRow: { role: ['middle'], dur: [3.2, 3.8], desc: 'Three video cards drop in, each shown whole at 16:9',
      fields: [label, F('lines', 'lines', { opt: true, min: 0, max: 2, maxLen: 44 }), F('items', 'list', { min: 3, max: 3, of: [F('image', 'image'), F('word', 'text', { maxLen: 14 }),
        F('sub', 'text', { opt: true, maxLen: 40 }), F('handle', 'text', { opt: true, maxLen: 24 }), F('duration', 'text', { opt: true, maxLen: 8 })] }), line,
        F('step', 'number', { opt: true, min: .2, max: 1 })] },

    // ---- lib/scenes-social.js
    compose: { role: ['middle'], dur: [3.6, 4.2], desc: 'A post composer types, posts, collects reactions',
      fields: [...head(1, 2), F('avatar', 'image', { opt: true }), F('handle', 'text', { opt: true, maxLen: 24 }), F('text', 'para', { maxLen: 160 }), F('image', 'image', { opt: true }),
        F('tools', 'texts', { opt: true, max: 4, maxLen: 20 }), F('button', 'text', { opt: true, maxLen: 14 }),
        F('reactions', 'list', { opt: true, max: 3, of: [F('icon', 'icon'), F('value', 'int', { min: 0, max: 999999 })] })] },
    profile: { role: ['middle'], dur: [2.8, 3.4], desc: 'A person spotlight: avatar ring, name, handle, chips (real people only)',
      fields: [label, F('avatar', 'image'), F('name', 'text', { maxLen: 30 }), F('handle', 'text', { opt: true, maxLen: 30 }), F('role', 'text', { opt: true, maxLen: 40 }),
        F('chips', 'texts', { opt: true, max: 4, maxLen: 24 })] },

    // ---- lib/scenes-template.js (from the templates)
    logo: { role: ['opener'], dur: [2.4, 3], desc: 'Logo with three drawn rings, letter-spaced wordmark', fields: [F('wordmark', 'text', { opt: true, maxLen: 20 })] },
    statement: { role: ['opener', 'middle'], dur: [2.4, 3], desc: 'Big multi-line statement', fields: head(1, 4) },
    wall: { role: ['opener', 'middle'], dur: [3, 3.6], desc: 'Tilted wall of pictures panning, headline over a shade',
      fields: [...head(1, 2), F('images', 'images', { opt: true, max: 28 }), F('highlight', 'texts', { opt: true, max: 4, kindOf: 'int', hint: 'tile numbers to lift' }),
        F('chips', 'texts', { opt: true, max: 4, maxLen: 20 })] },
    product: { role: ['middle'], dur: [3.4, 4], desc: 'Screenshot in a browser frame with feature chips',
      fields: [...head(1, 2), sub, F('screenshot', 'image', { opt: true, adjust: false }), F('url', 'text', { opt: true, maxLen: 50 }), F('features', 'list', { opt: true, max: 4, of: titleSub() })] },
    endcard: { role: ['closer'], dur: [2.6, 3.2], desc: 'Logo, name, tagline, CTA, footer',
      fields: [F('brand', 'text', { opt: true, maxLen: 30, label: 'Name (defaults to the brand)' }), ...closer] },
    hook: { role: ['opener'], dur: [2.4, 3], desc: 'Opening statement, readable by 0.5 s; optional picture marquee',
      fields: [...head(1, 4), sub, F('images', 'images', { opt: true, max: 12 }), F('badge', 'text', { opt: true, maxLen: 8 }), F('size', 'int', { opt: true, min: 60, max: 220, label: 'Headline size (px)' })] },
    stat: { role: ['middle'], dur: [2.8, 3.4], desc: 'A number counting up in a ring (real numbers only)',
      fields: [label, F('value', 'number'), F('prefix', 'text', { opt: true, maxLen: 4 }), F('suffix', 'text', { opt: true, maxLen: 6 }), F('max', 'number', { opt: true }),
        F('ring', 'number', { opt: true, min: 0, max: 1, label: 'Ring fill 0..1' }), F('decimals', 'int', { opt: true, min: 0, max: 3 }), F('caption', 'text', { opt: true, maxLen: 60 }),
        F('size', 'int', { opt: true, min: 60, max: 320 })] },
    phone: { role: ['middle'], dur: [3.2, 3.8], desc: 'Mobile screenshot in a phone frame with up to 4 chips',
      fields: [...head(1, 2), F('screenshot', 'image', { opt: true, adjust: false, hint: 'mobile screenshot' }), F('features', 'list', { opt: true, max: 4, of: titleSub() })] },
    points: { role: ['middle'], dur: [3, 3.6], desc: 'Headline and up to 4 icon rows', fields: [...head(1, 2), F('points', 'list', { min: 1, max: 4, of: titleSub() })] },
  };

  // Visual style, for filtering a picker: text = typography carries the scene; components = a UI piece or
  // widget (calendar, map, poll, chat...); images = the user's pictures or screenshots carry it.
  const STYLES = { text: 'Text', components: 'Components', images: 'Pictures' };
  const STYLE = {
    words: 'text', compare: 'text', steps: 'text', cards: 'text', quote: 'text', greetings: 'text', heroPoster: 'text',
    marquee: 'text', endPoster: 'text', endMarquee: 'text', kinetic: 'text', cube: 'text', statement: 'text', hook: 'text',
    points: 'text', logo: 'text', endcard: 'text', endWave: 'text', heroWave: 'components',
    notify: 'components', chat: 'components', stats: 'components', offer: 'components', receipt: 'components', timeline: 'components',
    stopwatch: 'components', ticket: 'components', flow: 'components', countdown: 'components', poll: 'components', badge: 'components',
    checklist: 'components', search: 'components', calendar: 'components', map: 'components', growth: 'components', compose: 'components',
    stat: 'components', podium: 'components', embedDemo: 'components',
    spotlight: 'images', heroSplit: 'images', heroSlides: 'images', heroCollage: 'images', carousel: 'images', bento: 'images', wipe: 'images',
    endPhoto: 'images', endSplit: 'images', endMosaic: 'images', walkthrough: 'images', lockscreen: 'images', deck: 'images', sleeve: 'images',
    adSpot: 'images', tabs: 'images', frontends: 'images', phoneStack: 'images', spotlightGrid: 'images', split3: 'images', magnifier: 'images',
    zoomReveal: 'images', videoRow: 'images', profile: 'images', wall: 'images', product: 'images', phone: 'images',
  };
  for (const t of Object.keys(TYPES)) TYPES[t].style = STYLE[t] || 'text';

  const SIZES = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] };

  // ---------- sanitising ----------
  const str = (v, max = 200) => (v == null ? '' : String(v)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
  const clampNum = (v, f, d) => { let n = +v; if (!Number.isFinite(n)) return d; if (f.kind === 'int') n = Math.round(n); if (f.min != null) n = Math.max(f.min, n); if (f.max != null) n = Math.min(f.max, n); return n; };
  const colorOk = c => typeof c === 'string' && c.length < 60 && /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/+-]+\)|transparent|[a-z]{3,20})$/i.test(c.trim());
  function image(v) {
    if (!v) return undefined;
    if (typeof v === 'string') return str(v, 2048);
    if (typeof v !== 'object' || !v.url) return undefined;
    const o = { url: str(v.url, 2048) };
    for (const k of ['scale', 'x', 'y']) if (v[k] != null && Number.isFinite(+v[k])) o[k] = +v[k];
    return o;
  }
  function value(f, v) {
    switch (f.kind) {
      case 'text': return v == null ? undefined : str(v, f.maxLen || 120);
      case 'para': return v == null ? undefined : str(v, f.maxLen || 400);
      case 'lines': case 'texts':
        if (!Array.isArray(v)) return v == null ? undefined : [f.kindOf === 'int' ? clampNum(v, { kind: 'int' }, 0) : str(v, f.maxLen || 60)];
        return v.slice(0, f.max || 12).map(x => f.kindOf === 'int' ? clampNum(x, { kind: 'int' }, 0) : str(x, f.maxLen || 60)).filter(x => !f.options || f.options.includes(x));
      case 'image': return image(v);
      case 'images': return Array.isArray(v) ? v.slice(0, f.max || 24).map(image).filter(Boolean) : undefined;
      case 'number': case 'int': return v == null || v === '' ? undefined : clampNum(v, f, undefined);
      case 'bool': return v == null ? undefined : !!v;
      case 'enum': return f.options.includes(v) ? v : undefined;
      case 'icon': return ICONS.includes(v) ? v : (v ? 'star' : undefined);
      case 'color': return colorOk(v) ? v.trim() : undefined;
      case 'object': {
        if (v == null || typeof v !== 'object') return undefined;
        if (!f.of.length) return Array.isArray(v) ? v.slice(0, 2).map(x => clampNum(x, { kind: 'number', min: 0, max: 100 }, 50)) : undefined; // walkthrough tap [x%, y%]
        return fieldsOf(f.of, v);
      }
      case 'list': return Array.isArray(v) ? v.slice(0, f.max || 12).filter(x => x && typeof x === 'object').map(x => fieldsOf(f.of, x)) : undefined;
      default: return undefined;
    }
  }
  function fieldsOf(fields, src) {
    const o = {};
    for (const f of fields) { const v = value(f, src[f.k]); if (v !== undefined) o[f.k] = v; }
    return o;
  }

  // Returns a clean copy of a doc: known scene types only, known fields only, strings capped, numbers clamped,
  // images reduced to { url, scale, x, y }. Throws nothing; dropped pieces are listed in doc._dropped.
  function sanitize(doc = {}) {
    const dropped = [];
    const W = clampNum(doc.width, { kind: 'int', min: 320, max: 3840 }, 1920), H = clampNum(doc.height, { kind: 'int', min: 320, max: 3840 }, 1080);
    const b = doc.brand || {}, c = b.colors || {};
    const colors = {};
    for (const k of ['bg', 'ink', 'mute', 'accent', 'accent2', 'accent3', 'glow1', 'glow2', 'glow3']) if (colorOk(c[k])) colors[k] = c[k].trim();
    const fontName = f => (typeof f === 'string' && /^[\w ]{1,40}$/.test(f) ? f : undefined);
    const brand = {
      name: str(b.name || 'Brand', 40),
      ...(b.monogram ? { monogram: str(b.monogram, 3) } : {}),
      ...(b.wordmark ? { wordmark: str(b.wordmark, 20) } : {}),
      ...(image(b.logo) ? { logo: image(b.logo) } : {}),
      ...(colorOk(b.logoBg) ? { logoBg: b.logoBg } : {}),
      ...(fontName(b.font) ? { font: b.font } : {}),
      ...(fontName(b.headFont) ? { headFont: b.headFont } : {}),
      colors,
    };
    const fonts = (Array.isArray(b.fonts) ? b.fonts : []).filter(f => typeof f === 'string' && /^[\w ]{1,40}(:[\w@;.,]{1,80})?$/.test(f)).slice(0, 6);
    const faces = (Array.isArray(b.fontFaces) ? b.fontFaces : []).filter(f => f && fontName(f.family) && f.url).slice(0, 8)
      .map(f => ({ family: f.family, url: str(f.url, 2048), weight: clampNum(f.weight, { kind: 'int', min: 100, max: 900 }, 400), style: f.style === 'italic' ? 'italic' : 'normal' }));
    if (fonts.length) brand.fonts = fonts; // left out when empty, so the runtime's default font set applies
    if (faces.length) brand.fontFaces = faces;
    const scenes = [];
    (Array.isArray(doc.scenes) ? doc.scenes : []).slice(0, 40).forEach((s, i) => {
      const m = s && TYPES[s.type];
      if (!m) { dropped.push(`scene ${i}: unknown type ${s && s.type}`); return; }
      scenes.push({ type: s.type, duration: clampNum(s.duration, { kind: 'number', min: .5, max: 30 }, m.dur[1]), ...fieldsOf(m.fields, s) });
    });
    const out = {
      width: W, height: H,
      fps: clampNum(doc.fps, { kind: 'int', min: 12, max: 60 }, 30),
      transition: clampNum(doc.transition, { kind: 'number', min: 0, max: 1 }, .25),
      brand, scenes,
      ...(doc.bug === false ? { bug: false } : {}),
      ...(doc.sfx === false ? { sfx: false } : {}),
      ...(doc.wordSfx === false ? { wordSfx: false } : {}),
      ...(doc.progress ? { progress: true } : {}),
      ...(typeof doc.locale === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(doc.locale) ? { locale: doc.locale } : {}),
      ...(doc.watermark && typeof doc.watermark === 'object' ? { watermark: { text: str(doc.watermark.text || 'SAMPLE', 20), ...(doc.watermark.note ? { note: str(doc.watermark.note, 120) } : {}) } } : {}),
    };
    if (dropped.length) out._dropped = dropped;
    return out;
  }

  // ---------- checks for the UI ----------
  // [{ scene, field, level: 'error'|'warn', msg }]
  function validate(doc) {
    const out = [];
    const check = (fields, src, scene, path) => {
      for (const f of fields) {
        const v = src ? src[f.k] : undefined, p = path ? `${path}.${f.k}` : f.k;
        const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
        if (empty) { if (!f.opt && !(f.min === 0)) out.push({ scene, field: p, level: 'error', msg: 'required' }); continue; }
        if (['lines', 'texts', 'list', 'images'].includes(f.kind) && Array.isArray(v)) {
          if (f.min && v.length < f.min) out.push({ scene, field: p, level: 'error', msg: `needs at least ${f.min}` });
          if (f.max && v.length > f.max) out.push({ scene, field: p, level: 'warn', msg: `only the first ${f.max} are used` });
          if (f.kind === 'list') v.forEach((x, i) => check(f.of, x, scene, `${p}[${i}]`));
          if (f.maxLen && f.kind !== 'list' && f.kind !== 'images') v.forEach((x, i) => String(x).length > f.maxLen && out.push({ scene, field: `${p}[${i}]`, level: 'warn', msg: `long text (max ${f.maxLen})` }));
        } else if (f.kind === 'object' && f.of.length) check(f.of, v, scene, p);
        else if (f.maxLen && String(v).length > f.maxLen) out.push({ scene, field: p, level: 'warn', msg: `long text (max ${f.maxLen})` });
      }
    };
    (doc.scenes || []).forEach((s, i) => {
      const m = TYPES[s.type];
      if (!m) { out.push({ scene: i, field: 'type', level: 'error', msg: `unknown type ${s.type}` }); return; }
      if (s.duration < m.dur[0]) out.push({ scene: i, field: 'duration', level: 'warn', msg: `under ${m.dur[0]} s is hard to read` });
      check(m.fields, s, i, '');
    });
    return out;
  }

  // a new scene of a type, filled with its sample (or empty) content
  const SAMPLES = {}; // filled by scene-samples.js when loaded (window.SceneSamples)
  function create(type, orient = 'landscape') {
    const m = TYPES[type]; if (!m) throw new Error('unknown type ' + type);
    const smp = (typeof self !== 'undefined' && self.SceneSamples || SAMPLES)[type];
    const base = smp ? JSON.parse(JSON.stringify(smp[orient] || smp.landscape || smp.portrait || {})) : {};
    return { ...base, type, duration: m.dur[1] };
  }

  function catalogue() {
    return Object.entries(TYPES).map(([type, m]) => ({ type, role: m.role, style: m.style, desc: m.desc, minDuration: m.dur[0], duration: m.dur[1], fields: m.fields,
      orient: m.orient || ['landscape', 'portrait'] }));
  }

  return { TYPES, ICONS, SIZES, STYLES, sanitize, validate, create, catalogue, SAMPLES };
});
