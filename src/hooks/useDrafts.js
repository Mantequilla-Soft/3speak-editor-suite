import { useCallback, useEffect, useRef, useState } from 'react'
import { api, getBackendUrl } from '../utils/backendSelector'
import { authFetch } from '../utils/editorAuth'

const AUTOSAVE_DELAY = 2500
const LOCAL = /^(blob|data):/

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`)

// Fields that only make sense in this browser session
const SESSION_FIELDS = ['file', 'uploading', 'uploadProgress', 'uploadError', 'converting', 'convertProgress', 'convertAhead', 'convertFailed']

// Drop every local-only reference (blob:/data: URLs, Files) from a value
const stripLocal = (value) => JSON.parse(JSON.stringify(value, (key, v) => {
  if (SESSION_FIELDS.includes(key)) return undefined
  return typeof v === 'string' && LOCAL.test(v) ? undefined : v
}))

// The clean plate and noise map of a static-background key are PNGs made in
// this browser (blob: / data: URLs). The local URLs of those in a project.
function localPlateUrls(tracks) {
  const urls = new Set()
  for (const t of tracks) {
    for (const c of t.clips) {
      const ck = c.chromaKey
      if (ck?.color !== 'static') continue
      if (ck.plateUrl && LOCAL.test(ck.plateUrl)) urls.add(ck.plateUrl)
      if (ck.noiseUrl && LOCAL.test(ck.noiseUrl)) urls.add(ck.noiseUrl)
    }
  }
  return [...urls]
}

// Upload one local image (plate / noise map) like any other file; its server URL
async function uploadLocalImage(localUrl, name) {
  const blob = await (await fetch(localUrl)).blob()
  const form = new FormData()
  form.append('file', blob, name)
  const res = await authFetch(api('/api/upload'), { method: 'POST', body: form })
  if (!res.ok) throw new Error(`upload ${res.status}`)
  const { url } = await res.json()
  const backend = getBackendUrl()
  return backend && url.startsWith('/') ? `${backend}${url}` : url
}

/**
 * The project as stored on the server: tracks and library with every media
 * reference pointing at the server's copy. Clips whose upload has not finished
 * have no server copy yet and are left out (counted in `pending`); the next
 * autosave after their upload picks them up. `plates` maps local plate / noise
 * map URLs to their uploaded copies (see useDrafts).
 */
export function serializeProject(tracks, library, plates = new Map()) {
  let pending = 0
  const serverRef = (x) => x.serverUrl || (x.url && !LOCAL.test(x.url) ? x.url : null)
  const outTracks = tracks.map(t => ({
    ...t,
    clips: t.clips.flatMap(c => {
      if (c.type === 'text' || c.type === 'color') return [stripLocal(c)]
      const url = serverRef(c)
      if (!url) { pending++; return [] }
      let source = { ...c, url }
      // A static-background key: its plate and noise map as uploaded copies
      if (c.chromaKey?.color === 'static') {
        const swap = (u) => (u && LOCAL.test(u) ? plates.get(u) || u : u)
        source = { ...source, chromaKey: { ...c.chromaKey, plateUrl: swap(c.chromaKey.plateUrl), noiseUrl: swap(c.chromaKey.noiseUrl) } }
      }
      const clip = stripLocal(source)
      // Without its plate (upload failed) the static key cannot work: save the clip unkeyed
      if (clip.chromaKey?.color === 'static' && !clip.chromaKey.plateUrl) delete clip.chromaKey
      return [clip]
    })
  }))
  const outLibrary = library.flatMap(i => {
    const url = serverRef(i)
    return url ? [stripLocal({ ...i, url })] : []
  })
  return { state: { version: 1, tracks: outTracks, library: outLibrary }, pending }
}

const hasContent = (tracks) => tracks.some(t => t.clips.length > 0)

/**
 * Drafts of a signed-in user, kept on the editor backend (/api/projects):
 * autosave from the first edit, a prompt to continue a saved draft, the
 * per-tier limit (free: 1 for 7 days, Pro: 3 for 30 days; each save restarts
 * the clock) and deleting the draft once the video is sent.
 */
export function useDrafts({ session, hasMedia, tracks, library, loadProjectState, onUnauthorized }) {
  const [drafts, setDrafts] = useState(null) // summaries, once fetched
  const [limits, setLimits] = useState(null)
  const [prompt, setPrompt] = useState(false) // "continue a draft?" on start
  const [status, setStatus] = useState('idle') // idle | saving | saved | limit | error
  const [saved, setSaved] = useState(null) // { updatedAt, expiresAt }
  const [limitProjects, setLimitProjects] = useState([])
  const [name, setName] = useState('')
  const [pending, setPending] = useState(0)
  const projectIdRef = useRef(null)
  const skipSaveRef = useRef(false) // the change a load makes is not an edit
  const replaceRef = useRef(null) // a free user who chose "start new" replaces their draft
  const touchedRef = useRef(false) // anything edited in this session yet
  const timerRef = useRef(null)
  // Local plate / noise map URL -> uploaded copy: each is uploaded once, not on every autosave
  const platesRef = useRef(new Map())

  // Upload the green-screen plates a save needs (failures just leave those clips unkeyed)
  const uploadPlates = useCallback(async () => {
    for (const local of localPlateUrls(tracks)) {
      if (platesRef.current.has(local)) continue
      try {
        platesRef.current.set(local, await uploadLocalImage(local, 'background-plate.png'))
      } catch (err) {
        console.warn('[drafts] green-screen plate not uploaded:', err.message)
      }
    }
  }, [tracks])

  const authed = useCallback((path, opts = {}) => fetch(api(`/api/projects${path}`), {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${session.token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }
  }), [session])

  // On start: list the user's drafts; offer them when the studio opened empty
  useEffect(() => {
    if (!session) { setDrafts(null); return }
    let cancelled = false
    authed('').then(r => (r.ok ? r.json() : null)).then(d => {
      if (cancelled || !d) return
      setDrafts(d.projects)
      setLimits(d.limits)
      if (d.projects.length && !hasMedia && !hasContent(tracks) && !projectIdRef.current) setPrompt(true)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [session]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async ({ replace = null, saveName } = {}) => {
    if (!session || !hasContent(tracks)) return { ok: false }
    setStatus('saving')
    await uploadPlates()
    const { state, pending: notYet } = serializeProject(tracks, library, platesRef.current)
    setPending(notYet)
    if (!projectIdRef.current) projectIdRef.current = newId()
    const finalName = (saveName ?? name).trim() || defaultName(tracks)
    setStatus('saving')
    try {
      const res = await authed(`/${projectIdRef.current}`, {
        method: 'PUT',
        body: JSON.stringify({ name: finalName, state, replace: replace || replaceRef.current || undefined })
      })
      if (res.status === 401) {
        // The token (6 h) ran out: the site mints a new one, then saving goes on
        onUnauthorized?.()
        setStatus('idle')
        return { ok: false }
      }
      if (res.status === 409) {
        const d = await res.json()
        setLimitProjects(d.projects || [])
        setLimits(d.limits || limits)
        setStatus('limit')
        return { ok: false, limit: true }
      }
      if (!res.ok) throw new Error(String(res.status))
      const d = await res.json()
      replaceRef.current = null
      setSaved({ updatedAt: d.project.updatedAt, expiresAt: d.project.expiresAt })
      setLimits(d.limits)
      if (!name) setName(d.project.name)
      setStatus('saved')
      return { ok: true }
    } catch {
      setStatus('error')
      return { ok: false }
    }
  }, [session, tracks, library, name, authed, limits, uploadPlates])

  // Autosave from the first edit on (not while the limit question is open)
  useEffect(() => {
    if (!session || !hasContent(tracks)) return
    if (skipSaveRef.current) { skipSaveRef.current = false; return }
    touchedRef.current = true
    if (status === 'limit') return
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { save() }, AUTOSAVE_DELAY)
    return () => clearTimeout(timerRef.current)
  }, [tracks, library, session]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadDraft = useCallback(async (id) => {
    const res = await authed(`/${id}`)
    if (!res.ok) return false
    const p = await res.json()
    skipSaveRef.current = true
    projectIdRef.current = p.id
    setName(p.name)
    setSaved({ updatedAt: p.updatedAt, expiresAt: p.expiresAt })
    setStatus('saved')
    loadProjectState(p.state)
    setPrompt(false)
    return true
  }, [authed, loadProjectState])

  // "Start new": a free user's single slot is taken over on the first save
  const startNew = useCallback(() => {
    setPrompt(false)
    if (limits && drafts && limits.maxProjects === 1 && drafts.length) replaceRef.current = drafts[0].id
  }, [limits, drafts])

  // The limit question: replace one of the saved projects, or do not save this one
  const resolveLimit = useCallback(async (replaceId) => {
    if (!replaceId) { setStatus('idle'); setLimitProjects([]); return { ok: false } }
    setLimitProjects([])
    return save({ replace: replaceId })
  }, [save])

  const deleteCurrent = useCallback(async () => {
    clearTimeout(timerRef.current)
    const id = projectIdRef.current
    projectIdRef.current = null
    setSaved(null)
    setStatus('idle')
    if (session && id) await authed(`/${id}`, { method: 'DELETE' }).catch(() => {})
  }, [session, authed])

  return {
    enabled: !!session,
    user: session?.user || null,
    drafts,
    limits,
    prompt,
    status,
    saved,
    pending,
    name,
    setName,
    limitProjects,
    hasEdits: () => touchedRef.current && hasContent(tracks),
    isSaved: () => !!projectIdRef.current && status === 'saved',
    save,
    loadDraft,
    startNew,
    resolveLimit,
    deleteCurrent
  }
}

function defaultName(tracks) {
  const first = tracks.flatMap(t => t.clips).find(c => c.type === 'video' || c.type === 'image')
  const base = (first?.name || 'Project').replace(/^Part \d+ · /, '').replace(/\.[a-z0-9]{2,4}$/i, '')
  const d = new Date()
  return `${base.slice(0, 40)} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

// "until Thu, 22 Oct, 14:05"
export function formatUntil(ms) {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// "7 days" / "30 days" (whole days from 2 days up, else hours)
export function formatKeep(ttlHours) {
  if (!ttlHours) return ''
  return ttlHours >= 48 && ttlHours % 24 === 0 ? `${ttlHours / 24} days` : `${ttlHours} hours`
}

// "2 h ago"
export function formatAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}
