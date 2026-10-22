// Sound for the Ad Wizard preview: music (trimmed, volume, fades) and sound effects, scheduled on Web Audio
// against the same clock as the picture. The final mix is made by the render backend; this only has to
// sound like it.
const buffers = new Map() // url -> Promise<AudioBuffer>

export default class PreviewAudio {
  constructor() {
    this.ctx = null
    this.playing = []
    this.music = null
    this.sfx = []
  }

  context() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)()
    return this.ctx
  }

  load(url) {
    if (!url) return Promise.resolve(null)
    if (!buffers.has(url)) {
      const ctx = this.context()
      buffers.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(`audio ${r.status}`); return r.arrayBuffer() })
        .then(b => ctx.decodeAudioData(b))
        .catch(e => { buffers.delete(url); console.warn('[ad-wizard] audio failed', url, e); return null }))
    }
    return buffers.get(url)
  }

  // music: { url, start, volume 0..100, fadeIn, fadeOut } | null; sfx: [{ url, at, volume }]
  set({ music, sfx }) {
    this.music = music
    this.sfx = sfx || []
    if (music?.url) this.load(music.url)
    for (const s of this.sfx) this.load(s.url)
  }

  // duration of a clip's file, once decoded (the render needs it for sound effects)
  async durationOf(url) { const b = await this.load(url); return b ? b.duration : 0 }

  async play(from, length) {
    this.stop()
    const ctx = this.context()
    if (ctx.state === 'suspended') await ctx.resume()
    const t0 = ctx.currentTime + 0.05
    const m = this.music
    if (m?.url) {
      const buf = await this.load(m.url)
      if (buf) {
        const src = ctx.createBufferSource(), g = ctx.createGain()
        src.buffer = buf
        src.connect(g).connect(ctx.destination)
        const vol = Math.max(0, (m.volume ?? 80) / 100)
        const fi = Math.max(0, m.fadeIn || 0), fo = Math.max(0, m.fadeOut || 0)
        // gain envelope over the ad's timeline, started at `from`
        const at = t => t0 + (t - from)
        g.gain.setValueAtTime(fi > 0 && from < fi ? vol * (from / fi) : vol, t0)
        if (fi > 0 && from < fi) g.gain.linearRampToValueAtTime(vol, at(fi))
        if (fo > 0 && length - fo > from) { g.gain.setValueAtTime(vol, at(length - fo)); g.gain.linearRampToValueAtTime(0, at(length)) }
        const offset = (m.start || 0) + from
        if (offset < buf.duration) { src.start(t0, offset, Math.max(0, length - from)); this.playing.push(src) }
      }
    }
    for (const s of this.sfx) {
      if (s.at + 0.02 < from) continue
      const buf = await this.load(s.url)
      if (!buf) continue
      const src = ctx.createBufferSource(), g = ctx.createGain()
      src.buffer = buf
      g.gain.value = Math.max(0, (s.volume ?? 100) / 100)
      src.connect(g).connect(ctx.destination)
      src.start(t0 + (s.at - from))
      this.playing.push(src)
    }
    return t0
  }

  // seconds of ad time since play() started (the picture follows this clock)
  now(t0, from) { return this.ctx ? from + (this.ctx.currentTime - t0) : from }

  stop() {
    for (const s of this.playing) { try { s.stop() } catch { /* already ended */ } }
    this.playing = []
  }

  // short one-off (preview a sound in a list)
  async blip(url, volume = 100) {
    const ctx = this.context()
    if (ctx.state === 'suspended') await ctx.resume()
    const buf = await this.load(url)
    if (!buf) return
    const src = ctx.createBufferSource(), g = ctx.createGain()
    src.buffer = buf; g.gain.value = volume / 100
    src.connect(g).connect(ctx.destination); src.start()
  }
}
