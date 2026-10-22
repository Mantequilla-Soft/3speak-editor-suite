import { verifyEditorToken } from './routes/projects.js'

/**
 * Starting work on this backend (uploads, renders, clip jobs) needs a 3Speak sign-in: the editor token
 * the 3Speak site mints for a VERIFIED session (see routes/projects.js), sent as `Authorization: Bearer`.
 * Fails closed: without EDITOR_TOKEN_SECRET nothing verifies, so nothing starts.
 * Reading results stays open (GET /api/upload/files/*, /rendered/*, job status): players and the other
 * render backend fetch those by URL, and their names are random.
 * REQUIRE_SIGN_IN=false switches the check off (local development only).
 */
const REQUIRED = process.env.REQUIRE_SIGN_IN !== 'false'

export function requireSignIn(req, res, next) {
  if (!REQUIRED) return next()
  const who = verifyEditorToken(req.get('Authorization'))
  if (!who) return res.status(401).json({ error: 'Sign in on 3Speak first', code: 'sign-in' })
  req.signedIn = who
  next()
}
