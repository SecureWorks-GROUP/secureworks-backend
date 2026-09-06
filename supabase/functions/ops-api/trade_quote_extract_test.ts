// deno-lint-ignore-file no-import-prefix
// TRD-6: price-free trade quote extract. Artifact content must never carry
// $, rates, totals, or money keys. Pointers stay off the documents allowlist.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { packTradeQuote } from "../_shared/trade_quote_pack/pack_trade_quote.ts";
import {
  TRADE_QUOTE_EXTRACT_DOC_TYPE,
  TRADE_QUOTE_EXTRACT_SCHEMA,
  assembleFrozenQuoteExtractPacks,
  assembleTradeQuoteExtract,
  assertTradeQuoteExtractArtifact,
  buildTradeQuoteExtractArtifact,
  projectTradeQuoteExtracts,
  renderTradeQuoteExtractHtml,
  tradeQuoteExtractArtifactLeaks,
  tradeQuoteExtractFilename,
  tradeQuoteExtractHtmlMoneyNeedles,
  tradeQuoteExtractIsEligible,
  tradeQuoteExtractMoneyLeakKeys,
} from "../_shared/trade_quote_pack/trade_quote_extract.ts";

const PACK = packTradeQuote({
  quote_number: "SWF-25101-Q2",
  job_document_id: "doc-2",
  sent_at: "2026-09-01T00:00:00.000Z",
  job_type: "fencing",
  scope_json: {
    job: {
      runs: [{ name: "Rear", length: 19, panels: [] }],
      gates: [{ type: "pedestrian", width: 900 }],
      notes: { noteWorkOrder: "Watch the dog." },
    },
  },
  pricing_json: {
    totalIncGST: 18400,
    payment_terms: "50% deposit + 50% on completion",
    valid_days: 30,
  },
  customer: {
    name: "Pat Client",
    phone: "0412 000 111",
    email: "pat@example.test",
    site_address: "12 Fence St",
    site_suburb: "Midland",
  },
});

Deno.test("assembleTradeQuoteExtract keeps customer, terms, metres and drops every money key", () => {
  const extract = assembleTradeQuoteExtract({
    pack: PACK,
    job: { job_number: "SWF-25101" },
  });
  assertEquals(extract.schema, TRADE_QUOTE_EXTRACT_SCHEMA);
  assertEquals(extract.type, TRADE_QUOTE_EXTRACT_DOC_TYPE);
  assertEquals(extract.job_number, "SWF-25101");
  assertEquals(extract.quote_number, "SWF-25101-Q2");
  assertEquals(extract.customer.name, "Pat Client");
  assertEquals(extract.customer.phone, "0412 000 111");
  assertEquals(extract.terms.payment_terms, "50% deposit + 50% on completion");
  assertEquals(extract.terms.valid_days, 30);
  const rear = extract.scope.find((row) => /Rear/.test(row.description));
  assertEquals(rear?.quantity, 19);
  assertEquals(rear?.unit, "m");
  assertEquals(tradeQuoteExtractMoneyLeakKeys(extract), []);
  assertEquals(JSON.stringify(extract).includes("$"), false);
  assertEquals(JSON.stringify(extract).includes("18400"), false);
  assertEquals(JSON.stringify(extract).includes("unit_price"), false);
  assertEquals(JSON.stringify(extract).includes("line_total"), false);
});

Deno.test("assembleTradeQuoteExtract overlays customer on older packs and strips leftover sell figures", () => {
  const old = packTradeQuote({
    quote_number: "Q-OLD",
    sent_at: "2026-09-01T00:00:00.000Z",
    job_type: "fencing",
    scope_json: { job: { runs: [{ name: "Front $9,999", length: 10, panels: [] }] } },
  });
  old.customer = { name: null, phone: null, email: null, site_address: null, site_suburb: null };
  const extract = assembleTradeQuoteExtract({
    pack: old,
    job: {
      job_number: "SWF-26091",
      client_name: "Client One",
      client_phone: "0400 111 222",
      site_address: "1 Fence St $850",
      site_suburb: "Midland",
    },
  });
  assertEquals(extract.customer.name, "Client One");
  assertEquals(extract.customer.phone, "0400 111 222");
  assertEquals(extract.customer.site_address, "1 Fence St");
  assertEquals(extract.scope[0].description.includes("9999"), false);
  assertEquals(tradeQuoteExtractMoneyLeakKeys(extract), []);
});

Deno.test("renderTradeQuoteExtractHtml is printable and has no dollar or GST money", () => {
  const extract = assembleTradeQuoteExtract({
    pack: PACK,
    job: { job_number: "SWF-25101" },
  });
  const html = renderTradeQuoteExtractHtml(extract);
  assert(html.includes("<!DOCTYPE html>"));
  assert(html.includes("Pat Client"));
  assert(html.includes("12 Fence St"));
  assert(html.includes("Midland"));
  assert(html.includes("50% deposit + 50% on completion"));
  assert(html.includes("19 m") || html.includes("19m"));
  assert(html.includes("@media print"));
  assertEquals(tradeQuoteExtractHtmlMoneyNeedles(html), []);
  assertEquals(html.includes("quote.pdf"), false);
  assertEquals(html.includes("unit_price"), false);
});

Deno.test("projectTradeQuoteExtracts names the HTML extract and skips unsent/superseded", () => {
  const pointers = projectTradeQuoteExtracts([
    { ...PACK, status: "sent" },
    { ...PACK, quote_number: "Q-ACC", status: "accepted", job_document_id: "doc-acc" },
    { ...PACK, quote_number: "Q-OLD", status: "superseded", job_document_id: "doc-old" },
    { ...PACK, quote_number: "Q-LIVE", source: "live_fallback", job_document_id: "doc-live" },
    { ...PACK, quote_number: "Q-PACK-ONLY", sent_at: null, status: "sent", job_document_id: "doc-pack" },
  ], "SWF-25101");
  assertEquals(pointers.length, 2);
  assertEquals(pointers[0].filename, "SWF-25101-SWF-25101-Q2-trade-extract.html");
  assertEquals(pointers[0].action, "trade_quote_extract");
  assertEquals(pointers[0].type, "trade_quote_extract");
  assertEquals(pointers[1].quote_number, "Q-ACC");
  assertEquals(tradeQuoteExtractIsEligible({ ...PACK, source: "live_fallback" }), false);
  assertEquals(tradeQuoteExtractIsEligible({ ...PACK, sent_at: null, status: "sent" }), false);
  assertEquals(tradeQuoteExtractFilename({ job_number: "SWF-1", quote_number: "Q-1" }), "SWF-1-Q-1-trade-extract.html");
  assertEquals(tradeQuoteExtractFilename({}).includes("quote.pdf"), false);
});

Deno.test("extract fail-closes money in phone, email, and units without eating a clean phone", () => {
  const dirty = packTradeQuote({
    quote_number: "Q-DIRTY",
    job_document_id: "doc-dirty",
    sent_at: "2026-09-01T00:00:00.000Z",
    job_type: "fencing",
    scope_json: { job: { runs: [{ name: "Rear", length: 19, panels: [] }] } },
    customer: {
      name: "Pat Client",
      phone: "0412 $18,400",
      email: "pat+$18,400@example.test",
      site_address: "12 Fence St",
      site_suburb: "Midland",
    },
  });
  dirty.items.push({
    kind: "info",
    description: "Sheets",
    quantity: 2,
    unit: "$18,400",
    unit_price: null,
    line_total: null,
  });
  dirty.customer.phone = "0412 $18,400";
  dirty.customer.email = "pat+$18,400@example.test";
  const extract = assembleTradeQuoteExtract({ pack: dirty, job: { job_number: "SWF-25101" } });
  assertEquals(extract.customer.phone, null);
  assertEquals(extract.customer.email, null);
  assertEquals(extract.customer.name, "Pat Client");
  assertEquals(extract.scope.some((row) => String(row.unit || "").includes("$")), false);
  assertEquals(extract.scope.some((row) => /18400/.test(String(row.unit || ""))), false);
  assertEquals(JSON.stringify(extract).includes("$"), false);
  assertEquals(JSON.stringify(extract).includes("18400"), false);

  const clean = assembleTradeQuoteExtract({ pack: PACK, job: { job_number: "SWF-25101" } });
  assertEquals(clean.customer.phone, "0412 000 111");
  assertEquals(clean.customer.email, "pat@example.test");
  assertEquals(clean.terms.payment_terms, "50% deposit + 50% on completion");
});

Deno.test("extract fail-closes USD and contextual money words on identity and dates", () => {
  const dirty = structuredClone(PACK);
  dirty.customer.phone = "USD 12";
  dirty.customer.email = "rate@example.test";
  dirty.customer.name = "amount due client";
  dirty.terms.valid_until = "price review 2026-10-01";
  dirty.customer.site_address = "12 cost street";
  dirty.notes = "fee on arrival";
  const extract = assembleTradeQuoteExtract({ pack: dirty, job: { job_number: "deposit SWF-25101" } });
  assertEquals(extract.customer.phone, null);
  assertEquals(extract.customer.email, null);
  assertEquals(extract.customer.name, null);
  assertEquals(extract.terms.valid_until, null);
  assertEquals(extract.customer.site_address, null);
  assertEquals(extract.notes, []);
  assertEquals(extract.job_number, null);
  assertEquals(extract.terms.payment_terms, "50% deposit + 50% on completion");
  const html = renderTradeQuoteExtractHtml(extract);
  assertEquals(tradeQuoteExtractArtifactLeaks(extract, html), []);
  assertTradeQuoteExtractArtifact(extract, html);
  assertEquals(tradeQuoteExtractHtmlMoneyNeedles(html), []);
});

Deno.test("assembleFrozenQuoteExtractPacks never synthesizes a live fallback extract", () => {
  const packs = assembleFrozenQuoteExtractPacks({
    documents: [
      {
        id: "d-live",
        type: "quote",
        quote_number: "Q-LIVE",
        sent_at: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "d-unsent",
        type: "quote",
        quote_number: "Q-PACK",
        trade_pack_json: PACK,
      },
      {
        id: "d-frozen",
        type: "quote",
        quote_number: "SWF-25101-Q2",
        sent_at: "2026-09-01T00:00:00.000Z",
        trade_pack_json: PACK,
      },
    ],
  });
  assertEquals(packs.length, 1);
  assertEquals(packs[0].quote_number, "SWF-25101-Q2");
  assertEquals(packs[0].source, "frozen");
});

Deno.test("extract fail-closes ad-hoc percent and payment-language outside sealed terms", () => {
  const dirty = structuredClone(PACK);
  dirty.terms.payment_terms = "50% upfront";
  dirty.customer.name = "balance due client";
  dirty.notes = "owing on completion";
  dirty.items.push({
    kind: "info",
    description: "Pay 40 percent now",
    quantity: 1,
    unit: "ea",
    unit_price: null,
    line_total: null,
  });
  const extract = assembleTradeQuoteExtract({ pack: dirty, job: { job_number: "SWF-25101" } });
  assertEquals(extract.terms.payment_terms, null);
  assertEquals(extract.customer.name, null);
  assertEquals(extract.notes, []);
  assertEquals(extract.scope.some((row) => /percent|%|upfront|balance/i.test(row.description)), false);
  assertEquals(JSON.stringify(extract).includes("50%"), false);
  assertEquals(JSON.stringify(extract).includes("upfront"), false);
  const clean = assembleTradeQuoteExtract({ pack: PACK, job: { job_number: "SWF-25101" } });
  assertEquals(clean.terms.payment_terms, "50% deposit + 50% on completion");
  const html = renderTradeQuoteExtractHtml(clean);
  assert(html.includes("50% deposit + 50% on completion"));
  assertEquals(tradeQuoteExtractHtmlMoneyNeedles(html), []);
  assertTradeQuoteExtractArtifact(clean, html);
});

Deno.test("sealed payment phrase is exempt only on terms.payment_terms", () => {
  const dirty = structuredClone(PACK);
  dirty.customer.name = "50% deposit + 50% on completion";
  dirty.notes = "50% deposit + 50% on completion";
  dirty.summary = "50% deposit + 50% on completion";
  dirty.items.push({
    kind: "info",
    description: "50% deposit + 50% on completion",
    quantity: 1,
    unit: "ea",
    unit_price: null,
    line_total: null,
  });
  dirty.terms.payment_terms = "50% deposit + 50% on completion $9,999";
  const extract = assembleTradeQuoteExtract({ pack: dirty, job: { job_number: "SWF-25101" } });
  assertEquals(extract.customer.name, null);
  assertEquals(extract.notes, []);
  assertEquals(extract.summary, null);
  assertEquals(extract.scope.some((row) => /50%|deposit/i.test(row.description)), false);
  assertEquals(extract.terms.payment_terms, "50% deposit + 50% on completion");
  const html = renderTradeQuoteExtractHtml(extract);
  assertEquals(tradeQuoteExtractHtmlMoneyNeedles(html), []);
  assertTradeQuoteExtractArtifact(extract, html);

  const leakedName = assembleTradeQuoteExtract({
    pack: { ...PACK, customer: { ...PACK.customer, name: "50% deposit + 50% on completion" } },
    job: { job_number: "SWF-25101" },
  });
  leakedName.customer.name = "50% deposit + 50% on completion";
  const leakedHtml = renderTradeQuoteExtractHtml(leakedName);
  assert(tradeQuoteExtractHtmlMoneyNeedles(leakedHtml).length > 0);
});

Deno.test("assertTradeQuoteExtractArtifact covers JSON projection and rendered HTML", () => {
  const artifact = buildTradeQuoteExtractArtifact({
    pack: PACK,
    job: { job_number: "SWF-25101" },
  });
  assertEquals(tradeQuoteExtractArtifactLeaks(artifact.extract, artifact.html), []);
  assertTradeQuoteExtractArtifact(artifact.extract, artifact.html);
  assertEquals(tradeQuoteExtractHtmlMoneyNeedles(artifact.html), []);
  assertEquals(tradeQuoteExtractMoneyLeakKeys(artifact.extract), []);

  const dirtyExtract = assembleTradeQuoteExtract({ pack: PACK, job: { job_number: "SWF-25101" } });
  dirtyExtract.customer.phone = "$18,400";
  const dirtyHtml = renderTradeQuoteExtractHtml(dirtyExtract);
  const leaks = tradeQuoteExtractArtifactLeaks(dirtyExtract, dirtyHtml);
  assert(leaks.length > 0);
  assert(leaks.some((hit) => hit.includes("$") || hit.includes("extract.customer.phone")));
});
