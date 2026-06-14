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

const SES_GROUP_MAIL = "ses@secureworkswa.com.au";
const MAILBOX = SES_GROUP_MAIL; // mailbox key in mail_sync_cursors / sync_state
const STORAGE_BUCKET = "makesafe-emails";
const GRAPH = "https://graph.microsoft.com/v1.0";

// Projection / extractor versions — stamped on pipeline_items for rebuildability.
const EXTRACTOR_VERSION = "v1";
const MATCHER_VERSION = "v1";

// Graph inline contentBytes cap (~4MB). Above this, the bytes are not inlined and
// the large-attachment $value path is required. Phase 1 marks those needs_review.
const INLINE_BYTES_LIMIT = 4 * 1024 * 1024;

// ════════════════════════════════════════════════════════════
// Types (minimal Graph shapes we read)
// ════════════════════════════════════════════════════════════
interface GraphFrom {
  emailAddress?: { address?: string; name?: string };
}
interface GraphPost {
  id: string;
  // internetMessageId presence on group posts is UNCONFIRMED — read defensively.
  internetMessageId?: string;
  conversationId?: string;
  conversationThreadId?: string;
  createdDateTime?: string;
  receivedDateTime?: string;
  from?: GraphFrom;
  sender?: GraphFrom;
  subject?: string;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
  newParticipants?: unknown;
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
// Attachment handling. Validates PDF magic bytes, sha256-dedups, uploads to the
// PRIVATE bucket, inserts an email_attachments row. Non-file / oversize / inline
// attachments -> status=needs_review (never silently skipped). Returns the count
// of still-unresolved (pending/failed/needs_review) attachment rows for this
// email, which drives the DEGRADED mode.
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

  // Attachment-list pagination: Graph returns at most 200 per call; drain all.
  const attUrl =
    `${GRAPH}/groups/${groupId}/threads/${post.conversationThreadId}/posts/${post.id}/attachments`;
  let attachments: GraphAttachment[] = [];
  try {
    const drained = await graphGetAll<GraphAttachment>(attUrl, token);
    attachments = drained.values;
    console.log(
      `[monitor-ses] post ${post.id}: ${attachments.length} attachments over ${drained.pages} page(s)`,
    );
  } catch (e) {
    // List fetch failed — leave the email DEGRADED. Record a placeholder using a
    // synthetic graph_attachment_id (the non-null key) so the retry worker re-tries
    // and the row is idempotent across polls. B5: error checked.
    console.error(
      `[monitor-ses] attachment list fetch failed for ${post.id}: ${(e as Error).message}`,
    );
    const synthetic = "_list_fetch_failed";
    const attempts = (await priorAttempts(sb, post.id, synthetic)) + 1;
    const { error } = await upsertAttachmentRow(sb, {
      email_id: post.id,
      graph_attachment_id: synthetic,
      name: null,
      status: "failed",
      attachment_kind: "unknown",
      last_error: "attachment_list_fetch_failed",
      attempts,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error(`[monitor-ses] failed-placeholder upsert failed for ${post.id}: ${error.message}`);
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

    // referenceAttachment / itemAttachment / inline -> needs_review + alert.
    if (!isFileAttachment || isInline) {
      const { error } = await upsertAttachmentRow(sb, {
        email_id: post.id,
        graph_attachment_id: gaid,
        name: att.name || null,
        content_type: att.contentType || null,
        size_bytes: att.size || null,
        status: "needs_review",
        attachment_kind: isInline ? "inline" : kind,
        last_error: `unsupported_attachment_kind:${isInline ? "inline" : kind}`,
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

    // fileAttachment with no inline contentBytes (too large for inline) -> the
    // large-attachment $value path is required. Phase 1 marks needs_review.
    if (!att.contentBytes || (att.size || 0) > INLINE_BYTES_LIMIT) {
      const { error } = await upsertAttachmentRow(sb, {
        email_id: post.id,
        graph_attachment_id: gaid,
        name: att.name || null,
        content_type: att.contentType || null,
        size_bytes: att.size || null,
        status: "needs_review",
        attachment_kind: "fileAttachment",
        last_error: "large_attachment_value_path_required",
        attempts,
        updated_at: new Date().toISOString(),
      });
      if (error) {
        throw new Error(`large-attachment upsert failed for ${post.id}/${gaid}: ${error.message}`);
      }
      unresolved++;
      // TODO(Phase 2): fetch via /attachments/{id}/$value for large PDFs.
      continue;
    }

    // We only store PDFs in this private bucket. Non-PDF file attachments are
    // recorded as needs_review (auditable) rather than silently skipped.
    if (!isPdfByType) {
      const { error } = await upsertAttachmentRow(sb, {
        email_id: post.id,
        graph_attachment_id: gaid,
        name: att.name || null,
        content_type: att.contentType || null,
        size_bytes: att.size || null,
        status: "needs_review",
        attachment_kind: "fileAttachment",
        last_error: "non_pdf_file_attachment",
        attempts,
        updated_at: new Date().toISOString(),
      });
      if (error) {
        throw new Error(`non-pdf attachment upsert failed for ${post.id}/${gaid}: ${error.message}`);
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
    internet_message_id: post.internetMessageId || null,
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
  const eventId = (eventRow as { id?: string } | null)?.id || null;

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
    // Threads under each conversation.
    const threadUrl = `${GRAPH}/groups/${groupId}/conversations/${conv.id}/threads?$select=id`;
    const threads = await graphGetAll<{ id: string }>(threadUrl, token, budget);
    threadPages += threads.pages;

    for (const thread of threads.values) {
      // Posts under each thread. Request the fields we project.
      const postUrl =
        `${GRAPH}/groups/${groupId}/threads/${thread.id}/posts` +
        `?$select=id,createdDateTime,receivedDateTime,from,sender,subject,hasAttachments,body,conversationId,conversationThreadId,internetMessageId`;
      const threadPosts = await graphGetAll<GraphPost>(postUrl, token, budget);
      postPages += threadPosts.pages;

      for (const post of threadPosts.values) {
        // Ensure the thread id is available for the attachment endpoint.
        if (!post.conversationThreadId) post.conversationThreadId = thread.id;
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

  // B1 — AUTH GUARD. Deployed --no-verify-jwt, so this function MUST authenticate
  // every non-OPTIONS request itself. The pg_cron trigger calls with
  // `Authorization: Bearer <service key>` (trigger_monitor_ses_makesafes ->
  // _sw_service_key(), which is the service-role JWT == SUPABASE_SERVICE_KEY).
  // Manual ops invokes carry x-api-key: SW_API_KEY. Accept EITHER valid
  // credential; reject everything else 401. (monitor-inbox accepted unauthenticated
  // requests — the gap Codex flagged. We close it here.)
  const apiKey = req.headers.get("x-api-key") || "";
  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const serviceKeyOk = !!SUPABASE_SERVICE_KEY && bearer === SUPABASE_SERVICE_KEY;
  const apiKeyOk = !!SW_API_KEY && apiKey === SW_API_KEY;
  if (!serviceKeyOk && !apiKeyOk) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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
    // does NOT advance the cursor. The full historical backfill is its own gated
    // Phase-2 step (TODO below) that ingests the entire group history, after which
    // the live cursor is established.
    //
    // TODO(Phase 2): run the full historical backfill as a separate gated step
    //   (traverse the whole group via D2-style exhaustion, ingest all posts), THEN
    //   write the first live cursor. Until that step runs, every poll re-scans the
    //   recent lookback window (idempotent upserts make this safe but not complete
    //   for old mail). Do not rely on this function alone for historical completeness.
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
  DEFAULT_REF_PREFIXES as _DEFAULT_REF_PREFIXES,
  extractRef as _extractRef,
  extractRefPrefixes as _extractRefPrefixes,
  graphGetAll as _graphGetAll,
  handler as _handler,
  isPdfMagic as _isPdfMagic,
  loadCompanyPatterns as _loadCompanyPatterns,
  normaliseRef as _normaliseRef,
  parseSenderDomain as _parseSenderDomain,
  persistPost as _persistPost,
  processAttachments as _processAttachments,
  resolveGroupId as _resolveGroupId,
  senderMatchesPattern as _senderMatchesPattern,
  sha256Hex as _sha256Hex,
};
