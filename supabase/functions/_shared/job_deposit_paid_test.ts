// deno-lint-ignore-file no-import-prefix
// The deposit advance rule (job_deposit_paid.ts): what counts as a deposit, when it is
// paid in full, where a paid deposit sends the job, and when a later void or refund is
// flagged for a person.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEPOSIT_RECEIVED_TEXT_TEMPLATE,
  type DepositInvoice,
  depositFlagFor,
  depositInvoicesSent,
  depositPaidTargetStatus,
  depositReceivedText,
  evaluateDepositPaid,
  isDepositAdvanceJobType,
  isDepositInvoice,
} from "./job_deposit_paid.ts";

function inv(over: Partial<DepositInvoice> = {}): DepositInvoice {
  return {
    xero_invoice_id: "x-1",
    invoice_number: "INV-1749",
    invoice_type: "ACCREC",
    status: "PAID",
    reference: "SWF-261369-DEP50",
    total: 2000,
    amount_due: 0,
    amount_paid: 2000,
    fully_paid_on: "2026-10-26",
    ...over,
  };
}

const job = { deposit_invoice_id: "x-1" };

Deno.test("deposit paid: one deposit paid in full is paid", () => {
  const v = evaluateDepositPaid({ job, invoices: [inv()] });
  assertEquals(v.paid, true);
  assertEquals(v.reasons, []);
  assertEquals(v.last_paid_on, "2026-10-26");
});

Deno.test("deposit paid: a part payment never counts", () => {
  const authorisedPart = inv({ status: "AUTHORISED", amount_due: 500, amount_paid: 1500 });
  assertEquals(evaluateDepositPaid({ job, invoices: [authorisedPart] }), {
    paid: false,
    reasons: ["part_paid:INV-1749"],
    deposits: [{ xero_invoice_id: "x-1", invoice_number: "INV-1749", status: "AUTHORISED", amount_due: 500 }],
    last_paid_on: "2026-10-26",
  });
  // PAID in our copy with money still due is not paid in full either.
  const odd = inv({ amount_due: 10 });
  assertEquals(evaluateDepositPaid({ job, invoices: [odd] }).reasons, ["part_paid:INV-1749"]);
  // Rounding inside half a cent is nothing due.
  assertEquals(evaluateDepositPaid({ job, invoices: [inv({ amount_due: 0.004 })] }).paid, true);
});

Deno.test("deposit paid: unpaid, draft and no deposit are not paid", () => {
  assertEquals(
    evaluateDepositPaid({ job, invoices: [inv({ status: "AUTHORISED", amount_due: 2000, amount_paid: 0 })] }).reasons,
    ["unpaid_deposit:INV-1749"],
  );
  assertEquals(
    evaluateDepositPaid({ job, invoices: [inv({ status: "DRAFT", amount_due: 2000, amount_paid: 0 })] }).reasons,
    ["draft_deposit:INV-1749"],
  );
  assertEquals(evaluateDepositPaid({ job, invoices: [] }).reasons, ["no_deposit_invoice"]);
  // A final invoice is not a deposit.
  const fin = inv({ xero_invoice_id: "x-9", reference: "SWF-261369-FINBAL" });
  assertEquals(
    evaluateDepositPaid({ job: { deposit_invoice_id: null }, invoices: [fin] }).reasons,
    ["no_deposit_invoice"],
  );
});

Deno.test("deposit paid: a shared fence with one party unpaid is not paid", () => {
  const a = inv({ xero_invoice_id: "x-a", invoice_number: "INV-1", reference: "SWF-26535-A-DEP50" });
  const b = inv({
    xero_invoice_id: "x-b",
    invoice_number: "INV-2",
    reference: "SWF-26535-B-DEP50",
    status: "AUTHORISED",
    amount_due: 900,
    amount_paid: 0,
    fully_paid_on: null,
  });
  const v = evaluateDepositPaid({ job: { deposit_invoice_id: "x-b" }, invoices: [a, b] });
  assertEquals(v.paid, false);
  assertEquals(v.reasons, ["unpaid_deposit:INV-2"]);
  // Once party B pays, the job is paid.
  const bPaid = { ...b, status: "PAID", amount_due: 0, amount_paid: 900, fully_paid_on: "2026-10-27" };
  const paid = evaluateDepositPaid({ job: { deposit_invoice_id: "x-b" }, invoices: [a, bPaid] });
  assertEquals(paid.paid, true);
  assertEquals(paid.last_paid_on, "2026-10-27");
});

Deno.test("deposit paid: a hand-made Xero deposit that is not the pointer still counts", () => {
  const pointer = inv({ xero_invoice_id: "x-1" });
  const handMade = inv({
    xero_invoice_id: "x-hand",
    invoice_number: "INV-1800",
    reference: "SWF-261369-DEP",
    status: "AUTHORISED",
    amount_due: 300,
    amount_paid: 0,
  });
  assert(isDepositInvoice(handMade, "x-1"));
  assertEquals(
    evaluateDepositPaid({ job, invoices: [pointer, handMade] }).reasons,
    ["unpaid_deposit:INV-1800"],
  );
  // A hand-made deposit paid, with no pointer at all, is paid.
  assertEquals(
    evaluateDepositPaid({ job: { deposit_invoice_id: null }, invoices: [{ ...handMade, status: "PAID", amount_due: 0 }] }).paid,
    true,
  );
});

Deno.test("deposit paid: voided deposits do not count, a bill is never a deposit", () => {
  const voided = inv({ xero_invoice_id: "x-old", status: "VOIDED", amount_due: 0 });
  const replacement = inv({ xero_invoice_id: "x-new", invoice_number: "INV-2000" });
  assertEquals(evaluateDepositPaid({ job, invoices: [voided, replacement] }).paid, true);
  assertEquals(evaluateDepositPaid({ job, invoices: [voided] }).reasons, ["no_deposit_invoice"]);
  assertEquals(isDepositInvoice(inv({ invoice_type: "ACCPAY" }), "x-1"), false);
  // The pointer counts even without a DEP reference.
  assert(isDepositInvoice(inv({ reference: "SWF-261369" }), "x-1"));
  assertEquals(isDepositInvoice(inv({ reference: "SWF-261369" }), null), false);
});

Deno.test("deposit sent: a live sent deposit lands, a draft or none does not", () => {
  assertEquals(depositInvoicesSent({ job, invoices: [inv({ status: "AUTHORISED", amount_due: 2000 })] }).sent, true);
  assertEquals(depositInvoicesSent({ job, invoices: [inv({ status: "DRAFT" })] }).sent, false);
  assertEquals(depositInvoicesSent({ job, invoices: [] }).reasons, ["no_deposit_invoice"]);
});

Deno.test("deposit target: fencing to order materials, patio by council", () => {
  assertEquals(depositPaidTargetStatus({ type: "fencing", council_required: null }), "order_materials");
  assertEquals(depositPaidTargetStatus({ type: "patio", council_required: true }), "approvals");
  assertEquals(depositPaidTargetStatus({ type: "patio", council_required: null }), "approvals");
  assertEquals(depositPaidTargetStatus({ type: "patio" }), "approvals");
  assertEquals(depositPaidTargetStatus({ type: "patio", council_required: false }), "order_materials");
  assertEquals(depositPaidTargetStatus({ type: "makesafe", council_required: false }), null);
  assert(isDepositAdvanceJobType("Fencing"));
  assertEquals(isDepositAdvanceJobType("repair"), false);
});

Deno.test("deposit flag: a voided counted deposit after the move is flagged", () => {
  const moved = { deposit_invoice_id: "x-1", status: "order_materials" };
  const voided = inv({ status: "VOIDED" });
  assertEquals(depositFlagFor({ job: moved, invoices: [voided], countedIds: ["x-1"] }), {
    reason: "deposit_voided",
    xero_invoice_id: "x-1",
    invoice_number: "INV-1749",
    invoice_status: "VOIDED",
  });
  // A replacement deposit paid in full flags nothing.
  const replacement = inv({ xero_invoice_id: "x-2", invoice_number: "INV-2" });
  assertEquals(depositFlagFor({ job: moved, invoices: [voided, replacement], countedIds: ["x-1"] }), null);
  // A job a person moved on (nothing counted) is flagged on a voided deposit too.
  assertEquals(depositFlagFor({ job: moved, invoices: [voided], countedIds: [] })?.reason, "deposit_voided");
  // Still in the deposit columns: never a flag.
  assertEquals(
    depositFlagFor({ job: { ...moved, status: "awaiting_deposit" }, invoices: [voided], countedIds: ["x-1"] }),
    null,
  );
});

Deno.test("deposit flag: a counted deposit no longer paid in full is flagged", () => {
  const moved = { deposit_invoice_id: "x-1", status: "scheduled" };
  const refunded = inv({ status: "AUTHORISED", amount_due: 2000, amount_paid: 0 });
  assertEquals(depositFlagFor({ job: moved, invoices: [refunded], countedIds: ["x-1"] })?.reason, "deposit_unpaid");
  // Without a counted record, a payment taken off alone raises nothing (only a void does).
  assertEquals(depositFlagFor({ job: moved, invoices: [refunded], countedIds: [] }), null);
  // Still paid: nothing.
  assertEquals(depositFlagFor({ job: moved, invoices: [inv()], countedIds: ["x-1"] }), null);
});

Deno.test("deposit text: the template has no em dash and names the client's first name", () => {
  assertEquals(DEPOSIT_RECEIVED_TEXT_TEMPLATE.includes("—"), false);
  assertEquals(DEPOSIT_RECEIVED_TEXT_TEMPLATE.includes("–"), false);
  const t = depositReceivedText("Vicky Zhang");
  assert(t.startsWith("Hi Vicky,\n"));
  assert(t.includes("received your deposit"));
  assert(t.includes("ordering your materials"));
  assert(depositReceivedText(null).startsWith("Hi there,"));
});
