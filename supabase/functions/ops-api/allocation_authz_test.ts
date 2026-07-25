import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resolveAllocationAuthz,
  allocateJob,
  assertAssignmentMutationAuthz,
} from "./index.ts";

// ── Minimal chainable Supabase mock ────────────────────────────────────────
// Records from() calls + inserts + updates; resolves reads from an in-memory
// store keyed by table + eq('id'/'...') filters. The builder is both chainable
// and awaitable (thenable) so `.limit(1)` (array) and `.maybeSingle()`/`.single()`
// (single row) both work.
type Store = {
  jobs?: Record<string, any>;
  users?: Record<string, any>;
  assignments?: Record<string, any>; // by id
  dup?: any[]; // rows returned by the job+user+date idempotency query
  calls?: string[];
  inserts?: Array<{ table: string; row: any }>;
  updates?: Array<{ table: string; row: any }>;
};

function makeClient(store: Store) {
  store.calls = store.calls || [];
  store.inserts = store.inserts || [];
  store.updates = store.updates || [];
  function builder(table: string) {
    const filters: Record<string, any> = {};
    let op: "select" | "insert" | "update" | "delete" = "select";
    let insertRow: any = null;
    let updateRow: any = null;
    const resolveSingle = () => {
      if (op === "insert") return { id: "new-assignment", ...insertRow };
      if (op === "update") {
        return { id: filters.id, job_id: store.assignments?.[filters.id]?.job_id, ...updateRow };
      }
      if (table === "jobs") return store.jobs?.[filters.id] ?? null;
      if (table === "users") return store.users?.[filters.id] ?? null;
      if (table === "job_assignments") return store.assignments?.[filters.id] ?? null;
      return null;
    };
    const resolveArray = () => {
      if (table === "job_assignments") return store.dup ?? [];
      return [];
    };
    const b: any = {
      select: () => b,
      insert: (row: any) => { op = "insert"; insertRow = row; store.inserts!.push({ table, row }); return b; },
      update: (row: any) => { op = "update"; updateRow = row; store.updates!.push({ table, row }); return b; },
      delete: () => { op = "delete"; return b; },
      eq: (k: string, v: any) => { filters[k] = v; return b; },
      neq: () => b,
      not: () => b,
      in: () => b,
      or: () => b,
      gte: () => b,
      lt: () => b,
      ilike: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: resolveSingle(), error: null }),
      single: () => Promise.resolve({ data: resolveSingle(), error: null }),
      then: (resolve: any) => resolve({ data: resolveArray(), error: null }),
    };
    return b;
  }
  return {
    from(table: string) { store.calls!.push(table); return builder(table); },
  };
}

const FENCING_JOB = { id: "job-fen", type: "fencing", job_number: "SWF-1", status: "accepted" };
const ARCHIVED_JOB = { id: "job-arch", type: "fencing", job_number: "SWF-2", status: "archived" };

// ── _resolveAllocationAuthz matrix ─────────────────────────────────────────
Deno.test("authz: api_key (dashboard/service) may allocate anything", () => {
  const d = _resolveAllocationAuthz({ authMode: "api_key" });
  assertEquals(d, { allowed: true, reason: "api_key" });
});

Deno.test("authz: routine may NEVER mutate assignments", () => {
  const d = _resolveAllocationAuthz({ authMode: "routine", jobVertical: "makesafe" });
  assertEquals(d, { allowed: false, reason: "routine_forbidden" });
});

Deno.test("authz: dispatcher roles (admin/owner/ops_manager) allocate any vertical", () => {
  for (const role of ["admin", "owner", "ops_manager"]) {
    const d = _resolveAllocationAuthz({ authMode: "jwt", callerRole: role, jobVertical: "fencing" });
    assertEquals(d, { allowed: true, reason: "dispatcher" }, `role ${role}`);
  }
});

Deno.test("authz: vertical manager — right vertical allowed, wrong vertical denied", () => {
  const right = _resolveAllocationAuthz({
    authMode: "jwt", callerRole: "lead_installer", managedVerticals: ["fencing"], jobVertical: "fencing",
  });
  assertEquals(right, { allowed: true, reason: "vertical_manager" });

  const wrong = _resolveAllocationAuthz({
    authMode: "jwt", callerRole: "sales", managedVerticals: ["patio"], jobVertical: "fencing",
  });
  assertEquals(wrong, { allowed: false, reason: "not_authorized" });
});

Deno.test("authz: plain installer (no managed verticals) is denied", () => {
  const d = _resolveAllocationAuthz({
    authMode: "jwt", callerRole: "lead_installer", managedVerticals: [], jobVertical: "fencing",
  });
  assertEquals(d, { allowed: false, reason: "not_authorized" });
});

// ── assertAssignmentMutationAuthz gate (create/update/delete_assignment) ────
Deno.test("gate: api_key ops path passes with ZERO DB reads (ops.html unaffected)", async () => {
  const store: Store = {};
  const client = makeClient(store);
  await assertAssignmentMutationAuthz(client, "api_key", null, { jobId: "job-fen" });
  assertEquals(store.calls, []); // no lookups for the privileged dashboard path
});

Deno.test("gate: routine caller is refused (403)", async () => {
  const client = makeClient({});
  await assertRejects(
    () => assertAssignmentMutationAuthz(client, "routine", null, { jobId: "job-fen" }),
    Error,
    "routine",
  );
});

Deno.test("gate: dispatcher JWT passes with no job/user lookup", async () => {
  const store: Store = {};
  const client = makeClient(store);
  await assertAssignmentMutationAuthz(client, "jwt", { id: "u1", role: "ops_manager" }, { jobId: "job-fen" });
  assertEquals(store.calls, []);
});

// managed_verticals rides on the AUTHENTICATED context (read server-side from
// the users row at auth time, never from the request body), so the gate reads the
// job and nothing else.
Deno.test("gate: vertical manager passes only for a job in their vertical", async () => {
  const store: Store = { jobs: { "job-fen": FENCING_JOB } };
  const client = makeClient(store);
  // Right vertical → resolves.
  await assertAssignmentMutationAuthz(
    client,
    "jwt",
    { id: "u-henry", role: "lead_installer", managedVerticals: ["fencing"] },
    { jobId: "job-fen" },
  );
  assertEquals(store.calls!.includes("users"), false, "the authed context already carries managed_verticals");

  // Wrong vertical → 403.
  await assertRejects(
    () =>
      assertAssignmentMutationAuthz(
        makeClient({ jobs: { "job-fen": FENCING_JOB } }),
        "jwt",
        { id: "u-nithin", role: "sales", managedVerticals: ["patio"] },
        { jobId: "job-fen" },
      ),
    Error,
    "Not authorized",
  );
});

Deno.test("gate: plain installer JWT is refused", async () => {
  const store: Store = { jobs: { "job-fen": FENCING_JOB } };
  await assertRejects(
    () =>
      assertAssignmentMutationAuthz(
        makeClient(store),
        "jwt",
        { id: "u-plain", role: "lead_installer", managedVerticals: [] },
        { jobId: "job-fen" },
      ),
    Error,
    "Not authorized",
  );
});

// A context with no manager scope at all must never fall through to "allowed":
// an absent list is an empty list, not a wildcard.
Deno.test("gate: a JWT carrying no managed verticals at all is refused", async () => {
  await assertRejects(
    () =>
      assertAssignmentMutationAuthz(
        makeClient({ jobs: { "job-fen": FENCING_JOB } }),
        "jwt",
        { id: "u-plain", role: "lead_installer" },
        { jobId: "job-fen" },
      ),
    Error,
    "Not authorized",
  );
  await assertRejects(
    () =>
      assertAssignmentMutationAuthz(
        makeClient({ jobs: { "job-fen": FENCING_JOB } }),
        "jwt",
        null,
        { jobId: "job-fen" },
      ),
    Error,
    "Not authorized",
  );
});

Deno.test("gate: update/delete resolve the job via the assignment id", async () => {
  const store: Store = {
    assignments: { "a1": { id: "a1", job_id: "job-fen", user_id: "someone" } },
    jobs: { "job-fen": FENCING_JOB },
  };
  const client = makeClient(store);
  await assertAssignmentMutationAuthz(
    client,
    "jwt",
    { id: "u-henry", role: "lead_installer", managedVerticals: ["fencing"] },
    { assignmentId: "a1" },
  );
  // It had to look up the assignment (for job_id) and the job (for vertical) —
  // and only those two.
  assertEquals(store.calls!.includes("job_assignments"), true);
  assertEquals(store.calls!.includes("jobs"), true);
  assertEquals(store.calls!.includes("users"), false);
});

// ── allocateJob ────────────────────────────────────────────────────────────
Deno.test("allocateJob: refuses an archived job (409)", async () => {
  const client = makeClient({ jobs: { "job-arch": ARCHIVED_JOB } });
  await assertRejects(
    () => allocateJob(client, {
      body: { jobId: "job-arch", userId: "inst-1", scheduledDate: "2026-07-06" },
      callerRole: "lead_installer",
      managedVerticals: ["fencing"],
    }),
    Error,
    "archived",
  );
});

Deno.test("allocateJob: refuses a manager of the wrong vertical (403)", async () => {
  const client = makeClient({ jobs: { "job-fen": FENCING_JOB } });
  await assertRejects(
    () => allocateJob(client, {
      body: { jobId: "job-fen", userId: "inst-1", scheduledDate: "2026-07-06" },
      callerRole: "sales",
      managedVerticals: ["patio"],
    }),
    Error,
    "Not authorized",
  );
});

Deno.test("allocateJob: missing target installer → 400", async () => {
  const client = makeClient({ jobs: { "job-fen": FENCING_JOB } });
  await assertRejects(
    () => allocateJob(client, {
      body: { jobId: "job-fen", scheduledDate: "2026-07-06" },
      callerRole: "admin",
    }),
    Error,
    "target installer",
  );
});

Deno.test("allocateJob: idempotent double-tap returns the existing assignment, no insert", async () => {
  const store: Store = {
    jobs: { "job-fen": FENCING_JOB },
    users: { "inst-1": { id: "inst-1" } },
    dup: [{ id: "existing-a", job_id: "job-fen", user_id: "inst-1", scheduled_date: "2026-07-06", status: "scheduled" }],
  };
  const client = makeClient(store);
  const res = await allocateJob(client, {
    body: { jobId: "job-fen", userId: "inst-1", scheduledDate: "2026-07-06" },
    callerRole: "lead_installer",
    managedVerticals: ["fencing"],
  });
  assertEquals(res.ok, true);
  assertEquals(res.mode, "idempotent");
  assertEquals(res.deduped, true);
  assertEquals(res.assignment.id, "existing-a");
  // No new job_assignments row was inserted.
  assertEquals(store.inserts!.filter((i) => i.table === "job_assignments").length, 0);
});

Deno.test("allocateJob: reassign to the SAME installer is a no-op (deduped)", async () => {
  const store: Store = {
    assignments: { "a1": { id: "a1", job_id: "job-fen", user_id: "inst-1", status: "scheduled" } },
    jobs: { "job-fen": FENCING_JOB },
    users: { "inst-1": { id: "inst-1" } },
  };
  const client = makeClient(store);
  const res = await allocateJob(client, {
    body: { assignmentId: "a1", userId: "inst-1" },
    callerRole: "admin",
  });
  assertEquals(res.mode, "reassign");
  assertEquals(res.deduped, true);
  assertEquals(store.updates!.length, 0); // no update issued
});

Deno.test("allocateJob: reassign moves the assignment to a new installer via updateAssignment", async () => {
  const store: Store = {
    assignments: { "a1": { id: "a1", job_id: "job-fen", user_id: "inst-1", status: "scheduled" } },
    jobs: { "job-fen": FENCING_JOB },
    users: { "inst-2": { id: "inst-2" } },
  };
  const client = makeClient(store);
  const res = await allocateJob(client, {
    body: { assignmentId: "a1", userId: "inst-2" },
    callerRole: "lead_installer",
    managedVerticals: ["fencing"],
  });
  assertEquals(res.ok, true);
  assertEquals(res.mode, "reassign");
  // updateAssignment ran and set user_id to the new installer.
  const upd = store.updates!.find((u) => u.table === "job_assignments");
  assertEquals(upd?.row?.user_id, "inst-2");
});
