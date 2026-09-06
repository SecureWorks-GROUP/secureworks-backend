// deno-lint-ignore-file no-import-prefix no-explicit-any
// Trade app three-tier access model (Captain ruling 2026-08-17):
//
//   1. Office (admin / owner / ops_manager)   everything, everywhere.
//   2. Division manager (users.managed_verticals contains the job's vertical)
//                                              everything on that trade's jobs,
//                                              quote included, allocation rights.
//   3. Allocated trade (job_assignments row, is_lead TRUE OR FALSE — no
//      difference)                             everything on the job EXCEPT
//                                              quote MONEY. TRD-4 keeps quote
//                                              writing + quote numbers.
//
// One predicate carries the decision (resolveTradeJobAccessTier); one rule
// carries the quote fence (tradeQuoteVisibleForTier). This suite proves both
// directions for every tier — granted AND refused — and drives the REAL
// trade_job_detail / trade_labour_budget handlers so a helper that is correct
// but unwired cannot pass.

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _getServiceReportForTest,
  _myJobsPersonalRecencyFilter,
  _resolveManagerVisibility,
  _scopeCalendarPayloadToVerticals,
  _submitServiceReportForTest,
  _tradeDocumentsForAllocatedTrade,
  _tradeJobDetailForTest,
  _tradeQuoteExtractForTest,
  _tradeLabourBudgetForTest,
  _tradeScopeSummary,
  ApiError,
  projectTradePurchaseOrders,
  assertAllocatedTradeQuotePackProjection,
  redactTradeQuotePackMoney,
  redactTradeScopeQuote,
  redactTradeWorkOrderScopeItems,
  redactTradeWorkOrdersForAllocated,
  sanitizeTradeAllocatedJobNotes,
  tradeLabourCostVisibleForTier,
  resolveTradeJobAccessTier,
  TRADE_JOB_SERVICE_REPORT_COLUMNS,
  TRADE_PRICED_WORK_ORDER_DOCUMENT_TYPES,
  TRADE_QUOTE_DOCUMENT_TYPES,
  tradeIsDesignatedLead,
  tradeJobAccessRefusal,
  tradeLeadJobIds,
  tradeQuoteVisibleForTier,
  tradeViewerQuoteVisibleForJob,
} from "./index.ts";
import { packTradeQuote } from "../_shared/trade_quote_pack/pack_trade_quote.ts";

// ── Stub client ─────────────────────────────────────────────────────────────
// Same generic chainable stand-in the crew-visibility suite uses: accumulates
// predicates and resolves against in-memory tables, so the tests exercise the
// real query chains the handlers issue.

type Tables = Record<string, any[]>;

function makeClient(tables: Tables, recorded: any[] = []) {
  function builder(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const rec: any = { table, eq: {}, neq: {}, is: {} };
    recorded.push(rec);
    let limitN: number | null = null;
    let selectCols: string[] | null = null;
    const run = () => {
      let rows = (tables[table] || []).filter((r) => preds.every((p) => p(r)));
      if (limitN != null) rows = rows.slice(0, limitN);
      // Honour a plain column projection (no embeds / wildcard) so a column the
      // handler does NOT select — pricing_json, say — cannot reach the payload
      // through the stub and hide a real leak or fake one.
      if (selectCols) {
        rows = rows.map((r) => {
          const out: any = {};
          for (const c of selectCols!) if (c in (r || {})) out[c] = r[c];
          return out;
        });
      }
      return { data: rows, error: null };
    };
    const api: any = {
      select: (cols?: string) => {
        const c = String(cols || "").trim();
        rec.select = c;
        selectCols = c && c !== "*" && !c.includes("(") && !c.includes(":")
          ? c.split(",").map((x) => x.trim()).filter(Boolean)
          : null;
        return api;
      },
      order: () => api,
      limit: (n: number) => {
        limitN = n;
        return api;
      },
      eq: (c: string, v: any) => {
        rec.eq[c] = v;
        preds.push((r) => String(r?.[c] ?? "") === String(v));
        return api;
      },
      neq: (c: string, v: any) => {
        rec.neq[c] = v;
        preds.push((r) => String(r?.[c] ?? "") !== String(v));
        return api;
      },
      in: (c: string, vals: any[]) => {
        preds.push((r) => vals.map(String).includes(String(r?.[c] ?? "")));
        return api;
      },
      is: (c: string, v: any) => {
        rec.is[c] = v;
        preds.push((r) => (r?.[c] ?? null) === v);
        return api;
      },
      not: () => api,
      single: () => {
        const { data } = run();
        return Promise.resolve({ data: data[0] ?? null, error: null });
      },
      maybeSingle: () => {
        const { data } = run();
        return Promise.resolve({ data: data[0] ?? null, error: null });
      },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      insert: (row: any) => {
        const rec = { id: row?.id || `${table}-${(tables[table] || []).length + 1}`, ...row };
        (tables[table] ||= []).push(rec);
        const inserted = { data: rec, error: null };
        const chain: any = {
          select: () => chain,
          single: () => Promise.resolve(inserted),
          maybeSingle: () => Promise.resolve(inserted),
          then: (res: any, rej: any) => Promise.resolve(inserted).then(res, rej),
        };
        return chain;
      },
      update: (row: any) => {
        const matched = (tables[table] || []).filter((r) => preds.every((p) => p(r)));
        for (const r of matched) Object.assign(r, row);
        const updated = { data: matched[0] ?? null, error: null };
        const chain: any = {
          select: () => chain,
          eq: api.eq,
          single: () => Promise.resolve(updated),
          maybeSingle: () => Promise.resolve(updated),
          then: (res: any, rej: any) => Promise.resolve(updated).then(res, rej),
        };
        return chain;
      },
    };
    return api;
  }
  return {
    from: (t: string) => builder(t),
    storage: {
      createBucket: async () => ({}),
      from(bucket: string) {
        return {
          upload: async () => ({ error: null }),
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://storage.test/${bucket}/${path}` },
          }),
        };
      },
    },
  };
}

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const JOB_FENCE = "job-fence";
const JOB_PATIO = "job-patio";
const JOB_MS = "job-ms";
const JOB_FENCE_B = "job-fence-b";
const HENRY = "u-henry"; // fencing division manager, not on any crew
const LEAD = "u-lead"; // allocated, is_lead=true
const CREW = "u-crew"; // allocated, is_lead=false
const STRANGER = "u-stranger"; // no vertical, no allocation
const OFFICE = "u-ops"; // ops_manager

// The quote as the scoping tools actually write it into jobs.scope_json.
const QUOTE_SCOPE = {
  tool: "patio",
  config: { totalMetres: 42, colour: "Monument", margin: 12 /* structural key on a config, still stripped by name */ },
  client: { notes: "Gate on the left" },
  pricing: {
    addonRows: [{ desc: "Extra post", sell: 250 }],
    extrasRows: [{ desc: "Skip bin", sell: 350 }],
    labour: { trades: 2, days: 3, dayRate: 400, sell: 3200 },
  },
    notes: {
    pricingNotes: "Priced at 35% margin",
    noteQuote: "Quote note text",
    noteWorkOrder: "Use 90x90 posts",
    noteInternal: "Client is a repeat customer. Do not mention $9,999",
  },
  _pricing_json: { totalExGST: 8000, totalIncGST: 8800, marginPct: 35 },
  patios: [{
    options: [{
      label: "Standard",
      pricing: { labour: { days: 2, dayRate: 400, sell: 1600 } },
      _pricing_json: { totalIncGST: 6600 },
    }],
  }],
  // Real production keys from the scope_json audit in
  // _shared/release_packet/adapters/LOOP2_DRYRUN_REPORT.md §2: fencing writes
  // job.pricePerMetre (x runs[].length = the quoted total), patio writes a
  // top-level job_costs.
  job_costs: { labour: 2400, materials: 3100, total: 5500 },
  job: {
    _pricing_json: { totalExGST: 5000 },
    pricePerMetre: 125,
    runs: [{ length: 10 }],
    siteNotes: "Park on the verge. Extra $9,999",
    supplierNotes: "Call before arrival. Charge 1,200 ex GST",
    quote: {
      quote_number: "Q-NARR",
      description: "Supply and install Monument fencing with a gate on the left.",
      materials: [{ name: "90x90 posts", qty: 12, unit_price: 45, total: 540 }],
      lineTotalEx: 540,
      gstAmount: 54,
      quotedTotal: 594,
    },
  },
};

function stampFrozenSentQuote(doc: any, sentAt = "2026-09-01T00:00:00Z") {
  doc.sent_at = sentAt;
  doc.trade_pack_json = packTradeQuote({
    quote_number: doc.quote_number,
    job_document_id: doc.id,
    sent_at: sentAt,
    job_type: "fencing",
    scope_json: structuredClone(QUOTE_SCOPE),
    pricing_json: { payment_terms: "50% deposit + 50% on completion", valid_days: 30 },
    source: "frozen",
  });
  return doc;
}

function seed(): Tables {
  return {
    jobs: [
      {
        id: JOB_FENCE,
        org_id: ORG_A,
        type: "fencing",
        status: "scheduled",
        job_number: "SWF-26091",
        client_name: "Client One",
        site_address: "1 Fence St",
        site_suburb: "Midland",
        scope_json: structuredClone(QUOTE_SCOPE),
        pricing_json: { labourTotal: 3200, total: 8800 },
        notes: "Park on the verge. Extra $9,999. Charge 1,200 excluding GST. Client approved $9,999 excluding GST.",
        metadata: { builder_po_number: "PO-1" },
      },
      {
        id: JOB_PATIO,
        org_id: ORG_A,
        type: "patio",
        status: "scheduled",
        job_number: "SWP-26100",
        scope_json: structuredClone(QUOTE_SCOPE),
      },
      {
        id: JOB_MS,
        org_id: ORG_A,
        type: "makesafe",
        status: "in_progress",
        job_number: "SWMS-26900",
        scope_json: {},
      },
      {
        id: JOB_FENCE_B,
        org_id: ORG_B,
        type: "fencing",
        status: "scheduled",
        job_number: "SWF-99001",
        scope_json: structuredClone(QUOTE_SCOPE),
      },
    ],
    // Lead and crew are both allocated to the fencing job. Henry is on none.
    // Every row carries the WORTHLESS default role so a role-based lead read
    // would wrongly call the crew member a lead too.
    job_assignments: [
      { id: "a-lead", job_id: JOB_FENCE, user_id: LEAD, status: "scheduled", is_lead: true, role: "lead_installer" },
      { id: "a-crew", job_id: JOB_FENCE, user_id: CREW, status: "scheduled", is_lead: false, role: "lead_installer" },
      { id: "a-crew-patio", job_id: JOB_PATIO, user_id: CREW, status: "scheduled", is_lead: false, role: "lead_installer" },
      { id: "a-crew-b", job_id: JOB_FENCE_B, user_id: CREW, status: "scheduled", is_lead: false, role: "lead_installer" },
    ],
    job_documents: [
      { id: "d-wo", job_id: JOB_FENCE, type: "work_order", visible_to_trades: true, file_name: "wo.pdf" },
      { id: "d-supplier-wo", job_id: JOB_FENCE, type: "supplier_work_order", visible_to_trades: true, file_name: "swo.pdf" },
      // ops flagged this QUOTE visible — the flag must not be enough.
      { id: "d-quote-vis", job_id: JOB_FENCE, type: "quote", visible_to_trades: true, file_name: "quote.pdf", quote_number: "Q-1" },
      { id: "d-quote-hid", job_id: JOB_FENCE, type: "quote", visible_to_trades: false, file_name: "quote-v2.pdf", quote_number: "Q-2" },
      { id: "d-invoice", job_id: JOB_FENCE, type: "invoice", visible_to_trades: true, file_name: "inv.pdf" },
      { id: "d-supplier-quote", job_id: JOB_FENCE, type: "supplier_quote", visible_to_trades: true, file_name: "sq.pdf" },
      { id: "d-internal", job_id: JOB_FENCE, type: "general", visible_to_trades: false, file_name: "internal.pdf" },
    ],
    job_media: [],
    job_events: [],
    job_service_reports: [],
    work_orders: [{
      id: "wo-1",
      job_id: JOB_FENCE,
      wo_number: "WO-1",
      scope_items: [{
        description: "Install fence Total $850",
        name: "Fence run $850",
        label: "Front run $850",
        title: "WO line $850",
        instructions: "Use 90x90 posts. Charge $850 extra.",
        notes: "Priced $850 — hide from trade",
        text: "Line text $850",
        quantity: 10,
        unit: "m",
        rate: 85,
        unit_price: 85,
        total: 850,
        unitPriceEx: 77,
        lineTotalEx: 777,
        gstAmount: 7.7,
        quotedTotal: 784,
        cost: 12,
        pricing: { amount: 99 },
      }],
      special_instructions: "Park on the verge. Charge $9,999 extra.",
      status: "sent",
    }],
    purchase_orders: [{ id: "po-1", job_id: JOB_FENCE, status: "sent", total: 1000, line_items: [{ description: "Labour install", quantity: 2, unit_price: 300 }] }],
    makesafe_job_details: [],
    makesafe_roof_report_drafts: [],
    trade_rates: [],
    users: [],
  };
}

const viewer = (id: string, role: string, managedVerticals: string[] = []) => ({
  id,
  email: `${id}@example.test`,
  orgId: ORG_A,
  role,
  managedVerticals,
});

const office = (role: string) =>
  _resolveManagerVisibility({ role, managedVerticals: [] }).isDispatcher;

async function detail(t: Tables, v: ReturnType<typeof viewer>) {
  const isOffice = office(v.role);
  return await _tradeJobDetailForTest(
    makeClient(t),
    new URLSearchParams({ jobId: JOB_FENCE }),
    v as any,
    isOffice,
  );
}

// ── The predicate itself ─────────────────────────────────────────────────────

Deno.test("tier: office (admin / owner / ops_manager) is office everywhere and sees the quote", async () => {
  for (const role of ["admin", "owner", "ops_manager"]) {
    const isOffice = _resolveManagerVisibility({ role, managedVerticals: [] }).isDispatcher;
    assertEquals(isOffice, true, role);
    const d = await resolveTradeJobAccessTier(makeClient(seed()), JOB_FENCE, OFFICE, {
      isOffice,
      access: { orgId: ORG_A, managedVerticals: [] },
    });
    assertEquals(d.tier, "office", role);
    assertEquals(d.quoteVisible, true, role);
  }
});

Deno.test("tier: a fencing division manager is division_manager on a fencing job they are NOT allocated to, and sees the quote", async () => {
  const d = await resolveTradeJobAccessTier(makeClient(seed()), JOB_FENCE, HENRY, {
    access: { orgId: ORG_A, managedVerticals: ["fencing"] },
  });
  assertEquals(d.tier, "division_manager");
  assertEquals(d.reason, "vertical_manager");
  assertEquals(d.quoteVisible, true);
});

Deno.test("tier: a manager who is ALSO on the crew keeps the manager tier (Henry sees the quote on his own jobs)", async () => {
  const t = seed();
  t.job_assignments.push({ id: "a-henry", job_id: JOB_FENCE, user_id: HENRY, status: "scheduled", is_lead: false, role: "lead_installer" });
  const d = await resolveTradeJobAccessTier(makeClient(t), JOB_FENCE, HENRY, {
    access: { orgId: ORG_A, managedVerticals: ["fencing"] },
  });
  assertEquals(d.tier, "division_manager");
});

Deno.test("tier: a fencing division manager is REFUSED on a patio job (another trade) — none", async () => {
  const d = await resolveTradeJobAccessTier(makeClient(seed()), JOB_PATIO, HENRY, {
    access: { orgId: ORG_A, managedVerticals: ["fencing"] },
  });
  assertEquals(d.tier, "none");
  assertEquals(d.reason, "not_assigned");
  assert(tradeJobAccessRefusal(d) instanceof Error);
});

Deno.test("tier: lead (is_lead=true) and crew (is_lead=false) BOTH resolve to allocated — no difference — and neither sees the quote", async () => {
  const lead = await resolveTradeJobAccessTier(makeClient(seed()), JOB_FENCE, LEAD, {
    access: { orgId: ORG_A, managedVerticals: [] },
  });
  const crew = await resolveTradeJobAccessTier(makeClient(seed()), JOB_FENCE, CREW, {
    access: { orgId: ORG_A, managedVerticals: [] },
  });
  assertEquals(lead.tier, "allocated");
  assertEquals(crew.tier, "allocated");
  assertEquals(lead.quoteVisible, false);
  assertEquals(crew.quoteVisible, false);
  assertEquals({ tier: lead.tier, quoteVisible: lead.quoteVisible, reason: lead.reason },
    { tier: crew.tier, quoteVisible: crew.quoteVisible, reason: crew.reason });
});

Deno.test("tier: a trade with no managed vertical and no allocation is refused — none", async () => {
  const d = await resolveTradeJobAccessTier(makeClient(seed()), JOB_FENCE, STRANGER, {
    access: { orgId: ORG_A, managedVerticals: [] },
  });
  assertEquals(d.tier, "none");
  assertEquals(d.reason, "not_assigned");
  assertEquals(tradeJobAccessRefusal(d)?.message, "You are not assigned to this job");
});

Deno.test("tier: another tenant is refused first, even for a manager of that vertical or an allocated crew row", async () => {
  const mgr = await resolveTradeJobAccessTier(makeClient(seed()), JOB_FENCE_B, HENRY, {
    access: { orgId: ORG_A, managedVerticals: ["fencing"] },
  });
  assertEquals(mgr.tier, "none");
  assertEquals(mgr.reason, "tenant_mismatch");
  const crew = await resolveTradeJobAccessTier(makeClient(seed()), JOB_FENCE_B, CREW, {
    access: { orgId: ORG_A, managedVerticals: [] },
  });
  assertEquals(crew.tier, "none");
  assertEquals(crew.reason, "tenant_mismatch");
  assertEquals(tradeJobAccessRefusal(crew)?.message, "You are not authorized to access this job");
});

Deno.test("tier: the MakeSafe field-report exception is preserved as its own tier and never sees the quote", async () => {
  const d = await resolveTradeJobAccessTier(makeClient(seed()), JOB_MS, STRANGER, {
    access: { orgId: ORG_A, managedVerticals: [] },
  });
  assertEquals(d.tier, "makesafe_open");
  assertEquals(d.quoteVisible, false);
});

Deno.test("tier: the predicate never reads job_assignments.role", async () => {
  const recorded: any[] = [];
  await resolveTradeJobAccessTier(makeClient(seed(), recorded), JOB_FENCE, CREW, {
    access: { orgId: ORG_A, managedVerticals: [] },
  });
  const assignmentReads = recorded.filter((r) => r.table === "job_assignments");
  assert(assignmentReads.length > 0);
  for (const r of assignmentReads) {
    assertEquals("role" in r.eq, false);
    assertEquals("is_lead" in r.eq, false, "is_lead is display only, never a tier input");
  }
});

Deno.test("quote rule: exactly office and division_manager see the quote", () => {
  assertEquals(tradeQuoteVisibleForTier("office"), true);
  assertEquals(tradeQuoteVisibleForTier("division_manager"), true);
  assertEquals(tradeQuoteVisibleForTier("allocated"), false);
  assertEquals(tradeQuoteVisibleForTier("makesafe_open"), false);
  assertEquals(tradeQuoteVisibleForTier("none"), false);
});

Deno.test("list quote fence: office everywhere; manager only in-vertical; crew never", () => {
  assertEquals(
    tradeViewerQuoteVisibleForJob({ type: "patio" }, { isOffice: true, managedVerticals: [] }),
    true,
  );
  assertEquals(
    tradeViewerQuoteVisibleForJob({ type: "fencing" }, { isOffice: false, managedVerticals: ["fencing"] }),
    true,
  );
  assertEquals(
    tradeViewerQuoteVisibleForJob({ type: "patio" }, { isOffice: false, managedVerticals: ["fencing"] }),
    false,
    "a fencing manager's open-pool permission must not quote-unlock a patio card",
  );
  assertEquals(
    tradeViewerQuoteVisibleForJob({ type: "makesafe" }, { isOffice: false, managedVerticals: ["fencing"] }),
    false,
  );
  assertEquals(
    tradeViewerQuoteVisibleForJob({ type: "makesafe" }, { isOffice: false, managedVerticals: ["makesafe"] }),
    true,
  );
  assertEquals(
    tradeViewerQuoteVisibleForJob({ type: "fencing" }, { isOffice: false, managedVerticals: [] }),
    false,
  );
  assertEquals(
    tradeViewerQuoteVisibleForJob(
      { type: "insurance", job_number: "SWMS-261199" },
      { isOffice: false, managedVerticals: ["makesafe"] },
    ),
    true,
    "SWMS- identity is the makesafe vertical",
  );
});

// ── trade_job_detail: the real payload, per tier ─────────────────────────────

function quoteLeakProbe(payload: any): string[] {
  const leaks: string[] = [];
  const clone = payload && typeof payload === "object" ? structuredClone(payload) : payload;
  if (clone && Array.isArray(clone.quote_packs)) {
    for (const pack of clone.quote_packs) {
      if (pack && typeof pack === "object") delete pack.quote_number;
    }
  }
  const text = JSON.stringify(clone);
  for (
    const needle of [
      "_pricing_json",
      "totalIncGST",
      "totalExGST",
      "marginPct",
      "pricingNotes",
      "\"sell\"",
      "dayRate",
      "Q-2",
      "quote.pdf",
      "inv.pdf",
      "8800",
      "8000",
      // Audited production money keys (LOOP2_DRYRUN_REPORT.md §2).
      "pricePerMetre",
      "job_costs",
      "5500",
      "540",
      "850",
      "lineTotalEx",
      "gstAmount",
      "quotedTotal",
      "594",
      "unitPriceEx",
      "777",
      "784",
      "wo.pdf",
      "swo.pdf",
    ]
  ) {
    if (text.includes(needle)) leaks.push(needle);
  }
  return leaks;
}

Deno.test("trade_job_detail: the LEAD gets the job, work order, PO, docs — and no quote by any route", async () => {
  const p = await detail(seed(), viewer(LEAD, "lead_installer"));
  assertEquals(p.access_tier, "allocated");
  assertEquals(p.quote_visible, false);
  assertEquals(p.job.id, JOB_FENCE);
  assertEquals(p.workOrders.length, 1);
  assertEquals(p.purchaseOrders.length, 1);
  assertEquals(p.quote_packs || [], [], "unsent quotes do not become a trade pack");
  assertEquals(p.quote_extracts || [], [], "unsent quotes do not mint an extract pointer");
  assertEquals(quoteLeakProbe(p), [], "no sell price, rate, or quote PDF in the allocated payload");
  // Documents: flagged-visible non-quote, non-priced-WO docs only. The
  // visible-flagged QUOTE, client INVOICE, and full priced work-order PDFs
  // are gone; the supplier quote (a supplier's price to us) stays. Quote
  // numbers on remaining rows are kept. JSON workOrders stay allowlisted.
  assertEquals(p.documents.map((d: any) => d.id).sort(), ["d-supplier-quote"]);
  assertEquals(p.workOrderDocuments, []);
  // Labour headcount/days survive; dayRate is a price and is stripped.
  assertEquals(p.job.scope_json.pricing, { labour: { trades: 2, days: 3 } });
  assertEquals(p.job.scope_json.notes, {
    noteQuote: "Quote note text",
    noteWorkOrder: "Use 90x90 posts",
    noteInternal: "Client is a repeat customer. Do not mention",
  });
  assertEquals(p.job.notes, "Park on the verge. Extra . Charge . Client approved.");
  assertEquals(p.job.scope_json.job.siteNotes, "Park on the verge. Extra");
  assertEquals(p.job.scope_json.job.supplierNotes, "Call before arrival. Charge");
  assertEquals(p.job.scope_json.config.totalMetres, 42);
  assertEquals(p.job.scope_json.job.quote, {
    quote_number: "Q-NARR",
    description: "Supply and install Monument fencing with a gate on the left.",
    materials: [{ name: "90x90 posts", qty: 12 }],
  });
  assertEquals(p.workOrders[0].scope_items, [{
    description: "Install fence Total",
    name: "Fence run",
    label: "Front run",
    title: "WO line",
    instructions: "Use 90x90 posts. Charge extra.",
    notes: "Priced — hide from trade",
    text: "Line text",
    quantity: 10,
    unit: "m",
  }]);
  assertEquals(p.workOrders[0].special_instructions, "Park on the verge. Charge extra.");
  assertEquals(p.workOrder.scope_items[0].rate, undefined);
  assertEquals(p.workOrder.scope_items[0].total, undefined);
  assertEquals(p.workOrder.scope_items[0].unit_price, undefined);
});

Deno.test("trade_job_detail: allocated trade sees sent quote packs by number, never the PDF or sell", async () => {
  const t = seed();
  const vis = t.job_documents.find((d: any) => d.id === "d-quote-vis");
  vis.sent_at = "2026-09-01T00:00:00Z";
  const p = await detail(t, viewer(LEAD, "lead_installer"));
  assertEquals(p.access_tier, "allocated");
  assertEquals(p.quote_visible, false);
  assertEquals(p.quote_packs.length, 1);
  assertEquals(p.quote_packs[0].quote_number, "Q-1");
  assertEquals(p.quote_packs[0].status, "sent");
  assertEquals(p.quote_packs[0].source, "live_fallback");
  const install = (p.quote_packs[0].items || []).find((i: any) => i.kind === "install_m");
  assertEquals(install?.quantity, 10);
  assertEquals(install?.unit_price, null, "allocated trades never see installer or sell rates");
  assertEquals(install?.line_total, null);
  assertEquals(p.documents.map((d: any) => d.id).sort(), ["d-supplier-quote"]);
  assertEquals(p.workOrderDocuments, []);
  assertEquals(p.quote_extracts, [], "sent quote without a frozen pack has no extract");
  assertAllocatedTradeQuotePackProjection(p.quote_packs[0]);
  assertEquals("pricing_json" in (p.job || {}), false, "live pricing_json must not ride the trade payload");
  assertEquals(JSON.stringify(p.documents).includes("quote.pdf"), false);
  assertEquals(JSON.stringify(p.quote_extracts).includes("quote.pdf"), false);
  assertEquals(quoteLeakProbe(p), [], "quote number on the pack is allowed; sell, rates and PDF are not");
});

Deno.test("trade_job_detail: allocated extract pointer requires a frozen pack plus client send", async () => {
  const t = seed();
  const vis = t.job_documents.find((d: any) => d.id === "d-quote-vis");
  stampFrozenSentQuote(vis);
  const p = await detail(t, viewer(LEAD, "lead_installer"));
  assertEquals(p.quote_extracts, [{
    type: "trade_quote_extract",
    label: "Quote extract",
    action: "trade_quote_extract",
    job_document_id: "d-quote-vis",
    quote_number: "Q-1",
    status: "sent",
    sent_at: "2026-09-01T00:00:00Z",
    filename: "SWF-26091-Q-1-trade-extract.html",
  }]);
  assertEquals(p.quote_packs[0].source, "frozen");
  assertEquals(JSON.stringify(p.quote_extracts).includes("quote.pdf"), false);
  assertEquals(quoteLeakProbe(p), [], "extract pointer is price-free");
});

Deno.test("trade_quote_extract: allocated trade gets printable HTML with no money", async () => {
  const t = seed();
  stampFrozenSentQuote(t.job_documents.find((d: any) => d.id === "d-quote-vis"));
  const htmlRes = await _tradeQuoteExtractForTest(
    makeClient(t),
    new URLSearchParams({ jobId: JOB_FENCE, format: "html" }),
    {},
    viewer(LEAD, "lead_installer"),
    false,
  );
  assertEquals(htmlRes.status, 200);
  assertEquals(htmlRes.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await htmlRes.text();
  assert(html.includes("Client One"));
  assert(html.includes("Midland"));
  assert(html.includes("50% deposit + 50% on completion"));
  assertEquals(html.includes("$"), false);
  assertEquals(html.includes("8800"), false);
  assertEquals(html.includes("quote.pdf"), false);
  assertEquals(html.toLowerCase().includes("gst"), false);

  const jsonRes = await _tradeQuoteExtractForTest(
    makeClient(t),
    new URLSearchParams({ jobId: JOB_FENCE, document_id: "d-quote-vis" }),
    {},
    viewer(LEAD, "lead_installer"),
    false,
  );
  const body = await jsonRes.json();
  assertEquals(body.schema, "secureworks.trade-quote-extract/v1");
  assertEquals(body.type, "trade_quote_extract");
  assertEquals(body.filename, "SWF-26091-Q-1-trade-extract.html");
  assertEquals(body.extract.customer.name, "Client One");
  assertEquals(JSON.stringify(body.extract).includes("$"), false);
  assertEquals(JSON.stringify(body.extract).includes("unit_price"), false);
  assertEquals(JSON.stringify(body.extract).includes("line_total"), false);
});

Deno.test("trade_quote_extract: sent quote without a frozen pack is 404", async () => {
  const t = seed();
  t.job_documents.find((d: any) => d.id === "d-quote-vis").sent_at = "2026-09-01T00:00:00Z";
  await assertRejects(
    () =>
      _tradeQuoteExtractForTest(
        makeClient(t),
        new URLSearchParams({ jobId: JOB_FENCE }),
        {},
        viewer(LEAD, "lead_installer"),
        false,
      ),
    ApiError,
    "No sent quote extract for this job",
  );
});

Deno.test("trade_quote_extract: frozen pack without client send is 404", async () => {
  const t = seed();
  const vis = t.job_documents.find((d: any) => d.id === "d-quote-vis");
  stampFrozenSentQuote(vis);
  vis.sent_at = null;
  vis.accepted_at = null;
  await assertRejects(
    () =>
      _tradeQuoteExtractForTest(
        makeClient(t),
        new URLSearchParams({ jobId: JOB_FENCE }),
        {},
        viewer(LEAD, "lead_installer"),
        false,
      ),
    ApiError,
    "No sent quote extract for this job",
  );
  const p = await detail(t, viewer(LEAD, "lead_installer"));
  assertEquals(p.quote_packs || [], [], "unsent frozen pack is not a trade pack");
  assertEquals(p.quote_extracts || [], [], "unsent frozen pack is not an extract");
});

Deno.test("trade_job_detail: pre-send sent_to_client=false stays unpublished even with sent_at", async () => {
  const t = seed();
  const vis = t.job_documents.find((d: any) => d.id === "d-quote-vis");
  vis.sent_at = "2026-09-01T00:00:00Z";
  vis.sent_to_client = false;
  const p = await detail(t, viewer(LEAD, "lead_installer"));
  assertEquals(p.quote_packs || [], [], "pre-send quote rows are not trade packs");
  assertEquals(p.quote_extracts || [], [], "pre-send quote rows are not extracts");
});

Deno.test("trade_job_detail: in-flight send claim is not quote-pack publication", async () => {
  const t = seed();
  const vis = t.job_documents.find((d: any) => d.id === "d-quote-vis");
  vis.send_claimed_at = "2026-09-06T00:00:00Z";
  vis.sent_to_client = false;
  vis.sent_at = null;
  const p = await detail(t, viewer(LEAD, "lead_installer"));
  assertEquals(p.quote_packs || [], [], "in-flight /send claim is not a trade pack");
  assertEquals(p.quote_extracts || [], [], "in-flight /send claim is not an extract");
});

Deno.test("redactTradeQuotePackMoney fail-closes ad-hoc percent payment language", () => {
  const out = redactTradeQuotePackMoney([{
    quote_number: "Q-1",
    customer: { name: "50% upfront client" },
    terms: { payment_terms: "balance due", valid_days: 30 },
    items: [{ kind: "install_m", description: "Pay 40 percent now", quantity: 10, unit: "m" }],
  }]);
  assertEquals(out[0].customer?.name, null);
  assertEquals(out[0].terms?.payment_terms, null);
  assertEquals(out[0].items[0].description, null);
  assertAllocatedTradeQuotePackProjection(out[0]);
  const sealed = redactTradeQuotePackMoney([{
    quote_number: "Q-1",
    terms: { payment_terms: "50% deposit + 50% on completion", valid_days: 30 },
    items: [{ kind: "install_m", description: "Install Deposit", quantity: 10, unit: "m" }],
  }]);
  assertEquals(sealed[0].terms?.payment_terms, "50% deposit + 50% on completion");
  assertEquals(sealed[0].items[0].description, "Install Deposit");
  assertAllocatedTradeQuotePackProjection(sealed[0]);
  const leftover = redactTradeQuotePackMoney([{
    quote_number: "Q-1",
    customer: { name: "Payment in dollars", site_address: "paid in bucks" },
    terms: { payment_terms: "50% deposit + 50% on completion", valid_days: 30 },
    summary: "Payment 50 leftover",
    items: [{ kind: "info", description: "Pay on site", quantity: 1, unit: "ea" }],
  }]);
  assertEquals(leftover[0].customer?.name, null);
  assertEquals(leftover[0].customer?.site_address, null);
  assertEquals(leftover[0].summary, null);
  assertEquals(leftover[0].items[0].description, null);
  assertEquals(leftover[0].terms?.payment_terms, "50% deposit + 50% on completion");
  assertAllocatedTradeQuotePackProjection(leftover[0]);
});

Deno.test("trade_quote_extract: unsent quote is 404 and a stranger is refused", async () => {
  await assertRejects(
    () =>
      _tradeQuoteExtractForTest(
        makeClient(seed()),
        new URLSearchParams({ jobId: JOB_FENCE }),
        {},
        viewer(LEAD, "lead_installer"),
        false,
      ),
    ApiError,
    "No sent quote extract for this job",
  );
  await assertRejects(
    () =>
      _tradeQuoteExtractForTest(
        makeClient(seed()),
        new URLSearchParams({ jobId: JOB_FENCE }),
        {},
        viewer(STRANGER, "lead_installer"),
        false,
      ),
    Error,
  );
});

Deno.test("trade_job_detail: the CREW member gets EXACTLY what the lead gets", async () => {
  const lead = await detail(seed(), viewer(LEAD, "crew"));
  const crew = await detail(seed(), viewer(CREW, "crew"));
  assertEquals(crew, lead);
});

Deno.test("trade_job_detail: allocated path money-sanitizes job event and media notes", async () => {
  const t = seed();
  t.job_events = [{
    id: "e-note",
    job_id: JOB_FENCE,
    event_type: "note",
    detail_json: {
      text: "Client approved $9,999 excluding GST",
      message: "Charge $9,999 extra",
      description: "Approved total 9,999 ex GST",
      body: "Fee 1,200 exclusive of GST",
      content: "Plus 80 +GST",
      amount: 9999,
      qty: 2,
    },
    created_at: "2026-09-01T00:00:00Z",
    users: { name: "Ops" },
  }];
  t.job_media = [{
    id: "p-note",
    job_id: JOB_FENCE,
    type: "photo",
    phase: "install",
    storage_url: "https://cdn.example.test/object/sign/media/1725234567/front.jpg",
    thumbnail_url: "https://cdn.example.test/thumbs/18400-front.jpg",
    po_id: "po-18400",
    created_at: "2026-09-01T00:00:00Z",
    attendance_cycle_id: "cycle-18400",
    cycle_attribution: { attendance_cycle_id: "cycle-18400", cycle_number: 1 },
    label: "Front run $9,999",
    notes: "Front run priced 1,200 exclusive of GST",
    amount: 9999,
  }];
  const allocated = await detail(t, viewer(LEAD, "lead_installer"));
  assertEquals(allocated.notes[0].detail_json.text, "Client approved");
  assertEquals(allocated.notes[0].detail_json.message, "Charge extra");
  assertEquals(allocated.notes[0].detail_json.description, "Approved total");
  assertEquals(allocated.notes[0].detail_json.body, "Fee");
  assertEquals(allocated.notes[0].detail_json.content, "Plus");
  assertEquals(allocated.notes[0].detail_json.amount, undefined);
  assertEquals(allocated.notes[0].detail_json.qty, 2);
  assertEquals(allocated.media[0].label, "Front run");
  assertEquals(allocated.media[0].notes, "Front run priced");
  assertEquals(allocated.media[0].id, "p-note");
  assertEquals(allocated.media[0].phase, "install");
  assertEquals(allocated.media[0].type, "photo");
  assertEquals(
    allocated.media[0].storage_url,
    "https://cdn.example.test/object/sign/media/1725234567/front.jpg",
  );
  assertEquals(allocated.media[0].thumbnail_url, "https://cdn.example.test/thumbs/18400-front.jpg");
  assertEquals(allocated.media[0].po_id, "po-18400");
  assertEquals(allocated.media[0].created_at, "2026-09-01T00:00:00Z");
  assertEquals(allocated.media[0].attendance_cycle_id, "cycle-18400");
  assertEquals(allocated.media[0].cycle_attribution, {
    attendance_cycle_id: "cycle-18400",
    cycle_number: 1,
  });
  assertEquals(allocated.media[0].amount, undefined);
  assertEquals(JSON.stringify(allocated.notes).includes("9999"), false);
  assertEquals(allocated.media[0].notes.includes("1200"), false);
  const office = await detail(t, viewer(OFFICE, "ops_manager"));
  assertEquals(office.notes[0].detail_json.text, "Client approved $9,999 excluding GST");
  assertEquals(office.notes[0].detail_json.message, "Charge $9,999 extra");
  assertEquals(office.notes[0].detail_json.amount, 9999);
  assertEquals(office.media[0].label, "Front run $9,999");
  assertEquals(office.media[0].notes, "Front run priced 1,200 exclusive of GST");
  assertEquals(
    office.media[0].storage_url,
    "https://cdn.example.test/object/sign/media/1725234567/front.jpg",
  );
});

Deno.test("trade_job_detail: makesafe_open drops priced WO PDFs and sanitizes WO prose", async () => {
  const t = seed();
  t.job_documents.push({
    id: "d-ms-wo",
    job_id: JOB_MS,
    type: "work_order",
    visible_to_trades: true,
    file_name: "ms-wo.pdf",
  });
  t.work_orders.push({
    id: "wo-ms",
    job_id: JOB_MS,
    wo_number: "WO-MS",
    special_instructions: "Attend after hours. Charge $9,999 extra.",
    scope_items: [{ description: "Make safe $850", quantity: 1, unit: "lot", rate: 85 }],
    status: "sent",
  });
  const p = await _tradeJobDetailForTest(
    makeClient(t),
    new URLSearchParams({ jobId: JOB_MS }),
    viewer(STRANGER, "crew") as any,
    false,
  );
  assertEquals(p.access_tier, "makesafe_open");
  assertEquals(p.quote_visible, false);
  assertEquals(p.documents.map((d: any) => d.id), []);
  assertEquals(p.workOrderDocuments, []);
  assertEquals(JSON.stringify(p).includes("ms-wo.pdf"), false);
  assertEquals(p.workOrders[0].special_instructions, "Attend after hours. Charge extra.");
  assertEquals(p.workOrders[0].scope_items, [{ description: "Make safe", quantity: 1, unit: "lot" }]);
});

Deno.test("trade_job_detail: allocated and makesafe_open strip MakeSafe billing overlay", async () => {
  const t = seed();
  t.jobs.find((j: any) => j.id === JOB_MS).notes = "Attend after hours.";
  t.makesafe_job_details = [{
    job_id: JOB_MS,
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    external_ref: "MLB-27000",
    substatus: "waiting_on_trade_report",
    attendance_cycle_id: "cycle-ms",
    cycle_number: 2,
    reattend_count: 1,
    invoice_notes: "Bill $9,999. Rate 85. Invoice INV-1240.",
    billing_rules: { rate: 85, amount: 9999, labour_hours: 3 },
    invoice_ready_at: "2026-09-01T00:00:00Z",
    special_instructions: "Use 90x90 posts. Charge 1200 extra.",
    safety_requirements: "Watch the GST registration. Total 9999.",
  }];
  t.job_assignments.push({
    id: "a-ms-lead",
    job_id: JOB_MS,
    user_id: LEAD,
    status: "scheduled",
    is_lead: true,
    role: "lead_installer",
  });
  const allocated = await _tradeJobDetailForTest(
    makeClient(t),
    new URLSearchParams({ jobId: JOB_MS }),
    viewer(LEAD, "lead_installer") as any,
    false,
  );
  const open = await _tradeJobDetailForTest(
    makeClient(t),
    new URLSearchParams({ jobId: JOB_MS }),
    viewer(STRANGER, "crew") as any,
    false,
  );
  for (const p of [allocated, open]) {
    assertEquals(p.quote_visible, false);
    assertEquals(p.makesafe_details.invoice_notes, undefined);
    assertEquals(p.makesafe_details.billing_rules, undefined);
    assertEquals(p.makesafe_details.invoice_ready_at, undefined);
    assertEquals(p.makesafe_details.cycle_number, 2);
    assertEquals(p.makesafe_details.reattend_count, 1);
    assertEquals(p.makesafe_details.attendance_cycle_id, "cycle-ms");
    assertEquals(p.makesafe_details.external_ref, "MLB-27000");
    assertEquals(p.makesafe_details.special_instructions, "Use 90x90 posts. Charge extra.");
    assertEquals(p.makesafe_details.safety_requirements, "Watch the GST registration. Total.");
    assertEquals(JSON.stringify(p.makesafe_details).includes("9999"), false);
    assertEquals(JSON.stringify(p.makesafe_details).includes("INV-1240"), false);
    assertEquals(JSON.stringify(p.makesafe_details).includes("\"rate\""), false);
  }
  const officeP = await _tradeJobDetailForTest(
    makeClient(t),
    new URLSearchParams({ jobId: JOB_MS }),
    viewer(OFFICE, "ops_manager") as any,
    true,
  );
  assertEquals(officeP.quote_visible, true);
  assertEquals(officeP.makesafe_details.invoice_notes, "Bill $9,999. Rate 85. Invoice INV-1240.");
  assertEquals(officeP.makesafe_details.billing_rules, { rate: 85, amount: 9999, labour_hours: 3 });
  assertEquals(officeP.makesafe_details.invoice_ready_at, "2026-09-01T00:00:00Z");
  assertEquals(officeP.makesafe_details.special_instructions, "Use 90x90 posts. Charge 1200 extra.");
});

Deno.test("trade_job_detail: allocated service reports drop money and keep hours", async () => {
  const t = seed();
  t.job_service_reports = [{
    id: "sr-1",
    job_id: JOB_FENCE,
    status: "submitted",
    cycle_number: 1,
    attendance_cycle_id: "cycle-1",
    notes: "Installed rear run. Charge 1200 extra. Total 9999.",
    checklist_json: {
      labour_hours: 3,
      hours_per_trade: 3,
      rate: 85,
      amount: 9999,
      total: 255,
      materials: "Sheets $99",
      items: [{ label: "Pickets", quantity: 4, rate: 13.5 }],
    },
    billed_total: 9999,
    quoted_amount: 8800,
  }];
  const allocated = await detail(t, viewer(LEAD, "lead_installer"));
  assertEquals(allocated.serviceReport.id, "sr-1");
  assertEquals(allocated.serviceReport.cycle_number, 1);
  assertEquals(allocated.serviceReport.notes, "Installed rear run. Charge extra. Total.");
  assertEquals(allocated.serviceReport.checklist_json.labour_hours, 3);
  assertEquals(allocated.serviceReport.checklist_json.hours_per_trade, 3);
  assertEquals(allocated.serviceReport.checklist_json.rate, undefined);
  assertEquals(allocated.serviceReport.checklist_json.amount, undefined);
  assertEquals(allocated.serviceReport.checklist_json.total, undefined);
  assertEquals(allocated.serviceReport.checklist_json.materials, "Sheets");
  assertEquals(allocated.serviceReport.checklist_json.items, [{ label: "Pickets", quantity: 4 }]);
  assertEquals(allocated.serviceReport.billed_total, undefined);
  assertEquals(allocated.serviceReport.quoted_amount, undefined);
  assertEquals(allocated.serviceReports[0].notes, allocated.serviceReport.notes);
  assertEquals(JSON.stringify(allocated.serviceReport).includes("9999"), false);
  assertEquals(JSON.stringify(allocated.serviceReports).includes("8800"), false);
  const officeP = await detail(t, viewer(OFFICE, "ops_manager"));
  assertEquals(officeP.serviceReport.notes, "Installed rear run. Charge 1200 extra. Total 9999.");
  assertEquals(officeP.serviceReport.checklist_json.rate, 85);
  // billed_total / quoted_amount are not operational columns — the trade
  // path no longer select('*'), so they cannot fail open even for office.
  assertEquals(officeP.serviceReport.billed_total, undefined);
  assertEquals(officeP.serviceReport.quoted_amount, undefined);
});

Deno.test("trade_job_detail: service-report read projects operational columns, never '*'", async () => {
  const t = seed();
  t.job_service_reports = [{
    id: "sr-cols",
    job_id: JOB_FENCE,
    status: "submitted",
    notes: "On site",
  }];
  const recorded: any[] = [];
  await _tradeJobDetailForTest(
    makeClient(t, recorded),
    new URLSearchParams({ jobId: JOB_FENCE }),
    viewer(LEAD, "lead_installer") as any,
    false,
  );
  const reportReads = recorded.filter((r) => r.table === "job_service_reports");
  assertEquals(reportReads.length > 0, true);
  for (const r of reportReads) {
    assertEquals(r.select, TRADE_JOB_SERVICE_REPORT_COLUMNS);
    assertEquals(String(r.select || "").includes("*"), false);
  }
});

const MONEY_REPORT = {
  id: "sr-door",
  job_id: JOB_FENCE,
  status: "submitted",
  submitted_by: LEAD,
  cycle_number: 1,
  attendance_cycle_id: "cycle-1",
  notes: "Installed rear run. Charge 1200 extra. Total 9999.",
  checklist_json: {
    labour_hours: 3,
    hours_per_trade: 3,
    rate: 85,
    amount: 9999,
    total: 255,
    materials: "Sheets $99",
  },
  billed_total: 9999,
  quoted_amount: 8800,
};

Deno.test("get_service_report: allocated / makesafe_open never see money-bearing rows", async () => {
  const t = seed();
  t.job_service_reports = [{ ...MONEY_REPORT }];
  const recorded: any[] = [];
  const allocated = await _getServiceReportForTest(
    makeClient(t, recorded),
    new URLSearchParams({ jobId: JOB_FENCE }),
    LEAD,
    { orgId: ORG_A, managedVerticals: [] },
    false,
  );
  assertEquals(allocated.report.id, "sr-door");
  assertEquals(allocated.report.submitted_by, LEAD);
  assertEquals(allocated.report.cycle_number, 1);
  assertEquals(allocated.report.notes, "Installed rear run. Charge extra. Total.");
  assertEquals(allocated.report.checklist_json.labour_hours, 3);
  assertEquals(allocated.report.checklist_json.rate, undefined);
  assertEquals(allocated.report.checklist_json.amount, undefined);
  assertEquals(allocated.report.billed_total, undefined);
  assertEquals(allocated.report.quoted_amount, undefined);
  assertEquals(JSON.stringify(allocated.report).includes("9999"), false);
  const reportReads = recorded.filter((r) => r.table === "job_service_reports");
  assertEquals(reportReads.some((r) => r.select === TRADE_JOB_SERVICE_REPORT_COLUMNS), true);
  assertEquals(reportReads.every((r) => !String(r.select || "").includes("*")), true);
});

Deno.test("get_service_report: office keeps raw notes and checklist money", async () => {
  const t = seed();
  t.job_service_reports = [{ ...MONEY_REPORT }];
  const officeP = await _getServiceReportForTest(
    makeClient(t),
    new URLSearchParams({ jobId: JOB_FENCE }),
    OFFICE,
    { orgId: ORG_A, managedVerticals: [] },
    true,
  );
  assertEquals(officeP.report.notes, "Installed rear run. Charge 1200 extra. Total 9999.");
  assertEquals(officeP.report.checklist_json.rate, 85);
  assertEquals(officeP.report.checklist_json.amount, 9999);
  assertEquals(officeP.report.billed_total, undefined);
  assertEquals(officeP.report.quoted_amount, undefined);
});

Deno.test("submit_service_report: allocated response is projected the same as trade_job_detail", async () => {
  const t = seed();
  const allocated = await _submitServiceReportForTest(
    makeClient(t),
    {
      jobId: JOB_FENCE,
      userId: LEAD,
      checklist: {
        labour_hours: 3,
        rate: 85,
        amount: 9999,
        materials: "Sheets $99",
      },
      notes: "Installed rear run. Charge 1200 extra. Total 9999.",
      status: "submitted",
    },
    { orgId: ORG_A, managedVerticals: [] },
    false,
  );
  assertEquals(allocated.report.submitted_by, LEAD);
  assertEquals(allocated.report.status, "submitted");
  assertEquals(allocated.report.notes, "Installed rear run. Charge extra. Total.");
  assertEquals(allocated.report.checklist_json.labour_hours, 3);
  assertEquals(allocated.report.checklist_json.rate, undefined);
  assertEquals(allocated.report.checklist_json.amount, undefined);
  assertEquals(allocated.report.checklist_json.materials, "Sheets");
  assertEquals(JSON.stringify(allocated.report).includes("9999"), false);
});

Deno.test("submit_service_report: office keeps raw notes and checklist money", async () => {
  const t = seed();
  const officeP = await _submitServiceReportForTest(
    makeClient(t),
    {
      jobId: JOB_FENCE,
      userId: OFFICE,
      checklist: { labour_hours: 3, rate: 85, amount: 9999 },
      notes: "Installed rear run. Charge 1200 extra. Total 9999.",
      status: "submitted",
    },
    { orgId: ORG_A, managedVerticals: [] },
    true,
  );
  assertEquals(officeP.report.notes, "Installed rear run. Charge 1200 extra. Total 9999.");
  assertEquals(officeP.report.checklist_json.rate, 85);
  assertEquals(officeP.report.checklist_json.amount, 9999);
});

const WALKTHROUGH_URL = "https://cdn.example.test/jobs/swf-26101/walkthrough.mp4";

Deno.test("trade_job_detail: promotes a job.scopeMedia walkthrough even when scope photos already exist", async () => {
  const t = seed();
  const job = t.jobs.find((j: any) => j.id === JOB_FENCE);
  job.scope_json = {
    ...job.scope_json,
    scopeMedia: {
      photos: [{ label: "Front", url: "https://cdn.example.test/jobs/swf-26101/front.jpg" }],
    },
    job: {
      ...job.scope_json.job,
      scopeMedia: {
        videoWalkthrough: WALKTHROUGH_URL,
        videoFileName: "site-walkthrough.mov",
        videoSize: 18432000,
      },
    },
  };
  t.job_media = [{
    id: "photo-scope",
    job_id: JOB_FENCE,
    phase: "scope",
    type: "photo",
    storage_url: "https://cdn.example.test/jobs/swf-26101/front.jpg",
    label: "Front",
  }];
  const p = await detail(t, viewer(LEAD, "lead_installer"));
  const videos = (p.media || []).filter((m: any) => m.type === "video");
  assertEquals(videos.length, 1);
  assertEquals(videos[0].storage_url, WALKTHROUGH_URL);
  assertEquals(videos[0].phase, "scope");
  assertEquals(videos[0].label, "Walkthrough");
  assertEquals((p.currentCycleMedia || []).some((m: any) => m.type === "video"), true);
  assertEquals(quoteLeakProbe(p), []);
});

Deno.test("trade_job_detail: a video past the 200-row media page still reaches media", async () => {
  const t = seed();
  const photos = Array.from({ length: 200 }, (_, i) => ({
    id: `photo-${i}`,
    job_id: JOB_FENCE,
    type: "photo",
    phase: "completion",
    storage_url: `https://cdn.example.test/jobs/swf-26101/p-${i}.jpg`,
    created_at: `2026-09-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
  }));
  t.job_media = [
    ...photos,
    {
      id: "walk-late",
      job_id: JOB_FENCE,
      type: "video",
      phase: "scope",
      label: "Walkthrough",
      storage_url: WALKTHROUGH_URL,
      created_at: "2026-09-02T00:00:00Z",
    },
  ];
  const p = await detail(t, viewer(LEAD, "lead_installer"));
  const videos = (p.media || []).filter((m: any) => m.type === "video");
  assertEquals(videos.length, 1);
  assertEquals(videos[0].id, "walk-late");
  assertEquals(videos[0].storage_url, WALKTHROUGH_URL);
  assertEquals((p.currentCycleMedia || []).some((m: any) => m.id === "walk-late"), true);
});

Deno.test("trade_job_detail: reattend cycle filter still returns the unbound walkthrough", async () => {
  const t = seed();
  t.jobs.find((j: any) => j.id === JOB_FENCE).type = "makesafe";
  t.makesafe_job_details = [{
    job_id: JOB_FENCE,
    attendance_cycle_id: "cycle-2",
    cycle_number: 2,
    reattend_count: 1,
    last_reattend_at: "2026-09-01T00:00:00Z",
  }];
  t.job_media = [
    {
      id: "new-photo",
      job_id: JOB_FENCE,
      type: "photo",
      phase: "completion",
      attendance_cycle_id: "cycle-2",
      cycle_attribution: "bound",
    },
    {
      id: "walk",
      job_id: JOB_FENCE,
      type: "video",
      phase: "scope",
      label: "Walkthrough",
      storage_url: WALKTHROUGH_URL,
    },
  ];
  const p = await detail(t, viewer(LEAD, "lead_installer"));
  assertEquals((p.media || []).map((m: any) => m.id).sort(), ["new-photo", "walk"]);
  assertEquals(p.currentCyclePhotoCount, 1);
});

Deno.test("trade_job_detail: existing video rows must be playable HTTPS to reach the trade payload", async () => {
  const t = seed();
  t.job_media = [
    {
      id: "https-walk",
      job_id: JOB_FENCE,
      type: "video",
      phase: "scope",
      label: "Walkthrough",
      storage_url: WALKTHROUGH_URL,
    },
    {
      id: "http-walk",
      job_id: JOB_FENCE,
      type: "video",
      phase: "scope",
      storage_url: "http://cdn.example.test/jobs/swf-26101/walkthrough.mp4",
    },
    {
      id: "data-walk",
      job_id: JOB_FENCE,
      type: "video",
      phase: "scope",
      storage_url: "data:video/mp4;base64,AAAA",
    },
    {
      id: "blob-walk",
      job_id: JOB_FENCE,
      type: "video",
      phase: "scope",
      storage_url: "blob:https://local/abc",
    },
  ];
  const p = await detail(t, viewer(LEAD, "lead_installer"));
  const videos = (p.media || []).filter((m: any) => m.type === "video");
  assertEquals(videos.map((m: any) => m.id), ["https-walk"]);
  assertEquals(videos[0].storage_url, WALKTHROUGH_URL);
});

Deno.test("trade_job_detail: allocated drops numeric top-level job.notes", async () => {
  const t = seed();
  t.jobs[0].notes = 85;
  const p = await detail(t, viewer(LEAD, "lead_installer"));
  assertEquals(p.access_tier, "allocated");
  assertEquals(p.job.notes, null);
  assertEquals(JSON.stringify(p.job).includes("\"85\""), false);
});

Deno.test("trade_job_detail: the fencing division manager sees the quote docs and the raw scope (office parity within the trade)", async () => {
  const p = await detail(seed(), viewer(HENRY, "lead_installer", ["fencing"]));
  assertEquals(p.access_tier, "division_manager");
  assertEquals(p.quote_visible, true);
  assertEquals(p.documents.map((d: any) => d.id).sort(), ["d-internal", "d-invoice", "d-quote-hid", "d-quote-vis", "d-supplier-quote", "d-supplier-wo", "d-wo"]);
  assertEquals(p.job.scope_json._pricing_json.totalIncGST, 8800);
  assertEquals(p.job.notes, "Park on the verge. Extra $9,999. Charge 1,200 excluding GST. Client approved $9,999 excluding GST.");
  assertEquals(p.job.scope_json.job.siteNotes, "Park on the verge. Extra $9,999");
  assertEquals(p.job.scope_json.notes.noteInternal, "Client is a repeat customer. Do not mention $9,999");
  assertEquals(p.workOrders[0].scope_items[0].rate, 85);
  assertEquals(p.workOrders[0].special_instructions, "Park on the verge. Charge $9,999 extra.");
  assertEquals(p.workOrderDocuments.map((d: any) => d.id).sort(), ["d-supplier-wo", "d-wo"]);
});

Deno.test("trade_job_detail: allocated scopeSummary is built from the redacted no-money projection", async () => {
  const t = seed();
  const job = t.jobs.find((j: any) => j.id === JOB_FENCE);
  job.scope_json = {
    ...job.scope_json,
    job: {
      ...job.scope_json.job,
      material: "Colorbond $9,999",
      colour: "Monument 9,999 ex GST",
      quotedTotals: [594],
    },
  };
  const allocated = await detail(t, viewer(LEAD, "lead_installer"));
  assertEquals(JSON.stringify(allocated.job.scope_json).includes("594"), false);
  assertEquals(JSON.stringify(allocated.scopeSummary).includes("9999"), false);
  assertEquals(JSON.stringify(allocated.scopeSummary).includes("594"), false);
  assertEquals(allocated.scopeSummary.includes("Colorbond"), true);
  assertEquals(allocated.scopeSummary.includes("Monument"), true);
  const office = await detail(t, viewer(OFFICE, "ops_manager"));
  assertEquals(office.scopeSummary.includes("$9,999") || office.job.scope_json.job.material.includes("$9,999"), true);
  assertEquals(office.job.scope_json.job.quotedTotals, [594]);
});

Deno.test("_tradeScopeSummary strips money only when asked — office full-quote line stays raw", () => {
  const job = {
    type: "fencing",
    scope_json: {
      job: {
        runs: [{ length: 10 }],
        material: "Colorbond $9,999",
        colour: "Monument",
        sheetHeight: 1800,
      },
    },
  };
  assertEquals(_tradeScopeSummary(job), "10m, Colorbond $9,999, Monument, 1800mm high");
  // $9,999, eats the list comma (amount class includes ','). Pin the leftover.
  assertEquals(_tradeScopeSummary(job, { sanitizeMoney: true }), "10m, Colorbond Monument, 1800mm high");
});

Deno.test("trade_job_detail: allocated PO line descriptions are money-sanitized; office keeps raw wording", async () => {
  const t = seed();
  t.purchase_orders = [{
    id: "po-money",
    job_id: JOB_FENCE,
    po_number: "PO-99",
    supplier_name: "Acme Sheets $99.50",
    status: "sent",
    notes: "Charge 1200 extra. Total 9999.",
    delivery_date: "2026-08-20",
    line_items: [{
      description: "Sheets $99.50. Total 9999.",
      quantity: 12,
      unit_price: 99.5,
    }],
  }];
  const allocated = await detail(t, viewer(LEAD, "lead_installer"));
  assertEquals(allocated.quote_visible, false);
  const allocatedLine = allocated.purchaseOrders[0].line_items[0];
  assertEquals(allocatedLine.description, "Sheets . Total.");
  assertEquals(allocatedLine.quantity, 12);
  assertEquals(allocatedLine.unit_price, undefined);
  assertEquals(allocated.purchaseOrders[0].supplier_name, "Acme Sheets");
  assertEquals(JSON.stringify(allocated.purchaseOrders).includes("99.50"), false);
  assertEquals(JSON.stringify(allocated.purchaseOrders).includes("9999"), false);
  const office = await detail(t, viewer(OFFICE, "ops_manager"));
  assertEquals(office.quote_visible, true);
  assertEquals(office.purchaseOrders[0].line_items[0].description, "Sheets $99.50. Total 9999.");
  assertEquals(office.purchaseOrders[0].supplier_name, "Acme Sheets $99.50");
  assertEquals(office.purchaseOrders[0].line_items[0].unit_price, undefined);
  const projectedHidden = projectTradePurchaseOrders(t.purchase_orders, false)[0];
  const projectedOffice = projectTradePurchaseOrders(t.purchase_orders, true)[0];
  assertEquals(projectedHidden.line_items[0].description, "Sheets . Total.");
  assertEquals(projectedHidden.notes, "Charge extra. Total.");
  assertEquals(projectedHidden.supplier_name, "Acme Sheets");
  assertEquals(projectedOffice.line_items[0].description, "Sheets $99.50. Total 9999.");
  assertEquals(projectedOffice.notes, "Charge 1200 extra. Total 9999.");
  assertEquals(projectedOffice.supplier_name, "Acme Sheets $99.50");
  t.purchase_orders = [{
    id: "po-ms",
    job_id: JOB_MS,
    supplier_name: "Acme Sheets $99.50",
    status: "sent",
    line_items: [{ description: "Sheets $99.50. Total 9999.", quantity: 12, unit_price: 99.5 }],
  }];
  const open = await _tradeJobDetailForTest(
    makeClient(t),
    new URLSearchParams({ jobId: JOB_MS }),
    viewer(STRANGER, "crew") as any,
    false,
  );
  assertEquals(open.access_tier, "makesafe_open");
  assertEquals(open.quote_visible, false);
  assertEquals(open.purchaseOrders[0].line_items[0].description, "Sheets . Total.");
  assertEquals(open.purchaseOrders[0].supplier_name, "Acme Sheets");
});

Deno.test("projectTradePurchaseOrders allocated lines keep only scalars; office may keep nested quantity", () => {
  const pos = [{
    id: "po-nested",
    po_number: "PO-NEST",
    supplier_name: "Acme",
    status: "sent",
    total: 18400,
    pricing: { sell: 18400, rate: 85 },
    line_items: [{
      description: "Sheets 99.50",
      quantity: { count: 12, rate: 99.5, billed: 9999 },
      unit: { name: "ea", unit_price: 99.5 },
      pricing: { sell: 1200 },
    }],
  }];
  const allocated = projectTradePurchaseOrders(pos, false)[0];
  assertEquals(allocated.line_items[0], { description: "Sheets", quantity: 0, unit: undefined });
  assertEquals(allocated.total, undefined);
  assertEquals(allocated.pricing, undefined);
  assertEquals(JSON.stringify(allocated).includes("99.5"), false);
  assertEquals(JSON.stringify(allocated).includes("18400"), false);
  assertEquals(JSON.stringify(allocated).includes("9999"), false);
  const office = projectTradePurchaseOrders(pos, true)[0];
  assertEquals(office.line_items[0].description, "Sheets 99.50");
  assertEquals(office.line_items[0].quantity, { count: 12, rate: 99.5, billed: 9999 });
  assertEquals(office.total, 18400);
  assertEquals(office.pricing, { sell: 18400, rate: 85 });
});

Deno.test("projectTradePurchaseOrders allocated drops money-shaped PO units; office keeps raw unit", () => {
  const pos = [{
    id: "po-unit",
    po_number: "PO-UNIT",
    supplier_name: "Acme",
    status: "sent",
    line_items: [{
      description: "Sheets Deposit 85",
      quantity: 12,
      unit: "AUD 9,999",
    }, {
      description: "Panels",
      quantity: 12,
      unit: "85",
    }, {
      description: "Posts",
      quantity: 4,
      unit: "999",
    }],
  }];
  const allocated = projectTradePurchaseOrders(pos, false)[0];
  assertEquals(allocated.line_items[0].description, "Sheets Deposit");
  assertEquals(allocated.line_items[0].quantity, 12);
  assertEquals(allocated.line_items[0].unit, undefined);
  assertEquals(allocated.line_items[1].unit, undefined);
  assertEquals(allocated.line_items[2].unit, undefined);
  assertEquals(JSON.stringify(allocated).includes("9,999"), false);
  assertEquals(JSON.stringify(allocated).includes("AUD"), false);
  assertEquals(JSON.stringify(allocated.line_items).includes("\"85\""), false);
  assertEquals(JSON.stringify(allocated.line_items).includes("999"), false);
  const office = projectTradePurchaseOrders(pos, true)[0];
  assertEquals(office.line_items[0].description, "Sheets Deposit 85");
  assertEquals(office.line_items[0].unit, "AUD 9,999");
  assertEquals(office.line_items[1].unit, "85");
  assertEquals(office.line_items[2].unit, "999");
});

Deno.test("trade_job_detail: office gets the same as the manager", async () => {
  const p = await detail(seed(), viewer(OFFICE, "ops_manager"));
  assertEquals(p.access_tier, "office");
  assertEquals(p.quote_visible, true);
  assertEquals(p.job.scope_json._pricing_json.totalIncGST, 8800);
  assertEquals(p.documents.length, 7);
  assertEquals(p.workOrderDocuments.map((d: any) => d.id).sort(), ["d-supplier-wo", "d-wo"]);
});

Deno.test("trade_job_detail: a trade with no vertical and no allocation is refused outright", async () => {
  await assertRejects(
    () => detail(seed(), viewer(STRANGER, "crew")),
    Error,
    "not assigned",
  );
});

Deno.test("trade_job_detail: a patio-only manager is refused on the fencing job", async () => {
  await assertRejects(
    () => detail(seed(), viewer(HENRY, "lead_installer", ["patio"])),
    Error,
    "not assigned",
  );
});

Deno.test("trade_job_detail: another tenant's manager is refused before anything is read", async () => {
  await assertRejects(
    () =>
      _tradeJobDetailForTest(
        makeClient(seed()),
        new URLSearchParams({ jobId: JOB_FENCE_B }),
        viewer(HENRY, "lead_installer", ["fencing"]) as any,
        false,
      ),
    Error,
    "not authorized",
  );
});

// ── The pure redactor and document filter ───────────────────────────────────

Deno.test("redactTradeScopeQuote allowlists quote/quotes so unknown money keys cannot fail open", () => {
  const r = redactTradeScopeQuote({
    job: {
      quote: {
        quote_number: "Q-NARR",
        description: "Supply and install Monument fencing with a gate on the left.",
        materials: [{ name: "90x90 posts", qty: 12, unit_price: 45, total: 540 }],
        lineTotalEx: 540,
        gstAmount: 54,
        quotedTotal: 594,
      },
      quotes: [{
        quote_number: "Q-ALLOW",
        narrative: "Gate on the left",
        lineTotalEx: 99,
      }],
    },
  });
  assertEquals(r.job.quote, {
    quote_number: "Q-NARR",
    description: "Supply and install Monument fencing with a gate on the left.",
    materials: [{ name: "90x90 posts", qty: 12 }],
  });
  assertEquals(r.job.quotes, [{
    quote_number: "Q-ALLOW",
    narrative: "Gate on the left",
  }]);
  assertEquals(quoteLeakProbe(r), []);
});

Deno.test("redactTradeScopeQuote money-sanitizes retained narrative and description leaves", () => {
  const r = redactTradeScopeQuote({
    notes: {
      noteQuote: "Quote writing Total $9,999 plus AUD 1,200",
      noteWorkOrder: "Use 90x90 posts",
      noteInternal: "Client is a repeat customer. Do not mention $9,999",
    },
    job: {
      siteNotes: "Park on the verge. Extra $9,999",
      supplierNotes: "Call before arrival. Charge 1,200 ex GST. Total 9,999 AUD",
      quote: {
        quote_number: "Q-NARR",
        description: "Supply and install. Total A$ 9,999 Approved total 9,999 ex GST",
        narrative: "Gate on the left $ 1,200 extra Total 9,999 AUD",
        name: "Monument package $9,999",
        label: "Front run AUD 1,200",
        title: "Quote title A$ 80",
        materials: [{ name: "90x90 posts $45", qty: 12, title: "Posts $45" }],
      },
    },
  });
  assertEquals(r.notes.noteQuote, "Quote writing Total plus");
  assertEquals(r.notes.noteWorkOrder, "Use 90x90 posts");
  assertEquals(r.notes.noteInternal, "Client is a repeat customer. Do not mention");
  assertEquals(r.job.siteNotes, "Park on the verge. Extra");
  assertEquals(r.job.supplierNotes, "Call before arrival. Charge . Total");
  assertEquals(r.job.quote.quote_number, "Q-NARR");
  assertEquals(r.job.quote.description, "Supply and install. Total Approved total");
  assertEquals(r.job.quote.narrative, "Gate on the left extra Total");
  assertEquals(r.job.quote.name, "Monument package");
  assertEquals(r.job.quote.label, "Front run");
  assertEquals(r.job.quote.title, "Quote title");
  assertEquals(r.job.quote.materials, [{ name: "90x90 posts", qty: 12, title: "Posts" }]);
  assertEquals(JSON.stringify(r).includes("9999"), false);
  assertEquals(JSON.stringify(r).includes("1200"), false);
});

Deno.test("redactTradeScopeQuote drops bare numeric string leaves on the quote-object allowlist", () => {
  const r = redactTradeScopeQuote({
    job: {
      quote: {
        quote_number: "Q-NARR",
        description: "9999",
        narrative: "85.00",
        notes: "Gate on the left",
        qty: "12",
      },
    },
  });
  assertEquals(r.job.quote.quote_number, "Q-NARR");
  assertEquals(r.job.quote.description, undefined);
  assertEquals(r.job.quote.narrative, undefined);
  assertEquals(r.job.quote.notes, "Gate on the left");
  assertEquals(r.job.quote.qty, "12");
  assertEquals(JSON.stringify(r).includes("9999"), false);
  assertEquals(JSON.stringify(r).includes("85.00"), false);
  assertEquals(quoteLeakProbe(r), []);
});

Deno.test("redactTradeScopeQuote strips nested numeric quote/quotes the same as a bare top-level quote", () => {
  const r = redactTradeScopeQuote({
    job: {
      quote: { quote: 594, quotes: ["$9,999", { quote_number: "Q-NEST", quote: 777 }] },
    },
  });
  assertEquals(r.job.quote, { quotes: [{ quote_number: "Q-NEST" }] });
  assertEquals(quoteLeakProbe(r), []);
  assertEquals(JSON.stringify(r).includes("9999"), false);
});

Deno.test("redactTradeScopeQuote strips the quote at every depth and keeps the rest", () => {
  const r = redactTradeScopeQuote(structuredClone(QUOTE_SCOPE));
  assertEquals(r._pricing_json, undefined);
  assertEquals(r.job._pricing_json, undefined);
  assertEquals(r.job.runs, [{ length: 10 }]);
  assertEquals(r.patios[0].options[0]._pricing_json, undefined);
  assertEquals(r.patios[0].options[0].pricing, { labour: { days: 2 } });
  assertEquals(r.patios[0].options[0].label, "Standard");
  assertEquals(r.pricing, { labour: { trades: 2, days: 3 } });
  assertEquals(r.notes.pricingNotes, undefined);
  assertEquals(r.notes.noteQuote, "Quote note text");
  assertEquals(r.notes.noteWorkOrder, "Use 90x90 posts");
  assertEquals(r.notes.noteInternal, "Client is a repeat customer. Do not mention");
  assertEquals(r.job.siteNotes, "Park on the verge. Extra");
  assertEquals(r.job.supplierNotes, "Call before arrival. Charge");
  assertEquals(r.client, { notes: "Gate on the left" });
  assertEquals(r.job.quote.quote_number, "Q-NARR");
  assertEquals(r.job.quote.description.includes("Monument"), true);
  assertEquals(r.job.quote.materials, [{ name: "90x90 posts", qty: 12 }]);
  assertEquals(quoteLeakProbe(r), []);
});

Deno.test("redactTradeScopeQuote strips the audited production money keys: fencing pricePerMetre and patio job_costs", () => {
  const r = redactTradeScopeQuote(structuredClone(QUOTE_SCOPE));
  // pricePerMetre x the surviving runs[].length reconstructs the quoted total
  // outright, so it has to go while the construction key length stays.
  assertEquals(r.job.pricePerMetre, undefined);
  assertEquals(r.job.runs, [{ length: 10 }]);
  assertEquals(r.job_costs, undefined);
  assertEquals(quoteLeakProbe(r), []);
});

Deno.test("redactTradeScopeQuote fails CLOSED at the recursion cap: a branch past the limit is dropped, never returned raw", () => {
  let deep: any = { sell: 9999, totalIncGST: 8800, pricePerMetre: 125 };
  for (let i = 0; i < 20; i++) deep = { level: deep };
  const r = redactTradeScopeQuote({ config: { totalMetres: 42 }, deep });
  // Everything inside the cap is still redacted normally...
  assertEquals(r.config, { totalMetres: 42 });
  // ...and nothing past it survives verbatim.
  assertEquals(quoteLeakProbe(r), []);
  assertEquals(JSON.stringify(r).includes("9999"), false);
});

Deno.test("redactTradeScopeQuote: an over-deep entry inside an ARRAY is dropped, not left as a hole", () => {
  let deep: any = { sell: 9999 };
  for (let i = 0; i < 20; i++) deep = [deep];
  const r = redactTradeScopeQuote({ rows: deep });
  assertEquals(quoteLeakProbe(r), []);
  assertEquals(JSON.stringify(r).includes("null"), false);
});

Deno.test("redactTradeScopeQuote: a pricing block with no labour becomes empty, a string blob is parsed, null stays null", () => {
  assertEquals(redactTradeScopeQuote({ pricing: { addonRows: [{ sell: 1 }] } }), { pricing: {} });
  assertEquals(redactTradeScopeQuote(JSON.stringify({ a: 1, _pricing_json: {} })), {});
  assertEquals(redactTradeScopeQuote(null), null);
  assertEquals(redactTradeScopeQuote("not json"), null);
});

Deno.test("redactTradeScopeQuote walks nested labour keep-key values so money cannot fail open", () => {
  const r = redactTradeScopeQuote({
    pricing: {
      labour: {
        trades: 2,
        days: { count: 3, rate: 400, billed: 9999, sell: 3200 },
        labourers: "2 at $85/hour",
      },
    },
  });
  assertEquals(r.pricing, {
    labour: {
      trades: 2,
      days: { count: 3 },
      labourers: "2 at /hour",
    },
  });
  assertEquals(JSON.stringify(r).includes("400"), false);
  assertEquals(JSON.stringify(r).includes("9999"), false);
  assertEquals(JSON.stringify(r).includes("3200"), false);
  assertEquals(JSON.stringify(r).includes("85"), false);
  assertEquals(JSON.stringify(r).includes("$"), false);
});

Deno.test("redactTradeScopeQuote drops unlisted numeric money keys and keeps construction quantities", () => {
  const r = redactTradeScopeQuote({
    config: { totalMetres: 42, colour: "Monument" },
    job: {
      runs: [{ length: 10, sellEx: 1250, quoted_ex: 1375 }],
      lineSell: 9999,
      extras: { sellPriceEx: 250, qty: 3 },
      quotedEx: "850",
    },
  });
  assertEquals(r.config, { totalMetres: 42, colour: "Monument" });
  assertEquals(r.job.runs, [{ length: 10 }]);
  assertEquals(r.job.lineSell, undefined);
  assertEquals(r.job.extras, { qty: 3 });
  assertEquals(r.job.quotedEx, undefined);
  assertEquals(JSON.stringify(r).includes("1250"), false);
  assertEquals(JSON.stringify(r).includes("1375"), false);
  assertEquals(JSON.stringify(r).includes("9999"), false);
  assertEquals(JSON.stringify(r).includes("250"), false);
  assertEquals(JSON.stringify(r).includes("850"), false);
});

Deno.test("redactTradeScopeQuote drops numeric money arrays under unlisted keys", () => {
  const r = redactTradeScopeQuote({
    quotedTotals: [594],
    extras: { sellEx: [1250, "850"] },
    qty: [12, 14],
    job: { runs: [{ length: 10 }], quotedTotals: [594] },
  });
  assertEquals(r.quotedTotals, []);
  assertEquals(r.extras.sellEx, []);
  assertEquals(r.qty, [12, 14]);
  assertEquals(r.job.runs, [{ length: 10 }]);
  assertEquals(r.job.quotedTotals, []);
  assertEquals(JSON.stringify(r).includes("594"), false);
  assertEquals(JSON.stringify(r).includes("1250"), false);
  assertEquals(JSON.stringify(r).includes("850"), false);
});

Deno.test("_tradeDocumentsForAllocatedTrade: honours the flag AND drops quote-bearing and priced WO types whatever the flag says", () => {
  const docs = seed().job_documents;
  assertEquals(_tradeDocumentsForAllocatedTrade(docs).map((d) => d.id).sort(), ["d-supplier-quote"]);
  assertEquals([...TRADE_QUOTE_DOCUMENT_TYPES].sort(), ["invoice", "quote"]);
  assertEquals([...TRADE_PRICED_WORK_ORDER_DOCUMENT_TYPES].sort(), ["supplier_work_order", "work_order"]);
  assertEquals(TRADE_QUOTE_DOCUMENT_TYPES.has("roof_report"), false);
  assertEquals(TRADE_PRICED_WORK_ORDER_DOCUMENT_TYPES.has("roof_report"), false);
});

Deno.test("_tradeDocumentsForAllocatedTrade keeps a fee-free roof_report for allocated viewers", () => {
  const out = _tradeDocumentsForAllocatedTrade([
    { id: "d-roof", type: "roof_report", visible_to_trades: true, file_name: "Roof Inspection Report.pdf" },
    { id: "d-quote", type: "quote", visible_to_trades: true },
  ]);
  assertEquals(out.map((d) => d.id), ["d-roof"]);
});

Deno.test("_tradeDocumentsForAllocatedTrade keeps quote_number on a remaining non-quote, non-priced-WO row", () => {
  const docs = [
    { id: "d-wo", type: "work_order", visible_to_trades: true, quote_number: "Q-WO" },
    { id: "d-supplier-wo", type: "supplier_work_order", visible_to_trades: true, quote_number: "Q-SWO" },
    { id: "d-sq", type: "supplier_quote", visible_to_trades: true, quote_number: "Q-KEEP" },
    { id: "d-quote", type: "quote", visible_to_trades: true, quote_number: "Q-HIDE" },
  ];
  const out = _tradeDocumentsForAllocatedTrade(docs);
  assertEquals(out.map((d) => d.id), ["d-sq"]);
  assertEquals(out[0].quote_number, "Q-KEEP");
});

Deno.test("redactTradeWorkOrderScopeItems drops rate/total/unit_price and keeps the writing", () => {
  assertEquals(
    redactTradeWorkOrderScopeItems([
      { description: "Posts", quantity: 4, unit: "ea", rate: 20, unit_price: 20, total: 80, price: 20 },
    ]),
    [{ description: "Posts", quantity: 4, unit: "ea" }],
  );
});

Deno.test("redactTradeWorkOrderScopeItems is allowlist-only — unknown money and nested pricing do not fail open", () => {
  assertEquals(
    redactTradeWorkOrderScopeItems([
      {
        description: "Posts",
        quantity: 4,
        unit: "ea",
        instructions: "Use 90x90 posts",
        unitPriceEx: 20,
        lineTotalEx: 80,
        gstAmount: 8,
        quotedTotal: 88,
        cost: 12,
        pricing: { amount: 80 },
      },
    ]),
    [{ description: "Posts", quantity: 4, unit: "ea", instructions: "Use 90x90 posts" }],
  );
});

Deno.test("redactTradeWorkOrderScopeItems drops non-object and nested-array entries", () => {
  assertEquals(
    redactTradeWorkOrderScopeItems([
      "$9,999",
      [{ description: "Hidden", unitPriceEx: 20, quotedTotal: 88 }],
      { description: "Posts", quantity: 4, unit: "ea" },
    ]),
    [{ description: "Posts", quantity: 4, unit: "ea" }],
  );
  assertEquals(redactTradeWorkOrderScopeItems("$9,999"), []);
});

Deno.test("redactTradeWorkOrderScopeItems drops numeric narrative scalars and keeps quantity", () => {
  assertEquals(
    redactTradeWorkOrderScopeItems([
      { description: 85, instructions: 85, notes: 85, name: 85, label: 85, title: 85, text: 85, quantity: 4, unit: "ea" },
      { description: "Posts", quantity: 4, unit: "ea" },
    ]),
    [
      { quantity: 4, unit: "ea" },
      { description: "Posts", quantity: 4, unit: "ea" },
    ],
  );
});

Deno.test("redactTradeWorkOrderScopeItems drops bare money unit/kind and keeps approved vocabulary", () => {
  assertEquals(
    redactTradeWorkOrderScopeItems([
      { kind: "85", unit: "85", description: "Posts", quantity: 4 },
      { kind: "install_m", unit: "m", description: "Rear", quantity: 19 },
      { kind: "999", units: "999", description: "Gate", quantity: 1 },
    ]),
    [
      { description: "Posts", quantity: 4 },
      { kind: "install_m", unit: "m", description: "Rear", quantity: 19 },
      { description: "Gate", quantity: 1 },
    ],
  );
});

Deno.test("redactTradeWorkOrderScopeItems money-sanitizes every retained string leaf", () => {
  assertEquals(
    redactTradeWorkOrderScopeItems([
      {
        description: "Posts Total $9,999",
        instructions: "Charge AUD 1,200 extra Total 9,999 AUD Approved total 9,999 ex GST",
        notes: "Priced A$ 80",
        name: "Front $9,999",
        label: "Run $ 40",
        title: "Line $9,999",
        text: "Text $9,999",
        quantity: 4,
        unit: "ea",
      },
    ]),
    [{
      description: "Posts Total",
      instructions: "Charge extra Total Approved total",
      notes: "Priced",
      name: "Front",
      label: "Run",
      title: "Line",
      text: "Text",
      quantity: 4,
      unit: "ea",
    }],
  );
});

Deno.test("redactTradeWorkOrdersForAllocated money-sanitizes special_instructions and other WO prose", () => {
  const out = redactTradeWorkOrdersForAllocated([
    {
      id: "wo-18400",
      wo_number: "WO-18400",
      status: "sent",
      scheduled_date: "2026-08-20",
      special_instructions: "Park on the verge. Charge $9,999 extra Approved total 9,999 ex GST",
      notes: "Installer note $1,200 Total 9,999 AUD",
      scope_items: [{
        description: "Posts Total $850",
        quantity: 4,
        unit: "ea",
        rate: 20,
      }],
    },
  ]);
  assertEquals(out[0].id, "wo-18400");
  assertEquals(out[0].wo_number, "WO-18400");
  assertEquals(out[0].status, "sent");
  assertEquals(out[0].scheduled_date, "2026-08-20");
  assertEquals(out[0].special_instructions, "Park on the verge. Charge extra Approved total");
  assertEquals(out[0].notes, "Installer note Total");
  assertEquals(out[0].scope_items, [{ description: "Posts Total", quantity: 4, unit: "ea" }]);
  assertEquals(JSON.stringify(out).includes("9999"), false);
  assertEquals(JSON.stringify(out).includes("1200"), false);
  assertEquals(JSON.stringify(out).includes("850"), false);
});

Deno.test("redactTradeWorkOrdersForAllocated drops nested money objects and unrecognised quote amounts", () => {
  const out = redactTradeWorkOrdersForAllocated([
    {
      id: "wo-2",
      wo_number: "WO-2",
      status: "sent",
      quoted_total: 850,
      pricing: { sell: 18400, rate: 85 },
      special_instructions: "Attend site. Quote 850. Monument fencing 18400.",
      scope_items: [{ description: "Make safe", quantity: 1, unit: "lot" }],
    },
  ]);
  assertEquals(out[0].quoted_total, undefined);
  assertEquals(out[0].pricing, undefined);
  assertEquals(out[0].special_instructions, "Attend site. Quote. Monument fencing .");
  assertEquals(JSON.stringify(out).includes("850"), false);
  assertEquals(JSON.stringify(out).includes("18400"), false);
});

Deno.test("redactTradeQuotePackMoney allowlists pack fields and nulls item money", () => {
  const out = redactTradeQuotePackMoney([
    {
      quote_number: "Q-1",
      lineTotalEx: 300,
      gstAmount: 30,
      quotedTotal: 330,
      items: [{
        kind: "install_m",
        description: "Install",
        quantity: 10,
        unit_price: 30,
        line_total: 300,
        lineTotalEx: 300,
        gstAmount: 30,
      }],
    },
  ]);
  assertEquals(out[0].quote_number, "Q-1");
  assertEquals(redactTradeQuotePackMoney([{ quote_number: "$18,400" }])[0].quote_number, null);
  assertEquals(redactTradeQuotePackMoney([{ quote_number: "50% deposit" }])[0].quote_number, null);
  assertEquals(redactTradeQuotePackMoney([{ quote_number: "rate 850" }])[0].quote_number, null);
  assertEquals(out[0].lineTotalEx, undefined);
  assertEquals(out[0].gstAmount, undefined);
  assertEquals(out[0].quotedTotal, undefined);
  assertEquals(out[0].items[0], {
    kind: "install_m",
    description: "Install",
    quantity: 10,
    unit_price: null,
    line_total: null,
  });
});

Deno.test("redactTradeQuotePackMoney allowlists customer and terms without money keys", () => {
  const out = redactTradeQuotePackMoney([
    {
      quote_number: "Q-1",
      customer: {
        name: "Pat Client $9,999",
        phone: "0412 000 111",
        email: "pat@example.test",
        site_address: "12 Fence St $850",
        site_suburb: "Midland",
        deposit_amount: 4400,
      },
      terms: {
        payment_terms: "50% deposit + 50% on completion $9,999",
        valid_days: 30,
        valid_until: "2026-10-01",
        deposit_percent: 50,
      },
    },
  ]);
  assertEquals(out[0].customer, {
    name: "Pat Client",
    phone: "0412 000 111",
    email: "pat@example.test",
    site_address: "12 Fence St",
    site_suburb: "Midland",
  });
  assertEquals(out[0].terms, {
    payment_terms: "50% deposit + 50% on completion",
    valid_days: 30,
    valid_until: "2026-10-01",
  });
  assertEquals("deposit_amount" in (out[0].customer || {}), false);
  assertEquals("deposit_percent" in (out[0].terms || {}), false);
  assertEquals(JSON.stringify(out).includes("9999"), false);
  assertEquals(JSON.stringify(out).includes("4400"), false);
  assertAllocatedTradeQuotePackProjection(out[0]);
});

Deno.test("redactTradeQuotePackMoney fail-closes money tokens on every customer and terms string", () => {
  const out = redactTradeQuotePackMoney([{
    quote_number: "Q-1",
    customer: {
      name: "USD Client",
      phone: "0412 $18,400",
      email: "fee@example.test",
      site_address: "12 cost street",
      site_suburb: "rate suburb",
    },
    terms: {
      payment_terms: "Pay the deposit now",
      valid_days: 30,
      valid_until: "valid until price review",
    },
  }]);
  assertEquals(out[0].customer, {
    name: null,
    phone: null,
    email: null,
    site_address: null,
    site_suburb: null,
  });
  assertEquals(out[0].terms, {
    payment_terms: null,
    valid_days: 30,
    valid_until: null,
  });
  assertAllocatedTradeQuotePackProjection(out[0]);
  assertEquals(redactTradeQuotePackMoney([{
    quote_number: "Q-1",
    terms: { payment_terms: "Payment on completion", valid_days: 30 },
  }])[0].terms?.payment_terms, null);
  assertEquals(redactTradeQuotePackMoney([{
    quote_number: "Q-1",
    terms: { payment_terms: "Net 30", valid_days: 30 },
  }])[0].terms?.payment_terms, null);
});

Deno.test("redactTradeQuotePackMoney keeps sealed phrase only on payment_terms", () => {
  const out = redactTradeQuotePackMoney([{
    quote_number: "Q-1",
    customer: { name: "50% deposit + 50% on completion" },
    terms: { payment_terms: "50% deposit + 50% on completion $9,999", valid_days: 30 },
    items: [{
      kind: "info",
      description: "50% deposit + 50% on completion",
      quantity: 1,
      unit_price: null,
      line_total: null,
    }],
    summary: "50% deposit + 50% on completion",
  }]);
  assertEquals(out[0].customer?.name, null);
  assertEquals(out[0].summary, null);
  assertEquals(out[0].items[0].description, null);
  assertEquals(out[0].terms?.payment_terms, "50% deposit + 50% on completion");
  assertAllocatedTradeQuotePackProjection(out[0]);
});

Deno.test("redactTradeQuotePackMoney nulls a nested quantity object instead of copying it", () => {
  const out = redactTradeQuotePackMoney([{
    quote_number: "Q-1",
    items: [{
      kind: "install_m",
      description: "Install Quote 850",
      quantity: { billed: 9999, rate: 85 },
      unit_price: 30,
    }],
  }]);
  assertEquals(out[0].items[0].quantity, null);
  assertEquals(out[0].items[0].description, "Install Quote");
  assertEquals(JSON.stringify(out).includes("9999"), false);
  assertEquals(JSON.stringify(out).includes("850"), false);
});

Deno.test("redactTradeQuotePackMoney omits pack notes so sell figures cannot ride the allocated projection", () => {
  const out = redactTradeQuotePackMoney([
    {
      quote_number: "Q-1",
      notes: "Priced $9,999 inc GST — do not show the trade",
      items: [],
    },
  ]);
  assertEquals(out[0].quote_number, "Q-1");
  assertEquals("notes" in out[0], false);
  assertEquals(JSON.stringify(out).includes("9999"), false);
});

Deno.test("redactTradeQuotePackMoney drops money-shaped unit and kind scalars", () => {
  const out = redactTradeQuotePackMoney([{
    quote_number: "Q-1",
    items: [
      { kind: "install_m", description: "Install Deposit 85", quantity: 10, unit: "AUD 9,999" },
      { kind: "AUD 9,999", description: "Sell line", quantity: 1, unit: "ea" },
      { kind: "install_m", description: "Rear", quantity: 19, unit: "m" },
      { kind: "install_m", description: "Sheets", quantity: 12, unit: "85" },
      { kind: "85", description: "Hidden", quantity: 1, unit: "999" },
    ],
  }]);
  assertEquals(out[0].items.map((i: any) => i.kind), ["install_m", "install_m", "install_m"]);
  assertEquals(out[0].items[0].description, "Install Deposit");
  assertEquals(out[0].items[0].unit, undefined);
  assertEquals(out[0].items[1].unit, "m");
  assertEquals(out[0].items[2].unit, undefined);
  assertEquals(JSON.stringify(out).includes("AUD"), false);
  assertEquals(JSON.stringify(out).includes("9,999"), false);
  assertEquals(JSON.stringify(out).includes("\"85\""), false);
  assertEquals(JSON.stringify(out).includes("999"), false);
});

Deno.test("redactTradeQuotePackMoney drops numeric-only summaries and descriptions", () => {
  const out = redactTradeQuotePackMoney([{
    quote_number: "Q-1",
    summary: 85,
    items: [
      { kind: "install_m", description: 85, quantity: 10, unit: "m" },
      { kind: "install_m", description: "999", quantity: 2, unit: "ea" },
      { kind: "install_m", description: "Rear 19m", quantity: 19, unit: "m" },
    ],
  }]);
  assertEquals(out[0].summary, null);
  assertEquals(out[0].items[0].description, null);
  assertEquals(out[0].items[1].description, null);
  assertEquals(out[0].items[2].description, "Rear 19m");
  assertEquals(JSON.stringify(out).includes("\"85\""), false);
});

Deno.test("sanitizeTradeAllocatedJobNotes drops numeric top-level notes and keeps writing / objects", () => {
  assertEquals(sanitizeTradeAllocatedJobNotes(85), null);
  assertEquals(sanitizeTradeAllocatedJobNotes("85"), null);
  assertEquals(
    sanitizeTradeAllocatedJobNotes("Park on the verge. Extra $9,999"),
    "Park on the verge. Extra",
  );
  assertEquals(sanitizeTradeAllocatedJobNotes("2 trades over 3 days"), "2 trades over 3 days");
  const walked = sanitizeTradeAllocatedJobNotes({
    noteWorkOrder: "Use 90x90 posts",
    sell: 9999,
    amount: 85,
  });
  assertEquals(walked, { noteWorkOrder: "Use 90x90 posts" });
});

Deno.test("redactTradeQuotePackMoney omits kind:note items and strips $ figures from summary and descriptions", () => {
  const out = redactTradeQuotePackMoney([
    {
      quote_number: "Q-1",
      summary: "Install 10m Total $9,999 AUD 1,200 A$ 80 $ 40 Total 9,999 AUD Approved total 9,999 ex GST",
      items: [
        { kind: "install_m", description: "Install fence Total $9,999 AUD 1,200 Total 9,999 AUD", quantity: 10, unit: "m" },
        { kind: "note", description: "Priced $9,999 — installer note", quantity: 1, unit: "lot" },
      ],
    },
  ]);
  assertEquals(out[0].summary, "Install 10m Total Total Approved total");
  assertEquals(out[0].items.map((i: any) => i.kind), ["install_m"]);
  assertEquals(out[0].items[0].description, "Install fence Total Total");
  assertEquals(JSON.stringify(out).includes("9999"), false);
  assertEquals(JSON.stringify(out).includes("1200"), false);
});

// ── Lead designation reads is_lead, never role ──────────────────────────────

Deno.test("lead surfaces: tradeLeadJobIds / tradeIsDesignatedLead read is_lead=true and never job_assignments.role", async () => {
  const recorded: any[] = [];
  const c = makeClient(seed(), recorded);
  assertEquals(await tradeLeadJobIds(c, LEAD), [JOB_FENCE]);
  // The crew member carries the default role 'lead_installer' on every row and
  // is STILL not a lead anywhere.
  assertEquals(await tradeLeadJobIds(c, CREW), []);
  assertEquals(await tradeIsDesignatedLead(c, LEAD, JOB_FENCE), true);
  assertEquals(await tradeIsDesignatedLead(c, CREW, JOB_FENCE), false);
  for (const r of recorded.filter((r) => r.table === "job_assignments")) {
    assertEquals(r.eq.is_lead, true);
    assertEquals("role" in r.eq, false);
  }
});

// ── trade_labour_budget through the tier ─────────────────────────────────────

Deno.test("trade_labour_budget: an allocated trade passes but the QUOTED labour figure never funds the budget", async () => {
  const t = seed();
  t.purchase_orders = []; // no labour PO → the old code fell back to pricing_json.labourTotal (3200)
  const p = await _tradeLabourBudgetForTest(makeClient(t), new URLSearchParams({ jobId: JOB_FENCE }), CREW, false, {
    orgId: ORG_A,
    managedVerticals: [],
  });
  assertEquals(p.labour_budget, 0);
});

Deno.test("trade_labour_budget: the division manager passes (was refused by the strict assignment check) and gets the quoted labour fallback", async () => {
  const t = seed();
  t.purchase_orders = [];
  const p = await _tradeLabourBudgetForTest(makeClient(t), new URLSearchParams({ jobId: JOB_FENCE }), HENRY, false, {
    orgId: ORG_A,
    managedVerticals: ["fencing"],
  });
  assertEquals(p.labour_budget, 3200);
});

// The shared tier predicate grants `makesafe_open` to ANY signed-in trade on ANY
// make-safe job (it asks whether the job is a make-safe, never whether it is
// open to this caller). That is right for the field-report doors and wrong here:
// this response names every assigned crew member, their hours, their
// trade_rates.hourly_rate and the cost derived from it.
Deno.test("trade_labour_budget: the MakeSafe open-pool tier is refused — another trade's pay is not a report-door read", async () => {
  const t = seed();
  t.job_assignments.push({
    id: "a-ms-lead",
    job_id: JOB_MS,
    user_id: LEAD,
    status: "complete",
    is_lead: true,
    role: "lead_installer",
    started_at: "2026-08-01T00:00:00Z",
    completed_at: "2026-08-01T06:00:00Z",
  });
  t.trade_rates = [{ user_id: LEAD, hourly_rate: 95, effective_from: "2026-01-01", effective_to: null }];
  t.users = [{ id: LEAD, name: "Lead Installer" }];

  // Control: the tier IS makesafe_open, so the refusal is the door's doing.
  const tier = await resolveTradeJobAccessTier(makeClient(t), JOB_MS, STRANGER, {
    access: { orgId: ORG_A, managedVerticals: [] },
  });
  assertEquals(tier.tier, "makesafe_open");

  await assertRejects(
    () =>
      _tradeLabourBudgetForTest(makeClient(t), new URLSearchParams({ jobId: JOB_MS }), STRANGER, false, {
        orgId: ORG_A,
        managedVerticals: [],
      }),
    Error,
    "not assigned",
  );
});

Deno.test("trade_labour_budget: an allocated crew member on that same make-safe still gets the crew costs", async () => {
  const t = seed();
  t.job_assignments.push({
    id: "a-ms-lead",
    job_id: JOB_MS,
    user_id: LEAD,
    status: "complete",
    is_lead: true,
    role: "lead_installer",
    started_at: "2026-08-01T00:00:00Z",
    completed_at: "2026-08-01T06:00:00Z",
  });
  t.trade_rates = [{ user_id: LEAD, hourly_rate: 95, effective_from: "2026-01-01", effective_to: null }];
  t.users = [{ id: LEAD, name: "Lead Installer" }];

  const p = await _tradeLabourBudgetForTest(makeClient(t), new URLSearchParams({ jobId: JOB_MS }), LEAD, false, {
    orgId: ORG_A,
    managedVerticals: [],
  });
  assertEquals(p.trades.length, 1);
  assertEquals(p.trades[0].rate, 95);
});

Deno.test("labour-cost rule: office, division manager and allocated pass; the open-pool exception and a stranger do not", () => {
  assertEquals(tradeLabourCostVisibleForTier("office"), true);
  assertEquals(tradeLabourCostVisibleForTier("division_manager"), true);
  assertEquals(tradeLabourCostVisibleForTier("allocated"), true);
  assertEquals(tradeLabourCostVisibleForTier("makesafe_open"), false);
  assertEquals(tradeLabourCostVisibleForTier("none"), false);
});

Deno.test("trade_labour_budget: an unallocated, unmanaged trade is refused", async () => {
  await assertRejects(
    () =>
      _tradeLabourBudgetForTest(makeClient(seed()), new URLSearchParams({ jobId: JOB_FENCE }), STRANGER, false, {
        orgId: ORG_A,
        managedVerticals: [],
      }),
    Error,
    "not assigned",
  );
});

// ── Division-manager office reads are bounded to their trade ─────────────────

Deno.test("_scopeCalendarPayloadToVerticals keeps only the manager's own trade(s), incl. SWMS-numbered make-safes for a make-safe manager", () => {
  const payload = {
    events: [
      { job_id: "j1", job_type: "fencing", job_number: "SWF-1" },
      { job_id: "j2", job_type: "patio", job_number: "SWP-1" },
      { job_id: "j3", job_type: "insurance", job_number: "SWMS-1" },
    ],
    deliveries: [{ job_id: "j1" }, { job_id: "j2" }],
    readiness: { j1: { ok: true }, j2: { ok: true }, j3: { ok: false } },
    truncated: false,
  };
  const fencing = _scopeCalendarPayloadToVerticals(payload, ["fencing"]);
  assertEquals(fencing.events.map((e: any) => e.job_id), ["j1"]);
  assertEquals(fencing.deliveries, [{ job_id: "j1" }]);
  assertEquals(Object.keys(fencing.readiness), ["j1"]);
  assertEquals(fencing.truncated, false);
  const ms = _scopeCalendarPayloadToVerticals(payload, ["makesafe"]);
  assertEquals(ms.events.map((e: any) => e.job_id), ["j3"]);
  const none = _scopeCalendarPayloadToVerticals(payload, []);
  assertEquals(none.events, []);
});

// ── my_jobs personal lane recency (Captain live report 2026-08-17) ───────────

Deno.test("my_jobs personal recency is window overlap: an ongoing span, a fresh start, or no date at all", () => {
  assertEquals(
    _myJobsPersonalRecencyFilter("2026-07-18"),
    "scheduled_end.gte.2026-07-18,and(scheduled_end.is.null,scheduled_date.gte.2026-07-18),scheduled_date.is.null",
  );
});
