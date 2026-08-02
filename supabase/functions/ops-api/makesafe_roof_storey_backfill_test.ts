// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRoofStoreyBackfillRow,
  competingStoreySignals,
  matchedContext,
  type RoofStoreyBackfillRow,
  roofStoreyBackfillSourceText,
  summariseRoofStoreyBackfill,
} from "./makesafe_roof_storey_backfill.ts";

const NO_FLAGS = { hasPersistedDocket: false, hasInvoiceObligation: false };

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    job_number: "SWMS-000001",
    status: "processing",
    site_suburb: "Somewhere",
    notes: "Please attend and conduct a single storey roof report",
    metadata: {},
    scope_json: null,
    ses_money_sealed_at: "2026-07-27T13:39:58Z",
    ...overrides,
  };
}

const DETAIL = {
  job_id: "00000000-0000-4000-8000-000000000001",
  external_ref: "MLB-00001",
  report_type: "roof_report",
};

Deno.test("a priceable ordered storey becomes a write row carrying the builder's own words", () => {
  const row = buildRoofStoreyBackfillRow(job(), DETAIL, NO_FLAGS);
  assertEquals(row.disposition, "write");
  assertEquals(row.storeys, "single");
  assertEquals(row.fee_ex_gst, 250);
  assertEquals(row.fee_inc_gst, 275);
  assertEquals(row.matched_phrase, "single storey roof report");
  assertEquals(row.money_sealed, true);
  assertEquals(row.written, false);
});

// THE MOST IMPORTANT TEST IN THIS FILE. U4 resolves storeys through
// `structuredSourceFact`, which returns undefined when two roots disagree. So a
// card that already carries a storey signal must never be written by a bulk
// run: taking a card that prices today and making it stop pricing would be the
// worst possible outcome of a change meant to unblock money.
Deno.test("a card already carrying a storey signal is HELD, never written", () => {
  const withExisting = buildRoofStoreyBackfillRow(
    job({ metadata: { storeys: "double" } }),
    DETAIL,
    NO_FLAGS,
  );
  assertEquals(withExisting.disposition, "hold_competing_storey_signal");
  assertEquals(withExisting.existing_storeys_fact, "double");

  const withScopeSignal = buildRoofStoreyBackfillRow(
    job({ scope_json: { building: "two storey" } }),
    DETAIL,
    NO_FLAGS,
  );
  assertEquals(withScopeSignal.disposition, "hold_competing_storey_signal");
  assertEquals(withScopeSignal.competing_storey_signal_in, ["jobs.scope_json"]);

  const withDetailSignal = buildRoofStoreyBackfillRow(
    job(),
    { ...DETAIL, substatus: "single storey noted" },
    NO_FLAGS,
  );
  assertEquals(withDetailSignal.disposition, "hold_competing_storey_signal");

  // Held rows never appear in the write set at any setting.
  const summary = summariseRoofStoreyBackfill([
    withExisting,
    withScopeSignal,
    withDetailSignal,
  ]);
  assertEquals(summary.counts.write, 0);
  assertEquals(summary.write_candidates.length, 0);
  assertEquals(summary.held.length, 3);
});

// The instruction text is the SOURCE of the verdict, so it must not count as a
// competing signal against itself - otherwise every card holds and the preview
// is useless.
Deno.test("the instruction text the verdict came from is not treated as a competing signal", () => {
  assertEquals(
    competingStoreySignals(
      job({
        metadata: {
          builder_email_text_for_trade: "two storey roof report",
          makesafe_type: "single storey roof report",
        },
      }),
      DETAIL,
    ),
    [],
  );
});

Deno.test("three storey refuses, records no storey and no fee", () => {
  const row = buildRoofStoreyBackfillRow(
    job({ notes: "Please attend and conduct a three storey roof report" }),
    DETAIL,
    NO_FLAGS,
  );
  assertEquals(row.disposition, "refused_no_sealed_price");
  assertEquals(row.storeys, null);
  assertEquals(row.fee_ex_gst, null);
  assertEquals(summariseRoofStoreyBackfill([row]).counts.write, 0);
});

Deno.test("conflicting storeys refuse rather than choosing", () => {
  const row = buildRoofStoreyBackfillRow(
    job({
      notes: "single storey roof report, amended to two storey roof report",
    }),
    DETAIL,
    NO_FLAGS,
  );
  assertEquals(row.disposition, "refused_conflicting");
  assertEquals(row.storeys, null);
});

Deno.test("no storey named records nothing and keeps the card blocking", () => {
  const row = buildRoofStoreyBackfillRow(
    job({ notes: "Please attend and conduct a roof report" }),
    DETAIL,
    NO_FLAGS,
  );
  assertEquals(row.disposition, "no_fact");
  assertEquals(row.storeys, null);
});

// The canary. A storey describing the BUILDING is not the product ordered. If
// one of these ever appears in the write set, a looser matcher has been wired
// in and the run must not be trusted.
Deno.test("a storey describing the property is never a write candidate", () => {
  for (
    const notes of [
      "Request for single storey property. Please attend and conduct a roof report",
      "The dwelling is a two storey brick and tile. Roof report required.",
    ]
  ) {
    const row = buildRoofStoreyBackfillRow(job({ notes }), DETAIL, NO_FLAGS);
    assertEquals(row.disposition, "no_fact", notes);
    assertEquals(row.storeys, null, notes);
  }
});

Deno.test("terminal cards are excluded whatever their instruction says", () => {
  for (
    const status of ["completed", "archived", "cancelled", "invoiced", "lost"]
  ) {
    const row = buildRoofStoreyBackfillRow(job({ status }), DETAIL, NO_FLAGS);
    assertEquals(row.disposition, "excluded_terminal", status);
    assertEquals(row.storeys, null, status);
  }
});

Deno.test("cards whose state would move are named", () => {
  const withDocket = buildRoofStoreyBackfillRow(job(), DETAIL, {
    hasPersistedDocket: true,
    hasInvoiceObligation: false,
  });
  const summary = summariseRoofStoreyBackfill([withDocket]);
  assertEquals(summary.counts.write, 1);
  assertEquals(summary.state_moves.length, 1);
  assertEquals(
    summary.state_moves[0].reason,
    "the persisted docket revision would be superseded",
  );
});

Deno.test("the matched context shows the phrase in its surroundings", () => {
  const source =
    "Please attend the property and conduct a single storey roof report noting the cause of damage";
  const context = matchedContext(source, "single storey roof report");
  assertEquals(typeof context, "string");
  assertEquals(context!.includes("single storey roof report"), true);
  assertEquals(matchedContext(source, null), null);
});

Deno.test("the source text joins the instruction fields without fusing them", () => {
  const source = roofStoreyBackfillSourceText(job({
    notes: "single storey",
    metadata: { builder_email_text_for_trade: "roof report" },
  }));
  assertEquals(source, "single storey\nroof report");
  // ...and the newline means the two halves cannot form a phrase across fields.
  const row = buildRoofStoreyBackfillRow(
    job({
      notes: "single storey",
      metadata: { builder_email_text_for_trade: "roof report" },
    }),
    DETAIL,
    NO_FLAGS,
  );
  assertEquals(row.disposition, "no_fact");
});

Deno.test("the summary counts every disposition and splits single from double", () => {
  const rows: RoofStoreyBackfillRow[] = [
    buildRoofStoreyBackfillRow(job(), DETAIL, NO_FLAGS),
    buildRoofStoreyBackfillRow(
      job({ notes: "two storey roof report" }),
      DETAIL,
      NO_FLAGS,
    ),
    buildRoofStoreyBackfillRow(
      job({ notes: "three storey roof report" }),
      DETAIL,
      NO_FLAGS,
    ),
    buildRoofStoreyBackfillRow(job({ notes: "roof report" }), DETAIL, NO_FLAGS),
    buildRoofStoreyBackfillRow(job({ status: "completed" }), DETAIL, NO_FLAGS),
  ];
  const summary = summariseRoofStoreyBackfill(rows);
  assertEquals(summary.counts.total, 5);
  assertEquals(summary.counts.write, 2);
  assertEquals(summary.counts.write_single, 1);
  assertEquals(summary.counts.write_double, 1);
  assertEquals(summary.counts.refused_no_sealed_price, 1);
  assertEquals(summary.counts.no_fact, 1);
  assertEquals(summary.counts.excluded_terminal, 1);
});
