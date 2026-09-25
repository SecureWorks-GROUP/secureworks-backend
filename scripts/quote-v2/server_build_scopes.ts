// Quote v2 stage 3 proof scopes: what a scoping tool or the terminal sends to
// `quote-v2?action=build` for the three real jobs, plus one price book job
// that exercises cut to order and a scoper's markup. First names and suburbs
// only. The jobs are local test rows; nothing here touches production.

import type { ScopeInput } from "../../supabase/functions/quote-v2/scope_build.ts";

export const GWELUP_JOB = "00000000-0000-4000-8000-000000261423";
export const SWP_JOB = "00000000-0000-4000-8000-000000026051";
export const KIKO_JOB = "00000000-0000-4000-8000-00000000c1c0";
export const PB_DEMO_JOB = "00000000-0000-4000-8000-0000000000b0";

const ownerSell = (unit: number, at = "2026-09-17T08:00:00+08:00") => ({
  basis: "stated",
  kind: "owner",
  unit_sell_ex_gst: unit,
  stated_by: "marnin",
  stated_at: at,
});

/** Gwelup SWF-261423, the 17 Sep shape: 50/50 on every line. */
export const GWELUP: ScopeInput = {
  family: "fencing",
  scope: {
    title: "Colorbond boundary fence",
    summary:
      "Replace the shared Hardie fence with 22 m of Colorbond, Woodland Grey 1800 Sameside, on retaining plinths.",
    exclusions: ["Root removal (neighbour only, priced separately)"],
  },
  parties: [
    {
      ref: "c",
      role: "client",
      display_name: "Stephen",
      share_rule: "equal",
      share_bp: 5000,
    },
    {
      ref: "n",
      role: "neighbour",
      display_name: "Fiona",
      share_rule: "equal",
      share_bp: 5000,
    },
  ],
  items: [
    {
      key: "fence",
      description: "Colorbond fence 1800 Woodland Grey, Sameside",
      qty: 22,
      unit: "lm",
      sell: ownerSell(125),
    },
    {
      key: "plinths",
      description: "Retaining plinths",
      qty: 9,
      unit: "each",
      sell: ownerSell(80),
    },
    {
      key: "removal",
      description: "Remove existing Hardie fence",
      qty: 22,
      unit: "lm",
      sell: ownerSell(30),
    },
    {
      key: "delivery",
      description: "Delivery",
      qty: 1,
      unit: "delivery",
      sell: ownerSell(200),
    },
  ],
};

const tool = "patio-tool pricing_json generated 2026-04-02T05:23:10.383Z";
const swpLine = (
  key: string,
  description: string,
  qty: number,
  unit: string,
  cost: number,
  sell: number,
) => ({
  key,
  description,
  qty,
  unit,
  cost: { source: "tool", unit_cost_ex_gst: cost, evidence: tool },
  sell: ownerSell(sell, "2026-04-02T05:23:10.383Z"),
});

/** Canning Vale SWP-26051 at the patio tool's costs and sells, without the
 * gutter beam counted twice. */
export const SWP_26051: ScopeInput = {
  family: "patio",
  scope: {
    title: "12.5 m x 5.5 m gable patio",
    summary:
      "SpanPlus 330 roof in Classic Cream, Manor Red steel, fascia connection.",
  },
  parties: [{
    ref: "c",
    role: "client",
    display_name: "Margaret",
    share_rule: "sole",
    share_bp: 10000,
  }],
  items: [
    swpLine("posts", "Posts 90×90×2", 5, "each", 145.55, 181.938),
    swpLine("kwikset", "Kwikset Concrete (5 bags/post)", 25, "bag", 5, 6.25),
    swpLine("gutter-beam", "Gutter Beam 100×50×2", 1, "stock", 195, 243.75),
    swpLine("fascia-beam", "Fascia Beam 100×50×2", 1, "stock", 240, 300),
    swpLine(
      "trusses",
      "Trusses 76×38×1.6 (risers welded, 200H×300V)",
      8,
      "each",
      702.7075,
      878.385,
    ),
    swpLine("purlins", "Purlins 76×38×1.6 RHS", 6, "stock", 248, 310),
    swpLine("fascia-brackets", "Fascia Brackets", 4, "each", 12, 15),
    swpLine(
      "spanplus",
      "SpanPlus 330 Sheets, last sheet cut to 290mm",
      235.6,
      "lm",
      12.04,
      15.05,
    ),
    swpLine("ridge-cap", "Ridge Cap", 8, "lm", 24, 30),
    swpLine("patio-gutter", "Patio Gutter", 6.5, "lm", 22, 27.5),
    swpLine(
      "downpipes",
      "Downpipes 95×45mm (2×1800mm + clip each)",
      2,
      "each",
      79.99,
      99.97,
    ),
    swpLine("gable-barges", "Gable Barges", 26, "lm", 24, 30),
    swpLine(
      "gable-infill",
      "Gable Infill, Colorbond",
      2,
      "each",
      132.86,
      166.075,
    ),
    swpLine("fascia-board", "Fascia Board (House Wall)", 8, "lm", 24, 30),
    swpLine(
      "fixings",
      "Fixings (screws, anchors, silicone, foam)",
      68.4,
      "m2",
      2.5,
      3.13,
    ),
    swpLine("demolition", "Demolition + Disposal", 1, "item", 1040, 1850),
    swpLine("labour", "Labour, 2 trades x 5 days", 80, "hour", 45, 110),
  ],
};

const e426 = "Stratco estimate E426 TB-WA-20260916-426, 16/09/2026";

/** Kiko, Balcatta: Stratco cost x the family default 1.4, rounded by the
 * owner to $5,260 ex. */
export const KIKO: ScopeInput = {
  family: "stratco",
  scope: {
    title: "Aluminium slat screens and gate",
    summary:
      "Nine void-infill slat bays (14.1 m, 711 high, Quickscreen 65, 15 mm gap) and one pedestrian swing gate for the 1700 opening.",
    exclusions: [
      "Gate latch and hinges",
      "Fixings into existing pillars",
      "Delivery",
    ],
  },
  parties: [{
    ref: "c",
    role: "client",
    display_name: "Kiko",
    share_rule: "sole",
    share_bp: 10000,
  }],
  items: [
    {
      key: "bays-materials",
      description: "Slat bays, cut to size",
      qty: 1,
      unit: "lot",
      cost: {
        source: "stated",
        unit_cost_ex_gst: 2015.44,
        evidence: e426,
      },
    },
    {
      key: "bays-labour",
      description: "Install slat bays",
      qty: 14.115,
      unit: "lm",
      cost: {
        source: "stated",
        unit_cost_ex_gst: 50,
        evidence: "labour $50/m (hold H4, provisional)",
      },
    },
    {
      key: "gate-materials",
      description: "Pedestrian swing gate",
      qty: 1,
      unit: "lot",
      cost: {
        source: "stated",
        unit_cost_ex_gst: 737.63,
        evidence: e426,
      },
    },
    {
      key: "gate-labour",
      description: "Install gate",
      qty: 1,
      unit: "each",
      cost: {
        source: "stated",
        unit_cost_ex_gst: 300,
        evidence: "labour $300 per gate (hold H4, provisional)",
      },
    },
    {
      key: "rounding",
      description: "Rounding",
      sell: {
        basis: "adjustment",
        amount_ex_gst: -2.35,
        stated_by: "marnin",
        stated_at: "2026-09-17T12:00:00+08:00",
      },
      note: "Quoted as $5,260 ex (cost x 1.4 = $5,262.35)",
    },
  ],
};

/** A price book job: steel beams bought through cut to order, costed at the
 * price of each length bought, with the scoper's own markup on the beams. */
export const PB_DEMO: ScopeInput = {
  family: "patio",
  scope: {
    title: "Test: price book beams and posts",
    summary: "Local proof job for the price book path. Not a real quote.",
  },
  parties: [{
    ref: "c",
    role: "client",
    display_name: "Test",
    share_rule: "sole",
    share_bp: 10000,
  }],
  items: [
    {
      key: "beams",
      description: "Beam 100×50×2",
      price_book: {
        item_key: "steel-rhs-100x50x2",
        cut: {
          pieces: [{ length_mm: 6000, qty: 1 }, { length_mm: 4800, qty: 2 }],
        },
      },
      markup: { multiplier: 1.3, reason: "steel beams, scoper's call" },
    },
    {
      key: "posts",
      description: "Posts 90×90×2",
      qty: 4,
      price_book: { item_key: "patio-post-90x90" },
    },
  ],
};
