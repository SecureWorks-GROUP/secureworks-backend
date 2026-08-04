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

// ── Pagination + chunking (PostgREST 1000-row cap) ─────────────────────────────
// PostgREST caps every response at 1000 ROWS regardless of how narrow the filter
// is (project-wide gotcha). A multi-row read with no .range() therefore SILENTLY
// truncates at 1000 — for GAP-1's drafts read that means already-drafted emails
// fall out of the dedup set and resurface as "new" -> duplicate intake. Every
// multi-row read in this module must paginate.
//
// PAGE_SIZE matches index.ts fetchAll (1000 = the cap). We loop .range(offset,
// offset+PAGE-1) until a short page. The factory returns a FRESH builder each
// call so .range() is re-applied cleanly per page (Supabase builders are not
// reusable once awaited). Works with the injected test client provided its
// builder exposes a .range(from,to) terminal (see the test stub).
const PAGE_SIZE = 1000;

// Exported (Wave 1): scanSesMakesafes in index.ts reuses this SAME paginated
// reader (PostgREST 1000-row cap) for its candidate window over the `emails`
// projection, mirroring makesafeNewEmails' sourcing. Pure DB read; no module-load
// side effects.
//
// UNIQUE TOTAL ORDER (required, not optional): `.range()` is LIMIT/OFFSET.
// Postgres only orders two separate LIMIT/OFFSET pages relative to each other
// under a TOTAL order. A non-unique primary sort (e.g. `received_at` alone) can
// put a tied row on neither page once the read spills past 1000 — it reads as
// absent, not as an error. The reader therefore ALWAYS appends `uniqueKey` AFTER
// any caller-supplied `.order()` chain so the caller's sort stays primary and
// the key only breaks ties. Prefer the table's stable primary key (`id`,
// `post_id`, …).
export async function fetchAllRows<T = any>(
  buildQuery: () => any,
  label: string,
  uniqueKey: string,
  uniqueAscending = true,
): Promise<T[]> {
  if (!uniqueKey || typeof uniqueKey !== "string") {
    throw new Error(
      `${label}: fetchAllRows requires a unique page-order key (table PK)`,
    );
  }
  const all: T[] = [];
  let offset = 0;
  // Hard ceiling so a misbehaving range terminal can't loop forever.
  for (let guard = 0; guard < 100_000; guard++) {
    const { data, error } = await buildQuery()
      .order(uniqueKey, { ascending: uniqueAscending })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`${label} failed: ${error.message ?? error}`);
    const page: T[] = data || [];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

// PostgREST also pushes an `.in(col, list)` into the request URL, so a very large
// id list can blow the URL length AND (because the response is still capped at
// 1000 result rows) silently truncate. Chunk the id list, paginate each chunk,
// and merge.
//
// URL-LENGTH CONSTRAINT (live-found 500 bug, 2026-06-16): the Supabase gateway
// rejects an over-long request URL BEFORE the request is sent — surfacing in Deno
// as "error sending request for ..." rather than an HTTP status. GAP-1/GAP-3 both
// 500'd here. A FIXED COUNT cannot be safe for both id shapes this module reads:
//   • email_events_raw.id is a 36-char UUID (~37 chars encoded in the in.(...) list).
//   • email_attachments.email_id = emails.post_id = a Graph/Exchange post id, which
//     is ~100-150 chars and carries URL-special chars (/, +, =) that grow further
//     under encoding. 100 of THOSE build a ~15-20KB list the gateway drops.
//
// So we chunk by a URL-LENGTH BUDGET, not a fixed count: accumulate ids until the
// next id would push the URL-encoded, comma-joined id list past IN_URL_BUDGET.
// This makes a chunk of long post-ids small (few per chunk) and a chunk of short
// UUIDs large (many per chunk) — each producing an `.in()` URL safely under the
// gateway's ~8KB limit, with headroom for the rest of the URL (table, columns,
// the `id=in.(` wrapper, range headers). A secondary hard COUNT cap bounds the
// worst case for very short ids and keeps each chunk under the 1000-row response
// cap.

// URL-encoded byte budget for the comma-joined id list inside one `.in()`. ~6000
// leaves ~2KB headroom under the ~8KB gateway limit for the rest of the request URL.
export const IN_URL_BUDGET = 6000;

// Secondary hard cap on ids-per-chunk (independent of the byte budget). Keeps the
// worst case (many very short ids) bounded and well under the 1000-row cap.
export const IN_MAX_COUNT = 200;

// Encoded cost of adding one id to the comma-joined list: the id's URL-encoded
// length plus 1 for the separating comma. Mirrors what PostgREST puts on the wire.
function encodedIdCost(id: string): number {
  return encodeURIComponent(id).length + 1;
}

// Split ids into chunks by URL-length budget (IN_URL_BUDGET) with a secondary
// hard count cap (IN_MAX_COUNT). A single id whose encoded cost alone exceeds the
// budget still gets its own 1-element chunk (never an empty/infinite chunk).
// Exported: allocated-trade restrict lists and other `.in(id, …)` splices reuse
// this same budget so gateway URL length never silently 500s a scoped board.
export function chunkByUrlBudget(ids: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let curBytes = 0;
  for (const id of ids) {
    const cost = encodedIdCost(id);
    // Start a new chunk if adding this id would exceed the byte budget OR the hard
    // count cap — but only if the current chunk already has at least one id (so a
    // lone over-budget id is not dropped and we never loop forever).
    if (
      cur.length > 0 &&
      (curBytes + cost > IN_URL_BUDGET || cur.length >= IN_MAX_COUNT)
    ) {
      out.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(id);
    curBytes += cost;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ── Bounded PostgREST fan-out ─────────────────────────────────────────────────
// Chunk reads run CONCURRENTLY (that is the round-trip win) but never all at
// once. The cap is MODULE-WIDE, not per call: the make-safe board issues ~10
// chunked job-id joins in one dependent wave, so a per-call bound would still
// let one board request open ~30 simultaneous PostgREST connections and would
// grow linearly with the board. Saturating the Supabase pool does not read as a
// slow board — `ops.html` falls back to `makesafe_pipeline` on any non-200 from
// `makesafe_board`, which is overlay-blind, so exhaustion surfaces as a
// board-truth outage. 8 is the captain's standing cap (2026-08-04): enough
// in-flight reads to keep the parallel-chunk TTFB win over the old serial
// reader, bounded against board growth and concurrent board loads. Lower it
// only on measured evidence.
//
// `withBoundedFetchSlot` is exported because the bound must cover EVERY
// board-path fan-out whose width grows with the board, not just the chunked
// reader: `makesafePipeline`'s typed + detail-authority job-source lanes (active
// and cancelled) build one raw paginated lane per URL-budget id chunk, so they
// acquire a slot from this same pool. Any new growth-dependent fan-out on that
// path must do the same.
export const CHUNK_FETCH_CONCURRENCY = 8;

let inFlightChunkFetches = 0;
const chunkFetchWaiters: Array<() => void> = [];

// Slots are TRANSFERRED on release rather than decremented-then-re-acquired, so
// a waiter resuming on a later microtask can never be overtaken by a fresh
// caller and push the in-flight count past the cap.
async function acquireChunkFetchSlot(): Promise<void> {
  if (inFlightChunkFetches < CHUNK_FETCH_CONCURRENCY) {
    inFlightChunkFetches++;
    return;
  }
  await new Promise<void>((resolve) => chunkFetchWaiters.push(resolve));
}

function releaseChunkFetchSlot(): void {
  const next = chunkFetchWaiters.shift();
  if (next) {
    next();
    return;
  }
  inFlightChunkFetches--;
}

export async function withBoundedFetchSlot<T>(run: () => Promise<T>): Promise<T> {
  await acquireChunkFetchSlot();
  try {
    return await run();
  } finally {
    releaseChunkFetchSlot();
  }
}

// Run a paginated read for each budgeted chunk of `ids` and merge all rows. The
// factory receives one chunk and must return a fresh query builder (including the
// `.in(col, chunk)` filter). `uniqueKey` is required and is appended inside
// `fetchAllRows` after any caller-supplied ordering — same total-order law as the
// unchunked reader.
//
// Chunks run concurrently under the shared CHUNK_FETCH_CONCURRENCY bound above.
// Each chunk still paginates internally with a stable uniqueKey order (holding
// its slot for the whole chunk); cross-chunk row order is not load-bearing
// (callers group by job_id / re-sort). Parallel chunks cut the make-safe board's
// sequential PostgREST round-trips: ~450 UUIDs → 3 chunks that used to wait on
// each other.
//
// Exported: `ops-api/index.ts` reuses this same reader for its make-safe job-id
// joins (`_fetchAllByJobIdChunked`).
export async function fetchAllRowsInChunks<T = any>(
  ids: string[],
  buildQueryForChunk: (chunkIds: string[]) => any,
  label: string,
  uniqueKey: string,
  uniqueAscending = true,
): Promise<T[]> {
  // Dedup ids FIRST. A duplicate id that straddles a chunk boundary would
  // otherwise land in two different `.in(col, chunk)` reads and return the same
  // DB row twice (double-counting downstream). Dedup also shrinks the request.
  const uniqueIds = Array.from(new Set(ids));
  if (!uniqueIds.length) return [];
  const chunks = chunkByUrlBudget(uniqueIds);
  const pages = await Promise.all(
    chunks.map((ch) =>
      withBoundedFetchSlot(() =>
        fetchAllRows<T>(
          () => buildQueryForChunk(ch),
          label,
          uniqueKey,
          uniqueAscending,
        )
      )
    ),
  );
  const all: T[] = [];
  for (const rows of pages) all.push(...rows);
  return all;
}

// ── Shared pure helpers ───────────────────────────────────────────────────────

// Derive the sender domain from a full email address. emails carries no
// from_domain column; this mirrors makesafe_reconcile.ts (lastIndexOf('@')).
export function deriveFromDomain(
  fromEmail: string | null | undefined,
): string | null {
  if (!fromEmail) return null;
  const v = String(fromEmail);
  const at = v.lastIndexOf("@");
  if (at < 0) return null;
  const d = v.slice(at + 1).trim().toLowerCase();
  return d || null;
}

// ── Own / outbound domain classification (inbound contamination filter) ────────
// The ses@ mailbox is a M365 GROUP that receives a COPY of every report/invoice
// pack WE send out, so the email-sync projection is contaminated by our own
// outbound mail: a live readiness check found makesafe_new_emails returned 460
// rows, 366 (79%) from our own domains, leaving only ~90 genuine inbound builder
// work-order candidates. GAP-1 is an INBOUND intake-candidate feed, so own/
// outbound mail must be excluded; GAP-3 (the fuller pipeline view) keeps both but
// tags each item's direction so the audit skill can filter cleanly.
//
// AUTHORITATIVE SOURCE: the codebase defines the INBOUND side (builders) as
// makesafe_companies.sender_patterns (used by monitor-ses-makesafes' classifier).
// There is NO existing self/own-domain list anywhere in the backend — own domains
// are the COMPLEMENT of the builder set and were not previously enumerated. So we
// define them here as the single source of truth for "our outbound mail".
//
// Matched by SUFFIX (equality OR dot-anchored suffix) so a subdomain like
// mail.secureworksgroup.app is covered by "secureworksgroup.app" while a look-alike
// like "notsecureworksgroup.app" is NOT (the dot anchor prevents over-matching,
// mirroring senderMatchesPattern in monitor-ses-makesafes).
//
// NOTE: primeeco.tech is deliberately NOT here. It is the builders' platform that
// delivers inbound work orders to us (mlb.mailer@primeeco.tech,
// noreply@notifications.primeeco.tech, etc.), NOT a domain WE send from. Listing it
// classified genuine inbound MLB/Prime work orders as "our own outbound" and silently
// dropped them from intake. The notification noise Prime also emits is handled by the
// subject-exclusion + work-order-PDF gate (see makesafe_intake_gate.ts), not by a
// blanket domain block.
export const OWN_OUTBOUND_DOMAINS: readonly string[] = [
  "secureworkswa.com.au", // legacy primary (ses@ lives here)
  "secureworksgroup.app", // current outbound app domain (quotes@/invoices@/orders@/approvals@)
  "secureworksgroup.com.au",
];

// True when fromDomain is (or is a subdomain of) one of our own outbound domains.
// Pure + exported for the test suite. Null/empty domain -> not own (treated as
// inbound so an un-parseable sender is never silently dropped from intake).
export function isOwnDomain(fromDomain: string | null | undefined): boolean {
  if (!fromDomain) return false;
  const d = String(fromDomain).trim().toLowerCase();
  if (!d) return false;
  return OWN_OUTBOUND_DOMAINS.some((own) => d === own || d.endsWith(`.${own}`));
}

// "outbound" when the sender is one of our own domains, else "inbound".
export type EmailDirection = "inbound" | "outbound";
export function directionForDomain(
  fromDomain: string | null | undefined,
): EmailDirection {
  return isOwnDomain(fromDomain) ? "outbound" : "inbound";
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
export function liveAttachmentCount(
  s: AttachmentStatusSummary | undefined,
): number {
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
      pending:
        "attachment pending (bytes not yet stored); retry after sync, or fall back to a live Graph fetch",
      failed:
        "attachment failed (fetch/upload/validation error); fall back to a live Graph fetch",
      needs_review:
        "attachment needs_review (reference/item/inline kind); not a stored PDF, manual review required",
      purged: "attachment purged (90-day PII tombstone); bytes no longer exist",
    };
    return {
      ok: false,
      error: reason[s] ||
        `attachment status '${
          status ?? "unknown"
        }' is not 'uploaded'; cannot mint signed URL`,
    };
  }
  if (!storagePath) {
    return {
      ok: false,
      error:
        "attachment is 'uploaded' but has no storage_path; cannot mint signed URL",
    };
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
  params: {
    since?: string | null;
    mailbox?: string | null;
    nowIso?: string | null;
  },
) {
  const mailbox = params.mailbox || SES_MAILBOX;
  const since = params.since || sinceFromDays(30, params.nowIso);

  // All ses@ emails in the window (exclude tombstoned — no PII to intake).
  // Paginated: the window can hold >1000 emails (PostgREST 1000-row cap).
  // Primary sort is newest-first received_at; uniqueKey post_id (emails PK)
  // breaks same-second ties so a multi-page window cannot drop an inbound WO.
  const emails = await fetchAllRows<any>(
    () =>
      client.from("emails")
        .select("post_id, received_at, from_email, has_attachments")
        .eq("mailbox", mailbox)
        .is("pii_purged_at", null)
        .gte("received_at", since)
        .order("received_at", { ascending: false }),
    "emails read",
    "post_id",
  );

  // Already-known Graph post ids: any intake draft (draft/needs_review/approved/
  // superseded). An approved draft maps to a live job, so its email is not "new".
  // A rejected draft IS eligible to resurface, so rejected ids are NOT excluded.
  // PAGINATED — this read has no time window, so it is the FIRST to hit the
  // 1000-row cap; truncation here drops known ids -> already-drafted emails
  // resurface as "new" -> duplicate intake. Must read every draft. Order on the
  // `id` PK so multi-page OFFSET is a total order.
  const drafts = await fetchAllRows<any>(
    () =>
      client.from("makesafe_intake_drafts")
        .select("graph_message_id, status")
        .neq("status", "rejected"),
    "makesafe_intake_drafts read",
    "id",
  );
  const knownIds = new Set<string>();
  for (const d of (drafts || [])) {
    if (d?.graph_message_id) knownIds.add(d.graph_message_id);
  }

  // INBOUND CONTAMINATION FILTER: ses@ is a group that receives a COPY of every
  // pack WE send, so the window is ~79% our own outbound mail. This feed is an
  // INBOUND intake-candidate list, so drop any email whose sender is one of our
  // own/outbound domains BEFORE dedup/summary work (smaller batched reads too).
  // Un-drafted AND inbound is the candidate set.
  const undrafted = (emails || []).filter((e: any) => !knownIds.has(e.post_id));
  const newEmails = undrafted.filter((e: any) =>
    !isOwnDomain(deriveFromDomain(e.from_email))
  );
  const excluded_outbound = undrafted.length - newEmails.length;
  const postIds = newEmails.map((e: any) => e.post_id);

  // GAP-5 — attachment status summary per email (one batched read).
  const summaries = await loadAttachmentSummaries(client, postIds);

  const rows = newEmails.map((e: any) => {
    const summary = summaries[e.post_id] ?? emptyAttachmentSummary();
    const attachment_count = liveAttachmentCount(summary);
    const from_domain = deriveFromDomain(e.from_email);
    return {
      post_id: e.post_id,
      received_at: e.received_at ?? null,
      from_domain,
      // After the filter every retained row is inbound; the field is surfaced for
      // transparency (and so a future relaxation of the filter stays self-describing).
      direction: directionForDomain(from_domain),
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
    // Count of un-drafted emails dropped because their sender is one of our own
    // outbound domains (the ses@-group self-copy contamination). Surfaced so the
    // intake skill can see the filter is working without a separate count.
    excluded_outbound,
    emails: rows,
    // extracted_ref is sourced from the pipeline_items projection (one ref per
    // ref per mailbox); a per-email ref is not stored on the emails row itself.
    // GAP-3 (makesafe_pipeline_items) is the ref-bearing read. GAP-1 stays a
    // pure "what is un-drafted" query; extracted_ref is null here by design.
    notes:
      "INBOUND-ONLY: emails from our own outbound domains (ses@-group self-copies) are " +
      "EXCLUDED; excluded_outbound counts them. Each retained row carries direction:'inbound'. " +
      "extracted_ref is null on this endpoint by design; use makesafe_pipeline_items (GAP-3) for normalised refs.",
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

  // Paginated: the full pipeline_items projection for a mailbox can exceed 1000.
  // Total order on the `id` PK so a multi-page mailbox projection cannot drop a
  // ref (lost sent_status / unresolved link).
  const pi = await fetchAllRows<any>(
    () => {
      let q = client.from("pipeline_items")
        .select(
          "ref, target_job, sent_status, attachment_refs, match_score, match_method, source_event_ids",
        )
        .eq("mailbox", mailbox);
      if (params.sent_status) q = q.eq("sent_status", params.sent_status);
      return q;
    },
    "pipeline_items read",
    "id",
  );

  // Resolve each pipeline item's originating email post_id via source_event_ids
  // -> email_events_raw.post_id (the highest-trust linkage, same as reconcile D1).
  // The eventIds list can be large -> chunk the .in() (URL safety) AND paginate
  // each chunk (1000-row result cap). `id` is the PK.
  const eventIds = Array.from(
    new Set(
      (pi || []).flatMap((p: any) => (p.source_event_ids || [])).filter(
        Boolean,
      ),
    ),
  ) as string[];
  const eventToPost = new Map<string, string>();
  const evs = await fetchAllRowsInChunks<any>(
    eventIds,
    (ch) => client.from("email_events_raw").select("id, post_id").in("id", ch),
    "email_events_raw (event->post) read",
    "id",
  );
  for (const ev of evs) if (ev?.id) eventToPost.set(ev.id, ev.post_id);

  // Resolve the post ids -> emails (sender_domain + received_at), windowed.
  // postIds can be large -> chunk the .in() AND paginate each chunk. emails PK
  // is post_id.
  const postIds = Array.from(
    new Set(Array.from(eventToPost.values())),
  ) as string[];
  const emailById = new Map<
    string,
    { from_email: string | null; received_at: string | null }
  >();
  const joinedEmails = await fetchAllRowsInChunks<any>(
    postIds,
    (ch) =>
      client.from("emails")
        .select("post_id, from_email, received_at")
        .eq("mailbox", mailbox)
        .in("post_id", ch),
    "emails (pipeline join) read",
    "post_id",
  );
  for (const e of joinedEmails) {
    emailById.set(e.post_id, {
      from_email: e.from_email ?? null,
      received_at: e.received_at ?? null,
    });
  }

  // GAP-5 — attachment status summary per originating email.
  const summaries = await loadAttachmentSummaries(client, postIds);

  const mapped = (pi || []).map((p: any) => {
    const firstEventId = (p.source_event_ids || []).find(
      (id: string) =>
        eventToPost.has(id) && emailById.has(eventToPost.get(id) as string),
    );
    const postId = firstEventId
      ? (eventToPost.get(firstEventId) ?? null)
      : null;
    const email = postId ? emailById.get(postId) : null;
    // A usable link requires BOTH event->post resolution AND the email row itself
    // (sender_domain/received_at live on the email). If either is missing the
    // item is unresolved and must NOT silently vanish (no-silent-drops).
    const resolved = !!email;
    const summary = postId
      ? (summaries[postId] ?? emptyAttachmentSummary())
      : emptyAttachmentSummary();
    // attachment_count: prefer the live store summary; fall back to the
    // pipeline_items.attachment_refs length when the email join is missing.
    const refsCount = Array.isArray(p.attachment_refs)
      ? p.attachment_refs.length
      : 0;
    const attachment_count = liveAttachmentCount(summary) || refsCount;
    const sender_domain = resolved
      ? deriveFromDomain(email?.from_email ?? null)
      : null;
    return {
      ref: p.ref ?? null,
      source_email_id: resolved ? postId : null,
      sender_domain,
      received_at: resolved ? (email?.received_at ?? null) : null,
      // NOT excluded here (GAP-3 is the fuller pipeline view). direction is
      // "inbound"/"outbound" by sender_domain so intake-audit can filter cleanly;
      // when the email link is unresolved (sender_domain null) direction is null
      // (unknown — never guessed) rather than defaulting to inbound.
      direction: resolved ? directionForDomain(sender_domain) : null,
      sent_status: p.sent_status ?? null,
      attachment_count,
      has_target_job: !!p.target_job,
      match_score: p.match_score ?? null,
      attachment_status_summary: summary,
      // no-silent-drops flag for intake-audit (see windowing rule below).
      email_link: resolved ? "resolved" : "unresolved",
      _resolved: resolved, // internal; stripped before return
    };
  });

  // WINDOWING RULE (`since` filters on the originating email's received_at):
  //   • resolved AND received_at >= since -> include (normal, inside window).
  //   • resolved AND received_at <  since -> exclude (correctly outside window).
  //   • NOT resolved (no usable email link) -> INCLUDE, flagged
  //     email_link:"unresolved" (source_email_id/received_at null) so intake-audit
  //     sees the anomaly. An unresolvable item must never be dropped just because
  //     its received_at is null.
  // (sent_status, if supplied, was already applied server-side above.)
  const rows = mapped
    .filter((r: any) =>
      !r._resolved || (r.received_at != null && r.received_at >= since)
    )
    .map((r: any) => {
      const { _resolved: _omit, ...rest } = r;
      return rest;
    });

  return {
    generated_at: new Date().toISOString(),
    mailbox,
    since,
    sent_status: params.sent_status || null,
    count: rows.length,
    items: rows,
    notes:
      "email_link is 'resolved' (received_at within the `since` window) or 'unresolved' " +
      "(no usable email link via source_event_ids -> email_events_raw -> emails). " +
      "Unresolved items are INCLUDED with source_email_id/received_at null so intake-audit " +
      "sees the anomaly; resolved items older than `since` are excluded. " +
      "direction is 'inbound'/'outbound' by sender_domain (null when unresolved); items are " +
      "NOT filtered by direction here (this is the fuller pipeline view) — filter client-side.",
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
    .select(
      "post_id, mailbox, subject, body_preview, from_email, received_at, has_attachments, pii_purged_at",
    )
    .eq("post_id", postId)
    .maybeSingle();
  if (emailErr) throw new Error(`emails read failed: ${emailErr.message}`);
  if (!email) return { found: false, post_id: postId };

  // PAGINATED: a single email can carry >1000 attachments (PostgREST 1000-row
  // cap), so an unpaginated read would silently truncate the attachment list and
  // undercount the status summary. fetchAllRows loops .range() to the last page
  // under a total order on the `id` PK so a multi-page attachment set cannot drop
  // a work-order PDF mid-list.
  const atts = await fetchAllRows<any>(
    () =>
      client.from("email_attachments")
        .select(
          "id, graph_attachment_id, name, content_type, size_bytes, status, attachment_kind",
        )
        .eq("email_id", postId),
    "email_attachments read",
    "id",
  );

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
    throw new ApiBadRequest(
      "attachment_id, or (post_id and graph_attachment_id), required",
    );
  }

  let q = client.from("email_attachments")
    .select(
      "id, email_id, graph_attachment_id, status, storage_path, name, content_type",
    );
  if (attachment_id) {
    q = q.eq("id", attachment_id);
  } else {
    q = q.eq("email_id", post_id).eq(
      "graph_attachment_id",
      graph_attachment_id,
    );
  }
  const { data: att, error: attErr } = await q.maybeSingle();
  if (attErr) {
    throw new Error(`email_attachments read failed: ${attErr.message}`);
  }
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
  if (signErr) {
    throw new Error(`createSignedUrl failed: ${signErr.message ?? signErr}`);
  }

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
//
// Multi-row collision: one target_job can carry several pipeline_items rows
// (historical sync projections, duplicates). Input order must NEVER demote a
// stronger verdict to a weaker one — e.g. a later `not_sent` must not overwrite
// an earlier `verified_sent`. Rank is explicit and total for known statuses;
// unknown/intermediate strings keep honest intermediate strength (0) and never
// invent "sent" from mere row existence (null/empty sent_status is ignored).
export const PIPELINE_SENT_STATUS_RANK: Readonly<Record<string, number>> = {
  verified_sent: 3,
  needs_review: 2,
  not_sent: 1,
};

/** Pure merge: keep the stronger sent_status; on equal rank keep the first. */
export function preferPipelineSentStatus(
  current: string | undefined | null,
  next: string | null | undefined,
): string | undefined {
  if (!next) return current ?? undefined;
  if (!current) return next;
  const cr = PIPELINE_SENT_STATUS_RANK[current] ?? 0;
  const nr = PIPELINE_SENT_STATUS_RANK[next] ?? 0;
  if (nr > cr) return next;
  return current;
}

export async function buildPipelineSentStatusMap(
  client: SB,
  jobIds: string[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  if (!jobIds.length) return map;
  // Chunk the job-id .in() list AND paginate each chunk (1000-row cap). The
  // shared reader appends the `id` PK as the unique page key so a multi-row
  // collision per target_job cannot vanish on a page boundary.
  const data = await fetchAllRowsInChunks<any>(
    jobIds,
    (ch) =>
      client.from("pipeline_items").select("target_job, sent_status").in(
        "target_job",
        ch,
      ),
    "pipeline_items (sent_status by job) read",
    "id",
  );
  for (const p of (data || [])) {
    if (!p?.target_job || !p.sent_status) continue; // mere row existence ≠ sent
    const preferred = preferPipelineSentStatus(
      map[p.target_job],
      p.sent_status,
    );
    if (preferred) map[p.target_job] = preferred;
  }
  return map;
}

// ── internal: batched attachment summary load (GAP-5) ──
// One email can have MANY attachments, so the 1000-row RESULT cap can truncate
// even for far fewer than 1000 emails. Chunk the email_id .in() list AND paginate
// each chunk so every attachment row is counted.
async function loadAttachmentSummaries(
  client: SB,
  postIds: string[],
): Promise<Record<string, AttachmentStatusSummary>> {
  if (!postIds.length) return {};
  // Total order on attachment `id` so multi-page attachment sets cannot undercount
  // status (WO PDF reading as absent / attachment-free).
  const rows = await fetchAllRowsInChunks<
    { email_id?: string | null; status?: string | null }
  >(
    postIds,
    (ch) =>
      client.from("email_attachments").select("email_id, status").in(
        "email_id",
        ch,
      ),
    "email_attachments (status summary) read",
    "id",
  );
  return buildAttachmentSummaries(rows);
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
export const _preferPipelineSentStatus = preferPipelineSentStatus;
export const _fetchAllRowsInChunks = fetchAllRowsInChunks;
export const _chunkByUrlBudget = chunkByUrlBudget;
export const _encodedIdCost = encodedIdCost;
export const _isOwnDomain = isOwnDomain;
export const _directionForDomain = directionForDomain;
