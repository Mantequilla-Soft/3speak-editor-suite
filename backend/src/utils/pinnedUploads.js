import fs from 'fs/promises'
import path from 'path'
import { PROJECTS_DIR } from '../routes/projects.js'
import { AD_DRAFTS_DIR } from '../routes/adDrafts.js'
import { TEMPLATES_DIR } from '../routes/templates.js'

// An upload's name without its derived suffixes: the original, its 480p copy,
// cleaned audio and scene cache all share it
export const uploadBase = (name) => path.basename(name, path.extname(name))
  .replace(/\.(scenes|audio)$/, '')
  .replace(/(_480p|_dn-(light|medium|strong))(\.part)?$/, '')

// Files saved projects, Ad Wizard drafts and templates still use (by upload base); expired
// ones go here. Templates have no expiresAt: their files stay as long as the template does.
export async function pinnedUploads(now, roots = [PROJECTS_DIR, AD_DRAFTS_DIR, TEMPLATES_DIR]) {
  const pinned = new Set()
  for (const root of roots) await pinFrom(root, now, pinned)
  return pinned
}

async function pinFrom(root, now, pinned) {
  let users = []
  try { users = await fs.readdir(root) } catch { return pinned }
  for (const user of users) {
    const dir = path.join(root, user)
    let files = []
    try { files = await fs.readdir(dir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const p = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))
        if (p.expiresAt <= now) {
          await fs.unlink(path.join(dir, f))
          console.log(`[cleanup] Project ${p.id} of ${user} expired`)
          continue
        }
        for (const name of p.files || []) pinned.add(uploadBase(name))
      } catch {}
    }
  }
  return pinned
}
