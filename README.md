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
| Frontend | React 18, Vite 5, FFmpeg.wasm, HLS.js, Lucide React |
| Backend | Node.js 18, Express 4, FFmpeg (system), Multer |
| Gateway | Node.js 18, Express 4, MongoDB |
| Infra | Docker Compose, Nginx, SharedArrayBuffer (COOP/COEP) |

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
- Undo/redo with 20-level history
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

### Other
- Drag-and-drop or file-picker media import with categorized library (Videos, Images, Sounds)
- HLS stream support with automatic download and progress tracking
- Webcam and audio recording via MediaRecorder API
- First-time onboarding tour
- Light and dark theme support
- Iframe embedding API with postMessage communication

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Delete` / `Backspace` | Remove selected clip |
| `Ctrl+R` | Split clip at playhead |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Ctrl+Shift+G` | Ungroup clips |
| `Arrow Left/Right` | Move playhead (100ms, 1s with Shift) |

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
| `GET` | `/api/upload/files/:filename` | Serve uploaded file |
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
