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
// model is rebuilt from its declared geometry at every level (customerSafeModel),
// so no note, price, name, address, token or product code can ride along, and
// a model of any other shape is refused. Cache-Control: no-store, and
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

// The model as the tool declares it (scope-engine-v2 patio/scoper/src/present/
// model.ts CustomerModel). The public route rebuilds it from scratch, field by
// field and type by type, at every level: `revision` and `notes` are never
// copied, an unknown key at any depth is dropped, and a field of the wrong type
// refuses the whole model. No stored text is passed through: view keys, view
// labels and the house note are rebuilt from the tool's own closed lists below,
// and anything not on them is dropped, so no price, name, address, token or
// product code can ride along, however the stored bytes were made.

type Num = number
const isNum = (v: unknown): v is Num => typeof v === 'number' && Number.isFinite(v)
const MAX_NUMBERS = 2_000_000
const MAX_ITEMS = 100_000

class Refused extends Error {}
const refuse = (): never => { throw new Refused() }

function obj(v: unknown): Row {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Row : refuse()
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) && v.length <= MAX_ITEMS ? v : refuse()
}
function nums(v: unknown, len?: number): Num[] {
  if (!Array.isArray(v) || v.length > MAX_NUMBERS || (len !== undefined && v.length !== len)) refuse()
  const a = v as unknown[]
  return a.map((x) => (isNum(x) ? x : refuse()))
}
function numsOrNull(v: unknown, len?: number): Num[] | null {
  return v === null ? null : nums(v, len)
}
function num(v: unknown): Num {
  return isNum(v) ? v : refuse()
}
function bool(v: unknown): boolean {
  return typeof v === 'boolean' ? v : refuse()
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : refuse()
}

// The tool's closed lists (scope-engine-v2 at 4f3c8f72, PR 1219's merge):
// - the opening view: key 'start', label `Your ${what}`
//   (patio/scoper/src/present/model.ts:156, fencemodel3d.ts:85);
// - the set views and their labels (patio/scoper/src/present/shots.ts:146-160,
//   FRAME_VIEW 'frame' at shots.ts:30; the fence's extra 'yard' view at
//   fencemodel3d.ts:91). 'under' is 'Wall fixing (cutaway)' when it carries the
//   cutaway mark (model.ts:157), else 'Standing under it'.
// A label is never read from the stored bytes: it is rebuilt from the key.
// A view whose key is not on the list is dropped.
const VIEW_LABELS: Record<string, string> = {
  front: 'Straight on',
  along: 'Along the fence',
  back: 'From next door',
  above: 'From above',
  yard: 'From the yard',
  frame: 'The frame, before the roof',
  side: 'From the side',
}
const viewLabel = (key: string, cutaway: boolean): string | null =>
  key === 'under' ? (cutaway ? 'Wall fixing (cutaway)' : 'Standing under it') : VIEW_LABELS[key] ?? null

// The house note: exactly one of housePictureNote's four texts
// (patio/scoper/src/present/connection-view.ts:45-46), else dropped.
const HOUSE_NOTE_BASE = [
  'House edges use the configured heights; the house outline remains indicative.',
  'The house and surroundings are indicative.',
]
const HOUSE_NOTE_CUTAWAY = ' Wall fixing shown in cutaway; anchor heads, washers and order lengths are to confirm.'
const HOUSE_NOTES = new Set(HOUSE_NOTE_BASE.flatMap((n) => [n, n + HOUSE_NOTE_CUTAWAY]))

const LOOK_RE = /^(lawn|(finish|context):[a-z-]{1,32})$/
const COLOR_RE = /^#[0-9a-f]{6}$/i

function camera(s: Row): Row {
  return { eye: nums(s.eye, 3), at: nums(s.at, 3), fov: num(s.fov) }
}

function startView(v: unknown, what: 'patio' | 'fence'): Row {
  const s = obj(v)
  if (s.key !== 'start') refuse()
  return { key: 'start', label: `Your ${what}`, ...camera(s) }
}

/** A set view rebuilt from its key, or null (dropped) when the key is not on the list. */
function setView(v: unknown): Row | null {
  const s = obj(v)
  if (s.cutaway !== undefined && s.cutaway !== true) refuse()
  const cutaway = s.cutaway === true
  const label = typeof s.key === 'string' ? viewLabel(s.key, cutaway) : null
  if (label === null) return null
  return { key: s.key, label, ...camera(s), ...(cutaway ? { cutaway: true } : {}) }
}

function shape(v: unknown): Row {
  const s = obj(v)
  if (s.kind === 'run') {
    return { kind: 'run', outer: nums(s.outer), holes: list(s.holes).map((h) => nums(h)), length: num(s.length) }
  }
  if (s.kind === 'mesh') return { kind: 'mesh', position: nums(s.position), uv: numsOrNull(s.uv) }
  return refuse()
}

function surface(v: unknown): Row {
  const s = obj(v)
  const look = typeof s.look === 'string' ? s.look : refuse()
  return {
    // Colorbond codes come off (colour:XYZ -> colour:); any other look the
    // page does not know is blanked rather than passed through.
    look: look.startsWith('colour:') ? 'colour:' : LOOK_RE.test(look) ? look : '',
    color: typeof s.color === 'string' && COLOR_RE.test(s.color) ? s.color : refuse(),
    roughness: num(s.roughness),
    metalness: num(s.metalness),
    clearcoat: num(s.clearcoat),
    clearcoatRoughness: num(s.clearcoatRoughness),
    doubleSided: bool(s.doubleSided),
    lawn: bool(s.lawn),
  }
}

function piece(v: unknown, shapeCount: number, surfaceCount: number): Row {
  const s = obj(v)
  const index = (x: unknown, n: number) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) < n ? x as number : refuse())
  const out: Row = {
    shape: index(s.shape, shapeCount),
    surface: index(s.surface, surfaceCount),
    matrix: nums(s.matrix, 16),
    clip: nums(s.clip),
    notches: nums(s.notches),
  }
  if (s.roof !== undefined) out.roof = s.roof === true ? true : refuse()
  if (s.wallConnection !== undefined) out.wallConnection = oneOf(s.wallConnection, ['member', 'anchor'] as const)
  return out
}

/**
 * The model as the customer may see it: a fresh copy of the declared geometry
 * only (see above), Colorbond codes taken off surface looks, and null when it
 * is not a patio or fence model of the declared shape.
 */
export function customerSafeModel(raw: unknown): Record<string, unknown> | null {
  try {
    const src = obj(raw)
    const what = oneOf(src.what, ['patio', 'fence'] as const)
    const shapes = list(src.shapes).map(shape)
    const surfaces = list(src.surfaces).map(surface)
    const out: Record<string, unknown> = {
      what,
      shapes,
      surfaces,
      pieces: list(src.pieces).map((p) => piece(p, shapes.length, surfaces.length)),
      subject: nums(src.subject, 6),
      house: numsOrNull(src.house, 6),
      front: nums(src.front),
      ground: numsOrNull(src.ground),
      start: startView(src.start, what),
      views: list(src.views).map(setView).filter((w): w is Row => w !== null),
    }
    if (src.houseWalls !== undefined) {
      out.houseWalls = list(src.houseWalls).map((w) => {
        const s = obj(w)
        return { from: nums(s.from, 3), to: nums(s.to, 3), out: nums(s.out, 3), height: num(s.height) }
      })
    }
    if (src.houseStandIn !== undefined) {
      out.houseStandIn = list(src.houseStandIn).map((w) => {
        const s = obj(w)
        return {
          from: nums(s.from, 3), to: nums(s.to, 3), out: nums(s.out, 3),
          kind: oneOf(s.kind, ['fascia', 'wall'] as const), lowY: num(s.lowY), topY: num(s.topY),
        }
      })
    }
    if (src.houseContext !== undefined) out.houseContext = oneOf(src.houseContext, ['sample', 'configured'] as const)
    if (typeof src.contextNote === 'string' && HOUSE_NOTES.has(src.contextNote)) out.contextNote = src.contextNote
    if (src.frontClearMm !== undefined) out.frontClearMm = src.frontClearMm === null ? null : num(src.frontClearMm)
    if (src.runs !== undefined) {
      out.runs = list(src.runs).map((r) => {
        const s = obj(r)
        const run: Row = { a: nums(s.a), b: nums(s.b), out: nums(s.out) }
        if (s.gaps !== undefined) run.gaps = list(s.gaps).map((g) => nums(g, 2))
        return run
      })
    }
    return out
  } catch (e) {
    if (e instanceof Refused) return null
    throw e
  }
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
 * own token reaches the model.
 *
 * The stamp is set only while absent, as one conditional write: the update
 * matches the row only while its metadata is still exactly what was read (so
 * a key another writer added meanwhile is never lost) and still has no stamp.
 * When it matches nothing, the row is read again: a stamp now present is never
 * moved, whoever set it; otherwise the write is tried again, a few times. Never
 * throws and never changes the send; a failed stamp only leaves that link "not
 * available".
 */
export async function stampRunDocumentsRelease(
  sb: any,
  documentIds: string[],
  releaseId: string,
  ctx: { job_id: string },
): Promise<void> {
  const log = (tag: string, fields: Row) => console.error(`[send-quote/model-stamp-${tag}]`, JSON.stringify({ job_id: ctx.job_id, ...fields }))
  for (const id of [...new Set(documentIds.filter((d) => typeof d === 'string' && d))]) {
    try {
      for (let attempt = 1; ; attempt++) {
        const { data, error } = await sb.from('job_documents').select('id, metadata').eq('id', id).maybeSingle()
        if (error || !data) {
          log('skip', { document_id: id, reason: error ? 'read_failed' : 'missing' })
          break
        }
        const raw = data.metadata ?? null
        if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
          log('skip', { document_id: id, reason: 'metadata_not_an_object' })
          break
        }
        const meta = (raw ?? {}) as Row
        if (meta[RELEASE_STAMP_KEY] != null) {
          if (meta[RELEASE_STAMP_KEY] !== releaseId) log('kept', { document_id: id, reason: 'another_release_already_stamped' })
          break
        }
        let write = sb.from('job_documents')
          .update({ metadata: { ...meta, [RELEASE_STAMP_KEY]: releaseId } })
          .eq('id', id)
          .is(`metadata->>${RELEASE_STAMP_KEY}`, null)
        write = raw === null ? write.is('metadata', null) : write.eq('metadata', JSON.stringify(raw))
        const { data: won, error: upErr } = await write.select('id')
        if (upErr) {
          log('fail', { document_id: id, error: upErr.message ?? String(upErr) })
          break
        }
        if (Array.isArray(won) && won.length > 0) break
        if (attempt >= 3) {
          log('fail', { document_id: id, error: 'metadata kept changing; not stamped' })
          break
        }
      }
    } catch (e: any) {
      log('fail', { document_id: id, error: e?.message ?? String(e) })
    }
  }
}
