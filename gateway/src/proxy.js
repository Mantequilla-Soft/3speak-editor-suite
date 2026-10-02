import { getActiveBackends, recordJobSent } from './backends.js'
import { getBackendHealth } from './healthChecker.js'

const MAX_JOBS_PER_BACKEND = parseInt(process.env.MAX_JOBS_PER_BACKEND || '2', 10)

let rrIndex = 0

export async function selectBackend() {
  const backends = await getActiveBackends()
  if (backends.length === 0) return null

  const startIndex = rrIndex % backends.length

  for (let i = 0; i < backends.length; i++) {
    const idx = (startIndex + i) % backends.length
    const backend = backends[idx]
    const health = getBackendHealth(backend.apiEndpoint)

    if (health.healthy && health.activeJobs < MAX_JOBS_PER_BACKEND) {
      rrIndex = idx + 1
      return backend
    }
  }

  return null
}

export async function proxyRenderRequest(req, res) {
  const backend = await selectBackend()

  if (!backend) {
    return res.status(503).json({ error: 'No available render backends', retryAfter: 30 })
  }

  try {
    const proxyRes = await fetch(`${backend.apiEndpoint}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    })

    const data = await proxyRes.json()

    if (proxyRes.ok) {
      await recordJobSent(backend._id)
      return res.json({ ...data, backendEndpoint: backend.apiEndpoint })
    }

    return res.status(proxyRes.status).json(data)
  } catch (err) {
    console.error(`[gateway] Proxy error to ${backend.apiEndpoint}:`, err.message)
    return res.status(502).json({ error: 'Backend communication error', detail: err.message })
  }
}

export async function proxyStatusRequest(req, res) {
  const { jobId } = req.params
  const backendEndpoint = req.query.backend

  if (!backendEndpoint) {
    return res.status(400).json({ error: 'backend query parameter required' })
  }

  try {
    const proxyRes = await fetch(`${backendEndpoint}/api/render/${jobId}`)
    const data = await proxyRes.json()
    return res.status(proxyRes.status).json(data)
  } catch (err) {
    return res.status(502).json({ error: 'Backend communication error', detail: err.message })
  }
}

export async function proxyAbortRequest(req, res) {
  const { jobId } = req.params
  const backendEndpoint = req.query.backend

  if (!backendEndpoint) {
    return res.status(400).json({ error: 'backend query parameter required' })
  }

  try {
    const proxyRes = await fetch(`${backendEndpoint}/api/render/${jobId}/abort`, { method: 'POST' })
    const data = await proxyRes.json()
    return res.status(proxyRes.status).json(data)
  } catch (err) {
    return res.status(502).json({ error: 'Backend communication error', detail: err.message })
  }
}
