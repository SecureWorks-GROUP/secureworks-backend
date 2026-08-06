#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
// deno-lint-ignore-file no-explicit-any
/**
 * PO-suffix duplicate census — read-only production answer to the Captain's question after the
 * Koondoola double-bill (SWMS-261025, 2026-08-06):
 *
 *   "How many other cards on the live board have a reference that differs from an existing
 *    invoice's reference only by a PO suffix?"
 *
 * Each such card is a potential second invoice on already-billed work, so the count is the size of
 * the risk sitting in the approve queue.
 *
 * WHAT IS COUNTED
 * ---------------
 * For every board card, the reference it would MINT today is resolved from the same authorities the
 * runtime uses, best first, and the tier that supplied it is reported:
 *
 *   obligation   the current obligation revision's `proposal.reference` (what was or will be minted)
 *   docket       the current pre-Xero docket's `local_invoice_proposal.builder_reference`
 *   intake_case  the assembler chain: builder_wo_canonical, builder_po_canonical, external_ref_canonical
 *   detail       makesafe_job_details.external_ref
 *
 * That reference is then compared against every LIVE (non VOIDED/DELETED) ACCREC invoice using the
 * SHIPPED predicates — `workRefRelation` and `poIndeterminateSiblingBlocks`, imported, never
 * restated — and each pair is classified:
 *
 *   po_indeterminate   same claim base, exactly ONE side names a purchase order. THE ANSWER TO THE
 *                      QUESTION: these are the references that differ only by a PO suffix.
 *                      - blocking      the invoice is unattributed (job_id NULL) or is this card's
 *                                      own, so nothing rules out that it is already our money.
 *                                      NEWLY REFUSED by the fixed guard. Koondoola's shape.
 *                      - other_card    the invoice is already linked to a DIFFERENT job, so it is
 *                                      demonstrably another card's money. Still permitted.
 *                                      SWMS-26938 / MLB-24732PO-55712 is the live example.
 *   distinct_po        both sides name a purchase order and the two differ. The builder said these
 *                      are two jobs. Permitted, unchanged by the fix.
 *   same_work          identical PO evidence. Blocked before and after.
 *
 * The `po_indeterminate` + blocking set is exactly the set whose verdict CHANGED, and that is a
 * proof rather than a replica of the old code: before this fix `sameWorkRef` answered "different
 * work" for every one-sided pair, which filtered it out of the exact and substring tiers, and the
 * claim-base tier did not exist. So every one-sided pair was permitted at every reference tier, and
 * no other relation's verdict moved.
 *
 * BLIND SPOTS, stated because a figure without them is not a measurement
 * ---------------------------------------------------------------------
 * - A card whose reference resolves from `detail` or `intake_case` has no docket yet, so the
 *   reference it would actually mint may still change. Those rows are reported with their tier so a
 *   reader can discount them.
 * - Invoices are matched on reference text alone. An invoice that covers this work under a
 *   completely different reference is invisible here, and one that merely shares a claim base is
 *   counted even if the work is genuinely separate — that ambiguity IS the finding.
 * - `xero_invoices.job_id` is NULL on 179 live ACCREC rows (2026-08-06), which is what makes the
 *   blocking/other_card split possible at all. The seal refuses to repair that at write time
 *   (Captain 2026-08-01), so absent attribution is read as unknown, never as clearance.
 *
 * Production safety: the only production access is the Supabase Management API `/database/query`
 * endpoint with `read_only: true`. `assertReadOnlySql` refuses anything that is not a SELECT/WITH
 * before the request is sent, and `assertNoPiiColumns` refuses any statement naming a
 * client-identifying column. No write, no backfill.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=… deno run --allow-env --allow-net --allow-read \
 *     scripts/ses-po-suffix-duplicate-census.ts [--json] [--include-cancelled]
 */

import {
  isVoidStatus,
  poIndeterminateSiblingBlocks,
  splitRefPo,
  workRefRelation,
} from "../supabase/functions/ops-api/makesafe_send_pack.ts";
import {
  describeSesBoardPopulation,
  sesBoardMembershipPredicate,
  sesBoardStatusPredicate,
  sesBoardSyntheticExclusionPredicate,
} from "./ses-board-population-contract.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

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

const PII_COLUMNS = [
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "contact_phone",
  "contact_email",
];

export function assertReadOnlySql(sql: string): void {
  const normalized = sql.trim().toLowerCase();
  if (!/^(select|with)\b/.test(normalized)) {
    throw new Error(`refused non-SELECT statement: ${sql.slice(0, 80)}`);
  }
  for (const verb of WRITE_VERBS) {
    if (new RegExp(`(^|[^a-z_])${verb}(?![a-z_])`, "i").test(normalized)) {
      throw new Error(`refused statement naming write verb "${verb}"`);
    }
  }
}

export function assertNoPiiColumns(sql: string): void {
  const normalized = sql.toLowerCase();
  for (const column of PII_COLUMNS) {
    if (normalized.includes(column)) {
      throw new Error(`refused statement naming PII column "${column}"`);
    }
  }
}

async function query<T = Record<string, any>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN")?.trim();
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required");
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-po-suffix-duplicate-census/1.0",
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

export type ReferenceTier =
  | "obligation"
  | "docket"
  | "intake_case"
  | "detail"
  | "none";

interface CardRow {
  job_id: string;
  job_number: string | null;
  status: string | null;
  site_suburb: string | null;
  requesting_company_slug: string | null;
  detail_external_ref: string | null;
  case_wo: string | null;
  case_po: string | null;
  case_external_ref: string | null;
  docket_reference: string | null;
  obligation_reference: string | null;
  obligation_state: string | null;
}

interface InvoiceRow {
  invoice_number: string | null;
  reference: string | null;
  status: string | null;
  job_id: string | null;
  invoice_date: string | null;
}

/** The reference a card would mint today, and which authority supplied it. */
export function resolveCardReference(
  card: CardRow,
): { reference: string; tier: ReferenceTier } {
  const candidates: Array<[ReferenceTier, string | null]> = [
    ["obligation", card.obligation_reference],
    ["docket", card.docket_reference],
    ["intake_case", card.case_wo || card.case_po || card.case_external_ref],
    ["detail", card.detail_external_ref],
  ];
  for (const [tier, value] of candidates) {
    const reference = String(value ?? "").trim();
    if (reference) return { reference, tier };
  }
  return { reference: "", tier: "none" };
}

export type PairClass =
  | "po_indeterminate_blocking"
  | "po_indeterminate_other_card"
  | "distinct_po"
  | "same_work";

export function classifyPair(
  cardJobId: string,
  cardReference: string,
  invoice: InvoiceRow,
): PairClass | null {
  const relation = workRefRelation(cardReference, invoice.reference);
  if (relation === "unrelated") return null;
  if (relation === "distinct_po") return "distinct_po";
  if (relation === "same_work") return "same_work";
  return poIndeterminateSiblingBlocks(cardJobId, invoice.job_id)
    ? "po_indeterminate_blocking"
    : "po_indeterminate_other_card";
}

const ISSUED = new Set(["AUTHORISED", "SUBMITTED", "PAID"]);

async function main() {
  const json = Deno.args.includes("--json");
  const includeCancelled = Deno.args.includes("--include-cancelled");

  const statusClause = includeCancelled ? "true" : sesBoardStatusPredicate("j");
  const cardSql = `
select
  j.id as job_id,
  j.job_number,
  j.status,
  j.site_suburb,
  d.requesting_company_slug,
  d.external_ref as detail_external_ref,
  c.builder_wo_canonical as case_wo,
  c.builder_po_canonical as case_po,
  c.external_ref_canonical as case_external_ref,
  dk.local_invoice_proposal->>'builder_reference' as docket_reference,
  ob.proposal->>'reference' as obligation_reference,
  ob.state as obligation_state
from jobs j
left join makesafe_job_details d on d.job_id = j.id
left join lateral (
  select builder_wo_canonical, builder_po_canonical, external_ref_canonical
  from makesafe_intake_cases mc
  where (mc.job_id = j.id or mc.target_job_id = j.id)
    and mc.state in ('confirmed_live_job','blocked_live_job')
  limit 1
) c on true
left join lateral (
  select local_invoice_proposal
  from makesafe_docket_revisions mdr
  where mdr.job_id = j.id and mdr.stage = 'pre_xero'
  order by mdr.committed_at desc
  limit 1
) dk on true
left join lateral (
  select proposal, state
  from makesafe_invoice_obligation_revisions_current mo
  where mo.job_id = j.id
  order by mo.created_at desc
  limit 1
) ob on true
where ${statusClause}
  and ${sesBoardMembershipPredicate("j", "d2")}
  and ${sesBoardSyntheticExclusionPredicate("j")}
`;

  const invoiceSql = `
select invoice_number, reference, status, job_id, invoice_date
from xero_invoices
where invoice_type = 'ACCREC' and reference is not null and reference <> ''
`;

  const [cards, invoicesAll] = await Promise.all([
    query<CardRow>(cardSql),
    query<InvoiceRow>(invoiceSql),
  ]);
  const invoices = invoicesAll.filter((row) => !isVoidStatus(row.status));

  const findings: Array<Record<string, any>> = [];
  let noReference = 0;

  for (const card of cards) {
    const { reference, tier } = resolveCardReference(card);
    if (!reference) {
      noReference++;
      continue;
    }
    const pairs = invoices
      .map((invoice) => ({
        invoice,
        klass: classifyPair(card.job_id, reference, invoice),
      }))
      .filter((pair): pair is { invoice: InvoiceRow; klass: PairClass } =>
        pair.klass !== null
      );
    const indeterminate = pairs.filter((pair) =>
      pair.klass === "po_indeterminate_blocking" ||
      pair.klass === "po_indeterminate_other_card"
    );
    if (indeterminate.length === 0) continue;

    const blocking = indeterminate.filter((pair) =>
      pair.klass === "po_indeterminate_blocking"
    );
    // A card already blocked on OTHER evidence has no verdict change: `same_work` matched before the
    // fix too, and a live invoice on this very card blocks at the job_id tier regardless.
    const alreadyBlocked = pairs.some((pair) => pair.klass === "same_work") ||
      invoices.some((invoice) => invoice.job_id === card.job_id);
    findings.push({
      job_number: card.job_number,
      suburb: card.site_suburb,
      job_status: card.status,
      builder: card.requesting_company_slug,
      reference,
      reference_tier: tier,
      obligation_state: card.obligation_state,
      newly_refused: blocking.length > 0 && !alreadyBlocked,
      already_blocked_on_other_evidence: alreadyBlocked,
      blocking_siblings: blocking.map((pair) => ({
        invoice_number: pair.invoice.invoice_number,
        status: pair.invoice.status,
        reference: pair.invoice.reference,
        invoice_date: pair.invoice.invoice_date,
        issued: ISSUED.has(String(pair.invoice.status ?? "").toUpperCase()),
        attribution: pair.invoice.job_id ? "this_card" : "unattributed",
      })),
      other_card_siblings: indeterminate
        .filter((pair) => pair.klass === "po_indeterminate_other_card")
        .map((pair) => ({
          invoice_number: pair.invoice.invoice_number,
          status: pair.invoice.status,
          reference: pair.invoice.reference,
        })),
    });
  }

  const newlyRefused = findings.filter((row) => row.newly_refused);
  const withIssuedSibling = newlyRefused.filter((row) =>
    row.blocking_siblings.some((sibling: any) => sibling.issued)
  );
  const summary = {
    generated_at: new Date().toISOString(),
    population: describeSesBoardPopulation(),
    population_note: includeCancelled
      ? "OVERRIDDEN with --include-cancelled: cancelled/lost cards are INCLUDED"
      : "cancelled/lost cards are OUTSIDE this denominator",
    cards_measured: cards.length,
    cards_without_any_reference: noReference,
    live_accrec_invoices: invoices.length,
    live_accrec_unattributed: invoices.filter((row) => !row.job_id).length,
    cards_with_po_suffix_only_difference: findings.length,
    cards_newly_refused_by_the_fix: newlyRefused.length,
    cards_newly_refused_against_an_ISSUED_invoice: withIssuedSibling.length,
    cards_permitted_sibling_is_another_cards_money:
      findings.filter((row) =>
        !row.newly_refused && row.other_card_siblings.length > 0
      ).length,
  };

  if (json) {
    console.log(JSON.stringify({ summary, findings }, null, 2));
    return;
  }

  console.log("PO-suffix duplicate census");
  console.log("=".repeat(78));
  for (const [key, value] of Object.entries(summary)) {
    console.log(`  ${key.padEnd(48)} ${value}`);
  }
  console.log();
  console.log(
    "Cards whose reference differs from a live invoice only by a PO suffix:",
  );
  console.log("-".repeat(78));
  for (const row of findings) {
    const flag = row.newly_refused
      ? "REFUSED NOW"
      : row.already_blocked_on_other_evidence
      ? "already blocked"
      : "permitted";
    console.log(
      `  ${String(row.job_number).padEnd(14)} ${
        String(row.suburb ?? "").padEnd(18)
      } ` +
        `${String(row.reference).padEnd(22)} [${row.reference_tier}] ${flag}`,
    );
    for (const sibling of row.blocking_siblings) {
      console.log(
        `      blocks on ${sibling.invoice_number} ${sibling.status} ` +
          `${sibling.reference} (${sibling.attribution})`,
      );
    }
    for (const sibling of row.other_card_siblings) {
      console.log(
        `      permitted: ${sibling.invoice_number} ${sibling.status} ` +
          `${sibling.reference} belongs to another card`,
      );
    }
  }
  if (findings.length === 0) console.log("  (none)");
  console.log();
  console.log(
    `Claim bases seen on live invoices: ${
      new Set(
        invoices.map((row) => splitRefPo(row.reference).base).filter(Boolean),
      ).size
    }`,
  );
}

if (import.meta.main) {
  await main();
}
