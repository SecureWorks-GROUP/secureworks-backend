// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  fenceCostPrices,
  fenceSellDefaults,
  patioHardcoded,
  type SourceRefs,
  wikiSupplierCsv,
} from "./price_book_sources.ts";
import { resolveObservation, slug } from "./price_book_catalog.ts";
import { buildPlan, planSql, summarise } from "./price_book_plan.ts";
import { assertLocalDatabase } from "./price_book_import.ts";

const REFS: SourceRefs = {
  fenceCommit: "f1",
  patioCommit: "p1",
  wikiCommit: "w1",
  backendCommit: "b1",
};

const FENCE_HTML = `
    // Updated 2026-03-19 — aligned with actual R&R Fencing supplier pricing
    const COST_PRICES = {
      panelKit1800_2400: 88,   // 1800H colorbond panel (2380mm wide) inc post — blessed 2026-06-12 $88
      concrete: 8.00,          // per bag — blessed 2026-06-12 $8
      delivery: 95             // actual delivery cost — R&R charges ~$95
    };
    const pricePerMetre = job.pricePerMetre || 125;
    const plinthSell = q.plinthPrice || 80;
`;

const PATIO_HTML = `
        const RATES_VERSION = '2026-06-13';
        const DEFAULT_RATES = {
            '100×50×2 RHS':    30.00,
            '65×65×2 SHS':      0.00,
            'Ridge Cap':       10.50,
        };
        const STEEL_STOCK_LENGTHS_BY_SIZE = {
            '100×50×2':   [5500, 6500, 8000],
        };
        const DEFAULT_SELL_MARKUP = 1.35;
`;

const BD_CSV =
  `supplier,item_description,unit,qty_context,unit_cost_ex_gst,invoice_ref,invoice_date,source,confidence,notes
BD Metals,100x50x2mm RHS powdercoated Surfmist - 6.5m length,EA (6.5m length),1,168.1818,Tax Invoice 00023259,2026-03-09,x,medium,"STAGED FOR MARNIN BLESSING"
BD Metals,Span Plus roof sheeting,line,1,1190.9091,Tax Invoice 00023259,2026-03-09,x,medium,""
BD Metals,FREIGHT / delivery to site (Bayswater),per delivery,1,172.7273,Tax Invoice 00023259,2026-03-09,x,medium,""
`;

const RNR_CSV =
  `supplier,item_description,unit,qty_context,unit_cost_ex_gst,invoice_ref,invoice_date,source,confidence,notes
R&R Fencing,"DELIVERY DATE: THURSDAY | GOING TO: 9 EXAMPLE GREEN, SOMEWHERE WA",each,1,86.3636,INV-1,2026-04-16,x,high,""
R&R Fencing,COLORBOND PANEL H1800mm X W2380mm INC 2400mm POSTS,each,1,88.1818,INV-2,2026-05-19,x,high,""
`;

const CMI_CSV =
  `supplier,item_description,unit,qty_context,unit_cost_ex_gst,invoice_ref,invoice_date,source,confidence,notes
CMI,FL211SM 0.55 CB FLASH 100 C WITH 1 B Surfmist,MTR,1,4.7600,Sales Invoice PSI-1,2026-06-05,x,high,""
CMI,FL212SM 0.55 CB FLASH 150 C WITH 1 B Surfmist,MTR,1,6.4800,Sales Invoice PSI-1,2026-06-05,x,high,""
CMI,FL222SM 0.55 CB FLASH 150 C WITH 2 B Surfmist,MTR,1,7.8000,Sales Invoice PSI-1,2026-06-05,x,high,""
`;

const STRATCO_CSV =
  `supplier,item_description,unit,qty_context,unit_cost_ex_gst,invoice_ref,invoice_date,source,confidence,notes,supplier_sku,basis,as_at,blessed,stock_length_mm,item_key
Stratco,Quickscreen slat 65 x 16.5 cut to size Colour,lm,1,13.08,TB-WA-20260916-426,2026-09-16,x,high,E426 unblessed,SC-10315,estimate,2026-09-16,,6100,qs-slat-65-col-lm
Stratco,Quickscreen slat 65 x 16.5 group S Colour,lm,1,8.25,form-S-2026-04-01,2026-04-01,x,high,never price form-S,,,2026-04-01,,6100,qs-slat-65-col-lm
`;

function all() {
  return [
    ...fenceCostPrices(FENCE_HTML, REFS),
    ...fenceSellDefaults(FENCE_HTML, REFS),
    ...patioHardcoded(PATIO_HTML, REFS),
    ...wikiSupplierCsv("bd-metals.csv", BD_CSV, REFS),
    ...wikiSupplierCsv("rnr-fencing.csv", RNR_CSV, REFS),
    ...wikiSupplierCsv("cmi.csv", CMI_CSV, REFS),
    ...wikiSupplierCsv("stratco-cts.csv", STRATCO_CSV, REFS),
  ];
}

Deno.test("fence COST_PRICES: dated by its blessing comment, blessing reported not trusted", () => {
  const obs = fenceCostPrices(FENCE_HTML, REFS);
  const panel = obs.find((o) => o.source_key === "panelKit1800_2400")!;
  assertEquals(panel.value, 88);
  assertEquals(panel.as_at, "2026-06-12");
  assertEquals(panel.claimed_blessed, "2026-06-12");
  const delivery = obs.find((o) => o.source_key === "delivery")!;
  assertEquals(delivery.supplier, "R&R Fencing");
  assertEquals(delivery.as_at, "2026-03-19");
  const sql = planSql(buildPlan(obs));
  assertEquals(sql.includes("blessed_by"), false);
});

Deno.test("sell rates are reported, never loaded or turned into a cost", () => {
  const plan = buildPlan(all());
  assertEquals(plan.legacySell.map((o) => [o.source_key, o.value]), [[
    "pricePerMetre",
    125,
  ], ["plinthPrice", 80]]);
  for (const c of plan.costs) {
    assertEquals(c.store === "s02_fence_sell_defaults", false);
    assertEquals(c.cost_ex_gst === 125 || c.cost_ex_gst === 80, false);
  }
});

Deno.test("a 6.5 m length on an invoice becomes $/LM on the canonical steel item, with its length", () => {
  const bd = wikiSupplierCsv("bd-metals.csv", BD_CSV, REFS)[0];
  const r = resolveObservation(bd);
  if ("unresolved" in r) throw new Error(r.unresolved);
  assertEquals(r.item.item_key, "steel-rhs-100x50x2");
  assertEquals(r.value, 25.8741);
  assertEquals(r.per_length_mm, 6500);
  assertEquals(r.conversion, "$168.18 per 6.5 m length = $25.87/LM");
});

Deno.test("tool constant and invoice for the same steel land on one item; the stock list rides along", () => {
  const plan = buildPlan(all());
  const costs = plan.costs.filter((c) => c.item_key === "steel-rhs-100x50x2");
  assertEquals(costs.map((c) => c.evidence_kind).sort(), [
    "invoice",
    "tool_constant",
  ]);
  assertEquals(
    plan.stock.find((s) => s.item_key === "steel-rhs-100x50x2")?.lengths_mm,
    [5500, 6500, 8000],
  );
  assertEquals(
    plan.cuts.find((c) => c.item_key === "steel-rhs-100x50x2")?.rule,
    "one_per_stick",
  );
});

Deno.test("cost fingerprint distinguishes length and evidence changes", () => {
  const source = wikiSupplierCsv("bd-metals.csv", BD_CSV, REFS)[0];
  const original = { ...source, evidence_ref: "same", as_at: "2026-03-09" };
  const differentLength = { ...original, per_length_mm: 8000 };
  const differentEvidence = {
    ...original,
    evidence_kind: "purchase_order" as const,
  };
  const plan = buildPlan([original, differentLength, differentEvidence]);
  const matches = plan.costs.filter((c) => c.item_key === "steel-rhs-100x50x2");
  assertEquals(matches.length, 3);
  assertEquals(new Set(matches.map((c) => c.fingerprint)).size, 3);
});

Deno.test("stock and allowance fingerprints include selection dates and evidence", () => {
  const stock = patioHardcoded(PATIO_HTML, REFS).find((o) =>
    o.kind === "stock_lengths" && o.stock_lengths_mm?.length
  )!;
  const stockPlan = buildPlan([
    stock,
    { ...stock, as_at: "2026-06-14" },
  ]);
  assertEquals(new Set(stockPlan.stock.map((s) => s.fingerprint)).size, 2);

  const allowanceSource = {
    store: "s07_patio_engine_snapshot",
    kind: "cost",
    source_key: "fixings",
    description: "Fixings",
    family: "patio",
    source_unit: "m2",
    value: 7.25,
    supplier: "CMI",
    as_at: "2026-06-13",
    evidence_kind: "tool_constant",
    evidence_ref: "same",
  } as const;
  const allowancePlan = buildPlan([
    allowanceSource,
    {
      ...allowanceSource,
      evidence_kind: "invoice",
      evidence_ref: allowanceSource.evidence_ref,
    },
    { ...allowanceSource, as_at: "2026-06-14" },
  ]);
  assertEquals(
    new Set(allowancePlan.allowances.map((a) => a.fingerprint)).size,
    3,
  );
});

Deno.test("a $0 sentinel creates an unpriced item and no cost row", () => {
  const plan = buildPlan(all());
  assertEquals(
    plan.items.some((i) => i.item_key === "steel-shs-65x65x2"),
    true,
  );
  assertEquals(
    plan.costs.some((c) => c.item_key === "steel-shs-65x65x2"),
    false,
  );
  assertEquals(
    plan.zeroSentinels.some((z) => z.item_key === "steel-shs-65x65x2"),
    true,
  );
  assertEquals(plan.costs.every((c) => c.cost_ex_gst > 0), true);
});

Deno.test("delivery lines never carry the street address; compound lines are excluded", () => {
  const rnr = wikiSupplierCsv("rnr-fencing.csv", RNR_CSV, REFS);
  assertEquals(rnr[0].description, "R&R Fencing delivery (address withheld)");
  const plan = buildPlan(all());
  const sql = planSql(plan);
  assertEquals(/EXAMPLE GREEN|Bayswater/i.test(sql), false);
  assertEquals(
    plan.excluded.some((o) => /compound/.test(o.excluded_reason ?? "")),
    true,
  );
  assertEquals(
    plan.costs.find((c) =>
      c.item_key === "fence-delivery-rr" && c.store === "s10_wiki_supplier_csv"
    )?.cost_ex_gst,
    86.3636,
  );
});

Deno.test("R&R panel invoice joins the tool's 2380-wide panel kit", () => {
  const plan = buildPlan(all());
  const keys = plan.costs.filter((c) =>
    c.item_key === "fence-panel-kit-h1800-w2380-post2400"
  )
    .map((c) => c.evidence_kind).sort();
  assertEquals(keys, ["invoice", "tool_constant"]);
});

Deno.test("Stratco: cut-to-size rows carry their stock length; the form-S rate is never priced", () => {
  const plan = buildPlan(all());
  const slat = plan.costs.filter((c) =>
    c.item_key === "stratco-qs-slat-65-col-lm"
  );
  assertEquals(slat.map((c) => c.cost_ex_gst), [13.08]);
  assertEquals(plan.excluded.some((o) => o.value === 8.25), true);
  assertEquals(
    plan.stock.find((s) => s.item_key === "stratco-qs-slat-65-col-lm")
      ?.lengths_mm,
    [6100],
  );
  assertEquals(
    plan.cuts.find((c) => c.item_key === "stratco-qs-slat-65-col-lm")?.rule,
    "cut_to_size",
  );
});

Deno.test("flashing girth bands average the newest rate per girth item in the band", () => {
  const plan = buildPlan(all());
  const bands = plan.allowances.filter((a) =>
    a.basis === "per_lm_by_girth_band"
  )
    .map((a) => [a.girth_min_mm, a.girth_max_mm, a.cost_ex_gst]);
  assertEquals(bands, [[0, 100, 4.76], [101, 150, 7.14]]);
  const fallback = plan.allowances.find((a) =>
    a.allowance_key === "flashing-unknown-girth"
  );
  assertEquals(fallback?.cost_ex_gst, 10.5);
});

Deno.test("the SQL is append-only, idempotent and quotes safely", () => {
  const sql = planSql(buildPlan(all()));
  assertEquals(/\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/i.test(sql), false);
  const inserts = sql.split("\n").filter((l) => l.startsWith("INSERT"));
  assertEquals(inserts.every((l) => /ON CONFLICT/.test(l)), true);
  assertEquals(sql.includes("R&R Fencing"), true);
  const withQuote = planSql(buildPlan(fenceCostPrices(
    `// Updated 2026-03-19\nconst COST_PRICES = {\n  oddItem: 5 // O'Brien's rate\n};`,
    REFS,
  )));
  assertEquals(withQuote.includes("O''Brien''s"), true);
});

Deno.test("every generated item key satisfies the database key rule", () => {
  const plan = buildPlan(all());
  const rule = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
  for (const i of plan.items) {
    assertEquals(rule.test(i.item_key), true, i.item_key);
  }
  for (
    const nasty of [
      ".42 MONUMENT CORODEK",
      "D&D HEAVY DUTY (PAIR)",
      "0.42mm x 3.0m",
      "--x..y--",
    ]
  ) {
    assertEquals(rule.test(slug(nasty)), true, slug(nasty));
  }
});

Deno.test("summary counts are consistent with the plan", () => {
  const plan = buildPlan(all());
  const s = summarise(plan);
  assertEquals(s.cost_rows, plan.costs.length);
  assertEquals(s.legacy_sell_rates, 2);
  assertEquals(
    s.unpriced_items,
    plan.items.filter((i) => !plan.costs.some((c) => c.item_key === i.item_key))
      .length,
  );
});

Deno.test("--apply only ever targets a localhost database", () => {
  assertEquals(
    assertLocalDatabase("postgresql://postgres@127.0.0.1:5432/scratch"),
    "postgresql://postgres@127.0.0.1:5432/scratch",
  );
  assertEquals(
    assertLocalDatabase("postgres://u:p@localhost:5433/x"),
    "postgres://u:p@localhost:5433/x",
  );
  for (
    const bad of [
      undefined,
      "postgresql://postgres@db.abcdefgh.supabase.co:5432/postgres",
      "postgresql://postgres@127.0.0.1.evil.example:5432/x",
      "postgresql://postgres@10.0.0.5:5432/x",
      "postgresql://postgres@localhost:5432/postgres?host=remote.example",
      "postgresql://postgres@localhost:5432/postgres?hostaddr=203.0.113.10",
      "postgresql://postgres@localhost:5432/postgres?service=production",
      "postgresql://localhost,remote.example/postgres",
    ]
  ) {
    assertThrows(() => assertLocalDatabase(bad));
  }
});
