// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
//
// Captain ruling 2026-08-01: the intake-exception panel may degrade, the board
// may not.
//
// Regression under proof: on 2026-08-01 a single post carrying two
// issue-bearing `email_events_raw` rows made `loadIntakeOperationalFacts` throw.
// That read shared the board's
// `Promise.all`, so `ops-api?action=makesafe_board` answered HTTP 500, ops.html
// fell back to the overlay-blind `makesafe_pipeline`, and every captain
// display-ledger transition — SWMS-261124's ruled ARCHIVE among them —
// disappeared from the live board while the board still looked healthy.
//
// Diagnosis: docs/evidence/ses-261124-archive-display-diagnosis-2026-08-01.md
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _loadIntakeExceptionProjectionForBoardForTest,
  _makesafeBoardActionForTest,
  _makesafeIntakeExceptionReadActionForTest,
} from "./index.ts";
import {
  buildIntakeExceptionProjection,
  degradedIntakeExceptionProjection,
  loadIntakeExceptionProjection,
} from "./makesafe_intake_exception_cards.ts";

const GENERATED_AT = "2026-08-01T04:00:00.000Z";
const RECOVERY_GENERATED_AT = "2026-08-03T16:00:00.000Z";
const PROJECTION_ERROR = "intake source events page read failed: fixture";

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
      lt: (column: string, value: any) => {
        predicates.push((row) => String(row?.[column] || "") < String(value));
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

const RECOVERED_EXCEPTION = {
  makesafe_intake_cases: [{
    id: "case-recovered",
    org_id: "00000000-0000-0000-0000-000000000001",
    company_id: null,
    company_slug_raw: "mlb",
    external_ref_raw: "MLB-RR-59036",
    external_ref_canonical: null,
    builder_wo_canonical: null,
    builder_po_canonical: null,
    wo_po_identity_key: null,
    raw_identity_json: {
      builder_slug: "mlb",
      external_ref: "MLB-RR-59036",
      builder_wo: "MLB-RR-59036",
      builder_po: "PO-59002",
    },
    story_json: [],
    evidence_map: {},
    state: "exception",
    reason_code: "adapter_parse_failure",
    missing_fields: [],
    conflicting_fields: {},
    parent_case_id: null,
    parent_relation: null,
    target_relation: null,
    job_id: null,
    target_job_id: null,
    client_name: null,
    client_phone: null,
    client_email: null,
    site_address: null,
    site_suburb: "Perth",
    is_authoritative: false,
    last_decision_reason: "deterministic source_persist_failed case_insert",
    instruction_key: "mlb:po-59002",
    lineage_id: "lineage-recovered",
    blocked_reasons: [],
    field_provenance: {},
    received_at: "2026-08-03T04:07:07.000Z",
  }],
  makesafe_intake_case_sources: [
    {
      id: "binding-a",
      org_id: "00000000-0000-0000-0000-000000000001",
      case_id: "case-recovered",
      post_id: "transport-a",
      role: "primary",
      received_at: "2026-08-03T04:07:07.000Z",
      attachment_refs: [],
    },
    {
      id: "binding-b",
      org_id: "00000000-0000-0000-0000-000000000001",
      case_id: "case-recovered",
      post_id: "transport-b",
      role: "twin",
      received_at: "2026-08-03T04:07:07.000Z",
      attachment_refs: [],
    },
  ],
  email_events_raw: ["transport-a", "transport-b"].flatMap((postId) => [
    {
      id: `${postId}-pdf`,
      org_id: "00000000-0000-0000-0000-000000000001",
      mailbox: "ses@secureworkswa.com.au",
      post_id: postId,
      change_type: "intake_deferred_pdf_extraction_pending",
      exclusion_reason: "pdf_extraction_pending",
      received_at: "2026-08-03T04:07:07.000Z",
      observed_at: "2026-08-03T04:09:01.000Z",
      page_meta: null,
    },
    {
      id: `${postId}-cap`,
      org_id: "00000000-0000-0000-0000-000000000001",
      mailbox: "ses@secureworkswa.com.au",
      post_id: postId,
      change_type: "intake_deferred_scan_run_cap_deferred",
      exclusion_reason: "run_cap_deferred",
      received_at: "2026-08-03T04:07:07.000Z",
      observed_at: "2026-08-03T04:09:02.000Z",
      page_meta: null,
    },
    {
      id: `${postId}-persist`,
      org_id: "00000000-0000-0000-0000-000000000001",
      mailbox: "ses@secureworkswa.com.au",
      post_id: postId,
      change_type: "intake_exception_source_persist_failed",
      exclusion_reason: "source_persist_failed",
      received_at: "2026-08-03T04:07:07.000Z",
      observed_at: "2026-08-03T04:09:03.000Z",
      page_meta: null,
    },
  ]),
  emails: [{
    post_id: "transport-a",
    subject: "MLB-RR-59036 PO-59002",
    from_email: null,
    from_name: null,
    received_at: "2026-08-03T04:07:07.000Z",
  }],
  email_attachments: [],
  makesafe_companies: [],
  makesafe_job_details: [],
  jobs: [],
  makesafe_intake_drafts: [],
  makesafe_intake_hugo_notifications: [],
  po_communications: [],
  business_events: [],
};

function recoveredReadFixture() {
  const store = structuredClone(RECOVERED_EXCEPTION);
  return { store, client: fixtureClient(store) as any };
}

Deno.test("dedicated exception list renders one multi-source fallback card with every issue reason", async () => {
  const fixture = recoveredReadFixture();
  const response = await _makesafeIntakeExceptionReadActionForTest(
    fixture.client,
    "api_key",
    null,
    null,
    RECOVERY_GENERATED_AT,
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.cards.length, 1);
  assertEquals(body.cards[0].external_ref, "MLB-RR-59036");
  assertEquals(body.cards[0].builder_purchase_order, "PO-59002");
  assertEquals(body.cards[0].evidence_sources.length, 2);
  assertEquals(
    body.cards[0].evidence_sources.filter((source: any) =>
      source.subject === null
    ).length,
    1,
  );
  assertEquals(body.cards[0].source_issue_reasons, [
    {
      reason_code: "source_persist_failed",
      severity: "critical",
      source_count: 2,
    },
    { reason_code: "run_cap_deferred", severity: "warning", source_count: 2 },
    {
      reason_code: "pdf_extraction_pending",
      severity: "warning",
      source_count: 2,
    },
  ]);
  assertEquals({
    jobs: fixture.store.jobs,
    drafts: fixture.store.makesafe_intake_drafts,
    notifications: fixture.store.makesafe_intake_hugo_notifications,
    communications: fixture.store.po_communications,
    sends: fixture.store.business_events,
  }, {
    jobs: [],
    drafts: [],
    notifications: [],
    communications: [],
    sends: [],
  });
});

Deno.test("dedicated exception detail finds the same multi-source fallback card exactly once", async () => {
  const fixture = recoveredReadFixture();
  const response = await _makesafeIntakeExceptionReadActionForTest(
    fixture.client,
    "api_key",
    null,
    { caseId: "case-recovered" },
    RECOVERY_GENERATED_AT,
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.card.case_ids, ["case-recovered"]);
  assertEquals(body.card.evidence_sources.length, 2);
  assertEquals(body.card.display_reason_code, "source_persist_failed");
  assertEquals(
    body.card.blocker_sentence,
    "The authoritative case could not be stored; review the source-persistence failure before any job can be created.",
  );
  assertEquals(body.card.auto_create_job, false);
  assertEquals(body.card.auto_create_draft, false);
});

Deno.test("board intake-exception read degrades to an empty projection carrying the alarm", async () => {
  const projection = await _loadIntakeExceptionProjectionForBoardForTest(
    {} as any,
    GENERATED_AT,
    async () => {
      throw new Error(PROJECTION_ERROR);
    },
  );
  assertEquals(projection.cards.length, 0);
  assertEquals(projection.source_alarms.length, 0);
  assertEquals(projection.summary.visible_actionable_cards, 0);
  assertEquals(projection.degraded?.reason, "projection_read_failed");
  assertEquals(projection.degraded?.failed_at, GENERATED_AT);
  assertEquals(projection.degraded?.error, PROJECTION_ERROR);
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
    error: new Error(PROJECTION_ERROR),
  });
  assertEquals(degraded.cards, []);
  assertEquals(degraded.dispositions, []);
  assertEquals(degraded.source_alarms, []);
  assertEquals(degraded.totals.cards, 0);
  assertEquals(degraded.totals.actionable_case_rows, 0);
  assertEquals(degraded.generated_at, GENERATED_AT);
  assertEquals(degraded.degraded?.error, PROJECTION_ERROR);
});

Deno.test("the dedicated intake-exception read treats distinct reasons on one source as healthy", async () => {
  const projection = await loadIntakeExceptionProjection(
    fixtureClient(ARCHIVED_BY_LEDGER) as any,
    {
      orgId: "00000000-0000-0000-0000-000000000001",
      mailbox: "ses@secureworkswa.com.au",
      generatedAt: GENERATED_AT,
    },
  );
  assertEquals(projection.degraded, null);
  assertEquals(projection.source_alarms.length, 1);
  assertEquals(projection.source_alarms[0].source_issue_reasons, [
    {
      reason_code: "lineage_quarantine",
      severity: "critical",
      source_count: 1,
    },
    {
      reason_code: "pdf_extraction_pending",
      severity: "warning",
      source_count: 1,
    },
  ]);
});

Deno.test("makesafe_board serves the captain display ledger with a healthy multi-issue intake projection", async () => {
  const response = await _makesafeBoardActionForTest(
    fixtureClient(ARCHIVED_BY_LEDGER) as any,
    "api_key",
    null,
    "ops",
    { generatedAt: GENERATED_AT },
  );
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

  assertEquals(body.intake_exceptions.cards, []);
  assertEquals(body.intake_exceptions.source_alarms.length, 1);
  assertEquals(body.intake_exceptions.degraded, null);
});
