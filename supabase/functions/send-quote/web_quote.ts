// The customer quote's web page (director's ruling 18 G, 16 Nov 2026).
//
// Ruling 4: a quote's html_url is kept only when its web page is confirmed uploaded. prepare_quote names the web
// page's place before the scoping tool uploads it; webPageSaved() is asked at the send, before the email, and a page
// that is not there is cleared from the document, so no link (the view redirect, the options list) points at a page
// that was never saved.
//
// Ruling 5: send-quote's own quote page (the fallback, and every quote with options) gets the look of the fence web
// quote: the blurred, dimmed photo backdrop with the navy scrim, and the glass bar at the foot with "Ready to get
// started?", Download PDF and Accept. The bar adds no price, cost, margin or supplier.

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
export const WEB_BAR_WORDS = Object.freeze({ ready: 'Ready to get started?', pdf: 'Download PDF', accept: 'Accept quote' })

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The backdrop and bar's style: the fence web quote's look, with the bar full width on a phone. */
export const WEB_LOOK_CSS = [
  'body.sw-web{background:#0a1217!important;padding-bottom:110px}',
  '.sw-web-bg{position:fixed;inset:-24px;z-index:-2;background:#0a1217 center/cover no-repeat;filter:blur(9px) brightness(.36) saturate(.7)}',
  '.sw-web-scrim{position:fixed;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(18,30,40,.77) 0%,rgba(9,16,21,.89) 100%);pointer-events:none}',
  'body.sw-web .topbar{background:rgba(22,36,43,.82);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}',
  'body.sw-web .actions-card,body.sw-web .card,body.sw-web .contact-card,body.sw-web .pdf-mobile-card{background:rgba(41,60,70,.88)}',
  '.sw-web-bar{position:fixed;left:0;right:0;bottom:0;z-index:900;padding:0 0 20px;pointer-events:none}',
  '.sw-web-bar-in{pointer-events:auto;margin:0 auto;width:max-content;max-width:calc(100% - 40px);display:flex;align-items:center;gap:14px;background:rgba(22,36,43,.92);'
    + '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.14);border-left:4px solid #F15A29;padding:12px 14px 12px 22px;'
    + 'box-shadow:0 18px 40px rgba(0,0,0,.45);box-sizing:border-box}',
  '.sw-web-msg{font-size:13px;font-weight:700;color:#fff;letter-spacing:.2px;white-space:nowrap;margin-right:4px}',
  '.sw-web-ghost{display:inline-flex;align-items:center;gap:7px;text-decoration:none;color:#E7EDF1;font-size:12px;font-weight:700;letter-spacing:.4px;padding:11px 16px;'
    + 'border:1px solid rgba(255,255,255,.28);border-radius:2px;white-space:nowrap;background:transparent;font-family:inherit;cursor:pointer}',
  '.sw-web-ghost::before{content:"\\2193";font-size:13px;line-height:1}',
  '.sw-web-accept{display:inline-flex;align-items:center;gap:9px;background:linear-gradient(180deg,#FF6A3A 0%,#F15A29 58%,#E5501F 100%);color:#fff;border:none;'
    + 'font-family:inherit;font-size:12.5px;font-weight:800;letter-spacing:1px;text-transform:uppercase;padding:13px 24px;cursor:pointer;white-space:nowrap}',
  '.sw-web-accept::after{content:"\\2192";font-size:14px;line-height:1}',
  '@media (hover:hover) and (pointer:fine){.sw-web-ghost:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.5);color:#fff}'
    + '.sw-web-accept:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(241,90,41,.5)}}',
  '@media (max-width:820px){body.sw-web{padding-bottom:84px}.sw-web-bar{padding:0}'
    + '.sw-web-bar-in{width:100%;max-width:none;border-left:0;border-top:3px solid #F15A29;justify-content:center;gap:8px;padding:10px 10px calc(10px + env(safe-area-inset-bottom))}'
    + '.sw-web-msg{display:none}.sw-web-ghost{padding:11px 12px}.sw-web-accept{padding:13px 16px}}',
  '@media print{.sw-web-bar,.sw-web-bg,.sw-web-scrim{display:none!important}}',
].join('')

/**
 * The backdrop (first in the body) and the bar (last). `photo`: the quote's own picture for the backdrop, a customer
 * address or null (the plain dark backdrop). `pdf`: the PDF's customer address, or null (no Download PDF). `accept`:
 * the page's own accept call (the confirm and any ticked options stay the page's), or null once accepted or declined.
 */
export function webLook(o: { photo: string | null; pdf: string | null; accept: string | null }): { backdrop: string; bar: string } {
  const photo = o.photo && /^(?:\/|https:\/\/)[^"'()\\\s]+$/.test(o.photo) ? o.photo : null
  const backdrop = `<div class="sw-web-bg" aria-hidden="true"${photo ? ` style="background-image:url('${esc(photo)}')"` : ''}></div><div class="sw-web-scrim" aria-hidden="true"></div>`
  const btn = (o.pdf ? `<a class="sw-web-ghost" href="${esc(o.pdf)}" target="_blank" rel="noopener" download>${WEB_BAR_WORDS.pdf}</a>` : '')
    + (o.accept ? `<button type="button" class="sw-web-accept" onclick="${esc(o.accept)}">${WEB_BAR_WORDS.accept}</button>` : '')
  const bar = btn ? `<div class="sw-web-bar" data-sw-web-bar><div class="sw-web-bar-in"><span class="sw-web-msg">${WEB_BAR_WORDS.ready}</span>${btn}</div></div>` : ''
  return { backdrop, bar }
}
