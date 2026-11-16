// quote-proxy tests. No network: every upstream call goes to a recording fake.
// Run: node --test test/worker_test.js   or   deno test test/worker_test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { DEFAULTS, handle, rewriteLocation, upstreamFor } from '../src/index.js'

const HOST = 'https://quote.secureworksgroup.app'
const SB = DEFAULTS.SUPABASE_ORIGIN
const ENV = {}

function fakeFetch(answer = () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })) {
  const calls = []
  const f = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve(answer(url, init))
  }
  f.calls = calls
  return f
}

// ── Path map ──

test('send-quote customer routes map to the function, query kept, on /q and /functions/v1/send-quote', () => {
  for (const route of ['view', 'accept', 'decline', 'payment-confirmed', 'upload-plans', 'model']) {
    assert.equal(upstreamFor(`${HOST}/q/${route}?token=abc&type=variation`, ENV).upstream, `${SB}/functions/v1/send-quote/${route}?token=abc&type=variation`)
    assert.equal(upstreamFor(`${HOST}/functions/v1/send-quote/${route}?token=abc`, ENV).upstream, `${SB}/functions/v1/send-quote/${route}?token=abc`)
  }
})

test('staff send-quote routes, other functions, REST, auth and storage APIs are refused', () => {
  const refused = [
    '/q/send', '/q/send-runs', '/q/send-invoice', '/q/status', '/q/accept-for-customer', '/q/neighbour-nudge',
    '/q/', '/q', '/q/view/extra', '/functions/v1/send-quote/send', '/functions/v1/ops-api', '/functions/v1/ops-api/x',
    '/functions/v1/ghl-proxy', '/rest/v1/jobs', '/auth/v1/token', '/storage/v1/object/public/job-pdfs/a.pdf',
    '/', '/index.html', '/files/job-photos/a.jpg', '/files/job-documents/a.pdf', '/files/library-docs/a.pdf',
    '/files/job-pdfs/', '/files/job-pdfs', '/3d/patio/index.html', '/3d/patio/', '/3d/deck/quote-3d.html',
    '/3d/patio/sub/quote-3d.html', '/q/%2e%2e%2fops-api', '/files/job-pdfs/%2e%2e/%2e%2e/x', '/files/job-pdfs/a%2fb.pdf',
    '/files/job-pdfs/a%252e.pdf', '/q/view%3F',
  ]
  for (const p of refused) assert.equal(upstreamFor(`${HOST}${p}`, ENV), null, p)
})

test('dot segments are resolved before the map, so they cannot climb out', () => {
  // new URL normalises these; whatever is left must still be inside the map or refused.
  assert.equal(upstreamFor(`${HOST}/files/job-pdfs/../../rest/v1/jobs`, ENV), null)
  assert.equal(upstreamFor(`${HOST}/q/../functions/v1/ops-api`, ENV), null)
  assert.equal(upstreamFor(`${HOST}/files/job-pdfs/a/../b.pdf`, ENV).upstream, `${SB}/storage/v1/object/public/job-pdfs/b.pdf`)
})

test('files map read-only to the two allowed public buckets', () => {
  assert.deepEqual(upstreamFor(`${HOST}/files/job-pdfs/org/job/quote_v2.pdf`, ENV), {
    kind: 'file', upstream: `${SB}/storage/v1/object/public/job-pdfs/org/job/quote_v2.pdf`, methods: ['GET', 'HEAD'],
  })
  assert.equal(upstreamFor(`${HOST}/files/quote-views/pages/x.txt`, ENV).upstream, `${SB}/storage/v1/object/public/quote-views/pages/x.txt`)
})

test('/view needs a src on our own /files; anything else is an invalid link', () => {
  const ok = `${HOST}/view?src=${encodeURIComponent(`${HOST}/files/quote-views/pages/x.txt`)}`
  assert.deepEqual(upstreamFor(ok, ENV), { kind: 'page', upstream: DEFAULTS.VIEWER_URL, methods: ['GET', 'HEAD'] })
  for (const src of [
    null,
    'https://evil.example/x.html',
    `${SB}/storage/v1/object/public/quote-views/pages/x.txt`,
    `${HOST}/files/job-photos/x.jpg`,
    `${HOST}/q/view?token=a`,
    'https://quote.secureworksgroup.app.evil.example/files/job-pdfs/x',
    'not a url',
  ]) {
    const u = src === null ? `${HOST}/view` : `${HOST}/view?src=${encodeURIComponent(src)}`
    assert.deepEqual(upstreamFor(u, ENV), { kind: 'bad-link' }, String(src))
  }
})

test('3D pages: only the allowed file, patio and fence', () => {
  assert.equal(upstreamFor(`${HOST}/3d/patio/quote-3d.html?token=t`, ENV).upstream, `${DEFAULTS.PATIO_3D_BASE}quote-3d.html`)
  assert.equal(upstreamFor(`${HOST}/3d/fence/quote-3d.html?token=t`, ENV).upstream, `${DEFAULTS.FENCE_3D_BASE}quote-3d.html`)
})

test('upstreams come from env vars when set', () => {
  const env = { SUPABASE_ORIGIN: 'https://other.supabase.co', FENCE_3D_BASE: 'https://secureworks-group.github.io/fence-designer/', THREE_D_FILES: 'quote-3d.html, fence-3d.html' }
  assert.equal(upstreamFor(`${HOST}/q/view?token=a`, env).upstream, 'https://other.supabase.co/functions/v1/send-quote/view?token=a')
  assert.equal(upstreamFor(`${HOST}/3d/fence/fence-3d.html`, env).upstream, 'https://secureworks-group.github.io/fence-designer/fence-3d.html')
})

// ── Redirect rewrite ──

test('redirect Location: viewer with supabase src becomes /view with our /files src', () => {
  const src = `${SB}/storage/v1/object/public/quote-views/pages/abc.txt`
  for (const viewer of ['https://secureworks-website.pages.dev/quote.html', 'https://secureworks-website.pages.dev/quote']) {
    const loc = `${viewer}?src=${encodeURIComponent(src)}`
    assert.equal(
      rewriteLocation(loc, `${SB}/functions/v1/send-quote/view?token=a`, HOST, ENV),
      `${HOST}/view?src=${encodeURIComponent(`${HOST}/files/quote-views/pages/abc.txt`)}`,
    )
  }
})

test('redirect Location: supabase send-quote, storage and 3D pages map to our paths', () => {
  const up = `${SB}/functions/v1/send-quote/view?token=a`
  assert.equal(rewriteLocation(`${SB}/functions/v1/send-quote/view?token=b`, up, HOST, ENV), `${HOST}/q/view?token=b`)
  assert.equal(rewriteLocation('/functions/v1/send-quote/accept?token=b', up, HOST, ENV), `${HOST}/q/accept?token=b`)
  assert.equal(rewriteLocation(`${SB}/storage/v1/object/public/job-pdfs/a/b.pdf`, up, HOST, ENV), `${HOST}/files/job-pdfs/a/b.pdf`)
  assert.equal(rewriteLocation(`${DEFAULTS.PATIO_3D_BASE}quote-3d.html?token=z`, up, HOST, ENV), `${HOST}/3d/patio/quote-3d.html?token=z`)
})

test('redirect Location outside the map is left as it was', () => {
  const up = `${SB}/functions/v1/send-quote/view?token=a`
  for (const loc of [
    'https://secureworksgroup.com.au/',
    `${SB}/functions/v1/ops-api?action=x`,
    `${SB}/storage/v1/object/public/job-photos/a.jpg`,
    'https://secureworks-website.pages.dev/quote.html?src=https%3A%2F%2Fevil.example%2Fx',
    'https://secureworks-website.pages.dev/other',
    'https://marninms98-dotcom.github.io/patio/scope-engine/index.html',
  ]) assert.equal(rewriteLocation(loc, up, HOST, ENV), loc)
})

// ── The worker end to end (fake upstream) ──

test('a View Your Quote click: GET passed through, redirect kept manual and rewritten, no key or cookie forwarded', async () => {
  const src = `${SB}/storage/v1/object/public/quote-views/pages/abc.txt`
  const f = fakeFetch(() => new Response(null, {
    status: 302,
    headers: { location: `https://secureworks-website.pages.dev/quote.html?src=${encodeURIComponent(src)}`, 'set-cookie': 'sb=1' },
  }))
  const res = await handle(new Request(`${HOST}/q/view?token=tok`, {
    headers: { cookie: 'a=b', authorization: 'Bearer x', apikey: 'k', 'x-api-key': 'k', 'user-agent': 'UA', accept: 'text/html' },
  }), ENV, f)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), `${HOST}/view?src=${encodeURIComponent(`${HOST}/files/quote-views/pages/abc.txt`)}`)
  assert.equal(res.headers.get('set-cookie'), null)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, `${SB}/functions/v1/send-quote/view?token=tok`)
  assert.equal(f.calls[0].init.redirect, 'manual')
  const sent = f.calls[0].init.headers
  assert.equal(sent.get('cookie'), null)
  assert.equal(sent.get('authorization'), null)
  assert.equal(sent.get('apikey'), null)
  assert.equal(sent.get('x-api-key'), null)
  assert.equal(sent.get('user-agent'), 'UA')
})

test('accept: POST body and content type passed through, answer returned as is', async () => {
  const f = fakeFetch(() => new Response('{"success":true}', { status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } }))
  const res = await handle(new Request(`${HOST}/functions/v1/send-quote/accept?token=tok`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"A"}',
  }), ENV, f)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '{"success":true}')
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.equal(f.calls[0].url, `${SB}/functions/v1/send-quote/accept?token=tok`)
  assert.equal(f.calls[0].init.method, 'POST')
  assert.equal(new TextDecoder().decode(f.calls[0].init.body), '{"name":"A"}')
  assert.equal(f.calls[0].init.headers.get('content-type'), 'application/json')
})

test('files: GET only; html from storage is served as plain text with nosniff', async () => {
  const f = fakeFetch(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  const res = await handle(new Request(`${HOST}/files/job-pdfs/a/quote_web.html`), ENV, f)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  const post = await handle(new Request(`${HOST}/files/job-pdfs/a.pdf`, { method: 'POST', body: 'x' }), ENV, f)
  assert.equal(post.status, 405)
  const put = await handle(new Request(`${HOST}/files/job-pdfs/a.pdf`, { method: 'PUT', body: 'x' }), ENV, f)
  assert.equal(put.status, 405)
  assert.equal(f.calls.length, 1)
})

test('pdf: content type kept, range passed through', async () => {
  const f = fakeFetch(() => new Response('%PDF', { status: 206, headers: { 'content-type': 'application/pdf' } }))
  const res = await handle(new Request(`${HOST}/files/job-pdfs/a.pdf`, { headers: { range: 'bytes=0-3' } }), ENV, f)
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-type'), 'application/pdf')
  assert.equal(f.calls[0].init.headers.get('range'), 'bytes=0-3')
})

test('viewer and 3D pages: followed upstream, the token is not sent to GitHub or pages.dev', async () => {
  const f = fakeFetch(() => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  const v = await handle(new Request(`${HOST}/view?src=${encodeURIComponent(`${HOST}/files/quote-views/pages/a.txt`)}`), ENV, f)
  assert.equal(v.status, 200)
  assert.equal(v.headers.get('content-type'), 'text/html')
  assert.equal(f.calls[0].url, DEFAULTS.VIEWER_URL)
  assert.equal(f.calls[0].init.redirect, 'follow')
  const t = await handle(new Request(`${HOST}/3d/fence/quote-3d.html?token=secret`), ENV, f)
  assert.equal(t.status, 200)
  assert.equal(f.calls[1].url, `${DEFAULTS.FENCE_3D_BASE}quote-3d.html`)
  assert.ok(!f.calls[1].url.includes('secret'))
})

test('outside the map: 404 and no upstream call; bad viewer src: 400 and no upstream call', async () => {
  const f = fakeFetch()
  for (const p of ['/functions/v1/ops-api?action=list_jobs', '/rest/v1/jobs', '/q/send', '/auth/v1/user']) {
    const res = await handle(new Request(`${HOST}${p}`, { method: 'POST', body: '{}' }), ENV, f)
    assert.equal(res.status, 404, p)
  }
  const bad = await handle(new Request(`${HOST}/view?src=${encodeURIComponent('https://evil.example/x')}`), ENV, f)
  assert.equal(bad.status, 400)
  assert.equal(f.calls.length, 0)
})

test('HEAD returns no body; the default export uses the same handler', async () => {
  const f = fakeFetch(() => new Response('body', { status: 200, headers: { 'content-type': 'application/pdf' } }))
  const res = await handle(new Request(`${HOST}/files/job-pdfs/a.pdf`, { method: 'HEAD' }), ENV, f)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '')
  assert.equal(typeof worker.fetch, 'function')
  const nf = await worker.fetch(new Request(`${HOST}/nothing`), ENV)
  assert.equal(nf.status, 404)
})
