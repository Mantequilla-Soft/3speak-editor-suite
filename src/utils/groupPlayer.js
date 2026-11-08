// Plays a group of clips (voices on their own tracks) together, behind the
// interface of ONE media element (currentTime / paused / play / pause), in
// timeline seconds, so the Cut silences popup can preview a group like a clip.
// The clock is the wall clock; each member's <audio> follows it: started when
// its clip begins, re-seeked when it drifts, paused outside its clip.

const DRIFT = 0.15

export class GroupPlayer {
  /**
   * members: [{ el: HTMLMediaElement, position, startTime, endTime, volume (0..1) }]
   * onState(playing): called when it starts or stops.
   */
  constructor(members, { onState = () => {}, now = () => performance.now() } = {}) {
    this.members = members
    this.onState = onState
    this.now = now
    this._base = 0
    this._t0 = 0
    this._playing = false
  }

  get paused() { return !this._playing }

  get currentTime() {
    if (!this._playing) return this._base
    const t = this._base + (this.now() - this._t0) / 1000
    this._sync(t)
    return t
  }

  set currentTime(t) {
    this._base = t
    this._t0 = this.now()
    if (this._playing) this._sync(t, true)
  }

  play() {
    if (!this._playing) {
      this._playing = true
      this._t0 = this.now()
      this._sync(this._base, true)
      this.onState(true)
    }
    return Promise.resolve()
  }

  pause() {
    if (!this._playing) return
    this._base = this.currentTime
    this._playing = false
    for (const m of this.members) if (m.el && !m.el.paused) m.el.pause()
    this.onState(false)
  }

  _sync(t, force = false) {
    for (const m of this.members) {
      const el = m.el
      if (!el) continue
      const inside = t >= m.position && t < m.position + (m.endTime - m.startTime)
      if (!inside) {
        if (!el.paused) el.pause()
        continue
      }
      const local = m.startTime + (t - m.position)
      el.volume = Math.min(1, Math.max(0, m.volume ?? 1))
      if (el.paused) {
        el.currentTime = local
        const p = el.play()
        if (p && p.catch) p.catch(() => {})
      } else if (force || Math.abs(el.currentTime - local) > DRIFT) {
        el.currentTime = local
      }
    }
  }
}
