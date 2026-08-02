#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any
/**
 * Read-only measurement for the trade roof-report confirmation control
 * (captain ruling, 2026-08-02).
 *
 * Answers three questions against live production, without writing anything:
 *
 *   1. On how many roof cards does the one-question control appear?
 *   2. Of the roof cards that LOOK done by substatus with no verification
 *      behind them, how many does it appear on — and why is it absent on the
 *      rest?
 *   3. Which of those sit at `ready_to_invoice` specifically?
 *
 * It imports the SHIPPED predicate (`sesRoofConfirmationEligibility`) rather
 * than restating it, so the number it reports is the behaviour that ships.
 *
 * Production safety:
 * - the only production access is the Supabase Management API
 *   `/database/query` endpoint with `read_only: true`, so the database itself
 *   refuses a write;
 * - `assertReadOnlySql` refuses any statement that is not a SELECT/WITH or that
 *   names a write verb, before the request is sent;
 * - `assertNoPiiColumns` refuses any statement naming a client-identifying
 *   column.
 *
 * The artifact it writes carries job numbers, stages and reason codes only. No
 * client name, phone, email or street address, and no portal URL.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read \
 *     --allow-write scripts/ses-roof-trade-confirmation-measure.ts \
 *     --out=/tmp/roof-confirm.json
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
import { projectMakesafePortalCaptures } from "../supabase/functions/ops-api/makesafe_board_read_model.ts";
import {
  isSesConfirmingTradeAssignment,
  isSesRoofCard,
  isSesRoofConfirmationDeadCard,
  resolveSesRoofPortalUrl,
  sesRoofCompletionRecorded,
  sesRoofConfirmationEligibility,
} from "../supabase/functions/ops-api/ses_trade_portal_confirmation.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

/**
 * "Looks done by substatus." These are exactly the substatuses the portal
 * guard treats as report-complete, so a roof card sitting in one with no
 * portal evidence is claiming a completion nothing proves.
 */
const LOOKS_DONE_SUBSTATUSES = [
  "admin_to_send_report",
  "ready_to_invoice",
  "complete",
];

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
      "User-Agent": "SecureWorks-SES-Roof-Confirmation-Measure/1.0",
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

const BOARD_SQL = `
select
  j.id, j.job_number, j.status,
  j.metadata->>'makesafe_job_family' as makesafe_job_family,
  j.metadata->>'external_ref' as metadata_external_ref
from jobs j
where ${sesBoardPopulationPredicate()}
order by j.job_number
`;

const DETAIL_SQL = `
select
  d.job_id, d.report_type, d.external_ref, d.external_links,
  d.attendance_cycle_id, d.cycle_number, d.substatus,
  d.portal_verified_at, d.portal_verified_cycle, d.portal_verified_signal
from makesafe_job_details d
join jobs j on j.id = d.job_id
where ${sesBoardStatusPredicate()}
`;

const ASSIGNMENT_SQL = `
select a.id, a.job_id, a.status
from job_assignments a
join jobs j on j.id = a.job_id
where ${sesBoardStatusPredicate()}
`;

const LEDGER_SQL = `
select
  c.id, c.job_id, c.attendance_cycle_id, c.role, c.status,
  c.makesafe_fact_version, c.capture_result, c.source_url,
  c.source_content_hash, c.builder_reference, c.captured_at, c.captured_by,
  c.capture_producer, c.signal, c.screenshot_object_key,
  c.screenshot_media_type, c.screenshot_content_hash, c.screenshot_size_bytes
from makesafe_portal_capture_revisions c
join jobs j on j.id = c.job_id
where ${sesBoardStatusPredicate()}
`;

async function main() {
  const outPath = Deno.args.find((a) => a.startsWith("--out="))?.slice(6) ??
    "./ses-roof-trade-confirmation-measure.json";

  const [jobs, details, ledger, assignments] = await Promise.all([
    query(BOARD_SQL),
    query(DETAIL_SQL),
    query(LEDGER_SQL),
    query(ASSIGNMENT_SQL),
  ]);

  const detailByJobId = new Map(
    details.map((row) => [String(row.job_id), row]),
  );
  const ledgerByJobId = new Map<string, any[]>();
  for (const row of ledger) {
    const jobId = String(row.job_id);
    const rows = ledgerByJobId.get(jobId) || [];
    rows.push(row);
    ledgerByJobId.set(jobId, rows);
  }
  const assignmentsByJobId = new Map<string, any[]>();
  for (const row of assignments) {
    const jobId = String(row.job_id);
    const rows = assignmentsByJobId.get(jobId) || [];
    rows.push(row);
    assignmentsByJobId.set(jobId, rows);
  }

  const cards: any[] = [];
  for (const job of jobs) {
    const detail = detailByJobId.get(String(job.id)) || null;
    const card = {
      id: String(job.id),
      status: job.status,
      metadata: {
        makesafe_job_family: job.makesafe_job_family,
        external_ref: job.metadata_external_ref,
      },
      external_ref: job.metadata_external_ref,
      makesafe_details: detail,
    };
    const rows = ledgerByJobId.get(String(job.id)) || [];
    const captures = projectMakesafePortalCaptures(card, rows);
    const eligibility = sesRoofConfirmationEligibility(card, captures);
    const substatus = String(detail?.substatus || "").toLowerCase();

    // Every blocker, evaluated INDEPENDENTLY. `eligibility.reason` is the first
    // one hit, which is the right refusal message and the wrong thing to count
    // by: a card can be blocked several ways at once. Built from the same
    // exported primitives the shipped predicate uses.
    const jobAssignments = assignmentsByJobId.get(String(job.id)) || [];
    const liveAssignments = jobAssignments.filter(
      isSesConfirmingTradeAssignment,
    );
    const roofCard = isSesRoofCard(card);
    const link = roofCard
      ? resolveSesRoofPortalUrl(card)
      : { url: null, ambiguous: false };
    const blockers: string[] = [];
    if (!roofCard) blockers.push("not_a_roof_card");
    if (isSesRoofConfirmationDeadCard(card)) blockers.push("card_not_live");
    if (!String(detail?.attendance_cycle_id || "").trim()) {
      blockers.push("no_attendance_cycle");
    }
    if (!String(detail?.external_ref || card.external_ref || "").trim()) {
      blockers.push("no_builder_reference");
    }
    if (roofCard && link.ambiguous) blockers.push("ambiguous_portal_roof_link");
    if (roofCard && !link.ambiguous && !link.url) {
      blockers.push("no_portal_roof_link");
    }
    if (sesRoofCompletionRecorded(card, captures)) {
      blockers.push("already_confirmed");
    }
    // Not part of card eligibility — it is per viewer — but it decides whether
    // ANY trade can act. A card with no live assignment has nobody to tick it.
    if (!liveAssignments.length) blockers.push("no_assigned_trade");

    cards.push({
      job_number: job.job_number,
      job_status: job.status,
      substatus: substatus || null,
      family: job.makesafe_job_family || null,
      report_type: detail?.report_type || null,
      applicable: eligibility.applicable,
      confirmed: eligibility.confirmed,
      offered: eligibility.offered,
      reason: eligibility.reason,
      looks_done_by_substatus: LOOKS_DONE_SUBSTATUSES.includes(substatus),
      // Roof identity is the card's own, exactly as the shipped predicate reads
      // it. A card can be a roof card and still not be offered the control.
      roof_card: eligibility.reason !== "not_a_roof_card",
      blockers,
      assignments_total: jobAssignments.length,
      assignments_live: liveAssignments.length,
      // The number that actually matters: the control is offered on the card
      // AND somebody is on the job to tick it.
      confirmable_by_a_trade: eligibility.offered && liveAssignments.length > 0,
    });
  }

  const roof = cards.filter((card) => card.roof_card);
  // The named cohort: a LIVE roof card claiming completion through its
  // substatus with no completion evidence behind it. Dead cards are reported
  // separately rather than folded in — a closed card is not work this channel
  // is meant to unblock.
  const unverifiedLooksDone = roof.filter((card) =>
    card.looks_done_by_substatus && !card.confirmed &&
    card.reason !== "card_not_live"
  );
  const unverifiedLooksDoneDead = roof.filter((card) =>
    card.looks_done_by_substatus && !card.confirmed &&
    card.reason === "card_not_live"
  );
  const readyToInvoiceUnverified = unverifiedLooksDone.filter((card) =>
    card.substatus === "ready_to_invoice"
  );

  const tally = (rows: any[]) => {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.reason] = (counts[row.reason] || 0) + 1;
    return counts;
  };
  // Counts every blocker on every card, so a card blocked three ways is counted
  // in all three. These totals therefore exceed the card count, on purpose.
  const tallyBlockers = (rows: any[]) => {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      for (const blocker of row.blockers) {
        counts[blocker] = (counts[blocker] || 0) + 1;
      }
    }
    return counts;
  };

  const report = {
    measured_at: new Date().toISOString(),
    board_population: describeSesBoardPopulation(),
    board_population_contract_version: SES_BOARD_POPULATION_CONTRACT_VERSION,
    queries: queryCount,
    totals: {
      board_cards: cards.length,
      roof_cards: roof.length,
      roof_confirmed_already: roof.filter((card) => card.confirmed).length,
      roof_control_offered: roof.filter((card) => card.offered).length,
      roof_confirmable_by_a_trade:
        roof.filter((card) => card.confirmable_by_a_trade).length,
      roof_reasons: tally(roof),
      roof_blockers: tallyBlockers(roof),
    },
    unverified_looks_done_dead_cards: {
      count: unverifiedLooksDoneDead.length,
      job_numbers: unverifiedLooksDoneDead.map((card) => card.job_number),
    },
    unverified_looks_done: {
      count: unverifiedLooksDone.length,
      control_offered:
        unverifiedLooksDone.filter((card) => card.offered).length,
      confirmable_by_a_trade:
        unverifiedLooksDone.filter((card) => card.confirmable_by_a_trade)
          .length,
      reasons: tally(unverifiedLooksDone),
      // Independent blocker counts. A card blocked more than one way appears
      // under each blocker, so these totals exceed the card count on purpose.
      blockers: tallyBlockers(unverifiedLooksDone),
      blockers_on_not_offered: tallyBlockers(
        unverifiedLooksDone.filter((card) => !card.offered),
      ),
      cards: unverifiedLooksDone.map((card) => ({
        job_number: card.job_number,
        substatus: card.substatus,
        offered: card.offered,
        confirmable_by_a_trade: card.confirmable_by_a_trade,
        reason: card.reason,
        blockers: card.blockers,
        assignments_total: card.assignments_total,
        assignments_live: card.assignments_live,
      })),
    },
    ready_to_invoice_unverified: {
      count: readyToInvoiceUnverified.length,
      control_offered:
        readyToInvoiceUnverified.filter((card) => card.offered).length,
      job_numbers: readyToInvoiceUnverified.map((card) => card.job_number),
    },
  };

  Deno.writeTextFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.totals, null, 2));
  console.log(JSON.stringify(report.unverified_looks_done, null, 2));
  console.log(JSON.stringify(report.ready_to_invoice_unverified, null, 2));
  console.log(`wrote ${outPath} (${queryCount} queries)`);
}

if (import.meta.main) {
  await main();
}
