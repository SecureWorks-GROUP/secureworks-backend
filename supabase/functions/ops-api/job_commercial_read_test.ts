// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
//
// Context slice D1 (23 Sep 2026): the job read answers "what was quoted, for
// how much, which version, accepted or not", the variations and the scope.
//
// Named rows (dossier design section 10; row labels only, synthetic ids,
// emails and money shaped on each row). The job_quote_values rows each fixture
// feeds the reader are exactly what the SQL contract
// supabase/tests/migration-contracts/20260923233000_job_quote_values proves
// the function returns for the same shape, so the two tests chain.
//
// Pins (named rows are the LIVE shapes read from production on 23 Sep 2026):
//   R3  SWF-261458  one sealed quote: $4,776.75 from its revision.
//   R6  SWF-26818   Q-0491 v2 current with no sealed value (null, never
//                   invented; a forged log row is ignored); the REAR run
//                   document has no party and is the client's, $4,842.45;
//                   superseded Q-0439 ($5,571.50) is history; variation $374
//                   pending, not agreed.
//   R7  SWF-261355  accepted Q-0738 with no sealed value: accepted, value null
//                   with the reason, never the live price.
//   R8  SWF-26163   variation approved with no send and no acceptance reads
//                   "approved internally, customer acceptance not recorded".
//   R9  SWF-26177   $7,000 variation pending since 4 Jun: listed with age.
//   R10 SWP-261456  no quote document (emailed from Outlook): none_recorded
//                   with the honest note; live price separate.
//   R12 SWMS-261464 no scope: scope no_scope, no error.
//   R14 SWF-26904   three parties recorded, one whole quote: its $7,733.
//   R15 SWF-26395   per-party whole quotes; party C never accepted:
//                   partially_accepted naming her; no party shows the whole
//                   job's $5,104 (job level only).
//   R23 SWF-26167 / SWF-261111 / SWF-26997 / SWP-26634  recipient_mismatch
//                   and "sent, but to <address>".
//   R24 SWP-261203  changed_since_last_quote by the rule (live: never sent).
//   Send-runs shape (synthetic, no named row has live run parties): each
//   party's own share; accepted only when every party on every run accepted.
//   Invoice read agrees with the job read on quote total and variations.
//   Failures: a failed value read is a null section with a code; a failed
//   recipient read keeps values and marks sent_to unknown.
//   Read only: the dossier makes no insert/update/delete/upsert, calls only
//   the job_quote_values RPC (and K4's context_job_freshness), and makes no
//   network call.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { pricingStatusFrom, readScopeRevisionAlignment, summariseScope } from "./job_commercial_read.ts";
import { _assembleJobDossierForTest } from "./index.ts";
import { invoiceContext } from "./invoice_context.ts";
import { isCurrentContextFact } from "./context_visibility.ts";
import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-09-23T06:00:00.000Z");

type Tables = Record<string, any[]>;

// ── fake client: filters honoured, writes trapped ───────────────────────────

const WRITE_METHODS = ["insert", "update", "upsert", "delete"];

function fakeClient(
  tables: Tables,
  opts: { failing?: Set<string> } = {},
) {
  const failing = opts.failing ?? new Set<string>();
  const reads: string[] = [];
  const rpcs: string[] = [];
  const writes: string[] = [];
  return {
    reads,
    rpcs,
    writes,
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push(fn);
      if (failing.has(`rpc:${fn}`)) {
        return { data: null, error: { code: "PGRST202", message: "missing" } };
      }
      const rows = (tables[`rpc:${fn}`] ?? []).filter((r) =>
        r._job_id === args.p_job_id
      ).map(({ _job_id, ...rest }) => rest);
      return { data: rows, error: null };
    },
    from(table: string) {
      reads.push(table);
      const filters: Array<(r: any) => boolean> = [];
      let order: { col: string; asc: boolean } | null = null;
      let limit: number | null = null;
      let single = false;
      const q: any = {};
      for (const m of WRITE_METHODS) {
        q[m] = () => {
          writes.push(`${m}:${table}`);
          throw new Error(`write attempted: ${m} ${table}`);
        };
      }
      q.select = () => q;
      q.eq = (c: string, v: any) => {
        filters.push((r) => r[c] === v);
        return q;
      };
      q.neq = (c: string, v: any) => {
        filters.push((r) => r[c] !== v);
        return q;
      };
      q.in = (c: string, v: any[]) => {
        filters.push((r) => v.includes(r[c]));
        return q;
      };
      q.gt = (c: string, v: any) => {
        filters.push((r) => r[c] != null && r[c] > v);
        return q;
      };
      q.ilike = (c: string, v: string) => {
        filters.push((r) =>
          String(r[c] ?? "").toLowerCase() === v.toLowerCase()
        );
        return q;
      };
      for (
        const m of ["is", "or", "not", "gte", "lt", "lte", "contains", "range"]
      ) {
        q[m] = () => q;
      }
      q.order = (c: string, o: any) => {
        order = { col: c, asc: o?.ascending !== false };
        return q;
      };
      q.limit = (n: number) => {
        limit = n;
        return q;
      };
      q.maybeSingle = () => {
        single = true;
        return q;
      };
      q.single = q.maybeSingle;
      q.then = (resolve: any, reject: any) => {
        if (failing.has(table)) {
          return Promise.resolve({
            data: null,
            error: { code: "42P01", message: `${table} unavailable` },
          }).then(resolve, reject);
        }
        let rows = (tables[table] ?? []).filter((r) =>
          filters.every((f) => f(r))
        );
        if (order) {
          const { col, asc } = order;
          rows = [...rows].sort((a, b) =>
            (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1)
          );
        }
        if (limit !== null) rows = rows.slice(0, limit);
        return Promise.resolve({
          data: single ? rows[0] ?? null : rows,
          error: null,
        }).then(resolve, reject);
      };
      return q;
    },
  };
}

// ── helpers to shape fixtures ────────────────────────────────────────────────

function doc(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    type: "quote",
    version: 1,
    quote_number: null,
    run_label: null,
    job_contact_id: null,
    sent_at: null,
    viewed_at: null,
    accepted_at: null,
    declined_at: null,
    superseded_at: null,
    quote_revision_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function value(documentId: string, over: Record<string, unknown> = {}) {
  return {
    document_id: documentId,
    job_contact_id: null,
    party_is_owner: null,
    run_label: null,
    value_inc_gst: null,
    value_source: "not recorded on the sent quote",
    whole_quote_total_inc: null,
    whole_quote_source: null,
    ...over,
  };
}

function quotesInput(p: {
  clientEmail?: string | null;
  values: any[];
  documents: any[];
  runAcceptances?: any[];
  revisions?: any[];
  parties?: any[];
  sentEvents?: any[];
}) {
  return {
    job: { client_email: p.clientEmail ?? null },
    values: p.values,
    documents: p.documents,
    runAcceptances: p.runAcceptances ?? [],
    recipients: {
      revisions: p.revisions ?? [],
      parties: p.parties ?? [],
      sentEvents: p.sentEvents ?? [],
    },
  };
}

// ── R6 SWF-26818 (live shape, 23 Sep read) ──────────────────────────────────

function row6Input() {
  return quotesInput({
    clientEmail: "owner6@example.test",
    documents: [
      doc("r6-q0439", {
        quote_number: "Q-0439",
        version: 1,
        sent_at: "2026-06-25T12:15:36.000Z",
        viewed_at: "2026-06-25T13:00:00.000Z",
        superseded_at: "2026-07-05T00:00:00.000Z",
      }),
      doc("r6-q0491", {
        quote_number: "Q-0491",
        version: 2,
        sent_at: "2026-07-05T01:00:00.000Z",
        viewed_at: "2026-07-05T02:00:00.000Z",
      }),
      // live: the REAR run document carries no party and no quote number
      doc("r6-rear", {
        run_label: "REAR",
        sent_at: "2026-07-06T01:00:00.000Z",
        viewed_at: "2026-07-22T01:00:00.000Z",
      }),
    ],
    // Exactly the SQL contract's output for this shape.
    values: [
      value("r6-rear", {
        party_is_owner: true,
        run_label: "REAR",
        value_inc_gst: 4842.45,
        value_source: "run_snapshot_share",
      }),
      value("r6-q0491"),
      value("r6-q0439", {
        value_inc_gst: 5571.5,
        value_source: "quote_revision",
      }),
    ],
    revisions: [{
      id: "r6-rev",
      job_document_id: "r6-q0439",
      recipient_email: "owner6@example.test",
      released_via: "send-quote/send",
      version: 1,
      sent_at: "2026-06-25T12:15:36.000Z",
    }],
    sentEvents: [{
      occurred_at: "2026-06-25T12:15:36.000Z",
      source: "send-quote/send",
      payload: { document_id: "r6-q0439", sent_to: "owner6@example.test" },
    }, {
      // forged row from a public source naming the current document
      occurred_at: "2026-07-06T02:00:00.000Z",
      source: "website_form",
      payload: { document_id: "r6-q0491", sent_to: "attacker@example.test" },
    }],
  });
}

// ── send-runs shape (synthetic: no named row has live run parties) ──────────

const R14 = { owner: "r14-owner", a: "r14-nb-a", b: "r14-nb-b" };

// ── dossier: sections, read-only contract, and agreement with the invoice read ──

const DOSSIER_JOB = "d1000000-0000-4000-8000-000000026818";
function dossierTables(): Tables {
  return {
    jobs: [{
      id: DOSSIER_JOB,
      job_number: "SWF-26818",
      type: "fencing",
      status: "archived",
      client_name: "Row Six",
      client_email: "owner6@example.test",
      ghl_contact_id: null,
      org_id: ORG,
      scope_json: {
        runs: [{
          run_label: "REAR",
          type: "Colorbond",
          length_m: 18,
          height_mm: 1800,
        }],
      },
      pricing_json: { totalIncGST: 5571.5 },
      scope_version: 1,
      scope_updated_at: null,
    }],
    job_documents: row6Input().documents.map((d) => ({
      ...d,
      job_id: DOSSIER_JOB,
    })),
    run_acceptances: row6Input().runAcceptances.map((r) => ({
      ...r,
      job_id: DOSSIER_JOB,
    })),
    quote_revisions: [],
    job_contacts: [],
    job_variations: [{
      job_id: DOSSIER_JOB,
      variation_number: 1,
      description: "Extra post",
      amount: 374,
      status: "pending_approval",
      created_at: "2026-07-05T00:00:00.000Z",
    }],
    business_events: [
      {
        id: "qs-1",
        job_id: null, // cleared by the attribution ladder
        entity_type: "job",
        entity_id: DOSSIER_JOB,
        event_type: "quote.sent",
        source: "send-quote/send",
        occurred_at: "2026-06-25T12:15:36.000Z",
        payload: { document_id: "r6-q0439", sent_to: "owner6@example.test" },
      },
      {
        id: "sc-1",
        job_id: null,
        entity_type: "job",
        entity_id: DOSSIER_JOB,
        event_type: "scope.completed",
        source: "scoping_tool",
        occurred_at: "2026-05-20T02:00:00.000Z",
        payload: {},
      },
    ],
    "rpc:job_quote_values": row6Input().values.map((v) => ({
      _job_id: DOSSIER_JOB,
      ...v,
    })),
  };
}

Deno.test("D1 dossier: quotes, variations and scope sections on SWF-26818, read only, no network", async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => {
    fetches++;
    throw new Error("the dossier must not call the network");
  }) as typeof fetch;
  try {
    const client = fakeClient(dossierTables());
    const d: any = await _assembleJobDossierForTest(client, {
      job_id: DOSSIER_JOB,
    });

    // read-only contract
    assertEquals(client.writes, []);
    // job_quote_values (D1), context_job_freshness (K4) and, through the
    // conversation it reuses, context_job_card_decisions (CTX-T22) are the only calls.
    assertEquals([...new Set(client.rpcs)].sort(), [
      "context_job_card_decisions",
      "context_job_freshness",
      "job_quote_values",
    ]);
    assertEquals(fetches, 0);

    // The version literal is pinned by job_freshness_test.ts (the newest section).
    assert(d.sections_version >= 2);
    assertEquals(d._kind, "job_dossier_v1");
    const q = d.operationalTruth.quotes;
    assertEquals(q.status, "viewed");
    assertEquals(q.current.map((c: any) => c.document_id), [
      "r6-rear",
      "r6-q0491",
    ]);
    assertEquals(q.current[0].value_inc_gst, 4842.45);
    // found by the job it names although the ladder cleared job_id
    assertEquals(q.history[0].sent_to, "owner6@example.test");
    assertEquals(q.whole_quote_total, null);
    assertEquals(d.operationalTruth.variations[0].amount, 374);
    assertEquals(d.operationalTruth.variations[0].agreed, false);
    assertEquals(d.scope.kind, "fence");
    assertEquals(d.scope.current_price_inc_gst, 5571.5);
    assertEquals(d.scope.signed_off_at, "2026-05-20T02:00:00.000Z");
    assertEquals(d.diagnostics.sourceStatus.quotes, {
      ok: true,
      state: "ok",
      count: 3,
    });
    assertEquals(d.diagnostics.sourceStatus.variations, {
      ok: true,
      state: "ok",
      count: 1,
    });
    assertEquals(d.diagnostics.sourceStatus.scope.ok, true);
    // the raw blobs are read, never returned
    assertEquals(d.job.scope_json, undefined);
    assertEquals(d.job.pricing_json, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("D1 dossier: a failed value read leaves quotes null and diagnostics not ok", async () => {
  const client = fakeClient(dossierTables(), {
    failing: new Set(["rpc:job_quote_values"]),
  });
  const d: any = await _assembleJobDossierForTest(client, {
    job_id: DOSSIER_JOB,
  });
  assertEquals(d.operationalTruth.quotes, null);
  assertEquals(d.diagnostics.sourceStatus.quotes.state, "failed");
  assertEquals(d.diagnostics.ok, false);
  assertEquals(d.scope.changed_since_last_quote, null);
  assertEquals(d.scope.changed_since_last_quote_basis, "quote_read_failed");
  assertEquals(client.writes, []);
});

Deno.test("D1 invoice read agrees with the job read on the quote total and variations", async () => {
  const t = dossierTables();
  t.xero_invoices = [{
    org_id: ORG,
    invoice_type: "ACCREC",
    xero_invoice_id: "b0000000-0000-4000-8000-000000026818",
    xero_contact_id: "xc-6",
    contact_name: "Row Six",
    invoice_number: "INV-2681",
    reference: "SWF-26818 DEP",
    status: "AUTHORISED",
    total: 2421.23,
    amount_due: 2421.23,
    amount_paid: 0,
    invoice_date: "2026-07-02",
    due_date: "2026-07-16",
    job_id: DOSSIER_JOB,
    synced_at: "2026-09-23T05:00:00.000Z",
    line_items: [],
    raw_json: {},
  }];
  const client = fakeClient(t);
  const inv: any = await invoiceContext(
    new URLSearchParams({ invoice: "INV-2681" }),
    {
      client,
      orgId: ORG,
      getJobConversation: async () => ({ messages: [] }),
      isCurrentContextFact,
      now: () => NOW,
    },
  );
  const d: any = await _assembleJobDossierForTest(fakeClient(dossierTables()), {
    job_id: DOSSIER_JOB,
  });
  const headline = d.operationalTruth.quotes.headline;
  assertEquals(inv.job.promised.quote_total, headline.value_inc_gst);
  assertEquals(inv.job.promised.quote_total_source, headline.value_source);
  assertEquals(
    inv.job.promised.quote_document.document_id,
    headline.document_id,
  );
  // the live price is reported separately and never as the quote total
  assertEquals(inv.job.promised.current_price_inc_gst, 5571.5);
  assert(inv.job.promised.quote_total !== 5571.5);
  assertEquals(
    inv.job.promised.variations.map((v: any) => [v.number, v.amount, v.agreed]),
    d.operationalTruth.variations.map((
      v: any,
    ) => [`VAR${v.variation_number}`, v.amount, v.agreed]),
  );
  assertEquals(inv.job.promised.variations_code, null);
  assertEquals(client.writes, []);
});

Deno.test("D1 invoice read: a failed variation read leaves promised.variations null with the reason", async () => {
  const t = dossierTables();
  t.xero_invoices = [{
    org_id: ORG,
    invoice_type: "ACCREC",
    xero_invoice_id: "b0000000-0000-4000-8000-000000026818",
    xero_contact_id: "xc-6",
    contact_name: "Row Six",
    invoice_number: "INV-2681",
    reference: "SWF-26818 DEP",
    status: "AUTHORISED",
    total: 2421.23,
    amount_due: 2421.23,
    amount_paid: 0,
    invoice_date: "2026-07-02",
    due_date: "2026-07-16",
    job_id: DOSSIER_JOB,
    synced_at: "2026-09-23T05:00:00.000Z",
    line_items: [],
    raw_json: {},
  }];
  const client = fakeClient(t, { failing: new Set(["job_variations"]) });
  const inv: any = await invoiceContext(
    new URLSearchParams({ invoice: "INV-2681" }),
    {
      client,
      orgId: ORG,
      getJobConversation: async () => ({ messages: [] }),
      isCurrentContextFact,
      now: () => NOW,
    },
  );
  assertEquals(inv.job.promised.variations, null);
  assertEquals(inv.job.promised.variations_code, "42P01");
  assertEquals(inv.sources.promised.ok, false);
  assert(String(inv.sources.promised.error).includes("job_variations"));
  assertEquals(client.writes, []);
});

// Sales patio-scoper draft: site, design, pricing (scope-engine-v2 store.ts).
function salesDraft() {
  return {
    site: {
      customer: "Pat Example",
      mobile: "0400000000",
      email: "pat@example.com",
      address: "1 Example St",
      gateCode: "GATE-5#",
      storeys: "single",
      houseRoof: "tile",
      fascia: "timber",
      windClass: "N2",
      readings: { slope: "flat" },
    },
    design: {
      shape: "skillion",
      widthMm: 6000,
      projectionMm: 4000,
      frontHeightMm: 2400,
      pitchDeg: 5,
    },
    pricing: {
      rates: { roof: 77711 },
      materialsTotal: 77712,
      oneFigure: 77713,
      labour: [{ name: "Install crew", amount: 77714 }],
      marginPct: 35,
      commissionPct: 13,
      rateFrom: "catalogue-77715",
    },
  };
}

// The office reads the draft whole: margin, commission, rates and the
// customer's contact details (INT-01, Jan 27 Oct 2026). The dossier itself is
// refused to anyone who is not office (dossier_audience_test.ts).
function assertWholeDraft(scope: { scope_record?: { draft: unknown } }) {
  assertEquals(scope.scope_record?.draft, salesDraft());
}

Deno.test("SQ-29 scope: a sealed patio-scoper record reads its own lines and provenance, never its figures", () => {
  const draft = salesDraft();
  const scope = summariseScope({
    id: "job-sq29",
    type: "patio",
    scope_json: {
      tool: "patio-scoper",
      version: "2.0",
      revision: {
        n: 3,
        scopeRevisionId: "rev-3",
        parentRevisionId: "rev-2",
        frozenId: "frz-3",
        catalogueRevisionId: "cat-1",
        sealedAt: "2026-10-20T01:00:00Z",
        outputsAgree: true,
      },
      family: "skillion",
      supported: true,
      lines: [
        { id: "l1", description: "Roof sheet", quantity: 12, unit: "ea", colour: "Surfmist" },
        { id: "l2", description: "Post", quantity: null, unit: "ea" },
      ],
      expected: { materials: 4321, labour: 1234, sale: 9876 },
      draft,
      savedAt: "2026-10-20T01:01:00Z",
    },
    pricing_json: null,
    scope_version: 3,
    scope_updated_at: "2026-10-20T01:01:00Z",
  }, { newestQuoteSentAt: null, signedOff: null });
  assertEquals(scope.status, "summarised");
  assertEquals(scope.kind, "patio");
  assertEquals(scope.lines, [
    "Roof sheet (12 ea), Surfmist",
    "Post (quantity to confirm)",
  ]);
  assertEquals(scope.scope_record, {
    tool: "patio-scoper",
    version: "2.0",
    family: "skillion",
    supported: true,
    draft,
    pricing_status: null,
    revision_n: 3,
    scope_revision_id: "rev-3",
    parent_revision_id: "rev-2",
    frozen_id: "frz-3",
    sealed_at: "2026-10-20T01:00:00Z",
  });
  const text = JSON.stringify(scope);
  for (const figure of ["4321", "1234", "9876"]) {
    assert(!text.includes(figure), `figure ${figure} leaked`);
  }
});

Deno.test("INT-01 scope: the office reads the Sales draft whole, margin, commission and contacts included", () => {
  const draft = salesDraft();
  const scope = summariseScope({
    id: "job-sq29-draft",
    type: "patio",
    scope_json: {
      tool: "patio-scoper",
      version: "2.0",
      revision: { n: 1, scopeRevisionId: "rev-1", parentRevisionId: null },
      family: "skillion",
      supported: true,
      lines: [],
      draft: { ...draft, width: 6000 },
    },
    pricing_json: null,
  }, { newestQuoteSentAt: null, signedOff: null });
  assertEquals(scope.scope_record?.draft, {
    site: draft.site,
    design: draft.design,
    pricing: draft.pricing,
  });
  assertEquals(scope.scope_record?.draft?.site?.customer, "Pat Example");
  assertEquals(scope.scope_record?.draft?.site?.address, "1 Example St");
  assertEquals(scope.scope_record?.draft?.site?.gateCode, "GATE-5#");
  assertEquals(scope.scope_record?.draft?.design?.widthMm, 6000);
  assertEquals(scope.scope_record?.draft?.design?.projectionMm, 4000);
  assertEquals(scope.scope_record?.draft?.pricing?.marginPct, 35);
  assertEquals(scope.scope_record?.draft?.pricing?.commissionPct, 13);
  assertEquals(scope.scope_record?.draft?.pricing?.materialsTotal, 77712);
  // No last-save status: the status comes from the frozen row only.
  assertEquals(scope.scope_record?.pricing_status, null);
  assertEquals(
    Object.prototype.hasOwnProperty.call(scope.scope_record?.draft, "width"),
    false,
  );

  const booleanDraft = summariseScope({
    id: "job-sq29-bool",
    type: "patio",
    scope_json: {
      tool: "patio-scoper",
      version: "2.0",
      revision: { n: 1, scopeRevisionId: "rev-1", parentRevisionId: null },
      family: "skillion",
      supported: true,
      lines: [],
      draft: false,
    },
    pricing_json: null,
  }, { newestQuoteSentAt: null, signedOff: null });
  assertEquals(booleanDraft.scope_record?.draft, null);

  // A draft holding only pricing and contacts is still the office's draft.
  const pricingOnly = summariseScope({
    id: "job-sq29-pricing-only",
    type: "patio",
    scope_json: {
      tool: "patio-scoper",
      version: "2.0",
      revision: { n: 1, scopeRevisionId: "rev-1", parentRevisionId: null },
      family: "skillion",
      supported: true,
      lines: [],
      draft: {
        site: { customer: "Pat Example", mobile: "0400000000" },
        pricing: draft.pricing,
      },
    },
    pricing_json: null,
  }, { newestQuoteSentAt: null, signedOff: null });
  assertEquals(pricingOnly.scope_record?.draft, {
    site: { customer: "Pat Example", mobile: "0400000000" },
    design: null,
    pricing: draft.pricing,
  });
});

Deno.test("INT-01 status: Sales' completeness rule as booleans only", () => {
  const complete = {
    pricing_complete: true,
    sell_to_confirm: [],
    internal: { costs_complete: true, costs_to_confirm: [] },
    revision: { sealed: true },
  };
  assertEquals(pricingStatusFrom(complete), {
    pricing_complete: true,
    sell_to_confirm_empty: true,
    costs_complete_not_false: true,
    revision_sealed: true,
    complete: true,
  });
  // S5: a missing costs_complete is "not false".
  assertEquals(
    pricingStatusFrom({ ...complete, internal: {} })?.complete,
    true,
  );
  // costs_complete false makes the whole rule false.
  const costsFalse = pricingStatusFrom({
    ...complete,
    internal: { costs_complete: false },
  });
  assertEquals(costsFalse?.costs_complete_not_false, false);
  assertEquals(costsFalse?.complete, false);
  // C5d: a missing sell_to_confirm is unknown, not empty.
  const { sell_to_confirm: _s, ...noSell } = complete;
  const unknownSell = pricingStatusFrom(noSell);
  assertEquals(unknownSell?.sell_to_confirm_empty, null);
  assertEquals(unknownSell?.complete, null);
  // No revision, or a non-boolean flag, is unknown.
  const { revision: _r, ...noRevision } = complete;
  assertEquals(pricingStatusFrom(noRevision)?.revision_sealed, null);
  assertEquals(pricingStatusFrom(noRevision)?.complete, null);
  assertEquals(
    pricingStatusFrom({ ...complete, pricing_complete: "yes" })?.pricing_complete,
    null,
  );
  assertEquals(pricingStatusFrom("not json"), null);
  // The text form, as stored on the frozen row, reads the same.
  assertEquals(pricingStatusFrom(JSON.stringify(complete))?.complete, true);
});

Deno.test("SQ-29 scope: an unsupported family says no quote or order is implied", () => {
  const scope = summariseScope({
    id: "job-sq29-u",
    type: "patio",
    scope_json: {
      tool: "patio-scoper",
      version: "2.0",
      revision: { n: 1, scopeRevisionId: "rev-1", parentRevisionId: null },
      family: "carport",
      supported: false,
      lines: [],
      expected: { materials: null, labour: null, sale: null },
    },
    pricing_json: null,
  }, { newestQuoteSentAt: null, signedOff: null });
  assertEquals(scope.kind, "patio");
  assertEquals(scope.lines, [
    "carport: not a family the scoper prices, so no quote or order is implied",
  ]);
  assertEquals(scope.scope_record?.supported, false);
  assertEquals(scope.scope_record?.parent_revision_id, null);
});

Deno.test("SQ-29 scope: the older patio tool shape still goes through the shared adapter", () => {
  const scope = summariseScope({
    id: "job-old",
    type: "patio",
    scope_json: { patios: [{ config: { dimensions: { width: 6, depth: 3 } } }] },
    pricing_json: null,
  }, { newestQuoteSentAt: null, signedOff: null });
  assertEquals(scope.scope_record, undefined);
  assertEquals(scope.kind, "patio");
});

// ── SQ-29: the frozen revision, read through the existing scope_revisions ───

function patioRecord(n: number, frozenId: string, desc: string) {
  return {
    tool: "patio-scoper",
    version: "2.0",
    revision: { n, scopeRevisionId: `rev-${n}`, frozenId, sealedAt: "2026-10-20T01:00:00Z" },
    family: "skillion",
    supported: true,
    lines: [{ id: "l1", description: desc, quantity: 2, unit: "ea" }],
    expected: { materials: 4321, labour: 1234, sale: 9876 },
  };
}

// The frozen row's pricing (Sales' pricing object, as freeze_scope stores it):
// the status keys beside figures and line names that must never cross over.
const FROZEN_PRICING = {
  pricing_complete: false,
  sell_to_confirm: ["Margin", "SENTINEL-LINE"],
  internal: {
    costs_complete: true,
    costs_to_confirm: ["COST-SENTINEL"],
    materials: 66601,
    labour: 66602,
  },
  revision: { sealed: true },
  margin_pct: 66603,
  totalIncGST: 66604,
};
const FROZEN_PRICING_LEAKS = [
  "66601", "66602", "66603", "66604", "Margin", "SENTINEL-LINE",
  "COST-SENTINEL", "sell_to_confirm\"", "costs_to_confirm", "PRICINGTEXT",
];

async function frozenRows(
  jobId: string,
  frozenScope: unknown,
  earlierScope: unknown,
  frozenPricing: unknown = FROZEN_PRICING,
) {
  const frozen = await canonicalJsonAndHash(frozenScope);
  const earlier = await canonicalJsonAndHash(earlierScope);
  const pricing = await canonicalJsonAndHash(frozenPricing);
  return [
    {
      id: "srv-2", job_id: jobId, revision_number: 2, status: "frozen",
      tool_kind: "patio", tool_version: "patio-scoper/2.0",
      scope_hash: frozen.hash, scope_canonical_text: frozen.canonical,
      pricing_canonical_text: pricing.canonical, pricing_hash: pricing.hash,
      frozen_at: "2026-10-20T02:00:00Z", superseded_at: null,
      superseded_by_scope_revision_id: null,
    },
    {
      id: "srv-1", job_id: jobId, revision_number: 1, status: "superseded",
      tool_kind: "patio", tool_version: "patio-scoper/2.0",
      scope_hash: earlier.hash, scope_canonical_text: earlier.canonical,
      frozen_at: "2026-10-20T01:00:00Z", superseded_at: "2026-10-20T02:00:00Z",
      superseded_by_scope_revision_id: "srv-2",
    },
  ];
}

const SQ29_JOB = "00000000-0000-0000-0000-0000000sq029";

Deno.test("SQ-29 frozen: a last save equal to the frozen row reads as that frozen revision, with history", async () => {
  const current = patioRecord(2, "frz-2", "Roof sheet");
  const rows = await frozenRows(SQ29_JOB, current, patioRecord(1, "frz-1", "Old sheet"));
  const client = fakeClient({ scope_revisions: rows });
  const rev = await readScopeRevisionAlignment(client, SQ29_JOB, current);
  assertEquals(rev.ok, true);
  assertEquals(rev.last_save_matches_frozen, true);
  assertEquals(rev.frozen_scope_json, null); // the text is not used when it matches
  // the second read is the frozen row's pricing, for the figure-free status
  assertEquals(client.reads.filter((t) => t === "scope_revisions").length, 2);
  const scope = summariseScope(
    { id: SQ29_JOB, type: "patio", scope_json: current, pricing_json: null },
    { newestQuoteSentAt: null, signedOff: null, revisions: rev },
  );
  assertEquals(scope.scope_source, "frozen_revision");
  assertEquals(scope.frozen_revision?.scope_revision_id, "srv-2");
  // the server id and the tool's own frozenId are different ids
  assertEquals(scope.scope_record?.frozen_id, "frz-2");
  assertEquals(scope.revision_history?.map((r) => [r.scope_revision_id, r.status]), [
    ["srv-2", "frozen"],
    ["srv-1", "superseded"],
  ]);
  assertEquals(scope.revision_history?.[1].superseded_by_scope_revision_id, "srv-2");
  assertEquals(scope.lines, ["Roof sheet (2 ea)"]);
  assertEquals(scope.scope_record?.pricing_status, {
    pricing_complete: false,
    sell_to_confirm_empty: false,
    costs_complete_not_false: true,
    revision_sealed: true,
    complete: false,
  });
  const text = JSON.stringify(scope);
  for (const leak of FROZEN_PRICING_LEAKS) {
    assert(!text.includes(leak), `${leak} leaked`);
  }
});

Deno.test("SQ-29 frozen: a save after the freeze is shown as unfrozen, and the lines come from the frozen row", async () => {
  const frozen = patioRecord(2, "frz-2", "Roof sheet");
  const rows = await frozenRows(SQ29_JOB, frozen, patioRecord(1, "frz-1", "Old sheet"));
  const client = fakeClient({ scope_revisions: rows });
  const lastSave = patioRecord(3, "frz-3", "Unfrozen sheet");
  const rev = await readScopeRevisionAlignment(client, SQ29_JOB, lastSave);
  assertEquals(rev.last_save_matches_frozen, false);
  const scope = summariseScope(
    { id: SQ29_JOB, type: "patio", scope_json: lastSave, pricing_json: null },
    { newestQuoteSentAt: null, signedOff: null, revisions: rev },
  );
  assertEquals(scope.scope_source, "frozen_revision");
  assertEquals(scope.last_save_matches_frozen, false);
  assertEquals(scope.lines, ["Roof sheet (2 ea)"]);
  assertEquals(scope.scope_record?.revision_n, 2);
  // the frozen row's status, not the last save's pricing_json
  assertEquals(scope.scope_record?.pricing_status?.complete, false);
  const text = JSON.stringify(scope);
  for (
    const leak of ["4321", "1234", "9876", "Unfrozen sheet", ...FROZEN_PRICING_LEAKS]
  ) {
    assert(!text.includes(leak), `${leak} leaked`);
  }
});

Deno.test("INT-01 frozen: the status never comes from the last save, a draft or unverified pricing", async () => {
  const current = {
    ...patioRecord(2, "frz-2", "Roof sheet"),
    draft: salesDraft(),
  };
  const lastSavePricing = {
    pricing_complete: true,
    sell_to_confirm: [],
    internal: { costs_complete: true },
    revision: { sealed: true },
    totalIncGST: 55501,
  };

  // No frozen row: null, even though the last save says complete.
  const none = await readScopeRevisionAlignment(fakeClient({}), SQ29_JOB, current);
  const s1 = summariseScope(
    { id: SQ29_JOB, type: "patio", scope_json: current, pricing_json: lastSavePricing },
    { newestQuoteSentAt: null, signedOff: null, revisions: none },
  );
  assertEquals(s1.scope_record?.pricing_status, null);
  assertWholeDraft(s1);

  // Pricing that does not hash to pricing_hash is not read.
  const rows = await frozenRows(SQ29_JOB, current, patioRecord(1, "frz-1", "Old sheet"));
  rows[0].pricing_canonical_text = JSON.stringify(lastSavePricing);
  const tampered = await readScopeRevisionAlignment(fakeClient({ scope_revisions: rows }), SQ29_JOB, current);
  assertEquals(tampered.frozen_pricing_status, null);
  assertEquals(tampered.code, "frozen_pricing_hash_mismatch");
  const s2 = summariseScope(
    { id: SQ29_JOB, type: "patio", scope_json: current, pricing_json: lastSavePricing },
    { newestQuoteSentAt: null, signedOff: null, revisions: tampered },
  );
  assertEquals(s2.scope_source, "frozen_revision");
  assertEquals(s2.scope_record?.pricing_status, null);

  // Frozen scope text unusable: the last save is shown, so no status.
  const rows3 = await frozenRows(SQ29_JOB, patioRecord(2, "frz-2", "Roof sheet"), patioRecord(1, "frz-1", "Old sheet"));
  rows3[0].scope_canonical_text = "{}";
  const mismatch = await readScopeRevisionAlignment(fakeClient({ scope_revisions: rows3 }), SQ29_JOB, current);
  assertEquals(mismatch.code, "frozen_text_hash_mismatch");
  const s3 = summariseScope(
    { id: SQ29_JOB, type: "patio", scope_json: current, pricing_json: lastSavePricing },
    { newestQuoteSentAt: null, signedOff: null, revisions: mismatch },
  );
  assertEquals(s3.scope_source, "last_save");
  assertEquals(s3.scope_record?.pricing_status, null);
  assertWholeDraft(s3);
});

Deno.test("SQ-29 frozen: a frozen text that does not hash to its scope_hash is not used", async () => {
  const frozen = patioRecord(2, "frz-2", "Roof sheet");
  const rows = await frozenRows(SQ29_JOB, frozen, patioRecord(1, "frz-1", "Old sheet"));
  rows[0].scope_canonical_text = JSON.stringify(patioRecord(2, "frz-2", "Tampered"));
  const lastSave = patioRecord(3, "frz-3", "Unfrozen sheet");
  const rev = await readScopeRevisionAlignment(fakeClient({ scope_revisions: rows }), SQ29_JOB, lastSave);
  assertEquals(rev.code, "frozen_text_hash_mismatch");
  const scope = summariseScope(
    { id: SQ29_JOB, type: "patio", scope_json: lastSave, pricing_json: null },
    { newestQuoteSentAt: null, signedOff: null, revisions: rev },
  );
  assertEquals(scope.scope_source, "last_save");
  assertEquals(scope.revision_read_code, "frozen_text_hash_mismatch");
  assertEquals(scope.lines, ["Unfrozen sheet (2 ea)"]);
});

Deno.test("SQ-29 frozen: no frozen row reads the last save; a failed read is not an empty history", async () => {
  const lastSave = patioRecord(1, "frz-1", "Roof sheet");
  const none = await readScopeRevisionAlignment(fakeClient({}), SQ29_JOB, lastSave);
  assertEquals(none.ok, true);
  assertEquals(none.frozen, null);
  const s1 = summariseScope(
    { id: SQ29_JOB, type: "patio", scope_json: lastSave, pricing_json: null },
    { newestQuoteSentAt: null, signedOff: null, revisions: none },
  );
  assertEquals(s1.scope_source, "last_save");
  assertEquals(s1.revision_history, []);
  assertEquals(s1.last_save_matches_frozen, null);

  const failed = await readScopeRevisionAlignment(
    fakeClient({}, { failing: new Set(["scope_revisions"]) }),
    SQ29_JOB,
    lastSave,
  );
  assertEquals(failed.ok, false);
  const s2 = summariseScope(
    { id: SQ29_JOB, type: "patio", scope_json: lastSave, pricing_json: null },
    { newestQuoteSentAt: null, signedOff: null, revisions: failed },
  );
  assertEquals(s2.revision_history, null);
  assertEquals(s2.revision_read_code, "scope_revisions_read_failed");
  assertEquals(s2.scope_source, "last_save");
});

Deno.test("SQ-29 frozen: history is capped at 50 and says there is more", async () => {
  const rows = Array.from({ length: 52 }, (_, i) => ({
    id: `srv-${i + 1}`, job_id: SQ29_JOB, revision_number: i + 1,
    status: i === 51 ? "frozen" : "superseded", scope_hash: "x",
  }));
  const rev = await readScopeRevisionAlignment(fakeClient({ scope_revisions: rows }), SQ29_JOB, {});
  assertEquals(rev.history.length, 50);
  assertEquals(rev.more, true);
  assertEquals(rev.frozen?.scope_revision_id, "srv-52");
});

Deno.test("SQ-29 frozen: the frozen row must be the job's own tool kind", async () => {
  const current = patioRecord(2, "frz-2", "Roof sheet");
  const rows = await frozenRows(SQ29_JOB, current, patioRecord(1, "frz-1", "Old sheet"));
  const asPatio = await readScopeRevisionAlignment(fakeClient({ scope_revisions: rows }), SQ29_JOB, current, "patio");
  assertEquals(asPatio.frozen?.scope_revision_id, "srv-2");
  const asFence = await readScopeRevisionAlignment(fakeClient({ scope_revisions: rows }), SQ29_JOB, current, "fencing");
  assertEquals(asFence.frozen, null);
  assertEquals(asFence.code, "frozen_tool_kind_mismatch");
  assertEquals(asFence.history.length, 2);
  const scope = summariseScope(
    { id: SQ29_JOB, type: "fencing", scope_json: current, pricing_json: null },
    { newestQuoteSentAt: null, signedOff: null, revisions: asFence },
  );
  assertEquals(scope.scope_source, "last_save");
  assertEquals(scope.revision_read_code, "frozen_tool_kind_mismatch");
});
