// deno-lint-ignore-file no-explicit-any no-import-prefix
// Work order lines from the accepted quote (docs/quote-work-order-lines-v1.md).
// Fixtures are shaped from live quotes read on 12-13 Oct 2026: SWF-26904 (The
// Strand), SWF-261527 and SWF-261525 (root removal), SWF-261540 (hours in the
// words) and a patio quote. Customer details are left out.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildQuoteWorkOrderLines,
  FENCE_LABOUR_COST_ITEM_KEYS,
  FENCE_LABOUR_COST_KEYS,
  fenceInstallDescription,
  QUOTE_LINE_FLAGS,
  QUOTE_RESULT_FLAGS,
  type QuoteWorkOrderLine,
} from "./quote_work_order_lines.ts";
import { projectTradeJobWorkOrder } from "./job_work_orders.ts";
import { tradeJobWorkOrderRedaction } from "./index.ts";

// scope_tool_defaults (fence-designer) as read live on 13 Oct 2026.
const COST_TABLE = {
  "base-labour": 35,
  "plinth-install": 10,
  "gate-labour-pedestrian": 250,
  "gate-labour-double": 500,
  "remove-hardie-cost": 12.5,
  "remove-timber-cost": 20,
  "remove-colorbond-cost": 15,
  "remove-asbestos-cost": 65,
  "veg-clear-cost": 150,
};

// SWF-26904: 37.6 m Ridgeside over three runs, 21 plinths, 15 m of Hardie
// removed. The quote's labour figure is 37.6 x 35 + 21 x 10 = 1,526.
const STRAND_PRICING = {
  version: "3.0",
  line_items: [
    {
      unit: "m",
      category: "fencing",
      quantity: 37.6,
      sell_price: 125,
      total_sell: 4700,
      description: "16× Ridgeside (37.6m total)",
      supplier_name: "R&R Fencing",
    },
    {
      unit: "each",
      category: "materials",
      quantity: 21,
      cost_price: 41,
      sell_price: 80,
      total_cost: 861,
      total_sell: 1680,
      description: "Retaining plinths (150mm COLORBOND)",
    },
    {
      unit: "m",
      category: "removal",
      quantity: 15,
      total_sell: 450,
      description: "Remove Hardie fence",
    },
    {
      unit: "lot",
      category: "delivery",
      quantity: 1,
      cost_price: 95,
      sell_price: 200,
      total_sell: 200,
      description: "Delivery",
    },
  ],
  internal: { cost: 3302.5, labour: 1526, margin: 1498.5, commission: 330.225 },
  labourCostEstimate: 1526,
  totalExGST: 7030,
};

// SWF-261527: the captain's own example. "Root removal / hard digging, 2 hrs",
// sell $130 an hour, cost $80 an hour, saved as material by the fence tool.
const ROOTS_2HRS_PRICING = {
  line_items: [
    {
      unit: "m",
      category: "fencing",
      quantity: 18.5,
      sell_price: 125,
      total_sell: 2312.5,
      description: "8× Ridgeside (18.5m total)",
    },
    {
      unit: "each",
      category: "materials",
      quantity: 12,
      cost_price: 41,
      sell_price: 80,
      description: "Retaining plinths (150mm COLORBOND)",
    },
    {
      unit: "m",
      category: "removal",
      quantity: 18.5,
      total_sell: 832.5,
      description: "Remove Colorbond fence",
    },
    {
      kind: "material",
      unit: "hrs",
      category: "custom",
      quantity: 2,
      cost_price: 80,
      sell_price: 130,
      total_sell: 260,
      description: "Root removal / hard digging ",
    },
    {
      unit: "lot",
      category: "delivery",
      quantity: 1,
      cost_price: 95,
      sell_price: 200,
      description: "Delivery",
    },
  ],
  internal: { cost: 2074.5, labour: 767.5 },
  labourCostEstimate: 767.5,
};

// SWF-261525: "Root removal, 1 job", cost $250, saved as material. Labour
// figure: 1 m x 35 + one pedestrian gate 250 = 285.
const ROOTS_ONE_JOB_PRICING = {
  line_items: [
    {
      unit: "m",
      category: "fencing",
      quantity: 1,
      sell_price: 100,
      description: "1× Superdek (1.0m total)",
    },
    {
      unit: "each",
      category: "gates",
      quantity: 1,
      total_sell: 1000,
      description: "Pedestrian gate 1000mm",
    },
    {
      kind: "material",
      unit: "job",
      category: "custom",
      quantity: 1,
      cost_price: 250,
      sell_price: 400,
      description: "Root removal  ",
    },
    {
      unit: "lot",
      category: "delivery",
      quantity: 1,
      cost_price: 95,
      description: "Delivery",
    },
  ],
  labourCostEstimate: 285,
};

// A patio quote: steel and gutters, and one labour row priced by the hour.
const PATIO_PRICING = {
  line_items: [
    {
      unit: "LM",
      category: "steel",
      quantity: 6,
      cost_price: 30.5,
      description: "Beam 150x50 C-section",
    },
    {
      unit: "LM",
      category: "gutters",
      quantity: 6,
      cost_price: 10,
      description: "Patio Gutter",
    },
    {
      unit: "sqm",
      category: "extras",
      quantity: 18,
      cost_price: 3,
      description: "Fixings (screws, anchors, silicone, foam)",
    },
    {
      unit: "hrs",
      category: "labour",
      quantity: 24,
      cost_price: 45,
      sell_price: 110,
      total_cost: 1080,
      total_sell: 2640,
      description: "Labour — 2 trades × 1.5 days",
    },
  ],
  labourCostEstimate: 1080,
};

function byKey(lines: QuoteWorkOrderLine[], key: string) {
  const line = lines.find((l) => l.line_key === key);
  assert(
    line,
    `no line ${key}: ${JSON.stringify(lines.map((l) => l.line_key))}`,
  );
  return line;
}

Deno.test("The Strand (SWF-26904): install per metre as quoted, plinths, removal; the split equals the quote's labour", () => {
  const r = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: STRAND_PRICING,
    costTable: COST_TABLE,
  });
  const install = byKey(r.lines, "install:0");
  assertEquals(
    {
      description: install.description,
      qty: install.qty,
      unit: install.unit,
      hours: install.hours,
      rate: install.rate,
      rate_unit: install.rate_unit,
      total: install.total,
      counted: install.counted,
    },
    {
      description: "Install Ridgeside fence (16 panels)",
      qty: 37.6,
      unit: "m",
      hours: null,
      rate: 35,
      rate_unit: "m",
      total: 1316,
      counted: true,
    },
  );
  const plinths = byKey(r.lines, "plinths");
  assertEquals([plinths.qty, plinths.unit, plinths.rate, plinths.total], [
    21,
    "ea",
    10,
    210,
  ]);
  const removal = byKey(r.lines, "removal:2");
  assertEquals([
    removal.description,
    removal.qty,
    removal.unit,
    removal.rate,
    removal.total,
  ], ["Remove Hardie fence", 15, "m", 12.5, 187.5]);
  assertEquals(removal.flags, [QUOTE_LINE_FLAGS.quoteCountedAsMaterials]);
  // Removal is not part of the quote's labour figure, so it is not counted.
  assertEquals([removal.counted, removal.needs_review], [false, false]);
  assertEquals(r.quote_labour_ex, 1526);
  assertEquals(r.labour_matches_quote, true);
  assertEquals(r.totals.install_labour_ex, 1526);
  assertEquals(r.totals.removal_ex, 187.5);
  // The agreed labour is the quote's own figure.
  assertEquals(r.agreed_labour_ex, 1526);
  // Delivery is not a task on site.
  assert(!r.lines.some((l) => /delivery/i.test(l.description)));
  assertEquals(r.flags, []);
  assertEquals(r.needs_review, false);
});

Deno.test("SWF-261527: 'Root removal / hard digging, 2 hrs' saved as material is read as 2 hours, kept uncounted outside the quote's labour", () => {
  const r = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: ROOTS_2HRS_PRICING,
    costTable: COST_TABLE,
  });
  const roots = byKey(r.lines, "extra:3");
  assertEquals(
    {
      description: roots.description,
      qty: roots.qty,
      unit: roots.unit,
      hours: roots.hours,
      rate: roots.rate,
      rate_unit: roots.rate_unit,
      total: roots.total,
      counted: roots.counted,
      flags: roots.flags,
    },
    {
      description: "Root removal / hard digging",
      qty: 2,
      unit: "hrs",
      hours: 2,
      rate: 80,
      rate_unit: "hr",
      total: 160,
      counted: false,
      flags: [
        QUOTE_LINE_FLAGS.savedAsMaterial,
        QUOTE_LINE_FLAGS.outsideQuoteLabour,
      ],
    },
  );
  assertEquals(roots.needs_review, true);
  assertEquals(r.totals.install_labour_ex, 767.5);
  assertEquals(r.labour_matches_quote, true);
  assertEquals(r.totals.extras_labour_ex, 160);
  assertEquals(r.totals.removal_ex, 277.5);
  // The quote's labour figure is the install split alone: 647.5 + 120.
  assertEquals(r.agreed_labour_ex, 767.5);
  assertEquals(
    r.lines.filter((l) => l.counted).map((l) => l.line_key),
    ["install:0", "plinths"],
  );
  assertEquals(r.needs_review, true);
});

Deno.test("SWF-261525: 'Root removal, 1 job' saved as material is not guessed at: listed, flagged, not counted", () => {
  const r = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: ROOTS_ONE_JOB_PRICING,
    costTable: COST_TABLE,
  });
  const roots = byKey(r.lines, "extra:2");
  assertEquals(roots.description, "Root removal");
  assertEquals([roots.qty, roots.unit, roots.hours, roots.rate, roots.total], [
    1,
    "job",
    null,
    null,
    null,
  ]);
  assertEquals(roots.counted, false);
  assertEquals(roots.quote_cost_ex, 250);
  assertEquals(roots.flags, [QUOTE_LINE_FLAGS.labourOrMaterialUnknown]);
  const gate = byKey(r.lines, "gate:1");
  assertEquals([gate.description, gate.qty, gate.rate, gate.total], [
    "Install pedestrian gate 1000mm",
    1,
    250,
    250,
  ]);
  assertEquals(r.labour_matches_quote, true);
  assertEquals(r.agreed_labour_ex, 285);
  assertEquals(r.totals.uncertain_cost_ex, 250);
  assertEquals(r.needs_review, true);
});

Deno.test("SWF-261540: hours written only in the words are flagged, never read as hours", () => {
  const r = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: {
      line_items: [
        {
          unit: "m",
          category: "fencing",
          quantity: 10,
          description: "4× Ridgeside (10.0m total)",
        },
        {
          kind: "material",
          unit: "job",
          category: "custom",
          quantity: 1,
          cost_price: 240,
          sell_price: 330,
          description:
            "3 hours 2 trades additional for removing roots in high garden bed  ",
        },
      ],
      labourCostEstimate: 350,
    },
    costTable: COST_TABLE,
  });
  const extra = byKey(r.lines, "extra:1");
  assertEquals(extra.hours, null);
  assertEquals(extra.counted, false);
  assertEquals(extra.flags, [
    QUOTE_LINE_FLAGS.labourOrMaterialUnknown,
    QUOTE_LINE_FLAGS.hoursInWords,
  ]);
  assertEquals(r.agreed_labour_ex, 350);
  assertEquals(r.needs_review, true);
});

Deno.test("patio: the quote's labour row comes through as hours at the cost per hour, and equals the quote's labour", () => {
  const r = buildQuoteWorkOrderLines({
    jobType: "patio",
    pricing: PATIO_PRICING,
  });
  assertEquals(r.job_type, "patio");
  assertEquals(r.lines.length, 1);
  const labour = r.lines[0];
  assertEquals(
    [
      labour.description,
      labour.qty,
      labour.unit,
      labour.hours,
      labour.rate,
      labour.rate_unit,
      labour.total,
      labour.counted,
    ],
    ["Labour — 2 trades × 1.5 days", 24, "hrs", 24, 45, "hr", 1080, true],
  );
  assertEquals(labour.flags, []);
  assertEquals(r.agreed_labour_ex, 1080);
  assertEquals(r.labour_matches_quote, true);
  assertEquals(r.needs_review, false);
});

const NEW_SHAPE_ITEMS = [
  {
    unit: "m",
    category: "fencing",
    quantity: 10,
    description: "4× Ridgeside (10.0m total)",
  },
  {
    kind: "labour",
    unit: "job",
    category: "custom",
    quantity: 1,
    hours: 3,
    cost_per_hour: 80,
    cost_price: 240,
    sell_price: 390,
    description: "Root removal",
  },
  {
    kind: "labour",
    unit: "job",
    category: "custom",
    quantity: 1,
    cost_price: 150,
    description: "Reposition gate",
  },
  {
    kind: "labour",
    unit: "m",
    category: "custom",
    quantity: 4,
    cost_price: 20,
    description: "Cut sheet into existing fence",
  },
];

Deno.test("new quote shape: labour lines carrying their own hours and cost per hour count when the quote's labour includes them", () => {
  const r = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: {
      line_items: NEW_SHAPE_ITEMS,
      labourCostEstimate: 350 + 240 + 150 + 80,
    },
    costTable: COST_TABLE,
  });
  const roots = byKey(r.lines, "labour:1");
  assertEquals([
    roots.qty,
    roots.unit,
    roots.hours,
    roots.rate,
    roots.rate_unit,
    roots.total,
    roots.flags,
  ], [3, "hrs", 3, 80, "hr", 240, []]);
  // A labour line with no hours is still labour at its quoted cost, flagged
  // for the hours the trade needs.
  const gate = byKey(r.lines, "labour:2");
  assertEquals([
    gate.qty,
    gate.unit,
    gate.hours,
    gate.total,
    gate.counted,
    gate.flags,
  ], [1, "job", null, 150, true, [QUOTE_LINE_FLAGS.hoursMissing]]);
  // Priced per metre: no hours expected.
  const cut = byKey(r.lines, "labour:3");
  assertEquals([cut.qty, cut.unit, cut.total, cut.flags], [4, "m", 80, []]);
  assert(r.lines.every((l) => l.counted));
  assertEquals(r.labour_matches_quote, true);
  assertEquals(r.agreed_labour_ex, 350 + 240 + 150 + 80);
  assertEquals(r.needs_review, true);
});

Deno.test("a labour line outside the quote's labour figure is kept, uncounted and flagged for the approver", () => {
  const r = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: { line_items: NEW_SHAPE_ITEMS, labourCostEstimate: 350 },
    costTable: COST_TABLE,
  });
  assertEquals(byKey(r.lines, "install:0").counted, true);
  for (const key of ["labour:1", "labour:2", "labour:3"]) {
    const line = byKey(r.lines, key);
    assertEquals([line.counted, line.needs_review], [false, true], key);
    assert(line.flags.includes(QUOTE_LINE_FLAGS.outsideQuoteLabour), key);
  }
  assertEquals(r.agreed_labour_ex, 350);
  assertEquals(r.labour_matches_quote, true);
});

Deno.test("access: the quote's own access percent is a line, worded without the percent, and the split still equals the quote", () => {
  const r = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: {
      line_items: [
        {
          unit: "m",
          category: "fencing",
          quantity: 20,
          description: "8× Ridgeside (20.0m total)",
        },
        {
          unit: "each",
          category: "gates",
          quantity: 1,
          description: "Double swing gate 3000mm",
        },
        {
          unit: "lot",
          category: "surcharges",
          quantity: 1,
          total_sell: 250,
          description: "Access surcharge (10%)",
        },
      ],
      labourCostEstimate: (20 * 35 + 500) * 1.1,
    },
    costTable: COST_TABLE,
  });
  const access = byKey(r.lines, "access");
  assertEquals([
    access.rate,
    access.rate_unit,
    access.total,
    access.qty,
    access.unit,
  ], [10, "pct", 120, 1, "lot"]);
  assert(!/%|surcharge/i.test(access.description), access.description);
  assertEquals(byKey(r.lines, "gate:1").rate, 500);
  assertEquals(r.labour_matches_quote, true);
  assertEquals(r.agreed_labour_ex, 1320);
});

Deno.test("a cost table that no longer rebuilds the quote's labour: nothing counted, the agreed labour stays the quote's, every rate line in review", () => {
  const r = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: STRAND_PRICING,
    costTable: { ...COST_TABLE, "base-labour": 40 },
  });
  assertEquals(r.labour_matches_quote, false);
  assert(r.flags.includes(QUOTE_RESULT_FLAGS.labourDiffersFromQuote));
  assertEquals(r.agreed_labour_ex, 1526);
  // Install, plinths and removal: every line priced from the table.
  assertEquals(r.lines.length, 3);
  for (const line of r.lines) {
    assertEquals([line.counted, line.needs_review], [false, true]);
    assert(line.flags.includes(QUOTE_LINE_FLAGS.labourDiffersFromQuote));
  }
  assertEquals(r.needs_review, true);
});

Deno.test("a rate changed since the quote was frozen: its lines are in review and the split is not counted", () => {
  const removalChanged = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: STRAND_PRICING,
    costTable: COST_TABLE,
    ratesChangedSinceQuote: [FENCE_LABOUR_COST_KEYS.removeHardie],
  });
  const removal = byKey(removalChanged.lines, "removal:2");
  assertEquals([removal.counted, removal.needs_review], [false, true]);
  assert(removal.flags.includes(QUOTE_LINE_FLAGS.ratesChangedSinceQuote));
  // The install split's own rates are unchanged, so it still counts.
  assertEquals(byKey(removalChanged.lines, "install:0").counted, true);
  assert(
    removalChanged.flags.includes(QUOTE_RESULT_FLAGS.ratesChangedSinceQuote),
  );
  assertEquals(removalChanged.agreed_labour_ex, 1526);

  const installChanged = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: STRAND_PRICING,
    costTable: COST_TABLE,
    ratesChangedSinceQuote: [FENCE_LABOUR_COST_KEYS.installPerMetre],
  });
  const install = byKey(installChanged.lines, "install:0");
  assertEquals([install.counted, install.needs_review], [false, true]);
  assert(install.flags.includes(QUOTE_LINE_FLAGS.ratesChangedSinceQuote));
  assert(installChanged.lines.every((l) => !l.counted));
  // The whole split is unverified; only the install line used the changed row.
  const plinths = byKey(installChanged.lines, "plinths");
  assertEquals([plinths.needs_review, plinths.flags], [true, [
    QUOTE_LINE_FLAGS.labourSplitUnverified,
  ]]);
  assert(install.flags.includes(QUOTE_LINE_FLAGS.labourSplitUnverified));
  // Removal uses its own row, which did not change.
  const unchangedRemoval = byKey(installChanged.lines, "removal:2");
  assertEquals([unchangedRemoval.needs_review, unchangedRemoval.flags], [
    false,
    [QUOTE_LINE_FLAGS.quoteCountedAsMaterials],
  ]);
  assertEquals(installChanged.labour_matches_quote, null);
  assertEquals(installChanged.agreed_labour_ex, 1526);
  assertEquals(installChanged.needs_review, true);
});

Deno.test("a custom labour line is outside the quote's labour only when the split proves it", () => {
  // The quoting tools' new format: install 10 m x 35 = 350, root removal
  // 2 hrs x 80 = 160, labourCostEstimate 510.
  const pricing = (labourCostEstimate: number) => ({
    line_items: [
      {
        unit: "m",
        category: "fencing",
        quantity: 10,
        description: "4× Ridgeside (10.0m total)",
      },
      {
        kind: "labour",
        unit: "hrs",
        category: "custom",
        quantity: 2,
        hours: 2,
        cost_per_hour: 80,
        description: "Root removal",
      },
    ],
    labourCostEstimate,
  });
  const counted = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: pricing(510),
    costTable: COST_TABLE,
  });
  assert(counted.lines.every((l) => l.counted));
  assertEquals(byKey(counted.lines, "labour:1").flags, []);
  assertEquals(counted.agreed_labour_ex, 510);

  const cases: Array<[string, Parameters<typeof buildQuoteWorkOrderLines>[0]]> =
    [
      ["mismatch", {
        jobType: "fencing",
        pricing: pricing(600),
        costTable: COST_TABLE,
      }],
      ["install rate changed", {
        jobType: "fencing",
        pricing: pricing(510),
        costTable: COST_TABLE,
        ratesChangedSinceQuote: [FENCE_LABOUR_COST_KEYS.installPerMetre],
      }],
      ["no labour figure", {
        jobType: "fencing",
        pricing: { line_items: pricing(510).line_items },
        costTable: COST_TABLE,
      }],
    ];
  for (const [label, input] of cases) {
    const r = buildQuoteWorkOrderLines(input);
    const roots = byKey(r.lines, "labour:1");
    assertEquals(roots.counted, false, label);
    assertEquals(roots.needs_review, true, label);
    assert(roots.flags.includes(QUOTE_LINE_FLAGS.labourUnverified), label);
    assert(!roots.flags.includes(QUOTE_LINE_FLAGS.outsideQuoteLabour), label);
    const install = byKey(r.lines, "install:0");
    assertEquals([install.counted, install.needs_review], [false, true], label);
    assert(
      install.flags.includes(QUOTE_LINE_FLAGS.labourSplitUnverified),
      label,
    );
  }
});

Deno.test("a quote with no labour figure: lines only, no agreed labour, flagged", () => {
  const { labourCostEstimate: _l, internal: _i, ...noLabour } = STRAND_PRICING;
  const r = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: noLabour,
    costTable: COST_TABLE,
  });
  assert(r.lines.length > 0);
  assert(r.lines.every((l) => !l.counted));
  assertEquals(r.agreed_labour_ex, null);
  assert(r.flags.includes(QUOTE_RESULT_FLAGS.quoteLabourMissing));
  assertEquals(r.needs_review, true);
});

Deno.test("a missing rate leaves the line uncounted and flagged", () => {
  const r = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: STRAND_PRICING,
    costTable: {},
  });
  for (const line of r.lines) {
    assertEquals(line.counted, false);
    assertEquals(line.total, null);
    assert(line.flags.includes(QUOTE_LINE_FLAGS.rateMissing));
  }
  assertEquals(r.agreed_labour_ex, 1526);
  assertEquals(r.labour_matches_quote, null);
  assertEquals(r.needs_review, true);
});

Deno.test("removal: asbestos is flagged as licensed work; its certificate is a fee, not a task", () => {
  const r = buildQuoteWorkOrderLines({
    jobType: "fencing",
    pricing: {
      line_items: [
        {
          unit: "m",
          category: "fencing",
          quantity: 10,
          description: "4× Ridgeside (10.0m total)",
        },
        {
          unit: "m",
          category: "removal",
          quantity: 10,
          description: "Remove asbestos fence (licenced)",
        },
        {
          unit: "job",
          category: "removal",
          quantity: 1,
          description: "Asbestos removal certificate",
        },
        {
          unit: "m",
          category: "removal",
          quantity: 6,
          description: "Remove timber/lap fence",
        },
      ],
      labourCostEstimate: 350,
    },
    costTable: COST_TABLE,
  });
  const removals = r.lines.filter((l) => l.basis === "removal");
  assertEquals(removals.map((l) => [l.description, l.total]), [[
    "Remove asbestos fence (licenced)",
    650,
  ], ["Remove timber/lap fence", 120]]);
  assert(removals[0].flags.includes(QUOTE_LINE_FLAGS.licensedRemoval));
  assertEquals(r.needs_review, true);
});

Deno.test("nothing to read: no lines, no agreed amount, flagged", () => {
  for (
    const pricing of [null, {}, { line_items: [] }, {
      line_items: [{
        category: "delivery",
        quantity: 1,
        description: "Delivery",
      }],
    }]
  ) {
    const r = buildQuoteWorkOrderLines({
      jobType: "fencing",
      pricing,
      costTable: COST_TABLE,
    });
    assertEquals(r.lines, []);
    assertEquals(r.agreed_labour_ex, null);
    assert(r.flags.includes(QUOTE_RESULT_FLAGS.noQuoteLines));
  }
  const other = buildQuoteWorkOrderLines({
    jobType: "decking",
    pricing: STRAND_PRICING,
  });
  assert(other.flags.includes(QUOTE_RESULT_FLAGS.unsupportedJobType));
});

Deno.test("the fence run line is reworded so the trade view never withholds it", () => {
  assertEquals(
    fenceInstallDescription("16× Ridgeside (37.6m total)"),
    "Install Ridgeside fence (16 panels)",
  );
  assertEquals(
    fenceInstallDescription("1× Superdek (1.0m total)"),
    "Install Superdek fence (1 panel)",
  );
  assertEquals(
    fenceInstallDescription("Colorbond run (12m)"),
    "Install Colorbond run",
  );
  assertEquals(fenceInstallDescription(""), "Install fence");
});

Deno.test("trade view of the filled lines: hours and quantities, no dollars, no line withheld", () => {
  const lines = [
    ...buildQuoteWorkOrderLines({
      jobType: "fencing",
      pricing: STRAND_PRICING,
      costTable: COST_TABLE,
    }).lines,
    ...buildQuoteWorkOrderLines({
      jobType: "fencing",
      pricing: ROOTS_2HRS_PRICING,
      costTable: COST_TABLE,
    }).lines,
    ...buildQuoteWorkOrderLines({
      jobType: "fencing",
      pricing: ROOTS_ONE_JOB_PRICING,
      costTable: COST_TABLE,
    }).lines,
    ...buildQuoteWorkOrderLines({ jobType: "patio", pricing: PATIO_PRICING })
      .lines,
  ];
  const view = projectTradeJobWorkOrder(
    {
      id: "wo",
      wo_number: "WO-SWF-1",
      status: "approved",
      job_id: "job",
      scope_items: lines,
      special_instructions: null,
    },
    { job_number: "SWF-1", type: "fencing" },
    tradeJobWorkOrderRedaction,
  );
  const items = view.scope_items as any[];
  assertEquals(items.length, lines.length);
  for (const item of items) {
    assertEquals(
      Object.keys(item).sort().filter((k) =>
        !["description", "qty", "unit", "hours"].includes(k)
      ),
      [],
    );
    assert(!/withheld/i.test(String(item.description)), JSON.stringify(item));
  }
  assertEquals(items.find((i) => /hard digging/.test(i.description)), {
    description: "Root removal / hard digging",
    qty: 2,
    unit: "hrs",
    hours: 2,
  });
  assertEquals(items.find((i) => /Ridgeside fence \(16/.test(i.description)), {
    description: "Install Ridgeside fence (16 panels)",
    qty: 37.6,
    unit: "m",
    hours: null,
  });
  assertEquals(items.find((i) => /^Labour/.test(i.description)), {
    description: "Labour — 2 trades × 1.5 days",
    qty: 24,
    unit: "hrs",
    hours: 24,
  });
  const text = JSON.stringify(items);
  for (
    const leak of [
      "$",
      "1316",
      "1080",
      "rate",
      "total",
      "quote_cost_ex",
      "flags",
      "counted",
      "needs_review",
    ]
  ) {
    assert(!text.includes(leak), `trade view leaked ${leak}: ${text}`);
  }
});

Deno.test("the cost keys read are the fence tool's own cost table keys", () => {
  assertEquals(
    FENCE_LABOUR_COST_ITEM_KEYS.length,
    Object.keys(FENCE_LABOUR_COST_KEYS).length,
  );
  for (const key of FENCE_LABOUR_COST_ITEM_KEYS) assert(key in COST_TABLE, key);
});
