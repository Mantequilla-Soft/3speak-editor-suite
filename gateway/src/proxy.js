import { getActiveBackends, recordJobSent } from './backends.js'
import { getBackendHealth } from './healthChecker.js'
import { rankBackends } from './pick.js'

const MAX_JOBS_PER_BACKEND = parseInt(process.env.MAX_JOBS_PER_BACKEND || '2', 10)

let rrIndex = 0

export async function selectBackend() {
  const list = await candidates()
  return list[0] || null
}

async function candidates() {
  const backends = await getActiveBackends()
  if (backends.length === 0) return []
  const start = rrIndex % backends.length
  rrIndex = start + 1
  return rankBackends(backends, getBackendHealth, { maxJobsPerBackend: MAX_JOBS_PER_BACKEND, start })
}

// The health cache is refreshed every few seconds: count a job sent right
// away, so a burst of renders spreads over the backends
function countSent(apiEndpoint, data) {
  const h = getBackendHealth(apiEndpoint)
  if (!h || !h.healthy) return
  if (data?.status === 'queued' && Number.isFinite(h.queuedJobs)) h.queuedJobs++
  else h.activeJobs = (h.activeJobs || 0) + 1
}

export async function proxyRenderRequest(req, res) {
  const list = await candidates()

  if (list.length === 0) {
    return res.status(503).json({ error: 'No available render backends', retryAfter: 30 })
  }

  let last = null
  for (const backend of list) {
    try {
      const proxyRes = await fetch(`${backend.apiEndpoint}/api/render`, {
        method: 'POST',
        // the 3Speak sign-in travels on: the backend checks it (backend/src/auth.js)
        headers: { 'Content-Type': 'application/json', ...(req.get('Authorization') ? { Authorization: req.get('Authorization') } : {}) },
        body: JSON.stringify(req.body)
      })

      const data = await proxyRes.json()

      if (proxyRes.ok) {
        await recordJobSent(backend._id)
        countSent(backend.apiEndpoint, data)
        return res.json({ ...data, backendEndpoint: backend.apiEndpoint })
      }
      // Busy after all (the health check was older): the next one
      if (proxyRes.status === 503) { last = { status: 503, data }; continue }
      return res.status(proxyRes.status).json(data)
    } catch (err) {
      console.error(`[gateway] Proxy error to ${backend.apiEndpoint}:`, err.message)
      last = { status: 502, data: { error: 'Backend communication error', detail: err.message } }
    }
  }
  return res.status(last.status).json(last.status === 503 ? { retryAfter: 30, ...last.data } : last.data)
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
    const proxyRes = await fetch(`${backendEndpoint}/api/render/${jobId}/abort`, { method: 'POST', headers: req.get('Authorization') ? { Authorization: req.get('Authorization') } : {} })
    const data = await proxyRes.json()
    return res.status(proxyRes.status).json(data)
  } catch (err) {
    return res.status(502).json({ error: 'Backend communication error', detail: err.message })
  }
}
