import { Router } from 'express'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'

/**
 * Saved projects (drafts) of signed-in 3Speak users.
 *
 * Who is asking comes from an editor token minted by the 3Speak site
 * (POST /api/editor-token there, after it verified the user's session), signed
 * with EDITOR_TOKEN_SECRET, which only the two servers know:
 *   v1.<base64url {"u":user,"pro":bool,"exp":ms}>.<hex hmac-sha256 of the middle part>
 * Free: 1 project, kept 48 h after its last save. Pro: 3 projects, 30 days each.
 *
 * Stored as UPLOAD_DIR/.projects/<user>/<id>.json. The upload files a project
 * uses are listed in it and kept by the cleanup (index.js) until it expires.
 */
const router = Router()
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
export const PROJECTS_DIR = path.join(UPLOAD_DIR, '.projects')
const SECRET = process.env.EDITOR_TOKEN_SECRET || ''
const HIVE_USER = /^[a-z][a-z0-9.-]{2,15}$/
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_STATE_BYTES = 5 * 1024 * 1024

export const TIERS = {
  free: { maxProjects: 1, ttlMs: 48 * 60 * 60 * 1000 },
  pro: { maxProjects: 3, ttlMs: 30 * 24 * 60 * 60 * 1000 }
}

function verifyEditorToken(header) {
  if (!SECRET) return null
  const token = String(header || '').replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const expected = crypto.createHmac('sha256', SECRET).update(parts[1]).digest('hex')
  const a = Buffer.from(parts[2])
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let claims
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!claims || !HIVE_USER.test(claims.u || '') || !(claims.exp > Date.now())) return null
  return { user: claims.u, pro: !!claims.pro }
}

router.use((req, res, next) => {
  const who = verifyEditorToken(req.get('Authorization'))
  if (!who) return res.status(401).json({ error: 'Sign in to use drafts' })
  req.drafts = { ...who, ...(who.pro ? TIERS.pro : TIERS.free), dir: path.join(PROJECTS_DIR, who.user) }
  next()
})

// The upload files a project needs, by name (kept by the cleanup while it lives)
export function referencedFiles(stateJson) {
  const names = new Set()
  for (const m of stateJson.matchAll(/\/api\/upload\/files\/([A-Za-z0-9_.-]+)/g)) names.add(m[1])
  return [...names]
}

// The user's live projects; expired ones are deleted on the way
async function listProjects(dir) {
  let files = []
  try { files = await fs.readdir(dir) } catch { return [] }
  const out = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const p = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))
      if (p.expiresAt <= Date.now()) {
        await fs.unlink(path.join(dir, f)).catch(() => {})
        continue
      }
      out.push(p)
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

const summary = (p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, expiresAt: p.expiresAt, clips: p.clips || 0, length: p.length || 0 })
const limits = (d) => ({ maxProjects: d.maxProjects, ttlHours: d.ttlMs / 3600000, pro: d.pro })

// GET /api/projects -> { projects: [summary], limits }
router.get('/', async (req, res) => {
  const projects = await listProjects(req.drafts.dir)
  res.json({ projects: projects.map(summary), limits: limits(req.drafts) })
})

// GET /api/projects/:id -> the whole project (state included)
router.get('/:id', async (req, res) => {
  if (!PROJECT_ID.test(req.params.id)) return res.status(400).json({ error: 'Bad id' })
  const p = (await listProjects(req.drafts.dir)).find(x => x.id === req.params.id)
  if (!p) return res.status(404).json({ error: 'Not found' })
  res.json(p)
})

/**
 * PUT /api/projects/:id  { name, state, replace? }
 * Saves (autosave too). Every save restarts the 48 h / 30 day clock. A new
 * project over the limit is refused with 409 { error: 'limit', projects }
 * unless `replace` names the project it may take the place of.
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params
  if (!PROJECT_ID.test(id)) return res.status(400).json({ error: 'Bad id' })
  const state = req.body?.state
  if (!state || typeof state !== 'object' || !Array.isArray(state.tracks)) return res.status(400).json({ error: 'Bad state' })
  const stateJson = JSON.stringify(state)
  if (stateJson.length > MAX_STATE_BYTES) return res.status(413).json({ error: 'Project too large' })

  const d = req.drafts
  const existing = await listProjects(d.dir)
  if (!existing.some(p => p.id === id) && existing.length >= d.maxProjects) {
    const replace = req.body?.replace
    if (!PROJECT_ID.test(replace || '') || !existing.some(p => p.id === replace)) {
      return res.status(409).json({ error: 'limit', projects: existing.map(summary), limits: limits(d) })
    }
    await fs.unlink(path.join(d.dir, `${replace}.json`)).catch(() => {})
  }

  const now = Date.now()
  const clips = state.tracks.reduce((n, t) => n + (Array.isArray(t.clips) ? t.clips.length : 0), 0)
  const length = state.tracks.reduce((m, t) => Math.max(m, ...(t.clips || []).map(c => (c.timelinePosition || 0) + ((c.endTime || 0) - (c.startTime || 0)))), 0)
  const project = {
    id,
    name: String(req.body?.name || 'Untitled project').slice(0, 80),
    user: d.user,
    updatedAt: now,
    expiresAt: now + d.ttlMs,
    clips,
    length,
    files: referencedFiles(stateJson),
    state
  }
  await fs.mkdir(d.dir, { recursive: true })
  const target = path.join(d.dir, `${id}.json`)
  await fs.writeFile(`${target}.tmp`, JSON.stringify(project))
  await fs.rename(`${target}.tmp`, target)
  res.json({ project: summary(project), limits: limits(d) })
})

// DELETE /api/projects/:id (after "Send video", or "Delete draft")
router.delete('/:id', async (req, res) => {
  if (!PROJECT_ID.test(req.params.id)) return res.status(400).json({ error: 'Bad id' })
  await fs.unlink(path.join(req.drafts.dir, `${req.params.id}.json`)).catch(() => {})
  res.json({ ok: true })
})

export { router as projectsRouter }
