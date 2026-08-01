#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any
/**
 * SES P0 — read-only TWO-ENGINE STAGE PARITY HARNESS (scout artifact).
 *
 * Runs BOTH make-safe stage engines over the SAME production reads and emits a
 * per-card diff:
 *
 *   LEGACY   `_deriveMakesafeBoardStage` (ops-api/index.ts:13432) — the ladder
 *            that actually places every card on the rendered board today, via
 *            `enrichMakesafeBoardJob` -> `board_stage` -> read model
 *            `declared_stage` -> `canonical_stage` -> `projectOpsMakesafeBoard`.
 *
 *   M1       `computeMakesafeStatus` (makesafe_computed_status.ts:331) — the
 *            engine the evidence ruler, the C1/C2 measurements and the SES
 *            certificate grade against. index.ts:3553-3560 calls it "shadow".
 *
 * FAITHFULNESS: this harness does NOT reimplement either ladder. It imports the
 * real exported functions and re-feeds them the same rows ops-api's
 * `makesafePipeline` + `loadCanonicalMakesafeBoard` load, in the same order.
 * The only reimplemented code is the plumbing of `enrichMakesafeBoardJob`
 * (which is not exported) and `makesafePipeline`'s pack/docket overlay, both
 * transcribed line-for-line and marked << ENRICH >> / << PIPELINE >> below.
 *
 * Production safety:
 * - the only production access is the Supabase Management API `/database/query`
 *   endpoint with `read_only: true`, so the database itself refuses a write;
 * - `assertReadOnlySql` (imported from the committed C2 sweep) refuses any
 *   statement that is not a SELECT/WITH or that names a write verb;
 * - `assertNoPiiColumns` refuses any statement naming a client-identifying
 *   column. Nothing here selects a name, phone, email or street address.
 *
 * NO write, NO backfill, NO stage move, NO deploy.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read \
 *     --allow-write scripts/ses-stage-parity-harness.ts --out=/tmp/parity.json
 */

import {
  assertNoPiiColumns,
  assertReadOnlySql,
} from "./ses-c2-measure-board-evidence.ts";
import {
  describeSesBoardPopulation,
  SES_BOARD_POPULATION_CONTRACT_VERSION,
  sesBoardPopulationPredicate,
  sesBoardStatusPredicate,
} from "./ses-board-population-contract.ts";
import {
  buildCanonicalMakesafeRows,
  isSyntheticLivefireJob,
} from "../supabase/functions/ops-api/makesafe_board_read_model.ts";
import {
  currentCycleReportMap,
  filterHoldsForCurrentCycle,
  hasReattendBoundary,
  projectCycleScopedEvidence,
} from "../supabase/functions/ops-api/makesafe_cycle_evidence.ts";
import { isPackSentTriageEvent } from "../supabase/functions/ops-api/makesafe_send_pack.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

let queryCount = 0;

async function query<T = Record<string, any>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  queryCount++;
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN")?.trim();
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required");
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-Stage-Parity-Harness/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message = payload && typeof payload === "object" &&
        "message" in payload
      ? String((payload as any).message)
      : `HTTP ${response.status}`;
    throw new Error(`read-only query failed: ${message}`);
  }
  return payload as T[];
}

// ── Board population ────────────────────────────────────────────────────────
// The predicate is NOT written here. It comes from the named, versioned
// population contract (`ses-board-population-contract.ts`) so this harness and
// the C2 sweep measure the same denominator by construction and both record
// which one they used. That contract is a DEFAULT, not a ruling — Captain
// decision C.5 (407 active vs 440 including cancelled) is still open.
// `metadata` is projected key-by-key (never `select metadata`) so no client
// identifier can enter this process.
const BOARD_SQL = `
select
  j.id, j.job_number, j.type, j.status,
  j.created_at, j.updated_at, j.completed_at,
  j.metadata->>'makesafe_job_family' as m_family,
  j.metadata->>'makesafe_job_family_label' as m_family_label,
  j.metadata->>'insurance_job_type' as m_insurance_job_type,
  j.metadata->>'own_template_requested' as m_own_template,
  j.metadata->>'strata' as m_strata,
  j.metadata->>'report_delivery' as m_report_delivery,
  j.metadata->>'external_ref' as m_external_ref,
  j.metadata->'requesting_company'->>'slug' as m_rc_slug,
  j.metadata->'requesting_company'->>'name' as m_rc_name,
  j.metadata->>'builder_po_number' as m_builder_po,
  j.metadata->>'builder_work_order_number' as m_builder_wo,
  j.metadata->>'builder_claim_ref' as m_builder_claim,
  j.metadata->>'synthetic_livefire_marker' as m_synth,
  j.metadata->'combined_sibling' as m_combined_sibling
from jobs j
where ${sesBoardPopulationPredicate()}
order by j.created_at desc, j.id desc
`;

/** Board-scoped join, identical predicate to BOARD_SQL's population clause. */
function boardScoped(select: string, table: string, alias: string): string {
  return `
select ${select}
from ${table} ${alias}
join jobs j on j.id = ${alias}.job_id
where ${
    sesBoardPopulationPredicate({
      detailAlias: "d2",
      includeSyntheticExclusion: false,
    })
  }
`;
}

function groupBy<T extends { job_id?: string | null }>(
  rows: T[],
): Record<string, T[]> {
  const map: Record<string, T[]> = {};
  for (const row of rows) {
    const id = String(row.job_id || "");
    if (!id) continue;
    (map[id] ||= []).push(row);
  }
  return map;
}

// << PIPELINE >> index.ts:13325 — pack statuses meaning the pack went out.
const PACK_SENT_STATUSES = [
  "sent",
  "sent_marker_failed",
  "sent_not_closed",
  "close_failed",
];

// << ENRICH >> index.ts:13166
const hasActiveInvoice = (invoice: any) =>
  !!invoice &&
  !["VOIDED", "DELETED"].includes(String(invoice?.status || "").toUpperCase());

interface ParityCard {
  job_ref: string;
  job_id: string;
  job_status: string;
  substatus: string | null;
  company_slug: string | null;
  report_type: string | null;
  ses_family: string;
  /** LEGACY ladder output, pre-overlay (production `declared_stage`). */
  legacy_stage: string;
  /** LEGACY + captain overlay (production `canonical_stage` = the column). */
  legacy_canonical_stage: string;
  /** M1 exactly as production publishes it today (fed legacy's display stage). */
  m1_published: string;
  /** M1 standing alone: no displayedStatus short-circuit. */
  m1_pure: string;
  /** The column this card lands in AFTER a cutover (M1 + re-applied overlay). */
  post_cutover_stage: string;
  post_cutover_overlay_binds: boolean;
  m1_pure_reasons: string[];
  m1_pure_missing: string[];
  overlay: {
    present: boolean;
    binds_today: boolean;
    source_status: string | null;
    after_status: string | null;
    run_key: string | null;
    applied_at: string | null;
    duplicate_of_job_number: string | null;
  };
  /** Facts that let a reader see WHICH branch fired without re-reading a DB. */
  facts: {
    assignments: number;
    has_current_cycle_report: boolean;
    report_status: string | null;
    photo_count: number;
    invoice_status: string | null;
    pack_status: string | null;
    pack_review_state: string | null;
    pack_sent_marker: boolean;
    has_report_doc: boolean;
    has_invoice_doc: boolean;
    has_swms_doc: boolean;
    has_wo_doc: boolean;
    swms_required: boolean;
    report_sent_at: boolean;
    report_received_at: boolean;
    reattend: boolean;
    portal_verified_this_cycle: boolean;
    typed_link_roles: string[];
    done_capture_roles: string[];
  };
  /** Which branch of the legacy ladder actually returned `legacy_stage`. */
  legacy_branch: string;
  divergence_cause: string;
}

/**
 * Name the legacy branch that produced this stage. Mirrors the return order of
 * `_deriveMakesafeBoardStage` (index.ts:13443-13523) using the SAME surfacing
 * flags the function itself computed, so it is an attribution, not a re-derivation.
 */
function legacyBranchOf(
  stage: string,
  jobStatus: string,
  surf: any,
  invoiceDone: boolean,
  verifiedSent: boolean,
  missingCloseout: string[],
  hasSubmittedReport: boolean,
  hasAssignments: boolean,
  normalizedSub: string | null,
): string {
  const s = String(jobStatus || "").toLowerCase();
  if (s === "cancelled" || s === "canceled") return "13448 job cancelled";
  if (s === "archived") return "13451 jobs.status=archived";
  if (!surf.sentClosed && surf.resumeNotSent) {
    return "13496 resumeNotSent (authorised pack never sent)";
  }
  if (!surf.sentClosed && surf.readyForReview) {
    return "13498 readyForReview (rendered report doc + DRAFT invoice, or U4 pre-Xero docs ready)";
  }
  if (!surf.sentClosed && surf.tradeReportIn) {
    return "13500 tradeReportIn (substatus=admin_to_send_report, pack not drafted)";
  }
  if (invoiceDone) {
    if (!verifiedSent && missingCloseout.length > 0) {
      return `13517 close-out doc gate HOLDS in report_ready (missing ${
        missingCloseout.join("+")
      })`;
    }
    return stage === "completed"
      ? "13519 invoiceDone, gate satisfied, completed <7 days"
      : "13519 invoiceDone, gate satisfied, aged >7 days to archive";
  }
  if (hasSubmittedReport || s === "complete") {
    return hasSubmittedReport
      ? `13521 hasSubmittedReport fall-through (report row / report_received_at / substatus=${
        normalizedSub ?? "-"
      })`
      : "13521 jobs.status=complete fall-through";
  }
  if (hasAssignments) return "13522 allocated: assignment row exists";
  if (
    normalizedSub === "waiting_on_trade_report" ||
    normalizedSub === "company_contact_done"
  ) {
    return `13522 allocated: substatus=${normalizedSub} (no assignment row)`;
  }
  if (["scheduled", "in_progress"].includes(s)) {
    return `13522 allocated: jobs.status=${s} (no assignment row)`;
  }
  return "13523 default new";
}

async function run(): Promise<void> {
  const outPath = Deno.args.find((a) => a.startsWith("--out="))?.slice(6) ??
    "/tmp/ses-stage-parity.json";
  const computedAt = Deno.args.find((a) => a.startsWith("--now="))?.slice(6) ??
    new Date().toISOString();

  const board = await query(BOARD_SQL);
  console.error(`population: ${describeSesBoardPopulation()}`);
  console.error(`board cards: ${board.length}`);

  const [
    details,
    reports,
    invoices,
    documents,
    packs,
    packCycles,
    dockets,
    assignments,
    noteCandidates,
    statusApps,
    photos,
    holds,
  ] = await Promise.all([
    // makesafe_job_details + the company slug/name ops-api joins through
    // requesting_company_id.
    query(`
      select d.job_id, d.requesting_company_slug, d.requesting_company_name,
             c.slug as company_slug, c.name as company_name,
             d.external_ref, d.substatus, d.report_received_at, d.report_sent_at,
             d.invoice_ready_at, d.external_links, d.report_type, d.cycle_number,
             d.reattend_count, d.last_reattend_at, d.portal_verified_at,
             d.portal_verified_cycle, d.portal_verified_signal,
             d.cancel_reason, d.cancelled_at, d.computed_status,
             d.computed_status_at, d.attendance_cycle_id, d.cycle_attribution
      from makesafe_job_details d
      left join makesafe_companies c on c.id = d.requesting_company_id
      join jobs j on j.id = d.job_id
      where ${sesBoardStatusPredicate()}
    `),
    // ops-api order: .neq(status,'draft').order(submitted_at desc) then id asc.
    query(
      boardScoped(
        "r.job_id, r.id, r.status, r.submitted_at, r.created_at, r.cycle_number, r.attendance_cycle_id, r.cycle_attribution",
        "job_service_reports",
        "r",
      ) +
        " and r.status <> 'draft' order by r.submitted_at desc nulls first, r.id asc",
    ),
    // ops-api order: ACCREC, not VOIDED/DELETED, .order(invoice_date desc) then id asc.
    query(
      boardScoped(
        "x.job_id, x.id, x.status, x.invoice_type, x.invoice_number, x.total, x.invoice_date, x.created_at",
        "xero_invoices",
        "x",
      ) +
        " and x.invoice_type = 'ACCREC' and x.status not in ('VOIDED','DELETED') order by x.invoice_date desc nulls first, x.id asc",
    ),
    query(
      boardScoped(
        "dd.job_id, dd.id, dd.type, dd.file_name",
        "job_documents",
        "dd",
      ) +
        " order by dd.id asc",
    ),
    query(
      boardScoped(
        "p.job_id, p.id, p.pack_kind, p.status, p.review_state, p.report_doc_id, p.invoice_doc_id, p.swms_doc_id, p.sent_at, p.last_render_hash",
        "makesafe_report_packs",
        "p",
      ) + " order by p.id asc",
    ),
    query(
      boardScoped(
        "pc.job_id, pc.id, pc.pack_id, pc.attendance_cycle_id, pc.cycle_attribution",
        "makesafe_report_pack_cycles",
        "pc",
      ) + " order by pc.id asc",
    ),
    query(
      boardScoped(
        "dr.job_id, dr.id, dr.state, dr.pre_xero_docs_ready, dr.blockers, dr.current_attendance_cycle_id, dr.committed_at",
        "makesafe_docket_revisions_current",
        "dr",
      ) + " order by dr.id asc",
    ),
    query(
      boardScoped(
        "a.job_id, a.id, a.user_id, a.scheduled_date, a.start_time, a.status, a.role, a.crew_name, a.attendance_cycle_id, a.cycle_attribution",
        "job_assignments",
        "a",
      ) +
        " and a.status <> 'cancelled' order by a.scheduled_date asc nulls last, a.id asc",
    ),
    // Pack-sent triage markers. SQL is a strict SUPERSET filter (every phrase
    // isPackSentTriageEvent can match contains one of these tokens); the real
    // exported predicate is then applied in-process. Only the marker text is
    // read, and only a boolean per job survives into the output.
    query(
      boardScoped(
        "e.job_id, e.id, e.event_type, e.detail_json",
        "job_events",
        "e",
      ) +
        ` and e.event_type = 'note' and (
            lower(e.detail_json->>'text') like '%makesafe_pack_sent%'
            or lower(e.detail_json->>'text') like '%bundled%'
            or lower(e.detail_json->>'text') like '%covered%'
            or lower(e.detail_json->>'note') like '%makesafe_pack_sent%'
            or lower(e.detail_json->>'note') like '%bundled%'
            or lower(e.detail_json->>'note') like '%covered%'
          ) order by e.id asc`,
    ),
    // The board reads the CURRENT view, ordered applied_at desc, first per job.
    query(
      boardScoped(
        "s.job_id, s.id, s.run_key, s.source_status, s.before_status, s.after_status, s.evidence_ref, s.applied_by, s.applied_at, s.duplicate_of_job_id, s.duplicate_of_job_number, s.duplicate_rule",
        "makesafe_board_status_current",
        "s",
      ) + " order by s.applied_at desc nulls first, s.id asc",
    ),
    query(
      boardScoped("m.job_id, count(*) as photo_count", "job_media", "m") +
        " and m.type = 'photo' and m.phase = 'completion' group by m.job_id",
    ),
    query(
      boardScoped(
        "h.job_id, h.id, h.cycle_number, h.reason_code, h.note, h.held_by, h.created_at, h.lifted_at, h.attendance_cycle_id, h.cycle_attribution",
        "makesafe_status_holds",
        "h",
      ) + " order by h.created_at desc nulls first, h.id asc",
    ),
  ]);

  console.error(
    `rows: details=${details.length} reports=${reports.length} invoices=${invoices.length} ` +
      `documents=${documents.length} packs=${packs.length} pack_cycles=${packCycles.length} ` +
      `dockets=${dockets.length} assignments=${assignments.length} note_candidates=${noteCandidates.length} ` +
      `status_apps=${statusApps.length} photo_rows=${photos.length} holds=${holds.length}`,
  );

  const detailByJob: Record<string, any> = {};
  for (const row of details as any[]) {
    // ops-api reads `*, makesafe_companies:requesting_company_id(slug,name)`.
    detailByJob[String(row.job_id)] = {
      ...row,
      makesafe_companies: row.company_slug || row.company_name
        ? { slug: row.company_slug, name: row.company_name }
        : null,
    };
  }
  const assignmentsByJob = groupBy(assignments as any[]);
  const documentsByJob = groupBy(documents as any[]);
  const docketsByJob = groupBy(dockets as any[]);
  const notesByJob = groupBy(noteCandidates as any[]);
  const statusAppsByJob = groupBy(statusApps as any[]);
  const holdsByJobRaw = groupBy(holds as any[]);
  const photoCountByJobId: Record<string, number> = {};
  for (const row of photos as any[]) {
    photoCountByJobId[String(row.job_id)] = Number(row.photo_count || 0);
  }
  const packCyclesByPackId: Record<string, any[]> = {};
  for (const pc of packCycles as any[]) {
    (packCyclesByPackId[String(pc.pack_id)] ||= []).push(pc);
  }

  // << PIPELINE >> index.ts:14812 — currentCycleReportMap over the full report set.
  const cycleIdByJobId: Record<string, string | null> = {};
  for (const d of details as any[]) {
    cycleIdByJobId[String(d.job_id)] = d.attendance_cycle_id ?? null;
  }
  const reportMap = currentCycleReportMap(
    reports as any[],
    detailByJob,
    cycleIdByJobId,
  );
  // << PIPELINE >> index.ts:14813 — firstByJobId over invoice_date-desc order.
  const invoiceMap: Record<string, any> = {};
  for (const row of invoices as any[]) {
    const id = String(row.job_id || "");
    if (id && !invoiceMap[id]) invoiceMap[id] = row;
  }
  // << PIPELINE >> index.ts:14819-14823 — LAST main pack by id asc wins.
  const packMap: Record<string, any> = {};
  for (const p of packs as any[]) {
    if ((p.pack_kind || "main") === "main") packMap[String(p.job_id)] = p;
  }
  // << PIPELINE >> index.ts:14830 — firstByJobId over dockets.
  const docketMap: Record<string, any> = {};
  for (const [jobId, rows] of Object.entries(docketsByJob)) {
    docketMap[jobId] = rows[0];
  }
  // << PIPELINE >> index.ts:13785-13802 — buildPackSentMap.
  const packSentMap: Record<string, boolean> = {};
  for (const [jobId, rows] of Object.entries(notesByJob)) {
    if (rows.some((ev: any) => isPackSentTriageEvent(ev))) {
      packSentMap[jobId] = true;
    }
  }

  const opsModule = await import(
    new URL("../supabase/functions/ops-api/index.ts", import.meta.url).href
  );
  const deriveLegacy = opsModule._deriveMakesafeBoardStage as (
    ...args: any[]
  ) => string;
  const docBooleans = opsModule._makesafeDocBooleansForTest as (
    rows: any[],
  ) => any;
  const missingCloseoutDocs = opsModule._makesafeMissingCloseoutDocs as (
    ...args: any[]
  ) => string[];
  const isMlb = opsModule._isMakesafeMlbCompany as (d: any, j: any) => boolean;
  const isWestern = opsModule._isMakesafeWesternCompany as (
    d: any,
    j: any,
  ) => boolean;
  const sentToBuilder = opsModule._makesafeSentToBuilder as (
    packSent: boolean | undefined,
    pack: any,
  ) => boolean;
  const normalizeSub = opsModule._normalizeMakesafeSubstatus as (
    s: any,
  ) => string | null;

  const baseRows: any[] = [];
  const holdsByJobId: Record<string, any> = {};

  for (const jobRaw of board as any[]) {
    const jobId = String(jobRaw.id);
    // Rebuild the `metadata` shape the engines read, from the projected keys.
    const job = {
      id: jobRaw.id,
      job_number: jobRaw.job_number,
      type: jobRaw.type,
      status: jobRaw.status,
      created_at: jobRaw.created_at,
      updated_at: jobRaw.updated_at,
      completed_at: jobRaw.completed_at,
      metadata: {
        makesafe_job_family: jobRaw.m_family ?? null,
        makesafe_job_family_label: jobRaw.m_family_label ?? null,
        insurance_job_type: jobRaw.m_insurance_job_type ?? null,
        own_template_requested: jobRaw.m_own_template ?? null,
        strata: jobRaw.m_strata ?? null,
        report_delivery: jobRaw.m_report_delivery ?? null,
        external_ref: jobRaw.m_external_ref ?? null,
        requesting_company: (jobRaw.m_rc_slug || jobRaw.m_rc_name)
          ? { slug: jobRaw.m_rc_slug, name: jobRaw.m_rc_name }
          : null,
        builder_po_number: jobRaw.m_builder_po ?? null,
        builder_work_order_number: jobRaw.m_builder_wo ?? null,
        builder_claim_ref: jobRaw.m_builder_claim ?? null,
        synthetic_livefire_marker: jobRaw.m_synth ?? null,
        combined_sibling: jobRaw.m_combined_sibling ?? null,
      },
    };
    if (isSyntheticLivefireJob(job)) {
      // BOARD_SQL already excluded terminal synthetic cards.
    }
    const detail = detailByJob[jobId] || null;
    const docRows = documentsByJob[jobId] || [];
    const report = reportMap[jobId];
    const invoice = invoiceMap[jobId];
    const rowPack = packMap[jobId];
    const packSent = packSentMap[jobId] === true;

    // << PIPELINE >> index.ts:14882-14915 — pack/docket overlay for the board.
    const packCycle = rowPack?.id
      ? (packCyclesByPackId[String(rowPack.id)] || []).find((pc: any) =>
        String(pc?.attendance_cycle_id || "") ===
          String(detail?.attendance_cycle_id || "") &&
        pc?.cycle_attribution === "bound"
      )
      : null;
    const packIsCurrent = !!packCycle &&
      packCycle.cycle_attribution === "bound" &&
      String(packCycle.attendance_cycle_id || "") ===
        String(detail?.attendance_cycle_id || "");
    const docket = docketMap[jobId];
    const docketIsCurrent = !!docket &&
      String(docket.current_attendance_cycle_id || "") ===
        String(detail?.attendance_cycle_id || "");
    const legacyStatus = String(rowPack?.status || "").toLowerCase();
    const legacySent = PACK_SENT_STATUSES.includes(legacyStatus) ||
      legacyStatus === "authorised_not_sent";
    const packForBoard = docket && !legacySent
      ? {
        ...(rowPack || {}),
        status: rowPack?.status || "drafted",
        review_state: docket.pre_xero_docs_ready ? "READY" : "U4_BLOCKED",
        docket_revision_id: docket.id,
        pre_xero_docs_ready: docket.pre_xero_docs_ready === true,
        blockers: Array.isArray(docket.blockers) ? docket.blockers : [],
        cycle_attribution: docketIsCurrent ? "bound" : null,
      }
      : rowPack
      ? { ...rowPack, cycle_attribution: packIsCurrent ? "bound" : null }
      : null;

    // ── << ENRICH >> index.ts:13806-13973 (enrichMakesafeBoardJob) ───────────
    const docFlags = docBooleans(docRows);
    const scoped = projectCycleScopedEvidence({
      detail,
      reports: report ? [report] : [],
      assignments: assignmentsByJob[jobId] || [],
      docs: docRows,
      pack: packForBoard || null,
      packSent,
      packCycleBound: !hasReattendBoundary(detail) ||
        packForBoard?.cycle_attribution === "bound",
      attendanceCycleId: detail?.attendance_cycle_id ?? null,
    });
    const scopedAssignments = scoped.assignments;
    const scopedReport = scoped.serviceReport;
    const scopedPack = scoped.pack;
    const scopedPackSent = scoped.packSent;
    const invoiceForStage = scoped.allowCloseoutFromEvidence ? invoice : null;

    // THE LEGACY LADDER — the real exported function, unmodified.
    const boardStage = deriveLegacy(
      job,
      detail,
      scopedAssignments,
      scopedReport,
      invoiceForStage,
      computedAt,
      docFlags,
      scopedPackSent,
      scopedPack,
    );

    // Branch attribution uses the ladder's OWN inputs (index.ts:13452-13456).
    const ladderInvoiceDone = hasActiveInvoice(invoiceForStage) ||
      String(job?.status || "").toLowerCase() === "invoiced" ||
      normalizeSub(detail?.substatus) === "complete";
    const ladderHasSubmittedReport = !!scopedReport ||
      !!detail?.report_received_at ||
      normalizeSub(detail?.substatus) === "admin_to_send_report" ||
      normalizeSub(detail?.substatus) === "ready_to_invoice";
    const surf = (opsModule._deriveMakesafeSurfacing as any)(
      job,
      detail,
      scopedReport,
      invoiceForStage,
      docFlags,
      scopedPackSent,
      scopedPack,
    );

    let missingDocs: string[] = [];
    if (docFlags && scoped.allowCloseoutFromEvidence) {
      const invoiceDone = hasActiveInvoice(invoice) ||
        String(job?.status || "").toLowerCase() === "invoiced" ||
        normalizeSub(detail?.substatus) === "complete";
      if (invoiceDone) {
        missingDocs = missingCloseoutDocs(
          docFlags,
          isMlb(detail, job) || isWestern(detail, job),
          !!(detail?.report_type),
        );
      }
    }
    const invoiceAuthorised = scoped.allowCloseoutFromEvidence &&
      hasActiveInvoice(invoice) &&
      ["AUTHORISED", "SUBMITTED", "PAID"].includes(
        String(invoice?.status || "").toUpperCase(),
      );
    const verifiedSent = (scopedPackSent === true && invoiceAuthorised &&
      normalizeSub(detail?.substatus) === "complete") || surf.gateSoftenSent;
    // The ladder recomputes the gate from its OWN scoped invoice, so mirror it.
    const ladderMissingCloseout = ladderInvoiceDone && docFlags
      ? missingCloseoutDocs(
        docFlags,
        isMlb(detail, job) || isWestern(detail, job),
        !!(detail?.report_type),
      )
      : [];
    const ladderVerifiedSent = (scopedPackSent === true &&
      hasActiveInvoice(invoiceForStage) &&
      ["AUTHORISED", "SUBMITTED", "PAID"].includes(
        String(invoiceForStage?.status || "").toUpperCase(),
      ) && normalizeSub(detail?.substatus) === "complete") ||
      surf.gateSoftenSent;
    const legacyBranch = legacyBranchOf(
      boardStage,
      job.status,
      surf,
      ladderInvoiceDone,
      ladderVerifiedSent,
      ladderMissingCloseout,
      ladderHasSubmittedReport,
      scopedAssignments.length > 0,
      normalizeSub(detail?.substatus),
    );
    const hardMissing = missingDocs.length > 0 && !verifiedSent;
    const scopedDocFlags = {
      ...docFlags,
      has_report_doc: scoped.hasReportDoc || scoped.hasReportDocTyped,
    };

    const ageHours = Math.max(
      0,
      Math.round(
        (new Date(computedAt).getTime() -
          new Date(job.created_at).getTime()) / 3600000,
      ),
    );

    const base: any = {
      ...job,
      makesafe_details: detail,
      substatus: normalizeSub(detail?.substatus) || null,
      board_stage: boardStage,
      board_label: null,
      age_hours: Number.isFinite(ageHours) ? ageHours : 0,
      requesting_company_name: detail?.requesting_company_name ||
        detail?.makesafe_companies?.name ||
        job.metadata?.requesting_company?.name ||
        null,
      requesting_company_slug: detail?.requesting_company_slug ||
        detail?.makesafe_companies?.slug ||
        job.metadata?.requesting_company?.slug || null,
      external_ref: detail?.external_ref || job.metadata?.external_ref || null,
      reattend_count: Number(detail?.reattend_count || 0),
      cycle_number: scoped.cycle_number,
      attendance_cycle_id: scoped.attendance_cycle_id,
      cycle_attribution_flags: scoped.cycle_attribution_flags,
      readiness_revision: scoped.readiness_revision,
      commercial_warning: scoped.commercial_warning,
      assignments: scopedAssignments,
      invoice_raw_status: scoped.allowCloseoutFromEvidence
        ? (invoice?.status || null)
        : null,
      invoice_date: scoped.allowCloseoutFromEvidence
        ? (invoice?.invoice_date || null)
        : null,
      invoice_created_at: scoped.allowCloseoutFromEvidence
        ? (invoice?.created_at || null)
        : null,
      sent_to_builder: sentToBuilder(scopedPackSent, scopedPack),
      report: scopedReport
        ? {
          status: scopedReport.status || null,
          submitted_at: scopedReport.submitted_at || scopedReport.created_at ||
            null,
          created_at: scopedReport.created_at || null,
          cycle_number: scopedReport.cycle_number ?? scoped.cycle_number,
          attendance_cycle_id: scopedReport.attendance_cycle_id ??
            scoped.attendance_cycle_id,
        }
        : null,
      report_pack: scopedPack
        ? {
          status: scopedPack.status || null,
          report_doc_id: scopedPack.report_doc_id || null,
          invoice_doc_id: scopedPack.invoice_doc_id || null,
          swms_doc_id: scopedPack.swms_doc_id || null,
          review_state: scopedPack.review_state || null,
          sent_at: scopedPack.sent_at || null,
          docket_revision_id: scopedPack.docket_revision_id || null,
          pre_xero_docs_ready: scopedPack.pre_xero_docs_ready === true,
          blockers: scopedPack.blockers || [],
        }
        : null,
      ...scopedDocFlags,
      pack_sent: scopedPackSent === true,
      docs_missing: hardMissing,
      missing_docs: hardMissing ? missingDocs : undefined,
      _legacy_branch: legacyBranch,
    };
    baseRows.push(base);

    // << loadCanonicalMakesafeBoard >> index.ts:15279-15294 — hold selection.
    for (const hold of holdsByJobRaw[jobId] || []) {
      if (hold?.lifted_at) continue;
      const holdDetail = detail ||
        { cycle_number: scoped.cycle_number, reattend_count: 0 };
      if (
        filterHoldsForCurrentCycle(
          [hold],
          holdDetail,
          holdDetail.attendance_cycle_id,
        ) && !holdsByJobId[jobId]
      ) {
        holdsByJobId[jobId] = hold;
      }
    }
  }

  const statusApplicationsByJobId: Record<string, any> = {};
  for (const [jobId, rows] of Object.entries(statusAppsByJob)) {
    statusApplicationsByJobId[jobId] = rows[0];
  }

  // ── RUN A — production truth. Legacy places, overlay applies, M1 rides along
  //           fed the legacy display stage.
  const runA = buildCanonicalMakesafeRows(baseRows, {
    photoCountByJobId,
    holdsByJobId,
    statusApplicationsByJobId,
    computedAt,
  });

  // ── RUN B — M1 standing alone. Force declaredStage to a non-terminal sentinel
  //           and remove the overlay so computeMakesafeStatus never takes its
  //           displayedStatus short-circuit. Every other evidence input is
  //           byte-identical to RUN A.
  const runB = buildCanonicalMakesafeRows(
    baseRows.map((row) => ({ ...row, board_stage: "new" })),
    { photoCountByJobId, holdsByJobId, computedAt },
  );
  const m1PureById = new Map(runB.map((r: any) => [r.id, r]));

  // ── RUN C — the POST-CUTOVER board. Declared stage is M1's own derivation and
  //           the existing captain overlay ledger is re-applied on top, exactly
  //           as makesafe_board_read_model.ts:466-474 would do after a flip.
  //           `canonical_stage` here IS the column each card would land in.
  const runC = buildCanonicalMakesafeRows(
    baseRows.map((row) => ({
      ...row,
      board_stage: (m1PureById.get(row.id) as any)?.computed_status ?? "new",
    })),
    {
      photoCountByJobId,
      holdsByJobId,
      statusApplicationsByJobId,
      computedAt,
    },
  );
  const postCutoverById = new Map(runC.map((r: any) => [r.id, r]));

  const cards: ParityCard[] = [];
  for (const row of runA) {
    const pure: any = m1PureById.get(row.id);
    const base = baseRows.find((b) => b.id === row.id);
    const detail = base?.makesafe_details || {};
    const app = statusApplicationsByJobId[row.id] || null;
    const typedLinks = Array.isArray(detail?.external_links)
      ? detail.external_links
      : [];
    const doneRoles = typedLinks
      .filter((l: any) => String(l?.status || "").toLowerCase() === "done")
      .map((l: any) => String(l?.role || l?.kind || ""));
    cards.push({
      job_ref: row.job_number || row.id,
      job_id: row.id,
      job_status: String(base?.status || ""),
      substatus: row.substatus ?? null,
      company_slug: base?.requesting_company_slug ?? null,
      report_type: detail?.report_type ?? null,
      ses_family: row.ses_family,
      legacy_stage: row.declared_stage,
      legacy_canonical_stage: row.canonical_stage,
      m1_published: row.computed_status,
      m1_pure: pure?.computed_status ?? "UNVERIFIED",
      post_cutover_stage:
        (postCutoverById.get(row.id) as any)?.canonical_stage ??
          "UNVERIFIED",
      post_cutover_overlay_binds: !!(postCutoverById.get(row.id) as any)
        ?.status_application,
      m1_pure_reasons: pure?.computed_status_reasons ?? [],
      m1_pure_missing: pure?.computed_status_missing ?? [],
      overlay: {
        present: !!app,
        binds_today: !!row.status_application,
        source_status: app?.source_status ?? null,
        after_status: app?.after_status ?? null,
        run_key: app?.run_key ?? null,
        applied_at: app?.applied_at ?? null,
        duplicate_of_job_number: app?.duplicate_of_job_number ?? null,
      },
      facts: {
        assignments: (base?.assignments || []).length,
        has_current_cycle_report: !!base?.report,
        report_status: base?.report?.status ?? null,
        photo_count: row.report?.photo_count ?? 0,
        invoice_status: base?.invoice_raw_status ?? null,
        pack_status: base?.report_pack?.status ?? null,
        pack_review_state: base?.report_pack?.review_state ?? null,
        pack_sent_marker: base?.pack_sent === true,
        has_report_doc: base?.has_report_doc === true,
        has_invoice_doc: base?.has_invoice_doc === true,
        has_swms_doc: base?.has_swms_doc === true,
        has_wo_doc: base?.has_wo === true,
        swms_required: base?.has_swms_doc === true ||
          !!base?.report_pack?.swms_doc_id ||
          (Array.isArray(base?.missing_docs) &&
            base.missing_docs.includes("swms")),
        report_sent_at: !!detail?.report_sent_at,
        report_received_at: !!detail?.report_received_at,
        reattend: Number(detail?.reattend_count || 0) > 0,
        portal_verified_this_cycle: !!detail?.portal_verified_at &&
          Number(detail?.portal_verified_cycle) ===
            Number(detail?.cycle_number ?? 1),
        typed_link_roles: typedLinks.map((l: any) =>
          String(l?.role || l?.kind || "")
        ),
        done_capture_roles: doneRoles,
      },
      legacy_branch: base?._legacy_branch ?? "UNVERIFIED",
      divergence_cause: "",
    });
  }

  for (const card of cards) classify(card);

  const summary = summarise(cards);
  await Deno.writeTextFile(
    outPath,
    JSON.stringify(
      {
        generated_from: "management-api /database/query read_only:true",
        computed_at: computedAt,
        // The denominator this run measured. `board_cards` is meaningless
        // without it, and it is NOT yet "the whole board" — see C.5.
        population_contract_version: SES_BOARD_POPULATION_CONTRACT_VERSION,
        population_contract: describeSesBoardPopulation(),
        queries_issued: queryCount,
        board_cards: cards.length,
        summary,
        cards,
      },
      null,
      2,
    ),
  );
  console.error(JSON.stringify(summary, null, 2));
  console.error(
    `wrote ${outPath} (${cards.length} cards, ${queryCount} queries)`,
  );
}

/** Attribute the legacy→M1 move to the branch that actually caused it. */
function classify(card: ParityCard): void {
  const legacy = card.legacy_canonical_stage;
  const m1 = card.m1_pure;
  if (legacy === m1) {
    card.divergence_cause = "agree";
    return;
  }
  if (legacy === "report_ready" && m1 !== "report_ready") {
    const branch = card.legacy_branch;
    if (branch.startsWith("13517")) {
      card.divergence_cause =
        "legacy close-out DOC GATE holds an invoiced card in report_ready (index.ts:13514-13518); M1 has no doc gate at all - it needs a pack review_state READY/READY_TO_BUILD, and every production pack review_state is NULL";
    } else if (branch.startsWith("13521")) {
      card.divergence_cause =
        "legacy hasSubmittedReport FALL-THROUGH (index.ts:13453+13521: a report row, report_received_at, or substatus admin_to_send_report|ready_to_invoice is enough); M1 requires a submitted current-cycle service report AND >=5 completion photos, or a READY pack";
    } else if (branch.startsWith("13498")) {
      card.divergence_cause =
        "legacy readyForReview (rendered report doc + DRAFT invoice, index.ts:13498); M1 docsReady needs pack review_state READY/READY_TO_BUILD (NULL on all 68 production packs)";
    } else if (branch.startsWith("13496")) {
      card.divergence_cause =
        "legacy resumeNotSent (authorised-but-unsent pack, index.ts:13496); M1 has no resume branch";
    } else {
      card.divergence_cause =
        `legacy report_ready via ${branch}; M1 has no equivalent branch`;
    }
    return;
  }
  if (legacy !== "trade_report_in" && m1 === "trade_report_in") {
    card.divergence_cause =
      "M1 reportInEvidence satisfied (submitted current-cycle report + >=5 photos, or all typed portal captures done) while the legacy ladder scopes trade_report_in to substatus=admin_to_send_report only (index.ts:13415)";
    return;
  }
  if (legacy === "trade_report_in" && m1 !== "trade_report_in") {
    card.divergence_cause =
      "legacy trade_report_in from substatus=admin_to_send_report (index.ts:13415); M1 reportInEvidence not satisfied: " +
      (card.m1_pure_missing.join("; ") || "(no reason recorded)");
    return;
  }
  if (legacy === "archive" && m1 === "completed") {
    card.divergence_cause =
      "M1 early-returns `completed` for jobs.status complete/completed/closed (makesafe_computed_status.ts:391-399) and has NO 7-day rollover on that path; the legacy ladder ages the same card into archive (index.ts:13519)";
    return;
  }
  if (legacy === "completed" && m1 === "archive") {
    card.divergence_cause =
      "both engines closed the card but computed a different completion timestamp (index.ts:13219 makesafeCompletedAt vs makesafe_computed_status.ts:317 completedAt)";
    return;
  }
  if (
    (legacy === "completed" || legacy === "archive") &&
    !["completed", "archive"].includes(m1)
  ) {
    card.divergence_cause =
      "legacy invoiceDone short-circuit closes the card (index.ts:13454/13502: active invoice OR status=invoiced OR substatus=complete); M1 closeoutSatisfied additionally requires a durable SEND record";
    return;
  }
  if (
    !["completed", "archive"].includes(legacy) &&
    ["completed", "archive"].includes(m1)
  ) {
    card.divergence_cause =
      "M1 closeoutSatisfied (durable send + issued invoice) while the legacy ladder held the card earlier";
    return;
  }
  if (legacy === "allocated" && m1 === "new") {
    card.divergence_cause =
      "legacy allocated from substatus/job-status (waiting_on_trade_report|company_contact_done|scheduled|in_progress, index.ts:13522) with zero assignments; M1 allocated needs an assignment row or a portal link";
    return;
  }
  if (legacy === "new" && m1 === "allocated") {
    card.divergence_cause =
      "M1 allocated from a typed portal link on a non-physical family (makesafe_computed_status.ts:449-457); legacy has no portal-link branch";
    return;
  }
  card.divergence_cause = `unclassified: legacy ${legacy} vs M1 ${m1}`;
}

function summarise(cards: ParityCard[]) {
  const stages = [
    "new",
    "allocated",
    "trade_report_in",
    "report_ready",
    "completed",
    "archive",
    "cancelled",
  ];
  const legacyCounts: Record<string, number> = {};
  const m1Counts: Record<string, number> = {};
  const publishedCounts: Record<string, number> = {};
  const legacyPreOverlay: Record<string, number> = {};
  const postCutover: Record<string, number> = {};
  for (const s of stages) {
    legacyCounts[s] = 0;
    m1Counts[s] = 0;
    publishedCounts[s] = 0;
    legacyPreOverlay[s] = 0;
    postCutover[s] = 0;
  }
  const matrix: Record<string, number> = {};
  const causes: Record<string, number> = {};
  const branches: Record<string, number> = {};
  const cutoverMatrix: Record<string, number> = {};
  let cutoverChanged = 0;
  let changed = 0;
  for (const c of cards) {
    const b = c.legacy_branch.split(" ")[0];
    branches[b] = (branches[b] || 0) + 1;
    legacyCounts[c.legacy_canonical_stage] =
      (legacyCounts[c.legacy_canonical_stage] || 0) + 1;
    legacyPreOverlay[c.legacy_stage] = (legacyPreOverlay[c.legacy_stage] || 0) +
      1;
    m1Counts[c.m1_pure] = (m1Counts[c.m1_pure] || 0) + 1;
    postCutover[c.post_cutover_stage] =
      (postCutover[c.post_cutover_stage] || 0) +
      1;
    const ck = `${c.legacy_canonical_stage} -> ${c.post_cutover_stage}`;
    if (c.legacy_canonical_stage !== c.post_cutover_stage) {
      cutoverMatrix[ck] = (cutoverMatrix[ck] || 0) + 1;
      cutoverChanged++;
    }
    publishedCounts[c.m1_published] = (publishedCounts[c.m1_published] || 0) +
      1;
    const key = `${c.legacy_canonical_stage} -> ${c.m1_pure}`;
    matrix[key] = (matrix[key] || 0) + 1;
    if (c.legacy_canonical_stage !== c.m1_pure) {
      changed++;
      causes[c.divergence_cause] = (causes[c.divergence_cause] || 0) + 1;
    }
  }
  // Overlay re-binding: would each application still bind if M1 derived the stage?
  const overlays = cards.filter((c) => c.overlay.present);
  const unbind = overlays.filter((c) =>
    String(c.overlay.source_status || "").toLowerCase() !== c.m1_pure
  );
  const bindsToday = overlays.filter((c) => c.overlay.binds_today);
  return {
    total: cards.length,
    legacy_canonical_column_counts: legacyCounts,
    legacy_pre_overlay_counts: legacyPreOverlay,
    m1_pure_column_counts: m1Counts,
    m1_published_counts: publishedCounts,
    post_cutover_column_counts: postCutover,
    cards_changing_column_m1_pure_vs_legacy_canonical: changed,
    cards_changing_column_after_cutover_with_overlays_reapplied: cutoverChanged,
    cutover_transition_matrix: Object.fromEntries(
      Object.entries(cutoverMatrix).sort((a, b) => b[1] - a[1]),
    ),
    legacy_branch_histogram: Object.fromEntries(
      Object.entries(branches).sort((a, b) => b[1] - a[1]),
    ),
    transition_matrix: Object.fromEntries(
      Object.entries(matrix).sort((a, b) => b[1] - a[1]),
    ),
    divergence_causes: Object.fromEntries(
      Object.entries(causes).sort((a, b) => b[1] - a[1]),
    ),
    overlays_total: overlays.length,
    overlays_binding_today: bindsToday.length,
    overlays_that_would_unbind_under_m1: unbind.length,
    overlays_binding_today_that_would_unbind:
      bindsToday.filter((c) =>
        String(c.overlay.source_status || "").toLowerCase() !== c.m1_pure
      ).length,
  };
}

if (import.meta.main) {
  await run();
}
