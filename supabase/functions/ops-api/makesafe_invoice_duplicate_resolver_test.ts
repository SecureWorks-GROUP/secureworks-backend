// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveSesInvoiceDuplicates,
  resolveSesInvoiceDuplicatesByJob,
  type SesInvoiceIndexRow,
} from "./makesafe_invoice_duplicate_resolver.ts";

const JOB = "10000000-0000-4000-8000-000000000001";

function invoice(
  overrides: Partial<SesInvoiceIndexRow> = {},
): SesInvoiceIndexRow {
  return {
    job_id: JOB,
    xero_invoice_id: "xero-1",
    invoice_number: "INV-1001",
    status: "DRAFT",
    reference: "MLB-24732",
    invoice_type: "ACCREC",
    ...overrides,
  };
}

Deno.test("duplicate resolver blocks a second create on the same job", () => {
  const [result] = resolveSesInvoiceDuplicates(
    [{ job_id: JOB, external_ref: "MLB-24732" }],
    [invoice()],
  );
  assertEquals(result.match_tier, "job_id");
  assertEquals(result.allows_create, false);
  assertEquals(result.reason_codes, ["blocked_duplicate_live"]);
});

Deno.test("duplicate resolver reports multi-live ambiguity instead of picking one", () => {
  const [result] = resolveSesInvoiceDuplicates(
    [{ job_id: JOB, external_ref: "MLB-24732" }],
    [
      invoice(),
      invoice({
        xero_invoice_id: "xero-2",
        invoice_number: "INV-1002",
      }),
    ],
  );
  assertEquals(result.ambiguity, "multi_live");
  assertEquals(result.live_invoices.length, 2);
  assertEquals(result.allows_create, false);
});

Deno.test("VOIDED and DELETED history never blocks create", () => {
  for (const status of ["VOIDED", "DELETED"]) {
    const [result] = resolveSesInvoiceDuplicates(
      [{ job_id: JOB, external_ref: "MLB-24732" }],
      [invoice({ status })],
    );
    assertEquals(result.match_tier, null);
    assertEquals(result.ambiguity, "void_only");
    assert(result.allows_create);
  }
});

Deno.test("different PO sibling remains separately invoiceable", () => {
  const [result] = resolveSesInvoiceDuplicates(
    [{
      job_id: JOB,
      external_ref: "MLB-25898PO-55547",
    }],
    [
      invoice({
        job_id: "20000000-0000-4000-8000-000000000002",
        reference: "MLB-25898PO-54817",
      }),
    ],
  );
  assertEquals(result.match_tier, null);
  assertEquals(result.ambiguity, "sibling_po");
  assert(result.allows_create);
});

Deno.test("obligation binding outranks mirror reference matching", () => {
  const [result] = resolveSesInvoiceDuplicates(
    [{
      job_id: JOB,
      external_ref: "AJBR 70062",
      obligation_revision_id: "30000000-0000-4000-8000-000000000003",
    }],
    [
      invoice({
        job_id: "40000000-0000-4000-8000-000000000004",
        reference: "unrelated display ref",
        invoice_obligation_revision_id: "30000000-0000-4000-8000-000000000003",
      }),
    ],
  );
  assertEquals(result.match_tier, "obligation_binding");
  assertEquals(result.allows_create, false);
});

Deno.test("indexed helper selects obligation binding so it cannot miss a bound duplicate", async () => {
  let selectedColumns = "";
  const client: any = {
    from: () => ({
      select: (columns: string) => {
        selectedColumns = columns;
        return {
          eq: () => ({
            in: async () => ({
              data: [invoice({
                job_id: "40000000-0000-4000-8000-000000000004",
                invoice_obligation_revision_id:
                  "30000000-0000-4000-8000-000000000003",
              })],
              error: null,
            }),
          }),
        };
      },
    }),
  };
  const [result] = await resolveSesInvoiceDuplicatesByJob(
    client,
    "00000000-0000-0000-0000-000000000001",
    [{
      job_id: JOB,
      obligation_revision_id: "30000000-0000-4000-8000-000000000003",
    }],
  );
  assert(selectedColumns.includes("invoice_obligation_revision_id"));
  assertEquals(result.match_tier, "obligation_binding");
  assertEquals(result.allows_create, false);
});
