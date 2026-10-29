// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch v2 board (dispatch_board.ts, docs/dispatch-v2-board-contract.md):
// which jobs the list shows and where, the card fields, the moves the header
// rail offers, the Arrival line, and that plain `pipeline&dispatch=1` callers
// get exactly what they got before.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _authorizeOpsApiAction,
  _perthTodayYmd,
  _pipelineForTest,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} from "./index.ts";
import {
  addDays,
  DISPATCH_BOARD_ACTIVE_FILTER,
  DISPATCH_BOARD_STATUSES,
  dispatchArrival,
  DispatchArrivalError,
  dispatchArrivalRead,
  dispatchBoardDeposit,
  dispatchBoardGroups,
  dispatchBoardInArchiveWindow,
  dispatchBoardInstall,
  dispatchBoardMoves,
  dispatchBoardPlacement,
  dispatchBoardRequest,
  dispatchBoardStage,
  dispatchBoardStageSince,
  perthDayOf,
} from "./dispatch_board.ts";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const ROW_CEILING = 1000;
const TODAY = _perthTodayYmd();

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
    status: "order_materials",
    client_name: `Customer Number${index}`,
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
    ds_ses_family: metadata?.ses_family ?? null,
    ds_makesafe_family: metadata?.makesafe_job_family ?? null,
    ds_repair_stage: metadata?.repair_stage ?? null,
    metadata,
    ...overrides,
  };
}

function booking(index: number, day: string, overrides: Row = {}): Row {
  return {
    id: `b-${index}-${day}-${overrides.user_id ?? "u1"}`,
    job_id: jobId(index),
    user_id: "u1",
    scheduled_date: day,
    scheduled_end: null,
    assignment_type: "install",
    status: "scheduled",
    is_ghost: false,
    role: null,
    is_lead: true,
    confirmation_status: "tentative",
    person: { name: "Henry" },
    ...overrides,
  };
}

// Split a flat PostgREST `or` on its top-level commas (an `in.(a,b)` list
// keeps its own commas).
function orTerms(filter: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of filter) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      terms.push(current);
      current = "";
    } else current += ch;
  }
  if (current) terms.push(current);
  return terms;
}

function orTermMatches(row: Row, term: string): boolean {
  const parsed =
    /^(\w+)(?:->>(\w+))?\.(not\.is\.null|is\.null|eq|neq|in)(?:\.(.*))?$/
      .exec(term);
  if (!parsed) throw new Error(`unsupported or term: ${term}`);
  const [, column, key, operator, value] = parsed;
  const actual = (key ? row[column]?.[key] : row[column]) ?? null;
  if (operator === "is.null") return actual === null;
  if (operator === "not.is.null") return actual !== null;
  if (actual === null) return false;
  if (operator === "in") {
    return value.replace(/^\(|\)$/g, "").split(",").includes(String(actual));
  }
  return operator === "eq"
    ? String(actual) === value
    : String(actual) !== value;
}

// A PostgREST stand-in: it applies the filters these reads use, records each
// read, can fail a table, and has no write method at all (a write would throw).
function makeClient(
  tables: Record<string, Row[]>,
  options: { fail?: string[] } = {},
) {
  const reads: Array<{ table: string; select: string; or: string[]; in: Array<[string, unknown[]]> }> = [];

  function from(table: string) {
    const read = {
      table,
      select: "",
      eq: [] as Array<[string, unknown]>,
      neq: [] as Array<[string, unknown]>,
      in: [] as Array<[string, unknown[]]>,
      gte: [] as Array<[string, string]>,
      lt: [] as Array<[string, string]>,
      or: [] as string[],
    };
    reads.push(read);
    const orders: Array<[string, boolean]> = [];
    let rowLimit: number | null = null;
    const failed = () => (options.fail || []).includes(table);

    const apply = (): Row[] => {
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
      for (const [column, value] of read.gte) {
        rows = rows.filter((row) => String(row[column] ?? "") >= value);
      }
      for (const [column, value] of read.lt) {
        rows = rows.filter((row) => String(row[column] ?? "") < value);
      }
      for (const filter of read.or) {
        rows = rows.filter((row) =>
          orTerms(filter).some((term) => orTermMatches(row, term))
        );
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
    const result = (data: unknown) =>
      failed()
        ? { data: null, error: { message: `${table} is not there` } }
        : { data, error: null };

    const builder: any = {
      select: (columns: string) => {
        read.select = columns;
        return builder;
      },
      eq: (c: string, v: unknown) => (read.eq.push([c, v]), builder),
      neq: (c: string, v: unknown) => (read.neq.push([c, v]), builder),
      in: (c: string, v: unknown[]) => (read.in.push([c, v]), builder),
      gte: (c: string, v: string) => (read.gte.push([c, v]), builder),
      lt: (c: string, v: string) => (read.lt.push([c, v]), builder),
      ilike: () => builder,
      not: () => builder,
      is: () => builder,
      or: (f: string) => (read.or.push(f), builder),
      order: (column: string, o?: { ascending?: boolean }) => {
        orders.push([column, o?.ascending !== false]);
        return builder;
      },
      limit: (n: number) => ((rowLimit = n), builder),
      range: (start: number, end: number) =>
        Promise.resolve(
          result(apply().slice(start, Math.min(end + 1, start + ROW_CEILING))),
        ),
      maybeSingle: () => Promise.resolve(result(apply()[0] ?? null)),
      then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
        Promise.resolve(result(apply().slice(0, ROW_CEILING))).then(
          resolve,
          reject,
        ),
    };
    return builder;
  }
  return { client: { from }, reads };
}

const params = (query: string) => new URLSearchParams(query);

function allRows(result: any): Row[] {
  return Object.values(result.columns).flat() as Row[];
}

function rowFor(result: any, index: number): Row | undefined {
  return allRows(result).find((row) => row.id === jobId(index));
}

// ── The request ─────────────────────────────────────────────────────────────

Deno.test("request: board=v2 only counts on the Dispatch list, and the view defaults to Active", () => {
  assertEquals(dispatchBoardRequest(params("dispatch=1")), null);
  assertEquals(dispatchBoardRequest(params("board=v2")), null);
  assertEquals(dispatchBoardRequest(params("dispatch=1&board=v1")), null);
  assertEquals(dispatchBoardRequest(params("dispatch=1&board=v2")), {
    view: "active",
  });
  assertEquals(
    dispatchBoardRequest(params("dispatch=1&board=v2&view=archive")),
    { view: "archive" },
  );
  assertEquals(
    dispatchBoardRequest(params("dispatch=1&board=v2&view=nonsense")),
    { view: "active" },
  );
});

// ── Stages ──────────────────────────────────────────────────────────────────

Deno.test("stage: the seven real statuses are the board, in pipeline order", () => {
  const seen = DISPATCH_BOARD_STATUSES.map((status) =>
    dispatchBoardStage(job(1, { status }))
  );
  assertEquals(seen.map((s) => s?.label), [
    "Order Materials",
    "Awaiting Supplier",
    "Order Confirmed",
    "Schedule Install",
    "Scheduled",
    "In Progress",
    "Rectification",
  ]);
  assertEquals(seen.map((s) => s?.order), [1, 2, 3, 4, 5, 6, 7]);
  assert(seen.every((s) => s?.track === "pipeline" && s.phase === "window"));
});

Deno.test("stage: nothing earlier, no legacy processing, no make-safe and no other type", () => {
  for (
    const status of [
      "draft",
      "quoted",
      "accepted",
      "awaiting_deposit",
      "deposit",
      "approvals",
      "processing",
    ]
  ) {
    assertEquals(dispatchBoardStage(job(1, { status })), null, status);
  }
  for (const type of ["makesafe", "insurance", "miscellaneous"]) {
    assertEquals(
      dispatchBoardStage(job(1, { type, status: "scheduled" })),
      null,
      type,
    );
  }
  for (const type of ["patio", "decking"]) {
    assertEquals(
      dispatchBoardStage(job(1, { type, status: "scheduled" }))?.key,
      "scheduled",
    );
  }
});

Deno.test("stage: a job past Rectification is 'after' (Archive only)", () => {
  for (const status of ["complete", "final_payment", "invoiced", "archived"]) {
    const stage = dispatchBoardStage(job(1, { status }));
    assertEquals(stage?.phase, "after", status);
    assertEquals(stage?.order, 0);
  }
});

Deno.test("stage: a repair is placed by its Repairs board stage, a stamp winning over the status", () => {
  const stamped = (repair_stage: string, status = "approvals") =>
    dispatchBoardStage(job(1, {
      type: "makesafe",
      status,
      metadata: { makesafe_job_family: "repair", repair_stage },
    }));
  assertEquals(stamped("materials")?.track, "repairs");
  assertEquals(stamped("materials")?.label, "Materials");
  assertEquals(stamped("scheduled")?.order, 2);
  assertEquals(stamped("approved", "order_materials"), null);
  assertEquals(stamped("on_site")?.phase, "after");
  // No stamp: the status says the stage.
  const unstamped = dispatchBoardStage(job(1, {
    type: "repair",
    status: "awaiting_supplier",
  }));
  assertEquals(unstamped?.key, "materials");
  assertEquals(dispatchBoardStage(job(1, { type: "repair", status: "accepted" })), null);
});

// ── Install and placement ───────────────────────────────────────────────────

Deno.test("install: none booked, a multi-day booking, tentative, and rows that are not installs", () => {
  assertEquals(dispatchBoardInstall([], TODAY).booked, false);
  const day1 = addDays(TODAY, 2);
  const install = dispatchBoardInstall([
    booking(1, day1, { scheduled_end: addDays(TODAY, 4) }),
    booking(1, addDays(TODAY, -9), { status: "cancelled" }),
    booking(1, addDays(TODAY, 9), { is_ghost: true }),
    booking(1, addDays(TODAY, 9), { role: "observer", user_id: "u2" }),
    booking(1, addDays(TODAY, 9), { assignment_type: "scope", user_id: "u3" }),
  ] as any, TODAY);
  assertEquals(install.booked, true);
  assertEquals(install.day, day1);
  assertEquals(install.first_day, day1);
  assertEquals(install.last_day, addDays(TODAY, 4));
  assertEquals(install.archive_on, addDays(TODAY, 5));
  assertEquals(install.passed, false);
  assertEquals(install.tentative, true);
  const confirmed = dispatchBoardInstall(
    [booking(1, addDays(TODAY, -1), { confirmation_status: "confirmed" })] as any,
    TODAY,
  );
  assertEquals(confirmed.passed, true);
  assertEquals(confirmed.tentative, false);
});

Deno.test("placement: Scheduled leaves for Archive the day after its last install day", () => {
  const scheduled = dispatchBoardStage(job(1, { status: "scheduled" }))!;
  const at = (day: string, end: string | null = null) =>
    dispatchBoardPlacement(
      scheduled,
      dispatchBoardInstall([booking(1, day, { scheduled_end: end })] as any, TODAY),
    );
  assertEquals(at(TODAY), "active");
  assertEquals(at(addDays(TODAY, -1)), "archive");
  // A two-day install that ends today is still on.
  assertEquals(at(addDays(TODAY, -1), TODAY), "active");
  // Nothing booked: stays in Scheduled.
  assertEquals(
    dispatchBoardPlacement(scheduled, dispatchBoardInstall([], TODAY)),
    "active",
  );
  // The bookings read failed: never hidden.
  assertEquals(dispatchBoardPlacement(scheduled, null), "active");
});

Deno.test("placement: an earlier stage stays Active after its install day; a job past Rectification needs a booking", () => {
  const ordering = dispatchBoardStage(job(1, { status: "order_materials" }))!;
  const gone = dispatchBoardInstall([booking(1, addDays(TODAY, -3))] as any, TODAY);
  assertEquals(dispatchBoardPlacement(ordering, gone), "active");
  // In Progress and Rectification stay Active whatever the install day, with
  // or without a booking (Shaun, 27 Oct 2026: extras are ordered there).
  for (const status of ["in_progress", "rectification"]) {
    const onSite = dispatchBoardStage(job(1, { status }))!;
    assertEquals(dispatchBoardPlacement(onSite, gone), "active", status);
    assertEquals(
      dispatchBoardPlacement(onSite, dispatchBoardInstall([], TODAY)),
      "active",
    );
    assertEquals(dispatchBoardPlacement(onSite, null), "active");
  }
  const after = dispatchBoardStage(job(1, { status: "complete" }))!;
  assertEquals(dispatchBoardPlacement(after, gone), "archive");
  assertEquals(
    dispatchBoardPlacement(after, dispatchBoardInstall([], TODAY)),
    null,
  );
  assertEquals(dispatchBoardPlacement(after, null), null);
});

Deno.test("archive window: 30 days by the last install day, any age for a search", () => {
  const at = (days: number) =>
    dispatchBoardInstall([booking(1, addDays(TODAY, -days))] as any, TODAY);
  assert(dispatchBoardInArchiveWindow(at(30), TODAY, false));
  assert(!dispatchBoardInArchiveWindow(at(31), TODAY, false));
  assert(dispatchBoardInArchiveWindow(at(400), TODAY, true));
});

// ── Days in stage ───────────────────────────────────────────────────────────

Deno.test("days in stage: from the change that moved the job in; a re-save does not restart it, a move back in does", () => {
  const stage = dispatchBoardStage(job(1, { status: "awaiting_supplier" }))!;
  const ev = (at: string, status: string) => ({
    event_type: "status_changed",
    created_at: at,
    ev_status: status,
  });
  const events = [
    ev("2026-09-01T02:00:00Z", "order_materials"),
    ev("2026-09-03T02:00:00Z", "awaiting_supplier"),
    ev("2026-09-04T02:00:00Z", "awaiting_supplier"),
  ];
  assertEquals(
    dispatchBoardStageSince(job(1, { status: "awaiting_supplier" }), stage, events),
    { since: "2026-09-03T02:00:00Z", source: "status_event" },
  );
  const back = [
    ...events,
    ev("2026-09-05T02:00:00Z", "order_confirmed"),
    ev("2026-09-07T02:00:00Z", "awaiting_supplier"),
  ];
  assertEquals(
    dispatchBoardStageSince(job(1, { status: "awaiting_supplier" }), stage, back)
      .since,
    "2026-09-07T02:00:00Z",
  );
});

Deno.test("days in stage: Scheduled falls back to its stamp, anything else with no event is unknown", () => {
  const scheduled = job(1, { status: "scheduled", scheduled_at: "2026-09-02T00:00:00Z" });
  assertEquals(
    dispatchBoardStageSince(scheduled, dispatchBoardStage(scheduled)!, []),
    { since: "2026-09-02T00:00:00Z", source: "status_stamp" },
  );
  const ordering = job(1, { status: "order_materials" });
  assertEquals(
    dispatchBoardStageSince(ordering, dispatchBoardStage(ordering)!, []),
    { since: null, source: "unknown" },
  );
});

Deno.test("days in stage: a stamped repair reads its Repairs stage changes, an unstamped one its status changes", () => {
  const stamped = job(1, {
    type: "repair",
    status: "approvals",
    metadata: { repair_stage: "materials" },
  });
  assertEquals(
    dispatchBoardStageSince(stamped, dispatchBoardStage(stamped)!, [
      { event_type: "repair_stage_changed", created_at: "2026-09-10T00:00:00Z", ev_stage: "materials" },
      { event_type: "status_changed", created_at: "2026-09-12T00:00:00Z", ev_status: "approvals" },
    ]),
    { since: "2026-09-10T00:00:00Z", source: "repair_stage_event" },
  );
  const unstamped = job(1, { type: "repair", status: "order_confirmed" });
  assertEquals(
    dispatchBoardStageSince(unstamped, dispatchBoardStage(unstamped)!, [
      { event_type: "status_changed", created_at: "2026-09-01T00:00:00Z", ev_status: "approvals" },
      { event_type: "status_changed", created_at: "2026-09-02T00:00:00Z", ev_status: "order_materials" },
      // Same Repairs stage (Materials): the count does not restart.
      { event_type: "status_changed", created_at: "2026-09-05T00:00:00Z", ev_status: "order_confirmed" },
    ]).since,
    "2026-09-02T00:00:00Z",
  );
});

Deno.test("perth day: a UTC evening is the next Perth day", () => {
  assertEquals(perthDayOf("2026-09-01T17:00:00Z"), "2026-09-02");
  assertEquals(perthDayOf("2026-09-01T15:59:00Z"), "2026-09-01");
  assertEquals(perthDayOf(null), null);
});

// ── Deposit and moves ───────────────────────────────────────────────────────

Deno.test("deposit: paid, not paid, unknown when the invoice read failed, not required on a repair", () => {
  assertEquals(dispatchBoardDeposit("fencing", { deposit_paid: true }, true).state, "paid");
  assertEquals(dispatchBoardDeposit("patio", { deposit_paid: false }, true).state, "not_paid");
  assertEquals(dispatchBoardDeposit("patio", null, true).state, "not_paid");
  assertEquals(dispatchBoardDeposit("fencing", { deposit_paid: true }, false), {
    required: true,
    paid: null,
    state: "unknown",
  });
  assertEquals(dispatchBoardDeposit("repair", null, true).state, "not_required");
});

Deno.test("moves: every other board status, forwards and backwards, through update_job_status", () => {
  const moves = dispatchBoardMoves(
    dispatchBoardStage(job(1, { status: "order_confirmed" }))!,
  )!;
  assertEquals(moves.action, "update_job_status");
  assertEquals(moves.field, "status");
  assertEquals(moves.current, "order_confirmed");
  assertEquals(
    moves.targets.map((t) => [t.key, t.direction]),
    [
      ["order_materials", "back"],
      ["awaiting_supplier", "back"],
      ["schedule_install", "forward"],
      ["scheduled", "forward"],
      ["in_progress", "forward"],
      ["rectification", "forward"],
    ],
  );
  const repair = dispatchBoardMoves(dispatchBoardStage(job(1, {
    type: "repair",
    status: "x",
    metadata: { repair_stage: "scheduled" },
  }))!)!;
  assertEquals(repair.action, "update_repair_stage");
  assertEquals(repair.field, "stage");
  assertEquals(repair.targets, [{ key: "materials", label: "Materials", direction: "back" }]);
  assertEquals(
    dispatchBoardMoves(dispatchBoardStage(job(1, { status: "complete" }))!),
    null,
  );
});

// ── Arrival ─────────────────────────────────────────────────────────────────

Deno.test("arrival: solid when confirmed, ring when not, red when sent with no date or arriving after the install", () => {
  const install = addDays(TODAY, 10);
  const arrival = dispatchArrival({
    today: TODAY,
    installDay: install,
    boxes: [
      { supplier_id: "s1", supplier_name: "Stratco", position: 0, delivery_date: addDays(TODAY, 3), delivery_date_confirmed_at: "2026-10-01T00:00:00Z" },
      { supplier_id: "s2", supplier_name: "Metroll", position: 1, delivery_date: addDays(TODAY, 5) },
      { supplier_id: "s3", supplier_name: "Bunnings", position: 2 },
      { supplier_id: "s4", supplier_name: "Late Co", position: 3, delivery_date: addDays(TODAY, 12), delivery_date_confirmed_at: "2026-10-01T00:00:00Z" },
      { supplier_id: "s5", supplier_name: "Draft Co", position: 4 },
    ],
    sentEmails: ["s1", "s2", "s3", "s4"].map((supplier_id) => ({
      supplier_id,
      status: "sent",
      sent_at: "2026-09-30T00:00:00Z",
    })).concat([
      // A held draft and a test copy are not an order sent.
      { supplier_id: "s5", status: "draft", sent_at: null as any },
    ]),
    orders: [],
  });
  assertEquals(
    arrival.orders.map((o) => [o.supplier_name, o.mark, o.flag, o.order_sent]),
    [
      ["Stratco", "solid", null, true],
      ["Metroll", "ring", null, true],
      ["Bunnings", "none", "no_date", true],
      ["Late Co", "solid", "after_install", true],
      ["Draft Co", "none", "not_sent", false],
    ],
  );
  assertEquals(arrival.counts, { orders: 5, sent: 4, confirmed: 2, late: 2, open: 5, on_us: 1, extra_open: 0 });
  assertEquals(arrival.all_confirmed_in_time, false);
  // The install day itself is in time.
  const onDay = dispatchArrival({
    today: TODAY,
    installDay: install,
    boxes: [{ supplier_id: "s1", supplier_name: "Stratco", delivery_date: install, delivery_date_confirmed_at: "2026-10-01T00:00:00Z" }],
    orders: [],
  });
  assertEquals(onDay.orders[0].flag, null);
  assertEquals(onDay.all_confirmed_in_time, true);
});

Deno.test("arrival: with no date on the box, the date our sent email asked for is a ring, never confirmed", () => {
  const arrival = dispatchArrival({
    today: TODAY,
    installDay: addDays(TODAY, 10),
    boxes: [{ supplier_id: "s1", supplier_name: "Stratco" }],
    sentEmails: [
      { supplier_id: "s1", status: "sent", sent_at: "2026-09-30T00:00:00Z", delivery_date: addDays(TODAY, 4) },
      { supplier_id: "s1", status: "sent", sent_at: "2026-10-02T00:00:00Z", delivery_date: addDays(TODAY, 6) },
    ],
    orders: [],
  });
  const [order] = arrival.orders;
  assertEquals(order.delivery_date, addDays(TODAY, 6));
  assertEquals(order.date_source, "requested");
  assertEquals(order.date_confirmed, false);
  assertEquals(order.mark, "ring");
  assertEquals(order.sent_at, "2026-10-02T00:00:00Z");
});

Deno.test("arrival: a box says pickup when its newest sent email opened for pickup; a PO says nothing", () => {
  const arrival = dispatchArrival({
    today: TODAY,
    installDay: addDays(TODAY, 10),
    boxes: [
      { supplier_id: "s1", supplier_name: "Lysaght" },
      { supplier_id: "s2", supplier_name: "Stratco" },
      { supplier_id: "s3", supplier_name: "Twinside" },
    ],
    sentEmails: [
      { supplier_id: "s1", status: "sent", sent_at: "2026-09-30T00:00:00Z", delivery_date: addDays(TODAY, 4), body_text: "Hi Team, could we please order the following for delivery:\n1. x" },
      { supplier_id: "s1", status: "sent", sent_at: "2026-10-02T00:00:00Z", delivery_date: addDays(TODAY, 6), body_text: "Hi Team, could we please order the following for pickup:\n1. x" },
      { supplier_id: "s2", status: "sent", sent_at: "2026-10-02T00:00:00Z", delivery_date: addDays(TODAY, 6), body_text: "Hi Team, could we please order the following for delivery:\n1. x" },
    ],
    orders: [
      { id: "po2", job_id: "j", supplier_id: "s9", supplier_name: "Xero Supplier", source: null, status: "draft", po_type: null, delivery_date: "2026-11-06", confirmed_delivery_date: null },
    ],
  });
  assertEquals(
    arrival.orders.map((o) => [o.key, o.fulfilment]),
    [
      ["box:s1", "pickup"],
      ["box:s2", "delivery"],
      ["box:s3", null],
      ["po:po2", null],
    ],
  );
});

Deno.test("arrival: a box falls back to its v1 Dispatch order, other material orders are listed, cancelled and labour orders are not", () => {
  const arrival = dispatchArrival({
    today: TODAY,
    installDay: null,
    boxes: [{ supplier_id: "s1", supplier_name: "Stratco", position: 0 }],
    orders: [
      { id: "po1", job_id: "j", supplier_id: "s1", supplier_name: "Stratco", source: "dispatch", status: "sent", po_type: "material", delivery_date: "2026-11-04", confirmed_delivery_date: "2026-11-04" },
      { id: "po2", job_id: "j", supplier_id: "s9", supplier_name: "Xero Supplier", source: null, status: "draft", po_type: null, delivery_date: "2026-11-06", confirmed_delivery_date: null },
      { id: "po3", job_id: "j", supplier_id: "s8", supplier_name: "Gone", source: null, status: "cancelled", po_type: "material" },
      { id: "po4", job_id: "j", supplier_id: "s7", supplier_name: "Labour", source: null, status: "sent", po_type: "labour" },
    ],
  });
  assertEquals(
    arrival.orders.map((o) => [o.key, o.source, o.delivery_date, o.date_confirmed, o.order_sent]),
    [
      ["box:s1", "supplier_box", "2026-11-04", true, true],
      ["po:po2", "other_order", "2026-11-06", false, false],
    ],
  );
});

// ── Groups ──────────────────────────────────────────────────────────────────

Deno.test("groups: Active has every stage in pipeline order then the repairs; Archive is newest first", () => {
  const rows = [
    { id: "a", board: { track: "pipeline", stage_key: "scheduled", install: { day: "2026-11-05" }, job_number: "SWF-2" } },
    { id: "b", board: { track: "pipeline", stage_key: "scheduled", install: { day: "2026-11-01" }, job_number: "SWF-3" } },
    { id: "c", board: { track: "pipeline", stage_key: "scheduled", install: null, job_number: "SWF-1" } },
    { id: "d", board: { track: "pipeline", stage_key: "order_materials", days_in_stage: 2, job_number: "SWF-4" } },
    { id: "e", board: { track: "pipeline", stage_key: "order_materials", days_in_stage: 9, job_number: "SWF-5" } },
    { id: "f", board: { track: "repairs", stage_key: "materials", job_number: "SWR-1" } },
  ];
  const groups = dispatchBoardGroups(rows, "active");
  assertEquals(groups.map((g) => g.key), [
    "order_materials",
    "awaiting_supplier",
    "order_confirmed",
    "schedule_install",
    "scheduled",
    "in_progress",
    "rectification",
    "repair_materials",
    "repair_scheduled",
  ]);
  assertEquals(groups[0].job_ids, ["e", "d"]);
  assertEquals(groups[4].job_ids, ["b", "a", "c"]);
  assertEquals(groups[5].label, "In Progress");
  assertEquals(groups[6].label, "Rectification");
  assertEquals(groups[7].label, "Repairs: Materials");
  assertEquals(groups[8].count, 0);
  const archive = dispatchBoardGroups([
    { id: "x", board: { install: { last_day: "2026-10-01" } } },
    { id: "y", board: { install: { last_day: "2026-10-09" } } },
  ], "archive");
  assertEquals(archive.map((g) => g.job_ids), [["y", "x"]]);
});

// ── The list read (pipeline) ────────────────────────────────────────────────

function boardFixture() {
  const jobs = [
    job(1, { status: "order_materials" }),
    job(2, { status: "accepted" }),
    job(3, { status: "scheduled", type: "patio", client_name: "Jane Mary Smith" }),
    job(4, { status: "scheduled", type: "makesafe" }),
    job(5, { status: "scheduled", type: "insurance" }),
    job(6, { status: "approvals", type: "makesafe", metadata: { makesafe_job_family: "repair", repair_stage: "materials" } }),
    job(7, { status: "approvals", type: "makesafe", metadata: { makesafe_job_family: "repair", repair_stage: "approved" } }),
    job(8, { status: "scheduled", client_name: "Test Customer" }),
    job(9, { status: "scheduled" }),
    job(10, { status: "in_progress" }),
    job(11, { status: "scheduled" }),
    job(12, { status: "processing" }),
    job(13, { status: "complete" }),
  ];
  return {
    jobs,
    job_assignments: [
      booking(3, addDays(TODAY, 2)),
      booking(9, addDays(TODAY, -1)),
      booking(10, addDays(TODAY, -3)),
      booking(13, addDays(TODAY, -45)),
    ],
    xero_invoices: [
      { job_id: jobId(1), status: "PAID", invoice_type: "ACCREC", reference: "SWF-1001 DEP" },
    ],
    job_events: [
      { id: "e1", job_id: jobId(1), event_type: "status_changed", created_at: `${addDays(TODAY, -4)}T02:00:00Z`, ev_status: "order_materials" },
    ],
    job_dispatch_state: [
      // v1's own rail must never put a job on the v2 board.
      { job_id: jobId(2), stage: "materials" },
    ],
    job_material_suppliers: [
      { id: "box1", job_id: jobId(3), supplier_id: "s1", supplier_name: "Stratco", position: 0, created_at: "2026-10-01T00:00:00Z", delivery_date: addDays(TODAY, 1), delivery_date_confirmed_at: "2026-10-20T00:00:00Z", delivery_date_source: "by_hand" },
    ],
    dispatch_supplier_order_emails: [
      { id: "em1", job_id: jobId(3), supplier_id: "s1", status: "sent", sent_at: "2026-10-19T00:00:00Z", delivery_date: addDays(TODAY, 1) },
    ],
    purchase_orders: [],
    // Stratco is on account (Shaun, 29 Oct 2026), so its confirmed date is
    // not held by the payment gate.
    dispatch_approved_supplier_emails: [
      { id: "ap1", org_id: ORG_ID, name: "Stratco WA", active: true, on_account: true },
    ],
    dispatch_approved_supplier_email_links: [
      { supplier_id: "s1", approved_id: "ap1", org_id: ORG_ID },
    ],
  };
}

Deno.test("pipeline: plain dispatch=1 is unchanged (no board, no v2 filter)", async () => {
  const { client, reads } = makeClient(boardFixture());
  const result: any = await _pipelineForTest(client as any, params("dispatch=1"));
  assertEquals("board" in result, false);
  assert(allRows(result).every((row) => !("board" in row)));
  const jobsRead = reads.find((r) => r.table === "jobs" && r.select !== "id, pricing_json")!;
  assert(!jobsRead.or.includes(DISPATCH_BOARD_ACTIVE_FILTER));
  // The v1 list still shows an accepted job.
  assert(rowFor(result, 2));
  assert(!reads.some((r) => r.table === "job_material_suppliers"));
});

Deno.test("pipeline v2 Active: only board jobs, each with its card fields", async () => {
  const { client } = makeClient(boardFixture());
  const result: any = await _pipelineForTest(client as any, params("dispatch=1&board=v2"));
  const ids = allRows(result).map((row) => row.id).sort();
  // Job 10 is In Progress: on the board whatever its install day.
  assertEquals(ids, [jobId(1), jobId(11), jobId(3), jobId(6), jobId(10)].sort());
  assertEquals(result.total, 5);

  const ordering = rowFor(result, 1)!.board;
  assertEquals(ordering.title, "SWF-1001 · Customer Number1");
  assertEquals(ordering.stage_label, "Order Materials");
  assertEquals(ordering.real_status, "order_materials");
  assertEquals(ordering.days_in_stage, 4);
  assertEquals(ordering.days_in_stage_source, "status_event");
  assertEquals(ordering.deposit.state, "paid");
  assertEquals(ordering.flags.deposit_not_paid, false);
  assertEquals(ordering.install.booked, false);

  const patio = rowFor(result, 3)!.board;
  assertEquals(patio.client_name, "Jane Mary Smith");
  assertEquals(patio.suburb, "Balcatta");
  assertEquals(patio.work_type, "patio");
  assertEquals(patio.install.day, addDays(TODAY, 2));
  assertEquals(patio.flags.deposit_not_paid, true);
  assertEquals(patio.flags.no_install_booked, false);
  assertEquals(patio.arrival.orders[0].mark, "solid");
  assertEquals(patio.arrival.orders[0].order_sent, true);
  assertEquals(patio.arrival.all_confirmed_in_time, true);

  // Scheduled with nothing booked stays, with the amber flag.
  assertEquals(rowFor(result, 11)!.board.flags.no_install_booked, true);

  const repair = rowFor(result, 6)!.board;
  assertEquals(repair.track, "repairs");
  assertEquals(repair.stage_key, "materials");
  assertEquals(repair.deposit.state, "not_required");
  assertEquals(repair.moves.action, "update_repair_stage");

  assertEquals(result.board.version, "v2");
  assertEquals(result.board.view, "active");
  assertEquals(result.board.reads, { installs: "ok", days_in_stage: "ok", deposits: "ok", arrival: "ok", accounts: "ok" });
  const counts = Object.fromEntries(result.board.groups.map((g: any) => [g.key, g.count]));
  assertEquals(counts.order_materials, 1);
  assertEquals(counts.scheduled, 2);
  assertEquals(counts.in_progress, 1);
  assertEquals(counts.rectification, 0);
  assertEquals(counts.repair_materials, 1);
  const onSite = rowFor(result, 10)!.board;
  assertEquals(onSite.stage_phase, "window");
  assertEquals(onSite.view, "active");
  // A day gone by is expected once the crew has been: no red flag.
  assertEquals(onSite.flags.install_date_passed, false);
  assertEquals(onSite.moves.action, "update_job_status");
  // Waiting on us: Order Materials with nothing ordered yet. The patio is
  // confirmed with its install booked: waiting on Stratco, not on us.
  assertEquals(ordering.waiting, { on_us: true, todo: ["Order the materials"] });
  assertEquals(patio.waiting, { on_us: false, todo: [] });
  assertEquals(patio.arrival.orders[0].material_stage, "order_confirmed");
  assertEquals(patio.arrival.orders[0].waiting_on, "supplier");
  // The repair at Materials with nothing ordered is waiting on us too.
  assertEquals(repair.waiting.todo, ["Order the materials"]);
  assertEquals(result.board.waiting_on_us, 2);
  // The real columns still carry the rows.
  assertEquals(result.columns.scheduled.length, 2);
});

Deno.test("pipeline v2 Archive: the day after the install, 30 days shown, a search finds older", async () => {
  const fixture = boardFixture();
  const { client, reads } = makeClient(fixture);
  const result: any = await _pipelineForTest(client as any, params("dispatch=1&board=v2&view=archive"));
  const ids = allRows(result).map((row) => row.id).sort();
  // Job 10 is In Progress: it stays Active, never in Archive.
  assertEquals(ids, [jobId(9)]);
  assertEquals(result.board.groups.length, 1);
  assertEquals(result.board.groups[0].job_ids, [jobId(9)]);
  const archived = rowFor(result, 9)!.board;
  assertEquals(archived.view, "archive");
  assertEquals(archived.real_status, "scheduled");
  assertEquals(archived.install.archive_on, TODAY);
  // The narrowing read ran first.
  assert(reads.some((r) => r.table === "job_assignments" && r.select === "id, job_id, status"));

  // Job 13's install was 45 days ago: only a search brings it back.
  const searched: any = await _pipelineForTest(
    makeClient(fixture).client as any,
    params("dispatch=1&board=v2&view=archive&search=SWF-1013"),
  );
  assertEquals(allRows(searched).map((row) => row.id), [jobId(13)]);
  assertEquals(searched.board.archive_from, null);
});

Deno.test("pipeline v2: a search still never lists a make-safe", async () => {
  const { client } = makeClient(boardFixture());
  const result: any = await _pipelineForTest(client as any, params("dispatch=1&board=v2&search=SWF-1004"));
  assertEquals(allRows(result).length, 0);
  assertEquals(result.total, 0);
  assertEquals(result.board.total, 0);
});

Deno.test("pipeline v2: until the order emails table exists, the Arrival line says failed", async () => {
  const { client } = makeClient(boardFixture(), { fail: ["dispatch_supplier_order_emails"] });
  const result: any = await _pipelineForTest(client as any, params("dispatch=1&board=v2"));
  assertEquals(result.total, 5);
  assertEquals(result.board.reads.arrival, "failed");
  assertEquals(rowFor(result, 3)!.board.arrival, null);
});

Deno.test("pipeline v2: a failed material lines read says the Arrival line failed", async () => {
  const { client } = makeClient(boardFixture(), { fail: ["job_material_lines"] });
  const result: any = await _pipelineForTest(client as any, params("dispatch=1&board=v2"));
  assertEquals(result.total, 5);
  assertEquals(result.board.reads.arrival, "failed");
  // With no Arrival line nobody knows whether anything is ordered, so the
  // card never claims "Order the materials".
  assertEquals(rowFor(result, 1)!.board.waiting, { on_us: false, todo: [] });
});

Deno.test("pipeline v2: failed side reads are said, and never hide a job", async () => {
  const { client } = makeClient(boardFixture(), {
    fail: ["job_material_suppliers", "job_events", "xero_invoices"],
  });
  const result: any = await _pipelineForTest(client as any, params("dispatch=1&board=v2"));
  assertEquals(result.total, 5);
  assertEquals(result.board.reads, { installs: "ok", days_in_stage: "failed", deposits: "failed", arrival: "failed", accounts: "ok" });
  const ordering = rowFor(result, 1)!.board;
  assertEquals(ordering.arrival, null);
  assertEquals(ordering.days_in_stage, null);
  assertEquals(ordering.deposit.state, "unknown");
  assertEquals(ordering.flags.deposit_not_paid, false);
});

Deno.test("pipeline v2: a failed bookings read keeps Scheduled jobs Active, unflagged", async () => {
  const { client } = makeClient(boardFixture(), { fail: ["job_assignments"] });
  const result: any = await _pipelineForTest(client as any, params("dispatch=1&board=v2"));
  assert(rowFor(result, 9));
  assertEquals(rowFor(result, 9)!.board.install, null);
  assertEquals(rowFor(result, 9)!.board.flags.no_install_booked, false);
  assertEquals(result.board.reads.installs, "failed");
});

Deno.test("pipeline v2: an empty answer still carries the board summary", async () => {
  const { client } = makeClient({ jobs: [] });
  const result: any = await _pipelineForTest(client as any, params("dispatch=1&board=v2"));
  assertEquals(result.total, 0);
  assertEquals(result.board.groups.length, 9);
  assertEquals(result.board.waiting_on_us, 0);
  assertEquals(result.board.reads.arrival, "ok");
});

// ── dispatch_arrival ────────────────────────────────────────────────────────

Deno.test("dispatch_arrival: one job's install and Arrival line", async () => {
  const fixture = boardFixture();
  const { client } = makeClient(fixture);
  const answer: any = await dispatchArrivalRead(client, jobId(3), ORG_ID, TODAY);
  assertEquals(answer.job_number, "SWF-1003");
  assertEquals(answer.install.day, addDays(TODAY, 2));
  assertEquals(answer.arrival.orders.length, 1);
  assertEquals(answer.arrival_read, "ok");
  assertEquals(answer.stage.key, "scheduled");
});

Deno.test("dispatch_arrival: refuses a bad id, an unknown job and a make-safe", async () => {
  const { client } = makeClient(boardFixture());
  const err = async (id: string | null) =>
    await assertRejects(
      () => dispatchArrivalRead(client, id, ORG_ID, TODAY),
      DispatchArrivalError,
    ) as DispatchArrivalError;
  assertEquals((await err(null)).status, 400);
  assertEquals((await err("not-a-uuid")).status, 400);
  assertEquals((await err(jobId(99))).status, 404);
  const makesafe = await err(jobId(4));
  assertEquals(makesafe.status, 409);
  assertEquals(makesafe.body.code, "not_dispatch_work");
});

Deno.test("dispatch_arrival: a staff read only", () => {
  const url = new URL(
    "https://example.test/functions/v1/ops-api?action=dispatch_arrival&job_id=" + jobId(1),
  );
  assertEquals(
    _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role: "ops_manager" } }),
    { ok: true },
  );
  const refused = _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role: "installer" } });
  assertEquals(refused.ok, false);
  assert(!LEAD_INSTALLER_READ_ACTIONS.has("dispatch_arrival"));
  assert(!AGENT_READ_ALLOWED_ACTIONS.has("dispatch_arrival"));
});
