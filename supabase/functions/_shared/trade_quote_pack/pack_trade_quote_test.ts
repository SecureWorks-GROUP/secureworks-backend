import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  allocatedPaymentTerms,
  allocatedTradePackIdentity,
  allocatedTradePackProse,
  allocatedTradeQuotePackProjectionLeaks,
  applyInstallerRates,
  assembleQuotePacksForTrade,
  frozenTradePackForExtract,
  packTradeQuote,
  overlayTradePackSnapshots,
  persistTradePackOnDocuments,
  quoteDocumentHasClientSend,
  sanitizeTradePackKind,
  sanitizeTradePackUnit,
  stripTradePackMoney,
  tradePackMoneyLeakKeys,
  isSealedPaymentTermsPhrase,
  isTradePaymentTermsFieldPath,
  tradeTextHasAdHocPercentOrPaymentLanguage,
  tradeTextHasMoneyToken,
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

Deno.test("assembleQuotePacksForTrade ignores a stored pack until the quote is sent or accepted", () => {
  const packs = assembleQuotePacksForTrade({
    jobType: "fencing",
    documents: [{
      id: "d-unsent",
      type: "quote",
      quote_number: "Q-UNSENT",
      trade_pack_json: {
        items: [{ kind: "install_m", description: "Rear", quantity: 10, unit: "m" }],
        source: "frozen",
      },
    }],
  });
  assertEquals(packs, []);
});

Deno.test("quote packs require authoritative primary-send state, not a pre-send stamp", () => {
  assertEquals(quoteDocumentHasClientSend({
    id: "d-pre",
    type: "quote",
    sent_at: "2026-09-01T00:00:00.000Z",
    sent_to_client: false,
  }), false);
  assertEquals(assembleQuotePacksForTrade({
    jobType: "fencing",
    liveScopeJson: FENCE_SCOPE,
    livePricingJson: FENCE_PRICING,
    documents: [{
      id: "d-pre",
      type: "quote",
      quote_number: "Q-PRE",
      sent_at: "2026-09-01T00:00:00.000Z",
      sent_to_client: false,
    }],
  }), []);
  assertEquals(quoteDocumentHasClientSend({
    id: "d-hist",
    type: "quote",
    sent_at: "2026-09-01T00:00:00.000Z",
  }), true);
  assertEquals(quoteDocumentHasClientSend({
    id: "d-acc",
    type: "quote",
    sent_to_client: false,
    accepted_at: "2026-09-01T12:00:00.000Z",
  }), true);
  const historical = assembleQuotePacksForTrade({
    jobType: "fencing",
    liveScopeJson: FENCE_SCOPE,
    livePricingJson: FENCE_PRICING,
    documents: [{
      id: "d-hist",
      type: "quote",
      quote_number: "Q-HIST",
      sent_at: "2026-09-01T00:00:00.000Z",
    }],
  });
  assertEquals(historical.length, 1);
  assertEquals(historical[0].source, "live_fallback");
  assertEquals(quoteDocumentHasClientSend({
    id: "d-claim",
    type: "quote",
    send_claimed_at: "2026-09-06T00:00:00.000Z",
    sent_to_client: false,
  }), false);
  assertEquals(quoteDocumentHasClientSend({
    id: "d-claim-leak",
    type: "quote",
    sent_at: "2026-09-06T00:00:00.000Z",
    send_claimed_at: "2026-09-06T00:00:00.000Z",
  }), false);
  assertEquals(assembleQuotePacksForTrade({
    jobType: "fencing",
    liveScopeJson: FENCE_SCOPE,
    livePricingJson: FENCE_PRICING,
    documents: [{
      id: "d-claim",
      type: "quote",
      quote_number: "Q-CLAIM",
      send_claimed_at: "2026-09-06T00:00:00.000Z",
      sent_to_client: false,
    }],
  }), []);
});

Deno.test("tradeTextHasMoneyToken is conservative across identity and date strings", () => {
  assertEquals(tradeTextHasMoneyToken("0412 000 111"), false);
  assertEquals(tradeTextHasMoneyToken("pat@example.test"), false);
  assertEquals(tradeTextHasMoneyToken("2026-10-01"), false);
  assertEquals(tradeTextHasMoneyToken("50% deposit + 50% on completion"), true);
  assertEquals(tradeTextHasMoneyToken("0412 $18,400"), true);
  assertEquals(tradeTextHasMoneyToken("USD 12"), true);
  assertEquals(tradeTextHasMoneyToken("rate@example.test"), true);
  assertEquals(tradeTextHasMoneyToken("price@example.test"), true);
  assertEquals(tradeTextHasMoneyToken("amount@example.test"), true);
  assertEquals(tradeTextHasMoneyToken("cost@example.test"), true);
  assertEquals(tradeTextHasMoneyToken("deposit@example.test"), true);
  assertEquals(tradeTextHasMoneyToken("fee@example.test"), true);
  assertEquals(allocatedTradePackIdentity("0412 000 111"), "0412 000 111");
  assertEquals(allocatedTradePackIdentity("fee@example.test"), null);
  assertEquals(allocatedTradeQuotePackProjectionLeaks({
    customer: { phone: "0412 $18,400", email: "usd@example.test" },
    terms: { valid_until: "valid until price review" },
  }).sort(), ["$", "customer.email", "customer.phone", "terms.valid_until"]);
  assertEquals(tradeTextHasMoneyToken("50% upfront"), true);
  assertEquals(tradeTextHasMoneyToken("balance due"), true);
  assertEquals(tradeTextHasMoneyToken("Pay 40 percent now"), true);
  assertEquals(tradeTextHasAdHocPercentOrPaymentLanguage("50% deposit + 50% on completion"), true);
  assertEquals(tradeTextHasAdHocPercentOrPaymentLanguage("Install Deposit"), false);
  assertEquals(allocatedTradePackProse("50% upfront"), null);
  assertEquals(allocatedTradePackProse("50% deposit + 50% on completion"), null);
  assertEquals(allocatedTradePackProse("Install Deposit"), "Install Deposit");
  assertEquals(allocatedPaymentTerms("50% deposit + 50% on completion"), "50% deposit + 50% on completion");
  assertEquals(allocatedPaymentTerms("50% deposit + 50% on completion $9,999"), "50% deposit + 50% on completion");
  assertEquals(allocatedPaymentTerms("50% upfront"), null);
  assertEquals(isSealedPaymentTermsPhrase("50% deposit + 50% on completion"), true);
  assertEquals(isTradePaymentTermsFieldPath("extract.terms.payment_terms"), true);
  assertEquals(isTradePaymentTermsFieldPath("customer.name"), false);
  assertEquals(allocatedTradePackIdentity("50% upfront"), null);
  assertEquals(allocatedTradeQuotePackProjectionLeaks({
    terms: { payment_terms: "50% upfront" },
    items: [{ description: "balance due on site" }],
  }).sort(), ["items[0].description", "terms.payment_terms"]);
  assertEquals(allocatedTradeQuotePackProjectionLeaks({
    customer: { name: "50% deposit + 50% on completion" },
    terms: { payment_terms: "50% deposit + 50% on completion" },
    items: [{ description: "50% deposit + 50% on completion" }],
  }).sort(), ["customer.name", "items[0].description"]);
});

Deno.test("frozenTradePackForExtract refuses live_fallback and unsent packs", () => {
  assertEquals(frozenTradePackForExtract({
    id: "d-live",
    type: "quote",
    quote_number: "Q-1",
    sent_at: "2026-09-01T00:00:00.000Z",
    trade_pack_json: packTradeQuote({
      quote_number: "Q-1",
      source: "live_fallback",
      scope_json: FENCE_SCOPE,
    }),
  }), null);
  assertEquals(frozenTradePackForExtract({
    id: "d-unsent",
    type: "quote",
    quote_number: "Q-1",
    trade_pack_json: packTradeQuote({
      quote_number: "Q-1",
      sent_at: "2026-09-01T00:00:00.000Z",
      scope_json: FENCE_SCOPE,
    }),
  }), null);
  const frozen = frozenTradePackForExtract({
    id: "d-ok",
    type: "quote",
    quote_number: "Q-1",
    sent_at: "2026-09-01T00:00:00.000Z",
    trade_pack_json: packTradeQuote({
      quote_number: "Q-1",
      sent_at: "2026-09-01T00:00:00.000Z",
      scope_json: FENCE_SCOPE,
    }),
  });
  assertEquals(frozen?.source, "frozen");
  assertEquals(frozen?.quote_number, "Q-1");
  assertEquals(frozen?.sent_at, "2026-09-01T00:00:00.000Z");
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
  assertEquals(stripTradePackMoney("Client approved $9,999 excluding GST"), "Client approved");
  assertEquals(stripTradePackMoney("Watch the GST registration"), "Watch the GST registration");
  assertEquals(stripTradePackMoney("Line 9999AUD"), "Line");
  assertEquals(stripTradePackMoney("Plus 80 +GST"), "Plus");
  assertEquals(stripTradePackMoney("Rear 19m 1800mm install"), "Rear 19m 1800mm install");
  assertEquals(stripTradePackMoney("Use 90x90 posts"), "Use 90x90 posts");
  assertEquals(stripTradePackMoney("Total 9999"), "Total");
  assertEquals(stripTradePackMoney("Approved total 9,999"), "Approved total");
  assertEquals(stripTradePackMoney("rate 85"), "rate");
  assertEquals(stripTradePackMoney("charged 1200 extra"), "charged extra");
  assertEquals(stripTradePackMoney("Fee 1,200"), "Fee");
  assertEquals(stripTradePackMoney("cost 99"), "cost");
  assertEquals(stripTradePackMoney("85/hour"), "");
  assertEquals(stripTradePackMoney("85 / hr"), "");
  assertEquals(stripTradePackMoney("1200/m"), "");
  assertEquals(stripTradePackMoney("85 per hour"), "");
  assertEquals(stripTradePackMoney("85 per day"), "");
  assertEquals(stripTradePackMoney("85/day"), "");
  assertEquals(stripTradePackMoney("85 per trade"), "");
  assertEquals(stripTradePackMoney("85/trade"), "");
  assertEquals(stripTradePackMoney("2 trades over 3 days"), "2 trades over 3 days");
  assertEquals(stripTradePackMoney("Quote 850"), "Quote");
  assertEquals(stripTradePackMoney("quoted at 9999"), "quoted");
  assertEquals(stripTradePackMoney("Sheets 99.50"), "Sheets");
  assertEquals(stripTradePackMoney("Monument fencing 18400"), "Monument fencing");
  assertEquals(stripTradePackMoney("12 posts at 850"), "12 posts at");
  assertEquals(stripTradePackMoney("SWF-26101 Quote 850"), "SWF-26101 Quote");
  assertEquals(stripTradePackMoney("Deposit 85"), "Deposit");
  assertEquals(stripTradePackMoney("Deposit of 85"), "Deposit");
  assertEquals(stripTradePackMoney("Price of 85"), "Price");
  assertEquals(stripTradePackMoney("12 panels at 85"), "12 panels at");
  assertEquals(stripTradePackMoney("85 per panel"), "");
  assertEquals(stripTradePackMoney("85 each"), "");
  assertEquals(stripTradePackMoney("85 dollars each"), "");
  assertEquals(stripTradePackMoney("85 USD each"), "");
  assertEquals(stripTradePackMoney("85 AUD each"), "");
  assertEquals(stripTradePackMoney("85 dollars per item"), "");
  assertEquals(stripTradePackMoney("85 USD per panel"), "");
  assertEquals(stripTradePackMoney("Charge 85 dollars each"), "Charge");
  assertEquals(stripTradePackMoney("USD 85"), "");
  assertEquals(stripTradePackMoney("Rate USD 85"), "Rate");
  assertEquals(stripTradePackMoney("dollars 85"), "");
  assertEquals(stripTradePackMoney("bucks 85"), "");
  assertEquals(stripTradePackMoney("Install USD 85 plus posts"), "Install plus posts");
  assertEquals(stripTradePackMoney("Install 85 dollars each plus posts"), "Install plus posts");
  assertEquals(stripTradePackMoney("85 per item"), "");
  assertEquals(stripTradePackMoney("85 per gate"), "");
  assertEquals(stripTradePackMoney("85 per material"), "");
  assertEquals(stripTradePackMoney("85 per linear metre"), "");
  assertEquals(stripTradePackMoney("Balance due 85"), "Balance due");
  assertEquals(stripTradePackMoney("Paid 85"), "Paid");
  assertEquals(stripTradePackMoney("Due 85"), "Due");
  assertEquals(stripTradePackMoney("deposit: 40"), "deposit");
});

Deno.test("allocatedTradePackProse drops numbers and numeric-only strings", () => {
  assertEquals(allocatedTradePackProse(85), null);
  assertEquals(allocatedTradePackProse(999), null);
  assertEquals(allocatedTradePackProse("85"), null);
  assertEquals(allocatedTradePackProse("999"), null);
  assertEquals(allocatedTradePackProse("Install 10m"), "Install 10m");
  assertEquals(allocatedTradePackProse("2 trades over 3 days"), "2 trades over 3 days");
  assertEquals(allocatedTradePackProse(null), null);
});

Deno.test("sanitizeTradePackUnit and sanitizeTradePackKind drop money scalars", () => {
  assertEquals(sanitizeTradePackUnit("m"), "m");
  assertEquals(sanitizeTradePackUnit("ea"), "ea");
  assertEquals(sanitizeTradePackUnit("lot"), "lot");
  assertEquals(sanitizeTradePackUnit("sheet"), "sheet");
  assertEquals(sanitizeTradePackUnit("85"), undefined);
  assertEquals(sanitizeTradePackUnit("999"), undefined);
  assertEquals(sanitizeTradePackUnit("AUD 9,999"), undefined);
  assertEquals(sanitizeTradePackUnit("85/day"), undefined);
  assertEquals(sanitizeTradePackUnit("AUD"), undefined);
  assertEquals(sanitizeTradePackUnit({ name: "ea", unit_price: 99.5 }), undefined);
  assertEquals(sanitizeTradePackKind("install_m"), "install_m");
  assertEquals(sanitizeTradePackKind("info"), "info");
  assertEquals(sanitizeTradePackKind("note"), undefined);
  assertEquals(sanitizeTradePackKind("AUD 9,999"), undefined);
  assertEquals(sanitizeTradePackKind("sell"), undefined);
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
  assertEquals(packs[0].items[0].unit, "m");
  assertEquals(packs[0].items[1].kind, "note");
  assertEquals(packs[0].items[1].description, "Priced");
});

Deno.test("hydrateStoredPack replaces money-shaped unit/kind with safe defaults", () => {
  const packs = assembleQuotePacksForTrade({
    jobType: "fencing",
    documents: [{
      id: "d-unit",
      type: "quote",
      quote_number: "Q-UNIT",
      sent_at: "2026-09-04T00:00:00.000Z",
      trade_pack_json: {
        items: [
          { kind: "AUD 9,999", description: "Install", quantity: 10, unit: "AUD 9,999" },
          { kind: "install_m", description: "Rear run", quantity: 19, unit: "m" },
        ],
        summary: "kept",
      },
    }],
  });
  assertEquals(packs[0].items[0].kind, "info");
  assertEquals(packs[0].items[0].unit, "ea");
  assertEquals(packs[0].items[1].kind, "install_m");
  assertEquals(packs[0].items[1].unit, "m");
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

Deno.test("packTradeQuote stamps customer and default payment terms without pricing totals", () => {
  const pack = packTradeQuote({
    quote_number: "SWF-25101-Q2",
    sent_at: "2026-09-01T00:00:00.000Z",
    job_type: "fencing",
    scope_json: FENCE_SCOPE,
    pricing_json: { ...FENCE_PRICING, payment_terms: "Pay $18,400 now", valid_days: 14 },
    customer: {
      name: "Pat Client",
      phone: "0412 000 111",
      email: "pat@example.test",
      site_address: "12 Fence St, Midland",
      site_suburb: "Midland",
    },
  });
  assertEquals(pack.customer, {
    name: "Pat Client",
    phone: "0412 000 111",
    email: "pat@example.test",
    site_address: "12 Fence St, Midland",
    site_suburb: "Midland",
  });
  assertEquals(pack.terms.payment_terms, "Pay now");
  assertEquals(pack.terms.valid_days, 14);
  assertEquals(pack.terms.valid_until, "2026-09-15");
  assertEquals(tradePackMoneyLeakKeys(pack), []);
  assertEquals(JSON.stringify(pack.customer).includes("18400"), false);
  assertEquals(JSON.stringify(pack.terms).includes("18400"), false);
  assertEquals(JSON.stringify(pack.terms).includes("$"), false);
});

Deno.test("overlayTradePackSnapshots fills empty customer/terms on older frozen packs", () => {
  const old = packTradeQuote({
    quote_number: "Q-OLD",
    sent_at: "2026-09-01T00:00:00.000Z",
    job_type: "fencing",
    scope_json: FENCE_SCOPE,
  });
  old.customer = { name: null, phone: null, email: null, site_address: null, site_suburb: null };
  old.terms = { payment_terms: null, valid_days: null, valid_until: null };
  const overlaid = overlayTradePackSnapshots(old, {
    customer: { name: "Client One", site_suburb: "Midland" },
    pricing_json: FENCE_PRICING,
  });
  assertEquals(overlaid.customer.name, "Client One");
  assertEquals(overlaid.customer.site_suburb, "Midland");
  assertEquals(overlaid.terms.payment_terms, "50% deposit + 50% on completion");
  assertEquals(overlaid.terms.valid_days, 30);
  assertEquals(JSON.stringify(overlaid.terms).includes("18400"), false);
});

Deno.test("persistTradePackOnDocuments writes customer snapshot onto the frozen pack", async () => {
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
  await persistTradePackOnDocuments(sb, {
    documents: [{ id: "doc-c", quote_number: "SWF-1-Q1", sent_at: "2026-09-01T00:00:00.000Z" }],
    jobType: "fencing",
    scopeJson: FENCE_SCOPE,
    pricingJson: FENCE_PRICING,
    customer: { name: "Pat", site_suburb: "Midland", phone: "0400 000 000" },
  });
  assertEquals(writes[0].pack.customer.name, "Pat");
  assertEquals(writes[0].pack.customer.phone, "0400 000 000");
  assertEquals(writes[0].pack.terms.payment_terms, "50% deposit + 50% on completion");
  assertEquals(tradePackMoneyLeakKeys(writes[0].pack), []);
});
