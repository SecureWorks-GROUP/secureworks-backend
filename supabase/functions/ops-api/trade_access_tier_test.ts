// deno-lint-ignore-file no-import-prefix no-explicit-any
// Trade app three-tier access model (Captain ruling 2026-08-17):
//
//   1. Office (admin / owner / ops_manager)   everything, everywhere.
//   2. Division manager (users.managed_verticals contains the job's vertical)
//                                              everything on that trade's jobs,
//                                              quote included, allocation rights.
//   3. Allocated trade (job_assignments row, is_lead TRUE OR FALSE — no
//      difference)                             everything on the job EXCEPT the
//                                              quote.
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
  _myJobsPersonalRecencyFilter,
  _resolveManagerVisibility,
  _scopeCalendarPayloadToVerticals,
  _tradeDocumentsForAllocatedTrade,
  _tradeJobDetailForTest,
  _tradeLabourBudgetForTest,
  redactTradeScopeQuote,
  resolveTradeJobAccessTier,
  TRADE_QUOTE_DOCUMENT_TYPES,
  tradeIsDesignatedLead,
  tradeJobAccessRefusal,
  tradeLeadJobIds,
  tradeQuoteVisibleForTier,
} from "./index.ts";

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
    };
    return api;
  }
  return { from: (t: string) => builder(t) };
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
    noteInternal: "Client is a repeat customer",
  },
  _pricing_json: { totalExGST: 8000, totalIncGST: 8800, marginPct: 35 },
  patios: [{
    options: [{
      label: "Standard",
      pricing: { labour: { days: 2, dayRate: 400, sell: 1600 } },
      _pricing_json: { totalIncGST: 6600 },
    }],
  }],
  job: { _pricing_json: { totalExGST: 5000 }, runs: [{ length: 10 }] },
};

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
    work_orders: [{ id: "wo-1", job_id: JOB_FENCE, wo_number: "WO-1", scope_items: [{ description: "Install fence" }], status: "sent" }],
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

// ── trade_job_detail: the real payload, per tier ─────────────────────────────

function quoteLeakProbe(payload: any): string[] {
  const leaks: string[] = [];
  const text = JSON.stringify(payload);
  for (const needle of ["_pricing_json", "totalIncGST", "totalExGST", "marginPct", "pricingNotes", "noteQuote", "\"sell\"", "Q-1", "Q-2", "quote.pdf", "inv.pdf", "8800", "8000"]) {
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
  assertEquals(quoteLeakProbe(p), [], "no quote coordinate anywhere in the allocated payload");
  // Documents: flagged-visible non-quote docs only. The visible-flagged QUOTE and
  // the client INVOICE are gone; the supplier quote (a supplier's price to us)
  // and the work order stay.
  assertEquals(p.documents.map((d: any) => d.id).sort(), ["d-supplier-quote", "d-wo"]);
  // The installer's own labour budget inputs survive the redaction.
  assertEquals(p.job.scope_json.pricing, { labour: { trades: 2, days: 3, dayRate: 400 } });
  assertEquals(p.job.scope_json.notes, { noteWorkOrder: "Use 90x90 posts", noteInternal: "Client is a repeat customer" });
  assertEquals(p.job.scope_json.config.totalMetres, 42);
});

Deno.test("trade_job_detail: the CREW member gets EXACTLY what the lead gets", async () => {
  const lead = await detail(seed(), viewer(LEAD, "crew"));
  const crew = await detail(seed(), viewer(CREW, "crew"));
  assertEquals(crew, lead);
});

Deno.test("trade_job_detail: the fencing division manager sees the quote docs and the raw scope (office parity within the trade)", async () => {
  const p = await detail(seed(), viewer(HENRY, "lead_installer", ["fencing"]));
  assertEquals(p.access_tier, "division_manager");
  assertEquals(p.quote_visible, true);
  assertEquals(p.documents.map((d: any) => d.id).sort(), ["d-internal", "d-invoice", "d-quote-hid", "d-quote-vis", "d-supplier-quote", "d-wo"]);
  assertEquals(p.job.scope_json._pricing_json.totalIncGST, 8800);
});

Deno.test("trade_job_detail: office gets the same as the manager", async () => {
  const p = await detail(seed(), viewer(OFFICE, "ops_manager"));
  assertEquals(p.access_tier, "office");
  assertEquals(p.quote_visible, true);
  assertEquals(p.job.scope_json._pricing_json.totalIncGST, 8800);
  assertEquals(p.documents.length, 6);
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

Deno.test("redactTradeScopeQuote strips the quote at every depth and keeps the rest", () => {
  const r = redactTradeScopeQuote(structuredClone(QUOTE_SCOPE));
  assertEquals(r._pricing_json, undefined);
  assertEquals(r.job._pricing_json, undefined);
  assertEquals(r.job.runs, [{ length: 10 }]);
  assertEquals(r.patios[0].options[0]._pricing_json, undefined);
  assertEquals(r.patios[0].options[0].pricing, { labour: { days: 2, dayRate: 400 } });
  assertEquals(r.patios[0].options[0].label, "Standard");
  assertEquals(r.pricing, { labour: { trades: 2, days: 3, dayRate: 400 } });
  assertEquals(r.notes.pricingNotes, undefined);
  assertEquals(r.notes.noteQuote, undefined);
  assertEquals(r.notes.noteWorkOrder, "Use 90x90 posts");
  assertEquals(r.client, { notes: "Gate on the left" });
  assertEquals(quoteLeakProbe(r), []);
});

Deno.test("redactTradeScopeQuote: a pricing block with no labour becomes empty, a string blob is parsed, null stays null", () => {
  assertEquals(redactTradeScopeQuote({ pricing: { addonRows: [{ sell: 1 }] } }), { pricing: {} });
  assertEquals(redactTradeScopeQuote(JSON.stringify({ a: 1, _pricing_json: {} })), { a: 1 });
  assertEquals(redactTradeScopeQuote(null), null);
  assertEquals(redactTradeScopeQuote("not json"), null);
});

Deno.test("_tradeDocumentsForAllocatedTrade: honours the flag AND drops quote-bearing types whatever the flag says", () => {
  const docs = seed().job_documents;
  assertEquals(_tradeDocumentsForAllocatedTrade(docs).map((d) => d.id).sort(), ["d-supplier-quote", "d-wo"]);
  assertEquals(_tradeDocumentsForAllocatedTrade(docs).some((d) => "quote_number" in d), false);
  assertEquals([...TRADE_QUOTE_DOCUMENT_TYPES].sort(), ["invoice", "quote"]);
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
