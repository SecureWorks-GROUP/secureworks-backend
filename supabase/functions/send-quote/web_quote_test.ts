// deno-lint-ignore-file no-import-prefix no-explicit-any
// Ruling 18 G (4): the web page kept only when confirmed uploaded. Ruling 19 addendum A: send-quote's own quote page
// has the one look (the gum-tree photo under the blue wash, the white logo, page cards, the glass bar), and never a PDF
// in a frame: a quote with options shows its saved web page's own pages inline (3a); otherwise the PDF's pages are
// drawn as pictures, or a clean card with Download PDF (3b).
// Run: deno test --allow-read --allow-env supabase/functions/send-quote/web_quote_test.ts (no network: fetch is stubbed).
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  BACKDROP_DATA_URI,
  cutSavedWebPages,
  LOGO_SVG,
  LOOK,
  PDF_READY_WORDS,
  pdfPagesHtml,
  PDFJS,
  readSavedWebPages,
  SAVED_PAGE_MAX_BYTES,
  savedWebPageAddress,
  WEB_BAR_WORDS,
  WEB_LOOK_CSS,
  webLook,
  webPageSaved,
} from './web_quote.ts'
import type { QuoteOptionsOffer } from './quote_options.ts'

const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
const { _buildClientPageForTest: buildClientPage } = await import('./index.ts')

const PROJECT = 'https://zzproject.supabase.co'
const HTML = `${PROJECT}/storage/v1/object/public/job-pdfs/zz-org/zz-job/quote_v1_web.html`
const PDF = `${PROJECT}/storage/v1/object/public/job-pdfs/zz-org/zz-job/quote_v1_ZZTEST.pdf`
const answer = (status: number) => (() => Promise.resolve(new Response(null, { status }))) as unknown as typeof fetch

// A made-up saved web page in the shape scope-engine shared/quote/web.js page() writes.
const savedPage = (pages: string, o: { style?: string; bodyClass?: string } = {}) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700&display=swap" rel="stylesheet">
<style>:root{--zz-ink:#1A272E}body{background:#E9EDF0;padding:24px 0}.pg{width:794px;height:1123px}.zz-quote-style{color:#123456}${o.style ?? ''}</style>
<style data-sw-web>body.sw-web{background:#0a1217}.zz-old-look{color:red}</style>
</head><body class="${o.bodyClass ?? 'sw-web'}" data-elite data-quote-layout="r11"><div class="sw-web-bg" aria-hidden="true"></div><div class="sw-web-scrim" aria-hidden="true"></div><main data-sw-web-pages>${pages}</main><script>window.zzSavedScript=1</script><div class="sw-web-bar" data-sw-web-bar><div class="sw-web-bar-in">zz</div></div><script>window.zzBarScript=1</script></body></html>`
const PATIO_PAGES = '<div class="pg cover" id="pg1"><img src="data:image/png;base64,iVBORw0KGgo=" alt=""><p class="zz-quote-style">ZZTEST patio page one</p></div>'
  + '<div class="pg" id="pg2"><svg class="map" xmlns="http://www.w3.org/2000/svg"><style>.swl1{fill:#fff}</style><rect width="1" height="1"/></svg><p>ZZTEST page two</p></div>'
const page200 = (body: string, headers: Record<string, string> = {}) => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = ((url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } }))
  }) as unknown as typeof fetch
  return { fn, calls }
}

const OFFER: QuoteOptionsOffer = {
  version: 1,
  sentence: 'Tick any options you want.',
  options: [{
    id: 'zz-opt-1', name: 'ZZTEST downlights', line: 'Four LED downlights', quantity: 4, unit: 'each', sell_ex_gst: 100, gst: 10, sell_inc_gst: 110,
    payer_id: null, goes: 'supplier', cost_ex_gst: null, cost_kind: 'materials', sealed: {},
  }],
  combinations: [
    { option_ids: [], totalExGST: 1000, gst: 100, totalIncGST: 1100, deposit_inc_gst: 110, sealed: {} },
    { option_ids: ['zz-opt-1'], totalExGST: 1100, gst: 110, totalIncGST: 1210, deposit_inc_gst: 121, sealed: {} },
  ],
}
const doc = (o: Record<string, unknown> = {}) => ({
  id: 'zz-doc', job_id: 'zz-job', quote_number: 'ZZQ-0001', share_token: '0f3c2a1b-zztest-share-token',
  pdf_url: PDF, html_url: HTML, accepted_at: null, declined_at: null, data_snapshot_json: { totalIncGST: 1100 },
  jobs: { client_name: 'ZZTEST Scope Checker', type: 'patio' }, job_contacts: null, ...o,
})
const build = (d: any, options: QuoteOptionsOffer | null, saved: any) => buildClientPage(d, d.share_token, null, options, null, saved) as string

// ── 4: the web page kept only when saved ──

Deno.test('4: the web page counts as saved only when it answers 2xx', async () => {
  assertEquals(await webPageSaved(HTML, answer(200)), true)
  assertEquals(await webPageSaved(HTML, answer(404)), false)
  assertEquals(await webPageSaved(HTML, answer(500)), false)
  assertEquals(await webPageSaved(HTML, (() => Promise.reject(new Error('no signal'))) as unknown as typeof fetch), false)
  assertEquals(await webPageSaved(null, answer(200)), false)
})

Deno.test('4: a page that does not answer in time is not saved', async () => {
  const slow = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch
  assertEquals(await webPageSaved(HTML, slow, 20), false)
})

Deno.test('4: the send clears a web page that is not there, before the email, and the view route asks the same', () => {
  const send = src.indexOf("if (path === 'send' && req.method === 'POST')")
  const clear = src.indexOf("if (doc.html_url && !(await webPageSaved(doc.html_url))) {", send)
  const email = src.indexOf("fetch('https://api.resend.com/emails'", send)
  assert(send > 0 && clear > send, 'the send asks whether the web page is there')
  assert(email > clear, 'before the email')
  assert(/update\(\{ html_url: null \}\)\.eq\('id', doc\.id\)/.test(src.slice(clear, clear + 400)), 'and clears it on the document')
  assert(src.includes('if (await webPageSaved(doc.html_url)) {'), 'the view redirect asks the same')
})

// ── 1: the one look ──

Deno.test('A1: the look\'s exact values: the gum-tree photo inlined, the blue wash .58/.70/.82, 4 px cards, the bar glass', () => {
  assert(BACKDROP_DATA_URI.startsWith('data:image/jpeg;base64,'))
  const jpg = Uint8Array.from(atob(BACKDROP_DATA_URI.slice('data:image/jpeg;base64,'.length)), (c) => c.charCodeAt(0))
  assertEquals(jpg.length, 74396, 'the q0/backdrop.jpg bytes')
  assert(jpg[0] === 0xff && jpg[1] === 0xd8 && jpg[jpg.length - 2] === 0xff && jpg[jpg.length - 1] === 0xd9, 'a whole JPEG')
  assert(WEB_LOOK_CSS.includes(`body.sw-web .sw-web-bg{position:fixed;inset:-12px;z-index:0;background:#22323b url('${BACKDROP_DATA_URI}') center/cover no-repeat;filter:blur(2px) brightness(.92) saturate(1.05)}`))
  assert(WEB_LOOK_CSS.includes('background:linear-gradient(180deg,rgba(41,60,70,.58) 0%,rgba(30,46,56,.70) 55%,rgba(22,36,43,.82) 100%)'))
  assert(WEB_LOOK_CSS.includes('body.sw-web{background:#22323b!important;padding:40px 0 120px!important;margin:0!important;min-height:100vh}'))
  assert(WEB_LOOK_CSS.includes('margin:0 auto 30px!important;position:relative;z-index:1;border-radius:4px;overflow:hidden;box-shadow:0 24px 70px rgba(8,16,22,.55),0 0 0 1px rgba(255,255,255,.06)!important'))
  assert(/\.sw-web-bar-in\{[^}]*background:rgba\(30,46,56,\.72\);[^}]*blur\(14px\) saturate\(1\.2\)[^}]*border:1px solid rgba\(255,255,255,\.16\);border-left:4px solid #F15A29;border-radius:6px;[^}]*box-shadow:0 18px 40px rgba\(8,16,22,\.45\)/.test(WEB_LOOK_CSS))
  assert(/@media \(max-width:820px\)\{body\.sw-web\{padding:0 0 84px!important\}[^@]*margin:0 auto 10px!important;border-radius:0\}[^@]*\.sw-web-bar-in\{width:100%;max-width:none;border-left:0;border-radius:0;border-top:3px solid #F15A29/.test(WEB_LOOK_CSS), 'docked full width on a phone')
  assert(WEB_LOOK_CSS.includes('@media print{.sw-web-bar,.sw-web-bg,.sw-web-scrim,.sw-web-head{display:none!important}body.sw-web{background:#fff!important;padding:0!important}}'))
  assertEquals(LOOK.glass, 'rgba(30,46,56,.72)')
  assert(!WEB_LOOK_CSS.includes('#0a1217') && !WEB_LOOK_CSS.includes('blur(9px)'), 'not the near-black of before')
})

Deno.test('A2: the real white logo, never the text-only "SecureWorks Group" strip', () => {
  assert(LOGO_SVG.startsWith('<svg viewBox="0 0 490 79.55" xmlns="http://www.w3.org/2000/svg">') && LOGO_SVG.endsWith('</svg>'))
  assert(LOGO_SVG.includes('.swl1{fill:#fff;}'), 'the white logo')
  for (const page of [build(doc(), OFFER, cutSavedWebPages(savedPage(PATIO_PAGES))), build(doc({ html_url: null }), null, null)]) {
    const head = page.indexOf('<header class="sw-web-head">')
    assert(head > page.indexOf('<body') && page.indexOf(LOGO_SVG, head) > head, 'the logo heads the page')
    assert(!/topbar|mob-brand|pdf-mobile/.test(page), 'no grey text bar or phone-only card')
    assert(!/>\s*SecureWorks\s*(?:<span>)?\s*Group\s*(?:<\/span>)?\s*<\/div>/.test(page), 'no plain text brand strip')
  }
})

// ── 3: no PDF frame anywhere ──

Deno.test('A3: no <iframe>, <embed> or <object> in any case of the page, and no scroll box', () => {
  const saved = cutSavedWebPages(savedPage(PATIO_PAGES))
  const cases = [
    build(doc(), OFFER, saved),
    build(doc(), OFFER, null),
    build(doc({ html_url: null }), null, null),
    build(doc({ accepted_at: '2026-11-16T00:00:00Z' }), null, null),
    build(doc({ declined_at: '2026-11-16T00:00:00Z' }), null, null),
    build(doc({ pdf_url: null, html_url: null }), null, null),
  ]
  for (const page of cases) {
    assert(!/<iframe|<embed|<object/i.test(page))
    assert(!/pdf-frame|#view=Fit|docs\.google\.com\/gview/.test(page))
    assert(!/overflow(?:-y)?:\s*(?:auto|scroll)/.test(page), 'no scroll box inside the page')
  }
  assert(!/<iframe|<embed|<object/i.test(src.slice(src.indexOf('function buildClientPage('), src.indexOf('function buildRunQuotePage('))))
})

// ── 3a: the saved web page's own pages inline ──

Deno.test('3a: the address is only this project\'s job-pdfs .html; anything else is never fetched', async () => {
  assertEquals(savedWebPageAddress(HTML, PROJECT), HTML)
  for (const bad of [
    'https://other.supabase.co/storage/v1/object/public/job-pdfs/zz/q.html',
    `${PROJECT}/storage/v1/object/public/quote-views/zz/q.html`,
    `${PROJECT}/storage/v1/object/public/job-pdfs/zz/q.pdf`,
    `${PROJECT}/storage/v1/object/public/job-pdfs/zz/%2e%2e/q.html`,
    `${PROJECT}/storage/v1/object/public/job-pdfs/zz/q.html?x=1`,
    `http://zzproject.supabase.co/storage/v1/object/public/job-pdfs/zz/q.html`,
    'https://quote.example.invalid/files/job-pdfs/zz/q.html',
  ]) assertEquals(savedWebPageAddress(bad, PROJECT), null, bad)
  const stub = page200(savedPage(PATIO_PAGES))
  assertEquals(await readSavedWebPages('https://evil.example.invalid/job-pdfs/q.html', PROJECT, stub.fn), null)
  assertEquals(stub.calls.length, 0)
})

Deno.test('3a: read with a GET in time; missing, slow or too big is the PDF\'s pages instead', async () => {
  const stub = page200(savedPage(PATIO_PAGES))
  const saved = await readSavedWebPages(HTML, PROJECT, stub.fn)
  assert(saved && saved.selector === '.pg')
  assertEquals(stub.calls[0].url, HTML)
  assertEquals(stub.calls[0].init.method, 'GET')
  assertEquals(await readSavedWebPages(HTML, PROJECT, answer(404)), null)
  const slow = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch
  assertEquals(await readSavedWebPages(HTML, PROJECT, slow, 20), null)
  assertEquals(await readSavedWebPages(HTML, PROJECT, page200('x', { 'content-length': String(SAVED_PAGE_MAX_BYTES + 1) }).fn), null)
})

Deno.test('3a: the options page shows the saved pages inline with the quote\'s own style, no script of its, then options and Accept', async () => {
  const saved = await readSavedWebPages(HTML, PROJECT, page200(savedPage(PATIO_PAGES)).fn)
  assert(saved)
  const page = build(doc(), OFFER, saved)
  const main = page.indexOf('<main data-sw-web-pages>')
  assert(main > 0 && page.indexOf('<main data-sw-web-pages>', main + 1) < 0, 'one set of pages')
  assert(page.includes(`<main data-sw-web-pages>${PATIO_PAGES}</main>`), 'the pages exactly as saved')
  assert(page.includes('.zz-quote-style{color:#123456}'), 'the quote\'s own style')
  assert(page.indexOf('.zz-quote-style{') < page.indexOf('body.sw-web{background:#22323b'), 'before the look, so the look wins')
  assert(page.includes('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700&display=swap">'))
  assert(!page.includes('zz-old-look') && !page.includes('#0a1217'), 'never its <style data-sw-web>')
  assert(!page.includes('zzSavedScript') && !page.includes('zzBarScript'), 'none of its scripts')
  assert(page.includes('var P="[data-sw-web-pages] .pg"') && page.includes('p.style.zoom=w<820?String(w/794):""'), 'A4 pages scaled to a phone as web.js does')
  assert(!page.includes(PDFJS.lib), 'no pdf.js when the pages are there')
  const opts = page.indexOf('id="quoteOptions"'), accept = page.indexOf('<button class="btn btn-accept" onclick="respondToQuote(\'accept\')">Accept Quote</button>')
  assert(opts > main && accept > opts, 'the options card and Accept below the pages')
  assert(page.indexOf('<div class="sw-web-bar" data-sw-web-bar>') > accept, 'the bar last')
  assert(page.includes('onclick="respondToQuote(&#39;accept&#39;)">Accept quote</button>'), 'the bar\'s Accept is the page\'s own confirm with its ticked options')
  assert(page.includes('<body class="sw-web">'))
})

Deno.test('3a: the fence\'s pages (.pgwrap) keep its body class "pdf" but never switch its own web mode on', () => {
  const fence = savedPage('<div id="pg1" class="pgwrap"><section class="page"><p>ZZTEST fence</p></section></div>', { bodyClass: 'sw-web web pdf' })
  const saved = cutSavedWebPages(fence)
  assert(saved)
  assertEquals(saved.selector, '.pgwrap')
  assertEquals(saved.bodyClass, 'pdf')
  const page = build(doc({ jobs: { client_name: 'ZZTEST', type: 'fencing' } }), OFFER, saved)
  assert(page.includes('<body class="sw-web pdf">') && page.includes('var P="[data-sw-web-pages] .pgwrap"'))
})

Deno.test('3a: refused (the PDF\'s pages instead): a script, a handler, a frame, an outside address, an outside style, no wrapper', () => {
  assert(cutSavedWebPages(savedPage(PATIO_PAGES)), 'the plain page is accepted')
  const refused = [
    savedPage(PATIO_PAGES + '<script>alert(1)</script>'),
    savedPage(PATIO_PAGES + '<SCRIPT src="/x.js"></SCRIPT>'),
    savedPage('<div class="pg"><img src="data:image/png;base64,AA==" onerror="alert(1)"></div>'),
    savedPage('<div class="pg"><img src="https://evil.example.invalid/x.png"></div>'),
    savedPage('<div class="pg"><img src="//evil.example.invalid/x.png"></div>'),
    savedPage('<div class="pg"><a href="javascript:alert(1)">x</a></div>'),
    savedPage('<div class="pg"><iframe src="/x"></iframe></div>'),
    savedPage('<div class="pg" style="background:url(https://evil.example.invalid/x.png)"></div>'),
    savedPage(PATIO_PAGES, { style: '.x{background:url("https://evil.example.invalid/x.png")}' }),
    savedPage(PATIO_PAGES, { style: '@import "https://evil.example.invalid/x.css";' }),
    savedPage(PATIO_PAGES).replace('<main data-sw-web-pages>', '<main>'),
    savedPage(PATIO_PAGES).replace('</main>', ''),
    savedPage('<p>no page here</p>'),
    '',
  ]
  for (const html of refused) assertEquals(cutSavedWebPages(html), null, html.slice(-160))
  assert(cutSavedWebPages(savedPage(PATIO_PAGES, { style: '.x{background:url(data:image/png;base64,AA==)}' })), 'inline pictures are fine')
})

// ── 3b: the PDF's pages as pictures ──

Deno.test('3b: no saved pages: pdf.js draws the PDF\'s pages from its customer address; a clean Download card if not', () => {
  for (const page of [build(doc(), OFFER, null), build(doc({ html_url: null }), null, null)]) {
    assert(page.includes(PDF_SCRIPT_TAG), 'pdf.js pinned, with its integrity hash')
    assert(page.includes(`<div class="sw-pdf-pages" id="swPdfPages" data-sw-pdf="${PDF}" aria-label="Your quote"></div>`), 'the per-page container, on the PDF\'s customer address')
    assert(page.includes("card.className='sw-pdf-page'") && page.includes("document.createElement('canvas')"), 'each page a picture card')
    assert(page.includes(`<div class="sw-pdf-ready" id="swPdfReady" hidden><p class="sw-pdf-ready-t">${PDF_READY_WORDS.title}</p><a class="sw-pdf-ready-btn" href="${PDF}" target="_blank" rel="noopener" download>${WEB_BAR_WORDS.pdf}</a></div>`))
    assert(page.includes('<noscript><div class="sw-pdf-ready"><p class="sw-pdf-ready-t">'), 'and without scripts')
    assert(/function fail\(\)\{[^}]*box\.hidden=true;ready\.hidden=false;\}/.test(page) && page.includes('.catch(fail)'), 'any failure shows the card, never an empty box')
    assert(!page.includes('<main data-sw-web-pages>'))
    assert(page.indexOf('<div class="sw-web-bar" data-sw-web-bar>') > page.indexOf('id="swPdfPages"'), 'the same bar')
  }
  const none = build(doc({ pdf_url: null, html_url: null }), null, null)
  assert(none.includes(`<div class="sw-pdf-ready"><p class="sw-pdf-ready-t">${PDF_READY_WORDS.none}</p></div>`) && !none.includes(PDFJS.lib))
})

// The 3b page's own script, run against a stand-in page (no browser, no network): what each failure path shows.
const PDF_SCRIPT_TAG = '<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" '
  + 'integrity="sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ==" '
  + 'crossorigin="anonymous" referrerpolicy="no-referrer" async onload="swPdfStart()" onerror="swPdfFail()"></script>'
function standIn(o: { workerStatus?: number } = {}) {
  const page = pdfPagesHtml(PDF)
  const code = /<script>([\s\S]*?)<\/script>/.exec(page)![1]
  const box = { innerHTML: 'x', hidden: false, children: [] as unknown[], clientWidth: 794, getAttribute: () => PDF, appendChild() {} }
  const ready = { hidden: true }
  const timers: Array<() => void> = []
  const calls = { getDocument: 0, fetched: [] as string[], blobs: 0 }
  const win: any = {
    crypto, Blob, URL,
    pdfjsLib: { GlobalWorkerOptions: {} as Record<string, string>, getDocument: () => { calls.getDocument++; return { promise: new Promise(() => {}) } } },
  }
  const fakeFetch = (url: string) => {
    calls.fetched.push(url)
    return Promise.resolve(new Response('ZZTEST not the worker', { status: o.workerStatus ?? 200 }))
  }
  const FakeBlob = function (this: unknown) { calls.blobs++ } as unknown as typeof Blob
  win.Blob = FakeBlob
  new Function('window', 'document', 'fetch', 'crypto', 'setTimeout', 'clearTimeout', 'URL', 'Blob', 'btoa', code)(
    win, { getElementById: (id: string) => (id === 'swPdfPages' ? box : ready) }, fakeFetch, crypto,
    (fn: () => void) => { timers.push(fn); return timers.length }, () => {}, URL, FakeBlob, btoa)
  return { page, box, ready, timers, calls, win }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

Deno.test('3b: pdf.js and its worker at one pinned version with their sha512 hashes, as named constants', () => {
  assertEquals(PDFJS.version, '3.11.174')
  assertEquals(PDFJS.lib, `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS.version}/pdf.min.js`)
  assertEquals(PDFJS.worker, `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS.version}/pdf.worker.min.js`)
  assertEquals(PDFJS.libIntegrity, 'sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ==')
  assertEquals(PDFJS.workerIntegrity, 'sha512-BbrZ76UNZq5BhH7LL7pn9A4TKQpQeNCHOo65/akfelcIBbcVvYWOFQKPXIrykE3qZxYjmDX573oa4Ywsc7rpTw==')
  const page = pdfPagesHtml(PDF)
  assertEquals(page.split('<script src=').length - 1, 1, 'one library tag')
  assert(page.includes(PDF_SCRIPT_TAG))
  assert(page.includes(`fetch(${JSON.stringify(PDFJS.worker)},{mode:'cors',credentials:'omit',referrerPolicy:'no-referrer'})`))
  assert(page.includes('"BbrZ76UNZq5BhH7LL7pn9A4TKQpQeNCHOo65/akfelcIBbcVvYWOFQKPXIrykE3qZxYjmDX573oa4Ywsc7rpTw=="'), 'the worker pin in the page')
  assert(!/workerSrc\s*=\s*["']https?:/.test(page), 'the worker is never run from its outside address')
})

Deno.test('3b: the worker\'s SHA-512 is compared before any blob is made or pdf.js is run', () => {
  const page = pdfPagesHtml(PDF)
  const digest = page.indexOf("crypto.subtle.digest('SHA-512',buf)")
  const compare = page.indexOf('if(b64(d)!==')
  const blob = page.indexOf("new Blob([buf],{type:'text/javascript'})")
  const run = page.indexOf('lib.getDocument(')
  assert(digest > 0 && compare > digest && blob > compare && run > blob, 'digest, compare, then blob, then pdf.js')
  assert(/if\(b64\(d\)!==[^)]+\)throw new Error\('worker hash'\);/.test(page), 'a mismatch throws to the card')
})

Deno.test('3b: the library failing to load (blocked, bad hash, offline) shows the Download card at once', () => {
  const s = standIn()
  assert(s.ready.hidden && !s.box.hidden, 'nothing shown while loading')
  const onerror = /onerror="([^"]+)"/.exec(s.page)![1]
  new Function('swPdfFail', onerror)(s.win.swPdfFail)
  assertEquals(s.ready.hidden, false, 'the card')
  assertEquals(s.box.hidden, true, 'no empty box')
  assertEquals(s.box.innerHTML, '')
})

Deno.test('3b: the library never answering shows the card on the load timer; a late load then does nothing', async () => {
  const s = standIn()
  assertEquals(s.timers.length, 1)
  s.timers[0]()
  assert(!s.ready.hidden && s.box.hidden)
  s.win.swPdfStart()
  await flush()
  assertEquals(s.calls.fetched.length, 0, 'pdf.js not run after the card')
})

Deno.test('3b: a worker that does not match its hash, or does not answer, never runs: the card instead', async () => {
  for (const o of [{}, { workerStatus: 404 }]) {
    const s = standIn(o)
    s.win.swPdfStart()
    // The digest runs off the main thread: wait for the outcome (up to 3 s), not a fixed number of turns.
    for (let i = 0; i < 300 && s.ready.hidden; i++) await new Promise((r) => setTimeout(r, 10))
    assertEquals(s.calls.fetched, [PDFJS.worker])
    assertEquals(s.calls.blobs, 0, 'no blob made')
    assertEquals(s.calls.getDocument, 0, 'pdf.js not run')
    assertEquals(s.win.pdfjsLib.GlobalWorkerOptions.workerSrc, undefined)
    assert(!s.ready.hidden && s.box.hidden, 'the card')
  }
})

Deno.test('3b: pdf.js missing after the tag loads: the card', () => {
  const s = standIn()
  delete s.win.pdfjsLib
  s.win.swPdfStart()
  assert(!s.ready.hidden && s.box.hidden)
})

Deno.test('3c: the bar: Ready to get started?, Download PDF, Accept through the page\'s own confirm; none once accepted', () => {
  const { backdrop, bar } = webLook({ pdf: 'https://quote.example.invalid/files/job-pdfs/zz/q.pdf', accept: "respondToQuote('accept')" })
  assert(backdrop.includes('class="sw-web-bg"') && backdrop.includes('class="sw-web-scrim"'))
  assert(bar.includes('href="https://quote.example.invalid/files/job-pdfs/zz/q.pdf"') && bar.includes('onclick="respondToQuote(&#39;accept&#39;)"'))
  const text = bar.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  assertEquals(text, `${WEB_BAR_WORDS.ready} ${WEB_BAR_WORDS.pdf} ${WEB_BAR_WORDS.accept}`, 'the bar adds its own words only: no price, cost or supplier')
  assert(!webLook({ pdf: '/files/job-pdfs/a.pdf', accept: null }).bar.includes('sw-web-accept'))
  assert(!webLook({ pdf: null, accept: "respondToQuote('accept')" }).bar.includes('sw-web-ghost'))
  assertEquals(webLook({ pdf: null, accept: null }).bar, '')
  const accepted = build(doc({ accepted_at: '2026-11-16T00:00:00Z' }), null, null)
  assert(accepted.includes('Quote Accepted. Thank you!') && accepted.includes('>Download PDF</a>') && !accepted.includes('class="sw-web-accept"'))
})

Deno.test('A4: the cards under the quote wear the one look: orange Accept, ghost Decline, glass cards, no Apple green', () => {
  const GRAD = 'linear-gradient(180deg,#FF6A3A 0%,#F15A29 58%,#E5501F 100%)'
  const cases = [
    build(doc(), OFFER, cutSavedWebPages(savedPage(PATIO_PAGES))),
    build(doc(), OFFER, null),
    build(doc({ html_url: null }), null, null),
    build(doc({ accepted_at: '2026-11-16T00:00:00Z' }), null, null),
    build(doc({ declined_at: '2026-11-16T00:00:00Z' }), null, null),
  ]
  for (const page of cases) {
    assert(!/#34C759|52,\s*199,\s*89/i.test(page), 'no Apple green anywhere')
    assert(!/#FF6B60/i.test(page), 'no red Decline')
    assert(page.includes(`.btn-accept { background: ${GRAD}; color: #fff; text-transform: uppercase; font-weight: 800; letter-spacing: 1px; border-radius: 2px; }`))
    assert(page.includes('.btn-decline { background: transparent; color: rgba(255,255,255,.75); border: 1px solid rgba(255,255,255,.28); border-radius: 2px; }'))
    assert(page.includes('body.sw-web .actions-card,body.sw-web .card,body.sw-web .opt-card,body.sw-web .contact-card,body.sw-web .decline-form,body.sw-web .sw-status,body.sw-web .confirm-box{background:rgba(30,46,56,.72);border-radius:6px;-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);border:1px solid rgba(255,255,255,.16);'))
    assert(page.includes('body.sw-web .container{max-width:794px;padding:0 0 40px}'), 'as wide as the pages')
    assert(page.includes('body.sw-web .contact-card a{color:#F15A29}'), 'Call Us and Email stay orange')
  }
  const open = cases[0]
  assert(open.includes('<button class="btn btn-accept" onclick="respondToQuote(\'accept\')">Accept Quote</button>'), 'the accept button carries the gradient class')
  assert(open.includes(`border-radius:2px;background:${GRAD};color:#fff;font-size:14px;font-weight:800;letter-spacing:1px;text-transform:uppercase;cursor:pointer;font-family:inherit">Yes, Accept</button>`), 'the confirm\'s Accept too')
  assert(open.includes('.opt-row input { width: 20px; height: 20px; margin-top: 2px; accent-color: #F15A29;'), 'the option ticks in orange')
})

Deno.test('wiring: the view route reads the saved pages only for a quote with options, and passes them to the page', () => {
  assert(src.includes('const savedPages = viewOptions && doc.html_url ? await readSavedWebPages(doc.html_url, SUPABASE_URL) : null'))
  assert(src.includes('return await htmlResponse(buildClientPage(doc, token, heroUrl, viewOptions, acceptWords, savedPages))'))
  const page = src.slice(src.indexOf('function buildClientPage('), src.indexOf('function buildRunQuotePage('))
  assert(page.includes('${WEB_LOOK_CSS}') && page.includes('const quotePages = saved ? savedPagesHtml(saved) : pdfPagesHtml(pdfAddress)'))
  assert(/const pdfAddress = doc\.pdf_url \? customerUrl\(doc\.pdf_url, CUSTOMER_HOST\) : null/.test(page), 'the PDF on its customer address')
  assert(/accept: !isAccepted && !isDeclined \? "respondToQuote\('accept'\)" : null/.test(page))
})
