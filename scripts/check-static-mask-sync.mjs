// Fails (exit 1) when the two copies of the static-background mask module differ.
// The preview (src/) and the backend render (backend/src/) must run the same code.
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const a = 'src/utils/staticKeyMask.js'
const b = 'backend/src/utils/staticKeyMask.js'
if (readFileSync(path.join(root, a), 'utf8') !== readFileSync(path.join(root, b), 'utf8')) {
  console.error(`${a} and ${b} differ. Copy one over the other so preview and render match.`)
  process.exit(1)
}
console.log('static key mask: frontend and backend copies are identical')
