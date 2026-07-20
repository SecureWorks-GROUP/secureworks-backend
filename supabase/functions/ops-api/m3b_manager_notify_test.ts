// M3b U2 (D4) — manager notification tests.
//
// (a) createMakesafeJob texts the make-safe manager(s) on EVERY creation path,
//     IGNORING suppress_notifications (gate G3 — that flag belonged to the
//     legacy manager direct-message block, now deleted; the dominant intake-approve
//     path passes it and previously left new make-safes silent). Dispatchers
//     (admin/ops_manager) and phone-less users are never texted.
// (b) updateJobStatus texts a vertical's managers ONLY when a fencing/patio job
//     TRANSITIONS INTO the crew-ready set — never on repeat saves, moves within
//     the set, non-ready transitions, or make-safe/decking types.
// All sends fetch-intercepted — zero real texts.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _createMakesafeJob, _updateJobStatus } from "./index.ts";

// ── Mock client: users reverse-lookup (.contains) + jobs read/update ────────
type Store = {
  users?: Array<Record<string, unknown>>;
  jobs?: Record<string, Record<string, unknown>>;
  inserts?: Array<{ table: string; row: unknown }>;
  updates?: Array<{ table: string; row: Record<string, unknown>; id?: unknown }>;
};

function makeClient(store: Store) {
  store.inserts = store.inserts || [];
  store.updates = store.updates || [];
  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let containsFilter: { col: string; arr: unknown[] } | null = null;
    let notNullCol: string | null = null;
    let op: "select" | "insert" | "update" = "select";
    let insertRow: Record<string, unknown> | null = null;
    let updateRow: Record<string, unknown> | null = null;
    const resolveSingle = () => {
      if (op === "insert") return { id: "new-job-1", ...(insertRow || {}) };
      if (op === "update") {
        const existing = store.jobs?.[String(filters.id)] ?? {};
        return { ...existing, ...(updateRow || {}) };
      }
      if (table === "jobs") return store.jobs?.[String(filters.id)] ?? null;
      return null;
    };
    const resolveArray = () => {
      if (op !== "select") return null;
      if (table === "users") {
        let rows = (store.users || []).slice();
        if (containsFilter?.col === "managed_verticals") {
          rows = rows.filter((u) => {
            const mv = (u.managed_verticals as unknown[]) || [];
            return (containsFilter!.arr as unknown[]).every((v) => mv.includes(v));
          });
        }
        if (notNullCol) rows = rows.filter((u) => u[notNullCol!] != null);
        return rows;
      }
      return [];
    };
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: () => b,
      insert: (row: Record<string, unknown>) => { op = "insert"; insertRow = row; store.inserts!.push({ table, row }); return b; },
      update: (row: Record<string, unknown>) => {
        op = "update"; updateRow = row;
        const rec = { table, row, id: undefined as unknown };
        store.updates!.push(rec);
        // Backfill target id at eq() time via closure.
        b._updateRec = rec;
        return b;
      },
      eq: (k: string, v: unknown) => {
        filters[k] = v;
        if (b._updateRec && k === "id") b._updateRec.id = v;
        return b;
      },
      neq: () => b,
      is: () => b,
      contains: (col: string, arr: unknown[]) => { containsFilter = { col, arr }; return b; },
      not: (col: string, cmp: string, v: unknown) => { if (cmp === "is" && v === null) notNullCol = col; return b; },
      ilike: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: resolveSingle(), error: null }),
      single: () => Promise.resolve({ data: resolveSingle(), error: null }),
      // deno-lint-ignore no-explicit-any
      then: (res: any, rej: any) => Promise.resolve({ data: resolveArray(), error: null }).then(res, rej),
      catch: () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }
  return {
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: "SWMS-27001", error: null }),
  };
}

// ── fetch interception ───────────────────────────────────────────────────────
type FetchCall = { url: string; body: string };
function stubFetch() {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: { body?: unknown }) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: String(init?.body ?? "") });
    return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}
const smsCalls = (calls: FetchCall[]) => calls.filter((c) => c.url.includes("ghl-proxy?action=send_sms"));
const smsPhones = (calls: FetchCall[]) => smsCalls(calls).map((c) => JSON.parse(c.body).phone);

// The full crew per D4: Hugo (make-safe), Henry (fencing), Nithin + Jan (patio).
// Marnin (admin) and Shaun (ops_manager, no phone) must never be texted.
const USERS = [
  { id: "u-hugo", name: "Hugo", role: "lead_installer", managed_verticals: ["makesafe"], phone: "+61400000001" },
  { id: "u-henry", name: "Henry", role: "lead_installer", managed_verticals: ["fencing"], phone: "+61400000002" },
  { id: "u-nithin", name: "Nithin", role: "sales", managed_verticals: ["patio"], phone: "+61400000003" },
  { id: "u-jan", name: "Jan", role: "lead_installer", managed_verticals: ["patio"], phone: "+61400000004" },
  { id: "u-marnin", name: "Marnin", role: "admin", managed_verticals: ["makesafe", "fencing", "patio", "decking"], phone: "+61400000009" },
  { id: "u-shaun", name: "Shaun", role: "ops_manager", managed_verticals: ["makesafe", "fencing", "patio", "decking"], phone: null },
];

// ── U2a: make-safe creation texts the make-safe manager ─────────────────────
Deno.test("U2a: direct createMakesafeJob texts Hugo only (no dispatchers or phone-less users)", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store: Store = { users: USERS.map((u) => ({ ...u })) };
    const res = await _createMakesafeJob(makeClient(store), {
      client_name: "Jane Client",
      site_address: "12 Example St",
      suburb: "Padbury",
      requesting_company_name: "MLB Insurance Building",
      external_ref: "MLB-9999",
    });
    await flush();

    assertEquals(res.ok, true);
    assertEquals(smsPhones(calls), ["+61400000001"], "exactly one SMS, to Hugo (Marnin/Shaun/other verticals excluded)");
    const body = JSON.parse(smsCalls(calls)[0].body);
    assert(body.message.includes("SWMS-27001"), "carries the job number");
    assert(body.message.includes("12 Example St, Padbury"), "carries the site");
    assert(body.message.includes("MLB Insurance Building"), "carries the builder");
    assert(body.message.includes("Open in Trade:"), "carries the trade link");
  } finally {
    restore();
  }
});

Deno.test("U2a (G3): suppress_notifications:true (the intake-approve path) still texts Hugo", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store: Store = { users: USERS.map((u) => ({ ...u })) };
    const res = await _createMakesafeJob(makeClient(store), {
      client_name: "Intake Client",
      site_address: "3 Approve Way",
      suburb: "Eaton",
      suppress_notifications: true, // exactly what approveIntakeDraft passes
    });
    await flush();
    assertEquals(res.ok, true);
    assertEquals(smsPhones(calls), ["+61400000001"], "intake-created make-safes are no longer silent");
  } finally {
    restore();
  }
});

Deno.test("U2a: no eligible manager (no phones) -> zero SMS, creation still succeeds", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store: Store = { users: [{ ...USERS[0], phone: null }] };
    const res = await _createMakesafeJob(makeClient(store), {
      client_name: "Jane Client",
      site_address: "12 Example St",
    });
    await flush();
    assertEquals(res.ok, true);
    assertEquals(smsCalls(calls).length, 0);
  } finally {
    restore();
  }
});

// ── U2b: ready-transition manager text via updateJobStatus ──────────────────
function jobFixture(type: string, status: string): Store {
  return {
    users: USERS.map((u) => ({ ...u })),
    jobs: {
      "job-1": {
        id: "job-1", type, status, job_number: "SWF-100", client_name: "Jane Client",
        site_address: "12 Example St", site_suburb: "Padbury", pricing_json: null,
      },
    },
  };
}

Deno.test("U2b: fencing quoted -> order_confirmed texts Henry only", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = jobFixture("fencing", "quoted");
    const res = await _updateJobStatus(makeClient(store), { job_id: "job-1", status: "order_confirmed" });
    await flush();
    assertEquals(res.success, true);
    assertEquals(smsPhones(calls), ["+61400000002"], "Henry (fencing manager) only");
    const body = JSON.parse(smsCalls(calls)[0].body);
    assert(body.message.includes("Job ready for crew"), "ready wording");
    assert(body.message.includes("SWF-100"));
    assert(body.message.includes("order_confirmed"));
  } finally {
    restore();
  }
});

Deno.test("U2b: patio quoted -> scheduled texts BOTH patio managers (Nithin + Jan)", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = jobFixture("patio", "quoted");
    const res = await _updateJobStatus(makeClient(store), { job_id: "job-1", status: "scheduled" });
    await flush();
    assertEquals(res.success, true);
    assertEquals(smsPhones(calls).sort(), ["+61400000003", "+61400000004"]);
  } finally {
    restore();
  }
});

Deno.test("U2b: NO text on repeat save, within-set move, non-ready transition, or non-fencing/patio types", async () => {
  const cases: Array<{ type: string; from: string; to: string; label: string }> = [
    { type: "fencing", from: "order_confirmed", to: "order_confirmed", label: "repeat save of the same ready status" },
    { type: "fencing", from: "schedule_install", to: "scheduled", label: "move WITHIN the ready set" },
    { type: "fencing", from: "quoted", to: "awaiting_deposit", label: "non-ready transition" },
    { type: "makesafe", from: "accepted", to: "scheduled", label: "make-safe type (creation text covers it)" },
    { type: "decking", from: "quoted", to: "order_confirmed", label: "decking type (no manager crew flow)" },
  ];
  for (const c of cases) {
    const { calls, restore } = stubFetch();
    try {
      const store = jobFixture(c.type, c.from);
      const res = await _updateJobStatus(makeClient(store), { job_id: "job-1", status: c.to });
      await flush();
      assertEquals(res.success, true, c.label);
      assertEquals(smsCalls(calls).length, 0, `zero SMS: ${c.label}`);
    } finally {
      restore();
    }
  }
});
