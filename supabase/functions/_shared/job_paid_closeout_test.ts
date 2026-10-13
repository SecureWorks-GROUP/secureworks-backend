// deno-lint-ignore-file no-import-prefix
// The paid close-out rule against the shapes of real jobs from the 13 Oct 2026
// investigation (paid-review-archive-s1): job numbers and money kept, people left out.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  closeoutHold,
  type CloseoutInvoice,
  type CloseoutJob,
  type CloseoutParty,
  evaluateJobPaid,
  invoicePartyKey,
  isCloseoutFromStatus,
  isCloseoutJobType,
  isDepositInvoice,
  isFinalInvoice,
  OWNER_KEY,
} from "./job_paid_closeout.ts";

function job(over: Partial<CloseoutJob> = {}): CloseoutJob {
  return {
    id: "job-1",
    job_number: "SWF-1",
    type: "fencing",
    status: "invoiced",
    is_callback: false,
    deposit_invoice_id: null,
    ...over,
  };
}

let seq = 0;
function inv(
  reference: string,
  status: string,
  total: number,
  over: Partial<CloseoutInvoice> = {},
): CloseoutInvoice {
  seq++;
  return {
    xero_invoice_id: `x-${seq}`,
    invoice_number: `INV-${seq}`,
    invoice_type: "ACCREC",
    status,
    reference,
    total,
    amount_paid: status === "PAID" ? total : 0,
    job_contact_id: null,
    xero_contact_id: null,
    fully_paid_on: status === "PAID" ? "2026-10-01" : null,
    ...over,
  };
}

function party(
  id: string,
  label: string,
  share: number,
  over: Partial<CloseoutParty> = {},
): CloseoutParty {
  return {
    id,
    contact_label: label,
    is_primary: label === "A",
    share_percentage: share,
    removed_at: null,
    xero_contact_id: null,
    ...over,
  };
}

const noQuote = { quote_total_inc: null, variations_inc: 0, unknown_reason: "quote_unknown" };

Deno.test("only fencing and patio are close-out jobs, from complete, final payment or invoiced", () => {
  assertEquals(isCloseoutJobType("fencing"), true);
  assertEquals(isCloseoutJobType("Patio"), true);
  for (const t of ["makesafe", "repair", "insurance", "decking", "renovation", null]) {
    assertEquals(isCloseoutJobType(t), false, String(t));
  }
  for (const s of ["complete", "final_payment", "invoiced"]) {
    assertEquals(isCloseoutFromStatus(s), true, s);
  }
  for (const s of ["get_review", "archived", "rectification", "in_progress"]) {
    assertEquals(isCloseoutFromStatus(s), false, s);
  }
});

Deno.test("holds: rectification and callback only", () => {
  assertEquals(closeoutHold({ status: "rectification", is_callback: false }), "rectification");
  assertEquals(closeoutHold({ status: "invoiced", is_callback: true }), "callback");
  assertEquals(closeoutHold({ status: "invoiced", is_callback: null }), null);
});

Deno.test("deposit and final: DEP50 is a deposit, FINBAL and FIN25 are finals, VAR and MAT are not", () => {
  assertEquals(isDepositInvoice(inv("SWF-261200-DEP50", "PAID", 1), null), true);
  assertEquals(isDepositInvoice(inv("DEP50", "PAID", 1), null), true);
  assertEquals(isDepositInvoice(inv("SWF-26984-C-RHS-DEP50", "PAID", 1), null), true);
  assertEquals(isDepositInvoice(inv("SWF-1-DEPOSIT", "PAID", 1), null), true);
  const byId = inv("SWF-1 fence", "PAID", 1);
  assertEquals(isDepositInvoice(byId, byId.xero_invoice_id), true);
  assertEquals(isFinalInvoice(inv("SWF-261200-FINBAL", "PAID", 1), null), true);
  assertEquals(isFinalInvoice(inv("SWF-26818-FIN25", "PAID", 1), null), true);
  assertEquals(isFinalInvoice(inv("SWF-26989-VAR", "PAID", 1), null), false);
  assertEquals(isFinalInvoice(inv("SWP-1-MAT30", "PAID", 1), null), false);
  assertEquals(isFinalInvoice(inv("SWP-1-PROG", "PAID", 1), null), false);
  // Anything that is not a named stage invoice counts as a final.
  assertEquals(isFinalInvoice(inv("12 Example St", "PAID", 1), null), true);
});

Deno.test("party matching: job_contact_id, then share letter, then Xero contact, else the client", () => {
  const a = party("pa", "A", 50, { xero_contact_id: "xa" });
  const b = party("pb", "B", 50, { xero_contact_id: "xb" });
  const paying = [a, b];
  assertEquals(invoicePartyKey(inv("SWF-1-A-DEP50", "PAID", 1, { job_contact_id: "pb" }), paying), "pb");
  assertEquals(invoicePartyKey(inv("SWF-1-B-FINBAL", "PAID", 1), paying), "pb");
  assertEquals(invoicePartyKey(inv("SWF-1-FINBAL", "PAID", 1, { xero_contact_id: "XB" }), paying), "pb");
  assertEquals(invoicePartyKey(inv("SWF-1-FINBAL", "PAID", 1), paying), "pa");
  assertEquals(invoicePartyKey(inv("SWF-1-C-FINBAL", "PAID", 1), paying), "unmatched:letter:C");
  assertEquals(invoicePartyKey(inv("SWF-1-FINBAL", "PAID", 1, { job_contact_id: "gone" }), paying), "unmatched:job_contact:gone");
  // No party rows: everything without a neighbour letter is the client's.
  assertEquals(invoicePartyKey(inv("SWF-1-FINBAL", "PAID", 1), []), OWNER_KEY);
});

Deno.test("a single-payer job with a paid deposit and paid final is paid", () => {
  const v = evaluateJobPaid({
    job: job(),
    invoices: [inv("SWF-1-DEP50", "PAID", 2000), inv("SWF-1-FINBAL", "PAID", 2000)],
    parties: [],
    quote: { quote_total_inc: 4000, variations_inc: 0, unknown_reason: null },
  });
  assertEquals(v.outcome, "paid");
  assertEquals(v.reasons, []);
  assertEquals(v.paid_total_inc, 4000);
  assertEquals(v.shortfall_inc, 0);
  assertEquals(v.last_paid_on, "2026-10-01");
});

Deno.test("SWF-261335 shape: only the owner's deposit paid, neighbour never invoiced -> not paid", () => {
  const v = evaluateJobPaid({
    job: job({ job_number: "SWF-261335" }),
    invoices: [inv("DEP50", "PAID", 1018)],
    parties: [party("pa", "A", 100), party("pb", "B", 50)],
    quote: { quote_total_inc: 6667, variations_inc: 0, unknown_reason: null },
  });
  assertEquals(v.outcome, "not_paid");
  assertEquals(v.reasons, [
    "party_without_paid_final:A",
    "party_without_paid_final:B",
    "paid_less_than_quoted",
  ]);
});

Deno.test("SWF-261227 shape: neighbour B paid deposit and final, owner A billed nothing live -> not paid", () => {
  const v = evaluateJobPaid({
    job: job({ job_number: "SWF-261227" }),
    invoices: [
      inv("SWF-261227-A-DEP50", "VOIDED", 840.13),
      inv("SWF-261227-B-FINBAL", "PAID", 840.13),
      inv("SWF-261227-B-DEP50", "DELETED", 840.13),
      inv("SWF-261227-B-DEP50", "PAID", 840.13, { job_contact_id: "pb" }),
    ],
    parties: [party("pa", "A", 50), party("pb", "B", 50)],
    quote: { quote_total_inc: 4340, variations_inc: 0, unknown_reason: null },
  });
  assertEquals(v.outcome, "not_paid");
  assertEquals(v.parties.map((p) => [p.label, p.has_paid_final]), [["A", false], ["B", true]]);
  assertEquals(v.reasons.includes("party_without_paid_final:A"), true);
});

Deno.test("SWF-26767 shape: final voided, only deposits paid -> not paid", () => {
  const v = evaluateJobPaid({
    job: job({ job_number: "SWF-26767" }),
    invoices: [
      inv("SWF-26767-FINBAL", "VOIDED", 2409),
      inv("SWF-26767-DEP50", "PAID", 2409),
      inv("SWF-26767-B-DEP50", "PAID", 2409, { job_contact_id: "pb" }),
    ],
    parties: [party("pa", "A", 50), party("pb", "B", 50)],
    quote: null,
  });
  assertEquals(v.outcome, "not_paid");
  assertEquals(v.reasons, ["party_without_paid_final:A", "party_without_paid_final:B"]);
  assertEquals(v.quote_known, false);
});

Deno.test("SWF-26989 shape: final balance still AUTHORISED -> not paid", () => {
  const v = evaluateJobPaid({
    job: job({ job_number: "SWF-26989", status: "get_review" }),
    invoices: [
      inv("SWF-26989-VAR", "PAID", 247.5),
      inv("SWF-26989-DEP50", "PAID", 2186.25),
      inv("SWF-26989-FINBAL50", "AUTHORISED", 2433.75),
    ],
    parties: [],
    quote: noQuote,
  });
  assertEquals(v.outcome, "not_paid");
  assertEquals(v.reasons, ["unpaid_invoice", "party_without_paid_final:owner"]);
});

Deno.test("a draft invoice blocks paid even when everything else is paid", () => {
  const v = evaluateJobPaid({
    job: job(),
    invoices: [inv("SWF-1-DEP50", "PAID", 1000), inv("SWF-1-FINBAL", "PAID", 1000), inv("SWF-1-VAR", "DRAFT", 200)],
    parties: [],
    quote: noQuote,
  });
  assertEquals(v.outcome, "not_paid");
  assertEquals(v.reasons, ["draft_invoice"]);
});

Deno.test("no linked invoice is never paid", () => {
  const v = evaluateJobPaid({ job: job(), invoices: [], parties: [], quote: noQuote });
  assertEquals(v.outcome, "not_paid");
  assertEquals(v.reasons, ["no_invoices", "party_without_paid_final:owner"]);
});

Deno.test("SWF-26818 shape: every final paid but well under the quote -> paid less than quoted", () => {
  const v = evaluateJobPaid({
    job: job({ job_number: "SWF-26818" }),
    invoices: [
      inv("SWF-26818-DEP25", "PAID", 1392.88),
      inv("SWF-26818-FIN25", "PAID", 1641.87),
      inv("SWF-26818-DEP25", "PAID", 1392.88),
      inv("SWF-26818-FIN25", "PAID", 1267.87),
    ],
    parties: [],
    quote: { quote_total_inc: 10414, variations_inc: 0, unknown_reason: null },
  });
  assertEquals(v.outcome, "paid_less_than_quoted");
  assertEquals(v.reasons, ["paid_less_than_quoted"]);
  assertEquals(v.paid_total_inc, 5695.5);
  assertEquals(v.shortfall_inc, 4718.5);
});

Deno.test("shared fence: both owners paid their finals and the quote is covered -> paid", () => {
  const v = evaluateJobPaid({
    job: job(),
    invoices: [
      inv("SWF-2-DEP50", "PAID", 1000),
      inv("SWF-2-FINBAL", "PAID", 1000),
      inv("SWF-2-B-DEP50", "PAID", 1000),
      inv("SWF-2-B-FINBAL", "PAID", 1000),
    ],
    parties: [party("pa", "A", 50), party("pb", "B", 50)],
    quote: { quote_total_inc: 4000, variations_inc: 0, unknown_reason: null },
  });
  assertEquals(v.outcome, "paid");
});

Deno.test("a removed neighbour or a zero share is not a paying party", () => {
  const v = evaluateJobPaid({
    job: job(),
    invoices: [inv("SWF-3-DEP50", "PAID", 1000), inv("SWF-3-FINBAL", "PAID", 1000)],
    parties: [
      party("pa", "A", 100),
      party("pb", "B", 50, { removed_at: "2026-09-01T00:00:00Z" }),
      party("pc", "C", 0),
    ],
    quote: noQuote,
  });
  assertEquals(v.outcome, "paid");
  assertEquals(v.parties.map((p) => p.label), ["A"]);
});

Deno.test("tolerance: a few dollars short and agreed variations both count", () => {
  const base = {
    job: job(),
    invoices: [inv("SWF-4-DEP50", "PAID", 2000), inv("SWF-4-FINBAL", "PAID", 1998), inv("SWF-4-VAR", "PAID", 330)],
    parties: [],
  };
  assertEquals(
    evaluateJobPaid({ ...base, quote: { quote_total_inc: 4000, variations_inc: 330, unknown_reason: null } }).outcome,
    "paid",
  );
  // An accepted variation that was never invoiced leaves money owing.
  assertEquals(
    evaluateJobPaid({ ...base, quote: { quote_total_inc: 4000, variations_inc: 990, unknown_reason: null } }).outcome,
    "paid_less_than_quoted",
  );
});

Deno.test("unknown quote or unreadable variations: rules 1 and 2 decide alone", () => {
  const base = {
    job: job(),
    invoices: [inv("SWF-5-DEP50", "PAID", 10), inv("SWF-5-FINBAL", "PAID", 10)],
    parties: [],
  };
  const unknown = evaluateJobPaid({ ...base, quote: null });
  assertEquals(unknown.outcome, "paid");
  assertEquals(unknown.quote_known, false);
  const noVariations = evaluateJobPaid({
    ...base,
    quote: { quote_total_inc: 9999, variations_inc: null, unknown_reason: null },
  });
  assertEquals(noVariations.outcome, "paid");
  assertEquals(noVariations.quote_unknown_reason, "variations_unreadable");
});
