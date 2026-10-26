// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch slice 7 (docs/dispatch-slice-7-contract.md, section 3): the one
// write behind the schedule step, set_dispatch_install_confirmed. Shipped with
// a migration contract only; these pin its write boundary and its two stale
// checks. Fixtures carry made-up job numbers and no client data.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISPATCH_INSTALL_CLEARED_EVENT,
  DISPATCH_INSTALL_CONFIRMED_EVENT,
  setDispatchInstallConfirmed,
} from "./dispatch_install_write.ts";
import { DispatchStageWriteError } from "./dispatch_stage_write.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const JOB = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-000000000004";
const TODAY = "2026-10-19";

type Row = Record<string, any>;
type Write = { table: string; op: string; value: Row };

function fakeClient(
  tables: Record<string, Row[]>,
  fail: Record<string, any> = {},
  beforeUpdate?: (table: string) => void,
) {
  const writes: Write[] = [];
  const from = (table: string) => {
    const rows = (tables[table] ||= []);
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "update" | "insert" = "select";
    let value: Row = {};
    const run = () => {
      const f = fail[`${table}.${op}`];
      if (f) return { data: null, error: f };
      if (op === "insert") {
        rows.push({ ...value });
        writes.push({ table, op, value });
        return { data: [{ ...value }], error: null };
      }
      const hit = rows.filter((r) => filters.every((fn) => fn(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, value);
        if (hit.length) writes.push({ table, op, value });
      }
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const b: any = {
      select: () => b,
      limit: () => b,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      is: (
        k: string,
        v: unknown,
      ) => (filters.push((r) => (r[k] ?? null) === v), b),
      ilike: (k: string, v: string) => (
        filters.push((r) =>
          String(r[k] ?? "").toLowerCase() ===
            v.replace(/\\/g, "").toLowerCase()
        ), b
      ),
      // Only the bookings read uses .or: status null or not cancelled.
      or:
        () => (filters.push((r) =>
          r.status == null || r.status !== "cancelled"
        ),
          b),
      update: (v: Row) => {
        beforeUpdate?.(table);
        op = "update";
        value = v;
        return b;
      },
      insert: (v: Row) => ((op = "insert"), (value = v), b),
      maybeSingle: () => {
        const res = run();
        return Promise.resolve({
          data: res.data?.[0] ?? null,
          error: res.error,
        });
      },
      then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
    };
    return b;
  };
  return { client: { from }, writes };
}

function booking(day: string, extra: Row = {}): Row {
  return {
    id: `b-${day}-${extra.role ?? "crew"}`,
    job_id: JOB,
    assignment_type: "install",
    status: "scheduled",
    scheduled_date: day,
    role: "lead_installer",
    is_ghost: false,
    ...extra,
  };
}

function world(
  bookings: Row[],
  state: Row | null = null,
  job: Row = {},
): Record<string, Row[]> {
  return {
    jobs: [{
      id: JOB,
      org_id: ORG,
      type: "fencing",
      status: "scheduled",
      job_number: "SWF-TEST",
      ...job,
    }],
    users: [{ id: USER, email: "person@example.test", org_id: ORG }],
    job_assignments: bookings,
    job_dispatch_state: state ? [{ job_id: JOB, ...state }] : [],
  };
}

const jwt = {
  mode: "jwt" as const,
  userId: USER,
  email: "person@example.test",
};
const key = { mode: "api_key" as const, userId: null, email: null };

async function refused(p: Promise<unknown>, status: number, code?: string) {
  const err: any = await assertRejects(() => p, DispatchStageWriteError);
  assertEquals(err.status, status);
  if (code) assertEquals(err.body?.code, code);
  return err;
}

const ALLOWED = new Set([
  "install_confirmed_at",
  "install_confirmed_by",
  "install_confirmed_by_email",
  "install_confirmed_for_day",
  "updated_at",
  "job_id",
  "org_id",
]);

function assertBoundary(writes: Write[]) {
  for (const w of writes) {
    assert(
      w.table === "job_dispatch_state" ||
        (w.table === "job_events" && w.op === "insert"),
      `unexpected write ${w.op} ${w.table}`,
    );
    if (w.table === "job_dispatch_state") {
      for (const k of Object.keys(w.value)) {
        assert(ALLOWED.has(k), `wrote ${k}`);
      }
    }
  }
}

Deno.test("install: confirm with no state row inserts the mark only, then one event", async () => {
  const { client, writes } = fakeClient(world([booking("2026-10-21")]));
  const res: any = await setDispatchInstallConfirmed(
    client,
    {
      job_id: JOB,
      confirmed: true,
      expected_install_day: "2026-10-21",
      expected_confirmed_at: null,
    },
    jwt,
    ORG,
    TODAY,
  );
  assertEquals(res.success, true);
  assertEquals(res.audit_logged, true);
  assertEquals(writes.map((w) => `${w.op}:${w.table}`), [
    "insert:job_dispatch_state",
    "insert:job_events",
  ]);
  assertEquals(writes[0].value.install_confirmed_for_day, "2026-10-21");
  assertEquals(
    writes[0].value.install_confirmed_by_email,
    "person@example.test",
  );
  assert(!("stage" in writes[0].value) && !("next_step" in writes[0].value));
  assertEquals(writes[1].value.event_type, DISPATCH_INSTALL_CONFIRMED_EVENT);
  assertEquals(writes[1].value.detail_json.for_day, "2026-10-21");
  assertBoundary(writes);
});

Deno.test("install: a booking moved since the screen loaded is refused, nothing written", async () => {
  const { client, writes } = fakeClient(world([booking("2026-10-22")]));
  await refused(
    setDispatchInstallConfirmed(
      client,
      {
        job_id: JOB,
        confirmed: true,
        expected_install_day: "2026-10-21",
        expected_confirmed_at: null,
      },
      jwt,
      ORG,
      TODAY,
    ),
    409,
    "install_changed",
  );
  assertEquals(writes, []);
});

Deno.test("install: a confirmation changed elsewhere is refused, nothing written", async () => {
  const state = {
    install_confirmed_at: "2026-10-18T03:00:00.000Z",
    install_confirmed_by_email: "other@example.test",
    install_confirmed_for_day: "2026-10-21",
  };
  const { client, writes } = fakeClient(world([booking("2026-10-21")], state));
  await refused(
    setDispatchInstallConfirmed(
      client,
      {
        job_id: JOB,
        confirmed: false,
        expected_install_day: "2026-10-21",
        expected_confirmed_at: null,
      },
      jwt,
      ORG,
      TODAY,
    ),
    409,
    "confirmation_changed",
  );
  assertEquals(writes, []);
});

Deno.test("install: clearing a mark updates the four columns to null, guarded on the mark read", async () => {
  const at = "2026-10-18T03:00:00.000Z";
  const state = {
    stage: "schedule_install",
    install_confirmed_at: at,
    install_confirmed_by: USER,
    install_confirmed_by_email: "person@example.test",
    install_confirmed_for_day: "2026-10-21",
  };
  const w = world([booking("2026-10-21")], state);
  const { client, writes } = fakeClient(w);
  const res: any = await setDispatchInstallConfirmed(
    client,
    {
      job_id: JOB,
      confirmed: false,
      expected_install_day: "2026-10-21",
      // The same instant printed another way still matches.
      expected_confirmed_at: "2026-10-18T11:00:00+08:00",
    },
    jwt,
    ORG,
    TODAY,
  );
  assertEquals(res.success, true);
  assertEquals(writes[0].op, "update");
  assertEquals(writes[0].value.install_confirmed_at, null);
  assertEquals(writes[0].value.install_confirmed_for_day, null);
  assertEquals(w.job_dispatch_state[0].stage, "schedule_install");
  assertEquals(writes[1].value.event_type, DISPATCH_INSTALL_CLEARED_EVENT);
  assertEquals(writes[1].value.detail_json.was_confirmed_at, at);
  assertBoundary(writes);
});

Deno.test("install: pressing confirm again on the same day changes nothing", async () => {
  const at = "2026-10-18T03:00:00.000Z";
  const { client, writes } = fakeClient(world([booking("2026-10-21")], {
    install_confirmed_at: at,
    install_confirmed_for_day: "2026-10-21",
  }));
  const res: any = await setDispatchInstallConfirmed(
    client,
    {
      job_id: JOB,
      confirmed: true,
      expected_install_day: "2026-10-21",
      expected_confirmed_at: at,
    },
    jwt,
    ORG,
    TODAY,
  );
  assertEquals(res.unchanged, true);
  assertEquals(writes, []);
});

Deno.test("install: ghost, observer, cancelled and non-install rows are not the install day", async () => {
  const { client } = fakeClient(world([
    booking("2026-10-20", { is_ghost: true, role: "ghost" }),
    booking("2026-10-20", { role: "observer" }),
    booking("2026-10-20", { status: "cancelled", role: "c" }),
    booking("2026-10-20", { assignment_type: "measure", role: "m" }),
    booking("2026-10-23"),
  ]));
  await refused(
    setDispatchInstallConfirmed(
      client,
      {
        job_id: JOB,
        confirmed: true,
        expected_install_day: "2026-10-20",
        expected_confirmed_at: null,
      },
      jwt,
      ORG,
      TODAY,
    ),
    409,
    "install_changed",
  );
  const res: any = await setDispatchInstallConfirmed(
    client,
    {
      job_id: JOB,
      confirmed: true,
      expected_install_day: "2026-10-23",
      expected_confirmed_at: null,
    },
    jwt,
    ORG,
    TODAY,
  );
  assertEquals(res.success, true);
});

Deno.test("install: the ops key must name a real person; by-id stays null", async () => {
  const { client, writes } = fakeClient(world([booking("2026-10-21")]));
  const body = {
    job_id: JOB,
    confirmed: true,
    expected_install_day: "2026-10-21",
    expected_confirmed_at: null,
  };
  await refused(
    setDispatchInstallConfirmed(client, body, key, ORG, TODAY),
    400,
    "operator_required",
  );
  await refused(
    setDispatchInstallConfirmed(
      client,
      { ...body, operator_email: "nobody@example.test" },
      key,
      ORG,
      TODAY,
    ),
    400,
    "operator_required",
  );
  assertEquals(writes, []);
  await setDispatchInstallConfirmed(
    client,
    { ...body, operator_email: "Person@Example.test" },
    key,
    ORG,
    TODAY,
  );
  assertEquals(writes[0].value.install_confirmed_by, null);
  assertEquals(
    writes[0].value.install_confirmed_by_email,
    "person@example.test",
  );
});

Deno.test("install: a make-safe job has no install step", async () => {
  const { client, writes } = fakeClient(
    world([booking("2026-10-21")], null, { type: "makesafe" }),
  );
  await refused(
    setDispatchInstallConfirmed(
      client,
      {
        job_id: JOB,
        confirmed: true,
        expected_install_day: "2026-10-21",
        expected_confirmed_at: null,
      },
      jwt,
      ORG,
      TODAY,
    ),
    409,
    "not_dispatch_work",
  );
  assertEquals(writes, []);
});

Deno.test("install: a row inserted by another press in between is a 409, not an overwrite", async () => {
  const { client, writes } = fakeClient(world([booking("2026-10-21")]), {
    "job_dispatch_state.insert": { code: "23505", message: "duplicate key" },
  });
  await refused(
    setDispatchInstallConfirmed(
      client,
      {
        job_id: JOB,
        confirmed: true,
        expected_install_day: "2026-10-21",
        expected_confirmed_at: null,
      },
      jwt,
      ORG,
      TODAY,
    ),
    409,
    "confirmation_changed",
  );
  assertEquals(writes, []);
});

Deno.test("install: a failed audit row is reported, the mark stands", async () => {
  const { client, writes } = fakeClient(world([booking("2026-10-21")]), {
    "job_events.insert": { message: "boom" },
  });
  const res: any = await setDispatchInstallConfirmed(
    client,
    {
      job_id: JOB,
      confirmed: true,
      expected_install_day: "2026-10-21",
      expected_confirmed_at: null,
    },
    jwt,
    ORG,
    TODAY,
  );
  assertEquals(res.audit_logged, false);
  assertEquals(writes.map((w) => w.table), ["job_dispatch_state"]);
});

Deno.test("install: a mark changed between the read and the update is a 409, nothing written", async () => {
  const at = "2026-10-18T03:00:00.000Z";
  const w = world([booking("2026-10-21")], {
    install_confirmed_at: at,
    install_confirmed_by_email: "person@example.test",
    install_confirmed_for_day: "2026-10-21",
  });
  // Another press lands after this one read the row and before it writes.
  const { client, writes } = fakeClient(w, {}, (table) => {
    if (table === "job_dispatch_state") {
      w.job_dispatch_state[0].install_confirmed_at = "2026-10-19T00:30:00.000Z";
    }
  });
  await refused(
    setDispatchInstallConfirmed(
      client,
      {
        job_id: JOB,
        confirmed: false,
        expected_install_day: "2026-10-21",
        expected_confirmed_at: at,
      },
      jwt,
      ORG,
      TODAY,
    ),
    409,
    "confirmation_changed",
  );
  assertEquals(writes, []);
  assertEquals(
    w.job_dispatch_state[0].install_confirmed_at,
    "2026-10-19T00:30:00.000Z",
  );
});
