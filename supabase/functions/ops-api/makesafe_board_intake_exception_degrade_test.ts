// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
//
// Captain ruling 2026-08-01: the intake-exception panel may degrade, the board
// may not.
//
// Regression under proof: on 2026-08-01 a single post carrying two
// issue-bearing `email_events_raw` rows made `loadIntakeOperationalFacts` throw
// `intake source issue uniqueness violated`. That read shared the board's
// `Promise.all`, so `ops-api?action=makesafe_board` answered HTTP 500, ops.html
// fell back to the overlay-blind `makesafe_pipeline`, and every captain
// display-ledger transition — SWMS-261124's ruled ARCHIVE among them —
// disappeared from the live board while the board still looked healthy.
//
// Diagnosis: docs/evidence/ses-261124-archive-display-diagnosis-2026-08-01.md
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _loadIntakeExceptionProjectionForBoardForTest,
  _makesafeBoardActionForTest,
} from "./index.ts";
import {
  buildIntakeExceptionProjection,
  degradedIntakeExceptionProjection,
  loadIntakeExceptionProjection,
} from "./makesafe_intake_exception_cards.ts";

const GENERATED_AT = "2026-08-01T04:00:00.000Z";
const UNIQUENESS_ERROR =
  "intake source issue uniqueness violated for post post-double-issue";

/**
 * Compact PostgREST fixture: enough of the builder surface for the canonical
 * board loader and the intake-exception projection to run for real. Unknown
 * tables read as empty rather than throwing, so this stays a board test.
 */
function fixtureClient(rowsByTable: Record<string, any[]>) {
  function builder(table: string) {
    const rows = (rowsByTable[table] || []).slice();
    const predicates: Array<(row: any) => boolean> = [];
    const query: any = {
      select: () => query,
      eq: (column: string, value: any) => {
        predicates.push((row) => {
          if (column.includes(".")) {
            let cursor: any = row;
            for (const part of column.split(".")) cursor = cursor?.[part];
            return cursor === value;
          }
          return row?.[column] === value;
        });
        return query;
      },
      neq: (column: string, value: any) => {
        predicates.push((row) => row?.[column] !== value);
        return query;
      },
      not: (column: string, operator: string, value: string) => {
        if (operator === "in") {
          const excluded = value.slice(1, -1).split(",").map((item) =>
            item.replaceAll('"', "")
          );
          predicates.push((row) => !excluded.includes(String(row?.[column])));
        }
        return query;
      },
      is: () => query,
      gte: (column: string, value: any) => {
        predicates.push((row) => String(row?.[column] || "") >= String(value));
        return query;
      },
      lte: (column: string, value: any) => {
        predicates.push((row) => String(row?.[column] || "") <= String(value));
        return query;
      },
      in: (column: string, values: any[]) => {
        predicates.push((row) => values.includes(row?.[column]));
        return query;
      },
      order: () => query,
      limit: () => query,
      range: async (from: number, to: number) => ({
        data: rows.filter((row) => predicates.every((p) => p(row))).slice(
          from,
          to + 1,
        ),
        error: null,
      }),
      maybeSingle: async () => ({
        data: rows.filter((row) => predicates.every((p) => p(row)))[0] || null,
        error: null,
      }),
      then: (resolve: (v: any) => any) =>
        resolve({
          data: rows.filter((row) => predicates.every((p) => p(row))),
          error: null,
        }),
    };
    return query;
  }
  return {
    from: (table: string) => builder(table),
    rpc: async () => ({ data: [], error: null }),
  };
}

// A card shaped for the display-ledger regression: the legacy ladder derives
// report_ready from a qualifying DRAFT and the ruled overlay moves it to ARCHIVE.
const JOB_ID = "job-261124-fixture";
const ARCHIVED_BY_LEDGER = {
  jobs: [{
    id: JOB_ID,
    job_number: "SWMS-261124",
    type: "makesafe",
    status: "accepted",
    created_at: "2026-08-01T06:32:10.000Z",
    client_name: "Fixture Client",
    site_address: "1 Fixture Street",
    metadata: { makesafe_job_family: "general_makesafe" },
  }],
  makesafe_job_details: [{
    job_id: JOB_ID,
    substatus: "ready_to_invoice",
    requesting_company_slug: "bw",
    requesting_company_name: "Builderwest Pty Ltd",
    external_ref: "BWCWA-6648",
  }],
  xero_invoices: [{
    id: "invoice-261124-fixture",
    job_id: JOB_ID,
    invoice_number: "INV-0754",
    reference: "BWCWA-6648",
    status: "DRAFT",
    invoice_type: "ACCREC",
    invoice_date: "2026-08-01",
  }],
  makesafe_board_status_current: [{
    id: 48,
    run_key: `ses-historical:${JOB_ID}:archive`,
    job_id: JOB_ID,
    source_status: "report_ready",
    before_status: "report_ready",
    after_status: "archive",
    evidence_ref: "data/ses-shadow-adjudicate-v1/report.md#6.1",
    applied_by: "captain-ruling-2026-08-01",
    applied_at: "2026-08-01T06:34:36.989Z",
  }],
  // One post, two issue-bearing rows — the exact 2026-08-01 shape.
  email_events_raw: [
    {
      id: "event-quarantine",
      post_id: "post-double-issue",
      change_type: "intake_exception_lineage_quarantine",
      exclusion_reason: "lineage_quarantine",
      received_at: "2026-07-31T07:16:33.000Z",
      observed_at: "2026-07-31T00:11:06.000Z",
      org_id: "00000000-0000-0000-0000-000000000001",
      mailbox: "ses@secureworkswa.com.au",
      page_meta: null,
    },
    {
      id: "event-pdf-pending",
      post_id: "post-double-issue",
      change_type: "intake_deferred_pdf_extraction_pending",
      exclusion_reason: "pdf_extraction_pending",
      received_at: "2026-07-31T07:16:33.000Z",
      observed_at: "2026-07-31T21:20:02.000Z",
      org_id: "00000000-0000-0000-0000-000000000001",
      mailbox: "ses@secureworkswa.com.au",
      page_meta: null,
    },
  ],
};

Deno.test("board intake-exception read degrades to an empty projection carrying the alarm", async () => {
  const projection = await _loadIntakeExceptionProjectionForBoardForTest(
    {} as any,
    GENERATED_AT,
    async () => {
      throw new Error(UNIQUENESS_ERROR);
    },
  );
  assertEquals(projection.cards.length, 0);
  assertEquals(projection.source_alarms.length, 0);
  assertEquals(projection.summary.visible_actionable_cards, 0);
  assertEquals(projection.degraded?.reason, "projection_read_failed");
  assertEquals(projection.degraded?.failed_at, GENERATED_AT);
  // The original guard message is preserved verbatim: the uniqueness guard is
  // kept and becomes the alarm, it is not softened or swallowed.
  assertEquals(projection.degraded?.error, UNIQUENESS_ERROR);
});

Deno.test("a healthy board intake-exception read passes through with degraded null", async () => {
  const healthy = buildIntakeExceptionProjection({
    orgId: "fixture-org",
    generatedAt: GENERATED_AT,
    facts: [],
    cases: [],
    sources: [],
    sourceCorrections: [],
    sourceSupersessions: [],
    caseCorrections: [],
    companies: [],
    jobs: [],
    emails: [],
    attachments: [],
    excludedPostIds: [],
    refPrefixes: [],
  });
  // Explicitly null, never absent — an empty card list must be distinguishable
  // from an unreadable projection by every consumer.
  assertEquals(healthy.degraded, null);

  const passedThrough = await _loadIntakeExceptionProjectionForBoardForTest(
    {} as any,
    GENERATED_AT,
    async () => healthy,
  );
  assertEquals(passedThrough.degraded, null);
  assertEquals(passedThrough, healthy);
});

Deno.test("degraded projection is zeroed, not fabricated", () => {
  const degraded = degradedIntakeExceptionProjection({
    generatedAt: GENERATED_AT,
    error: new Error(UNIQUENESS_ERROR),
  });
  assertEquals(degraded.cards, []);
  assertEquals(degraded.dispositions, []);
  assertEquals(degraded.source_alarms, []);
  assertEquals(degraded.totals.cards, 0);
  assertEquals(degraded.totals.actionable_case_rows, 0);
  assertEquals(degraded.generated_at, GENERATED_AT);
  assertEquals(degraded.degraded?.error, UNIQUENESS_ERROR);
});

Deno.test("the dedicated intake-exception read still throws on the same failure", async () => {
  // Degrading is a BOARD concession. `makesafe_intake_exception_read` exists to
  // serve these cards, so an unreadable projection there must stay loud.
  await assertRejects(
    () =>
      loadIntakeExceptionProjection(
        fixtureClient(ARCHIVED_BY_LEDGER) as any,
        {
          orgId: "00000000-0000-0000-0000-000000000001",
          mailbox: "ses@secureworkswa.com.au",
          generatedAt: GENERATED_AT,
        },
      ),
    Error,
    "intake source issue uniqueness violated",
  );
});

Deno.test("makesafe_board serves the captain display ledger even when intake exceptions are unreadable", async () => {
  const response = await _makesafeBoardActionForTest(
    fixtureClient(ARCHIVED_BY_LEDGER) as any,
    "api_key",
    null,
    "ops",
    { generatedAt: GENERATED_AT },
  );
  // Before this change the same fixture threw out of the action's Promise.all
  // and the serve handler answered 500.
  assertEquals(response.status, 200);
  const body = await response.json();

  const card = Object.values(body.columns as Record<string, any[]>)
    .flat()
    .find((row: any) => row.job_number === "SWMS-261124");
  assert(card, "the ruled card must still be on the board");
  // The whole point: the derived stage is report_ready (Docs Ready), and the
  // captain's display-ledger overlay still moves it to archive.
  assertEquals(card.declared_stage, "report_ready");
  assertEquals(card.canonical_stage, "archive");
  assertEquals(body.columns.archive.length, 1);
  assertEquals(body.columns.report_ready.length, 0);

  // The panel is empty AND says why, so zero cards is never read as a clean intake.
  assertEquals(body.intake_exceptions.cards, []);
  assertEquals(
    body.intake_exceptions.degraded.reason,
    "projection_read_failed",
  );
  assertStringIncludes(
    body.intake_exceptions.degraded.error,
    "intake source issue uniqueness violated",
  );
});
