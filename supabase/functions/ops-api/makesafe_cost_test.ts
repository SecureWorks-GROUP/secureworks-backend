// Tests for the M1.5 cost ledger math (makesafe_cost.ts).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  accrueScanTotals,
  addUsage,
  emailCostRecord,
  emptyScanTotals,
  HAIKU_4_5_RATES,
  readUsage,
  rollup24h,
  usdCost,
  ZERO_USAGE,
} from "./makesafe_cost.ts";

Deno.test("usdCost: input+output at the Haiku 4.5 rates", () => {
  // 1000 input @ $1/M + 200 output @ $5/M = 0.001 + 0.001 = 0.002
  const c = usdCost({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assertEquals(c, 0.002);
});

Deno.test("usdCost: cache-read and cache-write bill at their own rates", () => {
  const c = usdCost({
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 500, // 500 @ 0.1/M = 0.00005
    cache_creation_input_tokens: 400, // 400 @ 1.25/M = 0.0005
  });
  assertEquals(c, 0.00255);
});

Deno.test("HAIKU_4_5_RATES are the constants the cost math is documented against", () => {
  assertEquals(HAIKU_4_5_RATES.input_per_mtok, 1.0);
  assertEquals(HAIKU_4_5_RATES.output_per_mtok, 5.0);
  assertEquals(HAIKU_4_5_RATES.cache_read_per_mtok, 0.1);
  assertEquals(HAIKU_4_5_RATES.cache_write_per_mtok, 1.25);
});

Deno.test("readUsage normalises missing/garbage SDK usage fields to 0", () => {
  assertEquals(readUsage(undefined), ZERO_USAGE);
  assertEquals(readUsage({ input_tokens: "12", output_tokens: null, cache_read_input_tokens: 3 }), {
    input_tokens: 12,
    output_tokens: 0,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 0,
  });
});

Deno.test("emailCostRecord: a template skip (model not called) costs $0", () => {
  const rec = emailCostRecord({
    model_called: false,
    pdf_mode: "none",
    parser: "template",
    usage: { ...ZERO_USAGE },
  });
  assertEquals(rec.estimated_cost_usd, 0);
  assertEquals(rec.model_called, false);
  assertEquals(rec.parser, "template");
});

Deno.test("accrueScanTotals folds calls/skips/tokens across a scan", () => {
  let t = emptyScanTotals();
  t = accrueScanTotals(t, emailCostRecord({
    model_called: true, pdf_mode: "text", parser: "none",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }));
  t = accrueScanTotals(t, emailCostRecord({
    model_called: false, pdf_mode: "none", parser: "template", usage: { ...ZERO_USAGE },
  }));
  assertEquals(t.model_calls, 1);
  assertEquals(t.model_skips, 1);
  assertEquals(t.usage.input_tokens, 100);
  assertEquals(t.usage.output_tokens, 20);
});

Deno.test("rollup24h: model_skip_rate, calls, tokens, cost", () => {
  const r = rollup24h([
    { model_called: true, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    { model_called: false, usage: { ...ZERO_USAGE } },
    { model_called: true, usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    // Pre-M1.5 draft with no cost record — ignored (no model_called boolean).
    null,
    { pdf_mode: "text" } as unknown as { model_called?: boolean },
  ]);
  assertEquals(r.model_calls_24h, 2);
  assertEquals(r.model_skips_24h, 1);
  assertEquals(r.priced_drafts_24h, 3);
  assertEquals(r.model_skip_rate, 0.333); // 1 / 3
  assertEquals(r.tokens_24h.input_tokens, 1500);
  assertEquals(r.tokens_24h.output_tokens, 300);
  // 1500 @ $1/M + 300 @ $5/M = 0.0015 + 0.0015 = 0.003
  assertEquals(r.estimated_cost_usd_24h, 0.003);
});

Deno.test("rollup24h: no priced drafts -> skip rate 0 (no divide-by-zero)", () => {
  const r = rollup24h([null, undefined, {} as unknown as { model_called?: boolean }]);
  assertEquals(r.model_skip_rate, 0);
  assertEquals(r.estimated_cost_usd_24h, 0);
});

Deno.test("addUsage sums every token bucket", () => {
  const s = addUsage(
    { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
  );
  assertEquals(s, { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 });
});
