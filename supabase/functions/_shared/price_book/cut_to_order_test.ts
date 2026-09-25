// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  costCutPlanByLength,
  cutToOrder,
  CutToOrderError,
} from "./cut_to_order.ts";
// @ts-ignore verbatim JS fixture
import { nestCuts } from "./patio_nest_cuts_fixture.js";

// Patio stock list for 100x50x2 RHS (patio tool STEEL_STOCK_LENGTHS_BY_SIZE).
const RHS_100X50 = [5500, 6500, 8000];

// Kiko, Balcatta (17 Sep): nine void-infill bays of 9 slats each plus a
// 20-slat pedestrian gate, Quickscreen 65 slat, 6100 mm stock. Cut lengths
// from data/kiko-balcatta-slats-quote-20260917/calc.txt.
const KIKO_SLATS = [
  { length_mm: 645, qty: 9 },
  { length_mm: 555, qty: 9 },
  { length_mm: 1735, qty: 9 },
  { length_mm: 1735, qty: 9 },
  { length_mm: 1445, qty: 9 },
  { length_mm: 1950, qty: 9 },
  { length_mm: 1965, qty: 9 },
  { length_mm: 1955, qty: 9 },
  { length_mm: 1995, qty: 9 },
  { length_mm: 1610, qty: 20 },
];

Deno.test("Kiko slats: 101 pieces nest into 27 bars of 6100 mm at 4.1% waste", () => {
  const plan = cutToOrder({
    rule: "nest",
    pieces: KIKO_SLATS,
    stock_lengths_mm: [6100],
  });
  assertEquals(plan.piece_count, 101);
  assertEquals(plan.required_mm, 158_020);
  assertEquals(plan.sticks.length, 27);
  assertEquals(plan.order, [{
    length_mm: 6100,
    qty: 27,
    special_order: false,
  }]);
  assertEquals(plan.purchased_mm, 164_700);
  assertEquals(plan.waste_mm, 6_680);
  assertEquals(plan.waste_percent, 4.1);
  // Every stick respects the kerf.
  for (const stick of plan.sticks) {
    const used = stick.cuts_mm.reduce((a, b) => a + b, 0) +
      (stick.cuts_mm.length - 1) * 3;
    assertEquals(used <= 6100, true);
    assertEquals(stick.offcut_mm, 6100 - used - 3);
  }
  // Every piece is cut exactly once.
  assertEquals(plan.sticks.flatMap((s) => s.cuts_mm).length, 101);
});

Deno.test("need 6 m of 100x50 buys one 6.5 m length from 5500/6500/8000", () => {
  const plan = cutToOrder({
    rule: "one_per_stick",
    pieces: [{ length_mm: 6000, qty: 1 }],
    stock_lengths_mm: RHS_100X50,
  });
  assertEquals(plan.order, [{ length_mm: 6500, qty: 1, special_order: false }]);
  assertEquals(plan.waste_mm, 500);
  assertEquals(plan.sticks[0].offcut_mm, 497);
  // The 0.5 m offcut is paid for: $13.29 at $26.57/LM.
  const cost = costCutPlanByLength(plan, [{
    per_length_mm: null,
    cost_ex_gst: 26.57,
  }]);
  assertEquals(cost.waste_ex_gst, 13.29);
  assertEquals(cost.purchased_ex_gst, 172.71);
  assertEquals(cost.lines[0].rate_basis, "per_lm_rate");
});

// PB-9: whole stock lengths at the rate the supplier charges for THAT length.
// BD Metals invoice 00022187: $172.73 per 6.5 m ($26.5738/LM) and $150.00 per
// 5.5 m ($27.2727/LM). Pieces of 6 m and 4.8 m buy one of each.
const BD_RATES = [
  { per_length_mm: 6500, cost_ex_gst: 26.5738, cost_row_id: "c-6500" },
  { per_length_mm: 5500, cost_ex_gst: 27.2727, cost_row_id: "c-5500" },
];

Deno.test("PB-9: each stock length is costed at its own per-length price", () => {
  const plan = cutToOrder({
    rule: "one_per_stick",
    pieces: [{ length_mm: 6000, qty: 1 }, { length_mm: 4800, qty: 2 }],
    stock_lengths_mm: RHS_100X50,
  });
  const cost = costCutPlanByLength(plan, BD_RATES);
  assertEquals(
    cost.lines.map((l) => [l.length_mm, l.qty, l.each_ex_gst, l.rate_basis]),
    [
      [5500, 2, 150.0, "length_rate"],
      [6500, 1, 172.73, "length_rate"],
    ],
  );
  // Two 5.5 m lengths at $150.00, not 11 m of the 6.5 m length's $26.57/LM
  // ($292.31): the old headline-rate costing under-priced them by $7.69.
  assertEquals(cost.purchased_ex_gst, 472.73);
  assertEquals(cost.unpriced_lengths_mm, []);
});

Deno.test("PB-9: a length with no price is unpriced, never guessed from another length", () => {
  const plan = cutToOrder({
    rule: "one_per_stick",
    pieces: [{ length_mm: 7000, qty: 1 }],
    stock_lengths_mm: RHS_100X50,
  });
  const cost = costCutPlanByLength(plan, BD_RATES);
  assertEquals(cost.purchased_ex_gst, null);
  assertEquals(cost.waste_ex_gst, null);
  assertEquals(cost.unpriced_lengths_mm, [8000]);
  const withList = costCutPlanByLength(plan, [
    ...BD_RATES,
    { per_length_mm: null, cost_ex_gst: 28 },
  ]);
  assertEquals(withList.lines[0].each_ex_gst, 224);
  assertEquals(withList.lines[0].rate_basis, "per_lm_rate");
});

Deno.test("need 4.8 m of 100x50 buys 5.5 m", () => {
  const plan = cutToOrder({
    rule: "one_per_stick",
    pieces: [{ length_mm: 4800, qty: 1 }],
    stock_lengths_mm: RHS_100X50,
  });
  assertEquals(plan.order, [{ length_mm: 5500, qty: 1, special_order: false }]);
  assertEquals(plan.waste_mm, 700);
});

Deno.test("stock list order does not matter", () => {
  const plan = cutToOrder({
    rule: "one_per_stick",
    pieces: [{ length_mm: 4800, qty: 2 }],
    stock_lengths_mm: [8000, 5500, 6500],
  });
  assertEquals(plan.order, [{ length_mm: 5500, qty: 2, special_order: false }]);
});

Deno.test("a piece longer than every stock length is a special order", () => {
  const plan = cutToOrder({
    rule: "one_per_stick",
    pieces: [{ length_mm: 9000, qty: 2 }, { length_mm: 3000, qty: 1 }],
    stock_lengths_mm: RHS_100X50,
  });
  assertEquals(plan.special_orders, [{ length_mm: 9000, qty: 2 }]);
  assertEquals(plan.order, [
    { length_mm: 5500, qty: 1, special_order: false },
    { length_mm: 9000, qty: 2, special_order: true },
  ]);
  const cost = costCutPlanByLength(plan, [{
    per_length_mm: null,
    cost_ex_gst: 26.57,
  }]);
  assertEquals(cost.special_order_priced_at_stock_rate, true);
  assertEquals(cost.lines[1], {
    length_mm: 9000,
    qty: 2,
    special_order: true,
    rate_basis: "per_lm_rate",
    cost_row_id: null,
    each_ex_gst: 239.13,
    line_ex_gst: 478.26,
  });
});

Deno.test("single cut length reproduces nestCuts: longer stock only when fewer sticks", () => {
  // 76x38 rafters 3000 mm x 5 on [3000,4000,6100,7300,8000]: 6100 holds 2
  // (3000+3+3000=6003), 3000 holds 1. 3 sticks of 6100 beat 5 of 3000;
  // 8000 also holds 2, so it is not taken.
  const plan = cutToOrder({
    rule: "nest",
    pieces: [{ length_mm: 3000, qty: 5 }],
    stock_lengths_mm: [3000, 4000, 6100, 7300, 8000],
  });
  assertEquals(plan.order, [{ length_mm: 6100, qty: 3, special_order: false }]);
  assertEquals(plan.sticks.map((s) => s.cuts_mm.length), [2, 2, 1]);
  assertEquals(plan.sticks[0].offcut_mm, 6100 - 6006);
});

Deno.test("cut to size buys the pieces themselves and wastes nothing", () => {
  const plan = cutToOrder({
    rule: "cut_to_size",
    pieces: [{ length_mm: 1995, qty: 9 }, { length_mm: 645, qty: 9 }],
  });
  assertEquals(plan.waste_mm, 0);
  assertEquals(plan.waste_percent, 0);
  assertEquals(plan.order, [
    { length_mm: 1995, qty: 9, special_order: false },
    { length_mm: 645, qty: 9, special_order: false },
  ]);
});

Deno.test("bad input refuses with a code, never a guess", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as CutToOrderError).code;
    }
    return null;
  };
  assertEquals(
    code(() =>
      cutToOrder({ rule: "nest", pieces: [{ length_mm: 100, qty: 1 }] })
    ),
    "cut_stock_lengths_missing",
  );
  assertEquals(
    code(() =>
      cutToOrder({
        rule: "nest",
        pieces: [{ length_mm: 0, qty: 1 }],
        stock_lengths_mm: [6000],
      })
    ),
    "cut_piece_invalid",
  );
  assertEquals(
    code(() =>
      // deno-lint-ignore no-explicit-any
      cutToOrder({ rule: "guess" as any, pieces: [{ length_mm: 1, qty: 1 }] })
    ),
    "cut_rule_unknown",
  );
  assertThrows(() =>
    costCutPlanByLength(
      cutToOrder({ rule: "cut_to_size", pieces: [{ length_mm: 1, qty: 1 }] }),
      [{ per_length_mm: null, cost_ex_gst: 0 }],
    )
  );
});

// Parity with the patio tool: a seeded sweep over every patio stock list,
// single cut lengths and both modes the tool uses. Stock lengths, placements
// and stick counts match; this contract subtracts the final cut's kerf from
// each usable offcut while the patio tool's displayed waste does not.

Deno.test("parity: one cut length matches the patio tool's nestCuts on every stock list", () => {
  const stockLists = [
    [6500, 8000],
    [3000, 4000, 6100, 7300, 8000],
    [8000],
    [5500, 6500, 8000],
    [3100, 4100, 6200, 8000],
  ];
  let seed = 20260924;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  let compared = 0;
  for (const stock of stockLists) {
    for (let i = 0; i < 200; i++) {
      const cut = 300 + rand(8200);
      const qty = 1 + rand(20);
      for (const onePerStick of [false, true]) {
        const legacy = nestCuts(cut, qty, stock, { onePerStick });
        const plan = cutToOrder({
          rule: onePerStick ? "one_per_stick" : "nest",
          pieces: [{ length_mm: cut, qty }],
          stock_lengths_mm: stock,
        });
        if (legacy.specialOrder) {
          assertEquals(plan.special_orders, [{ length_mm: cut, qty }]);
        } else {
          assertEquals(plan.sticks.length, legacy.totalSticks);
          assertEquals(
            plan.sticks.map((s) => [s.stock_length_mm, s.cuts_mm.length]),
            // deno-lint-ignore no-explicit-any
            legacy.sticks.map((s: any) => [s.stockLength, s.cuts.length]),
          );
          for (let j = 0; j < plan.sticks.length; j++) {
            assertEquals(
              plan.sticks[j].offcut_mm,
              Math.max(0, legacy.sticks[j].waste - 3),
            );
          }
        }
        compared++;
      }
    }
  }
  assertEquals(compared, 2000);
});

Deno.test("piece count is bounded before expansion", () => {
  assertThrows(
    () =>
      cutToOrder({
        rule: "one_per_stick",
        pieces: [{ length_mm: 100, qty: 1001 }],
        stock_lengths_mm: [6000],
      }),
    CutToOrderError,
  );
});
