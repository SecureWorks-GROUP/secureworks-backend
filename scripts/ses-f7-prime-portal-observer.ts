#!/usr/bin/env -S deno run --allow-env=SUPABASE_ACCESS_TOKEN,SW_API_KEY --allow-net=api.supabase.com,kevgrhcjxspbxgovpmfl.supabase.co --allow-read --allow-write --allow-run=chrome-devtools-axi,sips
// deno-lint-ignore-file no-explicit-any
/**
 * F7 - deterministic Prime portal observer, with an opt-in capture writer.
 *
 * DRY RUN IS THE DEFAULT. Reading production is always read-only: database
 * reads use the Supabase Management API with `read_only: true`, and the browser
 * uses only open/eval/screenshot - it never clicks, fills, types, presses, or
 * submits.
 *
 * `--commit` is the only way this process writes anything, and it writes
 * exactly one kind of row: an append-only revision in
 * `makesafe_portal_capture_revisions`, through the single allow-listed ops-api
 * action `record_ses_portal_capture_evidence`. It writes NO stage, substatus,
 * job status or card placement, and `assertCaptureWriteAction` makes that
 * structural rather than a promise. `--commit` additionally REQUIRES `--job`,
 * so the writer can only ever be aimed at one named card; there is no sweep.
 *
 * What it will not record:
 * - a partial capture. Missing cycle, role, builder reference or screenshot
 *   means no row is written and the reason is recorded instead. The reader
 *   trusts what it accepts, so half a capture is worse than none.
 * - "not done" for a link it could not read. An expired, unreachable or
 *   unclassifiable page is `unreachable` (status `rejected`), never `not_done`.
 *
 * Before every reachable-page PNG, the Prime job-details component is blanked
 * and an opaque evidence-only frame covers the viewport. Raw portal text and
 * share URLs remain process-local and are represented in artifacts only by
 * SHA-256 fingerprints.
 */

import {
  canonicalSesPortalSourceUrl,
  SES_PORTAL_CAPTURE_PRODUCER,
  type SesPortalCaptureResult,
  type SesPortalCaptureRole,
} from "../supabase/functions/ops-api/ses_portal_capture_contract.ts";
import {
  extractPortalLinks,
} from "../supabase/functions/ops-api/makesafe_portal_guard.ts";
import {
  isCanonicalLiveMakesafeBoardJobStatus,
} from "../supabase/functions/ops-api/makesafe_board_read_model.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const FUNCTIONS_BASE = `https://${PROJECT_REF}.supabase.co/functions/v1`;
const OBSERVER_VERSION = "ses-prime-portal-observer/2026-08-02.4";

/**
 * The ONE ops-api action this process may call with a write method.
 *
 * `record_ses_portal_capture_evidence` appends an evidence revision and
 * nothing else. Every stage/substatus/status/placement writer is absent from
 * this allow-list, so "the observer never moves a card" is enforced by
 * construction at the single egress point rather than asserted in prose.
 */
export const SES_PORTAL_CAPTURE_WRITE_ACTION =
  "record_ses_portal_capture_evidence" as const;

/** The concrete agent recorded in `captured_by` on every revision it writes. */
export const SES_PORTAL_CAPTURE_OBSERVER_AGENT = OBSERVER_VERSION;
const DEFAULT_OUTPUT_DIR =
  "docs/evidence/ses-f7-prime-portal-capture-dry-run-2026-08-02";
const DEFAULT_INITIAL_WAIT_MS = 8_000;
const DEFAULT_RETRY_WAIT_MS = 6_000;

const WRITE_VERBS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "comment on",
  "copy",
  "call",
  "do ",
  "vacuum",
  "refresh materialized",
];

export type PrimePortalOutcome =
  | "submitted_locked"
  | "in_progress"
  | "not_started"
  | "cannot_observe";

export interface PrimePortalVerdict {
  outcome: PrimePortalOutcome;
  capture_result: SesPortalCaptureResult;
  reason_code:
    | "locked_or_submitted_observed"
    | "answered_fields_without_submission"
    | "zero_answered_fields"
    | "expired_or_inactive_link"
    | "page_failed_to_load"
    | "state_not_classifiable";
  answered_fields: number | null;
  total_fields: number | null;
  observed_phrase: string;
  signal: string;
}

export interface ExistingCaptureLike {
  job_id: string;
  attendance_cycle_id: string;
  role: string;
  capture_result: string;
  source_url: string;
  source_content_hash: string;
  screenshot_content_hash?: string | null;
}

export interface CaptureCandidate {
  job_id: string;
  attendance_cycle_id: string;
  role: SesPortalCaptureRole;
  capture_result: SesPortalCaptureResult;
  source_url: string;
  source_content_hash: string;
  screenshot_content_hash: string | null;
}

export type CapturePlanDecision =
  | { action: "idempotent_noop"; reason: "unchanged_capture_exists" }
  | { action: "create_revision"; reason: "new_or_changed_observation" };

export type CaptureWriteOutcome =
  /** Dry run: the revision was planned and deliberately not written. */
  | "dry_run"
  /** One append-only revision was created. */
  | "written"
  /** The exact observation is already in the ledger; nothing was written. */
  | "idempotent_noop"
  /** A required evidence element was missing; nothing was written. */
  | "write_refused"
  /** Recordable, but this run's write cap was already spent. */
  | "write_skipped_write_cap"
  /** The write was attempted and the server refused or failed it. */
  | "write_failed";

export interface CaptureWriteDecision {
  outcome: CaptureWriteOutcome;
  reason: string;
}

/**
 * Decide what a single observed link does in this run, before any network.
 *
 * The commit flag can only ever DOWNGRADE safety: with `commit:false` a
 * recordable observation is `dry_run`, never a write. Nothing here can turn a
 * `cannot_record` into a write, which is what keeps a partial capture out of a
 * ledger the reader trusts.
 */
export function decideCaptureWrite(args: {
  commit: boolean;
  plannedAction: "create_revision" | "idempotent_noop" | "cannot_record";
  planReason: string;
  writesUsed: number;
  maxWrites: number;
}): CaptureWriteDecision {
  if (args.plannedAction === "cannot_record") {
    return { outcome: "write_refused", reason: args.planReason };
  }
  if (args.plannedAction === "idempotent_noop") {
    return { outcome: "idempotent_noop", reason: "unchanged_capture_exists" };
  }
  if (!args.commit) {
    return { outcome: "dry_run", reason: "commit_not_requested" };
  }
  if (args.writesUsed >= args.maxWrites) {
    return {
      outcome: "write_skipped_write_cap",
      reason: `write_cap_reached_at_${args.maxWrites}`,
    };
  }
  return { outcome: "written", reason: "new_or_changed_observation" };
}

export interface CaptureWriteInput {
  job_id: string;
  attendance_cycle_id: string | null;
  role: SesPortalCaptureRole | null;
  capture_result: SesPortalCaptureResult;
  source_url: string;
  source_content_hash: string;
  builder_reference: string;
  captured_at: string;
  capture_idempotency_key: string | null;
  signal: string;
  screenshot: { content_hash: string; bytes_base64: string } | null;
}

export class CaptureWriteRefusal extends Error {
  reason: string;
  constructor(reason: string) {
    super(`portal capture write refused: ${reason}`);
    this.name = "CaptureWriteRefusal";
    this.reason = reason;
  }
}

/**
 * Refuse any ops-api action other than the append-only evidence recorder.
 *
 * This is the structural half of "the observer never writes a stage".
 */
export function assertCaptureWriteAction(action: string): void {
  if (action !== SES_PORTAL_CAPTURE_WRITE_ACTION) {
    throw new CaptureWriteRefusal(
      `disallowed_ops_api_action_${JSON.stringify(action)}`,
    );
  }
}

/**
 * Build the exact `record_ses_portal_capture_evidence` body, or refuse.
 *
 * Every element the reader gates on is required here, so an incomplete
 * observation cannot reach the network at all: exact job, exact cycle, typed
 * role, exact HTTPS URL, source fingerprint, builder reference, idempotency
 * key, signal, and - for anything other than `unreachable` - the screenshot and
 * its hash. `unreachable` is the mirror rule: it must carry NO screenshot,
 * because "we could not look" is not a picture of anything.
 */
export function buildCaptureWriteRequest(
  input: CaptureWriteInput,
): {
  action: typeof SES_PORTAL_CAPTURE_WRITE_ACTION;
  body: Record<string, unknown>;
} {
  const required: Array<[string, unknown]> = [
    ["missing_job_id", input.job_id],
    ["missing_attendance_cycle", input.attendance_cycle_id],
    ["unbound_capture_role", input.role],
    ["missing_builder_reference", input.builder_reference?.trim()],
    ["missing_capture_idempotency_key", input.capture_idempotency_key],
    ["missing_signal", input.signal?.trim()],
    ["missing_captured_at", input.captured_at],
  ];
  for (const [reason, value] of required) {
    if (!value) throw new CaptureWriteRefusal(reason);
  }
  if (!canonicalSesPortalSourceUrl(input.source_url)) {
    throw new CaptureWriteRefusal("missing_or_non_https_source_url");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.source_content_hash || "")) {
    throw new CaptureWriteRefusal("missing_source_content_hash");
  }
  if (input.capture_result === "unreachable") {
    if (input.screenshot) {
      throw new CaptureWriteRefusal("unreachable_capture_carries_screenshot");
    }
  } else {
    if (!input.screenshot) {
      throw new CaptureWriteRefusal("missing_screenshot");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(input.screenshot.content_hash || "")) {
      throw new CaptureWriteRefusal("missing_screenshot_content_hash");
    }
    if (!input.screenshot.bytes_base64) {
      throw new CaptureWriteRefusal("missing_screenshot_bytes");
    }
  }

  const body: Record<string, unknown> = {
    job_id: input.job_id,
    attendance_cycle_id: input.attendance_cycle_id,
    role: input.role,
    capture_result: input.capture_result,
    source_url: canonicalSesPortalSourceUrl(input.source_url),
    source_content_hash: input.source_content_hash,
    builder_reference: input.builder_reference.trim(),
    captured_at: input.captured_at,
    // The concrete agent that did the looking. `capture_producer` below names
    // the approved producer CONTRACT, whose membership is a captain question
    // (see SES_TRUSTED_PORTAL_CAPTURE_PRODUCERS); this field is how the ledger
    // still records exactly which implementation observed the page.
    captured_by: SES_PORTAL_CAPTURE_OBSERVER_AGENT,
    capture_producer: SES_PORTAL_CAPTURE_PRODUCER,
    capture_idempotency_key: input.capture_idempotency_key,
    signal: input.signal,
  };
  if (input.screenshot) {
    body.screenshot = {
      media_type: "image/png",
      content_hash: input.screenshot.content_hash,
      bytes_base64: input.screenshot.bytes_base64,
    };
  }
  return { action: SES_PORTAL_CAPTURE_WRITE_ACTION, body };
}

type BoardCard = {
  job_id: string;
  job_number: string;
  job_status: string;
  job_type: string;
  makesafe_job_family: string | null;
  insurance_job_type: string | null;
  metadata_external_ref: string | null;
  report_type: string | null;
  external_ref: string | null;
  external_links: unknown;
  cycle_number: number | null;
  attendance_cycle_id: string | null;
};

type IntakeCase = {
  id: string;
  job_id: string | null;
  target_job_id: string | null;
  state: string | null;
  builder_wo_canonical: string | null;
  builder_po_canonical: string | null;
  external_ref_canonical: string | null;
};

type IdentityRevision = {
  job_id: string;
  authority_kind: string;
};

type CaptureTask = {
  card: BoardCard;
  builder_reference: string;
  url: string;
  source_url_hash: string;
  role: SesPortalCaptureRole | null;
  role_reason: string | null;
  link_index: number;
};

type BrowserPageRead = {
  ready_state: string;
  body_text: string;
  spinner_visible: boolean;
  job_details_panels: number;
};

type ScreenshotEvidence = {
  relative_path: string;
  content_hash: string;
  size_bytes: number;
  width: number;
  height: number;
  job_details_panels_redacted: number;
  opaque_frame_verified: true;
};

type ObserverOptions = {
  outputDir: string;
  job: string | null;
  limit: number | null;
  initialWaitMs: number;
  retryWaitMs: number;
  commit: boolean;
  maxWrites: number;
  help: boolean;
};

type ObserverSummary = {
  observedTotal: PopulationCountSummary;
  canonicalLiveBoard: PopulationCountSummary;
  outputDir: string;
  commit: boolean;
  writes: number;
};

type PopulationName =
  | "observed_total"
  | "canonical_live_board"
  | "off_board_observed";

type PopulationCountSummary = {
  population: PopulationName;
  candidate_cards: number;
  portal_cards: number;
  portal_links: number;
  by_outcome: Record<string, number>;
  by_planned_action: Record<string, number>;
  by_write_outcome: Record<string, number>;
  revisions_written: number;
  existing_capture_rows: number;
  roof_cards: number;
  roof_would_become_provable: number;
  roof_would_remain_unprovable: number;
  roof_remain_unprovable_by_reason: Record<string, number>;
};

export class ObserverUsageError extends Error {}

export function observerPopulationForJobStatus(
  value: unknown,
): "canonical_live_board" | "off_board_observed" {
  return isCanonicalLiveMakesafeBoardJobStatus(value)
    ? "canonical_live_board"
    : "off_board_observed";
}

type SanitizedTaskResult = {
  job_id: string;
  job_number: string;
  builder_reference: string;
  family: string;
  population: "canonical_live_board" | "off_board_observed";
  cycle_number: number;
  attendance_cycle_id: string | null;
  link_index: number;
  role: SesPortalCaptureRole | null;
  source_url_hash: string;
  source_content_hash: string;
  outcome: PrimePortalOutcome;
  reason_code:
    | PrimePortalVerdict["reason_code"]
    | "unbound_capture_role"
    | "missing_attendance_cycle"
    | "missing_builder_reference";
  capture_result: SesPortalCaptureResult;
  answered_fields: number | null;
  total_fields: number | null;
  signal: string;
  screenshot: ScreenshotEvidence | null;
  recordable: boolean;
  planned_action: "create_revision" | "idempotent_noop" | "cannot_record";
  plan_reason: string;
  capture_idempotency_key: string | null;
  write_outcome: CaptureWriteOutcome;
  write_reason: string;
  revision_id: string | null;
};

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function assertReadOnlySql(sql: string): void {
  const normalized = sql.trim().toLowerCase();
  if (!/^(select|with)\b/.test(normalized)) {
    throw new Error("refused non-SELECT management query");
  }
  for (const verb of WRITE_VERBS) {
    if (new RegExp(`(^|[^a-z_])${verb}(?![a-z_])`, "i").test(normalized)) {
      throw new Error(`refused management query naming write verb "${verb}"`);
    }
  }
}

async function managementQuery<T>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("SUPABASE_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-F7-Prime-Observer/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error(
      `read-only management query failed: HTTP ${response.status}`,
    );
  }
  return payload as T[];
}

export interface CaptureWriteTransport {
  (
    action: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; payload: any }>;
}

/**
 * The real egress. Every call goes through `assertCaptureWriteAction`, so the
 * allow-list cannot be bypassed by a caller that assembles its own URL.
 */
export const opsApiCaptureWriteTransport: CaptureWriteTransport = async (
  action,
  body,
) => {
  assertCaptureWriteAction(action);
  const response = await fetch(`${FUNCTIONS_BASE}/ops-api?action=${action}`, {
    method: "POST",
    headers: {
      "x-api-key": requiredEnv("SW_API_KEY"),
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-F7-Prime-Observer/1.0",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
};

export interface CaptureWriteResult {
  outcome: "written" | "idempotent_noop" | "write_failed";
  reason: string;
  revision_id: string | null;
}

/**
 * Append one revision and classify the answer.
 *
 * Idempotency is defended twice and this is the SECOND layer. The planner
 * already skips an unchanged observation before we get here; if a concurrent
 * run wrote the same key first, the database unique index refuses the insert
 * and that refusal is a successful no-duplicate outcome, not an error.
 */
export async function writeCaptureRevision(
  request: {
    action: typeof SES_PORTAL_CAPTURE_WRITE_ACTION;
    body: Record<string, unknown>;
  },
  transport: CaptureWriteTransport,
): Promise<CaptureWriteResult> {
  assertCaptureWriteAction(request.action);
  const { status, payload } = await transport(request.action, request.body);
  if (status >= 200 && status < 300 && payload?.id) {
    return {
      outcome: "written",
      reason: "revision_appended",
      revision_id: String(payload.id),
    };
  }
  const code = String(payload?.code || "");
  const message = String(payload?.error || `http_${status}`);
  if (
    code === "ses_portal_capture_commit_failed" &&
    /idempotency conflict/i.test(message)
  ) {
    return {
      outcome: "idempotent_noop",
      reason: "database_idempotency_conflict",
      revision_id: null,
    };
  }
  return {
    outcome: "write_failed",
    reason: code || message,
    revision_id: null,
  };
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function normalizePrimeSourceText(value: string): string {
  return String(value || "").replace(/\r\n?/g, "\n").normalize("NFC");
}

function firstProgressCount(
  text: string,
): { answered: number; total: number } | null {
  for (const match of text.matchAll(/\b(\d{1,3})\s+of\s+(\d{1,3})\b/gi)) {
    const answered = Number(match[1]);
    const total = Number(match[2]);
    if (total > 0 && answered >= 0 && answered <= total) {
      return { answered, total };
    }
  }
  return null;
}

export function classifyPrimePortalText(
  rawText: string,
  navigationSucceeded = true,
): PrimePortalVerdict {
  const text = normalizePrimeSourceText(rawText);
  const lower = text.toLowerCase();
  const progress = firstProgressCount(text);
  const answered = progress?.answered ?? null;
  const total = progress?.total ?? null;

  if (!navigationSucceeded || !text.trim()) {
    return {
      outcome: "cannot_observe",
      capture_result: "unreachable",
      reason_code: "page_failed_to_load",
      answered_fields: answered,
      total_fields: total,
      observed_phrase: "The page did not produce observable Prime form text.",
      signal: "cannot observe: page failed to load",
    };
  }
  if (
    /no longer active or has expired|link is unavailable|share link has expired|page not found/
      .test(
        lower,
      )
  ) {
    return {
      outcome: "cannot_observe",
      capture_result: "unreachable",
      reason_code: "expired_or_inactive_link",
      answered_fields: answered,
      total_fields: total,
      observed_phrase:
        "The Prime share link is no longer active or has expired.",
      signal: "cannot observe: Prime link expired or inactive",
    };
  }

  const locked =
    /this form has been locked|locked and is no longer available for (?:editing|changes|submission)/
      .test(
        lower,
      );
  const submitted =
    /has been submitted|submitted and locked|estimate is in review and cannot be edited|submission is in review/
      .test(
        lower,
      );
  if (locked || submitted) {
    const progressSignal = progress
      ? `, ${progress.answered} of ${progress.total} fields answered`
      : "";
    return {
      outcome: "submitted_locked",
      capture_result: "done",
      reason_code: "locked_or_submitted_observed",
      answered_fields: answered,
      total_fields: total,
      observed_phrase: locked
        ? "This form has been locked."
        : "This submission is in review and cannot be edited.",
      signal: `submitted/locked observed${progressSignal}`,
    };
  }

  if (progress && progress.answered === 0) {
    return {
      outcome: "not_started",
      capture_result: "not_done",
      reason_code: "zero_answered_fields",
      answered_fields: 0,
      total_fields: progress.total,
      observed_phrase: `0 of ${progress.total}`,
      signal: `not started: 0 of ${progress.total} fields answered`,
    };
  }
  if (progress && progress.answered > 0) {
    return {
      outcome: "in_progress",
      capture_result: "not_done",
      reason_code: "answered_fields_without_submission",
      answered_fields: progress.answered,
      total_fields: progress.total,
      observed_phrase: `${progress.answered} of ${progress.total}`,
      signal:
        `in progress: ${progress.answered} of ${progress.total} fields answered; locked/submitted state not observed`,
    };
  }

  return {
    outcome: "cannot_observe",
    capture_result: "unreachable",
    reason_code: "state_not_classifiable",
    answered_fields: null,
    total_fields: null,
    observed_phrase: "Prime form state could not be classified.",
    signal: "cannot observe: Prime form state not classifiable",
  };
}

export function planCaptureRevision(
  candidate: CaptureCandidate,
  existingRows: ExistingCaptureLike[],
): CapturePlanDecision {
  const unchanged = existingRows.some((row) =>
    row.job_id === candidate.job_id &&
    row.attendance_cycle_id === candidate.attendance_cycle_id &&
    row.role === candidate.role &&
    row.capture_result === candidate.capture_result &&
    canonicalSesPortalSourceUrl(row.source_url) ===
      canonicalSesPortalSourceUrl(candidate.source_url) &&
    row.source_content_hash === candidate.source_content_hash &&
    (candidate.capture_result === "unreachable" ||
      /^sha256:[0-9a-f]{64}$/.test(row.screenshot_content_hash || ""))
  );
  return unchanged
    ? { action: "idempotent_noop", reason: "unchanged_capture_exists" }
    : { action: "create_revision", reason: "new_or_changed_observation" };
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
  return `sha256:${
    Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    )
  }`;
}

async function sha256Text(value: string): Promise<string> {
  return await sha256Bytes(new TextEncoder().encode(value));
}

function safeReference(value: unknown): string {
  return String(value || "").replace(/[^a-z0-9 ._/-]/gi, "").trim().slice(
    0,
    100,
  );
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildSafeEvidenceFrameHtml(args: {
  jobNumber: string;
  builderReference: string;
  verdict: PrimePortalVerdict;
  capturedAt: string;
}): string {
  const jobNumber = escapeHtml(safeReference(args.jobNumber));
  const builderReference = escapeHtml(safeReference(args.builderReference));
  const progress = args.verdict.answered_fields != null &&
      args.verdict.total_fields != null
    ? `${args.verdict.answered_fields} of ${args.verdict.total_fields}`
    : null;
  const safeVerdict = args.verdict.outcome === "submitted_locked"
    ? {
      phrase: "This form has been locked or submitted.",
      signal: progress
        ? `submitted/locked observed, ${progress} fields answered`
        : "submitted/locked observed",
    }
    : args.verdict.outcome === "in_progress"
    ? {
      phrase: progress || "Prime form is in progress.",
      signal: progress
        ? `in progress: ${progress} fields answered; locked/submitted state not observed`
        : "in progress; locked/submitted state not observed",
    }
    : {
      phrase: progress || "Prime form has not been started.",
      signal: progress
        ? `not started: ${progress} fields answered`
        : "not started",
    };
  const phrase = escapeHtml(safeVerdict.phrase);
  const signal = escapeHtml(safeVerdict.signal);
  const capturedAt = escapeHtml(args.capturedAt);
  return `
    <div class="ses-f7-brand">Prime portal observation</div>
    <h1>${phrase}</h1>
    <dl>
      <dt>SecureWorks card</dt><dd>${jobNumber || "reference unavailable"}</dd>
      <dt>Builder reference</dt><dd>${
    builderReference || "reference unavailable"
  }</dd>
      <dt>Observed state</dt><dd>${signal}</dd>
      <dt>Observed at</dt><dd>${capturedAt}</dd>
    </dl>
    <p class="ses-f7-redaction">Job details panel redacted before capture.</p>
  `;
}

function roleFromLink(
  rawRole: string,
  card: BoardCard,
): { role: SesPortalCaptureRole | null; reason: string | null } {
  const role = String(rawRole || "").trim().toLowerCase();
  if (role === "roof_report") return { role: "roof_report", reason: null };
  if (role === "assessment_report") {
    return { role: "assessment", reason: null };
  }
  if (role === "photos") return { role: "photos", reason: null };
  if (role === "quote") return { role: "scope", reason: null };
  if (role === "builder_portal" && isRoofCard(card)) {
    return { role: "roof_report", reason: null };
  }
  return { role: null, reason: "unbound_capture_role" };
}

function canonicalBuilderReference(
  card: BoardCard,
  cases: IntakeCase[],
  identity: IdentityRevision | undefined,
): string {
  const liveCases = cases.filter((item) =>
    ["confirmed_live_job", "blocked_live_job"].includes(
      String(item.state || ""),
    )
  );
  if (liveCases.length === 1) {
    const source = liveCases[0];
    return String(
      source.builder_wo_canonical || source.builder_po_canonical ||
        source.external_ref_canonical || "",
    );
  }
  if (identity && identity.authority_kind !== "unresolved_authority") {
    return String(card.external_ref || card.metadata_external_ref || "");
  }
  return "";
}

async function command(
  args: string[],
  options: { stdin?: string; tolerateFailure?: boolean } = {},
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const child = new Deno.Command("chrome-devtools-axi", {
    args,
    stdin: options.stdin == null ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (options.stdin != null && child.stdin) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }
  const output = await child.output();
  const result = {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
  if (!result.success && !options.tolerateFailure) {
    throw new Error(`chrome-devtools-axi ${args[0]} failed`);
  }
  return result;
}

async function axiRun(script: string): Promise<string> {
  const result = await command(["run"], { stdin: script });
  return result.stdout.trim();
}

async function readPrimePage(): Promise<BrowserPageRead> {
  const raw = await axiRun(`
    const value = await page.eval(() => ({
      ready_state: document.readyState,
      body_text: document.body?.innerText || "",
      spinner_visible: !!document.querySelector(".prime-spinner"),
      job_details_panels: document.querySelectorAll("prime-object-summary").length,
    }));
    console.log(JSON.stringify(value));
  `);
  return JSON.parse(raw) as BrowserPageRead;
}

async function openAndReadPrimePage(
  url: string,
  initialWaitMs: number,
  retryWaitMs: number,
): Promise<{ read: BrowserPageRead; navigationSucceeded: boolean }> {
  const failedRead = (): {
    read: BrowserPageRead;
    navigationSucceeded: false;
  } => ({
    navigationSucceeded: false,
    read: {
      ready_state: "failed",
      body_text: "",
      spinner_visible: false,
      job_details_panels: 0,
    },
  });
  const opened = await command(["open", url], { tolerateFailure: true });
  if (!opened.success) {
    return failedRead();
  }
  await new Promise((resolve) => setTimeout(resolve, initialWaitMs));
  try {
    let read = await readPrimePage();
    if (
      read.spinner_visible || read.ready_state !== "complete" ||
      read.body_text.trim().length < 40
    ) {
      await new Promise((resolve) => setTimeout(resolve, retryWaitMs));
      read = await readPrimePage();
    }
    return {
      navigationSucceeded: read.ready_state === "complete" &&
        read.body_text.trim().length > 0,
      read,
    };
  } catch {
    return failedRead();
  }
}

async function installSafeCaptureFrame(
  html: string,
): Promise<
  { job_details_panels_redacted: number; opaque_frame_verified: true }
> {
  const script = `
    const result = await page.eval(() => {
      const panels = [...document.querySelectorAll("prime-object-summary")];
      for (const panel of panels) {
        panel.replaceChildren();
        panel.setAttribute("data-ses-f7-redacted", "true");
      }
      document.querySelector("#ses-f7-capture-frame")?.remove();
      const frame = document.createElement("section");
      frame.id = "ses-f7-capture-frame";
      frame.setAttribute("aria-label", "sanitized Prime portal evidence");
      frame.style.cssText = [
        "position:fixed", "inset:0", "z-index:2147483647", "overflow:auto",
        "box-sizing:border-box", "padding:64px", "background:rgb(255,255,255)",
        "color:rgb(25,31,41)", "font:18px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
      ].join(";");
      frame.innerHTML = ${JSON.stringify(html)};
      const style = document.createElement("style");
      style.textContent = "#ses-f7-capture-frame h1{font-size:34px;max-width:900px;margin:28px 0}#ses-f7-capture-frame dl{display:grid;grid-template-columns:190px 1fr;gap:12px;max-width:900px}#ses-f7-capture-frame dt{font-weight:700}#ses-f7-capture-frame dd{margin:0}#ses-f7-capture-frame .ses-f7-brand{font-weight:800;color:#2456a6}#ses-f7-capture-frame .ses-f7-redaction{margin-top:40px;padding:16px;background:#f1f4f8;border-radius:8px}";
      frame.prepend(style);
      document.body.append(frame);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      const css = getComputedStyle(frame);
      const points = [[1,1],[innerWidth-2,1],[1,innerHeight-2],[innerWidth-2,innerHeight-2],[innerWidth/2,innerHeight/2]];
      const covered = points.every(([x,y]) => document.elementFromPoint(x,y)?.closest("#ses-f7-capture-frame"));
      const panelsBlank = panels.every((panel) => !(panel.textContent || "").trim());
      return {
        panel_count: panels.length,
        panels_blank: panelsBlank,
        background: css.backgroundColor,
        covered,
        frame_text: frame.innerText,
      };
    });
    console.log(JSON.stringify(result));
  `;
  const raw = await axiRun(script);
  const checked = JSON.parse(raw);
  if (
    checked.panels_blank !== true || checked.covered !== true ||
    checked.background !== "rgb(255, 255, 255)"
  ) {
    throw new Error("privacy frame verification failed");
  }
  return {
    job_details_panels_redacted: Number(checked.panel_count || 0),
    opaque_frame_verified: true,
  };
}

async function verifyPng(path: string): Promise<{
  content_hash: string;
  size_bytes: number;
  width: number;
  height: number;
}> {
  const bytes = await Deno.readFile(path);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < signature.length ||
    !signature.every((value, index) => bytes[index] === value)
  ) {
    throw new Error("capture is not a decodable PNG candidate");
  }
  const inspected = await new Deno.Command("sips", {
    args: ["-g", "pixelWidth", "-g", "pixelHeight", path],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!inspected.success) {
    throw new Error("screenshot image verification failed");
  }
  const text = new TextDecoder().decode(inspected.stdout);
  const width = Number(text.match(/pixelWidth:\s*(\d+)/)?.[1] || 0);
  const height = Number(text.match(/pixelHeight:\s*(\d+)/)?.[1] || 0);
  if (width < 640 || height < 480) {
    throw new Error("screenshot dimensions are below the evidence floor");
  }
  return {
    content_hash: await sha256Bytes(bytes),
    size_bytes: bytes.byteLength,
    width,
    height,
  };
}

async function captureViewportPng(destinationPath: string): Promise<void> {
  const temporaryPath = await Deno.makeTempFile({
    dir: "/tmp",
    prefix: "ses-f7-prime-capture-",
    suffix: ".png",
  });
  try {
    await command(["screenshot", temporaryPath, "--format", "png"]);
    const bytes = await Deno.readFile(temporaryPath);
    if (bytes.byteLength === 0) {
      throw new Error("chrome-devtools-axi returned an empty screenshot");
    }
    await Deno.writeFile(destinationPath, bytes);
  } finally {
    await Deno.remove(temporaryPath).catch(() => undefined);
  }
}

function boardFamily(card: BoardCard): string {
  if (
    card.job_type === "insurance" &&
    card.insurance_job_type === "restoration"
  ) return "restoration";
  if (isRoofCard(card)) return "roof_report";
  if (
    ["assessment_report", "assessment_report_quote"].includes(
      String(card.report_type || card.makesafe_job_family || ""),
    )
  ) return "assessment_report_quote";
  return String(card.makesafe_job_family || card.report_type || "unknown");
}

function isRoofCard(card: BoardCard): boolean {
  return [
    "ordinary_roof_portal",
    "own_template_roof",
    "roof_report",
  ].includes(String(card.makesafe_job_family || "")) ||
    card.report_type === "roof_report";
}

async function loadLiveInputs(): Promise<{
  cards: BoardCard[];
  existing: ExistingCaptureLike[];
  cases: IntakeCase[];
  identities: IdentityRevision[];
}> {
  const cards = await managementQuery<BoardCard>(`
select
  j.id as job_id,
  j.job_number,
  j.status as job_status,
  j.type as job_type,
  j.metadata->>'makesafe_job_family' as makesafe_job_family,
  j.metadata->>'insurance_job_type' as insurance_job_type,
  j.metadata->>'external_ref' as metadata_external_ref,
  d.report_type,
  d.external_ref,
  d.external_links,
  d.cycle_number,
  d.attendance_cycle_id
from jobs j
join makesafe_job_details d on d.job_id = j.id
where j.status not in ('cancelled', 'lost')
  and (
    j.type = 'makesafe'
    or (j.type = 'insurance' and j.metadata->>'insurance_job_type' = 'restoration')
  )
  and coalesce(j.metadata->>'synthetic_livefire', '') <> 'true'
order by j.job_number, j.id
  `);
  const [existing, cases, identities] = await Promise.all([
    managementQuery<ExistingCaptureLike>(`
select
  job_id, attendance_cycle_id, role, capture_result, source_url,
  source_content_hash, screenshot_content_hash
from makesafe_portal_capture_revisions
order by job_id, makesafe_fact_version desc
    `),
    managementQuery<IntakeCase>(`
select
  id, job_id, target_job_id, state, builder_wo_canonical,
  builder_po_canonical, external_ref_canonical
from makesafe_intake_cases
where state in ('confirmed_live_job', 'blocked_live_job')
    `),
    managementQuery<IdentityRevision>(`
select job_id, authority_kind
from makesafe_state_identity_current_v2
    `),
  ]);
  return { cards, existing, cases, identities };
}

async function buildTasks(
  cards: BoardCard[],
  cases: IntakeCase[],
  identities: IdentityRevision[],
): Promise<CaptureTask[]> {
  const casesByJob = new Map<string, IntakeCase[]>();
  for (const source of cases) {
    for (const id of [source.job_id, source.target_job_id]) {
      if (!id) continue;
      const rows = casesByJob.get(id) || [];
      if (!rows.some((row) => row.id === source.id)) rows.push(source);
      casesByJob.set(id, rows);
    }
  }
  const identityByJob = new Map(identities.map((row) => [row.job_id, row]));
  const tasks: CaptureTask[] = [];
  for (const card of cards) {
    const links = extractPortalLinks(card.external_links);
    const builderReference = canonicalBuilderReference(
      card,
      casesByJob.get(card.job_id) || [],
      identityByJob.get(card.job_id),
    );
    for (const [index, link] of links.entries()) {
      const resolved = roleFromLink(link.role, card);
      const url = canonicalSesPortalSourceUrl(link.url);
      if (!url) continue;
      tasks.push({
        card,
        builder_reference: builderReference,
        url,
        source_url_hash: await sha256Text(url),
        role: resolved.role,
        role_reason: resolved.reason,
        link_index: index + 1,
      });
    }
  }
  return tasks;
}

/** Switches, not key=value flags. `--commit=false` must not read as "off". */
const BOOLEAN_FLAGS = new Set(["help", "commit"]);

export function parseOptions(args: string[]): ObserverOptions {
  const known = new Set([
    "help",
    "out-dir",
    "job",
    "limit",
    "initial-wait-ms",
    "retry-wait-ms",
    "commit",
    "max-writes",
  ]);
  const values = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) {
      throw new ObserverUsageError(
        `unexpected argument ${JSON.stringify(arg)}`,
      );
    }
    const [key, ...rest] = arg.slice(2).split("=");
    if (!known.has(key)) {
      throw new ObserverUsageError(`unknown flag --${key}`);
    }
    const value = rest.join("=");
    if (!BOOLEAN_FLAGS.has(key) && !value) {
      throw new ObserverUsageError(`--${key} requires a value after =`);
    }
    if (BOOLEAN_FLAGS.has(key) && value) {
      throw new ObserverUsageError(`--${key} is a switch and takes no value`);
    }
    values.set(key, value || "true");
  }
  const help = values.has("help");
  const outputDir = values.get("out-dir") || DEFAULT_OUTPUT_DIR;
  const job = values.get("job") || null;
  const commit = values.has("commit");
  // A writer that can be aimed at the whole board is a backfill waiting to be
  // typed by accident. Committing REQUIRES one named card.
  if (commit && !job) {
    throw new ObserverUsageError(
      "--commit requires --job=<board reference>; there is no bulk capture mode",
    );
  }
  const maxWrites = positiveInteger(
    values.get("max-writes") || "1",
    "--max-writes",
  );
  if (values.has("max-writes") && !commit) {
    throw new ObserverUsageError(
      "--max-writes is only meaningful with --commit",
    );
  }
  const limit = optionalPositiveInteger(values.get("limit"), "--limit");
  const initialWaitMs = positiveInteger(
    values.get("initial-wait-ms") || String(DEFAULT_INITIAL_WAIT_MS),
    "--initial-wait-ms",
  );
  const retryWaitMs = positiveInteger(
    values.get("retry-wait-ms") || String(DEFAULT_RETRY_WAIT_MS),
    "--retry-wait-ms",
  );
  return {
    outputDir,
    job,
    limit,
    initialWaitMs: Math.max(1_000, initialWaitMs),
    retryWaitMs: Math.max(1_000, retryWaitMs),
    commit,
    maxWrites,
    help,
  };
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ObserverUsageError(`${flag} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(
  raw: string | undefined,
  flag: string,
): number | null {
  return raw == null ? null : positiveInteger(raw, flag);
}

export function printHelp(): void {
  console.log(`command: ses-f7-prime-portal-observer
description: Read genuine Prime share links without mutation, and optionally append what was observed to the capture ledger.
mode: dry-run by default; --commit appends evidence revisions only
flags[8]{flag,default,description}:
  --help,false,Show this reference without reading production
  --out-dir=<path>,${JSON.stringify(DEFAULT_OUTPUT_DIR)},Artifact directory
  --job=<job-reference>,all,Observe one exact board job reference
  --limit=<count>,all,Observe at most this many portal links
  --initial-wait-ms=<milliseconds>,${DEFAULT_INITIAL_WAIT_MS},Wait after opening each link
  --retry-wait-ms=<milliseconds>,${DEFAULT_RETRY_WAIT_MS},Extra wait for an incomplete load
  --commit,false,Append observed captures via ${SES_PORTAL_CAPTURE_WRITE_ACTION}; requires --job and SW_API_KEY
  --max-writes=<count>,1,Cap revisions appended in one --commit run
env[2]{name,requirement}:
  SUPABASE_ACCESS_TOKEN,always (read-only Management API)
  SW_API_KEY,only with --commit
examples[4]:
  scripts/ses-f7-prime-portal-observer.ts --help
  scripts/ses-f7-prime-portal-observer.ts --job=SWMS-REFERENCE --out-dir=.omx/f7-sample
  scripts/ses-f7-prime-portal-observer.ts
  scripts/ses-f7-prime-portal-observer.ts --job=SWMS-REFERENCE --commit
notes[3]:
  Nothing is written without --commit; --commit cannot run board-wide.
  A missing cycle/role/builder-reference/screenshot writes nothing and records the reason.
  An unreachable or expired link records cannot-observe, never not-done.`);
}

function toonString(value: string): string {
  return JSON.stringify(value);
}

function printSummary(summary: ObserverSummary): void {
  const total = summary.observedTotal;
  const board = summary.canonicalLiveBoard;
  console.log(`result:
  mode: ${summary.commit ? "commit" : "dry-run"}
  production_writes: ${summary.writes}
  stage_moves: 0
  observed_total_candidate_cards: ${total.candidate_cards} of ${total.candidate_cards} observed-total candidate cards
  observed_total_portal_cards: ${total.portal_cards} of ${total.candidate_cards} observed-total candidate cards
  observed_total_portal_links: ${total.portal_links} of ${total.portal_links} observed-total links
  canonical_live_board_portal_cards: ${board.portal_cards} of ${board.candidate_cards} canonical-live-board candidate cards
  canonical_live_board_portal_links: ${board.portal_links} of ${total.portal_links} observed-total links
  observed_total_submitted_locked: ${
    total.by_outcome.submitted_locked || 0
  } of ${total.portal_links} observed-total links
  canonical_live_board_submitted_locked: ${
    board.by_outcome.submitted_locked || 0
  } of ${board.portal_links} canonical-live-board links
  observed_total_roof_provable: ${total.roof_would_become_provable} of ${total.roof_cards} observed-total roof cards
  canonical_live_board_roof_provable: ${board.roof_would_become_provable} of ${board.roof_cards} canonical-live-board roof cards
artifacts[2]{kind,path}:
  report,${toonString(`${summary.outputDir}/report.md`)}
  manifest,${toonString(`${summary.outputDir}/dry-run.json`)}`);
}

function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`error: ${toonString(message)}
help: Run scripts/ses-f7-prime-portal-observer.ts --help`);
}

function relativeToOutput(outputDir: string, path: string): string {
  return path.startsWith(`${outputDir}/`)
    ? path.slice(outputDir.length + 1)
    : path;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function countBy(
  rows: SanitizedTaskResult[],
  field: "outcome" | "planned_action" | "write_outcome",
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[field] || "unknown");
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function roofUnprovableReasons(
  cards: BoardCard[],
  results: SanitizedTaskResult[],
  provableIds: ReadonlySet<string>,
): Record<string, number> {
  const reasons: Record<string, number> = {};
  for (const card of cards.filter(isRoofCard)) {
    if (provableIds.has(card.job_id)) continue;
    const rows = results.filter((result) => result.job_id === card.job_id);
    let reason = "no_genuine_portal_link";
    if (rows.some((row) => row.reason_code === "missing_attendance_cycle")) {
      reason = "missing_attendance_cycle";
    } else if (
      rows.some((row) => row.reason_code === "missing_builder_reference")
    ) {
      reason = "missing_builder_reference";
    } else if (rows.some((row) => row.reason_code === "unbound_capture_role")) {
      reason = "unbound_capture_role";
    } else if (rows.some((row) => row.outcome === "in_progress")) {
      reason = "in_progress_not_submitted";
    } else if (rows.some((row) => row.outcome === "not_started")) {
      reason = "not_started";
    } else if (
      rows.some((row) => row.reason_code === "expired_or_inactive_link")
    ) {
      reason = "expired_or_inactive_link";
    } else if (rows.some((row) => row.outcome === "cannot_observe")) {
      reason = "cannot_observe_other";
    }
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return reasons;
}

function summarizePopulation(
  population: PopulationName,
  allCards: BoardCard[],
  allResults: SanitizedTaskResult[],
  existingRows: ExistingCaptureLike[],
): PopulationCountSummary {
  const cards = population === "observed_total"
    ? allCards
    : allCards.filter((card) =>
      (population === "canonical_live_board") ===
        isCanonicalLiveMakesafeBoardJobStatus(card.job_status)
    );
  const cardIds = new Set(cards.map((card) => card.job_id));
  const results = allResults.filter((row) => cardIds.has(row.job_id));
  const roofCards = cards.filter(isRoofCard);
  const roofDoneIds = new Set(
    results.filter((row) =>
      row.family === "roof_report" && row.role === "roof_report" &&
      row.outcome === "submitted_locked" && row.recordable &&
      !!row.screenshot
    ).map((row) => row.job_id),
  );
  return {
    population,
    candidate_cards: cards.length,
    portal_cards: new Set(results.map((row) => row.job_id)).size,
    portal_links: results.length,
    by_outcome: countBy(results, "outcome"),
    by_planned_action: countBy(results, "planned_action"),
    by_write_outcome: countBy(results, "write_outcome"),
    revisions_written:
      results.filter((row) => row.write_outcome === "written").length,
    existing_capture_rows: existingRows.filter((row) => cardIds.has(row.job_id))
      .length,
    roof_cards: roofCards.length,
    roof_would_become_provable: roofDoneIds.size,
    roof_would_remain_unprovable: roofCards.length - roofDoneIds.size,
    roof_remain_unprovable_by_reason: roofUnprovableReasons(
      cards,
      results,
      roofDoneIds,
    ),
  };
}

function outcomeTableRow(
  label: string,
  counts: PopulationCountSummary,
): string {
  const outcomes = [
    "submitted_locked",
    "in_progress",
    "not_started",
    "cannot_observe",
  ];
  return `| ${label} | ${counts.candidate_cards} candidate cards | ${counts.portal_cards} of ${counts.candidate_cards} candidate cards | ${counts.portal_links} links | ${
    outcomes.map((outcome) =>
      `${counts.by_outcome[outcome] || 0} of ${counts.portal_links} links`
    ).join(" | ")
  } |`;
}

function reportMarkdown(manifest: any): string {
  const total = manifest.counts.observed_total as PopulationCountSummary;
  const board = manifest.counts.canonical_live_board as PopulationCountSummary;
  const offBoard = manifest.counts.off_board_observed as PopulationCountSummary;
  const rows = manifest.results.map((row: SanitizedTaskResult) =>
    `| ${row.job_number} | ${row.population} | ${
      row.builder_reference || "(unavailable)"
    } | ${row.role || "unbound"} | ${row.outcome} | ${
      row.answered_fields == null
        ? "-"
        : `${row.answered_fields}/${row.total_fields}`
    } | ${row.planned_action} | ${row.plan_reason} | ${row.write_outcome} | ${row.write_reason} |`
  ).join("\n");
  const reasonRows = [
    ["canonical-live-board", board] as const,
    ["observed-total", total] as const,
    ["off-board-observed", offBoard] as const,
  ].flatMap(([label, counts]) =>
    Object.entries(counts.roof_remain_unprovable_by_reason).map(
      ([reason, count]) =>
        `| ${label} | ${reason} | ${count} of ${counts.roof_would_remain_unprovable} unprovable roof cards |`,
    )
  ).join("\n");
  const writeRows = [
    ["canonical-live-board", board] as const,
    ["observed-total", total] as const,
    ["off-board-observed", offBoard] as const,
  ].map(([label, counts]) => {
    const outcomes = [
      "dry_run",
      "written",
      "idempotent_noop",
      "write_refused",
      "write_skipped_write_cap",
      "write_failed",
    ];
    return `| ${label} | ${
      outcomes.map((outcome) =>
        `${
          counts.by_write_outcome[outcome] || 0
        } of ${counts.portal_links} links`
      ).join(" | ")
    } |`;
  }).join("\n");
  return `# F7 Prime portal observer - production ${manifest.mode} run

Generated: ${manifest.generated_at}
Generation: \`${manifest.generation_id}\`
Observer: \`${manifest.observer_version}\`
Mode: \`${manifest.mode}\`

## Result

The observer retained the wider read-only set and labelled every result with canonical live-board membership. The observed-total population contains ${total.candidate_cards} of ${total.candidate_cards} candidate cards; ${total.portal_cards} of ${total.candidate_cards} carry ${total.portal_links} genuine portal links. The canonical-live-board partition contains ${board.candidate_cards} of ${total.candidate_cards} observed-total candidate cards; ${board.portal_cards} of ${board.candidate_cards} carry ${board.portal_links} genuine portal links. The off-board-observed partition contains ${offBoard.candidate_cards} of ${total.candidate_cards} observed-total candidate cards; ${offBoard.portal_cards} of ${offBoard.candidate_cards} carry ${offBoard.portal_links} genuine portal links.

It performed ${manifest.production_access.writes} production writes among ${total.candidate_cards} observed-total candidate cards and 0 stage moves among ${total.candidate_cards} observed-total candidate cards. Every write is an append-only \`makesafe_portal_capture_revisions\` row via \`${SES_PORTAL_CAPTURE_WRITE_ACTION}\`; no revision is ever updated or deleted. Every database read used the Management API with \`read_only: true\`.

## Population-partitioned outcomes

| Population | Candidate-card denominator | Portal-card denominator | Link denominator | Submitted/locked | In progress | Not started | Cannot observe |
|---|---:|---:|---:|---:|---:|---:|---:|
${outcomeTableRow("canonical-live-board", board)}
${outcomeTableRow("observed-total", total)}
${outcomeTableRow("off-board-observed", offBoard)}

## Roof result

| Population | Roof-card denominator | Screenshot-provable | Remains unprovable |
|---|---:|---:|---:|
| canonical-live-board | ${board.roof_cards} roof cards | ${board.roof_would_become_provable} of ${board.roof_cards} roof cards | ${board.roof_would_remain_unprovable} of ${board.roof_cards} roof cards |
| observed-total | ${total.roof_cards} roof cards | ${total.roof_would_become_provable} of ${total.roof_cards} roof cards | ${total.roof_would_remain_unprovable} of ${total.roof_cards} roof cards |
| off-board-observed | ${offBoard.roof_cards} roof cards | ${offBoard.roof_would_become_provable} of ${offBoard.roof_cards} roof cards | ${offBoard.roof_would_remain_unprovable} of ${offBoard.roof_cards} roof cards |

Why roof cards remain unprovable, with each reason measured against its named population's unprovable-roof denominator:

| Population | Reason | Count and denominator |
|---|---|---:|
${reasonRows || "| observed-total | none | 0 of 0 unprovable roof cards |"}

## Capture-revision plan

| Population | Create revision | Idempotent no-op | Cannot record | Existing ledger rows |
|---|---:|---:|---:|---:|
| canonical-live-board | ${
    board.by_planned_action.create_revision || 0
  } of ${board.portal_links} links | ${
    board.by_planned_action.idempotent_noop || 0
  } of ${board.portal_links} links | ${
    board.by_planned_action.cannot_record || 0
  } of ${board.portal_links} links | ${board.existing_capture_rows} rows among ${board.candidate_cards} candidate cards |
| observed-total | ${
    total.by_planned_action.create_revision || 0
  } of ${total.portal_links} links | ${
    total.by_planned_action.idempotent_noop || 0
  } of ${total.portal_links} links | ${
    total.by_planned_action.cannot_record || 0
  } of ${total.portal_links} links | ${total.existing_capture_rows} rows among ${total.candidate_cards} candidate cards |
| off-board-observed | ${
    offBoard.by_planned_action.create_revision || 0
  } of ${offBoard.portal_links} links | ${
    offBoard.by_planned_action.idempotent_noop || 0
  } of ${offBoard.portal_links} links | ${
    offBoard.by_planned_action.cannot_record || 0
  } of ${offBoard.portal_links} links | ${offBoard.existing_capture_rows} rows among ${offBoard.candidate_cards} candidate cards |

## Privacy and write safety

The observer blanked Prime's \`prime-object-summary\` job-details component and then covered the viewport with an opaque evidence-only frame before each screenshot. The frame contains only job reference, builder reference, the classified Prime status phrase, field count, observation time, and the redaction notice. Raw page text and share URLs are omitted from this artifact; only SHA-256 fingerprints remain. Screenshot verification covers every screenshot referenced by the ${total.portal_links}-link observed-total manifest.

Unchanged observations already present in the ledger are \`idempotent_noop\`; changed or absent observations are \`create_revision\` candidates. Expired, inactive, failed, and unclassifiable pages are always \`cannot_observe\`, never \`not_started\`.

This run's mode was \`${manifest.mode}\`. It appended ${manifest.production_access.writes} of ${total.portal_links} observed-total links as capture revisions and performed 0 stage moves among ${total.candidate_cards} observed-total candidate cards. The only write action reachable from this process is \`${SES_PORTAL_CAPTURE_WRITE_ACTION}\`; \`assertCaptureWriteAction\` refuses every other ops-api action at the single egress point, so no stage, substatus, job status or card placement can be written from here. A \`--commit\` run requires an exact \`--job\` and is capped at \`--max-writes\` (this run: ${manifest.production_access.write_cap}); links left unwritten by that cap are reported as \`write_skipped_write_cap\` rather than dropped silently.

| Population | Dry run | Written | Idempotent no-op | Write refused | Skipped by cap | Write failed |
|---|---:|---:|---:|---:|---:|---:|
${writeRows}

## Per-link result

| Card | Population | Builder ref | Role | Outcome | Fields | Planned action | Reason | Write outcome | Write reason |
|---|---|---|---|---|---:|---|---|---|---|
${rows}

## Query and code evidence

- Q1: observed-total candidate cards plus exact current cycle and genuine portal-link source facts, labelled by the canonical live-board predicate shared with \`loadCanonicalMakesafeBoard\`; Management API \`read_only: true\`.
- Q2: existing \`makesafe_portal_capture_revisions\` rows for idempotency comparison, Management API \`read_only: true\`.
- Q3: current intake/identity authority required to derive the exact U4 builder reference, Management API \`read_only: true\`.
- Detailed sanitized results and screenshot hashes: [dry-run.json](dry-run.json).
`;
}

async function run(): Promise<ObserverSummary | null> {
  const options = parseOptions(Deno.args);
  if (options.help) {
    printHelp();
    return null;
  }
  await Deno.mkdir(`${options.outputDir}/screenshots`, { recursive: true });
  const generatedAt = new Date().toISOString();
  const live = await loadLiveInputs();
  const allTasks = await buildTasks(live.cards, live.cases, live.identities);
  let tasks = options.job
    ? allTasks.filter((task) => task.card.job_number === options.job)
    : allTasks;
  if (options.limit) tasks = tasks.slice(0, options.limit);
  const generationId = (await sha256Text(JSON.stringify({
    observer: OBSERVER_VERSION,
    generated_at: generatedAt,
    tasks: tasks.map((task) => ({
      job_id: task.card.job_id,
      cycle: task.card.attendance_cycle_id,
      role: task.role,
      source_url_hash: task.source_url_hash,
    })),
  }))).slice(0, "sha256:".length + 20);

  // Fail before touching a browser if a commit run cannot authenticate, rather
  // than after observing every link.
  if (options.commit) requiredEnv("SW_API_KEY");

  await command(["resize", "1200", "800"]);
  const results: SanitizedTaskResult[] = [];
  let writesUsed = 0;
  for (const [index, task] of tasks.entries()) {
    const capturedAt = new Date().toISOString();
    const opened = await openAndReadPrimePage(
      task.url,
      options.initialWaitMs,
      options.retryWaitMs,
    );
    const normalizedText = normalizePrimeSourceText(opened.read.body_text);
    let verdict = classifyPrimePortalText(
      normalizedText,
      opened.navigationSucceeded,
    );
    const sourceContentHash = await sha256Text(normalizedText);
    let screenshot: ScreenshotEvidence | null = null;
    if (verdict.capture_result !== "unreachable") {
      try {
        const html = buildSafeEvidenceFrameHtml({
          jobNumber: task.card.job_number,
          builderReference: task.builder_reference,
          verdict,
          capturedAt,
        });
        const privacy = await installSafeCaptureFrame(html);
        const fileName = `${
          safeReference(task.card.job_number).replaceAll("/", "-")
        }-${task.role || "unbound"}-${task.link_index}-${
          task.source_url_hash.slice(-12)
        }.png`;
        const path = `${options.outputDir}/screenshots/${fileName}`;
        await captureViewportPng(path);
        const verified = await verifyPng(path);
        screenshot = {
          relative_path: relativeToOutput(options.outputDir, path),
          ...verified,
          ...privacy,
        };
      } catch {
        verdict = classifyPrimePortalText("", false);
      }
    }

    const missingCycle = !task.card.attendance_cycle_id;
    const missingRole = !task.role;
    const missingBuilderReference = !task.builder_reference.trim();
    const recordable = !missingCycle && !missingRole &&
      !missingBuilderReference;
    let plannedAction: SanitizedTaskResult["planned_action"] = "cannot_record";
    let planReason = missingCycle
      ? "missing_attendance_cycle"
      : missingRole
      ? task.role_reason || "unbound_capture_role"
      : missingBuilderReference
      ? "missing_builder_reference"
      : "new_or_changed_observation";
    let idempotencyKey: string | null = null;
    if (recordable) {
      const candidate: CaptureCandidate = {
        job_id: task.card.job_id,
        attendance_cycle_id: task.card.attendance_cycle_id!,
        role: task.role!,
        capture_result: verdict.capture_result,
        source_url: task.url,
        source_content_hash: sourceContentHash,
        screenshot_content_hash: screenshot?.content_hash || null,
      };
      const decision = planCaptureRevision(candidate, live.existing);
      plannedAction = decision.action;
      planReason = decision.reason;
      idempotencyKey = await sha256Text(
        [
          "ses-portal-capture-v1",
          candidate.job_id,
          candidate.attendance_cycle_id,
          candidate.role,
          candidate.capture_result,
          task.source_url_hash,
          candidate.source_content_hash,
        ].join("\n"),
      );
    }

    let writeDecision = decideCaptureWrite({
      commit: options.commit,
      plannedAction: plannedAction,
      planReason: planReason,
      writesUsed,
      maxWrites: options.maxWrites,
    });
    let revisionId: string | null = null;
    if (writeDecision.outcome === "written") {
      // `decideCaptureWrite` returns "written" as an INTENT; the outcome below
      // is what actually happened. The cap counts revisions that were really
      // created, so a refusal, a no-op or a failure leaves it unspent - which
      // is safe because a commit run is already scoped to one named card.
      try {
        const screenshotBytes = screenshot
          ? await Deno.readFile(
            `${options.outputDir}/${screenshot.relative_path}`,
          )
          : null;
        const request = buildCaptureWriteRequest({
          job_id: task.card.job_id,
          attendance_cycle_id: task.card.attendance_cycle_id,
          role: task.role,
          capture_result: verdict.capture_result,
          source_url: task.url,
          source_content_hash: sourceContentHash,
          builder_reference: task.builder_reference,
          captured_at: capturedAt,
          capture_idempotency_key: idempotencyKey,
          signal: verdict.signal,
          screenshot: screenshotBytes && screenshot
            ? {
              content_hash: screenshot.content_hash,
              bytes_base64: base64FromBytes(screenshotBytes),
            }
            : null,
        });
        const written = await writeCaptureRevision(
          request,
          opsApiCaptureWriteTransport,
        );
        writeDecision = { outcome: written.outcome, reason: written.reason };
        revisionId = written.revision_id;
        if (written.outcome === "written") writesUsed += 1;
      } catch (error) {
        writeDecision = {
          outcome: error instanceof CaptureWriteRefusal
            ? "write_refused"
            : "write_failed",
          reason: error instanceof CaptureWriteRefusal
            ? error.reason
            : error instanceof Error
            ? error.message
            : String(error),
        };
      }
    }

    const population = observerPopulationForJobStatus(task.card.job_status);
    results.push({
      job_id: task.card.job_id,
      job_number: task.card.job_number,
      builder_reference: task.builder_reference,
      family: boardFamily(task.card),
      population,
      cycle_number: Number(task.card.cycle_number || 1),
      attendance_cycle_id: task.card.attendance_cycle_id,
      link_index: task.link_index,
      role: task.role,
      source_url_hash: task.source_url_hash,
      source_content_hash: sourceContentHash,
      outcome: verdict.outcome,
      reason_code: missingCycle
        ? "missing_attendance_cycle"
        : missingRole
        ? "unbound_capture_role"
        : missingBuilderReference
        ? "missing_builder_reference"
        : verdict.reason_code,
      capture_result: verdict.capture_result,
      answered_fields: verdict.answered_fields,
      total_fields: verdict.total_fields,
      signal: verdict.signal,
      screenshot,
      recordable,
      planned_action: plannedAction,
      plan_reason: planReason,
      capture_idempotency_key: idempotencyKey,
      write_outcome: writeDecision.outcome,
      write_reason: writeDecision.reason,
      revision_id: revisionId,
    });

    console.error(
      `[observed-total link ${
        index + 1
      }/${tasks.length}; ${population}] ${task.card.job_number} ${
        task.role || "unbound"
      } ${verdict.outcome} ${writeDecision.outcome}`,
    );
  }

  const observedTotal = summarizePopulation(
    "observed_total",
    live.cards,
    results,
    live.existing,
  );
  const canonicalLiveBoard = summarizePopulation(
    "canonical_live_board",
    live.cards,
    results,
    live.existing,
  );
  const offBoardObserved = summarizePopulation(
    "off_board_observed",
    live.cards,
    results,
    live.existing,
  );

  const manifest = {
    schema_version: "ses-f7-prime-portal-observation/v3",
    observer_version: OBSERVER_VERSION,
    mode: options.commit ? "commit" : "dry-run",
    capture_producer_contract: SES_PORTAL_CAPTURE_PRODUCER,
    capture_observer_agent: SES_PORTAL_CAPTURE_OBSERVER_AGENT,
    generated_at: generatedAt,
    generation_id: generationId,
    production_access: {
      database: "management-api read_only:true",
      browser: "chrome-devtools-axi open/eval/screenshot only",
      write_action: options.commit ? SES_PORTAL_CAPTURE_WRITE_ACTION : null,
      write_cap: options.commit ? options.maxWrites : 0,
      writes: observedTotal.revisions_written,
      stage_moves: 0,
    },
    counts: {
      observed_total: observedTotal,
      canonical_live_board: canonicalLiveBoard,
      off_board_observed: offBoardObserved,
    },
    results,
  };
  await writeJson(`${options.outputDir}/dry-run.json`, manifest);
  await Deno.writeTextFile(
    `${options.outputDir}/report.md`,
    reportMarkdown(manifest),
  );
  console.error(
    `complete: observed-total ${observedTotal.portal_links}/${observedTotal.portal_links} links across ${observedTotal.portal_cards}/${observedTotal.candidate_cards} portal/candidate cards; canonical-live-board ${canonicalLiveBoard.portal_links}/${observedTotal.portal_links} links and ${canonicalLiveBoard.roof_would_become_provable}/${canonicalLiveBoard.roof_cards} provable roof cards`,
  );
  return {
    observedTotal,
    canonicalLiveBoard,
    outputDir: options.outputDir,
    commit: options.commit,
    writes: observedTotal.revisions_written,
  };
}

if (import.meta.main) {
  try {
    const summary = await run();
    if (summary) printSummary(summary);
  } catch (error) {
    printError(error);
    Deno.exitCode = error instanceof ObserverUsageError ? 2 : 1;
  }
}
