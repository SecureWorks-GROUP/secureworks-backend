// deno-lint-ignore-file no-explicit-any
// Canonical make-safe board row and its two audience projections.
// Clients must never derive a board column from assignment status.
import {
  computeMakesafeStatus,
  type MakesafePortalCapture,
  type MakesafeStatusHold,
  reportInEvidence,
} from "./makesafe_computed_status.ts";
import {
  isMakesafeTerminalDisplayStatus,
  isMakesafeTerminalJobState,
} from "./makesafe_status_apply.ts";
import {
  photoCountForCurrentCycle,
  tradeSafeHold,
} from "./makesafe_cycle_evidence.ts";

export const MAKESAFE_BOARD_CONTRACT_VERSION = "makesafe-board.v1";
const SYNTHETIC_LIVEFIRE_MARKER =
  /^SWG-SES-LIVEFIRE-TEST-ONLY-[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/;
export const OPS_MAKESAFE_STAGES = [
  "new",
  "allocated",
  "trade_report_in",
  "report_ready",
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
  completed: "Archive",
  archive: "Archive",
  cancelled: "Archive",
};
export const OPS_MAKESAFE_STAGE_LABELS: Record<OpsMakesafeStage, string> = {
  new: "New",
  allocated: "Allocated",
  trade_report_in: "Trade Report In",
  report_ready: "Report Ready",
  completed: "Completed This Week",
  archive: "Archive",
  cancelled: "Cancelled",
};

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
  computedAt?: string;
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
  const clientName = txt(job?.client_name) || txt(fallback?.client_name);
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

function blockerFacts(base: any, assignments: any[]) {
  const substatus = txt(base?.substatus || base?.makesafe_details?.substatus);
  const hasAllocation = assignments.length > 0 ||
    ["scheduled", "in_progress"].includes(
      String(base?.status || "").toLowerCase(),
    );
  const stale = substatus === "company_contact_required" && hasAllocation;
  const real: any[] = [];
  if (substatus === "company_contact_required" && !stale) {
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
    const code = txt(blocker?.reason_code);
    if (!code) continue;
    real.push({
      code,
      category: "ses_docket",
      docket_revision_id: base?.report_pack?.docket_revision_id || null,
    });
  }
  return {
    blocked: real.length > 0,
    real,
    stale_artifacts: stale
      ? [{
        code: "stale_company_contact_substatus",
        source: "known_allocation_write_path",
      }]
      : [],
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
  return {
    property_claim_key: claimKey(base),
    one_card_per_po: true,
    builder_claim_ref: base?.metadata?.builder_claim_ref ||
      base?.external_ref || null,
    builder_work_order_number: base?.metadata?.builder_work_order_number ||
      null,
    builder_po_number: base?.metadata?.builder_po_number || null,
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
        captures.push(item as MakesafePortalCapture);
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
): any[] {
  const computedAt = extras.computedAt || new Date().toISOString();
  const rows = (baseRows || []).filter((base) =>
    !isTerminalSyntheticLivefireJob(base)
  ).map((base) => {
    // enrichMakesafeBoardJob already cycle-scopes assignments/report/pack on the
    // base row; re-apply photo fail-closed for reattend here (photos are not
    // cycle-keyed yet).
    const assignments = assignmentFacts(base?.assignments || []);
    const report = base?.report || null;
    const pack = base?.report_pack || null;
    const detail = base?.makesafe_details || {};
    const portalCaptures = portalCapturesFromDetail(base);
    const hold = extras.holdsByJobId?.[base?.id] || null;
    const rawPhotoCount = Number(extras.photoCountByJobId?.[base?.id] || 0);
    const photoCount = photoCountForCurrentCycle(
      rawPhotoCount,
      detail,
      false, // no photo attendance_cycle_id write path yet → reattend fail-closed
    );
    const swmsRequired = base?.has_swms_doc === true || !!pack?.swms_doc_id ||
      (Array.isArray(base?.missing_docs) && base.missing_docs.includes("swms"));
    const declaredStage = String(base?.board_stage || "new").toLowerCase();
    const application = extras.statusApplicationsByJobId?.[base?.id] || null;
    const applicationApplies = !!application &&
      !isMakesafeTerminalDisplayStatus(declaredStage) &&
      !isMakesafeTerminalJobState(base?.status) &&
      String(application.source_status || "").toLowerCase() === declaredStage;
    const displayStage = applicationApplies
      ? String(application.after_status || declaredStage).toLowerCase()
      : declaredStage;
    // enrich already cycle-scopes pack/invoice closeout inputs on reattend.
    const invoiceStatus = rawInvoiceStatus(base);
    const packSent = base?.pack_sent === true;
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
        invoiceDate: base?.invoice_date || null,
        invoiceCreatedAt: base?.invoice_created_at || null,
        packSent,
        documents: {
          report: base?.has_report_doc === true,
          invoice: base?.has_invoice_doc === true,
          swms: base?.has_swms_doc === true,
        },
        swmsRequired,
        hold,
      },
      displayedStatus: displayStage,
      nowIso: computedAt,
    };
    const computation = computeMakesafeStatus(statusInput);
    const reportIn = reportInEvidence(statusInput);
    return {
      contract_version: MAKESAFE_BOARD_CONTRACT_VERSION,
      id: base?.id,
      job_number: base?.job_number || null,
      type: "makesafe",
      job_state: base?.status || null,
      substatus: base?.substatus || null,
      declared_stage: declaredStage,
      canonical_stage: displayStage,
      canonical_stage_label: applicationApplies
        ? OPS_MAKESAFE_STAGE_LABELS[displayStage as OpsMakesafeStage] ||
          displayStage
        : base?.board_label || null,
      status_application: applicationApplies
        ? {
          run_key: application.run_key,
          before_status: application.before_status,
          after_status: application.after_status,
          evidence_ref: application.evidence_ref,
          applied_by: application.applied_by,
          applied_at: application.applied_at,
        }
        : null,
      computed_status: computation.status,
      computed_status_reasons: computation.reasons,
      computed_status_missing: computation.missing,
      computed_status_at: computedAt,
      computed_status_hold: computation.hold,
      computed_status_job_type: computation.job_type,
      computed_status_evidence: {
        report_received_at: detail?.report_received_at || null,
        has_submitted_service_report: !!report &&
          ["submitted", "approved"].includes(
            String(report?.status || "").toLowerCase(),
          ),
        has_current_portal_capture:
          computation.job_type !== "physical_makesafe" &&
          reportIn.satisfied,
      },
      // U2-S1 additive spine keys (nullable-safe for pre-migration rows).
      attendance_cycle_id: base?.attendance_cycle_id ?? null,
      cycle_number: Number(
        base?.cycle_number || detail?.cycle_number || report?.cycle_number || 1,
      ),
      cycle_attribution_flags: Array.isArray(base?.cycle_attribution_flags)
        ? base.cycle_attribution_flags
        : [],
      readiness_revision: base?.readiness_revision ?? null,
      commercial_warning: base?.commercial_warning ?? null,
      makesafe_type: base?.metadata?.makesafe_job_family_label ||
        base?.metadata?.makesafe_job_family ||
        base?.makesafe_details?.report_type ||
        "Make-safe",
      builder: {
        name: base?.requesting_company_name || base?.requesting_company || null,
        external_ref: base?.external_ref || null,
      },
      contact: buildMakesafeContact(
        base,
        extras.contactsByJobId?.[base?.id] || [],
      ),
      assignments,
      report: {
        state: report?.status || base?.report_status ||
          "waiting_on_trade_report",
        submitted_at: report?.submitted_at || report?.created_at ||
          base?.makesafe_details?.report_received_at || null,
        photo_count: photoCount,
        cycle_number: Number(report?.cycle_number || base?.cycle_number || 1),
      },
      pack: {
        state: pack?.status || (base?.sent_to_builder ? "sent" : "not_started"),
        sent: packSent,
        sent_at: packSent
          ? (pack?.sent_at || base?.makesafe_details?.report_sent_at || null)
          : null,
        drafted: !!pack?.report_doc_id ||
          pack?.pre_xero_docs_ready === true ||
          ["drafted", "authorised_not_sent"].includes(
            String(pack?.status || ""),
          ),
        docket_revision_id: pack?.docket_revision_id || null,
        pre_xero_docs_ready: pack?.pre_xero_docs_ready === true,
        closeout_documents: {
          report: base?.has_report_doc === true,
          invoice: base?.has_invoice_doc === true,
          swms: base?.has_swms_doc === true,
        },
      },
      notes: noteFacts(extras.notesByJobId?.[base?.id] || []),
      lineage: lineageFacts(base, extras.intakeCaseByJobId?.[base?.id]),
      age: ageFacts(base),
      blockers: blockerFacts(base, assignments),
      cancelled: base?.board_stage === "cancelled"
        ? {
          reason: base?.cancel_reason || null,
          note: base?.cancel_note || null,
          by: base?.cancelled_by || null,
          at: base?.cancelled_at || null,
        }
        : null,
    };
  });

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

export function projectOpsMakesafeBoard(rows: any[]) {
  const columns: Record<string, any[]> = Object.fromEntries(
    OPS_MAKESAFE_STAGES.map((stage) => [stage, []]),
  );
  const unmapped: string[] = [];
  for (const row of rows || []) {
    const stage = String(row?.canonical_stage || "").toLowerCase();
    if ((OPS_MAKESAFE_STAGES as readonly string[]).includes(stage)) {
      columns[stage].push(row);
    } else {
      columns.new.push({
        ...row,
        projection_warning: `Unknown canonical stage: ${stage || "(blank)"}`,
      });
      if (row?.id) unmapped.push(row.id);
    }
  }
  return {
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
    column: mapped.column,
    canonical_stage: row?.canonical_stage,
    projection_warning: mapped.mapped
      ? null
      : `Unknown canonical stage: ${row?.canonical_stage || "(blank)"}`,
    job_state: row?.job_state,
    substatus: row?.substatus,
    builder: row?.builder,
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
  for (const r of ops.rows) {
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
