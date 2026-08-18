// deno-lint-ignore-file no-explicit-any
// Canonical make-safe board row and its two audience projections.
// Clients must never derive a board column from assignment status.
import {
  classifyMakesafeJobType,
  computeMakesafeStatus,
  MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION,
  type MakesafePortalCapture,
  type MakesafeStatusHold,
  reportInEvidence,
  requiresBoundBuilderReportPdf,
} from "./makesafe_computed_status.ts";
import {
  isMakesafeTerminalDisplayStatus,
  isMakesafeTerminalJobState,
} from "./makesafe_status_apply.ts";
import {
  photoCountForCurrentCycle,
  tradeSafeHold,
} from "./makesafe_cycle_evidence.ts";
import {
  canonicalSesFamilyFromCard,
  requiresMakesafeSwms,
  sesFamilyLabel,
} from "./ses_family_matrix.ts";
import {
  canonicalSesPortalSourceUrl,
  isSesSha256,
  isTrustedSesPortalCaptureProducer,
  SES_PORTAL_CAPTURE_PRODUCER,
  SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
  SES_TRADE_PORTAL_CONFIRMATION_QUESTION,
  sesPortalCaptureProducerHasScreenshot,
} from "./ses_portal_capture_contract.ts";
import { extractPortalLinks } from "./makesafe_portal_guard.ts";
import {
  sesRoofConfirmationEligibility,
  type SesRoofConfirmationPayload,
} from "./ses_trade_portal_confirmation.ts";
import {
  deriveSesStageV2,
  sesOverlayDecisionKind,
  sesStageV2OverlayCandidate,
} from "./ses_stage_engine_v2.ts";
import type { MakesafeTerminalProofFact } from "./makesafe_terminal_proof.ts";
import { presentSesPackHonesty } from "./ses_pack_presentation.ts";
import { projectMakesafeJobIdentity } from "./makesafe_job_identity_read_model.ts";

export const MAKESAFE_BOARD_CONTRACT_VERSION = "makesafe-board.v1";

/**
 * Ops board field shape.
 *
 * - `card` (default for projection=ops): only what the kanban card paints, plus
 *   the small presentation keys that previously required a second
 *   `makesafe_pipeline?history=all` join. Diagnostics and detail-view payloads
 *   are omitted so the board stays under a few hundred KB / a couple of seconds.
 * - `full`: every diagnostic and detail field (lineage siblings, notes,
 *   computed_status_evidence, derived_stage_v2_*, roof tick, job_identity, …).
 *   Opt in with `fields=full` or `include_diagnostics=1`.
 *
 * Placement (`canonical_stage`) is identical in both shapes: declared ladder +
 * display-ledger overlay. Card mode never re-derives a column.
 */
export const MAKESAFE_BOARD_FIELDS = ["card", "full"] as const;
export type MakesafeBoardFields = (typeof MAKESAFE_BOARD_FIELDS)[number];
export const MAKESAFE_BOARD_DEFAULT_FIELDS: MakesafeBoardFields = "card";

/**
 * Which ops board columns ship card rows.
 *
 * - `active` (default for projection=ops card shape): every column EXCEPT
 *   `archive`. Archive is two thirds of the live board and the largest remaining
 *   load cost after card-shape; the Captain ruled it loads on demand only.
 * - `archive`: only the Archive column (lazy/paged open of that column).
 * - `all`: every column, including Archive. Diagnostics (`fields=full`) and
 *   explicit `include_archive=1` / `columns=all` use this so nothing is
 *   unreachable.
 *
 * Placement for every returned card is unchanged: declared ladder +
 * display-ledger overlay. Scope only decides which cards are present, never
 * which column an included card lands in.
 */
export const MAKESAFE_BOARD_COLUMN_SCOPES = [
  "active",
  "archive",
  "all",
] as const;
export type MakesafeBoardColumnScope =
  (typeof MAKESAFE_BOARD_COLUMN_SCOPES)[number];
export const MAKESAFE_BOARD_DEFAULT_COLUMN_SCOPE: MakesafeBoardColumnScope =
  "active";

/** Largest archive page a caller may request (`columns=archive&limit=`). */
export const MAKESAFE_BOARD_MAX_ARCHIVE_PAGE = 500;

export function parseMakesafeBoardFields(
  fieldsRaw: string | null | undefined,
  includeDiagnosticsRaw?: string | null,
): MakesafeBoardFields {
  const includeDiagnostics = ["1", "true", "yes", "full"].includes(
    String(includeDiagnosticsRaw || "").trim().toLowerCase(),
  );
  if (includeDiagnostics) return "full";
  const fields = String(fieldsRaw || MAKESAFE_BOARD_DEFAULT_FIELDS)
    .trim()
    .toLowerCase();
  if (fields === "full" || fields === "all" || fields === "diagnostic") {
    return "full";
  }
  if (fields === "card" || fields === "slim" || fields === "board") {
    return "card";
  }
  // Unknown value: stay on the fast board path rather than silently shipping
  // a multi-megabyte diagnostic dump.
  return MAKESAFE_BOARD_DEFAULT_FIELDS;
}

/**
 * Resolve the ops column scope. `fields=full` always widens to `all` so a
 * diagnostic dump cannot silently drop history. Explicit include_archive /
 * columns=all also widen. Default is active-only (no Archive card haul).
 */
export function parseMakesafeBoardColumnScope(
  columnsRaw?: string | null,
  includeArchiveRaw?: string | null,
  fields: MakesafeBoardFields = MAKESAFE_BOARD_DEFAULT_FIELDS,
): MakesafeBoardColumnScope {
  // Full diagnostic shape is the complete set by contract.
  if (fields === "full") return "all";
  const includeArchive = ["1", "true", "yes", "all"].includes(
    String(includeArchiveRaw || "").trim().toLowerCase(),
  );
  if (includeArchive) return "all";
  const columns = String(columnsRaw || "").trim().toLowerCase();
  if (!columns || columns === "active" || columns === "live") return "active";
  if (columns === "archive" || columns === "archived") return "archive";
  if (
    columns === "all" || columns === "full" || columns === "history" ||
    columns === "complete"
  ) {
    return "all";
  }
  // Unknown value: stay on the fast active path rather than hauling history.
  return MAKESAFE_BOARD_DEFAULT_COLUMN_SCOPE;
}

/**
 * Presentation keys the ops card renderer reads that used to come only from
 * the overlay-blind `makesafe_pipeline` dual-fetch. Stamped from the pipeline
 * base row so `fields=card` is self-sufficient for board paint.
 */
export function boardPresentationFields(base: any) {
  return {
    site_suburb: base?.site_suburb || null,
    site_address: base?.site_address || null,
    client_name: base?.client_name || null,
    client_email: base?.client_email || null,
    client_phone: base?.client_phone || null,
    has_wo: base?.has_wo === true,
    docs_missing: base?.docs_missing === true,
    docs_warning: base?.docs_warning === true,
    invoice_status: base?.invoice_status || null,
    invoice_raw_status: base?.invoice_raw_status ?? rawInvoiceStatus(base),
    invoice_date: base?.invoice_date || null,
    invoice_created_at: base?.invoice_created_at || null,
    requesting_company_slug: base?.requesting_company_slug || null,
    requesting_company_name: base?.requesting_company_name ||
      base?.requesting_company || null,
    requesting_company: base?.requesting_company || null,
    builder_company: base?.builder_company ||
      base?.requesting_company_name ||
      base?.requesting_company || null,
    intake_at: base?.intake_at || base?.created_at || null,
    created_at: base?.created_at || null,
    updated_at: base?.updated_at || null,
    completed_at: base?.completed_at || null,
    reattend_count: base?.reattend_count ?? null,
    is_reattend: base?.is_reattend === true,
    last_reattend_at: base?.last_reattend_at || null,
    resume_action: base?.resume_action || null,
    // Stays a STRING (legacy payload shape). It reads the pipeline's single
    // presentation stamp so a ready docket never publishes a stale legacy
    // `failed`, and falls back to the raw status when nothing stamped it.
    pack_status: base?.pack_status || base?.pack_presentation?.state ||
      base?.report_pack?.status || null,
    needs_money_review: base?.needs_money_review === true,
    cancel_reason: base?.cancel_reason || null,
    cancel_note: base?.cancel_note || null,
    cancelled_by: base?.cancelled_by || null,
    cancelled_at: base?.cancelled_at || null,
  };
}

function slimContactForCard(contact: any) {
  return {
    client_name: contact?.client_name || null,
    phone: contact?.phone || null,
    address: contact?.address || null,
  };
}

function slimAssignmentsForCard(assignments: any[]) {
  return (assignments || []).map((a) => ({
    assignment_id: a?.assignment_id || null,
    user_id: a?.user_id || null,
    name: a?.name || null,
    status: a?.status || null,
    scheduled_date: a?.scheduled_date || null,
    role: a?.role || null,
  }));
}

function slimLineageForCard(lineage: any) {
  return {
    builder_claim_ref: lineage?.builder_claim_ref || null,
    builder_work_order_number: lineage?.builder_work_order_number || null,
    builder_po_number: lineage?.builder_po_number || null,
    builder_instruction_key: lineage?.builder_instruction_key || null,
    property_claim_key: lineage?.property_claim_key || null,
    // siblings omitted — diagnostic, fat, and unused by card paint
    siblings: [],
  };
}

/**
 * Project one full canonical row onto the card-shaped ops payload. Pure and
 * placement-preserving: never renames or rewrites `canonical_stage`.
 */
export function projectOpsMakesafeCardRow(row: any) {
  const presentation = row?.presentation && typeof row.presentation === "object"
    ? row.presentation
    : {};
  return {
    contract_version: row?.contract_version || MAKESAFE_BOARD_CONTRACT_VERSION,
    id: row?.id,
    job_number: row?.job_number || null,
    type: row?.type || "makesafe",
    ses_family: row?.ses_family || null,
    ses_family_label: row?.ses_family_label || null,
    ses_recipe_state: row?.ses_recipe_state || null,
    job_state: row?.job_state || null,
    substatus: row?.substatus || null,
    declared_stage: row?.declared_stage || null,
    canonical_stage: row?.canonical_stage || null,
    canonical_stage_label: row?.canonical_stage_label || null,
    placement_engine_version: row?.placement_engine_version || null,
    status_application: row?.status_application || null,
    duplicate_of_job_id: row?.duplicate_of_job_id || null,
    duplicate_of_job_number: row?.duplicate_of_job_number || null,
    captain_action: row?.captain_action || null,
    projection_warning: row?.projection_warning || null,
    makesafe_type: row?.makesafe_type || null,
    builder: row?.builder || null,
    contact: slimContactForCard(row?.contact),
    assignments: slimAssignmentsForCard(row?.assignments || []),
    report: row?.report || null,
    report_doc_id: row?.report_doc_id || null,
    has_report_doc: row?.has_report_doc === true,
    invoice_id: row?.invoice_id || null,
    pack: row?.pack
      ? {
        state: row.pack.state || null,
        sent: row.pack.sent === true,
        sent_at: row.pack.sent_at || null,
        drafted: row.pack.drafted === true,
        docket_revision_id: row.pack.docket_revision_id || null,
        pre_xero_docs_ready: row.pack.pre_xero_docs_ready === true,
        presentation_kind: row.pack.presentation_kind || null,
        presentation_reason: row.pack.presentation_reason || null,
        legacy_pack_status: row.pack.legacy_pack_status || null,
        report_doc_id: row.pack.report_doc_id || null,
        invoice_doc_id: row.pack.invoice_doc_id || null,
        swms_doc_id: row.pack.swms_doc_id || null,
        closeout_documents: row.pack.closeout_documents || {
          report: false,
          invoice: false,
          swms: false,
        },
      }
      : null,
    age: row?.age || null,
    blockers: row?.blockers || null,
    cancelled: row?.cancelled || null,
    attendance_cycle_id: row?.attendance_cycle_id ?? null,
    cycle_number: row?.cycle_number ?? null,
    cycle_attribution_flags: row?.cycle_attribution_flags || [],
    readiness_revision: row?.readiness_revision ?? null,
    commercial_warning: row?.commercial_warning ?? null,
    invoice_qualifies_as_current_draft:
      row?.invoice_qualifies_as_current_draft === true,
    invoice_draft_qualification_reason:
      row?.invoice_draft_qualification_reason ?? null,
    // Slim lineage for external_ref fallback only — no sibling fan-out.
    lineage: slimLineageForCard(row?.lineage || {}),
    // Presentation keys at top level so mapCanonicalMakesafeRow / card paint
    // can read them without the pipeline dual-fetch.
    ...presentation,
    // Explicit top-level fallbacks when presentation was not stamped (older
    // callers of projectOpsMakesafeCardRow on a full row).
    site_suburb: presentation.site_suburb ?? row?.site_suburb ?? null,
    site_address: presentation.site_address ?? row?.site_address ?? null,
    client_name: presentation.client_name ?? row?.contact?.client_name ??
      row?.client_name ?? null,
    has_wo: presentation.has_wo === true || row?.has_wo === true,
    invoice_status: presentation.invoice_status ?? row?.invoice_status ?? null,
    requesting_company_slug: presentation.requesting_company_slug ??
      row?.requesting_company_slug ?? null,
  };
}

/**
 * R8 — what an overlay ledger row is permitted to do.
 *
 * `display_override` may change the column, subject to the unchanged source
 * equality and nonterminal guards. `stage_attestation` may NEVER change a
 * column; it exists so a Captain decision whose corrected source lands on the
 * same column keeps its provenance instead of vanishing.
 *
 * A row with no `decision_kind` is a legacy display override. Every row in the
 * ledger today is one, which is why this release moves nothing.
 */
/** The canonical family of a raw board row, from the one canonical deriver. */
export function boardRowSesFamily(base: any) {
  const detail = base?.makesafe_details || {};
  // Some Captain-reviewed repair corrections carry the ruling as
  // `metadata.ses_family=repair` and/or the legacy detail authority
  // `report_type=repair`, without the `makesafe_job_family` key read below.
  // Admit only that exact alternate family signal here: treating every
  // report_type as a family fallback would widen this repair into unrelated
  // report-card reclassification.
  if (
    [base?.metadata?.ses_family, detail?.report_type].some((value) =>
      canonicalSesFamilyFromCard({ makesafe_job_family: value }) === "repair"
    )
  ) {
    return "repair";
  }
  return canonicalSesFamilyFromCard({
    makesafe_job_family: base?.metadata?.makesafe_job_family,
    insurance_job_type: base?.metadata?.insurance_job_type,
    own_template_requested: base?.metadata?.own_template_requested,
    strata: base?.metadata?.strata,
    report_delivery: base?.metadata?.report_delivery || detail?.report_delivery,
  });
}

/**
 * R5 — the job ids on this board that are own-template roofs.
 *
 * The loader uses this to decide whether to read the roof-draft table at all.
 * It is exported so the loader and the row builder ask the SAME question; a
 * loader that used a looser test would fetch drafts for cards the engine then
 * refuses to read them for.
 */
export function ownTemplateRoofJobIdsForBoard(baseRows: any[]): string[] {
  const ids: string[] = [];
  for (const base of baseRows || []) {
    const id = String(base?.id || "");
    if (!id) continue;
    if (boardRowSesFamily(base) === "own_template_roof") ids.push(id);
  }
  return ids;
}

/**
 * The current own-roof draft per job: one row per job by contract, but if a
 * database ever holds more, take the newest submitted cycle rather than an
 * arbitrary one. Never merges two drafts into a synthetic record.
 */
export function latestOwnRoofDraftByJobId(
  rows: any[],
): Record<string, any> {
  const byJob: Record<string, any> = {};
  for (const row of rows || []) {
    const jobId = String(row?.job_id || "");
    if (!jobId) continue;
    const current = byJob[jobId];
    if (
      !current ||
      Number(row?.submitted_cycle ?? 1) > Number(current?.submitted_cycle ?? 1)
    ) {
      byJob[jobId] = row;
    }
  }
  return byJob;
}
export const MAKESAFE_LIVE_BOARD_EXCLUDED_JOB_STATUSES = [
  "cancelled",
  "archived",
  "lost",
] as const;
export const MAKESAFE_ALL_HISTORY_EXCLUDED_JOB_STATUSES = [
  "cancelled",
  "lost",
] as const;

/** Shared by the canonical loader and read-only observers. */
export function makesafeBoardJobStatusExclusionFilter(
  allHistory: boolean,
): string {
  const statuses = allHistory
    ? MAKESAFE_ALL_HISTORY_EXCLUDED_JOB_STATUSES
    : MAKESAFE_LIVE_BOARD_EXCLUDED_JOB_STATUSES;
  return `("${statuses.join('","')}")`;
}

/** Membership in the canonical live board, excluding its history-only rows. */
export function isCanonicalLiveMakesafeBoardJobStatus(value: unknown): boolean {
  const status = String(value ?? "").trim().toLowerCase();
  return !!status &&
    !(MAKESAFE_LIVE_BOARD_EXCLUDED_JOB_STATUSES as readonly string[]).includes(
      status,
    );
}

const SYNTHETIC_LIVEFIRE_MARKER =
  /^SWG-SES-LIVEFIRE-TEST-ONLY-[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/;
export const OPS_MAKESAFE_STAGES = [
  "new",
  "allocated",
  "trade_report_in",
  "report_ready",
  // Release 12: the corrected engine refuses to guess a column when a card's
  // evidence contradicts itself (e.g. raw state says closed but no issued
  // invoice and no report corroborates it). Such a card is a captain question
  // and gets its own visible column instead of being silently dropped into a
  // wrong one. Resolved the way SWMS-261059 was: the captain reads the card,
  // his sign-off is recorded as a terminal-proof row, and the engine then
  // derives the column from that evidence — nobody writes a stage.
  "decision_required",
  "completed",
  "archive",
  "cancelled",
] as const;
export type OpsMakesafeStage = (typeof OPS_MAKESAFE_STAGES)[number];
export type TradeMakesafeColumn = "New" | "Allocated" | "Complete" | "Archive";
export const TRADE_MAKESAFE_COLUMNS: readonly TradeMakesafeColumn[] = [
  "New",
  "Allocated",
  "Complete",
  "Archive",
];
export const OPS_TO_TRADE_COLUMN: Record<
  OpsMakesafeStage,
  TradeMakesafeColumn
> = {
  new: "New",
  allocated: "Allocated",
  trade_report_in: "Complete",
  report_ready: "Complete",
  // A captain question is not trade work; keep it off the trade's active lanes.
  decision_required: "Archive",
  completed: "Archive",
  archive: "Archive",
  cancelled: "Archive",
};
export const OPS_MAKESAFE_STAGE_LABELS: Record<OpsMakesafeStage, string> = {
  new: "New",
  allocated: "Allocated",
  trade_report_in: "Trade Report In",
  report_ready: "Report Ready",
  decision_required: "Captain Decision",
  completed: "Completed This Week",
  archive: "Archive",
  cancelled: "Cancelled",
};

export function emptyOpsColumnCounts(): Record<OpsMakesafeStage, number> {
  return Object.fromEntries(
    OPS_MAKESAFE_STAGES.map((stage) => [stage, 0]),
  ) as Record<OpsMakesafeStage, number>;
}

/**
 * After overlay, recompute honest column counts from canonical rows.
 * Prefer this over pipeline declared counts when overlays can move cards
 * (e.g. report_ready → archive).
 */
export function countOpsCanonicalStages(
  rows: readonly any[],
): Record<OpsMakesafeStage, number> {
  const counts = emptyOpsColumnCounts();
  for (const row of rows || []) {
    const stage = String(row?.canonical_stage || "").toLowerCase();
    if ((OPS_MAKESAFE_STAGES as readonly string[]).includes(stage)) {
      counts[stage as OpsMakesafeStage] += 1;
    } else {
      // projectOps parks unknowns in `new`; census follows that placement.
      counts.new += 1;
    }
  }
  return counts;
}

/**
 * Keep only the rows the column scope should return. Pure and placement-
 * preserving: never rewrites `canonical_stage`.
 */
export function filterCanonicalRowsByColumnScope(
  rows: readonly any[],
  scope: MakesafeBoardColumnScope,
  pagination: { limit?: number | null; offset?: number | null } = {},
): any[] {
  const list = Array.isArray(rows) ? [...rows] : [];
  let filtered: any[];
  if (scope === "all") {
    filtered = list;
  } else if (scope === "archive") {
    filtered = list.filter((row) =>
      String(row?.canonical_stage || "").toLowerCase() === "archive"
    );
  } else {
    // active: everything except archive
    filtered = list.filter((row) =>
      String(row?.canonical_stage || "").toLowerCase() !== "archive"
    );
  }
  if (scope === "archive") {
    const offset = Math.max(0, Math.floor(Number(pagination.offset) || 0));
    const rawLimit = pagination.limit;
    const limit = rawLimit == null ? null : Math.max(
      1,
      Math.min(
        MAKESAFE_BOARD_MAX_ARCHIVE_PAGE,
        Math.floor(Number(rawLimit) || 0),
      ),
    );
    if (limit != null) {
      return filtered.slice(offset, offset + limit);
    }
    if (offset > 0) return filtered.slice(offset);
  }
  return filtered;
}

/**
 * Honest archive metadata so an excluded Archive never looks like those cards
 * ceased to exist. Always publish the total even when columns.archive is [].
 */
export function archiveOnDemandMeta(args: {
  scope: MakesafeBoardColumnScope;
  columnCounts: Record<string, number>;
  archiveReturned: number;
  offset?: number | null;
  limit?: number | null;
}) {
  const total = Number(args.columnCounts?.archive || 0);
  const included = args.scope === "all" || args.scope === "archive";
  return {
    included,
    scope: args.scope,
    total,
    returned: included ? args.archiveReturned : 0,
    offset: args.scope === "archive"
      ? Math.max(0, Math.floor(Number(args.offset) || 0))
      : 0,
    limit: args.scope === "archive" && args.limit != null
      ? Math.max(
        1,
        Math.min(
          MAKESAFE_BOARD_MAX_ARCHIVE_PAGE,
          Math.floor(Number(args.limit) || 0),
        ),
      )
      : null,
    // How the client fetches history without guessing.
    fetch: {
      active_default: "projection=ops",
      include_archive: "projection=ops&include_archive=1",
      archive_only: "projection=ops&columns=archive",
      archive_page: "projection=ops&columns=archive&limit=50&offset=0",
      full_diagnostics: "projection=ops&fields=full",
    },
  };
}

export interface MakesafeBoardViewer {
  userId: string;
  name?: string | null;
  role?: string | null;
  managedVerticals?: unknown;
}

export type MakesafeTradeProjectionAuthMode =
  | "api_key"
  | "jwt"
  | "routine"
  | "anonymous";

// These are the real role values carried by signed-in production users that may
// open the Trade projection. owner is retained for the approved platform-owner
// scope even though production currently has no owner row. Everything else is
// fail-closed rather than silently becoming an ordinary trade.
export const MAKESAFE_TRADE_PROJECTION_ROLES = [
  "admin",
  "owner",
  "ops_manager",
  "crew",
  "estimator",
  "installer",
  "lead_installer",
  "sales",
] as const;

export function authorizeMakesafeTradeProjection(
  authMode: MakesafeTradeProjectionAuthMode,
  viewer?: MakesafeBoardViewer | null,
) {
  if (authMode !== "jwt" || !viewer) {
    return {
      ok: false as const,
      status: 403,
      error: "trade projection requires an authenticated trade session",
    };
  }
  const role = String(viewer.role || "").trim().toLowerCase();
  if (!(MAKESAFE_TRADE_PROJECTION_ROLES as readonly string[]).includes(role)) {
    return {
      ok: false as const,
      status: 403,
      error: "trade projection is not permitted for this account role",
    };
  }
  return {
    ok: true as const,
    status: 200,
    permissions: resolveMakesafeTradeViewer(viewer),
  };
}

export interface CanonicalMakesafeExtras {
  notesByJobId?: Record<string, any[]>;
  photoCountByJobId?: Record<string, number>;
  contactsByJobId?: Record<string, any[]>;
  intakeCaseByJobId?: Record<string, any>;
  holdsByJobId?: Record<string, MakesafeStatusHold>;
  statusApplicationsByJobId?: Record<string, any>;
  portalCaptureRowsByJobId?: Record<string, any[]>;
  /** R5 — current own-template roof draft per job, for that family only. */
  ownRoofDraftByJobId?: Record<string, any>;
  ownRoofReportDocumentIdsByJobId?: Record<string, Set<string>>;
  /**
   * R7 — the append-only terminal-proof ledger, and the attendance-cycle sets
   * a proof is checked against. Both are read only for the jobs that actually
   * carry a proof; a caller that omits them leaves every card's derivation
   * exactly where its other evidence puts it.
   */
  terminalProofsByJobId?: Record<string, MakesafeTerminalProofFact[]>;
  attendanceCycleIdsByJobId?: Record<string, string[]>;
  terminalSyntheticLivefireJobIds?: ReadonlySet<string>;
  computedAt?: string;
}

function ledgerRoleToBoardRole(value: unknown): string | null {
  const role = token(value);
  if (role === "roofreport") return "roof_report";
  if (role === "assessment") return "assessment_report";
  if (role === "photos") return "photos";
  if (role === "scope") return "quote";
  return null;
}

function linkRoleToBoardRole(value: unknown): string | null {
  const role = token(value);
  if (role === "roofreport") return "roof_report";
  if (role === "assessmentreport") return "assessment_report";
  if (role === "photos") return "photos";
  if (role === "quote") return "quote";
  return null;
}

function validLedgerScreenshot(row: any): boolean {
  return typeof row?.screenshot_object_key === "string" &&
    row.screenshot_object_key.startsWith(
      "makesafe-docket-artifacts/portal-captures/",
    ) &&
    row?.screenshot_media_type === "image/png" &&
    isSesSha256(row?.screenshot_content_hash) &&
    Number(row?.screenshot_size_bytes) > 0;
}

function portalCaptureIdentity(capture: MakesafePortalCapture): string | null {
  const role = token(capture?.role);
  const canonicalRole = role === "roofreport"
    ? "roof_report"
    : ["assessment", "assessmentreport"].includes(role)
    ? "assessment"
    : role === "photos"
    ? "photos"
    : ["scope", "quote"].includes(role)
    ? "scope"
    : null;
  const url = canonicalSesPortalSourceUrl(capture?.url);
  return canonicalRole && url ? `${canonicalRole}\n${url}` : null;
}

/**
 * Project only exact current-cycle portal revisions that still bind to the
 * card's typed source URL. Builder-reference authority is producer-specific:
 * the deterministic writer already validates its value against canonical U4
 * input before commit (where empty is legitimate), while the trade producer
 * derives and records the card's non-empty legacy reference server-side. The
 * board must not re-check a canonical U4 value against a different legacy
 * field. The projection supplies existing evidence to the placing engine.
 *
 * Both approved producers land here (captain, 2026-08-02). They are gated
 * identically on job, cycle, role and source URL, with the producer-specific
 * reference rule above. They differ only in what proves the observation. The
 * deterministic reader must still carry a valid stored screenshot. A trade
 * attestation carries no image — its proof is the authenticated `captured_by` —
 * so it is admitted only for the one role the ruling names (roof) and is
 * stamped `attested_producer`, which is the ONLY thing that lets a
 * screenshot-less capture count downstream.
 */
export function portalCapturesFromLedger(
  base: any,
  rows: any[],
): MakesafePortalCapture[] {
  const detail = base?.makesafe_details || {};
  const jobId = String(base?.id || "");
  const attendanceCycleId = String(detail?.attendance_cycle_id || "");
  if (!jobId || !attendanceCycleId) return [];

  const builderReference = String(
    detail?.external_ref ?? base?.external_ref ?? "",
  ).trim();
  const reportType = token(
    detail?.report_type || base?.metadata?.makesafe_job_family,
  );
  const isRoofPortal = [
    "roofreport",
    "ordinaryroofportal",
    "owntemplateroof",
  ].includes(reportType);
  const sourceKeys = new Set(
    extractPortalLinks(detail?.external_links).flatMap((link) => {
      const role = linkRoleToBoardRole(link.role) ||
        (token(link.role) === "builderportal" && isRoofPortal
          ? "roof_report"
          : null);
      const url = canonicalSesPortalSourceUrl(link.url);
      return role && url ? [`${role}\n${url}`] : [];
    }),
  );
  const currentCycleNumber = Number(
    detail?.cycle_number ?? base?.cycle_number ?? 1,
  );
  const captures: MakesafePortalCapture[] = [];
  const seenLatest = new Set<string>();
  const seenDone = new Set<string>();

  const ordered = [...(rows || [])].sort((a, b) =>
    Number(b?.makesafe_fact_version || 0) -
      Number(a?.makesafe_fact_version || 0) ||
    String(b?.captured_at || "").localeCompare(String(a?.captured_at || ""))
  );
  for (const row of ordered) {
    const role = ledgerRoleToBoardRole(row?.role);
    const url = canonicalSesPortalSourceUrl(row?.source_url);
    const result = String(row?.capture_result || "").toLowerCase();
    const expectedStatus = result === "done"
      ? "verified"
      : result === "not_done"
      ? "captured"
      : result === "unreachable"
      ? "rejected"
      : null;
    const rowBuilderReference = String(row?.builder_reference ?? "").trim();
    const identityKey = role && url ? `${role}\n${url}` : "";
    const producer = row?.capture_producer;
    const deterministic = producer === SES_PORTAL_CAPTURE_PRODUCER;
    const attested = producer === SES_TRADE_PORTAL_CONFIRMATION_PRODUCER;
    const builderReferenceValid = deterministic ||
      (attested && !!rowBuilderReference &&
        rowBuilderReference === builderReference);
    const screenshotOk = sesPortalCaptureProducerHasScreenshot(producer)
      ? (result === "unreachable" || validLedgerScreenshot(row))
      // An attestation is roof-only, done-only, and never carries an image.
      : (role === "roof_report" && result === "done" &&
        !row?.screenshot_object_key);
    if (
      !role || !url || !expectedStatus ||
      String(row?.job_id || "") !== jobId ||
      String(row?.attendance_cycle_id || "") !== attendanceCycleId ||
      !builderReferenceValid ||
      !isTrustedSesPortalCaptureProducer(row?.capture_producer) ||
      String(row?.status || "").toLowerCase() !== expectedStatus ||
      !isSesSha256(row?.source_content_hash) ||
      !sourceKeys.has(identityKey) ||
      !screenshotOk ||
      (attested && !String(row?.captured_by ?? "").trim())
    ) {
      continue;
    }
    // Preserve two facts per typed portal identity:
    //
    // 1. the latest valid observation, which tells the UI whether the link is
    //    currently filling, locked, or gone; and
    // 2. the latest valid completion proof, which is monotonic within an
    //    attendance cycle. A later unreachable/not-done observation cannot
    //    erase an already locked Prime form or an authenticated trade tick.
    //
    // When the latest row is itself done the two facts are the same row and we
    // emit it once. All existing cycle/source/producer/screenshot guards above
    // remain unchanged.
    const isLatest = !seenLatest.has(identityKey);
    const isLastDone = result === "done" && !seenDone.has(identityKey);
    if (!isLatest && !isLastDone) continue;
    if (isLatest) seenLatest.add(identityKey);
    if (isLastDone) seenDone.add(identityKey);
    captures.push({
      status: result,
      role,
      url,
      signal: String(row?.signal || ""),
      locked: result === "done",
      screenshot: result === "unreachable" ? null : row.screenshot_object_key,
      cycle_number: currentCycleNumber,
      // Additive provenance for the canonical row. M1 ignores these keys.
      revision_id: row?.id || null,
      captured_at: row?.captured_at || null,
      // Trusted only because every ledger guard above passed. The status engine
      // uses this marker solely to recover the roof role of historical generic
      // `builder_portal` links; free-form detail captures are stripped below.
      validated_ledger_capture: true,
      // Set ONLY here, ONLY from a validated ledger row. Nothing derived from
      // free-form card content may carry it — see `portalCapturesFromDetail`.
      ...(attested
        ? {
          attested_producer: SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
          attested_by: String(row?.captured_by ?? ""),
        }
        : {}),
    } as MakesafePortalCapture);
  }
  return captures;
}

const txt = (v: unknown): string | null => String(v ?? "").trim() || null;
const token = (v: unknown) =>
  String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

export function isSyntheticLivefireJob(job: any): boolean {
  const metadata = job?.metadata && typeof job.metadata === "object"
    ? job.metadata
    : {};
  return SYNTHETIC_LIVEFIRE_MARKER.test(
    String(metadata.synthetic_livefire_marker || ""),
  );
}

/**
 * The one board-population exclusion for synthetic live-fire traffic whose run
 * has been terminally accounted. `buildCanonicalMakesafeRows` drops these rows,
 * so any census that adds cards back outside the build (the active board's
 * declared-archive count) must drop exactly the same ones or the two published
 * censuses disagree.
 */
export function isExcludedTerminalSyntheticBoardRow(
  row: any,
  terminalSyntheticJobIds?: ReadonlySet<string> | null,
): boolean {
  return isSyntheticLivefireJob(row) &&
    Boolean(terminalSyntheticJobIds?.has(String(row?.id)));
}

export function isTerminalSyntheticLivefireJob(job: any): boolean {
  const metadata = job?.metadata && typeof job.metadata === "object"
    ? job.metadata
    : {};
  return isSyntheticLivefireJob(job) &&
    typeof metadata.synthetic_livefire_terminal_at === "string" &&
    metadata.synthetic_livefire_terminal_at.length > 0;
}

function phoneHref(value: unknown): string | null {
  const raw = txt(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits ? `${raw.startsWith("+") ? "+" : ""}${digits}` : null;
}

function addressOf(job: any): string | null {
  const address = txt(job?.site_address);
  const suburb = txt(job?.site_suburb);
  if (!address) return suburb;
  return !suburb || address.toLowerCase().includes(suburb.toLowerCase())
    ? address
    : `${address}, ${suburb}`;
}

export function buildMakesafeContact(job: any, contacts: any[] = []) {
  const active = contacts.filter((c) =>
    !c?.status || String(c.status).toLowerCase() === "active"
  );
  const fallback = active.find((c) => c?.is_primary === true) || active[0] ||
    {};
  // `jobs.client_name` is the canonical client-facing site-contact source.
  // Do not let a stale auxiliary contact make the cockpit disagree with the
  // completion report assembled from the job row.
  const clientName = txt(job?.client_name);
  const phone = txt(job?.client_phone) || txt(fallback?.client_phone);
  const address = addressOf(job);
  const hrefPhone = phoneHref(phone);
  return {
    client_name: clientName,
    phone,
    address,
    actions: {
      call: hrefPhone
        ? {
          available: true,
          href: `tel:${hrefPhone}`,
          unavailable_reason: null,
        }
        : {
          available: false,
          href: null,
          unavailable_reason: "No client phone on file",
        },
      text: hrefPhone
        ? {
          available: true,
          href: `sms:${hrefPhone}`,
          unavailable_reason: null,
        }
        : {
          available: false,
          href: null,
          unavailable_reason: "No client phone on file",
        },
      navigate: address
        ? {
          available: true,
          href: `https://www.google.com/maps/search/?api=1&query=${
            encodeURIComponent(address)
          }`,
          unavailable_reason: null,
        }
        : {
          available: false,
          href: null,
          unavailable_reason: "No site address on file",
        },
    },
  };
}

function assignmentFacts(rows: any[]) {
  return rows.map((a) => ({
    assignment_id: a?.id || null,
    user_id: a?.user_id || a?.users?.id || null,
    name: a?.users?.name || a?.user?.name || a?.crew_name || null,
    phone: a?.users?.phone || a?.user?.phone || null,
    crew_name: a?.crew_name || null,
    role: a?.role || null,
    status: a?.status || null,
    scheduled_date: a?.scheduled_date || null,
    start_time: a?.start_time || null,
    travel_started_at: a?.travel_started_at || null,
    arrived_at: a?.arrived_at || null,
    started_at: a?.started_at || a?.clocked_on_at || null,
    completed_at: a?.completed_at || null,
  }));
}

function targetHours(base: any) {
  const family = String(base?.metadata?.makesafe_job_family || "")
    .toLowerCase();
  return base?.makesafe_details?.report_type || family.includes("report") ||
      family.includes("assessment")
    ? 48
    : 24;
}
function ageFacts(base: any) {
  const age = Math.max(0, Number(base?.age_hours || 0));
  const target = targetHours(base);
  return {
    age_hours: age,
    age_days: Math.floor(age / 24),
    target_hours: target,
    hard_max_hours: target === 48 ? 72 : 48,
    overdue_hours: Math.max(0, age - target),
    target_state: age <= target ? "within_target" : "over_target",
  };
}

/**
 * The pipeline's additive top-level pack-presentation stamp. It is deliberately
 * NOT `report_pack`: a card with no pack row and no docket must keep publishing
 * `report_pack: null` so M1's `!pack` short-circuit still fires.
 */
function stampedPackPresentation(base: any): any | null {
  const stamp = base?.pack_presentation;
  return stamp && typeof stamp === "object" && txt(stamp.kind) ? stamp : null;
}

/**
 * Operator substatus is a CLAIM. `ready_to_invoice` may only surface when
 * current-cycle report-in evidence backs it (portal lock/capture for
 * roof/assessment; submitted service report + photo floor for physical).
 *
 * Presentation only — never writes `makesafe_job_details.substatus`. An
 * unbacked claim is rewritten so Allocated cards cannot wear a "ready"
 * badge while report.state is still waiting and there is no capture/invoice
 * (SWMS-261113 / 261123 class). Placement stays evidence-derived.
 */
export function presentMakesafeBoardSubstatus(args: {
  rawSubstatus: string | null | undefined;
  reportInSatisfied: boolean;
  detail?: any;
  job?: any;
}): {
  substatus: string | null;
  declared_substatus: string | null;
  demoted: boolean;
} {
  const raw = txt(args.rawSubstatus);
  if (raw !== "ready_to_invoice") {
    return {
      substatus: raw,
      declared_substatus: raw,
      demoted: false,
    };
  }
  if (args.reportInSatisfied === true) {
    return {
      substatus: raw,
      declared_substatus: raw,
      demoted: false,
    };
  }
  const kind = classifyMakesafeJobType(args.detail, args.job);
  const honest = kind === "physical_makesafe"
    ? "waiting_on_trade_report"
    : MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION;
  return {
    substatus: honest,
    declared_substatus: raw,
    demoted: true,
  };
}

function blockerFacts(
  base: any,
  assignments: any[],
  presented?: {
    demoted: boolean;
    declared_substatus: string | null;
    substatus: string | null;
  },
) {
  const substatus = txt(base?.substatus || base?.makesafe_details?.substatus);
  const hasAllocation = assignments.length > 0 ||
    ["scheduled", "in_progress"].includes(
      String(base?.status || "").toLowerCase(),
    );
  const staleCompanyContact = substatus === "company_contact_required" &&
    hasAllocation;
  const real: any[] = [];
  if (substatus === "company_contact_required" && !staleCompanyContact) {
    real.push({
      code: "client_contact_required",
      category: "client_availability",
    });
  }
  if (base?.docs_missing === true) {
    real.push({
      code: "closeout_documents_missing",
      category: "ops_closeout",
      documents: Array.isArray(base?.missing_docs) ? base.missing_docs : [],
    });
  }
  for (
    const blocker of Array.isArray(base?.report_pack?.blockers)
      ? base.report_pack.blockers
      : []
  ) {
    const code = txt(blocker?.reason_code || blocker?.code);
    if (!code) continue;
    const fact = txt(blocker?.fact || blocker?.reason || blocker?.message) ||
      null;
    real.push({
      code,
      category: blocker?.category || "ses_docket",
      docket_revision_id: base?.report_pack?.docket_revision_id || null,
      // Name why — a code alone is not enough for the operator-facing surface.
      ...(fact ? { fact } : {}),
      ...(txt(blocker?.recovery_action)
        ? { recovery_action: txt(blocker.recovery_action) }
        : {}),
    });
  }
  // Surface a presentation-level refusal reason even when the blocker list is
  // empty (legacy failed without structured codes).
  const refusal = stampedPackPresentation(base) || base?.report_pack || null;
  if (
    real.length === 0 &&
    String(refusal?.presentation_kind || refusal?.kind || "").toLowerCase() ===
      "refused" &&
    txt(refusal?.presentation_reason || refusal?.reason)
  ) {
    real.push({
      code: "pack_refused",
      category: "ses_docket",
      docket_revision_id: base?.report_pack?.docket_revision_id || null,
      fact: txt(refusal.presentation_reason || refusal.reason),
    });
  }
  const stale_artifacts: any[] = [];
  if (staleCompanyContact) {
    stale_artifacts.push({
      code: "stale_company_contact_substatus",
      source: "known_allocation_write_path",
    });
  }
  if (presented?.demoted) {
    stale_artifacts.push({
      code: "stale_ready_to_invoice_substatus",
      source: "unbacked_operator_claim",
      declared_substatus: presented.declared_substatus,
      presented_substatus: presented.substatus,
    });
  }
  return {
    blocked: real.length > 0,
    real,
    stale_artifacts,
  };
}

function noteFacts(rows: any[]) {
  return rows.map((n) => ({
    id: n?.id || null,
    text: txt(n?.detail_json?.text ?? n?.detail_json?.note),
    author: n?.users?.name || n?.user?.name || null,
    user_id: n?.user_id || null,
    from_ops: n?.detail_json?.from_ops === true,
    created_at: n?.created_at || null,
  })).filter((n) => !!n.text);
}

function claimKey(base: any): string | null {
  const company = token(
    base?.requesting_company_slug || base?.requesting_company_name ||
      base?.requesting_company,
  );
  const claim = token(
    base?.makesafe_details?.external_ref || base?.external_ref ||
      base?.metadata?.builder_claim_ref,
  );
  if (claim) return `${company || "unknown"}:${claim}`;
  const address = token(base?.site_address);
  return address ? `${company || "unknown"}:address:${address}` : null;
}

function lineageFacts(base: any, intakeCase: any) {
  const combined = base?.metadata?.combined_sibling;
  const jobIdentity = projectMakesafeJobIdentity({
    builder_claim_ref: base?.metadata?.builder_claim_ref,
    builder_work_order_number: base?.metadata?.builder_work_order_number,
    builder_po_number: base?.metadata?.builder_po_number,
    requesting_company_slug: base?.requesting_company_slug,
    family: base?.metadata?.makesafe_job_family,
    authority: "typed_job_metadata",
  });
  return {
    property_claim_key: claimKey(base),
    one_card_per_po: true,
    builder_claim_ref: base?.metadata?.builder_claim_ref ||
      base?.external_ref || null,
    builder_work_order_number: base?.metadata?.builder_work_order_number ||
      null,
    builder_po_number: base?.metadata?.builder_po_number || null,
    builder_work_order_group: jobIdentity.work_order_number,
    builder_instruction_key: jobIdentity.job_grain_key,
    intake_case_id: intakeCase?.id || null,
    lineage_id: intakeCase?.lineage_id || null,
    parent_case_id: intakeCase?.parent_case_id || null,
    parent_relation: intakeCase?.parent_relation || null,
    cycle: Number(intakeCase?.cycle || base?.cycle_number || 1),
    siblings: combined?.job_id
      ? [{
        job_id: combined.job_id,
        job_number: combined.job_number || null,
        role: combined.role || null,
        relationship: "combined_work_order",
      }]
      : [],
  };
}

function portalCapturesFromDetail(base: any): MakesafePortalCapture[] {
  const detail = base?.makesafe_details || {};
  const cycle = Number(detail?.cycle_number ?? base?.cycle_number ?? 1);
  const captures: MakesafePortalCapture[] = [];
  const append = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (item && typeof item === "object") {
        // `attested_producer` is the marker that lets a screenshot-less capture
        // count as done. It is issued by `portalCapturesFromLedger` against a
        // validated ledger row and by nothing else. These entries come from
        // free-form card content (`portal_evidence`, `portal_captures`, a JSON
        // `portal_verified_signal`), so strip it rather than trust it.
        const {
          attested_producer: _dropped,
          legacy_verified: _legacyDropped,
          validated_ledger_capture: _validatedLedgerDropped,
          ...rest
        } = item as Record<
          string,
          unknown
        >;
        captures.push(rest as MakesafePortalCapture);
      }
    }
  };

  // New reporting records may be embedded by the evidence sync. Read them as-is;
  // the board never re-runs or re-classifies capture_portal_evidence.py.
  append(detail?.portal_evidence);
  append(detail?.portal_captures);
  for (
    const link of Array.isArray(detail?.external_links)
      ? detail.external_links
      : []
  ) {
    if (String(link?.status || "").toLowerCase() === "done") {
      captures.push({
        status: "done",
        role: link?.role || link?.kind,
        cycle_number: link?.cycle_number ?? cycle,
      });
    }
  }

  // portal_verified_signal can carry the reporting skill's JSON capture list.
  // Plain legacy verification is sufficient only for a one-link roof report. It
  // can never satisfy the assessment 3-of-3 predicate.
  const signal = detail?.portal_verified_signal;
  if (typeof signal === "string" && /^[\[{]/.test(signal.trim())) {
    try {
      const parsed = JSON.parse(signal);
      append(
        Array.isArray(parsed) ? parsed : parsed?.entries || parsed?.captures,
      );
    } catch {
      // A human-readable signal remains audit text, never manufactured evidence.
    }
  }
  const verifiedThisCycle = !!detail?.portal_verified_at &&
    Number(detail?.portal_verified_cycle) === cycle;
  const reportType = token(
    detail?.report_type || base?.metadata?.makesafe_job_family,
  );
  if (
    verifiedThisCycle && reportType === "roofreport" &&
    !captures.some((capture) =>
      String(capture.status || "").toLowerCase() === "done"
    )
  ) {
    captures.push({ status: "done", role: "roof_report", cycle_number: cycle });
  }
  return captures;
}

/**
 * The card's portal evidence: validated ledger rows first, then whatever the
 * card's own detail fields still carry that the ledger has not already claimed.
 *
 * Exported so the trade confirmation write path answers "is this already
 * confirmed?" from the SAME list the board and M1 read. A control that is
 * offered and a tick that is refused would otherwise be the same bug seen from
 * two sides.
 */
export function projectMakesafePortalCaptures(
  base: any,
  ledgerRows: any[],
): MakesafePortalCapture[] {
  const ledger = portalCapturesFromLedger(base, ledgerRows || []);
  const ledgerIdentities = new Set(
    ledger.map(portalCaptureIdentity).filter(Boolean),
  );
  return [
    ...ledger,
    ...portalCapturesFromDetail(base).filter((capture) => {
      const identity = portalCaptureIdentity(capture);
      return !identity || !ledgerIdentities.has(identity);
    }),
  ];
}

function rawInvoiceStatus(base: any): string | null {
  if (base && "invoice_raw_status" in base) {
    const raw = String(base.invoice_raw_status || "").trim().toUpperCase();
    return raw || null;
  }
  const status = String(base?.invoice_status || "").toLowerCase();
  if (status === "draft") return "DRAFT";
  if (status === "paid") return "PAID";
  if (status === "invoiced") return "AUTHORISED";
  return status ? status.toUpperCase() : null;
}

export function buildCanonicalMakesafeRows(
  baseRows: any[],
  extras: CanonicalMakesafeExtras = {},
  mode: MakesafeBoardFields = "full",
): any[] {
  const cardMode = mode === "card";
  const computedAt = extras.computedAt || new Date().toISOString();
  const terminalSyntheticJobIds = extras.terminalSyntheticLivefireJobIds;
  const rows = (baseRows || []).filter((base) =>
    !isExcludedTerminalSyntheticBoardRow(base, terminalSyntheticJobIds)
  ).map((base) => {
    // enrichMakesafeBoardJob already cycle-scopes assignments/report/pack on the
    // base row; re-apply photo fail-closed for reattend here (photos are not
    // cycle-keyed yet).
    const assignments = assignmentFacts(base?.assignments || []);
    const report = base?.report || null;
    const pack = base?.report_pack || null;
    const detail = base?.makesafe_details || {};
    const sesFamily = boardRowSesFamily(base);
    // Release 12: portal captures, holds and photo counts are PLACEMENT
    // evidence now (the corrected engine reads them), so card mode loads and
    // projects them like full mode. Card and full mode must place identically.
    const ledgerRows = extras.portalCaptureRowsByJobId?.[base?.id] || [];
    const ledgerPortalCaptures = portalCapturesFromLedger(base, ledgerRows);
    const portalCaptures = projectMakesafePortalCaptures(base, ledgerRows);
    const hold = extras.holdsByJobId?.[base?.id] || null;
    const rawPhotoCount = Number(extras.photoCountByJobId?.[base?.id] || 0);
    const photoCount = photoCountForCurrentCycle(
      rawPhotoCount,
      detail,
      false, // no photo attendance_cycle_id write path yet → reattend fail-closed
    );
    const swmsRequired = requiresMakesafeSwms(detail, base);
    const declaredStage = String(base?.board_stage || "new").toLowerCase();
    const application = extras.statusApplicationsByJobId?.[base?.id] || null;
    const invoiceQualifiesAsCurrentDraft =
      base?.invoice_qualifies_as_current_draft === true;
    const invoiceQualifiesAsCurrentCloseout =
      base?.invoice_qualifies_as_current_closeout === true ||
      invoiceQualifiesAsCurrentDraft;
    const invoiceCloseoutSatisfied = invoiceQualifiesAsCurrentDraft ||
      (invoiceQualifiesAsCurrentCloseout &&
        (base?.has_invoice_doc === true || !!pack?.invoice_doc_id));
    // R8 — an overlay row declares what it is allowed to do. A row with no
    // `decision_kind` is a legacy display override, which is every row in the
    // ledger today, so this reads as `display_override` and the binding below
    // is unchanged for all of them.
    const decisionKind = sesOverlayDecisionKind(application);
    // enrich already cycle-scopes pack/invoice closeout inputs on reattend.
    const invoiceStatus = rawInvoiceStatus(base);
    const packSent = base?.pack_sent === true;

    // ── RELEASE 12: the corrected evidence engine PLACES the card. ──────────
    // Captain-approved 2026-08-06 (Rescue SES mission, wiki
    // makesafe-system/missions/rescue-ses-2026-08/CONTRACT.md). The legacy
    // ladder's answer stays published as `declared_stage` provenance, but
    // `canonical_stage` is now the corrected engine plus the display-ledger
    // overlay, anchored on the DERIVED stage (Release 9 re-anchor rows carry
    // the matching source_status). Built WITHOUT `displayedStatus`, so the
    // engine physically cannot see the stage the board previously displayed.
    const statusInput = {
      job: base,
      detail,
      evidence: {
        assignments,
        serviceReports: report ? [report] : [],
        completionPhotoCount: photoCount,
        portalCaptures,
        packState: pack?.review_state || null,
        pack,
        invoiceStatus,
        invoiceQualifiesAsCurrentDraft,
        invoiceQualifiesAsCurrentCloseout,
        invoiceDate: base?.invoice_date || null,
        invoiceCreatedAt: base?.invoice_created_at || null,
        packSent,
        documents: {
          report: base?.has_report_doc === true || !!pack?.report_doc_id,
          ownRoofReportDocumentIds: extras?.ownRoofReportDocumentIdsByJobId?.[
            String(base?.id || "")
          ] ?? new Set<string>(),
          invoice: base?.has_invoice_doc === true || !!pack?.invoice_doc_id ||
            invoiceQualifiesAsCurrentDraft,
          swms: base?.has_swms_doc === true || !!pack?.swms_doc_id,
        },
        swmsRequired,
        hold,
        ownRoofDraft: extras?.ownRoofDraftByJobId?.[String(base?.id || "")] ??
          null,
        terminalProofs:
          extras?.terminalProofsByJobId?.[String(base?.id || "")] ??
            null,
        attendanceCycleIds:
          extras?.attendanceCycleIdsByJobId?.[String(base?.id || "")] ?? null,
        currentAttendanceCycleId: base?.attendance_cycle_id ??
          detail?.attendance_cycle_id ?? null,
      },
      ses_family: sesFamily,
      nowIso: computedAt,
    };
    const reportIn = reportInEvidence(statusInput);
    const stageV2 = deriveSesStageV2(statusInput);
    const derivedStage = String(stageV2.stage || "").toLowerCase();
    // R8 — ATTESTATIONS CAN NEVER BIND. The `decisionKind` test is FIRST and
    // structural. Binding is anchored on the DERIVED stage (post-R12); the
    // report_ready draft-invoice prerequisite is unchanged.
    const applicationApplies = decisionKind === "display_override" &&
      !!application &&
      !isMakesafeTerminalDisplayStatus(derivedStage) &&
      !isMakesafeTerminalJobState(base?.status) &&
      String(application.source_status || "").toLowerCase() === derivedStage &&
      (String(application.after_status || "").toLowerCase() !==
          "report_ready" ||
        invoiceCloseoutSatisfied);
    // An attestation attaches PROVENANCE only, and only when it genuinely
    // describes where the card already is. It never changes `displayStage`.
    const attestationAttaches = decisionKind === "stage_attestation" &&
      !!application &&
      String(application.source_status || "").toLowerCase() === derivedStage &&
      String(application.after_status || "").toLowerCase() === derivedStage;
    // Placement authority: corrected engine + display-ledger overlay.
    // Identical in card and full mode — card mode must never re-derive.
    const displayStage = applicationApplies
      ? String(application.after_status || derivedStage).toLowerCase()
      : derivedStage;
    const presentation = boardPresentationFields(base);
    const contact = buildMakesafeContact(
      base,
      cardMode ? [] : (extras.contactsByJobId?.[base?.id] || []),
    );
    const lineage = lineageFacts(
      base,
      cardMode ? null : extras.intakeCaseByJobId?.[base?.id],
    );
    // The pipeline's own `pack_presentation` stamp is the single presentation
    // authority for physical packs; re-derive when the stamp is dishonest or
    // when the card is report-only (pipeline fails closed without portal
    // captures; this read model has them). `drafted` always comes from the
    // presentation, never from reading a presentation state string.
    const needsBoundReportPdf = requiresBoundBuilderReportPdf(statusInput);
    // Prefer the preserved raw U4 stamp when the pipeline already gated
    // operator-facing pre_xero_docs_ready. Legacy rows only carried the stamp
    // on pre_xero_docs_ready itself.
    const docketPreXeroStamp = pack?.docket_pre_xero_docs_ready === true ||
      (pack?.docket_pre_xero_docs_ready == null &&
        pack?.pre_xero_docs_ready === true);
    const honestyInput = {
      docket: pack?.docket_revision_id
        ? {
          id: pack.docket_revision_id,
          pre_xero_docs_ready: docketPreXeroStamp,
          blockers: pack.blockers,
        }
        : null,
      legacy_pack: pack
        ? {
          status: pack.legacy_pack_status || pack.status,
          failed_step: pack.failed_step,
          error_detail: pack.error_detail,
        }
        : null,
      pack_sent: packSent || base?.sent_to_builder === true,
      has_report_doc: base?.has_report_doc === true,
      report_doc_id: pack?.report_doc_id || null,
      requires_bound_report_doc: needsBoundReportPdf,
      swms_doc_id: pack?.swms_doc_id || null,
      requires_bound_swms: swmsRequired,
      // Report-only: ready presentation still needs portal/own-template proof.
      family_report_evidence_satisfied: needsBoundReportPdf
        ? true
        : reportIn.satisfied,
    };
    const stamped = stampedPackPresentation(base);
    // A stale pipeline stamp can still claim ready without bind pointers —
    // re-derive when the stamp would green a card the live binds refuse.
    // Report-only always re-derives: the pipeline cannot see portal captures.
    const stampedReadyDishonest = String(stamped?.kind || "") === "ready" && (
      (needsBoundReportPdf && !String(pack?.report_doc_id || "").trim()) ||
      (swmsRequired && !String(pack?.swms_doc_id || "").trim()) ||
      (!needsBoundReportPdf && !reportIn.satisfied)
    );
    const reportOnlyNeedsLiveHonesty = !needsBoundReportPdf;
    const shouldDeriveHonesty = !stamped || stampedReadyDishonest ||
      reportOnlyNeedsLiveHonesty;
    const derived = shouldDeriveHonesty
      ? presentSesPackHonesty(honestyInput)
      : null;
    const packHonestySource = (stampedReadyDishonest ||
        reportOnlyNeedsLiveHonesty)
      ? derived
      : (stamped ?? derived);
    const packHonesty = {
      kind: String(packHonestySource?.kind ?? "none"),
      state: String(packHonestySource?.state ?? "not_started"),
      reason: packHonestySource?.reason ?? null,
      drafted: packHonestySource?.drafted === true || !!pack?.report_doc_id,
      legacy_pack_status: packHonestySource?.legacy_pack_status ?? null,
    };
    const packPayload = {
      // Honest state: never a stale legacy `failed` over a ready docket.
      state: packHonesty.state ||
        (base?.sent_to_builder ? "sent" : "not_started"),
      sent: packSent,
      sent_at: packSent
        ? (pack?.sent_at || base?.makesafe_details?.report_sent_at || null)
        : null,
      drafted: packHonesty.drafted === true,
      docket_revision_id: pack?.docket_revision_id || null,
      // Presentation honesty outranks a stale docket stamp: missing binds
      // cannot publish pre_xero_docs_ready as an operator-facing ready signal.
      pre_xero_docs_ready: packHonesty.kind === "ready" && docketPreXeroStamp,
      // Refusal / incomplete / ready distinction for the operator surface.
      presentation_kind: packHonesty.kind,
      presentation_reason: packHonesty.reason,
      legacy_pack_status: packHonesty.legacy_pack_status,
      report_doc_id: pack?.report_doc_id || null,
      invoice_doc_id: pack?.invoice_doc_id || null,
      swms_doc_id: pack?.swms_doc_id || null,
      closeout_documents: {
        // Physical / temp-fence: the report tile is the pack bind only.
        // Attach tick (`has_report_doc`) is not a bind.
        // Roof / assessment honestly have no local make-safe report, so the
        // portal/own-template report-in predicate remains the tile.
        report: needsBoundReportPdf
          ? !!String(pack?.report_doc_id || "").trim()
          : (reportIn.satisfied || base?.has_report_doc === true ||
            !!pack?.report_doc_id),
        invoice: invoiceCloseoutSatisfied,
        // Required SWMS closeout tick is the pack pointer; attach alone is not.
        swms: swmsRequired
          ? !!String(pack?.swms_doc_id || "").trim()
          : (base?.has_swms_doc === true || !!pack?.swms_doc_id),
      },
    };
    const rawReportState = String(
      report?.status || base?.report_status || "waiting_on_trade_report",
    );
    const reportPayload = {
      // Portal completion evidence is the report for roof/assessment cards.
      // Keep a real submitted/approved service-report state when one exists;
      // otherwise bind the shared report-in predicate into this presentation
      // field so a locked Prime capture cannot still read as waiting.
      state: reportIn.satisfied
        ? (["submitted", "approved"].includes(rawReportState.toLowerCase())
          ? rawReportState
          : "submitted")
        : rawReportState,
      submitted_at: report?.submitted_at || report?.created_at ||
        base?.makesafe_details?.report_received_at || null,
      photo_count: photoCount,
      cycle_number: Number(report?.cycle_number || base?.cycle_number || 1),
    };
    const presentedSubstatus = presentMakesafeBoardSubstatus({
      rawSubstatus: base?.substatus || detail?.substatus,
      reportInSatisfied: reportIn.satisfied,
      detail,
      job: base,
    });
    const statusApplication = (applicationApplies || attestationAttaches)
      ? {
        effect: applicationApplies ? "override" : "attestation",
        applies_to_display: applicationApplies,
        decision_kind: decisionKind,
        run_key: application.run_key,
        before_status: application.before_status,
        after_status: application.after_status,
        evidence_ref: application.evidence_ref,
        applied_by: application.applied_by,
        applied_at: application.applied_at,
        // Duplicate-survivor archives carry a pointer to the card that
        // survived, so an archived duplicate never reads as lost work.
        duplicate_of_job_id: application.duplicate_of_job_id ?? null,
        duplicate_of_job_number: application.duplicate_of_job_number ?? null,
        duplicate_rule: application.duplicate_rule ?? null,
      }
      : null;
    const spine = {
      contract_version: MAKESAFE_BOARD_CONTRACT_VERSION,
      id: base?.id,
      job_number: base?.job_number || null,
      type: base?.type || "makesafe",
      ses_family: sesFamily,
      ses_family_label: sesFamilyLabel(sesFamily),
      // Captain 2026-08-02 sealed repair + restoration on the physical pack path;
      // only `unknown` has no recipe.
      ses_recipe_state: sesFamily === "unknown" ? "unknown" : "sealed",
      job_state: base?.status || null,
      // Evidence-backed presentation: unbacked ready_to_invoice is demoted.
      substatus: presentedSubstatus.substatus,
      declared_stage: declaredStage,
      // Placement authority — identical in card and full mode. Release 12:
      // the corrected engine (+ overlay) places the card; `declared_stage`
      // above is the legacy ladder's answer, kept as provenance only.
      canonical_stage: displayStage,
      canonical_stage_label:
        OPS_MAKESAFE_STAGE_LABELS[displayStage as OpsMakesafeStage] ||
        base?.board_label || displayStage,
      placement_engine_version: `${stageV2.engine_version}+overlay-r12`,
      status_application: statusApplication,
      // Present regardless of whether the overlay currently applies, so the
      // planner can refuse to re-archive a card it already archived.
      duplicate_of_job_id: application?.duplicate_of_job_id ?? null,
      duplicate_of_job_number: application?.duplicate_of_job_number ?? null,
      captain_action: base?.captain_action ?? null,
      attendance_cycle_id: base?.attendance_cycle_id ?? null,
      cycle_number: Number(
        base?.cycle_number || detail?.cycle_number || report?.cycle_number || 1,
      ),
      cycle_attribution_flags: Array.isArray(base?.cycle_attribution_flags)
        ? base.cycle_attribution_flags
        : [],
      readiness_revision: base?.readiness_revision ?? null,
      invoice_qualifies_as_current_draft: invoiceQualifiesAsCurrentDraft,
      invoice_draft_qualification_reason:
        base?.invoice_draft_qualification_reason ?? "missing_invoice",
      commercial_warning: base?.commercial_warning ?? null,
      makesafe_type: sesFamily === "restoration" || sesFamily === "repair"
        ? sesFamilyLabel(sesFamily)
        : base?.metadata?.makesafe_job_family_label ||
          base?.metadata?.makesafe_job_family ||
          base?.makesafe_details?.report_type ||
          "Make-safe",
      builder: {
        name: base?.requesting_company_name || base?.requesting_company || null,
        external_ref: base?.external_ref || null,
      },
      report: reportPayload,
      // Direct, current-card coordinates for headless board consumers. These
      // are aliases of evidence already loaded and cycle-scoped by the board;
      // they do not query, bind, build, approve, or send anything.
      report_doc_id: pack?.report_doc_id || null,
      has_report_doc: base?.has_report_doc === true || !!pack?.report_doc_id,
      invoice_id: base?.invoice_id || null,
      pack: packPayload,
      age: ageFacts(base),
      blockers: blockerFacts(base, assignments, presentedSubstatus),
      cancelled: displayStage === "cancelled"
        ? {
          reason: base?.cancel_reason || null,
          note: base?.cancel_note || null,
          by: base?.cancelled_by || null,
          at: base?.cancelled_at || null,
        }
        : null,
      // Stamped so fields=card is self-sufficient for board paint without the
      // makesafe_pipeline dual-fetch. Full mode keeps them too (additive).
      presentation,
      ...presentation,
    };

    // Card mode: placement + paint only. Skip M1, stage-v2 shadow, roof tick,
    // notes, fat lineage siblings, and diagnostic evidence blobs.
    if (cardMode) {
      return {
        ...spine,
        contact: slimContactForCard(contact),
        assignments: slimAssignmentsForCard(assignments),
        lineage: slimLineageForCard(lineage),
      };
    }

    // Release 12: `statusInput` and `stageV2` are computed ABOVE, before
    // placement — the engine's answer IS the placement. M1 stays published for
    // measurement continuity and still receives the displayed stage.
    const computation = computeMakesafeStatus({
      ...statusInput,
      displayedStatus: displayStage,
    });
    const stageV2Overlay = sesStageV2OverlayCandidate(
      stageV2.stage,
      application,
      base?.status,
      invoiceCloseoutSatisfied,
    );
    const roofEligibility = sesRoofConfirmationEligibility(
      base,
      portalCaptures,
    );
    const roofConfirmation = {
      producer: SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
      applicable: roofEligibility.applicable,
      confirmed: roofEligibility.confirmed,
      offered: roofEligibility.offered,
      reason: roofEligibility.reason,
      question: roofEligibility.offered
        ? SES_TRADE_PORTAL_CONFIRMATION_QUESTION
        : null,
      source_url: roofEligibility.target?.source_url ?? null,
      attendance_cycle_id: roofEligibility.target?.attendance_cycle_id ?? null,
      cycle_number: roofEligibility.target?.cycle_number ?? null,
    };
    return {
      ...spine,
      // Which legacy ladder derived `declared_stage`
      // (`MAKESAFE_STAGE_LADDER_VERSION`, stamped by enrich). Advisory
      // provenance only — the sibling of `derived_stage_v2_engine_version`, so a
      // past measurement can name the derivation that produced it. Null for a
      // caller that built the base row without enrich.
      declared_stage_engine_version: base?.board_stage_engine_version ?? null,
      computed_status: computation.status,
      computed_status_reasons: computation.reasons,
      computed_status_missing: computation.missing,
      computed_status_at: computedAt,
      computed_status_hold: computation.hold,
      computed_status_job_type: computation.job_type,
      computed_status_evidence: {
        closeout_satisfied: computation.closeout_satisfied === true,
        report_received_at: detail?.report_received_at || null,
        has_submitted_service_report: !!report &&
          ["submitted", "approved"].includes(
            String(report?.status || "").toLowerCase(),
          ),
        has_current_portal_capture:
          computation.job_type !== "physical_makesafe" &&
          reportIn.satisfied,
        portal_capture_revisions: ledgerPortalCaptures.map((capture: any) => ({
          id: capture.revision_id || null,
          role: capture.role || null,
          status: capture.status || null,
          signal: capture.signal || null,
          captured_at: capture.captured_at || null,
          screenshot_available: !!capture.screenshot,
        })),
      },
      // ── Corrected stage engine — PLACEMENT AUTHORITY (Release 12) ───────
      // `derived_stage_v2` is the engine's own pre-overlay answer, and it is
      // what `canonical_stage` above is built from (engine + overlay). It is
      // also the ledger anchor every overlay writer stamps as `source_status`
      // (`makesafeOverlaySourceStatus`). The remaining keys in this block stay
      // diagnostic: comparison, audit, and measurement continuity.
      derived_stage_v2: stageV2.stage,
      // What the EXISTING overlay resolver would produce if the derivation
      // changed. A simulation with the same guards — it binds nothing.
      derived_stage_v2_post_overlay: stageV2Overlay.stage,
      derived_stage_v2_overlay_binds: stageV2Overlay.binds,
      derived_stage_v2_agrees_with_canonical:
        stageV2Overlay.stage === displayStage,
      derived_stage_v2_reasons: stageV2.reasons,
      derived_stage_v2_missing: stageV2.missing,
      derived_stage_v2_conflicts: stageV2.conflicts,
      derived_stage_v2_engine_version: stageV2.engine_version,
      // R4 — the canonical family the shadow engine actually used, and the
      // evidence path it delegated to. Diagnostic only, like every key above.
      derived_stage_v2_family: stageV2.ses_family,
      derived_stage_v2_family_kind: stageV2.family_kind,
      derived_stage_v2_family_recipe_state: stageV2.family_recipe_state,
      // The trade roof-report tick (captain, 2026-08-02). Advisory metadata
      // describing whether the one-question control belongs on this card; it
      // places no card and feeds no stage engine.
      roof_report_confirmation: roofConfirmation,
      job_identity: projectMakesafeJobIdentity({
        builder_claim_ref: base?.metadata?.builder_claim_ref,
        builder_work_order_number: base?.metadata?.builder_work_order_number,
        builder_po_number: base?.metadata?.builder_po_number,
        requesting_company_slug: base?.requesting_company_slug,
        family: base?.metadata?.makesafe_job_family,
        authority: "typed_job_metadata",
      }),
      contact,
      assignments,
      notes: noteFacts(extras.notesByJobId?.[base?.id] || []),
      lineage,
    };
  });

  // Sibling fan-out is diagnostic (lineage.siblings) and fat. Card mode never
  // spends the O(N²) property-claim grouping pass.
  if (cardMode) return rows;

  const grouped = new Map<string, any[]>();
  for (const row of rows) {
    const key = row.lineage.property_claim_key;
    if (key) grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      const known = new Set(row.lineage.siblings.map((s: any) => s.job_id));
      for (const sibling of group) {
        if (sibling.id === row.id || known.has(sibling.id)) continue;
        row.lineage.siblings.push({
          job_id: sibling.id,
          job_number: sibling.job_number,
          role: sibling.makesafe_type,
          relationship: "same_property_claim",
          builder_po_number: sibling.lineage.builder_po_number,
          builder_work_order_number: sibling.lineage.builder_work_order_number,
          builder_work_order_group: sibling.lineage.builder_work_order_group,
          builder_instruction_key: sibling.lineage.builder_instruction_key,
        });
      }
    }
  }
  return rows;
}

export function mapOpsStageToTradeColumn(stage: unknown): {
  column: TradeMakesafeColumn;
  mapped: boolean;
} {
  const normalized = String(stage || "").toLowerCase() as OpsMakesafeStage;
  return (OPS_MAKESAFE_STAGES as readonly string[]).includes(normalized)
    ? { column: OPS_TO_TRADE_COLUMN[normalized], mapped: true }
    : { column: "New", mapped: false };
}

export function projectOpsMakesafeBoard(
  rows: any[],
  options: { fields?: MakesafeBoardFields } = {},
) {
  const fields = options.fields || "full";
  const columns: Record<string, any[]> = Object.fromEntries(
    OPS_MAKESAFE_STAGES.map((stage) => [stage, []]),
  );
  const unmapped: string[] = [];
  for (const row of rows || []) {
    // Card-shaped rows are already slim; full rows are projected through the
    // stripper only when the caller asked for card on a full build.
    const projected = fields === "card" && row &&
        (row.computed_status_evidence !== undefined ||
          row.derived_stage_v2 !== undefined ||
          row.notes !== undefined ||
          row.roof_report_confirmation !== undefined ||
          row.job_identity !== undefined)
      ? projectOpsMakesafeCardRow(row)
      : row;
    const stage = String(projected?.canonical_stage || "").toLowerCase();
    if ((OPS_MAKESAFE_STAGES as readonly string[]).includes(stage)) {
      columns[stage].push(projected);
    } else {
      columns.new.push({
        ...projected,
        projection_warning: `Unknown canonical stage: ${stage || "(blank)"}`,
      });
      if (projected?.id) unmapped.push(projected.id);
    }
  }
  // Card shape: do NOT duplicate every card under `rows`. Columns alone is how
  // the ops board paints; the flat list was ~half the wire weight for no gain.
  // Full shape keeps `rows` for existing diagnostic consumers and trade parity.
  if (fields === "card") {
    return {
      shape: "card" as const,
      columns,
      unmapped_stage_job_ids: unmapped,
      row_count: Object.values(columns).reduce(
        (n, list) => n + (Array.isArray(list) ? list.length : 0),
        0,
      ),
    };
  }
  return {
    shape: "full" as const,
    columns,
    rows: Object.values(columns).flat(),
    unmapped_stage_job_ids: unmapped,
  };
}

// Visibility is server-owned: it derives ONLY from role and managed_verticals,
// never from a display name. A caller whose profile name happens to be "hugo"
// or "jan" gets nothing extra — the authority lives in the record, not the label.
//   - Full make-safe managers (Hugo via managed_verticals "makesafe", plus
//     platform admins/owners/ops managers): see every make-safe AND may allocate.
//   - View-only make-safe capability (e.g. Jan): sees every make-safe but is
//     action-gated — can_allocate is always false. Provision via a
//     "makesafe_view" / "makesafe_readonly" managed vertical (flagged for Marnin
//     in the PR to flip to full "makesafe" if allocate rights are ever wanted).
//   - Fencing viewers (managed_verticals "fencing", or the production sales
//     role used by Khairo): make-safe view-only, no allocate, and no
//     all-makesafe visibility. A sales profile that explicitly manages makesafe
//     still takes the manager scope first (the current Nithin shape).
export function resolveMakesafeTradeViewer(viewer: MakesafeBoardViewer) {
  const role = String(viewer?.role || "").trim().toLowerCase();
  const managed = Array.isArray(viewer?.managedVerticals)
    ? viewer.managedVerticals.map((v) => String(v || "").trim().toLowerCase())
    : [];
  const privileged = ["admin", "owner", "ops_manager"].includes(role);
  const makesafeManager = privileged || managed.includes("makesafe");
  const makesafeViewer = managed.includes("makesafe_view") ||
    managed.includes("makesafe_readonly");
  const fencingViewOnly = !makesafeManager &&
    (managed.includes("fencing") || role === "sales");
  const seesAll = makesafeManager || makesafeViewer;
  return {
    visibility: seesAll ? "all_makesafes" : "allocated_only",
    sees_all_makesafes: seesAll,
    fencing_view_only: fencingViewOnly,
    can_allocate: makesafeManager && !fencingViewOnly,
  };
}

function tradeSafe(row: any, viewer: MakesafeBoardViewer, all: boolean) {
  const mapped = mapOpsStageToTradeColumn(row?.canonical_stage);
  return {
    contract_version: MAKESAFE_BOARD_CONTRACT_VERSION,
    id: row?.id,
    job_number: row?.job_number,
    type: row?.type,
    makesafe_type: row?.makesafe_type,
    ses_family: row?.ses_family,
    ses_family_label: row?.ses_family_label,
    ses_recipe_state: row?.ses_recipe_state,
    column: mapped.column,
    canonical_stage: row?.canonical_stage,
    projection_warning: mapped.mapped
      ? null
      : `Unknown canonical stage: ${row?.canonical_stage || "(blank)"}`,
    job_state: row?.job_state,
    substatus: row?.substatus,
    builder: row?.builder,
    job_identity: row?.job_identity,
    contact: row?.contact,
    assignments: all
      ? row?.assignments || []
      : (row?.assignments || []).filter((a: any) =>
        a.user_id === viewer.userId
      ),
    report: row?.report,
    pack: row?.pack,
    notes: row?.notes,
    lineage: row?.lineage,
    age: row?.age,
    blockers: row?.blockers,
    cancelled: row?.cancelled,
    // U2-S1: holds visible to both ops and trade (allow-listed shape only).
    hold: tradeSafeHold(row?.computed_status_hold),
    attendance_cycle_id: row?.attendance_cycle_id ?? null,
    cycle_number: row?.cycle_number ?? null,
    cycle_attribution_flags: row?.cycle_attribution_flags || [],
    readiness_revision: row?.readiness_revision ?? null,
    // The one-question roof tick. `can_confirm` adds the only thing the
    // canonical row cannot know: whether THIS viewer is on the job. A manager
    // who sees every card is not on any of them, so they never get the control.
    roof_report_confirmation: tradeSafeRoofConfirmation(row, viewer),
  };
}

function tradeSafeRoofConfirmation(
  row: any,
  viewer: MakesafeBoardViewer,
): SesRoofConfirmationPayload {
  const confirmation = row?.roof_report_confirmation || null;
  const assignedToViewer = (row?.assignments || []).some((assignment: any) =>
    assignment?.user_id === viewer.userId &&
    String(assignment?.status || "").toLowerCase() !== "cancelled"
  );
  return {
    producer: SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
    applicable: confirmation?.applicable === true,
    confirmed: confirmation?.confirmed === true,
    offered: confirmation?.offered === true,
    can_confirm: confirmation?.offered === true && assignedToViewer,
    reason: confirmation?.reason ?? "not_a_roof_card",
    question: confirmation?.offered === true && assignedToViewer
      ? SES_TRADE_PORTAL_CONFIRMATION_QUESTION
      : null,
    source_url: confirmation?.source_url ?? null,
    attendance_cycle_id: confirmation?.attendance_cycle_id ?? null,
    cycle_number: confirmation?.cycle_number ?? null,
  };
}

export function projectTradeMakesafeBoard(
  rows: any[],
  viewer: MakesafeBoardViewer,
) {
  const permissions = resolveMakesafeTradeViewer(viewer);
  const visible = permissions.sees_all_makesafes
    ? rows || []
    : (rows || []).filter((r) =>
      (r?.assignments || []).some((a: any) => a.user_id === viewer.userId)
    );
  const columns: Record<TradeMakesafeColumn, any[]> = {
    New: [],
    Allocated: [],
    Complete: [],
    Archive: [],
  };
  const unmapped: string[] = [];
  for (const row of visible) {
    const projected = tradeSafe(row, viewer, permissions.sees_all_makesafes);
    columns[projected.column].push(projected);
    if (projected.projection_warning && row?.id) unmapped.push(row.id);
  }
  return {
    columns,
    rows: TRADE_MAKESAFE_COLUMNS.flatMap((column) => columns[column]),
    permissions,
    unmapped_stage_job_ids: unmapped,
  };
}

export function checkMakesafeBoardParity(rows: any[]) {
  const canonical = rows || [];
  // Project each board exactly once. Callers reuse the returned `ops` projection
  // instead of re-projecting for the response (see the ops-api handler).
  const ops = projectOpsMakesafeBoard(canonical);
  const trade = projectTradeMakesafeBoard(canonical, {
    userId: "parity-checker",
    role: "ops_manager",
    managedVerticals: ["makesafe"],
  });
  // Index the projections once so the per-row checks below are O(N), not O(N^2).
  const opsCountById = new Map<string, number>();
  // Full projection always emits `rows`; card omits it. Parity only runs full.
  const opsFlat = ops.rows ?? Object.values(ops.columns || {}).flat();
  for (const r of opsFlat) {
    if (r?.id) opsCountById.set(r.id, (opsCountById.get(r.id) || 0) + 1);
  }
  const tradeCountById = new Map<string, number>();
  const tradeRowById = new Map<string, any>();
  for (const r of trade.rows) {
    if (!r?.id) continue;
    tradeCountById.set(r.id, (tradeCountById.get(r.id) || 0) + 1);
    if (!tradeRowById.has(r.id)) tradeRowById.set(r.id, r);
  }
  const errors: string[] = [];
  for (const row of canonical) {
    if (!row?.id) {
      errors.push("canonical row missing id");
      continue;
    }
    const opsCount = opsCountById.get(row.id) || 0;
    const tradeCount = tradeCountById.get(row.id) || 0;
    if (opsCount !== 1) {
      errors.push(`${row.id}: ops projection count ${opsCount}`);
    }
    if (tradeCount !== 1) {
      errors.push(`${row.id}: trade projection count ${tradeCount}`);
    }
    const tradeRow = tradeRowById.get(row.id);
    const expected = mapOpsStageToTradeColumn(row.canonical_stage).column;
    if (tradeRow?.column !== expected) {
      errors.push(
        `${row.id}: expected trade ${expected}, got ${tradeRow?.column}`,
      );
    }
    if (tradeRow?.canonical_stage !== row.canonical_stage) {
      errors.push(`${row.id}: canonical stage changed in projection`);
    }
  }
  return {
    ok: errors.length === 0,
    checked: canonical.length,
    errors,
    unmapped_stage_job_ids: Array.from(
      new Set([
        ...ops.unmapped_stage_job_ids,
        ...trade.unmapped_stage_job_ids,
      ]),
    ),
    ops,
  };
}
