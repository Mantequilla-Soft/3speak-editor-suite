# 3Speak Editor

A browser-based non-linear video editor built for the [3Speak](https://3speak.tv) decentralized video platform. Features a React frontend with in-browser FFmpeg.wasm processing, a Node.js backend for server-side rendering, and an optional gateway for load-balancing render jobs.

## Architecture

```
┌─────────────┐       ┌─────────────┐       ┌─────────────────┐
│   Frontend   │──API──▶   Backend   │◀──────│  Gateway (opt)  │
│  React SPA   │       │  Express +  │       │  Load balancer  │
│  FFmpeg.wasm │       │   FFmpeg    │       │   + MongoDB     │
└─────────────┘       └─────────────┘       └─────────────────┘
```

- **Frontend** -- React SPA served by nginx. Handles editing UI and client-side exports via FFmpeg.wasm.
- **Backend** -- Express server with system FFmpeg. Handles server-side rendering, file uploads, and HLS clip preparation.
- **Gateway** (optional) -- Manages multiple backend instances with health checks and round-robin job proxying. Includes an admin UI.

The editor can also run in **iframe mode** -- a parent page (e.g. 3Speak TV) embeds it via iframe and communicates through `postMessage` to load media and receive render results.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 18, Vite 5, FFmpeg.wasm, HLS.js, Material Symbols Rounded (icons) |
| Backend | Node.js 18, Express 4, FFmpeg (system), Multer |
| Gateway | Node.js 18, Express 4, MongoDB |
| Infra | Docker Compose, Nginx, SharedArrayBuffer (COOP/COEP) |

## Look and feel

The editor follows 3Speak's v2 design (the `design_handoff_3speak_v2` package in the 3speak.tv repo, STYLE_GUIDE.md there), so it looks like the page around it:

- **Tokens:** `src/styles/tokens.css` holds the colours, type sizes, spacing, radii and motion, light (`:root`) and dark (`[data-theme="dark"]`, sent by 3Speak with `set-theme`). The editor's older names (`--bg-primary`, `--accent-primary`...) are aliases there. No hex values in components; tints come from `color-mix()`.
- **Scales:** type 10 11 12 13 14 16 18 20 24 28 32..., weights 400 500 700 900, control radius follows height (up to 28: 8, 32-40: 12, 44-52: 16), cards 24, dialogs 28.
- **Colour use:** red (`--accent`) is the one primary action per view (Render / Export, Use, Start recording), the playhead, live and errors; cyan (`--cyan`) is selected-but-not-primary, info and voice/sound on the timeline. No other hues in the interface (content colours a user picks are fine).
- **Icons:** `src/components/icons.jsx`, Material Symbols Rounded from Google Fonts. Only the listed glyphs are downloaded (`icon_names=` in `index.html`); `tests/icons.test.js` keeps the two in step.
- **Dialogs:** one shell (`.remix-picker-overlay` > `.remix-picker`), a bottom sheet under 768 px. Small notices are an island at the top centre, never a corner toast.

## Features

### Timeline & Clips
- Multi-track timeline with separate video and audio tracks
- Drag-and-drop from project library onto timeline
- Reposition clips along the timeline with snap-to-edge
- Move clips between tracks
- Trim handles for in/out point adjustment
- Split clip at playhead (group-aware -- splits paired video+audio)
- Remove gap at playhead
- Duplicate clips
- Linked video+audio clips via group IDs -- operations propagate to both
- Group/ungroup clips
- Undo/redo, 200 steps: every clip setting, plus chapters, flags, captions and the audio settings (src/utils/history.js keeps steps small by sharing what did not change; quick repeats such as a slider drag are one step)
- Timeline zoom (10-200 px/s) with adaptive ruler

### Media Support
- **Video** -- with sprite-strip thumbnail generation and HLS stream support
- **Audio** -- with real waveform visualization (Web Audio API)
- **Images** -- treated as video-track items with configurable duration
- **Text** -- overlay text with configurable font, size, color, weight, and position
- **Color** -- solid color or gradient backgrounds with configurable angle

### Preview
- Real-time multi-layer composited preview with play/pause/seek
- Visual transforms rendered live: zoom, position, crop, text overlays
- Resizable preview (10 size levels up to fullscreen)
- Single clip preview in the left panel
- Vertical video detection with auto layout switching

### Clip Properties
- Volume with mute/unmute
- Scale/zoom (10-200%)
- Position X/Y offset with 2D drag handle
- Crop (percentage-based)
- Opacity (0-100%)
- Text: content, font family, weight, size, color
- Color: background color, gradient toggle, end color, angle
- Duration control for images, text, and color clips

### Export (3 methods)

| Method | Where | Description |
|--------|-------|-------------|
| **Canvas (WYSIWYG)** | Client | Captures `canvas.captureStream()` at 30fps, preserves all visual transforms. Default method. |
| **Fast (FFmpeg-only)** | Client | Direct FFmpeg.wasm trim + concat. Faster but ignores visual transforms. |
| **Backend Render** | Server | Uploads media to backend, submits timeline JSON. Full FFmpeg pipeline with per-clip processing, compositing, and audio mixing. Used in iframe mode. |

Quality presets: High (CRF 18), Medium (CRF 23), Low (CRF 28).

**Render queue:** a backend renders `MAX_CONCURRENT_JOBS` at a time; more jobs wait in line (up to `MAX_QUEUED_JOBS`, default 20) and the editor shows "You are 2nd in line" until its turn (`backend/src/utils/renderQueue.js`). Every job is a JSON file in `RENDER_JOBS_DIR` (default `<UPLOAD_DIR>/.render-jobs`, the uploads volume), so a restart or redeploy loses none: queued jobs queue again, a running one starts over once. A full line answers 503 and the editor tries again by itself with backoff (also on network errors); it stops polling on a hard error (`src/utils/renderQueue.js`). `/api/health` reports `activeJobs` and `queuedJobs`; the gateway sends a job to a free backend first, else to the shortest line; the deploy swaps a backend only when both are 0.

### Render quality and captions (Shorts)
- Shorts render at **1080x1920** from the uploaded **originals**: the 480p copy of a video upload is only the editing proxy the preview plays (`GET /api/upload/files/<name>`); renders ask for `?for=render` (backend/src/utils/uploadFiles.js). Originals that are HDR, larger than 1920 on the long side or in an unusual codec get a `_master.mp4` render copy (fit 1920, never upscaled, SDR) that replaces them. Old uploads that only have their 480p file still render from it.
- **Auto captions** (Captions button on the timeline): speech to text with word times (whisper.cpp in the backend image), styles Karaoke (the spoken word highlighted), Pop (one or a few words at a time) and Subtitles, optional emoji accents, an editable words list. Burnt in with libass exactly where the preview draws them (src/utils/captions.js, shared with the backend), and written as WebVTT / SRT next to the render; `post-to-3speak` carries them as `subtitles` (`{ language, vttUrl, srtUrl, cues, burnedIn }`; `burnedIn` = "Show in the video" was on and the backend drew them, so 3Speak keeps CC off for them by default).

### Landscape projects and Export as
- **Shape** (chip at the top of the video editor, or `?aspect=16:9` / `?format=landscape|classic|square|short` from the page that opens it): Short 9:16 (up to 2 minutes) or Landscape 16:9, Classic 4:3, Square 1:1 (up to 10 minutes), rendered at 1080x1920, 1920x1080, 1440x1080, 1080x1080 from the originals. Kept with the draft. `post-to-3speak` carries `format: { aspect, short, durationSec }` (`editor-ready` says `canFormat: true`): 3Speak posts a 9:16 render as a Short, the others as a normal video.
- **Export as** (next to Render): the same project in other shapes, one or several at once. Footage framed as it came is cut to the new shape around the face in it: MediaPipe Face Detector in the browser, a few frames a second on the editing copy, smoothed into a path (`clip.reframe`, utils/reframe.js, shared with the render, which cuts the same window with an ffmpeg crop expression). Without a face the middle stays in view; each clip's window can be shifted by hand. The wasm files and model are served by the editor (`public/vision/`, `scripts/vision/copy-assets.mjs`, run before dev and build), nothing comes from a CDN.

### Speed, keyframes and punch-ins (Shorts)
- **Speed** (a video clip's settings): 0.25x to 4x on the clip and its linked sound (pitch kept: `atempo` in the render, the browser's playbackRate in the preview), ramp presets (Montage, Hero, Speed up, Slow down) and **Freeze at playhead** (a still of that frame, 0.5 to 3 s; the clip and its sound are split around it). Clip lengths follow the speed and the clips after it move along. `startTime` / `endTime` are clip time: `clip.speed`, `clip.speedRamp` and `clip.freezeAt` map it to the media (src/utils/clipSpeed.js, shared with the backend). The preview plays a ramp by changing the playback rate as it goes (close); the render is exact.
- **Keyframes** (Keyframes section): position, scale, rotation and opacity of video, image and text clips, volume of sound; a diamond adds or removes one at the playhead, arrows jump between them, linear or eased. With keyframes, a slider or a drag on the preview sets the keyframe at the playhead. **Ken Burns** presets for images. `clip.keyframes` in clip time (src/utils/keyframes.js, shared with the backend: CSS transform in the preview, perspective filter, alpha multiply and `volume` expressions in the render).
- **Auto punch-ins** (video clips): quick 115% zoom-ins at sentence starts and loud words, from the auto captions' word times or else the clip's loudness; ordinary Scale keyframes that **Remove punch-ins** takes off again (src/utils/punchIns.js).

### Looks, transitions and titles (Shorts)
- **Looks** (a clip's Look section): one-tap presets (Warm, Cool, Vivid, Matte, B&W, Vintage, Teal & Orange, Fade, Noir, Sunset) shown on the clip's own frame. A preset sets the Color sliders, so it can be adjusted from there; plus Blur, Vignette, Sharpen and a teal and orange split tone (`clip.look`). Preview (SVG filter) and render (ffmpeg lutrgb, convolution, gblur, vignette) share `src/utils/clipLook.js`.
- **Transitions** (the button on a cut between two clips, or a clip's Transition section): crossfade, dip to black, slide left / right / up, zoom and whip, 0.2 to 1.5 s, centred on the cut (`clip.transition = { type, duration, to }` on the outgoing clip; it only applies while `to` is the very next clip). The clips' linked sound crossfades too. Fade in / out on video, image and colour clips (`fadeIn` / `fadeOut`, the linked sound fades with it). Shared maths: `src/utils/transitions.js`.
- **Text** (a text clip's Text effects): an outline (`textStroke`) and words that come in one by one (`textAnim`: pop, fade up, typewriter, slide); `src/utils/textAnim.js`.
- **Titles** (+ menu > Titles): lower thirds, titles over the video and intro / outro cards from the Ad Wizard's motion scenes (`src/utils/titleScenes.js`). A title is a clip of type `scene`: the preview plays the scene engine's host page (`SceneLayer.jsx`), the render records the same page in Chromium (`backend/src/services/sceneClip.js`), with a transparent background over the video.
- The browser (canvas) export (standalone editor only) uses the same SVG filter for looks, but does not draw transitions, word entrances or titles: those need the backend render, which 3Speak always uses.

### Stock media and background removal (Shorts)
- **Stock media** (OFF unless the frontend is built with `VITE_STOCK_LIBRARY=true`; then timeline + menu, "Stock media", and "a stock picture or video behind" for a removed background): b-roll videos, photos and GIFs that are free to use with no credit (CC0 / public domain, licence checked per file), built onto our server by `scripts/stock/build_library.py OUT_DIR` and served at `/stock/` (host nginx, like `/music/` and `/stickers/`; `VITE_STOCK_SOURCES` overrides `/stock/library.json`). On an empty timeline a pick becomes the video, otherwise it goes over it as b-roll (a `B-roll` track, `stock: 'broll'`, no sound). With `PEXELS_API_KEY` / `PIXABAY_API_KEY` on the backend the sheet also searches Pexels / Pixabay (`/api/stock/*`); a pick is copied to our uploads first.
- **Background removal without a green screen** ("Person" in a video clip's Green screen box, and in the camera recorder): MediaPipe's selfie segmenter finds the person in every frame in the browser (self-hosted, `public/vision/`), the matte goes to the server as one file (`src/utils/personMask.js`, shared with the backend) and the render keys with it exactly like the preview. Behind the person: the tracks below (a stock picture or clip can be put there in one click), a blur of the clip, or a colour.

### Other
- Drag-and-drop or file-picker media import with categorized library (Videos, Images, Sounds)
- HLS stream support with automatic download and progress tracking
- Webcam and audio recording via MediaRecorder API
- First-time onboarding tour
- Light and dark theme support
- Iframe embedding API with postMessage communication
- Opens light: FFmpeg.wasm (only the legacy layout's exports and whole-HLS downloads in the browser use it) is served by the editor itself (`/ffmpeg/<version>/`, copied from `@ffmpeg/core` at build by `scripts/viteFfmpegCore.js`, gzipped) and loaded on first use; hls.js and the dialogs are their own chunks (`src/components/lazyPanels.jsx`)

### Audio editor (`?mode=audio`)
The same editor for podcasts, music and voice. 3Speak opens it from its share menu (standalone) and from the audio upload ("Edit audio" on a track).
- **Tracks:** a Voice track and a Music track. An audio stage shows the whole show with waveforms (click to jump), up to 3 hours. "Fit" zooms out to the whole show.
- **Cut silences:** finds the pauses and cuts them out, closing the gaps. It works on one clip or on every voice clip with the same settings. Files too big for the browser are measured by the backend (`POST /api/clip/audio-analysis`).
- **Several voices:** a host and a guest on their own Voice tracks can be grouped ("Group with other voices" in a clip's ⋯ menu). A group moves and trims together, and Cut silences on it cuts only where everyone is quiet, the same stretch from every voice, so they stay in sync. "Cut all voice clips" also cuts groups this way.
- **Basic edits:** split, trim, move, delete, volume, fades in and out, noise reduction, music library and sound effects, recording.
- **Studio voice:** a one-click clean-up in a voice clip's settings (noise and rumble out, less mud, more presence, softer S sounds, evened out: `POST /api/clip/denoise` with `strength: 'studio'`). In the audio editor it, and the noise levels, apply to every piece of the recording at once.
- **Duck:** the music tracks go down (-6, -12 or -18 dB) while a voice clip plays and come back up in the pauses. The editor works out where (`src/utils/duck.js`) and sends it as `timeline.master.duck`; the backend applies the same ramps (`duckExpr`), the preview plays them.
- **Chapters:** `M` or "Chapters" marks where a part starts. A chapter is pinned to the moment in the recording, so it moves with Cut silences, trims and the template intro. They go into the MP3 as ID3 chapters (`timeline.chapters`) and to 3Speak with "Use this audio".
- **Export:** an MP3 rendered by the backend (`timeline.output: 'audio'`), levelled to -16 LUFS for podcasts (can be switched off). "Use this audio" posts `{ type: 'post-to-3speak', mediaType: 'audio', outputUrl, fileName, durationSec, musicCredits?, chapters? }` (chapters: `[{ start, end, title }]`; audiograms: `[{ url, title, description, start, duration, width, height }]`, `start` = seconds into the episode, for the podcast feed's soundbites).
- **Audiogram:** after an export, a short video (up to 60 s, square or vertical) of a piece of the episode with its title and a moving waveform, to share as a teaser (`POST /api/audiogram`, then `GET /api/audiogram/:jobId`).
- **Audiogram captions:** "Captions" in the studio puts the spoken words on the audiogram in the Shorts captions' looks (Karaoke, Pop, Subtitles), in a box moved and widened like the other parts and kept clear of the logo. The words come from the exported MP3's piece (`POST /api/transcript`), can be fixed by hand, and are burnt in with libass (`src/utils/audiogramCaptions.js`, the same file in the backend, so preview and video match). The captions' look is part of the audiogram template.
- **Video podcast:** after an export, the whole episode as a 16:9 video (1920x1080, 15 or 24 fps) for 3Speak, YouTube and Spotify video podcasts: the picture, a moving waveform (the audiogram engine's page and waveforms), captions (speech to text on the backend, burnt in with libass and written as VTT / SRT) and the name of whoever is speaking (each voice track's loudness, `src/utils/speakers.js`). One streaming ffmpeg run on the backend, so hours long episodes stay within memory (`POST /api/video-podcast`, `GET /api/video-podcast/:jobId`, one at a time). "Post on 3Speak as a video" sends `post-to-3speak { mediaType: 'video', outputUrl, format: { aspect: '16:9', short: false }, durationSec, chapters?, subtitles? }`.
- **Drafts:** like the video editor's. Each editor only offers its own drafts, and the limit counts both.
- **Template:** one per user, kept for good (`/api/templates/audio`): intro, outro and a music bed (looped under the recording, faded out at the end), plus "cut silences", "level loudness" and "duck". It is applied by itself to a new recording, and one click takes it off again.
- **Handshake:** `editor-ready` carries `mode: 'audio'` and `canEditAudio: true`. Both editors also say `canLoadSound: true`: `load-media { url, name, mediaType: 'audio', music: true, credit: { id, title, ... } }` (3Speak's "Use this sound", an HLS `.m3u8` too) puts the sound on the music track with its credit, and `musicCredits` names only the songs still on the timeline. Load a recording with `load-media { file, name, mediaType: 'audio' }`.

### Word tools (both editors, built for long podcasts)
- **Transcript** (toolbar in the audio editor, timeline in the Shorts editor): the words of every recording with speaker labels (each voice track is a speaker). Click a word to go there, drag or Shift+click to select, Delete cuts the stretch out of every track and closes the gap (`rippleCutRanges` in `src/utils/ripple.js`, one undo step; Undo brings the words back). Find words and cut every place found. The words are pinned to the recordings (`src/utils/transcript.js`), so they follow every cut and trim, and are kept in the draft. Long shows are transcribed in 5-minute chunks (`POST /api/transcript`, `TRANSCRIPT_CHUNK_SECONDS`), the words appear chunk by chunk, and only the paragraphs in sight are drawn.
- **Remove fillers** (Fillers): um, uh, "you know", "like" as a filler and their equivalents per language (`src/data/fillerWords.json`), plus pauses over a chosen length, in a review list (listen to each, untick to keep); then the fillers are cut and the pauses shortened to a chosen length. Whisper writes the fillers down because the transcript starts it from a line full of them in the spoken language (`backend/src/utils/verbatimPrompts.js`).
- **Chapter suggestions** (Chapters, Suggest chapters): topic shifts in the transcript (TextTiling, no AI), long pauses (from the loudness without a transcript) and scene changes (`POST /api/clip/scenes`), titled with the words that set each part apart (`src/utils/chapterSuggest.js`). Add them one by one or all.

## Languages

The editor speaks the 21 languages of 3speak.tv (`src/i18n/languages.js`, the same list as the frontend). 3Speak opens it with `?lang=<code>` and sends `{ type: 'set-language', lang }` when the viewer switches while it is open (like `set-theme`); without either it follows the browser, then English. English is bundled; every other language is loaded on demand (one small chunk per area file), so the editor opens as fast as before. The teleprompter's voice language and the caption/transcript language names follow it too.

Strings live in `src/locales/<lang>/<area>.json` (`timeline.json` holds `t('timeline...')`), in the frontend's format: `{{placeholders}}`, plural forms `_one`/`_other` (plus `_few`/`_many` for ru, uk, pl) picked from `{ count }` with `Intl.PluralRules`, and simple `<tag>`s for `tRich()`. The code is `src/i18n/index.js` (a small `t()`, no library): `const { t } = useT()` in a component, `import { t } from '../i18n'` elsewhere (called when the text is needed, never at module top level).

Adding or changing a string:

1. Add it to `src/locales/en/<area>.json` (a new feature can get its own area file) and use it: `t('area.key', { name })`. Whole sentences only, never glued from pieces; a changed meaning gets a new key.
2. `npm run i18n:reuse -- --from ../new-3speak-tv` fills keys whose English text the 3Speak frontend already translates.
3. `npm run i18n:todo -- --out /tmp/i18n-todo` writes one flat file per language with what is still missing (in that language's plural forms); translate the values, keeping every `{{placeholder}}` and `<tag>`, then `npm run i18n:merge -- --in /tmp/i18n-todo`.
4. `npm run i18n:check` (also run by `tests/i18n.test.js`): every language has every key, the same placeholders, its own plural forms, and every key is used in `src/`.

## Tests

```bash
npm test                        # editor unit tests (Vitest)
cd backend && npm test          # backend: routes, audio render through real ffmpeg, templates
npm run test:e2e:audio          # the audio editor end to end in Chromium against a local backend
npm run test:e2e:words          # transcript, fillers, chapter ideas, audiogram captions (a stand-in whisper)
npm run test:e2e:language       # the editor, audio editor and Ad Wizard in the viewer's language (?lang=, set-language)
npm run i18n:check              # the translations: all keys, placeholders, plural forms
```

The end-to-end test needs `ffmpeg`/`ffprobe` on PATH and Chromium (`E2E_CHROME`, default Playwright's chromium-1148). It makes its own test audio, starts a backend on a free port with throwaway folders and token secret, builds the editor against it, plays the 3Speak side (`e2e/host.html`), and removes everything afterwards.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Delete` / `Backspace` | Remove selected clip |
| `Ctrl+R` | Split clip at playhead |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Ctrl+Shift+G` | Ungroup clips |
| `Arrow Left/Right` | Move playhead (100ms, 1s with Shift) |
| `M` | Add a chapter at the playhead (audio editor) |
| `J` / `K` / `L` | Play backward / stop / play forward (press J or L again: 2x, 4x, 8x) |
| `,` / `.` | One frame back / forward (Shift: 10 frames) |
| `Tab` / `Shift+Tab` | Next / previous clip (when a clip is selected) |
| `Alt+Arrow Left/Right` | Previous / next clip on the same track |
| `Alt+Arrow Up/Down` | Clip on the track above / below |
| `Enter` | Open the selected clip's settings |
| `?` | All shortcuts (also the keyboard button at the top, on desktop) |

Shortcuts never fire while typing in a field (`src/utils/keyboard.js`). The timeline is labelled for screen readers: clips are buttons ("clip") with their name and time, tracks are named groups, the playhead is a slider; a moved selection is announced. The list lives in `src/utils/shortcuts.js` (the `?` sheet reads it).

## Getting Started

### Development (no Docker)

```bash
# Frontend
npm install
npm run dev          # Vite dev server on http://localhost:8089

# Backend (separate terminal)
cd backend
npm install
npm run dev          # Express server on http://localhost:3102
```

### Docker

```bash
cp .env.example .env   # Configure services and credentials
docker compose up      # Starts services based on COMPOSE_PROFILES in .env
```

Control which services start via `COMPOSE_PROFILES` in `.env`:

| COMPOSE_PROFILES | Services started |
|------------------|------------------|
| *(empty)* | Backend only |
| `frontend` | Backend + Frontend |
| `gateway` | Backend + Gateway |
| `frontend,gateway` | All three |

| Service | Port | Description |
|---------|------|-------------|
| Frontend | 8089 | React SPA served by nginx |
| Backend | 3102 | Express + FFmpeg render service |
| Gateway | 3200 | Load balancer with admin UI |

### Nginx (reverse proxy)

Example nginx configs for each service are in `nginx/`:

```
nginx/
  frontend.conf.example        # editor.example.com -> :8089
  backend-api.conf.example     # editor-api.example.com -> :3102
  gateway.conf.example         # editor-gateway.example.com -> :3200
```

Copy and edit with your domain, then enable:

```bash
sudo cp nginx/frontend.conf.example /etc/nginx/sites-available/editor.yourdomain.com
# Edit server_name, then:
sudo ln -s /etc/nginx/sites-available/editor.yourdomain.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d editor.yourdomain.com
```

## Deploying a Backend on a New Server

Each backend is a self-contained render worker — no database, no shared state. You can spin up as many as you need on different servers.

### Prerequisites

- Docker & Docker Compose
- Nginx
- Certbot (for SSL)
- A domain pointed to the server (A record, DNS only — no Cloudflare proxy, or upgrade to a paid plan for >100MB uploads)

### Steps

**1. Clone the repo and configure:**

```bash
git clone <repo-url> ~/3speak-editor
cd ~/3speak-editor
cp .env.example .env
```

Edit `.env` — set `COMPOSE_PROFILES=` (empty) so only the backend starts:

```env
COMPOSE_PROFILES=
MAX_CONCURRENT_JOBS=2
```

**2. Build and start:**

```bash
docker compose up -d --build
```

The backend will be running on port 3102.

**3. Set up nginx reverse proxy:**

```bash
sudo cp nginx/backend-api.conf.example /etc/nginx/sites-available/your-editor-api.example.com
```

Edit the file — replace `YOUR_DOMAIN` with your actual domain and set the port (3102 for a single backend).

```bash
sudo ln -s /etc/nginx/sites-available/your-editor-api.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**4. Add SSL:**

```bash
sudo certbot --nginx -d your-editor-api.example.com
```

**5. Register the backend with the frontend:**

On the server running the frontend, add the new backend URL to `VITE_BACKEND_URLS` in `.env`:

```env
VITE_BACKEND_URLS=https://existing-backend.example.com,https://your-editor-api.example.com
```

Rebuild and restart the frontend:

```bash
docker compose build frontend
docker compose up -d frontend
```

The frontend automatically picks the first healthy backend from the list. If you're using the gateway, register the new backend via the gateway admin UI instead.

### Running Multiple Backends on the Same Server

To run a second backend on the same machine, create a separate compose directory with a different port:

```bash
mkdir ~/3speak-editor2
cat > ~/3speak-editor2/docker-compose.yml << 'EOF'
services:
  backend:
    build:
      context: /path/to/3speak-editor
      dockerfile: backend/Dockerfile
    container_name: 3speak-editor2-backend
    restart: unless-stopped
    ports:
      - "3103:3102"
    volumes:
      - rendered_output:/app/rendered
    environment:
      - NODE_ENV=production
      - PORT=3102
      - RENDERED_DIR=/app/rendered
      - WORK_DIR=/app/work
      - MAX_CONCURRENT_JOBS=2
      - HLS_TARGET_RESOLUTION=480

volumes:
  rendered_output:
    driver: local
EOF

cd ~/3speak-editor2
docker compose up -d --build
```

Then add an nginx config for this instance pointing to port 3103.

## Environment Variables

All variables are configured in `.env` (see `.env.example`).

### Docker Compose

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPOSE_PROFILES` | *(empty)* | Comma-separated: `frontend`, `gateway` |

### Frontend

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_HLS_TARGET_RESOLUTION` | `480` | Target HLS resolution for client-side downloads |
| `VITE_GATEWAY_URL` | *(empty)* | Gateway URL for render routing. If empty, renders go directly to the local backend |

### Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3102` | HTTP port |
| `MAX_CONCURRENT_JOBS` | `2` | Max simultaneous render jobs |
| `HLS_TARGET_RESOLUTION` | `480` | Target resolution for HLS clip prep |
| `CLEANUP_MAX_AGE_HOURS` | `2` | Auto-cleanup files older than this |
| `CLEANUP_INTERVAL_MINUTES` | `30` | Cleanup frequency |
| `MAX_PARALLEL_ENCODES` | `2` | Upload encodes (480p proxy, render master) at a time |
| `WHISPER_BIN` | `/opt/whisper/whisper-cli` | Auto captions: whisper.cpp CLI (built into the image) |
| `WHISPER_MODEL` | `/opt/whisper/ggml-base.bin` | Auto captions: ggml model (image build arg `WHISPER_MODEL`: tiny, base, small) |
| `WHISPER_THREADS` | `2` | CPU threads per transcription (one runs at a time) |
| `CAPTIONS_ENABLED` | `true` | `false` hides auto captions on this backend |
| `CAPTIONS_MAX_SECONDS` | `600` | Longest timeline auto captions transcribe |
| `CAPTION_FONTS_DIR` | `/usr/share/fonts/google` | Fonts libass burns captions with |
| `PEXELS_API_KEY` | (unset) | Stock sheet: live Pexels search (the key stays on the server) |
| `PIXABAY_API_KEY` | (unset) | Stock sheet: live Pixabay search (the key stays on the server) |

### Gateway

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3200` | HTTP port |
| `GATEWAY_MONGODB_URI` | *(required)* | MongoDB connection string |
| `MAX_JOBS_PER_BACKEND` | `2` | Max concurrent render jobs per backend before skipping |
| `HEALTH_CHECK_INTERVAL` | `15000` | Backend health check interval (ms) |
| `GATEWAY_ADMIN_USER` | `admin` | Admin UI username |
| `GATEWAY_ADMIN_PASSWORD` | *(empty)* | Admin UI password. If empty, auth is disabled |

## API Endpoints

### Backend (port 3102)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check with active/max job counts |
| `POST` | `/api/upload` | Upload file (multipart, 2GB max) |
| `GET` | `/api/upload/files/:filename` | Serve uploaded file (the 480p proxy once there; `?for=render`: the original or its master) |
| `GET` | `/api/captions/status` | Can this backend do auto captions (whisper, libass) |
| `POST` | `/api/captions/transcribe` | Start speech to text of a timeline's voice tracks |
| `GET` | `/api/captions/:jobId` | Poll it: words with times, language |
| `POST` | `/api/render` | Submit render job (timeline JSON) |
| `GET` | `/api/render/:jobId` | Poll render job status |
| `POST` | `/api/clip/prepare` | Submit HLS clip preparation |
| `GET` | `/api/clip/prepare/:jobId` | Poll clip prep status |

### Gateway (port 3200)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Gateway health check |
| `GET` | `/` | Yes | Admin UI |
| `GET` | `/api/backends` | Yes | List registered backends with health status |
| `POST` | `/api/backends` | Yes | Register a new backend `{ apiEndpoint }` |
| `PUT` | `/api/backends/:id` | Yes | Update backend `{ apiEndpoint, isActive }` |
| `DELETE` | `/api/backends/:id` | Yes | Remove a backend |
| `POST` | `/api/render` | No | Proxy render to least-loaded backend |
| `GET` | `/api/render/:jobId?backend=<url>` | No | Proxy status check to specific backend |

## Project Structure

```
├── src/                        # Frontend source
│   ├── App.jsx                 # Main layout
│   ├── components/
│   │   ├── Timeline.jsx        # Multi-track timeline
│   │   ├── GlobalPreview.jsx   # Multi-layer composited preview
│   │   ├── VideoPreview.jsx    # Single clip preview
│   │   ├── ClipProperties.jsx  # Properties panel
│   │   ├── ExportButton.jsx    # Export UI with settings & progress
│   │   ├── ProjectLibrary.jsx  # Media library with drag-to-timeline
│   │   ├── RecordVideo.jsx     # Webcam recording modal
│   │   ├── RecordAudio.jsx     # Audio recording modal
│   │   └── OnboardingTour.jsx  # First-time onboarding tour
│   ├── hooks/
│   │   ├── useTimeline.js      # Core timeline state & undo/redo
│   │   ├── useFFmpeg.js        # FFmpeg.wasm loader & export
│   │   ├── useCanvasExport.js  # Canvas-based WYSIWYG export
│   │   └── useIframeApi.js     # Iframe postMessage API
│   └── utils/                  # HLS helpers, downloaders
├── backend/                    # Server-side render service
│   └── src/
│       ├── routes/             # render, upload, clip endpoints
│       └── services/ffmpeg.js  # FFmpeg render pipeline
├── gateway/                    # Optional load balancer
│   ├── src/                    # Backend registry, health checks, proxy
│   └── public/index.html       # Admin UI
├── frontend/                   # Frontend Docker build
│   ├── Dockerfile
│   └── nginx.conf
├── nginx/                      # Example nginx reverse proxy configs
│   ├── frontend.conf.example
│   ├── backend-api.conf.example
│   └── gateway.conf.example
├── docker-compose.yml
├── .env.example
└── vite.config.js
```
