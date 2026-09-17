/**
 * sales_booking_pack — publish / stamp / read-merge regressions.
 *
 * What these prove:
 *  - Publish stores kind=pack; the latest as_of is the one sales_booking_read
 *    merges. An older as_of still in the table is ignored.
 *  - Merge puts proposal + draft on the matching case (`opp:<id>` → opportunity
 *    id), fills top-level drafts, and sets stamp_state from the latest stamp.
 *  - Stamp write then stamp read round-trips. Unauthenticated publish is
 *    refused. A signed-in ops_manager may write a stamp.
 *  - Nothing is sent.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applySalesBookingPackOverlay,
  assertSalesBookingPackPublishAuth,
  assertSalesBookingStampReadAuth,
  assertSalesBookingStampWriteAuth,
  loadSalesBookingPackOverlay,
  normaliseSalesBookingDrafts,
  salesBookingPackOpportunityId,
  salesBookingPackPublishAction,
  SalesBookingPackError,
  salesBookingStampReadAction,
  salesBookingStampStateForCase,
  salesBookingStampWriteAction,
} from "./sales_booking_pack.ts";
import {
  _authorizeOpsApiAction,
} from "./index.ts";
import {
  SALES_BOOKING_RESOURCES,
  type SalesBookingReadResponse,
  salesBookingRead,
  type SalesBookingReadDependencies,
} from "./sales_booking_read.ts";

const WEEK = "2026-09-14";
const NEW_AS_OF = "2026-09-16T08:00:00.000Z";
const OLD_AS_OF = "2026-09-16T07:00:00.000Z";
const API_KEY_AUTH = { mode: "api_key" as const };
const OPS_MANAGER_AUTH = {
  mode: "jwt" as const,
  role: "ops_manager",
  userId: "user-ops-manager",
};

type PackRow = {
  id: string;
  resource: string;
  week_start: string;
  kind: string;
  as_of: string;
  payload: Record<string, unknown>;
  published_by: string | null;
  created_at: string;
};

function memoryPacks(initial: PackRow[] = []) {
  const store: PackRow[] = initial.map((row) => ({ ...row }));
  const builder = () => {
    let filters: Array<(row: PackRow) => boolean> = [];
    let orderCol: keyof PackRow | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let pending: PackRow | null = null;
    let write: "insert" | "upsert" | null = null;

    const keyOf = (row: PackRow) =>
      `${row.resource}|${row.week_start}|${row.kind}|${row.as_of}`;

    const run = () => {
      if (write && pending) {
        if (write === "upsert") {
          const idx = store.findIndex((row) => keyOf(row) === keyOf(pending!));
          if (idx >= 0) {
            store[idx] = { ...store[idx], ...pending, id: store[idx].id };
            pending = store[idx];
          } else {
            store.push(pending);
          }
        } else {
          store.push(pending);
        }
        return { data: pending, error: null };
      }
      let matched = store.filter((row) => filters.every((fn) => fn(row)));
      if (orderCol) {
        const col = orderCol;
        matched = matched.slice().sort((a, b) => {
          const av = String(a[col]);
          const bv = String(b[col]);
          return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN != null) matched = matched.slice(0, limitN);
      return { data: matched, error: null };
    };

    const self: any = {
      insert(row: Record<string, unknown>) {
        write = "insert";
        pending = {
          id: typeof row.id === "string" ? row.id : crypto.randomUUID(),
          resource: String(row.resource),
          week_start: String(row.week_start),
          kind: String(row.kind),
          as_of: String(row.as_of),
          payload: (row.payload && typeof row.payload === "object"
            ? row.payload
            : {}) as Record<string, unknown>,
          published_by: typeof row.published_by === "string"
            ? row.published_by
            : null,
          created_at: typeof row.created_at === "string"
            ? row.created_at
            : new Date().toISOString(),
        };
        return self;
      },
      upsert(row: Record<string, unknown>) {
        write = "upsert";
        pending = {
          id: typeof row.id === "string" ? row.id : crypto.randomUUID(),
          resource: String(row.resource),
          week_start: String(row.week_start),
          kind: String(row.kind),
          as_of: String(row.as_of),
          payload: (row.payload && typeof row.payload === "object"
            ? row.payload
            : {}) as Record<string, unknown>,
          published_by: typeof row.published_by === "string"
            ? row.published_by
            : null,
          created_at: typeof row.created_at === "string"
            ? row.created_at
            : new Date().toISOString(),
        };
        return self;
      },
      select() {
        return self;
      },
      eq(col: string, value: unknown) {
        filters.push((row) => (row as Record<string, unknown>)[col] === value);
        return self;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col as keyof PackRow;
        orderAsc = opts?.ascending !== false;
        return self;
      },
      limit(n: number) {
        limitN = n;
        return self;
      },
      single() {
        const { data, error } = run();
        if (error) return Promise.resolve({ data: null, error });
        const row = Array.isArray(data) ? data[0] ?? null : data;
        return Promise.resolve({
          data: row,
          error: row ? null : { message: "no rows" },
        });
      },
      maybeSingle() {
        const { data, error } = run();
        if (error) return Promise.resolve({ data: null, error });
        const row = Array.isArray(data) ? data[0] ?? null : data;
        return Promise.resolve({ data: row, error: null });
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return self;
  };
  return {
    store,
    from(table: string) {
      if (table !== "sales_booking_packs") {
        throw new Error(`unexpected table ${table}`);
      }
      return builder();
    },
  };
}

function proposalsFixture(overrides: Record<string, unknown> = {}) {
  return {
    profile: "fencing-stratco-marnin",
    as_of: NEW_AS_OF,
    leads: [
      {
        id: "opp:opp-1",
        opportunity_id: "opp-1",
        name: "Jane Smith",
        suburb: "Canning Vale",
        disposition: "offer",
        window: {
          day: "Fri",
          start: "2026-09-18T08:00:00+08:00",
          end: "2026-09-18T09:30:00+08:00",
        },
        draft:
          "Hi Jane, it's Marnin from SecureWorks Group. I can come out to Canning Vale on Friday 18 September between 08:00 and 09:30 to measure and quote. Does that suit?",
        failures: ["coverage_flag_not_ready"],
        ...overrides,
      },
    ],
  };
}

function coverageFixture() {
  return {
    lead_count: 1,
    truncated: false,
    by_disposition: { offer: 1 },
  };
}

function readDeps(): SalesBookingReadDependencies {
  const marninScopeStage = SALES_BOOKING_RESOURCES.marnin.scope_stage_ids[0];
  return {
    readOpportunities: () =>
      Promise.resolve({
        opportunities: [{
          id: "opp-1",
          name: "Jane Smith",
          pipelineStageId: marninScopeStage,
          updatedAt: "2026-09-15T01:00:00.000Z",
          contact: { id: "contact-1", name: "Jane Smith", city: "Canning Vale" },
        }],
        stages: { [marninScopeStage]: "New Lead (Call + Qualify)" },
        exhausted: true,
        pages_scanned: 1,
        total: 1,
        reason: null,
      }),
    readDiary: () =>
      Promise.resolve({
        read_ok: true,
        reason: null,
        entries: [],
        malformed_dropped: 0,
        calendar_email: "marnin@secureworkswa.com.au",
        ghl_user_id: "ghl_user_marnin",
        scoper_user_id: SALES_BOOKING_RESOURCES.marnin.scoper_user_id,
      }),
    readThread: () => Promise.resolve([]),
    now: () => new Date("2026-09-16T02:00:00.000Z"),
  };
}

async function publishedRead(
  client: ReturnType<typeof memoryPacks>,
): Promise<SalesBookingReadResponse> {
  const assembled = await salesBookingRead(readDeps(), {
    resource: "marnin",
    week_start: WEEK,
  });
  const overlay = await loadSalesBookingPackOverlay(client, "marnin", WEEK);
  return applySalesBookingPackOverlay(assembled, overlay);
}

Deno.test("pack row id opp:<id> maps onto the case opportunity id", () => {
  assertEquals(salesBookingPackOpportunityId("opp:opp-1"), "opp-1");
  assertEquals(
    salesBookingPackOpportunityId("opp:TelAKHzhxnCjKrExxQxE"),
    "TelAKHzhxnCjKrExxQxE",
  );
  assertEquals(salesBookingPackOpportunityId("opp-1"), "opp-1");
  assertEquals(
    salesBookingPackOpportunityId("opp:x", "TelAKHzhxnCjKrExxQxE"),
    "TelAKHzhxnCjKrExxQxE",
  );
  assertEquals(normaliseSalesBookingDrafts({
    "opp:opp-1": "Hi Jane",
    "other": 1,
  }), { "opp-1": "Hi Jane" });
});

Deno.test("stamp_state matches bare GHL opportunity ids and opp:<id>", () => {
  const stamp = {
    captain: "marnin",
    approved: ["opp-1"],
    rejected: ["opp:opp-2"],
    decisions: {},
    stage_moves: [],
  };
  assertEquals(salesBookingStampStateForCase("opp-1", stamp), "approved");
  assertEquals(salesBookingStampStateForCase("opp-2", stamp), "rejected");
  assertEquals(salesBookingStampStateForCase("opp-3", stamp), "none");
});

Deno.test("publish then read merge puts proposal and draft on the matching case", async () => {
  const client = memoryPacks();
  const published = await salesBookingPackPublishAction(client, API_KEY_AUTH, {
    resource: "marnin",
    week_start: WEEK,
    as_of: NEW_AS_OF,
    proposals: proposalsFixture(),
    coverage: coverageFixture(),
    drafts: { "opp-1": "Hi Jane from drafts map." },
  });
  assertEquals(published.ok, true);
  assert(published.id);
  assertEquals(published.as_of, NEW_AS_OF);

  const payload = await publishedRead(client);
  assertEquals(payload.pack, { present: true, as_of: NEW_AS_OF });
  assertEquals(payload.drafts["opp-1"], "Hi Jane from drafts map.");
  assertEquals(payload.cases.length, 1);
  assertEquals(payload.cases[0].stamp_state, "none");
  assertEquals(payload.cases[0].proposal, {
    disposition: "offer",
    day: "Fri",
    window_start: "2026-09-18T08:00:00+08:00",
    window_end: "2026-09-18T09:30:00+08:00",
    draft:
      "Hi Jane, it's Marnin from SecureWorks Group. I can come out to Canning Vale on Friday 18 September between 08:00 and 09:30 to measure and quote. Does that suit?",
    why: ["coverage_flag_not_ready"],
  });

  const fromMapOnly = applySalesBookingPackOverlay(
    await salesBookingRead(readDeps(), { resource: "marnin", week_start: WEEK }),
    {
      pack: {
        id: "pack-map-only",
        as_of: NEW_AS_OF,
        payload: {
          proposals: proposalsFixture({ draft: null }),
          coverage: coverageFixture(),
          drafts: { "opp-1": "Hi Jane from drafts map." },
        },
      },
      stamp: null,
      pack_error: null,
      stamp_error: null,
    },
  );
  assertEquals(fromMapOnly.cases[0].proposal?.draft, "Hi Jane from drafts map.");
});

Deno.test("stale pack with an older as_of is ignored in favour of the latest", async () => {
  const client = memoryPacks();
  await salesBookingPackPublishAction(client, API_KEY_AUTH, {
    resource: "marnin",
    week_start: WEEK,
    as_of: NEW_AS_OF,
    proposals: proposalsFixture({
      draft: "new draft",
      disposition: "offer",
    }),
    coverage: coverageFixture(),
    drafts: { "opp-1": "new draft" },
  });
  await salesBookingPackPublishAction(client, API_KEY_AUTH, {
    resource: "marnin",
    week_start: WEEK,
    as_of: OLD_AS_OF,
    proposals: proposalsFixture({
      draft: "stale draft",
      disposition: "capacity",
    }),
    coverage: coverageFixture(),
    drafts: { "opp-1": "stale draft" },
  });

  const payload = await publishedRead(client);
  assertEquals(payload.pack.as_of, NEW_AS_OF);
  assertEquals(payload.cases[0].proposal?.disposition, "offer");
  assertEquals(payload.cases[0].proposal?.draft, "new draft");
  assertEquals(payload.drafts["opp-1"], "new draft");
});

Deno.test("stamp write then stamp read round-trips; merge sets stamp_state", async () => {
  const client = memoryPacks();
  await salesBookingPackPublishAction(client, API_KEY_AUTH, {
    resource: "marnin",
    week_start: WEEK,
    as_of: NEW_AS_OF,
    proposals: proposalsFixture(),
    coverage: coverageFixture(),
    drafts: { "opp-1": "Hi Jane" },
  });
  const written = await salesBookingStampWriteAction(
    client,
    OPS_MANAGER_AUTH,
    {
      resource: "marnin",
      week_start: WEEK,
      stamp: {
        captain: "marnin",
        approved: ["opp:opp-1"],
        rejected: [],
        decisions: { "opp:opp-1": "hold" },
        stage_moves: [{ id: "opp:opp-1", to_stage_id: "visit-booked" }],
      },
    },
    new Date("2026-09-17T01:00:00.000Z"),
  );
  assertEquals(written.ok, true);
  assertEquals(written.as_of, "2026-09-17T01:00:00.000Z");

  const read = await salesBookingStampReadAction(client, API_KEY_AUTH, {
    resource: "marnin",
    week_start: WEEK,
  });
  assertEquals(read.ok, true);
  assertEquals(read.as_of, "2026-09-17T01:00:00.000Z");
  assertEquals(read.stamp?.captain, "marnin");
  assertEquals(read.stamp?.approved, ["opp:opp-1"]);
  assertEquals(read.stamp?.decisions, { "opp:opp-1": "hold" });
  assertEquals(read.stamp?.stage_moves, [{
    id: "opp:opp-1",
    to_stage_id: "visit-booked",
  }]);

  const empty = await salesBookingStampReadAction(client, API_KEY_AUTH, {
    resource: "nithin",
    week_start: WEEK,
  });
  assertEquals(empty, { ok: true, stamp: null, as_of: null });

  const payload = await publishedRead(client);
  assertEquals(payload.stamp.present, true);
  assertEquals(payload.stamp.approved, ["opp:opp-1"]);
  assertEquals(payload.cases[0].stamp_state, "approved");
});

Deno.test("unauthenticated publish is refused; jwt ops_manager stamp is accepted", async () => {
  try {
    assertSalesBookingPackPublishAuth({ mode: "none" });
    throw new Error("expected throw");
  } catch (error) {
    assert(error instanceof SalesBookingPackError);
    assertEquals(error.status, 401);
  }
  try {
    assertSalesBookingPackPublishAuth({
      mode: "jwt",
      role: "ops_manager",
      userId: "u1",
    });
    throw new Error("expected throw");
  } catch (error) {
    assert(error instanceof SalesBookingPackError);
    assertEquals(error.status, 403);
  }
  assertSalesBookingPackPublishAuth(API_KEY_AUTH);
  assertSalesBookingStampReadAuth(API_KEY_AUTH);
  try {
    assertSalesBookingStampReadAuth(OPS_MANAGER_AUTH);
    throw new Error("expected throw");
  } catch (error) {
    assert(error instanceof SalesBookingPackError);
    assertEquals(error.status, 403);
  }

  assertSalesBookingStampWriteAuth(API_KEY_AUTH);
  assertSalesBookingStampWriteAuth(OPS_MANAGER_AUTH);
  try {
    assertSalesBookingStampWriteAuth({ mode: "jwt", role: "installer" });
    throw new Error("expected throw");
  } catch (error) {
    assert(error instanceof SalesBookingPackError);
    assertEquals(error.status, 403);
  }

  const client = memoryPacks();
  const published = await salesBookingStampWriteAction(client, OPS_MANAGER_AUTH, {
    resource: "nithin",
    week_start: WEEK,
    stamp: { captain: "nithin", approved: [], rejected: [] },
  }, new Date("2026-09-17T02:00:00.000Z"));
  assertEquals(published.ok, true);

  await assertRejects(
    () =>
      salesBookingPackPublishAction(client, { mode: "none" }, {
        resource: "marnin",
        week_start: WEEK,
        as_of: NEW_AS_OF,
        proposals: proposalsFixture(),
        coverage: coverageFixture(),
        drafts: {},
      }),
    SalesBookingPackError,
  );
});

Deno.test("front door refuses unauthenticated pack publish with 401", () => {
  for (
    const action of [
      "sales_booking_pack_publish",
      "sales_booking_stamp_write",
      "sales_booking_stamp_read",
    ]
  ) {
    const decision = _authorizeOpsApiAction({
      url: new URL(`https://example.invalid/ops-api?action=${action}`),
      authMode: "none",
    });
    assertEquals(decision.ok, false);
    if (!decision.ok) {
      assertEquals(decision.status, 401);
      assertEquals(decision.code, "user_jwt_required");
    }
  }
});
