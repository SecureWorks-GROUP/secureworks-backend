// deno-lint-ignore-file no-explicit-any
// Batch AI gap-fill for deterministic make-safe intake "needs-a-human" flags.
//
// WHAT THIS IS
// The deterministic intake (makesafe_deterministic_intake.ts) creates canonical
// cases with ZERO AI. Anything it cannot resolve deterministically is flagged for
// a human rather than guessed: an `exception` case (reason-coded) or a
// `blocked_live_job` case (missing a secondary field). This module exposes that
// backlog as a queryable QUEUE and applies AI-judged FILLS back onto the case.
//
// TRUST / COST MODEL (captain rulings 2026-07-21, binding)
//  * NO paid API. This module calls no model. The AI judgment runs OUTSIDE the
//    edge function, on the captain's subscription Claude, which reads the queue,
//    reads the evidence with the existing read actions, then posts fills here.
//  * NO approval gate. Fills land directly; the make-safe reporting run and Hugo's
//    trade app are the downstream human review surfaces. Fills are additive,
//    audited and reversible.
//  * ADDITIVE ONLY. A fill sets a currently-EMPTY job-material field. It never
//    overwrites a non-empty deterministic value, never deletes/archives, never
//    creates a job, never changes state/reason_code/lineage/canonical identity,
//    and never sends anything. Overwriting a populated field is a human's job.
//  * AUDITED. Every applied fill is written with last_decision_provenance='ai' and
//    a fresh last_decision_reason, which the case triggers record as an append-only
//    `case_update` event naming the AI gap-fill as the source (see migration
//    20260720000001_makesafe_intake_cases.sql record_makesafe_intake_case_event).
//
// This file holds the pure decision logic plus thin client-touching loaders. The
// dispatch wiring lives in index.ts (makesafe_gap_fill_queue / _apply actions).

// "Trade submitted a report but the reporting pack has not been run yet" — loaded
// against the live report lifecycle in makesafe_gap_fill_report_ready.ts.
import { loadReportReadyItems } from "./makesafe_gap_fill_report_ready.ts";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

export const GAP_FILL_CONTRACT_VERSION = "makesafe-gap-fill.v1";
// Names the fill source in every audit event / decision reason. Bump the version
// suffix when the resolution contract changes so the ledger stays legible.
export const GAP_FILL_ACTOR = "makesafe-gap-fill-skill@2026-07-21.v1";

// The only case columns the batch AI may fill. These are job-material fields, NOT
// canonical builder identity (which needs field provenance and a bigger decision).
// A blocked_live_job already carries client_name/site_address (the live identity
// floor guarantees it), so in practice its only fillable gap is client_phone.
export const GAP_FILL_ALLOWED_FIELDS = [
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "site_suburb",
] as const;
export type GapFillField = (typeof GAP_FILL_ALLOWED_FIELDS)[number];

// The two case states that mean "a human (now: subscription Claude) must look".
export const GAP_FILL_CASE_STATES = ["exception", "blocked_live_job"] as const;

function clean(value: unknown): string | null {
  const v = String(value ?? "").replace(/\s+/g, " ").trim();
  return v.length ? v : null;
}

function isEmptyField(value: unknown): boolean {
  return clean(value) === null;
}

// ── One-line, human-readable gap description ─────────────────────────────────
// Used in the queue payload and safe to show a reviewer. Never leaks message
// bodies or PII — only field NAMES and reason codes.
export function describeGap(caseRow: any): string {
  const state = String(caseRow?.state ?? "");
  const reason = caseRow?.reason_code ? String(caseRow.reason_code) : null;
  const missing = Array.isArray(caseRow?.missing_fields)
    ? caseRow.missing_fields.filter(Boolean)
    : [];
  const conflicting = caseRow?.conflicting_fields &&
      typeof caseRow.conflicting_fields === "object"
    ? Object.keys(caseRow.conflicting_fields)
    : [];
  if (state === "blocked_live_job") {
    const blocked = Array.isArray(caseRow?.blocked_reasons)
      ? caseRow.blocked_reasons.filter(Boolean)
      : [];
    const fields = blocked.map((r: string) => r.replace(/^missing:/, ""));
    return fields.length
      ? `Live job blocked on secondary field(s): ${fields.join(", ")}.`
      : `Live job blocked pending a secondary field.`;
  }
  switch (reason) {
    case "below_identity_floor":
      return "Exception: no confirmed builder WO/PO identity. AI cannot mint " +
        "identity; only client/site job material can be recovered.";
    case "wo_ref_without_pdf_pending_review":
      return "Maybe-box: builder WO ref extracted from subject but no WO PDF " +
        "was received. Review the email subject + address and decide whether " +
        "to create the job. AI may fill client/site material from the email " +
        "body; the WO ref is already known.";
    case "adapter_parse_failure":
      return missing.length
        ? `Exception: deterministic parse left required field(s) empty: ${
          missing.join(", ")
        }.`
        : "Exception: deterministic parse left a required field empty.";
    case "conflicting_fields":
      return conflicting.length
        ? `Exception: conflicting candidate values for: ${
          conflicting.join(", ")
        }. Pick the correct value from the evidence.`
        : "Exception: conflicting candidate field values.";
    case "unknown_builder":
      return "Exception: builder profile not resolved. Needs a human to map or " +
        "add the builder; not an AI gap-fill.";
    case "cancellation":
      return "Exception: builder cancelled the instruction. No fill needed.";
    case "non_makesafe":
      return "Accounted non-work. No fill needed.";
    default:
      return reason
        ? `Exception (${reason}). Review the evidence.`
        : "Needs review.";
  }
}

// Which allow-listed fields are currently EMPTY on the case and therefore
// candidates for an AI fill. A field already carrying a deterministic value is
// never a candidate (additive-only).
export function gapFillableFields(caseRow: any): GapFillField[] {
  return GAP_FILL_ALLOWED_FIELDS.filter((field) =>
    isEmptyField(caseRow?.[field])
  );
}

// Some exceptions are structurally NOT AI-fillable: an unknown builder, a
// cancellation, or a below-identity-floor case whose only gap is the (unmintable)
// builder WO/PO identity. The queue flags these so the skill leaves them for a
// human instead of guessing.
export function reasonIsHumanOnly(caseRow: any): boolean {
  const reason = caseRow?.reason_code ? String(caseRow.reason_code) : null;
  if (reason === "unknown_builder" || reason === "cancellation") return true;
  if (String(caseRow?.state) === "accounted_non_wo") return true;
  // below_identity_floor with no fillable client/site material is human-only:
  // the missing thing is the builder identity, which AI must never invent.
  if (
    reason === "below_identity_floor" && gapFillableFields(caseRow).length === 0
  ) {
    return true;
  }
  return false;
}

export interface GapFillApplyRequest {
  caseId?: string | null;
  instructionKey?: string | null;
  // Field -> value the subscription-Claude session judged from the evidence.
  fills?: Record<string, unknown> | null;
  // Required audit trail: a short, human-legible note citing the evidence the AI
  // used (e.g. "client_name from WO PDF att-123; site_address from email t-1").
  // Written into the append-only case_update event as the decision reason.
  evidenceNote?: string | null;
  // Optional: caller-supplied actor override (defaults to GAP_FILL_ACTOR).
  actor?: string | null;
}

export interface GapFillDiff {
  // Allow-listed, currently-empty fields with an accepted new value.
  applied: Record<string, string>;
  // Fields the caller asked to fill but that were rejected, with the reason.
  skipped: Array<{ field: string; value: unknown; reason: string }>;
}

// Pure: decide exactly which requested fills are accepted against a case row.
// Rejects (skips, never throws for) unknown fields, non-string/empty values, and
// fields that already carry a value. Returns the minimal write-diff.
export function computeCaseFill(
  caseRow: any,
  fills: Record<string, unknown> | null | undefined,
): GapFillDiff {
  const applied: Record<string, string> = {};
  const skipped: GapFillDiff["skipped"] = [];
  const allowed = new Set<string>(GAP_FILL_ALLOWED_FIELDS);
  for (const [field, rawValue] of Object.entries(fills ?? {})) {
    if (!allowed.has(field)) {
      skipped.push({ field, value: rawValue, reason: "field_not_allowlisted" });
      continue;
    }
    const value = clean(rawValue);
    if (value === null) {
      skipped.push({ field, value: rawValue, reason: "empty_value" });
      continue;
    }
    if (!isEmptyField(caseRow?.[field])) {
      // Additive-only: never clobber a deterministic value. A correction is a
      // human's decision, not a batch AI fill.
      skipped.push({
        field,
        value: rawValue,
        reason: "field_already_populated",
      });
      continue;
    }
    applied[field] = value;
  }
  return { applied, skipped };
}

// Recompute missing_fields after a fill: drop any allow-listed field we just
// populated. Non-fill missing entries (e.g. work_order_attachment, portal_link)
// are preserved untouched.
export function nextMissingFields(
  caseRow: any,
  applied: Record<string, string>,
): string[] {
  const filled = new Set(Object.keys(applied));
  const current = Array.isArray(caseRow?.missing_fields)
    ? caseRow.missing_fields.filter((f: unknown): f is string =>
      typeof f === "string"
    )
    : [];
  return current.filter((f: string) => !filled.has(f));
}

// Recompute conflicting_fields after a fill: drop any key the AI resolved by
// supplying a concrete value. Other conflicts are preserved.
export function nextConflictingFields(
  caseRow: any,
  applied: Record<string, string>,
): Record<string, unknown> {
  const filled = new Set(Object.keys(applied));
  const current = (caseRow?.conflicting_fields &&
      typeof caseRow.conflicting_fields === "object")
    ? caseRow.conflicting_fields as Record<string, unknown>
    : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!filled.has(key)) out[key] = value;
  }
  return out;
}

// Compose the append-only audit decision reason. MUST differ from the case's
// current last_decision_reason (the case trigger rejects an unchanged reason on a
// decision), so it always embeds the fill fields; the caller's evidence note is
// appended for the reviewer. Names the AI gap-fill as the source.
export function buildAuditReason(
  applied: Record<string, string>,
  evidenceNote: string | null | undefined,
): string {
  const fields = Object.keys(applied).sort().join(", ");
  const note = clean(evidenceNote);
  const base = `AI gap-fill (${GAP_FILL_CONTRACT_VERSION}): filled ${fields}`;
  return note ? `${base}. Evidence: ${note}` : base;
}

// ── Loaders (thin, client-touching) ─────────────────────────────────────────

interface QueueOptions {
  limit?: number;
  orgId?: string;
  includeReportReady?: boolean;
}

const QUEUE_DEFAULT_LIMIT = 100;
const QUEUE_MAX_LIMIT = 500;

// Columns the queue needs off a case row. Deliberately excludes nothing large;
// intake case rows carry no oversized blobs (story_json/evidence_map are bounded).
const CASE_QUEUE_COLUMNS = [
  "id",
  "instruction_key",
  "state",
  "reason_code",
  "missing_fields",
  "conflicting_fields",
  "blocked_reasons",
  "job_id",
  "company_id",
  "company_slug_raw",
  "external_ref_canonical",
  "builder_wo_canonical",
  "builder_po_canonical",
  "deliverable_ref_canonical",
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "site_suburb",
  "evidence_map",
  "received_at",
  "last_decision_provenance",
  "last_decision_reason",
].join(",");

function boundedLimit(limit: number | undefined): number {
  const n = Number(limit ?? QUEUE_DEFAULT_LIMIT);
  if (!Number.isFinite(n) || n < 1) return QUEUE_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), QUEUE_MAX_LIMIT);
}

// Per-case source evidence pointers: WHERE the AI should look. Carries no message
// bodies — only post ids, subjects, sender, timestamps and attachment metadata.
// The skill fetches bodies/PDFs with the existing read actions (get_makesafe_email
// / get_makesafe_attachment_url) so raw bytes never transit this endpoint.
async function loadCaseEvidencePointers(
  client: any,
  orgId: string,
  caseIds: string[],
): Promise<Map<string, any[]>> {
  const byCase = new Map<string, any[]>();
  if (!caseIds.length) return byCase;
  const { data: sources, error: srcErr } = await client
    .from("makesafe_intake_case_sources")
    .select("case_id,post_id,role,received_at,attachment_refs")
    .eq("org_id", orgId)
    .in("case_id", caseIds);
  if (srcErr) {
    throw new Error(`gap-fill source read failed: ${srcErr.message || srcErr}`);
  }
  const rows = sources || [];
  const postIds = [...new Set(rows.map((r: any) => r.post_id).filter(Boolean))];

  const emailByPost = new Map<string, any>();
  if (postIds.length) {
    const { data: emails, error: emErr } = await client
      .from("emails")
      .select("post_id,subject,from_email,from_name,received_at")
      .in("post_id", postIds);
    if (emErr) {
      throw new Error(`gap-fill email read failed: ${emErr.message || emErr}`);
    }
    for (const e of emails || []) emailByPost.set(e.post_id, e);
  }

  const attByPost = new Map<string, any[]>();
  if (postIds.length) {
    const { data: atts, error: attErr } = await client
      .from("email_attachments")
      .select("id,email_id,name,content_type,status,size_bytes")
      .in("email_id", postIds);
    if (attErr) {
      throw new Error(
        `gap-fill attachment read failed: ${attErr.message || attErr}`,
      );
    }
    for (const a of atts || []) {
      const list = attByPost.get(a.email_id) || [];
      list.push({
        attachment_id: a.id,
        name: a.name,
        content_type: a.content_type,
        status: a.status,
        is_pdf: /pdf/i.test(a.content_type || "") ||
          /\.pdf$/i.test(a.name || ""),
      });
      attByPost.set(a.email_id, list);
    }
  }

  for (const row of rows) {
    const e = emailByPost.get(row.post_id) || {};
    const pointer = {
      post_id: row.post_id,
      role: row.role,
      received_at: row.received_at,
      subject: e.subject ?? null,
      from_email: e.from_email ?? null,
      from_name: e.from_name ?? null,
      attachments: attByPost.get(row.post_id) || [],
    };
    const list = byCase.get(row.case_id) || [];
    list.push(pointer);
    byCase.set(row.case_id, list);
  }
  return byCase;
}

// The nextRecoveryAction the deterministic evidence map recorded per missing
// requirement, surfaced so the skill knows what recovery each gap wants.
function recoveryHints(caseRow: any): Record<string, string> {
  const map = caseRow?.evidence_map && typeof caseRow.evidence_map === "object"
    ? caseRow.evidence_map as Record<string, any>
    : {};
  const hints: Record<string, string> = {};
  for (const [req, entry] of Object.entries(map)) {
    if (entry && typeof entry === "object" && entry.nextRecoveryAction) {
      hints[req] = String(entry.nextRecoveryAction);
    }
  }
  return hints;
}

export interface GapFillQueueItem {
  kind: "intake_flag";
  case_id: string;
  instruction_key: string;
  state: string;
  reason_code: string | null;
  builder: string | null;
  external_ref: string | null;
  builder_wo: string | null;
  builder_po: string | null;
  deliverable_ref: string | null;
  present: Record<string, string | null>;
  missing_fields: string[];
  conflicting_fields: Record<string, unknown>;
  blocked_reasons: string[];
  gap: string;
  ai_fillable_fields: GapFillField[];
  human_only: boolean;
  recovery_hints: Record<string, string>;
  evidence_sources: any[];
  received_at: string | null;
}

// Build the intake-flag portion of the queue: every exception + blocked case,
// most-recent first, with evidence pointers and a per-field fill plan.
async function loadIntakeFlagItems(
  client: any,
  orgId: string,
  limit: number,
): Promise<GapFillQueueItem[]> {
  const { data: cases, error } = await client
    .from("makesafe_intake_cases")
    .select(CASE_QUEUE_COLUMNS)
    .eq("org_id", orgId)
    .in("state", GAP_FILL_CASE_STATES as unknown as string[])
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`gap-fill case read failed: ${error.message || error}`);
  }
  const rows = cases || [];
  const evidenceByCase = await loadCaseEvidencePointers(
    client,
    orgId,
    rows.map((r: any) => r.id),
  );
  return rows.map((row: any): GapFillQueueItem => ({
    kind: "intake_flag",
    case_id: row.id,
    instruction_key: row.instruction_key,
    state: row.state,
    reason_code: row.reason_code ?? null,
    builder: row.company_slug_raw ?? null,
    external_ref: row.external_ref_canonical ?? null,
    builder_wo: row.builder_wo_canonical ?? null,
    builder_po: row.builder_po_canonical ?? null,
    deliverable_ref: row.deliverable_ref_canonical ?? null,
    present: {
      client_name: row.client_name ?? null,
      client_phone: row.client_phone ?? null,
      client_email: row.client_email ?? null,
      site_address: row.site_address ?? null,
      site_suburb: row.site_suburb ?? null,
    },
    missing_fields: Array.isArray(row.missing_fields) ? row.missing_fields : [],
    conflicting_fields:
      (row.conflicting_fields && typeof row.conflicting_fields === "object")
        ? row.conflicting_fields
        : {},
    blocked_reasons: Array.isArray(row.blocked_reasons)
      ? row.blocked_reasons
      : [],
    gap: describeGap(row),
    ai_fillable_fields: gapFillableFields(row),
    human_only: reasonIsHumanOnly(row),
    recovery_hints: recoveryHints(row),
    evidence_sources: evidenceByCase.get(row.id) || [],
    received_at: row.received_at ?? null,
  }));
}

// Assemble the whole queue. Report-ready items are loaded separately (see
// makesafe_gap_fill_report_ready.ts) and appended when requested.
export async function loadGapFillQueue(
  client: any,
  options: QueueOptions = {},
): Promise<any> {
  const orgId = options.orgId ?? DEFAULT_ORG_ID;
  const limit = boundedLimit(options.limit);
  const intakeFlags = await loadIntakeFlagItems(client, orgId, limit);
  const reportReady = options.includeReportReady === false
    ? []
    : await loadReportReadyItems(client, orgId, limit);
  const aiFillable =
    intakeFlags.filter((i) => !i.human_only && i.ai_fillable_fields.length > 0)
      .length;
  return {
    contract_version: GAP_FILL_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    org_id: orgId,
    limit,
    totals: {
      intake_flags: intakeFlags.length,
      ai_fillable: aiFillable,
      human_only: intakeFlags.filter((i) => i.human_only).length,
      report_ready: reportReady.length,
    },
    intake_flags: intakeFlags,
    report_ready: reportReady,
  };
}

// ── Apply (thin, client-touching) ────────────────────────────────────────────

export interface GapFillApplyResult {
  ok: boolean;
  applied: boolean;
  case_id: string | null;
  instruction_key: string | null;
  filled: Record<string, string>;
  skipped: Array<{ field: string; value: unknown; reason: string }>;
  reason: string;
  audit_provenance?: string;
}

// Apply an AI-judged fill to a single case. Idempotent: if nothing actually
// changes, it performs NO write and returns applied=false (so a re-run of the
// skill does not churn the ledger or trip the "decision reason unchanged" guard).
export async function applyGapFill(
  client: any,
  body: GapFillApplyRequest,
  orgId: string = DEFAULT_ORG_ID,
): Promise<GapFillApplyResult> {
  const caseId = clean(body?.caseId);
  const instructionKey = clean(body?.instructionKey);
  if (!caseId && !instructionKey) {
    throw new GapFillError("caseId or instructionKey is required", 400);
  }
  const fills = body?.fills;
  if (!fills || typeof fills !== "object" || Array.isArray(fills)) {
    throw new GapFillError("fills object is required", 400);
  }

  let query = client
    .from("makesafe_intake_cases")
    .select(CASE_QUEUE_COLUMNS)
    .eq("org_id", orgId);
  query = caseId
    ? query.eq("id", caseId)
    : query.eq("instruction_key", instructionKey);
  const { data: caseRow, error: readErr } = await query.maybeSingle();
  if (readErr) {
    throw new GapFillError(
      `gap-fill case read failed: ${readErr.message || readErr}`,
      500,
    );
  }
  if (!caseRow) throw new GapFillError("case not found", 404);

  // Only exception / blocked cases are gap-fillable. A live/non-work case is not a
  // "needs a human" flag; refuse rather than mutate an unrelated case.
  if (!(GAP_FILL_CASE_STATES as unknown as string[]).includes(caseRow.state)) {
    throw new GapFillError(
      `case is '${caseRow.state}', not a gap-fill flag (must be exception or blocked_live_job)`,
      409,
    );
  }

  const diff = computeCaseFill(caseRow, fills as Record<string, unknown>);
  const noChange = Object.keys(diff.applied).length === 0;
  if (noChange) {
    return {
      ok: true,
      applied: false,
      case_id: caseRow.id,
      instruction_key: caseRow.instruction_key,
      filled: {},
      skipped: diff.skipped,
      reason: "no_fillable_change",
    };
  }

  const reason = buildAuditReason(diff.applied, body?.evidenceNote);
  const actor = clean(body?.actor) ?? GAP_FILL_ACTOR;
  const update: Record<string, any> = {
    ...diff.applied,
    missing_fields: nextMissingFields(caseRow, diff.applied),
    conflicting_fields: nextConflictingFields(caseRow, diff.applied),
    // Drives the append-only case_update audit event. provenance='ai' names the
    // gap-fill as the source; the reason must differ from the current one.
    last_decision_provenance: "ai",
    last_decision_actor: actor,
    last_decision_reason: reason,
  };

  const { data: updated, error: updErr } = await client
    .from("makesafe_intake_cases")
    .update(update)
    .eq("org_id", orgId)
    .eq("id", caseRow.id)
    .select("id,instruction_key,state")
    .single();
  if (updErr) {
    throw new GapFillError(
      `gap-fill apply failed: ${updErr.message || updErr}`,
      500,
    );
  }

  return {
    ok: true,
    applied: true,
    case_id: updated?.id ?? caseRow.id,
    instruction_key: updated?.instruction_key ?? caseRow.instruction_key,
    filled: diff.applied,
    skipped: diff.skipped,
    reason: "filled",
    audit_provenance: "ai",
  };
}

export class GapFillError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Test-only aliases (mirror the `_`-prefixed convention in sibling modules).
export const _loadGapFillQueueForTest = loadGapFillQueue;
export const _applyGapFillForTest = applyGapFill;
