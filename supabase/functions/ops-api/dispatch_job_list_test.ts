// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch slice 1 read additions (docs/dispatch-slice-1-read-contract.md):
// the opt-in `pipeline&dispatch=1` list read with its description line and GST
// flag, and the `job_notes` read that returns every note on a job.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _authorizeOpsApiAction,
  _jobNotesForTest,
  _pipelineForTest,
  AGENT_READ_ALLOWED_ACTIONS,
  ApiError,
  EXISTING_FENCE_TYPE_PROJECTION,
  LEAD_INSTALLER_READ_ACTIONS,
} from "./index.ts";
import {
  DISPATCH_LIST_ALIASES,
  DISPATCH_LIST_STATUSES,
  DISPATCH_LISTED_WORK_FILTER,
  dispatchJobDescription,
  dispatchValueIncGst,
  dispatchWorkType,
  isDispatchListRequested,
  isPersonWrittenJobNote,
  JOB_NOTE_EVENT_TYPES,
  projectDispatchJobNote,
} from "./dispatch_job_list.ts";
import { buildAgentReplyBody } from "./makesafe_draft_notes.ts";
import { buildPackSentMarkerText } from "./makesafe_send_pack.ts";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
// PostgREST's response ceiling: a read with no .range() stops here.
const ROW_CEILING = 1000;

type Row = Record<string, any>;

function jobId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function job(index: number, overrides: Row = {}): Row {
  const metadata = overrides.metadata ?? null;
  return {
    id: jobId(index),
    org_id: ORG_ID,
    type: "fencing",
    status: "scheduled",
    client_name: `Customer ${index}`,
    client_phone: null,
    site_address: `${index} Example Street`,
    site_suburb: "Balcatta",
    pj_total_inc: 1000 + index,
    pj_total: null,
    pj_split_neighbours: null,
    pj_job_neighbours: null,
    ghl_contact_id: null,
    ghl_opportunity_id: null,
    job_number: `SWF-${1000 + index}`,
    accepted_at: null,
    approvals_at: null,
    deposit_at: null,
    processing_at: null,
    scheduled_at: null,
    completed_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: new Date(Date.UTC(2026, 7, 1) - index * 60000).toISOString(),
    deposit_invoice_id: null,
    deposit_amount: null,
    council_required: false,
    ds_runs: null,
    ds_gates: null,
    ds_colour: null,
    ds_profile: null,
    ds_config: null,
    // What the two family projections return for this row's metadata.
    ds_ses_family: metadata?.ses_family ?? null,
    ds_makesafe_family: metadata?.makesafe_job_family ?? null,
    metadata,
    ...overrides,
  };
}

// One term of a flat PostgREST `or`: column.op.value, the column optionally a
// `->>` text path. A null never satisfies eq or neq, as in SQL.
function orTermMatches(row: Row, term: string): boolean {
  const parsed =
    /^(\w+)(?:->>(\w+))?\.(not\.is\.null|is\.null|eq|neq)(?:\.(.*))?$/
      .exec(term);
  if (!parsed) throw new Error(`unsupported or term: ${term}`);
  const [, column, key, operator, value] = parsed;
  const actual = (key ? row[column]?.[key] : row[column]) ?? null;
  if (operator === "is.null") return actual === null;
  if (operator === "not.is.null") return actual !== null;
  if (actual === null) return false;
  return operator === "eq"
    ? String(actual) === value
    : String(actual) !== value;
}

// A PostgREST stand-in that applies the filters these reads depend on and
// records what each read asked for.
function makeClient(tables: Record<string, Row[]>) {
  const reads: Array<{
    table: string;
    select: string;
    eq: Array<[string, unknown]>;
    neq: Array<[string, unknown]>;
    in: Array<[string, unknown[]]>;
    ilike: Array<[string, string]>;
    or: string[];
    ranged: boolean;
  }> = [];

  function from(table: string) {
    const read = {
      table,
      select: "",
      eq: [] as Array<[string, unknown]>,
      neq: [] as Array<[string, unknown]>,
      in: [] as Array<[string, unknown[]]>,
      ilike: [] as Array<[string, string]>,
      or: [] as string[],
      ranged: false,
    };
    reads.push(read);
    const ilike = read.ilike;
    const orders: Array<[string, boolean]> = [];
    let rowLimit: number | null = null;

    const apply = (): Row[] => {
      // The defensive malformed-pricing probe; these fixtures have none.
      if (table === "jobs" && read.select === "id, pricing_json") return [];
      let rows = [...(tables[table] || [])];
      for (const [column, value] of read.eq) {
        rows = rows.filter((row) => row[column] === value);
      }
      for (const [column, value] of read.neq) {
        rows = rows.filter((row) => row[column] !== value);
      }
      for (const [column, values] of read.in) {
        rows = rows.filter((row) => values.includes(row[column]));
      }
      for (const [column, value] of ilike) {
        rows = rows.filter((row) =>
          String(row[column] ?? "").toLowerCase() === value.toLowerCase()
        );
      }
      for (const filter of read.or) {
        rows = rows.filter((row) =>
          filter.split(",").some((term) => orTermMatches(row, term))
        );
      }
      // Only a select that names the column returns it.
      if (table === "jobs" && !/(^|,\s*)metadata(\s*,|$)/.test(read.select)) {
        rows = rows.map(({ metadata: _metadata, ...rest }) => rest);
      }
      rows.sort((a, b) => {
        for (const [column, ascending] of orders) {
          if (a[column] === b[column]) continue;
          const before = a[column] < b[column] ? -1 : 1;
          return ascending ? before : -before;
        }
        return 0;
      });
      return rowLimit == null ? rows : rows.slice(0, rowLimit);
    };

    const builder: any = {
      select: (columns: string) => {
        read.select = columns;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        read.eq.push([column, value]);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        read.neq.push([column, value]);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        read.in.push([column, values]);
        return builder;
      },
      ilike: (column: string, value: string) => {
        ilike.push([column, value]);
        return builder;
      },
      not: () => builder,
      or: (filter: string) => {
        read.or.push(filter);
        return builder;
      },
      is: () => builder,
      order: (column: string, options?: { ascending?: boolean }) => {
        orders.push([column, options?.ascending !== false]);
        return builder;
      },
      limit: (value: number) => {
        rowLimit = value;
        return builder;
      },
      range: (start: number, end: number) => {
        read.ranged = true;
        const page = apply().slice(
          start,
          Math.min(end + 1, start + ROW_CEILING),
        );
        return Promise.resolve({ data: page, error: null });
      },
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) =>
        Promise.resolve({ data: apply().slice(0, ROW_CEILING), error: null })
          .then(resolve, reject),
    };
    return builder;
  }

  const jobsReads = () =>
    reads.filter((read) =>
      read.table === "jobs" && read.select !== "id, pricing_json"
    );
  return { client: { from }, reads, jobsReads };
}

function allRows(result: any): Row[] {
  return Object.values(result.columns).flat() as Row[];
}

const params = (query: string) => new URLSearchParams(query);

// ── The description line ────────────────────────────────────────────────────

Deno.test("description: a single fence run reads metres, colour and profile", () => {
  assertEquals(
    dispatchJobDescription({
      ds_runs: [{ length: 12.5, panels: [{}, {}] }],
      ds_gates: [],
      ds_colour: "Woodland Grey",
      ds_profile: "Sameside",
    }),
    "12.5m Woodland Grey Sameside fence",
  );
});

Deno.test("description: several runs are summed and counted, and gates are counted", () => {
  assertEquals(
    dispatchJobDescription({
      ds_runs: [{ length: 41 }, { length: "2.4" }],
      ds_gates: [{ type: "pedestrian" }],
      ds_colour: "Monument",
      ds_profile: "Trimclad ",
    }),
    "43.4m Monument Trimclad fence, 2 runs, 1 gate",
  );
  assertEquals(
    dispatchJobDescription({
      ds_runs: [{ length: 42 }],
      ds_gates: [{}, {}],
      ds_colour: "",
      ds_profile: "",
    }),
    "42m fence, 2 gates",
  );
});

Deno.test("description: a patio reads its size, roof style and roofing", () => {
  assertEquals(
    dispatchJobDescription({
      ds_config: {
        length: "7.7",
        projection: "4.2",
        roofStyle: "skillion",
        roofing: "solarspan75",
      },
    }),
    "7.7m × 4.2m skillion patio, solarspan75",
  );
  assertEquals(
    dispatchJobDescription({
      ds_config: {
        length: "6.0",
        projection: 3,
        roofStyle: "reverse_skillion",
      },
    }),
    "6m × 3m reverse skillion patio",
  );
});

Deno.test("description: a missing part is left out, never printed as a placeholder", () => {
  const line = dispatchJobDescription({
    ds_config: { length: "6", roofStyle: "gable" },
  });
  assertEquals(line, "gable patio");
  assert(!String(line).includes("?"));
});

Deno.test("description: shape decides, so a repair job scoped in the fence tool reads as a fence", () => {
  assertEquals(
    dispatchJobDescription({
      type: "repair",
      ds_runs: [{ length: 8 }],
      ds_colour: "Domain",
      ds_profile: "Ridgeside",
    }),
    "8m Domain Ridgeside fence",
  );
});

Deno.test("description: nothing to describe is null", () => {
  for (
    const row of [
      {},
      { ds_runs: null, ds_gates: null, ds_config: null },
      {
        ds_runs: [],
        ds_gates: [],
        ds_colour: "Domain",
        ds_profile: "Ridgeside",
      },
      { ds_config: {} },
      { ds_config: { sheetColor: "Surfmist" } },
      { ds_config: "not an object" },
      { ds_runs: "not an array" },
    ]
  ) {
    assertEquals(dispatchJobDescription(row), null);
  }
});

// ── The GST flag ────────────────────────────────────────────────────────────

Deno.test("value_inc_gst: true only when the figure is totalIncGST", () => {
  assertEquals(
    dispatchValueIncGst({ pj_total_inc: 3047, pj_total: null }),
    true,
  );
  assertEquals(
    dispatchValueIncGst({ pj_total_inc: 3047, pj_total: 2770 }),
    true,
  );
  // The unlabelled fallback: a price is shown, but not known to include GST.
  assertEquals(
    dispatchValueIncGst({ pj_total_inc: null, pj_total: 3850 }),
    false,
  );
  assertEquals(dispatchValueIncGst({ pj_total_inc: 0, pj_total: 3850 }), false);
  // No price at all.
  assertEquals(
    dispatchValueIncGst({ pj_total_inc: null, pj_total: null }),
    false,
  );
  assertEquals(dispatchValueIncGst({}), false);
});

// ── pipeline: the flag is opt-in ────────────────────────────────────────────

Deno.test("flag: only dispatch=1 turns the Dispatch list on", () => {
  assertEquals(isDispatchListRequested(params("dispatch=1")), true);
  for (const query of ["", "dispatch=0", "dispatch=true", "dispatch="]) {
    assertEquals(isDispatchListRequested(params(query)), false);
  }
});

function mixedBoard(): Record<string, Row[]> {
  return {
    jobs: [
      job(1, {
        ds_runs: [{ length: 12.5 }],
        ds_colour: "Woodland Grey",
        ds_profile: "Sameside",
      }),
      job(2, {
        type: "patio",
        status: "order_materials",
        job_number: "SWP-2002",
        pj_total_inc: null,
        pj_total: 3850,
      }),
      job(3, { status: "draft" }),
      job(4, { status: "quoted" }),
      job(5, {
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-5005",
        pj_total_inc: null,
        site_suburb: "Dalyellup",
      }),
      job(6, { status: "archived", pj_total_inc: null }),
    ],
  };
}

Deno.test("pipeline without the flag is unchanged: same select, same rows, no new keys", async () => {
  const { client, jobsReads } = makeClient(mixedBoard());
  const result = await _pipelineForTest(client, params(""));

  assertEquals(result.total, 6);
  assertEquals(result.columns.draft.length, 1);
  assertEquals(result.columns.quoted.length, 1);
  assertEquals(
    allRows(result).filter((row) => row.type === "makesafe").length,
    1,
  );

  const [read] = jobsReads();
  assertEquals(jobsReads().length, 1);
  assertEquals(read.ranged, false);
  assertEquals(read.neq, []);
  assert(!read.or.includes(DISPATCH_LISTED_WORK_FILTER));
  // The fence type is the one scope value the plain read projects; the
  // Dispatch description paths stay opt-in.
  assert(read.select.includes(EXISTING_FENCE_TYPE_PROJECTION));
  assert(
    !read.select.replace(EXISTING_FENCE_TYPE_PROJECTION, "").includes(
      "scope_json",
    ),
  );
  assert(!read.select.includes("metadata"));
  const statuses = read.in.find(([column]) => column === "status")?.[1] || [];
  assert(statuses.includes("draft") && statuses.includes("quoted"));
  assertEquals(statuses.length, 20);

  for (const row of allRows(result)) {
    assert(!("description" in row));
    assert(!("value_inc_gst" in row));
    assert(!("work_type" in row));
    // The fixture rows carry the scope aliases; the plain read must pass a row
    // through as it always has rather than start stripping keys.
    assert("ds_runs" in row);
  }
});

Deno.test("dispatch list: accepted work only, make-safe left out, the new fields on every row", async () => {
  const { client, jobsReads } = makeClient(mixedBoard());
  const result = await _pipelineForTest(client, params("dispatch=1"));

  assertEquals(result.total, 3);
  assertEquals(result.columns.draft, []);
  assertEquals(result.columns.quoted, []);
  assertEquals(
    allRows(result).map((row) => row.job_number).sort(),
    ["SWF-1001", "SWF-1006", "SWP-2002"],
  );

  const [read] = jobsReads();
  assertEquals(read.ranged, true);
  assertEquals(
    read.in.find(([column]) => column === "status")?.[1],
    DISPATCH_LIST_STATUSES,
  );
  assert(!DISPATCH_LIST_STATUSES.includes("draft"));
  assert(!DISPATCH_LIST_STATUSES.includes("quoted"));
  // Projected paths only: the scope blob itself is never selected.
  assert(read.select.includes("ds_runs:scope_json->job->runs"));
  assert(!/(^|,\s*)scope_json(\s*,|$)/.test(read.select));

  const fence = result.columns.scheduled[0];
  assertEquals(fence.description, "12.5m Woodland Grey Sameside fence");
  assertEquals(fence.value, 1001);
  assertEquals(fence.value_inc_gst, true);
  assertEquals(fence.work_type, "fencing");

  const fallback = result.columns.order_materials[0];
  assertEquals(fallback.work_type, "patio");
  assertEquals(fallback.description, null);
  assertEquals(fallback.value, 3850);
  assertEquals(fallback.value_inc_gst, false);

  const noPrice = result.columns.archived[0];
  assertEquals(noPrice.value, 0);
  assertEquals(noPrice.value_inc_gst, false);

  for (const row of allRows(result)) {
    for (
      const alias of [...DISPATCH_LIST_ALIASES, "pj_total_inc", "pj_total"]
    ) {
      assert(!(alias in row), `${alias} leaked into the response`);
    }
  }
});

Deno.test("work type: repair wins over the row's own type, by either family tag", () => {
  assertEquals(
    dispatchWorkType({ type: "makesafe", ds_ses_family: "repair" }),
    "repair",
  );
  assertEquals(
    dispatchWorkType({ type: "fencing", ds_makesafe_family: " Repair " }),
    "repair",
  );
  assertEquals(dispatchWorkType({ type: "repair" }), "repair");
  assertEquals(
    dispatchWorkType({ type: "makesafe", ds_ses_family: "roof_report" }),
    "makesafe",
  );
  assertEquals(
    dispatchWorkType({
      type: "makesafe",
      ds_ses_family: null,
      ds_makesafe_family: null,
    }),
    "makesafe",
  );
  assertEquals(dispatchWorkType({ type: "patio" }), "patio");
});

function repairBoard(): Record<string, Row[]> {
  return {
    jobs: [
      ...mixedBoard().jobs,
      job(7, {
        type: "makesafe",
        status: "in_progress",
        job_number: "SWMS-5007",
        metadata: { ses_family: "repair" },
      }),
      job(8, {
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-5008",
        metadata: { makesafe_job_family: "repair" },
      }),
      job(9, {
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-5009",
        metadata: { ses_family: "roof_report" },
      }),
      job(10, { type: "repair", status: "accepted", job_number: "SWR-5010" }),
    ],
  };
}

Deno.test("dispatch list: a repair-family job typed makesafe is listed as a repair, a true make-safe is not", async () => {
  const { client } = makeClient(repairBoard());
  const result = await _pipelineForTest(client, params("dispatch=1"));

  const byNumber = Object.fromEntries(
    allRows(result).map((row) => [row.job_number, row]),
  );
  assertEquals(Object.keys(byNumber).sort(), [
    "SWF-1001",
    "SWF-1006",
    "SWMS-5007",
    "SWMS-5008",
    "SWP-2002",
    "SWR-5010",
  ]);
  assertEquals(result.total, 6);

  for (const number of ["SWMS-5007", "SWMS-5008"]) {
    assertEquals(byNumber[number].work_type, "repair");
    // The stored type is reported as it is, never rewritten.
    assertEquals(byNumber[number].type, "makesafe");
  }
  assertEquals(byNumber["SWR-5010"].work_type, "repair");
  assertEquals(byNumber["SWF-1001"].work_type, "fencing");

  assertEquals(
    allRows(result).filter((row) => row.work_type === "repair").length,
    3,
  );
  for (const row of allRows(result)) {
    for (const alias of DISPATCH_LIST_ALIASES) {
      assert(!(alias in row), `${alias} leaked into the response`);
    }
    assert(!("metadata" in row));
  }
});

Deno.test("dispatch list: a search returns true make-safes as make-safe and repair-family ones as repair", async () => {
  const { client } = makeClient(repairBoard());
  const result = await _pipelineForTest(
    client,
    params("dispatch=1&search=swms-"),
  );

  assertEquals(
    Object.fromEntries(
      allRows(result).map((row) => [row.job_number, row.work_type]),
    ),
    {
      "SWMS-5005": "makesafe",
      "SWMS-5007": "repair",
      "SWMS-5008": "repair",
      "SWMS-5009": "makesafe",
    },
  );
});

Deno.test("dispatch list: a search brings make-safe jobs back and reads enrichment for matches only", async () => {
  const { client, jobsReads, reads } = makeClient(mixedBoard());
  const result = await _pipelineForTest(
    client,
    params("dispatch=1&search=swms-5005"),
  );

  assertEquals(result.total, 1);
  assertEquals(result.columns.accepted[0].job_number, "SWMS-5005");
  assertEquals(result.columns.accepted[0].value_inc_gst, false);
  assertEquals(result.columns.accepted[0].work_type, "makesafe");
  assert(!jobsReads()[0].or.includes(DISPATCH_LISTED_WORK_FILTER));

  const assignmentReads = reads.filter((read) =>
    read.table === "job_assignments"
  );
  assert(assignmentReads.length > 0);
  for (const read of assignmentReads) {
    assertEquals(read.in.find(([column]) => column === "job_id")?.[1], [
      jobId(5),
    ]);
  }
});

Deno.test("dispatch list: a search still never returns a draft or a quote", async () => {
  const { client } = makeClient(mixedBoard());
  const result = await _pipelineForTest(
    client,
    params("dispatch=1&search=customer"),
  );
  assertEquals(result.total, 4);
  assert(
    allRows(result).every((row) => !["draft", "quoted"].includes(row.status)),
  );
});

Deno.test("dispatch list: every job comes back past the 1000-row ceiling the plain read stops at", async () => {
  const jobCount = 1205;
  const jobs = Array.from({ length: jobCount }, (_, index) => job(index + 1));

  const plain = await _pipelineForTest(makeClient({ jobs }).client, params(""));
  assertEquals(plain.total, ROW_CEILING);

  const dispatch = await _pipelineForTest(
    makeClient({ jobs }).client,
    params("dispatch=1"),
  );
  assertEquals(dispatch.total, jobCount);
  const numbers = new Set(allRows(dispatch).map((row) => row.job_number));
  assertEquals(numbers.size, jobCount);
  // Newest first, across the page boundary.
  const updated = dispatch.columns.scheduled.map((row: Row) => row.updated_at);
  assertEquals(updated, [...updated].sort().reverse());
});

// ── job_notes ───────────────────────────────────────────────────────────────

Deno.test("note row: text falls back through the keys live rows hold, and the author is the linked user", () => {
  assertEquals(
    projectDispatchJobNote({
      id: "n1",
      user_id: "u1",
      created_at: "2026-10-12T05:16:00+00:00",
      detail_json: {
        text: "Gate latch",
        visibility: "internal_only",
        from_ops: true,
      },
      users: { name: "Office Person" },
    }),
    {
      id: "n1",
      text: "Gate latch",
      author: "Office Person",
      user_id: "u1",
      created_at: "2026-10-12T05:16:00+00:00",
      visibility: "internal_only",
      from_ops: true,
    },
  );

  const keyed = projectDispatchJobNote({
    id: "n2",
    user_id: null,
    created_at: "2026-10-01T00:00:00+00:00",
    detail_json: { message: "From the message key" },
    users: null,
  });
  assertEquals(keyed.text, "From the message key");
  assertEquals(keyed.author, null);
  assertEquals(keyed.user_id, null);
  assertEquals(keyed.visibility, null);
  assertEquals(keyed.from_ops, false);

  assertEquals(
    projectDispatchJobNote({ detail_json: { note: "Older key" } }).text,
    "Older key",
  );
  // A server-key note: no user is no author, not a guess.
  assertEquals(
    projectDispatchJobNote({ detail_json: { text: "x" } }).author,
    null,
  );
  assertEquals(projectDispatchJobNote({ detail_json: null }).text, "");
});

function notesFixture(): Record<string, Row[]> {
  const events: Row[] = [];
  // 82 events on one job with 4 notes, 2 of them older than its newest 50
  // events: the shape job_detail.events cannot show in full.
  for (let index = 0; index < 82; index++) {
    const isNote = [3, 20, 60, 75].includes(index);
    events.push({
      id: `event-${String(index).padStart(3, "0")}`,
      job_id: jobId(1),
      user_id: null,
      event_type: isNote ? "note" : "status_changed",
      detail_json: isNote ? { text: `Note ${index}` } : {},
      created_at: new Date(Date.UTC(2026, 9, 12) - index * 3600000)
        .toISOString(),
      users: null,
    });
  }
  events.push({
    id: "other-job-note",
    job_id: jobId(2),
    user_id: null,
    event_type: "note",
    detail_json: { text: "Another job" },
    created_at: "2026-10-12T00:00:00.000Z",
    users: null,
  });
  return {
    jobs: [
      { id: jobId(1), org_id: ORG_ID, job_number: "SWP-26195" },
      { id: jobId(2), org_id: ORG_ID, job_number: "SWF-1002" },
      { id: jobId(3), org_id: ORG_ID, job_number: "SWF-1003" },
    ],
    job_events: events,
  };
}

Deno.test("job_notes: every note on the job, including those outside its newest 50 events", async () => {
  const { client } = makeClient(notesFixture());
  const result = await _jobNotesForTest(client, jobId(1));

  assertEquals(result.job_id, jobId(1));
  assertEquals(result.total, 4);
  assertEquals(
    result.notes.map((note: any) => note.text),
    ["Note 3", "Note 20", "Note 60", "Note 75"],
  );
});

Deno.test("job_notes: system marker rows are left out, so the list holds what comms_notes_count counts", async () => {
  const fixture = notesFixture();
  const marker = (id: string, text: string, hour: number): Row => ({
    id,
    job_id: jobId(3),
    user_id: null,
    event_type: "note",
    detail_json: { text },
    created_at: new Date(Date.UTC(2026, 9, 12, hour)).toISOString(),
    users: null,
  });
  fixture.job_events.push(
    marker(
      "pack-sent",
      buildPackSentMarkerText({
        invoiceNumber: "INV-0835",
        to: "builder@example.test",
        nowIso: "2026-10-12T03:00:00.000Z",
        messageId: "m1",
      }),
      3,
    ),
    marker("agent-reply", buildAgentReplyBody("Report wording revised"), 2),
    marker("human", "Called the builder about access", 1),
  );

  const result = await _jobNotesForTest(makeClient(fixture).client, jobId(3));
  assertEquals(result.total, 1);
  assertEquals(result.notes.map((note: any) => note.id), ["human"]);
});

Deno.test("job_notes: a job number resolves, and a job with no notes is an empty list", async () => {
  const byNumber = await _jobNotesForTest(
    makeClient(notesFixture()).client,
    "swp-26195",
  );
  assertEquals(byNumber.job_id, jobId(1));
  assertEquals(byNumber.total, 4);

  const empty = await _jobNotesForTest(
    makeClient(notesFixture()).client,
    jobId(3),
  );
  assertEquals(empty, { job_id: jobId(3), notes: [], total: 0 });
});

// The job number shapes the live Dispatch list returns that are not letters,
// a hyphen, then digits (7 of 315 on 12 Oct 2026).
const ODD_JOB_NUMBERS = ["SW1346", "SWF-PDF-BUCKET", "SWG-20260713-BE"];

Deno.test("job_notes: a job number of any stored shape resolves, by the whole number only", async () => {
  const fixture = notesFixture();
  ODD_JOB_NUMBERS.forEach((jobNumber, index) => {
    fixture.jobs.push({
      id: jobId(10 + index),
      org_id: ORG_ID,
      job_number: jobNumber,
    });
    fixture.job_events.push({
      id: `odd-${index}`,
      job_id: jobId(10 + index),
      user_id: null,
      event_type: "note",
      detail_json: { text: `Note on ${jobNumber}` },
      created_at: "2026-10-12T00:00:00.000Z",
      users: null,
    });
  });
  // Another org's job with the same number is never the answer.
  fixture.jobs.push({
    id: jobId(20),
    org_id: "00000000-0000-0000-0000-00000000ffff",
    job_number: "SW9999",
  });

  for (const [index, jobNumber] of ODD_JOB_NUMBERS.entries()) {
    const { client, reads } = makeClient(fixture);
    const result = await _jobNotesForTest(client, ` ${jobNumber} `);
    assertEquals(result.job_id, jobId(10 + index));
    assertEquals(result.notes.map((note: any) => note.text), [
      `Note on ${jobNumber}`,
    ]);
    // Matched with eq on the stored number: no pattern read at all.
    assert(reads.every((read) => read.ilike.length === 0));
    assert(
      reads.some((read) =>
        read.table === "jobs" &&
        read.eq.some(([column, value]) =>
          column === "job_number" && value === jobNumber
        )
      ),
    );
  }
  const lowerCase = await _jobNotesForTest(
    makeClient(fixture).client,
    "swf-pdf-bucket",
  );
  assertEquals(lowerCase.job_id, jobId(11));

  // Not a prefix, not a part, not a LIKE pattern, not another org's number.
  for (
    const reference of [
      "SW134",
      "SW13466",
      "PDF-BUCKET",
      "SWF-PDF-BUCKE_",
      "SWF_PDF_BUCKET",
      "SW%",
      "SW*",
      "SWF-100",
      "SW9999",
    ]
  ) {
    const missing = await assertRejects(
      () => _jobNotesForTest(makeClient(fixture).client, reference),
      ApiError,
    );
    assertEquals(missing.status, 404, reference);
  }
});

Deno.test("job_notes: every note comes back past the 1000-row ceiling", async () => {
  const fixture = notesFixture();
  for (let index = 0; index < 1100; index++) {
    fixture.job_events.push({
      id: `bulk-${String(index).padStart(4, "0")}`,
      job_id: jobId(3),
      user_id: null,
      event_type: "note",
      detail_json: { text: `Bulk ${index}` },
      created_at: new Date(Date.UTC(2026, 8, 1) + index * 1000).toISOString(),
      users: null,
    });
  }
  const result = await _jobNotesForTest(makeClient(fixture).client, jobId(3));
  assertEquals(result.total, 1100);
  assertEquals(new Set(result.notes.map((note: any) => note.id)).size, 1100);
  assertEquals(result.notes[0].text, "Bulk 1099");
});

Deno.test("job_notes: an unknown job is a 404 and a missing reference a 400, never an empty list", async () => {
  // A reference that is not a job id is read as a job number, so one that
  // matches no stored number is an unknown job.
  for (const reference of [jobId(99), "not-a-job", "12345"]) {
    const missing = await assertRejects(
      () => _jobNotesForTest(makeClient(notesFixture()).client, reference),
      ApiError,
    );
    assertEquals(missing.status, 404, reference);
  }

  for (const reference of ["", "   "]) {
    const bad = await assertRejects(
      () => _jobNotesForTest(makeClient(notesFixture()).client, reference),
      ApiError,
    );
    assertEquals(bad.status, 400);
  }
});

// ── The note count on a card and the notes under it ─────────────────────────

Deno.test("note rule: the three note event types, less the pack-sent and agent-reply markers", () => {
  assertEquals(JOB_NOTE_EVENT_TYPES, ["note", "note_added", "site_note"]);
  const packSent = buildPackSentMarkerText({
    invoiceNumber: "INV-0835",
    to: "builder@example.test",
    nowIso: "2026-10-12T03:00:00.000Z",
    messageId: "m1",
  });
  const agentReply = buildAgentReplyBody("Report wording revised");

  for (
    const detail_json of [
      { text: "Gate is locked" },
      { note: "Older key" },
      { message: "Only a message key" },
      { text: "Call back", note: "Call back", from_ops: true },
      { text: "MAKESAFE_PACK_PORTAL_READY | portal" },
      {},
      null,
    ]
  ) {
    assert(
      isPersonWrittenJobNote({ detail_json }),
      JSON.stringify(detail_json),
    );
  }
  for (
    const detail_json of [
      { text: packSent },
      { text: agentReply },
      { note: packSent },
      { note: agentReply },
    ]
  ) {
    assert(
      !isPersonWrittenJobNote({ detail_json }),
      JSON.stringify(detail_json),
    );
  }
});

// Every shape a note row takes on live records, on jobs the Dispatch list
// returns: the three note_added key shapes (2 and 3 Sep 2026), site_note,
// markers under either key, a body under `message`, an empty body, and events
// that are not notes.
function noteCountFixture(): Record<string, Row[]> {
  const packSent = buildPackSentMarkerText({
    invoiceNumber: "INV-0835",
    to: "builder@example.test",
    nowIso: "2026-10-12T03:00:00.000Z",
    messageId: "m1",
  });
  const agentReply = buildAgentReplyBody("Report wording revised");
  let sequence = 0;
  const event = (
    job: number,
    event_type: string,
    detail_json: Row | null,
    extra: Row = {},
  ): Row => {
    sequence += 1;
    return {
      id: `count-${String(sequence).padStart(3, "0")}`,
      job_id: jobId(job),
      user_id: null,
      event_type,
      detail_json,
      created_at: new Date(Date.UTC(2026, 8, 2) + sequence * 60000)
        .toISOString(),
      users: null,
      ...extra,
    };
  };
  return {
    jobs: [
      // The SWF-261279 shape: three notes and one Ops screen note_added.
      job(1),
      job(2, { job_number: "SW1346" }),
      job(3, { job_number: "SWF-PDF-BUCKET", type: "patio" }),
      job(4, { job_number: "SWG-20260713-BE" }),
      // A repair-family job typed make-safe is listed, markers and all.
      job(5, { type: "makesafe", metadata: { ses_family: "repair" } }),
      job(6),
      // Not listed: a true make-safe, and a draft.
      job(7, { type: "makesafe" }),
      job(8, { status: "draft" }),
    ],
    job_events: [
      event(1, "note", { text: "First", visibility: "internal_only" }),
      event(1, "note", { text: "Second" }, {
        user_id: "u1",
        users: { name: "Office Person" },
      }),
      event(1, "note", { text: "Third" }),
      event(1, "note_added", {
        from_ops: true,
        note: "From the Ops screen",
        source: "ops",
        text: "From the Ops screen",
        visibility: "internal_only",
      }),
      event(1, "status_changed", { text: "Not a note" }),
      event(2, "note_added", {
        from_ops: true,
        note: "No source key",
        text: "No source key",
        visibility: "client_visible",
      }),
      event(2, "note_added", { note: "Only the note key" }),
      event(3, "site_note", { text: "Side gate code on the fridge" }),
      event(3, "note", { message: "Only the message key" }),
      event(3, "note", {}),
      event(4, "note_added", { text: packSent }),
      event(4, "site_note", { note: agentReply }),
      event(5, "note", { text: packSent }),
      event(5, "note", { text: agentReply }),
      event(5, "note_added", { note: packSent }),
      event(5, "note", { text: "Called the builder about access" }),
      event(5, "note", { text: "MAKESAFE_PACK_PORTAL_READY | portal" }),
      event(7, "note", { text: "On a job that is not listed" }),
      event(8, "note_added", { text: "On a draft" }),
    ],
  };
}

Deno.test("job_notes: note_added and site_note rows come back in the note shape, newest first", async () => {
  const { client, reads } = makeClient(noteCountFixture());
  const first = await _jobNotesForTest(client, jobId(1));
  assertEquals(first.total, 4);
  assertEquals(first.notes[0], {
    id: "count-004",
    text: "From the Ops screen",
    author: null,
    user_id: null,
    created_at: "2026-09-02T00:04:00.000Z",
    visibility: "internal_only",
    from_ops: true,
  });
  assertEquals(
    first.notes.map((note: any) => note.text),
    ["From the Ops screen", "Third", "Second", "First"],
  );
  const notesRead = reads.find((read) => read.table === "job_events");
  assertEquals(notesRead?.in, [["event_type", JOB_NOTE_EVENT_TYPES]]);

  const second = await _jobNotesForTest(client, "SW1346");
  assertEquals(
    second.notes.map((
      note: any,
    ) => [note.text, note.visibility, note.from_ops]),
    [
      ["Only the note key", null, false],
      ["No source key", "client_visible", true],
    ],
  );

  const third = await _jobNotesForTest(client, jobId(3));
  assertEquals(
    third.notes.map((note: any) => note.text),
    ["", "Only the message key", "Side gate code on the fridge"],
  );

  // A marker is a marker whichever note type and key it was stored under.
  assertEquals((await _jobNotesForTest(client, jobId(4))).total, 0);
  assertEquals(
    (await _jobNotesForTest(client, jobId(5))).notes.map((note: any) =>
      note.text
    ),
    ["MAKESAFE_PACK_PORTAL_READY | portal", "Called the builder about access"],
  );
});

Deno.test("the list's note count and job_notes agree on every listed job, by id and by job number", async () => {
  const { client } = makeClient(noteCountFixture());
  const listed = allRows(
    await _pipelineForTest(client, params("dispatch=1")),
  );
  assertEquals(
    Object.fromEntries(
      listed.map((row) => [row.job_number, row.comms_notes_count]),
    ),
    {
      "SWF-1001": 4,
      "SW1346": 2,
      "SWF-PDF-BUCKET": 3,
      "SWG-20260713-BE": 0,
      "SWF-1005": 2,
      "SWF-1006": 0,
    },
  );
  for (const row of listed) {
    for (const reference of [row.id, row.job_number]) {
      const notes = await _jobNotesForTest(client, reference);
      assertEquals(notes.job_id, row.id, reference);
      assertEquals(notes.total, row.comms_notes_count, reference);
      assertEquals(notes.notes.length, row.comms_notes_count, reference);
    }
  }
});

Deno.test("pipeline without the flag: the note count follows the same note rule, and no Dispatch key appears", async () => {
  const { client } = makeClient(noteCountFixture());
  const rows = allRows(await _pipelineForTest(client, params("")));
  assertEquals(
    Object.fromEntries(
      rows.map((row) => [row.job_number, row.comms_notes_count]),
    ),
    {
      "SWF-1001": 4,
      "SW1346": 2,
      "SWF-PDF-BUCKET": 3,
      "SWG-20260713-BE": 0,
      "SWF-1005": 2,
      "SWF-1006": 0,
      // The plain read keeps the true make-safe, and counts its note.
      "SWF-1007": 1,
      // It keeps the draft too, but has never read enrichment for a draft, so
      // the draft's one note_added stays uncounted, as before this fix.
      "SWF-1008": 0,
    },
  );
  for (const row of rows) {
    assert(!("description" in row));
    assert(!("value_inc_gst" in row));
    assert(!("work_type" in row));
  }
});

// ── Who may call ────────────────────────────────────────────────────────────

Deno.test("job_notes and the Dispatch list are staff reads: a trade session is refused", () => {
  const urls = [
    "https://example.test/functions/v1/ops-api?action=job_notes&jobId=" +
    jobId(1),
    "https://example.test/functions/v1/ops-api?action=pipeline&dispatch=1",
  ];
  for (const href of urls) {
    const url = new URL(href);
    for (const role of ["admin", "owner", "ops_manager"]) {
      assertEquals(
        _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }),
        { ok: true },
      );
    }
    for (
      const authUser of [
        { role: "installer" },
        { role: "lead_installer", managedVerticals: ["fencing"] },
      ]
    ) {
      const refused = _authorizeOpsApiAction({
        url,
        authMode: "jwt",
        authUser,
      });
      assertEquals(refused.ok, false);
      assertEquals((refused as any).status, 403);
      assertEquals((refused as any).code, "operator_access_required");
    }
    // No credential at all is a 401: there is no session to judge a role on.
    const anonymous = _authorizeOpsApiAction({ url, authMode: "none" });
    assertEquals(anonymous.ok, false);
    assertEquals((anonymous as any).status, 401);
    assertEquals((anonymous as any).code, "user_jwt_required");
  }
  assert(!LEAD_INSTALLER_READ_ACTIONS.has("job_notes"));
  assert(!AGENT_READ_ALLOWED_ACTIONS.has("job_notes"));
});
