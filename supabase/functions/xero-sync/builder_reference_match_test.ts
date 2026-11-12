// ════════════════════════════════════════════════════════════
// B3 — the builder reference rule (builder_reference_match.ts) and its place in
// matchUnlinkedInvoices (Strategy 1b).
//
// The fixtures are the production shapes of 3 Nov 2026 (job numbers, claims,
// POs, types, statuses, trackings and the trade words of each line), with
// customer names and addresses replaced.
//
// RUN:
//   ~/.deno/bin/deno test --no-check --allow-env --allow-read \
//     supabase/functions/xero-sync/builder_reference_match_test.ts
// ════════════════════════════════════════════════════════════

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BUILDER_REFERENCE_RULE,
  type BuilderRefInvoice,
  type BuilderRefJob,
  builderReferenceAnnotation,
  builderReferenceKeys,
  decideBuilderReference,
  invoiceTrade,
  jobTrade,
  parseBuilderKeys,
} from "./builder_reference_match.ts";
import { matchUnlinkedInvoices } from "./index.ts";

const INSURANCE = [{ Name: "Business Unit", Option: "SW - INSURANCE WORK" }];
const MAKESAFE = [{ Name: "Business Unit", Option: "SW - MAKESAFE" }];
const REPORTS = [{ Name: "Business Unit", Option: "ROOF REPORTS" }];

function inv(o: Partial<BuilderRefInvoice> & { reference: string; text: string; tracking?: unknown[] }): BuilderRefInvoice {
  return {
    id: o.id ?? `row-${o.reference}`,
    xero_invoice_id: o.xero_invoice_id ?? `xero-${o.reference}`,
    invoice_number: o.invoice_number ?? "INV-TEST",
    invoice_type: o.invoice_type ?? "ACCREC",
    invoice_date: o.invoice_date === undefined ? "2026-10-29" : o.invoice_date,
    reference: o.reference,
    line_items: [{ Description: o.text, Tracking: (o.tracking ?? INSURANCE) as never }],
  };
}

function job(o: Partial<BuilderRefJob> & { job_number: string; type: string; status: string }): BuilderRefJob {
  return {
    id: o.id ?? `job-${o.job_number}`,
    job_number: o.job_number,
    type: o.type,
    status: o.status,
    legacy: o.legacy ?? false,
    created_at: o.created_at ?? "2026-08-01T00:00:00Z",
    client_name: o.client_name ?? "Customer A",
    ghl_contact_id: o.ghl_contact_id ?? null,
    site_key: o.site_key === undefined ? "53 example st" : o.site_key,
    builder: o.builder ?? null,
    quoted_value: o.quoted_value ?? null,
    work_order_value_ex_gst: o.work_order_value_ex_gst ?? null,
    do_not_schedule: o.do_not_schedule ?? false,
    refs: o.refs ?? {},
    invoices: o.invoices ?? [],
  };
}

function linkedTo(d: ReturnType<typeof decideBuilderReference>): string | null {
  return d.outcome === "link" ? d.job_number : null;
}

// ── The four B3 misses ──────────────────────────────────────

Deno.test("INV-1772: a make-safe retrieval on the one card that carries its claim links to SWMS-26520", () => {
  const d = decideBuilderReference(
    inv({ reference: "MLB-25248PO-52289", text: "Temporary fence retrieval - make safe. Collection and removal of temporary fencing. MLB-25248 / PO MLB-25248PO-5", tracking: MAKESAFE }),
    [job({ job_number: "SWMS-26520", type: "makesafe", status: "archived", builder: "mlb", refs: { details_external_ref: "MLB-25248", external_ref: "MLB-25248" }, invoices: [{ id: "inv-0633", invoice_number: "INV-0633", total: 497.2, status: "PAID" }] })],
  );
  assertEquals(linkedTo(d), "SWMS-26520");
  assert(d.outcome === "link");
  assertEquals(d.evidence.rule, BUILDER_REFERENCE_RULE);
  assertEquals(d.evidence.invoice_trade, "makesafe");
  assertEquals(d.evidence.step, "unique");
  assertEquals(d.evidence.keys, { claims: ["25248"], pos: ["52289"], source: "reference" });
});

const SWMS_261163 = job({ job_number: "SWMS-261163", type: "makesafe", status: "processing", builder: "mlb", refs: { details_external_ref: "MLB-26303", builder_claim_ref: "MLB-26303", builder_po_number: "PO-58097", builder_work_order_number: "MLB-26303", external_ref: "MLB-26303" } });
const SWF_261360 = job({ job_number: "SWF-261360", type: "fencing", status: "archived", refs: { mlb_ref: "MLB-26303" } });

Deno.test("INV-1775: gates billed under the make-safe card's claim and PO link to the fence job SWF-261360", () => {
  const d = decideBuilderReference(
    inv({ reference: "MLB-26303PO-58097", text: "MLB-26303PO-58097 | Carpentry - External\nRemove and replace 2 x 1700mm x 1700mm Colorbond drive gates" }),
    [SWMS_261163, SWF_261360],
  );
  assertEquals(linkedTo(d), "SWF-261360");
  assert(d.outcome === "link");
  const card = d.evidence.candidates.find((c) => c.job_number === "SWMS-261163")!;
  assertEquals([card.kept, card.dropped, card.matched.sort()], [false, "trade_makesafe", ["26303", "58097"]]);
});

Deno.test("INV-1787: a sliding gate under a claim held by an assessment card links to the repair job SWF-261359", () => {
  const d = decideBuilderReference(
    inv({ reference: "MLB-24473PO-59514", text: "MLB-24473 | PO MLB-24473PO-59514\nFencing - External: Remove and dispose from site. Supply and install new manual sliding gate" }),
    [
      job({ job_number: "SWMS-26965", type: "makesafe", status: "archived", builder: "mlb", refs: { details_external_ref: "MLB-24473", external_ref: "MLB-24473" } }),
      job({ job_number: "SWF-261359", type: "repair", status: "invoiced", refs: { mlb_ref: "MLB-24473" } }),
    ],
  );
  assertEquals(linkedTo(d), "SWF-261359");
});

Deno.test("INV-1805: gutter work whose claim and PO sit on the repair job links to SWR-261499", () => {
  const d = decideBuilderReference(
    inv({ reference: "MLB-40502PO-62815", text: "MLB-40502 | PO MLB-40502PO-62815\nCarpentry - External: Remove and dispose from site. Supply and install similar to existing: 2 lengths of gutter" }),
    [job({ job_number: "SWR-261499", type: "repair", status: "scheduled", builder: "mlb", work_order_value_ex_gst: 1080, refs: { details_external_ref: "MLB-40502", builder_claim_ref: "MLB-40502", builder_po_number: "PO-62815", builder_work_order_number: "MLB-40502PO-62815", mlb_ref: "MLB-40502" } })],
  );
  assertEquals(linkedTo(d), "SWR-261499");
});

// ── B3's two payment misses: Ambrose invoices raised before their job card ──
// matchUnlinkedInvoices re-reads every unlinked customer invoice on each 15-minute sync, so an
// invoice raised before its card links at the first sync after the card is made, and the
// payment of 28 Oct arrives on an invoice already on its job.

const SWR_261574 = job({
  job_number: "SWR-261574", type: "repair", status: "processing", builder: "acg", created_at: "2026-10-13T08:01:59Z",
  refs: { details_external_ref: "ACG-20305206PO-2030520605", external_ref: "ACG-20305206PO-2030520605", builder_claim_ref: "ACG-20305206", builder_po_number: "PO-2030520605", builder_work_order_number: "ACG-20305206PO-2030520605" },
});
const SWMS_261588 = job({
  job_number: "SWMS-261588", type: "makesafe", status: "processing", builder: "acg", created_at: "2026-10-15T05:18:55Z",
  refs: { details_external_ref: "ACG-20333978PO-2033397801", external_ref: "ACG-20333978PO-2033397801" },
});
const INV_1688 = inv({ reference: "20305206-05", invoice_date: "2026-10-15", text: "Deposit (50% of $8,745.00 ex GST)\nMaterials Deposit\nPO 20305206-05\n5 Example Road" });
const INV_1709 = inv({ reference: "20333978-01", invoice_date: "2026-10-14", text: "Make safe: attended site and collected 5 panels of temp fencing (temp fence pickup). Job 20333978 | 8A Example Rise" });

Deno.test("INV-1688: an Ambrose deposit raised before its job card links to SWR-261574 at the first sync after the card", () => {
  assertEquals(decideBuilderReference(INV_1688, []).outcome, "no_candidate");
  const d = decideBuilderReference(INV_1688, [SWR_261574]);
  assertEquals(linkedTo(d), "SWR-261574");
  assert(d.outcome === "link" && d.evidence.invoice_trade === "works");
});

Deno.test("INV-1709: an Ambrose temp fence pickup reads as make-safe and links to SWMS-261588, not to a person", () => {
  assertEquals(invoiceTrade(INV_1709), "makesafe");
  assertEquals(decideBuilderReference(INV_1709, []).outcome, "no_candidate");
  const d = decideBuilderReference(INV_1709, [SWMS_261588]);
  assertEquals(linkedTo(d), "SWMS-261588");
  assert(d.outcome === "link" && d.evidence.invoice_trade === "makesafe" && d.evidence.step === "unique");
});

// ── The 3 Nov test's four wrong links: never the make-safe card ──

const EARLIER_WRONG: Array<{ name: string; invoice: BuilderRefInvoice; card: BuilderRefJob[]; works: BuilderRefJob }> = [
  {
    name: "INV-1580",
    invoice: inv({ reference: "MLB-26640PO-59061", text: "Supply and install for gate plus waste disposal and site cleanup\nSWF-261280 | MLB-26640" }),
    card: [job({ job_number: "SWMS-261252", type: "makesafe", status: "processing", builder: "mlb", refs: { details_external_ref: "MLB-26640", builder_po_number: "PO-59061" } })],
    works: job({ job_number: "SWF-261280", type: "repair", status: "order_materials", quoted_value: 2145, refs: { mlb_ref: "MLB-26640" } }),
  },
  {
    name: "INV-1419",
    invoice: inv({ reference: "MLB-24319PO-56427", text: "Remove, dispose and replace hardies fibre cement fencing with 1300H Colorbond fence panels" }),
    card: [job({ job_number: "SWMS-261031", type: "makesafe", status: "complete", builder: "mlb", refs: { details_external_ref: "MLB-24319", builder_po_number: "PO-56427" } })],
    works: job({ job_number: "SWF-26997", type: "repair", status: "complete", quoted_value: 6237, refs: { mlb_ref: "MLB-24319" } }),
  },
  {
    name: "INV-1646",
    invoice: inv({ reference: "MLB-26012PO-58248", text: "Carpentry (External): remove/dispose, supply and install new shed; Fencing: remove/replace Colorbond fence\nSWMS-261251 | MLB-26012" }),
    card: [
      job({ job_number: "SWMS-261251", type: "makesafe", status: "processing", builder: "mlb", refs: { details_external_ref: "MLB-26012", builder_po_number: "PO-58248" } }),
      job({ job_number: "SWMS-26804", type: "makesafe", status: "processing", builder: "mlb", refs: { details_external_ref: "MLB-26012PO-54537" } }),
    ],
    works: job({ job_number: "SWF-261279", type: "repair", status: "order_materials", quoted_value: 4950, refs: { mlb_ref: "MLB-26012" } }),
  },
  { name: "INV-1775", invoice: inv({ reference: "MLB-26303PO-58097", text: "Carpentry - External\nRemove and replace 2 x Colorbond drive gates" }), card: [SWMS_261163], works: SWF_261360 },
];

for (const c of EARLIER_WRONG) {
  Deno.test(`${c.name}: never linked to the make-safe card that carries its claim and PO`, () => {
    const cards = new Set(c.card.map((j) => j.job_number));
    const withWorks = decideBuilderReference(c.invoice, [...c.card, c.works]);
    assert(!cards.has(linkedTo(withWorks) ?? ""), `${c.name} linked to ${linkedTo(withWorks)}`);
    assertEquals(linkedTo(withWorks), c.works.job_number);
    // Without the works job only the make-safe card carries the reference: a person decides.
    const cardOnly = decideBuilderReference(c.invoice, c.card);
    assertEquals(cardOnly.outcome, "person");
    assert(cardOnly.outcome === "person" && cardOnly.reason === "no_job_of_this_trade");
  });
}

Deno.test("INV-1219: a claim-only reference on a make-safe card and a works job is left for a person", () => {
  const d = decideBuilderReference(
    inv({ reference: "MLB-24481", text: "Supply and install 14.8m of Colorbond fencing, including 12 retaining plinths" }),
    [
      job({ job_number: "SWMS-26776", type: "makesafe", status: "complete", builder: "mlb", refs: { details_external_ref: "MLB-24481" } }),
      job({ job_number: "SWF-261111", type: "repair", status: "invoiced", quoted_value: 3740, refs: { mlb_ref: "MLB-24481" } }),
    ],
  );
  assert(d.outcome === "person" && d.reason === "claim_only_cross_trade");
});

// ── The PO picks among sibling cards of one claim ──────────

const SIBLINGS = [
  job({ job_number: "SWMS-261170", type: "makesafe", status: "scheduled", builder: "mlb", refs: { details_external_ref: "MLB-27580", builder_po_number: "PO-58169" } }),
  job({ job_number: "SWMS-261171", type: "makesafe", status: "scheduled", builder: "mlb", refs: { details_external_ref: "MLB-27580", builder_po_number: "PO-58171" } }),
];

Deno.test("Sibling make-safe cards on one claim: the invoice's PO names the card", () => {
  const d = decideBuilderReference(inv({ reference: "MLB-27580PO-58171", text: "MLB-27580 - make-safe attendance - 1 trade x 3 hours", tracking: MAKESAFE }), SIBLINGS);
  assertEquals(linkedTo(d), "SWMS-261171");
  assert(d.outcome === "link" && d.evidence.step === "po_instruction");
});

Deno.test("Sibling cards: a claim-only reference, an unknown PO or a PO on both cards is left for a person", () => {
  for (const reference of ["MLB-27580", "MLB-27580PO-99999"]) {
    const d = decideBuilderReference(inv({ reference, text: "make-safe attendance", tracking: MAKESAFE }), SIBLINGS);
    assert(d.outcome === "person" && d.reason === "several_jobs", reference);
  }
  const samePo = SIBLINGS.map((j) => ({ ...j, refs: { ...j.refs, builder_po_number: "PO-55622" } }));
  const d = decideBuilderReference(inv({ reference: "MLB-27580PO-55622", text: "Roof report", tracking: REPORTS }), samePo);
  assert(d.outcome === "person" && d.reason === "several_jobs");
});

// ── Site candidates ─────────────────────────────────────────

Deno.test("Site: an open works job with no reference at the card's site, same customer, is the works candidate", () => {
  const card = job({ job_number: "SWMS-1", type: "makesafe", status: "complete", builder: "mlb", client_name: "Customer A", refs: { details_external_ref: "MLB-11111", builder_po_number: "PO-22222" } });
  const sibling = job({ job_number: "SWR-2", type: "repair", status: "scheduled", client_name: "customer a" });
  const d = decideBuilderReference(inv({ reference: "MLB-11111PO-22222", text: "Carpentry - External: replace fascia" }), [card, sibling]);
  assertEquals(linkedTo(d), "SWR-2");
  assert(d.outcome === "link");
  const c = d.evidence.candidates.find((x) => x.job_number === "SWR-2")!;
  assertEquals([c.found, c.site_of], ["site", ["SWMS-1"]]);
});

Deno.test("Site: another claim's job, a finished job, another customer or another site is not a candidate", () => {
  const card = job({ job_number: "SWMS-1", type: "makesafe", status: "complete", builder: "mlb", refs: { details_external_ref: "MLB-11111" } });
  const others = [
    job({ job_number: "SWR-OTHER-CLAIM", type: "repair", status: "scheduled", refs: { mlb_ref: "MLB-33333" } }),
    job({ job_number: "SWR-FINISHED", type: "repair", status: "complete" }),
    job({ job_number: "SWR-OTHER-CUSTOMER", type: "repair", status: "scheduled", client_name: "Customer B" }),
    job({ job_number: "SWR-OTHER-SITE", type: "repair", status: "scheduled", site_key: "9 other st" }),
  ];
  const d = decideBuilderReference(inv({ reference: "MLB-11111PO-22222", text: "Carpentry - External: replace fascia" }), [card, ...others]);
  assert(d.outcome === "person" && d.reason === "no_job_of_this_trade");
  assertEquals(d.evidence.candidates.map((c) => c.job_number), ["SWMS-1"]);
});

Deno.test("Site: same builder counts as the same party when the customer name differs", () => {
  const card = job({ job_number: "SWMS-1", type: "makesafe", status: "complete", builder: "mlb", client_name: "QBE insured - name TBC", refs: { details_external_ref: "MLB-11111" } });
  const sibling = job({ job_number: "SWR-2", type: "repair", status: "scheduled", builder: "mlb", client_name: "Customer A" });
  assertEquals(linkedTo(decideBuilderReference(inv({ reference: "MLB-11111PO-22222", text: "Carpentry - External: replace fascia" }), [card, sibling])), "SWR-2");
});

// ── What never stays ─────────────────────────────────────────

Deno.test("A finished job its other invoices already cover in full is dropped; one with no known value is kept", () => {
  const full = job({ job_number: "SWR-FULL", type: "repair", status: "complete", quoted_value: 1100, refs: { mlb_ref: "MLB-44444" }, invoices: [{ id: "other", invoice_number: "INV-9", total: 1100, status: "PAID" }] });
  const open = job({ job_number: "SWR-OPEN", type: "repair", status: "processing", refs: { mlb_ref: "MLB-44444" } });
  const d = decideBuilderReference(inv({ reference: "MLB-44444PO-55555", text: "Carpentry - External: replace gate" }), [full, open]);
  assertEquals(linkedTo(d), "SWR-OPEN");
  assert(d.outcome === "link");
  assertEquals(d.evidence.candidates.find((c) => c.job_number === "SWR-FULL")!.dropped, "finished_and_invoiced_in_full");
  // The invoice being placed never counts against its own job; a work order value counts with GST.
  const self = job({ job_number: "SWR-SELF", type: "repair", status: "complete", work_order_value_ex_gst: 1000, refs: { mlb_ref: "MLB-44444" }, invoices: [{ id: "row-MLB-44444PO-55555", invoice_number: "INV-TEST", total: 1100, status: "AUTHORISED" }] });
  assertEquals(linkedTo(decideBuilderReference(inv({ reference: "MLB-44444PO-55555", text: "Carpentry - External: replace gate" }), [self])), "SWR-SELF");
  const noValue = job({ job_number: "SWR-NOVALUE", type: "repair", status: "complete", refs: { mlb_ref: "MLB-44444" }, invoices: [{ id: "other", invoice_number: "INV-9", total: 9999, status: "PAID" }] });
  assertEquals(linkedTo(decideBuilderReference(inv({ reference: "MLB-44444PO-55555", text: "Carpentry - External: replace gate" }), [noValue])), "SWR-NOVALUE");
});

Deno.test("Cancelled, lost, draft, holding and old-system jobs never take the invoice", () => {
  for (const o of [{ status: "cancelled" }, { status: "lost" }, { status: "draft" }, { status: "processing", do_not_schedule: true }, { status: "processing", legacy: true }]) {
    const d = decideBuilderReference(inv({ reference: "MLB-66666PO-77777", text: "make-safe attendance", tracking: MAKESAFE }), [job({ job_number: "SWMS-X", type: "makesafe", ...o, refs: { details_external_ref: "MLB-66666" } })]);
    assert(d.outcome === "person" && d.reason === "no_job_of_this_trade", JSON.stringify(o));
  }
});

Deno.test("An invoice that reads as both make-safe and works links nothing", () => {
  const d = decideBuilderReference(
    inv({ reference: "MLB-66666PO-77777", text: "Make safe: attended site and collected temp fencing; supply and install new gate" }),
    [job({ job_number: "SWMS-X", type: "makesafe", status: "processing", refs: { details_external_ref: "MLB-66666" } }), job({ job_number: "SWR-Y", type: "repair", status: "processing", refs: { mlb_ref: "MLB-66666" } })],
  );
  assert(d.outcome === "person" && d.reason === "trade_unclear");
});

Deno.test("Not this rule: a job number in the reference, no builder reference, a bill, before 1 Jul 2026, no date", () => {
  const rows = [job({ job_number: "SWMS-X", type: "makesafe", status: "processing", refs: { details_external_ref: "MLB-66666" } })];
  const cases: Array<[BuilderRefInvoice, string]> = [
    [inv({ reference: "SWMS-261163 MLB-66666", text: "make-safe" }), "job_number_in_reference"],
    [inv({ reference: "DEP12", text: "Deposit ($5,896.00)" }), "no_builder_reference"],
    [inv({ reference: "MLB-66666", text: "make-safe", invoice_type: "ACCPAY" }), "not_customer_invoice"],
    [inv({ reference: "MLB-66666", text: "make-safe", invoice_date: "2026-06-30" }), "before_measured_period"],
    [inv({ reference: "MLB-66666", text: "make-safe", invoice_date: null }), "before_measured_period"],
  ];
  for (const [invoice, reason] of cases) {
    const d = decideBuilderReference(invoice, rows);
    assert(d.outcome === "not_applicable" && d.reason === reason, `${invoice.reference}: ${JSON.stringify(d)}`);
  }
});

Deno.test("No job carries the reference: no candidate (the contact-name rule runs as before)", () => {
  assertEquals(decideBuilderReference(inv({ reference: "HPO000012751", text: "Deposit" }), []).outcome, "no_candidate");
});

Deno.test("A batch read for many invoices gives the same answer as a read for one", () => {
  const one = [SWMS_261163, SWF_261360];
  const batch = [...one, ...SIBLINGS, job({ job_number: "SWR-Z", type: "repair", status: "processing", site_key: "53 example st", refs: { mlb_ref: "MLB-99998" } })];
  const invoice = inv({ reference: "MLB-26303PO-58097", text: "Carpentry - External\nRemove and replace 2 x Colorbond drive gates" });
  assertEquals(decideBuilderReference(invoice, batch), decideBuilderReference(invoice, one));
});

// ── Keys and trades ──────────────────────────────────────────

Deno.test("Keys: claim, PO, the Ambrose job-PO form, SES tokens, dollar amounts and the first line", () => {
  assertEquals(parseBuilderKeys("MLB-26303PO-58097"), { claims: ["26303"], pos: ["58097"] });
  assertEquals(parseBuilderKeys("MLB-RR-27884PO-59203 - Roof report"), { claims: ["27884"], pos: ["59203"] });
  assertEquals(parseBuilderKeys("20305206-05"), { claims: ["20305206"], pos: ["2030520605"] });
  assertEquals(parseBuilderKeys("AJBR-70487 | SES-9558fb58-39de-5ab2-ac5d-591958993047"), { claims: ["70487"], pos: [] });
  assertEquals(parseBuilderKeys("Deposit (50% of $12,345.00) SWF-261280"), { claims: [], pos: [] });
  assertEquals(parseBuilderKeys("MLB-27023PO-RET14"), { claims: ["27023"], pos: [] });
  assertEquals(builderReferenceKeys(inv({ reference: "JOB-DEP", text: "Make safe: Job 20333978 | site" })), { claims: ["20333978"], pos: [], source: "first_line" });
  assertEquals(builderReferenceKeys(inv({ reference: "MLB-40502PO-62815", text: "MLB-99999" })).source, "reference");
});

Deno.test("Trades: tracking first, line words decide insurance work, job type before prefix", () => {
  assertEquals(invoiceTrade(inv({ reference: "MLB-1", text: "temporary fencing make-safe - 2 trades x 4 hours" })), "makesafe");
  assertEquals(invoiceTrade(inv({ reference: "MLB-1", text: "Roof report inspection", tracking: REPORTS })), "makesafe");
  assertEquals(invoiceTrade(inv({ reference: "MLB-1", text: "Carpentry - External: gutter" })), "works");
  assertEquals(invoiceTrade(inv({ reference: "MLB-1", text: "Fencing - External: sliding gate", tracking: [{ Option: "SW - FENCING" }] })), "works");
  assertEquals(invoiceTrade(inv({ reference: "MLB-1", text: "Strip and replace downpipe", tracking: MAKESAFE })), "mixed");
  assertEquals(invoiceTrade(inv({ reference: "X", text: "Labour", tracking: [] })), "unknown");
  // Temporary fencing is make-safe gear: its words are never works words (INV-1709).
  assertEquals(invoiceTrade(inv({ reference: "X", text: "collected 5 panels of temp fencing (temp fence pickup)" })), "makesafe");
  assertEquals(invoiceTrade(inv({ reference: "X", text: "Temporary fencing - 10 panels, temporary fence gates" })), "makesafe");
  assertEquals(invoiceTrade(inv({ reference: "X", text: "Fencing - External: supply and install Colorbond; remove temp fencing" })), "mixed");
  assertEquals(invoiceTrade(inv({ reference: "X", text: "Fencing - External: supply and install Colorbond fence" })), "works");
  assertEquals(jobTrade({ type: "repair", job_number: "SWF-261359" }), "works");
  assertEquals(jobTrade({ type: "insurance", job_number: "SWMS-26931" }), "any");
  assertEquals(jobTrade({ type: null, job_number: "SWMS-1" }), "makesafe");
  assertEquals(jobTrade({ type: null, job_number: "SWB-1" }), "works");
  assertEquals(jobTrade({ type: "miscellaneous", job_number: "SWM-1" }), "other");
});

Deno.test("The person's item names every candidate and why, with a link option for each", () => {
  const d = decideBuilderReference(inv({ reference: "MLB-27580", text: "make-safe attendance", tracking: MAKESAFE, xero_invoice_id: "xero-77" }), SIBLINGS);
  assert(d.outcome === "person");
  const a = builderReferenceAnnotation({ ...inv({ reference: "MLB-27580", text: "x", xero_invoice_id: "xero-77" }), total: 330 }, d, "org-1");
  assertEquals(a.annotation_type, "unlinked_invoice");
  assertEquals(a.source_ref, "sync:unlinked:xero-77");
  assertEquals(a.structured_data.xero_invoice_id, "xero-77");
  assertEquals(a.structured_data.candidate_jobs.map((c) => c.job_number), ["SWMS-261170", "SWMS-261171"]);
  assertEquals(a.response_options.map((o) => o.value), ["link:job-SWMS-261170", "link:job-SWMS-261171", "dismiss"]);
  assert(a.body.includes("SWMS-261170") && a.body.includes("more than one job fits"), a.body);
  assert(!/—/.test(a.title + a.body), "no em dash in staff text");
});

// ════════════════════════════════════════════════════════════
// matchUnlinkedInvoices: Strategy 1b in place
// ════════════════════════════════════════════════════════════

type Call = { table: string; select?: string; filters: Array<{ op: string; args: unknown[] }>; update?: Record<string, unknown>; insert?: unknown };

function fakeClient(o: {
  sales: unknown[];
  candidates?: { data: unknown; error: unknown };
  linkWrite?: "ok" | "lost";
  jobsByContact?: unknown[];
  annotations?: unknown[];
}) {
  const calls: Call[] = [];
  const rpcs: Array<{ name: string; args: unknown }> = [];
  const inserts: Array<{ table: string; row: any }> = [];
  function builder(table: string) {
    const call: Call = { table, filters: [] };
    let mode: "select" | "update" | "insert" = "select";
    const b: any = {
      select: (s: string) => { call.select = s; return b; },
      update: (row: Record<string, unknown>) => { mode = "update"; call.update = row; return b; },
      insert: (row: unknown) => { mode = "insert"; call.insert = row; inserts.push({ table, row }); return b; },
      eq: (...a: unknown[]) => { call.filters.push({ op: "eq", args: a }); return b; },
      is: (...a: unknown[]) => { call.filters.push({ op: "is", args: a }); return b; },
      not: (...a: unknown[]) => { call.filters.push({ op: "not", args: a }); return b; },
      ilike: (...a: unknown[]) => { call.filters.push({ op: "ilike", args: a }); return b; },
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: any, reject?: any) => {
        calls.push(call);
        let out: unknown = { data: null, error: null };
        if (mode === "update") out = { data: o.linkWrite === "lost" ? [] : [{ id: "x" }], error: null };
        else if (mode === "insert") out = { data: null, error: null };
        else if (table === "xero_invoices") {
          const type = call.filters.find((f) => f.op === "eq" && f.args[0] === "invoice_type")?.args[1];
          out = { data: type === "ACCREC" ? o.sales : [], error: null };
        } else if (table === "jobs") out = { data: o.jobsByContact ?? [], error: null };
        else if (table === "ai_annotations") out = { data: o.annotations ?? [], error: null };
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return b;
  }
  const client = {
    from: (t: string) => builder(t),
    rpc: (name: string, args: unknown) => {
      rpcs.push({ name, args });
      if (name === "xero_builder_reference_candidates") return Promise.resolve(o.candidates ?? { data: [], error: null });
      return Promise.resolve({ data: true, error: null });
    },
  };
  return { client, calls, rpcs, inserts };
}

const SALE_1775 = {
  id: "row-1775", xero_invoice_id: "xero-1775", invoice_number: "INV-1775", invoice_type: "ACCREC", status: "AUTHORISED",
  reference: "MLB-26303PO-58097", contact_name: "Major Loss Builders", total: 3179, invoice_date: "2026-10-29",
  invoice_obligation_revision_id: null, ses_external_token: null,
  line_items: [{ Description: "MLB-26303PO-58097 | Carpentry - External\nRemove and replace 2 x Colorbond drive gates", Tracking: INSURANCE }],
};

Deno.test("Matcher: a builder reference link writes only the job, guarded, and records the rule and its evidence", async () => {
  const { client, calls, rpcs, inserts } = fakeClient({ sales: [SALE_1775], candidates: { data: [SWMS_261163, SWF_261360], error: null } });
  const r: any = await matchUnlinkedInvoices(client);
  assertEquals([r.matched, r.flagged, r.builder_reference.linked], [1, 0, 1]);
  assertEquals(rpcs.filter((x) => x.name === "xero_builder_reference_candidates").map((x) => x.args), [{ p_keys: ["26303", "58097"] }]);
  const write = calls.find((c) => c.table === "xero_invoices" && c.update)!;
  assertEquals(Object.keys(write.update!).sort(), ["job_id", "updated_at"]);
  assertEquals(write.update!.job_id, "job-SWF-261360");
  assert(write.filters.some((f) => f.op === "is" && f.args[0] === "job_id" && f.args[1] === null), "guarded by job_id is null");
  const ev = inserts.find((i) => i.table === "business_events")!.row;
  assertEquals([ev.event_type, ev.job_id, ev.match_method, ev.payload.method, ev.payload.rule], ["invoice.auto_linked", "job-SWF-261360", "direct_reference", "builder_reference", BUILDER_REFERENCE_RULE]);
  assertEquals(ev.payload.evidence.candidates.map((c: any) => [c.job_number, c.kept]), [["SWF-261360", true], ["SWMS-261163", false]]);
  assert(!calls.some((c) => c.table === "jobs" && c.filters.some((f) => f.op === "ilike")), "contact-name match not consulted");
});

Deno.test("Matcher: a builder reference link closes that invoice's open item for a person, and nothing else", async () => {
  const { client, calls } = fakeClient({ sales: [SALE_1775], candidates: { data: [SWMS_261163, SWF_261360], error: null } });
  await matchUnlinkedInvoices(client);
  const close = calls.filter((c) => c.table === "ai_annotations" && c.update);
  assertEquals(close.length, 1);
  const u = close[0].update! as { status: string; resolved_by: string; resolved_at: unknown; resolution: { value: string; text: string; job_id: string } };
  assertEquals([u.status, u.resolved_by, u.resolution.value, u.resolution.job_id], ["resolved", "auto", "auto_linked", "job-SWF-261360"]);
  assert(typeof u.resolved_at === "string" && !/—/.test(u.resolution.text), u.resolution.text);
  assertEquals(close[0].filters, [{ op: "eq", args: ["source_ref", "sync:unlinked:xero-1775"] }, { op: "eq", args: ["status", "active"] }]);

  // No link (a person decides, or another writer linked it first): no item is closed.
  const person = fakeClient({ sales: [{ ...SALE_1775, reference: "MLB-27580", line_items: [{ Description: "make-safe attendance", Tracking: MAKESAFE }] }], candidates: { data: SIBLINGS, error: null } });
  await matchUnlinkedInvoices(person.client);
  assertEquals(person.calls.filter((c) => c.table === "ai_annotations" && c.update).length, 0);
  const lost = fakeClient({ sales: [SALE_1775], candidates: { data: [SWMS_261163, SWF_261360], error: null }, linkWrite: "lost" });
  await matchUnlinkedInvoices(lost.client);
  assertEquals(lost.calls.filter((c) => c.table === "ai_annotations" && c.update).length, 0);
});

Deno.test("Matcher: several candidates become one person's item and no contact-name guess", async () => {
  const sale = { ...SALE_1775, reference: "MLB-27580", line_items: [{ Description: "make-safe attendance", Tracking: MAKESAFE }] };
  const { client, calls, inserts } = fakeClient({ sales: [sale], candidates: { data: SIBLINGS, error: null }, jobsByContact: [{ id: "job-guess", job_number: "SWMS-GUESS" }] });
  const r: any = await matchUnlinkedInvoices(client);
  assertEquals([r.matched, r.flagged, r.builder_reference.flagged], [0, 1, 1]);
  assert(!calls.some((c) => c.table === "xero_invoices" && c.update), "no link written");
  const ann = inserts.find((i) => i.table === "ai_annotations")!.row;
  assertEquals([ann.annotation_type, ann.source_ref, ann.structured_data.reason], ["unlinked_invoice", "sync:unlinked:xero-1775", "several_jobs"]);
  assert(!calls.some((c) => c.table === "jobs" && c.filters.some((f) => f.op === "ilike")), "contact-name match not consulted");
});

Deno.test("Matcher: an invoice a person already resolved or dismissed is not raised again", async () => {
  const sale = { ...SALE_1775, reference: "MLB-27580", line_items: [{ Description: "make-safe attendance", Tracking: MAKESAFE }] };
  const { client, calls, inserts } = fakeClient({ sales: [sale], candidates: { data: SIBLINGS, error: null }, annotations: [{ id: "ann-dismissed" }] });
  const r: any = await matchUnlinkedInvoices(client);
  assertEquals(r.flagged, 1);
  assertEquals(inserts.filter((i) => i.table === "ai_annotations").length, 0);
  const read = calls.find((c) => c.table === "ai_annotations" && c.select)!;
  assert(!read.filters.some((f) => f.args[0] === "status"), "the look-up covers every status");
});

Deno.test("Matcher: a failed candidate read links nothing by the rule and the contact-name match runs as before", async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const { client, calls } = fakeClient({ sales: [SALE_1775], candidates: { data: null, error: { message: "boom" } }, jobsByContact: [] });
    const r: any = await matchUnlinkedInvoices(client);
    assertEquals([r.matched, r.builder_reference.ready, r.builder_reference.error], [0, false, "boom"]);
    assert(!calls.some((c) => c.table === "xero_invoices" && c.update));
    assert(calls.some((c) => c.table === "jobs" && c.filters.some((f) => f.op === "ilike")), "contact-name match ran");
  } finally {
    console.error = orig;
  }
});

Deno.test("Matcher: an SES-bound invoice is refused, a lost race records nothing, no keys means no read", async () => {
  const ses = fakeClient({ sales: [{ ...SALE_1775, ses_external_token: "tok" }], candidates: { data: [SWMS_261163, SWF_261360], error: null } });
  const r1: any = await matchUnlinkedInvoices(ses.client);
  assertEquals([r1.matched, r1.refused], [0, 1]);
  assert(!ses.calls.some((c) => c.table === "xero_invoices" && c.update));

  const lost = fakeClient({ sales: [SALE_1775], candidates: { data: [SWMS_261163, SWF_261360], error: null }, linkWrite: "lost" });
  const r2: any = await matchUnlinkedInvoices(lost.client);
  assertEquals([r2.matched, r2.builder_reference.linked], [0, 0]);
  assertEquals(lost.inserts.filter((i) => i.table === "business_events").length, 0);

  const none = fakeClient({ sales: [{ ...SALE_1775, reference: null, line_items: [{ Description: "Labour" }] }] });
  await matchUnlinkedInvoices(none.client);
  assertEquals(none.rpcs.filter((x) => x.name === "xero_builder_reference_candidates").length, 0);
});

Deno.test("Matcher: customer invoices are read with their date and lines; bills are not", async () => {
  const { client, calls } = fakeClient({ sales: [] });
  await matchUnlinkedInvoices(client);
  const reads = calls.filter((c) => c.table === "xero_invoices" && c.select);
  const sales = reads.find((c) => c.filters.some((f) => f.args[0] === "invoice_type" && f.args[1] === "ACCREC"))!;
  const bills = reads.find((c) => c.filters.some((f) => f.args[0] === "invoice_type" && f.args[1] === "ACCPAY"))!;
  assert(sales.select!.includes("invoice_date") && sales.select!.includes("line_items"), sales.select);
  assert(!bills.select!.includes("line_items"), bills.select);
});

Deno.test("a restoration card is make-safe work by its SWRESTO- number", () => {
  assertEquals(jobTrade({ type: null as unknown as string, job_number: "SWRESTO-261800" }), "makesafe");
  assertEquals(jobTrade({ type: "makesafe", job_number: "SWRESTO-261800" }), "makesafe");
});
