// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch slice 5 (docs/dispatch-slice-5-contract.md): the two reads and the
// eight writes in dispatch_orders_store.ts, end to end, against an in-memory
// stand-in for PostgREST, storage and the two dispatch_commit_* functions. The
// stand-in knows every live column the code may name (a wrong column name is a
// 42703, as live), keeps the migration's keys, and records every request. The
// send transport is stubbed: nothing here can reach Resend. Supplier and job
// names and addresses are made up.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISPATCH_ORDERS_ACTIONS,
  DISPATCH_ORDERS_SENDING_ACTIONS,
  type DispatchOrdersContext,
  runDispatchOrdersAction,
} from "./dispatch_orders_store.ts";
import {
  DispatchMaterialsError,
  runDispatchMaterialsAction,
} from "./dispatch_materials_store.ts";
import type { DispatchTransportAnswer } from "./dispatch_order_send.ts";
import type { DispatchOrderPdfInput } from "./dispatch_order_pdf.ts";
import { sha256Hex } from "./dispatch_orders.ts";

// index.ts reads SUPABASE_URL and the service key into module constants, so
// they are set before it is imported (a closed local port) and restored.
const SERVICE_KEY = "test-service-role-key";
const ROUTINE_KEY = "test-routine-key";
const IMPORT_ENV: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};
const index = await (async () => {
  const saved = new Map(
    Object.keys(IMPORT_ENV).map((n) => [n, Deno.env.get(n)]),
  );
  for (const [name, value] of Object.entries(IMPORT_ENV)) {
    Deno.env.set(name, value);
  }
  try {
    return await import("./index.ts");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
})();
const {
  _authorizeOpsApiAction,
  _opsApiRequestHandlerForTest,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} = index;

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000ee";
type Row = Record<string, any>;

function uuid(prefix: string, n: number): string {
  return `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
const JOB = {
  fence: uuid("a1", 1),
  makesafe: uuid("a1", 2),
  other: uuid("a1", 3),
  repair: uuid("a1", 4),
};
const SUP = {
  steel: uuid("b1", 1),
  sheets: uuid("b1", 2),
  none: uuid("b1", 3),
  own: uuid("b1", 4),
  test: uuid("b1", 5),
  bad: uuid("b1", 6),
};
const USER = { shaun: uuid("d1", 1) };
const line = (n: number) => uuid("c1", n);

// Every column the live tables carry (information_schema, 14 Oct 2026), plus
// this slice's migration. Selecting or writing any other name is a 42703.
const SCHEMA: Record<string, string[]> = {
  jobs: [
    "id",
    "org_id",
    "job_number",
    "type",
    "status",
    "site_address",
    "site_suburb",
    "metadata",
    "scope_json",
    "pricing_json",
    "updated_at",
  ],
  suppliers: [
    "id",
    "org_id",
    "xero_contact_id",
    "name",
    "email",
    "phone",
    "is_active",
    "synced_at",
    "created_at",
    "updated_at",
  ],
  users: ["id", "org_id", "name", "email", "role"],
  job_material_suppliers: [
    "id",
    "org_id",
    "job_id",
    "supplier_id",
    "supplier_name",
    "position",
    "created_at",
    "created_by",
    "created_by_email",
  ],
  job_material_lines: [
    "id",
    "org_id",
    "job_id",
    "supplier_id",
    "description",
    "quantity",
    "unit",
    "status",
    "purchase_order_id",
    "source",
    "position",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    "created_by_email",
    "updated_by_email",
  ],
  job_dispatch_workings: [
    "job_id",
    "org_id",
    "working_out",
    "working_out_updated_at",
    "sketch_png",
    "sketch_updated_at",
  ],
  purchase_orders: [
    "id",
    "org_id",
    "job_id",
    "po_number",
    "supplier_name",
    "xero_contact_id",
    "status",
    "line_items",
    "subtotal",
    "tax",
    "total",
    "delivery_date",
    "reference",
    "notes",
    "xero_po_id",
    "synced_at",
    "created_by",
    "created_at",
    "updated_at",
    "invoice_received_at",
    "paid_at",
    "xero_bill_id",
    "delivery_confirmed_at",
    "confirmed_delivery_date",
    "po_type",
    "quote_revision_id",
    "supplier_id",
    "source",
    "created_by_email",
    "pdf_path",
    "pdf_sha256",
    "pdf_version",
    "pdf_rendered_at",
    "last_sent_pdf_version",
    "last_sent_at",
    "confirmed_delivery_set_at",
    "confirmed_delivery_set_by",
    "confirmed_delivery_set_by_email",
    "delivery_sighted_at",
    "delivery_sighted_by",
    "delivery_sighted_by_email",
  ],
  job_order_emails: [
    "id",
    "org_id",
    "job_id",
    "purchase_order_id",
    "supplier_id",
    "kind",
    "status",
    "subject",
    "body_text",
    "body_generated_sha",
    "pdf_version",
    "pdf_path",
    "pdf_sha256",
    "line_count",
    "order_lines",
    "to_email_sent",
    "attempt_to_email",
    "attempt_in_reply_to",
    "send_attempt",
    "last_error",
    "communication_id",
    "resend_id",
    "sent_at",
    "sent_by",
    "sent_by_email",
    "sent_via",
    "discarded_at",
    "discarded_by_email",
    "created_at",
    "updated_at",
    "created_by",
    "created_by_email",
  ],
  po_communications: [
    "id",
    "po_id",
    "job_id",
    "direction",
    "from_email",
    "to_email",
    "subject",
    "body_text",
    "body_html",
    "attachments_json",
    "sent_at",
    "received_at",
    "created_at",
    "communication_type",
    "message_id",
    "in_reply_to",
    "thread_id",
    "council_submission_id",
    "council_step_index",
    "delivery_status",
    "read_at",
    "cc_emails",
    "created_by",
    "ai_classification",
    "ai_confidence",
    "quote_version",
  ],
  email_events: [
    "id",
    "email_type",
    "entity_type",
    "entity_id",
    "job_id",
    "recipient",
    "sender",
    "subject",
    "resend_message_id",
    "status",
    "sent_at",
    "metadata",
    "created_at",
    "comms_channel",
  ],
  job_events: [
    "id",
    "job_id",
    "user_id",
    "event_type",
    "detail_json",
    "created_at",
  ],
};

function job(id: string, over: Row = {}): Row {
  return {
    id,
    org_id: ORG,
    job_number: "SWF-900001",
    type: "fencing",
    status: "order_materials",
    site_address: "1 Example St",
    site_suburb: "Exampleton",
    metadata: null,
    ...over,
  };
}

function supplier(id: string, name: string, email: string | null): Row {
  return { id, org_id: ORG, name, email, is_active: true };
}

function seed(): Record<string, Row[]> {
  return {
    jobs: [
      job(JOB.fence),
      job(JOB.makesafe, { type: "makesafe", job_number: "SWMS-90001" }),
      job(JOB.other, { org_id: OTHER_ORG }),
      job(JOB.repair, {
        type: "repair",
        job_number: "SWR-900002",
        site_address: "2 Example Rd, Exampleton",
        site_suburb: "Exampleton",
      }),
    ],
    suppliers: [
      supplier(SUP.steel, "Example Steel", "orders@steel-supplies.test"),
      supplier(SUP.sheets, "Example Sheets", "sales@sheets.test"),
      supplier(SUP.none, "No Email Supplies", null),
      supplier(SUP.own, "Our Own Address", "orders@secureworkswa.com.au"),
      supplier(SUP.test, "Test Address", "sales@example.com"),
      supplier(SUP.bad, "Two Addresses", "a@x.test; b@y.test"),
    ],
    users: [{
      id: USER.shaun,
      org_id: ORG,
      name: "Shaun",
      email: "shaun@ops.test",
      role: "ops_manager",
    }],
    job_material_suppliers: [],
    job_material_lines: [],
    job_dispatch_workings: [],
    purchase_orders: [],
    job_order_emails: [],
    po_communications: [],
    email_events: [],
    job_events: [],
  };
}

// ── The stand-in ────────────────────────────────────────────────────────────

type Recorded = {
  table: string;
  kind: string;
  select: string;
  filters: Array<[string, string, unknown]>;
};

function makeDb(initial = seed()) {
  let tables: Record<string, Row[]> = structuredClone(initial);
  const requests: Recorded[] = [];
  const failures = new Set<string>();
  const files = new Map<string, Uint8Array>();
  let clock = Date.UTC(2026, 9, 14, 3, 0, 0);
  // PostgREST's own stamp shape: microseconds and +00:00.
  const tick = () =>
    new Date(clock += 1000).toISOString().replace("Z", "000+00:00");
  let seq = 1_000_000;

  const violation = (code: string, message: string) => ({
    data: null,
    error: { code, message },
  });

  function columnsOf(select: string): Array<[string, string]> {
    if (!select || select === "*") return [];
    return select.split(",").map((raw) => raw.trim()).filter(Boolean).map(
      (item) => {
        const colon = item.indexOf(":");
        return colon >= 0
          ? [item.slice(0, colon), item.slice(colon + 1)]
          : [item, item];
      },
    );
  }
  function baseColumn(expression: string) {
    return expression.split("->")[0];
  }
  function valueOf(row: Row, expression: string): unknown {
    const text = /^(\w+)->>(\w+)$/.exec(expression);
    if (text) {
      const v = row[text[1]]?.[text[2]];
      return v === undefined || v === null ? null : String(v);
    }
    return row[expression];
  }
  function unknownColumn(table: string, names: string[]) {
    const known = SCHEMA[table];
    if (!known) return null;
    const bad = names.find((n) => !known.includes(baseColumn(n)));
    return bad
      ? violation("42703", `column ${table}.${bad} does not exist`)
      : null;
  }
  function project(_table: string, row: Row, select: string): Row {
    if (!select || select === "*") return { ...row };
    const out: Row = {};
    for (const [alias, expression] of columnsOf(select)) {
      out[alias] = valueOf(row, expression) ?? null;
    }
    return out;
  }

  function checkRow(table: string, row: Row, all: Row[]) {
    if (table === "job_order_emails") {
      if (
        !["draft", "sending", "sent", "send_unknown", "discarded"].includes(
          row.status,
        )
      ) {
        return violation("23514", "job_order_emails_status_valid");
      }
      const open = ["draft", "sending", "send_unknown"];
      if (
        open.includes(row.status) &&
        all.some((r) =>
          r !== row && r.purchase_order_id === row.purchase_order_id &&
          open.includes(r.status)
        )
      ) {
        return violation("23505", "job_order_emails_open_per_order_key");
      }
    }
    if (table === "purchase_orders") {
      if (
        all.some((r) =>
          r !== row && r.org_id === row.org_id && r.po_number === row.po_number
        )
      ) {
        return violation("23505", "purchase_orders_org_po_number_key");
      }
      if (
        typeof row.created_by === "string" &&
        !/^[0-9a-f-]{36}$/.test(row.created_by)
      ) {
        return violation("22P02", "invalid input syntax for type uuid");
      }
    }
    if (
      table === "job_material_lines" &&
      !["not_reviewed", "to_order", "in_stock"].includes(row.status)
    ) {
      return violation("23514", "job_material_lines_status_valid");
    }
    return null;
  }

  function from(table: string) {
    const request: Recorded = {
      table,
      kind: "select",
      select: "",
      filters: [],
    };
    requests.push(request);
    const orders: Array<[string, boolean]> = [];
    let limit: number | null = null;
    let range: [number, number] | null = null;
    let single: "single" | "maybe" | null = null;
    let returning: string | null = null;
    let payload: any = null;
    let head = false;

    const matches = (row: Row) =>
      request.filters.every(([op, column, value]) => {
        const actual = valueOf(row, column);
        if (op === "eq") {
          return actual !== null && actual !== undefined &&
            String(actual) === String(value);
        }
        if (op === "neq") {
          return actual !== null && actual !== undefined &&
            String(actual) !== String(value);
        }
        if (op === "in") {
          return (value as unknown[]).map(String).includes(String(actual));
        }
        if (op === "is") return (actual ?? null) === value;
        if (op === "ilike") {
          return ilikeMatches(String(actual ?? ""), String(value));
        }
        return true;
      });

    const finish = (rows: Row[]) => {
      if (single === "single") {
        return rows.length === 1
          ? { data: rows[0], error: null }
          : violation("PGRST116", "not one row");
      }
      if (single === "maybe") {
        return rows.length > 1
          ? violation("PGRST116", "many rows")
          : { data: rows[0] ?? null, error: null };
      }
      if (request.kind !== "select" && returning === null) {
        return { data: null, error: null };
      }
      return { data: rows, error: null };
    };

    const execute = (): any => {
      if (failures.has(`${request.kind}:${table}`)) {
        return violation("XX000", `forced failure on ${request.kind} ${table}`);
      }
      const rows = tables[table] ||= [];
      const named = [
        ...columnsOf(
          request.kind === "select" ? request.select : (returning || ""),
        ).map(([, e]) => e),
        ...request.filters.map(([, c]) => c),
        ...orders.map(([c]) => c),
      ];
      const bad = unknownColumn(table, named);
      if (bad) return bad;
      if (request.kind === "select") {
        let found = rows.filter(matches);
        found.sort((a, b) => {
          for (const [c, asc] of orders) {
            if (a[c] === b[c]) continue;
            return (a[c] < b[c] ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        if (head) return { data: null, count: found.length, error: null };
        if (range) found = found.slice(range[0], range[1] + 1);
        if (limit !== null) found = found.slice(0, limit);
        return finish(found.map((r) => project(table, r, request.select)));
      }
      if (request.kind === "insert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map((
          r: Row,
        ) => ({ ...r }));
        const badWrite = unknownColumn(
          table,
          incoming.flatMap((r: Row) => Object.keys(r)),
        );
        if (badWrite) return badWrite;
        for (const row of incoming) {
          row.id ??= crypto.randomUUID();
          row.created_at ??= tick();
          const failure = checkRow(table, row, [...rows, ...incoming]);
          if (failure) return failure;
        }
        rows.push(...incoming);
        return finish(
          incoming.map((r: Row) => project(table, r, returning || "*")),
        );
      }
      if (request.kind === "update") {
        const badWrite = unknownColumn(table, Object.keys(payload));
        if (badWrite) return badWrite;
        const targets = rows.filter(matches);
        const next = targets.map((t) => ({
          ...t,
          ...payload,
          ...(table === "purchase_orders" ? { updated_at: tick() } : {}),
        }));
        for (const n of next) {
          const failure = checkRow(
            table,
            n,
            rows.map((r) => next.find((x) => x.id === r.id) ?? r).filter((r) =>
              r !== n
            ).concat([n]),
          );
          if (failure) return failure;
        }
        targets.forEach((t, i) => Object.assign(t, next[i]));
        return finish(targets.map((r) => project(table, r, returning || "*")));
      }
      const targets = rows.filter(matches);
      tables[table] = rows.filter((r) => !targets.includes(r));
      return finish(targets.map((r) => project(table, r, returning || "id")));
    };

    const builder: any = {
      select(columns: string, options?: { head?: boolean }) {
        if (request.kind === "select") request.select = columns;
        else returning = columns;
        if (options?.head) head = true;
        return builder;
      },
      insert(value: any) {
        request.kind = "insert";
        payload = value;
        return builder;
      },
      update(value: any) {
        request.kind = "update";
        payload = value;
        return builder;
      },
      delete() {
        request.kind = "delete";
        return builder;
      },
      eq(c: string, v: unknown) {
        request.filters.push(["eq", c, v]);
        return builder;
      },
      neq(c: string, v: unknown) {
        request.filters.push(["neq", c, v]);
        return builder;
      },
      in(c: string, v: unknown[]) {
        request.filters.push(["in", c, v]);
        return builder;
      },
      is(c: string, v: unknown) {
        request.filters.push(["is", c, v]);
        return builder;
      },
      ilike(c: string, v: string) {
        request.filters.push(["ilike", c, v]);
        return builder;
      },
      order(c: string, o?: { ascending?: boolean }) {
        orders.push([c, o?.ascending !== false]);
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      range(a: number, b: number) {
        range = [a, b];
        return Promise.resolve(execute());
      },
      single() {
        single = "single";
        return builder;
      },
      maybeSingle() {
        single = "maybe";
        return builder;
      },
      then(resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };
    return builder;
  }

  // ── The two transactions, as the migration writes them ─────────────────────
  class Raise extends Error {}
  const raise = (word: string): never => {
    throw new Raise(word);
  };
  // A database error inside the transaction: everything it wrote rolls back.
  class Fault extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  }
  function atomically(name: string, fn: () => any) {
    requests.push({
      table: `rpc:${name}`,
      kind: "rpc",
      select: "",
      filters: [],
    });
    if (failures.has(`rpc:${name}`)) {
      return violation("XX000", `forced failure on rpc ${name}`);
    }
    const before = structuredClone(tables);
    try {
      return { data: fn(), error: null };
    } catch (error) {
      tables = before;
      if (error instanceof Raise) {
        return { data: null, error: { code: "P0001", message: error.message } };
      }
      if (error instanceof Fault) {
        return violation(error.code, error.message);
      }
      throw error;
    }
  }
  const lineRows = () => tables.job_material_lines;

  function commitOrder(p: any) {
    const stamps: any[] = p.lines || [];
    if (stamps.length === 0) raise("no_lines_to_order");
    if (
      tables.purchase_orders.some((o) =>
        o.job_id === p.job_id && o.supplier_id === p.supplier_id &&
        o.source === "dispatch" &&
        !["cancelled", "deleted"].includes(o.status) && !o.xero_po_id
      )
    ) raise("order_open");
    const now = tick();
    const order: Row = {
      id: crypto.randomUUID(),
      org_id: p.org_id,
      job_id: p.job_id,
      po_number: p.po_number,
      supplier_name: p.supplier_name,
      supplier_id: p.supplier_id,
      source: "dispatch",
      status: "draft",
      po_type: "material",
      line_items: p.line_items,
      subtotal: 0,
      tax: 0,
      total: 0,
      reference: p.reference,
      created_by: p.actor?.user_id ?? null,
      created_by_email: p.actor?.email ?? null,
      pdf_path: p.pdf.path,
      pdf_sha256: p.pdf.sha256,
      pdf_version: p.pdf.version,
      pdf_rendered_at: now,
      xero_po_id: null,
      last_sent_at: null,
      last_sent_pdf_version: null,
      created_at: now,
      updated_at: now,
    };
    const failure = checkRow("purchase_orders", order, [
      ...tables.purchase_orders,
      order,
    ]);
    if (failure) throw new Raise(failure.error.message);
    tables.purchase_orders.push(order);
    let stamped = 0;
    for (const s of stamps) {
      const l = lineRows().find((r) =>
        r.id === s.id && r.updated_at === s.updated_at &&
        r.job_id === p.job_id && r.supplier_id === p.supplier_id &&
        r.status === "to_order" && !r.purchase_order_id
      );
      if (l) {
        Object.assign(l, {
          purchase_order_id: order.id,
          updated_at: now,
          updated_by_email: p.actor?.email ?? null,
        });
        stamped++;
      }
    }
    if (stamped !== stamps.length) raise("lines_changed");
    if (
      lineRows().some((r) =>
        r.job_id === p.job_id && r.supplier_id === p.supplier_id &&
        r.status === "to_order" && !r.purchase_order_id
      )
    ) raise("lines_changed");
    const draft: Row = {
      id: crypto.randomUUID(),
      org_id: order.org_id,
      job_id: p.job_id,
      purchase_order_id: order.id,
      supplier_id: p.supplier_id,
      kind: "order",
      status: "draft",
      subject: p.draft.subject,
      body_text: p.draft.body_text,
      body_generated_sha: p.draft.body_generated_sha,
      pdf_version: order.pdf_version,
      pdf_path: order.pdf_path,
      pdf_sha256: order.pdf_sha256,
      line_count: stamps.length,
      order_lines: p.line_items,
      last_error: null,
      created_at: now,
      updated_at: now,
      created_by_email: p.actor?.email ?? null,
    };
    tables.job_order_emails.push(draft);
    tables.job_events.push({
      id: crypto.randomUUID(),
      job_id: p.job_id,
      user_id: p.actor?.user_id ?? null,
      event_type: "po_created",
      detail_json: {
        po_number: order.po_number,
        supplier: order.supplier_name,
        total: 0,
        source: "dispatch",
        operator_email: p.actor?.email ?? null,
      },
      created_at: now,
    });
    return { order: { ...order }, draft: { ...draft } };
  }

  function releaseUnknown(p: any) {
    const email = p.actor?.email || null;
    if (!email) raise("operator_required");
    const draft = tables.job_order_emails.find((e) =>
      e.id === p.draft_id && e.job_id === p.job_id
    );
    if (!draft || !["sending", "send_unknown"].includes(draft.status)) {
      raise("draft_not_unknown");
    }
    if (
      draft!.status !== p.prior_status ||
      Date.parse(draft!.updated_at) !== Date.parse(p.prior_updated_at)
    ) raise("draft_changed");
    const now = tick();
    const prior = { ...draft! };
    Object.assign(draft!, {
      status: "draft",
      attempt_to_email: null,
      attempt_in_reply_to: null,
      send_attempt: (prior.send_attempt ?? 1) + 1,
      last_error: `Released as not sent by ${email}`.slice(0, 1000),
      updated_at: now,
    });
    if (failures.has("insert:job_events")) {
      throw new Fault("XX000", "forced failure on insert job_events");
    }
    const order = tables.purchase_orders.find((o) =>
      o.id === prior.purchase_order_id
    );
    tables.job_events.push({
      id: crypto.randomUUID(),
      job_id: prior.job_id,
      user_id: p.actor?.user_id ?? null,
      event_type: "po_email_send_released",
      detail_json: {
        po_id: prior.purchase_order_id,
        po_number: order?.po_number ?? null,
        draft_id: prior.id,
        prior_status: prior.status,
        prior_attempt: prior.send_attempt ?? 1,
        released_at: now,
        operator_email: email,
        via: p.via,
        source: "dispatch",
      },
      created_at: now,
    });
    return { draft: { ...draft! } };
  }

  function commitUpdate(p: any) {
    const now = tick();
    if (
      tables.job_order_emails.some((e) =>
        e.purchase_order_id === p.order_id &&
        ["sending", "send_unknown"].includes(e.status)
      )
    ) raise("draft_sending");
    const order = tables.purchase_orders.find((o) =>
      o.id === p.order_id && o.job_id === p.job_id && o.source === "dispatch" &&
      o.updated_at === p.expected_order_updated_at && !o.xero_po_id &&
      !["cancelled", "deleted"].includes(o.status) &&
      (p.mode !== "cancel" || !o.last_sent_at)
    );
    if (!order) raise("order_changed");
    if (p.mode === "cancel") {
      Object.assign(order!, { status: "cancelled", updated_at: now });
      for (const l of lineRows()) {
        if (l.purchase_order_id === order!.id) {
          Object.assign(l, {
            purchase_order_id: null,
            status: "to_order",
            updated_at: now,
          });
        }
      }
      for (const e of tables.job_order_emails) {
        if (e.purchase_order_id === order!.id && e.status === "draft") {
          Object.assign(e, {
            status: "discarded",
            discarded_at: now,
            discarded_by_email: p.actor?.email ?? null,
            updated_at: now,
          });
        }
      }
      tables.job_events.push({
        id: crypto.randomUUID(),
        job_id: p.job_id,
        user_id: p.actor?.user_id ?? null,
        event_type: "po_cancelled",
        detail_json: {
          po_number: order!.po_number,
          supplier: order!.supplier_name,
          operator_email: p.actor?.email ?? null,
        },
        created_at: now,
      });
      return { order: { ...order } };
    }
    Object.assign(order!, {
      line_items: p.line_items,
      pdf_path: p.pdf.path,
      pdf_sha256: p.pdf.sha256,
      pdf_version: p.pdf.version,
      pdf_rendered_at: now,
      updated_at: now,
    });
    const keep = p.keep || [], remove = p.remove || [], add = p.add || [];
    if (
      keep.some((s: any) =>
        !lineRows().some((l) =>
          l.id === s.id && l.updated_at === s.updated_at &&
          l.purchase_order_id === order!.id
        )
      )
    ) raise("lines_changed");
    for (const s of remove) {
      const l = lineRows().find((r) =>
        r.id === s.id && r.updated_at === s.updated_at &&
        r.purchase_order_id === order!.id
      );
      if (!l) raise("lines_changed");
      Object.assign(l!, {
        purchase_order_id: null,
        status: "to_order",
        updated_at: now,
      });
    }
    for (const s of add) {
      const l = lineRows().find((r) =>
        r.id === s.id && r.updated_at === s.updated_at &&
        r.job_id === p.job_id && r.supplier_id === order!.supplier_id &&
        r.status === "to_order" && !r.purchase_order_id
      );
      if (!l) raise("lines_changed");
      Object.assign(l!, { purchase_order_id: order!.id, updated_at: now });
    }
    const want = keep.length + add.length;
    if (
      want === 0 ||
      lineRows().filter((l) => l.purchase_order_id === order!.id).length !==
        want
    ) raise("lines_changed");
    if (
      lineRows().some((l) =>
        l.job_id === p.job_id && l.supplier_id === order!.supplier_id &&
        l.status === "to_order" && !l.purchase_order_id &&
        !remove.some((r: any) => r.id === l.id)
      )
    ) raise("lines_changed");
    let draft: Row | undefined;
    if (p.draft_update) {
      draft = tables.job_order_emails.find((e) =>
        e.id === p.draft_update.id && e.purchase_order_id === order!.id &&
        e.status === "draft" &&
        e.updated_at === p.draft_update.expected_updated_at
      );
      if (!draft) raise("draft_changed");
      const f = p.draft_update.fields || {};
      Object.assign(draft!, {
        pdf_version: order!.pdf_version,
        pdf_path: order!.pdf_path,
        pdf_sha256: order!.pdf_sha256,
        line_count: want,
        order_lines: p.line_items,
        subject: f.subject ?? draft!.subject,
        body_text: f.body_text ?? draft!.body_text,
        body_generated_sha: f.body_generated_sha ?? draft!.body_generated_sha,
        last_error: null,
        updated_at: now,
      });
    } else {
      if (
        tables.job_order_emails.some((e) =>
          e.purchase_order_id === order!.id && e.status === "draft"
        )
      ) raise("draft_changed");
      draft = {
        id: crypto.randomUUID(),
        org_id: order!.org_id,
        job_id: p.job_id,
        purchase_order_id: order!.id,
        supplier_id: order!.supplier_id,
        kind: p.draft_insert.kind,
        status: "draft",
        subject: p.draft_insert.subject,
        body_text: p.draft_insert.body_text,
        body_generated_sha: p.draft_insert.body_generated_sha,
        pdf_version: order!.pdf_version,
        pdf_path: order!.pdf_path,
        pdf_sha256: order!.pdf_sha256,
        line_count: want,
        order_lines: p.line_items,
        last_error: null,
        created_at: now,
        updated_at: now,
      };
      tables.job_order_emails.push(draft);
    }
    return { order: { ...order }, draft: { ...draft } };
  }

  const client = {
    from,
    rpc(name: string, args: any) {
      if (name === "dispatch_next_po_number") {
        requests.push({
          table: `rpc:${name}`,
          kind: "rpc",
          select: "",
          filters: [],
        });
        return Promise.resolve({ data: `PO-${++seq}`, error: null });
      }
      if (name === "dispatch_commit_order") {
        return Promise.resolve(atomically(name, () => commitOrder(args.p)));
      }
      if (name === "dispatch_commit_order_update") {
        return Promise.resolve(atomically(name, () => commitUpdate(args.p)));
      }
      if (name === "dispatch_release_unknown_send") {
        return Promise.resolve(atomically(name, () => releaseUnknown(args.p)));
      }
      return Promise.resolve(
        violation("42883", `function ${name} does not exist`),
      );
    },
    storage: {
      from(bucket: string) {
        assertEquals(bucket, "dispatch-order-pdfs");
        return {
          upload(path: string, bytes: Uint8Array, options: any) {
            requests.push({
              table: "storage",
              kind: "upload",
              select: path,
              filters: [],
            });
            if (failures.has("storage:upload")) {
              return Promise.resolve({
                data: null,
                error: { statusCode: "500", message: "down" },
              });
            }
            if (files.has(path) && !options?.upsert) {
              return Promise.resolve({
                data: null,
                error: {
                  statusCode: "409",
                  message: "The resource already exists",
                },
              });
            }
            files.set(path, new Uint8Array(bytes));
            return Promise.resolve({ data: { path }, error: null });
          },
          remove(paths: string[]) {
            requests.push({
              table: "storage",
              kind: "remove",
              select: paths.join(","),
              filters: [],
            });
            for (const p of paths) files.delete(p);
            return Promise.resolve({ data: [], error: null });
          },
          download(path: string) {
            const bytes = files.get(path);
            return Promise.resolve(
              bytes
                ? { data: new Blob([bytes as BlobPart]), error: null }
                : { data: null, error: { message: "not found" } },
            );
          },
          createSignedUrl(path: string, seconds: number) {
            requests.push({
              table: "storage",
              kind: "sign",
              select: path,
              filters: [],
            });
            return Promise.resolve(
              files.has(path)
                ? {
                  data: {
                    signedUrl:
                      `https://storage.test/${path}?expires=${seconds}`,
                  },
                  error: null,
                }
                : { data: null, error: { message: "Object not found" } },
            );
          },
        };
      },
    },
  };
  return {
    client,
    get tables() {
      return tables;
    },
    requests,
    failures,
    files,
    tick,
    writes: () => requests.filter((r) => !["select", "sign"].includes(r.kind)),
  };
}

// The PDF is stubbed with a small deterministic stand-in so these tests stay
// fast; dispatch_order_pdf_test.ts renders the real one. Its line count is the
// lines it was given.
async function fakePdf(input: DispatchOrderPdfInput) {
  const bytes = new TextEncoder().encode(
    `%PDF ${JSON.stringify([input.poNumber, input.version, input.lines])}`,
  );
  return {
    bytes,
    sha256: await sha256Hex(bytes),
    pageCount: 1,
    lineCount: input.lines.length,
  };
}

type Transport = {
  calls: Array<{ payload: any; idempotencyKey: string }>;
  answers: DispatchTransportAnswer[];
};
function transport(
  answers: DispatchTransportAnswer[] = [],
): Transport & { fn: any } {
  const t: any = { calls: [], answers: [...answers] };
  t.fn = (request: any) => {
    t.calls.push(request);
    const answer = t.answers.shift() ??
      { status: 200, body: { id: `resend-${t.calls.length}` } };
    if (answer.status === 0) return Promise.reject(new Error("network down"));
    return Promise.resolve(answer);
  };
  return t;
}

function ctx(
  db: ReturnType<typeof makeDb>,
  t = transport(),
  over: Partial<DispatchOrdersContext> = {},
): DispatchOrdersContext {
  return {
    orgId: ORG,
    actor: { userId: USER.shaun, email: "shaun@ops.test", orgId: ORG },
    via: "screen",
    transport: t.fn,
    renderPdf: fakePdf,
    now: () => db.tick(),
    ...over,
  };
}

const terminal = (db: ReturnType<typeof makeDb>, t = transport()) =>
  ctx(db, t, {
    actor: { userId: null, email: null, orgId: null },
    via: "terminal",
  });

function call(
  db: ReturnType<typeof makeDb>,
  action: string,
  body: Row = {},
  c = ctx(db),
) {
  return runDispatchOrdersAction(
    db.client,
    action,
    new URLSearchParams(),
    body,
    c,
  ) as Promise<any>;
}
function get(
  db: ReturnType<typeof makeDb>,
  action: string,
  params: Record<string, string>,
  c = ctx(db),
) {
  return runDispatchOrdersAction(
    db.client,
    action,
    new URLSearchParams(params),
    {},
    c,
  ) as Promise<any>;
}
async function refused(
  promise: Promise<unknown>,
  status: number,
  code: string,
) {
  const error = await assertRejects(
    () => promise,
    DispatchMaterialsError,
  ) as DispatchMaterialsError;
  assertEquals([error.status, error.body.code], [status, code], error.message);
  return error;
}

// A job with the steel supplier chosen and three lines: two To order, one Not
// reviewed; and a sheets supplier with one To order line.
function withLines(db = makeDb(), jobId = JOB.fence) {
  const add = (
    supplierId: string,
    n: number,
    status: string,
    position: number,
  ) =>
    db.tables.job_material_lines.push({
      id: line(n),
      org_id: ORG,
      job_id: jobId,
      supplier_id: supplierId,
      description: `Item ${n}`,
      quantity: n * 2,
      unit: n === 1 ? "posts" : null,
      status,
      purchase_order_id: null,
      source: "manual",
      position,
      created_at: db.tick(),
      updated_at: db.tick(),
    });
  for (
    const [i, s] of [
      SUP.steel,
      SUP.sheets,
      SUP.none,
      SUP.own,
      SUP.test,
      SUP.bad,
    ].entries()
  ) {
    db.tables.job_material_suppliers.push({
      id: crypto.randomUUID(),
      org_id: ORG,
      job_id: jobId,
      supplier_id: s,
      supplier_name: "x",
      position: i + 1,
    });
  }
  add(SUP.steel, 1, "to_order", 1);
  add(SUP.steel, 2, "to_order", 2);
  add(SUP.steel, 3, "not_reviewed", 3);
  add(SUP.sheets, 4, "to_order", 4);
  return db;
}

function stamps(
  db: ReturnType<typeof makeDb>,
  supplierId: string,
  jobId = JOB.fence,
) {
  return db.tables.job_material_lines
    .filter((l) =>
      l.job_id === jobId && l.supplier_id === supplierId &&
      l.status === "to_order" && !l.purchase_order_id
    )
    .map((l) => ({ id: l.id, updated_at: l.updated_at }));
}

async function create(
  db: ReturnType<typeof makeDb>,
  supplierId = SUP.steel,
  c = ctx(db),
  jobId = JOB.fence,
) {
  return await call(db, "dispatch_order_create", {
    job_id: jobId,
    supplier_id: supplierId,
    lines: stamps(db, supplierId, jobId),
  }, c);
}

function orderRow(db: ReturnType<typeof makeDb>, poNumber: string) {
  return db.tables.purchase_orders.find((o) => o.po_number === poNumber)!;
}

const ALLOWED_TABLES = new Set([
  "jobs",
  "suppliers",
  "users",
  "job_material_suppliers",
  "job_material_lines",
  "purchase_orders",
  "job_order_emails",
  "po_communications",
  "email_events",
  "job_events",
  "storage",
  "rpc:dispatch_next_po_number",
  "rpc:dispatch_commit_order",
  "rpc:dispatch_commit_order_update",
  "rpc:dispatch_release_unknown_send",
]);
// Tables only the RPCs and the send's filing may write; every other write is a defect.
const WRITABLE_DIRECT = new Set([
  "job_order_emails",
  "po_communications",
  "email_events",
  "job_events",
  "purchase_orders",
  "storage",
]);

function assertOnlyAllowedTouches(db: ReturnType<typeof makeDb>) {
  for (const r of db.requests) {
    assert(ALLOWED_TABLES.has(r.table), `touched ${r.table}`);
    if (
      r.kind !== "select" && r.kind !== "sign" && !r.table.startsWith("rpc:")
    ) {
      assert(WRITABLE_DIRECT.has(r.table), `${r.kind} on ${r.table}`);
    }
  }
}

// ── Create ──────────────────────────────────────────────────────────────────

// PostgREST ILIKE: % and * are any run, _ is one character, a backslash
// makes the next character literal; case-blind.
function ilikeMatches(actual: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%" || c === "*") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is").test(actual);
}

Deno.test("create: one order with exactly the To order lines, no price; lines stamped; one PDF; one held draft; one event", async () => {
  const db = withLines();
  const answer = await create(db);
  assertEquals(answer.success, true);
  const order = orderRow(db, "PO-1000001");
  assertEquals([
    order.source,
    order.status,
    order.supplier_id,
    order.total,
    order.subtotal,
    order.tax,
  ], ["dispatch", "draft", SUP.steel, 0, 0, 0]);
  assertEquals([order.created_by, order.created_by_email, order.reference], [
    USER.shaun,
    "shaun@ops.test",
    "SWF-900001",
  ]);
  assertEquals(order.line_items, [
    { line_id: line(1), description: "Item 1", quantity: 2, unit: "posts" },
    { line_id: line(2), description: "Item 2", quantity: 4, unit: null },
  ]);
  assert(!JSON.stringify(order.line_items).includes("price"));
  const stamped = db.tables.job_material_lines.filter((l) =>
    l.purchase_order_id === order.id
  ).map((l) => l.id).sort();
  assertEquals(stamped, [line(1), line(2)]);
  assertEquals(
    db.tables.job_material_lines.find((l) => l.id === line(3))!
      .purchase_order_id,
    null,
  );
  assertEquals(
    db.tables.job_material_lines.find((l) => l.id === line(4))!
      .purchase_order_id,
    null,
  );
  // The PDF is on file at its path, and its line count is the order's.
  assertEquals(order.pdf_path, `${JOB.fence}/PO-1000001-v1.pdf`);
  assert(db.files.has(order.pdf_path));
  assertEquals(answer.draft.pdf, {
    version: 1,
    file_name: "PO-1000001.pdf",
    line_count: 2,
  });
  assertEquals(answer.draft.to, {
    email: "orders@steel-supplies.test",
    state: "ok",
  });
  assertEquals(
    answer.draft.subject,
    "Purchase order PO-1000001 for SWF-900001",
  );
  assert(
    answer.draft.body_text.includes(
      "Please find attached PO-1000001 for job SWF-900001 (Exampleton).\n\n2 posts Item 1\n4 Item 2",
    ),
  );
  assertEquals(answer.order.chip.text, "PO-1000001 · Draft email ready");
  assertEquals(
    answer.lines.filter((l: Row) => l.display_status === "on_po").length,
    2,
  );
  assertEquals(db.tables.job_order_emails.length, 1);
  assertEquals(
    db.tables.job_events.map((
      e,
    ) => [e.event_type, e.detail_json.source, e.detail_json.total]),
    [["po_created", "dispatch", 0]],
  );
  // Nothing went anywhere.
  assertEquals(
    db.tables.po_communications.length + db.tables.email_events.length,
    0,
  );
  assertOnlyAllowedTouches(db);
});

Deno.test("create: a stale line, a missing line or an extra line is lines_changed, and nothing is left behind", async () => {
  const db = withLines();
  const lines = stamps(db, SUP.steel);
  await refused(
    call(db, "dispatch_order_create", {
      job_id: JOB.fence,
      supplier_id: SUP.steel,
      lines: [
        { ...lines[0], updated_at: "2026-10-14T02:00:00.000000+00:00" },
        lines[1],
      ],
    }),
    409,
    "lines_changed",
  );
  await refused(
    call(db, "dispatch_order_create", {
      job_id: JOB.fence,
      supplier_id: SUP.steel,
      lines: [lines[0]],
    }),
    409,
    "lines_changed",
  );
  // A line changed between the read and the commit: the commit refuses, the file goes.
  const c = ctx(db, transport(), {
    renderPdf: async (input) => {
      db.tables.job_material_lines.find((l) => l.id === line(2))!.updated_at =
        db.tick();
      return await fakePdf(input);
    },
  });
  const err = await refused(
    call(db, "dispatch_order_create", {
      job_id: JOB.fence,
      supplier_id: SUP.steel,
      lines,
    }, c),
    409,
    "lines_changed",
  );
  assert(Array.isArray(err.body.lines));
  assertEquals(db.tables.purchase_orders.length, 0);
  assertEquals(db.tables.job_order_emails.length, 0);
  assertEquals(db.files.size, 0);
  assert(db.tables.job_material_lines.every((l) => !l.purchase_order_id));
});

Deno.test("create: a second open order, no To order line, a supplier not on the job, a make-safe job and another org's job are refused", async () => {
  const db = withLines();
  await create(db);
  await refused(
    call(db, "dispatch_order_create", {
      job_id: JOB.fence,
      supplier_id: SUP.steel,
      lines: [],
    }),
    409,
    "order_open",
  );
  db.tables.job_material_lines.find((l) => l.id === line(4))!.status =
    "in_stock";
  await refused(
    call(db, "dispatch_order_create", {
      job_id: JOB.fence,
      supplier_id: SUP.sheets,
      lines: [],
    }),
    409,
    "no_lines_to_order",
  );
  await refused(
    call(db, "dispatch_order_create", {
      job_id: JOB.repair,
      supplier_id: SUP.steel,
      lines: [],
    }),
    409,
    "supplier_not_on_job",
  );
  await refused(
    call(db, "dispatch_order_create", {
      job_id: JOB.makesafe,
      supplier_id: SUP.steel,
      lines: [],
    }),
    409,
    "not_dispatch_work",
  );
  await refused(
    call(db, "dispatch_order_create", {
      job_id: JOB.other,
      supplier_id: SUP.steel,
      lines: [],
    }),
    404,
    "job_not_found",
  );
  await refused(
    call(db, "dispatch_order_create", {
      job_id: JOB.fence,
      supplier_id: uuid("b1", 99),
      lines: [],
    }),
    404,
    "supplier_not_found",
  );
  await refused(
    call(db, "dispatch_order_create", {
      job_id: JOB.fence,
      supplier_id: "nope",
      lines: [],
    }),
    400,
    "invalid_request",
  );
  assertEquals(db.tables.purchase_orders.length, 1);
});

Deno.test("create: a supplier with no usable address still gets its order and PDF; the draft says so and its hash names no address", async () => {
  const db = withLines();
  db.tables.job_material_lines.push({
    ...db.tables.job_material_lines[0],
    id: line(9),
    supplier_id: SUP.none,
    updated_at: db.tick(),
  });
  const answer = await create(db, SUP.none);
  assertEquals(answer.draft.to, { email: null, state: "missing" });
  assert(orderRow(db, "PO-1000001").pdf_path);
});

Deno.test("create: an order once in Xero frees the supplier for a new one; a used number is never reused", async () => {
  const db = withLines();
  await create(db);
  orderRow(db, "PO-1000001").xero_po_id = "xero-1";
  db.tables.job_material_lines.find((l) => l.id === line(3))!.status =
    "to_order";
  const second = await create(db);
  assertEquals(second.order.po_number, "PO-1000002");
  // A failed commit burns its number.
  db.failures.add("rpc:dispatch_commit_order");
  db.tables.job_material_lines.find((l) => l.id === line(4))!.status =
    "to_order";
  await refused(create(db, SUP.sheets), 500, "orders_write_failed");
  db.failures.delete("rpc:dispatch_commit_order");
  assertEquals((await create(db, SUP.sheets)).order.po_number, "PO-1000004");
});

// ── Update and Take off ─────────────────────────────────────────────────────

Deno.test("update: adds the new To order lines and takes off a line, with a new PDF version and the draft rewritten", async () => {
  const db = withLines();
  const made = await create(db);
  const order = orderRow(db, made.order.po_number);
  db.tables.job_material_lines.find((l) => l.id === line(3))!.status =
    "to_order";
  const answer = await call(db, "dispatch_order_update", {
    job_id: JOB.fence,
    purchase_order_id: order.id,
    expected_order_updated_at: order.updated_at,
    lines: stamps(db, SUP.steel),
    remove_line_ids: [line(1)],
  });
  assertEquals(answer.success, true);
  const after = orderRow(db, "PO-1000001");
  assertEquals(after.pdf_version, 2);
  assertEquals(after.pdf_path, `${JOB.fence}/PO-1000001-v2.pdf`);
  assertEquals(after.line_items.map((l: Row) => l.line_id), [line(2), line(3)]);
  const taken = db.tables.job_material_lines.find((l) => l.id === line(1))!;
  assertEquals([taken.purchase_order_id, taken.status], [null, "to_order"]);
  assertEquals(db.tables.job_order_emails.length, 1);
  assertEquals([answer.draft.pdf.version, answer.draft.pdf.line_count], [2, 2]);
  assert(answer.draft.body_text.includes("4 Item 2\n6 Item 3"));
  assert(
    db.files.has(`${JOB.fence}/PO-1000001-v1.pdf`),
    "old versions are kept",
  );
  // No job event for an update.
  assertEquals(db.tables.job_events.length, 1);
});

Deno.test("update: an edited message is kept and reported; nothing to change is unchanged; every line off is refused", async () => {
  const db = withLines();
  const made = await create(db);
  let order = orderRow(db, made.order.po_number);
  const draft = db.tables.job_order_emails[0];
  await call(db, "dispatch_order_draft_save", {
    draft_id: draft.id,
    body_text: "Hi team, please deliver early.",
    expected_updated_at: draft.updated_at,
  });
  const same = await call(db, "dispatch_order_update", {
    job_id: JOB.fence,
    purchase_order_id: order.id,
    expected_order_updated_at: order.updated_at,
    lines: [],
    remove_line_ids: [],
  });
  assertEquals(same.unchanged, true);
  const taken = await call(db, "dispatch_order_update", {
    job_id: JOB.fence,
    purchase_order_id: order.id,
    expected_order_updated_at: order.updated_at,
    lines: [],
    remove_line_ids: [line(2)],
  });
  assertEquals(taken.draft.body_text, "Hi team, please deliver early.");
  assertEquals(taken.body_kept, true);
  const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
  assertEquals([
    read.drafts[0].body_edited,
    read.drafts[0].order_changed_since_edit,
  ], [true, true]);
  order = orderRow(db, "PO-1000001");
  // Line 2 came off and is To order again: it would join, so set it In stock.
  db.tables.job_material_lines.find((l) => l.id === line(2))!.status =
    "in_stock";
  await refused(
    call(db, "dispatch_order_update", {
      job_id: JOB.fence,
      purchase_order_id: order.id,
      expected_order_updated_at: order.updated_at,
      lines: [],
      remove_line_ids: [line(1)],
    }),
    409,
    "order_would_be_empty",
  );
});

Deno.test("update: stale order, stale line, a line not on the order, Xero, cancelled, a send in flight and a non-Dispatch order are refused", async () => {
  const db = withLines();
  const made = await create(db);
  const order = orderRow(db, made.order.po_number);
  const base = {
    job_id: JOB.fence,
    purchase_order_id: order.id,
    expected_order_updated_at: order.updated_at,
    lines: [],
    remove_line_ids: [line(1)],
  };
  await refused(
    call(db, "dispatch_order_update", {
      ...base,
      expected_order_updated_at: "2026-10-14T01:00:00.000000+00:00",
    }),
    409,
    "order_changed",
  );
  await refused(
    call(db, "dispatch_order_update", { ...base, remove_line_ids: [line(4)] }),
    409,
    "lines_changed",
  );
  db.tables.job_material_lines.find((l) => l.id === line(3))!.status =
    "to_order";
  await refused(call(db, "dispatch_order_update", base), 409, "lines_changed");
  db.tables.job_order_emails[0].status = "send_unknown";
  await refused(
    call(db, "dispatch_order_update", {
      ...base,
      lines: stamps(db, SUP.steel),
    }),
    409,
    "draft_sending",
  );
  db.tables.job_order_emails[0].status = "draft";
  order.xero_po_id = "x";
  await refused(call(db, "dispatch_order_update", base), 409, "order_in_xero");
  order.xero_po_id = null;
  order.status = "cancelled";
  await refused(
    call(db, "dispatch_order_update", base),
    409,
    "order_cancelled",
  );
  order.source = null;
  await refused(
    call(db, "dispatch_order_update", base),
    409,
    "not_dispatch_order",
  );
});

Deno.test("update: two at once: one wins, the other is order_changed, and the winner's PDF is the one on file", async () => {
  const db = withLines();
  const made = await create(db);
  const order = orderRow(db, made.order.po_number);
  const body = (remove: string) => ({
    job_id: JOB.fence,
    purchase_order_id: order.id,
    expected_order_updated_at: order.updated_at,
    lines: [],
    remove_line_ids: [remove],
  });
  const results = await Promise.allSettled([
    call(db, "dispatch_order_update", body(line(1))),
    call(db, "dispatch_order_update", body(line(2))),
  ]);
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  assertEquals(
    (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason.body.code,
    "order_changed",
  );
  const after = orderRow(db, "PO-1000001");
  assertEquals(after.pdf_version, 2);
  assertEquals(
    await sha256Hex(db.files.get(after.pdf_path)!),
    after.pdf_sha256,
  );
  assertEquals([...db.files.keys()].filter((k) => k.includes("-v2")).length, 1);
  const v1 = await get(db, "dispatch_order_pdf", {
    purchase_order_id: order.id,
    version: "1",
  });
  assert(v1.url.includes("PO-1000001-v1.pdf"));
});

// ── Cancel and Discard ──────────────────────────────────────────────────────

Deno.test("cancel: only a Dispatch order never sent and not in Xero; lines back to To order; draft discarded; one event", async () => {
  const db = withLines();
  const made = await create(db);
  const order = orderRow(db, made.order.po_number);
  order.xero_po_id = "x";
  await refused(
    call(db, "dispatch_order_cancel", {
      job_id: JOB.fence,
      purchase_order_id: order.id,
      expected_order_updated_at: order.updated_at,
    }),
    409,
    "order_in_xero",
  );
  order.xero_po_id = null;
  const answer = await call(db, "dispatch_order_cancel", {
    job_id: JOB.fence,
    purchase_order_id: order.id,
    expected_order_updated_at: order.updated_at,
  });
  assertEquals(answer.order.status, "cancelled");
  assertEquals(orderRow(db, "PO-1000001").status, "cancelled");
  assert(
    db.tables.job_material_lines.filter((l) =>
      l.supplier_id === SUP.steel && l.id !== line(3)
    ).every((l) => !l.purchase_order_id && l.status === "to_order"),
  );
  assertEquals(db.tables.job_order_emails[0].status, "discarded");
  assertEquals(db.tables.job_events.map((e) => e.event_type), [
    "po_created",
    "po_cancelled",
  ]);
  await refused(
    call(db, "dispatch_order_cancel", {
      job_id: JOB.fence,
      purchase_order_id: order.id,
      expected_order_updated_at: orderRow(db, "PO-1000001").updated_at,
    }),
    409,
    "order_cancelled",
  );
});

Deno.test("discard: drops the email only; the order stays unsent with its lines and its chip reads Not sent", async () => {
  const db = withLines();
  const made = await create(db);
  const draft = db.tables.job_order_emails[0];
  await refused(
    call(db, "dispatch_order_discard", {
      draft_id: draft.id,
      expected_updated_at: "2026-10-14T01:00:00.000000+00:00",
    }),
    409,
    "draft_changed",
  );
  const answer = await call(db, "dispatch_order_discard", {
    draft_id: draft.id,
    expected_updated_at: draft.updated_at,
  });
  assertEquals(answer.order.chip.text, "PO-1000001 · Not sent");
  assertEquals(db.tables.job_order_emails[0].status, "discarded");
  assertEquals(orderRow(db, made.order.po_number).status, "draft");
  assertEquals(
    db.tables.job_material_lines.filter((l) => l.purchase_order_id).length,
    2,
  );
  await refused(
    call(db, "dispatch_order_discard", {
      draft_id: draft.id,
      expected_updated_at: db.tables.job_order_emails[0].updated_at,
    }),
    409,
    "draft_not_editable",
  );
  // Update and email makes a fresh draft for the same order.
  const order = orderRow(db, made.order.po_number);
  const again = await call(db, "dispatch_order_update", {
    job_id: JOB.fence,
    purchase_order_id: order.id,
    expected_order_updated_at: order.updated_at,
    lines: [],
    remove_line_ids: [line(2)],
  });
  assertEquals([again.draft.kind, again.draft.status], ["order", "draft"]);
});

// ── Draft save ──────────────────────────────────────────────────────────────

Deno.test("save: subject and message saved and the hash moves; a stale stamp is 409 with the stored draft; limits hold", async () => {
  const db = withLines();
  const made = await create(db);
  const draft = db.tables.job_order_emails[0];
  const saved = await call(db, "dispatch_order_draft_save", {
    draft_id: draft.id,
    subject: "  New subject ",
    expected_updated_at: draft.updated_at,
  });
  assertEquals(saved.draft.subject, "New subject");
  assert(saved.draft.draft_hash !== made.draft.draft_hash);
  const stale = await refused(
    call(db, "dispatch_order_draft_save", {
      draft_id: draft.id,
      subject: "x",
      expected_updated_at: draft.created_at,
    }),
    409,
    "draft_changed",
  );
  assertEquals((stale.body.draft as any).subject, "New subject");
  await refused(
    call(db, "dispatch_order_draft_save", {
      draft_id: draft.id,
      subject: "",
      expected_updated_at: saved.draft.updated_at,
    }),
    400,
    "invalid_request",
  );
  await refused(
    call(db, "dispatch_order_draft_save", {
      draft_id: draft.id,
      body_text: "x".repeat(20_001),
      expected_updated_at: saved.draft.updated_at,
    }),
    400,
    "invalid_request",
  );
  await refused(
    call(db, "dispatch_order_draft_save", {
      draft_id: draft.id,
      expected_updated_at: saved.draft.updated_at,
    }),
    400,
    "invalid_request",
  );
});

// ── Send ────────────────────────────────────────────────────────────────────

async function readyDraft(
  db: ReturnType<typeof makeDb>,
  supplierId = SUP.steel,
) {
  if (supplierId !== SUP.steel && supplierId !== SUP.sheets) {
    db.tables.job_material_lines.push({
      ...db.tables.job_material_lines[0],
      id: crypto.randomUUID(),
      supplier_id: supplierId,
      updated_at: db.tick(),
    });
  }
  const made = await create(db, supplierId);
  return made.draft;
}

Deno.test("send: a press sends exactly the draft shown, once, then files it on the order and job", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport([{ status: 200, body: { id: "resend-1" } }]);
  const answer = await call(db, "dispatch_order_send", {
    draft_id: draft.id,
    expected_draft_hash: draft.draft_hash,
  }, ctx(db, t));
  assertEquals([answer.success, answer.filed], [true, true]);
  assertEquals(t.calls.length, 1);
  const { payload, idempotencyKey } = t.calls[0];
  assertEquals(idempotencyKey, `dispatch-draft-${draft.id}`);
  assertEquals(payload.to, ["orders@steel-supplies.test"]);
  assertEquals(
    payload.reply_to,
    "orders+PO-1000001-SWF-900001@secureworksgroup.app",
  );
  assertEquals(payload.subject, draft.subject);
  assertEquals(payload.text, draft.body_text);
  assertEquals(payload.attachments.length, 1);
  assertEquals(payload.attachments[0].filename, "PO-1000001.pdf");
  assert(!("cc" in payload) && !("bcc" in payload));
  const order = orderRow(db, "PO-1000001");
  assertEquals([
    order.status,
    order.last_sent_pdf_version,
    typeof order.last_sent_at,
  ], ["sent", 1, "string"]);
  const stored = db.tables.job_order_emails[0];
  assertEquals([
    stored.status,
    stored.to_email_sent,
    stored.resend_id,
    stored.sent_by,
    stored.sent_by_email,
    stored.sent_via,
  ], [
    "sent",
    "orders@steel-supplies.test",
    "resend-1",
    USER.shaun,
    "shaun@ops.test",
    "screen",
  ]);
  assertEquals(db.tables.po_communications.length, 1);
  const comm = db.tables.po_communications[0];
  assertEquals([
    comm.po_id,
    comm.job_id,
    comm.communication_type,
    comm.direction,
    comm.from_email,
    comm.to_email,
    comm.message_id,
    comm.thread_id,
    comm.delivery_status,
  ], [
    order.id,
    JOB.fence,
    "purchase_order",
    "outbound",
    "orders@secureworksgroup.app",
    "orders@steel-supplies.test",
    "resend-1",
    "resend-1",
    "sent",
  ]);
  assertEquals(comm.attachments_json[0].storage_path, order.pdf_path);
  assertEquals(
    db.tables.email_events.map((
      e,
    ) => [
      e.email_type,
      e.entity_id,
      e.recipient,
      e.metadata.source,
      e.metadata.via,
    ]),
    [["po", order.id, "orders@steel-supplies.test", "dispatch", "screen"]],
  );
  assertEquals(db.tables.job_events.map((e) => e.event_type), [
    "po_created",
    "po_email_sent",
  ]);
  assertEquals(
    db.tables.job_events[1].detail_json.operator_email,
    "shaun@ops.test",
  );
  assertEquals(answer.order.chip.text, `PO-1000001 · Sent 14/10`);
  // Sent is final: a second press sends nothing.
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, ctx(db, t)),
    409,
    "draft_not_sendable",
  );
  assertEquals(t.calls.length, 1);
  // A sent order is not cancelled from Dispatch.
  await refused(
    call(db, "dispatch_order_cancel", {
      job_id: JOB.fence,
      purchase_order_id: order.id,
      expected_order_updated_at: order.updated_at,
    }),
    409,
    "order_sent",
  );
  assertOnlyAllowedTouches(db);
});

Deno.test("send: a stale hash, an edited draft or a changed contact address sends nothing", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport();
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: "0".repeat(64),
    }, ctx(db, t)),
    409,
    "draft_changed",
  );
  db.tables.suppliers.find((s) => s.id === SUP.steel)!.email =
    "new@steel-supplies.test";
  const changed = await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, ctx(db, t)),
    409,
    "draft_changed",
  );
  assertEquals((changed.body.draft as any).to.email, "new@steel-supplies.test");
  assertEquals(t.calls.length, 0);
  assertEquals(db.tables.job_order_emails[0].status, "draft");
});

for (
  const [supplierId, code] of [
    [SUP.none, "supplier_email_missing"],
    [SUP.own, "supplier_email_not_supplier"],
    [SUP.test, "supplier_email_not_supplier"],
    [SUP.bad, "supplier_email_malformed"],
  ] as const
) {
  Deno.test(`send: ${code} is refused before the transport is called (${supplierId.slice(-1)})`, async () => {
    const db = withLines();
    const draft = await readyDraft(db, supplierId);
    const t = transport();
    await refused(
      call(db, "dispatch_order_send", {
        draft_id: draft.id,
        expected_draft_hash: draft.draft_hash,
      }, ctx(db, t)),
      409,
      code,
    );
    assertEquals(t.calls.length, 0);
    assertEquals(
      db.tables.job_order_emails.find((d) => d.id === draft.id)!.status,
      "draft",
    );
  });
}

Deno.test("send: the claim lets one of two presses through", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport();
  const results = await Promise.allSettled([
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, ctx(db, t)),
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, ctx(db, t)),
  ]);
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) =>
    r.status === "rejected"
  ) as PromiseRejectedResult;
  assertEquals(rejected.reason.body.code, "draft_not_sendable");
  assertEquals(t.calls.length, 1);
  assertEquals(db.tables.po_communications.length, 1);
});

Deno.test("send: a 4xx puts the draft back with the reason; nothing is filed", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport([{
    status: 422,
    body: { message: "Invalid `to` field" },
  }]);
  const err = await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, ctx(db, t)),
    502,
    "send_refused",
  );
  assertEquals(err.body.reason, "Invalid `to` field");
  const stored = db.tables.job_order_emails[0];
  assertEquals([stored.status, stored.last_error], [
    "draft",
    "Invalid `to` field",
  ]);
  assertEquals(
    db.tables.po_communications.length + db.tables.email_events.length,
    0,
  );
  assertEquals(orderRow(db, "PO-1000001").status, "draft");
});

Deno.test("send: a 5xx or a network failure is not confirmed, called once; a person's retry carries the same key and files once", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport([{ status: 503, body: null }, { status: 0, body: null }, {
    status: 200,
    body: { id: "resend-9" },
  }]);
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, ctx(db, t)),
    502,
    "send_unknown",
  );
  assertEquals(t.calls.length, 1);
  assertEquals(db.tables.job_order_emails[0].status, "send_unknown");
  const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
  assertEquals(read.drafts[0].status, "send_unknown");
  // The order cannot be cancelled while its email may have gone.
  const order = orderRow(db, "PO-1000001");
  await refused(
    call(db, "dispatch_order_cancel", {
      job_id: JOB.fence,
      purchase_order_id: order.id,
      expected_order_updated_at: order.updated_at,
    }),
    409,
    "draft_sending",
  );
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: read.drafts[0].draft_hash,
    }, ctx(db, t)),
    502,
    "send_unknown",
  );
  const ok = await call(db, "dispatch_order_send", {
    draft_id: draft.id,
    expected_draft_hash: read.drafts[0].draft_hash,
  }, ctx(db, t));
  assertEquals(ok.success, true);
  assertEquals(
    t.calls.map((c) => c.idempotencyKey),
    Array(3).fill(`dispatch-draft-${draft.id}`),
  );
  assertEquals(
    JSON.stringify(t.calls[0].payload),
    JSON.stringify(t.calls[2].payload),
  );
  assertEquals(db.tables.po_communications.length, 1);
});

Deno.test("send: a retry after an unknown result is the same request even if a reply landed and the contact changed in between", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport();
  await call(db, "dispatch_order_send", {
    draft_id: draft.id,
    expected_draft_hash: draft.draft_hash,
  }, ctx(db, t));
  const order = orderRow(db, "PO-1000001");
  db.tables.po_communications.push({
    id: uuid("f1", 1),
    po_id: order.id,
    job_id: JOB.fence,
    direction: "inbound",
    communication_type: "purchase_order",
    from_email: "orders@steel-supplies.test",
    subject: "Re: PO",
    body_text: "Got it",
    message_id: "<reply-1@steel-supplies.test>",
    received_at: db.tick(),
    created_at: db.tick(),
  });
  const updated = await call(db, "dispatch_order_update", {
    job_id: JOB.fence,
    purchase_order_id: order.id,
    expected_order_updated_at: order.updated_at,
    lines: [],
    remove_line_ids: [line(2)],
  });
  t.answers.push({ status: 503, body: null }, {
    status: 200,
    body: { id: "resend-retry" },
  });
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: updated.draft.id,
      expected_draft_hash: updated.draft.draft_hash,
    }, ctx(db, t)),
    502,
    "send_unknown",
  );
  // In between: the supplier writes again, and the contact's address changes.
  db.tables.po_communications.push({
    id: uuid("f1", 2),
    po_id: order.id,
    job_id: JOB.fence,
    direction: "inbound",
    communication_type: "purchase_order",
    from_email: "orders@steel-supplies.test",
    subject: "Re: PO",
    body_text: "Any news?",
    message_id: "<reply-2@steel-supplies.test>",
    received_at: db.tick(),
    created_at: db.tick(),
  });
  db.tables.suppliers.find((s) => s.id === SUP.steel)!.email =
    "new@steel-supplies.test";
  const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
  assertEquals(read.drafts[0].to.email, "orders@steel-supplies.test");
  await call(db, "dispatch_order_send", {
    draft_id: updated.draft.id,
    expected_draft_hash: read.drafts[0].draft_hash,
  }, ctx(db, t));
  const [first, retry] = t.calls.slice(1);
  assertEquals(retry.idempotencyKey, first.idempotencyKey);
  assertEquals(JSON.stringify(retry.payload), JSON.stringify(first.payload));
  assertEquals(
    retry.payload.headers["In-Reply-To"],
    "<reply-1@steel-supplies.test>",
  );
  assertEquals(retry.payload.to, ["orders@steel-supplies.test"]);
});

Deno.test("send: after a refusal (nothing went) a corrected send goes under a new key", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport([{ status: 422, body: { message: "Invalid subject" } }, {
    status: 200,
    body: { id: "resend-2" },
  }]);
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, ctx(db, t)),
    502,
    "send_refused",
  );
  const stored = db.tables.job_order_emails[0];
  const saved = await call(db, "dispatch_order_draft_save", {
    draft_id: draft.id,
    subject: "PO-1000001 for SWF-900001",
    expected_updated_at: stored.updated_at,
  }, ctx(db, t));
  await call(db, "dispatch_order_send", {
    draft_id: draft.id,
    expected_draft_hash: saved.draft.draft_hash,
  }, ctx(db, t));
  assertEquals(t.calls.map((c) => c.idempotencyKey), [
    `dispatch-draft-${draft.id}`,
    `dispatch-draft-${draft.id}-a2`,
  ]);
  assertEquals(db.tables.job_order_emails[0].status, "sent");
});

Deno.test("send: a refusal on a retry after an unknown result keeps the draft not confirmed and the next retry uses the same key", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport([
    { status: 503, body: null },
    { status: 429, body: { message: "Too many requests" } },
    { status: 200, body: { id: "resend-3" } },
  ]);
  const press = async () => {
    const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
    return call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: read.drafts[0].draft_hash,
    }, ctx(db, t));
  };
  await refused(press(), 502, "send_unknown");
  const before = { ...db.tables.job_order_emails[0] };
  await refused(press(), 502, "send_unknown");
  const between = db.tables.job_order_emails[0];
  assertEquals(between.status, "send_unknown");
  assertEquals(between.send_attempt, before.send_attempt);
  assertEquals(between.attempt_to_email, before.attempt_to_email);
  assertEquals(between.attempt_in_reply_to, before.attempt_in_reply_to);
  assertEquals(between.last_error, "Too many requests");
  const ok = await press();
  assertEquals(ok.success, true);
  assertEquals(
    t.calls.map((c) => c.idempotencyKey),
    Array(3).fill(`dispatch-draft-${draft.id}`),
  );
  assertEquals(db.tables.job_order_emails[0].status, "sent");
});

Deno.test("release: a person releases a not-confirmed send to draft under a new key, recorded, with nothing sent", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport([{ status: 503, body: null }, {
    status: 200,
    body: { id: "resend-4" },
  }]);
  await refused(
    call(db, "dispatch_order_release_unknown", {
      draft_id: draft.id,
      expected_updated_at: db.tables.job_order_emails[0].updated_at,
    }, ctx(db, t)),
    409,
    "draft_not_unknown",
  );
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, ctx(db, t)),
    502,
    "send_unknown",
  );
  const unknown = db.tables.job_order_emails[0];
  await refused(
    call(db, "dispatch_order_release_unknown", {
      draft_id: draft.id,
      expected_updated_at: "2026-10-14T01:00:00.000000+00:00",
    }, ctx(db, t)),
    409,
    "draft_changed",
  );
  const eventsBefore = db.tables.job_events.length;
  const answer = await call(db, "dispatch_order_release_unknown", {
    draft_id: draft.id,
    expected_updated_at: unknown.updated_at,
  }, ctx(db, t));
  assertEquals(answer.success, true);
  assertEquals(t.calls.length, 1);
  const stored = db.tables.job_order_emails[0];
  assertEquals(stored.status, "draft");
  assertEquals(stored.send_attempt, 2);
  assertEquals(stored.attempt_to_email, null);
  assertEquals(stored.attempt_in_reply_to, null);
  const events = db.tables.job_events.slice(eventsBefore);
  assertEquals(events.length, 1);
  assertEquals(events[0].event_type, "po_email_send_released");
  assertEquals(events[0].user_id, USER.shaun);
  assertEquals(events[0].detail_json.operator_email, "shaun@ops.test");
  assertEquals(events[0].detail_json.draft_id, draft.id);
  assertEquals(events[0].detail_json.prior_status, "send_unknown");
  assertEquals(events[0].detail_json.prior_attempt, 1);
  assertEquals(events[0].detail_json.released_at, stored.updated_at);
  await refused(
    call(db, "dispatch_order_release_unknown", {
      draft_id: draft.id,
      expected_updated_at: stored.updated_at,
    }, ctx(db, t)),
    409,
    "draft_not_unknown",
  );
  const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
  await call(db, "dispatch_order_send", {
    draft_id: draft.id,
    expected_draft_hash: read.drafts[0].draft_hash,
  }, ctx(db, t));
  assertEquals(t.calls.map((c) => c.idempotencyKey), [
    `dispatch-draft-${draft.id}`,
    `dispatch-draft-${draft.id}-a2`,
  ]);
  assertEquals(db.tables.job_order_emails[0].status, "sent");
});

Deno.test("release: when the audit row cannot be written nothing is released, and the person's retry releases it with its record", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport([{ status: 503, body: null }]);
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, ctx(db, t)),
    502,
    "send_unknown",
  );
  const unknown = { ...db.tables.job_order_emails[0] };
  const eventsBefore = db.tables.job_events.length;
  db.failures.add("insert:job_events");
  await refused(
    call(db, "dispatch_order_release_unknown", {
      draft_id: draft.id,
      expected_updated_at: unknown.updated_at,
    }, ctx(db, t)),
    500,
    "orders_write_failed",
  );
  assertEquals(db.tables.job_order_emails[0], unknown);
  assertEquals(db.tables.job_events.length, eventsBefore);
  db.failures.delete("insert:job_events");
  const answer = await call(db, "dispatch_order_release_unknown", {
    draft_id: draft.id,
    expected_updated_at: unknown.updated_at,
  }, ctx(db, t));
  assertEquals(answer.success, true);
  const stored = db.tables.job_order_emails[0];
  assertEquals(stored.status, "draft");
  assertEquals(stored.send_attempt, (unknown.send_attempt ?? 1) + 1);
  const events = db.tables.job_events.slice(eventsBefore);
  assertEquals(events.map((e) => e.event_type), ["po_email_send_released"]);
  assertEquals(events[0].user_id, USER.shaun);
  assertEquals(events[0].detail_json.operator_email, "shaun@ops.test");
  assertEquals(events[0].detail_json.released_at, stored.updated_at);
  assertEquals(t.calls.length, 1);
});

Deno.test("release: the ops key must name the person who checked", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  db.tables.job_order_emails[0].status = "send_unknown";
  await refused(
    call(
      db,
      "dispatch_order_release_unknown",
      {
        draft_id: draft.id,
        expected_updated_at: db.tables.job_order_emails[0].updated_at,
      },
      ctx(db, transport(), {
        via: "terminal",
        actor: { userId: null, email: null, orgId: null },
      }),
    ),
    400,
    "operator_required",
  );
  assertEquals(db.tables.job_order_emails[0].status, "send_unknown");
});

Deno.test("send: a claim left with no answer for two minutes reads as not confirmed and can be retried", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  db.tables.job_order_emails[0].status = "sending";
  const t = transport();
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, ctx(db, t)),
    409,
    "draft_not_sendable",
  );
  for (let i = 0; i < 130; i++) db.tick();
  const ok = await call(db, "dispatch_order_send", {
    draft_id: draft.id,
    expected_draft_hash: draft.draft_hash,
  }, ctx(db, t));
  assertEquals([ok.success, t.calls.length], [true, 1]);
});

Deno.test("send: the email went but a filing write failed: success with filed false, and the draft is sent", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  db.failures.add("insert:email_events");
  const answer = await call(db, "dispatch_order_send", {
    draft_id: draft.id,
    expected_draft_hash: draft.draft_hash,
  });
  assertEquals([answer.success, answer.filed], [true, false]);
  assertEquals(db.tables.job_order_emails[0].status, "sent");
  assertEquals(db.tables.po_communications.length, 1);
});

Deno.test("send: an order cancelled just after the claim sends nothing and puts the draft back", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const client = new Proxy(db.client, {
    get(target: any, prop: string) {
      if (prop !== "from") return target[prop];
      return (table: string) => {
        const builder = target.from(table);
        if (table !== "job_order_emails") return builder;
        const update = builder.update;
        builder.update = (value: any) => {
          const result = update(value);
          if (value?.status === "sending") {
            const then = builder.then;
            builder.then = (resolve: any, reject: any) =>
              then((out: any) => {
                orderRow(db, "PO-1000001").status = "cancelled";
                return out;
              }).then(resolve, reject);
          }
          return result;
        };
        return builder;
      };
    },
  });
  const t = transport();
  await refused(
    runDispatchOrdersAction(
      client,
      "dispatch_order_send",
      new URLSearchParams(),
      {
        draft_id: draft.id,
        expected_draft_hash: draft.draft_hash,
      },
      ctx(db, t),
    ) as Promise<any>,
    409,
    "order_cancelled",
  );
  assertEquals(t.calls.length, 0);
  assertEquals(db.tables.job_order_emails[0].status, "draft");
  assertEquals(db.tables.po_communications.length, 0);
});

Deno.test("send: a PDF that is not the draft's bytes sends nothing", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  db.files.set(
    orderRow(db, "PO-1000001").pdf_path,
    new TextEncoder().encode("%PDF other"),
  );
  const t = transport();
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, ctx(db, t)),
    409,
    "pdf_changed",
  );
  assertEquals(t.calls.length, 0);
  assertEquals(db.tables.job_order_emails[0].status, "draft");
});

Deno.test("send: the ops key must name a person in users; the send records the terminal and that person", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport();
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
    }, terminal(db, t)),
    400,
    "operator_required",
  );
  await refused(
    call(db, "dispatch_order_send", {
      draft_id: draft.id,
      expected_draft_hash: draft.draft_hash,
      operator_email: "nobody@ops.test",
    }, terminal(db, t)),
    400,
    "operator_required",
  );
  assertEquals(t.calls.length, 0);
  const ok = await call(db, "dispatch_order_send", {
    draft_id: draft.id,
    expected_draft_hash: draft.draft_hash,
    operator_email: "SHAUN@ops.test",
  }, terminal(db, t));
  assertEquals(ok.success, true);
  const stored = db.tables.job_order_emails[0];
  assertEquals([stored.sent_by, stored.sent_by_email, stored.sent_via], [
    null,
    "shaun@ops.test",
    "terminal",
  ]);
  assertEquals(db.tables.job_events[1].detail_json.via, "terminal");
});

Deno.test("send: an update email after a supplier replied threads to the reply and says what changed", async () => {
  const db = withLines();
  const draft = await readyDraft(db);
  const t = transport();
  await call(db, "dispatch_order_send", {
    draft_id: draft.id,
    expected_draft_hash: draft.draft_hash,
  }, ctx(db, t));
  const order = orderRow(db, "PO-1000001");
  db.tables.po_communications.push({
    id: uuid("f1", 1),
    po_id: order.id,
    job_id: JOB.fence,
    direction: "inbound",
    communication_type: "purchase_order",
    from_email: "orders@steel-supplies.test",
    subject: "Re: Purchase order PO-1000001",
    body_text: "Got it",
    message_id: "<reply-1@steel-supplies.test>",
    received_at: db.tick(),
    created_at: db.tick(),
  });
  const updated = await call(db, "dispatch_order_update", {
    job_id: JOB.fence,
    purchase_order_id: order.id,
    expected_order_updated_at: order.updated_at,
    lines: [],
    remove_line_ids: [line(2)],
  });
  assertEquals([updated.draft.kind, updated.draft.subject], [
    "update",
    "Updated purchase order PO-1000001 for SWF-900001",
  ]);
  assert(updated.draft.body_text.includes("Taken off:\n4 Item 2"));
  await call(db, "dispatch_order_send", {
    draft_id: updated.draft.id,
    expected_draft_hash: updated.draft.draft_hash,
  }, ctx(db, t));
  assertEquals(
    t.calls[1].payload.headers["In-Reply-To"],
    "<reply-1@steel-supplies.test>",
  );
  assertEquals(orderRow(db, "PO-1000001").last_sent_pdf_version, 2);
  const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
  assertEquals(read.threads.length, 1);
  assertEquals(read.threads[0].messages.length, 3);
});

// ── Reply and Link ──────────────────────────────────────────────────────────

function supplierThread(db: ReturnType<typeof makeDb>, poId: string | null) {
  db.tables.po_communications.push(
    {
      id: uuid("f1", 1),
      po_id: poId,
      job_id: JOB.fence,
      direction: "inbound",
      communication_type: "purchase_order",
      from_email: "staff@secureworkswa.com.au",
      to_email: "orders@secureworksgroup.app",
      subject: "Order",
      body_text: "fwd",
      received_at: "2026-10-01T01:00:00.000000+00:00",
      created_at: "2026-10-01T01:00:00.000000+00:00",
      thread_id: "t-1",
      message_id: "<a@x.test>",
    },
    {
      id: uuid("f1", 2),
      po_id: poId,
      job_id: JOB.fence,
      direction: "inbound",
      communication_type: "purchase_order",
      from_email: "orders@steel-supplies.test",
      to_email: "orders@secureworksgroup.app",
      subject: "Re: Order",
      body_text: "Ready Friday",
      received_at: "2026-10-02T01:00:00.000000+00:00",
      created_at: "2026-10-02T01:00:00.000000+00:00",
      thread_id: "t-1",
      message_id: "<b@steel-supplies.test>",
    },
    {
      id: uuid("f1", 3),
      po_id: null,
      job_id: JOB.fence,
      direction: "inbound",
      communication_type: "client",
      from_email: "client@home.test",
      subject: "Hello",
      body_html: "<p>Hi</p>",
      received_at: "2026-10-03T01:00:00.000000+00:00",
      created_at: "2026-10-03T01:00:00.000000+00:00",
    },
  );
}

Deno.test("reply: goes only to the newest inbound sender, once, filed on the thread; a stale newest message is refused", async () => {
  const db = withLines();
  await create(db);
  supplierThread(db, orderRow(db, "PO-1000001").id);
  const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
  const thread = read.threads.find((th: Row) => th.tag === "supplier");
  assertEquals(thread.can_reply, true);
  const t = transport();
  await refused(
    call(db, "dispatch_order_reply", {
      job_id: JOB.fence,
      thread_key: thread.key,
      reply_to_message_id: uuid("f1", 1),
      body_text: "Thanks",
    }, ctx(db, t)),
    409,
    "thread_changed",
  );
  const ok = await call(db, "dispatch_order_reply", {
    job_id: JOB.fence,
    thread_key: thread.key,
    reply_to_message_id: uuid("f1", 2),
    body_text: "Thanks, Friday works.",
  }, ctx(db, t));
  assertEquals(ok.success, true);
  assertEquals(t.calls.length, 1);
  const { payload, idempotencyKey } = t.calls[0];
  assertEquals(payload.to, ["orders@steel-supplies.test"]);
  assertEquals(payload.subject, "Re: Order");
  assertEquals(payload.headers["In-Reply-To"], "<b@steel-supplies.test>");
  assert(!("attachments" in payload));
  assert(idempotencyKey.startsWith(`dispatch-reply-${uuid("f1", 2)}-`));
  const filed = db.tables.po_communications.at(-1)!;
  assertEquals([
    filed.direction,
    filed.thread_id,
    filed.po_id,
    filed.in_reply_to,
  ], [
    "outbound",
    "t-1",
    orderRow(db, "PO-1000001").id,
    "<b@steel-supplies.test>",
  ]);
  // The same reply pressed again: our reply is now the newest message, so it
  // is refused before any send.
  await refused(
    call(db, "dispatch_order_reply", {
      job_id: JOB.fence,
      thread_key: thread.key,
      reply_to_message_id: uuid("f1", 2),
      body_text: "Thanks, Friday works.",
    }, ctx(db, t)),
    409,
    "thread_changed",
  );
  assertEquals(t.calls.length, 1);
  // A client thread is never replied to here.
  const client = read.threads.find((th: Row) => th.tag === "client");
  await refused(
    call(db, "dispatch_order_reply", {
      job_id: JOB.fence,
      thread_key: client.key,
      reply_to_message_id: uuid("f1", 3),
      body_text: "x",
    }, ctx(db, t)),
    409,
    "thread_not_supplier",
  );
});

Deno.test("reply: a reply that went but was not filed on the thread is not sent again", async () => {
  const db = withLines();
  supplierThread(db, null);
  const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
  const thread = read.threads.find((th: Row) => th.tag === "supplier");
  db.failures.add("insert:po_communications");
  const t = transport();
  const first = await call(db, "dispatch_order_reply", {
    job_id: JOB.fence,
    thread_key: thread.key,
    reply_to_message_id: uuid("f1", 2),
    body_text: "On its way",
  }, ctx(db, t));
  assertEquals([first.success, first.filed], [true, false]);
  const again = await call(db, "dispatch_order_reply", {
    job_id: JOB.fence,
    thread_key: thread.key,
    reply_to_message_id: uuid("f1", 2),
    body_text: "On its way",
  }, ctx(db, t));
  assertEquals(again.unchanged, true);
  assertEquals(t.calls.length, 1);
});

Deno.test("reply: an empty message and the ops key without a person are refused", async () => {
  const db = withLines();
  supplierThread(db, null);
  const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
  const thread = read.threads.find((th: Row) => th.tag === "supplier");
  await refused(
    call(db, "dispatch_order_reply", {
      job_id: JOB.fence,
      thread_key: thread.key,
      reply_to_message_id: uuid("f1", 2),
      body_text: "  ",
    }),
    400,
    "invalid_request",
  );
  await refused(
    call(db, "dispatch_order_reply", {
      job_id: JOB.fence,
      thread_key: thread.key,
      reply_to_message_id: uuid("f1", 2),
      body_text: "Hi",
    }, terminal(db)),
    400,
    "operator_required",
  );
});

Deno.test("link: sets po_id only on that thread's rows without one; a linked thread and another job's order are refused", async () => {
  const db = withLines();
  await create(db);
  supplierThread(db, null);
  db.tables.po_communications.push({
    id: uuid("f1", 9),
    po_id: null,
    job_id: JOB.fence,
    direction: "inbound",
    communication_type: "purchase_order",
    from_email: "x@other.test",
    subject: "Other",
    created_at: "2026-10-04T01:00:00.000000+00:00",
  });
  const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
  const thread = read.threads.find((th: Row) =>
    th.key === `th-${uuid("f1", 1)}`
  );
  assertEquals(thread.can_link, true);
  assertEquals(read.orders_for_link.map((o: Row) => o.po_number), [
    "PO-1000001",
  ]);
  await refused(
    call(db, "dispatch_email_link_po", {
      job_id: JOB.fence,
      thread_key: thread.key,
      purchase_order_id: uuid("e1", 99),
    }),
    409,
    "order_not_on_job",
  );
  const order = orderRow(db, "PO-1000001");
  const answer = await call(db, "dispatch_email_link_po", {
    job_id: JOB.fence,
    thread_key: thread.key,
    purchase_order_id: order.id,
  });
  assertEquals(answer.thread.po_number, "PO-1000001");
  assertEquals(
    db.tables.po_communications.filter((c) => c.po_id === order.id).map((c) =>
      c.id
    ).sort(),
    [uuid("f1", 1), uuid("f1", 2)],
  );
  assertEquals(
    db.tables.po_communications.find((c) => c.id === uuid("f1", 9))!.po_id,
    null,
  );
  assertEquals(
    db.tables.po_communications.find((c) => c.id === uuid("f1", 3))!.po_id,
    null,
  );
  const after = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
  const linked = after.threads.find((th: Row) => th.po_number === "PO-1000001");
  await refused(
    call(db, "dispatch_email_link_po", {
      job_id: JOB.fence,
      thread_key: linked.key,
      purchase_order_id: order.id,
    }),
    409,
    "thread_has_order",
  );
});

// ── The two reads ───────────────────────────────────────────────────────────

Deno.test("emails read: drafts and threads, no write; failed threads still show drafts; failed drafts are a 500", async () => {
  const db = withLines();
  await create(db);
  supplierThread(db, null);
  const before = db.requests.length;
  const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence });
  assertEquals(
    db.requests.slice(before).filter((r) => r.kind !== "select"),
    [],
  );
  assertEquals(read.drafts.length, 1);
  assertEquals(read.threads_status, "ok");
  assertEquals(read.threads.map((th: Row) => th.tag), ["client", "supplier"]);
  assert(!("_rows" in read.threads[0]));
  db.failures.add("select:po_communications");
  const degraded = await get(db, "dispatch_order_emails", {
    job_id: JOB.fence,
  });
  assertEquals([
    degraded.threads_status,
    "threads" in degraded,
    degraded.drafts.length,
  ], ["failed", false, 1]);
  db.failures.add("select:job_order_emails");
  await refused(
    get(db, "dispatch_order_emails", { job_id: JOB.fence }),
    500,
    "orders_read_failed",
  );
  await refused(
    get(db, "dispatch_order_emails", { job_id: JOB.makesafe }),
    409,
    "not_dispatch_work",
  );
  await refused(
    get(db, "dispatch_order_emails", { job_id: "x" }),
    400,
    "invalid_request",
  );
});

Deno.test("pdf read: a 300 second link to the newest or a named version, and 404 for none; no write", async () => {
  const db = withLines();
  const made = await create(db);
  const order = orderRow(db, made.order.po_number);
  await call(db, "dispatch_order_update", {
    job_id: JOB.fence,
    purchase_order_id: order.id,
    expected_order_updated_at: order.updated_at,
    lines: [],
    remove_line_ids: [line(2)],
  });
  const before = db.requests.length;
  const newest = await get(db, "dispatch_order_pdf", {
    purchase_order_id: order.id,
  });
  assertEquals(newest, {
    url: `https://storage.test/${JOB.fence}/PO-1000001-v2.pdf?expires=300`,
    file_name: "PO-1000001.pdf",
    version: 2,
    expires_in: 300,
  });
  assertEquals(
    (await get(db, "dispatch_order_pdf", {
      purchase_order_id: order.id,
      version: "1",
    })).version,
    1,
  );
  assertEquals(
    db.requests.slice(before).filter((r) =>
      !["select", "sign"].includes(r.kind)
    ),
    [],
  );
  await refused(
    get(db, "dispatch_order_pdf", {
      purchase_order_id: order.id,
      version: "3",
    }),
    404,
    "pdf_not_found",
  );
  db.tables.purchase_orders.push({
    id: uuid("e1", 5),
    org_id: ORG,
    job_id: JOB.fence,
    po_number: "PO-683376",
    supplier_name: "Legacy",
    status: "draft",
    created_at: db.tick(),
    updated_at: db.tick(),
  });
  await refused(
    get(db, "dispatch_order_pdf", { purchase_order_id: uuid("e1", 5) }),
    404,
    "pdf_not_found",
  );
});

// ── Slice 4's read and remove-supplier, extended ────────────────────────────

const materialsCtx = (db: ReturnType<typeof makeDb>) => ({
  orgId: ORG,
  actor: { userId: USER.shaun, email: "shaun@ops.test", orgId: ORG },
  extractMaterialsFromScope: () => [],
  now: () => db.tick(),
});

Deno.test("materials read: each supplier carries its order chip, lines their order number, orders the slice 5 fields", async () => {
  const db = withLines();
  await create(db);
  db.tables.purchase_orders.push({
    id: uuid("e1", 5),
    org_id: ORG,
    job_id: JOB.fence,
    po_number: "PO-683376",
    supplier_name: "Legacy",
    status: "draft",
    line_items: [{ description: "Sheets", quantity: 4, unit_price: 50 }],
    created_at: db.tick(),
    updated_at: db.tick(),
  });
  const answer: any = await runDispatchMaterialsAction(
    db.client,
    "dispatch_materials",
    new URLSearchParams({ job_id: JOB.fence }),
    {},
    materialsCtx(db),
  );
  const steel = answer.suppliers.find((s: Row) => s.supplier_id === SUP.steel);
  assertEquals(steel.order.po_number, "PO-1000001");
  assertEquals(steel.order.chip.text, "PO-1000001 · Draft email ready");
  assertEquals(
    answer.suppliers.find((s: Row) => s.supplier_id === SUP.sheets).order,
    null,
  );
  assertEquals(
    answer.lines.find((l: Row) => l.id === line(1)).po_number,
    "PO-1000001",
  );
  assert(!("po_number" in answer.lines.find((l: Row) => l.id === line(3))));
  const dispatchOrder = answer.orders.find((o: Row) =>
    o.po_number === "PO-1000001"
  );
  assertEquals([
    dispatchOrder.source,
    dispatchOrder.supplier_id,
    dispatchOrder.pdf_version,
    dispatchOrder.in_xero,
  ], ["dispatch", SUP.steel, 1, false]);
  assertEquals(dispatchOrder.lines[0].line_id, line(1));
  const legacy = answer.orders.find((o: Row) => o.po_number === "PO-683376");
  assertEquals([legacy.source, legacy.supplier_id], [null, null]);
  assert(!JSON.stringify(answer.orders).includes("unit_price"));
  // The screen sends the read's stamp back to change the order: it is the
  // stored one, and a cancel with it goes through.
  const stored = db.tables.purchase_orders.find((o) =>
    o.po_number === "PO-1000001"
  )!;
  assertEquals(steel.order.updated_at, stored.updated_at);
  assertEquals(dispatchOrder.updated_at, stored.updated_at);
  const cancelled = await call(db, "dispatch_order_cancel", {
    job_id: JOB.fence,
    purchase_order_id: steel.order.id,
    expected_order_updated_at: steel.order.updated_at,
  });
  assertEquals(cancelled.order.status, "cancelled");
  // A failed chip read is never "Not ordered".
  db.failures.add("select:job_order_emails");
  const failed: any = await runDispatchMaterialsAction(
    db.client,
    "dispatch_materials",
    new URLSearchParams({ job_id: JOB.fence }),
    {},
    materialsCtx(db),
  );
  assertEquals(failed.orders_status, "failed");
  assert(failed.suppliers.every((s: Row) => !("order" in s)));
});

Deno.test("remove supplier: refused while it has an order on the job that is not cancelled", async () => {
  const db = withLines();
  await create(db);
  // Clear its lines so only the order holds it.
  for (const l of db.tables.job_material_lines) {
    if (l.supplier_id === SUP.steel) l.supplier_id = SUP.sheets;
  }
  const err = await assertRejects(
    () =>
      runDispatchMaterialsAction(
        db.client,
        "dispatch_materials_remove_supplier",
        new URLSearchParams(),
        { job_id: JOB.fence, supplier_id: SUP.steel },
        materialsCtx(db),
      ),
    DispatchMaterialsError,
  ) as DispatchMaterialsError;
  assertEquals([err.status, err.body.code], [409, "supplier_has_orders"]);
  orderRow(db, "PO-1000001").status = "cancelled";
  const ok: any = await runDispatchMaterialsAction(
    db.client,
    "dispatch_materials_remove_supplier",
    new URLSearchParams(),
    { job_id: JOB.fence, supplier_id: SUP.steel },
    materialsCtx(db),
  );
  assertEquals(ok.success, true);
});

// ── A whole session writes only what it may ─────────────────────────────────

Deno.test("session: create, save, update, send, reply, link and the reads touch no table outside the slice and no outside call but the stub", async () => {
  const db = withLines();
  const t = transport();
  const c = ctx(db, t);
  const made = await create(db, SUP.steel, c);
  const saved = await call(db, "dispatch_order_draft_save", {
    draft_id: made.draft.id,
    subject: "PO for Friday",
    expected_updated_at: made.draft.updated_at,
  }, c);
  await get(db, "dispatch_order_emails", { job_id: JOB.fence }, c);
  await call(db, "dispatch_order_send", {
    draft_id: made.draft.id,
    expected_draft_hash: saved.draft.draft_hash,
  }, c);
  supplierThread(db, orderRow(db, made.order.po_number).id);
  const read = await get(db, "dispatch_order_emails", { job_id: JOB.fence }, c);
  const thread = read.threads.find((th: Row) => th.tag === "supplier");
  await call(db, "dispatch_order_reply", {
    job_id: JOB.fence,
    thread_key: thread.key,
    reply_to_message_id: thread.messages.at(-1).id,
    body_text: "Thanks",
  }, c);
  await get(db, "dispatch_order_pdf", {
    purchase_order_id: orderRow(db, made.order.po_number).id,
  }, c);
  assertOnlyAllowedTouches(db);
  assertEquals(t.calls.length, 2);
  // jobs is only ever read.
  assert(
    db.requests.filter((r) => r.table === "jobs").every((r) =>
      r.kind === "select"
    ),
  );
  assert(
    !db.requests.some((r) =>
      /business_events|job_dispatch_state|job_media|job_documents|jarvis_event_log/
        .test(r.table)
    ),
  );
});

// ── Who may call ────────────────────────────────────────────────────────────

Deno.test("gate: the eleven actions are staff only and on no allow-list", () => {
  assertEquals(DISPATCH_ORDERS_ACTIONS.length, 11);
  assertEquals([...DISPATCH_ORDERS_SENDING_ACTIONS], [
    "dispatch_order_send",
    "dispatch_order_reply",
  ]);
  for (const action of DISPATCH_ORDERS_ACTIONS) {
    const url = new URL(
      `https://example.test/functions/v1/ops-api?action=${action}`,
    );
    for (const role of ["admin", "owner", "ops_manager"]) {
      assertEquals(
        _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }),
        { ok: true },
      );
    }
    for (
      const authUser of [{ role: "installer" }, {
        role: "lead_installer",
        managedVerticals: ["fencing", "patio"],
      }]
    ) {
      const refusedCall = _authorizeOpsApiAction({
        url,
        authMode: "jwt",
        authUser,
      }) as any;
      assertEquals([refusedCall.ok, refusedCall.status, refusedCall.code], [
        false,
        403,
        "operator_access_required",
      ]);
    }
    assert(!AGENT_READ_ALLOWED_ACTIONS.has(action));
    assert(!LEAD_INSTALLER_READ_ACTIONS.has(action));
  }
});

const ENV: Record<string, string> = {
  ...IMPORT_ENV,
  MAKESAFE_ROUTINE_KEY: ROUTINE_KEY,
};

async function withEnvAndFetchSpy<T>(
  fn: (calls: string[]) => Promise<T>,
): Promise<T> {
  const saved = new Map(Object.keys(ENV).map((n) => [n, Deno.env.get(n)]));
  for (const [n, v] of Object.entries(ENV)) Deno.env.set(n, v);
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response("{}", { status: 500 }));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
    for (const [n, v] of saved) {
      if (v === undefined) Deno.env.delete(n);
      else Deno.env.set(n, v);
    }
  }
}

Deno.test("gate: the routine key is refused on all eleven before any call; a write by GET is 405", async () => {
  await withEnvAndFetchSpy(async (calls) => {
    for (const action of DISPATCH_ORDERS_ACTIONS) {
      const isRead = action === "dispatch_order_emails" ||
        action === "dispatch_order_pdf";
      const res = await _opsApiRequestHandlerForTest(
        new Request(
          `https://example.invalid/ops-api?action=${action}&job_id=${JOB.fence}`,
          {
            method: isRead ? "GET" : "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": ROUTINE_KEY,
            },
            body: isRead ? undefined : JSON.stringify({ job_id: JOB.fence }),
          },
        ),
      );
      assertEquals(res.status, 403, action);
      await res.body?.cancel();
    }
    const get = await _opsApiRequestHandlerForTest(
      new Request(
        "https://example.invalid/ops-api?action=dispatch_order_send",
        {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SERVICE_KEY}`,
          },
        },
      ),
    );
    assertEquals(get.status, 405);
    await get.body?.cancel();
    assertEquals(calls, []);
  });
});
