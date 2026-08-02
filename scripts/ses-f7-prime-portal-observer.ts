#!/usr/bin/env -S deno run --allow-env=SUPABASE_ACCESS_TOKEN --allow-net=api.supabase.com --allow-read --allow-write --allow-run=chrome-devtools-axi,sips
// deno-lint-ignore-file no-explicit-any
/**
 * F7 - deterministic, view-only Prime portal observer.
 *
 * Default and only live mode in this tranche is dry-run. Production reads use
 * the Supabase Management API with `read_only: true`; the browser uses only
 * open/eval/screenshot. It never clicks, fills, types, presses, or submits.
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

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const OBSERVER_VERSION = "ses-prime-portal-observer/2026-08-02.2";
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
  help: boolean;
};

type ObserverSummary = {
  portalLinks: number;
  submittedLocked: number;
  inProgress: number;
  notStarted: number;
  cannotObserve: number;
  roofProvable: number;
  roofCards: number;
  outputDir: string;
};

export class ObserverUsageError extends Error {}

type SanitizedTaskResult = {
  job_id: string;
  job_number: string;
  builder_reference: string;
  family: string;
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
  const failedRead = (): { read: BrowserPageRead; navigationSucceeded: false } => ({
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
where j.status not in ('cancelled', 'archived', 'lost')
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

export function parseOptions(args: string[]): ObserverOptions {
  const known = new Set([
    "help",
    "out-dir",
    "job",
    "limit",
    "initial-wait-ms",
    "retry-wait-ms",
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
    if (key !== "help" && !value) {
      throw new ObserverUsageError(`--${key} requires a value after =`);
    }
    values.set(key, value || "true");
  }
  const help = values.has("help");
  const outputDir = values.get("out-dir") || DEFAULT_OUTPUT_DIR;
  const job = values.get("job") || null;
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

function printHelp(): void {
  console.log(`command: ses-f7-prime-portal-observer
description: Read genuine Prime share links without mutation and emit sanitized dry-run evidence.
mode: dry-run only
flags[6]{flag,default,description}:
  --help,false,Show this reference without reading production
  --out-dir=<path>,${JSON.stringify(DEFAULT_OUTPUT_DIR)},Artifact directory
  --job=<job-reference>,all,Observe one exact board job reference
  --limit=<count>,all,Observe at most this many portal links
  --initial-wait-ms=<milliseconds>,${DEFAULT_INITIAL_WAIT_MS},Wait after opening each link
  --retry-wait-ms=<milliseconds>,${DEFAULT_RETRY_WAIT_MS},Extra wait for an incomplete load
examples[3]:
  scripts/ses-f7-prime-portal-observer.ts --help
  scripts/ses-f7-prime-portal-observer.ts --job=SWMS-REFERENCE --out-dir=.omx/f7-sample
  scripts/ses-f7-prime-portal-observer.ts`);
}

function toonString(value: string): string {
  return JSON.stringify(value);
}

function printSummary(summary: ObserverSummary): void {
  console.log(`result:
  mode: dry-run
  production_writes: 0
  stage_moves: 0
  portal_links: ${summary.portalLinks}
  submitted_locked: ${summary.submittedLocked}
  in_progress: ${summary.inProgress}
  not_started: ${summary.notStarted}
  cannot_observe: ${summary.cannotObserve}
  roof_provable: ${summary.roofProvable} of ${summary.roofCards}
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

function reportMarkdown(manifest: any): string {
  const c = manifest.counts;
  const rows = manifest.results.map((row: SanitizedTaskResult) =>
    `| ${row.job_number} | ${row.builder_reference || "(unavailable)"} | ${
      row.role || "unbound"
    } | ${row.outcome} | ${
      row.answered_fields == null
        ? "-"
        : `${row.answered_fields}/${row.total_fields}`
    } | ${row.planned_action} | ${row.plan_reason} |`
  ).join("\n");
  const roofReasons = Object.entries(c.roof_remain_unprovable_by_reason)
    .map(([reason, count]) => `- ${reason}: ${count}`)
    .join("\n");
  return `# F7 Prime portal observer - production dry run

Generated: ${manifest.generated_at}
Generation: \`${manifest.generation_id}\`
Observer: \`${manifest.observer_version}\`

## Result

The observer read ${c.portal_cards} active board cards carrying ${c.portal_links} genuine portal links. It performed no production write and no stage move. Every database query used the Management API with \`read_only: true\`.

Link outcomes:

- submitted/locked: ${c.by_outcome.submitted_locked || 0}
- in progress: ${c.by_outcome.in_progress || 0}
- not started: ${c.by_outcome.not_started || 0}
- cannot observe: ${c.by_outcome.cannot_observe || 0}

Roof result: ${c.roof_would_become_provable} of ${c.roof_cards} active roof cards would become screenshot-provable from this dry run. ${c.roof_would_remain_unprovable} would remain unprovable.

Why roof cards remain unprovable:

${roofReasons || "- none"}

## Privacy and write safety

The observer blanked Prime's \`prime-object-summary\` job-details component and then covered the viewport with an opaque evidence-only frame before each screenshot. The frame contains only job reference, builder reference, the classified Prime status phrase, field count, observation time, and the redaction notice. Raw page text and share URLs are omitted from this artifact; only SHA-256 fingerprints remain.

The dry run planned the existing \`record_ses_portal_capture_evidence\` contract but did not call it. Unchanged observations already present in the ledger are \`idempotent_noop\`; changed or absent observations are \`create_revision\` candidates. Expired, inactive, failed, and unclassifiable pages are always \`cannot_observe\`, never \`not_started\`.

## Per-link result

| Card | Builder ref | Role | Outcome | Fields | Planned action | Reason |
|---|---|---|---|---:|---|---|
${rows}

## Query and code evidence

- Q1: active board cards plus exact current cycle and genuine portal-link source facts, Management API \`read_only: true\`.
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

  await command(["resize", "1200", "800"]);
  const results: SanitizedTaskResult[] = [];
  for (const [index, task] of tasks.entries()) {
    const capturedAt = new Date().toISOString();
    const opened = await openAndReadPrimePage(
      task.url,
      options.initialWaitMs,
      options.retryWaitMs,
    );
    const normalizedText = normalizePrimeSourceText(opened.read.body_text);
    const verdict = classifyPrimePortalText(
      normalizedText,
      opened.navigationSucceeded,
    );
    const sourceContentHash = await sha256Text(normalizedText);
    let screenshot: ScreenshotEvidence | null = null;
    if (verdict.capture_result !== "unreachable") {
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

    results.push({
      job_id: task.card.job_id,
      job_number: task.card.job_number,
      builder_reference: task.builder_reference,
      family: boardFamily(task.card),
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
    });

    console.error(
      `[${index + 1}/${tasks.length}] ${task.card.job_number} ${
        task.role || "unbound"
      } ${verdict.outcome}`,
    );
  }

  const byOutcome: Record<string, number> = {};
  for (const result of results) {
    byOutcome[result.outcome] = (byOutcome[result.outcome] || 0) + 1;
  }
  const portalCardIds = new Set(results.map((row) => row.job_id));
  const roofCards = live.cards.filter(isRoofCard);
  const roofDoneIds = new Set(
    results.filter((row) =>
      row.family === "roof_report" && row.role === "roof_report" &&
      row.outcome === "submitted_locked" && row.recordable &&
      !!row.screenshot
    ).map((row) => row.job_id),
  );
  const roofReasons: Record<string, number> = {};
  for (const card of roofCards) {
    if (roofDoneIds.has(card.job_id)) continue;
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
    roofReasons[reason] = (roofReasons[reason] || 0) + 1;
  }

  const manifest = {
    schema_version: "ses-f7-prime-portal-dry-run/v1",
    observer_version: OBSERVER_VERSION,
    capture_producer_contract: SES_PORTAL_CAPTURE_PRODUCER,
    generated_at: generatedAt,
    generation_id: generationId,
    production_access: {
      database: "management-api read_only:true",
      browser: "chrome-devtools-axi open/eval/screenshot only",
      writes: 0,
      stage_moves: 0,
    },
    counts: {
      active_board_cards: live.cards.length,
      portal_cards: portalCardIds.size,
      portal_links: results.length,
      by_outcome: byOutcome,
      existing_capture_rows: live.existing.length,
      roof_cards: roofCards.length,
      roof_would_become_provable: roofDoneIds.size,
      roof_would_remain_unprovable: roofCards.length - roofDoneIds.size,
      roof_remain_unprovable_by_reason: roofReasons,
    },
    results,
  };
  await writeJson(`${options.outputDir}/dry-run.json`, manifest);
  await Deno.writeTextFile(
    `${options.outputDir}/report.md`,
    reportMarkdown(manifest),
  );
  console.error(
    `complete: ${results.length} links; roof provable ${roofDoneIds.size}/${roofCards.length}`,
  );
  return {
    portalLinks: results.length,
    submittedLocked: byOutcome.submitted_locked || 0,
    inProgress: byOutcome.in_progress || 0,
    notStarted: byOutcome.not_started || 0,
    cannotObserve: byOutcome.cannot_observe || 0,
    roofProvable: roofDoneIds.size,
    roofCards: roofCards.length,
    outputDir: options.outputDir,
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
