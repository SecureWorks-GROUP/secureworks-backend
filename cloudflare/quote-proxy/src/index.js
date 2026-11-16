// quote-proxy: every customer quote link on the company's own address
// (Marnin, 16 Nov 2026: "we dont want them to check our github", "i want the
// web address to be somewhere else").
//
// A strict allow-list. On the custom domain it serves:
//   /q/<route>, /functions/v1/send-quote/<route>
//                     -> SUPABASE_ORIGIN/functions/v1/send-quote/<route>
//                        customer routes only; method, query and body passed through;
//                        redirects to supabase, pages.dev or GitHub Pages rewritten to our paths
//   /files/<bucket>/<path>
//                     -> SUPABASE_ORIGIN/storage/v1/object/public/<bucket>/<path>
//                        GET/HEAD only; job-pdfs and quote-views only
//   /view             -> VIEWER_URL (the quote viewer shell); src must be our own /files
//   /3d/patio/<file>, /3d/fence/<file>
//                     -> PATIO_3D_BASE / FENCE_3D_BASE + file; only the files in THREE_D_FILES
// Anything else is 404: no other function, no REST, no auth, no staff route.
//
// No secret: the customer's own share token rides in the query; no key is added,
// and cookies, Authorization, apikey and x-api-key are never forwarded.
// The backend's side of this map: supabase/functions/_shared/customer_public_host.ts.

export const CUSTOMER_QUOTE_ROUTES = ['view', 'accept', 'decline', 'payment-confirmed', 'upload-plans', 'model']
export const CUSTOMER_FILE_BUCKETS = ['job-pdfs', 'quote-views']

export const DEFAULTS = {
  SUPABASE_ORIGIN: 'https://kevgrhcjxspbxgovpmfl.supabase.co',
  VIEWER_URL: 'https://secureworks-website.pages.dev/quote',
  PATIO_3D_BASE: 'https://marninms98-dotcom.github.io/patio/scope-engine/',
  FENCE_3D_BASE: 'https://marninms98-dotcom.github.io/patio/scope-engine/',
  THREE_D_FILES: 'quote-3d.html',
}

// Request headers passed upstream. Everything else (cookies, Authorization,
// apikey, x-api-key, Cloudflare's own) stays on our side.
const FORWARD_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
  'range',
  'if-none-match',
  'if-modified-since',
  'origin',
]

const SEND_QUOTE_METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS']
const READ_METHODS = ['GET', 'HEAD']
// Encoded dots, slashes, backslashes or percent signs never appear in a real
// link and could be decoded upstream into another path.
const SUSPECT_ESCAPE = /%(2e|2f|5c|25)/i

function config(env) {
  const e = env || {}
  const pick = (k) => (typeof e[k] === 'string' && e[k].trim() ? e[k].trim() : DEFAULTS[k])
  const files = pick('THREE_D_FILES').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    supabaseOrigin: new URL(pick('SUPABASE_ORIGIN')).origin,
    viewerUrl: new URL(pick('VIEWER_URL')).href,
    threeD: { patio: new URL(pick('PATIO_3D_BASE')).href, fence: new URL(pick('FENCE_3D_BASE')).href },
    threeDFiles: files,
  }
}

const notFound = () =>
  new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
const notAllowed = (allow) =>
  new Response('Method not allowed', { status: 405, headers: { 'Content-Type': 'text/plain; charset=utf-8', Allow: allow.join(', ') } })
const badLink = () =>
  new Response('Invalid link', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })

/**
 * Where a request on our host goes, or null when it is outside the map.
 * Pure: no network. { kind, upstream, methods }.
 */
export function upstreamFor(requestUrl, env) {
  const c = config(env)
  const u = new URL(requestUrl)
  const path = u.pathname
  if (SUSPECT_ESCAPE.test(path) || path.includes('\\')) return null

  const fn = path.match(/^\/(?:q|functions\/v1\/send-quote)\/([^/]+)$/)
  if (fn) {
    if (!CUSTOMER_QUOTE_ROUTES.includes(fn[1])) return null
    return { kind: 'send-quote', upstream: `${c.supabaseOrigin}/functions/v1/send-quote/${fn[1]}${u.search}`, methods: SEND_QUOTE_METHODS }
  }

  const file = path.match(/^\/files\/([^/]+)\/(.+)$/)
  if (file) {
    if (!CUSTOMER_FILE_BUCKETS.includes(file[1])) return null
    const prefix = `/storage/v1/object/public/${file[1]}/`
    const up = new URL(`${c.supabaseOrigin}${prefix}${file[2]}${u.search}`)
    if (up.origin !== c.supabaseOrigin || !up.pathname.startsWith(prefix) || up.pathname === prefix) return null
    return { kind: 'file', upstream: up.href, methods: READ_METHODS }
  }

  if (path === '/view') {
    // The shell document.writes whatever src it is given: on our domain it may
    // only be our own read-only /files.
    const src = u.searchParams.get('src')
    if (!src) return { kind: 'bad-link' }
    let s
    try { s = new URL(src) } catch (_e) { return { kind: 'bad-link' } }
    if (s.origin !== u.origin || !upstreamFor(s.href, env) || !s.pathname.startsWith('/files/')) return { kind: 'bad-link' }
    return { kind: 'page', upstream: c.viewerUrl, methods: READ_METHODS }
  }

  const three = path.match(/^\/3d\/(patio|fence)\/([^/]+)$/)
  if (three) {
    if (!c.threeDFiles.includes(three[2])) return null
    return { kind: 'page', upstream: new URL(three[2], c.threeD[three[1]]).href, methods: READ_METHODS }
  }

  return null
}

/**
 * A Location from upstream as the customer should see it: a supabase send-quote
 * route or allowed bucket, the viewer (with its src), or a 3D page becomes the
 * matching path on our host. Anything else is returned as it was (still works).
 */
export function rewriteLocation(location, upstreamUrl, publicOrigin, env) {
  const c = config(env)
  let l
  try { l = new URL(location, upstreamUrl) } catch (_e) { return location }

  if (l.origin === c.supabaseOrigin) {
    const fn = l.pathname.match(/^\/functions\/v1\/send-quote\/([^/]+)$/)
    if (fn && CUSTOMER_QUOTE_ROUTES.includes(fn[1])) return `${publicOrigin}/q/${fn[1]}${l.search}${l.hash}`
    const file = l.pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/)
    if (file && CUSTOMER_FILE_BUCKETS.includes(file[1])) return `${publicOrigin}/files/${file[1]}/${file[2]}${l.search}${l.hash}`
    return location
  }

  const viewer = new URL(c.viewerUrl)
  const viewerPaths = new Set([viewer.pathname, viewer.pathname.replace(/\.html$/, ''), `${viewer.pathname.replace(/\.html$/, '')}.html`])
  if (l.origin === viewer.origin && viewerPaths.has(l.pathname)) {
    const src = l.searchParams.get('src')
    if (!src) return location
    const mapped = rewriteLocation(src, upstreamUrl, publicOrigin, env)
    if (!mapped.startsWith(`${publicOrigin}/files/`)) return location
    return `${publicOrigin}/view?src=${encodeURIComponent(mapped)}`
  }

  for (const what of ['patio', 'fence']) {
    const base = new URL(c.threeD[what])
    if (l.origin !== base.origin || !l.pathname.startsWith(base.pathname)) continue
    const file = l.pathname.slice(base.pathname.length)
    if (c.threeDFiles.includes(file)) return `${publicOrigin}/3d/${what}/${file}${l.search}${l.hash}`
  }
  return location
}

function forwardHeaders(request) {
  const h = new Headers()
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(name)
    if (v !== null) h.set(name, v)
  }
  return h
}

function responseHeaders(upstream, kind, upstreamUrl, publicOrigin, env) {
  const h = new Headers(upstream.headers)
  h.delete('set-cookie')
  const loc = h.get('location')
  if (loc !== null) h.set('location', rewriteLocation(loc, upstreamUrl, publicOrigin, env))
  if (kind === 'file') {
    // Stored files are data, never a page on our domain.
    const ct = (h.get('content-type') || '').toLowerCase()
    if (ct.startsWith('text/html') || ct.includes('xml') || ct.startsWith('image/svg')) h.set('content-type', 'text/plain; charset=utf-8')
    h.set('x-content-type-options', 'nosniff')
  }
  return h
}

/** The worker. fetchImpl is injectable for tests (no network). */
export async function handle(request, env, fetchImpl = fetch) {
  const route = upstreamFor(request.url, env)
  if (!route) return notFound()
  if (route.kind === 'bad-link') return badLink()
  if (!route.methods.includes(request.method)) return notAllowed(route.methods)

  const publicOrigin = new URL(request.url).origin
  const init = {
    method: request.method,
    headers: forwardHeaders(request),
    // Our pages (viewer, 3D) are followed upstream so the customer stays on our address;
    // send-quote redirects come back to be rewritten.
    redirect: route.kind === 'page' ? 'follow' : 'manual',
  }
  if (request.method === 'POST') init.body = await request.arrayBuffer()
  const upstream = await fetchImpl(route.upstream, init)
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream, route.kind, route.upstream, publicOrigin, env),
  })
}

export default {
  fetch(request, env) {
    return handle(request, env)
  },
}
