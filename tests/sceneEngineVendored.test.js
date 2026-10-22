import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'

// The scene engine is vendored twice (scripts/sync-scene-engine.mjs): the frontend preview and the backend
// renderer must run the SAME engine, or the render differs from the preview.
describe('vendored scene engine', () => {
  it('frontend and backend copies are identical', () => {
    const libs = fs.readdirSync('public/scenes/lib')
    expect(libs).toEqual(fs.readdirSync('backend/scene-engine/lib'))
    for (const f of libs) expect(fs.readFileSync(`backend/scene-engine/lib/${f}`, 'utf8'), f).toBe(fs.readFileSync(`public/scenes/lib/${f}`, 'utf8'))
    expect(fs.readFileSync('backend/scene-engine/host/index.html', 'utf8')).toBe(fs.readFileSync('public/scenes/host/index.html', 'utf8'))
  })
  it('every scene type has a picker thumbnail in both orientations, and its sound files exist', () => {
    const ctx = { self: {} }
    vm.runInNewContext(fs.readFileSync('public/scenes/lib/scene-meta.js', 'utf8'), ctx)
    for (const type of Object.keys(ctx.self.SceneMeta.TYPES)) {
      for (const o of ['landscape', 'portrait']) expect(fs.existsSync(`public/scenes/thumbs/${o}/${type}.jpg`), `${o}/${type}`).toBe(true)
    }
    for (const f of ['trans-1', 'trans-5', 'whoosh-1', 'swish-1', 'tick', 'click-1', 'type-1', 'hit-1']) expect(fs.existsSync(`public/scenes/sfx/${f}.wav`), f).toBe(true)
  })
})
