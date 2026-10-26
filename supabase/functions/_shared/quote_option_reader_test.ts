// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _dailyCoverageAuditForTest,
  _listQuotesForTest,
  _opsSummaryForTest,
  _pipelineForTest,
} from "../ops-api/index.ts";
import {
  decideQuoteOptionGroups,
  decideSupersededJob,
  dropSupersededQuoteOptions,
  loadQuoteOptionVisibility,
  openSupersessions,
  QUOTE_OPTION_OPS_READER_FLAG,
  QUOTE_OPTION_WON_STATUSES,
  type QuoteOptionEvent,
  type QuoteOptionMember,
} from "./quote_option_reader.ts";

type Row = Record<string, unknown>;

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Job 1 accepted, superseding its option job 2 (quoted). Job 3 is a draft
// genuine repeat with no events. Group 10: jobs 10 and 11 both accepted (a
// simultaneous acceptance), job 12 (quoted) superseded by job 10.
const G1 = id(1);
const G2 = id(10);
const T0 = "2026-10-19T01:00:00.000Z";

function sEvent(job: string, by: string, group: string, at = T0): Row {
  return {
    id: `ev-s-${job}-${at}`,
    job_id: job,
    event_type: "quote_option_superseded",
    created_at: at,
    detail_json: {
      superseded_by_job_id: by,
      quote_option_group_id: group,
      accepted_status: "accepted",
    },
  };
}

function uEvent(job: string, group: string, at: string): Row {
  return {
    id: `ev-u-${job}-${at}`,
    job_id: job,
    event_type: "quote_option_unsuperseded",
    created_at: at,
    detail_json: { quote_option_group_id: group },
  };
}

function job(n: number, status: string, extra: Row = {}): Row {
  return {
    id: id(n),
    org_id: ORG_ID,
    type: "fencing",
    status,
    client_name: `Customer ${n}`,
    site_suburb: "Balcatta",
    job_number: `SWF-${9000 + n}`,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    quoted_at: "2026-09-02T00:00:00.000Z",
    ghl_opportunity_id: null,
    quote_option_group_id: null,
    superseded_at: null,
    ...extra,
  };
}

function fixture(flagOn: boolean): Record<string, Row[]> {
  return {
    feature_flags: flagOn
      ? [{ flag_name: QUOTE_OPTION_OPS_READER_FLAG, enabled: true }]
      : [],
    jobs: [
      job(1, "accepted", { quote_option_group_id: G1 }),
      job(2, "quoted", { quote_option_group_id: G1, superseded_at: T0 }),
      job(3, "draft"),
      job(10, "accepted", { quote_option_group_id: G2 }),
      job(11, "accepted", { quote_option_group_id: G2 }),
      job(12, "quoted", { quote_option_group_id: G2, superseded_at: T0 }),
    ],
    job_events: [sEvent(id(2), id(1), G1), sEvent(id(12), id(10), G2)],
    job_documents: [
      { id: "doc-2", job_id: id(2), type: "quote", sent_to_client: true },
      { id: "doc-12", job_id: id(12), type: "quote", sent_to_client: true },
    ],
  };
}

interface Call {
  table: string;
  select: string;
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown[]]>;
  order: string[];
  limit: number | null;
}

function makeClient(
  tables: Record<string, Row[]>,
  options: { fail?: (call: Call) => boolean } = {},
) {
  const calls: Call[] = [];
  function from(table: string) {
    const call: Call = {
      table,
      select: "",
      eq: [],
      in: [],
      order: [],
      limit: null,
    };
    const cmp: Array<(row: Row) => boolean> = [];
    calls.push(call);
    const result = () => {
      if (options.fail?.(call)) {
        return { data: null, error: { message: `${table} forced failure` } };
      }
      if (table === "jobs" && call.select === "id, pricing_json") {
        return { data: [], error: null };
      }
      let rows = [...(tables[table] || [])];
      for (const [c, v] of call.eq) rows = rows.filter((r) => r[c] === v);
      for (const [c, vs] of call.in) {
        rows = rows.filter((r) => vs.includes(r[c]));
      }
      for (const f of cmp) rows = rows.filter(f);
      return {
        data: call.limit == null ? rows : rows.slice(0, call.limit),
        error: null,
      };
    };
    const b: any = {
      select: (s: string) => ((call.select = s), b),
      eq: (c: string, v: unknown) => (call.eq.push([c, v]), b),
      in: (c: string, v: unknown[]) => (call.in.push([c, v]), b),
      gte: (
        c: string,
        v: string,
      ) => (cmp.push((r) => String(r[c] ?? "") >= v), b),
      lt: (
        c: string,
        v: string,
      ) => (cmp.push((r) => String(r[c] ?? "") < v), b),
      lte: (
        c: string,
        v: string,
      ) => (cmp.push((r) => String(r[c] ?? "") <= v), b),
      gt: (
        c: string,
        v: string,
      ) => (cmp.push((r) => String(r[c] ?? "") > v), b),
      neq: () => b,
      not: () => b,
      or: () => b,
      is: () => b,
      order: (c: string) => (call.order.push(c), b),
      limit: (n: number) => ((call.limit = n), b),
      insert: () => b,
      upsert: () => b,
      update: () => b,
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      range: async (f: number, t: number) => {
        const r = result();
        return r.error
          ? r
          : { data: (r.data || []).slice(f, t + 1), error: null };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(res, rej),
    };
    return b;
  }
  const client = {
    from,
    rpc: async () => ({ data: null, error: null }),
  };
  return { client, calls };
}

const optionCalls = (calls: Call[]) =>
  calls.filter((c) =>
    (c.table === "job_events" &&
      c.in.some(([col, values]) =>
        col === "event_type" && values.includes("quote_option_superseded")
      )) ||
    (c.table === "jobs" &&
      c.in.some(([col]) => col === "quote_option_group_id"))
  );

// ── The rule ────────────────────────────────────────────────────────────────

const ev = (row: Row) => row as unknown as QuoteOptionEvent;
const members = (rows: Row[]) => {
  const map = new Map<string, QuoteOptionMember[]>();
  for (const r of rows) {
    const g = String(r.quote_option_group_id);
    map.set(g, [...(map.get(g) || []), r as unknown as QuoteOptionMember]);
  }
  return map;
};
const NOW = "2026-10-19T12:00:00.000Z";

Deno.test("quote options: a superseded event stays open until a later unsuperseded event", () => {
  const a = id(2);
  assertEquals(openSupersessions([ev(sEvent(a, id(1), G1))], NOW).has(a), true);
  const undone = [
    ev(sEvent(a, id(1), G1)),
    ev(uEvent(a, G1, "2026-10-19T02:00:00.000Z")),
  ];
  assertEquals(openSupersessions(undone, NOW).has(a), false);
  // Superseded again after being undone.
  const again = [
    ...undone,
    ev(sEvent(a, id(1), G1, "2026-10-19T03:00:00.000Z")),
  ];
  assertEquals(openSupersessions(again, NOW).has(a), true);
  // On a tie the unsuperseded event counts as later, whatever the read order.
  const tie = [ev(uEvent(a, G1, T0)), ev(sEvent(a, id(1), G1, T0))];
  assertEquals(openSupersessions(tie, NOW).has(a), false);
  // An event after the reading instant does not count yet.
  assertEquals(
    openSupersessions(
      [ev(sEvent(a, id(1), G1, "2026-10-20T00:00:00.000Z"))],
      NOW,
    ).has(a),
    false,
  );
});

Deno.test("quote options: one won option leaves its open siblings out", () => {
  const d = decideSupersededJob(
    id(2),
    ev(sEvent(id(2), id(1), G1)),
    members(fixture(true).jobs.slice(0, 2)),
  );
  assertEquals(d.state, "superseded");
  assertEquals(d.reason, "one_option_won");
});

Deno.test("quote options: two won options keep every option shown, pending review", () => {
  const rows = fixture(true).jobs.slice(3);
  const d = decideSupersededJob(
    id(12),
    ev(sEvent(id(12), id(10), G2)),
    members(rows),
  );
  assertEquals(d.state, "pending_review");
  assertEquals(d.reason, "several_options_won");
});

Deno.test("quote options: the accepted option going back to draft or quoted brings its siblings back", () => {
  for (const status of ["draft", "quoted", null]) {
    const rows = [
      job(1, String(status ?? "draft"), { quote_option_group_id: G1, status }),
      job(2, "quoted", { quote_option_group_id: G1, superseded_at: T0 }),
    ];
    const d = decideSupersededJob(
      id(2),
      ev(sEvent(id(2), id(1), G1)),
      members(rows),
    );
    assertEquals(d.state, "live", String(status));
    assertEquals(d.reason, "accepted_option_reopened");
  }
});

Deno.test("quote options: the accepted option lost or cancelled keeps its siblings out", () => {
  for (const status of ["lost", "cancelled"]) {
    const rows = [
      job(1, status, { quote_option_group_id: G1 }),
      job(2, "quoted", { quote_option_group_id: G1, superseded_at: T0 }),
    ];
    const d = decideSupersededJob(
      id(2),
      ev(sEvent(id(2), id(1), G1)),
      members(rows),
    );
    assertEquals(d.state, "superseded", status);
    assertEquals(d.reason, "accepted_option_lost");
  }
});

Deno.test("quote options: anything that does not agree is shown, never hidden", () => {
  const event = ev(sEvent(id(2), id(1), G1));
  const accepted = job(1, "accepted", { quote_option_group_id: G1 });
  // The sibling moved on itself (the client accepted it anyway).
  let d = decideSupersededJob(
    id(2),
    event,
    members([accepted, job(2, "accepted", { quote_option_group_id: G1 })]),
  );
  assertEquals([d.state, d.reason], ["live", "option_moved_on"]);
  d = decideSupersededJob(
    id(2),
    event,
    members([
      accepted,
      job(2, "lost", { quote_option_group_id: G1, superseded_at: T0 }),
    ]),
  );
  assertEquals([d.state, d.reason], ["live", "option_moved_on"]);
  // Pointer cleared but no unsuperseded event.
  d = decideSupersededJob(
    id(2),
    event,
    members([accepted, job(2, "quoted", { quote_option_group_id: G1 })]),
  );
  assertEquals([d.state, d.reason], ["live", "pointer_disagrees"]);
  // The event names no group, or a group the job is not in.
  const noGroup = ev({
    ...sEvent(id(2), id(1), G1),
    detail_json: { superseded_by_job_id: id(1) },
  });
  assertEquals(
    decideSupersededJob(id(2), noGroup, members([accepted])).reason,
    "group_unknown",
  );
  assertEquals(
    decideSupersededJob(id(2), event, new Map()).reason,
    "group_unknown",
  );
});

// fence_quote_option_status_won copied verbatim from the SQ-23 write branch
// (sq23/quote-option-jobs at 57499c8, round 3). Used only while that
// migration is not in this tree; once it is, the test reads the migration
// itself and also fails if this copy has drifted from it. Set
// SQ23_MIGRATION_PATH to check against a migration file elsewhere.
const SQ23_WON_FUNCTION_57499C8 =
  `CREATE OR REPLACE FUNCTION public.fence_quote_option_status_won(p_status text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT coalesce(p_status, '') IN ('accepted', 'awaiting_deposit', 'deposit', 'approvals',
    'order_materials', 'order_confirmed', 'schedule_install', 'processing', 'awaiting_supplier',
    'scheduled', 'in_progress', 'rectification', 'final_payment', 'invoiced', 'complete', 'get_review')
$$;`;

function wonFunction(sql: string): string {
  const m = sql.match(
    /CREATE OR REPLACE FUNCTION public\.fence_quote_option_status_won\(p_status text\)[\s\S]*?\$\$;/,
  );
  assert(m, "fence_quote_option_status_won not found");
  return m[0];
}

function wonList(fn: string): string[] {
  const body = fn.match(/IN \(([\s\S]*?)\)/);
  assert(body, "won list not found");
  return [...body[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

Deno.test("quote options: the won list equals the SQ-23 migration's", async () => {
  const envPath = Deno.env.get("SQ23_MIGRATION_PATH");
  const path = envPath ||
    new URL(
      "../../migrations/20261019210000_fence_quote_option_jobs.sql",
      import.meta.url,
    )
      .pathname;
  let sql: string | null = null;
  try {
    sql = await Deno.readTextFile(path);
  } catch {
    if (envPath) {
      throw new Error(`SQ23_MIGRATION_PATH not readable: ${envPath}`);
    }
  }
  if (sql) {
    assertEquals(
      wonFunction(SQ23_WON_FUNCTION_57499C8),
      wonFunction(sql),
      "the copy here has drifted from the migration",
    );
    assertEquals([...QUOTE_OPTION_WON_STATUSES], wonList(wonFunction(sql)));
  }
  assertEquals(
    [...QUOTE_OPTION_WON_STATUSES],
    wonList(SQ23_WON_FUNCTION_57499C8),
  );
  assertEquals(QUOTE_OPTION_WON_STATUSES.length, 16);
  assert(!QUOTE_OPTION_WON_STATUSES.includes("partially_accepted"));
});

function rEvent(job: string, group: string, reason: string, at = T0): Row {
  return {
    id: `ev-r-${job}-${reason}-${at}`,
    job_id: job,
    event_type: "quote_option_review_needed",
    created_at: at,
    detail_json: { reason, quote_option_group_id: group },
  };
}

const m = (
  n: number,
  status: string,
  superseded = false,
): QuoteOptionMember => ({
  id: id(n),
  status,
  quote_option_group_id: G1,
  superseded_at: superseded ? T0 : null,
});

Deno.test("quote options: a second winner at awaiting_deposit or deposit keeps the open sibling shown", () => {
  for (
    const status of [
      "awaiting_deposit",
      "deposit",
      "approvals",
      "order_materials",
      "order_confirmed",
      "schedule_install",
    ]
  ) {
    const groups = new Map([[G1, [
      m(1, "accepted"),
      m(2, status),
      m(3, "quoted", true),
    ]]]);
    const d = decideQuoteOptionGroups(
      groups,
      [ev(sEvent(id(3), id(1), G1))],
      NOW,
    );
    assertEquals(d.get(id(3))?.state, "pending_review", status);
    assertEquals(d.get(id(3))?.reason, "several_options_won", status);
  }
  // Accepted straight to deposit is one winner, for the right reason.
  const groups = new Map([[G1, [m(1, "deposit"), m(3, "quoted", true)]]]);
  const d = decideQuoteOptionGroups(
    groups,
    [ev(sEvent(id(3), id(1), G1))],
    NOW,
  );
  assertEquals([d.get(id(3))?.state, d.get(id(3))?.reason], [
    "superseded",
    "one_option_won",
  ]);
});

Deno.test("quote options: the round-3 two-winner shape labels the whole group pending review", () => {
  // Second winner's trigger cleared the marks and wrote one review event.
  const groups = new Map([[G1, [
    m(1, "accepted"),
    m(2, "accepted"),
    m(3, "quoted"),
  ]]]);
  const events = [
    ev(sEvent(id(3), id(1), G1)),
    ev(uEvent(id(3), G1, "2026-10-19T02:00:00.000Z")),
    ev(
      rEvent(id(2), G1, "more_than_one_option_won", "2026-10-19T02:00:00.000Z"),
    ),
  ];
  const d = decideQuoteOptionGroups(groups, events, NOW);
  for (const n of [1, 2, 3]) {
    assertEquals(d.get(id(n))?.state, "pending_review", String(n));
  }
  // Two winners even with no event at all.
  const bare = decideQuoteOptionGroups(groups, [
    ev(rEvent(id(2), G1, "crewed")),
  ], NOW);
  assertEquals(bare.get(id(3))?.reason, "several_options_won");
});

Deno.test("quote options: a busy or failed review keeps the group shown until a later supersede", () => {
  for (const reason of ["sibling_busy", "supersede_failed"]) {
    const groups = new Map([[G1, [
      m(1, "accepted"),
      m(2, "quoted", true),
      m(3, "quoted"),
    ]]]);
    const events = [
      ev(sEvent(id(2), id(1), G1)),
      ev(rEvent(id(1), G1, reason)),
    ];
    let d = decideQuoteOptionGroups(groups, events, NOW);
    assertEquals([d.get(id(2))?.state, d.get(id(2))?.reason], [
      "pending_review",
      "review_needed",
    ], reason);
    assertEquals(d.get(id(3))?.state, "pending_review", reason);
    // A later run of the normal rule settles it.
    const later = [
      ...events,
      ev(sEvent(id(3), id(1), G1, "2026-10-19T03:00:00.000Z")),
    ];
    d = decideQuoteOptionGroups(
      new Map([[G1, [
        m(1, "accepted"),
        m(2, "quoted", true),
        m(3, "quoted", true),
      ]]]),
      later,
      NOW,
    );
    assertEquals(d.get(id(2))?.state, "superseded", reason);
    assertEquals(d.get(id(3))?.state, "superseded", reason);
  }
});

Deno.test("quote options: other review reasons leave the normal rule standing", () => {
  for (
    const reason of [
      "accepted_job_lost",
      "crewed",
      "invoiced",
      "accepted_after_superseded",
    ]
  ) {
    const groups = new Map([[G1, [m(1, "lost"), m(2, "quoted", true)]]]);
    const events = [
      ev(sEvent(id(2), id(1), G1)),
      ev(rEvent(id(1), G1, reason, "2026-10-19T05:00:00.000Z")),
    ];
    const d = decideQuoteOptionGroups(groups, events, NOW);
    assertEquals(d.get(id(2))?.state, "superseded", reason);
  }
});

// ── The reads ───────────────────────────────────────────────────────────────

Deno.test("quote options load: switch off reads only the switch", async () => {
  const { client, calls } = makeClient(fixture(false));
  const v = await loadQuoteOptionVisibility(client, fixture(false).jobs);
  assertEquals(v.status, "off");
  assertEquals(v.hidden.size, 0);
  assertEquals(calls.map((c) => c.table), ["feature_flags"]);
  assertEquals(calls[0].eq, [["flag_name", QUOTE_OPTION_OPS_READER_FLAG]]);
});

Deno.test("quote options load: reads the open jobs' events, then their groups by the indexed column", async () => {
  const tables = fixture(true);
  const { client, calls } = makeClient(tables);
  const v = await loadQuoteOptionVisibility(client, tables.jobs, { asOf: NOW });
  assertEquals(v.status, "ok");
  assertEquals([...v.hidden].sort(), [id(2)]);
  assertEquals(v.decisions.get(id(12))?.state, "pending_review");
  assertEquals(v.decisions.get(id(10))?.state, "pending_review");
  assertEquals(v.decisions.has(id(3)), false);
  const calledOptions = optionCalls(calls);
  // Every given job is in the group read, so no third read.
  assertEquals(calledOptions.length, 2);
  const [events, groups] = calledOptions;
  assertEquals(events.select, "job_id, event_type, created_at, detail_json");
  assertEquals(events.in[0], ["job_id", [
    id(1),
    id(2),
    id(3),
    id(10),
    id(11),
    id(12),
  ]]);
  assertEquals(events.in[1], ["event_type", [
    "quote_option_superseded",
    "quote_option_unsuperseded",
    "quote_option_review_needed",
  ]]);
  assertEquals(events.order, ["created_at"]);
  assertEquals(events.limit, 1000);
  assertEquals(
    groups.select,
    "id, status, quote_option_group_id, superseded_at",
  );
  assertEquals(groups.in[0], ["quote_option_group_id", [G1, G2]]);
  assertEquals(groups.limit, 1000);
});

Deno.test("quote options load: reads the events of group members it was not given", async () => {
  const tables = fixture(true);
  // Round-3 two-winner shape on group 10: marks cleared, review on job 11.
  tables.jobs = tables.jobs.map((
    j,
  ) => (j.id === id(12) ? { ...j, superseded_at: null } : j));
  tables.job_events = [
    sEvent(id(2), id(1), G1),
    sEvent(id(12), id(10), G2),
    uEvent(id(12), G2, "2026-10-19T02:00:00.000Z"),
    rEvent(id(11), G2, "more_than_one_option_won", "2026-10-19T02:00:00.000Z"),
  ];
  const { client, calls } = makeClient(tables);
  // Only the open jobs, as list_quotes passes them.
  const open = tables.jobs.filter((j) =>
    j.status === "quoted" || j.status === "draft"
  );
  const v = await loadQuoteOptionVisibility(client, open, { asOf: NOW });
  assertEquals([...v.hidden], [id(2)]);
  assertEquals(v.decisions.get(id(12))?.state, "pending_review");
  assertEquals(
    v.decisions.has(id(11)),
    false,
    "decisions only for the given jobs",
  );
  const reads = optionCalls(calls);
  assertEquals(reads.map((c) => c.table), ["job_events", "jobs", "job_events"]);
  assertEquals(reads[2].in[0], ["job_id", [id(1), id(10), id(11)]]);
});

Deno.test("quote options load: no open supersession needs no group read", async () => {
  const tables = fixture(true);
  tables.job_events = [];
  const { client, calls } = makeClient(tables);
  const v = await loadQuoteOptionVisibility(client, tables.jobs);
  assertEquals(v.status, "ok");
  assertEquals(optionCalls(calls).map((c) => c.table), ["job_events"]);
});

Deno.test("quote options load: a failed read or a full page hides nothing and says failed", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const table of ["job_events", "jobs"]) {
      const { client } = makeClient(fixture(true), {
        fail: (c) => c.table === table,
      });
      const v = await loadQuoteOptionVisibility(client, fixture(true).jobs);
      assertEquals([v.status, v.hidden.size], ["failed", 0], table);
    }
    const tables = fixture(true);
    tables.job_events = Array.from(
      { length: 1000 },
      (_, i) =>
        sEvent(
          id(2),
          id(1),
          G1,
          `2026-10-18T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        ),
    );
    const { client } = makeClient(tables);
    const v = await loadQuoteOptionVisibility(client, tables.jobs);
    assertEquals([v.status, v.hidden.size], ["failed", 0]);
  } finally {
    console.error = originalError;
  }
});

// ── The Ops readers ─────────────────────────────────────────────────────────

const columnIds = (result: any, col: string) =>
  (result.columns[col] as any[]).map((j) => j.id).sort();

Deno.test("pipeline: switch on leaves the superseded option out, keeps repeats and pending review", async () => {
  const { client } = makeClient(fixture(true));
  const result: any = await _pipelineForTest(
    client,
    new URLSearchParams("type=fencing"),
  );
  assertEquals(columnIds(result, "quoted"), [id(12)]);
  assertEquals(columnIds(result, "draft"), [id(3)]);
  assertEquals(columnIds(result, "accepted"), [id(1), id(10), id(11)]);
  assertEquals(result.total, 5);
  assertEquals(result.columns.quoted[0].quote_option_state, "pending_review");
  assertEquals(result.quote_options, {
    status: "ok",
    superseded_hidden: 1,
    pending_review_job_ids: [id(10), id(11), id(12)],
  });
});

Deno.test("pipeline: switch off shows every job and adds nothing", async () => {
  const { client, calls } = makeClient(fixture(false));
  const result: any = await _pipelineForTest(
    client,
    new URLSearchParams("type=fencing"),
  );
  assertEquals(columnIds(result, "quoted"), [id(12), id(2)].sort());
  assertEquals(result.total, 6);
  assertEquals("quote_options" in result, false);
  // (The fake hands back every fixture column, so look for the reader's keys.)
  assertEquals(JSON.stringify(result).includes("quote_option_state"), false);
  assertEquals(optionCalls(calls), []);
});

Deno.test("pipeline: a failed option read shows every job and says so", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const { client } = makeClient(fixture(true), {
      fail: (c) =>
        c.table === "jobs" &&
        c.in.some(([col]) => col === "quote_option_group_id"),
    });
    const result: any = await _pipelineForTest(
      client,
      new URLSearchParams("type=fencing"),
    );
    assertEquals(result.total, 6);
    assertEquals(result.degraded, true);
    assertEquals(result.enrichment_errors, ["pipeline.quote_options"]);
    assertEquals(result.quote_options.status, "failed");
  } finally {
    console.error = originalError;
  }
});

Deno.test("ops summary: quoted count, quotes pending and old drafts leave the superseded option out", async () => {
  const on = makeClient(fixture(true));
  const off = makeClient(fixture(false));
  const resultOn: any = await _opsSummaryForTest(on.client);
  const resultOff: any = await _opsSummaryForTest(off.client);
  assertEquals(resultOff.stat_cards.pipeline.quoted, 2);
  assertEquals(resultOn.stat_cards.pipeline.quoted, 1);
  assertEquals(resultOff.stat_cards.quotes_pending, 2);
  assertEquals(resultOn.stat_cards.quotes_pending, 1);
  assertEquals("quote_options" in resultOff, false);
  assertEquals(resultOn.quote_options.superseded_hidden, 1);
  assertEquals(optionCalls(off.calls), []);
});

Deno.test("ops summary: a superseded old draft is not a lead waiting for scope", async () => {
  const tables = fixture(true);
  tables.jobs = tables.jobs.map((
    j,
  ) => (j.id === id(2) ? { ...j, status: "draft" } : j));
  const { client } = makeClient(tables);
  const result: any = await _opsSummaryForTest(client);
  const scope = result.attention.find((a: any) => a.type === "scope_pending");
  assert(scope, "the genuine draft still counts");
  assertEquals(scope.title.startsWith("1 lead "), true);
});

Deno.test("list quotes: leaves the superseded option out", async () => {
  const on: any = await _listQuotesForTest(
    makeClient(fixture(true)).client,
    new URLSearchParams(),
  );
  const off: any = await _listQuotesForTest(
    makeClient(fixture(false)).client,
    new URLSearchParams(),
  );
  assertEquals(on.quotes.map((q: any) => q.id).sort(), [id(3), id(12)].sort());
  assertEquals(
    off.quotes.map((q: any) => q.id).sort(),
    [id(2), id(3), id(12)].sort(),
  );
  assertEquals(Object.keys(off), ["quotes", "total"]);
  assertEquals(on.quote_options.status, "ok");
});

Deno.test("daily coverage audit: a superseded quoted option is not owed a nurture", async () => {
  const shift = (tables: Record<string, Row[]>) => {
    // Inside the 45-day window.
    const created = new Date(Date.now() - 10 * 86400000).toISOString();
    tables.jobs = tables.jobs.map((j) => ({ ...j, created_at: created }));
    return tables;
  };
  const on: any = await _dailyCoverageAuditForTest(
    makeClient(shift(fixture(true))).client,
    new URLSearchParams(),
  );
  const off: any = await _dailyCoverageAuditForTest(
    makeClient(shift(fixture(false))).client,
    new URLSearchParams(),
  );
  assertEquals(off.quote_coverage.quoted_45d, 2);
  assertEquals(on.quote_coverage.quoted_45d, 1);
  assertEquals(on.raw_unfiltered_universe.quoted_45d, 1);
  assertEquals("quote_options" in off, false);
});

// ── Readers outside ops-api ─────────────────────────────────────────────────

Deno.test("drop superseded: switch off hands the rows back untouched", async () => {
  const rows = fixture(false).jobs;
  const { client, calls } = makeClient(fixture(false));
  const out = await dropSupersededQuoteOptions(client, rows);
  assertEquals(out.rows, rows);
  assertEquals(out.visibility.status, "off");
  assertEquals(optionCalls(calls), []);
});

Deno.test("drop superseded: switch on leaves out only the superseded option, looking up only open rows", async () => {
  const tables = fixture(true);
  const { client, calls } = makeClient(tables);
  const out = await dropSupersededQuoteOptions(client, tables.jobs, {
    asOf: NOW,
  });
  assertEquals(
    out.rows.map((r) => r.id),
    tables.jobs.map((r) => r.id).filter((x) => x !== id(2)),
  );
  assertEquals(optionCalls(calls)[0].in[0], ["job_id", [id(2), id(3), id(12)]]);
});

// reporting-api and ops-ai start a server when imported, so their reads are
// pinned at source: each named list must go through the shared rule.
const OUTSIDE_READERS: Array<[string, number, string]> = [
  [
    "../daily-digest/index.ts",
    4,
    "deep diagnostics stale quotes, stale_followup chases, digest and daily annotations",
  ],
  [
    "../reporting-api/index.ts",
    3,
    "sales summary, sales pipeline, sales alerts",
  ],
  ["../ops-ai/index.ts", 1, "revenue forecast"],
];

Deno.test("readers outside ops-api: each named list goes through the shared rule", async () => {
  for (const [file, count, what] of OUTSIDE_READERS) {
    const src = await Deno.readTextFile(new URL(file, import.meta.url));
    const calls = src.match(/await dropSupersededQuoteOptions\(/g) || [];
    assertEquals(calls.length, count, `${file}: ${what}`);
  }
});
