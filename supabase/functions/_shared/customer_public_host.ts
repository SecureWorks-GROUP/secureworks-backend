// Customer quote links on the company's own address (Marnin, 16 Nov 2026:
// "we dont want them to check our github", "i want the web address to be
// somewhere else").
//
// One setting, CUSTOMER_PUBLIC_HOST (for example https://quote.secureworksgroup.app).
// Unset, or not a bare https origin: every helper here returns today's address
// exactly, so this is safe to merge before the domain answers. Set: every link a
// customer sees is built on that host with the path map the Cloudflare worker
// in cloudflare/quote-proxy/ serves:
//   /q/<route>                send-quote/<route> (customer routes only)
//   /files/<bucket>/<path>    storage/v1/object/public/<bucket>/<path> (read only)
//   /view?src=<our /files>    the quote viewer shell (today on pages.dev)
//   /3d/patio|fence/<file>    the customer 3D page (today on GitHub Pages)
// Links already in customers' inboxes keep working: the old addresses still answer.
// cloudflare/quote-proxy/test/roundtrip_test.ts proves both sides agree.

/** send-quote routes a customer uses. Staff routes (send, send-runs, send-invoice, status, ...) are never on the public host. */
export const CUSTOMER_QUOTE_ROUTES = ['view', 'accept', 'decline', 'payment-confirmed', 'upload-plans', 'model'] as const

/** Public storage buckets a customer link may name: the quote PDF and web quote, and the viewer's page copies. */
export const CUSTOMER_FILE_BUCKETS = ['job-pdfs', 'quote-views'] as const

/** The address customer pages called before the setting (kept byte for byte when unset). */
export const LEGACY_PAGE_SEND_QUOTE_BASE = 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/send-quote/'

/** The setting as an origin (https://host), or null when unset or not a bare https origin. */
export function customerPublicHost(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  try {
    const u = new URL(value.includes('://') ? value : `https://${value}`)
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
    if (u.pathname !== '/' || u.search || u.hash) return null
    return u.origin
  } catch (_e) {
    return null
  }
}

/** True when the setting has a value that customerPublicHost refuses (worth a log line). */
export function customerPublicHostInvalid(raw: string | null | undefined): boolean {
  return String(raw ?? '').trim() !== '' && customerPublicHost(raw) === null
}

const isRoute = (s: string) => (CUSTOMER_QUOTE_ROUTES as readonly string[]).includes(s)
const isBucket = (s: string) => (CUSTOMER_FILE_BUCKETS as readonly string[]).includes(s)
const isSupabaseHost = (hostname: string) => hostname.endsWith('.supabase.co') || hostname.endsWith('.supabase.in')

/**
 * A send-quote or public-storage address as the customer should see it.
 * Unset host, or an address outside the map: returned unchanged.
 */
export function customerUrl<T extends string | null | undefined>(url: T, host: string | null): T {
  if (!host || !url) return url
  let u: URL
  try { u = new URL(url) } catch (_e) { return url }
  if (u.protocol !== 'https:' || !isSupabaseHost(u.hostname)) return url
  const fn = u.pathname.match(/^\/functions\/v1\/send-quote\/([^/]+)$/)
  if (fn && isRoute(fn[1])) return `${host}/q/${fn[1]}${u.search}${u.hash}` as T
  const file = u.pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/)
  if (file && isBucket(file[1])) return `${host}/files/${file[1]}/${file[2]}${u.search}${u.hash}` as T
  return url
}

/** A send-quote customer route: `${base}/functions/v1/send-quote/<route>` today, `${host}/q/<route>` when set. */
export function customerSendQuoteUrl(host: string | null, unsetBase: string, route: typeof CUSTOMER_QUOTE_ROUTES[number]): string {
  return host ? `${host}/q/${route}` : `${unsetBase}/functions/v1/send-quote/${route}`
}

/**
 * The viewer shell with its src. Set: /view on our host with src on /files.
 * When src cannot be put on our host, today's viewer is kept so the link still opens
 * (the worker's /view refuses any src that is not its own /files).
 */
export function customerViewerUrl(viewerBase: string, src: string, host: string | null): string {
  const legacy = `${viewerBase}?src=${encodeURIComponent(src)}`
  if (!host) return legacy
  const mapped = customerUrl(src, host)
  if (!mapped.startsWith(`${host}/files/`)) return legacy
  return `${host}/view?src=${encodeURIComponent(mapped)}`
}

/** The base customer pages' own scripts call send-quote on (accept, decline, upload-plans). */
export function customerPageSendQuoteBase(host: string | null): string {
  return host ? `${host}/q/` : LEGACY_PAGE_SEND_QUOTE_BASE
}

/** Where the "I've paid" prompt posts. Today a relative address (resolved against the viewer shell). */
export function customerPaymentConfirmPostUrl(host: string | null, token: string): string {
  const rel = `payment-confirmed?token=${encodeURIComponent(token)}`
  return host ? `${host}/q/${rel}` : rel
}

/** The variation email's View & Respond link. */
export function customerVariationLink(host: string | null, shareToken: string): string {
  return host
    ? `${host}/q/view?token=${shareToken}&type=variation`
    : `https://secureworks-group.github.io/secureworks-ux/quote-viewer.html?token=${shareToken}&type=variation`
}
