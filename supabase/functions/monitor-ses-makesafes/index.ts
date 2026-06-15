// ════════════════════════════════════════════════════════════
// MONITOR-SES-MAKESAFES — group-poll ingestion for the make-safe sync engine
// Mission: makesafe-live-truth-2026-06-14 (Phase 1: schema + ingestion + attachments)
// ════════════════════════════════════════════════════════════
//
// Polls the ses@secureworkswa.com.au M365 GROUP via the Graph Groups
// conversations/threads/posts API, classifies each post (make-safe or not),
// idempotently upserts the make-safe ones into the event-sourced schema, fetches
// + stores PDF attachment bytes in a PRIVATE Storage bucket, and projects
// pipeline_items for the skills/board to read.
//
// Phase 1 scope ONLY. Reconciliation (D1-D4), the canary, and the dedicated
// attachment-retry worker are the NEXT phase. Where a Phase-2 concern is touched
// (e.g. retry, target-job match), it is best-effort and marked TODO.
//
// Hard rules honoured here (per MISSION.md):
//   - /groups/ path only (NEVER /users/ on a group — "Group Shard" error).
//   - @odata.nextLink exhaustion at EVERY level; page counts logged.
//   - Overlapping watermark (>= last_completed_max - overlap), NOT strict gt.
//   - Watermark persisted ONLY after a full successful page drain.
//   - ON CONFLICT (post_id) DO UPDATE; no nullable composite conflict key.
//   - Excluded posts ALWAYS write an audit row; never silently dropped.
//   - Attachment BYTES never returned, never logged.
//   - sync_state.mode = DEGRADED while any attachment pending/failed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGraphToken } from "../_shared/graph_client.ts";
// SINGLE SOURCE OF TRUTH for ref prefixes + normalisation, shared with the
// reconciler (ops-api/makesafe_reconcile.ts) so the email side and the board side
// can never drift on which prefixes / normal forms are recognised. The local
// copies that used to live in this file are DELETED — this is the only definition.
import {
  buildSubjectRef,
  extractRef,
  extractRefPrefixes as sharedExtractRefPrefixes,
  loadRefPrefixes,
  normaliseRef,
  REF_PREFIX_FLOOR,
} from "../_shared/makesafe_refs.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SERVICE_KEY")!;
const SW_API_KEY = Deno.env.get("SW_API_KEY") || "";

// Test-only seam: the handler builds its Supabase client via this indirection so a
// Deno test can inject a stub client (createClient is an esm.sh import that cannot be
// stubbed otherwise). Production leaves it null and the real createClient is used.
// deno-lint-ignore no-explicit-any
let _testClientFactory: ((url: string, key: string) => any) | null = null;
// deno-lint-ignore no-explicit-any
function _setTestClientFactory(f: ((url: string, key: string) => any) | null): void {
  _testClientFactory = f;
}

// ── AUTH HELPERS ────────────────────────────────────────────────────────────
// This function is deployed with verify_jwt ON: the Supabase gateway
// cryptographically verifies the JWT signature BEFORE our handler runs. So when a
// Bearer token reaches our code at all, its signature is already proven valid — we
// only need to authorize on the *claims*, not re-verify the signature ourselves.
//
// Why this matters: the pg_cron trigger (trigger_monitor_ses_makesafes ->
// _sw_service_key()) calls us with `Authorization: Bearer <a valid service-role
// JWT>`. That JWT is signature-valid but does NOT byte-equal the function's injected
// SUPABASE_SERVICE_ROLE_KEY (the keys can be rotated/differ), so an exact-string
// match silently 401s the CRON and the sync never runs. Authorizing on the decoded
// `role` claim (== "service_role") lets the cron bearer through while still rejecting
// an anon JWT (role == "anon").

// Decode (NOT verify) a JWT's payload and return its `role` claim, or null on any
// failure. Signature verification is the gateway's job (verify_jwt on); we just read
// the middle segment. Any malformed/garbage token returns null -> not authorized.
function decodeJwtRole(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // base64url -> base64, pad, decode, JSON.parse.
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const json = atob(b64);
    const payload = JSON.parse(json);
    return typeof payload?.role === "string" ? payload.role : null;
  } catch (_) {
    return null;
  }
}

// Authorize a request. Accept if ANY of:
//   (a) x-api-key === expectedApiKey (manual ops invoke), OR
//   (b) Bearer === expectedServiceKey (fast path: exact injected service key), OR
//   (c) Bearer is a JWT whose decoded `role` claim === "service_role" (the pg_cron
//       _sw_service_key() path — signature already verified by the gateway).
// Everything else (anon JWT, garbage bearer, no creds) is rejected.
function isAuthorized(
  req: Request,
  expectedServiceKey: string,
  expectedApiKey: string,
): boolean {
  const apiKey = req.headers.get("x-api-key") || "";
  if (!!expectedApiKey && apiKey === expectedApiKey) return true; // (a)

  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!bearer) return false;
  if (!!expectedServiceKey && bearer === expectedServiceKey) return true; // (b)
  return decodeJwtRole(bearer) === "service_role"; // (c)
}

const SES_GROUP_MAIL = "ses@secureworkswa.com.au";
const MAILBOX = SES_GROUP_MAIL; // mailbox key in mail_sync_cursors / sync_state
const STORAGE_BUCKET = "makesafe-emails";
const GRAPH = "https://graph.microsoft.com/v1.0";

// Projection / extractor versions — stamped on pipeline_items for rebuildability.
const EXTRACTOR_VERSION = "v1";
const MATCHER_VERSION = "v1";

// HARD decode safety cap (memory guard) for inline PDF bytes. This is NOT the
// business size cap: a PDF that carries inline contentBytes is uploaded regardless
// of ordinary size. This only stops the edge isolate from decoding a pathological
// blob. Graph's own ~4MB inline cap means PDFs above it arrive WITHOUT contentBytes
// (handled separately as needs_review), so this rarely if ever triggers.
const INLINE_BYTES_LIMIT = 25 * 1024 * 1024;

// ════════════════════════════════════════════════════════════
// Types (minimal Graph shapes we read)
// ════════════════════════════════════════════════════════════
interface GraphFrom {
  emailAddress?: { address?: string; name?: string };
}
// GROUP CONVERSATION POST (microsoft.graph.post). RESOLVED: group posts do NOT
// carry `subject` or `internetMessageId` — requesting `subject` in $select 400s
// ("Could not find a property named 'subject' on type
// 'Microsoft.OutlookServices.Post'"). The SUBJECT lives on the parent THREAD as
// `topic`; collectPosts threads that topic into `subject` below so the classifier /
// persistence contract (which reads post.subject) is unchanged. internetMessageId
// is not available on group posts at all, so dedup is on post.id only.
interface GraphPost {
  id: string;
  conversationId?: string;
  conversationThreadId?: string;
  createdDateTime?: string;
  receivedDateTime?: string;
  from?: GraphFrom;
  sender?: GraphFrom;
  // NOT requested from Graph (not a valid Post property). Populated by collectPosts
  // from the parent thread's `topic`. Read by classifyPost / persistPost.
  subject?: string;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
  newParticipants?: unknown;
  // Thread-sourced recipient signals, threaded down from conversationThread
  // (toRecipients/ccRecipients live on the THREAD, not the post).
  toRecipients?: GraphFrom[];
  ccRecipients?: GraphFrom[];
}

// GROUP CONVERSATION THREAD (microsoft.graph.conversationThread). These ARE valid
// thread properties: id, topic (the subject), lastDeliveredDateTime, hasAttachments,
// toRecipients, ccRecipients. `topic` is the subject source for every post under it.
interface GraphThread {
  id: string;
  topic?: string;
  lastDeliveredDateTime?: string;
  hasAttachments?: boolean;
  toRecipients?: GraphFrom[];
  ccRecipients?: GraphFrom[];
}
interface GraphAttachment {
  id?: string;
  "@odata.type"?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
}

interface CompanyPattern {
  slug: string;
  name: string;
  pattern: string;
}

// B1 — the loaded company set, plus the data-driven ref-prefix set derived from
// every active company's parsing_rules.ref_prefixes (unioned with the static
// floor). The handler threads `refPrefixes` into classifyPost so a company-defined
// ref family is recognised without a code change.
interface LoadedCompanies {
  patterns: CompanyPattern[];
  refPrefixes: string[];
}

// ════════════════════════════════════════════════════════════
// Exhaustive paginated GET — follow @odata.nextLink until drained.
// Returns all collected values + the page count (for logging / page_meta).
// ════════════════════════════════════════════════════════════
// M3 — bounded 429 retry budget. The old loop retried 429s with `continue`
// forever; a sustained throttle would hang the run (and the lock) indefinitely.
// We cap retries per URL AND across the whole traversal, with exponential backoff
// on top of Retry-After, and throw (degrade, not corrupt) once exhausted.
const MAX_429_RETRIES_PER_URL = 5;
const MAX_429_RETRIES_TOTAL = 20;
const MAX_BACKOFF_SECONDS = 60;

async function graphGetAll<T>(
  firstUrl: string,
  token: string,
  budget?: { total: number },
): Promise<{ values: T[]; pages: number }> {
  // Shared budget lets a multi-URL traversal share one total cap; default a fresh
  // one for standalone calls.
  const b = budget ?? { total: MAX_429_RETRIES_TOTAL };
  const values: T[] = [];
  let url: string | null = firstUrl;
  let pages = 0;
  while (url) {
    let urlRetries = 0;
    // Retry loop for the CURRENT url (handles repeated 429 on the same page).
    for (;;) {
      const resp: Response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.status === 429) {
        if (urlRetries >= MAX_429_RETRIES_PER_URL || b.total <= 0) {
          throw new Error(
            `Graph 429 retry budget exhausted for ${url} ` +
            `(url_retries=${urlRetries}, total_remaining=${b.total})`,
          );
        }
        urlRetries++;
        b.total--;
        const retryAfter = Number(resp.headers.get("Retry-After") || "5");
        // Exponential backoff on top of Retry-After, capped.
        const backoff = Math.min(
          Math.max(retryAfter, 2 ** urlRetries),
          MAX_BACKOFF_SECONDS,
        );
        console.log(`[monitor-ses] 429 throttled; backing off ${backoff}s (retry ${urlRetries})`);
        await new Promise((r) => setTimeout(r, backoff * 1000));
        continue; // re-fetch same url
      }
      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Graph GET failed ${resp.status} for ${url}: ${err}`);
      }
      const data: { value?: T[]; "@odata.nextLink"?: string } = await resp.json();
      pages++;
      for (const v of (data.value || [])) values.push(v);
      url = data["@odata.nextLink"] || null;
      break; // move to next page (or exit while if null)
    }
  }
  return { values, pages };
}

// ════════════════════════════════════════════════════════════
// Resolve the M365 group id at runtime by mail. NEVER use /users/ on a group.
// ════════════════════════════════════════════════════════════
async function resolveGroupId(token: string): Promise<string> {
  const url = `${GRAPH}/groups?$filter=` +
    encodeURIComponent(`mail eq '${SES_GROUP_MAIL}'`) +
    `&$select=id,mail,displayName`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Group resolution failed ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  const groups = (data.value || []) as Array<{ id?: string }>;
  // N4 — require EXACTLY ONE group for this mail. Zero = misconfiguration; more
  // than one = ambiguous (we must not silently poll an arbitrary first match and
  // ingest the wrong mailbox's mail). Fail closed in both cases.
  if (groups.length === 0 || !groups[0]?.id) {
    throw new Error(`No M365 group found for mail ${SES_GROUP_MAIL}`);
  }
  if (groups.length > 1) {
    throw new Error(
      `Ambiguous group resolution: ${groups.length} groups match mail ${SES_GROUP_MAIL}`,
    );
  }
  return groups[0].id as string;
}

// ════════════════════════════════════════════════════════════
// sha256 hex of a string (envelope fingerprint; NON-PII hash).
// ════════════════════════════════════════════════════════════
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// sha256 hex of raw bytes (for attachment dedup). Bytes never logged.
async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ════════════════════════════════════════════════════════════
// Classifier — decide if a post is a make-safe email.
// Inclusion: sender matches a company sender_pattern OR subject has a ref/keyword.
// Returns {include, reason, ref, company}. Never silently drops — caller writes
// an exclusion audit row when include=false.
// ════════════════════════════════════════════════════════════
// B1 — the make-safe ref-prefix set is DATA-DRIVEN from makesafe_companies (the
// same source the classifier uses for sender patterns), so a new builder ref
// format added to a company's parsing_rules.ref_prefixes cannot silently
// reintroduce the dropped-ref bug.
//
// The prefix floor, buildSubjectRef, normaliseRef, and extractRef ALL now live in
// the shared module ../_shared/makesafe_refs.ts (the SINGLE source of truth used
// by BOTH this monitor and the reconciler). They are imported above; the local
// copies that used to live here are DELETED so the two sides can never diverge.
// DEFAULT_REF_PREFIXES is kept as a thin alias for the shared floor for the
// underscore-prefixed test export.
const DEFAULT_REF_PREFIXES = REF_PREFIX_FLOOR;
const SUBJECT_KEYWORD = /make\s*safe|work\s*order/i;

// N1 — extract the sender domain (lowercased) from an email address. Used for
// anchored/boundary matching instead of fromEmail.includes(pattern), which
// over-matches (e.g. pattern "mlb.com" hits "notmlb.com.evil.test").
function parseSenderDomain(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

// N1 — does the sender domain match a company pattern with a proper boundary?
// A pattern matches when it equals the domain OR is a dot-anchored suffix of it
// (so "mlb.com.au" matches "noreply.mlb.com.au" but NOT "evilmlb.com.au"). If the
// pattern itself looks like a full address (contains '@'), match the whole address.
function senderMatchesPattern(fromEmail: string, pattern: string): boolean {
  const p = pattern.toLowerCase().trim();
  if (!p) return false;
  if (p.includes("@")) return fromEmail === p;
  const domain = parseSenderDomain(fromEmail);
  if (!domain) return false;
  return domain === p || domain.endsWith(`.${p}`);
}

function classifyPost(
  post: GraphPost,
  companies: CompanyPattern[],
  // B1 — the data-driven ref-prefix set (union of the static floor and every
  // company's parsing_rules.ref_prefixes). Defaults to the floor so pure callers
  // / tests still recognise MLB/AJBR/MS without wiring the company set.
  prefixes: readonly string[] = DEFAULT_REF_PREFIXES,
): { include: boolean; reason: string; ref: string | null; company: CompanyPattern | null } {
  const fromEmail =
    (post.from?.emailAddress?.address || post.sender?.emailAddress?.address || "")
      .toLowerCase();
  const subject = post.subject || "";

  let matchedCompany: CompanyPattern | null = null;
  for (const c of companies) {
    // N1 — anchored domain-boundary match, not substring includes().
    if (senderMatchesPattern(fromEmail, c.pattern)) {
      matchedCompany = c;
      break;
    }
  }
  const subjectRefMatch = subject.match(buildSubjectRef(prefixes));
  const subjectKeyword = SUBJECT_KEYWORD.test(subject);

  // B1 — extract the ref from the FULL subject (prefixed OR bare-numeric) with a
  // body fallback, so a make-safe post is NEVER persisted with ref=null. A null
  // ref previously skipped the pipeline_items projection, leaving the post
  // invisible to D1 while D2 saw the email present -> a real dropped intake
  // evaded BOTH checks. Now bare/spaced/compact refs get a non-null ref + a row.
  const body = post.body?.content || null;
  const ref = extractRef(subject, body, prefixes);

  if (matchedCompany) {
    return { include: true, reason: `sender:${matchedCompany.slug}`, ref, company: matchedCompany };
  }
  if (subjectRefMatch) {
    return { include: true, reason: "subject_ref", ref, company: null };
  }
  if (subjectKeyword) {
    return { include: true, reason: "subject_keyword", ref, company: null };
  }
  return {
    include: false,
    reason: fromEmail ? `no_sender_or_subject_match:${fromEmail}` : "no_match",
    ref: null,
    company: null,
  };
}

// ════════════════════════════════════════════════════════════
// Attachment handling. Validates PDF magic bytes, sha256-dedups, uploads PDFs to the
// PRIVATE bucket, inserts an email_attachments row. Classification by TYPE (never
// inline-ness): reference/item -> needs_review (BLOCKING); non-PDF files incl inline
// images -> skipped (benign, NON-blocking, audit-only); PDF without inline bytes or
// over the decode cap -> needs_review (BLOCKING); valid PDF (even inline) -> uploaded;
// any genuine failure -> failed. Nothing is silently dropped. Returns the count of
// still-unresolved (pending/failed/needs_review) rows — `skipped` and `uploaded` are
// resolved — which drives the DEGRADED mode.
// ════════════════════════════════════════════════════════════
function isPdfMagic(bytes: Uint8Array): boolean {
  // "%PDF" = 0x25 0x50 0x44 0x46
  return bytes.length >= 4 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 &&
    bytes[2] === 0x44 && bytes[3] === 0x46;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// B5 — the attachment upsert conflict target is (email_id, graph_attachment_id),
// a NON-NULL key that holds even before sha256 is known (pending/needs_review/
// failed rows). Every write error is checked and surfaced. N3 — every row carries
// attempts+1 + last_error on a failed/needs_review write.
async function upsertAttachmentRow(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
  // deno-lint-ignore no-explicit-any
  row: Record<string, any>,
): Promise<{ error: { message: string } | null }> {
  return await sb.from("email_attachments").upsert(row, {
    onConflict: "email_id,graph_attachment_id",
  });
}

// N3 — count prior attempts for this attachment so we can increment, not reset.
async function priorAttempts(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
  emailId: string,
  graphAttachmentId: string,
): Promise<number> {
  const { data } = await sb.from("email_attachments")
    .select("attempts")
    .eq("email_id", emailId)
    .eq("graph_attachment_id", graphAttachmentId)
    .maybeSingle();
  return (data as { attempts?: number } | null)?.attempts ?? 0;
}

async function processAttachments(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
  token: string,
  groupId: string,
  post: GraphPost,
): Promise<number> {
  if (!post.hasAttachments) return 0;

  // Fetch the post's attachments via $expand=attachments on the post itself.
  // IMPORTANT (root cause of the 75/75 live failure): the direct sub-resource list
  // `GET /groups/{id}/threads/{tid}/posts/{pid}/attachments` is DELEGATED-ONLY in
  // Graph v1.0 — it is NOT supported for Application (client_credentials) tokens,
  // which is what _shared/graph_client.ts mints, so it 4xxs for every group post.
  // `GET .../posts/{pid}?$expand=attachments` IS app-only supported and returns the
  // SAME fileAttachment objects with inline contentBytes, so the per-attachment
  // loop below is unchanged. On failure we record the REAL Graph status/body — the
  // old opaque "attachment_list_fetch_failed" label hid it and made this
  // undiagnosable. (Make-safe WO emails carry a handful of PDFs; $expand returns
  // them all for a single post — no pagination needed at this volume.)
  const expandUrl =
    `${GRAPH}/groups/${groupId}/threads/${post.conversationThreadId}/posts/${post.id}?$expand=attachments`;
  let attachments: GraphAttachment[] = [];
  let listOk = false;
  let fetchError = "";
  try {
    const resp = await fetch(expandUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Graph GET failed ${resp.status} for ${expandUrl}: ${body.slice(0, 300)}`);
    }
    const data = await resp.json() as { attachments?: GraphAttachment[] };
    attachments = data.attachments || [];
    listOk = true;
    console.log(
      `[monitor-ses] post ${post.id}: ${attachments.length} attachments (expand)`,
    );
  } catch (e) {
    fetchError = (e as Error).message;
    console.error(
      `[monitor-ses] attachment expand fetch failed for ${post.id}: ${fetchError}`,
    );
  }

  if (!listOk) {
    // The $expand fetch failed — leave the email DEGRADED. Record a placeholder
    // using a synthetic graph_attachment_id (the non-null key) so the retry worker
    // re-tries and the row is idempotent across polls. last_error now carries the
    // REAL Graph status/body for diagnosis.
    const synthetic = "_list_fetch_failed";
    const attempts = (await priorAttempts(sb, post.id, synthetic)) + 1;
    const realErr = `attachment_list_fetch_failed: ${fetchError}`.slice(0, 1000);
    const { error } = await upsertAttachmentRow(sb, {
      email_id: post.id,
      graph_attachment_id: synthetic,
      name: null,
      status: "failed",
      attachment_kind: "unknown",
      last_error: realErr,
      attempts,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      // HIGH (silent-drop window): the fetch already failed AND we could not even
      // record the failed placeholder. If we logged-and-returned here, the run
      // would report success and the watermark would advance past a post whose
      // attachment failure left NO durable record — a silent drop. FAIL CLOSED:
      // throw so the run returns non-success and does NOT advance the watermark
      // (the same window is retried next cycle). Never a no-record continue.
      throw new Error(
        `attachment expand fetch failed AND failed-placeholder upsert failed for ${post.id}: ` +
        `fetch_error=${fetchError}; upsert_error=${error.message}`,
      );
    }
    return 1;
  }

  // HIGH (silent-drop window): hasAttachments=true but Graph returned a SUCCESSFUL
  // EMPTY list. Pre-fix the for-loop below simply did not run and we returned 0 ->
  // no durable row, watermark advances, attachment silently lost. Write a synthetic
  // needs_review row (non-null graph_attachment_id) and count it as unresolved so it
  // is seen by the refreshSyncState backlog count -> DEGRADED -> blocks verified ->
  // the retry worker re-checks. Never a no-record return.
  if (attachments.length === 0) {
    const synthetic = "_hasattachments_true_empty_list";
    const attempts = (await priorAttempts(sb, post.id, synthetic)) + 1;
    const { error } = await upsertAttachmentRow(sb, {
      email_id: post.id,
      graph_attachment_id: synthetic,
      name: null,
      status: "needs_review",
      attachment_kind: "unknown",
      last_error: "hasAttachments_true_but_empty_list",
      attempts,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      // Same fail-closed contract as the list-fetch placeholder: if even the
      // synthetic row cannot be recorded, throw rather than silently drop.
      throw new Error(
        `hasAttachments=true empty-list synthetic upsert failed for ${post.id}: ${error.message}`,
      );
    }
    return 1;
  }

  let unresolved = 0;
  for (const att of attachments) {
    const kind = (att["@odata.type"] || "").split(".").pop() || "unknown";
    const isFileAttachment = kind === "fileAttachment";
    const isInline = att.isInline === true;
    const isPdfByType = (att.contentType || "").includes("pdf") ||
      (att.name || "").toLowerCase().endsWith(".pdf");

    // B5 — graph_attachment_id is the non-null key. If Graph omits it (shouldn't
    // happen for real attachments), synthesise a stable per-post fallback so the
    // conflict target is never null. Bytes hash later fills sha256.
    const gaid = att.id || `_noid_${kind}_${(att.name || "unnamed")}`;
    const attempts = (await priorAttempts(sb, post.id, gaid)) + 1;

    // STATUS SEMANTICS (2026-06-15): `skipped` is a TERMINAL, NON-BLOCKING record —
    // an attachment we deliberately do NOT capture (benign), kept only for audit.
    // `needs_review` is TERMINAL but BLOCKING — a human must look (it may hide a real
    // work order). Both monitor.refreshSyncState and ops-api reconcile count
    // (pending|failed|needs_review) as the unresolved backlog and EXCLUDE `skipped`,
    // so benign attachments never keep the board DEGRADED while a genuinely-missing
    // PDF still blocks the verified gate. `skipped` rows do NOT increment `unresolved`.

    // ORDER MATTERS. Classify by TYPE first, never by inline-ness: an inline check
    // must NOT pre-empt these branches, or an inline PDF work order (a real WO) would
    // be silently skipped, and an inline reference/item that could hide a WO would be
    // dropped. So: (1) non-file -> block; (2) non-PDF file -> skip (this is where
    // inline IMAGES land, benign); (3) PDF (even inline) -> capture below.

    // referenceAttachment / itemAttachment (a OneDrive link or an attached Outlook
    // item) -> needs_review (BLOCKING), regardless of inline-ness. These can hide a
    // real work order (a WO shared by link, or a forwarded email carrying the PDF),
    // so a human must check.
    if (!isFileAttachment) {
      const { error } = await upsertAttachmentRow(sb, {
        email_id: post.id,
        graph_attachment_id: gaid,
        name: att.name || null,
        content_type: att.contentType || null,
        size_bytes: att.size || null,
        status: "needs_review",
        attachment_kind: kind,
        last_error: `unsupported_attachment_kind:${kind}`,
        attempts,
        updated_at: new Date().toISOString(),
      });
      if (error) {
        throw new Error(`needs_review attachment upsert failed for ${post.id}/${gaid}: ${error.message}`);
      }
      unresolved++;
      // TODO(Phase 2): emit Telegram needs_review alert for this attachment.
      continue;
    }

    // PDF-ONLY policy (Marnin 2026-06-15): only PDFs are stored in this private
    // bucket. Non-PDF FILE attachments -> skipped (benign, auditable, NOT downloaded,
    // NOT blocking). This is where inline IMAGES (logos/signatures, contentType
    // image/*) land — they are non-PDF file attachments. An inline PDF does NOT land
    // here; it falls through to the PDF capture below. This check is BEFORE the
    // size/bytes branches so a large NON-PDF (e.g. a 5 MB JPG) classifies as non-PDF,
    // not mislabelled as a "large attachment" needing the value path.
    if (!isPdfByType) {
      const { error } = await upsertAttachmentRow(sb, {
        email_id: post.id,
        graph_attachment_id: gaid,
        name: att.name || null,
        content_type: att.contentType || null,
        size_bytes: att.size || null,
        status: "skipped",
        attachment_kind: isInline ? "inline" : "fileAttachment",
        last_error: isInline ? "inline_attachment_skipped" : "non_pdf_file_attachment_skipped",
        attempts,
        updated_at: new Date().toISOString(),
      });
      if (error) {
        throw new Error(`skipped(non-pdf) upsert failed for ${post.id}/${gaid}: ${error.message}`);
      }
      continue; // resolved-as-skipped: NOT unresolved
    }

    // PDF without inline contentBytes — Graph omits contentBytes for fileAttachments
    // above its inline cap (~4 MB). Fetching those bytes needs the /attachments/{id}
    // /$value path, which is the SAME /attachments sub-resource that is
    // DELEGATED-ONLY (app-only unsupported) — so it cannot be retrieved with this
    // function's app-only token. Record needs_review (visible, NOT lost) and defer.
    // No such case in the live 7-day sample; revisit the auth model if large inbound
    // WO PDFs ever appear.
    if (!att.contentBytes) {
      const { error } = await upsertAttachmentRow(sb, {
        email_id: post.id,
        graph_attachment_id: gaid,
        name: att.name || null,
        content_type: att.contentType || null,
        size_bytes: att.size || null,
        status: "needs_review",
        attachment_kind: "fileAttachment",
        last_error: "pdf_no_inline_bytes_value_path_required",
        attempts,
        updated_at: new Date().toISOString(),
      });
      if (error) {
        throw new Error(`pdf-no-bytes upsert failed for ${post.id}/${gaid}: ${error.message}`);
      }
      unresolved++;
      continue;
    }

    // Memory guard: contentBytes IS present but the file is absurdly large — do not
    // decode it in the edge isolate. INLINE_BYTES_LIMIT is a HARD decode safety cap
    // (a memory guard, NOT the business size cap: a PDF with inline bytes uploads
    // regardless of ordinary size). In practice Graph's own inline cap keeps this
    // from triggering; it exists only to protect the isolate from a pathological blob.
    if ((att.size || 0) > INLINE_BYTES_LIMIT) {
      const { error } = await upsertAttachmentRow(sb, {
        email_id: post.id,
        graph_attachment_id: gaid,
        name: att.name || null,
        content_type: att.contentType || null,
        size_bytes: att.size || null,
        status: "needs_review",
        attachment_kind: "fileAttachment",
        last_error: "pdf_exceeds_inline_decode_cap",
        attempts,
        updated_at: new Date().toISOString(),
      });
      if (error) {
        throw new Error(`pdf-oversize upsert failed for ${post.id}/${gaid}: ${error.message}`);
      }
      unresolved++;
      continue;
    }

    // Decode + validate PDF magic bytes. Bytes are never logged or returned.
    let bytes: Uint8Array;
    try {
      bytes = b64ToBytes(att.contentBytes);
    } catch {
      await markAttachmentFailed(sb, post.id, att, gaid, attempts, "base64_decode_failed");
      unresolved++;
      continue;
    }
    if (!isPdfMagic(bytes)) {
      await markAttachmentFailed(sb, post.id, att, gaid, attempts, "pdf_magic_byte_validation_failed");
      unresolved++;
      continue;
    }

    const sha = await sha256HexBytes(bytes);

    // Idempotent: if these exact bytes are already uploaded for this email, skip.
    const { data: existing } = await sb.from("email_attachments")
      .select("id, status")
      .eq("email_id", post.id)
      .eq("sha256", sha)
      .maybeSingle();
    if (existing && (existing as { status?: string }).status === "uploaded") {
      continue; // already resolved; not unresolved
    }

    // One Storage object per (email, sha). Path includes sha so identical bytes
    // re-uploaded are byte-identical and upsert is a no-op.
    const safeName = (att.name || "work-order.pdf").replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `${post.id}/${sha}_${safeName}`;
    const { error: upErr } = await sb.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, bytes, { contentType: "application/pdf", upsert: true });
    if (upErr) {
      await markAttachmentFailed(sb, post.id, att, gaid, attempts, `storage_upload_failed:${upErr.message}`);
      unresolved++;
      continue;
    }

    const { error: rowErr } = await upsertAttachmentRow(sb, {
      email_id: post.id,
      graph_attachment_id: gaid,
      name: att.name || null,
      content_type: att.contentType || "application/pdf",
      size_bytes: att.size || bytes.length,
      sha256: sha,
      storage_path: storagePath,
      status: "uploaded",
      attachment_kind: "fileAttachment",
      last_error: null,
      attempts,
      updated_at: new Date().toISOString(),
    });
    if (rowErr) {
      // M4 — the bytes uploaded but the row write failed -> an orphaned Storage
      // object with no tracking row. Delete the object we just wrote, then mark
      // the row failed so the retry worker re-attempts cleanly.
      console.error(`[monitor-ses] attachment row upsert failed for ${post.id}/${gaid}: ${rowErr.message}; deleting orphaned object`);
      try {
        await sb.storage.from(STORAGE_BUCKET).remove([storagePath]);
      } catch (e) {
        console.error(`[monitor-ses] orphan cleanup failed for ${storagePath}: ${(e as Error).message}`);
      }
      await markAttachmentFailed(sb, post.id, att, gaid, attempts, `row_upsert_failed:${rowErr.message}`);
      unresolved++;
      continue;
    }
    console.log(`[monitor-ses] stored attachment for post ${post.id} (sha ${sha.slice(0, 12)}…)`);
  }

  // Supersede stale synthetic placeholders. We reached here only when the list
  // fetch SUCCEEDED and returned real attachments (attachments.length > 0), so any
  // failure/empty placeholder from a PRIOR run is now stale. Without this, a single
  // transient list-fetch failure would leave a post permanently DEGRADED even after
  // a later successful poll. Idempotent: no-op when none exist. Cleanup failure is
  // logged but does NOT throw — it never drops real data, only fails to tidy.
  const { error: supersedeErr } = await sb.from("email_attachments")
    .delete()
    .eq("email_id", post.id)
    .in("graph_attachment_id", ["_list_fetch_failed", "_hasattachments_true_empty_list"]);
  if (supersedeErr) {
    console.error(
      `[monitor-ses] stale-placeholder supersede failed for ${post.id}: ${supersedeErr.message}`,
    );
  }

  return unresolved;
}

async function markAttachmentFailed(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
  emailId: string,
  att: GraphAttachment,
  graphAttachmentId: string,
  attempts: number,
  reason: string,
): Promise<void> {
  // B5 — error checked; N3 — attempts incremented + last_error recorded.
  const { error } = await upsertAttachmentRow(sb, {
    email_id: emailId,
    graph_attachment_id: graphAttachmentId,
    name: att.name || null,
    content_type: att.contentType || null,
    size_bytes: att.size || null,
    status: "failed",
    attachment_kind: "fileAttachment",
    last_error: reason,
    attempts,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    throw new Error(`markAttachmentFailed upsert failed for ${emailId}/${graphAttachmentId}: ${error.message}`);
  }
}

// ════════════════════════════════════════════════════════════
// Best-effort target-job match for the pipeline projection. Phase 1 keeps this
// thin: exact normalised external_ref against makesafe_job_details. Ambiguous /
// fuzzy matching is Phase 2 (D1 reconciliation). Returns {jobId, score, method}.
// ════════════════════════════════════════════════════════════
async function matchTargetJob(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
  ref: string | null,
): Promise<{ jobId: string | null; score: number; method: string }> {
  if (!ref) return { jobId: null, score: 0, method: "no_ref" };
  const { data } = await sb.from("makesafe_job_details")
    .select("job_id, external_ref")
    .ilike("external_ref", ref)
    .limit(2);
  if (data && data.length === 1 && (data[0] as { job_id?: string }).job_id) {
    return { jobId: (data[0] as { job_id: string }).job_id, score: 1, method: "exact_external_ref" };
  }
  // TODO(Phase 2): normalised candidate match with sender/date corroboration.
  return { jobId: null, score: 0, method: "no_exact_match" };
}

// ════════════════════════════════════════════════════════════
// Persist one make-safe post: emails upsert + email_events_raw append +
// attachments + pipeline_items projection. Returns unresolved attachment count.
// ════════════════════════════════════════════════════════════
async function persistPost(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
  token: string,
  groupId: string,
  post: GraphPost,
  cls: ReturnType<typeof classifyPost>,
): Promise<number> {
  const fromEmail = post.from?.emailAddress?.address ||
    post.sender?.emailAddress?.address || null;
  const fromName = post.from?.emailAddress?.name ||
    post.sender?.emailAddress?.name || null;
  const subject = post.subject || null;
  const bodyContent = post.body?.content || null;
  const bodyType = post.body?.contentType || null;
  const receivedAt = post.receivedDateTime || post.createdDateTime || null;
  const bodyPreview = bodyContent
    ? bodyContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)
    : null;

  // Envelope fingerprint (NON-PII): hash of stable identity fields only.
  const contentSha = await sha256Hex(
    `${post.id}|${receivedAt || ""}|${fromEmail || ""}|${subject || ""}`,
  );

  // 1) Idempotent upsert into emails ON CONFLICT (post_id).
  const { error: emailErr } = await sb.from("emails").upsert({
    post_id: post.id,
    mailbox: MAILBOX,
    // Group posts (microsoft.graph.post) do NOT expose internetMessageId — it is not
    // a valid Post property. Dedup is on post.id (post_id is the ON CONFLICT key); the
    // emails.internet_message_id partial-unique index is disabled and tolerates null.
    internet_message_id: null,
    conversation_id: post.conversationId || null,
    thread_id: post.conversationThreadId || null,
    from_email: fromEmail,
    from_name: fromName,
    to_recipients: null, // group posts have no per-recipient list; left null
    subject,
    body_preview: bodyPreview,
    body_content: bodyContent,
    body_content_type: bodyType,
    received_at: receivedAt,
    has_attachments: post.hasAttachments || false,
    content_sha256: contentSha,
    updated_at: new Date().toISOString(),
  }, { onConflict: "post_id" });
  if (emailErr) {
    throw new Error(`emails upsert failed for ${post.id}: ${emailErr.message}`);
  }

  // 2) Append a NON-PII audit row to email_events_raw.
  // B4 — this is a REQUIRED write. email_events_raw is the append-only replay log
  // that pipeline_items is rebuilt from; if this insert fails but the cursor still
  // advanced, the row would vanish from the replay set forever. Throw so the caller
  // aborts BEFORE the watermark commit (retry the same window next cycle).
  //
  // MEDIUM (idempotency) — a backfill re-run (or an overlapping-window re-poll) hits
  // the SAME post again. A plain insert would APPEND a duplicate 'created' audit row
  // for that post on every re-run, polluting the replay log (and pipeline_items'
  // source_event_ids provenance). Dedupe on the stable (post_id, change_type='created')
  // key: if an equivalent row already exists, REUSE its id instead of inserting a new
  // one. (The append-only contract is preserved for genuinely distinct events — the
  // D2 'inventory_scan' rows are a different change_type and are never deduped here.)
  const { data: existingEvent, error: existingEvErr } = await sb.from("email_events_raw")
    .select("id")
    .eq("post_id", post.id)
    .eq("change_type", "created")
    .maybeSingle();
  if (existingEvErr) {
    throw new Error(`email_events_raw dedupe read failed for ${post.id}: ${existingEvErr.message}`);
  }
  let eventId = (existingEvent as { id?: string } | null)?.id || null;
  if (!eventId) {
    const { data: eventRow, error: evErr } = await sb.from("email_events_raw").insert({
      mailbox: MAILBOX,
      post_id: post.id,
      change_type: "created",
      received_at: receivedAt,
      content_sha256: contentSha,
      extracted_ref: cls.ref,
      conversation_id: post.conversationId || null,
      thread_id: post.conversationThreadId || null,
      page_meta: {},
    }).select("id").single();
    if (evErr) {
      throw new Error(`email_events_raw insert failed for ${post.id}: ${evErr.message}`);
    }
    eventId = (eventRow as { id?: string } | null)?.id || null;
  }

  // 3) Attachments (decoupled DEGRADED contract).
  const unresolved = await processAttachments(sb, token, groupId, post);

  // 4) pipeline_items projection (rebuildable; stamped with versions + provenance).
  if (cls.ref) {
    const match = await matchTargetJob(sb, cls.ref);
    const { data: attRows } = await sb.from("email_attachments")
      .select("id").eq("email_id", post.id);
    const attachmentRefs = (attRows || []).map((a: { id: string }) => a.id);

    // M1 — a single (mailbox, ref) can be touched by multiple posts/polls. A
    // plain upsert OVERWRITES attachment_refs / source_event_ids, dropping the
    // evidence accumulated by earlier posts on the same ref. Read the existing
    // row and UNION the provenance arrays so earlier evidence is preserved.
    const { data: existing, error: exReadErr } = await sb.from("pipeline_items")
      .select("attachment_refs, source_event_ids")
      .eq("mailbox", MAILBOX)
      .eq("ref", cls.ref)
      .maybeSingle();
    if (exReadErr) {
      throw new Error(`pipeline_items read failed for ${cls.ref}: ${exReadErr.message}`);
    }
    const ex = (existing || {}) as {
      attachment_refs?: string[];
      source_event_ids?: string[];
    };
    const mergedAttachmentRefs = Array.from(
      new Set([...(ex.attachment_refs || []), ...attachmentRefs]),
    );
    const mergedSourceEventIds = Array.from(
      new Set([...(ex.source_event_ids || []), ...(eventId ? [eventId] : [])]),
    );

    const { error: piErr } = await sb.from("pipeline_items").upsert({
      ref: cls.ref,
      mailbox: MAILBOX,
      target_job: match.jobId,
      // Capture-only sees the post exists; "verified_sent" is a reconciliation
      // (Phase 2 / pack_sent_status) decision. Phase 1 records the email's
      // presence and leaves sent_status to the audit layer.
      sent_status: "needs_review",
      attachment_refs: mergedAttachmentRefs,
      match_score: match.score,
      match_method: match.method,
      extractor_version: EXTRACTOR_VERSION,
      matcher_version: MATCHER_VERSION,
      source_event_ids: mergedSourceEventIds,
      updated_at: new Date().toISOString(),
    }, { onConflict: "mailbox,ref" });
    if (piErr) {
      // B2/M2-adjacent: a failed projection write must not let the watermark
      // advance silently. Throw to abort before cursor commit.
      throw new Error(`pipeline_items upsert failed for ${cls.ref}: ${piErr.message}`);
    }
  }

  // 5) DONE MARKER (resumable backfill) — set LAST, only after the email row, events,
  // ALL attachments, and the pipeline projection were durably written without throwing.
  // The chunked backfill's done-detection keys off this flag (NOT mere email-row or
  // attachment-row existence — the FK forces the email row first, and a kill mid
  // attachment-loop leaves some rows but not all). A partially-written post stays
  // attachments_settled=false and is REPROCESSED next invoke — never skipped with PDFs
  // silently missing. The */5 poll sets it too (harmless; idempotent).
  const { error: settledErr } = await sb.from("emails")
    .update({ attachments_settled: true, updated_at: new Date().toISOString() })
    .eq("post_id", post.id);
  if (settledErr) {
    throw new Error(`attachments_settled marker write failed for ${post.id}: ${settledErr.message}`);
  }

  return unresolved;
}

// ════════════════════════════════════════════════════════════
// Excluded post -> audit rows (email_events_raw + email_classifier_exclusions).
// Never silently dropped.
// ════════════════════════════════════════════════════════════
async function auditExclusion(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
  post: GraphPost,
  reason: string,
): Promise<void> {
  // B7 — never store the raw sender address in this (un-purged) audit table.
  // Keep the domain (coarse non-PII hint) + a sha256 of the full address.
  const fromEmail = post.from?.emailAddress?.address ||
    post.sender?.emailAddress?.address || null;
  const fromDomain = parseSenderDomain(fromEmail);
  const fromEmailHash = fromEmail ? await sha256Hex(fromEmail.toLowerCase()) : null;
  const subjectHash = post.subject ? await sha256Hex(post.subject) : null;

  // B3 — the exclusion audit write is REQUIRED. If it fails, throw so the caller
  // aborts BEFORE the watermark is committed (otherwise an excluded post would
  // silently vanish while the cursor advanced past it). Nothing is dropped.
  //
  // MEDIUM (idempotency) — a backfill re-run / overlapping re-poll re-classifies the
  // SAME excluded post. A plain insert would append a duplicate 'excluded' audit row
  // each run. Dedupe on the stable (post_id, change_type='excluded') key: skip the
  // insert if an equivalent row already exists. (The classifier-exclusions row below
  // already upserts ON CONFLICT(post_id), so it was idempotent; this closes the gap
  // on the event-log side.)
  const { data: existingExcl, error: existingExclErr } = await sb.from("email_events_raw")
    .select("id")
    .eq("post_id", post.id)
    .eq("change_type", "excluded")
    .maybeSingle();
  if (existingExclErr) {
    throw new Error(`exclusion event dedupe read failed for ${post.id}: ${existingExclErr.message}`);
  }
  if (!existingExcl) {
    const { error: evErr } = await sb.from("email_events_raw").insert({
      mailbox: MAILBOX,
      post_id: post.id,
      change_type: "excluded",
      received_at: post.receivedDateTime || post.createdDateTime || null,
      exclusion_reason: reason,
      conversation_id: post.conversationId || null,
      thread_id: post.conversationThreadId || null,
      page_meta: {},
    });
    if (evErr) {
      throw new Error(`exclusion event insert failed for ${post.id}: ${evErr.message}`);
    }
  }
  const { error: exErr } = await sb.from("email_classifier_exclusions").upsert({
    post_id: post.id,
    mailbox: MAILBOX,
    from_domain: fromDomain,
    from_email_hash: fromEmailHash,
    subject_hash: subjectHash,
    exclusion_reason: reason,
  }, { onConflict: "post_id" });
  if (exErr) {
    throw new Error(`exclusion row upsert failed for ${post.id}: ${exErr.message}`);
  }
}

// B1 — pull VALIDATED ref prefixes out of a company's parsing_rules.ref_prefixes.
// Delegates to the shared module's validating extractor (the SINGLE source of
// truth) and returns just the valid tokens for back-compat with callers/tests
// that expect a plain string[]. Invalid prefixes (single-char, metachars, empty)
// are dropped by the shared validator (finding 4).
// deno-lint-ignore no-explicit-any
function extractRefPrefixes(parsingRules: any): string[] {
  return sharedExtractRefPrefixes(parsingRules).valid;
}

// ════════════════════════════════════════════════════════════
// Load active company sender patterns + data-driven ref prefixes.
// Reuse scanSesMakesafes approach for sender patterns; the ref-prefix set (B1) is
// loaded via the SHARED loadRefPrefixes (the SAME function the reconciler uses),
// so the email side and the board side derive an IDENTICAL prefix set from
// makesafe_companies.parsing_rules.ref_prefixes (unioned with the static floor).
// ════════════════════════════════════════════════════════════
async function loadCompanyPatterns(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
): Promise<LoadedCompanies> {
  const { data: companies, error } = await sb.from("makesafe_companies")
    .select("slug, name, sender_patterns, parsing_rules")
    .eq("active", true);
  // M6 — a failed company query previously fell through to an empty pattern set,
  // which silently degrades the classifier to subject-only matching (over- and
  // under-including). Fail the run instead so the next cycle retries with the
  // real pattern set; degrade, do not silently misclassify.
  if (error) {
    throw new Error(`makesafe_companies query failed: ${error.message}`);
  }
  const patterns: CompanyPattern[] = [];
  for (
    const co of (companies || []) as Array<
      { slug: string; name: string; sender_patterns: string[]; parsing_rules?: unknown }
    >
  ) {
    for (const p of (co.sender_patterns || [])) {
      patterns.push({ slug: co.slug, name: co.name, pattern: p.toLowerCase() });
    }
  }
  // B1 — the ref-prefix set comes from the SHARED loader (floor UNION validated
  // company prefixes), the identical call the reconciler's D1 uses. This is what
  // guarantees parity: a company-supplied prefix recognised on ingest is also
  // recognised on the board side.
  const refPrefixes = await loadRefPrefixes(sb);
  return { patterns, refPrefixes };
}

// ════════════════════════════════════════════════════════════
// Full traversal: conversations -> threads -> posts, @odata.nextLink exhausted
// at every level. Returns all posts within the overlapping window + page counts.
// ════════════════════════════════════════════════════════════
async function collectPosts(
  token: string,
  groupId: string,
  sinceIso: string,
): Promise<{ posts: GraphPost[]; pageCounts: { conversations: number; threads: number; posts: number } }> {
  const posts: GraphPost[] = [];
  let convPages = 0;
  let threadPages = 0;
  let postPages = 0;
  // M3 — one shared 429 budget for the whole traversal (conversations + threads +
  // posts), so a sustained throttle cannot loop indefinitely across many URLs.
  const budget = { total: MAX_429_RETRIES_TOTAL };

  // Conversations (top-level). Order newest first; we filter posts by window.
  const convUrl =
    `${GRAPH}/groups/${groupId}/conversations?$select=id,lastDeliveredDateTime&$orderby=lastDeliveredDateTime desc`;
  const conversations = await graphGetAll<{ id: string; lastDeliveredDateTime?: string }>(
    convUrl,
    token,
    budget,
  );
  convPages += conversations.pages;

  for (const conv of conversations.values) {
    // Threads under each conversation. The SUBJECT lives on the thread as `topic`
    // (it is NOT a Post property), so request topic + the other valid thread fields
    // (lastDeliveredDateTime, hasAttachments, toRecipients, ccRecipients on
    // microsoft.graph.conversationThread) and thread them down to each post.
    const threadUrl = `${GRAPH}/groups/${groupId}/conversations/${conv.id}/threads` +
      `?$select=id,topic,lastDeliveredDateTime,hasAttachments,toRecipients,ccRecipients`;
    const threads = await graphGetAll<GraphThread>(threadUrl, token, budget);
    threadPages += threads.pages;

    for (const thread of threads.values) {
      // Posts under each thread. Request ONLY valid microsoft.graph.post fields.
      // `subject` and `internetMessageId` are NOT Post properties (requesting
      // `subject` 400s); the subject comes from thread.topic, set on each post below.
      const postUrl =
        `${GRAPH}/groups/${groupId}/threads/${thread.id}/posts` +
        `?$select=id,createdDateTime,receivedDateTime,from,sender,hasAttachments,body,conversationId,conversationThreadId`;
      const threadPosts = await graphGetAll<GraphPost>(postUrl, token, budget);
      postPages += threadPosts.pages;

      for (const post of threadPosts.values) {
        // Ensure the thread id is available for the attachment endpoint.
        if (!post.conversationThreadId) post.conversationThreadId = thread.id;
        // SUBJECT = the thread topic. classifyPost / persistPost read post.subject;
        // ref extraction (MLB-/AJBR-/MS… refs) runs against this topic, with the post
        // body as a secondary ref source. emails.subject is stored as this topic.
        post.subject = thread.topic ?? "";
        // Recipient signals live on the thread, not the post — thread them down so
        // any To/Cc-based classification has them.
        if (thread.toRecipients) post.toRecipients = thread.toRecipients;
        if (thread.ccRecipients) post.ccRecipients = thread.ccRecipients;
        const ts = post.receivedDateTime || post.createdDateTime;
        // Overlapping window filter: include anything at/after the lower bound.
        if (!ts || ts >= sinceIso) posts.push(post);
      }
    }
  }
  return { posts, pageCounts: { conversations: convPages, threads: threadPages, posts: postPages } };
}

// ════════════════════════════════════════════════════════════
// Update sync_state mode based on outstanding attachments for this mailbox.
// ════════════════════════════════════════════════════════════
async function refreshSyncState(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
  ok: boolean,
  lastError: string | null,
): Promise<void> {
  // N2 — count unresolved attachments FOR THIS MAILBOX ONLY. email_attachments has
  // no mailbox column, so we join through emails (email_id -> emails.post_id) and
  // filter emails.mailbox = MAILBOX. Counting across all mailboxes (the old
  // behaviour) would falsely DEGRADE this mailbox on another mailbox's backlog.
  //
  // BACKLOG SEMANTICS: count pending|failed|needs_review as unresolved. `skipped`
  // (benign: inline images + non-PDF files under the PDF-only policy) is TERMINAL
  // and EXCLUDED — without it, every email's logo/photo kept the board permanently
  // DEGRADED so verified could never go true. needs_review STILL blocks (a real
  // problem a human must resolve: a missing PDF, a reference/item link that could
  // hide a WO, an empty list despite hasAttachments). This MUST match the ops-api
  // reconcile backlog query (makesafe_reconcile.ts) so monitor + gate agree.
  const { count, error: countErr } = await sb.from("email_attachments")
    .select("id, emails!inner(mailbox)", { count: "exact", head: true })
    .eq("emails.mailbox", MAILBOX)
    .in("status", ["pending", "failed", "needs_review"]);
  if (countErr) {
    throw new Error(`sync_state attachment count failed: ${countErr.message}`);
  }
  const pending = count || 0;

  let mode: "OK" | "DEGRADED" | "ERROR";
  if (!ok) mode = "ERROR";
  else if (pending > 0) mode = "DEGRADED";
  else mode = "OK";

  const now = new Date().toISOString();
  const { error: upErr } = await sb.from("sync_state").upsert({
    mailbox: MAILBOX,
    last_attempt_at: now,
    last_successful_sync_at: ok ? now : undefined,
    last_error: lastError,
    mode,
    pending_attachments: pending,
    updated_at: now,
  }, { onConflict: "mailbox" });
  if (upErr) {
    // M2 — surface the sync_state write failure rather than reporting a healthy
    // state that was never persisted.
    throw new Error(`sync_state upsert failed: ${upErr.message}`);
  }
}

// ════════════════════════════════════════════════════════════
// FULL HISTORICAL BACKFILL — one-shot, gated, manual (mode=backfill_full)
// ════════════════════════════════════════════════════════════
// Mission: makesafe-live-truth-2026-06-14 (the gated Phase-2 step the M7 first-run
// TODO promised). This is NOT the regular */5 poll. It is invoked explicitly with
// {mode:"backfill_full"} (POST body) or ?backfill=full, runs ONCE, and:
//
//   1. Traverses the ENTIRE ses@ group history (epoch -> backfill start time) with
//      @odata.nextLink exhaustion at EVERY level — reusing collectPosts, which
//      already drains every page. The recent-only lookback of the poll is REPLACED
//      here by an epoch lower bound so nothing old is filtered out.
//   2. Idempotently ingests through the SAME persistPost + processAttachments path,
//      so every fail-closed + durable-attachment-record invariant holds, and a
//      re-run never double-inserts (ON CONFLICT(post_id) / (email_id,graph_attach_id)
//      / (mailbox,ref)). Excluded posts ALWAYS write an audit row (auditExclusion).
//   3. Establishes the true coverage FLOOR (recon_inventory_floor = earliest
//      ingested receivedDateTime) and CEILING (recon_inventory_ceiling = now), so
//      the verified gate (combineVerifiedGate) can reflect true full-history
//      coverage. ONLY this full pass is allowed to set the historical floor.
//   4. ATOMICALLY commits the coverage FLOOR + CEILING, the backfill_complete
//      marker, AND the live cursor (mail_sync_cursors.last_completed_max) in ONE
//      transaction via the commit_makesafe_backfill RPC — the FINAL step. The cursor
//      is set to the backfill START time so the */5 poll takes over with NO GAP: the
//      poll's overlapping (>= start - overlap) window re-scans EVERYTHING that could
//      have arrived during the (long) backfill run. Backfill covered <= start..now
//      already, and the poll re-covers >= start, so the two windows OVERLAP — never
//      a gap.
//
// FAIL CLOSED + RESUMABLE: the floor, the ceiling, the backfill_complete marker, and
// the live cursor are committed in ONE all-or-nothing RPC transaction, ONLY after the
// full pass completes WITHOUT throwing. A partial/failed backfill (any persist/
// attachment/traversal throw, OR a failure inside the atomic commit) leaves NO floor,
// NO ceiling, NO completion marker, and NO live cursor — so recon_verified can NEVER
// read true over un-ingested history. (The verified gate also requires
// backfill_complete = true, so even a partially-written prior state cannot verify.)
// A re-run after a partial failure re-traverses from epoch and idempotently
// re-ingests; already-ingested posts upsert as no-ops, un-ingested ones are filled
// in, and only THEN is the atomic commit attempted. The advisory lock prevents it
// running concurrently with the poll (which would race the same cursor/rows).
//
// COST: it is a long run, and the full history can exceed ONE invoke's compute
// (photo-heavy emails return tens of MB of contentBytes via $expand -> the edge
// isolate OOMs with WORKER_RESOURCE_LIMIT). So the backfill is RESUMABLE ACROSS
// INVOKES: each invoke processes at most BACKFILL_MAX_POSTS_PER_INVOKE not-yet-done
// posts (persisting each idempotently), then returns {partial:true} if more remain.
// floor/ceiling/cursor are committed ONLY on the invoke that drains the LAST post, so
// a partial run never leaves a misleading floor. The driver re-invokes until
// partial=false. Conservative cap keeps each invoke well under the resource limit.
const BACKFILL_MAX_POSTS_PER_INVOKE = 40;

// PostgREST returns at most ~1000 rows per request. The chunked backfill's
// done-detection MUST see EVERY settled/excluded row each invoke — a truncated read
// makes already-done posts look not-done, re-burning the per-invoke budget so the
// backfill never converges (never commits). So all backfill-state reads paginate via
// .range() until a short page. eqFilters are applied to every page.
async function fetchAllRows(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
  table: string,
  columns: string,
  eqFilters: Array<[string, unknown]> = [],
): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(columns);
    for (const [c, v] of eqFilters) q = q.eq(c, v);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`fetchAll ${table} failed: ${error.message}`);
    const rows = (data || []) as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// A post is "already done" (handled by a prior invoke) when it has an exclusion row,
// OR an emails row with attachments_settled=true (the all-or-nothing done marker that
// persistPost sets LAST). Keying off the settled marker — NOT email-row existence (the
// FK forces it first) nor mere attachment-row existence (a kill mid-attachment-loop
// leaves some rows but not all) — is what makes the chunked backfill crash-safe: a
// partially-written post stays settled=false and is reprocessed, never silently skipped.
// Returns the two id sets the caller unions. BOTH reads are PAGINATED (see fetchAllRows)
// so the done-set is always complete — the loop's termination depends on it.
async function loadBackfillState(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
): Promise<{ settledIds: Set<string>; excludedIds: Set<string> }> {
  const settledIds = new Set<string>();
  const excludedIds = new Set<string>();
  const em = await fetchAllRows(sb, "emails", "post_id", [["mailbox", MAILBOX], ["attachments_settled", true]]);
  for (const r of em) settledIds.add(r.post_id as string);
  const ex = await fetchAllRows(sb, "email_classifier_exclusions", "post_id", []);
  for (const r of ex) excludedIds.add(r.post_id as string);
  return { settledIds, excludedIds };
}

// The coverage FLOOR for the atomic commit = earliest received_at across ALL ingested
// make-safe emails. Computed from the DB (not in-memory), because a chunked invoke
// never holds the whole history at once. Reads received_at for the mailbox and takes
// the MIN in code (the set is bounded — one-time backfill); the commit RPC then
// applies the widen-only rule server-side.
async function loadIngestedFloor(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
): Promise<string | null> {
  const rows = await fetchAllRows(sb, "emails", "received_at", [["mailbox", MAILBOX]]);
  let min: string | null = null;
  for (const r of rows) {
    const ts = r.received_at as string | null | undefined;
    if (ts && (!min || ts < min)) min = ts;
  }
  return min;
}

async function runBackfillFull(
  // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
  sb: any,
  // Injected so tests can stub the network/traversal layer without import.meta.main
  // binding a port. Production passes the real implementations.
  deps: {
    getGraphToken: () => Promise<string>;
    resolveGroupId: (token: string) => Promise<string>;
    loadCompanyPatterns: (
      // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
      sb: any,
    ) => Promise<LoadedCompanies>;
    collectPosts: (
      token: string,
      groupId: string,
      sinceIso: string,
    ) => Promise<{
      posts: GraphPost[];
      pageCounts: { conversations: number; threads: number; posts: number };
    }>;
    persistPost: (
      // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
      sb: any,
      token: string,
      groupId: string,
      post: GraphPost,
      cls: ReturnType<typeof classifyPost>,
    ) => Promise<number>;
    auditExclusion: (
      // deno-lint-ignore no-explicit-any -- supabase-js v2 untyped client (ops-api convention)
      sb: any,
      post: GraphPost,
      reason: string,
    ) => Promise<void>;
    // Wall clock, injectable for deterministic tests.
    nowIso?: string;
  },
): Promise<{
  success: boolean;
  group_id: string;
  partial: boolean;
  remaining: number;
  posts_seen: number;
  included: number;
  excluded: number;
  unresolved_attachments: number;
  page_counts: { conversations: number; threads: number; posts: number };
  inventory_floor: string | null;
  inventory_ceiling: string;
  committed_cursor: string;
  timestamp: string;
}> {
  // Capture the backfill START instant up front. The live cursor is committed to
  // this value at the end, so the */5 poll re-scans (start - overlap)..now and
  // cannot skip anything that arrived DURING the backfill run.
  const backfillStartIso = deps.nowIso || new Date().toISOString();

  const token = await deps.getGraphToken();
  const groupId = await deps.resolveGroupId(token);
  // Same data-driven classifier inputs as the poll (sender patterns + ref prefixes),
  // so historical posts are classified identically to live ones.
  const { patterns: companies, refPrefixes } = await deps.loadCompanyPatterns(sb);

  // Epoch lower bound — the WHOLE history. collectPosts drains every conversation/
  // thread/post page via @odata.nextLink; the >= epoch filter keeps everything.
  const sinceIso = new Date(0).toISOString();
  console.log(
    `[monitor-ses][backfill] FULL historical backfill start group=${groupId} ` +
      `since>=${sinceIso} (epoch) start=${backfillStartIso}`,
  );

  const { posts, pageCounts } = await deps.collectPosts(token, groupId, sinceIso);
  console.log(
    `[monitor-ses][backfill] traversal drained pages conv=${pageCounts.conversations} ` +
      `thread=${pageCounts.threads} post=${pageCounts.posts}; ${posts.length} posts total`,
  );

  // ── RESUMABLE CHUNKED PROCESSING. Skip posts a prior invoke already handled, then
  // process at most BACKFILL_MAX_POSTS_PER_INVOKE not-done posts. Each persistPost /
  // auditExclusion throw propagates (fail closed). If any not-done posts remain after
  // the cap, return {partial:true} WITHOUT committing coverage — the driver re-invokes.
  const { settledIds, excludedIds } = await loadBackfillState(sb);
  const isDone = (post: GraphPost): boolean =>
    excludedIds.has(post.id) || settledIds.has(post.id);

  let included = 0;
  let excluded = 0;
  let totalUnresolved = 0;
  let processedThisInvoke = 0;
  let remaining = 0;

  for (const post of posts) {
    if (isDone(post)) continue; // handled by a prior invoke
    if (processedThisInvoke >= BACKFILL_MAX_POSTS_PER_INVOKE) { remaining++; continue; }
    const cls = classifyPost(post, companies, refPrefixes);
    if (!cls.include) {
      await deps.auditExclusion(sb, post, cls.reason);
      excluded++;
    } else {
      const unresolved = await deps.persistPost(sb, token, groupId, post, cls);
      totalUnresolved += unresolved;
      included++;
    }
    processedThisInvoke++;
  }
  console.log(
    `[monitor-ses][backfill] chunk processed=${processedThisInvoke} ` +
      `(included=${included} excluded=${excluded} unresolved_att=${totalUnresolved}) remaining=${remaining}`,
  );

  // ── NOT FINISHED: more not-done posts remain. Return PARTIAL without committing
  // coverage (FAIL CLOSED — no floor/ceiling/cursor/marker until the WHOLE history is
  // drained). The driver re-invokes until partial=false. ──
  if (remaining > 0) {
    await refreshSyncState(sb, true, null); // best-effort mode; never writes the cursor
    return {
      success: true,
      partial: true,
      remaining,
      group_id: groupId,
      posts_seen: posts.length,
      included,
      excluded,
      unresolved_attachments: totalUnresolved,
      page_counts: pageCounts,
      inventory_floor: null,
      inventory_ceiling: backfillStartIso,
      committed_cursor: "",
      timestamp: new Date().toISOString(),
    };
  }

  // ── ALL POSTS DRAINED WITHOUT THROWING. Only now commit coverage. The ceiling is
  // the backfill start instant; the floor is the earliest ingested received_at across
  // ALL history, read from the DB (chunked invokes never hold the whole set). ──
  const ceilingIso = backfillStartIso;
  const floorIso = (await loadIngestedFloor(sb)) ?? backfillStartIso; // empty group -> floor=ceiling

  // BLOCKER FIX (atomic commit) — commit the coverage FLOOR + CEILING, the
  // backfill_complete marker, AND the live cursor in ONE transaction via the
  // commit_makesafe_backfill RPC. Previously these were two SEPARATE writes
  // (sync_state floor/ceiling, then mail_sync_cursors cursor); if the cursor write
  // failed AFTER the floor write, the system had coverage bounds set (claiming
  // ingestion coverage) but the wrong/absent live cursor — a sync gap the verified
  // gate could falsely pass. The RPC is the LAST step and is all-or-nothing: on ANY
  // failure NOTHING is set, so a partial/failed backfill can never leave coverage
  // bounds (or the backfill_complete marker) recorded without the matching cursor,
  // and recon_verified can never read true over un-ingested history.
  //
  // The RPC also applies the MIN(floor)/MAX(ceiling) widen-only rule server-side
  // (against the existing row), so re-running on a now-larger history never regresses
  // coverage — the same invariant the old separate read+compute path enforced.
  const nowStamp = new Date().toISOString();
  const { data: committed, error: commitErr } = await sb.rpc("commit_makesafe_backfill", {
    p_mailbox: MAILBOX,
    p_floor: floorIso,
    p_ceiling: ceilingIso,
    p_cursor: backfillStartIso,
  });
  if (commitErr) {
    // FAIL CLOSED: the atomic commit failed -> NEITHER coverage bounds NOR the live
    // cursor NOR the backfill_complete marker were written (the RPC body is one
    // transaction). Throw so the run fails and is re-run; recon_verified stays
    // blocked (backfill_incomplete) until a commit succeeds.
    throw new Error(`backfill atomic commit failed: ${commitErr.message}`);
  }

  // The RPC returns the post-widen floor/ceiling it actually persisted.
  const result = (committed || {}) as {
    recon_inventory_floor?: string;
    recon_inventory_ceiling?: string;
  };
  const newFloor = result.recon_inventory_floor ?? floorIso;
  const newCeiling = result.recon_inventory_ceiling ?? ceilingIso;

  // Refresh sync_state mode (DEGRADED while any attachment is unresolved). Done
  // after coverage is committed; surfaces the attachment backlog for the gate. (A
  // best-effort mode write — it never un-sets backfill_complete or the cursor.)
  await refreshSyncState(sb, true, null);

  console.log(
    `[monitor-ses][backfill] DONE included=${included} excluded=${excluded} ` +
      `unresolved_att=${totalUnresolved} floor=${newFloor} ceiling=${newCeiling} ` +
      `cursor=${backfillStartIso} (atomic commit ok)`,
  );

  return {
    success: true,
    partial: false,
    remaining: 0,
    group_id: groupId,
    posts_seen: posts.length,
    included,
    excluded,
    unresolved_attachments: totalUnresolved,
    page_counts: pageCounts,
    inventory_floor: newFloor,
    inventory_ceiling: newCeiling,
    committed_cursor: backfillStartIso,
    timestamp: nowStamp,
  };
}

// ════════════════════════════════════════════════════════════
// Main handler
// ════════════════════════════════════════════════════════════
// Exported as a named handler and only bound to Deno.serve when this module is
// run as the entry point (import.meta.main). This lets the Phase-2 reconciliation
// + Deno test suite import the internal pure functions (and reuse collectPosts /
// resolveGroupId for D2) WITHOUT this module binding a TCP port on import.
async function handler(req: Request): Promise<Response> {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // B1 — AUTH GUARD. This function authenticates every non-OPTIONS request itself.
  // verify_jwt is ON for this deploy, so the Supabase gateway has ALREADY
  // cryptographically verified any Bearer JWT's signature before we run — which means
  // we authorize on the decoded `role` claim, NOT a brittle exact-string match.
  // Accept if ANY of: x-api-key == SW_API_KEY (manual ops), Bearer == the injected
  // service key (fast path), OR Bearer is a JWT with role == "service_role". That last
  // clause is what lets the pg_cron _sw_service_key() bearer through: it is a
  // signature-valid service-role JWT that does NOT byte-equal SUPABASE_SERVICE_ROLE_KEY
  // (rotated/different value), so the old exact-match silently 401'd the cron and the
  // sync never ran. An anon JWT (role == "anon") is still rejected. See isAuthorized().
  if (!isAuthorized(req, SUPABASE_SERVICE_KEY, SW_API_KEY)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // ── Mode detection: regular poll (default) vs the gated FULL HISTORICAL backfill.
  // The backfill is EXPLICIT and manual: {mode:"backfill_full"} in the POST body OR
  // ?backfill=full in the query string. The */5 cron trigger posts {} (no mode), so
  // it always runs the regular poll — the backfill is NEVER the scheduled path. Both
  // modes are behind the SAME auth gate above and the SAME advisory lock below.
  let backfillFull = false;
  try {
    const u = new URL(req.url);
    if ((u.searchParams.get("backfill") || "").toLowerCase() === "full") backfillFull = true;
  } catch (_) { /* non-URL request line; ignore */ }
  if (!backfillFull && req.method === "POST") {
    try {
      const raw = await req.text();
      if (raw) {
        const body = JSON.parse(raw);
        if (body && typeof body === "object" && body.mode === "backfill_full") backfillFull = true;
      }
    } catch (_) { /* empty / non-JSON body (cron posts {}); treat as regular poll */ }
  }

  const sb = _testClientFactory
    ? _testClientFactory(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // B2 — per-mailbox concurrency lock. Overlapping */5 runs would race on the
  // cursor read/drain/write and corrupt the watermark. Acquire a pg advisory lock
  // for this mailbox; if a previous run still holds it, exit early-clean (200, no
  // work). Released in the finally below so a normal run frees it immediately, and
  // a crashed run frees it when its Postgres backend connection closes.
  let lockHeld = false;
  try {
    const { data: locked, error: lockErr } = await sb.rpc("try_lock_mailbox_sync", {
      p_mailbox: MAILBOX,
    });
    if (lockErr) {
      throw new Error(`advisory lock RPC failed: ${lockErr.message}`);
    }
    if (locked !== true) {
      console.log(`[monitor-ses] another run holds the ${MAILBOX} lock; exiting early`);
      return new Response(
        JSON.stringify({ success: true, skipped: "locked", mailbox: MAILBOX }),
        { headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }
    lockHeld = true;
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[monitor-ses] lock acquisition error:", msg);
    try { await refreshSyncState(sb, false, msg); } catch (_) { /* best-effort */ }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── GATED FULL HISTORICAL BACKFILL branch (mode=backfill_full). Runs UNDER the
    // same advisory lock as the poll (so it never races the */5 cron), traverses ALL
    // history, ingests idempotently, then sets the coverage floor/ceiling + commits
    // the live cursor LAST (fail-closed: see runBackfillFull). On any throw the
    // catch below leaves NO floor and NO cursor, so a partial backfill cannot let
    // recon_verified read true over un-ingested history.
    if (backfillFull) {
      const result = await runBackfillFull(sb, {
        getGraphToken,
        resolveGroupId,
        loadCompanyPatterns,
        collectPosts,
        persistPost,
        auditExclusion,
      });
      return new Response(JSON.stringify({ ...result, mode: "backfill_full" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const token = await getGraphToken();
    const groupId = await resolveGroupId(token);
    // B1 — patterns drive sender matching; refPrefixes (data-driven, union of the
    // static floor + every company's parsing_rules.ref_prefixes) drives subject
    // ref extraction so a company-defined ref family is recognised code-free.
    const { patterns: companies, refPrefixes } = await loadCompanyPatterns(sb);

    // ── Overlapping watermark: read cursor, compute lower bound (>=, not >). ──
    const { data: cursor, error: cursorReadErr } = await sb.from("mail_sync_cursors")
      .select("last_completed_max, overlap_seconds")
      .eq("mailbox", MAILBOX)
      .maybeSingle();
    if (cursorReadErr) {
      throw new Error(`cursor read failed: ${cursorReadErr.message}`);
    }
    // N5 — overlap window is configurable per mailbox (mail_sync_cursors.overlap_seconds);
    // 900s is the default until the integration-validation step measures the real
    // max thread-reply latency. An env override (MAKESAFE_OVERLAP_SECONDS) lets ops
    // tune it without a DB write during validation.
    const envOverlap = Number(Deno.env.get("MAKESAFE_OVERLAP_SECONDS") || "");
    const overlapSeconds =
      (cursor as { overlap_seconds?: number } | null)?.overlap_seconds ??
      (Number.isFinite(envOverlap) && envOverlap > 0 ? envOverlap : 900);
    const lastMax = (cursor as { last_completed_max?: string } | null)?.last_completed_max;

    // M7 — FIRST RUN handling. With no cursor we do a bounded recent-mail lookback,
    // but we must NOT commit a live watermark off that partial window — doing so
    // would permanently skip anything older than the lookback. So the first run is
    // an explicit INITIAL BACKFILL: it ingests the recent window (idempotently) and
    // does NOT advance the cursor. The FULL historical backfill is now implemented
    // as the gated, one-shot {mode:"backfill_full"} path above (runBackfillFull):
    // it traverses the entire group history from epoch, ingests via this SAME
    // persistPost path, sets recon_inventory_floor to all-history, and ESTABLISHES
    // the first live cursor (at the backfill start instant) so this poll then takes
    // over with no gap. Until that gated backfill has been run once, this poll keeps
    // re-scanning the recent lookback window (idempotent upserts make that safe but
    // NOT complete for old mail) and never advances a live cursor — so a poll-only
    // deployment can never make the verified gate read true over un-ingested history.
    const initialBackfill = !lastMax;
    const baseMs = lastMax
      ? Date.parse(lastMax)
      : Date.now() - 7 * 24 * 60 * 60 * 1000;
    const sinceIso = new Date(baseMs - overlapSeconds * 1000).toISOString();

    console.log(
      `[monitor-ses] poll start group=${groupId} since>=${sinceIso} ` +
      `(overlap=${overlapSeconds}s, initialBackfill=${initialBackfill})`,
    );

    // ── Full traversal (nextLink exhausted at every level). ──
    const { posts, pageCounts } = await collectPosts(token, groupId, sinceIso);
    console.log(
      `[monitor-ses] drained pages conv=${pageCounts.conversations} thread=${pageCounts.threads} post=${pageCounts.posts}; ${posts.length} posts in window`,
    );

    // ── Classify + persist. Track the max receivedDateTime actually drained. ──
    let included = 0;
    let excluded = 0;
    let totalUnresolved = 0;
    let maxReceived = lastMax || null;

    for (const post of posts) {
      const ts = post.receivedDateTime || post.createdDateTime || null;
      if (ts && (!maxReceived || ts > maxReceived)) maxReceived = ts;

      const cls = classifyPost(post, companies, refPrefixes);
      if (!cls.include) {
        await auditExclusion(sb, post, cls.reason);
        excluded++;
        continue;
      }
      const unresolved = await persistPost(sb, token, groupId, post, cls);
      totalUnresolved += unresolved;
      included++;
    }

    // ── Persist watermark ONLY after a full successful drain. ──
    // (We reached here without throwing, so the page drain completed.)
    // M2 — the cursor commit error is CHECKED: if the watermark fails to persist
    // we must NOT report success (the next run would otherwise re-read the same
    // window, which is safe, but a silent failure would mask a broken cursor). On
    // a backfill (initialBackfill) we deliberately do NOT advance the live cursor
    // (M7) — see below.
    if (maxReceived && !initialBackfill) {
      const { error: curErr } = await sb.from("mail_sync_cursors").upsert({
        mailbox: MAILBOX,
        last_completed_max: maxReceived,
        overlap_seconds: overlapSeconds,
        updated_at: new Date().toISOString(),
      }, { onConflict: "mailbox" });
      if (curErr) {
        throw new Error(`cursor commit failed: ${curErr.message}`);
      }
    }

    // M2 — sync_state write error is surfaced (throws) so we never return success
    // with an uncommitted state row.
    await refreshSyncState(sb, true, null);

    const result = {
      success: true,
      group_id: groupId,
      posts_in_window: posts.length,
      included,
      excluded,
      unresolved_attachments_this_run: totalUnresolved,
      page_counts: pageCounts,
      watermark: maxReceived,
      timestamp: new Date().toISOString(),
    };
    console.log(
      `[monitor-ses] done included=${included} excluded=${excluded} unresolved_att=${totalUnresolved}`,
    );
    return new Response(JSON.stringify(result), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    // On failure: do NOT advance the watermark (retry same window next cycle).
    // Degrade, do not corrupt.
    const msg = (e as Error).message;
    console.error("[monitor-ses] Error:", msg);
    try {
      await refreshSyncState(sb, false, msg);
    } catch (_) { /* best-effort */ }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } finally {
    // B2 — always release the advisory lock for this run.
    if (lockHeld) {
      try {
        await sb.rpc("unlock_mailbox_sync", { p_mailbox: MAILBOX });
      } catch (e) {
        console.error("[monitor-ses] lock release failed:", (e as Error).message);
      }
    }
  }
}

// Only bind a TCP port when this file is the entry module (deployed function or
// `deno run` of this file). Importers (reconciliation actions, Deno tests) get
// the pure functions without a server starting.
if (import.meta.main) {
  Deno.serve(handler);
}

// Test-only exports (underscore-prefixed; mirrors the makesafe_board_test.ts
// pattern of exporting internal pure functions for Deno tests in Phase 2).
// collectPosts / resolveGroupId / graphGetAll are reused by the D2 full-post
// inventory reconcile (see makesafe_reconcile.ts).
export {
  auditExclusion as _auditExclusion,
  buildSubjectRef as _buildSubjectRef,
  classifyPost as _classifyPost,
  collectPosts as _collectPosts,
  decodeJwtRole as _decodeJwtRole,
  DEFAULT_REF_PREFIXES as _DEFAULT_REF_PREFIXES,
  extractRef as _extractRef,
  extractRefPrefixes as _extractRefPrefixes,
  graphGetAll as _graphGetAll,
  handler as _handler,
  isAuthorized as _isAuthorized,
  isPdfMagic as _isPdfMagic,
  loadCompanyPatterns as _loadCompanyPatterns,
  normaliseRef as _normaliseRef,
  parseSenderDomain as _parseSenderDomain,
  persistPost as _persistPost,
  processAttachments as _processAttachments,
  resolveGroupId as _resolveGroupId,
  runBackfillFull as _runBackfillFull,
  senderMatchesPattern as _senderMatchesPattern,
  _setTestClientFactory,
  sha256Hex as _sha256Hex,
};
