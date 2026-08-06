// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// "Nothing is BOUND" is not "nothing EXISTS".
//
// Measured live 2026-08-06: all 16 Docs Ready cards with no bound invoice
// already had live money under their own reference (SEVEN PAID, six AUTHORISED,
// three unlinked DRAFTs), and the cockpit told the operator to mint on every
// one of them — SWMS-26841 offered a $561 proposal against INV-0850 already
// PAID at $882.20.
//
// The property these tests exist to pin is that the fix is ONE-WAY: it can add
// a refusal and it can never make a card more approvable.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyExistingCardMoney,
  describeExistingCardMoney,
  NO_EXISTING_CARD_MONEY,
  type SesExistingCardMoney,
} from "./ses_existing_card_money.ts";
import {
  approveInvoiceDisabledReason,
  existingCardMoneyRefusal,
} from "./ses_review_cockpit.ts";

const JOB = "job-1";
const OTHER = "job-2";

const inv = (over: Record<string, unknown> = {}) => ({
  id: "x1",
  invoice_number: "INV-0850",
  reference: "MLB-26565 - Temp Fence Make-Safe",
  status: "PAID",
  invoice_type: "ACCREC",
  job_id: null,
  total: 882.2,
  ...over,
});

// ── classification ───────────────────────────────────────────────────────────

Deno.test("SWMS-26841: an invoice already PAID on this card is existing money", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ job_id: JOB })], null);
  assertEquals(money.exists, true);
  assertEquals(money.rows[0].attribution, "own_job");
  assertEquals(money.rows[0].status, "PAID");
  assertEquals(money.rows[0].total, 882.2);
});

Deno.test("SWMS-261015: an UNLINKED DRAFT under the card's own reference is existing money", () => {
  // The unique-match attribution matcher restricts to ISSUED statuses and would
  // miss this; a refusal must be inclusive, and a live DRAFT is exactly the
  // second-draft case being prevented.
  const money = classifyExistingCardMoney(
    JOB,
    "MLB-26658PO-56313",
    [inv({ id: "x2", invoice_number: "INV-1115", status: "DRAFT", reference: "MLB-26658PO-56313", job_id: null, total: 464.75 })],
    null,
  );
  assertEquals(money.exists, true);
  assertEquals(money.rows[0].attribution, "unlinked_reference_match");
  assertEquals(money.rows[0].status, "DRAFT");
});

Deno.test("a contested reference still REFUSES — inclusive, not unique", () => {
  // The attribution matcher correctly returns nothing when two cards share a
  // claim. For refusal that is the wrong answer: two candidates is more reason
  // to stop, not less.
  const money = classifyExistingCardMoney(
    JOB,
    "MLB-27037",
    [inv({ id: "a", invoice_number: "INV-1116", status: "DRAFT", reference: "MLB-27037PO-56459", job_id: null }),
     inv({ id: "b", invoice_number: "INV-1127", status: "AUTHORISED", reference: "MLB-27037", job_id: OTHER })],
    null,
  );
  assertEquals(money.exists, true);
  assertEquals(money.rows.length, 2);
});

Deno.test("the docket's OWN bound invoice is never reported as a surprise", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ id: "bound", job_id: JOB })], "bound");
  assertEquals(money.exists, false);
  assertEquals(money.rows.length, 0);
});

Deno.test("VOIDED/DELETED and non-ACCREC rows are not existing money", () => {
  const rows = [
    inv({ id: "v", status: "VOIDED", job_id: JOB }),
    inv({ id: "d", status: "DELETED", job_id: JOB }),
    inv({ id: "p", invoice_type: "ACCPAY", job_id: JOB }),
  ];
  assertEquals(classifyExistingCardMoney(JOB, "MLB-26565", rows, null).exists, false);
});

Deno.test("an unrelated reference on another card's invoice is not this card's money", () => {
  const money = classifyExistingCardMoney(
    JOB,
    "MLB-26565",
    [inv({ id: "z", reference: "MLB-99999", job_id: OTHER })],
    null,
  );
  assertEquals(money.exists, false);
});

Deno.test("a short reference cannot attach another builder's invoice by substring", () => {
  // SES_MIN_REFERENCE_DIGITS: a four-digit reference is a substring of
  // unrelated five- and six-digit numbers.
  const money = classifyExistingCardMoney(
    JOB,
    "BW-6771",
    [inv({ id: "z", reference: "MLB-267715", job_id: OTHER })],
    null,
  );
  assertEquals(money.exists, false);
});

// ── the refusal, and the one-way property ────────────────────────────────────

Deno.test("no bound invoice + existing money -> a refusal naming the invoice", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ job_id: JOB })], null);
  const refusal = existingCardMoneyRefusal(null, money);
  assert(refusal, "expected a refusal");
  assertEquals(refusal!.code, "invoice_exists_unbound");
  assertStringIncludes(refusal!.fact, "INV-0850");
  assertStringIncludes(refusal!.recovery_action, "Do not mint");
});

Deno.test("a BOUND card is never touched, however much other money exists", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ job_id: JOB })], null);
  assertEquals(existingCardMoneyRefusal("DRAFT", money), null);
  assertEquals(existingCardMoneyRefusal("AUTHORISED", money), null);
});

Deno.test("no existing money -> no refusal (it can only ADD a stop)", () => {
  assertEquals(existingCardMoneyRefusal(null, NO_EXISTING_CARD_MONEY), null);
  assertEquals(existingCardMoneyRefusal(null, null), null);
  assertEquals(existingCardMoneyRefusal(null, undefined), null);
});

Deno.test("an UNREADABLE Xero mirror refuses — it never reads as 'no money'", () => {
  const unreadable: SesExistingCardMoney = { exists: true, unreadable: true, rows: [] };
  const refusal = existingCardMoneyRefusal(null, unreadable);
  assert(refusal, "expected a refusal");
  assertStringIncludes(refusal!.fact, "could not be read");
});

// ── the operator sentence ────────────────────────────────────────────────────

Deno.test("the mint invitation is REPLACED when money already exists", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ job_id: JOB })], null);
  const withMoney = approveInvoiceDisabledReason(
    { xero_binding: null },
    { stale: false, xeroAuthorised: false, noAdditionalCharge: false, existingMoney: money },
  );
  assertStringIncludes(withMoney, "INV-0850");
  assertStringIncludes(withMoney, "Do NOT mint");
  assert(!withMoney.includes("Mint the draft first"), "must not invite a mint");
});

Deno.test("the mint invitation SURVIVES for a card with genuinely no money", () => {
  const clean = approveInvoiceDisabledReason(
    { xero_binding: null },
    { stale: false, xeroAuthorised: false, noAdditionalCharge: false, existingMoney: NO_EXISTING_CARD_MONEY },
  );
  assertStringIncludes(clean, "Mint the draft first");
});

Deno.test("an omitted existingMoney behaves exactly as before (no silent change)", () => {
  const before = approveInvoiceDisabledReason(
    { xero_binding: null },
    { stale: false, xeroAuthorised: false, noAdditionalCharge: false },
  );
  assertStringIncludes(before, "Mint the draft first");
});

Deno.test("the already-authorised sentence still wins over everything", () => {
  const money = classifyExistingCardMoney(JOB, "MLB-26565", [inv({ job_id: JOB })], null);
  const reason = approveInvoiceDisabledReason(
    { xero_binding: { invoice_number: "INV-9", status: "AUTHORISED" } },
    { stale: false, xeroAuthorised: true, noAdditionalCharge: false, existingMoney: money },
  );
  assertStringIncludes(reason, "already authorised");
});

Deno.test("describeExistingCardMoney names status and amount, and caps the list", () => {
  const many: SesExistingCardMoney = {
    exists: true,
    unreadable: false,
    rows: Array.from({ length: 6 }, (_, i) => ({
      invoice_number: `INV-${i}`,
      xero_invoice_id: `x${i}`,
      status: "PAID",
      total: 100 + i,
      reference: "MLB-1",
      attribution: "own_job" as const,
    })),
  };
  const text = describeExistingCardMoney(many);
  assertStringIncludes(text, "INV-0 PAID $100.00");
  assertStringIncludes(text, "and 2 more");
});
