#!/usr/bin/env python3
"""
Builds the editor's stock media library: b-roll videos, photos and animated
GIFs that anyone may use, also commercially, with no credit needed (CC0 or
public domain). Everything is downloaded onto our own server, cut and
re-encoded to an editing size, and listed in library.json next to it.

    python3 -I scripts/stock/build_library.py /path/to/stock-library
    python3 -I scripts/stock/build_library.py --list          # what would be taken
    python3 -I scripts/stock/build_library.py --per-query 1 OUT   # a quick small build

The folder is served at /stock/ on the editor domains (host nginx, like /music/
and /stickers/) and the editor reads /stock/library.json. Re-running only
fetches what is missing; items removed from the source or listed in
scripts/stock/exclude.txt or OUT/exclude.txt (one id per line) are dropped.

Source: Wikimedia Commons (API, no key). Every file's licence is checked on its
own file page metadata before it is taken:
  - licence CC0 or public domain (extmetadata License / LicenseShortName)
  - no attribution required (AttributionRequired is not "true")
  - no restrictions (personality rights, trademark, insignia...)
  - nothing in title, description or categories from SKIP_WORDS
Openverse (api.openverse.org) would add Flickr CC0 photos, but it answers this
server with a Cloudflare challenge, so it is not used. Pexels and Pixabay need
an API key; the editor backend can search them live when PEXELS_API_KEY /
PIXABAY_API_KEY are set (backend/src/routes/stock.js), downloading the chosen
file to the server first.

Outputs (OUT):
  videos/<id>.mp4    H.264, at most 1920 on the long side and 1080 on the short
                     side, at most 30 fps, at most 15 s, no sound, faststart
  gifs/<id>.mp4      an animated GIF as a muted H.264 loop (at least 3 s)
  images/<id>.jpg    at most 1920 on the long side
  thumbs/<id>.jpg    320 px wide poster
  previews/<id>.mp4  a 4 s, 320 px wide silent clip for hover previews (videos, GIFs)
  library.json       { version, generated, categories, items }

Stdlib only; needs ffmpeg/ffprobe and curl on PATH. Videos are read by ffmpeg
straight from Commons (only the seconds that are used); photos and GIFs land in
OUT/.incoming/<id>/ and are treated as data (only ffmpeg reads them), deleted
once the item is encoded.
"""
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

CONTACT = 'https://3speak.tv; tibfox@gmail.com'
UA = f'3SpeakEditorStockLibrary/1.0 ({CONTACT}) python-urllib'
API = 'https://commons.wikimedia.org/w/api.php'
API_PAUSE = 1.0        # seconds between API calls
DOWNLOAD_PAUSE = 3.0   # seconds between file downloads (upload.wikimedia.org answers 429 when hurried)

# CC0 or public domain (Commons structured data: P275 licence = CC0, or P6216
# copyright status = public domain). The file page metadata is checked again.
LICENCE_FILTER = 'haswbstatement:P275=Q6938433|P6216=Q19652'
CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/'
PD_URL = 'https://creativecommons.org/publicdomain/mark/1.0/'

MAX_VIDEO_SECONDS = 15
MIN_VIDEO_SECONDS = 3
MAX_SOURCE_BYTES = 300 * 1024 * 1024
MAX_GIF_BYTES = 25 * 1024 * 1024

CATEGORIES = [
    {'id': 'nature', 'label': 'Nature'},
    {'id': 'city', 'label': 'City'},
    {'id': 'people', 'label': 'People'},
    {'id': 'animals', 'label': 'Animals'},
    {'id': 'food', 'label': 'Food'},
    {'id': 'tech', 'label': 'Tech'},
    {'id': 'sports', 'label': 'Sports'},
    {'id': 'space', 'label': 'Space'},
    {'id': 'abstract', 'label': 'Abstract'},
    {'id': 'backgrounds', 'label': 'Backgrounds'},
]

# category -> (video searches, photo searches); each search adds up to
# --per-query items of that kind
QUERIES = {
    'nature': (['ocean waves', 'waterfall', 'forest', 'clouds timelapse', 'river', 'flowers wind'],
               ['mountain landscape', 'forest path', 'beach', 'flower meadow']),
    'city': (['city traffic', 'street night', 'city timelapse', 'train', 'skyline'],
             ['city skyline', 'street', 'bridge city', 'night city']),
    'people': (['people walking', 'crowd street', 'hands', 'dance'],
               ['people walking', 'crowd', 'hands working']),
    'animals': (['bird', 'cat', 'dog', 'fish aquarium', 'horse'],
                ['cat', 'dog', 'bird', 'butterfly']),
    'food': (['cooking', 'coffee', 'fruit', 'bread'],
             ['food', 'coffee cup', 'fruit', 'vegetables']),
    'tech': (['computer', 'keyboard typing', 'circuit', 'robot', '3D printer'],
             ['laptop', 'circuit board', 'server room', 'smartphone']),
    'sports': (['football', 'running', 'cycling', 'surfing', 'skateboard', 'swimming'],
               ['stadium', 'bicycle', 'surfing', 'basketball']),
    'space': (['earth from space', 'rocket launch', 'galaxy', 'moon', 'aurora'],
              ['galaxy', 'nebula', 'earth from space', 'moon']),
    'abstract': (['abstract animation', 'fractal zoom', 'light', 'ink in water', 'particles'],
                 ['abstract', 'bokeh', 'fractal', 'light painting']),
    'backgrounds': (['sky', 'water surface', 'candle', 'rain'],
                    ['texture', 'blue sky', 'wood texture', 'paper texture', 'stone wall']),
}
# GIF searches -> category
GIF_QUERIES = [
    ('animation loop', 'abstract'), ('animated', 'abstract'), ('animation', 'tech'),
    ('gears animation', 'tech'), ('animated earth', 'space'), ('walking animation', 'people'),
    ('animal animation', 'animals'), ('weather animation', 'nature'),
]

# Never in a general-audience library (title, description, categories)
SKIP_WORDS = re.compile(r'\b(?:' + '|'.join([
    'nude', 'nudes', 'nudity', 'naked', 'nsfw', 'sex', 'sexual', 'sexy', 'erotic', 'erotica', 'porn',
    'pornography', 'genital', 'genitals', 'penis', 'vagina', 'breast', 'breasts', 'topless', 'lingerie',
    'bikini', 'underwear', 'corpse', 'corpses', 'dead', 'death', 'cadaver', 'autopsy', 'surgery',
    'surgical', 'wound', 'wounds', 'blood', 'bloody', 'gore', 'injury', 'injured', 'accident', 'crash',
    'war', 'wars', 'wartime', 'military', 'army', 'soldier', 'soldiers', 'weapon', 'weapons', 'gun',
    'guns', 'rifle', 'bomb', 'bombs', 'bombing', 'missile', 'missiles', 'explosion', 'execution',
    'nazi', 'nazis', 'swastika', 'hitler', 'terror', 'terrorism', 'terrorist', 'protest', 'protests',
    'riot', 'riots', 'police', 'prison', 'funeral', 'cemetery', 'grave', 'graves', 'disease',
    'patient', 'patients', 'hospital', 'medical', 'syringe', 'drug', 'drugs', 'cigarette', 'smoking',
    'alcohol', 'beer', 'wine', 'religion', 'religious', 'church', 'mosque', 'bible', 'quran', 'politics',
    'political', 'politician', 'election', 'president', 'campaign', 'logo', 'logos', 'trademark',
    'advertisement', 'advertising', 'brand', 'child', 'children', 'kid', 'kids', 'baby', 'babies',
    'toddler', 'schoolchildren', 'pupils', 'minor', 'minors', 'slaughter', 'hunting', 'butcher',
    'inmate', 'inmates', 'prisoner', 'prisoners', 'shackles', 'handcuffs', 'wreck', 'wreckage', 'disaster',
    'fire', 'fires', 'wildfire', 'wildfires', 'smoke', 'flood', 'hurricane', 'tornado', 'earthquake',
    'ntsb', 'usda', 'careers', 'dressing', 'undressing', 'bathing', 'bath', 'locomotion', 'muybridge',
]) + r')\b', re.I)

TAG_STOP = {'the', 'a', 'an', 'of', 'in', 'on', 'and', 'at', 'to', 'with', 'from', 'by', 'for', 'file',
            'ogv', 'webm', 'gif', 'jpg', 'jpeg', 'png', 'tif', 'mp4', 'video', 'image', 'photo', 'and'}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


_last_api = [0.0]


def api(params):
    """One Commons API call (polite: a pause between calls, maxlag, a contact UA)."""
    wait = API_PAUSE - (time.time() - _last_api[0])
    if wait > 0:
        time.sleep(wait)
    q = {'format': 'json', 'formatversion': '2', 'maxlag': '5', **params}
    url = f'{API}?{urllib.parse.urlencode(q)}'
    for attempt in range(4):
        _last_api[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.loads(r.read().decode('utf-8'))
            if d.get('error', {}).get('code') == 'maxlag':
                time.sleep(5 * (attempt + 1))
                continue
            return d
        except Exception as e:  # network hiccup: back off
            log(f'  api retry ({e})')
            time.sleep(5 * (attempt + 1))
    return {}


def plain(s):
    """extmetadata values are HTML snippets."""
    s = re.sub(r'<[^>]+>', ' ', s or '')
    return re.sub(r'\s+', ' ', html.unescape(s)).strip()


def meta(ii, key):
    return plain(((ii.get('extmetadata') or {}).get(key) or {}).get('value', ''))


def licence_of(ii):
    """('CC0' | 'Public domain', url) when the file may be used freely with no credit, else None."""
    code = meta(ii, 'License').lower()
    short = meta(ii, 'LicenseShortName')
    if meta(ii, 'AttributionRequired').lower() == 'true':
        return None
    if meta(ii, 'Restrictions'):
        return None
    if meta(ii, 'NonFree').lower() == 'true':
        return None
    s = short.lower()
    if code == 'cc0' or s.startswith('cc0') or s.startswith('cc-zero'):
        return ('CC0', CC0_URL)
    if code == 'pd' or code.startswith('pd-') or s.startswith('public domain') or s == 'pd' or s.startswith('pd-') or s == 'pdm':
        url = meta(ii, 'LicenseUrl')
        return ('Public domain', url if url.startswith('http') else PD_URL)
    return None


def tags_of(title, query, category, ii):
    words = re.findall(r'[a-z][a-z\-]{2,}', f'{title} {query}'.lower())
    cats = meta(ii, 'Categories').lower().split('|')
    for c in cats[:8]:
        words += re.findall(r'[a-z][a-z\-]{2,}', c)
    seen = []
    for w in words + [category]:
        if w not in TAG_STOP and w not in seen and not w.isdigit():
            seen.append(w)
    return seen[:16]


def clean_title(title):
    t = re.sub(r'^File:', '', title)
    t = re.sub(r'\.(ogv|webm|gif|jpe?g|png|tiff?|mpg|mpeg|mov|mp4)$', '', t, flags=re.I)
    t = t.replace('_', ' ')
    t = re.sub(r'\s+', ' ', t).strip()
    return t[:80]


def search(query, kind, limit):
    """Candidate files for a search: kind video | image | gif."""
    flt = {'video': 'filetype:video', 'image': 'filetype:bitmap -filemime:image/gif filew:>1279',
           'gif': 'filemime:image/gif filew:>299'}[kind]
    d = api({
        'action': 'query', 'generator': 'search', 'gsrnamespace': '6', 'gsrlimit': str(limit),
        'gsrsearch': f'{query} {flt} {LICENCE_FILTER}',
        'prop': 'imageinfo', 'iiprop': 'url|size|mime|extmetadata|metadata',
        'iiurlwidth': '1920',
        'iiextmetadatafilter': 'LicenseShortName|License|LicenseUrl|AttributionRequired|Restrictions|NonFree|Artist|ImageDescription|Categories|ObjectName',
    })
    pages = (d.get('query') or {}).get('pages') or []
    pages.sort(key=lambda p: p.get('index', 0))
    return pages


def gif_frames(ii):
    for m in ii.get('metadata') or []:
        if m.get('name') == 'frameCount':
            try:
                return int(m.get('value'))
            except (TypeError, ValueError):
                return 0
    return 0


def acceptable(page, kind):
    """(reason to skip) or None."""
    ii = (page.get('imageinfo') or [None])[0]
    if not ii:
        return 'no file info'
    if not licence_of(ii):
        return f'licence {meta(ii, "LicenseShortName") or "?"}'
    text = ' '.join([page.get('title', ''), meta(ii, 'ImageDescription'), meta(ii, 'ObjectName'), meta(ii, 'Categories')])
    if SKIP_WORDS.search(text):
        return f'topic ({SKIP_WORDS.search(text).group(0)})'
    w, h = ii.get('width') or 0, ii.get('height') or 0
    size = ii.get('size') or 0
    if kind == 'video':
        dur = float(ii.get('duration') or 0)
        if not ii.get('mime', '').startswith(('video/', 'application/ogg')):
            return 'not a video'
        if dur < MIN_VIDEO_SECONDS:
            return 'too short'
        if min(w, h) < 480:
            return 'too small'
        if size > MAX_SOURCE_BYTES:
            return 'source too big'
    elif kind == 'image':
        if max(w, h) < 1280:
            return 'too small'
        if not ii.get('mime', '') in ('image/jpeg', 'image/png', 'image/tiff', 'image/webp'):
            return 'not a photo'
    elif kind == 'gif':
        if gif_frames(ii) < 4:
            return 'not animated'
        if size > MAX_GIF_BYTES:
            return 'too big'
    return None


def run(cmd, timeout=900):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode('utf-8', 'replace')[-600:])
    return p.stdout


_last_dl = [0.0]


def polite_wait():
    wait = DOWNLOAD_PAUSE - (time.time() - _last_dl[0])
    if wait > 0:
        time.sleep(wait)
    _last_dl[0] = time.time()


def download(url, dest):
    polite_wait()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    run(['curl', '-sSfL', '--retry', '3', '--retry-delay', '5', '-A', UA,
         '--max-filesize', str(MAX_SOURCE_BYTES), '-o', dest, url], timeout=1800)


def probe(path):
    out = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
               'stream=width,height:format=duration', '-of', 'json', path], timeout=120)
    d = json.loads(out)
    st = (d.get('streams') or [{}])[0]
    return {'width': int(st.get('width') or 0), 'height': int(st.get('height') or 0),
            'duration': float((d.get('format') or {}).get('duration') or 0)}


# Fit inside 1920x1080 (or 1080x1920 for portrait), never upscaled, even sizes
FIT = ("scale='if(gte(iw,ih),min(1920,iw),-2)':'if(gte(iw,ih),-2,min(1920,ih))',"
       "scale='if(gte(iw,ih),-2,min(1080,iw))':'if(gte(iw,ih),min(1080,ih),-2)',"
       "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1")
X264 = ['-c:v', 'libx264', '-threads', '3', '-preset', 'faster', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an']


def make_preview(src, out_preview, out_thumb, start=0.0, seconds=4.0):
    run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.2f}', '-i', src, '-t', f'{seconds:.2f}',
         '-vf', 'fps=24,scale=320:-2:flags=bicubic,setsar=1', '-c:v', 'libx264', '-preset', 'veryfast',
         '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out_preview])
    run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{min(1.0, seconds / 2):.2f}', '-i', out_preview,
         '-frames:v', '1', '-q:v', '4', out_thumb])


def encode_video(src, out, thumb, preview, duration):
    """src: the file's URL. ffmpeg reads only the part it needs (a few MB
    instead of the whole original), with our user agent."""
    polite_wait()
    dur = duration
    start = min(1.0, dur * 0.05) if dur > MAX_VIDEO_SECONDS + 1 else 0.0
    length = min(MAX_VIDEO_SECONDS, dur - start)
    args = ['ffmpeg', '-v', 'error', '-y', '-user_agent', UA, '-rw_timeout', '60000000',
            '-ss', f'{start:.2f}', '-i', src, '-t', f'{length:.2f}',
            '-vf', f'{FIT},fps=30', *X264, out]
    for attempt in range(3):
        try:
            run(args, timeout=1800)
            break
        except RuntimeError as e:
            # rate limited (429 shows up as "4XX"): wait and try again, a little longer each time
            if '4XX' not in str(e) or attempt == 2:
                raise
            log(f'  rate limited, waiting {60 * (attempt + 1)} s')
            time.sleep(60 * (attempt + 1))
    make_preview(out, preview, thumb, 0, min(4.0, length))
    return probe(out)


def encode_gif(src, out, thumb, preview):
    info = probe(src)
    loops = 0 if info['duration'] >= 3 else int(3 / max(0.1, info['duration']))
    # transparent parts become black; the GIF plays at least 3 s
    run(['ffmpeg', '-v', 'error', '-y', '-stream_loop', str(loops), '-i', src,
         '-filter_complex', f'color=black:s={max(2, info["width"])}x{max(2, info["height"])}[bg];[bg][0:v]overlay=shortest=1,{FIT},fps=30',
         '-t', str(MAX_VIDEO_SECONDS), *X264, out], timeout=600)
    o = probe(out)
    make_preview(out, preview, thumb, 0, min(4.0, o['duration']))
    return o


def encode_image(src, out, thumb):
    run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-frames:v', '1',
         '-vf', "scale='if(gte(iw,ih),min(1920,iw),-2)':'if(gte(iw,ih),-2,min(1920,ih))',format=yuvj444p",
         '-q:v', '3', out])
    run(['ffmpeg', '-v', 'error', '-y', '-i', out, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', thumb])
    return probe(out)


def candidates(per_query):
    """Every (kind, category, query, page) the searches give, first come first."""
    for cat in CATEGORIES:
        vq, iq = QUERIES[cat['id']]
        for q in vq:
            yield from (('video', cat['id'], q, p) for p in search(q, 'video', per_query * 4))
        for q in iq:
            yield from (('image', cat['id'], q, p) for p in search(q, 'image', per_query * 4))
    for q, cat in GIF_QUERIES:
        yield from (('gif', cat, q, p) for p in search(q, 'gif', per_query * 4))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out', nargs='?', help='output folder (served at /stock/)')
    ap.add_argument('--list', action='store_true', help='only list what would be taken')
    ap.add_argument('--per-query', type=int, default=2, help='items taken per search (default 2)')
    ap.add_argument('--max-items', type=int, default=300, help='stop after this many items (default 300)')
    ap.add_argument('--offline', action='store_true',
                    help='download nothing: rebuild the list from the items already in OUT (after editing exclude.txt)')
    args = ap.parse_args()
    if not args.list and not args.out:
        ap.error('give the output folder, or --list')

    out = os.path.abspath(args.out) if args.out else None
    old = {}
    exclude = set()
    if out:
        for sub in ('videos', 'gifs', 'images', 'thumbs', 'previews', '.incoming'):
            os.makedirs(os.path.join(out, sub), exist_ok=True)
        try:
            with open(os.path.join(out, 'library.json'), encoding='utf-8') as f:
                old = {it['id']: it for it in json.load(f).get('items', [])}
        except (OSError, ValueError):
            old = {}
        # left out by hand: scripts/stock/exclude.txt (reviewed list) plus OUT/exclude.txt (local)
        for ex in (os.path.join(os.path.dirname(os.path.abspath(__file__)), 'exclude.txt'), os.path.join(out, 'exclude.txt')):
            try:
                with open(ex, encoding='utf-8') as f:
                    exclude |= {ln.strip() for ln in f if ln.strip() and not ln.startswith('#')}
            except OSError:
                pass

    items = []
    seen = set()
    taken = {}  # (kind, category, query) -> count
    skipped = 0
    if args.offline:
        if not out:
            ap.error('--offline needs the output folder')
        items = [it for it in old.values() if it['id'] not in exclude and
                 all(os.path.exists(os.path.join(out, it[k])) for k in ('file', 'thumb', 'preview') if it.get(k))]
    for kind, cat, q, page in ([] if args.offline else candidates(args.per_query)):
        if len(items) >= args.max_items:
            break
        key = (kind, cat, q)
        if taken.get(key, 0) >= args.per_query:
            continue
        pid = page.get('pageid')
        iid = f'wm{pid}'
        if not pid or iid in seen:
            continue
        if iid in exclude:
            # its slot stays empty: a left-out item is not replaced by the next (usually weaker) result
            taken[key] = taken.get(key, 0) + 1
            continue
        why = acceptable(page, kind)
        if why:
            skipped += 1
            log(f'  skip {page.get("title")}: {why}')
            continue
        seen.add(iid)
        ii = page['imageinfo'][0]
        lic, lic_url = licence_of(ii)
        item = {
            'id': iid, 'type': kind, 'category': cat, 'title': clean_title(page['title']),
            'tags': tags_of(clean_title(page['title']), q, cat, ii),
            'source': 'Wikimedia Commons', 'author': meta(ii, 'Artist')[:120] or 'Unknown',
            'license': lic, 'licenseUrl': lic_url,
            'sourceUrl': ii.get('descriptionurl') or f'https://commons.wikimedia.org/wiki/{urllib.parse.quote(page["title"])}',
        }
        if args.list:
            print(f'{kind:5} {cat:11} {lic:13} {item["title"]}  <{item["sourceUrl"]}>')
            items.append(item)
            taken[key] = taken.get(key, 0) + 1
            continue

        folder = {'video': 'videos', 'gif': 'gifs', 'image': 'images'}[kind]
        ext = 'jpg' if kind == 'image' else 'mp4'
        rel = f'{folder}/{iid}.{ext}'
        thumb = f'thumbs/{iid}.jpg'
        preview = f'previews/{iid}.mp4' if kind != 'image' else None
        have = all(os.path.exists(os.path.join(out, p)) for p in [rel, thumb] + ([preview] if preview else []))
        if have and iid in old:
            items.append({**old[iid], **item, 'file': rel, 'thumb': thumb, **({'preview': preview} if preview else {})})
            taken[key] = taken.get(key, 0) + 1
            continue
        incoming = os.path.join(out, '.incoming', iid)
        try:
            src_url = ii['thumburl'] if kind == 'image' and ii.get('thumburl') else ii['url']
            src = os.path.join(incoming, 'source' + os.path.splitext(urllib.parse.urlparse(src_url).path)[1][:6])
            log(f'+ {kind} {cat}: {item["title"]} ({(ii.get("size") or 0) // 1048576} MB source)')
            if kind == 'video':
                info = encode_video(src_url, os.path.join(out, rel), os.path.join(out, thumb), os.path.join(out, preview),
                                    float(ii.get('duration') or 0))
            elif kind == 'gif':
                download(src_url, src)
                info = encode_gif(src, os.path.join(out, rel), os.path.join(out, thumb), os.path.join(out, preview))
            else:
                download(src_url, src)
                info = encode_image(src, os.path.join(out, rel), os.path.join(out, thumb))
        except Exception as e:
            log(f'  failed: {str(e)[:300]}')
            for p in [rel, thumb, preview]:
                if p:
                    try:
                        os.remove(os.path.join(out, p))
                    except OSError:
                        pass
            continue
        finally:
            shutil.rmtree(incoming, ignore_errors=True)
        item.update({'file': rel, 'thumb': thumb, 'width': info['width'], 'height': info['height']})
        if preview:
            item['preview'] = preview
        if kind != 'image':
            item['duration'] = round(info['duration'], 2)
        items.append(item)
        taken[key] = taken.get(key, 0) + 1
        # written as it goes, so an interrupted build still leaves a usable list
        # (with the items of the last build it has not come to yet)
        done = {it['id'] for it in items}
        write_library(out, items + [o for o in old.values() if o['id'] not in done and o['id'] not in exclude])

    if args.list:
        log(f'{len(items)} items, {skipped} skipped')
        return
    write_library(out, items)
    # files of items no longer listed (excluded, or gone from the source)
    keep = {p for it in items for p in (it.get('file'), it.get('thumb'), it.get('preview')) if p}
    for sub in ('videos', 'gifs', 'images', 'thumbs', 'previews'):
        for name in os.listdir(os.path.join(out, sub)):
            if f'{sub}/{name}' not in keep:
                os.remove(os.path.join(out, sub, name))
    counts = {}
    for it in items:
        counts[it['type']] = counts.get(it['type'], 0) + 1
    log(f'library: {len(items)} items {counts}, {skipped} candidates skipped')


def write_library(out, items):
    lib = {
        'version': 1,
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'note': 'CC0 / public domain media from Wikimedia Commons, licence checked per file. No credit needed.',
        'categories': CATEGORIES,
        'items': items,
    }
    tmp = os.path.join(out, 'library.json.part')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(lib, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(out, 'library.json'))


if __name__ == '__main__':
    main()
