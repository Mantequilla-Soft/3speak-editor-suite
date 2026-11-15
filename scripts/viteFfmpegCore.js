// Vite plugin: serves FFmpeg.wasm's core files from the editor itself instead
// of unpkg (src/utils/ffmpegCore.js). Dev: served from node_modules. Build:
// copied to dist/ffmpeg/<version>/, the wasm also gzipped next to it for
// nginx's gzip_static (frontend/nginx.conf). FFMPEG_CORE_DIR points somewhere
// else (a folder with ffmpeg-core.js and ffmpeg-core.wasm) when needed.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { FFMPEG_CORE_VERSION, FFMPEG_CORE_PATH, FFMPEG_CORE_FILES } from '../src/utils/ffmpegCore.js'

const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm' }

export function coreDir(root = process.cwd()) {
  return process.env.FFMPEG_CORE_DIR || path.join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm')
}

function checkVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, '..', '..', 'package.json'), 'utf8'))
    return pkg.version === FFMPEG_CORE_VERSION ? null : `found @ffmpeg/core ${pkg.version}, the editor asks for ${FFMPEG_CORE_VERSION}`
  } catch { return null } // FFMPEG_CORE_DIR without a package.json
}

export default function ffmpegCore() {
  let root = process.cwd()
  let dir
  const missing = () => FFMPEG_CORE_FILES.filter(f => !fs.existsSync(path.join(dir, f)))
  return {
    name: 'ffmpeg-core',
    configResolved(config) { root = config.root; dir = coreDir(root) },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = (req.url || '').split('?')[0].match(/\/ffmpeg\/([^/]+)\/(ffmpeg-core\.(?:js|wasm))$/)
        if (!m || m[1] !== FFMPEG_CORE_VERSION) return next()
        const file = path.join(dir, m[2])
        if (!fs.existsSync(file)) return next()
        res.setHeader('Content-Type', TYPES[path.extname(file)])
        fs.createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      const gone = missing()
      if (gone.length) {
        // The editor then loads it from unpkg (the fallback); the Docker build always has it (npm ci)
        this.warn(`@ffmpeg/core files missing in ${dir} (${gone.join(', ')}): the build will fetch FFmpeg.wasm from unpkg. Run npm ci.`)
        return
      }
      const wrong = checkVersion(dir)
      if (wrong) this.error(wrong)
      for (const f of FFMPEG_CORE_FILES) {
        const source = fs.readFileSync(path.join(dir, f))
        this.emitFile({ type: 'asset', fileName: `${FFMPEG_CORE_PATH}/${f}`, source })
        if (f.endsWith('.wasm')) this.emitFile({ type: 'asset', fileName: `${FFMPEG_CORE_PATH}/${f}.gz`, source: zlib.gzipSync(source, { level: 9 }) })
      }
    }
  }
}
