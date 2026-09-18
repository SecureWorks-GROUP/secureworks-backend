// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _createMakesafeJob,
  _isMakesafeHugoAssigneeForTest,
  _resolveMakesafeDefaultAssigneeForTest,
} from "./index.ts";

type Row = Record<string, any>;
type Store = { tables: Record<string, Row[]> };

const HUGO = {
  id: "user-hugo",
  name: "Hugo",
  email: "hugolgraetz@gmail.com",
  role: "ops_manager",
  created_at: "2024-06-01T00:00:00Z",
};
const SHAUN = {
  id: "user-shaun",
  name: "Shaun",
  email: "shaun@secureworkswa.com.au",
  role: "ops_manager",
  created_at: "2020-01-01T00:00:00Z",
};

function makeStore(users: Row[] = [SHAUN, HUGO]): Store {
  return {
    tables: {
      jobs: [],
      users,
      makesafe_job_details: [],
      makesafe_attendance_cycles: [],
      job_assignments: [],
      job_events: [],
      job_documents: [],
      makesafe_companies: [],
      makesafe_intake_cases: [],
      ses_synthetic_livefire_runs: [],
    },
  };
}

function makeClient(store: Store) {
  function builder(table: string) {
    let operation: "select" | "insert" | "update" | "delete" = "select";
    let insertValue: Row | Row[] | null = null;
    let updateValue: Row | null = null;
    const filters: Array<(row: Row) => boolean> = [];
    let executed: Promise<{ data: any; error: any }> | null = null;

    const matching = () =>
      (store.tables[table] || []).filter((row) =>
        filters.every((filter) => filter(row))
      );
    const execute = () => {
      if (executed) return executed;
      executed = Promise.resolve().then(() => {
        store.tables[table] = store.tables[table] || [];
        if (operation === "select") {
          return { data: matching().map((row) => ({ ...row })), error: null };
        }
        if (operation === "insert") {
          const values = Array.isArray(insertValue)
            ? insertValue
            : [insertValue || {}];
          const inserted = values.map((value, index) => {
            const row = { ...value };
            if (!row.id) {
              row.id = table === "jobs"
                ? `job-${store.tables.jobs.length + index + 1}`
                : `${table}-${store.tables[table].length + index + 1}`;
            }
            store.tables[table].push(row);
            return { ...row };
          });
          return { data: inserted, error: null };
        }
        if (operation === "update") {
          const updated: Row[] = [];
          for (const row of matching()) {
            Object.assign(row, updateValue || {});
            updated.push({ ...row });
          }
          return { data: updated, error: null };
        }
        const removed = matching();
        store.tables[table] = store.tables[table].filter((row) =>
          !removed.includes(row)
        );
        return { data: removed, error: null };
      });
      return executed;
    };

    const chain: any = {
      select: () => chain,
      insert: (value: Row | Row[]) => {
        operation = "insert";
        insertValue = value;
        return chain;
      },
      update: (value: Row) => {
        operation = "update";
        updateValue = value;
        return chain;
      },
      delete: () => {
        operation = "delete";
        return chain;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return chain;
      },
      neq: (column: string, value: unknown) => {
        filters.push((row) => row[column] !== value);
        return chain;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => row[column] == value);
        return chain;
      },
      or: () => chain,
      not: () => chain,
      contains: () => chain,
      ilike: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        const result = await execute();
        const rows = Array.isArray(result.data) ? result.data : [];
        return { data: rows[0] || null, error: result.error };
      },
      single: async () => {
        const result = await execute();
        const rows = Array.isArray(result.data) ? result.data : [];
        return { data: rows[0] || null, error: result.error };
      },
      then: (resolve: any, reject: any) => execute().then(resolve, reject),
      catch: (reject: any) => execute().catch(reject),
    };
    return chain;
  }

  return {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Row = {}) => {
      if (name === "next_job_number") {
        const n = 29001 + store.tables.jobs.length;
        if (String(args.job_type || "") === "repair") {
          return { data: `SWR-${n}`, error: null };
        }
        return { data: `SWMS-${n}`, error: null };
      }
      return { data: null, error: null };
    },
  };
}

function physicalInput() {
  return {
    client_name: "Sample Client",
    site_address: "12 Example St",
    suburb: "Padbury",
    requesting_company_name: "ML Builders",
    external_ref: "MLB-40001",
    makesafe_job_family: "general_makesafe",
    suppress_manager_notification: true,
  };
}

Deno.test("Hugo matcher accepts the live Hugo identity and rejects other staff", () => {
  assertEquals(_isMakesafeHugoAssigneeForTest(HUGO), true);
  assertEquals(
    _isMakesafeHugoAssigneeForTest({ name: "Hugo Graetz", email: "x@y" }),
    true,
  );
  assertEquals(_isMakesafeHugoAssigneeForTest(SHAUN), false);
  assertEquals(
    _isMakesafeHugoAssigneeForTest({
      name: "Ryan",
      email: "ryanhumphries2002@gmail.com",
    }),
    false,
  );
});

Deno.test("default assignee lookup returns Hugo by name even when his role is ops_manager", async () => {
  const store = makeStore();
  const assignee = await _resolveMakesafeDefaultAssigneeForTest(
    makeClient(store),
  );
  assertEquals(assignee?.id, HUGO.id);
  assertEquals(assignee?.name, "Hugo");
});

Deno.test("physical make-safe mint auto-allocates Hugo as lead", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() =>
      Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
  try {
    const store = makeStore();
    const result = await _createMakesafeJob(
      makeClient(store),
      physicalInput(),
      { suppressGeocoding: true },
    );
    assertEquals(result.ok, true);
    const jobId = result.job.id;
    const real = store.tables.job_assignments.filter((row) =>
      row.job_id === jobId && row.is_ghost !== true
    );
    assertEquals(real.length, 1);
    assertEquals(real[0].user_id, HUGO.id);
    assertEquals(real[0].crew_name, "Hugo");
    assertEquals(real[0].role, "lead_installer");
    assertEquals(real[0].visible_to_trades, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("repair-family mint on the make-safe route stays unassigned", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() =>
      Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
  try {
    const store = makeStore();
    const result = await _createMakesafeJob(
      makeClient(store),
      {
        ...physicalInput(),
        makesafe_job_family: "repair",
      },
      { suppressGeocoding: true },
    );
    assertEquals(result.ok, true);
    assertEquals(
      store.tables.job_assignments.filter((row) =>
        row.job_id === result.job.id
      ),
      [],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("repair mint stays unassigned for manual allocation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() =>
      Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
  try {
    const store = makeStore();
    const result = await _createMakesafeJob(
      makeClient(store),
      {
        ...physicalInput(),
        makesafe_job_family: "repair",
      },
      { suppressGeocoding: true, jobRoute: "repair" },
    );
    assertEquals(result.ok, true);
    assertEquals(
      store.tables.job_assignments.filter((row) =>
        row.job_id === result.job.id
      ),
      [],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("mint still succeeds when Hugo is missing, and no assignment is invented", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() =>
      Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
  try {
    const store = makeStore([SHAUN]);
    const result = await _createMakesafeJob(
      makeClient(store),
      physicalInput(),
      { suppressGeocoding: true },
    );
    assertEquals(result.ok, true);
    assert(result.job.id);
    assertEquals(store.tables.job_assignments, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
