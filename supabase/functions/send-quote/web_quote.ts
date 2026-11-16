// The customer quote's web page (director's ruling 18 G, 16 Nov 2026; its look, ruling 19 addendum A).
//
// Ruling 4: a quote's html_url is kept only when its web page is confirmed uploaded. prepare_quote names the web
// page's place before the scoping tool uploads it; webPageSaved() is asked at the send, before the email, and a page
// that is not there is cleared from the document, so no link (the view redirect, the options list) points at a page
// that was never saved.
//
// Ruling 19 addendum A: send-quote's own quote page (every quote with options, and the fallback) has the ONE look the
// scoping tools' web quote has (scope-engine shared/quote/web.js): the gum-tree photo VISIBLE under a translucent
// brand-blue wash, the real white logo, each A4 page a card, the glass bar in the same blue with the orange Accept,
// docked full width on a phone. No PDF in a frame and no scroll box inside the page:
//   a. a quote with options shows its saved web page's own printed pages inline (readSavedWebPages, cutSavedWebPages);
//   b. a quote whose web page did not save, or an older quote with none, draws the PDF's pages one under another as
//      pictures (pdf.js), or a clean card with Download PDF when they cannot be drawn (pdfPagesHtml).
// The page adds only the bar's words: no price, cost, margin or supplier.
import { BACKDROP_DATA_URI } from './backdrop.ts'
import { LOGO_SVG } from './logo.ts'

export { BACKDROP_DATA_URI, LOGO_SVG }

/** Whether the web page at `url` is there: a HEAD answered 2xx within `ms`. Missing, refused or slow is false. */
export async function webPageSaved(url: string | null | undefined, fetchFn: typeof fetch = fetch, ms = 2500): Promise<boolean> {
  if (!url) return false
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const head = await fetchFn(url, { method: 'HEAD', signal: ac.signal })
    return head.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

/** The words the bar adds: the same words as the scoping tools' web quote (shared/quote/web.js in scope-engine-v2). */
/**
 * The quote's state on its link, for the saved web page (money14's review of scope-engine-v2 PR 1295, finding 2): after
 * a lost or unclear Accept reply the page reads this before it offers Accept again, and on opening it shows an accepted,
 * declined or replaced quote instead of Accept. A read only: it counts no view and changes nothing.
 */
export type QuoteLinkState = 'accepted' | 'declined' | 'gone' | 'open'
export interface QuoteStateRow { accepted_at?: string | null; declined_at?: string | null; superseded_at?: string | null }
export function quoteLinkState(row: QuoteStateRow | null | undefined): QuoteLinkState {
  if (!row) return 'gone'
  if (row.accepted_at) return 'accepted'
  if (row.declined_at) return 'declined'
  if (row.superseded_at) return 'gone'
  return 'open'
}
/** The answer to view?token=&state=1: 200 with the state, or 503 with none when the quote cannot be read now. */
export async function quoteLinkStateAnswer(
  token: string | null,
  read: (token: string) => PromiseLike<{ data: QuoteStateRow | null; error: unknown }>,
): Promise<{ status: number; body: { state: QuoteLinkState | null } }> {
  if (!token || !/^[A-Za-z0-9-]{8,}$/.test(token)) return { status: 200, body: { state: 'gone' } }
  try {
    const { data, error } = await read(token)
    if (error) return { status: 503, body: { state: null } }
    return { status: 200, body: { state: quoteLinkState(data) } }
  } catch {
    return { status: 503, body: { state: null } }
  }
}

/**
 * After an Accept reply whose outcome is not known (lost, cut off, or a server fault), director 18:59 on scope-engine-v2
 * PR 1295, the same rule as ruling 18 B: the page never offers Accept again in that visit and never tells it as a
 * failure. The same words as the scoping tools' web quote (shared/quote/web.js STATE_WORDS). `{phone}` is the trade's.
 */
export const ACCEPT_HELD_WORDS = Object.freeze({
  held: 'We are checking your acceptance. Please do not press Accept again.',
  callUs: 'If this is still here in a few minutes, call us on {phone} and we will confirm it for you.',
  gone: 'This quote is no longer open to accept. Please use the newest link we sent you.',
  check: 'Check again',
})
/** How long the page waits before its first read of the quote's state after such a reply (a read, never a resend). */
export const ACCEPT_SETTLE_MS = 4000

/**
 * send-quote's own quote page's script for that case: `swHoldAccept()` takes every Accept off the page for this visit,
 * says `held` with "Check again" (which only reads `stateUrl`, view?token=&state=1), and reads once by itself after
 * ACCEPT_SETTLE_MS. Accepted or declined: the link's own page is loaded again, as the customer sees it on any visit.
 * No longer open: says so. Still open, or not readable: `held` stays and `callUs` is added. `swAcceptHeld()` is true
 * from then on, so a press of Accept does nothing. Nothing is kept: a fresh load of the link is as normal.
 */
export function acceptHeldScript(o: { stateUrl: string; phone: string }): string {
  const J = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c')
  return 'var SW_HELD=' + J(ACCEPT_HELD_WORDS) + ',SW_STATE_URL=' + J(o.stateUrl) + ',SW_PHONE=' + J(o.phone) + ',SW_SETTLE=' + ACCEPT_SETTLE_MS + ',swHeld=false;'
    + 'function swAcceptHeld(){return swHeld;}'
    + 'function swHeldSay(t){var p=document.getElementById("swHeldText");if(p)p.textContent=t;}'
    + 'function swHeldLook(){var b=document.getElementById("swHeldCheck");if(b)b.disabled=true;'
    + 'return fetch(SW_STATE_URL,{cache:"no-store",headers:{Accept:"application/json"}}).then(function(r){return r.ok?r.json():null;}).catch(function(){return null;})'
    + '.then(function(j){if(b)b.disabled=false;var s=j&&typeof j.state==="string"?j.state:null;'
    + 'if(s==="accepted"||s==="declined"){location.reload();return;}'
    + 'if(s==="gone"){swHeldSay(SW_HELD.gone);if(b)b.hidden=true;return;}'
    + 'swHeldSay(SW_HELD.held+" "+SW_HELD.callUs.split("{phone}").join(SW_PHONE));});}'
    + 'function swHoldAccept(){if(swHeld)return;swHeld=true;var po=document.getElementById("processingOverlay");if(po)po.remove();'
    + 'document.querySelectorAll(".btn-accept,.sw-web-accept").forEach(function(x){x.disabled=true;x.hidden=true;x.style.display="none";});'
    // The bar's "Ready to get started?" never stands beside the checking words (director 21:02).
    + 'document.querySelectorAll(".sw-web-msg").forEach(function(x){x.hidden=true;x.style.display="none";});'
    + 'var box=document.createElement("div");box.id="swHeld";box.className="sw-held";box.setAttribute("role","status");box.setAttribute("aria-live","polite");'
    + 'var p=document.createElement("p");p.id="swHeldText";box.appendChild(p);'
    + 'var b=document.createElement("button");b.type="button";b.id="swHeldCheck";b.className="sw-web-ghost sw-held-check";b.textContent=SW_HELD.check;b.addEventListener("click",function(){if(!b.disabled)swHeldLook();});box.appendChild(b);'
    + 'document.body.appendChild(box);swHeldSay(SW_HELD.held);setTimeout(swHeldLook,SW_SETTLE);}'
}
/** The held box's look: the bar's glass and orange edge, above the bar. */
export const ACCEPT_HELD_CSS = '.sw-held{position:fixed;left:50%;transform:translateX(-50%);bottom:96px;z-index:10000;max-width:calc(100% - 32px);width:440px;box-sizing:border-box;'
  + 'background:rgba(16,33,49,.92);border:1px solid rgba(255,255,255,.16);border-left:4px solid #F15A29;border-radius:6px;padding:14px 16px;color:#fff;'
  + 'font-family:"Plus Jakarta Sans",system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.45;box-shadow:0 18px 40px rgba(8,16,22,.45)}'
  + '.sw-held p{margin:0 0 10px}.sw-held button[hidden]{display:none}.sw-held .sw-held-check::before{content:none}'

export const WEB_BAR_WORDS = Object.freeze({ ready: 'Ready to get started?', pdf: 'Download PDF', accept: 'Accept quote' })

/** The words of the clean card shown when the PDF's pages cannot be drawn (or there is no PDF). */
export const PDF_READY_WORDS = Object.freeze({ title: 'Your quote is ready to download.', none: 'PDF not available' })

/** The one look's exact values (q0/look.md; the same values as scope-engine shared/quote/web.js LOOK). */
export const LOOK = Object.freeze({
  base: '#12202c',
  wash: 'linear-gradient(180deg,rgba(22,44,64,.60) 0%,rgba(16,33,49,.72) 55%,rgba(10,22,34,.84) 100%)',
  photo: 'blur(2px) brightness(.92) saturate(1.05)',
  card: '0 24px 70px rgba(8,16,22,.55),0 0 0 1px rgba(255,255,255,.06)',
  glass: 'rgba(16,33,49,.74)',
})

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// A page card: the saved web page's printed pages (patio .pg, fence .pgwrap) and the PDF's drawn pages.
const PAGE_CARDS = 'body.sw-web [data-sw-web-pages] .pg,body.sw-web [data-sw-web-pages] .pgwrap,body.sw-web .sw-pdf-page'
// send-quote's own cards under the pages (options, Accept and Decline, the decline reasons, supporting documents, contact,
// the accepted or declined line) and the accept confirm: glass in the bar's blue, 6 px corners, as wide as the pages.
const OWN_CARDS = 'body.sw-web .actions-card,body.sw-web .card,body.sw-web .opt-card,body.sw-web .contact-card,body.sw-web .decline-form,body.sw-web .sw-status,body.sw-web .confirm-box'
const GLASS_FILTER = '-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);'

/** The look's style for send-quote's own quote page. Written after any saved quote's own style, so it wins. */
export const WEB_LOOK_CSS = [
  `body.sw-web{background:${LOOK.base}!important;padding:40px 0 120px!important;margin:0!important;min-height:100vh}`,
  `body.sw-web .sw-web-bg{position:fixed;inset:-12px;z-index:0;background:${LOOK.base} url('${BACKDROP_DATA_URI}') center/cover no-repeat;filter:${LOOK.photo}}`,
  `body.sw-web .sw-web-scrim{position:fixed;inset:0;z-index:0;pointer-events:none;background:${LOOK.wash}}`,
  'body.sw-web .sw-web-head,body.sw-web [data-sw-web-pages],body.sw-web .sw-pdf-pages,body.sw-web .sw-pdf-ready,body.sw-web .container{position:relative;z-index:1}',
  '.sw-web-head{max-width:794px;margin:0 auto 22px;padding:0 2px;display:flex;align-items:center}',
  '.sw-web-logo{display:block;width:200px;height:33px}.sw-web-logo svg{display:block;width:100%;height:100%}',
  // The saved pages keep the printed quote's own type (its body's), not this page's white text.
  '[data-sw-web-pages]{display:block;color:#000;text-align:left;line-height:1.5;font-family:"Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}',
  `${PAGE_CARDS}{margin:0 auto 30px!important;position:relative;z-index:1;border-radius:4px;overflow:hidden;box-shadow:${LOOK.card}!important}`,
  '.sw-pdf-pages{display:block}.sw-pdf-pages[hidden]{display:none}',
  '.sw-pdf-page{max-width:794px;background:#fff}.sw-pdf-page canvas{display:block;width:100%;height:auto}',
  `.sw-pdf-ready{max-width:794px;margin:0 auto 30px;padding:36px 28px;text-align:center;color:#fff;background:${LOOK.glass};border-radius:4px;${GLASS_FILTER}`
    + `border:1px solid rgba(255,255,255,.16);box-shadow:${LOOK.card};box-sizing:border-box}`,
  '.sw-pdf-ready[hidden]{display:none}',
  '.sw-pdf-ready-t{font-size:17px;font-weight:700;margin-bottom:18px}',
  '.sw-pdf-ready-btn{display:inline-block;background:linear-gradient(180deg,#FF6A3A 0%,#F15A29 58%,#E5501F 100%);color:#fff;text-decoration:none;font-size:13px;font-weight:800;'
    + 'letter-spacing:1px;text-transform:uppercase;padding:14px 26px;border-radius:2px}',
  'body.sw-web .container{max-width:794px;padding:0 0 40px}',
  `${OWN_CARDS}{background:${LOOK.glass};border-radius:6px;${GLASS_FILTER}border:1px solid rgba(255,255,255,.16);box-shadow:${LOOK.card}}`,
  'body.sw-web .container{margin:0 auto}body.sw-web .contact-card a{color:#F15A29}',
  '.sw-web-bar{position:fixed;left:0;right:0;bottom:0;z-index:900;padding:0 0 20px;pointer-events:none}',
  `.sw-web-bar-in{pointer-events:auto;margin:0 auto;width:max-content;max-width:calc(100% - 40px);display:flex;align-items:center;gap:14px;background:${LOOK.glass};`
    + `${GLASS_FILTER}border:1px solid rgba(255,255,255,.16);border-left:4px solid #F15A29;border-radius:6px;`
    + 'padding:12px 14px 12px 22px;box-shadow:0 18px 40px rgba(8,16,22,.45);box-sizing:border-box}',
  '.sw-web-msg{font-size:13px;font-weight:700;color:#fff;letter-spacing:.2px;white-space:nowrap;margin-right:4px}',
  '.sw-web-ghost{display:inline-flex;align-items:center;gap:7px;text-decoration:none;color:#E7EDF1;font-size:12px;font-weight:700;letter-spacing:.4px;padding:11px 16px;'
    + 'border:1px solid rgba(255,255,255,.28);border-radius:2px;white-space:nowrap;background:transparent;font-family:inherit;cursor:pointer}',
  '.sw-web-ghost::before{content:"\\2193";font-size:13px;line-height:1}',
  '.sw-web-accept{display:inline-flex;align-items:center;gap:9px;background:linear-gradient(180deg,#FF6A3A 0%,#F15A29 58%,#E5501F 100%);color:#fff;border:none;'
    + 'font-family:inherit;font-size:12.5px;font-weight:800;letter-spacing:1px;text-transform:uppercase;padding:13px 24px;cursor:pointer;white-space:nowrap}',
  '.sw-web-accept::after{content:"\\2192";font-size:14px;line-height:1}',
  '@media (hover:hover) and (pointer:fine){.sw-web-ghost:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.5);color:#fff}'
    + '.sw-web-accept:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(241,90,41,.5)}}',
  `@media (max-width:820px){body.sw-web{padding:0 0 84px!important}${PAGE_CARDS}{margin:0 auto 10px!important;border-radius:0}`
    + '.sw-web-head{margin:0;padding:14px 16px}.sw-web-logo{width:160px;height:26.4px}.sw-pdf-ready{margin:0 auto 10px;border-radius:0}'
    + 'body.sw-web .container{padding:6px 16px 24px}.sw-web-bar{padding:0}'
    + '.sw-web-bar-in{width:100%;max-width:none;border-left:0;border-radius:0;border-top:3px solid #F15A29;justify-content:center;gap:8px;padding:10px 10px calc(10px + env(safe-area-inset-bottom))}'
    + '.sw-web-msg{display:none}.sw-web-ghost{padding:11px 12px}.sw-web-accept{padding:13px 16px}}',
  '@media print{.sw-web-bar,.sw-web-bg,.sw-web-scrim,.sw-web-head{display:none!important}body.sw-web{background:#fff!important;padding:0!important}}',
].join('')

/**
 * The backdrop and logo (first in the body) and the bar (last). `pdf`: the PDF's customer address, or null (no
 * Download PDF). `accept`: the page's own accept call (the confirm and any ticked options stay the page's), or null
 * once accepted or declined.
 */
export function webLook(o: { pdf: string | null; accept: string | null }): { backdrop: string; header: string; bar: string } {
  const backdrop = '<div class="sw-web-bg" aria-hidden="true"></div><div class="sw-web-scrim" aria-hidden="true"></div>'
  const header = `<header class="sw-web-head"><span class="sw-web-logo" role="img" aria-label="SecureWorks Group">${LOGO_SVG}</span></header>`
  const btn = (o.pdf ? `<a class="sw-web-ghost" href="${esc(o.pdf)}" target="_blank" rel="noopener" download>${WEB_BAR_WORDS.pdf}</a>` : '')
    + (o.accept ? `<button type="button" class="sw-web-accept" onclick="${esc(o.accept)}">${WEB_BAR_WORDS.accept}</button>` : '')
  const bar = btn ? `<div class="sw-web-bar" data-sw-web-bar><div class="sw-web-bar-in"><span class="sw-web-msg">${WEB_BAR_WORDS.ready}</span>${btn}</div></div>` : ''
  return { backdrop, header, bar }
}

// ── a. The saved web page's own pages, inline ──

/** The saved page's printed pages, cut out and checked, with the quote's own style. */
export interface SavedWebPages {
  /** The quote's own <style> blocks (never its <style data-sw-web>) and its Google Fonts stylesheet link. */
  head: string
  /** The saved page's body classes besides sw-web (the fence's "pdf"), for its own style's body selectors. */
  bodyClass: string
  /** The printed pages, exactly as saved between <main data-sw-web-pages> and </main>. */
  pages: string
  /** One A4 page: the patio's .pg or the fence's .pgwrap. */
  selector: '.pg' | '.pgwrap'
}

export const SAVED_PAGE_MS = 4000
export const SAVED_PAGE_MAX_BYTES = 16_000_000
const PAGES_OPEN = '<main data-sw-web-pages>'
const FONT_HOST = /^(?:https?:)?\/\/fonts\.(?:googleapis|gstatic)\.com(?:\/|$)/i
const UNSAFE_CSS = /(?:java|vb)script\s*:|expression\s*\(|-moz-binding|behavior\s*:/i

/**
 * The address send-quote reads the saved web page from: only a public job-pdfs .html object on this project's own
 * storage (`supabaseUrl`), never another host, bucket or path. Anything else is null.
 */
export function savedWebPageAddress(htmlUrl: string | null | undefined, supabaseUrl: string | null | undefined): string | null {
  // Escaped dots or slashes and dot segments are refused as written, before the address is normalised.
  if (/%(?:2e|2f|5c|25)|\\|\/\.{1,2}(?:\/|$)/i.test(String(htmlUrl ?? ''))) return null
  let u: URL, base: URL
  try {
    u = new URL(String(htmlUrl ?? ''))
    base = new URL(String(supabaseUrl ?? ''))
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || base.protocol !== 'https:' || u.origin !== base.origin || u.username || u.password || u.search || u.hash) return null
  const m = /^\/storage\/v1\/object\/public\/job-pdfs\/([A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*\.html)$/.exec(u.pathname)
  if (!m) return null
  return u.href
}

/** Every outside address `text` would load or link to, besides Google Fonts. */
function outsideAddresses(text: string): string[] {
  const out: string[] = []
  const re = /(?:src|srcset|href|action|poster|formaction)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]+)|url\(\s*["']?\s*((?:https?:)?\/\/[^"')\s]+)|@import\s+["']\s*((?:https?:)?\/\/[^"']+)/gi
  for (const m of text.matchAll(re)) {
    const a = m[1] || m[2] || m[3]
    if (!FONT_HOST.test(a)) out.push(a)
  }
  return out
}

/** Whether the cut pages are safe to place in send-quote's page: no script, handler, frame or outside address. */
function safePages(s: string): boolean {
  if (/<\s*\/?\s*(?:script|iframe|frame|frameset|object|embed|applet|base|meta|link|main|form|portal)\b/i.test(s)) return false
  if (/\son[a-z]+\s*=/i.test(s)) return false
  if (/(?:href|action|formaction)\s*=\s*["']?\s*data:(?!image\/(?:png|jpe?g|gif|webp)[;,])/i.test(s)) return false
  if (UNSAFE_CSS.test(s)) return false
  return outsideAddresses(s).length === 0
}

/**
 * Cut the printed pages out of a saved web page (scope-engine shared/quote/web.js page()): what sits between
 * `<main data-sw-web-pages>` and its `</main>`, the quote's own <style> blocks from its <head> except
 * `<style data-sw-web>`, and its Google Fonts link. Null (send-quote draws the PDF instead) when the page is not one
 * of these, or the cut or a style holds a script, an event handler, a frame or an outside address.
 */
export function cutSavedWebPages(html: string | null | undefined): SavedWebPages | null {
  const s = String(html ?? '')
  const headEnd = s.search(/<\/head\s*>/i)
  const body = /<body\b([^>]*)>/i.exec(s)
  if (headEnd < 0 || !body || body.index < headEnd) return null
  const open = s.indexOf(PAGES_OPEN, body.index)
  if (open < 0 || s.indexOf(PAGES_OPEN, open + 1) >= 0) return null
  const close = s.indexOf('</main>', open + PAGES_OPEN.length)
  if (close < 0) return null
  const pages = s.slice(open + PAGES_OPEN.length, close)
  if (!pages.trim() || !safePages(pages)) return null
  const selector = /\bclass="(?:[^"]*\s)?pgwrap(?:\s[^"]*)?"/.test(pages) ? '.pgwrap' : /\bclass="(?:[^"]*\s)?pg(?:\s[^"]*)?"/.test(pages) ? '.pg' : null
  if (!selector) return null

  const head = s.slice(0, headEnd)
  const parts: string[] = []
  for (const link of head.matchAll(/<link\b[^>]*>/gi)) {
    const href = /\bhref\s*=\s*"(https:\/\/fonts\.googleapis\.com\/css2?\?[^"<>]+)"/i.exec(link[0])
    if (href && /\brel\s*=\s*"?stylesheet\b/i.test(link[0])) parts.push(`<link rel="stylesheet" href="${href[1]}">`)
  }
  for (const st of head.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)) {
    if (/\bdata-sw-web\b/i.test(st[1])) continue
    if (UNSAFE_CSS.test(st[2]) || outsideAddresses(st[2]).length) return null
    parts.push(`<style>${st[2]}</style>`)
  }
  const cls = /\bclass\s*=\s*"([^"]*)"/i.exec(body[1])?.[1] ?? ''
  // "web" would switch the fence's own web mode (its own bar and backdrop) on; send-quote's page has its own.
  const bodyClass = cls.split(/\s+/).filter((c) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(c) && c !== 'sw-web' && c !== 'web').join(' ')
  return { head: parts.join('\n'), bodyClass, pages, selector }
}

/**
 * Read the quote's saved web page (its html_url) and cut out its pages: a GET on this project's own storage only,
 * answered 2xx within `ms` and under SAVED_PAGE_MAX_BYTES. Missing, refused, slow, too big or unsafe is null.
 */
export async function readSavedWebPages(
  htmlUrl: string | null | undefined,
  supabaseUrl: string | null | undefined,
  fetchFn: typeof fetch = fetch,
  ms = SAVED_PAGE_MS,
): Promise<SavedWebPages | null> {
  const address = savedWebPageAddress(htmlUrl, supabaseUrl)
  if (!address) return null
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const res = await fetchFn(address, { method: 'GET', signal: ac.signal, redirect: 'manual' })
    if (!res.ok) return null
    if (Number(res.headers.get('content-length') ?? 0) > SAVED_PAGE_MAX_BYTES) return null
    const text = await res.text()
    if (text.length > SAVED_PAGE_MAX_BYTES) return null
    return cutSavedWebPages(text)
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** The saved pages in send-quote's page, scaled to a phone's width as web.js does (zoom = width / 794 below 820 px). */
export function savedPagesHtml(saved: SavedWebPages): string {
  const sel = `[data-sw-web-pages] ${saved.selector}`
  return `<main data-sw-web-pages>${saved.pages}</main>
  <script>(function(){var P=${JSON.stringify(sel)};function fit(){var w=document.documentElement.clientWidth;`
    + 'document.querySelectorAll(P).forEach(function(p){p.style.zoom=w<820?String(w/794):"";});}'
    + 'fit();addEventListener("resize",fit);addEventListener("orientationchange",fit);})();</script>'
}

// ── b. The PDF's pages as pictures ──

/**
 * pdf.js from cdnjs at ONE pinned version, each file with its sha512 (cdnjs's own SRI list). To update: change the
 * version in both URLs and both hashes together, from cdnjs's published SRI values for that version.
 */
export const PDFJS = Object.freeze({
  version: '3.11.174',
  lib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  libIntegrity: 'sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ==',
  worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  workerIntegrity: 'sha512-BbrZ76UNZq5BhH7LL7pn9A4TKQpQeNCHOo65/akfelcIBbcVvYWOFQKPXIrykE3qZxYjmDX573oa4Ywsc7rpTw==',
})

/** How long pdf.js may take to load, and the first page to draw, before the clean Download card shows instead. */
export const PDFJS_LOAD_MS = 15000
export const PDF_FIRST_PAGE_MS = 20000

/**
 * The PDF's pages drawn one under another, each a picture card full width (794 px at most), from the PDF's customer
 * address. The library loads with its integrity hash (async, so the page never waits on it); the worker is fetched,
 * its SHA-512 compared with the pinned value, and only a match is run (from a blob: address). The library blocked,
 * failing its hash, offline or slow, the worker not matching, the PDF not read, or a page not drawn: the clean card
 * with Download PDF, never an empty box. No PDF at all: the card says so.
 */
export function pdfPagesHtml(pdf: string | null): string {
  if (!pdf) return `<div class="sw-pdf-ready"><p class="sw-pdf-ready-t">${PDF_READY_WORDS.none}</p></div>`
  const card = (hidden: boolean) => `<div class="sw-pdf-ready"${hidden ? ' id="swPdfReady" hidden' : ''}><p class="sw-pdf-ready-t">${PDF_READY_WORDS.title}</p>`
    + `<a class="sw-pdf-ready-btn" href="${esc(pdf)}" target="_blank" rel="noopener" download>${WEB_BAR_WORDS.pdf}</a></div>`
  const workerPin = PDFJS.workerIntegrity.slice('sha512-'.length)
  return `<div class="sw-pdf-pages" id="swPdfPages" data-sw-pdf="${esc(pdf)}" aria-label="Your quote"></div>
  ${card(true)}
  <noscript>${card(false)}</noscript>
  <script>(function(){
    var box=document.getElementById('swPdfPages'),ready=document.getElementById('swPdfReady'),done=false,started=false,timer;
    function fail(){if(done)return;done=true;clearTimeout(timer);box.innerHTML='';box.hidden=true;ready.hidden=false;}
    function b64(buf){var a=new Uint8Array(buf),s='';for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s);}
    function draw(doc){
      var chain=Promise.resolve();
      for(var i=1;i<=doc.numPages;i++){(function(n){chain=chain.then(function(){return doc.getPage(n).then(function(page){
        if(done)return;
        var w=Math.min(box.clientWidth||794,794),one=page.getViewport({scale:1}),dpr=Math.max(2,Math.min(window.devicePixelRatio||1,3));
        var vp=page.getViewport({scale:w/one.width*dpr});
        var c=document.createElement('canvas');c.width=Math.floor(vp.width);c.height=Math.floor(vp.height);
        c.setAttribute('role','img');c.setAttribute('aria-label','Quote page '+n);
        var card=document.createElement('div');card.className='sw-pdf-page';card.appendChild(c);box.appendChild(card);
        return page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise.then(function(){clearTimeout(timer);});
      });});})(i);}
      return chain;
    }
    window.swPdfFail=fail;
    window.swPdfStart=function(){
      if(done||started)return;started=true;clearTimeout(timer);
      var lib=window.pdfjsLib;
      if(!lib||!lib.getDocument||!window.crypto||!crypto.subtle||!window.Blob||!window.URL){fail();return;}
      timer=setTimeout(fail,${PDF_FIRST_PAGE_MS});
      fetch(${JSON.stringify(PDFJS.worker)},{mode:'cors',credentials:'omit',referrerPolicy:'no-referrer'})
        .then(function(r){if(!r.ok)throw new Error('worker');return r.arrayBuffer();})
        .then(function(buf){return crypto.subtle.digest('SHA-512',buf).then(function(d){
          if(b64(d)!==${JSON.stringify(workerPin)})throw new Error('worker hash');
          lib.GlobalWorkerOptions.workerSrc=URL.createObjectURL(new Blob([buf],{type:'text/javascript'}));
          return lib.getDocument({url:box.getAttribute('data-sw-pdf')}).promise;
        });})
        .then(draw).then(function(){if(!box.children.length)fail();}).catch(fail);
    };
    timer=setTimeout(fail,${PDFJS_LOAD_MS});
  })();</script>
  <script src="${PDFJS.lib}" integrity="${PDFJS.libIntegrity}" crossorigin="anonymous" referrerpolicy="no-referrer" async onload="swPdfStart()" onerror="swPdfFail()"></script>`
}
