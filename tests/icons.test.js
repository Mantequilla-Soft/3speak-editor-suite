// The editor's icons are Material Symbols Rounded, loaded from Google Fonts with
// an `icon_names=` list in index.html so only the glyphs we use are downloaded.
// A glyph missing from that list shows up as its name in plain text, so the
// list must match the names in src/components/icons.jsx exactly (and Google
// wants it sorted). The component file is JSX, so read it as text.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const iconsSrc = read('src/components/icons.jsx')
const mapBody = iconsSrc.match(/export const MATERIAL = \{([\s\S]*?)\n\}/)[1]
const map = Object.fromEntries([...mapBody.matchAll(/^\s+(\w+): '([a-z0-9_]+)',/gm)].map(m => [m[1], m[2]]))
const exported = [...iconsSrc.matchAll(/^export const (\w+) = make\('(\w+)'\)/gm)]

function walk(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : /\.jsx?$/.test(n) ? [p] : []
  })
}

describe('editor icons', () => {
  it('index.html loads exactly the glyphs icons.jsx uses, sorted', () => {
    const html = read('index.html')
    const listed = html.match(/icon_names=([a-z0-9_,]+)/)[1].split(',')
    const wanted = [...new Set(Object.values(map))].sort()
    expect(listed).toEqual(wanted)
  })

  it('every exported icon has a Material name and matches its export name', () => {
    for (const [, name, key] of exported) {
      expect(name).toBe(key)
      expect(map[key], key).toBeTruthy()
    }
  })

  it('nothing imports lucide-react any more, and every imported icon exists', () => {
    const srcDir = new URL('../src', import.meta.url).pathname
    const names = new Set(exported.map(m => m[1]))
    for (const file of walk(srcDir)) {
      const text = readFileSync(file, 'utf8')
      expect(text.includes("from 'lucide-react'"), file).toBe(false)
      for (const m of text.matchAll(/import \{([^}]*)\} from '[./]+(?:components\/)?icons'/g)) {
        for (const part of m[1].split(',').map(s => s.trim().split(' as ')[0]).filter(Boolean)) {
          expect(names.has(part), `${file}: ${part}`).toBe(true)
        }
      }
    }
  })
})
