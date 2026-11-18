import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compareWorkOrderToBudget, parseJobNumber, toCents } from "./prove-work-order-from-scope.ts";

const budget = (amount: unknown) => ({ labour: { pay: "group_work_order", work_order_amount_ex_gst: amount } });

Deno.test("prove script: equal only when both amounts match to the cent", () => {
  assertEquals(compareWorkOrderToBudget(budget(2240), 2240), {
    budget_amount: "2240.00", work_order_amount: "2240.00", equal: true,
  });
  assertEquals(compareWorkOrderToBudget(budget(2240.37), "2240.37").equal, true);
  assertEquals(compareWorkOrderToBudget(budget(2240.37), 2240.36).equal, false);
});

Deno.test("prove script: a missing amount is none and never equal, never zero", () => {
  assertEquals(compareWorkOrderToBudget(budget(null), null), {
    budget_amount: null, work_order_amount: null, equal: false,
  });
  assertEquals(compareWorkOrderToBudget(null, 0).equal, false);
  assertEquals(compareWorkOrderToBudget(budget(2240), null).equal, false);
  assertEquals(toCents(""), null);
  assertEquals(toCents(-1), null);
});

Deno.test("prove script: only a ZZTEST job number is accepted", () => {
  assertEquals(parseJobNumber(["--job-number", "ZZTEST-SCOPE"]), "ZZTEST-SCOPE");
  assertEquals(parseJobNumber(["--job-number=ZZTEST-1"]), "ZZTEST-1");
  assertEquals(parseJobNumber(["--job-number", "SWF-261001"]), null);
  assertEquals(parseJobNumber(["--job-number", "ZZTEST-"]), null);
  assertEquals(parseJobNumber([]), null);
});
