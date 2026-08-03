// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _createMakesafeJob } from "./index.ts";
import {
  MLB_27309_SOURCE_POST_ID,
  runAdjudicatedExactRescan,
} from "./ses_missed_job_recovery.ts";

type Row = Record<string, any>;

type Store = {
  tables: Record<string, Row[]>;
  failCycleBindAfterInsert?: boolean;
  deletedJobIds: string[];
};

const CASE_ID = "00000000-0000-4000-8000-000000000901";
const MINT_ID = "00000000-0000-4000-8000-000000000902";

function makeStore(input: Partial<Store> = {}): Store {
  return {
    tables: {
      jobs: [],
      makesafe_job_details: [],
      makesafe_attendance_cycles: [],
      job_assignments: [],
      job_events: [],
      makesafe_intake_cases: [{
        id: CASE_ID,
        org_id: "00000000-0000-0000-0000-000000000001",
        job_id: null,
        target_job_id: null,
        instruction_key: "builder:generic/po:roof-one",
        builder_wo_canonical: "BUILDER-ROOF-ONE",
        builder_po_canonical: "PO-ROOF-ONE",
        external_ref_canonical: "BUILDER-ROOF-ONE",
      }],
      ...(input.tables || {}),
    },
    failCycleBindAfterInsert: input.failCycleBindAfterInsert,
    deletedJobIds: [],
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
                ? `job-roof-${store.tables.jobs.length + index + 1}`
                : table === "makesafe_attendance_cycles"
                ? `cycle-${row.job_id}-${row.cycle_number}`
                : `${table}-${(store.tables[table] || []).length + index + 1}`;
            }
            store.tables[table] = store.tables[table] || [];
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
        const removedIds = new Set(removed.map((row) => row.id));
        store.tables[table] = (store.tables[table] || []).filter((row) =>
          !removed.includes(row)
        );
        if (table === "jobs") {
          for (const jobId of removedIds) {
            store.deletedJobIds.push(String(jobId));
            store.tables.makesafe_job_details = store.tables
              .makesafe_job_details.filter((row) => row.job_id !== jobId);
            store.tables.makesafe_attendance_cycles = store.tables
              .makesafe_attendance_cycles.filter((row) => row.job_id !== jobId);
          }
        }
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
      is: (column: string, value: unknown) => {
        filters.push((row) => row[column] == value);
        return chain;
      },
      ilike: () => chain,
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
        return {
          data: `SWMS-${29001 + store.tables.jobs.length}`,
          error: null,
        };
      }
      if (name === "bind_makesafe_roof_initial_cycle_v1") {
        const detail = store.tables.makesafe_job_details.find((row) =>
          row.job_id === args.p_job_id
        );
        const beforeCycles = structuredClone(
          store.tables.makesafe_attendance_cycles,
        );
        const beforeDetail = detail ? structuredClone(detail) : null;
        const cycle = {
          id: `cycle-${args.p_job_id}-1`,
          job_id: args.p_job_id,
          cycle_number: 1,
          open_reason: args.p_open_reason,
        };
        store.tables.makesafe_attendance_cycles.push(cycle);
        if (store.failCycleBindAfterInsert) {
          store.tables.makesafe_attendance_cycles = beforeCycles;
          if (detail && beforeDetail) Object.assign(detail, beforeDetail);
          return {
            data: null,
            error: { message: "transactional cycle bind refused" },
          };
        }
        if (!detail) {
          store.tables.makesafe_attendance_cycles = beforeCycles;
          return { data: null, error: { message: "detail missing" } };
        }
        detail.attendance_cycle_id = cycle.id;
        detail.cycle_attribution = "bound";
        return {
          data: {
            attendance_cycle_id: cycle.id,
            cycle_number: 1,
            cycle_created: true,
            cycle_bound: true,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
}

function roofInput() {
  return {
    client_name: "Generic",
    site_address: "Generic site",
    suburb: "Eaton",
    external_ref: "BUILDER-ROOF-ONE",
    makesafe_job_family: "roof_report",
    intake_mint_id: MINT_ID,
    suppress_manager_notification: true,
  };
}

function roofAuthorityOptions() {
  return {
    canonicalIntakeAuthority: { case_id: CASE_ID, mint_id: MINT_ID },
  };
}

function attendanceFor(store: Store, jobId: string) {
  const detail = store.tables.makesafe_job_details.find((row) =>
    row.job_id === jobId
  );
  const cycles = store.tables.makesafe_attendance_cycles.filter((row) =>
    row.job_id === jobId
  );
  return {
    currentAttendanceCycleId: detail?.attendance_cycle_id || null,
    immutableAttendanceCycleIds: cycles.map((row) => row.id),
    attribution: detail?.cycle_attribution || null,
    cycleNumber: Number(detail?.cycle_number || 0),
  };
}

Deno.test("ordinary roof intake returns only after one current cycle is bound and remains unassigned", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() =>
      Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
  try {
    const store = makeStore();
    const result = await _createMakesafeJob(
      makeClient(store),
      roofInput(),
      roofAuthorityOptions(),
    );
    const jobId = result.job.id;
    const attendance = attendanceFor(store, jobId);

    assertEquals(store.tables.jobs.length, 1);
    assertEquals(store.tables.makesafe_attendance_cycles.length, 1);
    assertEquals(
      attendance.currentAttendanceCycleId,
      attendance.immutableAttendanceCycleIds[0],
    );
    assertEquals(attendance.attribution, "bound");
    assertEquals(attendance.cycleNumber, 1);
    assertEquals(store.tables.job_assignments, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("roof intake removes the new card when the transactional bind rolls back after cycle insertion", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() =>
      Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
  try {
    const store = makeStore({ failCycleBindAfterInsert: true });
    await assertRejects(
      () =>
        _createMakesafeJob(
          makeClient(store),
          roofInput(),
          roofAuthorityOptions(),
        ),
      Error,
      "live job was removed",
    );
    assertEquals(store.tables.jobs, []);
    assertEquals(store.tables.makesafe_job_details, []);
    assertEquals(store.tables.makesafe_attendance_cycles, []);
    assertEquals(store.deletedJobIds, ["job-roof-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("direct roof creation without canonical intake authority is refused before any card or cycle exists", async () => {
  const store = makeStore();
  await assertRejects(
    () => _createMakesafeJob(makeClient(store), roofInput()),
    Error,
    "requires canonical deterministic intake authority",
  );
  assertEquals(store.tables.jobs, []);
  assertEquals(store.tables.makesafe_attendance_cycles, []);
  assertEquals(store.tables.job_assignments, []);
});

Deno.test("sanctioned exact rescan cannot report a newly minted roof card without the shared cycle invariant", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() =>
      Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
  try {
    const store = makeStore();
    const client = makeClient(store);
    let mintedJob: Row | null = null;
    let provenanceWrites = 0;
    const result = await runAdjudicatedExactRescan({
      post_id: MLB_27309_SOURCE_POST_ID,
      expected_job_family: "roof_report",
    }, {
      loadAuthority: async () => ({
        caseId: "case-exact",
        state: "exception",
        jobId: null,
        targetJobId: null,
      }),
      scan: async () => {
        mintedJob = (await _createMakesafeJob(
          client,
          roofInput(),
          roofAuthorityOptions(),
        )).job;
        return { totals: { jobs_created: 1 } };
      },
      loadJob: async () =>
        mintedJob
          ? {
            id: mintedJob.id,
            jobNumber: mintedJob.job_number,
            jobFamily: mintedJob.metadata.makesafe_job_family,
            attendance: attendanceFor(store, mintedJob.id),
          }
          : null,
      appendProvenance: async () => {
        provenanceWrites++;
      },
      hasProvenance: async () => false,
      canRepairProvenance: async () => false,
    });

    assertEquals(result.outcome, "minted");
    assertEquals(store.tables.jobs.length, 1);
    assertEquals(store.tables.makesafe_attendance_cycles.length, 1);
    assertEquals(store.tables.job_assignments, []);
    assertEquals(provenanceWrites, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
