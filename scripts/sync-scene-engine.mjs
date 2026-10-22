// Vendor the scene engine (Mantequilla-Soft/motiongraphics-cookbook, docs/engine.md) into this repo:
//   public/scenes/{lib,host,sfx,thumbs}   -> served by the frontend, the Ad Wizard's same-origin preview iframe
//   backend/scene-engine/{lib,host}       -> used by the backend to render scene video (headless Chromium)
//
//   node scripts/sync-scene-engine.mjs [path/to/motiongraphics-cookbook]   (default: ../motiongraphics-cookbook)
//        [--thumbs]   also (re)generate the picker thumbnails (runs the cookbook's check-engine, ~3 min, needs Chromium)
//
// The copy is committed here on purpose: the editor builds and runs without the cookbook checkout.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const src = path.resolve(args.find(a => !a.startsWith('--')) || '../motiongraphics-cookbook');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
if (!fs.existsSync(path.join(src, 'host/index.html'))) { console.error(`no scene engine at ${src}`); process.exit(1); }

// browser files only (the cookbook's Node tools stay there)
const LIB = fs.readdirSync(path.join(src, 'lib')).filter(f => /^(timeline|kit|scene-meta|scene-samples)\.js$|^scenes.*\.(js|css)$|^base\.css$/.test(f));
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const fresh = d => { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); };

for (const target of [path.join(root, 'public/scenes'), path.join(root, 'backend/scene-engine')]) {
  fresh(path.join(target, 'lib')); fresh(path.join(target, 'host'));
  for (const f of LIB) copy(path.join(src, 'lib', f), path.join(target, 'lib', f));
  copy(path.join(src, 'host/index.html'), path.join(target, 'host/index.html'));
}
// sound effects the scenes cue (CC0, see SOURCES.md)
fresh(path.join(root, 'public/scenes/sfx'));
for (const f of fs.readdirSync(path.join(src, 'sfx')).filter(f => /\.(wav|md)$/.test(f))) copy(path.join(src, 'sfx', f), path.join(root, 'public/scenes/sfx', f));

if (args.includes('--thumbs')) {
  fresh(path.join(root, 'public/scenes/thumbs'));
  execFileSync('node', ['scripts/check-engine.mjs', '--thumbs', path.join(root, 'public/scenes/thumbs'), '--at', '.7'], { cwd: src, stdio: 'inherit' });
}

const rev = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const stamp = { source: 'Mantequilla-Soft/motiongraphics-cookbook', commit: rev, syncedAt: new Date().toISOString(), files: LIB.length };
for (const t of ['public/scenes', 'backend/scene-engine']) fs.writeFileSync(path.join(root, t, 'VERSION.json'), JSON.stringify(stamp, null, 2) + '\n');
console.log(`scene engine ${rev}: ${LIB.length} lib files -> public/scenes + backend/scene-engine`);
