import { Router } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { verifyEditorToken, referencedFiles } from './projects.js'

/**
 * The audio template of a signed-in 3Speak user: ONE per person, kept for good
 * (no expiry, free and Pro alike). It holds the intro, outro and music bed the
 * person puts around every recording, plus their finishing settings, so a new
 * episode only needs the recording itself.
 *
 * Same sign-in as the drafts (editor token, routes/projects.js). Stored as
 * UPLOAD_DIR/.templates/<user>/audio.json; it has no expiresAt, so the upload
 * files it lists are kept by the cleanup (index.js) for as long as it exists.
 * Saving a new template replaces the old one (and frees the old one's files).
 */
const router = Router()
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
export const TEMPLATES_DIR = path.join(UPLOAD_DIR, '.templates')
export const MAX_TEMPLATE_BYTES = 256 * 1024
export const TEMPLATE_KINDS = new Set(['audio'])
const SLOTS = ['intro', 'outro', 'bed']
const UPLOAD_URL = /\/api\/upload\/files\/[A-Za-z0-9_.-]+(\?[^\s"]*)?$/

const num = (v, min, max, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/**
 * The template as stored, from what the editor sends; null when it is unusable.
 * A slot is one of our uploads (never a local or outside URL), the part of it
 * to use, its volume and fades.
 */
export function cleanTemplate(input) {
  if (!input || typeof input !== 'object') return null
  const out = { version: 1, slots: {}, master: {}, silence: null, autoApply: input.autoApply !== false }
  for (const name of SLOTS) {
    const s = input.slots?.[name]
    if (!s) continue
    if (typeof s.url !== 'string' || !UPLOAD_URL.test(s.url) || s.url.length > 500) return null
    const duration = num(s.duration, 0, 4 * 3600, 0)
    const startTime = num(s.startTime, 0, duration || 4 * 3600, 0)
    const endTime = num(s.endTime, startTime, duration || 4 * 3600, duration)
    if (!(endTime > startTime)) return null
    out.slots[name] = {
      url: s.url,
      name: String(s.name || name).slice(0, 120),
      duration,
      startTime,
      endTime,
      volume: num(s.volume, 0, 200, name === 'bed' ? 20 : 100),
      fadeIn: num(s.fadeIn, 0, 30, 0),
      fadeOut: num(s.fadeOut, 0, 30, 0),
      ...(name === 'bed' ? { loop: s.loop !== false } : {})
    }
  }
  out.master.loudness = input.master?.loudness !== false
  // Auto-duck: the music under the voices, by -6 / -12 / -18 dB
  out.master.duck = input.master?.duck === true
  out.master.duckDb = [-6, -12, -18].includes(+input.master?.duckDb) ? +input.master.duckDb : -12
  if (input.silence && typeof input.silence === 'object') {
    out.silence = {
      enabled: input.silence.enabled === true,
      thresholdDb: num(input.silence.thresholdDb, -90, 0, -40),
      minSilence: num(input.silence.minSilence, 0.1, 10, 0.8),
      keepStartMs: num(input.silence.keepStartMs, 0, 2000, 200),
      keepEndMs: num(input.silence.keepEndMs, 0, 2000, 200)
    }
  }
  return out
}

router.use((req, res, next) => {
  const who = verifyEditorToken(req.get('Authorization'))
  if (!who) return res.status(401).json({ error: 'Sign in to use templates' })
  req.templateUser = who.user
  next()
})

const fileFor = (user, kind) => path.join(TEMPLATES_DIR, user, `${kind}.json`)

router.param('kind', (req, res, next, kind) => {
  if (!TEMPLATE_KINDS.has(kind)) return res.status(404).json({ error: 'No such template kind' })
  next()
})

// GET /api/templates/:kind -> { template | null }
router.get('/:kind', async (req, res) => {
  try {
    const t = JSON.parse(await fs.readFile(fileFor(req.templateUser, req.params.kind), 'utf8'))
    res.json({ template: t })
  } catch {
    res.json({ template: null })
  }
})

// PUT /api/templates/:kind { template } -> { template }   (replaces the one there was)
router.put('/:kind', async (req, res) => {
  const raw = req.body?.template
  if (JSON.stringify(raw || null).length > MAX_TEMPLATE_BYTES) return res.status(413).json({ error: 'Template too large' })
  const template = cleanTemplate(raw)
  if (!template) return res.status(400).json({ error: 'Bad template' })
  const now = Date.now()
  const stored = {
    ...template,
    kind: req.params.kind,
    user: req.templateUser,
    updatedAt: now,
    files: referencedFiles(JSON.stringify(template.slots))
  }
  const target = fileFor(req.templateUser, req.params.kind)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(`${target}.tmp`, JSON.stringify(stored))
  await fs.rename(`${target}.tmp`, target)
  res.json({ template: stored })
})

// DELETE /api/templates/:kind
router.delete('/:kind', async (req, res) => {
  await fs.unlink(fileFor(req.templateUser, req.params.kind)).catch(() => {})
  res.json({ ok: true })
})

export { router as templatesRouter }
