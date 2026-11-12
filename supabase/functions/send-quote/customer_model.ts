// deno-lint-ignore-file no-explicit-any
// Customer 3D view, stage E1 (director's ruling 6, 12 Nov 2026).
//
// GET send-quote/model?token=<share_token> answers the hosted customer 3D page
// (quote-3d.html, published beside the live scoping tool) with the model of the
// sealed revision the customer's quote was SENT as. No sign-in: the quote
// link's own token is the only key, as for View Your Quote.
//
// The chain, never the job's latest revision (a later draft must not be shown):
//   job_documents (share_token, sent, type quote)
//     -> its release: quote_revision_id (the B1 link /send writes), or, for a
//        fence runs send, metadata.released_quote_revision_id (stamped below)
//     -> quote_revisions (sent, same job) -> scope_revision_id
//     -> scope_revisions (same job, frozen or superseded) -> revision_number
//     -> scope_artifacts customer_model (first saved) -> private bucket bytes.
//
// Answers: 200 { rev_label, model }; 404 no model (or no such quote); 410
// { current: true } when the quote was replaced; 503 when a read failed. The
// model is copied through an allow-list of its geometry keys, so no price,
// name, address or product code can ride along. Cache-Control: no-store, and
// cross-site reads only from the hosted page's own origin.
//
// The quote email's third button (customerModelEmailBlock) is shown only when
// the released revision has a model. No em dashes in customer text.

type Row = Record<string, any>

export const CUSTOMER_3D_PAGE_DEFAULT_URL = 'https://marninms98-dotcom.github.io/patio/scope-engine/quote-3d.html'
// GitHub Pages hosts the scoping tools are published on (ghl-proxy/scope_engine_links.ts).
const CUSTOMER_3D_PAGE_HOSTS = new Set(['marninms98-dotcom.github.io', 'secureworks-group.github.io'])

/** The hosted customer 3D page: CUSTOMER_3D_PAGE_URL when it is an https address on a tool host, else the default. */
export function customer3dPageUrl(raw: string | null | undefined): string {
  const value = String(raw || '').trim()
  if (value) {
    try {
      const u = new URL(value)
      if (u.protocol === 'https:' && CUSTOMER_3D_PAGE_HOSTS.has(u.hostname) && !u.search && !u.hash) return u.href
    } catch (_e) { /* fall through */ }
  }
  return CUSTOMER_3D_PAGE_DEFAULT_URL
}

/** The one origin allowed to read the model cross-site: the hosted page's own. */
export function customer3dPageOrigin(pageUrl: string): string {
  return new URL(pageUrl).origin
}

/** The customer's 3D link: the hosted page with the same token as View Your Quote. */
export function customer3dLink(pageUrl: string, shareToken: string): string {
  const u = new URL(pageUrl)
  u.searchParams.set('token', shareToken)
  return u.href
}

export function customerModelHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  }
}

export type CustomerModelAnswer =
  | { status: 200; body: { rev_label: string; model: Record<string, unknown> } }
  | { status: 404; body: { error: 'not_available' } }
  | { status: 410; body: { current: true } }
  | { status: 503; body: { error: 'try_again' } }

const NOT_AVAILABLE: CustomerModelAnswer = { status: 404, body: { error: 'not_available' } }
const REPLACED: CustomerModelAnswer = { status: 410, body: { current: true } }
const TRY_AGAIN: CustomerModelAnswer = { status: 503, body: { error: 'try_again' } }

const RUNS_RELEASE_VIA = 'send-quote/send-runs'
const RELEASE_STAMP_KEY = 'released_quote_revision_id'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The model's own keys (scope-engine-v2 patio/scoper/src/present/model.ts
// CustomerModel, less `revision`, the revision id customerCopy strips). A key
// the tool adds later is dropped here until it is listed: geometry only.
const MODEL_KEYS = [
  'what', 'notes', 'shapes', 'surfaces', 'pieces', 'subject', 'house', 'houseWalls', 'houseContext',
  'houseStandIn', 'contextNote', 'front', 'ground', 'start', 'views', 'frontClearMm', 'runs',
] as const

// A price or an email address anywhere in the model's text. (No phone pattern:
// long decimals in the geometry would read as one.)
const MONEY_RE = /\$\s?\d/
const EMAIL_RE = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i

/**
 * The model as the customer may see it: the allow-listed geometry keys only,
 * Colorbond codes taken off surface looks (colour:XYZ -> colour:), and null
 * when it is not a patio or fence model or its text carries a price or an
 * email address.
 */
export function customerSafeModel(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const src = raw as Row
  if (src.what !== 'patio' && src.what !== 'fence') return null
  const out: Record<string, unknown> = {}
  for (const key of MODEL_KEYS) if (key in src) out[key] = src[key]
  if (Array.isArray(out.surfaces)) {
    out.surfaces = (out.surfaces as unknown[]).map((s) => {
      if (s && typeof s === 'object' && typeof (s as Row).look === 'string' && (s as Row).look.startsWith('colour:')) {
        return { ...(s as Row), look: 'colour:' }
      }
      return s
    })
  }
  const text = JSON.stringify(out)
  if (MONEY_RE.test(text) || EMAIL_RE.test(text)) return null
  return out
}

/** The first customer_model saved on a scope revision, null when none, 'error' when the read failed. */
export async function scopeRevisionCustomerModel(sb: any, scopeRevisionId: string): Promise<Row | null | 'error'> {
  try {
    const { data, error } = await sb.from('scope_artifacts')
      .select('id, bucket_id, storage_path, sha256, content_type')
      .eq('scope_revision_id', scopeRevisionId)
      .eq('artifact_type', 'customer_model')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(1)
    if (error || !Array.isArray(data)) return 'error'
    return data[0] ?? null
  } catch (_e) {
    return 'error'
  }
}

/** Whether a send's sealed revision has a customer model. A failed read is no button. */
export async function scopeRevisionHasCustomerModel(sb: any, scopeRevisionId: string | null | undefined): Promise<boolean> {
  if (!scopeRevisionId) return false
  const row = await scopeRevisionCustomerModel(sb, scopeRevisionId)
  return !!row && row !== 'error'
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The customer model for a quote link's token (see the chain at the top). Never throws. */
export async function readCustomerModelForToken(sb: any, token: string | null | undefined): Promise<CustomerModelAnswer> {
  const tok = String(token || '').trim()
  if (!tok) return NOT_AVAILABLE
  try {
    const docs = await sb.from('job_documents')
      .select('id, job_id, quote_revision_id, superseded_at, metadata')
      .eq('share_token', tok)
      .eq('sent_to_client', true)
      .eq('type', 'quote')
      .limit(2)
    if (docs.error || !Array.isArray(docs.data)) return TRY_AGAIN
    const rows = docs.data as Row[]
    if (!rows.length) return NOT_AVAILABLE
    const current = rows.filter((r) => r.superseded_at == null)
    if (!current.length) return REPLACED
    if (current.length > 1) return NOT_AVAILABLE
    const doc = current[0]

    // The release this document was sent as.
    const linked = typeof doc.quote_revision_id === 'string' && doc.quote_revision_id ? doc.quote_revision_id : null
    const stamped = !linked && doc.metadata && typeof doc.metadata === 'object' && typeof doc.metadata[RELEASE_STAMP_KEY] === 'string' &&
        UUID_RE.test(doc.metadata[RELEASE_STAMP_KEY])
      ? doc.metadata[RELEASE_STAMP_KEY] as string
      : null
    const releaseId = linked ?? stamped
    if (!releaseId) return NOT_AVAILABLE

    const rel = await sb.from('quote_revisions')
      .select('id, job_id, job_document_id, sent_at, scope_revision_id, released_via')
      .eq('id', releaseId)
      .maybeSingle()
    if (rel.error) return TRY_AGAIN
    const release = rel.data as Row | null
    if (!release || release.job_id !== doc.job_id || release.sent_at == null) return NOT_AVAILABLE
    // B1 links only a release made for this very document; a runs stamp only a runs release.
    if (linked && release.job_document_id !== doc.id) return NOT_AVAILABLE
    if (stamped && release.released_via !== RUNS_RELEASE_VIA) return NOT_AVAILABLE
    if (typeof release.scope_revision_id !== 'string' || !release.scope_revision_id) return NOT_AVAILABLE

    const sr = await sb.from('scope_revisions')
      .select('id, job_id, revision_number, status')
      .eq('id', release.scope_revision_id)
      .maybeSingle()
    if (sr.error) return TRY_AGAIN
    const revision = sr.data as Row | null
    if (!revision || revision.job_id !== doc.job_id || !['frozen', 'superseded'].includes(revision.status)) return NOT_AVAILABLE

    const artifact = await scopeRevisionCustomerModel(sb, revision.id)
    if (artifact === 'error') return TRY_AGAIN
    if (!artifact || artifact.content_type !== 'application/json') return NOT_AVAILABLE

    const dl = await sb.storage.from(artifact.bucket_id || 'scope-artifacts').download(artifact.storage_path)
    if (dl.error || !dl.data) return TRY_AGAIN
    const bytes = new Uint8Array(await dl.data.arrayBuffer())
    if ((await sha256Hex(bytes)) !== artifact.sha256) {
      console.error('[send-quote/model] stored model does not match its recorded hash', JSON.stringify({ artifact_id: artifact.id }))
      return NOT_AVAILABLE
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch (_e) {
      return NOT_AVAILABLE
    }
    const model = customerSafeModel(parsed)
    if (!model) {
      console.error('[send-quote/model] stored model refused for the customer', JSON.stringify({ artifact_id: artifact.id }))
      return NOT_AVAILABLE
    }
    const n = Number(revision.revision_number)
    return { status: 200, body: { rev_label: Number.isInteger(n) && n > 0 ? `Rev ${n}` : 'Rev', model } }
  } catch (e: any) {
    console.error('[send-quote/model] read failed', e?.message ?? String(e))
    return TRY_AGAIN
  }
}

/** The whole model route: GET (and its preflight) with the restricted cross-site headers. */
export async function handleCustomerModelRequest(req: Request, sb: any, pageUrl: string): Promise<Response> {
  const headers = customerModelHeaders(customer3dPageOrigin(pageUrl))
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers })
  const answer = await readCustomerModelForToken(sb, new URL(req.url).searchParams.get('token'))
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers })
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The quote email's third, quieter button. Empty when there is no link. */
export function customerModelEmailBlock(opts: { what: 'patio' | 'fence'; url: string | null | undefined }): string {
  if (!opts.url) return ''
  const what = opts.what === 'fence' ? 'fence' : 'patio'
  const href = escapeHtml(opts.url)
  return `
      <!-- 3D view (quieter) -->
      <p style="color:#4C6A7C;font-size:14px;line-height:1.6;margin:8px 0 8px;text-align:center;">
        We have also drawn your ${what} in 3D from this quote. Turn it round and zoom in on your phone.
      </p>
      <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
        <tr><td style="border:1px solid #293C46;border-radius:8px;">
          <a href="${href}" style="display:inline-block;padding:10px 24px;color:#293C46;text-decoration:none;font-size:14px;font-weight:600;">
            See your ${what} in 3D
          </a>
        </td></tr>
      </table>`
}

/** The model's word for a job: a fencing job is a fence, everything else the patio page. */
export function customerModelWhat(jobType: string | null | undefined): 'patio' | 'fence' {
  return jobType === 'fencing' ? 'fence' : 'patio'
}

/**
 * A fence runs send records one release for the whole call, bound to its first
 * client document, so the other run documents (and every neighbour's) name no
 * release. When that email carried the 3D button, each document of the call is
 * stamped with the call's release (metadata.released_quote_revision_id) so its
 * own token reaches the model. A stamp already set is never moved. Never throws
 * and never changes the send; a failed stamp only leaves that link "not available".
 */
export async function stampRunDocumentsRelease(
  sb: any,
  documentIds: string[],
  releaseId: string,
  ctx: { job_id: string },
): Promise<void> {
  for (const id of [...new Set(documentIds.filter((d) => typeof d === 'string' && d))]) {
    try {
      const { data, error } = await sb.from('job_documents').select('id, metadata').eq('id', id).maybeSingle()
      if (error || !data) {
        console.error('[send-quote/model-stamp-skip]', JSON.stringify({ job_id: ctx.job_id, document_id: id, reason: error ? 'read_failed' : 'missing' }))
        continue
      }
      const meta = data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata) ? data.metadata as Row : {}
      if (meta[RELEASE_STAMP_KEY]) continue
      const { error: upErr } = await sb.from('job_documents')
        .update({ metadata: { ...meta, [RELEASE_STAMP_KEY]: releaseId } })
        .eq('id', id)
      if (upErr) console.error('[send-quote/model-stamp-fail]', JSON.stringify({ job_id: ctx.job_id, document_id: id, error: upErr.message ?? String(upErr) }))
    } catch (e: any) {
      console.error('[send-quote/model-stamp-fail]', JSON.stringify({ job_id: ctx.job_id, document_id: id, error: e?.message ?? String(e) }))
    }
  }
}
