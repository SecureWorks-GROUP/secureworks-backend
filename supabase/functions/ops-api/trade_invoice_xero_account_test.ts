// deno-lint-ignore-file no-import-prefix
// Regression: trade/subcontractor ACCPAY bills route to Xero account 306
// ("Internal Subcontractors") — Captain's ruling 2026-07-31. Previously they
// landed on 620 while manually entered subcontractor bills sat on 306.
// Source-level assertions (same style as index_deno_type_baseline_test.ts):
// no network, no live Supabase, no Xero mutation.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TRADE_INVOICE_XERO_ACCOUNT_CODE } from "./wo_labour_fanout.ts";

const INDEX_SRC = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

Deno.test("trade invoice Xero account code is 306 (Internal Subcontractors)", () => {
  assertEquals(TRADE_INVOICE_XERO_ACCOUNT_CODE, "306");
});

Deno.test("no trade push path still hardcodes AccountCode '620'", () => {
  assert(
    !INDEX_SRC.includes("AccountCode: '620'") &&
      !INDEX_SRC.includes('AccountCode: "620"'),
    "found a hardcoded 620 AccountCode — trade ACCPAY bills must use TRADE_INVOICE_XERO_ACCOUNT_CODE (306)",
  );
});

Deno.test("all seven trade ACCPAY line-item sites use the shared constant", () => {
  // push_trade_invoice_to_xero (1), submit_work_order_invoice (2),
  // generate_trade_invoice labour+extras (2), submitTradeInvoice per-metre+hourly (2).
  const uses = INDEX_SRC.match(
    /AccountCode: TRADE_INVOICE_XERO_ACCOUNT_CODE,/g,
  );
  assertEquals(
    uses?.length ?? 0,
    7,
    "expected exactly 7 trade line-item sites on the shared constant; a new trade push path must reuse it and a removed one must update this count",
  );
});

Deno.test("client/sales (ACCREC) invoice account routing is untouched", () => {
  // These are the client-side defaults that must NOT be swept into the trade
  // change: sales/deposit invoice line fallbacks and the bank-txn default.
  for (
    const fragment of [
      "AccountCode: li.account_code || '200'",
      "AccountCode: li.account_code || '210'",
      "AccountCode: li.account_code || '300'",
    ]
  ) {
    assert(
      INDEX_SRC.includes(fragment),
      `client invoice default missing: ${fragment}`,
    );
  }
});
