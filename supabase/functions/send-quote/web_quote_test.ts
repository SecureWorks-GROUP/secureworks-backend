// deno-lint-ignore-file no-import-prefix
// Ruling 18 G (4 and 5): the web page kept only when confirmed uploaded, and send-quote's own quote page on the
// fence web quote's backdrop with its floating bar.
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { WEB_BAR_WORDS, WEB_LOOK_CSS, webLook, webPageSaved } from './web_quote.ts'

const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
const HTML = 'https://quote.example.invalid/files/job-pdfs/zz/quote_v1_web.html'
const answer = (status: number) => (() => Promise.resolve(new Response(null, { status }))) as unknown as typeof fetch

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

Deno.test('5: the bar: Ready to get started?, Download PDF on the customer address, Accept through the page\'s own confirm', () => {
  const { backdrop, bar } = webLook({ photo: null, pdf: 'https://quote.example.invalid/files/job-pdfs/zz/q.pdf', accept: "respondToQuote('accept')" })
  assert(backdrop.includes('class="sw-web-bg"') && backdrop.includes('class="sw-web-scrim"') && !backdrop.includes('url('))
  assert(bar.includes(`>${WEB_BAR_WORDS.ready}<`) && bar.includes(`>${WEB_BAR_WORDS.pdf}</a>`) && bar.includes(`>${WEB_BAR_WORDS.accept}</button>`))
  assert(bar.includes('href="https://quote.example.invalid/files/job-pdfs/zz/q.pdf"'))
  assert(bar.includes('onclick="respondToQuote(&#39;accept&#39;)"'))
  const text = bar.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  assertEquals(text, `${WEB_BAR_WORDS.ready} ${WEB_BAR_WORDS.pdf} ${WEB_BAR_WORDS.accept}`, 'the bar adds its own words only: no price, cost or supplier')
})

Deno.test('5: accepted or declined: no Accept; no PDF: no Download; neither: no bar', () => {
  assert(!webLook({ photo: null, pdf: '/files/job-pdfs/a.pdf', accept: null }).bar.includes('sw-web-accept'))
  assert(!webLook({ photo: null, pdf: null, accept: "respondToQuote('accept')" }).bar.includes('sw-web-ghost'))
  assertEquals(webLook({ photo: null, pdf: null, accept: null }).bar, '')
})

Deno.test('5: a backdrop photo only from a plain address; anything that could break out of the style is left off', () => {
  assert(webLook({ photo: '/files/job-pdfs/zz/cover.jpg', pdf: null, accept: null }).backdrop.includes("url('/files/job-pdfs/zz/cover.jpg')"))
  assert(!webLook({ photo: "x') ;}</style><script>", pdf: null, accept: null }).backdrop.includes('url('))
  assert(!webLook({ photo: 'javascript:alert(1)', pdf: null, accept: null }).backdrop.includes('url('))
})

Deno.test('5: send-quote\'s own quote page wears the look: the style, the body class, the backdrop first and the bar last', () => {
  const page = src.slice(src.indexOf('function buildClientPage('), src.indexOf('function buildRunQuotePage('))
  assert(page.includes('${WEB_LOOK_CSS}') && page.includes('<body class="sw-web">'))
  const bd = page.indexOf('${look.backdrop}'), bar = page.indexOf('${look.bar}'), footer = page.indexOf('This quote is valid for 30 days')
  assert(bd > 0 && footer > bd && bar > footer, 'backdrop after <body>, bar after the footer')
  assert(/pdf: doc\.pdf_url \? customerUrl\(doc\.pdf_url, CUSTOMER_HOST\) : null/.test(page), 'Download PDF on the customer address')
  assert(/accept: !isAccepted && !isDeclined \? "respondToQuote\('accept'\)" : null/.test(page), 'Accept only while open, through the page\'s confirm (and its ticked options)')
  assert(/photo: null/.test(page), 'no private or outside picture behind it')
  assert(/blur\(9px\)/.test(WEB_LOOK_CSS) && /max-width:820px/.test(WEB_LOOK_CSS))
})
