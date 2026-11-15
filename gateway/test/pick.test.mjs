// The gateway's choice of backend for a new render (src/pick.js)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankBackends } from '../src/pick.js'

const b = (name) => ({ apiEndpoint: `http://${name}:3102` })
const A = b('a'), B = b('b'), C = b('c')
const rank = (health, opts) => rankBackends([A, B, C], (e) => health[e.split('//')[1].split(':')[0]], opts).map(x => x.apiEndpoint.split('//')[1].split(':')[0])

test('free render places first, the least busy first, round robin among equals', () => {
  const h = { a: { healthy: true, activeJobs: 1, maxConcurrentJobs: 2, queuedJobs: 0 }, b: { healthy: true, activeJobs: 0, maxConcurrentJobs: 2, queuedJobs: 0 }, c: { healthy: true, activeJobs: 0, maxConcurrentJobs: 2, queuedJobs: 0 } }
  assert.deepEqual(rank(h), ['b', 'c', 'a'])
  assert.deepEqual(rank(h, { start: 2 }), ['c', 'b', 'a'])
})

test('all busy: the shortest line gets it (backends queue), a full line none', () => {
  const h = { a: { healthy: true, activeJobs: 2, maxConcurrentJobs: 2, queuedJobs: 3, maxQueuedJobs: 20 }, b: { healthy: true, activeJobs: 2, maxConcurrentJobs: 2, queuedJobs: 1, maxQueuedJobs: 20 }, c: { healthy: true, activeJobs: 2, maxConcurrentJobs: 2, queuedJobs: 20, maxQueuedJobs: 20 } }
  assert.deepEqual(rank(h), ['b', 'a'])
})

test('an older backend (no queuedJobs) only while it has a place; unhealthy ones never', () => {
  const h = { a: { healthy: true, activeJobs: 2, maxConcurrentJobs: 2 }, b: { healthy: false, activeJobs: 0, maxConcurrentJobs: 2, queuedJobs: 0 }, c: { healthy: true, activeJobs: 1, maxConcurrentJobs: 2 } }
  assert.deepEqual(rank(h), ['c'])
  assert.deepEqual(rank({ a: h.a, b: h.b, c: { ...h.c, activeJobs: 2 } }), [])
})

test('MAX_JOBS_PER_BACKEND still caps the places the gateway counts', () => {
  const h = { a: { healthy: true, activeJobs: 1, maxConcurrentJobs: 4, queuedJobs: 0 }, b: { healthy: true, activeJobs: 0, maxConcurrentJobs: 4, queuedJobs: 2 } }
  assert.deepEqual(rank({ ...h, c: undefined }, { maxJobsPerBackend: 1 }), ['b', 'a']) // a is full at 1, b has its place
})
