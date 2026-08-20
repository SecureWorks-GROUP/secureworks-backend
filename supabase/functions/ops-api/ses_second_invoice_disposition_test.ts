import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  normalizePostReleaseDisposition,
  sesInvoiceFamilyFromCardFacts,
  siblingLiveInvoiceMayYieldToSecondInvoice,
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
