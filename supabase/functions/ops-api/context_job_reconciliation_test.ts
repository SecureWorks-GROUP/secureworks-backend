// CTX-N1: the two job reconciliation doors. Behaviour on the module (job
// lookup, arguments, failed reads never empty) and on the real ops-api front
// door (staff only, never a profile-scoped trade read or an agent read).
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONTEXT_JOB_RECON_ACTIONS,
  contextJobMail,
  ContextJobReconError,
  contextMailArgs,
  RECON_JOB_ITEMS_PAGE,
  reconJobItems,
} from "./context_job_reconciliation.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

const JOB = {
  id: "07387667-7616-4db9-aed8-d3a020d321f9",
  job_number: "SWP-26376",
};

function fake(opts: {
  jobs?: unknown[];
  jobError?: unknown;
  rpcData?: unknown;
  rpcError?: unknown;
}) {
  const calls: { kind: string; detail: unknown }[] = [];
  const client = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const q: any = {
        select() {
          return q;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return q;
        },
        limit(n: number) {
          calls.push({ kind: "from", detail: { table, filters, n } });
          return Promise.resolve({
            data: opts.jobError ? null : (opts.jobs ?? [JOB]),
            error: opts.jobError ?? null,
          });
        },
      };
      return q;
    },
    rpc(fn: string, args: unknown) {
      calls.push({ kind: "rpc", detail: { fn, args } });
      return Promise.resolve({
        data: opts.rpcError ? null : opts.rpcData,
        error: opts.rpcError ?? null,
      });
    },
  };
  return { client, calls };
}

Deno.test("context_job_mail: job number matched whole, args passed, candidates counted", async () => {
  const { client, calls } = fake({
    rpcData: [
      { event_id: "e1", placement: "candidate" },
      { event_id: "e2", placement: "certain" },
    ],
  });
  const out = await contextJobMail(
    client,
    new URLSearchParams("job_number=SWP-26376&limit=20&roles=supplier,staff"),
  );
  assertEquals(calls[0], {
    kind: "from",
    detail: { table: "jobs", filters: [["job_number", "SWP-26376"]], n: 2 },
  });
  assertEquals(calls[1], {
    kind: "rpc",
    detail: {
      fn: "context_job_mail",
      args: { p_job: JOB.id, p_limit: 21, p_roles: ["supplier", "staff"] },
    },
  });
  assertEquals(out.job_number, "SWP-26376");
  assertEquals(out.candidate_count, 1);
  assertEquals(out.mail.length, 2);
  assertEquals(out.more, false);
});

Deno.test("a cut list says more instead of reading as complete", async () => {
  const mailRows = Array.from({ length: 3 }, (_, i) => ({
    event_id: `e${i}`,
    placement: "certain",
  }));
  const mail = await contextJobMail(
    fake({ rpcData: mailRows }).client,
    new URLSearchParams("job_number=SWP-26376&limit=2"),
  );
  assertEquals([mail.mail.length, mail.more], [2, true]);
  const itemRows = Array.from({ length: RECON_JOB_ITEMS_PAGE + 1 }, (_, i) => ({
    event_id: `e${i}`,
  }));
  const items = await reconJobItems(
    fake({ rpcData: itemRows }).client,
    new URLSearchParams("job_number=SWP-26376"),
  );
  assertEquals([items.items.length, items.more], [RECON_JOB_ITEMS_PAGE, true]);
  const full = await reconJobItems(
    fake({ rpcData: itemRows.slice(0, RECON_JOB_ITEMS_PAGE) }).client,
    new URLSearchParams("job_number=SWP-26376"),
  );
  assertEquals([full.items.length, full.more], [RECON_JOB_ITEMS_PAGE, false]);
});

Deno.test("recon_job_items: job_id looked up by id, items returned", async () => {
  const { client, calls } = fake({ rpcData: [{ event_id: "e1" }] });
  const out = await reconJobItems(
    client,
    new URLSearchParams(`job_id=${JOB.id}`),
  );
  assertEquals((calls[0].detail as any).filters, [["id", JOB.id]]);
  assertEquals(calls[1], {
    kind: "rpc",
    detail: { fn: "context_recon_job_items", args: { p_job: JOB.id } },
  });
  assertEquals(out.items, [{ event_id: "e1" }]);
});

Deno.test("a failed read is 502 read_failed, never an empty list", async () => {
  for (
    const opts of [
      { rpcError: { code: "57014", message: "timeout" } },
      { jobError: { code: "42703", message: "bad column" } },
    ]
  ) {
    for (const fn of [contextJobMail, reconJobItems]) {
      const e = await assertRejects(
        () =>
          fn(fake(opts).client, new URLSearchParams("job_number=SWP-26376")),
        ContextJobReconError,
      );
      assertEquals([e.code, e.status], ["read_failed", 502]);
    }
  }
});

Deno.test("an answer that is not a list is a failed read; an empty list is a real empty list", async () => {
  for (const rpcData of [null, undefined, {}, { mail: [] }, "x", 0]) {
    for (const fn of [contextJobMail, reconJobItems]) {
      const e = await assertRejects(
        () =>
          fn(fake({ rpcData }).client, new URLSearchParams("job_number=SWP-26376")),
        ContextJobReconError,
      );
      assertEquals([e.code, e.status], ["read_failed", 502]);
    }
  }
  const mail = await contextJobMail(
    fake({ rpcData: [] }).client,
    new URLSearchParams("job_number=SWP-26376"),
  );
  assertEquals([mail.mail.length, mail.more, mail.candidate_count], [0, false, 0]);
  const items = await reconJobItems(
    fake({ rpcData: [] }).client,
    new URLSearchParams("job_number=SWP-26376"),
  );
  assertEquals([items.items.length, items.more], [0, false]);
});

Deno.test("unknown and ambiguous jobs refuse by name", async () => {
  let e = await assertRejects(
    () =>
      reconJobItems(
        fake({ jobs: [] }).client,
        new URLSearchParams("job_number=SWP-1"),
      ),
    ContextJobReconError,
  );
  assertEquals([e.code, e.status], ["job_not_found", 404]);
  e = await assertRejects(
    () =>
      reconJobItems(
        fake({ jobs: [JOB, JOB] }).client,
        new URLSearchParams("job_number=SWP-26376"),
      ),
    ContextJobReconError,
  );
  assertEquals([e.code, e.status], ["job_number_ambiguous", 409]);
  for (const q of ["", "job_id=nope", "job_number=SWP%2526376"]) {
    e = await assertRejects(
      () => reconJobItems(fake({}).client, new URLSearchParams(q)),
      ContextJobReconError,
    );
    assertEquals([e.code, e.status], ["invalid_request", 400], q);
  }
});

Deno.test("mail arguments: limit bounds and a closed role list", () => {
  assertEquals(contextMailArgs(new URLSearchParams("")), {
    p_limit: 100,
    p_roles: null,
  });
  for (const q of ["limit=0", "limit=501", "limit=x", "roles=supplier,boss"]) {
    const e = assertThrows(
      () => contextMailArgs(new URLSearchParams(q)),
      ContextJobReconError,
    );
    assertEquals([e.code, e.status], ["invalid_request", 400], q);
  }
});

Deno.test("both doors are staff-only: not profile-scoped, not agent-read, trades refused", () => {
  for (const action of CONTEXT_JOB_RECON_ACTIONS) {
    const url = new URL(`https://example.invalid/ops-api?action=${action}`);
    assertEquals(_opsApiActionNeedsStaffRole(url), true, action);
    assertEquals(AGENT_READ_ALLOWED_ACTIONS.has(action), false, action);
    const decide = (
      authMode: "api_key" | "jwt",
      role?: string,
      managedVerticals?: string[],
    ) => {
      const d = _authorizeOpsApiAction({
        url,
        authMode,
        authUser: role ? { role, managedVerticals } : null,
        serverSecretPresented: authMode === "api_key",
      });
      return d.ok ? 200 : d.status;
    };
    assertEquals(decide("jwt", "admin"), 200, action);
    assertEquals(decide("jwt", "ops_manager"), 200, action);
    assertEquals(decide("api_key"), 200, action);
    assertEquals(decide("jwt", "lead_installer"), 403, action);
    assertEquals(decide("jwt", "lead_installer", ["fencing"]), 403, action);
    assertEquals(decide("jwt", "trade"), 403, action);
  }
});
