// deno-lint-ignore-file no-explicit-any no-import-prefix
// Dispatch v2, slice 8: the migrations, the column names the store and the
// sibling adapter use, and the PostgREST calls they make. No database: the
// migration text is read from disk and the client is a recording fake.
//
// Run: deno test --no-check --allow-env --allow-read supabase/functions/ops-api/dispatch_v2_replies_store_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  capturedEmailOf,
  EMAIL_SELECT,
  postgrestRepliesStore,
  REF_SELECT,
  SUGGESTION_SELECT,
} from "./dispatch_v2_replies_store.ts";
import {
  DELIVERY_SOURCE_SUPPLIER_EMAIL,
  isNotWired,
  postgrestDispatchRepliesSources,
} from "./dispatch_v2_replies_sources.ts";

const ROOT = new URL("../../", import.meta.url);
const TABLES = "migrations/20261023230000_dispatch_v2_replies_tables.sql";
const SCHEDULE = "migrations/20261023230100_dispatch_v2_replies_schedule.sql";

function read(path: string): string {
  return Deno.readTextFileSync(new URL(path, ROOT));
}

/** Column names of one CREATE TABLE in a migration's text. */
function columnsOf(sql: string, table: string): string[] {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`);
  assert(start >= 0, `${table} is created`);
  const body = sql.slice(start, sql.indexOf("\n);", start));
  return body.split("\n").slice(1)
    .map((l) => l.trim())
    .filter((l) =>
      /^[a-z_]+ /.test(l) && !/^(constraint|check|unique)\b/i.test(l)
    )
    .map((l) => l.split(" ")[0]);
}

function selectList(select: string): string[] {
  return select.split(",").map((c) => c.trim());
}

Deno.test("migration: the store reads only columns the tables have", () => {
  const sql = read(TABLES);
  const pairs: [string, string][] = [
    ["dispatch_v2_supplier_emails", EMAIL_SELECT],
    ["dispatch_v2_delivery_suggestions", SUGGESTION_SELECT],
    ["dispatch_v2_supplier_order_refs", REF_SELECT],
  ];
  for (const [table, select] of pairs) {
    const cols = columnsOf(sql, table);
    for (const c of selectList(select)) {
      assert(cols.includes(c), `${table}.${c}`);
    }
  }
  const scanCols = columnsOf(sql, "dispatch_v2_reply_scan_state");
  for (
    const c of [
      "id",
      "cursor_sequence",
      "last_scan_at",
      "last_result",
      "updated_at",
    ]
  ) {
    assert(scanCols.includes(c), `scan state ${c}`);
  }
});

Deno.test("migration: four tables, row security on, browser roles shut out", () => {
  const sql = read(TABLES);
  for (
    const t of [
      "dispatch_v2_supplier_emails",
      "dispatch_v2_supplier_order_refs",
      "dispatch_v2_delivery_suggestions",
      "dispatch_v2_reply_scan_state",
    ]
  ) {
    assert(
      sql.includes(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`),
      t,
    );
    assert(
      sql.includes(
        `REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated;`,
      ),
      t,
    );
    assert(sql.includes(`TO service_role;`), t);
    assert(
      !new RegExp(`GRANT[^;]*${t}[^;]*TO (anon|authenticated)`).test(sql),
      t,
    );
  }
  // One row per captured email, one suggestion per email.
  assert(sql.includes("UNIQUE (business_event_id)"));
  assert(sql.includes("UNIQUE (email_id)"));
  assert(sql.includes("UNIQUE (order_id, ref)"));
  // Nothing in it writes another table.
  assert(!/\b(UPDATE|INSERT INTO|DELETE FROM)\s+public\./i.test(sql));
  assert(!sql.includes("suppliers.email ="));
});

Deno.test("migration: the schedule is off by default and calls only the scan", () => {
  const sql = read(SCHEDULE);
  assert(sql.includes("('dispatch_v2_replies_v1', false,"));
  assert(sql.includes("ON CONFLICT (flag_name) DO NOTHING"));
  assert(sql.includes("ops-api?action=dispatch_v2_replies_scan"));
  assert(sql.includes("'Bearer ' || public.sw_service_key()"));
  assert(
    sql.includes("cron.schedule('dispatch-v2-replies-scan', '3-59/5 * * * *'"),
  );
  assert(sql.includes("WHERE public.automation_lane_enabled('capture')"));
  assert(
    sql.includes(
      "REVOKE ALL ON FUNCTION public.trigger_dispatch_v2_replies_scan() FROM PUBLIC, anon, authenticated;",
    ),
  );
  // Exactly one outbound call, to ops-api.
  assertEquals(sql.match(/net\.http_post/g)?.length, 1);
});

Deno.test("migration: names, order and rollbacks", () => {
  for (const name of [TABLES, SCHEDULE]) {
    const file = name.split("/")[1];
    assert(/^\d{14}_dispatch_v2_replies_/.test(file), file);
    // Later than the last sibling Dispatch v2 migration known when written
    // (be-dispatch-supplier-order-emails: 20261023214200).
    assert(file.slice(0, 14) > "20261023214200", file);
    const down = read(`rollbacks/${file.replace(".sql", "_down.sql")}`);
    assert(down.length > 0, file);
  }
  const downTables = read(
    "rollbacks/20261023230000_dispatch_v2_replies_tables_down.sql",
  );
  assert(
    downTables.includes(
      "DROP TABLE IF EXISTS public.dispatch_v2_supplier_emails;",
    ),
  );
  const downSchedule = read(
    "rollbacks/20261023230100_dispatch_v2_replies_schedule_down.sql",
  );
  assert(downSchedule.includes("jobname = 'dispatch-v2-replies-scan'"));
  assert(
    downSchedule.includes(
      "DROP FUNCTION IF EXISTS public.trigger_dispatch_v2_replies_scan();",
    ),
  );
});

Deno.test("capturedEmailOf: reads the capture reader's row and drops the Subject line", () => {
  const e = capturedEmailOf({
    id: "e1",
    sequence_number: "232752",
    provider_message_id: "email:abc@x",
    event_at: "2026-10-23T03:15:00Z",
    recorded_at: "2026-10-23T03:17:00Z",
    payload: {
      from: "sales@fencingwarehousewa.au",
      subject: "RE: Material Order Ref SWF-261500",
      body:
        "Subject: RE: Material Order Ref SWF-261500\n\nYes, delivery Monday.",
      conversation_id: "AAQk",
      sender_kind: "supplier",
      has_attachments: true,
      attachments: [{ name: "SO238780.pdf" }],
    },
    metadata: { capture_mode: "live", history_tier: "deep" },
  });
  assertEquals(e.sequence_number, 232752);
  assertEquals(e.body, "Yes, delivery Monday.");
  assertEquals(e.received_at, "2026-10-23T03:15:00Z");
  assertEquals(e.from_email, "sales@fencingwarehousewa.au");
  assertEquals(e.conversation_id, "AAQk");
  assertEquals(e.attachment_names, ["SO238780.pdf"]);
  assertEquals(e.history_tier, "deep");
});

// ── A recording PostgREST fake ────────────────────────────────────────────

type Call = { table: string; steps: [string, unknown[]][] };

function fakeClient(
  answer: (call: Call) => { data?: any; error?: any; count?: number },
) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, steps: [] };
      calls.push(call);
      const builder: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") {
            const r = answer(call);
            return (res: any) =>
              res({
                data: r.data ?? null,
                error: r.error ?? null,
                count: r.count ?? null,
              });
          }
          if (prop === "maybeSingle") {
            return () => {
              call.steps.push(["maybeSingle", []]);
              const r = answer(call);
              return Promise.resolve({
                data: r.data ?? null,
                error: r.error ?? null,
              });
            };
          }
          return (...args: unknown[]) => {
            call.steps.push([prop, args]);
            return builder;
          };
        },
      });
      return builder;
    },
  };
  return { client, calls };
}

function step(call: Call, name: string): unknown[][] {
  return call.steps.filter(([n]) => n === name).map(([, a]) => a);
}

Deno.test("store: the scan reads inbound email only, never the owner-private mailboxes", async () => {
  const { client, calls } = fakeClient(() => ({ data: [] }));
  await postgrestRepliesStore(client).readInboundEmails(
    500,
    "2026-10-23T07:58:00Z",
    200,
  );
  const c = calls[0];
  assertEquals(c.table, "business_events");
  assertEquals(step(c, "eq"), [
    ["source", "outlook-mail-capture"],
    ["channel", "email"],
    ["direction", "inbound"],
  ]);
  assertEquals(step(c, "gt"), [["sequence_number", 500]]);
  assertEquals(step(c, "lt"), [["recorded_at", "2026-10-23T07:58:00Z"]]);
  assertEquals(step(c, "or"), [[
    "privacy_classification.is.null,privacy_classification.neq.restricted_pii",
  ]]);
  assertEquals(step(c, "order"), [["sequence_number", { ascending: true }]]);
  assertEquals(step(c, "limit"), [[200]]);
});

Deno.test("store: a re-captured email is not stored twice (upsert ignoring duplicates)", async () => {
  const { client, calls } = fakeClient(() => ({ data: [] }));
  const row = await postgrestRepliesStore(client).insertEmail({} as any);
  assertEquals(row, null);
  assertEquals(step(calls[0], "upsert")[0][1], {
    onConflict: "business_event_id",
    ignoreDuplicates: true,
  });
});

Deno.test("store: two people pressing at once, the update checks the state it read", async () => {
  const { client, calls } = fakeClient(() => ({ data: [] }));
  const r = await postgrestRepliesStore(client).updateEmail(
    "org",
    "id1",
    "unmatched",
    { state: "hidden" },
  );
  assertEquals(r, null);
  assertEquals(step(calls[0], "eq"), [["org_id", "org"], ["id", "id1"], [
    "state",
    "unmatched",
  ]]);
});

Deno.test("sources: a missing sibling table reads as not wired, not as an error", async () => {
  assertEquals(isNotWired({ code: "42P01" }), true);
  assertEquals(isNotWired({ code: "PGRST205" }), true);
  assertEquals(isNotWired({ code: "23505" }), false);
  const { client } = fakeClient(() => ({
    error: { code: "PGRST205", message: "not found" },
  }));
  const s = postgrestDispatchRepliesSources(client);
  assertEquals(await s.listOrders("org", { sentSince: "2026-01-01" }), {
    available: false,
    rows: [],
  });
  assertEquals(await s.listApprovedSenders("org"), {
    available: false,
    rows: [],
  });
  assertEquals(await s.getOrder("org", "o1"), { available: false, rows: [] });
});

Deno.test("sources: orders read sent emails only, with job number and the box's confirmed date", async () => {
  const { client, calls } = fakeClient((call) => {
    if (call.table === "dispatch_supplier_order_emails") {
      return {
        data: [{
          id: "o1",
          job_id: "j1",
          supplier_id: "s1",
          supplier_name: "Stratco WA",
          status: "sent",
          sent_at: "2026-10-20T01:00:00Z",
          sent_internet_message_id: "<o1@x>",
          sent_conversation_id: "C1",
        }],
      };
    }
    if (call.table === "jobs") {
      return { data: [{ id: "j1", job_number: "SWF-261387" }] };
    }
    return {
      data: [{
        job_id: "j1",
        supplier_id: "s1",
        delivery_date: "2026-10-27",
        delivery_date_confirmed_at: "2026-10-22T00:00:00Z",
      }],
    };
  });
  const r = await postgrestDispatchRepliesSources(client).listOrders("org", {
    sentSince: "2026-04-26",
  });
  assertEquals(r.available, true);
  assertEquals(r.rows[0], {
    order_id: "o1",
    job_id: "j1",
    job_number: "SWF-261387",
    supplier_id: "s1",
    supplier_name: "Stratco WA",
    status: "sent",
    sent_at: "2026-10-20T01:00:00Z",
    sent_internet_message_id: "<o1@x>",
    sent_conversation_id: "C1",
    confirmed_delivery_date: "2026-10-27",
  });
  assertEquals(step(calls[0], "in"), [["status", ["sent", "send_unknown"]]]);
});

Deno.test("sources: the board's columns not there yet means no confirmed date, not a failure", async () => {
  const { client } = fakeClient((call) => {
    if (call.table === "dispatch_supplier_order_emails") {
      return {
        data: [{
          id: "o1",
          job_id: "j1",
          supplier_id: "s1",
          supplier_name: "X",
          status: "sent",
        }],
      };
    }
    if (call.table === "jobs") return { data: [] };
    return { error: { code: "42703", message: "column does not exist" } };
  });
  const r = await postgrestDispatchRepliesSources(client).listOrders("org", {
    sentSince: "x",
  });
  assertEquals(r.rows[0].confirmed_delivery_date, null);
});

Deno.test("sources: Accept writes the supplier box's date, confirmed time and source only", async () => {
  const { client, calls } = fakeClient(() => ({ data: [{ job_id: "j1" }] }));
  const order = {
    order_id: "o1",
    job_id: "j1",
    job_number: null,
    supplier_id: "s1",
    supplier_name: "Stratco WA",
    status: "sent",
    sent_at: null,
    sent_internet_message_id: null,
    sent_conversation_id: null,
    confirmed_delivery_date: null,
  };
  const r = await postgrestDispatchRepliesSources(client)
    .setConfirmedDeliveryDate({
      orgId: "org",
      order,
      date: "2026-10-27",
      now: "2026-10-23T08:00:00Z",
      suggestionId: "s",
    });
  assertEquals(r, { ok: true, confirmed_delivery_date: "2026-10-27" });
  assertEquals(calls[0].table, "job_material_suppliers");
  assertEquals(step(calls[0], "update"), [[{
    delivery_date: "2026-10-27",
    delivery_date_confirmed_at: "2026-10-23T08:00:00Z",
    delivery_date_source: DELIVERY_SOURCE_SUPPLIER_EMAIL,
  }]]);
  assertEquals(step(calls[0], "eq"), [["job_id", "j1"], ["supplier_id", "s1"]]);

  const missing = fakeClient(() => ({ error: { code: "PGRST204" } }));
  const r2 = await postgrestDispatchRepliesSources(missing.client)
    .setConfirmedDeliveryDate({
      orgId: "org",
      order,
      date: "2026-10-27",
      now: "x",
      suggestionId: "s",
    });
  assertEquals(r2.ok, false);
  assertEquals((r2 as any).code, "orders_not_wired");
});

Deno.test("sources: approved senders come from the app-kept list, To and CC, with their Xero contacts", async () => {
  const { client } = fakeClient((call) =>
    call.table === "dispatch_approved_supplier_emails"
      ? {
        data: [{
          id: "a1",
          name: "Stratco WA",
          to_emails: ["TradeWA@stratcowa.com.au"],
          cc_emails: ["tony.bacich@stratcowa.com.au"],
          active: true,
        }],
      }
      : {
        data: [{ supplier_id: "s1", approved_id: "a1" }, {
          supplier_id: "s2",
          approved_id: "a1",
        }],
      }
  );
  const r = await postgrestDispatchRepliesSources(client).listApprovedSenders(
    "org",
  );
  assertEquals(r.rows, [{
    supplier_key: "stratcowa",
    supplier_name: "Stratco WA",
    supplier_ids: ["s1", "s2"],
    emails: ["tradewa@stratcowa.com.au", "tony.bacich@stratcowa.com.au"],
  }]);
});
