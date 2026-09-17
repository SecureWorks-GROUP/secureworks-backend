// deno-lint-ignore-file no-import-prefix no-explicit-any
// Repair as a first-class trade vertical (2026-09-17, Captain: "there's
// fencing, there's patio, and now there's repair. It's the same theory").
//
// A job is repair whenever jobs.type='repair' OR its family metadata says
// repair (metadata.ses_family / metadata.makesafe_job_family), independent of
// jobs.type — mirroring isInsuranceRepairFamily (insurance_repairs_board.ts),
// the boards' own rule. update_makesafe_job_family never retypes the row (the
// SWR- mint is a one-way supervised door, Captain ruling 2026-08-28), so a
// family-tagged make-safe/fencing job stays that type forever by design; every
// trade-facing vertical decision must still read it as repair.
//
// This suite pins: the pure classifiers (_jobVertical / _jobIsRepairFamily /
// _jobFamilyOf / _normalizeManagedVerticals / _resolveManagerVisibility), the
// Trade calendar's vertical filter + precedence, the office calendar's
// per-manager scoping, the trade job access tier, and trade_job_detail
// returning documents + repair identifiers through the NORMAL path for a
// type=makesafe/family=repair job (never only via the make-safe board).

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _CREW_READY_STATUSES,
  _jobFamilyOf,
  _jobIsRepairFamily,
  _jobVertical,
  _MANAGED_VERTICALS,
  _managerBoardVerticals,
  _normalizeManagedVerticals,
  _REPAIR_POOL_READY_STATUSES,
  _resolveManagerVisibility,
  _resolveWeeklyWorkOrderInvoice,
  _canSubmitWorkOrderInvoice,
  _scopeCalendarPayloadToVerticals,
  _tradeCompleteMyJobForTest,
  _tradeJobDetailForTest,
  myJobs,
  resolveTradeJobAccessTier,
  type TradeAuthContext,
  tradeCalendarEvents,
} from "./index.ts";
import {
  completionEvidenceApplies,
  completionEvidenceVertical,
  loadCompletionEvidenceByJob,
} from "./trade_completion_evidence.ts";

// ── _jobVertical / _jobIsRepairFamily / _jobFamilyOf ────────────────────────

Deno.test("jobVertical: type=repair is the repair vertical", () => {
  assertEquals(_jobVertical({ type: "repair" }), "repair");
  assertEquals(_jobIsRepairFamily({ type: "repair" }), true);
  assertEquals(_jobFamilyOf({ type: "repair" }), null); // no family metadata stamped, and type alone isn't a family tag
});

Deno.test("jobVertical: type=makesafe + metadata.ses_family=repair is repair, not makesafe", () => {
  const job = { type: "makesafe", metadata: { ses_family: "repair" } };
  assertEquals(_jobIsRepairFamily(job), true);
  assertEquals(_jobVertical(job), "repair");
  assertEquals(_jobFamilyOf(job), "repair");
});

Deno.test("jobVertical: type=makesafe + metadata.makesafe_job_family=repair is repair", () => {
  const job = { type: "makesafe", metadata: { makesafe_job_family: "repair" } };
  assertEquals(_jobIsRepairFamily(job), true);
  assertEquals(_jobVertical(job), "repair");
});

Deno.test("jobVertical: type=fencing + family=repair is repair, not fencing (SWF-261343 class)", () => {
  const job = { type: "fencing", metadata: { ses_family: "repair" } };
  assertEquals(_jobVertical(job), "repair");
});

Deno.test("jobVertical: plain make-safe with no family tag stays makesafe", () => {
  assertEquals(_jobVertical({ type: "makesafe" }), "makesafe");
  assertEquals(_jobVertical({ type: "makesafe", metadata: {} }), "makesafe");
  assertEquals(
    _jobVertical({ type: "general", job_number: "SWMS-26801" }),
    "makesafe",
  );
  assertEquals(
    _jobIsRepairFamily({ type: "makesafe", metadata: { ses_family: "roof" } }),
    false,
  );
});

Deno.test("jobVertical: plain jobs.type still wins for everything else", () => {
  assertEquals(_jobVertical({ type: "fencing" }), "fencing");
  assertEquals(_jobVertical({ type: "Patio" }), "patio");
  assertEquals(_jobVertical({ type: "decking" }), "decking");
});

Deno.test("jobVertical: a light calendar-row shape (job_family column) is honoured the same way", () => {
  // calendar_events projects job_family directly (COALESCE(ses_family,
  // makesafe_job_family)); no `.metadata` object is ever selected for it.
  assertEquals(
    _jobVertical({ type: "makesafe", job_family: "repair" }),
    "repair",
  );
  assertEquals(
    _jobVertical({ type: "makesafe", job_family: null }),
    "makesafe",
  );
});

Deno.test("jobVertical / jobIsRepairFamily: null / empty job is safe", () => {
  assertEquals(_jobVertical(null), "");
  assertEquals(_jobVertical({}), "");
  assertEquals(_jobIsRepairFamily(null), false);
  assertEquals(_jobIsRepairFamily({}), false);
  assertEquals(_jobFamilyOf(null), null);
});

// ── _normalizeManagedVerticals ───────────────────────────────────────────────

Deno.test("normalizeManagedVerticals: repair is now a valid managed vertical", () => {
  assert(_MANAGED_VERTICALS.includes("repair" as any));
  assertEquals(_normalizeManagedVerticals(["repair"]), ["repair"]);
  assertEquals(_normalizeManagedVerticals(["Repair", " repair "]), ["repair"]);
  assertEquals(
    _normalizeManagedVerticals(["fencing", "repair"]),
    ["fencing", "repair"],
  );
});

// ── _resolveManagerVisibility ────────────────────────────────────────────────

Deno.test("resolveManagerVisibility: manager of repair only", () => {
  const v = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["repair"],
  });
  assertEquals(v.isDispatcher, false);
  assertEquals(v.isMakesafeManager, false);
  assertEquals(v.canSeeMakesafePool, false);
  assertEquals(v.managedVerticals, ["repair"]);
  assertEquals(v.poolVerticals, ["repair"]);
});

Deno.test("resolveManagerVisibility: manager of makesafe AND repair gets both pools, canonical order", () => {
  const v = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["repair", "makesafe"],
  });
  // Canonical order is makesafe, fencing, patio, decking, repair.
  assertEquals(v.poolVerticals, ["makesafe", "repair"]);
});

Deno.test("resolveManagerVisibility: dispatcher does not implicitly gain the repair pool (matches fencing/patio/decking)", () => {
  const admin = _resolveManagerVisibility({
    role: "admin",
    managedVerticals: [],
  });
  assertEquals(admin.isDispatcher, true);
  assertEquals(admin.poolVerticals, ["makesafe"]);
});

// ── tradeCalendarVerticalFilter (imported indirectly via its effect below) ──
// tradeCalendarVerticalFilter itself is module-private; its shape is proven
// through the real tradeCalendarEvents query capture in trade_calendar_test.ts
// (existing suite) and through the precedence behaviour asserted below via
// _scopeCalendarPayloadToVerticals, which shares the same _jobVertical
// classifier and is the one place the office `calendar` action's per-manager
// scoping is decided.

// ── _scopeCalendarPayloadToVerticals: repair precedence ─────────────────────

const REPAIR_FAMILY_EVENT = {
  job_id: "job-261319",
  job_type: "makesafe",
  job_family: "repair",
};
const PLAIN_MAKESAFE_EVENT = {
  job_id: "job-plain-ms",
  job_type: "makesafe",
  job_family: null,
};
const FENCING_REPAIR_EVENT = {
  job_id: "job-261343",
  job_type: "fencing",
  job_family: "repair",
};

Deno.test("scopeCalendarPayloadToVerticals: a repair-family make-safe event is kept for a repair manager", () => {
  const out = _scopeCalendarPayloadToVerticals(
    { events: [REPAIR_FAMILY_EVENT, PLAIN_MAKESAFE_EVENT] },
    ["repair"],
  );
  assertEquals(out.events.map((e: any) => e.job_id), ["job-261319"]);
});

Deno.test("scopeCalendarPayloadToVerticals: the SAME event is dropped for a makesafe-only manager (repair wins precedence)", () => {
  const out = _scopeCalendarPayloadToVerticals(
    { events: [REPAIR_FAMILY_EVENT, PLAIN_MAKESAFE_EVENT] },
    ["makesafe"],
  );
  // The family-tagged row is excluded even though job_type says makesafe; the
  // plain make-safe (no family tag) still comes through.
  assertEquals(out.events.map((e: any) => e.job_id), ["job-plain-ms"]);
});

Deno.test("scopeCalendarPayloadToVerticals: a fencing job tagged family=repair is excluded from a fencing manager's view", () => {
  const out = _scopeCalendarPayloadToVerticals(
    { events: [FENCING_REPAIR_EVENT] },
    ["fencing"],
  );
  assertEquals(out.events, []);
});

Deno.test("scopeCalendarPayloadToVerticals: a manager of BOTH sees it once, under either scope", () => {
  const out = _scopeCalendarPayloadToVerticals(
    { events: [REPAIR_FAMILY_EVENT] },
    ["makesafe", "repair"],
  );
  assertEquals(out.events.length, 1);
});

// ── trade_job_detail + resolveTradeJobAccessTier: repair-family make-safe ──

type Tables = Record<string, any[]>;

function makeClient(tables: Tables) {
  function builder(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;
    let selectCols: string[] | null = null;
    const run = () => {
      let rows = (tables[table] || []).filter((r) => preds.every((p) => p(r)));
      if (limitN != null) rows = rows.slice(0, limitN);
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
        preds.push((r) => String(r?.[c] ?? "") === String(v));
        return api;
      },
      neq: (c: string, v: any) => {
        preds.push((r) => String(r?.[c] ?? "") !== String(v));
        return api;
      },
      in: (c: string, vals: any[]) => {
        preds.push((r) => vals.map(String).includes(String(r?.[c] ?? "")));
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
const JOB_REPAIR_FAMILY = "job-swms-261319";
const HUGO = "u-hugo"; // makesafe division manager
const RITA = "u-rita"; // repair division manager

function repairFamilySeed(): Tables {
  return {
    jobs: [
      {
        id: JOB_REPAIR_FAMILY,
        org_id: ORG_A,
        type: "makesafe",
        status: "processing",
        job_number: "SWMS-261319",
        client_name: "Simon Davey",
        site_address: "1 Duncraig Rd",
        site_suburb: "Duncraig",
        scope_json: {},
        pricing_json: {},
        metadata: {
          ses_family: "repair",
          makesafe_job_family: "repair",
          builder_work_order_number: "MLB-27649",
          builder_po_number: "PO-56789",
          builder_claim_ref: "MLB-27649",
        },
      },
    ],
    job_assignments: [],
    job_documents: [
      {
        id: "d-wo",
        job_id: JOB_REPAIR_FAMILY,
        type: "work_order",
        visible_to_trades: true,
        file_name: "wo.pdf",
      },
      {
        id: "d-general",
        job_id: JOB_REPAIR_FAMILY,
        type: "general",
        visible_to_trades: true,
        file_name: "photo-note.pdf",
      },
    ],
    job_media: [],
    job_events: [],
    job_service_reports: [],
    work_orders: [],
    purchase_orders: [],
    makesafe_job_details: [],
    makesafe_roof_report_drafts: [],
    trade_rates: [],
    users: [],
  };
}

Deno.test("access tier: a repair division manager gets division_manager + quote on a type=makesafe/family=repair job", async () => {
  const d = await resolveTradeJobAccessTier(
    makeClient(repairFamilySeed()),
    JOB_REPAIR_FAMILY,
    RITA,
    {
      access: { orgId: ORG_A, managedVerticals: ["repair"] },
    },
  );
  assertEquals(d.tier, "division_manager");
  assertEquals(d.reason, "vertical_manager");
  assertEquals(d.quoteVisible, true);
});

Deno.test("access tier: a make-safe-only division manager does NOT get division_manager on the same job (repair wins precedence)", async () => {
  const d = await resolveTradeJobAccessTier(
    makeClient(repairFamilySeed()),
    JOB_REPAIR_FAMILY,
    HUGO,
    {
      access: { orgId: ORG_A, managedVerticals: ["makesafe"] },
    },
  );
  // Falls through to the make-safe open-report door (any signed-in trade may
  // report on an open make-safe) rather than the full manager tier — the
  // point being it is NOT "division_manager" any more.
  assertEquals(d.tier, "makesafe_open");
  assertEquals(d.quoteVisible, false);
});

Deno.test("trade_job_detail: a type=makesafe/family=repair job returns documents AND repair identifiers through the normal path", async () => {
  const result: any = await _tradeJobDetailForTest(
    makeClient(repairFamilySeed()),
    new URLSearchParams({ jobId: JOB_REPAIR_FAMILY }),
    {
      id: RITA,
      email: "rita@example.test",
      orgId: ORG_A,
      role: "lead_installer",
      managedVerticals: ["repair"],
    } as any,
    false,
  );

  // Normal path: documents come through exactly as any other job's would.
  assertEquals(
    result.documents.map((d: any) => d.id).sort(),
    ["d-general", "d-wo"],
  );

  // Contract fields for the dashboard: job_family / vertical, present without
  // jobs.type ever being mutated.
  assertEquals(result.job.type, "makesafe");
  assertEquals(result.job_family, "repair");
  assertEquals(result.vertical, "repair");

  // Repair identifiers, sourced from the job's own metadata (never retyped).
  assert(result.repair, "repair identifiers block must be present");
  assertEquals(result.repair.builder_work_order_number, "MLB-27649");
  assertEquals(result.repair.builder_po_number, "PO-56789");
  assertEquals(result.repair.builder_claim_ref, "MLB-27649");
  assert(
    typeof result.repair.repair_stage === "string" &&
      result.repair.repair_stage.length > 0,
  );
});

Deno.test("trade_job_detail: an ordinary (non-repair-family) make-safe job carries no repair block", async () => {
  const tables = repairFamilySeed();
  tables.jobs[0].metadata = { builder_work_order_number: "MLB-1" };
  const result: any = await _tradeJobDetailForTest(
    makeClient(tables),
    new URLSearchParams({ jobId: JOB_REPAIR_FAMILY }),
    {
      id: HUGO,
      email: "hugo@example.test",
      orgId: ORG_A,
      role: "lead_installer",
      managedVerticals: ["makesafe"],
    } as any,
    false,
  );
  assertEquals(result.job_family, null);
  assertEquals(result.vertical, "makesafe");
  assertEquals(result.repair, null);
});

// ── Fencing completion evidence keys on jobs.type, never the trade vertical ──
// Captain ruling 2026-09-17: the completion-photos + neighbour-sign-off gate
// is a money/safety gate and must not relax because a fencing job's family
// metadata says repair (SWF-261343 class).

const SWF_261343 = {
  id: "job-swf-261343",
  org_id: ORG_A,
  type: "fencing",
  status: "processing",
  job_number: "SWF-261343",
  scope_json: { job: { neighbours: [{ firstName: "" }] } },
  metadata: { ses_family: "repair" },
};

Deno.test("completion evidence: a fencing job tagged family=repair still requires evidence (loadCompletionEvidenceByJob)", async () => {
  // The trade vertical says repair; the evidence gate must not follow it.
  assertEquals(_jobVertical(SWF_261343), "repair");
  assertEquals(completionEvidenceVertical(SWF_261343), "fencing");
  assertEquals(completionEvidenceVertical({ type: " Fencing " }), "fencing");
  assertEquals(completionEvidenceApplies(completionEvidenceVertical(SWF_261343)), true);

  const tables: string[] = [];
  const client = {
    from(table: string) {
      const q: any = {
        select: () => q,
        in: () => q,
        eq: () => q,
        then: (res: any) => {
          tables.push(table);
          return Promise.resolve({ data: [], error: null }).then(res);
        },
      };
      return q;
    },
  };
  const map = await loadCompletionEvidenceByJob(client, [{
    id: SWF_261343.id,
    vertical: completionEvidenceVertical(SWF_261343),
    scope_json: SWF_261343.scope_json,
  }]);
  const ev = map.get(SWF_261343.id)!;
  assertEquals(ev.applies, true);
  assertEquals(ev.satisfied, false);
  assertEquals(ev.missing, ["completion_photos", "neighbour_signoff"]);
  assert(tables.includes("job_media"), "evidence was actually read for the fencing job");
});

Deno.test("complete_my_job: a fencing job tagged family=repair is refused end to end until evidence is on file", async () => {
  const tables: Tables = {
    jobs: [{ ...SWF_261343 }],
    job_assignments: [
      { id: "a-lead", job_id: SWF_261343.id, user_id: "u-lead", status: "scheduled", is_ghost: false },
    ],
    job_media: [],
    job_events: [],
  };
  const lead = {
    id: "u-lead",
    email: "lead@example.test",
    orgId: ORG_A,
    role: "lead_installer",
    managedVerticals: [],
  } as any;
  const access = { orgId: ORG_A, managedVerticals: [] as string[] };
  await assertRejects(
    () => _tradeCompleteMyJobForTest(makeClient(tables), { jobId: SWF_261343.id }, lead, access),
    Error,
    "cannot be marked complete yet",
  );
  assertEquals(tables.jobs[0].status, "processing", "job status untouched by the refused completion");
});

// ── my_jobs open pools: repair pool statuses + make-safe pool exclusion ──────
// Mock adapted from m3b_ready_gate_pool_test.ts, extended so a PostgREST
// JSON-path column inside or() (`metadata->>ses_family.eq.repair`) resolves
// against the row's metadata object, and every query is recorded.

type PoolJob = { id: string; type: string; status: string; job_number?: string; metadata?: any };
type PoolAssignment = { id: string; user_id: string; status: string; scheduled_date: string; job_id: string };
type PoolDetail = { job_id: string; substatus?: string | null; report_received_at?: string | null; report_sent_at?: string | null; invoice_ready_at?: string | null };
type PoolFixtures = { assignments: PoolAssignment[]; jobs: PoolJob[]; details?: PoolDetail[] };
type PoolQuery = {
  table: string;
  eq: Record<string, unknown>;
  neq: Record<string, unknown>;
  gte: string | null;
  lt: string | null;
  refOr: { str: string; referencedTable: string | null } | null;
  notIn: string | null;
  inCol: string | null;
  inVals: unknown[] | null;
};

function poolCell(row: Record<string, any>, col: string): string {
  const m = col.match(/^(\w+)->>(\w+)$/);
  if (m) {
    const obj = row?.[m[1]];
    return String((obj && typeof obj === "object" ? obj[m[2]] : "") ?? "");
  }
  return String(row?.[col] ?? "");
}

function poolMatchOr(row: Record<string, any>, orStr: string): boolean {
  return orStr.split(",").some((cond) => {
    const [col, op, ...rest] = cond.split(".");
    const val = rest.join(".");
    const cell = poolCell(row, col);
    if (op === "eq") return cell === val;
    if (op === "ilike") return cell.toLowerCase().startsWith(val.replace(/%$/, "").toLowerCase());
    return false;
  });
}

function poolNotInSet(filterStr: string): Set<string> {
  const out = new Set<string>();
  for (const m of filterStr.matchAll(/"([^"]+)"/g)) out.add(m[1]);
  return out;
}

function resolvePoolQuery(fx: PoolFixtures, st: PoolQuery): { data: unknown[]; error: null } {
  if (st.table === "job_assignments") {
    let rows = fx.assignments.slice();
    if (st.eq.user_id != null) rows = rows.filter((a) => a.user_id === st.eq.user_id);
    if (st.neq.status != null) rows = rows.filter((a) => a.status !== st.neq.status);
    if (st.notIn) {
      const closed = poolNotInSet(st.notIn);
      rows = rows.filter((a) => !closed.has(a.status));
    }
    if (st.gte != null) rows = rows.filter((a) => a.scheduled_date >= st.gte!);
    if (st.lt != null) rows = rows.filter((a) => a.scheduled_date < st.lt!);
    let joined = rows
      .map((a) => ({ a, job: fx.jobs.find((j) => j.id === a.job_id) }))
      .filter((x) => x.job) as { a: PoolAssignment; job: PoolJob }[];
    if (st.refOr && st.refOr.referencedTable === "jobs") {
      joined = joined.filter((x) => poolMatchOr(x.job, st.refOr!.str));
    }
    if (st.inCol === "job_id" && st.inVals) {
      return {
        data: joined
          .filter((x) => st.inVals!.includes(x.a.job_id))
          .map(({ a }) => ({
            id: a.id, job_id: a.job_id, scheduled_date: a.scheduled_date,
            status: a.status, role: "lead", assignment_type: "install",
            crew_name: null, user: { id: a.user_id, name: a.user_id },
          })),
        error: null,
      };
    }
    return {
      data: joined.map(({ a, job }) => ({
        id: a.id, scheduled_date: a.scheduled_date, status: a.status,
        role: "lead", assignment_type: "install", crew_name: null, notes: null,
        jobs: { ...job },
      })),
      error: null,
    };
  }
  if (st.table === "jobs") {
    let rows = fx.jobs.slice();
    if (st.eq.type != null) rows = rows.filter((j) => j.type === st.eq.type);
    if (st.eq.status != null) rows = rows.filter((j) => j.status === st.eq.status);
    if (st.eq.id != null) rows = rows.filter((j) => j.id === st.eq.id);
    if (st.inCol === "status" && st.inVals) rows = rows.filter((j) => st.inVals!.includes(j.status));
    if (st.inCol === "id" && st.inVals) rows = rows.filter((j) => st.inVals!.includes(j.id));
    if (st.refOr && st.refOr.referencedTable == null) {
      rows = rows.filter((j) => poolMatchOr(j, st.refOr!.str));
    }
    if (st.notIn) {
      const ex = poolNotInSet(st.notIn);
      rows = rows.filter((j) => !ex.has(j.status));
    }
    return { data: rows.map((j) => ({ ...j })), error: null };
  }
  if (st.table === "makesafe_job_details") {
    let rows = (fx.details || []).slice();
    if (st.inCol === "job_id" && st.inVals) rows = rows.filter((d) => st.inVals!.includes(d.job_id));
    return { data: rows.map((d) => ({ ...d })), error: null };
  }
  return { data: [], error: null };
}

function makePoolClient(fx: PoolFixtures, recorded: PoolQuery[]) {
  function from(table: string) {
    const st: PoolQuery = {
      table, eq: {}, neq: {}, gte: null, lt: null, refOr: null,
      notIn: null, inCol: null, inVals: null,
    };
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => { st.eq[k] = v; return b; },
      neq: (k: string, v: unknown) => { st.neq[k] = v; return b; },
      gte: (k: string, v: string) => { if (k === "scheduled_date") st.gte = v; return b; },
      lt: (k: string, v: string) => { if (k === "scheduled_date") st.lt = v; return b; },
      in: (k: string, arr: unknown[]) => { st.inCol = k; st.inVals = arr; return b; },
      not: (k: string, op: string, v: string) => { if (k === "status" && op === "in") st.notIn = v; return b; },
      or: (s: string, opts?: { referencedTable?: string }) => {
        st.refOr = { str: s, referencedTable: opts?.referencedTable ?? null };
        return b;
      },
      ilike: () => b,
      order: () => b,
      limit: () => b,
      range: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: any) => { recorded.push(st); resolve(resolvePoolQuery(fx, st)); },
    };
    return b;
  }
  return { from };
}

function poolIds(g: any): string[] {
  return (g.makesafePool as any[]).map((a) => a.jobs?.id);
}

function repairPoolFixtures(): PoolFixtures {
  return {
    assignments: [],
    jobs: [
      // SWMS-261319 shape: repair-family make-safe, never retyped, at 'processing'.
      { id: "job-ms-repair", type: "makesafe", status: "processing", job_number: "SWMS-261319", metadata: { ses_family: "repair" } },
      // SWR- typed repair sits at 'accepted' after createMakesafeJob.
      { id: "job-swr", type: "repair", status: "accepted", job_number: "SWR-1", metadata: {} },
      // Ordinary make-safe, no family tag.
      { id: "job-ms-plain", type: "makesafe", status: "accepted", job_number: "SWMS-2", metadata: {} },
      // Fencing at a non-ready status: must stay out of the fencing pool.
      { id: "job-f-processing", type: "fencing", status: "processing", job_number: "SWF-1", metadata: {} },
      // Fencing at a ready status: pools for the fencing manager as before.
      { id: "job-f-ready", type: "fencing", status: "order_confirmed", job_number: "SWF-2", metadata: {} },
      // Patio at a non-ready status: unaffected.
      { id: "job-p-accepted", type: "patio", status: "accepted", job_number: "SWP-1", metadata: {} },
    ],
  };
}

async function poolFor(managed: string[], fx: PoolFixtures, recorded: PoolQuery[] = [], role = "lead_installer") {
  const vis = _resolveManagerVisibility({ role, managedVerticals: managed });
  const scope = _managerBoardVerticals({ isDispatcher: vis.isDispatcher, mode: "all", managedVerticals: managed });
  const g = await myJobs(
    makePoolClient(fx, recorded), "u-viewer",
    vis.isDispatcher, vis.isDispatcher, vis.isMakesafeManager, vis.poolVerticals, scope,
  );
  return poolIds(g);
}

Deno.test("repair pool: an unallocated repair-family make-safe at 'processing' surfaces for a repair division manager (SWMS-261319)", async () => {
  const recorded: PoolQuery[] = [];
  const pool = await poolFor(["repair"], repairPoolFixtures(), recorded);
  assert(pool.includes("job-ms-repair"), "repair-family make-safe at processing pools");
  assert(pool.includes("job-swr"), "SWR- typed repair at accepted pools");
  assertEquals(pool.includes("job-ms-plain"), false, "a plain make-safe is not repair work");
  assertEquals(pool.includes("job-f-processing"), false);
  assertEquals(pool.includes("job-p-accepted"), false);

  const repairQuery = recorded.find((q) => q.table === "jobs" && q.refOr?.str.includes("type.eq.repair"));
  assert(repairQuery, "repair pool query issued");
  assertEquals(repairQuery!.inCol, "status");
  assertEquals(repairQuery!.inVals, [..._REPAIR_POOL_READY_STATUSES]);
  for (const s of _CREW_READY_STATUSES) assert(_REPAIR_POOL_READY_STATUSES.includes(s));
  for (const s of ["accepted", "processing", "scheduled"]) assert(_REPAIR_POOL_READY_STATUSES.includes(s));
});

Deno.test("repair pool: the fencing / patio pools keep exactly _CREW_READY_STATUSES (non-ready statuses still excluded)", async () => {
  const recorded: PoolQuery[] = [];
  const pool = await poolFor(["fencing", "patio"], repairPoolFixtures(), recorded);
  assert(pool.includes("job-f-ready"), "order_confirmed fencing pools as before");
  assertEquals(pool.includes("job-f-processing"), false, "processing fencing does NOT pool");
  assertEquals(pool.includes("job-p-accepted"), false, "accepted patio does NOT pool");
  assertEquals(pool.includes("job-ms-repair"), false);
  assertEquals(pool.includes("job-swr"), false);
  for (const vertical of ["fencing", "patio"]) {
    const q = recorded.find((r) => r.table === "jobs" && r.eq.type === vertical);
    assert(q, `${vertical} pool query issued`);
    assertEquals(q!.inVals, [..._CREW_READY_STATUSES]);
  }
});

Deno.test("make-safe pool: a repair-family make-safe no longer appears in a make-safe-only manager's open pool", async () => {
  const fx: PoolFixtures = {
    assignments: [],
    jobs: [
      { id: "job-ms-plain", type: "makesafe", status: "accepted", job_number: "SWMS-2", metadata: {} },
      { id: "job-ms-repair", type: "makesafe", status: "accepted", job_number: "SWMS-261319", metadata: { ses_family: "repair" } },
      { id: "job-ms-repair-legacy-family", type: "makesafe", status: "processing", job_number: "SWMS-3", metadata: { makesafe_job_family: "repair" } },
    ],
  };
  const pool = await poolFor(["makesafe"], fx);
  assert(pool.includes("job-ms-plain"), "ordinary make-safe still pools");
  assertEquals(pool.includes("job-ms-repair"), false, "ses_family=repair is not in the make-safe pool");
  assertEquals(pool.includes("job-ms-repair-legacy-family"), false, "makesafe_job_family=repair is not in the make-safe pool");
});

Deno.test("make-safe pool: a manager of BOTH make-safe and repair sees the repair-family card once, via the repair pool", async () => {
  const fx: PoolFixtures = {
    assignments: [],
    jobs: [
      { id: "job-ms-plain", type: "makesafe", status: "accepted", job_number: "SWMS-2", metadata: {} },
      { id: "job-ms-repair", type: "makesafe", status: "processing", job_number: "SWMS-261319", metadata: { ses_family: "repair" } },
    ],
  };
  const pool = await poolFor(["makesafe", "repair"], fx);
  assertEquals(pool.filter((id) => id === "job-ms-repair").length, 1);
  assert(pool.includes("job-ms-plain"));
});

// ── trade_calendar pagination: page math on the raw lookahead, precedence
// narrowing on the page only ───────────────────────────────────────────────

function calendarPagingClient(rows: any[]) {
  function from(table: string) {
    if (table !== "calendar_events") throw new Error(`unexpected table ${table}`);
    const eq: Record<string, unknown> = {};
    const neq: Record<string, unknown> = {};
    const ors: string[] = [];
    let lte: string | null = null;
    let range: [number, number] | null = null;
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { eq[c] = v; return b; },
      neq: (c: string, v: unknown) => { neq[c] = v; return b; },
      lte: (_c: string, v: string) => { lte = v; return b; },
      or: (v: string) => { ors.push(v); return b; },
      order: () => b,
      range: (a: number, z: number) => { range = [a, z]; return b; },
      then: (resolve: (v: unknown) => void) => {
        let result = rows.slice();
        for (const [c, v] of Object.entries(eq)) result = result.filter((r) => r[c] === v);
        for (const [c, v] of Object.entries(neq)) result = result.filter((r) => r[c] !== v);
        if (lte) result = result.filter((r) => r.scheduled_date <= lte!);
        for (const clause of ors) {
          if (clause.startsWith("scheduled_end.gte.")) {
            const from = clause.match(/scheduled_end\.gte\.(\d{4}-\d{2}-\d{2})/)?.[1] || "";
            result = result.filter((r) =>
              (r.scheduled_end != null && r.scheduled_end >= from) ||
              (r.scheduled_end == null && r.scheduled_date >= from)
            );
            continue;
          }
          result = result.filter((r) => poolMatchOr(r, clause));
        }
        result.sort((a, b) =>
          String(a.scheduled_date).localeCompare(String(b.scheduled_date)) ||
          String(a.assignment_id).localeCompare(String(b.assignment_id))
        );
        if (range) result = result.slice(range[0], range[1] + 1);
        resolve({ data: result, error: null });
      },
    };
    return b;
  }
  return { from };
}

const CAL_HUGO: TradeAuthContext = {
  id: "hugo",
  email: "hugo@example.test",
  orgId: ORG_A,
  role: "lead_installer",
  managedVerticals: ["makesafe"],
};

function calRow(assignmentId: string, jobNumber: string, jobFamily: string | null) {
  return {
    assignment_id: assignmentId,
    job_id: `job-${assignmentId}`,
    user_id: "someone",
    job_number: jobNumber,
    job_type: "makesafe",
    job_family: jobFamily,
    org_id: ORG_A,
    assignment_status: "scheduled",
    scheduled_date: "2026-07-15",
    scheduled_end: null,
  };
}

Deno.test("trade calendar: a classifier-dropped boundary row does not break truncation / next_offset, and no row is duplicated across pages", async () => {
  // Three raw rows for a makesafe-scoped manager; the SECOND is the page
  // boundary row of a 2-row page and is repair-family, so precedence drops it.
  const rows = [
    calRow("a1", "SWMS-1", null),
    calRow("a2", "SWMS-261319", "repair"),
    calRow("a3", "SWMS-3", null),
  ];
  const client = calendarPagingClient(rows);
  const page1 = await tradeCalendarEvents(
    client,
    new URLSearchParams({ from: "2026-07-13", to: "2026-07-21", mode: "all", page_size: "2", offset: "0" }),
    CAL_HUGO,
    false,
  );
  assertEquals(page1.events.map((e: any) => e.assignment_id), ["a1"], "the dropped boundary row shortens the page; a3 must NOT leak onto page 1");
  assertEquals(page1.truncated, true, "the raw lookahead saw a third row");
  assertEquals(page1.next_offset, 2);

  const page2 = await tradeCalendarEvents(
    client,
    new URLSearchParams({ from: "2026-07-13", to: "2026-07-21", mode: "all", page_size: "2", offset: String(page1.next_offset) }),
    CAL_HUGO,
    false,
  );
  assertEquals(page2.events.map((e: any) => e.assignment_id), ["a3"]);
  assertEquals(page2.truncated, false);
  assertEquals(page2.next_offset, null);

  const seen = [...page1.events, ...page2.events].map((e: any) => e.assignment_id);
  assertEquals(new Set(seen).size, seen.length, "no row emitted twice across pages");
  assertEquals(seen.includes("a2"), false, "the repair-family row never reaches a makesafe-only view");
});

Deno.test("trade calendar: the same rows are all returned, once, for a repair+makesafe manager", async () => {
  const rows = [
    calRow("a1", "SWMS-1", null),
    calRow("a2", "SWMS-261319", "repair"),
    calRow("a3", "SWMS-3", null),
  ];
  const viewer: TradeAuthContext = { ...CAL_HUGO, managedVerticals: ["makesafe", "repair"] };
  const client = calendarPagingClient(rows);
  const p1 = await tradeCalendarEvents(client, new URLSearchParams({ from: "2026-07-13", to: "2026-07-21", mode: "all", page_size: "2" }), viewer, false);
  const p2 = await tradeCalendarEvents(client, new URLSearchParams({ from: "2026-07-13", to: "2026-07-21", mode: "all", page_size: "2", offset: String(p1.next_offset) }), viewer, false);
  assertEquals(p1.events.map((e: any) => e.assignment_id), ["a1", "a2"]);
  assertEquals(p2.events.map((e: any) => e.assignment_id), ["a3"]);
  assertEquals(p2.truncated, false);
});

Deno.test("make-safe pool: a dispatcher still sees an unallocated repair-family make-safe; a make-safe-only manager does not", async () => {
  const fx = (): PoolFixtures => ({
    assignments: [],
    jobs: [
      { id: "job-ms-repair", type: "makesafe", status: "processing", job_number: "SWMS-261319", metadata: { ses_family: "repair" } },
      { id: "job-ms-plain", type: "makesafe", status: "accepted", job_number: "SWMS-2", metadata: {} },
    ],
    details: [
      { job_id: "job-ms-repair", substatus: "pending_allocation" },
      { job_id: "job-ms-plain", substatus: "pending_allocation" },
    ],
  });
  const dispatcherVis = _resolveManagerVisibility({ role: "ops_manager", managedVerticals: [] });
  assertEquals(dispatcherVis.isDispatcher, true);
  assertEquals(dispatcherVis.poolVerticals.includes("repair"), false, "a pure dispatcher gains no repair pool");
  const dispatcherPool = await poolFor([], fx(), [], "ops_manager");
  assert(dispatcherPool.includes("job-ms-repair"), "Hugo-class dispatcher keeps SWMS-261319 in the make-safe pool");
  assert(dispatcherPool.includes("job-ms-plain"));

  const managerPool = await poolFor(["makesafe"], fx());
  assertEquals(managerPool.includes("job-ms-repair"), false, "a make-safe-only manager cannot action it, so it is not offered");
  assert(managerPool.includes("job-ms-plain"));
});

Deno.test("repair pool: a freshly minted repair job still at company_contact_required is not offered", async () => {
  const fx: PoolFixtures = {
    assignments: [],
    jobs: [
      { id: "job-swr-new", type: "repair", status: "accepted", job_number: "SWR-9", metadata: {} },
      { id: "job-ms-repair-new", type: "makesafe", status: "accepted", job_number: "SWMS-9", metadata: { ses_family: "repair" } },
      { id: "job-ms-repair-reported", type: "makesafe", status: "processing", job_number: "SWMS-10", metadata: { ses_family: "repair" } },
      { id: "job-repair-legacy", type: "repair", status: "accepted", job_number: "SWR-1", metadata: {} },
    ],
    details: [
      { job_id: "job-swr-new", substatus: "company_contact_required" },
      { job_id: "job-ms-repair-new", substatus: "company_contact_required" },
      { job_id: "job-ms-repair-reported", substatus: "processing", report_received_at: "2026-09-10T00:00:00Z" },
    ],
  };
  const recorded: PoolQuery[] = [];
  const pool = await poolFor(["repair"], fx, recorded);
  assertEquals(pool.includes("job-swr-new"), false, "ops's admin queue is not open work");
  assertEquals(pool.includes("job-ms-repair-new"), false);
  assertEquals(pool.includes("job-ms-repair-reported"), false, "report already in is not open work");
  assert(pool.includes("job-repair-legacy"), "no detail row -> allocatable on status alone");
  const detailRead = recorded.find((q) => q.table === "makesafe_job_details" && q.inCol === "job_id");
  assert(detailRead, "repair candidates are screened through makesafe_job_details");
});

Deno.test("repair pool: the same job is offered once its substatus clears company_contact_required", async () => {
  const fx: PoolFixtures = {
    assignments: [],
    jobs: [
      { id: "job-swr-new", type: "repair", status: "accepted", job_number: "SWR-9", metadata: {} },
      { id: "job-ms-repair-new", type: "makesafe", status: "processing", job_number: "SWMS-9", metadata: { ses_family: "repair" } },
    ],
    details: [
      { job_id: "job-swr-new", substatus: "pending_allocation" },
      { job_id: "job-ms-repair-new", substatus: "processing" },
    ],
  };
  const pool = await poolFor(["repair"], fx);
  assert(pool.includes("job-swr-new"));
  assert(pool.includes("job-ms-repair-new"));
});

// ── Work-order invoice authorization: weekly lane agrees with the single door ──

const WO_JOB_ID = "00000000-0000-0000-0000-000000000260";
const WO_ID = "00000000-0000-0000-0000-000000000160";

function repairFamilyWorkOrder() {
  return {
    id: WO_ID,
    org_id: ORG_A,
    job_id: WO_JOB_ID,
    wo_number: "WO-160",
    status: "complete",
    completed_at: "2026-08-26T09:30:00Z",
    scheduled_date: "2026-08-26",
    assigned_user_id: null,
    site_address: "1 Duncraig Rd",
    scope_items: [{ description: "Fence panel repair", quantity: 2, unit: "ea", unit_price: 120 }],
    jobs: {
      id: WO_JOB_ID,
      org_id: ORG_A,
      job_number: "SWMS-261319",
      client_name: "Simon Davey",
      type: "makesafe",
      status: "complete",
      site_address: "1 Duncraig Rd",
      site_suburb: "Duncraig",
      metadata: { ses_family: "repair" },
    },
  };
}

function projectEmbeddedJobs(row: any, select: string) {
  const m = select.match(/jobs!inner\(([^)]*)\)/);
  if (!m) return row;
  const cols = m[1].split(",").map((c) => c.trim()).filter(Boolean);
  const jobs: any = {};
  for (const c of cols) if (c in (row.jobs || {})) jobs[c] = row.jobs[c];
  return { ...row, jobs };
}

function weeklyLaneClient(workOrders: any[]): any {
  return {
    from(table: string) {
      let selected = "";
      const b: any = {
        select(columns: string) { selected = columns; return b; },
        eq: () => b,
        in: () => b,
        lte: () => b,
        or: () => b,
        order: () => b,
        then(resolve: (v: unknown) => void) {
          const data = table === "work_orders"
            ? workOrders.map((wo) => projectEmbeddedJobs(wo, selected))
            : [];
          resolve({ data, error: null });
        },
      };
      return b;
    },
  };
}

const RITA_CTX: TradeAuthContext = { id: RITA, email: "rita@example.test", orgId: ORG_A, role: "lead_installer", managedVerticals: ["repair"] };
const HUGO_CTX: TradeAuthContext = { id: HUGO, email: "hugo@example.test", orgId: ORG_A, role: "lead_installer", managedVerticals: ["makesafe"] };

Deno.test("work-order invoice authz: the weekly lane and the single door agree on a repair-family job", async () => {
  const wo = repairFamilyWorkOrder();
  const body = { work_order_blocks: [{ work_order_id: WO_ID }] };

  // Single door (submit_work_order_invoice selects metadata on the embed).
  assertEquals(_canSubmitWorkOrderInvoice(RITA_CTX, wo, false), true);
  assertEquals(_canSubmitWorkOrderInvoice(HUGO_CTX, wo, false), false);

  // Weekly lane, driven end to end through its own select projection.
  const forRita = await _resolveWeeklyWorkOrderInvoice(
    weeklyLaneClient([repairFamilyWorkOrder()]), RITA_CTX, false, "2026-08-24", "2026-08-30", body,
  );
  assertEquals(forRita.job_blocks.length, 1, "repair division manager is authorised on the weekly lane too");
  assertEquals(forRita.job_blocks[0].source_work_order_id, WO_ID);

  await assertRejects(
    () => _resolveWeeklyWorkOrderInvoice(
      weeklyLaneClient([repairFamilyWorkOrder()]), HUGO_CTX, false, "2026-08-24", "2026-08-30", body,
    ),
    Error,
    "outside your assigned or managed work",
  );
});
