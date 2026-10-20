// Fails (exit 1) when the frontend and backend copies of a shared module differ.
// The preview (src/) and the backend render (backend/src/) must run the same code:
// the static-background mask and the clip colour adjustments.
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = false
for (const file of ['staticKeyMask.js', 'clipColor.js', 'stickerMotion.js']) {
  const a = `src/utils/${file}`
  const b = `backend/src/utils/${file}`
  if (readFileSync(path.join(root, a), 'utf8') !== readFileSync(path.join(root, b), 'utf8')) {
    console.error(`${a} and ${b} differ. Copy one over the other so preview and render match.`)
    failed = true
  } else {
    console.log(`${file}: frontend and backend copies are identical`)
  }
}
if (failed) process.exit(1)
