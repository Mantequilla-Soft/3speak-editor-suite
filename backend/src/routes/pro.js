// GET /api/pro-status: may this user make landscape videos (16:9, 4:3, 1:1)? The editor asks
// once it has the 3Speak sign-in, so a free user sees the Pro notice before editing, not only
// when the render is refused. Same rule as the render route (proGate.js); without a sign-in the
// answer is "not allowed" while the rule is on (the editor opened outside 3Speak).
//
// -> { landscapeProOnly, landscapeAllowed, pro: true | false | null, reason, user, upgradeUrl }
import { Router } from 'express'
import { SIGN_IN_REQUIRED } from '../auth.js'
import { verifyEditorToken } from './projects.js'
import { proGateConfig, landscapeAccess, upgradeUrlFor } from '../proGate.js'

const router = Router()

router.get('/', async (req, res) => {
  const cfg = proGateConfig()
  res.set('Cache-Control', 'no-store')
  const who = SIGN_IN_REQUIRED ? verifyEditorToken(req.get('Authorization')) : null
  if (SIGN_IN_REQUIRED && !who) {
    return res.json({ landscapeProOnly: cfg.enabled, landscapeAllowed: !cfg.enabled, pro: null, reason: cfg.enabled ? 'sign-in' : 'disabled', user: null, upgradeUrl: null })
  }
  const access = await landscapeAccess(who, cfg)
  const pro = !who ? null : access.reason === 'token' || access.reason === 'pro' ? true : access.reason === 'free' ? false : null
  res.json({
    landscapeProOnly: cfg.enabled,
    landscapeAllowed: access.allowed,
    pro,
    reason: access.reason,
    user: who?.user || null,
    upgradeUrl: who ? upgradeUrlFor(who.user, cfg) : null,
  })
})

export { router as proRouter }
