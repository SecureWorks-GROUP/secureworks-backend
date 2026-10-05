import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildXeroInvoiceEvidencePlan,
  XERO_EVIDENCE_MAX_CANDIDATES,
  xeroEvidenceMatchJob,
  type XeroEvidenceJobRow,
} from "./xero_invoice_evidence_plan.ts";

const card = (
  id: string,
  externalRef: string | null,
  extra: Partial<XeroEvidenceJobRow> = {},
): XeroEvidenceJobRow => ({
  id,
  job_number: `SWMS-${id.slice(-4)}`,
  type: "makesafe",
  metadata: {},
  external_ref: externalRef,
  has_makesafe_details: true,
  ...extra,
});

const invoice = (
  id: string,
  reference: string | null,
  status = "PAID",
  jobId: string | null = null,
) => ({
  id,
  invoice_number: `INV-${id.slice(-4)}`,
  reference,
  status,
  invoice_type: "ACCREC",
  job_id: jobId,
});

const J1 = "a0000000-0000-4000-8000-000000000001";
const J2 = "a0000000-0000-4000-8000-000000000002";
const J3 = "a0000000-0000-4000-8000-000000000003";
const I1 = "b0000000-0000-4000-8000-000000000001";
const I2 = "b0000000-0000-4000-8000-000000000002";
const I3 = "b0000000-0000-4000-8000-000000000003";
const I4 = "b0000000-0000-4000-8000-000000000004";

Deno.test("a unique reference match places the row on that card", () => {
  const { plan, summary } = buildXeroInvoiceEvidencePlan(
    [card(J1, "MLB-26344"), card(J2, "AJBR-70271")],
    [invoice(I1, "MLB-26344 Make safe")],
    [I1],
  );
  assertEquals(plan.matches, [{ invoice_id: I1, job_id: J1, digits: ["26344"] }]);
  assertEquals(plan.candidates, []);
  assertEquals(summary.matched, 1);
});

Deno.test("a claim shared by two cards is never matched; both become candidates", () => {
  const { plan, summary } = buildXeroInvoiceEvidencePlan(
    [card(J1, "MLB-27037"), card(J2, "MLB-27037")],
    [invoice(I1, "MLB-27037")],
    [I1],
  );
  assertEquals(plan.matches, []);
  assertEquals(plan.candidates, [{ invoice_id: I1, job_ids: [J1, J2] }]);
  assertEquals(summary.with_candidates, 1);
});

Deno.test("a non-board job still contests the reference (guard 2 sees every job)", () => {
  const { plan } = buildXeroInvoiceEvidencePlan(
    [
      card(J1, "MLB-26344"),
      card(J2, null, {
        type: "fencing",
        has_makesafe_details: false,
        metadata: { builder_po_number: "26344" },
      }),
    ],
    [invoice(I1, "MLB-26344")],
    [I1],
  );
  assertEquals(plan.matches, []);
  assertEquals(plan.candidates, [{ invoice_id: I1, job_ids: [J1, J2] }]);
});

Deno.test("two invoices naming one card match neither; the card is a candidate for both", () => {
  const { plan } = buildXeroInvoiceEvidencePlan(
    [card(J1, "MLB-26344")],
    [invoice(I1, "MLB-26344"), invoice(I2, "MLB-26344 balance")],
    [I1, I2],
  );
  assertEquals(plan.matches, []);
  assertEquals(plan.candidates.map((c) => c.invoice_id), [I1, I2]);
});

Deno.test("a substring is never a match: four-digit references stay out", () => {
  const { plan, summary } = buildXeroInvoiceEvidencePlan(
    [card(J1, "BWCWA6771")],
    [invoice(I1, "PO 167710")],
    [I1],
  );
  assertEquals(plan, { matches: [], candidates: [] });
  assertEquals(summary.no_candidate, 1);
});

Deno.test("only the invoices asked about are planned; draft and linked invoices are not eligible", () => {
  const { plan, summary } = buildXeroInvoiceEvidencePlan(
    [card(J1, "MLB-26344"), card(J2, "MLB-25147"), card(J3, "AJBR-70271")],
    [
      invoice(I1, "MLB-26344"),
      invoice(I2, "MLB-25147", "DRAFT"),
      invoice(I3, "AJBR-70271", "PAID", J3),
      invoice(I4, "MLB-99999"),
    ],
    [I1, I2, I3],
  );
  assertEquals(plan.matches, [{ invoice_id: I1, job_id: J1, digits: ["26344"] }]);
  assertEquals(plan.candidates, []);
  assertEquals(summary.not_eligible, 2);
});

Deno.test("ids come out lower case and candidates are capped", () => {
  const jobs = Array.from(
    { length: XERO_EVIDENCE_MAX_CANDIDATES + 3 },
    (_, i) =>
      card(`a0000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, "MLB-31313"),
  );
  const { plan } = buildXeroInvoiceEvidencePlan(
    jobs,
    [invoice(I1.toUpperCase(), "MLB-31313")],
    [I1],
  );
  assertEquals(plan.candidates.length, 1);
  assertEquals(plan.candidates[0].invoice_id, I1);
  assertEquals(plan.candidates[0].job_ids.length, XERO_EVIDENCE_MAX_CANDIDATES);
});

Deno.test("the board rule: make-safe, restoration, or a details row", () => {
  assertEquals(xeroEvidenceMatchJob({ id: J1, type: "makesafe" }).on_board, true);
  assertEquals(
    xeroEvidenceMatchJob({
      id: J1,
      type: "insurance",
      metadata: { insurance_job_type: "restoration" },
    }).on_board,
    true,
  );
  assertEquals(
    xeroEvidenceMatchJob({ id: J1, type: "repair", has_makesafe_details: true }).on_board,
    true,
  );
  assertEquals(xeroEvidenceMatchJob({ id: J1, type: "fencing" }).on_board, false);
});
