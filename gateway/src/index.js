import crypto from 'crypto'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { connectDB } from './db.js'
import { addBackend, updateBackend, getAllBackends, deleteBackend } from './backends.js'
import { startHealthChecker, getHealthCache } from './healthChecker.js'
import { proxyRenderRequest, proxyStatusRequest, proxyAbortRequest } from './proxy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3200
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

app.use(cors())
app.use(express.json())

// Basic auth middleware for admin routes. Fails CLOSED: without ADMIN_PASSWORD the admin API and page are
// switched off (they used to be open to anyone).
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
function requireAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('Gateway admin is disabled: set ADMIN_PASSWORD to use it')

  const header = req.headers.authorization
  if (!header || !header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Gateway Admin"')
    return res.status(401).send('Authentication required')
  }

  const credentials = Buffer.from(header.slice(6), 'base64').toString()
  const sep = credentials.indexOf(':')
  const user = credentials.slice(0, sep), pass = credentials.slice(sep + 1) // a password may contain ':'

  if (sameSecret(user, ADMIN_USER) && sameSecret(pass, ADMIN_PASSWORD)) {
    return next()
  }

  res.set('WWW-Authenticate', 'Basic realm="Gateway Admin"')
  return res.status(401).send('Invalid credentials')
}

// Gateway health check (public)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// === Admin API: Backend Management (protected) ===

app.get('/api/backends', requireAuth, async (req, res) => {
  try {
    const backends = await getAllBackends()
    const healthCache = getHealthCache()

    const result = backends.map(b => ({
      ...b,
      health: healthCache.get(b.apiEndpoint) || {
        healthy: false, activeJobs: 0, maxConcurrentJobs: 0,
        lastChecked: null, error: 'Not checked yet'
      }
    }))

    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/backends', requireAuth, async (req, res) => {
  try {
    const { apiEndpoint } = req.body
    if (!apiEndpoint) {
      return res.status(400).json({ error: 'apiEndpoint required' })
    }
    const normalized = apiEndpoint.replace(/\/+$/, '')
    const backend = await addBackend(normalized)
    res.status(201).json(backend)
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Backend endpoint already exists' })
    }
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/backends/:id', requireAuth, async (req, res) => {
  try {
    const result = await updateBackend(req.params.id, req.body)
    if (!result) {
      return res.status(404).json({ error: 'Backend not found' })
    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/backends/:id', requireAuth, async (req, res) => {
  try {
    const result = await deleteBackend(req.params.id)
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Backend not found' })
    }
    res.json({ deleted: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// === Proxy API: Forward render requests ===

app.post('/api/render', proxyRenderRequest)
app.get('/api/render/:jobId', proxyStatusRequest)
app.post('/api/render/:jobId/abort', proxyAbortRequest)

// Serve admin UI (protected) — after API routes so auth doesn't block them
app.use('/', requireAuth, express.static(path.join(__dirname, '..', 'public')))

// === Startup ===

async function start() {
  await connectDB()
  startHealthChecker()

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[gateway] Gateway service listening on port ${PORT}`)
  })
}

start().catch(err => {
  console.error('[gateway] Failed to start:', err)
  process.exit(1)
})
