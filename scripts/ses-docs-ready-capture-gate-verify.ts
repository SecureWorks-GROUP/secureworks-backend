#!/usr/bin/env -S deno run --allow-env --allow-net
/**
 * Docs Ready capture gate — read-only production verification.
 *
 * Answers, from one live board read and nothing else:
 *   BEFORE  how many cards the declared ladder + display overlay put in Docs
 *           Ready — i.e. the column as it was before this gate existed;
 *   AFTER   how many survive the capture gate;
 *   WHY     per family, and per removed card, the exact captures it is short of.
 *
 * BEFORE is recoverable after deploy because the board still publishes
 * `declared_stage` beside `canonical_stage`, so this script gives the same
 * answer whether it runs before the gate ships or a month later. That is the
 * point: Ops re-verifies after this worker, and a proof that only works once is
 * not a proof.
 *
 * Read-only by construction: one authenticated GET, no write action reachable.
 * Prints suburb and job reference only — never client name, phone, email or
 * street address.
 *
 *   SW_SUPABASE_URL=... SW_API_KEY=... deno run --allow-env --allow-net \
 *     scripts/ses-docs-ready-capture-gate-verify.ts [--fields=card|full] [--json]
 */

type Row = Record<string, any>;

const DOCS_READY = "report_ready";

function arg(name: string, fallback: string): string {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const baseUrl = (Deno.env.get("SW_SUPABASE_URL") || "").replace(/\/+$/, "");
const apiKey = Deno.env.get("SW_API_KEY") || "";
if (!baseUrl || !apiKey) {
  console.error(
    "SW_SUPABASE_URL and SW_API_KEY are required (read-only board GET).",
  );
  Deno.exit(2);
}

const fields = arg("fields", "card");
// `column_scope=all` so a card the gate pushes out of Docs Ready is still
// counted wherever it landed, rather than looking deleted.
const url =
  `${baseUrl}/functions/v1/ops-api?action=makesafe_board&fields=${fields}&columns=all`;

const response = await fetch(url, { headers: { "x-api-key": apiKey } });
if (!response.ok) {
  // Per the board-truth rule: a non-200 from `makesafe_board` is an outage, not
  // an empty board. Never report a count from a failed read.
  console.error(
    `makesafe_board returned HTTP ${response.status} — board-truth outage, no count reported.`,
  );
  Deno.exit(1);
}
const board = await response.json();
const rows: Row[] = Object.values(board.columns || {}).flat() as Row[];

const stage = (row: Row) => String(row?.canonical_stage || "").toLowerCase();
const declared = (row: Row) => String(row?.declared_stage || "").toLowerCase();
const overlayInto = (row: Row) =>
  row?.status_application?.applies_to_display === true &&
  String(row.status_application.after_status || "").toLowerCase() ===
    DOCS_READY;

/** The column as the declared ladder + overlay alone would paint it. */
const before = rows.filter((r) => overlayInto(r) || declared(r) === DOCS_READY);
const after = rows.filter((r) => stage(r) === DOCS_READY);
const held = before.filter((r) => stage(r) !== DOCS_READY);

const gateOf = (row: Row) => row?.docs_ready_capture_gate || null;
const familyOf = (row: Row) => String(row?.ses_family || "unknown");

const byFamily = (list: Row[]) => {
  const counts: Record<string, number> = {};
  for (const row of list) {
    counts[familyOf(row)] = (counts[familyOf(row)] || 0) + 1;
  }
  return counts;
};

// A card the gate had no verdict on must never be counted as a removal, and
// must be visible: an unreadable ledger is the one shape that would quietly
// under-report this whole check.
const noVerdict = before.filter((r) => gateOf(r)?.satisfied === null);
const unreadable = noVerdict.filter((r) =>
  gateOf(r)?.reason === "portal_capture_evidence_unreadable"
);

const report = {
  generated_at: board.generated_at || null,
  fields: board.fields || fields,
  gate_deployed: rows.some((r) => gateOf(r) !== null),
  gate_version: gateOf(before[0] || {})?.version || null,
  docs_ready_before: before.length,
  docs_ready_after: after.length,
  removed: held.length,
  before_by_family: byFamily(before),
  after_by_family: byFamily(after),
  removed_by_family: byFamily(held),
  no_verdict_left_in_place: noVerdict.length,
  unreadable_capture_ledger: unreadable.length,
  removed_cards: held.map((row) => ({
    job_number: row.job_number || null,
    suburb: row.site_suburb || null,
    family: familyOf(row),
    declared_stage: declared(row),
    now_in: stage(row),
    missing: gateOf(row)?.missing ?? [],
  })),
};

if (Deno.args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`generated_at        ${report.generated_at}`);
  console.log(
    `gate deployed       ${report.gate_deployed} (${
      report.gate_version ?? "n/a"
    })`,
  );
  console.log(
    `Docs Ready BEFORE   ${report.docs_ready_before}  ${
      JSON.stringify(report.before_by_family)
    }`,
  );
  console.log(
    `Docs Ready AFTER    ${report.docs_ready_after}  ${
      JSON.stringify(report.after_by_family)
    }`,
  );
  console.log(
    `removed             ${report.removed}  ${
      JSON.stringify(report.removed_by_family)
    }`,
  );
  console.log(
    `left in place (no verdict)  ${report.no_verdict_left_in_place} (unreadable ledger: ${report.unreadable_capture_ledger})`,
  );
  for (const card of report.removed_cards) {
    console.log(
      `\n  ${card.job_number}  ${card.suburb}  [${card.family}]  ${card.declared_stage} -> ${card.now_in}`,
    );
    for (const missing of card.missing) console.log(`      - ${missing}`);
  }
}

if (unreadable.length > 0) {
  console.error(
    `\n${unreadable.length} card(s) had an unreadable capture ledger — counts above are incomplete.`,
  );
  Deno.exit(1);
}
