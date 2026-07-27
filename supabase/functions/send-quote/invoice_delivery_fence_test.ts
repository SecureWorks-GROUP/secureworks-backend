// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateBrandedInvoiceDeliveryBinding } from "./invoice_delivery_fence.ts";

const REAL_JOB = "10000000-0000-4000-8000-000000000001";
const DECOY_JOB = "90000000-0000-4000-8000-000000000009";

Deno.test("branded invoice delivery refuses an unlinked ACCREC decoy job", () => {
  const result = validateBrandedInvoiceDeliveryBinding(
    {
      invoice_type: "ACCREC",
      job_id: null,
    },
    DECOY_JOB,
    "xero-unlinked",
  );
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.status, 409);
    assertEquals(result.refusal.code, "invoice_link_required");
  }
});

Deno.test("branded invoice delivery refuses a mismatched caller job", () => {
  const result = validateBrandedInvoiceDeliveryBinding(
    {
      invoice_type: "ACCREC",
      job_id: REAL_JOB,
    },
    DECOY_JOB,
    "xero-linked",
  );
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.refusal.code, "invoice_link_required");
    assertEquals(result.refusal.evidence?.expected_job_id, undefined);
    assertEquals(result.refusal.evidence?.invoice_job_id, REAL_JOB);
  }
});

Deno.test("branded invoice delivery preserves matching non-SES link", () => {
  assertEquals(
    validateBrandedInvoiceDeliveryBinding(
      {
        invoice_type: "ACCREC",
        job_id: REAL_JOB,
      },
      REAL_JOB,
      "xero-linked",
    ),
    {
      allowed: true,
      job_id: REAL_JOB,
    },
  );
});

Deno.test("SES release bindings cannot use branded legacy delivery", () => {
  const result = validateBrandedInvoiceDeliveryBinding(
    {
      invoice_type: "ACCREC",
      job_id: REAL_JOB,
      invoice_obligation_revision_id: "20000000-0000-4000-8000-000000000002",
    },
    REAL_JOB,
    "xero-ses",
  );
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.refusal.code, "sealed_ses_release_required");
  }
});
