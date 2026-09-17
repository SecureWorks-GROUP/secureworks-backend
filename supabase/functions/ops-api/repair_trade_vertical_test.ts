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
  _jobFamilyOf,
  _jobIsRepairFamily,
  _jobVertical,
  _MANAGED_VERTICALS,
  _normalizeManagedVerticals,
  _resolveManagerVisibility,
  _scopeCalendarPayloadToVerticals,
  _tradeJobDetailForTest,
  resolveTradeJobAccessTier,
} from "./index.ts";

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
