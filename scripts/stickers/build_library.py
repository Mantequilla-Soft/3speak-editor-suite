#!/usr/bin/env python3
"""Build the image-sticker library for the 3Speak shorts editor.

Writes transparent PNGs plus library.json into OUT_DIR (served by nginx at
/stickers/). Re-runnable: emoji downloads that already exist are kept, and
designed stickers are only re-rendered when their SVG source changed
(tracked in SRC_DIR/build-state.json). Use --force to rebuild everything.

Categories:
  emoji     Noto Emoji PNGs (Apache-2.0), downloaded from GitHub
  badges    designed here as SVG, rendered with rsvg-convert
  shapes    designed here as SVG, rendered with rsvg-convert
  branding  logos listed in BRANDING below (drop more in there)

SVG rendering runs inside the editor backend container (it has the editor's
fonts and rsvg-convert). Downloads land in SRC_DIR and are treated as data:
they are parsed or copied, never executed.

Stdlib only; needs docker, curl and ffmpeg on the host.
"""

import argparse
import base64
import hashlib
import json
import math
import os
import random
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from xml.sax.saxutils import escape

EDITOR_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = Path('/mnt/HC_Volume_103240961/editor-stickers')
SRC_DIR = Path('/mnt/HC_Volume_103240961/editor-stickers-src')
CONTAINER = '3speak-deveditor-backend'

CATEGORIES = [
    {'id': 'emoji', 'label': 'Emojis'},
    {'id': 'badges', 'label': 'Badges'},
    {'id': 'shapes', 'label': 'Arrows & shapes'},
    {'id': 'branding', 'label': 'Branding'},
]

CC0 = ('CC0-1.0', 'https://creativecommons.org/publicdomain/zero/1.0/')
NOTO_URL = 'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/2D/png/512/emoji_u{cp}.png'
NOTO_LICENSE = ('Apache-2.0', 'https://github.com/googlefonts/noto-emoji/blob/main/LICENSE')

# ---------------------------------------------------------------------------
# Branding. Add entries here to ship more logos. Kinds:
#   svg      local SVG file ('path'), optional 'replace' {old: new} / 'css'
#   png      local PNG file ('path'), scaled to 'width'
#   zip-svg  SVG member of a downloaded zip ('url', 'member'), optional 'replace'
# ---------------------------------------------------------------------------
HIVE_ZIP = 'https://hive.io/hive-branding.zip'
TM = 'Trademark (3Speak / Hive)'
BRANDING = [
    {'id': '3speak-logo-white', 'title': '3Speak logo (white text)', 'kind': 'svg',
     'path': EDITOR_ROOT / 'src/assets/3S_logo.svg', 'css': 'path:not([class]){fill:#ffffff}',
     'width': 600, 'source': '3Speak', 'licenseUrl': 'https://3speak.tv',
     'keywords': ['3speak', 'logo', 'brand', 'white', 'dark video']},
    {'id': '3speak-logo', 'title': '3Speak logo', 'kind': 'svg',
     'path': EDITOR_ROOT / 'src/assets/3S_logo.svg',
     'width': 600, 'source': '3Speak', 'licenseUrl': 'https://3speak.tv',
     'keywords': ['3speak', 'logo', 'brand', 'light background']},
    {'id': '3speak-mark', 'title': '3Speak mark', 'kind': 'png',
     'path': EDITOR_ROOT / 'src/assets/3speak.png',
     'width': 600, 'source': '3Speak', 'licenseUrl': 'https://3speak.tv',
     'keywords': ['3speak', '3s', 'logo', 'icon', 'brand']},
    {'id': 'hive-logo', 'title': 'Hive logo', 'kind': 'zip-svg', 'url': HIVE_ZIP,
     'member': 'hive-branding/logo/vector/hextacular.svg',
     'width': 600, 'source': 'Hive', 'licenseUrl': 'https://hive.io/brand',
     'keywords': ['hive', 'logo', 'brand', 'icon']},
    {'id': 'hive-wordmark-white', 'title': 'Hive logo with name (white text)', 'kind': 'zip-svg',
     'url': HIVE_ZIP, 'member': 'hive-branding/logo/vector/horizontal.svg',
     'replace': {'#212529': '#ffffff'},
     'width': 600, 'source': 'Hive', 'licenseUrl': 'https://hive.io/brand',
     'keywords': ['hive', 'logo', 'wordmark', 'white', 'dark video']},
    {'id': 'hive-wordmark', 'title': 'Hive logo with name', 'kind': 'zip-svg',
     'url': HIVE_ZIP, 'member': 'hive-branding/logo/vector/horizontal.svg',
     'width': 600, 'source': 'Hive', 'licenseUrl': 'https://hive.io/brand',
     'keywords': ['hive', 'logo', 'wordmark', 'light background']},
]

# ---------------------------------------------------------------------------
# Emojis: codepoints (Noto file naming, no FE0F) | title | keywords
# ---------------------------------------------------------------------------
EMOJI_TABLE = """
1f600|Grinning face|smile happy grin
1f601|Beaming face with smiling eyes|grin happy teeth
1f605|Grinning face with sweat|nervous relief laugh
1f923|Rolling on the floor laughing|rofl lol funny
1f602|Face with tears of joy|lol laugh funny crying
1f642|Slightly smiling face|smile ok
1f643|Upside-down face|silly sarcasm
1fae0|Melting face|melt hot embarrassed
1f609|Winking face|wink flirt
1f60a|Smiling face with smiling eyes|blush happy
1f607|Smiling face with halo|angel innocent
1f970|Smiling face with hearts|love adore
1f60d|Smiling face with heart-eyes|love crush
1f929|Star-struck|wow amazing stars
1f618|Face blowing a kiss|kiss love
1f60b|Face savoring food|yum delicious
1f92a|Zany face|crazy wild
1f911|Money-mouth face|money rich
1f917|Smiling face with open hands|hug hugs
1fae3|Face with peeking eye|peek scared shy
1f92b|Shushing face|quiet secret shh
1f914|Thinking face|think hmm wonder
1fae1|Saluting face|salute respect yes
1f928|Face with raised eyebrow|suspicious doubt
1f610|Neutral face|meh blank
1f60f|Smirking face|smirk smug
1f644|Face with rolling eyes|eyeroll whatever
1f62c|Grimacing face|awkward yikes
1f634|Sleeping face|sleep tired zzz
1f975|Hot face|hot heat sweat
1f976|Cold face|cold freezing
1f635|Face with crossed-out eyes|dead dizzy knocked out
1f92f|Exploding head|mind blown shock
1f973|Partying face|party celebrate birthday
1f60e|Smiling face with sunglasses|cool sunglasses
1f913|Nerd face|nerd geek smart
1f615|Confused face|confused unsure
1f62e|Face with open mouth|surprised wow
1f633|Flushed face|embarrassed shock
1f97a|Pleading face|please puppy eyes
1f979|Face holding back tears|touched emotional
1f622|Crying face|sad tear
1f62d|Loudly crying face|sob crying sad
1f631|Face screaming in fear|scream shock horror
1f971|Yawning face|bored tired yawn
1f624|Face with steam from nose|frustrated triumph
1f621|Enraged face|angry rage mad
1f608|Smiling face with horns|devil evil mischief
1f480|Skull|dead lol dying
1f4a9|Pile of poo|poop funny
1f921|Clown face|clown joke
1f47b|Ghost|ghost boo halloween
1f916|Robot|robot ai bot
1f648|See-no-evil monkey|monkey oops cringe
2764|Red heart|love heart like
1f499|Blue heart|love heart
1f49c|Purple heart|love heart
1f5a4|Black heart|love heart dark
1f494|Broken heart|heartbreak sad
1f496|Sparkling heart|love sparkle
1f498|Heart with arrow|love cupid
1f48b|Kiss mark|kiss lips
1f44d|Thumbs up|like yes good
1f44e|Thumbs down|dislike no bad
1f44f|Clapping hands|clap applause bravo
1f64c|Raising hands|celebrate hooray praise
1f64f|Folded hands|please thanks pray
1f91d|Handshake|deal agreement
270c|Victory hand|peace victory
1f91e|Crossed fingers|luck hope
1f918|Sign of the horns|rock metal
1f919|Call me hand|call shaka
1f44c|OK hand|ok perfect
1f449|Backhand index pointing right|right point
1f446|Backhand index pointing up|up point
1f447|Backhand index pointing down|down point link below
1faf5|Index pointing at the viewer|you point
1f44b|Waving hand|hello hi bye wave
1f4aa|Flexed biceps|strong muscle gym
1f44a|Oncoming fist|punch fist bump
1faf6|Heart hands|love heart hands
1f525|Fire|fire lit hot trending
1f4af|Hundred points|100 perfect score
2728|Sparkles|sparkle magic new shiny
1f389|Party popper|party celebrate tada
1f38a|Confetti ball|confetti celebrate
1f440|Eyes|look watch see
1f4a5|Collision|boom bang explosion
1f4a8|Dashing away|fast dash wind
1f4ac|Speech balloon|talk comment chat
1f4a4|Zzz|sleep tired
2b50|Star|star favorite
1f31f|Glowing star|star shine
26a1|High voltage|lightning zap fast
1f680|Rocket|rocket launch moon
1f4b0|Money bag|money rich cash
1f4b8|Money with wings|money spend cash
1fa99|Coin|coin money crypto
1f48e|Gem stone|gem diamond
1f451|Crown|king queen crown
1f3c6|Trophy|win trophy winner
1f947|1st place medal|gold first winner
1f3af|Bullseye|target goal direct hit
2705|Check mark button|check yes done correct
274c|Cross mark|no wrong cross
26a0|Warning|warning caution alert
1f6ab|Prohibited|no forbidden ban
2757|Red exclamation mark|exclamation important
2753|Red question mark|question what
1f514|Bell|bell notification subscribe
1f4e3|Megaphone|announce shout
1f3b5|Musical note|music note song
1f3b6|Musical notes|music song
1f3a4|Microphone|mic sing karaoke podcast
1f3a7|Headphone|music listen audio
1f4f7|Camera|photo camera
1f3a5|Movie camera|video film record
1f3ac|Clapper board|movie film action
1f4f1|Mobile phone|phone mobile
1f4bb|Laptop|computer laptop
1f3ae|Video game|game gaming controller
1f4a1|Light bulb|idea tip
1f4c8|Chart increasing|growth up stonks
23f0|Alarm clock|time alarm
1f6a8|Police car light|siren alert breaking
1f381|Wrapped gift|gift present giveaway
1f382|Birthday cake|birthday cake party
1f9e0|Brain|brain smart think
1f4a3|Bomb|bomb explosive
1f355|Pizza|pizza food
1f354|Hamburger|burger food
1f35f|French fries|fries food
1f37f|Popcorn|popcorn movie snack
1f34e|Red apple|apple fruit
2615|Hot beverage|coffee tea
1f37a|Beer mug|beer drink cheers
1f436|Dog face|dog puppy pet
1f431|Cat face|cat kitten pet
1f98a|Fox|fox animal
1f43c|Panda|panda animal
1f981|Lion|lion animal
1f984|Unicorn|unicorn magic
1f41d|Honeybee|bee hive honey
1f98b|Butterfly|butterfly nature
2600|Sun|sun sunny weather
1f327|Cloud with rain|rain weather
2744|Snowflake|snow cold winter
1f308|Rainbow|rainbow weather pride
1f319|Crescent moon|moon night
1f30a|Water wave|wave ocean sea
1f33b|Sunflower|flower summer
1f340|Four leaf clover|luck clover
"""

# ---------------------------------------------------------------------------
# Design palette
# ---------------------------------------------------------------------------
RED = '#e53935'
RED_DARK = '#b3261e'
WHITE = '#ffffff'
INK = '#111111'
YELLOW = '#ffd60a'
YELLOW_DARK = '#e0b400'
BLUE = '#2f80ed'
GREEN = '#22c55e'

ANTON = ('Anton', 400)
BEBAS = ('Bebas Neue', 400)
BANGERS = ('Bangers', 400)
MONT = ('Montserrat', 800)

SHADOW_DY, SHADOW_BLUR, SHADOW_OPACITY = 6, 6, 0.38
MARGIN = 30


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------------------
# PNG helpers
# ---------------------------------------------------------------------------
def png_info(path):
    """Return (width, height) when path is a complete PNG, else None."""
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    if len(data) < 45 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        return None
    if data[-12:-4] != b'\x00\x00\x00\x00IEND' and b'IEND' not in data[-16:]:
        return None
    w, h = struct.unpack('>II', data[16:24])
    if not (0 < w <= 10000 and 0 < h <= 10000):
        return None
    return w, h


def alpha_bbox(path, threshold):
    """Ink bbox (x1, y1, x2, y2) of a PNG's alpha channel (x2/y2 inclusive)."""
    r = subprocess.run(
        ['ffmpeg', '-hide_banner', '-nostdin', '-v', 'info', '-i', str(path),
         '-vf', f'alphaextract,bbox=min_val={threshold}', '-f', 'null', '-'],
        capture_output=True, text=True)
    m = re.findall(r'x1:(-?\d+) x2:(-?\d+) y1:(-?\d+) y2:(-?\d+)', r.stderr)
    if not m:
        return None
    x1, x2, y1, y2 = map(int, m[-1])
    if x2 < x1 or y2 < y1:
        return None
    return x1, y1, x2, y2


def trim_png(path, pad=6):
    """Crop transparent borders (keeping `pad` px) in place."""
    info = png_info(path)
    box = alpha_bbox(path, 1)
    if not info or not box:
        return
    w, h = info
    x1, y1, x2, y2 = box
    x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
    x2, y2 = min(w - 1, x2 + pad), min(h - 1, y2 + pad)
    cw, ch = x2 - x1 + 1, y2 - y1 + 1
    if (cw, ch) == (w, h):
        return
    tmp = Path(str(path) + '.trim.png')
    subprocess.run(['ffmpeg', '-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', str(path),
                    '-vf', f'crop={cw}:{ch}:{x1}:{y1}', '-pix_fmt', 'rgba', str(tmp)], check=True)
    if png_info(tmp):
        tmp.replace(path)


# ---------------------------------------------------------------------------
# Rendering in the container
# ---------------------------------------------------------------------------
def render_batch(jobs, workdir, container):
    """jobs: list of (svg_text, out_path, size_flag) where size_flag is
    None, ('w', px) or ('h', px). Renders all SVGs in one container round trip."""
    if not jobs:
        return
    local = Path(tempfile.mkdtemp(prefix='render-', dir=workdir))
    remote = f'/tmp/stickers-build-{os.getpid()}-{local.name}'
    try:
        (local / 'out').mkdir()
        lines = ['set -e']
        for i, (svg, _out, size) in enumerate(jobs):
            (local / f'{i}.svg').write_text(svg, encoding='utf-8')
            flag = ''
            if size:
                flag = f'-{size[0]} {int(size[1])} '
            lines.append(f'rsvg-convert {flag}-o {remote}/out/{i}.png {remote}/{i}.svg')
        (local / 'run.sh').write_text('\n'.join(lines) + '\n')
        subprocess.run(['docker', 'cp', f'{local}/.', f'{container}:{remote}'], check=True,
                       stdout=subprocess.DEVNULL)
        r = subprocess.run(['docker', 'exec', container, 'sh', f'{remote}/run.sh'],
                           capture_output=True, text=True)
        if r.returncode != 0:
            log('rsvg-convert failed:', r.stderr.strip()[:2000])
        subprocess.run(['docker', 'cp', f'{container}:{remote}/out/.', str(local / 'out')],
                       check=True, stdout=subprocess.DEVNULL)
        for i, (_svg, out, _size) in enumerate(jobs):
            src = local / 'out' / f'{i}.png'
            if png_info(src):
                Path(out).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, out)
    finally:
        subprocess.run(['docker', 'exec', container, 'rm', '-rf', remote],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(local, ignore_errors=True)


def check_fonts(container, families):
    r = subprocess.run(['docker', 'exec', container, 'fc-list', ':', 'family'],
                       capture_output=True, text=True, check=True)
    have = set()
    for line in r.stdout.splitlines():
        for f in line.split(','):
            have.add(f.strip().lower())
    missing = [f for f in families if f.lower() not in have]
    if missing:
        sys.exit(f'fonts missing in {container}: {missing}')


# ---------------------------------------------------------------------------
# Text metrics (measured by rendering, cached on disk)
# ---------------------------------------------------------------------------
REF = 200  # reference font size for measurement


def text_svg_attrs(font, size, ls_em):
    fam, weight = font
    ls = f' letter-spacing="{ls_em * size:.2f}"' if ls_em else ''
    return f'font-family="{escape(fam)}" font-weight="{weight}" font-size="{size:.2f}"{ls}'


class Metrics:
    def __init__(self, cache_path):
        self.cache_path = cache_path
        try:
            self.cache = json.loads(cache_path.read_text())
        except (OSError, ValueError):
            self.cache = {}
        self.wanted = {}

    @staticmethod
    def key(text, font, ls_em):
        return json.dumps([text, font[0], font[1], round(ls_em, 4)])

    def get(self, text, font, ls_em=0.0):
        k = self.key(text, font, ls_em)
        if k in self.cache:
            return self.cache[k]
        self.wanted[k] = (text, font, ls_em)
        return [0.0, -0.7, 0.6 * max(1, len(text)), 0.0]  # placeholder

    def measure_wanted(self, workdir, container):
        if not self.wanted:
            return
        W, H, X, Y = 3000, 560, 100, 380
        jobs, keys = [], []
        mdir = Path(tempfile.mkdtemp(prefix='measure-', dir=workdir))
        for i, (k, (text, font, ls)) in enumerate(self.wanted.items()):
            svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
                   f'viewBox="0 0 {W} {H}"><text x="{X}" y="{Y}" {text_svg_attrs(font, REF, ls)} '
                   f'fill="#fff">{escape(text)}</text></svg>')
            jobs.append((svg, mdir / f'{i}.png', None))
            keys.append(k)
        render_batch(jobs, workdir, container)
        for (svg, out, _), k in zip(jobs, keys):
            box = alpha_bbox(out, 128)
            if not box:
                sys.exit(f'could not measure text {k}')
            x1, y1, x2, y2 = box
            if x1 <= 0 or y1 <= 0 or x2 >= W - 1 or y2 >= H - 1:
                sys.exit(f'text clipped while measuring {k}')
            self.cache[k] = [(x1 - X) / REF, (y1 - Y) / REF, (x2 + 1 - X) / REF, (y2 + 1 - Y) / REF]
        shutil.rmtree(mdir, ignore_errors=True)
        self.wanted = {}
        self.cache_path.write_text(json.dumps(self.cache, indent=1, sort_keys=True))


class T:
    """Text placement by measured ink box."""

    def __init__(self, metrics):
        self.m = metrics

    def box(self, text, font, ls=0.0):
        return self.m.get(text, font, ls)

    def size_for(self, text, font, cap=None, max_w=None, ls=0.0):
        x1, y1, x2, y2 = self.box(text, font, ls)
        cands = []
        if cap:
            cands.append(cap / max(1e-6, y2 - y1))
        if max_w:
            cands.append(max_w / max(1e-6, x2 - x1))
        return min(cands)

    def width(self, text, font, size, ls=0.0):
        x1, _, x2, _ = self.box(text, font, ls)
        return (x2 - x1) * size

    def el(self, text, font, size, cx, cy, fill, ls=0.0, extra=''):
        x1, y1, x2, y2 = self.box(text, font, ls)
        x = cx - (x1 + x2) / 2 * size
        y = cy - (y1 + y2) / 2 * size
        return (f'<text x="{x:.2f}" y="{y:.2f}" {text_svg_attrs(font, size, ls)} '
                f'fill="{fill}" {extra}>{escape(text)}</text>')


# ---------------------------------------------------------------------------
# SVG helpers
# ---------------------------------------------------------------------------
def doc(w, h, body, defs='', shadow=True):
    w, h = math.ceil(w), math.ceil(h)
    flt = ''
    if shadow:
        flt = (f'<filter id="sh" filterUnits="userSpaceOnUse" x="0" y="0" width="{w}" height="{h}" '
               f'color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="{SHADOW_DY}" '
               f'stdDeviation="{SHADOW_BLUR}" flood-color="#000" flood-opacity="{SHADOW_OPACITY}"/></filter>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
            f'<defs>{flt}{defs}</defs>{body}</svg>')


def pts(points):
    return ' '.join(f'{x:.2f},{y:.2f}' for x, y in points)


def burst(cx, cy, rx, ry, n, inner, jitter=0.0, seed=1, rot=0.0):
    rnd = random.Random(seed)
    out = []
    for i in range(2 * n):
        a = rot + math.pi * i / n
        k = 1.0 if i % 2 == 0 else inner
        if jitter:
            k *= 1 + rnd.uniform(-jitter, jitter)
        out.append((cx + rx * k * math.cos(a), cy + ry * k * math.sin(a)))
    return out


def smooth_path(points, closed=False):
    """Catmull-Rom through points, as cubic beziers."""
    p = points
    n = len(p)
    if closed:
        get = lambda i: p[i % n]
        rng = range(n)
    else:
        get = lambda i: p[min(max(i, 0), n - 1)]
        rng = range(n - 1)
    d = f'M{p[0][0]:.2f},{p[0][1]:.2f}'
    for i in rng:
        p0, p1, p2, p3 = get(i - 1), get(i), get(i + 1), get(i + 2)
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f' C{c1[0]:.2f},{c1[1]:.2f} {c2[0]:.2f},{c2[1]:.2f} {p2[0]:.2f},{p2[1]:.2f}'
    return d + (' Z' if closed else '')


def compose(t, h, parts, bg, pad_l, pad_r, gap, margin=MARGIN, extra_before=''):
    """Lay out parts left to right on a background.
    parts: ('text', text, font, cap, fill[, ls]) or ('icon', width, fn(x, cy) -> svg)
    bg: fn(x, y, w, h) -> svg."""
    widths, sizes = [], []
    for p in parts:
        if p[0] == 'text':
            ls = p[5] if len(p) > 5 else 0.0
            s = t.size_for(p[1], p[2], cap=p[3], ls=ls)
            sizes.append(s)
            widths.append(t.width(p[1], p[2], s, ls))
        else:
            sizes.append(None)
            widths.append(p[1])
    inner = sum(widths) + gap * (len(parts) - 1)
    bw = pad_l + inner + pad_r
    W, H = bw + 2 * margin, h + 2 * margin
    x0, y0, cy = margin, margin, margin + h / 2
    body = [bg(x0, y0, bw, h), extra_before]
    x = x0 + pad_l
    for p, w, s in zip(parts, widths, sizes):
        if p[0] == 'text':
            ls = p[5] if len(p) > 5 else 0.0
            body.append(t.el(p[1], p[2], s, x + w / 2, cy, p[4], ls))
        else:
            body.append(p[2](x, cy))
        x += w + gap
    return W, H, ''.join(body)


def rrect(fill, rx=None, stroke=''):
    def f(x, y, w, h):
        r = h / 2 if rx is None else rx
        return f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{r:.2f}" fill="{fill}" {stroke}/>'
    return f


def shadowed(svg):
    return f'<g filter="url(#sh)">{svg}</g>'


# ---- icons -----------------------------------------------------------------
def icon_live_dot(x, cy):
    return (f'<circle cx="{x + 36}" cy="{cy}" r="34" fill="none" stroke="#fff" stroke-opacity="0.45" stroke-width="7"/>'
            f'<circle cx="{x + 36}" cy="{cy}" r="19" fill="#fff"/>')


def icon_play(color):
    def f(x, cy):
        p = [(x + 6, cy - 30), (x + 56, cy), (x + 6, cy + 30)]
        return (f'<polygon points="{pts(p)}" fill="{color}" stroke="{color}" stroke-width="10" '
                f'stroke-linejoin="round"/>')
    return f


def icon_plus(bg, fg):
    def f(x, cy):
        c = x + 38
        return (f'<circle cx="{c}" cy="{cy}" r="38" fill="{bg}"/>'
                f'<path d="M{c - 19},{cy} H{c + 19} M{c},{cy - 19} V{cy + 19}" stroke="{fg}" '
                f'stroke-width="10" stroke-linecap="round"/>')
    return f


THUMB_D = ('M8,44 h18 a4,4 0 0 1 4,4 v42 a4,4 0 0 1 -4,4 h-18 a4,4 0 0 1 -4,-4 v-42 a4,4 0 0 1 4,-4 Z '
           'M36,46 L52,14 C55,7 66,8 66,18 L62,38 L86,38 C94,38 98,45 96,52 L88,86 C86,92 82,94 76,94 '
           'L40,94 C37,94 36,92 36,89 Z')


def icon_thumb(color, scale=0.86):
    def f(x, cy):
        return (f'<path transform="translate({x - 3 * scale:.2f},{cy - 52 * scale:.2f}) scale({scale})" '
                f'd="{THUMB_D}" fill="{color}"/>')
    return f


def icon_bulb(color):
    def f(x, cy):
        c = x + 40
        top = cy - 20
        return (f'<circle cx="{c}" cy="{top}" r="30" fill="{color}"/>'
                f'<path d="M{c - 22},{top + 12} L{c - 14},{top + 40} L{c + 14},{top + 40} L{c + 22},{top + 12} Z" fill="{color}"/>'
                f'<rect x="{c - 15}" y="{top + 46}" width="30" height="9" rx="4.5" fill="{color}"/>'
                f'<rect x="{c - 11}" y="{top + 59}" width="22" height="8" rx="4" fill="{color}"/>'
                f'<path d="M{c - 12},{top - 6} a12,12 0 0 1 12,-12" fill="none" stroke="#fff" '
                f'stroke-opacity="0.75" stroke-width="6" stroke-linecap="round"/>')
    return f


def icon_numbox(t, num, font, fill, color):
    def f(x, cy):
        s = t.size_for(num, font, cap=92)
        return (f'<rect x="{x}" y="{cy - 64}" width="128" height="128" rx="24" fill="{fill}"/>'
                + t.el(num, font, s, x + 64, cy, color))
    return f


# ---------------------------------------------------------------------------
# Badges
# ---------------------------------------------------------------------------
def b_new(t):
    W = H = 560
    c = W / 2
    b = burst(c, c, 236, 236, 16, 0.84, rot=-math.pi / 2)
    s = t.size_for('NEW', BANGERS, cap=150, max_w=300)
    body = (f'<polygon points="{pts(b)}" fill="{YELLOW}" stroke="{YELLOW}" stroke-width="8" stroke-linejoin="round"/>'
            + t.el('NEW', BANGERS, s, c, c, RED))
    return doc(W, H, f'<g filter="url(#sh)" transform="rotate(-10 {c} {c})">{body}</g>')


def b_live(t):
    W, H, body = compose(t, 150, [('icon', 72, icon_live_dot), ('text', 'LIVE', MONT, 64, WHITE, 0.04)],
                         rrect(RED), 46, 56, 26)
    return doc(W, H, shadowed(body))


def b_sale(t):
    h, a = 170, 70
    s = t.size_for('SALE', ANTON, cap=96)
    tw = t.width('SALE', ANTON, s)
    m = 70
    x0, y0 = m, m
    hole_x = x0 + a - 4
    tx0 = x0 + a + 36
    x1 = tx0 + tw + 50
    W, H = x1 + m, h + 2 * m
    cy = y0 + h / 2
    poly = [(x0, cy), (x0 + a, y0), (x1, y0), (x1, y0 + h), (x0 + a, y0 + h)]
    mask = (f'<mask id="hole" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">'
            f'<rect width="{W}" height="{H}" fill="#fff"/><circle cx="{hole_x}" cy="{cy}" r="17" fill="#000"/></mask>')
    body = (f'<g mask="url(#hole)"><polygon points="{pts(poly)}" fill="{RED}" stroke="{RED}" '
            f'stroke-width="22" stroke-linejoin="round"/></g>'
            + t.el('SALE', ANTON, s, tx0 + tw / 2, cy, WHITE))
    return doc(W, H, f'<g filter="url(#sh)" transform="rotate(-7 {W / 2} {H / 2})">{body}</g>', defs=mask)


def b_free(t):
    h, n = 150, 44
    s = t.size_for('FREE', ANTON, cap=84, ls=0.04)
    tw = t.width('FREE', ANTON, s, 0.04)
    bw = tw + 2 * (n + 52)
    x0 = y0 = MARGIN
    W, H = bw + 2 * MARGIN, h + 2 * MARGIN
    cy = y0 + h / 2
    poly = [(x0, y0), (x0 + bw, y0), (x0 + bw - n, cy), (x0 + bw, y0 + h), (x0, y0 + h), (x0 + n, cy)]
    body = (f'<polygon points="{pts(poly)}" fill="{YELLOW}" stroke="{YELLOW}" stroke-width="6" stroke-linejoin="round"/>'
            + t.el('FREE', ANTON, s, x0 + bw / 2, cy, INK, 0.04))
    return doc(W, H, shadowed(body))


def b_subscribe(t):
    W, H, body = compose(t, 150, [('icon', 62, icon_play(WHITE)), ('text', 'SUBSCRIBE', MONT, 56, WHITE, 0.02)],
                         rrect(RED), 54, 60, 28)
    return doc(W, H, shadowed(body))


def b_follow(t):
    W, H, body = compose(t, 150, [('icon', 76, icon_plus(WHITE, BLUE)), ('text', 'FOLLOW', MONT, 58, WHITE, 0.02)],
                         rrect(BLUE), 37, 60, 26)
    return doc(W, H, shadowed(body))


def b_like(t):
    W, H, body = compose(t, 150, [('icon', 84, icon_thumb(BLUE)), ('text', 'LIKE', MONT, 60, INK, 0.02)],
                         rrect(WHITE), 46, 62, 26)
    return doc(W, H, shadowed(body))


def b_breaking(t):
    h = 140
    k = h * math.tan(math.radians(12)) / 2
    cap = 74
    s1 = t.size_for('BREAKING', ANTON, cap=cap, ls=0.03)
    s2 = t.size_for('NEWS', ANTON, cap=cap, ls=0.03)
    w1 = t.width('BREAKING', ANTON, s1, 0.03) + 2 * 40
    w2 = t.width('NEWS', ANTON, s2, 0.03) + 2 * 40
    gap = 12
    x0, y0 = MARGIN + k, MARGIN
    W, H = w1 + gap + w2 + 2 * MARGIN + 2 * k, h + 2 * MARGIN
    cy = y0 + h / 2

    def para(x, w, fill):
        p = [(x + k, y0), (x + w + k, y0), (x + w - k, y0 + h), (x - k, y0 + h)]
        return f'<polygon points="{pts(p)}" fill="{fill}" stroke="{fill}" stroke-width="6" stroke-linejoin="round"/>'
    x2 = x0 + w1 + gap
    body = (para(x0, w1, RED) + para(x2, w2, WHITE)
            + t.el('BREAKING', ANTON, s1, x0 + w1 / 2, cy, WHITE, 0.03)
            + t.el('NEWS', ANTON, s2, x2 + w2 / 2, cy, RED, 0.03))
    return doc(W, H, shadowed(body))


def b_part(n):
    def f(t):
        W, H, body = compose(t, 170, [('text', 'PART', BEBAS, 98, WHITE, 0.04),
                                      ('icon', 128, icon_numbox(t, str(n), BEBAS, YELLOW, INK))],
                             rrect(INK, 30), 48, 21, 30)
        return doc(W, H, shadowed(body))
    return f


def b_wait(t):
    W, H, body = compose(t, 150, [('text', 'WAIT FOR IT...', BANGERS, 74, INK, 0.03)],
                         rrect(YELLOW), 60, 60, 0, margin=60)
    return doc(W, H, f'<g filter="url(#sh)" transform="rotate(-4 {W / 2} {H / 2})">{body}</g>')


def b_tutorial(t):
    stripe = []

    def bg(x, y, w, h):
        stripe.append((x, y, h))
        return (f'<clipPath id="tc"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="26"/></clipPath>'
                f'<g clip-path="url(#tc)"><rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{BLUE}"/>'
                f'<rect x="{x}" y="{y}" width="24" height="{h}" fill="{YELLOW}"/></g>')
    W, H, body = compose(t, 150, [('icon', 62, icon_play(WHITE)), ('text', 'TUTORIAL', MONT, 58, WHITE, 0.03)],
                         bg, 62, 58, 28)
    return doc(W, H, shadowed(body))


def b_tip(t):
    W, H, body = compose(t, 160, [('icon', 80, icon_bulb(INK)), ('text', 'TIP', ANTON, 86, INK, 0.04)],
                         rrect(YELLOW, 32), 40, 52, 22)
    return doc(W, H, shadowed(body))


def comic(t, text, fill_bg, fill_txt, seed):
    W, H = 640, 520
    cx, cy = W / 2, H / 2
    b = burst(cx, cy, 290, 230, 13, 0.72, jitter=0.12, seed=seed, rot=0.2)
    s = t.size_for(text, BANGERS, cap=150, max_w=330)
    body = (f'<polygon points="{pts(b)}" fill="{fill_bg}" stroke="{INK}" stroke-width="10" stroke-linejoin="round"/>'
            + t.el(text, BANGERS, s, cx, cy, fill_txt,
                   extra=f'stroke="{INK}" stroke-width="16" stroke-linejoin="round" paint-order="stroke"'))
    return doc(W, H, f'<g filter="url(#sh)" transform="rotate(-6 {cx} {cy})">{body}</g>')


def b_omg(t):
    return comic(t, 'OMG!', RED, WHITE, seed=7)


def b_wow(t):
    return comic(t, 'WOW!', BLUE, YELLOW, seed=11)


def b_top5(t):
    W, H, body = compose(t, 170, [('text', 'TOP', ANTON, 84, WHITE, 0.04), ('text', '5', ANTON, 122, YELLOW)],
                         rrect(INK, 30), 50, 50, 24)
    return doc(W, H, shadowed(body))


def b_num1(t):
    W, H = 440 + 2 * MARGIN, 470 + 2 * MARGIN
    cx, cy, r = W / 2, MARGIN + 175, 165
    left = [(cx - 110, cy + 60), (cx - 20, cy + 110), (cx - 70, cy + 285), (cx - 105, cy + 245), (cx - 155, cy + 262)]
    right = [(2 * cx - x, y) for x, y in left]
    s = t.size_for('#1', ANTON, cap=150, max_w=210)
    body = (f'<polygon points="{pts(left)}" fill="{RED}" stroke="{RED}" stroke-width="6" stroke-linejoin="round"/>'
            f'<polygon points="{pts(right)}" fill="{RED_DARK}" stroke="{RED_DARK}" stroke-width="6" stroke-linejoin="round"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{YELLOW}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r - 20}" fill="none" stroke="{YELLOW_DARK}" stroke-width="8"/>'
            + t.el('#1', ANTON, s, cx, cy, INK))
    return doc(W, H, shadowed(body))


def b_vs(t):
    w, h = 560, 320
    x0, y0 = MARGIN, MARGIN
    W, H = w + 2 * MARGIN, h + 2 * MARGIN
    cx, cy = x0 + w / 2, y0 + h / 2
    sl = 60
    lp = [(x0, y0), (cx + sl, y0), (cx - sl, y0 + h), (x0, y0 + h)]
    rp = [(cx + sl, y0), (x0 + w, y0), (x0 + w, y0 + h), (cx - sl, y0 + h)]
    s = t.size_for('VS', ANTON, cap=170, ls=0.02)
    clip = f'<clipPath id="vc"><rect x="{x0}" y="{y0}" width="{w}" height="{h}" rx="40"/></clipPath>'
    body = (f'<g clip-path="url(#vc)"><polygon points="{pts(lp)}" fill="{RED}"/>'
            f'<polygon points="{pts(rp)}" fill="{BLUE}"/>'
            f'<line x1="{cx + sl}" y1="{y0 - 5}" x2="{cx - sl}" y2="{y0 + h + 5}" stroke="#fff" stroke-width="14"/></g>'
            + t.el('VS', ANTON, s, cx, cy, WHITE, 0.02,
                   extra=f'stroke="{INK}" stroke-width="18" stroke-linejoin="round" paint-order="stroke"'))
    return doc(W, H, shadowed(body), defs=clip)


BADGES = [
    ('new', 'New', b_new, ['new', 'fresh', 'starburst']),
    ('live', 'Live', b_live, ['live', 'stream', 'now', 'on air']),
    ('sale', 'Sale', b_sale, ['sale', 'discount', 'deal', 'tag']),
    ('free', 'Free', b_free, ['free', 'giveaway', 'ribbon']),
    ('subscribe', 'Subscribe', b_subscribe, ['subscribe', 'sub', 'play', 'button']),
    ('follow', 'Follow', b_follow, ['follow', 'plus', 'button']),
    ('like', 'Like', b_like, ['like', 'thumbs up', 'button']),
    ('breaking-news', 'Breaking news', b_breaking, ['breaking', 'news', 'headline']),
    ('part-2', 'Part 2', b_part(2), ['part', 'series', 'episode', '2']),
    ('part-3', 'Part 3', b_part(3), ['part', 'series', 'episode', '3']),
    ('wait-for-it', 'Wait for it', b_wait, ['wait', 'suspense', 'watch till the end']),
    ('tutorial', 'Tutorial', b_tutorial, ['tutorial', 'how to', 'guide', 'learn']),
    ('tip', 'Tip', b_tip, ['tip', 'idea', 'hint', 'light bulb']),
    ('omg', 'OMG', b_omg, ['omg', 'shock', 'comic', 'wow']),
    ('wow', 'WOW', b_wow, ['wow', 'amazing', 'comic']),
    ('top-5', 'Top 5', b_top5, ['top', 'ranking', 'list', '5']),
    ('number-1', '#1', b_num1, ['number one', 'first', 'winner', 'medal']),
    ('vs', 'VS', b_vs, ['versus', 'vs', 'battle', 'compare']),
]


# ---------------------------------------------------------------------------
# Arrows & shapes
# ---------------------------------------------------------------------------
def head(tip, direction, length, half):
    ux, uy = direction
    n = math.hypot(ux, uy)
    ux, uy = ux / n, uy / n
    bx, by = tip[0] - ux * length, tip[1] - uy * length
    return [tip, (bx - uy * half, by + ux * half), (bx + uy * half, by - ux * half)]


def s_arrow_straight(t):
    W, H = 600, 280
    cy = H / 2
    p = [(40, cy - 32), (380, cy - 32), (380, cy - 95), (556, cy), (380, cy + 95), (380, cy + 32), (40, cy + 32)]
    return doc(W, H, shadowed(f'<polygon points="{pts(p)}" fill="{YELLOW}" stroke="{YELLOW}" '
                              f'stroke-width="14" stroke-linejoin="round"/>'))


def s_arrow_curved(t):
    W, H = 600, 460
    p0, c1, c2, p3 = (70, 390), (110, 150), (330, 70), (460, 175)
    hd = head((p3[0] + 70 * 0.77, p3[1] + 70 * 0.64), (p3[0] - c2[0], p3[1] - c2[1]), 105, 66)
    body = (f'<path d="M{p0[0]},{p0[1]} C{c1[0]},{c1[1]} {c2[0]},{c2[1]} {p3[0]},{p3[1]}" fill="none" '
            f'stroke="#fff" stroke-width="38" stroke-linecap="round"/>'
            f'<polygon points="{pts(hd)}" fill="#fff" stroke="#fff" stroke-width="14" stroke-linejoin="round"/>')
    return doc(W, H, shadowed(body))


def s_arrow_hand(t):
    W, H = 620, 440
    pts_ = [(50, 360), (130, 368), (205, 330), (240, 262), (222, 205), (178, 196), (160, 240),
            (190, 300), (270, 318), (360, 288), (440, 220), (500, 160), (548, 104)]
    d = smooth_path(pts_)
    tip = pts_[-1]
    dx, dy = tip[0] - pts_[-2][0], tip[1] - pts_[-2][1]
    n = math.hypot(dx, dy)
    ux, uy = dx / n, dy / n
    wings = []
    for ang, ln in ((0.55, 110), (-0.62, 98)):
        ca, sa = math.cos(ang), math.sin(ang)
        bx, by = -(ux * ca - uy * sa), -(ux * sa + uy * ca)
        wings.append(f'M{tip[0]},{tip[1]} L{tip[0] + bx * ln:.1f},{tip[1] + by * ln:.1f}')
    body = (f'<path d="{d} {" ".join(wings)}" fill="none" stroke="{RED}" stroke-width="20" '
            f'stroke-linecap="round" stroke-linejoin="round"/>')
    return doc(W, H, shadowed(body))


def s_arrow_double(t):
    W, H = 600, 240
    cy = H / 2
    p = [(44, cy), (170, cy - 88), (170, cy - 30), (430, cy - 30), (430, cy - 88), (556, cy),
         (430, cy + 88), (430, cy + 30), (170, cy + 30), (170, cy + 88)]
    return doc(W, H, shadowed(f'<polygon points="{pts(p)}" fill="#fff" stroke="#fff" '
                              f'stroke-width="14" stroke-linejoin="round"/>'))


def s_circle(t):
    W, H = 640, 460
    cx, cy, rx, ry = 320, 232, 270, 180
    p = []
    steps = 44
    start = -2.15
    for i in range(steps + 1):
        a = start + (2 * math.pi + 0.55) * i / steps
        k = 1 + 0.035 * math.sin(3 * a + 0.7) + 0.05 * i / steps
        p.append((cx + rx * k * math.cos(a) + 6 * i / steps, cy + ry * k * math.sin(a) - 10 * i / steps))
    d = smooth_path(p)
    body = f'<path d="{d}" fill="none" stroke="{RED}" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"/>'
    return doc(W, H, shadowed(body))


def s_underline(t):
    W, H = 620, 200
    a = smooth_path([(40, 95), (180, 78), (330, 74), (470, 82), (580, 98)])
    b = smooth_path([(580, 98), (420, 112), (250, 120), (110, 138), (75, 146)])
    body = (f'<path d="{a}" fill="none" stroke="{YELLOW}" stroke-width="24" stroke-linecap="round"/>'
            f'<path d="{b}" fill="none" stroke="{YELLOW}" stroke-width="20" stroke-linecap="round"/>')
    return doc(W, H, shadowed(body))


def s_check(t):
    W, H = 520, 440
    body = (f'<polyline points="70,235 195,355 450,85" fill="none" stroke="{GREEN}" stroke-width="78" '
            f'stroke-linecap="round" stroke-linejoin="round"/>')
    return doc(W, H, shadowed(body))


def s_cross(t):
    W = H = 440
    body = (f'<path d="M80,80 L360,360 M360,80 L80,360" fill="none" stroke="{RED}" stroke-width="78" '
            f'stroke-linecap="round"/>')
    return doc(W, H, shadowed(body))


def s_star(t):
    W, H = 560, 540
    b = burst(W / 2, H / 2 + 22, 250, 250, 5, 0.45, rot=-math.pi / 2)
    return doc(W, H, shadowed(f'<polygon points="{pts(b)}" fill="{YELLOW}" stroke="{YELLOW}" '
                              f'stroke-width="26" stroke-linejoin="round"/>'))


def s_starburst(t):
    W = H = 600
    c = W / 2
    outer = burst(c, c, 262, 262, 20, 0.82, rot=-math.pi / 2)
    inner = burst(c, c, 228, 228, 20, 0.84, rot=-math.pi / 2)
    body = (f'<polygon points="{pts(outer)}" fill="{RED}" stroke="{RED}" stroke-width="6" stroke-linejoin="round"/>'
            f'<polygon points="{pts(inner)}" fill="{YELLOW}" stroke="{YELLOW}" stroke-width="6" stroke-linejoin="round"/>')
    return doc(W, H, shadowed(body))


def bubble_path(x0, y0, x1, y1, r, tail):
    """Rounded rect with a tail on the bottom edge. tail = (start_x, tip_x, tip_y, end_x)."""
    sx, tx, ty, ex = tail
    return (f'M{x0 + r},{y0} H{x1 - r} A{r},{r} 0 0 1 {x1},{y0 + r} V{y1 - r} A{r},{r} 0 0 1 {x1 - r},{y1} '
            f'H{ex} L{tx},{ty} L{sx},{y1} H{x0 + r} A{r},{r} 0 0 1 {x0},{y1 - r} V{y0 + r} '
            f'A{r},{r} 0 0 1 {x0 + r},{y0} Z')


def s_bubble(side):
    def f(t):
        W, H = 620, 480
        d = bubble_path(40, 40, 580, 350, 80, (230, 92, 445, 140))
        g = f'<path d="{d}" fill="#fff" stroke="{INK}" stroke-width="9" stroke-linejoin="round"/>'
        if side == 'right':
            g = f'<g transform="translate({W},0) scale(-1,1)">{g}</g>'
        return doc(W, H, shadowed(g))
    return f


def s_thought(t):
    W, H = 640, 520
    lobes = [(190, 150, 95), (310, 115, 110), (440, 145, 100), (510, 245, 85), (430, 320, 95),
             (300, 330, 100), (175, 305, 95), (120, 225, 85), (320, 225, 140)]
    trail = [(150, 405, 34), (95, 458, 20)]
    sw = 9
    outline = ''.join(f'<circle cx="{x}" cy="{y}" r="{r + sw}" fill="{INK}"/>' for x, y, r in lobes)
    fill = ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff"/>' for x, y, r in lobes)
    tr = ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff" stroke="{INK}" stroke-width="{sw}"/>'
                 for x, y, r in trail)
    return doc(W, H, shadowed(outline + fill + tr))


def s_heart(t):
    W, H = 560, 500
    d = ('M280,450 C250,425 60,300 45,175 C35,90 95,40 165,40 C215,40 255,70 280,115 '
         'C305,70 345,40 395,40 C465,40 525,90 515,175 C500,300 310,425 280,450 Z')
    body = (f'<path d="{d}" fill="{RED}"/>'
            f'<ellipse cx="160" cy="130" rx="52" ry="30" transform="rotate(-35 160 130)" fill="#fff" fill-opacity="0.35"/>')
    return doc(W, H, shadowed(body))


def s_glyph(ch):
    def f(t):
        W, H = 380, 600
        s = t.size_for(ch, ANTON, cap=500, max_w=280)
        el = t.el(ch, ANTON, s, W / 2, H / 2, YELLOW,
                  extra=f'stroke="{INK}" stroke-width="22" stroke-linejoin="round" paint-order="stroke"')
        return doc(W, H, shadowed(el))
    return f


SHAPES = [
    ('arrow-right', 'Arrow (straight)', s_arrow_straight, ['arrow', 'right', 'point', 'straight']),
    ('arrow-curved', 'Arrow (curved)', s_arrow_curved, ['arrow', 'curved', 'point']),
    ('arrow-hand-drawn', 'Arrow (hand-drawn)', s_arrow_hand, ['arrow', 'hand drawn', 'scribble', 'loop']),
    ('arrow-double', 'Double arrow', s_arrow_double, ['arrow', 'double', 'left right', 'compare']),
    ('circle-highlight', 'Circle highlight', s_circle, ['circle', 'highlight', 'ring', 'hand drawn', 'look']),
    ('underline-scribble', 'Underline scribble', s_underline, ['underline', 'scribble', 'highlight']),
    ('check-mark', 'Check mark', s_check, ['check', 'tick', 'yes', 'correct', 'done']),
    ('cross-mark', 'Cross', s_cross, ['cross', 'x', 'no', 'wrong']),
    ('star', 'Star', s_star, ['star', 'favorite', 'rating']),
    ('starburst', 'Starburst', s_starburst, ['starburst', 'burst', 'badge', 'price', 'blank']),
    ('speech-bubble-left', 'Speech bubble (left)', s_bubble('left'), ['speech', 'bubble', 'talk', 'say']),
    ('speech-bubble-right', 'Speech bubble (right)', s_bubble('right'), ['speech', 'bubble', 'talk', 'say']),
    ('thought-bubble', 'Thought bubble', s_thought, ['thought', 'think', 'bubble', 'cloud']),
    ('heart', 'Heart', s_heart, ['heart', 'love', 'like']),
    ('exclamation', 'Exclamation mark', s_glyph('!'), ['exclamation', 'alert', 'important', 'attention']),
    ('question', 'Question mark', s_glyph('?'), ['question', 'what', 'quiz', 'ask']),
]

SIZE_OVERRIDES = {'exclamation': ('h', 600), 'question': ('h', 600)}


# ---------------------------------------------------------------------------
# Build steps
# ---------------------------------------------------------------------------
def build_emoji(out, src, force, failures):
    rows = []
    for line in EMOJI_TABLE.strip().splitlines():
        cp, title, kw = line.split('|')
        rows.append((cp.strip(), title.strip(), kw.split()))
    seen = set()
    for cp, _, _ in rows:
        if cp in seen:
            sys.exit(f'duplicate emoji {cp}')
        seen.add(cp)
    ddir = src / 'noto-emoji'
    ddir.mkdir(parents=True, exist_ok=True)
    (out / 'emoji').mkdir(parents=True, exist_ok=True)

    def fetch(cp):
        dst = out / 'emoji' / f'{cp}.png'
        if not force and png_info(dst):
            return cp, True, 'cached'
        raw = ddir / f'emoji_u{cp}.png'
        if force or not png_info(raw):
            tmp = raw.with_suffix('.part')
            r = subprocess.run(['curl', '-fsSL', '--retry', '2', '-m', '60', '--max-filesize', '5000000',
                                '-o', str(tmp), NOTO_URL.format(cp=cp)], capture_output=True, text=True)
            if r.returncode != 0 or not png_info(tmp):
                tmp.unlink(missing_ok=True)
                return cp, False, f'download failed ({r.stderr.strip()[:120]})'
            tmp.replace(raw)
        shutil.copyfile(raw, dst)
        return cp, True, 'downloaded'

    with ThreadPoolExecutor(max_workers=8) as ex:
        results = dict((cp, (ok, msg)) for cp, ok, msg in ex.map(fetch, [r[0] for r in rows]))
    items = []
    for cp, title, kw in rows:
        ok, msg = results[cp]
        if not ok:
            failures.append(f'emoji {cp} {title}: {msg}')
            continue
        w, h = png_info(out / 'emoji' / f'{cp}.png')
        items.append({'id': f'emoji-{cp}', 'category': 'emoji', 'title': title,
                      'file': f'emoji/{cp}.png', 'width': w, 'height': h, 'keywords': kw,
                      'source': 'Noto Emoji (Google)', 'license': NOTO_LICENSE[0],
                      'licenseUrl': NOTO_LICENSE[1]})
    n_dl = sum(1 for ok, m in results.values() if ok and m == 'downloaded')
    log(f'emoji: {len(items)} ok ({n_dl} downloaded, {len(items) - n_dl} cached), '
        f'{len(rows) - len(items)} failed')
    return items


def safe_svg(text, origin):
    low = text.lower()
    for bad in ('<script', '<!entity', '<!doctype', 'xlink:href="http', 'href="http', 'href="file',
                '<foreignobject', 'onload='):
        if bad in low:
            raise ValueError(f'{origin}: refusing SVG containing {bad!r}')
    return text


def branding_svg(entry, src):
    kind = entry['kind']
    if kind == 'svg':
        svg = safe_svg(Path(entry['path']).read_text(encoding='utf-8'), entry['path'])
    elif kind == 'zip-svg':
        zdir = src / 'downloads'
        zdir.mkdir(parents=True, exist_ok=True)
        zpath = zdir / (hashlib.sha1(entry['url'].encode()).hexdigest()[:12] + '.zip')
        if not zpath.exists():
            tmp = zpath.with_suffix('.part')
            subprocess.run(['curl', '-fsSL', '--retry', '2', '-m', '120', '--max-filesize', '50000000',
                            '-o', str(tmp), entry['url']], check=True)
            tmp.replace(zpath)
        with zipfile.ZipFile(zpath) as z:
            info = z.getinfo(entry['member'])
            if info.file_size > 2_000_000:
                raise ValueError('zip member too large')
            svg = safe_svg(z.read(info).decode('utf-8'), entry['member'])
    elif kind == 'png':
        p = Path(entry['path'])
        wh = png_info(p)
        if not wh:
            raise ValueError(f'{p} is not a PNG')
        b64 = base64.b64encode(p.read_bytes()).decode()
        w, h = wh
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
               f'width="{w}" height="{h}" viewBox="0 0 {w} {h}"><image width="{w}" height="{h}" '
               f'xlink:href="data:image/png;base64,{b64}"/></svg>')
    else:
        raise ValueError(f'unknown branding kind {kind}')
    for old, new in entry.get('replace', {}).items():
        if old not in svg:
            raise ValueError(f'{entry["id"]}: replace target {old} not found')
        svg = svg.replace(old, new)
    if entry.get('css'):
        svg = re.sub(r'(<svg\b[^>]*>)', lambda m: m.group(1) + f'<style>{entry["css"]}</style>', svg, count=1)
    return svg


def build_designed(out, src, container, force, failures, only):
    metrics = Metrics(src / 'text-metrics.json')
    t = T(metrics)
    specs = []  # (category, id, title, fn, keywords, size, extra)
    if 'badges' in only:
        for bid, title, fn, kw in BADGES:
            specs.append(('badges', bid, title, fn, kw, ('w', 600), {}))
    if 'shapes' in only:
        for sid, title, fn, kw in SHAPES:
            specs.append(('shapes', sid, title, fn, kw, SIZE_OVERRIDES.get(sid, ('w', 600)), {}))

    # pass 1: collect text that needs measuring, then measure it
    for s in specs:
        s[3](t)
    metrics.measure_wanted(src, container)

    svgs = []
    for cat, iid, title, fn, kw, size, _ in specs:
        svg = fn(t)
        if metrics.wanted:
            sys.exit(f'{iid}: text still unmeasured')
        svgs.append((cat, iid, title, svg, kw, size, {'source': '3Speak', 'license': CC0[0],
                                                      'licenseUrl': CC0[1], 'trim': True}))
    if 'branding' in only:
        for e in BRANDING:
            try:
                svg = branding_svg(e, src)
            except Exception as ex:  # noqa: BLE001
                failures.append(f'branding {e["id"]}: {ex}')
                continue
            svgs.append(('branding', e['id'], e['title'], svg, e['keywords'], ('w', e['width']),
                         {'source': e['source'], 'license': TM, 'licenseUrl': e['licenseUrl'], 'trim': True}))

    state_path = src / 'build-state.json'
    try:
        state = json.loads(state_path.read_text())
    except (OSError, ValueError):
        state = {}
    jobs, todo = [], []
    for cat, iid, title, svg, kw, size, meta in svgs:
        dst = out / cat / f'{iid}.png'
        digest = hashlib.sha256((svg + json.dumps(size)).encode()).hexdigest()
        if not force and png_info(dst) and state.get(f'{cat}/{iid}') == digest:
            continue
        (src / 'svg' / cat).mkdir(parents=True, exist_ok=True)
        (src / 'svg' / cat / f'{iid}.svg').write_text(svg, encoding='utf-8')
        jobs.append((svg, dst, size))
        todo.append((f'{cat}/{iid}', digest, dst, meta))
    log(f'designed: {len(svgs)} total, {len(jobs)} to render')
    render_batch(jobs, src, container)
    for key, digest, dst, meta in todo:
        if png_info(dst):
            if meta.get('trim'):
                trim_png(dst)
            state[key] = digest
        else:
            failures.append(f'{key}: render failed')
            state.pop(key, None)
    state_path.write_text(json.dumps(state, indent=1, sort_keys=True))

    items = []
    for cat, iid, title, svg, kw, size, meta in svgs:
        dst = out / cat / f'{iid}.png'
        wh = png_info(dst)
        if not wh:
            continue
        items.append({'id': f'{cat}-{iid}', 'category': cat, 'title': title,
                      'file': f'{cat}/{iid}.png', 'width': wh[0], 'height': wh[1], 'keywords': kw,
                      'source': meta['source'], 'license': meta['license'], 'licenseUrl': meta['licenseUrl']})
    return items


def contact_sheet(out, items, path, container, workdir):
    cells = [i for i in items if i['category'] != 'emoji']
    cols, cw, chh, tw, th, top = 6, 300, 270, 270, 200, 70
    rows = math.ceil(len(cells) / cols)
    W, H = cols * cw + 20, top + rows * chh + 20
    parts = [f'<rect width="{W}" height="{H}" fill="#3a3a3a"/>',
             f'<text x="20" y="45" font-family="Inter" font-weight="700" font-size="26" fill="#eee">'
             f'3Speak sticker library: badges, shapes, branding ({len(cells)})</text>']
    for n, it in enumerate(cells):
        r, c = divmod(n, cols)
        x, y = 10 + c * cw, top + r * chh
        w, h = it['width'], it['height']
        sc = min(tw / w, th / h)
        dw, dh = w * sc, h * sc
        b64 = base64.b64encode((out / it['file']).read_bytes()).decode()
        parts.append(f'<rect x="{x + 5}" y="{y}" width="{cw - 10}" height="{chh - 10}" rx="8" fill="#2a2a2a"/>')
        parts.append(f'<image x="{x + (cw - dw) / 2:.1f}" y="{y + 8 + (th - dh) / 2:.1f}" width="{dw:.1f}" '
                     f'height="{dh:.1f}" xlink:href="data:image/png;base64,{b64}"/>')
        parts.append(f'<text x="{x + cw / 2}" y="{y + chh - 26}" text-anchor="middle" font-family="Inter" '
                     f'font-size="15" fill="#ddd">{escape(it["id"])} ({w}x{h})</text>')
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
           f'width="{W}" height="{H}" viewBox="0 0 {W} {H}">{"".join(parts)}</svg>')
    render_batch([(svg, path, None)], workdir, container)
    return png_info(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', type=Path, default=OUT_DIR)
    ap.add_argument('--src', type=Path, default=SRC_DIR)
    ap.add_argument('--container', default=CONTAINER)
    ap.add_argument('--force', action='store_true', help='re-download and re-render everything')
    ap.add_argument('--no-contact', action='store_true', help='skip the contact sheet')
    args = ap.parse_args()
    out, src = args.out, args.src
    out.mkdir(parents=True, exist_ok=True)
    src.mkdir(parents=True, exist_ok=True)
    check_fonts(args.container, ['Anton', 'Bebas Neue', 'Bangers', 'Montserrat', 'Inter'])

    failures = []
    items = build_emoji(out, src, args.force, failures)
    items += build_designed(out, src, args.container, args.force, failures,
                            only={'badges', 'shapes', 'branding'})
    ids = [i['id'] for i in items]
    dup = {x for x in ids if ids.count(x) > 1}
    if dup:
        sys.exit(f'duplicate ids: {dup}')
    order = {c['id']: n for n, c in enumerate(CATEGORIES)}
    items.sort(key=lambda i: order[i['category']])
    lib = {'version': 1, 'categories': CATEGORIES, 'items': items}
    tmp = out / 'library.json.tmp'
    tmp.write_text(json.dumps(lib, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    tmp.replace(out / 'library.json')

    # prune PNGs in the managed category folders that are no longer listed
    referenced = {i['file'] for i in items}
    pruned = []
    if not failures:
        for c in CATEGORIES:
            for p in sorted((out / c['id']).glob('*.png')):
                rel = f'{c["id"]}/{p.name}'
                if rel not in referenced:
                    p.unlink()
                    pruned.append(rel)
    if pruned:
        log(f'pruned {len(pruned)} unlisted PNGs: {" ".join(pruned)}')
    stray = [str(p.relative_to(out)) for p in out.rglob('*.png') if str(p.relative_to(out)) not in referenced]
    if not args.no_contact:
        cs = contact_sheet(out, items, src / 'contact.png', args.container, src)
        log(f'contact sheet: {src / "contact.png"} {cs}')

    total = sum((out / i['file']).stat().st_size for i in items)
    for c in CATEGORIES:
        sel = [i for i in items if i['category'] == c['id']]
        size = sum((out / i['file']).stat().st_size for i in sel)
        log(f'  {c["id"]:9s} {len(sel):4d} items  {size / 1e6:6.2f} MB')
    log(f'  total     {len(items):4d} items  {total / 1e6:6.2f} MB  -> {out / "library.json"}')
    if stray:
        log(f'unreferenced PNGs in output: {stray}')
    if failures:
        log('FAILURES:')
        for f in failures:
            log('  ' + f)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
