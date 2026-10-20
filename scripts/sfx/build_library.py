#!/usr/bin/env python3
"""
Builds the editor's sound-effects library from Kenney's audio packs
(kenney.nl, all CC0 1.0): downloads each pack's zip, converts every sound to
MP3 and writes library.json next to them, in the same shape as the music
library (scripts/music/build_library.py), so the same reader can show it.

    python3 scripts/sfx/build_library.py OUT_DIR [CACHE_DIR]
    python3 scripts/sfx/build_library.py --list [CACHE_DIR]   # what would be included

    OUT_DIR   e.g. /mnt/HC_Volume_103240961/editor-sfx
    CACHE_DIR where the zips are kept (default /mnt/HC_Volume_103240961/editor-sfx-src)

`moods` in library.json is the CATEGORY list here (whoosh, click, pop, ...).
Re-running only downloads packs whose zip is missing and only converts sounds
whose MP3 is missing.

The zips are plain data: only audio members are read out of them, by name,
into a fresh folder per pack, nothing in them is ever run. Each pack page is
checked for its CC0 license link before the zip is taken. Voiceover packs are
left out on purpose (spoken words, not effects).
"""
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from array import array
from datetime import datetime, timezone

UA = {'User-Agent': 'Mozilla/5.0 (compatible; 3speak-shorts-editor-sfx-library; +https://3speak.tv)'}
CC0 = ('CC0 1.0', 'https://creativecommons.org/publicdomain/zero/1.0/')
DEFAULT_CACHE = '/mnt/HC_Volume_103240961/editor-sfx-src'
AUDIO_EXT = ('.wav', '.ogg', '.flac', '.mp3')
# Lossless first when a pack ships the same sound in more than one format
EXT_RANK = {'.wav': 0, '.flac': 1, '.ogg': 2, '.mp3': 3}
MAX_ZIP_BYTES = 200 * 1024 * 1024
MAX_MEMBER_BYTES = 50 * 1024 * 1024
MAX_SECONDS = 60  # an "effect" longer than this is no use as an effect

# Categories, shown as the library's mood chips
CATEGORIES = [
    ('whoosh', 'Whoosh & transition'),
    ('click', 'Click & UI'),
    ('pop', 'Pop & bubble'),
    ('impact', 'Impact & hit'),
    ('alert', 'Notification & alert'),
    ('coins', 'Coins & reward'),
    ('arcade', 'Arcade & game'),
    ('scifi', 'Sci-fi'),
    ('foley', 'Foley'),
    ('jingles', 'Jingles'),
]

# (page slug, pack name, category for sounds no rule below claims)
PACKS = [
    ('interface-sounds', 'Interface Sounds', 'click'),
    ('ui-audio', 'UI Audio', 'click'),
    ('impact-sounds', 'Impact Sounds', 'impact'),
    ('digital-audio', 'Digital Audio', 'arcade'),
    ('sci-fi-sounds', 'Sci-fi Sounds', 'scifi'),
    ('rpg-audio', 'RPG Audio', 'foley'),
    ('casino-audio', 'Casino Audio', 'foley'),
    ('music-jingles', 'Music Jingles', 'jingles'),
]

# Filename rules, first match wins. Each is (pack slug or None for any pack,
# pattern on the file stem, category).
RULES = [
    (None, r'coin|chip|cash|money', 'coins'),
    (None, r'jingle', 'jingles'),
    (None, r'footstep', 'foley'),
    (None, r'explosion', 'impact'),
    (None, r'whoosh|swoosh|swish|woosh', 'whoosh'),
    ('interface-sounds', r'^(confirmation|error|question|bong|glass)', 'alert'),
    ('interface-sounds', r'^(drop|pluck)', 'pop'),
    ('interface-sounds', r'^(maximize|minimize|scroll|scratch|glitch)', 'whoosh'),
    ('digital-audio', r'^(two|three|lowthree|tone)', 'alert'),
    ('digital-audio', r'^pep', 'pop'),
    ('digital-audio', r'^(highup|highdown|lowdown)', 'whoosh'),
    ('digital-audio', r'^(laser|phaser|zap|space|low)', 'scifi'),
    ('sci-fi-sounds', r'^impact', 'impact'),
    ('sci-fi-sounds', r'^slime', 'pop'),
    ('rpg-audio', r'^(knife|draw)', 'whoosh'),
]
# Pack demo reels, not single effects
SKIP_STEM = re.compile(r'^preview', re.I)


def slug(text):
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


def fetch(url, pause=1.0):
    if pause:
        time.sleep(pause)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
        return r.read(MAX_ZIP_BYTES + 1)


def pack_url(pack):
    return f'https://kenney.nl/assets/{pack}'


def zip_url(pack):
    """The pack page's own download link, after checking it says CC0."""
    page = fetch(pack_url(pack)).decode('utf-8', 'replace')
    if 'creativecommons.org/publicdomain/zero/1.0' not in page:
        raise RuntimeError('page does not link the CC0 license')
    m = re.search(r"""https://kenney\.nl/media/pages/assets/""" + re.escape(pack) + r"""/[^"'\s<>]+\.zip""", page)
    if not m:
        raise RuntimeError('no zip link on the page')
    return m.group(0)


def download(pack, cache):
    """Path of the pack's zip in the cache, downloading it when missing."""
    d = os.path.join(cache, pack)
    os.makedirs(d, exist_ok=True)
    have = [f for f in os.listdir(d) if f.endswith('.zip')]
    if have:
        return os.path.join(d, have[0])
    url = zip_url(pack)
    data = fetch(url)
    if len(data) > MAX_ZIP_BYTES:
        raise RuntimeError('zip larger than the cap')
    name = re.sub(r'[^A-Za-z0-9._-]+', '_', url.rsplit('/', 1)[1])
    dest = os.path.join(d, name)
    with open(dest + '.part', 'wb') as f:
        f.write(data)
    os.replace(dest + '.part', dest)
    print(f'.. downloaded {pack}: {len(data) / 1e6:.1f} MB', file=sys.stderr)
    return dest


def extract(pack, zip_path, cache):
    """Audio members only, flattened into a fresh folder: {stem: path}.

    Member names are never used as paths: each file is written under a name
    built from its cleaned stem, so `../` or absolute names go nowhere.
    """
    out = os.path.join(cache, pack, 'files')
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)
    best = {}  # stem key -> (rank, member)
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if info.is_dir() or info.file_size > MAX_MEMBER_BYTES:
                continue
            base = info.filename.replace('\\', '/').rsplit('/', 1)[-1]
            stem, ext = os.path.splitext(base)
            ext = ext.lower()
            if ext not in AUDIO_EXT or base.startswith('.') or '__MACOSX' in info.filename:
                continue
            key = re.sub(r'[^A-Za-z0-9_-]+', '_', stem).strip('_')
            if not key:
                continue
            rank = EXT_RANK[ext]
            if key not in best or rank < best[key][0]:
                best[key] = (rank, info, ext)
        files = {}
        for key, (_, info, ext) in sorted(best.items()):
            dest = os.path.join(out, key + ext)
            with z.open(info) as src, open(dest, 'wb') as f:
                shutil.copyfileobj(src, f, 1 << 20)
            files[key] = dest
    return files


def split_words(stem):
    """'laserLarge_002' -> ['laser', 'Large', '2'], 'jingles_NES03' -> ['jingles', 'NES', '3']"""
    s = re.sub(r'([a-z])([A-Z])', r'\1 \2', stem)
    s = re.sub(r'([A-Za-z])(\d)', r'\1 \2', s)
    s = re.sub(r'(\d)([A-Za-z])', r'\1 \2', s)
    words = [w for w in re.split(r'[\s_\-.]+', s) if w]
    return [str(int(w)) if w.isdigit() else w for w in words]


KEEP_UPPER = {'NES'}  # the only real acronym in the pack file names
RENAME_WORD = {'jingles': 'Jingle'}


def title_of(stem):
    """'laserLarge_002' -> 'Laser Large 2', 'jingles_NES03' -> 'Jingle NES 3'"""
    out = []
    for w in split_words(stem):
        if w in KEEP_UPPER:
            out.append(w)
        else:
            out.append(RENAME_WORD.get(w.lower(), w[:1].upper() + w[1:].lower()))
    return ' '.join(out)


def category(pack, default, stem):
    s = stem.lower()
    for only, pattern, cat in RULES:
        if only and only != pack:
            continue
        if re.search(pattern, s if only else re.sub(r'[^a-z]', '', s)):
            return cat
    return default


def collect(cache):
    sounds, failed = [], []
    for pack, pack_name, default in PACKS:
        try:
            files = extract(pack, download(pack, cache), cache)
        except Exception as err:  # one broken pack must not sink the others
            print(f'!! {pack} failed: {err}', file=sys.stderr)
            failed.append(pack)
            continue
        for stem, path in files.items():
            if SKIP_STEM.search(stem):
                continue
            sounds.append({
                'id': f'{pack}-{slug(stem)}',
                'title': title_of(stem),
                'artist': 'Kenney',
                'mood': category(pack, default, stem),
                'pack': pack_name,
                'src': path,
                'source': 'kenney.nl',
                'sourceUrl': pack_url(pack),
                'license': CC0[0],
                'licenseUrl': CC0[1],
                'credit': '',
            })
        print(f'{pack}: {len(files)} sounds', file=sys.stderr)
    return sounds, failed


# ----------------------------------------------------------------------------


def probe_duration(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
        capture_output=True, text=True, check=True).stdout.strip()
    return round(float(out), 2)


def probe_channels(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels',
         '-of', 'csv=p=0', path], capture_output=True, text=True, check=True).stdout.strip()
    return 2 if out.startswith('2') or (out.isdigit() and int(out) > 2) else 1


# Effects are short, so fewer bars than a song and a higher decode rate, or a
# tenth of a second would have only a handful of samples per bar
PEAK_BARS = 60
PEAK_RATE = 16000


def compute_peaks(path, bars=PEAK_BARS):
    """The loudness (RMS) of each slice of the sound, 0-100, like the music library."""
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(PEAK_RATE), '-f', 's16le', '-'],
        capture_output=True, check=True).stdout
    samples = array('h')
    samples.frombytes(raw[: len(raw) - len(raw) % 2])
    if sys.byteorder != 'little':
        samples.byteswap()
    n = len(samples)
    if n == 0:
        return [0] * bars
    rms = []
    for b in range(bars):
        lo, hi = n * b // bars, max(n * (b + 1) // bars, n * b // bars + 1)
        chunk = samples[lo:min(hi, n)] or samples[n - 1:n]
        rms.append(math.sqrt(sum(x * x for x in chunk) / len(chunk)))
    top = max(rms) or 1
    return [round(100 * v / top) for v in rms]


def main(out_dir, cache):
    os.makedirs(out_dir, exist_ok=True)
    sounds, failed = collect(cache)
    tracks, ids = [], set()
    for s in sounds:
        if s['id'] in ids:
            print(f'!! duplicate id, skipped: {s["id"]}', file=sys.stderr)
            continue
        ids.add(s['id'])
        name = f'{s["id"]}.mp3'
        dest = os.path.join(out_dir, name)
        if not os.path.exists(dest):
            tmp = dest + '.tmp.mp3'
            try:
                # Mono stays mono, stereo stays stereo; no loudness pass, the
                # packs are mastered as sets and a click should stay a click
                subprocess.run(
                    ['ffmpeg', '-v', 'error', '-y', '-i', s['src'], '-vn', '-ac', str(probe_channels(s['src'])),
                     '-c:a', 'libmp3lame', '-b:a', '128k', '-map_metadata', '-1', tmp],
                    check=True)
                os.replace(tmp, dest)
            except Exception as err:
                print(f'!! conversion failed, skipped: {s["id"]}: {err}', file=sys.stderr)
                if os.path.exists(tmp):
                    os.remove(tmp)
                continue
        entry = {k: v for k, v in s.items() if k != 'src'}
        entry['duration'] = probe_duration(dest)
        if entry['duration'] > MAX_SECONDS:
            print(f'-- too long, skipped: {s["id"]} ({entry["duration"]:.0f}s)', file=sys.stderr)
            continue
        entry['file'] = name
        try:
            entry['peaks'] = compute_peaks(dest)
        except Exception as err:  # a sound without a waveform still plays
            print(f'!! no waveform for {s["id"]}: {err}', file=sys.stderr)
        tracks.append(entry)
    order = {c: i for i, (c, _) in enumerate(CATEGORIES)}
    tracks.sort(key=lambda t: (order.get(t['mood'], 99), t['id']))
    library = {
        'version': 2,
        'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'moods': [{'id': c, 'label': label} for c, label in CATEGORIES],
        'tracks': tracks,
    }
    tmp = os.path.join(out_dir, 'library.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(library, f, indent=1)
    os.replace(tmp, os.path.join(out_dir, 'library.json'))
    counts = {}
    for t in tracks:
        counts[t['mood']] = counts.get(t['mood'], 0) + 1
    print(f'{len(tracks)} sounds -> {out_dir}')
    for c, label in CATEGORIES:
        print(f'  {c:<8} {counts.get(c, 0)}')
    if failed:
        print('packs that failed: ' + ', '.join(failed))


if __name__ == '__main__':
    args = sys.argv[1:]
    if args[:1] == ['--list'] and len(args) <= 2:
        got, _ = collect(args[1] if len(args) == 2 else DEFAULT_CACHE)
        for t in got:
            print(f'{t["mood"]:<8} {t["id"]:<48} {t["title"]}')
    elif 1 <= len(args) <= 2 and not args[0].startswith('-'):
        main(args[0], args[1] if len(args) == 2 else DEFAULT_CACHE)
    else:
        sys.exit('usage: build_library.py OUT_DIR [CACHE_DIR] | --list [CACHE_DIR]')
