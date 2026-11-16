// deno-lint-ignore-file no-import-prefix no-explicit-any
// Ruling 18 G (4): the web page kept only when confirmed uploaded. Ruling 19 addendum A: send-quote's own quote page
// has the one look (the gum-tree photo under the blue wash, the white logo, page cards, the glass bar), and never a PDF
// in a frame: a quote with options shows its saved web page's own pages inline (3a); otherwise the PDF's pages are
// drawn as pictures, or a clean card with Download PDF (3b).
// Run: deno test --allow-read --allow-env supabase/functions/send-quote/web_quote_test.ts (no network: fetch is stubbed).
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  ACCEPT_HELD_WORDS,
  ACCEPT_SETTLE_MS,
  acceptHeldScript,
  BACKDROP_DATA_URI,
  cutSavedWebPages,
  LOGO_SVG,
  LOOK,
  PDF_READY_WORDS,
  pdfPagesHtml,
  PDFJS,
  quoteLinkState,
  quoteLinkStateAnswer,
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
const { _buildClientPageForTest: buildClientPage, buildNextStepsPage, buildQuoteEmail } = await import('./index.ts')
const { quotePhone, QUOTE_PHONES } = await import('./division_routing.ts')

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
  assert(WEB_LOOK_CSS.includes(`body.sw-web .sw-web-bg{position:fixed;inset:-12px;z-index:0;background:#12202c url('${BACKDROP_DATA_URI}') center/cover no-repeat;filter:blur(2px) brightness(.92) saturate(1.05)}`))
  assert(WEB_LOOK_CSS.includes('background:linear-gradient(180deg,rgba(22,44,64,.60) 0%,rgba(16,33,49,.72) 55%,rgba(10,22,34,.84) 100%)'))
  assert(WEB_LOOK_CSS.includes('body.sw-web{background:#12202c!important;padding:40px 0 120px!important;margin:0!important;min-height:100vh}'))
  assert(WEB_LOOK_CSS.includes('margin:0 auto 30px!important;position:relative;z-index:1;border-radius:4px;overflow:hidden;box-shadow:0 24px 70px rgba(8,16,22,.55),0 0 0 1px rgba(255,255,255,.06)!important'))
  assert(/\.sw-web-bar-in\{[^}]*background:rgba\(16,33,49,\.74\);[^}]*blur\(14px\) saturate\(1\.2\)[^}]*border:1px solid rgba\(255,255,255,\.16\);border-left:4px solid #F15A29;border-radius:6px;[^}]*box-shadow:0 18px 40px rgba\(8,16,22,\.45\)/.test(WEB_LOOK_CSS))
  assert(/@media \(max-width:820px\)\{body\.sw-web\{padding:0 0 84px!important\}[^@]*margin:0 auto 10px!important;border-radius:0\}[^@]*\.sw-web-bar-in\{width:100%;max-width:none;border-left:0;border-radius:0;border-top:3px solid #F15A29/.test(WEB_LOOK_CSS), 'docked full width on a phone')
  assert(WEB_LOOK_CSS.includes('@media print{.sw-web-bar,.sw-web-bg,.sw-web-scrim,.sw-web-head{display:none!important}body.sw-web{background:#fff!important;padding:0!important}}'))
  assertEquals(LOOK.glass, 'rgba(16,33,49,.74)')
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
  assert(page.indexOf('.zz-quote-style{') < page.indexOf('body.sw-web{background:#12202c'), 'before the look, so the look wins')
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
    assert(page.includes('dpr=Math.max(2,Math.min(window.devicePixelRatio||1,3))') && page.includes('page.getViewport({scale:w/one.width*dpr})'), 'each page drawn at the screen\'s pixel ratio, at least 2x, so the words are sharp on a desktop (director 16:16)')
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
    assert(page.includes('body.sw-web .actions-card,body.sw-web .card,body.sw-web .opt-card,body.sw-web .contact-card,body.sw-web .decline-form,body.sw-web .sw-status,body.sw-web .confirm-box{background:rgba(16,33,49,.74);border-radius:6px;-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);border:1px solid rgba(255,255,255,.16);'))
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

// The saved web page's Accept (money14's review of scope-engine-v2 PR 1295, finding 2): a lost or unclear reply is never
// read as a no. The page reads the quote's state on its link before it offers Accept again.
Deno.test('state: accepted, declined, replaced (or not found) and open, from the quote\'s own row', () => {
  assertEquals(quoteLinkState({ accepted_at: '2026-11-16T09:00:00Z', declined_at: null, superseded_at: null }), 'accepted')
  assertEquals(quoteLinkState({ accepted_at: null, declined_at: '2026-11-16T09:00:00Z' }), 'declined')
  assertEquals(quoteLinkState({ superseded_at: '2026-11-16T09:00:00Z' }), 'gone')
  assertEquals(quoteLinkState(null), 'gone')
  assertEquals(quoteLinkState({ accepted_at: null, declined_at: null, superseded_at: null }), 'open')
  // Accepted wins over replaced: a quote accepted before a newer one was sent still reads accepted.
  assertEquals(quoteLinkState({ accepted_at: '2026-11-16T09:00:00Z', superseded_at: '2026-11-16T10:00:00Z' }), 'accepted')
})

Deno.test('state: a read that fails is 503 with no state (the page then keeps Accept off), never "open"', async () => {
  const seen: string[] = []
  const ok = await quoteLinkStateAnswer('0f3c2a1b-zztest', (t) => { seen.push(t); return Promise.resolve({ data: { accepted_at: null }, error: null }) })
  assertEquals(ok, { status: 200, body: { state: 'open' } })
  assertEquals(seen, ['0f3c2a1b-zztest'])
  assertEquals(await quoteLinkStateAnswer('0f3c2a1b-zztest', () => Promise.resolve({ data: null, error: { message: 'zz' } })), { status: 503, body: { state: null } })
  assertEquals(await quoteLinkStateAnswer('0f3c2a1b-zztest', () => Promise.reject(new Error('zz'))), { status: 503, body: { state: null } })
  assertEquals(await quoteLinkStateAnswer(null, () => { throw new Error('never read') }), { status: 200, body: { state: 'gone' } })
  assertEquals(await quoteLinkStateAnswer('x"><b>', () => { throw new Error('never read') }), { status: 200, body: { state: 'gone' } })
})

Deno.test('wiring: view?state=1 answers the state before any view is counted, reading the quote by its link only', () => {
  const view = src.slice(src.indexOf("if (path === 'view' && req.method === 'GET') {"))
  const state = view.indexOf("if (url.searchParams.get('state') === '1') {"), counted = view.indexOf('// Track views (first view sets viewed_at)')
  assert(state > 0 && counted > state, 'the state read comes before the view is counted')
  const block = view.slice(state, view.indexOf('if (!token) return await htmlResponse(errorPage', state))
  assert(block.includes(".select('accepted_at, declined_at, superseded_at')") && block.includes(".eq('share_token', t)") && block.includes(".eq('sent_to_client', true)") && block.includes(".eq('type', 'quote')"))
  assert(block.includes("return jsonResponse(answer.body, answer.status, { ...corsHeaders, 'Cache-Control': 'no-store' })"))
  assert(!/\.update\(|\.insert\(/.test(block), 'a read only')
})

Deno.test('next steps: the acceptance page works where only its own script may run: no inline handlers', () => {
  const page: string = buildNextStepsPage({ clientName: 'ZZTEST Scope Checker', projectType: 'patio', address: 'ZZTEST 1 Test Lab Way', depositAmount: 100, depositDescription: 'ZZTEST deposit',
    paymentUrl: '', invoiceNumber: 'ZZ-INV-1', shareToken: '0f3c2a1b-zztest', isPatio: true, jobId: 'zz-job' })
  assert(page.includes('id="planUploadArea"'), 'the plan upload is on this page')
  assertEquals(page.match(/\son[a-z]+\s*=\s*["']/gi) ?? [], [], 'no inline handler')
  assert(!/javascript:/i.test(page))
  for (const ev of ["area.addEventListener('click'", "area.addEventListener('dragover'", "area.addEventListener('dragleave'", "area.addEventListener('drop'", "input.addEventListener('change'"]) assert(page.includes(ev), ev)
})

// ── Director 18:59 (scope-engine-v2 PR 1295, money14's recheck): an Accept reply lost, cut off or a server fault ──
// The client page's own script, run against a stand-in page and send-quote on a clock its waits move. After such a reply
// the page never offers Accept again in that visit, whatever the state reads; "Check again" only reads; no failure words.
type Post = Response | 'lost' | 'pending' | 'cut'
const FENCE_TOKEN = '0f3c2a1b-zztest'
const clientScript = (type = 'fencing') => {
  const d = { id: 'zz-doc', share_token: FENCE_TOKEN, quote_number: 'ZZQ-0959', pdf_url: null, accepted_at: null, declined_at: null, jobs: { type, client_name: 'ZZTEST' }, data_snapshot_json: {} }
  const page: string = buildClientPage(d, FENCE_TOKEN, null, null, null, null)
  return { page, code: [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('respondToQuote'))! }
}
async function visit(o: { state: () => string | null; post: (s: { now: number; commitAt: number | null }) => Post; again?: boolean; later?: number; check?: boolean; type?: string; fault?: (c: string) => string }) {
  const real = clientScript(o.type).code
  const code = o.fault ? o.fault(real) : real
  if (o.fault && code === real) throw new Error('planted fault did not apply')
  const s = { now: 0, commitAt: null as number | null, committed: false, posts: 0, reads: 0, reloads: 0, alerts: [] as string[], said: [] as string[], written: null as string | null }
  const ids: Record<string, any> = {}
  const mk = (tag: string): any => {
    const e: any = { tag, children: [] as any[], style: {}, attrs: {} as Record<string, string>, hidden: false, disabled: false, on: {} as Record<string, () => void>, _t: '',
      appendChild(c: any) { this.children.push(c); if (c.id) ids[c.id] = c; for (const k of c.children) if (k.id) ids[k.id] = k; return c },
      setAttribute(k: string, v: string) { this.attrs[k] = v }, addEventListener(k: string, f: () => void) { this.on[k] = f }, remove() { if (this.id) delete ids[this.id] } }
    Object.defineProperty(e, 'textContent', { get() { return e._t }, set(v: string) { e._t = v; if (e.id === 'swHeldText') s.said.push(v) } })
    return e
  }
  const accepts = [mk('button'), mk('button')]
  const msgs = [mk('span')]
  const document: any = {
    body: mk('body'), head: mk('head'),
    getElementById: (id: string) => ids[id] ?? null,
    createElement: (tag: string) => mk(tag),
    querySelectorAll: (q: string) => (q === '.btn-accept,.sw-web-accept' ? accepts : q === '.sw-web-msg' ? msgs : []),
    querySelector: () => null,
    open() { s.written = '' }, write(h: string) { s.written += h }, close() {},
  }
  document.body.appendChild = function (c: any) { if (c.id) ids[c.id] = c; for (const k of c.children) if (k.id) ids[k.id] = k; return c }
  const fetchStub = (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') {
      s.posts++
      const r = o.post(s)
      if (r === 'lost') return Promise.reject(new TypeError('Failed to fetch'))
      if (r === 'pending') { s.commitAt = s.now + ACCEPT_SETTLE_MS + 2000; return Promise.reject(new TypeError('Failed to fetch')) }
      if (r === 'cut') { s.committed = true; return Promise.resolve({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: () => Promise.reject(new TypeError('network error')) }) }
      return Promise.resolve(r)
    }
    s.reads++
    if (url !== `https://quote.secureworksgroup.app/q/view?token=${FENCE_TOKEN}&state=1` && !url.endsWith(`view?token=${FENCE_TOKEN}&state=1`)) throw new Error('unexpected read ' + url)
    const st = o.state()
    const taken = s.committed || (s.commitAt !== null && s.now >= s.commitAt)
    return Promise.resolve(new Response(JSON.stringify({ state: st === null ? undefined : (taken && st === 'open' ? 'accepted' : st) }), { status: st === null ? 503 : 200 }))
  }
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1)) }
  const run = new Function('document', 'fetch', 'alert', 'confirm', 'setTimeout', 'location', 'window', code + ';return { respondToQuote: respondToQuote };')
  const page = run(document, fetchStub, (m: string) => { s.alerts.push(m) }, () => true, (f: () => void, ms: number) => { s.now += ms; setTimeout(f, 0) }, { reload() { s.reloads++ } }, { location: { reload() { s.reloads++ } } })
  await page.respondToQuote('accept_confirmed'); await settle()
  const afterRead = { said: ids.swHeldText?.textContent ?? null, offered: accepts.some((a) => !a.disabled || !a.hidden), check: !!ids.swHeldCheck && !ids.swHeldCheck.hidden }
  if (o.again) { await page.respondToQuote('accept'); await page.respondToQuote('accept_confirmed'); await settle() }
  if (o.later) s.now += o.later
  if (o.check && ids.swHeldCheck) { ids.swHeldCheck.on.click(); await settle() }
  return { s, accepts, msgs, ids, afterRead }
}
const FAILURE = /did not|not reach|try again|failed|went wrong|unsuccessful/i
const held = (phone: string) => ACCEPT_HELD_WORDS.held + ' ' + ACCEPT_HELD_WORDS.callUs.replace('{phone}', phone)
const FAULTS: Record<string, (c: string) => string> = {
  'the reviewed behaviour: a lost reply alerts a failure and Accept stays on offer': (c) => c.replace("if (action === 'accept') { swHoldAccept(); return; }", ''),
  'Accept offered again when the read shows open': (c) => c.replace('swHeldSay(SW_HELD.held+" "+SW_HELD.callUs.split("{phone}").join(SW_PHONE));', 'swHeld=false;document.querySelectorAll(".btn-accept,.sw-web-accept").forEach(function(x){x.disabled=false;x.hidden=false;});'),
  'a second press sends again': (c) => c.replace("if ((action === 'accept' || action === 'accept_confirmed') && swAcceptHeld()) return;", ''),
  '"Check again" sends the acceptance again': (c) => c.replace('if(!b.disabled)swHeldLook();', 'fetch("zz-accept",{method:"POST"}).catch(function(){});swHeldLook();'),
  'the bar still says "Ready to get started?" beside the checking words': (c) => c.replace('document.querySelectorAll(".sw-web-msg").forEach(function(x){x.hidden=true;x.style.display="none";});', ''),
  'a server fault alerts a failure': (c) => c.replace("} else if (action === 'accept' && res.status >= 500) {\n          swHoldAccept();\n        }", '}'),
}
async function caught(o: Parameters<typeof visit>[0], pass: (r: Awaited<ReturnType<typeof visit>>) => boolean, faults: string[]) {
  const r = await visit(o)
  assert(pass(r), JSON.stringify({ posts: r.s.posts, reads: r.s.reads, reloads: r.s.reloads, alerts: r.s.alerts, said: r.s.said, afterRead: r.afterRead }))
  for (const f of faults) assert(!pass(await visit({ ...o, fault: FAULTS[f] })), 'planted fault not caught: ' + f)
}
const noFailure = (r: Awaited<ReturnType<typeof visit>>) => !r.s.alerts.length && !r.s.said.some((x) => FAILURE.test(x))
// Accept off for the visit, and the bar's "Ready to get started?" gone beside the checking words (director 21:02).
const neverOffered = (r: Awaited<ReturnType<typeof visit>>) => r.accepts.every((a) => a.disabled && a.hidden) && r.msgs.every((m) => m.hidden && m.style.display === 'none')

Deno.test('accept held: the words are the director\'s (18:59), the same as the scoping tools\' web quote, no long dashes', () => {
  assertEquals(ACCEPT_HELD_WORDS.held, 'We are checking your acceptance. Please do not press Accept again.')
  assertEquals(ACCEPT_HELD_WORDS.callUs, 'If this is still here in a few minutes, call us on {phone} and we will confirm it for you.')
  assert(!/—/.test(JSON.stringify(ACCEPT_HELD_WORDS)))
  assert(acceptHeldScript({ stateUrl: 'x</script>', phone: '1' }).includes('x\\u003c/script>'), 'its values cannot end the script')
})
Deno.test('accept held: money14\'s delayed acceptance (taken after the wait): open read, Accept never offered, the fence phone; a second press sends nothing; Check again later shows it accepted; one POST, no failure words', async () => {
  await caught({ state: () => 'open', post: () => 'pending', again: true, later: 3000, check: true },
    (r) => r.s.posts === 1 && r.afterRead.said === held('0489 267 772') && !r.afterRead.offered && r.afterRead.check && r.s.reloads === 1 && noFailure(r) && neverOffered(r),
    ['the reviewed behaviour: a lost reply alerts a failure and Accept stays on offer', 'Accept offered again when the read shows open', 'a second press sends again', '"Check again" sends the acceptance again', 'the bar still says "Ready to get started?" beside the checking words'])
})
Deno.test('accept held: a lost reply with nothing taken: the state reads open, Accept is still never offered again in this visit', async () => {
  await caught({ state: () => 'open', post: () => 'lost', again: true, type: 'patio' },
    (r) => r.s.posts === 1 && neverOffered(r) && r.afterRead.said === held('0489 267 774') && noFailure(r),
    ['the reviewed behaviour: a lost reply alerts a failure and Accept stays on offer', 'Accept offered again when the read shows open', 'a second press sends again'])
})
Deno.test('accept held: a server fault (5xx) is an outcome not known: no failure alert, Accept off, held', async () => {
  await caught({ state: () => 'open', post: () => new Response('<html><body>zz</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }) },
    (r) => r.s.posts === 1 && neverOffered(r) && r.afterRead.said === held('0489 267 772') && noFailure(r) && r.s.written === null,
    ['a server fault alerts a failure'])
})
Deno.test('accept held: a success reply cut off part way: held, then the read shows accepted and the link\'s page loads again', async () => {
  const r = await visit({ state: () => 'open', post: () => 'cut' })
  assert(r.s.written === null && r.s.reloads === 1 && r.s.said[0] === ACCEPT_HELD_WORDS.held && noFailure(r))
})
Deno.test('accept held: a state that cannot be read keeps held and the call-us line; Check again only reads', async () => {
  await caught({ state: () => null, post: () => 'lost', check: true },
    (r) => r.s.posts === 1 && r.s.reads === 2 && neverOffered(r) && r.ids.swHeldText.textContent === held('0489 267 772') && r.s.reloads === 0,
    ['"Check again" sends the acceptance again'])
})
Deno.test('accept held: a quote no longer open says so; a refusal (4xx) is still send-quote\'s own answer', async () => {
  let r = await visit({ state: () => 'gone', post: () => 'lost' })
  assert(r.ids.swHeldText.textContent === ACCEPT_HELD_WORDS.gone && r.ids.swHeldCheck.hidden && neverOffered(r))
  r = await visit({ state: () => 'open', post: () => new Response(JSON.stringify({ error: 'Tick the options again' }), { status: 400, headers: { 'content-type': 'application/json' } }) })
  assert(r.s.alerts[0] === 'Tick the options again' && !r.ids.swHeld, 'a 4xx refusal is shown as send-quote words it, and is not held')
})
Deno.test('accept held: send-quote\'s acceptance page (2xx HTML) is still shown in place', async () => {
  const r = await visit({ state: () => 'open', post: () => new Response('<html><body>Next steps</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) })
  assert(r.s.written === '<html><body>Next steps</body></html>' && !r.ids.swHeld)
})
Deno.test('accept held: the page keeps nothing between visits, so a fresh load of the link offers Accept as normal', () => {
  const { page, code } = clientScript()
  assert(!/localStorage|sessionStorage|document\.cookie|indexedDB/.test(code))
  assert(page.includes('class="sw-web-accept"') && page.includes(".sw-held{"), 'the bar Accept is there on load, and the held box has its look')
  assert(page.includes('.sw-held .sw-held-check::before{content:none}') && acceptHeldScript({ stateUrl: 'x', phone: '1' }).includes('className="sw-web-ghost sw-held-check"'), '"Check again" has no download arrow')
})

// ── The line a customer calls about the quote (director 21:01) and zoom on a phone (director 21:02) ──

const NUMBERS = /(?:\+?61\s?|0)489\s?267\s?(\d{3})/g
const linesOn = (html: string) => [...new Set([...html.matchAll(NUMBERS)].map((m) => '0489 267 ' + m[1]))].sort()
const quoteDocs = (type: string) => {
  const d = doc({ jobs: { client_name: 'ZZTEST Scope Checker', type } })
  return {
    'quote page': build(d, null, null),
    'quote page with options': build(d, OFFER, cutSavedWebPages(savedPage(PATIO_PAGES))),
    'Accept checking box': acceptHeldScript({ stateUrl: 'x', phone: quotePhone(type) }),
    'quote email': buildQuoteEmail({ clientName: 'ZZTEST', viewUrl: 'https://view.invalid', pdfUrl: '', projectType: type, suburb: 'Testville', customMessage: '', scoperName: 'ZZTEST' }) as string,
    'acceptance page': buildNextStepsPage({ clientName: 'ZZTEST', projectType: type, address: 'ZZTEST 1 Test Lab Way', depositAmount: 100, depositDescription: 'ZZTEST deposit', paymentUrl: '', invoiceNumber: 'ZZ-INV-1', shareToken: 'zz', isPatio: type === 'patio', jobId: 'zz-job' }) as string,
  }
}
Deno.test('quote phone: a patio customer reads 0489 267 774 and a fence customer 0489 267 772 on the quote page, its messages and the quote email, never two numbers for one trade', () => {
  assertEquals(QUOTE_PHONES, { patio: '0489 267 774', fencing: '0489 267 772', other: '0489 267 771' })
  for (const [type, want] of [['patio', '0489 267 774'], ['fencing', '0489 267 772']]) {
    const seen = new Set<string>()
    for (const [what, html] of Object.entries(quoteDocs(type))) {
      const on = linesOn(html)
      assert(on.length <= 1 && on.every((n) => n === want), `${type} ${what}: ${on.join(', ')}`)
      on.forEach((n) => seen.add(n))
    }
    assertEquals([...seen], [want], `${type}: one number across the quote's pages`)
  }
})
Deno.test('quote phone: read from one place: the quote pages and quote email name no number of their own and never the invoice email\'s division phone', () => {
  const block = src.slice(src.indexOf('export function buildQuoteEmail('), src.indexOf('export function buildInvoiceEmail('))
  assert(block.length > 10000 && block.includes('quotePhoneHref('), 'the quote block')
  assert(!block.includes('getDivisionPhone'), 'no division phone in the quote block')
  assertEquals(block.match(/(?:\+?61\s?|0)489\s?267\s?\d{3}/g) ?? [], [], 'no number written in the quote block')
})

/** What would stop a customer pinching or double-tapping to zoom: a viewport that fixes the scale, or a touch-action other than auto. */
function zoomBlocked(html: string): string[] {
  const why: string[] = []
  const metas = [...html.matchAll(/<meta\b[^>]*name=["']viewport["'][^>]*>/gi)].map((m) => m[0])
  if (metas.length !== 1) why.push(`${metas.length} viewport tags`)
  for (const m of metas) {
    const content = (/content=["']([^"']*)["']/i.exec(m)?.[1] ?? '').toLowerCase().replace(/\s+/g, '')
    if (/user-scalable=(no|0)/.test(content)) why.push('user-scalable=no')
    const max = /maximum-scale=([\d.]+)/.exec(content)
    if (max && Number(max[1]) < 5) why.push('maximum-scale=' + max[1])
  }
  for (const m of html.matchAll(/touch-action\s*:\s*([a-z- ]+)/gi)) if (m[1].trim() !== 'auto') why.push('touch-action:' + m[1].trim())
  if (/\.preventDefault\(\)[^;]*;?[^}]*(?:touchstart|gesturestart|dblclick)|(?:touchstart|gesturestart|dblclick)[^}]*preventDefault/i.test(html)) why.push('a touch handler that cancels zoom')
  return why
}
Deno.test('zoom: on a phone the customer can pinch and double-tap to zoom every quote page (director 21:02)', () => {
  for (const type of ['patio', 'fencing']) {
    const pages = quoteDocs(type)
    for (const what of ['quote page', 'quote page with options', 'acceptance page'] as const) assertEquals(zoomBlocked(pages[what]), [], `${type} ${what}`)
    assertEquals(zoomBlocked(build(doc({ jobs: { client_name: 'ZZTEST', type }, html_url: null }), null, null)), [], `${type} quote page drawn from the PDF`)
  }
  assertEquals(zoomBlocked(WEB_LOOK_CSS + '<meta name="viewport" content="width=device-width">'), [], 'the look itself')
  const page = quoteDocs('patio')['quote page']
  for (const [fault, html] of [
    ['user-scalable=no', page.replace(/(<meta name="viewport" content=")/, '$1user-scalable=no,')],
    ['maximum-scale=1', page.replace(/(<meta name="viewport" content=")/, '$1maximum-scale=1,')],
    ['touch-action:manipulation (no double-tap zoom)', page.replace('</style>', '.pg{touch-action:manipulation}</style>')],
    ['touch-action:pan-x pan-y (no pinch)', page.replace('</style>', 'body{touch-action:pan-x pan-y}</style>')],
  ]) assert(zoomBlocked(html).length > 0, 'the check catches ' + fault)
})

