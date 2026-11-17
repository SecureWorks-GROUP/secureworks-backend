// P1-16.3: the real send door, with invented identities and money only.
// deno-lint-ignore-file no-explicit-any
import "./trade_app_visibility_rules_test_env.ts";
Deno.env.set("XERO_CLIENT_ID", "ZZTEST-app");
const { _opsApiRequestHandlerForTest } = await import("./index.ts");

export const TRADE = "00000000-0000-4000-8000-000000000031";
export const ORG = "00000000-0000-4000-8000-000000000032";
export const JOB = "00000000-0000-4000-8000-000000000033";
export const INVOICE = "00000000-0000-4000-8000-000000000034";
export const CARD = "00000000-0000-4000-8000-000000000035";
export const WEEK = "2026-11-02";
export const card = (over: any = {}) => ({
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
  fail?: "history" | "rates" | "profile" | "mark" | "wo_cards";
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
  const cards = (world.cards ?? [card()]).map((row) => ({ ...row }));
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
    const matches = (row: any, key: string) =>
      url.searchParams.getAll(key).every((value) => {
        if (value.startsWith("eq.")) return String(row[key]) === value.slice(3);
        if (value.startsWith("in.(")) {
          return value.slice(4, -1).split(",").includes(String(row[key]));
        }
        if (value.startsWith("gte.")) return String(row[key]) >= value.slice(4);
        if (value.startsWith("lte.")) return String(row[key]) <= value.slice(4);
        if (value === "is.null") return row[key] == null;
        return true;
      });
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
      if (
        world.fail === "wo_cards" &&
        url.searchParams.get("job_id")?.startsWith("in.") &&
        url.searchParams.get("select") ===
          "id,job_id,scheduled_date,invoiced_in"
      ) return fail();
      const selected = cards.filter((row) =>
        ["id", "job_id", "user_id", "scheduled_date", "status", "is_ghost"]
          .every((key) => matches(row, key))
      );
      if (method === "PATCH") {
        selected.forEach((row) => Object.assign(row, raw));
      }
      return reply(selected);
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
      cards,
      reads,
      xero,
    };
  } finally {
    globalThis.fetch = previous;
  }
}
