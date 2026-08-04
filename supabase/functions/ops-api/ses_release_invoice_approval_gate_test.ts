// deno-lint-ignore-file no-import-prefix
/**
 * Focused gate for SEND IT invoice-approval bookkeeping after re-prepare.
 * AUTHORISED obligation binding is downstream proof of human APPROVE INVOICE;
 * non-AUTHORISED still requires the approval row.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sesReleaseInvoiceApprovalSatisfied } from "./ses_reporting_actions.ts";

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
