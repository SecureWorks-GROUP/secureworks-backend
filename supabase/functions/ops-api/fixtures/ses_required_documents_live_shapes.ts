import type {
  SesRequiredDocumentMap,
  SesRequiredDocumentsCard,
} from "../makesafe_document_truth.ts";

export interface SesRequiredDocumentsLiveShape {
  name:
    | "mlb_physical"
    | "ajbr_physical"
    | "roof"
    | "temporary_fence"
    | "assessment";
  captured_from: string;
  board_card: SesRequiredDocumentsCard & {
    metadata: { makesafe_job_family: string };
  };
  inspect_classification: SesRequiredDocumentsCard;
  inspect_artifact_truth: {
    required_documents: SesRequiredDocumentMap;
  };
  expected: SesRequiredDocumentMap;
}

/**
 * Sanitised board, docket-classification and artifact-truth slices copied from
 * read-only production payloads. These retain the real producer spellings (`general_makesafe`,
 * `temp_fence_makesafe`, `assessment_report_quote`) instead of normalising the
 * fixtures into values invented for this test.
 */
export const SES_REQUIRED_DOCUMENTS_LIVE_SHAPES:
  readonly SesRequiredDocumentsLiveShape[] = [
    {
      name: "mlb_physical",
      captured_from:
        "2026-08-21 board/inspect proof for SWMS-261056 plus scripts/ses-rules-clean-shadow-2026-08-06.json",
      board_card: {
        job_number: "SWMS-261056",
        requesting_company_slug: "mlb",
        external_ref: "MLB-MW-26956PO-56959",
        metadata: { makesafe_job_family: "general_makesafe" },
      },
      inspect_classification: {
        builder_key: "MLB",
        family: "physical_makesafe",
        pricing_disposition: "priced_from_canon",
      },
      inspect_artifact_truth: {
        required_documents: { report: true, invoice: true, swms: true },
      },
      expected: { report: true, invoice: true, swms: true },
    },
    {
      name: "ajbr_physical",
      captured_from:
        "data/ajs-two-card-remint-v1/A-docket-real.json (SWMS-261139 / AJBR-70554)",
      board_card: {
        job_number: "SWMS-261139",
        requesting_company_slug: "ajbr",
        external_ref: "AJBR-70554",
        metadata: { makesafe_job_family: "general_makesafe" },
      },
      inspect_classification: {
        builder_key: "AJBR",
        family: "physical_makesafe",
        pricing_disposition: "priced_from_canon",
      },
      inspect_artifact_truth: {
        required_documents: { report: true, invoice: true, swms: false },
      },
      expected: { report: true, invoice: true, swms: false },
    },
    {
      name: "roof",
      captured_from:
        "supabase/functions/ops-api/fixtures/ses_u4_swms_26980_live_snapshot.json",
      board_card: {
        job_number: "SWMS-26980",
        requesting_company_slug: "mlb",
        external_ref: "MLB-26567PO-56164",
        metadata: { makesafe_job_family: "roof_report" },
      },
      inspect_classification: {
        builder_key: "MLB",
        family: "ordinary_roof_portal",
        pricing_disposition: "priced_from_canon",
      },
      inspect_artifact_truth: {
        required_documents: { report: true, invoice: true, swms: false },
      },
      expected: { report: true, invoice: true, swms: false },
    },
    {
      name: "temporary_fence",
      captured_from:
        "scripts/board-fixes-round2-temp-fence.fixture.txt (AJBR 66933)",
      board_card: {
        job_number: "AJBR 66933",
        requesting_company_slug: "ajbr",
        external_ref: "AJBR-66933",
        metadata: { makesafe_job_family: "temp_fence_makesafe" },
      },
      inspect_classification: {
        builder_key: "AJBR",
        family: "temporary_fencing",
        pricing_disposition: "priced_from_canon",
      },
      inspect_artifact_truth: {
        required_documents: { report: true, invoice: true, swms: false },
      },
      expected: { report: true, invoice: true, swms: false },
    },
    {
      name: "assessment",
      captured_from:
        "docs/evidence/ses-f7-prime-portal-capture-dry-run-2026-08-02/dry-run.json (SWMS-26708)",
      board_card: {
        job_number: "SWMS-26708",
        requesting_company_slug: "mlb",
        external_ref: "",
        metadata: { makesafe_job_family: "assessment_report_quote" },
      },
      inspect_classification: {
        builder_key: "MLB",
        family: "assessment_quote",
        pricing_disposition: "priced_from_canon",
      },
      inspect_artifact_truth: {
        required_documents: { report: false, invoice: true, swms: false },
      },
      expected: { report: false, invoice: true, swms: false },
    },
  ];
