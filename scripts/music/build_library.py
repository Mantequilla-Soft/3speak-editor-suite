#!/usr/bin/env python3
"""
Builds the editor's music library: downloads songs that may be used
commercially with a credit (CC BY) from a few artists, evens out their
loudness, and writes library.json next to them.

    python3 scripts/music/build_library.py /path/to/editor-music
    python3 scripts/music/build_library.py --list      # what would be included
    python3 scripts/music/build_library.py --peaks /path/to/editor-music
                                  # only (re)compute waveforms, no downloads

The folder is served at /music/ on the editor domains (host nginx), and the
editor reads /music/library.json. Re-running only downloads what is missing.

Sources (each checks the license of every song before taking it, anything
NC / ND / SA or without a stated license is skipped):
  - Kevin MacLeod, incompetech.com: curated titles, CC BY 4.0
  - Sascha Ende, ende.app: download charts + the top of each genre page; the
    license is read from each song page's structured data
  - Jason Shaw, audionautix.com: a few genre pages; the site-wide license page
    is checked; robots.txt asks for 3s between requests
  - Lee Rosevere ("Music For Podcasts") and Josh Woodward (instrumentals):
    their Internet Archive items, license read per item
Free Music Archive is left out on purpose: its robots.txt shuts out AI agents.

Every song needs a credit in the post; the editor sends `credit` with the
video and 3speak.tv appends it to the post body.
"""
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

UA = {'User-Agent': 'Mozilla/5.0 (compatible; 3speak-shorts-editor-music-library; +https://3speak.tv)'}
CC_BY = {
    '4.0': ('CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'),
    '3.0': ('CC BY 3.0', 'https://creativecommons.org/licenses/by/3.0/'),
}
# A plain CC BY license URL (no -nc / -nd / -sa), version 3.0 or 4.0
CC_BY_URL = re.compile(r'creativecommons\.org/licenses/by/([34]\.0)', re.I)

MOODS = [
    ('upbeat', 'Upbeat'),
    ('chill', 'Chill'),
    ('groovy', 'Groovy'),
    ('acoustic', 'Acoustic'),
    ('funny', 'Funny'),
    ('epic', 'Epic'),
    ('suspense', 'Suspense'),
    ('retro', 'Retro'),
    ('background', 'Background'),
]


def slug(text):
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


def fetch(url, pause=0.0):
    if pause:
        time.sleep(pause)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def cc_by(url):
    """(label, url) for a plain CC BY license URL, else None."""
    m = CC_BY_URL.search(url or '')
    return CC_BY[m.group(1)] if m else None


# ---------------------------------------------------------------- incompetech

INCOMPETECH = {
    'upbeat': ['Carefree', 'Wallpaper', 'Beachfront Celebration', 'Happy Alley', 'Cipher',
               'Life of Riley', 'Vivacity', 'Getting it Done'],
    'chill': ['Cool Vibes', 'Lobby Time', 'Chill Wave', 'Bossa Antigua', 'Easy Lemon',
              'Dream Culture', 'Laid Back Guitars', 'Smooth Lovin'],
    'groovy': ['Funkorama', 'Local Forecast - Elevator', 'Blippy Trance', 'Werq',
               'Backbay Lounge', 'Overcast', 'Kool Kats', 'Rollin at 5'],
    'funny': ['Monkeys Spinning Monkeys', 'Fluffing a Duck', 'Sneaky Snitch', 'Investigations',
              'Pixel Peeker Polka - faster', 'Merry Go', 'Quirky Dog', 'Silly Fun'],
    'epic': ['Heroic Age', 'Adventure Meme', 'Volatile Reaction', 'Hitman', 'Take a Chance',
             'Rising Game', 'Eighties Action', 'Unity'],
    'suspense': ['Constance', 'Nerves', 'Covert Affair', 'Anamalie', 'Firesong',
                 'Crossing the Chasm', 'Night on the Docks - Sax', 'Arcadia'],
    'retro': ['Itty Bitty 8 Bit', 'Voxel Revolution', 'Bit Shift', 'Hot Swing', 'Neo Western'],
}


def source_incompetech():
    catalog = {p['title'].lower(): p for p in json.loads(fetch('https://incompetech.com/music/royalty-free/pieces.json'))}
    label, lurl = CC_BY['4.0']
    for mood, titles in INCOMPETECH.items():
        for title in titles:
            p = catalog.get(title.lower())
            if not p:
                print(f'!! incompetech: not in catalog: {title}', file=sys.stderr)
                continue
            yield {
                # Kept as the bare slug: ids of the first library must not change
                'id': slug(title),
                'title': p['title'],
                'artist': 'Kevin MacLeod',
                'mood': mood,
                'feel': p.get('feel') or '',
                'bpm': int(p['bpm']) if str(p.get('bpm') or '').isdigit() else None,
                'fetch': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/' + urllib.parse.quote(p['filename']),
                'source': 'incompetech.com',
                'sourceUrl': ('https://incompetech.com/music/royalty-free/index.html?isrc=' + p['isrc'])
                if p.get('isrc') else 'https://incompetech.com',
                'license': label,
                'licenseUrl': lurl,
                # The wording incompetech asks for
                'credit': f'"{p["title"]}" Kevin MacLeod (incompetech.com)\n'
                          f'Licensed under Creative Commons: By Attribution 4.0 License\n{lurl}',
            }


# ------------------------------------------------------------------ ende.app

ENDE_GENRES = {  # genre page -> mood
    'lofi-chill-beats': 'chill', 'funk': 'groovy', 'hiphop-rap': 'groovy', 'soul-rnb': 'groovy',
    'pop': 'upbeat', 'dance-club': 'upbeat', 'electronica': 'upbeat', 'acoustic': 'acoustic',
    'cinematic': 'epic', 'rock': 'epic', 'ambient': 'background',
}
ENDE_PER_GENRE = 4
ENDE_CHARTS = 20


# Titles that don't belong in a general-audience picker, or are arrangements
# of someone else's composition
SKIP_TITLE = re.compile(r'sexy|feat\.|zarathustra|liberals', re.I)
# The title says more about the mood than the genre does
TITLE_MOOD = [
    (re.compile(r'comedy|funny|quirky', re.I), 'funny'),
    (re.compile(r'backrooms|horror|thriller|suspense|creepy', re.I), 'suspense'),
    (re.compile(r'\b80s\b|8.?bit|chiptune|retro|arcade', re.I), 'retro'),
    (re.compile(r'lo-?fi', re.I), 'chill'),
]
MAX_SECONDS = 480  # longer pieces (meditations, suites) are no use in a short


def title_mood(title):
    for pattern, mood in TITLE_MOOD:
        if pattern.search(title):
            return mood
    return None


def ende_mood(genre_text, fallback):
    g = (genre_text or '').lower()
    for key, mood in (('lofi', 'chill'), ('lo-fi', 'chill'), ('chill', 'chill'), ('funk', 'groovy'),
                      ('hip', 'groovy'), ('soul', 'groovy'), ('acoustic', 'acoustic'), ('folk', 'acoustic'),
                      ('cinematic', 'epic'), ('orchestra', 'epic'), ('rock', 'epic'), ('ambient', 'background'),
                      ('pop', 'upbeat'), ('dance', 'upbeat'), ('electro', 'upbeat')):
        if key in g:
            return mood
    return fallback


def source_ende():
    song_link = re.compile(r'href="(https://ende\.app/en/song/(\d+)-[^"]+)"')
    picks = []  # (url, mood hint)
    seen = set()

    def take(page_url, limit, mood):
        page = fetch(page_url, pause=1).decode('utf-8', 'replace')
        n = 0
        for url, sid in song_link.findall(page):
            if sid in seen:
                continue
            seen.add(sid)
            picks.append((url, mood))
            n += 1
            if n >= limit:
                break

    take('https://ende.app/en/charts', ENDE_CHARTS, None)
    for genre, mood in ENDE_GENRES.items():
        take(f'https://ende.app/en/genres/{genre}', ENDE_PER_GENRE, mood)

    ld_block = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)
    for url, mood_hint in picks:
        page = fetch(url, pause=1).decode('utf-8', 'replace')
        song = None
        for block in ld_block.findall(page):
            try:
                d = json.loads(block)
            except ValueError:
                continue
            if d.get('@type') == 'MusicComposition' and d.get('audio'):
                song = d
                break
        lic = cc_by(song.get('license') if song else '')
        if not song or not lic:
            print(f'!! ende: skipped (no CC BY license found): {url}', file=sys.stderr)
            continue
        title = re.sub(r'\s+', ' ', html.unescape(song['name'])).strip()
        if SKIP_TITLE.search(title):
            continue
        label, lurl = lic
        yield {
            'id': 'ende-' + url.rsplit('/', 1)[1],
            'title': title,
            'artist': 'Sascha Ende',
            'mood': title_mood(title) or ende_mood(song.get('genre'), mood_hint or 'upbeat'),
            'feel': song.get('genre') or '',
            'bpm': None,
            # The song page's own player file (128k), robots.txt allows /storage/
            'fetch': song['audio'],
            'source': 'ende.app',
            'sourceUrl': url,
            'license': label,
            'licenseUrl': lurl,
            'credit': f'"{title}" by Sascha Ende (ende.app)\nLicense: {label} ({lurl})',
        }


# --------------------------------------------------------------- audionautix

AUDIONAUTIX_GENRES = {  # genre page -> mood
    'lo-fi': 'chill', 'easy-listening': 'chill', 'jazz-funk': 'groovy', 'pop-funk': 'groovy',
    'hip-hop': 'groovy', 'acoustic': 'acoustic', 'folk': 'acoustic', 'dance': 'upbeat',
    'top-40': 'upbeat', 'soundtrack': 'epic', 'rock': 'epic', 'meditative': 'background',
}
AUDIONAUTIX_PER_GENRE = 4
AUDIONAUTIX_PAUSE = 3  # robots.txt Crawl-delay


def source_audionautix():
    terms = fetch('https://audionautix.com/creative-commons-music', pause=AUDIONAUTIX_PAUSE).decode('utf-8', 'replace')
    if 'Attribution 4.0' not in terms:
        print('!! audionautix: license page no longer says Attribution 4.0, skipping the source', file=sys.stderr)
        return
    label, lurl = CC_BY['4.0']
    block = re.compile(r'<h3>(.*?)</h3>(.*?)href="(/Music/+[^"]+\.mp3)"', re.S)
    seen = set()
    for genre, mood in AUDIONAUTIX_GENRES.items():
        page = fetch(f'https://audionautix.com/free-music/{genre}', pause=AUDIONAUTIX_PAUSE).decode('utf-8', 'replace')
        n = 0
        for raw_title, meta, path in block.findall(page):
            title = html.unescape(re.sub(r'<[^>]+>', '', raw_title)).strip()
            # Titles carry their length, "Jellyfish (3:22)", sometimes a stray " Hs"
            title = re.sub(r'\s*\(\d+:\d\d\)\s*(Hs)?$', '', title).strip()
            if not title or title.lower() in seen or title.lower() == 'free music' or SKIP_TITLE.search(title):
                continue
            seen.add(title.lower())
            feel = re.search(r'Mood:</td>\s*<td><a[^>]*>([^<]*)</a>', meta)
            yield {
                'id': 'audionautix-' + slug(title),
                'title': title,
                'artist': 'Jason Shaw',
                'mood': mood,
                'feel': html.unescape(feel.group(1)).strip() if feel else '',
                'bpm': None,
                'fetch': 'https://audionautix.com' + urllib.parse.quote(re.sub('/+', '/', path)),
                'source': 'audionautix.com',
                'sourceUrl': 'https://audionautix.com',
                'license': label,
                'licenseUrl': lurl,
                # The credit the site asks for
                'credit': f'"{title}" by Jason Shaw, music by audionautix.com\nLicense: {label} ({lurl})',
            }
            n += 1
            if n >= AUDIONAUTIX_PER_GENRE:
                break


# ----------------------------------------------------------- Internet Archive

ARCHIVE_ITEMS = [
    # (item, artist, mood, max tracks)
    ('MusicForPodcasts01', 'Lee Rosevere', 'background', 6),
    ('MusicForPodcasts02', 'Lee Rosevere', 'background', 6),
    ('MusicForPodcasts03', 'Lee Rosevere', 'background', 6),
    ('MusicForPodcasts04', 'Lee Rosevere', 'background', 6),
    ('leerosevere_musicforpodcasts_5', 'Lee Rosevere', 'background', 8),
    ('leerosevere_musicforpodcasts_6', 'Lee Rosevere', 'background', 8),
    ('JoshWoodward-TheShadeFromOurTrees-NoVox', 'Josh Woodward', 'acoustic', 8),
    ('cover_Josh_Woodward_-_Addressed_to_the_Stars', 'Josh Woodward', 'acoustic', 8),
    ('josh-woodward-sandcastles-novox', 'Josh Woodward', 'acoustic', 8),
    ('jamendo-117652', 'Josh Woodward', 'acoustic', 6),
]


def clean_archive_title(name, meta_title, artist):
    t = meta_title or os.path.splitext(name)[0]
    t = re.sub(r'^\s*' + re.escape(artist) + r'\s*-\s*', '', t, flags=re.I)
    t = re.sub(r'^.*?-\s*\d{1,2}\s+', '', t) if re.match(r'^.*-\s*\d{1,2}\s+', t) else t
    t = re.sub(r'^\d{1,2}[\s._-]+', '', t)
    return t.strip()


def source_archive():
    for item, artist, mood, limit in ARCHIVE_ITEMS:
        meta = json.loads(fetch(f'https://archive.org/metadata/{item}', pause=0.5))
        lic = cc_by((meta.get('metadata') or {}).get('licenseurl'))
        if not lic:
            print(f'!! archive: {item} has no plain CC BY license, skipped', file=sys.stderr)
            continue
        label, lurl = lic
        files = [f for f in meta.get('files', [])
                 if f.get('name', '').lower().endswith('.mp3') and f.get('source') == 'original']
        # Some items only carry derived MP3s next to FLAC/WAV originals
        if not files:
            files = [f for f in meta.get('files', []) if f.get('name', '').lower().endswith('.mp3')]
        files.sort(key=lambda f: f['name'])
        taken = 0
        for f in files:
            length = float(f.get('length') or 0) if re.match(r'^[\d.]+$', str(f.get('length') or '')) else 0
            if length and length < 30:
                continue  # stings and bumpers
            title = clean_archive_title(f['name'], f.get('title'), artist)
            if not title or SKIP_TITLE.search(title):
                continue
            if 'novox' in f['name'].lower() and 'instrumental' not in title.lower():
                title += ' (Instrumental)'
            page = f'https://archive.org/details/{item}'
            yield {
                'id': f'{slug(artist)}-{slug(title)}',
                'title': title,
                'artist': artist,
                'mood': mood,
                'feel': '',
                'bpm': None,
                'fetch': f'https://archive.org/download/{item}/' + urllib.parse.quote(f['name']),
                'source': 'archive.org',
                'sourceUrl': page,
                'license': label,
                'licenseUrl': lurl,
                'credit': f'"{title}" by {artist} ({page})\nLicense: {label} ({lurl})',
            }
            taken += 1
            if taken >= limit:
                break


SOURCES = [source_incompetech, source_ende, source_audionautix, source_archive]

# ----------------------------------------------------------------------------


def probe_duration(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
        capture_output=True, text=True, check=True).stdout.strip()
    return round(float(out), 2)


# Bars in the waveform the library shows for each song. Enough to tell a quiet
# intro from a drop at a glance, small enough to ship all of them in library.json.
PEAK_BARS = 120
PEAK_RATE = 4000  # Hz, decoding for the shape only


def compute_peaks(path, bars=PEAK_BARS):
    """The loudness of each slice of the song, 0-100, for drawing its waveform.

    RMS per slice rather than the raw peak: after loudness normalisation almost
    every slice peaks near the ceiling, and a row of equal bars says nothing
    about the music. RMS shows the quiet intro, the build and the drop.
    """
    from array import array
    import math
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
        chunk = samples[lo:hi]
        rms.append(math.sqrt(sum(x * x for x in chunk) / len(chunk)))
    top = max(rms) or 1
    return [round(100 * v / top) for v in rms]


def add_peaks(out_dir):
    """Waveforms for the songs already in out_dir, without scraping anything."""
    path = os.path.join(out_dir, 'library.json')
    with open(path) as f:
        library = json.load(f)
    done = 0
    for t in library['tracks']:
        if t.get('peaks') and len(t['peaks']) == PEAK_BARS:
            continue
        try:
            t['peaks'] = compute_peaks(os.path.join(out_dir, t['file']))
            done += 1
        except Exception as err:
            print(f'!! no waveform for {t["title"]}: {err}', file=sys.stderr)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(library, f, indent=1)
    os.replace(tmp, path)
    print(f'waveforms added for {done} songs -> {path}')


def collect():
    tracks, ids = [], set()
    for src in SOURCES:
        try:
            got = 0
            for t in src():
                if t['id'] in ids:
                    continue
                ids.add(t['id'])
                tracks.append(t)
                got += 1
            print(f'{src.__name__}: {got} songs', file=sys.stderr)
        except Exception as err:  # one broken site must not sink the others
            print(f'!! {src.__name__} failed: {err}', file=sys.stderr)
    return tracks


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tracks = []
    for t in collect():
        name = f'{t["id"]}.mp3'
        dest = os.path.join(out_dir, name)
        if not os.path.exists(dest):
            print(f'.. {t["artist"]}: {t["title"]}')
            raw = dest + '.src'
            try:
                with open(raw, 'wb') as f:
                    f.write(fetch(t['fetch'], pause=AUDIONAUTIX_PAUSE if t['source'] == 'audionautix.com' else 0.5))
                # Same loudness for every song, so switching doesn't jump in volume
                subprocess.run(
                    ['ffmpeg', '-v', 'error', '-y', '-i', raw, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
                     '-ar', '44100', '-ac', '2', '-b:a', '128k', '-map_metadata', '-1', dest],
                    check=True)
            except Exception as err:
                print(f'!! download failed, skipped: {t["title"]}: {err}', file=sys.stderr)
                if os.path.exists(dest):
                    os.remove(dest)
                continue
            finally:
                if os.path.exists(raw):
                    os.remove(raw)
        entry = {k: v for k, v in t.items() if k != 'fetch'}
        entry['duration'] = probe_duration(dest)
        if entry['duration'] > MAX_SECONDS:
            print(f'-- too long, skipped: {t["title"]} ({entry["duration"]:.0f}s)', file=sys.stderr)
            continue
        entry['file'] = name
        try:
            entry['peaks'] = compute_peaks(dest)
        except Exception as err:  # a song without a waveform still plays
            print(f'!! no waveform for {t["title"]}: {err}', file=sys.stderr)
        tracks.append(entry)
    library = {
        'version': 2,
        'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'moods': [{'id': m, 'label': label} for m, label in MOODS],
        'tracks': tracks,
    }
    tmp = os.path.join(out_dir, 'library.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(library, f, indent=1)
    os.replace(tmp, os.path.join(out_dir, 'library.json'))
    print(f'{len(tracks)} songs -> {out_dir}')


if __name__ == '__main__':
    if sys.argv[1:] == ['--list']:
        for t in collect():
            print(f'{t["mood"]:<11} {t["artist"]:<14} {t["license"]:<10} {t["title"]}')
    elif len(sys.argv) == 3 and sys.argv[1] == '--peaks':
        add_peaks(sys.argv[2])
    elif len(sys.argv) == 2:
        main(sys.argv[1])
    else:
        sys.exit('usage: build_library.py OUT_DIR | --list | --peaks OUT_DIR')
