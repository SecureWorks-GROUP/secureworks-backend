// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch slice 3 (docs/dispatch-slice-3-contract.md): the stage rail, the
// To do list, and the two writes behind the rail. Fixtures carry made-up job
// numbers and no client data; each proof job is named by its id in the build
// note (P1 to P23).
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _authorizeOpsApiAction,
  _opsApiCallerIsStaffOperator,
  _opsApiRequestHandlerForTest,
  _pipelineForTest,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} from "./index.ts";
import {
  DISPATCH_LIST_ALIASES,
  DISPATCH_LIST_PROJECTION,
} from "./dispatch_job_list.ts";
import {
  DISPATCH_STAGES,
  dispatchPlace,
  dispatchRowFields,
  dispatchTodo,
  normaliseDispatchNextStep,
} from "./dispatch_stage.ts";
import {
  DISPATCH_NEXT_STEP_SET_EVENT,
  DISPATCH_STAGE_CHANGED_EVENT,
  DispatchStageWriteError,
  setDispatchNextStep,
  setDispatchStage,
} from "./dispatch_stage_write.ts";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const ROW_CEILING = 1000;
const PAGE_SIZE = 1000;
type Row = Record<string, any>;

function jobId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

// A job row as the Dispatch list projects it (the ds_ aliases are what the
// projections return for the row's metadata).
function job(index: number, overrides: Row = {}): Row {
  return {
    id: jobId(index),
    org_id: ORG_ID,
    type: "fencing",
    status: "order_materials",
    client_name: `Customer ${index}`,
    client_phone: null,
    site_address: null,
    site_suburb: null,
    pj_total_inc: null,
    pj_total: null,
    pj_split_neighbours: null,
    pj_job_neighbours: null,
    ghl_contact_id: null,
    ghl_opportunity_id: null,
    job_number: `SWF-T${index}`,
    accepted_at: null,
    approvals_at: null,
    deposit_at: null,
    processing_at: null,
    scheduled_at: null,
    completed_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: new Date(Date.UTC(2026, 9, 1) - index * 60000).toISOString(),
    deposit_invoice_id: null,
    deposit_amount: null,
    council_required: null,
    ds_runs: null,
    ds_gates: null,
    ds_colour: null,
    ds_profile: null,
    ds_config: null,
    ds_ses_family: null,
    ds_makesafe_family: null,
    ds_repair_stage: null,
    ...overrides,
  };
}

// ── The nineteen proof jobs of build note section 9.0 ────────────────────────
type Proof = {
  id: string;
  row: Row;
  todo: boolean;
  stage: string | null;
  index: number | null;
  source: string | null;
  from: string | null;
  out: string | null;
};

function proofJobs(): Proof[] {
  const p = (
    n: number,
    id: string,
    over: Row,
    expect: Omit<Proof, "id" | "row">,
  ): Proof => ({
    id,
    row: job(n, { job_number: `SWX-${id}`, ...over }),
    ...expect,
  });
  return [
    p(12, "P12", { status: "awaiting_deposit" }, {
      todo: true,
      stage: "accepted",
      index: 1,
      source: "job_status",
      from: "awaiting_deposit",
      out: null,
    }),
    p(13, "P13", { status: "order_materials" }, {
      todo: true,
      stage: "deposit_paid",
      index: 2,
      source: "job_status",
      from: "order_materials",
      out: null,
    }),
    p(14, "P14", { status: "processing" }, {
      todo: true,
      stage: "deposit_paid",
      index: 2,
      source: "job_status",
      from: "processing",
      out: null,
    }),
    p(15, "P15", { status: "awaiting_supplier" }, {
      todo: true,
      stage: "materials_ordered",
      index: 3,
      source: "job_status",
      from: "awaiting_supplier",
      out: null,
    }),
    p(4, "P4", {
      type: "patio",
      status: "order_materials",
      council_required: true,
    }, {
      todo: true,
      stage: "deposit_paid",
      index: 2,
      source: "job_status",
      from: "order_materials",
      out: null,
    }),
    p(
      10,
      "P10",
      { type: "patio", status: "accepted", council_required: false },
      {
        todo: true,
        stage: "accepted",
        index: 1,
        source: "job_status",
        from: "accepted",
        out: null,
      },
    ),
    p(7, "P7", {
      type: "patio",
      status: "order_materials",
      council_required: false,
    }, {
      todo: true,
      stage: "deposit_paid",
      index: 2,
      source: "job_status",
      from: "order_materials",
      out: null,
    }),
    p(16, "P16", {
      type: "patio",
      status: "schedule_install",
      council_required: false,
    }, {
      todo: true,
      stage: "supplier_confirmed",
      index: 4,
      source: "job_status",
      from: "schedule_install",
      out: null,
    }),
    p(
      17,
      "P17",
      { type: "patio", status: "approvals", council_required: true },
      {
        todo: false,
        stage: "deposit_paid",
        index: 2,
        source: "job_status",
        from: "approvals",
        out: "in_council",
      },
    ),
    p(18, "P18", {
      type: "patio",
      status: "awaiting_deposit",
      council_required: null,
    }, {
      todo: false,
      stage: "accepted",
      index: 1,
      source: "job_status",
      from: "awaiting_deposit",
      out: "council_not_decided",
    }),
    p(19, "P19", {
      type: "patio",
      status: "awaiting_deposit",
      council_required: true,
    }, {
      todo: false,
      stage: "accepted",
      index: 1,
      source: "job_status",
      from: "awaiting_deposit",
      out: "council_to_come",
    }),
    // Slice 7 (ruling I7): a Trade scheduled job with no install booked and no
    // install mark is back in To do.
    p(1, "P1", { status: "scheduled" }, {
      todo: true,
      stage: "trade_scheduled",
      index: 6,
      source: "job_status",
      from: "scheduled",
      out: null,
    }),
    p(20, "P20", {
      type: "repair",
      status: "accepted",
      ds_repair_stage: "approved",
    }, {
      todo: true,
      stage: "accepted",
      index: 1,
      source: "repairs_board",
      from: "approved",
      out: null,
    }),
    // A repair-family job typed fencing: the Repairs board decides.
    p(21, "P21", {
      type: "fencing",
      status: "schedule_install",
      ds_makesafe_family: "repair",
      ds_repair_stage: "materials",
    }, {
      todo: true,
      stage: "deposit_paid",
      index: 2,
      source: "repairs_board",
      from: "materials",
      out: null,
    }),
    p(5, "P5", {
      type: "fencing",
      status: "order_materials",
      ds_ses_family: "repair",
      ds_repair_stage: "complete",
    }, {
      todo: false,
      stage: "trade_scheduled",
      index: 6,
      source: "repairs_board",
      from: "complete",
      out: null,
    }),
    p(22, "P22", {
      type: "repair",
      status: "accepted",
      ds_repair_stage: "wo_in",
    }, {
      todo: false,
      stage: "not_started",
      index: 0,
      source: "repairs_board",
      from: "wo_in",
      out: null,
    }),
    p(23, "P23", { status: "partially_accepted" }, {
      todo: false,
      stage: "not_started",
      index: 0,
      source: "job_status",
      from: "partially_accepted",
      out: null,
    }),
    p(2, "P2", { status: "archived" }, {
      todo: false,
      stage: "trade_scheduled",
      index: 6,
      source: "job_status",
      from: "archived",
      out: null,
    }),
    p(6, "P6", { type: "makesafe", status: "accepted" }, {
      todo: false,
      stage: null,
      index: null,
      source: null,
      from: null,
      out: null,
    }),
  ];
}

Deno.test("rules: the nineteen proof jobs read the stage, source and To do of build note 9.0", () => {
  const proofs = proofJobs();
  assertEquals(proofs.length, 19);
  for (const proof of proofs) {
    const fields = dispatchRowFields(proof.row, null, {
      bookings: [],
      today: "2026-10-14",
    });
    assertEquals(
      {
        todo: fields.dispatch_todo,
        stage: fields.dispatch_stage,
        index: fields.dispatch_stage_index,
        source: fields.dispatch_stage_source,
        from: fields.dispatch_stage_from,
        out: fields.dispatch_todo_out,
      },
      {
        todo: proof.todo,
        stage: proof.stage,
        index: proof.index,
        source: proof.source,
        from: proof.from,
        out: proof.out,
      },
      proof.id,
    );
    assertEquals(fields.dispatch_stage_set_at, null, proof.id);
    assertEquals(fields.dispatch_stage_set_by, null, proof.id);
    assertEquals(fields.dispatch_next_step, null, proof.id);
  }
});

Deno.test("rules: every fencing status maps to its stop, and stop 5 is never read", () => {
  const expected: Record<string, number> = {
    partially_accepted: 0,
    accepted: 1,
    awaiting_deposit: 1,
    deposit: 1,
    approvals: 2,
    order_materials: 2,
    processing: 2,
    awaiting_supplier: 3,
    order_confirmed: 4,
    schedule_install: 4,
    scheduled: 6,
    in_progress: 6,
    rectification: 6,
    complete: 6,
    final_payment: 6,
    invoiced: 6,
    get_review: 6,
    archived: 6,
  };
  for (const type of ["fencing", "patio", "decking", "insurance"]) {
    for (const [status, index] of Object.entries(expected)) {
      const place = dispatchPlace(job(1, { type, status }), null);
      assertEquals(place.index, index, `${type} ${status}`);
      assertEquals(place.source, "job_status");
      assertEquals(place.from, status);
      assert(place.stage !== "materials_on_site");
    }
  }
});

Deno.test("rules: a repair reads the Repairs board, by insuranceRepairStage, whatever its job status", () => {
  const byBoard: Record<string, number> = {
    wo_in: 0,
    scoping: 0,
    quoted: 0,
    variation: 0,
    approved: 1,
    materials: 2,
    scheduled: 6,
    on_site: 6,
    complete: 6,
  };
  for (const [boardStage, index] of Object.entries(byBoard)) {
    const place = dispatchPlace(
      job(1, {
        type: "repair",
        status: "order_materials",
        ds_repair_stage: boardStage,
      }),
      null,
    );
    assertEquals(place.index, index, boardStage);
    assertEquals(place.source, "repairs_board");
    assertEquals(place.from, boardStage);
  }
  // No stored board stage: the Repairs board's own fallback from the status.
  const fallback = dispatchPlace(
    job(1, { type: "repair", status: "awaiting_supplier" }),
    null,
  );
  assertEquals(fallback.from, "materials");
  assertEquals(fallback.index, 2);
});

Deno.test("rules: a set stage wins over the job status and the Repairs board", () => {
  const state = {
    stage: "materials_on_site",
    stage_set_at: "2026-10-14T03:00:00.000Z",
    stage_set_by_email: "office@example.test",
    stage_setter: { name: "Office Person" },
    next_step: "CALL SUPPLIER",
  };
  for (
    const row of [
      job(1, { status: "scheduled" }),
      job(2, { type: "repair", status: "accepted", ds_repair_stage: "wo_in" }),
    ]
  ) {
    const fields = dispatchRowFields(row, state);
    assertEquals(fields.dispatch_stage, "materials_on_site");
    assertEquals(fields.dispatch_stage_index, 5);
    assertEquals(fields.dispatch_stage_source, "set");
    assertEquals(fields.dispatch_stage_from, null);
    assertEquals(fields.dispatch_stage_set_at, "2026-10-14T03:00:00.000Z");
    assertEquals(fields.dispatch_stage_set_by, "Office Person");
    assertEquals(fields.dispatch_next_step, "CALL SUPPLIER");
  }
  // The scheduled fence set back at stop 5 is in To do again; the repair at
  // WO In is still outside the window whatever is set.
  assertEquals(
    dispatchRowFields(job(1, { status: "scheduled" }), state).dispatch_todo,
    true,
  );
  assertEquals(
    dispatchRowFields(
      job(2, { type: "repair", status: "accepted", ds_repair_stage: "wo_in" }),
      state,
    ).dispatch_todo,
    false,
  );
  // The setter's email when the user has no name; nothing when neither.
  assertEquals(
    dispatchRowFields(job(1), { ...state, stage_setter: null })
      .dispatch_stage_set_by,
    "office@example.test",
  );
  assertEquals(
    dispatchRowFields(job(1), {
      ...state,
      stage_setter: { name: " " },
      stage_set_by_email: null,
    }).dispatch_stage_set_by,
    null,
  );
});

Deno.test("rules: To do is stops 1 to 5 inside the window; stop 6, started, cancelled and other types are out", () => {
  const set = (stage: string) => ({
    stage,
    stage_set_at: "2026-10-14T00:00:00Z",
  });
  assertEquals(
    dispatchRowFields(
      job(1, { status: "order_materials" }),
      set("trade_scheduled"),
    ).dispatch_todo,
    false,
  );
  assertEquals(
    dispatchRowFields(
      job(1, { status: "order_materials" }),
      set("materials_on_site"),
    ).dispatch_todo,
    true,
  );
  for (
    const status of ["in_progress", "complete", "archived", "cancelled", "lost"]
  ) {
    const fields = dispatchRowFields(
      job(1, { status }),
      set("materials_ordered"),
    );
    assertEquals(fields.dispatch_todo, false, status);
    assertEquals(fields.dispatch_stage, "materials_ordered", status);
  }
  const insurance = dispatchRowFields(
    job(1, { type: "insurance", status: "order_materials" }),
    null,
  );
  assertEquals(insurance.dispatch_stage, "deposit_paid");
  assertEquals(insurance.dispatch_todo, false);
  const decking = dispatchRowFields(
    job(1, {
      type: "decking",
      status: "order_materials",
      council_required: false,
    }),
    null,
  );
  assertEquals(decking.dispatch_todo, true);
});

Deno.test("rules: the patio council rule holds patio and decking only, before Approvals unless council_required is false", () => {
  const cases: Array<[string, string, boolean | null, string | null]> = [
    ["patio", "approvals", true, "in_council"],
    ["patio", "approvals", false, "in_council"],
    ["decking", "approvals", null, "in_council"],
    ["patio", "accepted", true, "council_to_come"],
    ["patio", "deposit", null, "council_not_decided"],
    ["patio", "awaiting_deposit", false, null],
    ["patio", "order_materials", true, null],
    ["patio", "order_materials", null, null],
    ["fencing", "accepted", null, null],
  ];
  for (const [type, status, council, out] of cases) {
    const row = job(1, { type, status, council_required: council });
    const result = dispatchTodo(row, dispatchPlace(row, null));
    assertEquals(result.out, out, `${type} ${status} ${council}`);
    if (out) assertEquals(result.todo, false);
  }
  // A held job outside the window carries no reason.
  const notListed = job(1, {
    type: "patio",
    status: "partially_accepted",
    council_required: null,
  });
  assertEquals(
    dispatchTodo(notListed, dispatchPlace(notListed, null)).out,
    null,
  );
});

Deno.test("rules: the next-step line is trimmed and its white space collapsed", () => {
  assertEquals(
    normaliseDispatchNextStep("  call   the\tsupplier \n"),
    "call the supplier",
  );
  assertEquals(normaliseDispatchNextStep("   "), "");
  assertEquals(normaliseDispatchNextStep(undefined), null);
});

// ── A PostgREST stand-in for the list read and the two writes ────────────────
type Failure = { message: string; code?: string };

function makeClient(
  seed: Record<string, Row[]>,
  options: {
    fail?: Record<string, Failure>;
    beforeWrite?: (
      table: string,
      op: string,
      tables: Record<string, Row[]>,
    ) => void;
  } = {},
) {
  const tables: Record<string, Row[]> = {
    jobs: [],
    job_dispatch_state: [],
    job_events: [],
    users: [],
    ...structuredClone(seed),
  };
  const calls: Array<
    { table: string; op: string; select: string; values?: any }
  > = [];

  function from(table: string) {
    let op = "select";
    let select = "";
    let values: any = null;
    let upsertKey: string | null = null;
    const filters: Array<(row: Row) => boolean> = [];
    const orders: Array<[string, boolean]> = [];
    let rowLimit: number | null = null;
    let single = false;

    const withEmbeds = (row: Row): Row => {
      if (
        table === "job_dispatch_state" &&
        select.includes("stage_setter:stage_set_by(name)")
      ) {
        const user = tables.users.find((u) => u.id === row.stage_set_by);
        return {
          ...row,
          stage_setter: user ? { name: user.name ?? null } : null,
        };
      }
      return { ...row };
    };

    const run = (): { data: any; error: any } => {
      const failure = options.fail?.[`${table}:${op}`];
      if (failure) return { data: null, error: failure };
      if (
        table === "jobs" && op === "select" && select === "id, pricing_json"
      ) {
        return { data: [], error: null };
      }
      const rows = tables[table] || (tables[table] = []);
      if (op === "select") {
        let out = rows.filter((row) => filters.every((f) => f(row)));
        out.sort((a, b) => {
          for (const [column, ascending] of orders) {
            if (a[column] === b[column]) continue;
            const before = a[column] < b[column] ? -1 : 1;
            return ascending ? before : -before;
          }
          return 0;
        });
        if (rowLimit != null) out = out.slice(0, rowLimit);
        return { data: out.map(withEmbeds), error: null };
      }
      options.beforeWrite?.(table, op, tables);
      if (op === "insert") {
        const row = { ...values };
        if (
          table === "job_dispatch_state" &&
          rows.some((r) => r.job_id === row.job_id)
        ) {
          return {
            data: null,
            error: { message: "duplicate key", code: "23505" },
          };
        }
        rows.push(row);
        return { data: [withEmbeds(row)], error: null };
      }
      if (op === "upsert") {
        const existing = rows.find((r) => r[upsertKey!] === values[upsertKey!]);
        if (existing) {
          Object.assign(existing, values);
          return { data: [withEmbeds(existing)], error: null };
        }
        const row = { stage: null, stage_set_at: null, ...values };
        rows.push(row);
        return { data: [withEmbeds(row)], error: null };
      }
      // update
      const hit = rows.filter((row) => filters.every((f) => f(row)));
      for (const row of hit) Object.assign(row, values);
      return { data: hit.map(withEmbeds), error: null };
    };

    const settle = () => {
      calls.push({ table, op, select, values });
      const result = run();
      if (result.error || !single) return result;
      const list = result.data || [];
      return { data: list[0] ?? null, error: null };
    };

    const builder: any = {
      select: (columns = "*") => {
        select = columns;
        return builder;
      },
      insert: (v: any) => {
        op = "insert";
        values = v;
        return builder;
      },
      update: (v: any) => {
        op = "update";
        values = v;
        return builder;
      },
      upsert: (v: any, opts: { onConflict: string }) => {
        op = "upsert";
        values = v;
        upsertKey = opts.onConflict;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        filters.push((row) => row[column] !== value);
        return builder;
      },
      is: (column: string, value: unknown) => {
        if (value === null) filters.push((row) => row[column] == null);
        return builder;
      },
      in: (column: string, list: unknown[]) => {
        filters.push((row) => list.includes(row[column]));
        return builder;
      },
      or: (filter: string) => {
        // Only the pipeline's flat or-filters reach here; keep every row
        // except true make-safes on the listed-work filter.
        if (filter.startsWith("type.neq.makesafe")) {
          filters.push((row) =>
            row.type !== "makesafe" || row.ds_ses_family === "repair" ||
            row.ds_makesafe_family === "repair"
          );
        }
        return builder;
      },
      not: () => builder,
      order: (column: string, opts?: { ascending?: boolean }) => {
        orders.push([column, opts?.ascending !== false]);
        return builder;
      },
      limit: (n: number) => {
        rowLimit = n;
        return builder;
      },
      range: (start: number, end: number) => {
        const result = settle();
        if (result.error) return Promise.resolve(result);
        return Promise.resolve({
          data: result.data.slice(
            start,
            Math.min(end + 1, start + ROW_CEILING),
          ),
          error: null,
        });
      },
      maybeSingle: () => {
        single = true;
        return Promise.resolve(settle());
      },
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (r: unknown) => unknown,
      ) => Promise.resolve(settle()).then(resolve, reject),
    };
    return builder;
  }

  const writes = () => calls.filter((c) => c.op !== "select");
  return { client: { from }, tables, calls, writes };
}

const params = (query: string) => new URLSearchParams(query);
const allRows = (result: any): Row[] =>
  Object.values(result.columns).flat() as Row[];
const DISPATCH_KEYS = [
  "dispatch_stage",
  "dispatch_stage_index",
  "dispatch_stage_source",
  "dispatch_stage_from",
  "dispatch_stage_set_at",
  "dispatch_stage_set_by",
  "dispatch_todo",
  "dispatch_todo_out",
  "dispatch_next_step",
];

function proofBoard(): Record<string, Row[]> {
  return { jobs: proofJobs().map((proof) => proof.row) };
}

// ── The list read ────────────────────────────────────────────────────────────
Deno.test("pipeline dispatch=1: every row carries its stage, and todo_total counts the To do rows", async () => {
  const { client, calls } = makeClient(proofBoard());
  const result: any = await _pipelineForTest(client, params("dispatch=1"));

  assertEquals(result.dispatch_stages, "ok");
  const rows = allRows(result);
  // Make-safe left out without a search (slice 1): 18 listed.
  assertEquals(rows.length, 18);
  const expected = proofJobs().filter((proof) => proof.id !== "P6");
  for (const proof of expected) {
    const row = rows.find((r) => r.job_number === proof.row.job_number)!;
    assertEquals(row.dispatch_todo, proof.todo, proof.id);
    assertEquals(row.dispatch_stage, proof.stage, proof.id);
    assertEquals(row.dispatch_stage_index, proof.index, proof.id);
    assertEquals(row.dispatch_stage_source, proof.source, proof.id);
    assertEquals(row.dispatch_stage_from, proof.from, proof.id);
    assertEquals(row.dispatch_todo_out, proof.out, proof.id);
    for (const alias of DISPATCH_LIST_ALIASES) {
      assert(!(alias in row), `${alias} leaked`);
    }
  }
  assertEquals(result.todo_total, rows.filter((r) => r.dispatch_todo).length);
  assertEquals(result.todo_total, expected.filter((p) => p.todo).length);
  assert(!("degraded" in result));

  // One more read, of job_dispatch_state for the listed ids, with the
  // setter's name embedded; the jobs read projects repair_stage only.
  const stateReads = calls.filter((c) => c.table === "job_dispatch_state");
  assertEquals(stateReads.length, 1);
  const jobsRead = calls.find((c) =>
    c.table === "jobs" && c.select !== "id, pricing_json"
  )!;
  assertStringIncludes(
    jobsRead.select,
    "ds_repair_stage:metadata->>repair_stage",
  );
  assert(!/(^|,\s*)metadata(\s*,|$)/.test(jobsRead.select));
  assert(!/(^|,\s*)scope_json(\s*,|$)/.test(jobsRead.select));
  assert(
    DISPATCH_LIST_PROJECTION.includes(
      "ds_repair_stage:metadata->>repair_stage",
    ),
  );
});

Deno.test("pipeline dispatch=1: a search returns the make-safe with no rail, never in To do", async () => {
  const { client } = makeClient(proofBoard());
  const result: any = await _pipelineForTest(
    client,
    params("dispatch=1&search=SWX-P6"),
  );
  const rows = allRows(result);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].dispatch_stage, null);
  assertEquals(rows[0].dispatch_stage_index, null);
  assertEquals(rows[0].dispatch_stage_source, null);
  assertEquals(rows[0].dispatch_todo, false);
  assertEquals(rows[0].dispatch_todo_out, null);
  assertEquals(result.todo_total, 0);
});

Deno.test("pipeline dispatch=1: a set stage and next step come through with the setter's name", async () => {
  const board = proofBoard();
  const p1 = proofJobs().find((p) => p.id === "P1")!.row;
  const { client } = makeClient({
    ...board,
    users: [{
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      name: "Office Person",
    }],
    job_dispatch_state: [{
      job_id: p1.id,
      org_id: ORG_ID,
      stage: "materials_ordered",
      stage_set_at: "2026-10-14T03:00:00.000Z",
      stage_set_by: "aaaaaaaa-0000-4000-8000-000000000001",
      stage_set_by_email: "office@example.test",
      next_step: "CHASE SUPPLIER",
      next_step_set_at: "2026-10-14T03:00:00.000Z",
    }],
  });
  const result: any = await _pipelineForTest(client, params("dispatch=1"));
  const row = allRows(result).find((r) => r.id === p1.id)!;
  assertEquals(row.dispatch_stage, "materials_ordered");
  assertEquals(row.dispatch_stage_source, "set");
  assertEquals(row.dispatch_stage_from, null);
  assertEquals(row.dispatch_stage_set_by, "Office Person");
  assertEquals(row.dispatch_next_step, "CHASE SUPPLIER");
  // Set back from Scheduled, the job is in To do again.
  assertEquals(row.dispatch_todo, true);
  assert(!("stage_setter" in row));
});

Deno.test("pipeline dispatch=1: a failed stage read is never 'nothing set': failed, and no stage field", async () => {
  const { client } = makeClient(proofBoard(), {
    fail: {
      "job_dispatch_state:select": {
        message: "relation does not exist",
        code: "42P01",
      },
    },
  });
  const result: any = await _pipelineForTest(client, params("dispatch=1"));
  assertEquals(result.dispatch_stages, "failed");
  assert(!("todo_total" in result));
  assertEquals(result.degraded, true);
  assert(result.enrichment_errors.includes("pipeline.job_dispatch_state"));
  const rows = allRows(result);
  assertEquals(rows.length, 18);
  for (const row of rows) {
    for (const key of DISPATCH_KEYS) {
      assert(!(key in row), `${key} on a failed read`);
    }
    // Slice 1's fields still come back.
    assert("work_type" in row);
  }
});

Deno.test("pipeline dispatch=1: an answer with no job still says the stage read is ok", async () => {
  const { client } = makeClient(proofBoard());
  const result: any = await _pipelineForTest(
    client,
    params("dispatch=1&search=nothing-matches"),
  );
  assertEquals(result.total, 0);
  assertEquals(result.dispatch_stages, "ok");
  assertEquals(result.todo_total, 0);
});

Deno.test("pipeline without dispatch=1 carries none of the new keys and does not read job_dispatch_state", async () => {
  const { client, calls } = makeClient(proofBoard());
  const result: any = await _pipelineForTest(client, params(""));
  assert(!("dispatch_stages" in result));
  assert(!("todo_total" in result));
  for (const row of allRows(result)) {
    for (const key of DISPATCH_KEYS) assert(!(key in row), key);
  }
  assertEquals(calls.filter((c) => c.table === "job_dispatch_state").length, 0);
  const jobsRead = calls.find((c) =>
    c.table === "jobs" && c.select !== "id, pricing_json"
  )!;
  assert(!jobsRead.select.includes("repair_stage"));
});

// ── set_dispatch_stage ───────────────────────────────────────────────────────
const STAFF = {
  userId: "aaaaaaaa-0000-4000-8000-000000000001",
  email: "office@example.test",
};
const OPS_KEY = { userId: null, email: "ops@example.test" };

function writeBoard(): Record<string, Row[]> {
  return {
    jobs: [
      job(1, { status: "order_materials" }),
      job(2, { type: "makesafe", status: "accepted", job_number: "SWMS-T2" }),
      job(3, {
        type: "makesafe",
        status: "accepted",
        ds_ses_family: "repair",
        ds_repair_stage: "approved",
      }),
      job(4, { status: "scheduled" }),
    ],
    users: [{ id: STAFF.userId, name: "Office Person" }],
  };
}

async function refusal(promise: Promise<unknown>) {
  const error = await assertRejects(() => promise, DispatchStageWriteError);
  return error as DispatchStageWriteError;
}

function noJobsWrite(writes: Array<{ table: string }>) {
  assert(
    writes.every((w) =>
      w.table === "job_dispatch_state" || w.table === "job_events"
    ),
  );
}

Deno.test("set_dispatch_stage: each of the six stages can be set, one state row and one event each, no jobs write", async () => {
  let expected = "deposit_paid";
  const { client, tables, writes } = makeClient(writeBoard());
  for (const stage of DISPATCH_STAGES) {
    if (stage === expected && tables.job_dispatch_state.length === 0) {
      // Pinning the stop the job shows from its status is a real write.
    }
    const answer = await setDispatchStage(
      client,
      { job_id: jobId(1), stage, expected_stage: expected },
      STAFF,
      ORG_ID,
    );
    assertEquals(answer.success, true);
    assertEquals(answer.dispatch_stage, stage);
    assertEquals(
      answer.dispatch_stage_index,
      DISPATCH_STAGES.indexOf(stage) + 1,
    );
    assertEquals(answer.dispatch_stage_source, "set");
    assertEquals(answer.dispatch_stage_set_by, "Office Person");
    assertEquals(answer.previous_stage, expected);
    assertEquals(answer.audit_logged, true);
    assertEquals(answer.dispatch_todo, stage !== "trade_scheduled");
    expected = stage;
  }
  assertEquals(tables.job_dispatch_state.length, 1);
  assertEquals(tables.job_dispatch_state[0].stage, "trade_scheduled");
  assertEquals(tables.job_dispatch_state[0].stage_set_by, STAFF.userId);
  assertEquals(tables.job_dispatch_state[0].stage_set_by_email, STAFF.email);
  const events = tables.job_events.filter((e) =>
    e.event_type === DISPATCH_STAGE_CHANGED_EVENT
  );
  assertEquals(events.length, 6);
  assertEquals(tables.job_events.length, 6);
  assertEquals(events[0].detail_json.from_stage, "deposit_paid");
  assertEquals(events[0].detail_json.from_source, "job_status");
  assertEquals(events[0].detail_json.to_stage, "accepted");
  assertEquals(events[0].detail_json.operator_email, STAFF.email);
  assertEquals(events[0].user_id, STAFF.userId);
  assertEquals(events[1].detail_json.from_source, "set");
  noJobsWrite(writes());
  // The job itself is untouched.
  assertEquals(tables.jobs[0].status, "order_materials");
  assertEquals(tables.jobs[0].updated_at, writeBoard().jobs[0].updated_at);
});

Deno.test("set_dispatch_stage: the ops key is attributed by its stamped email, with no user", async () => {
  const { client, tables } = makeClient(writeBoard());
  const answer = await setDispatchStage(
    client,
    {
      job_id: jobId(1),
      stage: "materials_ordered",
      expected_stage: "deposit_paid",
    },
    OPS_KEY,
    ORG_ID,
  );
  assertEquals(answer.dispatch_stage_set_by, "ops@example.test");
  assertEquals(tables.job_dispatch_state[0].stage_set_by, null);
  assertEquals(tables.job_events[0].user_id, null);
});

Deno.test("set_dispatch_stage: pinning the stop shown from the job status writes; setting the set stage again writes nothing", async () => {
  const { client, tables, writes } = makeClient(writeBoard());
  const pinned = await setDispatchStage(
    client,
    {
      job_id: jobId(4),
      stage: "trade_scheduled",
      expected_stage: "trade_scheduled",
    },
    STAFF,
    ORG_ID,
  );
  assertEquals(pinned.previous_source, "job_status");
  assertEquals(pinned.dispatch_stage_source, "set");
  assertEquals(tables.job_events.length, 1);
  const before = writes().length;
  const again = await setDispatchStage(
    client,
    {
      job_id: jobId(4),
      stage: "trade_scheduled",
      expected_stage: "trade_scheduled",
    },
    STAFF,
    ORG_ID,
  );
  assertEquals(again.unchanged, true);
  assertEquals(again.success, true);
  assertEquals(writes().length, before);
  assertEquals(tables.job_events.length, 1);
});

Deno.test("set_dispatch_stage: not_started, an unknown or missing stage and a missing expected_stage are 400", async () => {
  const { client, writes } = makeClient(writeBoard());
  for (
    const body of [
      {
        job_id: jobId(1),
        stage: "not_started",
        expected_stage: "deposit_paid",
      },
      { job_id: jobId(1), stage: "installed", expected_stage: "deposit_paid" },
      { job_id: jobId(1), stage: "scheduled", expected_stage: "deposit_paid" },
      { job_id: jobId(1), expected_stage: "deposit_paid" },
      { job_id: jobId(1), stage: "accepted" },
      { stage: "accepted", expected_stage: "deposit_paid" },
      { job_id: "SWF-1001", stage: "accepted", expected_stage: "deposit_paid" },
    ]
  ) {
    const error = await refusal(setDispatchStage(client, body, STAFF, ORG_ID));
    assertEquals(error.status, 400, JSON.stringify(body));
  }
  assertEquals(writes().length, 0);
});

Deno.test("set_dispatch_stage: an unknown job is 404 and a make-safe job 409 not_dispatch_work", async () => {
  const { client, writes } = makeClient(writeBoard());
  const missing = await refusal(
    setDispatchStage(
      client,
      { job_id: jobId(99), stage: "accepted", expected_stage: "not_started" },
      STAFF,
      ORG_ID,
    ),
  );
  assertEquals(missing.status, 404);
  const makesafe = await refusal(
    setDispatchStage(
      client,
      { job_id: jobId(2), stage: "accepted", expected_stage: "not_started" },
      STAFF,
      ORG_ID,
    ),
  );
  assertEquals(makesafe.status, 409);
  assertEquals(makesafe.body.code, "not_dispatch_work");
  // Another organisation's job is not found.
  const other = makeClient({
    jobs: [job(1, { org_id: "00000000-0000-0000-0000-0000000000ff" })],
  });
  assertEquals(
    (await refusal(
      setDispatchStage(
        other.client,
        { job_id: jobId(1), stage: "accepted", expected_stage: "deposit_paid" },
        STAFF,
        ORG_ID,
      ),
    )).status,
    404,
  );
  assertEquals(writes().length, 0);
});

Deno.test("set_dispatch_stage: a repair-family job stored as make-safe is allowed", async () => {
  const { client, tables } = makeClient(writeBoard());
  const answer = await setDispatchStage(
    client,
    { job_id: jobId(3), stage: "deposit_paid", expected_stage: "accepted" },
    STAFF,
    ORG_ID,
  );
  assertEquals(answer.previous_source, "repairs_board");
  assertEquals(answer.dispatch_stage, "deposit_paid");
  assertEquals(tables.job_dispatch_state.length, 1);
});

Deno.test("set_dispatch_stage: a wrong expected_stage is 409 stage_changed with the current fields, and writes nothing", async () => {
  const { client, writes } = makeClient(writeBoard());
  const error = await refusal(
    setDispatchStage(
      client,
      {
        job_id: jobId(1),
        stage: "materials_ordered",
        expected_stage: "accepted",
      },
      STAFF,
      ORG_ID,
    ),
  );
  assertEquals(error.status, 409);
  assertEquals(error.body.code, "stage_changed");
  assertEquals(error.body.dispatch_stage, "deposit_paid");
  assertEquals(error.body.dispatch_stage_source, "job_status");
  assertEquals(error.body.job_number, "SWF-T1");
  assertEquals(writes().length, 0);
});

Deno.test("set_dispatch_stage: a row inserted or moved in between is a 409, never an overwrite", async () => {
  // Someone else's first press lands between the read and the insert.
  const raced = makeClient(writeBoard(), {
    beforeWrite: (table, op, tables) => {
      if (table === "job_dispatch_state" && op === "insert") {
        tables.job_dispatch_state.push({
          job_id: jobId(1),
          org_id: ORG_ID,
          stage: "supplier_confirmed",
          stage_set_at: "2026-10-14T00:00:00Z",
        });
      }
    },
  });
  const inserted = await refusal(
    setDispatchStage(
      raced.client,
      {
        job_id: jobId(1),
        stage: "materials_ordered",
        expected_stage: "deposit_paid",
      },
      STAFF,
      ORG_ID,
    ),
  );
  assertEquals(inserted.status, 409);
  assertEquals(inserted.body.code, "stage_changed");
  assertEquals(inserted.body.dispatch_stage, "supplier_confirmed");
  assertEquals(raced.tables.job_dispatch_state[0].stage, "supplier_confirmed");
  assertEquals(raced.tables.job_events.length, 0);

  // A move lands between the read and the guarded update.
  const moved = makeClient({
    ...writeBoard(),
    job_dispatch_state: [{
      job_id: jobId(1),
      org_id: ORG_ID,
      stage: "accepted",
      stage_set_at: "2026-10-14T00:00:00Z",
    }],
  }, {
    beforeWrite: (table, op, tables) => {
      if (table === "job_dispatch_state" && op === "update") {
        tables.job_dispatch_state[0].stage = "materials_on_site";
      }
    },
  });
  const updated = await refusal(
    setDispatchStage(
      moved.client,
      {
        job_id: jobId(1),
        stage: "materials_ordered",
        expected_stage: "accepted",
      },
      STAFF,
      ORG_ID,
    ),
  );
  assertEquals(updated.status, 409);
  assertEquals(updated.body.dispatch_stage, "materials_on_site");
  assertEquals(moved.tables.job_dispatch_state[0].stage, "materials_on_site");
  assertEquals(moved.tables.job_events.length, 0);
});

Deno.test("set_dispatch_stage: a failed audit row after the stage landed answers success with audit_logged false", async () => {
  const { client, tables } = makeClient(writeBoard(), {
    fail: { "job_events:insert": { message: "insert failed" } },
  });
  const answer = await setDispatchStage(
    client,
    {
      job_id: jobId(1),
      stage: "materials_ordered",
      expected_stage: "deposit_paid",
    },
    STAFF,
    ORG_ID,
  );
  assertEquals(answer.success, true);
  assertEquals(answer.audit_logged, false);
  assertEquals(tables.job_dispatch_state[0].stage, "materials_ordered");
});

Deno.test("set_dispatch_stage: a failed state read or write is an error, never a silent success", async () => {
  for (
    const key of [
      "job_dispatch_state:select",
      "job_dispatch_state:insert",
      "jobs:select",
    ]
  ) {
    const { client, tables } = makeClient(writeBoard(), {
      fail: { [key]: { message: "boom" } },
    });
    await assertRejects(() =>
      setDispatchStage(
        client,
        {
          job_id: jobId(1),
          stage: "materials_ordered",
          expected_stage: "deposit_paid",
        },
        STAFF,
        ORG_ID,
      )
    );
    assertEquals(tables.job_events.length, 0, key);
  }
});

// ── set_dispatch_next_step ───────────────────────────────────────────────────
Deno.test("set_dispatch_next_step: saves the cleaned line, keeps the stage, and writes one event", async () => {
  const { client, tables, writes } = makeClient({
    ...writeBoard(),
    job_dispatch_state: [{
      job_id: jobId(1),
      org_id: ORG_ID,
      stage: "materials_ordered",
      stage_set_at: "2026-10-14T00:00:00Z",
      next_step: null,
    }],
  });
  const answer = await setDispatchNextStep(
    client,
    { job_id: jobId(1), text: "  chase   supplier  " },
    STAFF,
    ORG_ID,
  );
  assertEquals(answer.success, true);
  assertEquals(answer.dispatch_next_step, "chase supplier");
  assert(answer.next_step_set_at);
  assertEquals(tables.job_dispatch_state[0].stage, "materials_ordered");
  assertEquals(tables.job_dispatch_state[0].next_step_set_by, STAFF.userId);
  assertEquals(tables.job_events.length, 1);
  assertEquals(tables.job_events[0].event_type, DISPATCH_NEXT_STEP_SET_EVENT);
  assertEquals(tables.job_events[0].detail_json, {
    text: "chase supplier",
    previous_text: null,
    operator_email: STAFF.email,
  });
  noJobsWrite(writes());
});

Deno.test("set_dispatch_next_step: a first line creates the row with no stage; an empty line clears it", async () => {
  const { client, tables } = makeClient(writeBoard());
  await setDispatchNextStep(
    client,
    { job_id: jobId(1), text: "BOOK CREW" },
    STAFF,
    ORG_ID,
  );
  assertEquals(tables.job_dispatch_state.length, 1);
  assertEquals(tables.job_dispatch_state[0].stage, null);
  const cleared = await setDispatchNextStep(
    client,
    { job_id: jobId(1), text: "   " },
    STAFF,
    ORG_ID,
  );
  assertEquals(cleared.dispatch_next_step, null);
  assertEquals(tables.job_dispatch_state[0].next_step, null);
  assertEquals(tables.job_events.length, 2);
  assertEquals(tables.job_events[1].detail_json.previous_text, "BOOK CREW");
  // The stage read is unchanged by a next-step row.
  const fields = dispatchRowFields(
    tables.jobs[0],
    tables.job_dispatch_state[0],
  );
  assertEquals(fields.dispatch_stage_source, "job_status");
  // Saving the same line again writes nothing.
  const same = await setDispatchNextStep(
    client,
    { job_id: jobId(1), text: "" },
    STAFF,
    ORG_ID,
  );
  assertEquals(same.unchanged, true);
  assertEquals(tables.job_events.length, 2);
});

Deno.test("set_dispatch_next_step: over 40 characters or no text is 400; unknown job 404; make-safe 409", async () => {
  const { client, writes } = makeClient(writeBoard());
  assertEquals(
    (await refusal(
      setDispatchNextStep(
        client,
        { job_id: jobId(1), text: "x".repeat(41) },
        STAFF,
        ORG_ID,
      ),
    )).status,
    400,
  );
  // Collapsed white space counts once, so this fits.
  await setDispatchNextStep(
    client,
    { job_id: jobId(1), text: "x".repeat(20) + "      " + "y".repeat(19) },
    STAFF,
    ORG_ID,
  );
  assertEquals(
    (await refusal(
      setDispatchNextStep(client, { job_id: jobId(1) }, STAFF, ORG_ID),
    )).status,
    400,
  );
  assertEquals(
    (await refusal(
      setDispatchNextStep(
        client,
        { job_id: jobId(99), text: "a" },
        STAFF,
        ORG_ID,
      ),
    )).status,
    404,
  );
  const makesafe = await refusal(
    setDispatchNextStep(client, { job_id: jobId(2), text: "a" }, STAFF, ORG_ID),
  );
  assertEquals(makesafe.status, 409);
  assertEquals(makesafe.body.code, "not_dispatch_work");
  assertEquals(
    writes().filter((w) => w.table === "job_dispatch_state").length,
    1,
  );
});

// ── Who may call, and what the writes may touch ──────────────────────────────
const ROUTINE_KEY = "test-routine-key";

async function routineCall(action: string, body: unknown) {
  const fetches: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const saved = Deno.env.get("MAKESAFE_ROUTINE_KEY");
  globalThis.fetch = ((input: Request | URL | string) => {
    fetches.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  console.log = () => {};
  Deno.env.set("MAKESAFE_ROUTINE_KEY", ROUTINE_KEY);
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    const res = await _opsApiRequestHandlerForTest(
      new Request(url, {
        method: "POST",
        headers: {
          "x-api-key": ROUTINE_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json(), fetches };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (saved === undefined) Deno.env.delete("MAKESAFE_ROUTINE_KEY");
    else Deno.env.set("MAKESAFE_ROUTINE_KEY", saved);
  }
}

Deno.test("the two writes are staff-only: refused to trades, the routine key and the agent read list", async () => {
  for (const action of ["set_dispatch_stage", "set_dispatch_next_step"]) {
    const url = new URL(
      `https://example.test/functions/v1/ops-api?action=${action}`,
    );
    for (const role of ["admin", "owner", "ops_manager"]) {
      assertEquals(
        _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }),
        { ok: true },
      );
      assert(_opsApiCallerIsStaffOperator("jwt", { role }));
    }
    for (
      const authUser of [{ role: "installer" }, {
        role: "lead_installer",
        managedVerticals: ["fencing"],
      }]
    ) {
      const refused = _authorizeOpsApiAction({
        url,
        authMode: "jwt",
        authUser,
      });
      assertEquals((refused as any).status, 403);
      assert(!_opsApiCallerIsStaffOperator("jwt", authUser));
    }
    assert(_opsApiCallerIsStaffOperator("api_key", null));
    assert(!_opsApiCallerIsStaffOperator("routine", null));
    assert(!_opsApiCallerIsStaffOperator("agent_read", null));
    assert(!AGENT_READ_ALLOWED_ACTIONS.has(action));
    assert(!LEAD_INSTALLER_READ_ACTIONS.has(action));
    const routine = await routineCall(action, {
      job_id: jobId(1),
      stage: "materials_ordered",
      expected_stage: "deposit_paid",
      text: "chase supplier",
    });
    assertEquals(routine.status, 403, action);
    assertStringIncludes(String(routine.body.error), action);
    assertEquals(
      routine.fetches.filter((u) =>
        /\/rest\/v1\/(jobs|job_dispatch_state|job_events)\b/.test(u)
      ),
      [],
      `${action} reached a table for the routine key`,
    );
  }
});

Deno.test("the two writes call nothing: every path reads jobs only and writes only job_dispatch_state and job_events", async () => {
  const seed = writeBoard();
  const { client, tables, calls } = makeClient(seed, {
    beforeWrite: (table, op, t) => {
      if (
        raceOn === "insert" && table === "job_dispatch_state" && op === "insert"
      ) {
        t.job_dispatch_state.push({
          job_id: jobId(4),
          org_id: ORG_ID,
          stage: "accepted",
          stage_set_at: "2026-10-14T00:00:00Z",
        });
      }
      if (
        raceOn === "update" && table === "job_dispatch_state" && op === "update"
      ) {
        const row = t.job_dispatch_state.find((r) => r.job_id === jobId(1));
        if (row) row.stage = "materials_on_site";
      }
    },
  });
  let raceOn: "insert" | "update" | null = null;
  const foreign: string[] = [];
  const onlyFrom = new Proxy(client, {
    get(target: any, prop) {
      if (prop === "from") return target.from;
      if (prop === "then") return undefined;
      foreign.push(String(prop));
      return undefined;
    },
  });
  const jobsBefore = structuredClone(tables.jobs);
  const fetches: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    fetches.push(input instanceof Request ? input.url : String(input));
    return Promise.reject(new Error("no network in the Dispatch writes"));
  }) as typeof fetch;
  try {
    const stage = (body: Row) =>
      setDispatchStage(onlyFrom, body, STAFF, ORG_ID);
    const step = (body: Row) =>
      setDispatchNextStep(onlyFrom, body, STAFF, ORG_ID);

    // First insert, guarded update, unchanged.
    assertEquals(
      (await stage({
        job_id: jobId(1),
        stage: "materials_ordered",
        expected_stage: "deposit_paid",
      })).success,
      true,
    );
    assertEquals(
      (await stage({
        job_id: jobId(1),
        stage: "supplier_confirmed",
        expected_stage: "materials_ordered",
      })).success,
      true,
    );
    assertEquals(
      (await stage({
        job_id: jobId(1),
        stage: "supplier_confirmed",
        expected_stage: "supplier_confirmed",
      })).unchanged,
      true,
    );
    // 400, 404, and the 409s: wrong expected stage, make-safe, raced insert, raced update.
    assertEquals(
      (await refusal(
        stage({
          job_id: jobId(1),
          stage: "not_started",
          expected_stage: "supplier_confirmed",
        }),
      )).status,
      400,
    );
    assertEquals(
      (await refusal(
        stage({
          job_id: jobId(99),
          stage: "accepted",
          expected_stage: "not_started",
        }),
      )).status,
      404,
    );
    assertEquals(
      (await refusal(
        stage({
          job_id: jobId(1),
          stage: "accepted",
          expected_stage: "deposit_paid",
        }),
      )).body.code,
      "stage_changed",
    );
    assertEquals(
      (await refusal(
        stage({
          job_id: jobId(2),
          stage: "accepted",
          expected_stage: "not_started",
        }),
      )).body.code,
      "not_dispatch_work",
    );
    raceOn = "insert";
    assertEquals(
      (await refusal(
        stage({
          job_id: jobId(4),
          stage: "materials_ordered",
          expected_stage: "trade_scheduled",
        }),
      )).body.code,
      "stage_changed",
    );
    raceOn = "update";
    assertEquals(
      (await refusal(
        stage({
          job_id: jobId(1),
          stage: "materials_on_site",
          expected_stage: "supplier_confirmed",
        }),
      )).body.code,
      "stage_changed",
    );
    raceOn = null;

    // Next step: create a row, update it, clear it, unchanged, and the refusals.
    assertEquals(
      (await step({ job_id: jobId(3), text: "BOOK CREW" })).dispatch_next_step,
      "BOOK CREW",
    );
    assertEquals(
      (await step({ job_id: jobId(1), text: "chase supplier" }))
        .dispatch_next_step,
      "chase supplier",
    );
    assertEquals(
      (await step({ job_id: jobId(3), text: "  " })).dispatch_next_step,
      null,
    );
    assertEquals((await step({ job_id: jobId(3), text: "" })).unchanged, true);
    assertEquals(
      (await refusal(step({ job_id: jobId(1), text: "x".repeat(41) }))).status,
      400,
    );
    assertEquals(
      (await refusal(step({ job_id: jobId(99), text: "a" }))).status,
      404,
    );
    assertEquals(
      (await refusal(step({ job_id: jobId(2), text: "a" }))).body.code,
      "not_dispatch_work",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(foreign, [], "a client call other than from()");
  assertEquals(fetches, [], "a network call");
  const touched = [...new Set(calls.map((c) => c.table))].sort();
  assertEquals(touched, ["job_dispatch_state", "job_events", "jobs"]);
  const jobsWrites = calls.filter((c) =>
    c.table === "jobs" && c.op !== "select"
  );
  assertEquals(jobsWrites, [], "jobs is only ever read");
  assertEquals(
    calls.filter((c) => c.table === "job_events").every((c) =>
      c.op === "insert"
    ),
    true,
  );
  assertEquals(tables.jobs, jobsBefore, "the jobs rows changed");
  assertEquals(
    tables.job_events.map((e) => e.event_type).sort(),
    [
      ...Array(2).fill(DISPATCH_STAGE_CHANGED_EVENT),
      ...Array(3).fill(DISPATCH_NEXT_STEP_SET_EVENT),
    ].sort(),
  );
});

Deno.test("PAGE_SIZE matches the paging helper the list read uses", () => {
  // The stand-in pages at the PostgREST ceiling, as fetchAllRows does.
  assertEquals(PAGE_SIZE, ROW_CEILING);
});

// ── Client sign-off on the list (dispatch_signoff.ts) ────────────────────────
// Made-up job numbers; read only. The switch is the trade invoice gate's own.
function signoffBoard(flagOn: boolean): Record<string, Row[]> {
  return {
    jobs: [
      job(91, { job_number: "SWX-S1", status: "complete", completed_at: "2026-10-18T02:00:00.000Z" }),
      job(92, { job_number: "SWX-S2", status: "complete", completed_at: "2026-10-18T02:00:00.000Z" }),
      job(93, { job_number: "SWX-S3", status: "complete", completed_at: "2026-10-18T02:00:00.000Z" }),
      job(94, { job_number: "SWX-S4", status: "invoiced", completed_at: "2026-10-18T02:00:00.000Z" }),
      job(95, { job_number: "SWX-S5", type: "repair", status: "complete" }),
      job(96, { job_number: "SWX-S6", status: "complete", completed_at: "2026-10-18T02:00:00.000Z" }),
    ],
    feature_flags: [{ flag_name: "trade_invoice_requires_client_signoff_v1", enabled: flagOn }],
    client_signoff_settings: [{ id: 1, min_happy_rating: 4, gated_job_types: ["fencing", "patio"], applies_from: null }],
    job_client_signoffs: [
      { id: "so-1", job_id: jobId(91), method: "trade_app", signed_name: "x", happy: true, satisfaction_rating: 5, created_at: "2026-10-18T03:00:00.000Z" },
      { id: "so-2", job_id: jobId(92), method: "trade_app", signed_name: "x", happy: false, satisfaction_rating: 2, created_at: "2026-10-18T03:00:00.000Z" },
      { id: "so-6", job_id: jobId(96), method: "trade_app", signed_name: "x", happy: true, satisfaction_rating: 5, created_at: "2026-10-18T03:00:00.000Z" },
      { id: "so-4", job_id: jobId(94), method: "office_waiver", waiver_reason: "client away", created_at: "2026-10-18T03:00:00.000Z" },
    ],
    xero_invoices: [
      { job_id: jobId(94), status: "AUTHORISED", invoice_type: "ACCREC", reference: "SWX-S4 Final" },
      { job_id: jobId(96), status: "DRAFT", invoice_type: "ACCREC", reference: "SWX-S6 Final" },
    ],
  };
}

Deno.test("pipeline dispatch=1: with the sign-off switch off nothing is read and no card carries sign-off", async () => {
  const { client, calls } = makeClient(signoffBoard(false));
  const result: any = await _pipelineForTest(client, params("dispatch=1"));
  assertEquals(result.dispatch_signoff, "off");
  assert(!("final_invoice_ready_total" in result));
  for (const row of allRows(result)) {
    assert(!("client_signoff" in row));
    assert(!("final_invoice_ready" in row));
  }
  assertEquals(calls.filter((c) => c.table === "job_client_signoffs").length, 0);
  assertEquals(calls.filter((c) => c.table === "client_signoff_settings").length, 0);
});

Deno.test("pipeline dispatch=1: with the switch on each fencing card shows its sign-off and whether the final invoice can be raised", async () => {
  const { client, writes } = makeClient(signoffBoard(true));
  const result: any = await _pipelineForTest(client, params("dispatch=1"));
  assertEquals(result.dispatch_signoff, "ok");
  const by = (n: string) => allRows(result).find((r) => r.job_number === n)!;
  assertEquals(by("SWX-S1").client_signoff.state, "signed_off");
  assertEquals(by("SWX-S1").final_invoice_ready, true);
  assertEquals(by("SWX-S2").client_signoff.state, "not_happy");
  assertEquals(by("SWX-S2").final_invoice_ready, false);
  assertEquals(by("SWX-S3").client_signoff, { state: "not_signed", method: null, signed_at: null });
  assertEquals(by("SWX-S3").final_invoice_ready, false);
  // Waived, but the final invoice is already raised: not ready again.
  assertEquals(by("SWX-S4").client_signoff.state, "waived");
  assertEquals(by("SWX-S4").final_invoice_ready, false);
  // A repair job is outside the sign-off rule: no keys.
  assert(!("client_signoff" in by("SWX-S5")));
  // A DRAFT final invoice still waits on the office: the job stays ready,
  // while the card's own has_final_invoice keeps counting the draft.
  assertEquals(by("SWX-S6").final_invoice_ready, true);
  assertEquals(by("SWX-S6").has_final_invoice, true);
  assertEquals(result.final_invoice_ready_total, 2);
  // Payment is never an input, and the read writes nothing.
  assertEquals(writes().length, 0);
  // The existing To do is untouched by sign-off.
  assertEquals(result.todo_total, allRows(result).filter((r) => r.dispatch_todo).length);
});

Deno.test("pipeline dispatch=1: a failed sign-off read is unknown, never not signed or ready", async () => {
  const { client } = makeClient(signoffBoard(true), {
    fail: { "job_client_signoffs:select": { message: "boom" } },
  });
  const result: any = await _pipelineForTest(client, params("dispatch=1"));
  assertEquals(result.dispatch_signoff, "ok");
  const s1 = allRows(result).find((r) => r.job_number === "SWX-S1")!;
  assertEquals(s1.client_signoff.state, "unknown");
  assertEquals(s1.final_invoice_ready, null);
  assertEquals(result.final_invoice_ready_total, 0);
});
