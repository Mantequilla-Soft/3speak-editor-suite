// The files MediaPipe's vision tasks need at run time, served by the editor
// itself (public/vision/), so the browser fetches nothing from a CDN:
//   public/vision/wasm/    the wasm runtime, copied from node_modules/@mediapipe/tasks-vision
//                          (not committed: it comes with `npm ci`, ~28 MB)
//   public/vision/models/  the models (committed; downloaded again only when missing,
//                          and checked against the known sha256)
// Runs before `npm run dev` and `npm run build` (package.json pre-scripts), also
// in the frontend image (frontend/Dockerfile). Re-runnable; copies only what changed.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision')
const outWasm = path.join(root, 'public', 'vision', 'wasm')
const outModels = path.join(root, 'public', 'vision', 'models')

// The plain and the no-SIMD builds (FilesetResolver picks the one the browser can run)
const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']
const MODELS = [
  {
    // Face Detector, BlazeFace short range (Apache-2.0), for reframing
    file: 'blaze_face_short_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    sha256: 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f'
  }
]

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function copyWasm() {
  if (!fs.existsSync(pkg)) throw new Error('node_modules/@mediapipe/tasks-vision is missing: run npm ci first')
  fs.mkdirSync(outWasm, { recursive: true })
  let copied = 0
  for (const name of WASM_FILES) {
    const from = path.join(pkg, 'wasm', name)
    const to = path.join(outWasm, name)
    const a = fs.statSync(from)
    const b = fs.existsSync(to) ? fs.statSync(to) : null
    if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue
    fs.copyFileSync(from, to)
    copied++
  }
  console.log(`[vision] wasm: ${copied ? `${copied} file(s) copied` : 'up to date'} in public/vision/wasm`)
}

async function ensureModels() {
  fs.mkdirSync(outModels, { recursive: true })
  for (const m of MODELS) {
    const to = path.join(outModels, m.file)
    if (fs.existsSync(to) && sha256(fs.readFileSync(to)) === m.sha256) continue
    console.log(`[vision] downloading ${m.file}`)
    const res = await fetch(m.url)
    if (!res.ok) throw new Error(`${m.file}: download failed (${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (sha256(buf) !== m.sha256) throw new Error(`${m.file}: unexpected checksum, not saved`)
    fs.writeFileSync(to, buf)
  }
  console.log('[vision] models: ok')
}

copyWasm()
await ensureModels()
