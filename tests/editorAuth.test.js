import { describe, it, expect, beforeEach, vi } from 'vitest'

const tok = exp => `v1.${Buffer.from(JSON.stringify({ u: 'alice', exp })).toString('base64url')}.sig`

// a fake window with a parent that answers 'drafts-sign-in' like the 3Speak page
function setup(reply) {
  const listeners = []
  const parent = { postMessage: vi.fn(msg => { if (msg.type === 'drafts-sign-in') setTimeout(() => send(reply()), 0) }) }
  const win = { parent, addEventListener: (t, f) => listeners.push(f), removeEventListener() {} }
  const send = data => listeners.forEach(f => f({ source: parent, data }))
  globalThis.window = win
  globalThis.atob = s => Buffer.from(s, 'base64').toString('binary')
  return { win, parent, send }
}

describe('editor sign-in token', () => {
  beforeEach(() => vi.resetModules())

  it('keeps the token the page sends and uses it until a minute before it expires', async () => {
    const { send } = setup(() => ({}))
    const A = await import('../src/utils/editorAuth.js')
    send({ type: 'drafts-session', session: { token: tok(Date.now() + 3600e3) } })
    expect(A.currentToken()).toMatch(/^v1\./)
    send({ type: 'drafts-session', session: { token: tok(Date.now() + 30e3) } })
    expect(A.currentToken()).toBeNull()
  })

  it('asks the page once, however many calls wait, and gets a fresh token', async () => {
    const fresh = tok(Date.now() + 3600e3)
    const { parent } = setup(() => ({ type: 'drafts-session', session: { token: fresh } }))
    const A = await import('../src/utils/editorAuth.js')
    const [a, b, c] = await Promise.all([A.ensureToken(), A.ensureToken(), A.authHeaders()])
    expect(a).toBe(fresh); expect(b).toBe(fresh); expect(c.Authorization).toBe(`Bearer ${fresh}`)
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
  })

  it('a logged-out page means a sign-in error, not a hang', async () => {
    setup(() => ({ type: 'drafts-session', session: null, reason: 'logged-out' }))
    const A = await import('../src/utils/editorAuth.js')
    await expect(A.ensureToken()).rejects.toMatchObject({ code: 'sign-in', reason: 'logged-out' })
  })

  it('authFetch drops a refused token and retries once with a new one', async () => {
    let n = 0
    const tokens = [tok(Date.now() + 3600e3), tok(Date.now() + 7200e3)]
    const { send } = setup(() => ({ type: 'drafts-session', session: { token: tokens[1] } }))
    const A = await import('../src/utils/editorAuth.js')
    send({ type: 'drafts-session', session: { token: tokens[0] } })
    const seen = []
    globalThis.fetch = vi.fn(async (url, o) => { seen.push(o.headers.Authorization); return { status: n++ === 0 ? 401 : 200 } })
    const res = await A.authFetch('/api/render', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(seen).toEqual([`Bearer ${tokens[0]}`, `Bearer ${tokens[1]}`])
  })

  it('outside an iframe there is nobody to ask', async () => {
    const w = { addEventListener() {} }; w.parent = w; globalThis.window = w
    const A = await import('../src/utils/editorAuth.js')
    await expect(A.ensureToken()).rejects.toMatchObject({ code: 'sign-in', reason: 'standalone' })
  })
})
