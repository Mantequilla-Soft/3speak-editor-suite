// Which backend gets a new render. Backends with a render place free come
// first (fewest jobs first, round robin among equals); when every place is
// taken, the job still goes to the backend with the shortest line (backends
// queue jobs themselves since the render queue, backend/src/utils/renderQueue.js).
// An older backend that does not report `queuedJobs` cannot queue: it only
// gets jobs while it has a place free. No candidate = the gateway answers 503
// and the editor tries again by itself.

/**
 * @param backends [{ apiEndpoint, ... }] (active ones, in a stable order)
 * @param healthOf apiEndpoint -> { healthy, activeJobs, maxConcurrentJobs, queuedJobs?, maxQueuedJobs? }
 * @param opts { maxJobsPerBackend, start } start = round robin offset
 * @returns the backends to try, best first
 */
export function rankBackends(backends, healthOf, { maxJobsPerBackend = 2, start = 0 } = {}) {
  const n = backends.length
  const rows = []
  for (let i = 0; i < n; i++) {
    const b = backends[(start + i) % n]
    const h = healthOf(b.apiEndpoint) || {}
    if (!h.healthy) continue
    const places = Math.max(1, Math.min(maxJobsPerBackend, h.maxConcurrentJobs || maxJobsPerBackend))
    const active = h.activeJobs || 0
    const queues = Number.isFinite(h.queuedJobs)
    const queued = queues ? h.queuedJobs : 0
    const free = active < places
    if (!free && !queues) continue
    if (!free && Number.isFinite(h.maxQueuedJobs) && queued >= h.maxQueuedJobs) continue
    rows.push({ b, i, free, load: (active + queued) / places })
  }
  rows.sort((x, y) => (y.free - x.free) || (x.load - y.load) || (x.i - y.i))
  return rows.map(r => r.b)
}
