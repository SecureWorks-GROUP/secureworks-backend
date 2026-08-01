#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
// deno-lint-ignore-file no-explicit-any
/**
 * SES Phase C1 — read-only single-card evidence measurement.
 *
 * Inventories ONE make-safe card's actual evidence from production and prints
 * the deterministic ruler's verdict
 * (`supabase/functions/ops-api/makesafe_evidence_requirements.ts`). This is the
 * building block C2 batches over; it deliberately measures one card so the read
 * set stays small and every row is attributable.
 *
 * Production safety:
 * - the Supabase client is wired through the shared `readOnlyFetch`, which
 *   rejects every HTTP method except GET/HEAD before a request can leave this
 *   process;
 * - every read is scoped to the single resolved job id;
 * - `jobs` is read with an explicit column list, never `select('*')`, so the
 *   ~100 kB `scope_json` blob never enters this process;
 * - the rendered report carries job/work-order references, statuses and counts
 *   only. Client names, addresses, phones and emails are never selected or
 *   printed, and the output passes the same privacy guard the board checker uses.
 *
 * This script performs NO write, NO backfill and NO stage move.
 *
 * Usage:
 *   SUPABASE_URL='https://<ref>.supabase.co' \
 *   SUPABASE_SERVICE_ROLE_KEY='...' \
 *   deno run --allow-env --allow-net --allow-read \
 *     scripts/ses-measure-card-evidence.ts --job SWMS-261055 [--stage report_ready] [--json]
 */

import {
  computeMakesafeStatus,
  MAKESAFE_COMPLETION_PHOTO_FLOOR,
  type MakesafeStatusInput,
} from "../supabase/functions/ops-api/makesafe_computed_status.ts";
import {
  currentCycleNumber,
  hasReattendBoundary,
  photoCountForCurrentCycle,
  selectCurrentCycleReport,
} from "../supabase/functions/ops-api/makesafe_cycle_evidence.ts";
import { extractBuilderWorkOrderIdentity } from "../supabase/functions/ops-api/makesafe_builder_work_order_identity.ts";
import {
  emptySesCardEvidenceInventory,
  readSesCardEvidence,
  SES_EVIDENCE_CONTRACT_SOURCE,
  SES_EVIDENCE_CONTRACT_VERSION,
  SES_EVIDENCE_ITEM_LABELS,
  SES_EVIDENCE_STAGES,
  type SesCardEvidenceInventory,
  type SesEvidenceFamily,
  sesEvidenceFamilyFromCard,
  type SesEvidenceReading,
  type SesEvidenceStage,
} from "../supabase/functions/ops-api/makesafe_evidence_requirements.ts";
import {
  assertReportPrivacy,
  readOnlyFetch,
} from "./ses-evidence-stage-checker.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const DEFAULT_SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;

/**
 * `jobs` columns this script may read. `scope_json` and `pricing_json` are
 * deliberately absent, and the family authority is projected key by key rather
 * than pulling the whole metadata blob.
 */
const JOB_COLUMNS = [
  "id",
  "job_number",
  "type",
  "status",
  "archived",
  "created_at",
  "updated_at",
  "completed_at",
  "makesafe_job_family:metadata->>makesafe_job_family",
  "insurance_job_type:metadata->>insurance_job_type",
  "own_template_requested:metadata->>own_template_requested",
  "strata:metadata->>strata",
  "report_delivery:metadata->>report_delivery",
  "synthetic_livefire_marker:metadata->>synthetic_livefire_marker",
].join(",");

const SENT_PACK_STATUSES = new Set([
  "sent",
  "sent_marker_failed",
  "sent_not_closed",
  "close_failed",
]);
const ISSUED_INVOICE_STATUSES = new Set(["AUTHORISED", "SUBMITTED", "PAID"]);
const TERMINAL_STAGES = new Set<SesEvidenceStage>([
  "completed",
  "archive",
  "cancelled",
]);
/** Link/capture roles that stand in for a hosted GHL object rather than Prime. */
const GHL_URL_HINTS = ["gohighlevel", "leadconnector", "msgsndr", "ghl."];

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function truthy(value: unknown): boolean {
  const token = text(value).toLowerCase();
  return token === "true" || token === "t" || token === "1";
}

function hasStoredDocument(
  documents: MeasureDocumentRow[],
  kind: "work_order" | "swms" | "roof_report",
): boolean {
  return documents.some((row) => {
    if (!text(row.storage_url)) return false;
    const type = text(row.type).toLowerCase();
    if (type === kind) return true;
    if (kind === "work_order" || (type !== "" && type !== "general")) {
      return false;
    }
    const name = text(row.file_name).toLowerCase();
    return kind === "swms" && /swms(?![-\s]?\d)/i.test(name);
  });
}

export interface MeasureDocumentRow {
  id?: string | null;
  type?: string | null;
  file_name?: string | null;
  storage_url?: string | null;
  created_at?: string | null;
}

export interface MeasureMediaRow {
  id?: string | null;
  type?: string | null;
  phase?: string | null;
  storage_url?: string | null;
  created_at?: string | null;
}

export interface MeasureInvoiceRow {
  id?: string | null;
  status?: string | null;
  invoice_type?: string | null;
  invoice_date?: string | null;
  created_at?: string | null;
}

export interface MeasurePackRow {
  id?: string | null;
  pack_kind?: string | null;
  status?: string | null;
  review_state?: string | null;
  report_doc_id?: string | null;
  invoice_doc_id?: string | null;
  swms_doc_id?: string | null;
  sent_at?: string | null;
}

export interface MeasureDocFlags {
  has_wo: boolean;
  has_report_doc: boolean;
  has_invoice_doc: boolean;
  has_swms_doc: boolean;
}

export interface MeasureCardInput {
  job: Record<string, any>;
  detail: Record<string, any> | null;
  assignments: any[];
  serviceReports: any[];
  documents: MeasureDocumentRow[];
  /** Produced by ops-api's own `makesafeDocBooleans`, never re-derived here. */
  docFlags: MeasureDocFlags;
  media: MeasureMediaRow[];
  invoices: MeasureInvoiceRow[];
  packs: MeasurePackRow[];
  statusApplication: Record<string, any> | null;
  stageOverride?: SesEvidenceStage | null;
}

export interface MeasureCardResult {
  job_ref: string;
  job_id: string;
  family: SesEvidenceFamily | null;
  family_refusal: string | null;
  stage: SesEvidenceStage;
  stage_source: string;
  computed_stage: SesEvidenceStage;
  display_overlay_stage: string | null;
  cycle_number: number;
  reattend_boundary: boolean;
  completion_photo_count: number;
  inventory: SesCardEvidenceInventory;
  reading: SesEvidenceReading | null;
}

function livePackRows(packs: MeasurePackRow[]): MeasurePackRow[] {
  return packs.filter((pack) =>
    !text(pack.pack_kind) || text(pack.pack_kind).toLowerCase() === "main"
  );
}

function strongestInvoice(rows: MeasureInvoiceRow[]): MeasureInvoiceRow | null {
  const rank: Record<string, number> = {
    PAID: 5,
    AUTHORISED: 4,
    SUBMITTED: 3,
    DRAFT: 2,
  };
  return [...rows]
    .filter((row) =>
      text(row.invoice_type).toUpperCase() === "ACCREC" &&
      !["VOIDED", "DELETED"].includes(text(row.status).toUpperCase())
    )
    .sort((a, b) => {
      const diff = (rank[text(b.status).toUpperCase()] || 1) -
        (rank[text(a.status).toUpperCase()] || 1);
      if (diff) return diff;
      return text(b.invoice_date || b.created_at).localeCompare(
        text(a.invoice_date || a.created_at),
      );
    })[0] || null;
}

function portalRole(value: unknown): string {
  const role = text(value).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (["roof", "roof_report"].includes(role)) return "roof_report";
  if (["assessment", "assessment_report"].includes(role)) {
    return "assessment_report";
  }
  if (["photos", "photo_schedule", "photo_evidence"].includes(role)) {
    return "photos";
  }
  if (["quote", "quotation", "scope", "scope_of_works"].includes(role)) {
    return "quote";
  }
  return role;
}

function typedLinks(detail: Record<string, any> | null): any[] {
  return Array.isArray(detail?.external_links) ? detail!.external_links : [];
}

function portalCaptures(detail: Record<string, any> | null): any[] {
  const captures: any[] = [];
  const append = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") captures.push(item);
      }
    }
  };
  append(detail?.portal_evidence);
  append(detail?.portal_captures);
  for (const link of typedLinks(detail)) {
    if (text(link?.status).toLowerCase() === "done") {
      captures.push({
        status: "done",
        role: link?.role || link?.kind,
        cycle_number: link?.cycle_number ?? currentCycleNumber(detail),
      });
    }
  }
  const signal = detail?.portal_verified_signal;
  if (typeof signal === "string" && /^[\[{]/.test(signal.trim())) {
    try {
      const parsed = JSON.parse(signal);
      append(
        Array.isArray(parsed) ? parsed : parsed?.entries || parsed?.captures,
      );
    } catch {
      // A non-JSON legacy signal carries no typed capture. Ignore it here; the
      // ruler reports the resulting absence rather than guessing a role.
    }
  }
  return captures;
}

/** Roles with a done, screenshot-backed capture in the current cycle. */
function doneCaptureRoles(detail: Record<string, any> | null): Set<string> {
  const cycle = currentCycleNumber(detail);
  return new Set(
    portalCaptures(detail)
      .filter((capture) =>
        text(capture?.status).toLowerCase() === "done" &&
        (capture?.cycle_number == null ||
          Number(capture.cycle_number) === cycle)
      )
      .map((capture) => portalRole(capture?.role || capture?.kind))
      .filter(Boolean),
  );
}

function hasGhlShapedLink(detail: Record<string, any> | null): boolean {
  return typedLinks(detail).some((link: any) => {
    const url = text(link?.url).toLowerCase();
    const provider = text(link?.provider || link?.source).toLowerCase();
    return provider.includes("ghl") || provider.includes("highlevel") ||
      GHL_URL_HINTS.some((hint) => url.includes(hint));
  });
}

function primeLinkFact(
  family: SesEvidenceFamily,
  detail: Record<string, any> | null,
) {
  const done = doneCaptureRoles(detail);
  const links = new Set(
    typedLinks(detail).map((link: any) => portalRole(link?.role || link?.kind))
      .filter(Boolean),
  );
  const required = family === "assessment_quote"
    ? ["assessment_report", "photos", "quote"]
    : family === "ordinary_roof_portal"
    ? ["roof_report"]
    : [];
  // The assessment photo schedule is graded in its own column, so the Prime
  // column asks only for the report/scope roles of the triad.
  const primeRoles = family === "assessment_quote"
    ? ["assessment_report", "quote"]
    : required;
  const satisfied = primeRoles.length > 0 &&
    primeRoles.every((role) => done.has(role) && links.has(role));
  const missingRoles = primeRoles.filter((role) =>
    !done.has(role) || !links.has(role)
  );
  return {
    present: satisfied,
    substitute_present: !satisfied && hasGhlShapedLink(detail),
    count: links.size,
    detail: primeRoles.length === 0
      ? "family owes no Prime portal deliverable"
      : satisfied
      ? `typed + done captures for ${primeRoles.join(", ")}`
      : `awaiting done capture for ${missingRoles.join(", ") || "(none)"}`,
  };
}

/**
 * Build one card's evidence inventory. Pure: every production row is passed in,
 * so C2 can batch this over a paged read without changing a rule.
 */
export function buildSesCardEvidenceInventory(
  input: MeasureCardInput,
): MeasureCardResult {
  const job = input.job || {};
  const detail = input.detail;
  const jobRef = text(job.job_number) || text(job.id) || "UNKNOWN-JOB-REF";
  const family = sesEvidenceFamilyFromCard({
    makesafe_job_family: detail?.report_type || job.makesafe_job_family,
    insurance_job_type: job.insurance_job_type,
    own_template_requested: truthy(job.own_template_requested),
    strata: truthy(job.strata),
    report_delivery: job.report_delivery || detail?.report_delivery,
  });

  const cycle = currentCycleNumber(detail);
  const reattend = hasReattendBoundary(detail);
  const currentReport = selectCurrentCycleReport(
    input.serviceReports,
    detail,
    detail?.attendance_cycle_id ?? null,
  );
  const reportSubmitted = ["submitted", "approved"].includes(
    text(currentReport?.status).toLowerCase(),
  );
  const completionPhotos = input.media.filter((row) =>
    text(row.type).toLowerCase() === "photo" &&
    text(row.phase).toLowerCase() === "completion"
  );
  const photoCount = photoCountForCurrentCycle(
    completionPhotos.length,
    detail,
    false,
  );
  const mediaWithoutArtifact =
    input.media.filter((row) => !text(row.storage_url)).length;
  const storedWorkOrder = hasStoredDocument(input.documents, "work_order");
  const storedSwms = hasStoredDocument(input.documents, "swms");
  const storedRoofPdf = hasStoredDocument(input.documents, "roof_report");
  const packs = livePackRows(input.packs);
  const pack = packs[0] || null;
  const packSent = packs.some((row) =>
    SENT_PACK_STATUSES.has(text(row.status).toLowerCase())
  );
  const invoice = strongestInvoice(input.invoices);
  const invoiceStatus = text(invoice?.status).toUpperCase();

  const statusInput: MakesafeStatusInput = {
    job: {
      status: job.status ?? null,
      completed_at: job.completed_at ?? null,
      updated_at: job.updated_at ?? null,
      metadata: {
        makesafe_job_family: job.makesafe_job_family ?? null,
        insurance_job_type: job.insurance_job_type ?? null,
      },
    },
    detail: {
      report_type: detail?.report_type ?? null,
      cycle_number: cycle,
      report_sent_at: detail?.report_sent_at ?? null,
      invoice_ready_at: detail?.invoice_ready_at ?? null,
      external_links: typedLinks(detail),
    },
    evidence: {
      assignments: input.assignments,
      serviceReports: input.serviceReports,
      completionPhotoCount: photoCount,
      portalCaptures: portalCaptures(detail),
      packState: pack?.review_state ?? null,
      pack: pack
        ? {
          status: pack.status ?? null,
          report_doc_id: pack.report_doc_id ?? null,
          invoice_doc_id: pack.invoice_doc_id ?? null,
          swms_doc_id: pack.swms_doc_id ?? null,
          sent_at: pack.sent_at ?? null,
        }
        : null,
      invoiceStatus: invoice?.status ?? null,
      invoiceDate: invoice?.invoice_date ?? null,
      invoiceCreatedAt: invoice?.created_at ?? null,
      packSent,
      documents: {
        report: input.docFlags.has_report_doc,
        invoice: input.docFlags.has_invoice_doc,
        swms: input.docFlags.has_swms_doc,
      },
      swmsRequired: input.docFlags.has_swms_doc || !!pack?.swms_doc_id,
    },
    displayedStatus: input.statusApplication?.after_status ?? null,
  };
  const computed = computeMakesafeStatus(statusInput);
  const overlayStage = text(input.statusApplication?.after_status) || null;

  const stage: SesEvidenceStage = input.stageOverride ??
    (computed.status as SesEvidenceStage);
  const stageSource = input.stageOverride
    ? "explicit --stage"
    : overlayStage
    ? "M1 computed status under the applied display overlay"
    : "M1 computed status (no display overlay on this card)";

  const terminal = TERMINAL_STAGES.has(stage);
  const invoicePresent = terminal
    ? !!invoice && ISSUED_INVOICE_STATUSES.has(invoiceStatus)
    : !!invoice;

  const tradeReportPresent = family === "own_template_roof"
    ? storedRoofPdf
    : reportSubmitted;
  const photosPresent = family === "assessment_quote"
    ? doneCaptureRoles(detail).has("photos")
    : photoCount >= MAKESAFE_COMPLETION_PHOTO_FLOOR;

  const identity = extractBuilderWorkOrderIdentity({
    externalRef: text(detail?.external_ref) || null,
  });

  const prime = primeLinkFact(family ?? "physical_makesafe", detail);
  const inventory: SesCardEvidenceInventory = {
    ...emptySesCardEvidenceInventory(),
    builder_wo_doc: {
      present: input.docFlags.has_wo && storedWorkOrder,
      transit_record_without_artifact: input.docFlags.has_wo && !storedWorkOrder,
      detail: input.docFlags.has_wo
        ? storedWorkOrder
          ? "typed work_order job_documents row with stored artifact"
          : "document row exists with no stored artifact"
        : "no typed work_order job_documents row",
    },
    prime_link: prime,
    trade_report: {
      present: tradeReportPresent,
      count: input.serviceReports.length,
      transit_record_without_artifact: !tradeReportPresent && !!currentReport,
      detail: family === "own_template_roof"
        ? (storedRoofPdf
          ? "typed roof_report document"
          : "no typed roof_report document")
        : currentReport
        ? `current-cycle report status ${
          text(currentReport.status) || "(blank)"
        }`
        : "no current-cycle service report",
    },
    photos_media: {
      present: photosPresent,
      // The assessment photo column is a typed Prime capture, not a local pack,
      // so a photo count would be a category error there.
      ...(family === "assessment_quote" ? {} : { count: photoCount }),
      // Cheap transit discrimination only: either a media row exists with no
      // stored artifact, or the trade submitted the app flow while zero
      // completion photos landed. C2 owns full transit forensics.
      transit_record_without_artifact: !photosPresent &&
        (mediaWithoutArtifact > 0 || (reportSubmitted && photoCount === 0)),
      detail: family === "assessment_quote"
        ? "typed Prime photo-schedule capture"
        : `${photoCount} current-cycle completion photos (floor ${MAKESAFE_COMPLETION_PHOTO_FLOOR}); ${input.media.length} media rows, ${mediaWithoutArtifact} without a stored artifact`,
    },
    swms: {
      present: (input.docFlags.has_swms_doc && storedSwms) ||
        !!pack?.swms_doc_id,
      transit_record_without_artifact: (input.docFlags.has_swms_doc &&
        !storedSwms) || (!input.docFlags.has_swms_doc && !!pack?.swms_doc_id),
      detail: input.docFlags.has_swms_doc
        ? storedSwms
          ? "typed swms document with stored artifact"
          : "document row exists with no stored artifact"
        : pack?.swms_doc_id
        ? "pack references a SWMS doc id with no typed document row"
        : "no SWMS artifact; the policy decision is not stored as evidence",
    },
    invoice: {
      present: invoicePresent,
      transit_record_without_artifact: !invoicePresent &&
        !!pack?.invoice_doc_id,
      detail: invoice
        ? `strongest live ACCREC invoice is ${invoiceStatus}${
          terminal ? " (terminal stage requires an issued invoice)" : ""
        }`
        : "no live ACCREC invoice",
    },
    po: {
      present: !!identity.builder_po_number,
      detail: identity.builder_po_number
        ? `PO recovered from makesafe_job_details.external_ref`
        : "no PO token in makesafe_job_details.external_ref",
    },
  };

  return {
    job_ref: jobRef,
    job_id: text(job.id),
    family,
    family_refusal: family
      ? null
      : "canonical family authority is unknown; the ruler refuses to measure a guessed family",
    stage,
    stage_source: stageSource,
    computed_stage: computed.status as SesEvidenceStage,
    display_overlay_stage: overlayStage,
    cycle_number: cycle,
    reattend_boundary: reattend,
    completion_photo_count: photoCount,
    inventory,
    reading: family ? readSesCardEvidence({ family, stage, inventory }) : null,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderMeasurement(result: MeasureCardResult): string {
  const lines: string[] = [];
  lines.push(`SES card evidence measurement — ${result.job_ref}`);
  lines.push(`  ruler          ${SES_EVIDENCE_CONTRACT_VERSION}`);
  lines.push(`  ruler source   ${SES_EVIDENCE_CONTRACT_SOURCE}`);
  lines.push(`  job id         ${result.job_id}`);
  lines.push(`  family         ${result.family ?? "UNKNOWN (refused)"}`);
  lines.push(`  stage measured ${result.stage}  [${result.stage_source}]`);
  lines.push(`  M1 computed    ${result.computed_stage}`);
  lines.push(
    `  display overlay ${result.display_overlay_stage ?? "(none applied)"}`,
  );
  lines.push(
    `  cycle          ${result.cycle_number}${
      result.reattend_boundary ? " (reattendance boundary active)" : ""
    }`,
  );
  lines.push("");

  if (!result.reading) {
    lines.push(`VERDICT: refused — ${result.family_refusal}`);
    lines.push("");
    return lines.join("\n");
  }

  lines.push(`VERDICT: ${result.reading.verdict.toUpperCase()}`);
  lines.push("");
  lines.push("  item             requirement      status               signal");
  lines.push(
    "  ---------------- ---------------- -------------------- ---------------",
  );
  for (const item of result.reading.items) {
    lines.push(
      `  ${item.item.padEnd(16)} ${item.requirement.padEnd(16)} ${
        item.status.padEnd(20)
      } ${item.signal === "none" ? "" : item.signal}`.trimEnd(),
    );
    lines.push(`      ${SES_EVIDENCE_ITEM_LABELS[item.item]}`);
    if (item.detail) lines.push(`      observed: ${item.detail}`);
  }
  lines.push("");

  if (result.reading.missing.length > 0) {
    lines.push(`  MISSING: ${result.reading.missing.join(", ")}`);
  }
  if (result.reading.lost_in_transit.length > 0) {
    lines.push(
      `  LOST IN TRANSIT (cheap signal; C2 owns forensics): ${
        result.reading.lost_in_transit.join(", ")
      }`,
    );
  }
  if (result.reading.unresolved.length > 0) {
    lines.push(`  UNRESOLVED: ${result.reading.unresolved.join(", ")}`);
    lines.push("");
    lines.push("  Open Captain questions blocking a settled verdict:");
    for (const question of result.reading.open_questions) {
      lines.push(`   - [${question.id}] ${question.title}`);
      lines.push(`     ${question.question}`);
    }
  }
  lines.push("");
  lines.push(
    "This run performed no write, no backfill and no stage move. Its transport rejects every HTTP method except GET/HEAD.",
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function option(name: string): string | undefined {
  const withEquals = Deno.args.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

function flag(name: string): boolean {
  return Deno.args.includes(name);
}

function requiredEnv(name: string, fallback?: string): string {
  const value = text(Deno.env.get(name) || fallback);
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/+$/, "");
}

export function parseStageOption(
  value: string | undefined,
): SesEvidenceStage | null {
  if (!value) return null;
  const token = text(value).toLowerCase();
  const stage = SES_EVIDENCE_STAGES.find((candidate) => candidate === token);
  if (!stage) {
    throw new Error(
      `--stage must be one of ${SES_EVIDENCE_STAGES.join(", ")}; got ${token}`,
    );
  }
  return stage;
}

async function readRows(
  client: any,
  table: string,
  select: string,
  jobId: string,
  configure?: (query: any) => any,
): Promise<any[]> {
  let query = client.from(table).select(select).eq("job_id", jobId);
  if (configure) query = configure(query);
  const { data, error } = await query;
  // A wrong column name returns a 400 with data:null, which reads exactly like
  // "no evidence". Fail loudly rather than reporting a quiet card.
  if (error) throw new Error(`${table} read failed: ${error.message}`);
  return data || [];
}

async function run(): Promise<void> {
  const jobArg = option("--job");
  if (!jobArg) {
    throw new Error(
      "--job is required (a job_number such as SWMS-261055, or a job id)",
    );
  }
  const stageOverride = parseStageOption(option("--stage"));
  const asJson = flag("--json");
  const strict = flag("--strict");
  const supabaseUrl = requiredEnv("SUPABASE_URL", DEFAULT_SUPABASE_URL);
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabaseModuleUrl = "https://esm.sh/@supabase/supabase-js@2";
  const { createClient } = await import(supabaseModuleUrl);
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: readOnlyFetch },
  });

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      jobArg,
    );
  const { data: jobRows, error: jobError } = await client.from("jobs")
    .select(JOB_COLUMNS)
    .eq(isUuid ? "id" : "job_number", jobArg)
    .limit(2);
  if (jobError) throw new Error(`jobs read failed: ${jobError.message}`);
  if (!jobRows || jobRows.length === 0) throw new Error(`no job for ${jobArg}`);
  if (jobRows.length > 1) {
    throw new Error(
      `${jobArg} matched more than one job; pass the job id instead`,
    );
  }
  const job = jobRows[0] as Record<string, any>;
  const jobId = text(job.id);

  // makesafe_job_details is one small row per job with no large blob, and its
  // column set has drifted across migrations, so `*` is the drift-proof read
  // here. Every other read enumerates columns.
  const [
    detailRows,
    assignments,
    serviceReports,
    documents,
    media,
    invoices,
    packs,
    statusApplications,
  ] = await Promise.all([
    readRows(client, "makesafe_job_details", "*", jobId),
    readRows(
      client,
      "job_assignments",
      "id,job_id,status,attendance_cycle_id,cycle_attribution,created_at",
      jobId,
    ),
    readRows(
      client,
      "job_service_reports",
      "id,job_id,status,cycle_number,attendance_cycle_id,cycle_attribution,created_at",
      jobId,
    ),
    readRows(
      client,
      "job_documents",
      "id,job_id,type,file_name,storage_url,created_at",
      jobId,
    ),
    readRows(
      client,
      "job_media",
      "id,job_id,type,phase,storage_url,created_at",
      jobId,
    ),
    readRows(
      client,
      "xero_invoices",
      "id,job_id,status,invoice_type,invoice_date,created_at",
      jobId,
      (query) => query.eq("invoice_type", "ACCREC"),
    ),
    readRows(
      client,
      "makesafe_report_packs",
      "id,job_id,pack_kind,status,review_state,report_doc_id,invoice_doc_id,swms_doc_id,sent_at",
      jobId,
    ),
    readRows(
      client,
      "makesafe_board_status_applications",
      "id,job_id,source_status,before_status,after_status,applied_at",
      jobId,
      (query) => query.order("id", { ascending: false }).limit(1),
    ),
  ]);

  // Reuse ops-api's own typed/filename doc derivation rather than restating it.
  const opsModule = await import(
    new URL("../supabase/functions/ops-api/index.ts", import.meta.url).href
  );
  const docFlags = opsModule._makesafeDocBooleansForTest(
    documents,
  ) as MeasureDocFlags;

  const result = buildSesCardEvidenceInventory({
    job,
    detail: detailRows[0] || null,
    assignments,
    serviceReports,
    documents,
    docFlags,
    media,
    invoices,
    packs,
    statusApplication: statusApplications[0] || null,
    stageOverride,
  });

  const output = asJson
    ? JSON.stringify(result, null, 2)
    : renderMeasurement(result);
  assertReportPrivacy(output);
  console.log(output);
  if (strict && result.reading?.verdict === "fail") Deno.exit(1);
}

if (import.meta.main) {
  await run();
}
