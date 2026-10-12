// deno-lint-ignore-file no-explicit-any no-import-prefix
// The trade's view of a job work order, driven through the real trade
// redaction my_job_work_order uses: heights and lengths stay, prices never do.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tradeJobWorkOrderRedaction } from "./index.ts";
import { projectTradeJobWorkOrder } from "./job_work_orders.ts";

function tradeSees(written: string): {
  description: string | null;
  instructions: string | null;
} {
  const out = projectTradeJobWorkOrder(
    {
      id: "wo",
      job_id: "job",
      status: "approved",
      agreed_labour_ex: 7777,
      scope_items: [{ description: written, qty: 1, unit: "lot" }],
      special_instructions: written,
    },
    {},
    tradeJobWorkOrderRedaction,
  ) as any;
  return {
    description: out.scope_items[0]?.description ?? null,
    instructions: out.special_instructions,
  };
}

Deno.test("trade work order view keeps heights and lengths written with a space", () => {
  for (
    const written of [
      "2.1 m high pool fence, 12.5 m run",
      "Colorbond fence 1800 high, 30 m",
      "Insulated patio 6.5 x 4.2 m",
      "Insulated patio 6.5 x 4.2 m, 2.7 m clearance",
      "Install 30 m Colorbond 1.8 m",
      "25.5 m Hardifence, 1.8 high",
      "Supply and install 2 x 900 mm gates",
      "Posts at 2.4 m centres, 600 deep",
      "Slab 24.5 m2, 100 mm thick",
      "Install 120 metres of 1.8m Colorbond",
    ]
  ) {
    assertEquals(tradeSees(written), {
      description: written,
      instructions: written,
    });
  }
});

Deno.test("trade work order view still removes every price", () => {
  const cases: Array<[string, string | null, string[]]> = [
    ["$1,800", null, ["1,800", "1800", "800"]],
    ["Fence 1800 ex GST", "Fence", ["1800", "GST"]],
    ["Fence rate 85/hr", null, ["85"]],
    ["Fence 2 hrs @ 120", "Fence 2 hrs @", ["120"]],
    ["labour 2400", "labour", ["2400"]],
    ["30 m at 45 per m", "30 m at", ["45"]],
    ["Fence $30 m", "Fence m", ["30"]],
    ["Fence $ 1800 high", "Fence high", ["1800"]],
    ["Fence 1800 mm ex GST", "Fence mm", ["1800"]],
    ["Fence 1800 high inc GST", "Fence high", ["1800"]],
    ["Gates 2 x 450", "Gates 2 x", ["450"]],
    ["Fence 30 m price 1,250.50", null, ["1,250", "250", "50"]],
    ["Fence 30 m, labour $2,000", "Fence 30 m, labour", ["2,000", "2000"]],
  ];
  for (const [written, expected, leaks] of cases) {
    const seen = tradeSees(written);
    assertEquals(seen.description, expected, written);
    assertEquals(seen.instructions, expected, written);
    for (const leak of leaks) {
      assert(
        !JSON.stringify(seen).includes(leak),
        `${written} leaked ${leak}: ${JSON.stringify(seen)}`,
      );
    }
  }
});

Deno.test("trade work order view never carries the agreed labour or a priced item key", () => {
  const out = projectTradeJobWorkOrder(
    {
      id: "wo",
      job_id: "job",
      status: "approved",
      agreed_labour_ex: 7777,
      scope_items: [{
        description: "Install 30 m Colorbond 1.8 m",
        qty: 30,
        unit: "m",
        rate: 66.67,
        total: 2000,
        notes: "1.8 m sheets, paid $66.67 per metre",
      }],
      special_instructions: " 2.1 m high, allowance 2000",
    },
    {},
    tradeJobWorkOrderRedaction,
  ) as any;
  assertEquals(out.scope_items, [{
    description: "Install 30 m Colorbond 1.8 m",
    qty: 30,
    unit: "m",
  }]);
  assertEquals(out.special_instructions, "2.1 m high, allowance");
  const text = JSON.stringify(out);
  for (const leak of ["7777", "66.67", "2000", "rate", "total"]) {
    assert(!text.includes(leak), `leaked ${leak}: ${text}`);
  }
});
