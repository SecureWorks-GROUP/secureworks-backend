import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  matchingInvoiceRowForHit,
  normalizePostReleaseDisposition,
  sesInvoiceFamilyFromCardFacts,
  siblingLiveInvoiceMayYieldToSecondInvoice,
  siblingLiveInvoicesAllYieldToSecondInvoice,
} from "./ses_second_invoice_disposition.ts";

Deno.test("normalizePostReleaseDisposition accepts the sealed enums and spaced form", () => {
  assertEquals(
    normalizePostReleaseDisposition("second_invoice"),
    "second_invoice",
  );
  assertEquals(
    normalizePostReleaseDisposition("second invoice"),
    "second_invoice",
  );
  assertEquals(
    normalizePostReleaseDisposition("Second-Invoice"),
    "second_invoice",
  );
  assertEquals(
    normalizePostReleaseDisposition("combine_credit"),
    "combine_credit",
  );
  assertEquals(
    normalizePostReleaseDisposition("document_only"),
    "document_only",
  );
  assertEquals(normalizePostReleaseDisposition("hold_pricing"), "hold_pricing");
  assertEquals(normalizePostReleaseDisposition("not_a_disposition"), null);
  assertEquals(normalizePostReleaseDisposition(""), null);
  assertEquals(normalizePostReleaseDisposition(null), null);
});

Deno.test("sesInvoiceFamilyFromCardFacts uses report_type when family is blank", () => {
  assertEquals(
    sesInvoiceFamilyFromCardFacts({
      makesafe_job_family: "physical_makesafe",
    }),
    "physical_makesafe",
  );
  assertEquals(
    sesInvoiceFamilyFromCardFacts({
      report_type: "assessment_report",
    }),
    "assessment_quote",
  );
  // Live Myalup stamps 2026-08-20: MS general_makesafe, assess assessment_report_quote.
  assertEquals(
    sesInvoiceFamilyFromCardFacts({
      makesafe_job_family: "general_makesafe",
    }),
    "physical_makesafe",
  );
  assertEquals(
    sesInvoiceFamilyFromCardFacts({
      makesafe_job_family: "assessment_report_quote",
      report_type: "assessment_report",
    }),
    "assessment_quote",
  );
  // Live Lake Preston stamps 2026-08-21: MS general_makesafe, assess
  // assessment_report_quote, roof roof_report. Same canonicalisation as Myalup.
  assertEquals(
    sesInvoiceFamilyFromCardFacts({
      makesafe_job_family: "roof_report",
    }),
    "ordinary_roof_portal",
  );
  assertEquals(
    sesInvoiceFamilyFromCardFacts({}),
    "unknown",
  );
});

Deno.test("siblingLiveInvoiceMayYieldToSecondInvoice is same-card and unknown-family closed", () => {
  const ms = "d4653440-6e9e-4451-858a-c30fd52336ba";
  const assess = "a146802e-2db5-4fac-94ed-24fff1d42353";
  assertEquals(
    siblingLiveInvoiceMayYieldToSecondInvoice({
      ourJobId: ms,
      invoiceJobId: assess,
      ourFamily: "physical_makesafe",
      invoiceFamily: "assessment_quote",
    }),
    true,
  );
  assertEquals(
    siblingLiveInvoiceMayYieldToSecondInvoice({
      ourJobId: ms,
      invoiceJobId: ms,
      ourFamily: "physical_makesafe",
      invoiceFamily: "assessment_quote",
    }),
    false,
  );
  assertEquals(
    siblingLiveInvoiceMayYieldToSecondInvoice({
      ourJobId: ms,
      invoiceJobId: assess,
      ourFamily: "physical_makesafe",
      invoiceFamily: "physical_makesafe",
    }),
    false,
  );
  assertEquals(
    siblingLiveInvoiceMayYieldToSecondInvoice({
      ourJobId: ms,
      invoiceJobId: assess,
      ourFamily: "physical_makesafe",
      invoiceFamily: "unknown",
    }),
    false,
  );
  assertEquals(
    siblingLiveInvoiceMayYieldToSecondInvoice({
      ourJobId: ms,
      invoiceJobId: null,
      ourFamily: "physical_makesafe",
      invoiceFamily: "assessment_quote",
    }),
    false,
  );
});

Deno.test("Lake Preston family pair yields physical vs assessment and vs roof", () => {
  const ms = "a4f2f7b5-aa02-430c-b648-ee6872bbf883";
  const assess = "1caa4531-910c-45af-95c5-d5ce3b99d4e9";
  const roof = "66774c3f-6e4d-4ad0-a9c5-5b950993b9c7";
  assertEquals(
    siblingLiveInvoiceMayYieldToSecondInvoice({
      ourJobId: ms,
      invoiceJobId: assess,
      ourFamily: "physical_makesafe",
      invoiceFamily: "assessment_quote",
    }),
    true,
  );
  assertEquals(
    siblingLiveInvoiceMayYieldToSecondInvoice({
      ourJobId: ms,
      invoiceJobId: roof,
      ourFamily: "physical_makesafe",
      invoiceFamily: "ordinary_roof_portal",
    }),
    true,
  );
});

Deno.test("siblingLiveInvoicesAllYieldToSecondInvoice fails closed on empty or same-family", async () => {
  const ms = "a4f2f7b5-aa02-430c-b648-ee6872bbf883";
  const assess = "1caa4531-910c-45af-95c5-d5ce3b99d4e9";
  const roof = "66774c3f-6e4d-4ad0-a9c5-5b950993b9c7";
  const family = (jobId: string) =>
    jobId === assess
      ? "assessment_quote"
      : jobId === roof
      ? "ordinary_roof_portal"
      : jobId === ms
      ? "physical_makesafe"
      : "unknown";
  const empty = await siblingLiveInvoicesAllYieldToSecondInvoice({
    ourJobId: ms,
    loadCardFamily: async (id) => family(id),
    liveInvoices: [],
  });
  assertEquals(empty.yields, false);
  const bothSiblings = await siblingLiveInvoicesAllYieldToSecondInvoice({
    ourJobId: ms,
    loadCardFamily: async (id) => family(id),
    liveInvoices: [{ job_id: assess }, { job_id: roof }],
  });
  assertEquals(bothSiblings.yields, true);
  const sameCard = await siblingLiveInvoicesAllYieldToSecondInvoice({
    ourJobId: ms,
    loadCardFamily: async (id) => family(id),
    liveInvoices: [{ job_id: assess }, { job_id: ms }],
  });
  assertEquals(sameCard.yields, false);
});

Deno.test("matchingInvoiceRowForHit keys on xero id or invoice number", () => {
  const rows = [{
    xero_invoice_id: "xero-0876",
    invoice_number: "INV-0876",
    job_id: "1caa4531-910c-45af-95c5-d5ce3b99d4e9",
  }];
  assertEquals(
    matchingInvoiceRowForHit(
      { xero_invoice_id: "xero-0876", invoice_number: "INV-0876" },
      rows,
    )?.job_id,
    "1caa4531-910c-45af-95c5-d5ce3b99d4e9",
  );
  assertEquals(
    matchingInvoiceRowForHit({ invoice_number: "INV-9999" }, rows),
    null,
  );
});
