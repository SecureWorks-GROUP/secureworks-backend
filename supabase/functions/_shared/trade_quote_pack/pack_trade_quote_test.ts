import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyInstallerRates,
  assembleQuotePacksForTrade,
  packTradeQuote,
  persistTradePackOnDocuments,
  stripTradePackMoney,
  tradePackMoneyLeakKeys,
  TRADE_INSTALLER_RATES,
  HENRY_INSTALLER_RATES,
} from "./pack_trade_quote.ts";

const FENCE_SCOPE = {
  job: {
    colour: "Shale Grey",
    profile: "Trimclad",
    supplier: "RNR",
    runs: [
      {
        name: "Rear",
        length: 19,
        sheetHeight: 1800,
        panels: [
          { height: 1800, retaining: 0 },
          { height: 1800, retaining: 300 },
        ],
      },
      { name: "LHS", length: 8.5, sheetHeight: 1800, panels: [{ height: 1800, retaining: 0 }] },
    ],
    gates: [{ type: "pedestrian", width: 900 }],
    removal: { existingFenceType: "colourbond", existingFenceLength: 12 },
    notes: { noteWorkOrder: "Watch the dog. Access via side gate." },
  },
  notes: { noteWorkOrder: "Watch the dog. Access via side gate." },
};

const FENCE_PRICING = {
  totalIncGST: 18400,
  margin_pct: 32,
  job_description: "27m Colorbond Fencing — 1800mm Shale Grey — $18,400",
  line_items: [
    { description: "Shale Grey Trimclad fencing", quantity: 27.5, unit: "m", total_sell: 3437.5, category: "fencing" },
    { description: "Remove Colorbond fence", quantity: 12, unit: "m", total_sell: 240, category: "removal" },
  ],
};

Deno.test("fencing pack: runs, plinths, gate, colorbond removal, no client money", () => {
  const pack = packTradeQuote({
    quote_number: "SWF-25101-Q2",
    job_document_id: "doc-2",
    sent_at: "2026-09-04T07:00:00.000Z",
    job_type: "fencing",
    scope_json: FENCE_SCOPE,
    pricing_json: FENCE_PRICING,
  });
  assertEquals(pack.quote_number, "SWF-25101-Q2");
  assertEquals(pack.job_type, "fencing");
  const kinds = pack.items.map((i) => i.kind);
  assertEquals(kinds.includes("install_m"), true);
  assertEquals(kinds.includes("plinth"), true);
  assertEquals(kinds.includes("gate_pedestrian"), true);
  assertEquals(kinds.includes("removal_m"), true);
  assertEquals(kinds.includes("note"), true);
  const rear = pack.items.find((i) => i.kind === "install_m" && /Rear/.test(i.description));
  assertEquals(rear?.quantity, 19);
  const removal = pack.items.find((i) => i.kind === "removal_m");
  assertEquals(removal?.quantity, 12);
  assertEquals(tradePackMoneyLeakKeys(pack), []);
  assertEquals(pack.items.every((i) => i.unit_price == null), true);
});

Deno.test("fencing trade rates: $30/m, $10 plinth, $10 removal, $250 gate", () => {
  const packed = packTradeQuote({
    quote_number: "Q1",
    job_type: "fencing",
    scope_json: FENCE_SCOPE,
    pricing_json: FENCE_PRICING,
  });
  const rated = applyInstallerRates(packed, false);
  const install = rated.items.find((i) => i.kind === "install_m" && /Rear/.test(i.description));
  assertEquals(install?.unit_price, TRADE_INSTALLER_RATES.install_m);
  assertEquals(install?.line_total, 19 * 30);
  const plinth = rated.items.find((i) => i.kind === "plinth");
  assertEquals(plinth?.unit_price, 10);
  const removal = rated.items.find((i) => i.kind === "removal_m");
  assertEquals(removal?.unit_price, 10);
  const gate = rated.items.find((i) => i.kind === "gate_pedestrian");
  assertEquals(gate?.unit_price, 250);
  assertEquals(tradePackMoneyLeakKeys(rated), []);
});

Deno.test("Henry overlay: plinth $12.50, install and removal rates stay blank", () => {
  const packed = packTradeQuote({
    quote_number: "Q1",
    job_type: "fencing",
    scope_json: FENCE_SCOPE,
    pricing_json: FENCE_PRICING,
  });
  const rated = applyInstallerRates(packed, true);
  const install = rated.items.find((i) => i.kind === "install_m");
  assertEquals(install?.unit_price, HENRY_INSTALLER_RATES.install_m);
  assertEquals(install?.line_total, null);
  const plinth = rated.items.find((i) => i.kind === "plinth");
  assertEquals(plinth?.unit_price, 12.5);
  const removal = rated.items.find((i) => i.kind === "removal_m");
  assertEquals(removal?.unit_price, null);
});

Deno.test("patio pack: description only, no labour amounts", () => {
  const pack = applyInstallerRates(packTradeQuote({
    quote_number: "SWP-25099-Q1",
    job_type: "patio",
    scope_json: {
      config: {
        length: 6,
        projection: 3,
        roofStyle: "flat",
        roofing: "solarspan75",
        sheetColor: { name: "Monument" },
        connection: "fascia",
        posts: 4,
        beams: 2,
      },
      notes: { noteWorkOrder: "Mind the pool fence." },
    },
    pricing_json: {
      job_description: "6m × 3m flat SolarSpan 75mm — $22,000 inc GST",
      totalIncGST: 22000,
      labourCostEstimate: 1800,
      line_items: [{ description: "Labour", total_sell: 4400, category: "labour" }],
    },
  }), false);
  assertEquals(pack.job_type, "patio");
  assertEquals(pack.items.every((i) => i.unit_price == null && i.line_total == null), true);
  assertEquals(tradePackMoneyLeakKeys(pack), []);
  assertEquals(pack.items.some((i) => /Patio 6m/.test(i.description)), true);
  assertEquals(pack.items.some((i) => /Mind the pool fence/.test(i.description)), true);
  assertEquals(JSON.stringify(pack).includes("22000"), false);
  assertEquals(JSON.stringify(pack).includes("$22"), false);
});

Deno.test("two sent quotes stay two packs with their own quote numbers", () => {
  const packs = assembleQuotePacksForTrade({
    jobType: "fencing",
    liveScopeJson: FENCE_SCOPE,
    livePricingJson: FENCE_PRICING,
    isHenry: false,
    documents: [
      {
        id: "d1",
        type: "quote",
        quote_number: "SWF-25101-Q1",
        sent_at: "2026-09-01T00:00:00.000Z",
        trade_pack_json: packTradeQuote({
          quote_number: "SWF-25101-Q1",
          job_type: "fencing",
          scope_json: { job: { runs: [{ name: "Rear", length: 10, panels: [] }], gates: [] } },
        }),
      },
      {
        id: "d2",
        type: "quote",
        quote_number: "SWF-25101-Q2",
        sent_at: "2026-09-04T00:00:00.000Z",
        accepted_at: "2026-09-04T12:00:00.000Z",
        trade_pack_json: packTradeQuote({
          quote_number: "SWF-25101-Q2",
          job_type: "fencing",
          scope_json: FENCE_SCOPE,
          pricing_json: FENCE_PRICING,
        }),
      },
    ],
  });
  assertEquals(packs.length, 2);
  assertEquals(packs[0].quote_number, "SWF-25101-Q2");
  assertEquals(packs[0].accepted, true);
  assertEquals(packs[0].status, "accepted");
  assertEquals(packs[1].quote_number, "SWF-25101-Q1");
  assertEquals(packs[1].accepted, false);
  const q1Install = packs[1].items.find((i) => i.kind === "install_m");
  assertEquals(q1Install?.quantity, 10);
});

Deno.test("stripTradePackMoney removes $ / A$ / AUD figures and leaves ordinary numbers", () => {
  assertEquals(stripTradePackMoney("Total $9,999"), "Total");
  assertEquals(stripTradePackMoney("Total $ 9,999"), "Total");
  assertEquals(stripTradePackMoney("Total A$ 9,999"), "Total");
  assertEquals(stripTradePackMoney("Total AUD 9,999"), "Total");
  assertEquals(stripTradePackMoney("Total 9,999 AUD"), "Total");
  assertEquals(stripTradePackMoney("Approved total 9,999 ex GST"), "Approved total");
  assertEquals(stripTradePackMoney("Approved total 9,999 inc GST"), "Approved total");
  assertEquals(stripTradePackMoney("Fee 9,999.00 excl. GST"), "Fee");
  assertEquals(stripTradePackMoney("Approved total 9,999 excluding GST"), "Approved total");
  assertEquals(stripTradePackMoney("Approved total 9,999 exclusive of GST"), "Approved total");
  assertEquals(stripTradePackMoney("Approved total 9,999 inclusive of GST"), "Approved total");
  assertEquals(stripTradePackMoney("Approved total 9,999 GST exclusive"), "Approved total");
  assertEquals(stripTradePackMoney("Approved total 9,999 GST inclusive"), "Approved total");
  assertEquals(stripTradePackMoney("Approved total 9,999 (ex GST)"), "Approved total");
  assertEquals(stripTradePackMoney("Approved total 9,999 (inc. GST)"), "Approved total");
  assertEquals(stripTradePackMoney("Fee ex GST 9,999"), "Fee");
  assertEquals(stripTradePackMoney("Fee inc GST 9,999"), "Fee");
  assertEquals(stripTradePackMoney("Fee excl. GST 9,999"), "Fee");
  assertEquals(stripTradePackMoney("Fee plus GST 9,999"), "Fee");
  assertEquals(stripTradePackMoney("Fee +GST 9999"), "Fee");
  assertEquals(stripTradePackMoney("Line 9999AUD"), "Line");
  assertEquals(stripTradePackMoney("Plus 80 +GST"), "Plus");
  assertEquals(stripTradePackMoney("Rear 19m 1800mm install"), "Rear 19m 1800mm install");
  assertEquals(stripTradePackMoney("Use 90x90 posts"), "Use 90x90 posts");
});

Deno.test("hydrateStoredPack keeps stored summary money for quote-visible viewers and still strips item descriptions", () => {
  const packs = assembleQuotePacksForTrade({
    jobType: "fencing",
    documents: [{
      id: "d-stored",
      type: "quote",
      quote_number: "Q-STORED",
      sent_at: "2026-09-04T00:00:00.000Z",
      trade_pack_json: {
        items: [
          { kind: "install_m", description: "Install fence Total $9,999", quantity: 10, unit: "m" },
          { kind: "note", description: "Priced $9,999", quantity: 1, unit: "lot" },
        ],
        summary: "Total $9,999 AUD 1,200 / Total 9,999 AUD / Approved total 9,999 excluding GST",
      },
    }],
  });
  assertEquals(
    packs[0].summary,
    "Total $9,999 AUD 1,200 / Total 9,999 AUD / Approved total 9,999 excluding GST",
  );
  assertEquals(packs[0].items[0].description, "Install fence Total");
  assertEquals(packs[0].items[1].kind, "note");
  assertEquals(packs[0].items[1].description, "Priced");
});

Deno.test("persistTradePackOnDocuments writes frozen packs per document", async () => {
  const writes: Array<{ id: string; pack: any }> = [];
  const sb = {
    from(_table: string) {
      return {
        update(row: any) {
          return {
            eq(_col: string, id: string) {
              writes.push({ id, pack: row.trade_pack_json });
              return { error: null };
            },
          };
        },
      };
    },
  };
  const n = await persistTradePackOnDocuments(sb, {
    documents: [
      { id: "doc-a", quote_number: "SWF-1-Q1" },
      { id: "doc-b", quote_number: "SWF-1-Q2" },
    ],
    jobType: "fencing",
    scopeJson: FENCE_SCOPE,
    pricingJson: FENCE_PRICING,
  });
  assertEquals(n, 2);
  assertEquals(writes[0].pack.quote_number, "SWF-1-Q1");
  assertEquals(writes[1].pack.quote_number, "SWF-1-Q2");
  assertEquals(writes[0].pack.source, "frozen");
  assertEquals(tradePackMoneyLeakKeys(writes[0].pack), []);
});
