#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any
/**
 * SES Item 10 — the ZERO-WRITE shadow run of the rules-clean classifier.
 *
 * This is the dry-run mode the ticket requires. It answers, for every card in
 * the named board population: WOULD auto-authorisation have skipped the
 * Captain on this invoice, and if not, which named guard parked it?
 *
 * ── Why this does not call the real prepare/mint sequence ──────────────────
 *
 * `prepare_ses_invoice_obligation` PERSISTS. `prepareSesInvoiceObligationAction`
 * (ses_reporting_actions.ts) ends in `commit_ses_invoice_obligation_revision_v1`
 * and takes no dry_run parameter, so "prepare it and look at the result" is a
 * write to the obligation ledger, not a rehearsal. So this harness never
 * prepares anything. It classifies from the ALREADY-PERSISTED docket revision
 * instead, which is sound because `prepare` copies
 * `local_invoice_proposal.line_items` VERBATIM into the obligation lines — the
 * money this would authorise is already sitting on the docket.
 *
 * ── Production safety ─────────────────────────────────────────────────────
 *
 * The only production access is the Supabase Management API `/database/query`
 * with `read_only: true`, so the database itself refuses a write. On top of
 * that, `assertReadOnlySql` refuses any non-SELECT/WITH statement or one naming
 * a write verb before the request is sent, and `assertNoPiiColumns` refuses any
 * statement naming a client-identifying column. Nothing here selects a name,
 * phone, email or street address. No ops-api action is called at all, so no
 * write path is even reachable.
 *
 * NO write. NO mint. NO authorise. NO send. NO void. NO re-price.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read \
 *     scripts/ses-rules-clean-shadow.ts [--json out.json] [--limit N]
 */

import {
  classifySesInvoiceRulesClean,
  SES_RULES_CLEAN_CONTRACT_VERSION,
  SES_RULES_CLEAN_GUARDS,
  type SesRulesCleanEvidence,
  type SesRulesCleanPortalCapture,
  type SesRulesCleanVerdict,
} from "../supabase/functions/ops-api/makesafe_invoice_rules_clean.ts";
import {
  resolveSesInvoiceDuplicates,
  type SesInvoiceIndexRow,
} from "../supabase/functions/ops-api/makesafe_invoice_duplicate_resolver.ts";
import { composeInvoiceReferenceWithPo } from "../supabase/functions/ops-api/ses_invoice_reference_grain.ts";
import {
  isVoidStatus,
  resolveExistingInvoice,
} from "../supabase/functions/ops-api/makesafe_send_pack.ts";
import {
  describeSesBoardPopulation,
  SES_BOARD_POPULATION_CONTRACT_VERSION,
  sesBoardPopulationPredicate,
} from "./ses-board-population-contract.ts";
import {
  assertNoPiiColumns,
  assertReadOnlySql,
} from "./ses-c2-measure-board-evidence.ts";
import { buildSesMeasurementGeneration } from "./ses-measurement-generation.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

/**
 * Cards the brief names as untouchable. They are still CLASSIFIED (the run is
 * read-only, and Koondoola is the live proof that the duplicate guard has
 * eyes), but they are excluded by name from first-fire staging.
 */
export const SHADOW_NO_FIRST_FIRE_JOB_NUMBERS = new Set([
  "SWMS-261025", // Koondoola — the PO-blindness incident card
  "SWMS-26931", // Clarkson
  "SWMS-261018", // West Perth
  "SWMS-26845", // Queens Park
]);

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

let queryCount = 0;

async function query<T = Record<string, any>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  queryCount++;
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("SUPABASE_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-Item10-RulesClean-Shadow/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as any).message)
        : `HTTP ${response.status}`;
    throw new Error(`read-only query failed: ${message}`);
  }
  return payload as T[];
}

// ── Reads ─────────────────────────────────────────────────────────────────

const BOARD_SQL = `
select j.id, j.job_number, j.type, j.status
from jobs j
where ${sesBoardPopulationPredicate()}
order by j.created_at desc, j.id desc
`;

const DETAIL_SQL = `
select d.job_id, d.attendance_cycle_id, d.requesting_company_slug, d.substatus
from makesafe_job_details d
join jobs j on j.id = d.job_id
where ${sesBoardPopulationPredicate()}
`;

/** Latest committed docket revision per job, with its envelope facts. */
const DOCKET_SQL = `
select distinct on (r.job_id)
  r.job_id,
  r.id as revision_id,
  r.stage,
  r.state,
  r.blockers,
  r.attendance_cycle_ids,
  r.local_invoice_proposal,
  r.envelope->'pre_xero_docs_ready' as pre_xero_docs_ready,
  r.envelope->'v2'->'classification'->>'family' as family,
  r.envelope->'v2'->'classification'->>'builder_key' as builder_key,
  r.envelope->'v2'->'items'->'supporting_report_pdf'->>'state' as supporting_report_state
from makesafe_docket_revisions r
order by r.job_id, r.committed_at desc
`;

/**
 * The portal-capture half of the C3 evidence floor, for report-only families
 * whose report lives in the builder portal rather than in the pack. Rows are
 * read UNFILTERED and the classifier decides which one, if any, is evidence:
 * a caller that forgets a filter must park, not pass, so the qualification
 * rule may not live in this query string.
 *
 * `screenshot_content_hash` is SERVER-computed from the uploaded PNG, so a
 * `verified` row does attest the image bytes. Two documented facts stop that
 * from being sufficient on its own, and both are encoded as columns here:
 *
 *  - `captured_by` names what actually LOOKED at the page. The F7 in-repo
 *    observer writes under the same approved `capture_producer` contract name
 *    but covers the viewport with an opaque frame first, so its images are a
 *    synthetic observation card carrying no portal form fields at all.
 *  - `screenshot_content_hash = source_content_hash` is impossible for two
 *    different artifacts (PNG bytes vs normalised page text). Where they match,
 *    the caller-supplied page-text coordinate is corrupted, and the textual
 *    basis of the capture's `done` verdict cannot be re-verified.
 */
const PORTAL_CAPTURE_SQL = `
select
  p.id,
  p.job_id,
  p.attendance_cycle_id,
  p.role,
  p.status,
  p.capture_result,
  p.captured_by,
  p.capture_producer,
  p.captured_at,
  (p.screenshot_content_hash is not null) as has_screenshot,
  (p.screenshot_content_hash = p.source_content_hash) as page_text_hash_corrupted
from makesafe_portal_capture_revisions p
`;

/**
 * Independence provenance for the supporting report of that same revision.
 * `durable_curated_revision` plus a bind-time `report_input_hash` and an
 * expected raw sha is the independent-completeness shape; anything else is the
 * self-vouch class the two open readiness gaps live in.
 */
const REPORT_PROOF_SQL = `
with latest as (
  select distinct on (job_id) job_id, id as revision_id
  from makesafe_docket_revisions
  order by job_id, committed_at desc
)
select
  l.job_id,
  a.metadata->>'evidence_source' as evidence_source,
  a.metadata->>'source_kind' as source_kind,
  (a.metadata->>'report_input_hash' is not null) as has_report_input_hash,
  (a.metadata->>'expected_raw_sha256' is not null) as has_expected_raw_sha256
from latest l
join makesafe_docket_artifacts a
  on a.revision_id = l.revision_id and a.role = 'supporting_report_pdf'
`;

const OBLIGATION_SQL = `
select
  job_id, id as revision_id, state, pricing_disposition,
  proposal->'lines' as lines,
  proposal->'commercial_quantity_override' as commercial_quantity_override
from makesafe_invoice_obligation_revisions_current
`;

/** Purchase order per card, mirroring readCardPurchaseOrder's live-case rule. */
const PURCHASE_ORDER_SQL = `
select
  coalesce(c.job_id, c.target_job_id) as job_id,
  count(*) as live_cases,
  min(c.builder_po_canonical) as builder_po_canonical
from makesafe_intake_cases c
where c.state in ('confirmed_live_job', 'blocked_live_job')
  and coalesce(c.job_id, c.target_job_id) is not null
group by 1
`;

/**
 * The FULL live ACCREC estate. This is the family-A tier the indexed probe
 * cannot stand in for: it is the whole mirror, not a reference-bounded slice.
 */
const ACCREC_SQL = `
select
  id, job_id, xero_invoice_id, invoice_number, status, reference,
  invoice_type, invoice_obligation_revision_id, sub_total, total
from xero_invoices
where invoice_type = 'ACCREC'
`;

// ── Evidence assembly ─────────────────────────────────────────────────────

/**
 * PostgREST/Management API returns `numeric` as a string. A value that is not a
 * finite number stays absent rather than becoming 0, so the classifier reads it
 * as "no total" and parks instead of comparing an invented figure.
 */
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function indexBy<T>(rows: T[], key: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) map.set(key(row), row);
  return map;
}

export interface ShadowCardResult {
  job_id: string;
  job_number: string | null;
  builder_key: string | null;
  basis: string | null;
  /**
   * Which determination point this card was classified at. `pre_mint` asks
   * "may the skill mint and then auto-authorise?"; `authorise` asks "may this
   * already-minted DRAFT be advanced?" and excludes that one invoice from the
   * duplicate question. A card with exactly one DRAFT bound to its current
   * obligation is classified at `authorise`; every other card at `pre_mint`.
   */
  determination_point: "pre_mint" | "authorise";
  subject_invoice_number: string | null;
  verdict: SesRulesCleanVerdict;
}

export async function runShadow(limit: number | null): Promise<{
  results: ShadowCardResult[];
  accrec_rows: number;
  queries: number;
}> {
  const [
    board,
    details,
    dockets,
    reportProofs,
    captures,
    obligations,
    purchaseOrders,
    accrec,
  ] = await Promise.all([
    query(BOARD_SQL),
    query(DETAIL_SQL),
    query(DOCKET_SQL),
    query(REPORT_PROOF_SQL),
    query(PORTAL_CAPTURE_SQL),
    query(OBLIGATION_SQL),
    query(PURCHASE_ORDER_SQL),
    query<SesInvoiceIndexRow>(ACCREC_SQL),
  ]);

  const detailBy = indexBy(details, (row) => String(row.job_id));
  const docketBy = indexBy(dockets, (row) => String(row.job_id));
  const proofBy = indexBy(reportProofs, (row) => String(row.job_id));
  const captureBy = new Map<string, any[]>();
  for (const row of captures) {
    const key = String(row.job_id);
    const bucket = captureBy.get(key) ?? [];
    bucket.push(row);
    captureBy.set(key, bucket);
  }
  const obligationBy = indexBy(obligations, (row) => String(row.job_id));
  const poBy = indexBy(purchaseOrders, (row) => String(row.job_id));
  const liveAccrec = accrec.filter((row) => !isVoidStatus(row.status));

  const cards = limit ? board.slice(0, limit) : board;
  const results: ShadowCardResult[] = [];

  for (const card of cards) {
    const jobId = String(card.id);
    const docket = docketBy.get(jobId) ?? null;
    const proposal = docket?.local_invoice_proposal ?? null;
    const detail = detailBy.get(jobId) ?? null;
    const obligation = obligationBy.get(jobId) ?? null;
    const poRow = poBy.get(jobId) ?? null;

    // Compose the reference the mint would actually carry. `readCardPurchaseOrder`
    // returns null unless EXACTLY one live case exists, so mirror that here.
    const purchaseOrder = poRow && Number(poRow.live_cases) === 1
      ? poRow.builder_po_canonical
      : null;
    const composed = composeInvoiceReferenceWithPo(
      proposal?.builder_reference ?? null,
      purchaseOrder,
    );

    // The determination point. A card carrying exactly ONE live DRAFT bound to
    // its current obligation revision is classified as an authorise decision
    // about that draft; that one invoice, and nothing else, is excluded from
    // the duplicate question. Two such drafts is not a determination this
    // harness may make, so such a card stays pre_mint and its own drafts
    // correctly read as duplicates.
    const ownDrafts = obligation
      ? liveAccrec.filter((row) =>
        String(row.invoice_obligation_revision_id || "") ===
          String(obligation.revision_id) &&
        String(row.status || "").toUpperCase() === "DRAFT"
      )
      : [];
    const subject = ownDrafts.length === 1 ? ownDrafts[0] : null;
    const determinationPoint: "pre_mint" | "authorise" = subject
      ? "authorise"
      : "pre_mint";
    const obligationLinesReadable = Array.isArray(obligation?.lines);
    const pricedLines = subject && obligationLinesReadable
      ? obligation!.lines
      : null;
    const pricedLinesSource = subject && obligationLinesReadable
      ? "invoice_obligation_revision" as const
      : "docket_local_invoice_proposal" as const;
    const pricedLinesReadError = subject && !obligationLinesReadable
      ? "the bound obligation revision carries no readable line array, and the docket proposal is not the money this DRAFT would advance"
      : null;
    const excludedId = subject
      ? String(subject.xero_invoice_id || subject.id)
      : null;
    const keep = (row: SesInvoiceIndexRow) =>
      !excludedId || String(row.xero_invoice_id || row.id) !== excludedId;
    const probeRows = accrec.filter(keep);
    const scanRows = liveAccrec.filter(keep);

    // Family A: the indexed five-tier resolver, over the full live mirror.
    let duplicate = null;
    let duplicateError: string | null = null;
    try {
      [duplicate] = resolveSesInvoiceDuplicates([{
        job_id: jobId,
        external_ref: composed.reference || null,
        obligation_revision_id: obligation?.revision_id ?? null,
      }], probeRows);
    } catch (error) {
      duplicateError = error instanceof Error ? error.message : String(error);
    }

    // Family A4: the full live-ACCREC estate scan, the skill-side tier. This is
    // the same resolver `create_ses_invoice_draft` runs before any Xero create.
    let fullScan: { rows_scanned: number; matches: number } | null = null;
    let fullScanError: string | null = null;
    try {
      const match = resolveExistingInvoice(
        scanRows as any[],
        jobId,
        composed.reference || null,
      );
      fullScan = {
        rows_scanned: scanRows.length,
        matches: match ? 1 : 0,
      };
    } catch (error) {
      fullScanError = error instanceof Error ? error.message : String(error);
    }

    // Family C3: independent completeness proof for the report evidence.
    const proof = proofBy.get(jobId) ?? null;
    let reportIndependent: boolean | null = null;
    let portalCaptures: SesRulesCleanPortalCapture[] | null = null;
    // Which floor this card owes is STATED, never inferred from which evidence
    // field this harness happened to populate. No docket means no stated
    // floor, and an unstated floor parks.
    let reportEvidenceFloor:
      | "pack_supporting_report"
      | "portal_capture"
      | null = null;
    if (docket) {
      if (String(docket.supporting_report_state) === "not_applicable") {
        reportEvidenceFloor = "portal_capture";
        // Report-only family: the builder portal holds the report, so the
        // portal capture IS the evidence floor. Which capture -- if any -- is
        // evidence is the classifier's decision, not this harness's: every row
        // is handed over unfiltered, role and status and result included, and
        // it names the one it relied on.
        portalCaptures = (captureBy.get(jobId) ?? [])
          .map((row) => ({
            id: row.id,
            role: row.role,
            status: row.status,
            capture_result: row.capture_result,
            attendance_cycle_id: row.attendance_cycle_id,
            captured_by: row.captured_by,
            capture_producer: row.capture_producer,
            captured_at: row.captured_at,
            has_screenshot: row.has_screenshot === true,
            page_text_hash_corrupted: row.page_text_hash_corrupted === true,
          }));
      } else if (!proof) {
        reportEvidenceFloor = "pack_supporting_report";
        reportIndependent = null;
      } else {
        reportEvidenceFloor = "pack_supporting_report";
        reportIndependent =
          String(proof.source_kind) === "durable_curated_revision" &&
            proof.has_report_input_hash === true &&
            proof.has_expected_raw_sha256 === true
            ? true
            : false;
      }
    }

    const evidence: SesRulesCleanEvidence = {
      job_id: jobId,
      job_number: card.job_number ?? null,
      family: docket?.family ?? null,
      docket: docket
        ? {
          revision_id: String(docket.revision_id),
          job_id: String(docket.job_id),
          stage: docket.stage,
          state: docket.state,
          blockers: docket.blockers,
          pre_xero_docs_ready: docket.pre_xero_docs_ready,
          attendance_cycle_ids: docket.attendance_cycle_ids,
          local_invoice_proposal: proposal,
        }
        : null,
      current_attendance_cycle_id: detail?.attendance_cycle_id ?? null,
      composed_reference: composed.reference || null,
      duplicate,
      duplicate_read_error: duplicateError,
      full_accrec_scan: fullScan,
      full_accrec_scan_error: fullScanError,
      obligation: obligation
        ? {
          revision_id: String(obligation.revision_id),
          state: obligation.state,
          pricing_disposition: obligation.pricing_disposition,
        }
        : null,
      determination_point: determinationPoint,
      // At the authorise point the money under consideration is the bound
      // obligation's lines, not the docket's -- a Captain rate override lives
      // on the obligation and never touches the docket proposal. If that read
      // is not an array on a card that IS at the authorise point, the harness
      // must NOT quietly fall back to the docket: that would classify money
      // nobody is about to bill. It parks instead.
      priced_lines: pricedLines,
      priced_lines_source: pricedLinesSource,
      priced_lines_read_error: pricedLinesReadError,
      commercial_quantity_override: subject
        ? obligation?.commercial_quantity_override ?? null
        : null,
      report_evidence_independent: reportIndependent,
      report_evidence_floor: reportEvidenceFloor,
      portal_captures: portalCaptures,
      subject_invoice: subject
        ? {
          xero_invoice_id: subject.xero_invoice_id,
          invoice_number: subject.invoice_number,
          status: subject.status,
          invoice_obligation_revision_id:
            subject.invoice_obligation_revision_id,
          // The DRAFT's OWN money. This shadow can only read the local
          // mirror, which is written at the mint and cannot witness a later
          // edit made in Xero -- so it is stamped `local_mirror` and A6
          // correctly parks on it. A live call site must read the draft from
          // Xero itself and stamp `xero_api`; there is no shortcut here.
          sub_total: numeric((subject as any).sub_total),
          total: numeric((subject as any).total),
          totals_source: "local_mirror",
        }
        : null,
    };

    results.push({
      job_id: jobId,
      job_number: card.job_number ?? null,
      builder_key: docket?.builder_key ?? detail?.requesting_company_slug ??
        null,
      basis: proposal?.basis ?? null,
      determination_point: determinationPoint,
      subject_invoice_number: subject
        ? String(subject.invoice_number ?? "") || null
        : null,
      verdict: classifySesInvoiceRulesClean(evidence),
    });
  }

  return { results, accrec_rows: liveAccrec.length, queries: queryCount };
}

// ── Reporting ─────────────────────────────────────────────────────────────

function summarise(results: ShadowCardResult[]) {
  const byVerdict = new Map<string, number>();
  const byFirstGuard = new Map<string, number>();
  const byGuardStatus = new Map<
    string,
    { flagged: number; unevaluable: number }
  >();
  for (const guard of SES_RULES_CLEAN_GUARDS) {
    byGuardStatus.set(guard.id, { flagged: 0, unevaluable: 0 });
  }
  for (const result of results) {
    byVerdict.set(
      result.verdict.verdict,
      (byVerdict.get(result.verdict.verdict) ?? 0) + 1,
    );
    const first = result.verdict.parked_on[0];
    if (first) byFirstGuard.set(first, (byFirstGuard.get(first) ?? 0) + 1);
    for (const guard of result.verdict.guards) {
      if (guard.status === "clean") continue;
      const bucket = byGuardStatus.get(guard.id)!;
      if (guard.status === "flagged") bucket.flagged++;
      else bucket.unevaluable++;
    }
  }
  return { byVerdict, byFirstGuard, byGuardStatus };
}

if (import.meta.main) {
  const args = Deno.args;
  const jsonIndex = args.indexOf("--json");
  const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : null;
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : null;

  const snapshotAt = new Date().toISOString();
  console.log("SES Item 10 — rules-clean SHADOW RUN (zero writes)");
  console.log(`  classifier      ${SES_RULES_CLEAN_CONTRACT_VERSION}`);
  console.log(`  population      ${describeSesBoardPopulation()}`);
  console.log("");

  const { results, accrec_rows, queries } = await runShadow(limit);
  const { byVerdict, byFirstGuard, byGuardStatus } = summarise(results);

  console.log(`Cards classified: ${results.length}`);
  console.log(`Live ACCREC rows scanned per card: ${accrec_rows}`);
  console.log(`Read-only queries: ${queries}`);
  console.log("");
  console.log("Verdicts:");
  for (const [verdict, count] of [...byVerdict].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${verdict.padEnd(12)} ${count}`);
  }
  console.log("");
  console.log("First parking guard (the one the card would name):");
  for (const [guard, count] of [...byFirstGuard].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${guard.padEnd(42)} ${count}`);
  }
  console.log("");
  console.log("Per-guard non-clean counts (flagged / unevaluable):");
  for (const guard of SES_RULES_CLEAN_GUARDS) {
    const bucket = byGuardStatus.get(guard.id)!;
    if (bucket.flagged === 0 && bucket.unevaluable === 0) continue;
    console.log(
      `  ${guard.id.padEnd(42)} ${String(bucket.flagged).padStart(4)} / ${
        String(bucket.unevaluable).padStart(4)
      }`,
    );
  }

  const atAuthorise = results.filter((row) =>
    row.determination_point === "authorise"
  );
  console.log("");
  console.log(
    `Determination point: ${
      results.length - atAuthorise.length
    } pre_mint, ${atAuthorise.length} authorise (card carries exactly one own DRAFT).`,
  );

  const clean = results.filter((row) => row.verdict.verdict === "rules_clean");
  console.log("");
  console.log(`RULES-CLEAN cards (${clean.length}):`);
  for (const row of clean) {
    const excluded = row.job_number &&
      SHADOW_NO_FIRST_FIRE_JOB_NUMBERS.has(row.job_number);
    console.log(
      `  ${String(row.job_number).padEnd(14)} ${
        String(row.builder_key).padEnd(6)
      } ${row.determination_point.padEnd(10)} ${
        String(row.subject_invoice_number ?? "-").padEnd(10)
      } ${String(row.basis).padEnd(28)}${
        excluded ? "  [EXCLUDED FROM FIRST FIRE]" : ""
      }`,
    );
  }

  if (jsonPath) {
    // The committed artifact is the per-card VERDICT MANIFEST, not the full
    // guard prose: it is what a rerun must reproduce, and it stays small enough
    // to read in a diff. The generation id is content-derived, so an
    // independent rerun over unchanged state reproduces it exactly.
    const generation = await buildSesMeasurementGeneration({
      snapshotAt: snapshotAt,
      populationContractVersion: SES_BOARD_POPULATION_CONTRACT_VERSION,
      populationContract: describeSesBoardPopulation(),
      rulerContractVersion: SES_RULES_CLEAN_CONTRACT_VERSION,
      cardHashes: results.map((row) => ({
        job_id: row.job_id,
        input_hash: `${row.determination_point}|${row.verdict.verdict}|${
          row.verdict.parked_on.join(",")
        }`,
      })),
    });
    await Deno.writeTextFile(
      jsonPath,
      JSON.stringify(
        {
          generation,
          live_accrec_rows_scanned: accrec_rows,
          writes_performed: 0,
          cards: results.map((row) => ({
            job_number: row.job_number,
            builder_key: row.builder_key,
            basis: row.basis,
            determination_point: row.determination_point,
            verdict: row.verdict.verdict,
            parked_on: row.verdict.parked_on,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `\nWrote ${jsonPath} (generation ${
        generation.generation_id.slice(0, 16)
      })`,
    );
  }
}
