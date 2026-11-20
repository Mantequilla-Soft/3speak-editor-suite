// The landscape video editor is 3Speak Pro (utils/landscapeAccess.js; the backend enforces it in
// backend/src/proGate.js). Shorts and the audio editor stay free; a failed question locks nothing.
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PRO_ASPECTS, isProAspect, normalizeAccess, fetchLandscapeAccess, accessFromRefusal, isProRefusal,
  landscapeLocked, lockedExportAspects, fallbackUpgradeUrl,
} from '../src/utils/landscapeAccess'
import { submitRender } from '../src/utils/renderQueue'
import LandscapeProNotice from '../src/components/LandscapeProNotice'
import ProjectFormat from '../src/components/ProjectFormat'
import FormatsPanel from '../src/components/FormatsPanel'

const free = { allowed: false, pro: false, reason: 'free', upgradeUrl: 'https://3speak.tv/wallet/freddy#pro' }
const pro = { allowed: true, pro: true, reason: 'pro', upgradeUrl: 'https://3speak.tv/wallet/tina#pro' }
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('which shapes are Pro', () => {
  it('16:9, 4:3 and 1:1 are Pro; the Short is free', () => {
    expect(PRO_ASPECTS).toEqual(['16:9', '4:3', '1:1'])
    for (const a of PRO_ASPECTS) expect(isProAspect(a)).toBe(true)
    expect(isProAspect('9:16')).toBe(false)
  })

  it('a free user is locked in a landscape, classic or square project, never in a Short or the audio editor', () => {
    expect(landscapeLocked(free, '16:9')).toBe(true)
    expect(landscapeLocked(free, '4:3')).toBe(true)
    expect(landscapeLocked(free, '1:1')).toBe(true)
    expect(landscapeLocked(free, '9:16')).toBe(false)
    expect(landscapeLocked(free, '16:9', true)).toBe(false)
    expect(landscapeLocked(pro, '16:9')).toBe(false)
    // not answered yet: nothing locked
    expect(landscapeLocked(null, '16:9')).toBe(false)
  })

  it('Export as: a free user may only render the Short', () => {
    expect(lockedExportAspects(free)).toEqual(PRO_ASPECTS)
    expect(lockedExportAspects(pro)).toEqual([])
    expect(lockedExportAspects(null)).toEqual([])
    expect(lockedExportAspects(free, true)).toEqual([])
  })
})

describe('asking the backend', () => {
  it('sends the sign-in and reads the answer', async () => {
    const fetchImpl = vi.fn(async () => json({ landscapeProOnly: true, landscapeAllowed: false, pro: false, reason: 'free', user: 'freddy', upgradeUrl: 'https://3speak.tv/wallet/freddy#pro' }))
    const a = await fetchLandscapeAccess({ url: '/api/pro-status', token: 'tok', user: 'freddy', fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/pro-status')
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer tok' })
    expect(a).toEqual(free)
  })

  it('a failed question allows (fail open, as the backend): network error, 5xx, an older backend', async () => {
    for (const fetchImpl of [async () => { throw new TypeError('Failed to fetch') }, async () => json({}, 502), async () => json({ status: 'ok' }), async () => json({ error: 'Not found' }, 404)]) {
      const a = await fetchLandscapeAccess({ url: '/api/pro-status', token: 't', user: 'freddy', fetchImpl })
      expect(a.allowed).toBe(true)
      expect(a.upgradeUrl).toBe('https://3speak.tv/wallet/freddy#pro')
    }
  })

  it('only an https Pro page is linked', () => {
    expect(normalizeAccess({ landscapeAllowed: false, upgradeUrl: 'javascript:alert(1)', user: 'freddy' }).upgradeUrl).toBe('https://3speak.tv/wallet/freddy#pro')
    expect(fallbackUpgradeUrl(null)).toBe('https://3speak.tv')
  })

  it('a 403 pro_required from the render route reaches the editor with its body', async () => {
    const body = { error: 'Pro required', code: 'pro_required', feature: 'landscape_editor', message: 'x', upgrade_url: 'https://3speak.tv/wallet/freddy#pro' }
    const err = await submitRender({ send: async () => json(body, 403) }).catch(e => e)
    expect(isProRefusal(err)).toBe(true)
    expect(err.status).toBe(403)
    expect(err.body).toEqual(body)
    expect(accessFromRefusal(err.body)).toEqual(free)
  })
})

describe('the Pro notice and marks', () => {
  it('names the shape, links the Pro page in a new tab and offers a Short instead', () => {
    const html = renderToStaticMarkup(createElement(LandscapeProNotice, { aspect: '16:9', access: free, checking: false, onRecheck: () => {}, onMakeShort: () => {} }))
    expect(html).toContain('Landscape videos are part of 3Speak Pro')
    expect(html).toContain('Shorts and the audio editor stay free for everyone')
    expect(html).toContain('href="https://3speak.tv/wallet/freddy#pro"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('Make a Short instead')
    expect(html).toContain('I have Pro now')
    expect(html).toContain('Landscape 16:9')
  })

  it('Export as: Pro shapes are disabled with the Pro mark and a link for a free user', () => {
    const props = { projectAspect: '9:16', viewAspect: null, onViewAspect: () => {}, tracks: [], fileStore: null, onUpdateClip: () => {}, selectedClipId: null, onSelectClip: () => {}, timelineEnd: 10, buildPayload: async () => ({}), canRender: true, renderBlocked: null, canSend: true, onSend: () => {} }
    const locked = renderToStaticMarkup(createElement(FormatsPanel, { ...props, lockedAspects: PRO_ASPECTS, upgradeUrl: free.upgradeUrl }))
    expect(locked.match(/class="pro-badge"/g)).toHaveLength(3)
    expect(locked).toContain('Shapes other than Short 9:16 are part of 3Speak Pro.')
    expect(locked).toContain('href="https://3speak.tv/wallet/freddy#pro"')
    // nothing to render: the default target (a landscape shape) is locked
    expect(locked).toMatch(/<button class="formats-btn primary" disabled="">/)
    const open = renderToStaticMarkup(createElement(FormatsPanel, props))
    expect(open).not.toContain('pro-badge')
  })

  it('the shape chip renders for free and Pro users alike (the marks are in its picker)', () => {
    for (const proLocked of [true, false]) {
      const html = renderToStaticMarkup(createElement(ProjectFormat, { aspect: '9:16', onChange: () => {}, tracks: [], proLocked }))
      expect(html).toContain('project-format-chip')
    }
  })
})
