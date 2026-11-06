import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { presentTradeInvoiceBillOutcome } from "./trade_invoice_bill_outcome.ts";

Deno.test("a voided or deleted bill never reads as a live bill", () => {
  assertEquals(
    presentTradeInvoiceBillOutcome({ xero_bill_id: "b", xero_bill_status: "VOIDED", status: "pushed_to_xero" }),
    { xero_bill_outcome: "voided", bill_status_label: "Voided in Xero", week_released: false },
  );
  assertEquals(
    presentTradeInvoiceBillOutcome({
      xero_bill_id: "b",
      xero_bill_status: "deleted",
      status: "ops-reject",
      override_details: { voided_release: { xero_bill_id: "b" } },
    }),
    { xero_bill_outcome: "deleted", bill_status_label: "Deleted in Xero, week released", week_released: true },
  );
});

Deno.test("a live, paid or missing bill adds nothing", () => {
  for (const status of ["AUTHORISED", "DRAFT", "PAID", "", null]) {
    assertEquals(presentTradeInvoiceBillOutcome({ xero_bill_id: "b", xero_bill_status: status }), {});
  }
  assertEquals(presentTradeInvoiceBillOutcome({ xero_bill_id: null, xero_bill_status: "VOIDED" }), {});
  assertEquals(
    presentTradeInvoiceBillOutcome({ xero_bill_id: "b", xero_bill_status: "VOIDED", status: "ops-reject", override_details: [1] }).week_released,
    false,
  );
});
