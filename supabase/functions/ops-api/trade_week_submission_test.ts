// P1-16.3: the real send door, with invented identities and money only.
// deno-lint-ignore-file no-explicit-any
import "./trade_app_visibility_rules_test_env.ts";
import { assert, assertEquals } from "jsr:@std/assert@1";
Deno.env.set("XERO_CLIENT_ID", "ZZTEST-app");
const { _opsApiRequestHandlerForTest } = await import("./index.ts");

const TRADE = "00000000-0000-4000-8000-000000000031";
const ORG = "00000000-0000-4000-8000-000000000032";
const JOB = "00000000-0000-4000-8000-000000000033";
const INVOICE = "00000000-0000-4000-8000-000000000034";
const CARD = "00000000-0000-4000-8000-000000000035";
const WEEK = "2026-11-02";
const card = (over: any = {}) => ({
  id: CARD,
  job_id: JOB,
  user_id: TRADE,
  scheduled_date: "2026-11-03",
  status: "complete",
  is_ghost: false,
  invoiced_in: null,
  clocked_on_at: "2026-11-02T23:00:00Z",
  clocked_off_at: "2026-11-03T07:00:00Z",
  break_minutes: 30,
  hours_worked: 7.5,
  ...over,
});
type World = {
  on?: boolean;
  cards?: any[];
  rates?: any[];
  gstRegistered?: boolean;
  fail?: "history" | "rates" | "profile" | "mark";
  body?: any;
  action?: string;
  xero?: boolean;
};
export async function send(world: World = {}) {
  const invoices: any[] = [],
    lines: any[] = [],
    marks: any[] = [],
    reads: URL[] = [];
  const xero: any[] = [];
  const config = new Map<string, any>();
  const cards = world.cards ?? [card()];
  const previous = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const rows = (x: any) => Array.isArray(x) ? x : [x];
    const accept = new Headers(init?.headers).get("accept") || "";
    const reply = (x: any[]) =>
      Promise.resolve(Response.json(
        accept.includes("vnd.pgrst.object") ? x[0] ?? null : x,
      ));
    const fail = () =>
      Promise.resolve(
        Response.json({ message: "ZZTEST unreadable", code: "XX000" }, {
          status: 500,
        }),
      );
    if (url.hostname === "api.xero.com") {
      if (method === "PUT" && url.pathname.endsWith("/Invoices")) {
        xero.push(raw);
        return Promise.reject(new Error("ZZTEST provider unavailable"));
      }
      return Promise.resolve(
        Response.json({
          Invoices: [],
          Contacts: [{
            ContactID: "ZZTEST-contact",
            Name: "ZZTEST trade",
            ContactStatus: "ACTIVE",
            IsSupplier: true,
          }],
        }),
      );
    }
    const matches = (row: any, key: string) => {
      const value = url.searchParams.get(key);
      return !value || !/^(eq\.|in\.)/.test(value) ||
        (value.startsWith("eq.")
          ? String(row[key]) === value.slice(3)
          : value.slice(4, -1).split(",").includes(String(row[key])));
    };
    if (url.pathname === "/auth/v1/user") {
      return Promise.resolve(
        Response.json({ id: TRADE, aud: "authenticated" }),
      );
    }
    const rpc = url.pathname.split("/rpc/")[1];
    if (rpc) {
      if (rpc === "job_mark_changed") {
        marks.push(raw);
        if (world.fail === "mark") return fail();
      }
      if (
        rpc === "persist_weekly_trade_invoice_v4" ||
        rpc === "persist_trade_work_order_invoice_v1"
      ) {
        invoices.push(raw.p_invoice);
        lines.push(...raw.p_lines);
      }
      return Promise.resolve(Response.json(INVOICE));
    }
    const table = url.pathname.split("/rest/v1/")[1];
    if (method === "GET") reads.push(url);
    if (
      table === "org_config" &&
      url.searchParams.get("config_key")?.includes("integration.xero.cooldown")
    ) {
      if (method !== "GET") {
        config.set(
          raw.config_key ?? url.searchParams.get("config_key")?.slice(3),
          raw,
        );
      }
      return reply([...config.values()]);
    }
    if (table === "users") {
      if (
        world.fail === "profile" &&
        url.searchParams.get("select")?.includes("default_hourly_rate")
      ) return fail();
      return reply([{
        id: TRADE,
        org_id: ORG,
        role: "trade",
        name: "ZZTEST trade",
        managed_verticals: [],
        trade_sees_all_jobs: false,
        invoice_type: "hourly",
        xero_contact_id: world.xero ? "ZZTEST-contact" : null,
        trade_details: { gstRegistered: world.gstRegistered === true },
      }]);
    }
    if (table === "feature_flags") {
      return reply([{
        enabled: world.on !== false &&
          url.searchParams.get("flag_name") === "eq.trade_week_autofill_v1",
      }]);
    }
    if (table === "xero_tokens" && world.xero) {
      return reply([{
        access_token: "ZZTEST-token",
        tenant_id: "ZZTEST-tenant",
        expires_at: "2100-01-01T00:00:00Z",
      }]);
    }
    if (
      table === "work_orders" && world.action === "submit_work_order_invoice"
    ) {
      return reply([{
        id: "00000000-0000-4000-8000-000000000036",
        org_id: ORG,
        job_id: JOB,
        assigned_user_id: TRADE,
        status: "complete",
        kind: "crew",
        scheduled_date: "2026-11-03",
        wo_number: "ZZTEST-WO",
        scope_items: [{
          description: "ZZTEST work",
          quantity: 1,
          unit_price: 300,
        }],
        jobs: {
          id: JOB,
          org_id: ORG,
          type: "miscellaneous",
          status: "complete",
          job_number: "ZZTEST-163",
          metadata: {},
        },
      }]);
    }
    if (table === "trade_rates") {
      return world.fail === "rates" ? fail() : reply(
        world.rates ??
          [{
            hourly_rate: 40,
            effective_from: "2026-01-01",
            effective_to: null,
          }],
      );
    }
    if (table === "job_assignments") {
      if (world.fail === "history" && url.searchParams.get("limit") === "10") {
        return fail();
      }
      return reply(
        cards.filter((c) => matches(c, "id") && matches(c, "job_id")),
      );
    }
    if (table === "jobs") {
      return reply([{
        id: JOB,
        org_id: ORG,
        type: "fencing",
        status: "scheduled",
        job_number: "ZZTEST-163",
        metadata: {},
      }]);
    }
    if (table === "trade_invoices") {
      if (method === "POST") {
        invoices.push(...rows(raw));
        return reply([{ id: INVOICE }]);
      }
      if (method === "PATCH" || method === "DELETE") {
        return reply([{ id: INVOICE }]);
      }
      return reply([]);
    }
    if (table === "trade_invoice_lines" && method === "POST") {
      lines.push(...rows(raw));
      return reply([]);
    }
    return reply([]);
  }) as typeof fetch;
  try {
    const response = await _opsApiRequestHandlerForTest(
      new Request(
        `https://example.invalid/ops-api?action=${
          world.action ?? "generate_trade_invoice"
        }`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            week_start: WEEK,
            gst_on: true,
            confirm_ms: 1499,
            manual_assignments: [{ assignment_id: CARD, hours: 7.5 }],
            ...world.body,
          }),
        },
      ),
    );
    return {
      status: response.status,
      response: await response.json(),
      invoices,
      lines,
      marks,
      reads,
      xero,
    };
  } finally {
    globalThis.fetch = previous;
  }
}
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

test("week send: matching, changed and unclocked hours retain the server suggestion", async () => {
  for (
    const [hours, clocked, changed] of [[7.5, true, false], [9, true, true], [
      9,
      false,
      null,
    ]] as const
  ) {
    const result = await send({
      cards: [card(
        clocked
          ? {}
          : { clocked_on_at: null, clocked_off_at: null, hours_worked: null },
      )],
      body: {
        manual_assignments: [{
          assignment_id: CARD,
          hours,
          suggested: { hours: 99 },
        }],
      },
    });
    assertEquals(result.status, 200, JSON.stringify(result.response));
    assertEquals(result.lines[0].changed_from_suggestion, changed);
    assertEquals(result.lines[0].suggested.hours, clocked ? 7.5 : null);
    assertEquals(result.lines[0].total_hours, hours);
    assertEquals(result.invoices[0].accepted_untouched, changed === false);
    assertEquals(result.invoices[0].confirm_seconds, 1);
    assertEquals(result.marks, [{ p_job_id: JOB, p_source: "trade_invoice" }]);
  }
});

test("week send: booked and added hourly work use the office rate and profile GST", async () => {
  for (const added of [false, true]) {
    const result = await send({
      cards: added
        ? [
          card({
            status: "scheduled",
            hours_worked: null,
            clocked_on_at: null,
            clocked_off_at: null,
          }),
        ]
        : [card()],
      body: added
        ? {
          manual_assignments: [],
          extra_items: [{
            type: "Labour",
            row_type: "labour",
            job_id: JOB,
            job_number: "ZZTEST-163",
            description: "ZZTEST work",
            quantity: 7.5,
            rate: 41,
            date: "2026-11-03",
          }],
        }
        : {
          manual_assignments: [{
            assignment_id: CARD,
            hours: 7.5,
            rate: 41,
            rate_source: "client_entered",
          }],
        },
    });
    assertEquals(result.status, 200, JSON.stringify(result.response));
    assertEquals(result.lines[0].line_total_ex, 300);
    assertEquals(result.lines[0].sent_values.typed_rate, 41);
    assertEquals(
      result.lines[0].office_review_note,
      "Rate is set by the office",
    );
    assertEquals(result.invoices[0].gst, 0);
    if (added) {
      assertEquals(result.lines[0].suggested, { source: "added_by_trade" });
    }
  }
});

test("week send: a rate change takes effect on its work day and leaves one line per card", async () => {
  const result = await send({
    cards: [card(), card({ id: "next", scheduled_date: "2026-11-04" })],
    rates: [{
      hourly_rate: 48,
      effective_from: "2026-11-04",
      effective_to: null,
    }, {
      hourly_rate: 40,
      effective_from: "2026-01-01",
      effective_to: "2026-11-03",
    }],
    body: {
      manual_assignments: [{ assignment_id: CARD, hours: 7.5 }, {
        assignment_id: "next",
        hours: 7.5,
      }],
    },
  });
  assertEquals(result.status, 200, JSON.stringify(result.response));
  assertEquals(result.lines.map((l) => l.line_total_ex), [300, 360]);
  assertEquals(result.marks.length, 1);
});

test("week send: omitted cards, failed reads, office changes and retry do not invent untouched acceptance", async () => {
  const omitted = await send({ cards: [card(), card({ id: "omitted" })] });
  assertEquals(omitted.invoices[0].accepted_untouched, false);
  const missing = await send({ rates: [] });
  assertEquals(missing.status, 422);
  assertEquals(missing.invoices.length, 0);
  const unavailable = await send({ fail: "history" });
  assertEquals(unavailable.status, 200);
  assertEquals(unavailable.invoices[0].accepted_untouched, false);
  const markFailure = await send({ fail: "mark" });
  assertEquals(markFailure.status, 200);
  for (const fail of ["rates", "profile"] as const) {
    const refused = await send({ fail });
    assert(refused.status >= 400);
    assertEquals(refused.invoices.length, 0);
    const retry = await send({
      rates: [{
        hourly_rate: 44,
        effective_from: "2026-01-01",
        effective_to: null,
      }],
      gstRegistered: true,
    });
    assertEquals(retry.status, 200);
    assertEquals(retry.lines[0].line_total_ex, 330);
    assertEquals(retry.invoices[0].gst > 0, true);
  }
});

test("week send off: typed rate, body GST and stored fields retain main's behaviour", async () => {
  const result = await send({
    on: false,
    body: {
      manual_assignments: [{
        assignment_id: CARD,
        hours: 7.5,
        rate: 41,
        rate_source: "client_entered",
      }],
    },
  });
  assertEquals(result.status, 200, JSON.stringify(result.response));
  assertEquals(result.lines[0].line_total_ex, 307.5);
  assertEquals(result.invoices[0].gst > 0, true);
  assertEquals("accepted_untouched" in result.invoices[0], false);
  assertEquals("suggested" in result.lines[0], false);
});

// Both send doors share GST authority and mark only after durable local storage.
test("work-order send: profile GST and one non-blocking job mark survive a mark fault", async () => {
  for (const on of [false, true]) {
    const result = await send({
      action: "submit_work_order_invoice",
      on,
      xero: true,
      fail: "mark",
      body: { work_order_id: "00000000-0000-4000-8000-000000000036" },
    });
    assertEquals(result.status, 200, JSON.stringify(result.response));
    assertEquals(result.invoices[0].gst, on ? 0 : 30);
    assertEquals(
      result.marks,
      on ? [{ p_job_id: JOB, p_source: "trade_invoice" }] : [],
    );
  }
});
