import { getActiveBackends } from './backends.js'

const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '15000', 10)
const HEALTH_CHECK_TIMEOUT = parseInt(process.env.HEALTH_CHECK_TIMEOUT || '5000', 10)

// Cache: apiEndpoint -> { healthy, activeJobs, maxConcurrentJobs, lastChecked, error }
const healthCache = new Map()

export function getHealthCache() {
  return healthCache
}

export function getBackendHealth(apiEndpoint) {
  return healthCache.get(apiEndpoint) || {
    healthy: false,
    activeJobs: 0,
    maxConcurrentJobs: 0,
    lastChecked: null,
    error: 'Not checked yet'
  }
}

async function checkBackendHealth(apiEndpoint) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT)

    const response = await fetch(`${apiEndpoint}/api/health`, { signal: controller.signal })
    clearTimeout(timeout)

    if (!response.ok) {
      healthCache.set(apiEndpoint, {
        healthy: false, activeJobs: 0, maxConcurrentJobs: 0,
        lastChecked: new Date(), error: `HTTP ${response.status}`
      })
      return
    }

    const data = await response.json()
    healthCache.set(apiEndpoint, {
      healthy: data.status === 'ok',
      activeJobs: data.activeJobs || 0,
      maxConcurrentJobs: data.maxConcurrentJobs || 0,
      lastChecked: new Date(),
      error: null
    })
  } catch (err) {
    healthCache.set(apiEndpoint, {
      healthy: false, activeJobs: 0, maxConcurrentJobs: 0,
      lastChecked: new Date(), error: err.message
    })
  }
}

async function runHealthChecks() {
  try {
    const backends = await getActiveBackends()
    await Promise.allSettled(backends.map(b => checkBackendHealth(b.apiEndpoint)))
  } catch (err) {
    console.error('[gateway] Health check cycle error:', err.message)
  }
}

export function startHealthChecker() {
  runHealthChecks()
  setInterval(runHealthChecks, HEALTH_CHECK_INTERVAL)
  console.log(`[gateway] Health checker started (interval: ${HEALTH_CHECK_INTERVAL}ms)`)
}
