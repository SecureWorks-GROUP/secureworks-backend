// deno-lint-ignore-file no-explicit-any
// (supabase-js v2 client + Postgres rows are untyped here, matching the ops-api
//  convention — index.ts is fully lint-excluded for the same reason. The `any`
//  casts are confined to the DB-bound action wrappers; the pure helpers below
//  them are fully typed.)
// ════════════════════════════════════════════════════════════
// MAKE-SAFE COMPACT READ ENDPOINTS — GAP-1..6
// Campaign: MAKESAFE-REPORTING-ALLOCATIONS-PROOF, mission M2
// Plan: makesafe-live-truth-2026-06-14/skills-rewire-plan.md §2 (GAP-1..6)
// ════════════════════════════════════════════════════════════
//
// These let the four make-safe skills read Supabase truth (the email-sync
// projection) instead of scanning the live ses@ mailbox via Graph. All six are
// READ-ONLY against business data. GAP-2 mints a short-TTL signed URL (a read).
//
// They follow the makesafe_reconcile.ts convention: thin DB-bound wrappers that
// accept an injected supabase client, with the small pure helpers exported for
// the Deno test suite. Nothing here touches the network at module load.
//
// SCHEMA NOTES (built to the ACTUAL columns, not the spec's assumptions — see
// 20260614000001_makesafe_email_sync_schema.sql):
//   • emails has NO `from_domain`/`sender_domain` column — derived from
//     `from_email` (substring after the last '@').
//   • pipeline_items has NO `source_email_id`/`email_id` column — the originating
//     email is resolved via `source_event_ids[]` -> email_events_raw.post_id,
//     EXACTLY as makesafe_reconcile.ts resolves it (single source of truth).
//   • makesafe_intake_drafts has NO `source_email_id` column — the Graph post id
//     is stored as `graph_message_id`, and `emails.post_id` IS that id. GAP-1
//     dedups emails.post_id against makesafe_intake_drafts.graph_message_id.
//   • email_attachments.status has NO `skipped` value — the enum is
//     pending|uploaded|failed|needs_review|purged. The summary surfaces the four
//     live-actionable statuses plus `purged` (informative for intake fallback).
//   • Storage bucket is `makesafe-emails` (private).

// The canonical ses@ mailbox key (matches monitor-ses-makesafes + reconcile).
export const SES_MAILBOX = "ses@secureworkswa.com.au";

const DAY_MS = 86_400_000;

type SB = any;

// ── Shared pure helpers ───────────────────────────────────────────────────────

// Derive the sender domain from a full email address. emails carries no
// from_domain column; this mirrors makesafe_reconcile.ts (lastIndexOf('@')).
export function deriveFromDomain(fromEmail: string | null | undefined): string | null {
  if (!fromEmail) return null;
  const v = String(fromEmail);
  const at = v.lastIndexOf("@");
  if (at < 0) return null;
  const d = v.slice(at + 1).trim().toLowerCase();
  return d || null;
}

// ISO timestamp `days` before `nowIso` (default wall-clock now). Used to build
// the default `since` window for GAP-1/GAP-3.
export function sinceFromDays(days: number, nowIso?: string | null): string {
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const base = Number.isNaN(now) ? Date.now() : now;
  return new Date(base - days * DAY_MS).toISOString();
}

// GAP-5 — per-email attachment status summary. Counts each live status. The enum
// has no `skipped`; `purged` is surfaced because a purged attachment can no
// longer be served (the intake skill must NOT try a signed URL for it).
export interface AttachmentStatusSummary {
  uploaded: number;
  pending: number;
  failed: number;
  needs_review: number;
  purged: number;
}

export function emptyAttachmentSummary(): AttachmentStatusSummary {
  return { uploaded: 0, pending: 0, failed: 0, needs_review: 0, purged: 0 };
}

// Build a post_id -> AttachmentStatusSummary map from a flat list of
// email_attachments rows ({ email_id, status }). Unknown/extra statuses are
// ignored (the summary only reports the known enum members).
export function buildAttachmentSummaries(
  attachmentRows: Array<{ email_id?: string | null; status?: string | null }>,
): Record<string, AttachmentStatusSummary> {
  const out: Record<string, AttachmentStatusSummary> = {};
  for (const a of attachmentRows || []) {
    const pid = a?.email_id;
    if (!pid) continue;
    const s = out[pid] ?? (out[pid] = emptyAttachmentSummary());
    const status = String(a?.status || "");
    if (status === "uploaded") s.uploaded++;
    else if (status === "pending") s.pending++;
    else if (status === "failed") s.failed++;
    else if (status === "needs_review") s.needs_review++;
    else if (status === "purged") s.purged++;
  }
  return out;
}

// Total live attachment count for an email (everything except purged — purged
// bytes are gone, so they are not a "has attachments" signal for the skills).
export function liveAttachmentCount(s: AttachmentStatusSummary | undefined): number {
  if (!s) return 0;
  return s.uploaded + s.pending + s.failed + s.needs_review;
}

// ── GAP-2 status guard (pure) ─────────────────────────────────────────────────
// A signed URL may ONLY be minted for an `uploaded` attachment (bytes validated
// + stored). Every other status returns a clear, distinct error string so the
// intake skill can decide its fallback (e.g. live Graph fetch for pending/failed).
export function attachmentUrlGuard(
  status: string | null | undefined,
  storagePath: string | null | undefined,
): { ok: boolean; error?: string } {
  const s = String(status || "").toLowerCase();
  if (s !== "uploaded") {
    const reason: Record<string, string> = {
      pending: "attachment pending (bytes not yet stored); retry after sync, or fall back to a live Graph fetch",
      failed: "attachment failed (fetch/upload/validation error); fall back to a live Graph fetch",
      needs_review: "attachment needs_review (reference/item/inline kind); not a stored PDF, manual review required",
      purged: "attachment purged (90-day PII tombstone); bytes no longer exist",
    };
    return {
      ok: false,
      error: reason[s] || `attachment status '${status ?? "unknown"}' is not 'uploaded'; cannot mint signed URL`,
    };
  }
  if (!storagePath) {
    return { ok: false, error: "attachment is 'uploaded' but has no storage_path; cannot mint signed URL" };
  }
  return { ok: true };
}

// ════════════════════════════════════════════════════════════
// DB-BOUND ACTIONS (thin wrappers; injected client for unit testing)
// ════════════════════════════════════════════════════════════

// ── GAP-1: makesafe_new_emails ──
// New candidate ses@ emails NOT already drafted/approved into the intake queue.
// Dedup key: emails.post_id == makesafe_intake_drafts.graph_message_id (the Graph
// post id; an approved draft means a job already exists for it). Tombstoned
// (pii_purged_at) emails are excluded — there is nothing to intake from them.
// Each row carries GAP-5 attachment_status_summary so the skill knows whether a
// WO PDF is servable (uploaded) before opening anything.
//
// Params: since (default 30d), mailbox (default ses@).
export async function makesafeNewEmails(
  client: SB,
  params: { since?: string | null; mailbox?: string | null; nowIso?: string | null },
) {
  const mailbox = params.mailbox || SES_MAILBOX;
  const since = params.since || sinceFromDays(30, params.nowIso);

  // All ses@ emails in the window (exclude tombstoned — no PII to intake).
  const { data: emails, error: emailsErr } = await client.from("emails")
    .select("post_id, received_at, from_email, has_attachments")
    .eq("mailbox", mailbox)
    .is("pii_purged_at", null)
    .gte("received_at", since)
    .order("received_at", { ascending: false });
  if (emailsErr) throw new Error(`emails read failed: ${emailsErr.message}`);

  // Already-known Graph post ids: any intake draft (draft/needs_review/approved/
  // superseded). An approved draft maps to a live job, so its email is not "new".
  // A rejected draft IS eligible to resurface, so rejected ids are NOT excluded.
  const { data: drafts, error: draftsErr } = await client.from("makesafe_intake_drafts")
    .select("graph_message_id, status")
    .neq("status", "rejected");
  if (draftsErr) throw new Error(`makesafe_intake_drafts read failed: ${draftsErr.message}`);
  const knownIds = new Set<string>();
  for (const d of (drafts || [])) if (d?.graph_message_id) knownIds.add(d.graph_message_id);

  const newEmails = (emails || []).filter((e: any) => !knownIds.has(e.post_id));
  const postIds = newEmails.map((e: any) => e.post_id);

  // GAP-5 — attachment status summary per email (one batched read).
  const summaries = await loadAttachmentSummaries(client, postIds);

  const rows = newEmails.map((e: any) => {
    const summary = summaries[e.post_id] ?? emptyAttachmentSummary();
    const attachment_count = liveAttachmentCount(summary);
    return {
      post_id: e.post_id,
      received_at: e.received_at ?? null,
      from_domain: deriveFromDomain(e.from_email),
      extracted_ref: null as string | null, // see note below
      has_attachments: e.has_attachments === true || attachment_count > 0,
      attachment_count,
      attachment_status_summary: summary,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    mailbox,
    since,
    count: rows.length,
    emails: rows,
    // extracted_ref is sourced from the pipeline_items projection (one ref per
    // ref per mailbox); a per-email ref is not stored on the emails row itself.
    // GAP-3 (makesafe_pipeline_items) is the ref-bearing read. GAP-1 stays a
    // pure "what is un-drafted" query; extracted_ref is null here by design.
    notes: "extracted_ref is null on this endpoint by design; use makesafe_pipeline_items (GAP-3) for normalised refs.",
  };
}

// ── GAP-3: makesafe_pipeline_items ──
// The pipeline_items projection as a flat list, joined to its originating email
// (via source_event_ids -> email_events_raw.post_id -> emails) for sender_domain
// and received_at. This is the intake-audit "mailbox side" without a live scan.
//
// Params: since (default 60d), mailbox (default ses@), sent_status (optional).
export async function makesafePipelineItems(
  client: SB,
  params: {
    since?: string | null;
    mailbox?: string | null;
    sent_status?: string | null;
    nowIso?: string | null;
  },
) {
  const mailbox = params.mailbox || SES_MAILBOX;
  const since = params.since || sinceFromDays(60, params.nowIso);

  let piQuery = client.from("pipeline_items")
    .select("ref, target_job, sent_status, attachment_refs, match_score, match_method, source_event_ids")
    .eq("mailbox", mailbox);
  if (params.sent_status) piQuery = piQuery.eq("sent_status", params.sent_status);
  const { data: pi, error: piErr } = await piQuery;
  if (piErr) throw new Error(`pipeline_items read failed: ${piErr.message}`);

  // Resolve each pipeline item's originating email post_id via source_event_ids
  // -> email_events_raw.post_id (the highest-trust linkage, same as reconcile D1).
  const eventIds = Array.from(
    new Set((pi || []).flatMap((p: any) => (p.source_event_ids || [])).filter(Boolean)),
  );
  const eventToPost = new Map<string, string>();
  if (eventIds.length) {
    const { data: evs, error: evsErr } = await client.from("email_events_raw")
      .select("id, post_id").in("id", eventIds);
    if (evsErr) throw new Error(`email_events_raw (event->post) read failed: ${evsErr.message}`);
    for (const ev of (evs || [])) if (ev?.id) eventToPost.set(ev.id, ev.post_id);
  }

  // Resolve the post ids -> emails (sender_domain + received_at), windowed.
  const postIds = Array.from(new Set(Array.from(eventToPost.values())));
  const emailById = new Map<string, { from_email: string | null; received_at: string | null }>();
  if (postIds.length) {
    const { data: emails, error: emailsErr } = await client.from("emails")
      .select("post_id, from_email, received_at")
      .eq("mailbox", mailbox)
      .in("post_id", postIds);
    if (emailsErr) throw new Error(`emails (pipeline join) read failed: ${emailsErr.message}`);
    for (const e of (emails || [])) {
      emailById.set(e.post_id, { from_email: e.from_email ?? null, received_at: e.received_at ?? null });
    }
  }

  // GAP-5 — attachment status summary per originating email.
  const summaries = await loadAttachmentSummaries(client, postIds);

  let rows = (pi || []).map((p: any) => {
    const firstEventId = (p.source_event_ids || []).find((id: string) => eventToPost.has(id));
    const postId = firstEventId ? (eventToPost.get(firstEventId) ?? null) : null;
    const email = postId ? emailById.get(postId) : null;
    const summary = postId ? (summaries[postId] ?? emptyAttachmentSummary()) : emptyAttachmentSummary();
    // attachment_count: prefer the live store summary; fall back to the
    // pipeline_items.attachment_refs length when the email join is missing.
    const refsCount = Array.isArray(p.attachment_refs) ? p.attachment_refs.length : 0;
    const attachment_count = liveAttachmentCount(summary) || refsCount;
    return {
      ref: p.ref ?? null,
      source_email_id: postId,
      sender_domain: deriveFromDomain(email?.from_email ?? null),
      received_at: email?.received_at ?? null,
      sent_status: p.sent_status ?? null,
      attachment_count,
      has_target_job: !!p.target_job,
      match_score: p.match_score ?? null,
      attachment_status_summary: summary,
    };
  });

  // `since` filters on the originating email's received_at. A pipeline item whose
  // email is older than the window (or whose email could not be resolved) is
  // excluded so the result honours the lookback. (sent_status, if supplied, was
  // already applied server-side above.)
  rows = rows.filter((r: any) => r.received_at != null && r.received_at >= since);

  return {
    generated_at: new Date().toISOString(),
    mailbox,
    since,
    sent_status: params.sent_status || null,
    count: rows.length,
    items: rows,
  };
}

// ── GAP-6: get_makesafe_email ──
// One email by post_id (= source_email_id / graph_message_id) + its attachments.
// If PII is tombstoned (emails.pii_purged_at set), returns a DEGRADED record
// flagged tombstoned (PII columns are null on the row; we surface the skeleton +
// attachment status so the audit trail stays continuous).
//
// Params: post_id.
export async function getMakesafeEmail(
  client: SB,
  params: { post_id?: string | null },
) {
  const postId = params.post_id;
  if (!postId) throw new ApiBadRequest("post_id required");

  const { data: email, error: emailErr } = await client.from("emails")
    .select("post_id, mailbox, subject, body_preview, from_email, received_at, has_attachments, pii_purged_at")
    .eq("post_id", postId)
    .maybeSingle();
  if (emailErr) throw new Error(`emails read failed: ${emailErr.message}`);
  if (!email) return { found: false, post_id: postId };

  const { data: atts, error: attErr } = await client.from("email_attachments")
    .select("id, graph_attachment_id, name, content_type, size_bytes, status, attachment_kind")
    .eq("email_id", postId);
  if (attErr) throw new Error(`email_attachments read failed: ${attErr.message}`);

  const summary = (buildAttachmentSummaries(
    (atts || []).map((a: any) => ({ email_id: postId, status: a.status })),
  )[postId]) ?? emptyAttachmentSummary();

  const tombstoned = email.pii_purged_at != null;

  return {
    found: true,
    tombstoned,
    email: {
      post_id: email.post_id,
      mailbox: email.mailbox ?? null,
      // PII columns are null once tombstoned (the purge nulls them); surface as
      // null + the tombstoned flag so the skill degrades gracefully.
      subject: tombstoned ? null : (email.subject ?? null),
      body_preview: tombstoned ? null : (email.body_preview ?? null),
      from_domain: tombstoned ? null : deriveFromDomain(email.from_email),
      received_at: email.received_at ?? null,
      has_attachments: email.has_attachments === true,
      pii_purged_at: email.pii_purged_at ?? null,
    },
    attachments: (atts || []).map((a: any) => ({
      attachment_id: a.id,
      graph_attachment_id: a.graph_attachment_id ?? null,
      // name is PII (can leak client/address) and is nulled on purge.
      name: tombstoned ? null : (a.name ?? null),
      content_type: a.content_type ?? null,
      size_bytes: a.size_bytes ?? null,
      status: a.status ?? null,
      attachment_kind: a.attachment_kind ?? null,
    })),
    attachment_status_summary: summary,
  };
}

// ── GAP-2: get_makesafe_attachment_url ──
// Mint a short-TTL (60s) signed URL to an `uploaded` attachment's storage_path in
// the private `makesafe-emails` bucket. Param: attachment_id (uuid) OR
// (post_id, graph_attachment_id). Only `uploaded` rows are servable; every other
// status returns a clear error (see attachmentUrlGuard).
const SIGNED_URL_TTL_SECONDS = 60;
const MAKESAFE_BUCKET = "makesafe-emails";

export async function getMakesafeAttachmentUrl(
  client: SB,
  params: {
    attachment_id?: string | null;
    post_id?: string | null;
    graph_attachment_id?: string | null;
  },
) {
  const { attachment_id, post_id, graph_attachment_id } = params;
  if (!attachment_id && !(post_id && graph_attachment_id)) {
    throw new ApiBadRequest("attachment_id, or (post_id and graph_attachment_id), required");
  }

  let q = client.from("email_attachments")
    .select("id, email_id, graph_attachment_id, status, storage_path, name, content_type");
  if (attachment_id) {
    q = q.eq("id", attachment_id);
  } else {
    q = q.eq("email_id", post_id).eq("graph_attachment_id", graph_attachment_id);
  }
  const { data: att, error: attErr } = await q.maybeSingle();
  if (attErr) throw new Error(`email_attachments read failed: ${attErr.message}`);
  if (!att) {
    return { ok: false, error: "attachment not found" };
  }

  const guard = attachmentUrlGuard(att.status, att.storage_path);
  if (!guard.ok) {
    return {
      ok: false,
      error: guard.error,
      attachment_id: att.id,
      status: att.status ?? null,
    };
  }

  const { data: signed, error: signErr } = await client.storage
    .from(MAKESAFE_BUCKET)
    .createSignedUrl(att.storage_path, SIGNED_URL_TTL_SECONDS);
  if (signErr) throw new Error(`createSignedUrl failed: ${signErr.message ?? signErr}`);

  return {
    ok: true,
    attachment_id: att.id,
    email_id: att.email_id ?? null,
    name: att.name ?? null,
    content_type: att.content_type ?? null,
    expires_in: SIGNED_URL_TTL_SECONDS,
    signed_url: signed?.signedUrl ?? signed?.signedURL ?? null,
  };
}

// ── GAP-4 helper: pipeline_item sent_status by target job ──
// Returns a map of job_id -> pipeline_items.sent_status for the given job ids, so
// makesafe_audit can surface the sync-system sent verdict alongside the
// notes-based pack_sent marker. (verified_sent | not_sent | needs_review.)
export async function buildPipelineSentStatusMap(
  client: SB,
  jobIds: string[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  if (!jobIds.length) return map;
  const { data, error } = await client.from("pipeline_items")
    .select("target_job, sent_status")
    .in("target_job", jobIds);
  if (error) throw new Error(`pipeline_items (sent_status by job) read failed: ${error.message}`);
  for (const p of (data || [])) {
    if (p?.target_job && p.sent_status) map[p.target_job] = p.sent_status;
  }
  return map;
}

// ── internal: batched attachment summary load (GAP-5) ──
async function loadAttachmentSummaries(
  client: SB,
  postIds: string[],
): Promise<Record<string, AttachmentStatusSummary>> {
  if (!postIds.length) return {};
  const { data, error } = await client.from("email_attachments")
    .select("email_id, status")
    .in("email_id", postIds);
  if (error) throw new Error(`email_attachments (status summary) read failed: ${error.message}`);
  return buildAttachmentSummaries((data || []) as Array<{ email_id?: string | null; status?: string | null }>);
}

// A 400-class error the ops-api dispatcher maps to a 400 response. index.ts has
// an ApiError; this local marker keeps the module importable + unit-testable
// standalone (the dispatcher checks `.status`).
export class ApiBadRequest extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ApiBadRequest";
  }
}

// Test-only aliases (mirror the `_`-prefixed convention in makesafe_reconcile.ts
// and the make-safe helpers in index.ts).
export const _makesafeNewEmails = makesafeNewEmails;
export const _makesafePipelineItems = makesafePipelineItems;
export const _getMakesafeEmail = getMakesafeEmail;
export const _getMakesafeAttachmentUrl = getMakesafeAttachmentUrl;
export const _buildPipelineSentStatusMap = buildPipelineSentStatusMap;
