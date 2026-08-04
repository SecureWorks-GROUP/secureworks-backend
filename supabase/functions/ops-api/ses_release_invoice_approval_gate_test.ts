// deno-lint-ignore-file no-import-prefix
/**
 * Focused gate for SEND IT invoice-approval bookkeeping after re-prepare.
 * AUTHORISED obligation binding is downstream proof of human APPROVE INVOICE;
 * non-AUTHORISED still requires the approval row.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  sesReleaseInvoiceApprovalReadRefusal,
  sesReleaseInvoiceApprovalSatisfied,
} from "./ses_reporting_actions.ts";

Deno.test(
  "invoice_bound + AUTHORISED obligation satisfies SEND IT without approval row",
  () => {
    assertEquals(
      sesReleaseInvoiceApprovalSatisfied({
        hasInvoiceApprovalRow: false,
        obligationXeroBindingStatus: "AUTHORISED",
      }),
      true,
    );
    // Case-insensitive: production bindings may vary casing.
    assertEquals(
      sesReleaseInvoiceApprovalSatisfied({
        hasInvoiceApprovalRow: false,
        obligationXeroBindingStatus: "authorised",
      }),
      true,
    );
  },
);

Deno.test(
  "invoice_bound without AUTHORISED still refuses when approval row is missing",
  () => {
    assertEquals(
      sesReleaseInvoiceApprovalSatisfied({
        hasInvoiceApprovalRow: false,
        obligationXeroBindingStatus: "DRAFT",
      }),
      false,
    );
    assertEquals(
      sesReleaseInvoiceApprovalSatisfied({
        hasInvoiceApprovalRow: false,
        obligationXeroBindingStatus: null,
      }),
      false,
    );
    assertEquals(
      sesReleaseInvoiceApprovalSatisfied({
        hasInvoiceApprovalRow: false,
        obligationXeroBindingStatus: "",
      }),
      false,
    );
    assertEquals(
      sesReleaseInvoiceApprovalSatisfied({
        hasInvoiceApprovalRow: false,
        obligationXeroBindingStatus: "SUBMITTED",
      }),
      false,
    );
    // Missing status entirely (obligation read failed / unbound).
    assertEquals(
      sesReleaseInvoiceApprovalSatisfied({
        hasInvoiceApprovalRow: false,
      }),
      false,
    );
  },
);

Deno.test(
  "a failed approval read refuses as unreadable, never as approval missing",
  () => {
    const refusal = sesReleaseInvoiceApprovalReadRefusal("approval", {
      data: null,
      error: { message: "column does not exist" },
    });
    assertEquals(refusal?.code, "invoice_approval_unreadable");
    assertStringIncludes(refusal?.fact || "", "APPROVE INVOICE record");
    assertStringIncludes(refusal?.fact || "", "column does not exist");
    // An approval read that cleanly returned no row is the bookkeeping gap this
    // gate exists for, not a fault.
    assertEquals(
      sesReleaseInvoiceApprovalReadRefusal("approval", {
        data: null,
        error: null,
      }),
      null,
    );
  },
);

Deno.test(
  "the AUTHORISED pass is only granted on an obligation read that returned",
  () => {
    for (
      const response of [
        { data: null, error: { message: "timeout" } },
        { data: null, error: null },
      ]
    ) {
      const refusal = sesReleaseInvoiceApprovalReadRefusal(
        "obligation",
        response,
      );
      assertEquals(refusal?.code, "invoice_approval_unreadable");
      assertStringIncludes(refusal?.fact || "", "Xero binding");
    }
    assertEquals(
      sesReleaseInvoiceApprovalReadRefusal("obligation", {
        data: { xero_binding: { status: "AUTHORISED" } },
        error: null,
      }),
      null,
    );
  },
);

Deno.test(
  "present invoice approval row always satisfies regardless of binding status",
  () => {
    assertEquals(
      sesReleaseInvoiceApprovalSatisfied({
        hasInvoiceApprovalRow: true,
        obligationXeroBindingStatus: null,
      }),
      true,
    );
    assertEquals(
      sesReleaseInvoiceApprovalSatisfied({
        hasInvoiceApprovalRow: true,
        obligationXeroBindingStatus: "DRAFT",
      }),
      true,
    );
  },
);
