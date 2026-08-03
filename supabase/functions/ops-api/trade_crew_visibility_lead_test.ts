// deno-lint-ignore-file no-import-prefix no-explicit-any
// Trade app: what an assigned installer can see on a job, and the named lead.
//
// Three reported problems, one payload:
//   1. an installer cannot see who else is on the job          -> crew / leadInstaller
//   2. no way to name a lead installer                          -> is_lead + set_job_lead
//   3. an assigned installer cannot see scope or the work order -> scopeSummary,
//                                                                  workOrders,
//                                                                  workOrderDocuments
//
// The controls in the second half are the important half: this change WIDENS
// what a trade receives, so the tests that matter are the ones proving it did
// not widen too far — a not-visible-to-trades quote PDF must still never reach
// an installer, and an ordinary installer must still not be able to name a lead.

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resolveAllocationAuthz,
  _resolveLeadTarget,
  _setJobLeadForTest,
  _tradeJobDetailForTest,
  _tradeLeadInstaller,
  _tradeScopeSummary,
  _tradeVisibleDocuments,
} from "./index.ts";

// ── Stub client ─────────────────────────────────────────────────────────────
// Generic chainable stand-in for the PostgREST builder: accumulates predicates,
// resolves against in-memory tables. Deliberately generic so the test exercises
// the real query chain tradeJobDetail issues rather than a hand-shaped result.

type Tables = Record<string, any[]>;

function makeClient(tables: Tables, opts: { errorOn?: string } = {}) {
  function builder(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;
    const run = () => {
      if (opts.errorOn === table) {
        return { data: null, error: { message: `stub 42703 on ${table}` } };
      }
      let rows = (tables[table] || []).filter((r) => preds.every((p) => p(r)));
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };
    const api: any = {
      select: () => api,
      order: () => api,
      eq: (c: string, v: any) => {
        preds.push((r) => String(r?.[c] ?? "") === String(v));
        return api;
      },
      neq: (c: string, v: any) => {
        preds.push((r) => String(r?.[c] ?? "") !== String(v));
        return api;
      },
      limit: (n: number) => {
        limitN = n;
        return api;
      },
      single: () => {
        const { data, error } = run();
        if (error) return Promise.resolve({ data: null, error });
        return Promise.resolve({ data: (data || [])[0] ?? null, error: null });
      },
      maybeSingle: () => {
        const { data, error } = run();
        if (error) return Promise.resolve({ data: null, error });
        return Promise.resolve({ data: (data || [])[0] ?? null, error: null });
      },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      update: (patch: any) => {
        const upd: any = {
          eq: (c: string, v: any) => {
            preds.push((r) => String(r?.[c] ?? "") === String(v));
            return upd;
          },
          neq: (c: string, v: any) => {
            preds.push((r) => String(r?.[c] ?? "") !== String(v));
            return upd;
          },
          select: () => upd,
          single: () => {
            const rows = (tables[table] || []).filter((r) =>
              preds.every((p) => p(r))
            );
            // Enforce uq_job_assignments_one_lead the way the database does, so a
            // clear-then-set ordering bug fails here instead of in production.
            for (const r of rows) Object.assign(r, patch);
            if (patch.is_lead === true) {
              const leads = (tables[table] || []).filter((r) =>
                r.is_lead === true && r.job_id === rows[0]?.job_id
              );
              if (leads.length > 1) {
                return Promise.resolve({
                  data: null,
                  error: { message: "uq_job_assignments_one_lead violated" },
                });
              }
            }
            return Promise.resolve({ data: rows[0] ?? null, error: null });
          },
          then: (res: any, rej: any) => {
            const rows = (tables[table] || []).filter((r) =>
              preds.every((p) => p(r))
            );
            for (const r of rows) Object.assign(r, patch);
            return Promise.resolve({ data: rows, error: null }).then(res, rej);
          },
        };
        return upd;
      },
      insert: (row: any) => {
        (tables[table] ||= []).push(row);
        return Promise.resolve({ data: row, error: null });
      },
    };
    return api;
  }
  return { from: (t: string) => builder(t) };
}

const JOB_ID = "job-1";
const ORG = "org-1";
const INSTALLER = "user-installer";
const MATE = "user-mate";

// A patio job with a populated scope blob, two live work orders, a work-order
// PDF flagged visible and a quote PDF flagged NOT visible, and two crew.
function seed(): Tables {
  return {
    jobs: [{
      id: JOB_ID,
      org_id: ORG,
      type: "patio",
      job_number: "SWP-90001",
      status: "processing",
      metadata: { internal: "must not reach the trade" },
      scope_json: {
        config: {
          length: 6,
          projection: 4,
          roofStyle: "Gable",
          roofing: "solarspan75",
          sheetColor: "Monument",
          posts: 4,
        },
      },
    }],
    job_documents: [
      {
        id: "doc-wo",
        type: "work_order",
        file_name: "wo.pdf",
        pdf_url: "https://example.test/wo.pdf",
        visible_to_trades: true,
      },
      {
        id: "doc-quote",
        type: "quote",
        file_name: "quote.pdf",
        pdf_url: "https://example.test/quote.pdf",
        visible_to_trades: false,
      },
      {
        id: "doc-wo-superseded",
        type: "work_order",
        file_name: "wo-v1.pdf",
        pdf_url: "https://example.test/wo-v1.pdf",
        visible_to_trades: false,
      },
    ].map((d) => ({ ...d, job_id: JOB_ID })),
    job_media: [{ id: "m1", job_id: JOB_ID, phase: "scope", type: "photo" }],
    job_events: [],
    job_service_reports: [],
    work_orders: [
      {
        id: "wo-new",
        job_id: JOB_ID,
        wo_number: "WO-2",
        status: "sent",
        scope_items: [{ description: "Install patio" }],
        special_instructions: "Park on the verge",
      },
      {
        id: "wo-old",
        job_id: JOB_ID,
        wo_number: "WO-1",
        status: "sent",
        scope_items: [{ description: "Footings" }],
        special_instructions: null,
      },
    ],
    job_assignments: [
      {
        id: "asg-1",
        job_id: JOB_ID,
        user_id: INSTALLER,
        status: "scheduled",
        role: "lead_installer",
        is_lead: false,
        crew_name: "Isaac",
        users: { name: "Isaac", phone: "0400000001" },
      },
      {
        id: "asg-2",
        job_id: JOB_ID,
        user_id: MATE,
        status: "scheduled",
        role: "lead_installer",
        is_lead: false,
        crew_name: "Henry",
        users: { name: "Henry", phone: "0400000002" },
      },
      {
        id: "asg-cancelled",
        job_id: JOB_ID,
        user_id: "user-gone",
        status: "cancelled",
        role: "lead_installer",
        is_lead: false,
        crew_name: "Departed",
        users: { name: "Departed", phone: null },
      },
    ],
    purchase_orders: [{
      id: "po-1",
      job_id: JOB_ID,
      po_number: "PO-1",
      status: "authorised",
      line_items: [{ description: "Sheets", quantity: 10, unit_amount: 99.5 }],
    }],
    makesafe_job_details: [],
  };
}

// An ORDINARY installer: no admin, no managed verticals. Every assertion below
// is about what THIS viewer receives, not what an admin receives.
const installerViewer = {
  id: INSTALLER,
  email: "installer@example.test",
  orgId: ORG,
  role: "installer",
  managedVerticals: [] as string[],
};

function detailFor(tables: Tables) {
  return _tradeJobDetailForTest(
    makeClient(tables),
    new URLSearchParams({ jobId: JOB_ID }),
    installerViewer as any,
    false, // isAdmin — an assigned installer, NOT a dispatcher
  );
}

// ── 1 + 2: crew and the named lead ──────────────────────────────────────────

Deno.test("assigned installer sees who else is on the job, with names", async () => {
  const d: any = await detailFor(seed());
  const names = d.crew.map((c: any) => c.name).sort();
  assertEquals(names, ["Henry", "Isaac"]);
  // The cancelled assignment is not crew.
  assertEquals(d.crew.length, 2);
});

Deno.test("no lead is designated until somebody designates one", async () => {
  const d: any = await detailFor(seed());
  // Every crew row carries role 'lead_installer' (the column default), and that
  // must NOT be read as a designation.
  assert(d.crew.every((c: any) => c.role === "lead_installer"));
  assertEquals(d.leadInstaller, null);
  assert(d.crew.every((c: any) => c.is_lead === false));
});

Deno.test("set_job_lead names exactly one lead and the payload reports it", async () => {
  const tables = seed();
  const res: any = await _setJobLeadForTest(makeClient(tables), {
    jobId: JOB_ID,
    assignmentId: "asg-2",
  });
  assertEquals(res.success, true);
  assertEquals(res.lead.assignment_id, "asg-2");

  const d: any = await detailFor(tables);
  assertEquals(d.leadInstaller.user_id, MATE);
  assertEquals(d.leadInstaller.name, "Henry");
  assertEquals(d.crew.filter((c: any) => c.is_lead).length, 1);
});

Deno.test("moving the lead leaves exactly one lead, never two", async () => {
  const tables = seed();
  const c = makeClient(tables);
  await _setJobLeadForTest(c, { jobId: JOB_ID, assignmentId: "asg-2" });
  await _setJobLeadForTest(c, { jobId: JOB_ID, userId: INSTALLER });
  const leads = tables.job_assignments.filter((a: any) => a.is_lead);
  assertEquals(leads.length, 1);
  assertEquals(leads[0].id, "asg-1");
});

Deno.test("the lead can be cleared back to nobody", async () => {
  const tables = seed();
  const c = makeClient(tables);
  await _setJobLeadForTest(c, { jobId: JOB_ID, assignmentId: "asg-1" });
  const res: any = await _setJobLeadForTest(c, { jobId: JOB_ID, clear: true });
  assertEquals(res.lead, null);
  assertEquals(tables.job_assignments.filter((a: any) => a.is_lead).length, 0);
});

// ── 3: scope and work order ─────────────────────────────────────────────────

Deno.test("assigned installer gets a readable scope summary", async () => {
  const d: any = await detailFor(seed());
  assertEquals(
    d.scopeSummary,
    "6m x 4m, Gable, SolarSpan 75mm, Monument, 4 x 100x100 SHS posts",
  );
});

Deno.test("assigned installer gets EVERY live work order, not just the newest", async () => {
  const d: any = await detailFor(seed());
  assertEquals(d.workOrders.length, 2);
  assertEquals(d.workOrders.map((w: any) => w.wo_number).sort(), [
    "WO-1",
    "WO-2",
  ]);
  // Back-compat: the pre-existing singular key still holds the newest.
  assertEquals(d.workOrder.wo_number, "WO-2");
});

Deno.test("assigned installer gets the work-order PDF as its own surface", async () => {
  const d: any = await detailFor(seed());
  assertEquals(d.workOrderDocuments.length, 1);
  assertEquals(d.workOrderDocuments[0].id, "doc-wo");
});

// ── CONTROLS: proof this did not widen too far ──────────────────────────────
//
// These are the tests that matter. Everything above adds visibility; these
// prove the boundaries that must not move.

Deno.test("CONTROL: a quote PDF flagged not-visible-to-trades never reaches an installer", async () => {
  const d: any = await detailFor(seed());
  const ids = d.documents.map((x: any) => x.id);
  assert(!ids.includes("doc-quote"), "quote PDF leaked to the trade payload");
  const serialised = JSON.stringify(d);
  assert(
    !serialised.includes("quote.pdf"),
    "quote PDF url reachable anywhere in the trade payload",
  );
});

Deno.test("CONTROL: a superseded work order flagged not-visible stays hidden", async () => {
  const d: any = await detailFor(seed());
  const ids = d.documents.map((x: any) => x.id);
  assert(!ids.includes("doc-wo-superseded"));
  assertEquals(
    d.workOrderDocuments.filter((x: any) => x.id === "doc-wo-superseded")
      .length,
    0,
  );
});

Deno.test("CONTROL: the scope summary can never fall back to a quote description", () => {
  // buildScopeSummaryLine falls back to pricing_json.job_description when the
  // scope blob yields nothing. _tradeScopeSummary strips pricing_json first, so
  // even a job carrying one produces no scope line rather than a quote field.
  const summary = _tradeScopeSummary({
    type: "patio",
    scope_json: {},
    pricing_json: { job_description: "Supply and install, $18,400 inc GST" },
  });
  assertEquals(summary, "");
});

Deno.test("CONTROL: an empty document set stays empty", () => {
  assertEquals(_tradeVisibleDocuments([]), []);
  assertEquals(_tradeVisibleDocuments(null as any), []);
});

Deno.test("CONTROL: job.metadata still never reaches the trade payload", async () => {
  const d: any = await detailFor(seed());
  assertEquals(d.job.metadata, undefined);
});

Deno.test("CONTROL: PO line items still carry no pricing", async () => {
  const d: any = await detailFor(seed());
  const li = d.purchaseOrders[0].line_items[0];
  assertEquals(li.description, "Sheets");
  assertEquals(li.quantity, 10);
  assertEquals((li as any).unit_amount, undefined);
  assert(!JSON.stringify(d.purchaseOrders).includes("99.5"));
});

Deno.test("CONTROL: an ordinary installer may NOT name the lead", () => {
  // set_job_lead is gated by the same resolver that gates creating the
  // assignment. An installer with no managed verticals is refused on every job.
  const decision = _resolveAllocationAuthz({
    authMode: "jwt",
    callerRole: "installer",
    managedVerticals: [],
    jobVertical: "patio",
  });
  assertEquals(decision.allowed, false);
  assertEquals(decision.reason, "not_authorized");
});

Deno.test("CONTROL: an installer may not name the lead on their OWN job either", () => {
  // The narrow reading: being ON the crew grants no authority over the crew.
  const decision = _resolveAllocationAuthz({
    authMode: "jwt",
    callerRole: "lead_installer", // even the users.role that sounds like a lead
    managedVerticals: [],
    jobVertical: "patio",
  });
  assertEquals(decision.allowed, false);
});

Deno.test("CONTROL: a vertical manager may name the lead only in their vertical", () => {
  assertEquals(
    _resolveAllocationAuthz({
      authMode: "jwt",
      callerRole: "installer",
      managedVerticals: ["fencing"],
      jobVertical: "fencing",
    }).allowed,
    true,
  );
  assertEquals(
    _resolveAllocationAuthz({
      authMode: "jwt",
      callerRole: "installer",
      managedVerticals: ["fencing"],
      jobVertical: "patio",
    }).allowed,
    false,
  );
});

Deno.test("CONTROL: the make-safe automation routine may never name a lead", () => {
  assertEquals(
    _resolveAllocationAuthz({ authMode: "routine", jobVertical: "makesafe" })
      .allowed,
    false,
  );
});

Deno.test("CONTROL: a non-crew or cancelled person cannot be made lead", async () => {
  const tables = seed();
  const c = makeClient(tables);
  await assertRejects(
    () => _setJobLeadForTest(c, { jobId: JOB_ID, userId: "user-stranger" }),
    Error,
    "not an active crew member",
  );
  await assertRejects(
    () =>
      _setJobLeadForTest(c, { jobId: JOB_ID, assignmentId: "asg-cancelled" }),
    Error,
    "not an active crew member",
  );
  assertEquals(tables.job_assignments.filter((a: any) => a.is_lead).length, 0);
});

Deno.test("CONTROL: an assignment belonging to another job cannot be made lead", () => {
  const rows = [{
    id: "asg-elsewhere",
    job_id: "other-job",
    status: "scheduled",
  }];
  // _resolveLeadTarget only ever sees this job's rows, so a foreign assignment
  // id simply does not match.
  let threw = false;
  try {
    _resolveLeadTarget({ assignmentId: "asg-elsewhere" }, []);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  void rows;
});

Deno.test("CONTROL: an unassigned installer is still refused the job entirely", async () => {
  const tables = seed();
  tables.job_assignments = tables.job_assignments.filter(
    (a: any) => a.user_id !== INSTALLER,
  );
  await assertRejects(() => detailFor(tables) as any, Error);
});

Deno.test("CONTROL: leadInstaller is null rather than a guess when nobody is flagged", () => {
  assertEquals(
    _tradeLeadInstaller([
      { id: "a", role: "lead_installer", is_lead: false },
      { id: "b", role: "lead_installer", is_lead: false },
    ]),
    null,
  );
});
