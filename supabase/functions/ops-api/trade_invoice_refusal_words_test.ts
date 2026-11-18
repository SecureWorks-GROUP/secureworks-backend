// deno-lint-ignore-file no-import-prefix
// Follow-up 49 item 6: a refusal reaches the trade in plain words.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  TRADE_INVOICE_REFUSAL_WORDS,
  TradeInvoiceStoreError,
  tradeInvoiceRefusal,
} from "./trade_invoice_refusal.ts";

const JOB = "00000000-0000-4000-8000-0000000000f4";
const BILL = "00000000-0000-4000-8000-0000000000b1";

// What each refusal looks like when it reaches the route's catch.
const RAISED: Record<keyof typeof TRADE_INVOICE_REFUSAL_WORDS, unknown[]> = {
  work_order_amount_refused: [
    // The PostgREST error the cap move throws, unwrapped.
    { code: "23514", message: "job_amount_guard", details: JOB },
    // A save that wraps the database text.
    new TradeInvoiceStoreError("Failed to persist weekly invoice: job_amount_guard", "23514"),
  ],
  invoice_changed_before_xero: [
    new TradeInvoiceStoreError("work_order_invoice_changed_before_xero", "P0001"),
  ],
  xero_bill_needs_office: [
    // The checkpoint's wrapped error, which once reached the trade verbatim
    // as a plain sentence, guard name and bill id included.
    new Error(`Xero created bill ${BILL}, but its recoverable identity could not be saved: job_amount_guard`),
    new Error(`Xero bill ${BILL} reconciled, but the local invoice could not be marked pushed: trade invoice row was not updated`),
  ],
};

Deno.test("FU49 item 6: every refusal code answers with its label's words", () => {
  for (const [code, raised] of Object.entries(RAISED)) {
    const words = TRADE_INVOICE_REFUSAL_WORDS[code as keyof typeof TRADE_INVOICE_REFUSAL_WORDS];
    assert(raised.length > 0, code);
    for (const err of raised) {
      assertEquals(tradeInvoiceRefusal(err), {
        status: words.status,
        body: { ok: false, code, error: words.error },
      });
    }
  }
});

Deno.test("FU49 item 6: the label words carry no internal name, id or amount", () => {
  for (const [code, words] of Object.entries(TRADE_INVOICE_REFUSAL_WORDS)) {
    assertEquals(/[_$\d]|guard|persist|postgrest|rpc|trigger|uuid/i.test(words.error), false, code);
    assert(words.error.length <= 160, code);
    assertEquals(words.error.includes("\u2014"), false, code);
  }
});

Deno.test("FU49 item 6: a cap refusal never echoes the job id or the guard name", () => {
  const out = tradeInvoiceRefusal({ code: "23514", message: "job_amount_guard", details: JOB });
  assertEquals(JSON.stringify(out).includes(JOB), false);
  assertEquals(JSON.stringify(out.body.error).includes("job_amount_guard"), false);
});

Deno.test("FU49 item 6: a raw Xero failure is never passed to the trade as a sentence", () => {
  const out = tradeInvoiceRefusal(new Error('Xero API /Contacts?where=Name failed (500): {"Message":"down"}'));
  assertEquals(out.status, 500);
  assertEquals(out.body.code, "trade_invoice_error");
});
