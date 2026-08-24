// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCanonicalMakesafeRows,
  MAKESAFE_BOARD_CONTRACT_VERSION,
} from "./makesafe_board_read_model.ts";
import { assembleSesPackInspection } from "./ses_inspect_pack.ts";
import { SES_REQUIRED_DOCUMENTS_LIVE_SHAPES } from "./fixtures/ses_required_documents_live_shapes.ts";

const OUTPUT_HASH =
  "sha256:5555555555555555555555555555555555555555555555555555555555555555";

function boardRow(
  fixture: (typeof SES_REQUIRED_DOCUMENTS_LIVE_SHAPES)[number],
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

function inspectInput(
  fixture: (typeof SES_REQUIRED_DOCUMENTS_LIVE_SHAPES)[number],
) {
  return {
    job_id: `fixture-${fixture.name}`,
    job_number: String(fixture.board_card.job_number),
    required_document_card: fixture.inspect_classification,
    docket: {
      docket_revision_id: `docket-${fixture.name}`,
      output_content_hash: OUTPUT_HASH,
      invoice_obligation_revision_id: `obligation-${fixture.name}`,
      readiness_revision: OUTPUT_HASH,
      dependency_generation: 1,
    },
    xero_binding: null,
    local_invoice_proposal: null,
    docket_routes: [],
    release_send_progress: { kind: "none" as const },
    pack_row: {
      status: "drafted",
      report_doc_id: "report-doc",
      invoice_doc_id: "invoice-doc",
      swms_doc_id: "swms-doc",
      sent_at: null,
      send_started_at: null,
    },
    release_row: null,
    member_rows: [],
    route_rows: [],
    proof_rows: [],
    approval_rows: [],
    review_row: null,
    audit_rows: [],
  };
}

Deno.test("required-document addition versions the default board contract", () => {
  assertEquals(MAKESAFE_BOARD_CONTRACT_VERSION, "makesafe-board.v1.1");
});

for (const fixture of SES_REQUIRED_DOCUMENTS_LIVE_SHAPES) {
  Deno.test(`captured ${fixture.name} shape publishes one board/inspect map`, () => {
    const [card] = buildCanonicalMakesafeRows([boardRow(fixture)], {}, "card");
    assertExists(card.pack, fixture.name);
    assertEquals(
      card.pack.required_documents,
      fixture.expected,
      `${fixture.name} board map from ${fixture.captured_from}`,
    );

    const inspection = assembleSesPackInspection(inspectInput(fixture));
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
