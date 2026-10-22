import { Router } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { verifyEditorToken, referencedFiles } from './projects.js'

/**
 * Ad Wizard drafts (?mode=ads), separate from the Shorts editor's projects:
 * everyone gets 5 drafts, each kept 90 days after its last save.
 * Same sign-in as the editor's drafts: an editor token minted by the 3Speak site.
 * Stored as UPLOAD_DIR/.ad-drafts/<user>/<id>.json; the uploads a draft uses
 * (pictures, logo, fonts, music) are listed in it and kept by the cleanup.
 */
const router = Router()
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
export const AD_DRAFTS_DIR = path.join(UPLOAD_DIR, '.ad-drafts')
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_STATE_BYTES = 2 * 1024 * 1024
export const AD_DRAFT_LIMITS = { maxDrafts: 5, ttlMs: 90 * 24 * 60 * 60 * 1000 }

router.use((req, res, next) => {
  const who = verifyEditorToken(req.get('Authorization'))
  if (!who) return res.status(401).json({ error: 'Sign in to save drafts' })
  req.drafts = { ...who, ...AD_DRAFT_LIMITS, dir: path.join(AD_DRAFTS_DIR, who.user) }
  next()
})

async function listDrafts(dir) {
  let files = []
  try { files = await fs.readdir(dir) } catch { return [] }
  const out = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const p = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))
      if (p.expiresAt <= Date.now()) { await fs.unlink(path.join(dir, f)).catch(() => {}); continue }
      out.push(p)
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

const summary = (p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, expiresAt: p.expiresAt, format: p.format, scenes: p.scenes, first: p.first })
const limits = (d) => ({ maxDrafts: d.maxDrafts, ttlDays: d.ttlMs / 86400000 })

router.get('/', async (req, res) => {
  res.json({ drafts: (await listDrafts(req.drafts.dir)).map(summary), limits: limits(req.drafts) })
})

router.get('/:id', async (req, res) => {
  if (!DRAFT_ID.test(req.params.id)) return res.status(400).json({ error: 'Bad id' })
  const p = (await listDrafts(req.drafts.dir)).find(x => x.id === req.params.id)
  if (!p) return res.status(404).json({ error: 'Not found' })
  res.json(p)
})

/**
 * PUT /api/ad-drafts/:id  { name, state, replace? }
 * Every save restarts the 90-day clock. A 6th draft is refused with 409 { error: 'limit', drafts }
 * unless `replace` names the draft it may take the place of.
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params
  if (!DRAFT_ID.test(id)) return res.status(400).json({ error: 'Bad id' })
  const state = req.body?.state
  if (!state || typeof state !== 'object' || state.version !== 1 || !Array.isArray(state.scenes)) return res.status(400).json({ error: 'Bad state' })
  const stateJson = JSON.stringify(state)
  if (stateJson.length > MAX_STATE_BYTES) return res.status(413).json({ error: 'Draft too large' })

  const d = req.drafts
  const existing = await listDrafts(d.dir)
  if (!existing.some(p => p.id === id) && existing.length >= d.maxDrafts) {
    const replace = req.body?.replace
    if (!DRAFT_ID.test(replace || '') || !existing.some(p => p.id === replace)) {
      return res.status(409).json({ error: 'limit', drafts: existing.map(summary), limits: limits(d) })
    }
    await fs.unlink(path.join(d.dir, `${replace}.json`)).catch(() => {})
  }
  const now = Date.now()
  const draft = {
    id,
    name: String(req.body?.name || 'Untitled ad').slice(0, 80),
    user: d.user,
    updatedAt: now,
    expiresAt: now + d.ttlMs,
    format: state.format === 'portrait' ? 'portrait' : 'landscape',
    scenes: state.scenes.length,
    first: typeof state.scenes[0]?.type === 'string' ? state.scenes[0].type.slice(0, 30) : null,
    files: referencedFiles(stateJson),
    state,
  }
  await fs.mkdir(d.dir, { recursive: true })
  const target = path.join(d.dir, `${id}.json`)
  await fs.writeFile(`${target}.tmp`, JSON.stringify(draft))
  await fs.rename(`${target}.tmp`, target)
  res.json({ draft: summary(draft), limits: limits(d) })
})

router.delete('/:id', async (req, res) => {
  if (!DRAFT_ID.test(req.params.id)) return res.status(400).json({ error: 'Bad id' })
  await fs.unlink(path.join(req.drafts.dir, `${req.params.id}.json`)).catch(() => {})
  res.json({ ok: true })
})

export { router as adDraftsRouter }
