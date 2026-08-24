// deno-lint-ignore-file no-import-prefix require-await
import {
  assertEquals,
  assertExists,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCanonicalMakesafeRows,
  MAKESAFE_BOARD_CONTRACT_VERSION,
} from "./makesafe_board_read_model.ts";
import { inspectSesPackAction } from "./ses_inspect_pack.ts";
import type { SesSupabaseClient } from "./ses_reporting_actions.ts";
import type { SesCockpitDocket } from "./ses_review_cockpit.ts";
import { SES_REQUIRED_DOCUMENTS_LIVE_SHAPES } from "./fixtures/ses_required_documents_live_shapes.ts";

const OUTPUT_HASH =
  "sha256:5555555555555555555555555555555555555555555555555555555555555555";

type TestFixture =
  & Omit<
    (typeof SES_REQUIRED_DOCUMENTS_LIVE_SHAPES)[number],
    "name"
  >
  & { name: string };

function boardRow(
  fixture: TestFixture,
) {
  return {
    id: `fixture-${fixture.name}`,
    job_number: fixture.board_card.job_number,
    type: "makesafe",
    status: "scheduled",
    board_stage: "new",
    board_label: "New",
    requesting_company_slug: fixture.board_card.requesting_company_slug,
    external_ref: fixture.board_card.external_ref,
    metadata: fixture.board_card.metadata,
    makesafe_details: {
      external_ref: fixture.board_card.external_ref,
      substatus: "company_contact_required",
      cycle_number: 1,
    },
    assignments: [],
  };
}

function inspectDocket(
  fixture: TestFixture,
): SesCockpitDocket {
  return {
    job_id: `fixture-${fixture.name}`,
    job_number: String(fixture.board_card.job_number),
    docket_revision_id: `docket-${fixture.name}`,
    docket_output_content_hash: OUTPUT_HASH,
    invoice_obligation_revision_id: `obligation-${fixture.name}`,
    readiness_revision: OUTPUT_HASH,
    dependency_generation: 1,
    attendance_cycle_ids: [],
    xero_binding: null,
    xero_invoice_pdf_available: false,
    local_invoice_proposal: null,
    work_order: null,
    family_evidence: {},
    swms: {},
    routes: [],
    caveats: [],
    crew_and_trade_visits: { assignments: [], visit_reports: [] },
    clean_input: {
      builder_key: fixture.inspect_classification.builder_key,
      family: fixture.inspect_classification.family,
    } as SesCockpitDocket["clean_input"],
    release_send_progress: { kind: "none" as const },
  } as unknown as SesCockpitDocket;
}

function inspectClient(): SesSupabaseClient {
  return {
    from(table: string) {
      const single = table === "makesafe_report_packs"
        ? {
          status: "drafted",
          report_doc_id: "report-doc",
          invoice_doc_id: "invoice-doc",
          swms_doc_id: "swms-doc",
          sent_at: null,
          send_started_at: null,
        }
        : null;
      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        order() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: single, error: null });
        },
        then(
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve({ data: [], error: null }).then(
            onFulfilled,
            onRejected,
          );
        },
      };
      return builder;
    },
  } as unknown as SesSupabaseClient;
}

Deno.test("required-document addition versions the default board contract", () => {
  assertEquals(MAKESAFE_BOARD_CONTRACT_VERSION, "makesafe-board.v1.2");
});

for (const fixture of SES_REQUIRED_DOCUMENTS_LIVE_SHAPES) {
  Deno.test(`captured ${fixture.name} shape publishes one board/inspect map`, async () => {
    const [card] = buildCanonicalMakesafeRows([boardRow(fixture)], {}, "card");
    assertExists(card.pack, fixture.name);
    assertEquals(card.pack.required_documents_resolved, true);
    assertEquals(
      card.pack.required_documents,
      fixture.expected,
      `${fixture.name} board map from ${fixture.captured_from}`,
    );

    const inspection = await inspectSesPackAction(
      inspectClient(),
      `fixture-${fixture.name}`,
      null,
      { loadDocket: async () => inspectDocket(fixture) },
    );
    assertEquals(inspection.required_documents_resolved, true);
    assertEquals(
      inspection.required_documents,
      fixture.expected,
      `${fixture.name} inspect map from ${fixture.captured_from}`,
    );
    assertEquals(
      inspection.required_documents,
      card.pack.required_documents,
      `${fixture.name} board/inspect parity`,
    );
    // The obligation map is additive; literal proof coordinates remain intact.
    assertEquals(inspection.pack.report_doc_id, "report-doc");
    assertEquals(inspection.pack.invoice_doc_id, "invoice-doc");
    assertEquals(inspection.pack.swms_doc_id, "swms-doc");
  });
}

Deno.test("unresolved matrix authority publishes unknown, never invented obligations", async () => {
  const unknownFixture = {
    ...SES_REQUIRED_DOCUMENTS_LIVE_SHAPES[0],
    name: "unknown" as const,
    board_card: {
      job_number: "SWMS-UNKNOWN",
      requesting_company_slug: "unresolved-builder",
      external_ref: "",
      metadata: { makesafe_job_family: "unknown" },
    },
    inspect_classification: { builder_key: "UNKNOWN", family: "unknown" },
  };
  const [card] = buildCanonicalMakesafeRows(
    [boardRow(unknownFixture)],
    {},
    "card",
  );
  assertEquals(card.pack.required_documents_resolved, false);
  assertEquals(card.pack.required_documents, null);
  assertMatch(
    card.pack.required_documents_unresolved_reason,
    /family_unknown|builder_open_class/,
  );

  const inspection = await inspectSesPackAction(
    inspectClient(),
    "fixture-unknown",
    null,
    { loadDocket: async () => inspectDocket(unknownFixture) },
  );
  assertEquals(inspection.required_documents_resolved, false);
  assertEquals(inspection.required_documents, null);
  assertMatch(
    inspection.required_documents_unresolved_reason || "",
    /family_unknown|builder_open_class/,
  );
});
