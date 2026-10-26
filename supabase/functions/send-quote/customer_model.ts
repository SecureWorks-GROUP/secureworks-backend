// Customer 3D page (26 Oct 2026, flag customer_3d_page_v1, off).
//
// The patio scoping tool stores the customer's 3D model (geometry and colours only:
// no prices, product names, part ids or customer details) as a `customer_model`
// scope artefact on each frozen revision, in the private scope-artifacts bucket.
// This module finds it for the holder of a quote's share_token, so the quote link
// is the only key: no second customer token, nothing public.
//
//   GET send-quote/3d?token=     302 to the static viewer page, or a plain "not available" page
//   GET send-quote/model?token=  the model as JSON, read by that viewer page
//
// Which model: the job's current frozen scope revision (status 'frozen', newest
// revision_number); a superseded revision is never served. Off, missing or
// unreadable flag, a retired or unsent quote, no frozen revision or no model: not
// available. A read failure is `unavailable`, never an empty model.

import { isFlagOn } from '../_shared/evidence/feature_flag.ts'

export const CUSTOMER_3D_FLAG = 'customer_3d_page_v1' as const
export const CUSTOMER_MODEL_ARTIFACT = 'customer_model'
const BUCKET = 'scope-artifacts'
const MAX_MODEL_BYTES = 2 * 1024 * 1024

export type CustomerModelLookup =
  | { ok: true; jobId: string; scopeRevisionId: string; revisionNumber: number; storagePath: string }
  | { ok: false; reason: 'flag_off' | 'no_token' | 'quote_not_found' | 'no_frozen_revision' | 'no_model' | 'read_failed' }

/** Finds the current frozen revision's customer model for a quote link. Reads only. */
// deno-lint-ignore no-explicit-any
export async function findCustomerModel(sb: any, token: string | null, flagOn?: boolean): Promise<CustomerModelLookup> {
  const on = flagOn ?? await isFlagOn(sb, CUSTOMER_3D_FLAG)
  if (!on) return { ok: false, reason: 'flag_off' }
  if (!token) return { ok: false, reason: 'no_token' }

  const doc = await sb
    .from('job_documents')
    .select('id, job_id')
    .eq('share_token', token)
    .eq('sent_to_client', true)
    .is('superseded_at', null)
    .maybeSingle()
  if (doc.error) return { ok: false, reason: 'read_failed' }
  if (!doc.data?.job_id) return { ok: false, reason: 'quote_not_found' }

  const rev = await sb
    .from('scope_revisions')
    .select('id, revision_number')
    .eq('job_id', doc.data.job_id)
    .eq('status', 'frozen')
    .order('revision_number', { ascending: false })
    .limit(1)
  if (rev.error) return { ok: false, reason: 'read_failed' }
  const current = rev.data?.[0]
  if (!current?.id) return { ok: false, reason: 'no_frozen_revision' }

  const art = await sb
    .from('scope_artifacts')
    .select('storage_path, created_at')
    .eq('scope_revision_id', current.id)
    .eq('artifact_type', CUSTOMER_MODEL_ARTIFACT)
    .order('created_at', { ascending: false })
    .limit(1)
  if (art.error) return { ok: false, reason: 'read_failed' }
  const path = art.data?.[0]?.storage_path
  if (!path) return { ok: false, reason: 'no_model' }

  return { ok: true, jobId: doc.data.job_id, scopeRevisionId: current.id, revisionNumber: Number(current.revision_number), storagePath: path }
}

export type CustomerModelRead =
  | { ok: true; model: Record<string, unknown>; revLabel: string }
  | { ok: false; reason: 'read_failed' }

/** Reads the model bytes for a found lookup and checks they are one JSON object of a sane size. */
// deno-lint-ignore no-explicit-any
export async function readCustomerModel(sb: any, found: Extract<CustomerModelLookup, { ok: true }>): Promise<CustomerModelRead> {
  const dl = await sb.storage.from(BUCKET).download(found.storagePath)
  if (dl.error || !dl.data) return { ok: false, reason: 'read_failed' }
  try {
    const bytes = new Uint8Array(await dl.data.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_MODEL_BYTES) return { ok: false, reason: 'read_failed' }
    const model = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!model || typeof model !== 'object' || Array.isArray(model)) return { ok: false, reason: 'read_failed' }
    return { ok: true, model, revLabel: `Rev ${found.revisionNumber}` }
  } catch {
    return { ok: false, reason: 'read_failed' }
  }
}

/** The viewer page's address for a quote link: the static page reads send-quote/model with the same token. */
export function customerModelViewerUrl(viewerBase: string, token: string): string {
  const u = new URL(viewerBase)
  u.searchParams.set('token', token)
  return u.toString()
}
