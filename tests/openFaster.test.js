// E26 Open faster: FFmpeg.wasm from the editor's own server, loaded on first
// use; dialogs and hls.js in their own chunks.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { FFMPEG_CORE_VERSION, FFMPEG_CORE_PATH, coreSources } from '../src/utils/ffmpegCore.js'
import { coreDir } from '../scripts/viteFfmpegCore.js'

const root = path.resolve(__dirname, '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

describe('FFmpeg.wasm core', () => {
  it('is the version package.json and the lock install', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.dependencies['@ffmpeg/core']).toBe(FFMPEG_CORE_VERSION)
    const lock = JSON.parse(read('package-lock.json'))
    expect(lock.packages['node_modules/@ffmpeg/core'].version).toBe(FFMPEG_CORE_VERSION)
  })

  it('comes from this server first, under a versioned path, unpkg only as the fallback', () => {
    const [own, cdn] = coreSources('/', 'https://3speak-editor.okinoko.io')
    expect(own).toEqual({ coreURL: `https://3speak-editor.okinoko.io/${FFMPEG_CORE_PATH}/ffmpeg-core.js`, wasmURL: `https://3speak-editor.okinoko.io/${FFMPEG_CORE_PATH}/ffmpeg-core.wasm`, own: true })
    expect(cdn.coreURL).toBe(`https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm/ffmpeg-core.js`)
    expect(coreSources('/editor', 'https://x.io')[0].wasmURL).toBe(`https://x.io/editor/${FFMPEG_CORE_PATH}/ffmpeg-core.wasm`)
  })

  it('the build copies it from node_modules (or FFMPEG_CORE_DIR)', () => {
    expect(coreDir('/app')).toBe(process.env.FFMPEG_CORE_DIR || '/app/node_modules/@ffmpeg/core/dist/esm')
    expect(read('vite.config.js')).toMatch(/ffmpegCore\(\)/)
    expect(read('frontend/Dockerfile')).toMatch(/COPY scripts\/viteFfmpegCore\.js scripts\//)
  })

  it('nginx sends it gzipped and long cached, with the COEP the editor needs', () => {
    const conf = read('frontend/nginx.conf')
    const block = conf.slice(conf.indexOf('location /ffmpeg/'), conf.indexOf('}', conf.indexOf('location /ffmpeg/')))
    expect(block).toMatch(/gzip_static on/)
    expect(block).toMatch(/immutable/)
    expect(block).toMatch(/Cross-Origin-Embedder-Policy "credentialless"/)
    expect(conf).toMatch(/gzip_types[^;]*application\/javascript/)
  })

  it('is never loaded when the editor opens, and its code is not in the main chunk', () => {
    const app = read('src/App.jsx')
    expect(app).not.toMatch(/Auto-load FFmpeg on mount/)
    const hook = read('src/hooks/useFFmpeg.js')
    expect(hook).not.toMatch(/^import .*@ffmpeg\/(ffmpeg|util)/m)
    expect(hook).not.toMatch(/https:\/\/unpkg/) // only utils/ffmpegCore.js knows the fallback
  })
})

describe('code split', () => {
  it('hls.js is imported on first use only', () => {
    for (const f of ['src/utils/hlsHelper.js', 'src/components/Timeline.jsx', 'src/components/GlobalPreview.jsx', 'src/components/VideoPreview.jsx', 'src/hooks/useTimeline.js']) {
      expect(read(f), f).not.toMatch(/^import [^\n]* from 'hls\.js'/m)
    }
  })

  it('App takes the on-demand dialogs from lazyPanels, none of them directly', () => {
    const app = read('src/App.jsx')
    const lazy = read('src/components/lazyPanels.jsx')
    const names = [...lazy.matchAll(/export const (\w+) = lazyPanel\(\(\) => import\('\.\/(\w+)'\)\)/g)]
    expect(names.length).toBeGreaterThan(8)
    for (const [, name, file] of names) {
      expect(name).toBe(file)
      expect(app, name).not.toMatch(new RegExp(`^import ${name} from`, 'm'))
    }
  })
})
