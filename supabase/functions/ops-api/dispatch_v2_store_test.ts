// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch v2 (docs/dispatch-v2-emails-contract.md): the draft list, supplier
// boxes, photos and supplier order emails in dispatch_v2_store.ts, end to end,
// against an in-memory stand-in for PostgREST and storage. The stand-in knows
// every column the code may name (a wrong column name is a 42703, as live) and
// keeps the migrations' keys: the line-to-box link, one box per supplier per
// job, one main tick per job, one open email per box.
//
// NO EMAIL IS SENT. Every send goes to a fake sender that only records what it
// was asked to send. Job, client and supplier details are made up.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISPATCH_V2_ACTIONS,
  DISPATCH_V2_READ_ACTIONS,
  DISPATCH_V2_WRITE_ACTIONS,
  type DispatchV2Context,
  type DispatchV2OutlookPayload,
  type DispatchV2SendOutcome,
  projectDispatchV2Email,
  runDispatchV2Action,
} from "./dispatch_v2_store.ts";
import { DispatchMaterialsError } from "./dispatch_materials_store.ts";

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
  patio: uuid("a1", 2),
  repair: uuid("a1", 3),
  decking: uuid("a1", 4),
  makesafe: uuid("a1", 5),
  other: uuid("a1", 6),
  misc: uuid("a1", 7),
};
const SUP = {
  stratco: uuid("b1", 1),
  metroll: uuid("b1", 2),
  plain: uuid("b1", 3),
  inactive: uuid("b1", 4),
  oldlink: uuid("b1", 5),
  otherOrg: uuid("b1", 6),
};
const APPROVED = {
  stratco: uuid("c1", 1),
  metroll: uuid("c1", 2),
  unlinked: uuid("c1", 3),
  retired: uuid("c1", 4),
};
const L = (n: number) => uuid("e1", n);
const SHAUN = { userId: uuid("d1", 1), email: "shaun@ops.test", orgId: ORG };

const SCHEMA: Record<string, string[]> = {
  jobs: [
    "id",
    "org_id",
    "job_number",
    "type",
    "status",
    "client_name",
    "client_phone",
    "site_address",
    "site_suburb",
    "metadata",
    "scope_json",
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
    "detail",
    "profile",
    "colour",
    "dispatch_order_email_id",
  ],
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
    "is_main_supplier",
  ],
  dispatch_approved_supplier_emails: [
    "id",
    "org_id",
    "name",
    "used_for",
    "to_emails",
    "cc_emails",
    "active",
    "approved_by",
    "approved_on",
    "created_at",
    "updated_at",
  ],
  dispatch_approved_supplier_email_links: [
    "supplier_id",
    "approved_id",
    "org_id",
    "created_at",
    "created_by_email",
  ],
  dispatch_material_photos: [
    "id",
    "org_id",
    "job_id",
    "supplier_id",
    "file_name",
    "content_type",
    "size_bytes",
    "storage_path",
    "sha256",
    "created_at",
    "created_by",
    "created_by_email",
  ],
  dispatch_supplier_order_emails: [
    "id",
    "org_id",
    "job_id",
    "supplier_id",
    "supplier_name",
    "approved_email_id",
    "work_type",
    "is_main_supplier",
    "standing_lines_included",
    "status",
    "team_cc_email",
    "to_emails",
    "cc_emails",
    "subject",
    "body_text",
    "built_body_text",
    "delivery_date",
    "order_lines",
    "photo_ids",
    "test_sent_at",
    "test_sent_to",
    "test_sent_by_email",
    "test_internet_message_id",
    "test_conversation_id",
    "send_claimed_at",
    "sent_at",
    "sent_by",
    "sent_by_email",
    "sent_from_mailbox",
    "sent_to_emails",
    "sent_cc_emails",
    "sent_internet_message_id",
    "sent_conversation_id",
    "sent_graph_message_id",
    "last_error",
    "created_at",
    "created_by",
    "created_by_email",
    "updated_at",
    "updated_by_email",
  ],
};

// The tables v2 may write. Anything else written is a failure.
const V2_WRITABLE = new Set([
  "job_material_lines",
  "job_material_suppliers",
  "dispatch_material_photos",
  "dispatch_supplier_order_emails",
  "storage",
]);

function job(id: string, over: Row = {}): Row {
  return {
    id,
    org_id: ORG,
    job_number: "SWF-900001",
    type: "fencing",
    status: "order_materials",
    client_name: "Jeremy Example",
    client_phone: "0400 000 000",
    site_address: "1 Example St",
    site_suburb: "Exampleton",
    metadata: null,
    scope_json: null,
    ...over,
  };
}

function seed(): Record<string, Row[]> {
  const supplier = (id: string, name: string, over: Row = {}) => ({
    id,
    org_id: ORG,
    name,
    email: "xero-sync-owns-this@example.test",
    is_active: true,
    ...over,
  });
  const approved = (id: string, name: string, over: Row = {}) => ({
    id,
    org_id: ORG,
    name,
    used_for: "any",
    to_emails: [],
    cc_emails: [],
    active: true,
    approved_by: "Shaun",
    approved_on: "2026-10-23",
    ...over,
  });
  return {
    jobs: [
      job(JOB.fence, {
        scope_json: { items: ["Colorbond fence sheets", "Concrete bags (20kg)"] },
      }),
      job(JOB.patio, { type: "patio", job_number: "SWP-900002" }),
      job(JOB.repair, { type: "repair", job_number: "SWR-900003" }),
      job(JOB.decking, { type: "decking", job_number: "SWD-900004" }),
      job(JOB.makesafe, { type: "makesafe", job_number: "SWMS-90005" }),
      job(JOB.other, { org_id: OTHER_ORG }),
      job(JOB.misc, { type: "miscellaneous", job_number: "SWM-900007" }),
    ],
    suppliers: [
      supplier(SUP.stratco, "Stratco (WA) Pty Ltd"),
      supplier(SUP.metroll, "Metroll Perth"),
      supplier(SUP.plain, "Plain Hardware"),
      supplier(SUP.inactive, "Gone Supplies", { is_active: false }),
      supplier(SUP.oldlink, "Retired Link Supplies"),
      supplier(SUP.otherOrg, "Other Org Steel", { org_id: OTHER_ORG }),
    ],
    dispatch_approved_supplier_emails: [
      approved(APPROVED.stratco, "Stratco", {
        used_for: "fencing+patio",
        to_emails: ["tradewa@stratcowa.com.au"],
        cc_emails: ["tony.bacich@stratcowa.com.au"],
      }),
      approved(APPROVED.metroll, "Metroll", {
        used_for: "patio",
        to_emails: ["orders@metroll.test"],
      }),
      approved(APPROVED.unlinked, "Unique Laser", {
        to_emails: ["orders@unique-laser.test"],
      }),
      approved(APPROVED.retired, "Retired", {
        to_emails: ["old@retired.test"],
        active: false,
      }),
    ],
    dispatch_approved_supplier_email_links: [
      { supplier_id: SUP.stratco, approved_id: APPROVED.stratco, org_id: ORG },
      { supplier_id: SUP.metroll, approved_id: APPROVED.metroll, org_id: ORG },
      { supplier_id: SUP.oldlink, approved_id: APPROVED.retired, org_id: ORG },
    ],
    job_material_suppliers: [],
    job_material_lines: [],
    dispatch_material_photos: [],
    dispatch_supplier_order_emails: [],
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
  const tables: Record<string, Row[]> = structuredClone(initial);
  const requests: Recorded[] = [];
  const failures = new Set<string>();
  const files = new Map<string, Uint8Array>();

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
  const baseColumn = (expression: string) => expression.split("->")[0];
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
    if (!known) return violation("42P01", `relation ${table} does not exist`);
    const bad = names.find((n) => !known.includes(baseColumn(n)));
    return bad
      ? violation("42703", `column ${table}.${bad} does not exist`)
      : null;
  }
  function project(row: Row, select: string): Row {
    if (!select || select === "*") return structuredClone(row);
    const out: Row = {};
    for (const [alias, expression] of columnsOf(select)) {
      out[alias] = structuredClone(valueOf(row, expression) ?? null);
    }
    return out;
  }

  // The migrations' keys and checks, as Postgres would enforce them.
  function checkRow(table: string, row: Row, all: Row[]) {
    const others = all.filter((r) => r !== row);
    if (table === "job_material_lines") {
      if (others.some((r) => r.id === row.id)) {
        return violation("23505", "job_material_lines_pkey");
      }
      if (
        row.supplier_id &&
        !tables.job_material_suppliers.some((b) =>
          b.job_id === row.job_id && b.supplier_id === row.supplier_id
        )
      ) return violation("23503", "job_material_lines_supplier_on_job_fkey");
      if (!["not_reviewed", "to_order", "in_stock"].includes(row.status)) {
        return violation("23514", "job_material_lines_status_valid");
      }
    }
    if (table === "job_material_suppliers") {
      if (
        others.some((r) =>
          r.job_id === row.job_id && r.supplier_id === row.supplier_id
        )
      ) return violation("23505", "job_material_suppliers_job_supplier_key");
      if (
        row.is_main_supplier &&
        others.some((r) => r.job_id === row.job_id && r.is_main_supplier)
      ) return violation("23505", "job_material_suppliers_one_main_idx");
    }
    if (table === "dispatch_material_photos") {
      if (
        row.supplier_id &&
        !tables.job_material_suppliers.some((b) =>
          b.job_id === row.job_id && b.supplier_id === row.supplier_id
        )
      ) {
        return violation(
          "23503",
          "dispatch_material_photos_supplier_on_job_fkey",
        );
      }
      if (!(row.size_bytes >= 1 && row.size_bytes <= 3_000_000)) {
        return violation("23514", "dispatch_material_photos_size");
      }
    }
    if (table === "dispatch_supplier_order_emails") {
      const open = ["draft", "sending", "send_unknown"];
      if (
        !["draft", "sending", "sent", "send_unknown", "discarded"].includes(
          row.status,
        )
      ) return violation("23514", "dispatch_supplier_order_emails_status_valid");
      if (
        open.includes(row.status) &&
        others.some((r) =>
          r.job_id === row.job_id && r.supplier_id === row.supplier_id &&
          open.includes(r.status)
        )
      ) return violation("23505", "dispatch_supplier_order_emails_one_open_idx");
      if (
        !Array.isArray(row.to_emails) || row.to_emails.length < 1 ||
        row.to_emails.length > 10
      ) return violation("23514", "dispatch_supplier_order_emails_to_count");
      if ((row.photo_ids || []).length > 3) {
        return violation("23514", "dispatch_supplier_order_emails_photo_count");
      }
      if (row.status === "sent" && !row.sent_at) {
        return violation(
          "23514",
          "dispatch_supplier_order_emails_sent_has_time",
        );
      }
    }
    return null;
  }

  function from(table: string) {
    const request: Recorded = { table, kind: "select", select: "", filters: [] };
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
        if (op === "not.is") return (actual ?? null) !== value;
        if (op === "ilike") {
          const pattern = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/%/g, ".*");
          return new RegExp(`^${pattern}$`, "i").test(String(actual ?? ""));
        }
        throw new Error(`stand-in has no filter ${op}`);
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
        return finish(found.map((r) => project(r, request.select)));
      }
      if (request.kind === "insert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map((
          r: Row,
        ) => structuredClone(r));
        const badWrite = unknownColumn(
          table,
          incoming.flatMap((r: Row) => Object.keys(r)),
        );
        if (badWrite) return badWrite;
        for (const row of incoming) {
          if (table !== "dispatch_approved_supplier_email_links") {
            row.id ??= crypto.randomUUID();
          }
          row.created_at ??= new Date().toISOString();
          if (table === "job_material_suppliers") {
            row.is_main_supplier ??= false;
          }
          if (table === "dispatch_supplier_order_emails") {
            row.cc_emails ??= [];
            row.photo_ids ??= [];
            row.order_lines ??= [];
          }
          const failure = checkRow(table, row, [...rows, ...incoming]);
          if (failure) return failure;
        }
        rows.push(...incoming);
        return finish(incoming.map((r: Row) => project(r, returning || "*")));
      }
      if (request.kind === "update") {
        const badWrite = unknownColumn(table, Object.keys(payload));
        if (badWrite) return badWrite;
        const targets = rows.filter(matches);
        const next = targets.map((t) => ({ ...t, ...structuredClone(payload) }));
        for (const n of next) {
          const failure = checkRow(
            table,
            n,
            rows.map((r) => next[targets.indexOf(r)] ?? r),
          );
          if (failure) return failure;
        }
        targets.forEach((t, i) => Object.assign(t, next[i]));
        return finish(targets.map((r) => project(r, returning || "*")));
      }
      const targets = rows.filter(matches);
      if (
        table === "job_material_suppliers" &&
        targets.some((box) =>
          tables.job_material_lines.some((l) =>
            l.job_id === box.job_id && l.supplier_id === box.supplier_id
          )
        )
      ) return violation("23503", "job_material_lines_supplier_on_job_fkey");
      tables[table] = rows.filter((r) => !targets.includes(r));
      return finish(targets.map((r) => project(r, returning || "id")));
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
      not(c: string, op: string, v: unknown) {
        request.filters.push([`not.${op}`, c, v]);
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

  const client = {
    from,
    rpc(name: string) {
      requests.push({ table: `rpc:${name}`, kind: "rpc", select: "", filters: [] });
      return Promise.resolve(violation("42883", `function ${name} does not exist`));
    },
    storage: {
      from(bucket: string) {
        assertEquals(bucket, "dispatch-material-photos");
        const note = (kind: string, path: string) =>
          requests.push({ table: "storage", kind, select: path, filters: [] });
        return {
          upload(path: string, bytes: Uint8Array, options: any) {
            note("upload", path);
            if (failures.has("storage:upload")) {
              return Promise.resolve({ data: null, error: { message: "down" } });
            }
            if (files.has(path) && !options?.upsert) {
              return Promise.resolve({
                data: null,
                error: { statusCode: "409", message: "exists" },
              });
            }
            files.set(path, new Uint8Array(bytes));
            return Promise.resolve({ data: { path }, error: null });
          },
          remove(paths: string[]) {
            note("remove", paths.join(","));
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
            note("sign", path);
            return Promise.resolve(
              files.has(path)
                ? {
                  data: {
                    signedUrl: `https://storage.test/${path}?expires=${seconds}`,
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
    tables,
    requests,
    failures,
    files,
    writes: () =>
      requests.filter((r) => !["select", "sign"].includes(r.kind)),
  };
}

// ── The fake sender: records, never sends ───────────────────────────────────

function fakeSender(
  answer: (p: DispatchV2OutlookPayload, n: number) => DispatchV2SendOutcome =
    (_p, n) => ({
      kind: "sent",
      ids: {
        graph_message_id: `graph-${n}`,
        internet_message_id: `<order-${n}@secureworkswa.test>`,
        conversation_id: `conv-${n}`,
      },
    }),
) {
  const sent: DispatchV2OutlookPayload[] = [];
  const sender = (payload: DispatchV2OutlookPayload) => {
    sent.push(structuredClone(payload));
    return Promise.resolve(answer(payload, sent.length));
  };
  return { sent, sender };
}

let clockMs = Date.UTC(2026, 9, 23, 2, 0, 0);
function ctx(
  sender = fakeSender().sender,
  over: Partial<DispatchV2Context> = {},
): DispatchV2Context {
  return {
    orgId: ORG,
    actor: SHAUN,
    extractMaterialsFromScope: (scope: any) =>
      (scope?.items || []).map((description: string) => ({
        description,
        quantity: 4,
        unit: null,
      })),
    sender,
    // Every call moves the clock one second on, as real stamps would.
    now: () => new Date(clockMs += 1000).toISOString(),
    ...over,
  };
}

const params = (values: Record<string, string> = {}) =>
  new URLSearchParams(values);

function call(
  db: ReturnType<typeof makeDb>,
  action: string,
  body: Row,
  c = ctx(),
): Promise<any> {
  return runDispatchV2Action(db.client, action, params(), body, c);
}

function get(
  db: ReturnType<typeof makeDb>,
  action: string,
  values: Record<string, string>,
  c = ctx(),
): Promise<any> {
  return runDispatchV2Action(db.client, action, params(values), null, c);
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

async function addBox(
  db: ReturnType<typeof makeDb>,
  jobId: string,
  supplierId: string,
) {
  return await call(db, "dispatch_v2_add_supplier", {
    job_id: jobId,
    supplier_id: supplierId,
  });
}

async function addLine(
  db: ReturnType<typeof makeDb>,
  jobId: string,
  n: number,
  line: Row,
) {
  const out = await call(db, "dispatch_v2_save_line", {
    job_id: jobId,
    line: { id: L(n), quantity: 1, ...line },
  });
  return out.line;
}

// A fencing job with two boxes: Stratco holds the panels and plinths, Metroll
// holds the gate. One In stock line stays in Stratco's box.
async function fencingJob(db = makeDb()) {
  await addBox(db, JOB.fence, SUP.metroll);
  await addBox(db, JOB.fence, SUP.stratco);
  await addLine(db, JOB.fence, 1, {
    supplier_id: SUP.stratco,
    description: "1800H standard width panels with 2400H posts",
    quantity: 14,
    profile: "Neetascreen",
    colour: "Monument",
  });
  await addLine(db, JOB.fence, 2, {
    supplier_id: SUP.stratco,
    description: "150mm standard width plinths",
    quantity: 14,
    colour: "Monument",
  });
  await addLine(db, JOB.fence, 3, {
    supplier_id: SUP.metroll,
    description: "gate posts",
    quantity: 2,
    detail: "Gate: Pedestrian gate 1270mm",
  });
  await addLine(db, JOB.fence, 4, {
    supplier_id: SUP.stratco,
    description: "Tek screws we have",
    status: "in_stock",
  });
  return db;
}

async function makeEmail(
  db: ReturnType<typeof makeDb>,
  jobId: string,
  supplierId: string,
  extra: Row = {},
) {
  return await call(db, "dispatch_v2_make_email", {
    job_id: jobId,
    supplier_id: supplierId,
    delivery_date: "2026-11-04",
    ...extra,
  });
}

function assertOnlyV2Writes(db: ReturnType<typeof makeDb>) {
  for (const w of db.writes()) {
    assert(V2_WRITABLE.has(w.table), `wrote ${w.kind} ${w.table}`);
  }
  assertEquals(
    db.tables.suppliers.map((s) => s.email),
    seed().suppliers.map((s) => s.email),
    "suppliers.email is never written",
  );
}

// ── The read ────────────────────────────────────────────────────────────────

Deno.test("read: boxes, draft list, main supplier, team CC and the no-approved-email block", async () => {
  const db = await fencingJob();
  await addBox(db, JOB.fence, SUP.plain);
  await addLine(db, JOB.fence, 9, { description: "Draft list line" });
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(read.job_number, "SWF-900001");
  assertEquals(read.work_type, "fencing");
  assertEquals(read.team_cc.email, "fencing@secureworkswa.com.au");
  assertEquals(read.from, "admin@secureworkswa.com.au");
  assertEquals(read.test_send_done, false);
  // Metroll was added first, but Stratco holds the panels.
  assertEquals(read.main_supplier_id, SUP.stratco);
  assertEquals(read.main_supplier_ticked, false);
  assertEquals(read.can_suggest, false);
  assertEquals(read.draft_list.lines.map((l: any) => l.id), [L(9)]);
  assertEquals(read.draft_list.lines[0].supplier_id, null);
  assertEquals(
    read.suppliers.map((s: any) => [s.supplier_id, s.is_main, !!s.send_blocked]),
    [
      [SUP.metroll, false, false],
      [SUP.stratco, true, false],
      [SUP.plain, false, true],
    ],
  );
  const stratco = read.suppliers[1];
  assertEquals(stratco.approved_email.to, ["tradewa@stratcowa.com.au"]);
  assertEquals(stratco.lines.map((l: any) => l.id), [L(1), L(2), L(4)]);
  assertEquals(stratco.lines[0].profile, "Neetascreen");
  assertEquals(read.suppliers[2].send_blocked.code, "no_approved_email");
  assertOnlyV2Writes(db);
});

Deno.test("read: a make-safe job, another org's job and a bad id are refused", async () => {
  const db = makeDb();
  await refused(
    get(db, "dispatch_v2_materials", { job_id: JOB.makesafe }),
    409,
    "not_dispatch_work",
  );
  await refused(
    get(db, "dispatch_v2_materials", { job_id: JOB.other }),
    404,
    "job_not_found",
  );
  await refused(
    get(db, "dispatch_v2_materials", { job_id: "nope" }),
    400,
    "invalid_request",
  );
  const repair = await get(db, "dispatch_v2_materials", { job_id: JOB.repair });
  assertEquals(repair.work_type, "repair");
  assertEquals(repair.team_cc.email, "ses@secureworkswa.com.au");
  const decking = await get(db, "dispatch_v2_materials", { job_id: JOB.decking });
  assertEquals(decking.team_cc.email, "patios@secureworkswa.com.au");
  assert(decking.team_cc.open_question);
});

// ── Supplier search ─────────────────────────────────────────────────────────

Deno.test("search: approved list first, then every other active supplier, each flagged", async () => {
  const db = makeDb();
  const all = await get(db, "dispatch_v2_supplier_search", {});
  assertEquals(
    all.approved.map((a: any) => [a.approved_name, a.supplier_id, a.can_add]),
    [
      ["Metroll", SUP.metroll, true],
      ["Stratco", SUP.stratco, true],
      ["Unique Laser", null, false],
    ],
  );
  assert(all.approved.every((a: any) => a.has_approved_email === true));
  // The retired entry's supplier and plain suppliers come after, unflagged;
  // inactive and other-org suppliers are not offered.
  assertEquals(
    all.others.map((o: any) => [o.name, o.has_approved_email]),
    [["Plain Hardware", false], ["Retired Link Supplies", false]].sort(),
  );
  const q = await get(db, "dispatch_v2_supplier_search", { q: "strat" });
  assertEquals(q.approved.map((a: any) => a.supplier_id), [SUP.stratco]);
  assertEquals(q.others, []);
});

// ── Lines ───────────────────────────────────────────────────────────────────

Deno.test("lines: into a box, between boxes and back to the draft list; stale stamp refused", async () => {
  const db = makeDb();
  await addBox(db, JOB.fence, SUP.stratco);
  await addBox(db, JOB.fence, SUP.metroll);
  let line = await addLine(db, JOB.fence, 1, { description: "Plinths" });
  assertEquals(line.supplier_id, null);
  line = (await call(db, "dispatch_v2_move_line", {
    job_id: JOB.fence,
    id: L(1),
    supplier_id: SUP.stratco,
    expected_updated_at: line.updated_at,
  })).line;
  assertEquals(line.supplier_id, SUP.stratco);
  const stale = line.updated_at;
  line = (await call(db, "dispatch_v2_move_line", {
    job_id: JOB.fence,
    id: L(1),
    supplier_id: SUP.metroll,
    expected_updated_at: line.updated_at,
  })).line;
  assertEquals(line.supplier_id, SUP.metroll);
  await refused(
    call(db, "dispatch_v2_move_line", {
      job_id: JOB.fence,
      id: L(1),
      supplier_id: null,
      expected_updated_at: stale,
    }),
    409,
    "line_changed",
  );
  line = (await call(db, "dispatch_v2_move_line", {
    job_id: JOB.fence,
    id: L(1),
    supplier_id: null,
    expected_updated_at: line.updated_at,
  })).line;
  assertEquals(line.supplier_id, null);
  // A box that is not on the job is refused.
  await refused(
    call(db, "dispatch_v2_move_line", {
      job_id: JOB.fence,
      id: L(1),
      supplier_id: SUP.plain,
      expected_updated_at: line.updated_at,
    }),
    409,
    "supplier_not_on_job",
  );
  // An edit keeps the box and adds the template's extra lines.
  const edited = (await call(db, "dispatch_v2_save_line", {
    job_id: JOB.fence,
    expected_updated_at: line.updated_at,
    line: {
      id: L(1),
      description: "Plinths",
      quantity: 3,
      detail: "Gate: Pedestrian gate 1270mm\n  ",
      colour: "Dune",
    },
  })).line;
  assertEquals([edited.quantity, edited.detail, edited.colour], [
    3,
    "Gate: Pedestrian gate 1270mm",
    "Dune",
  ]);
  // A retried insert is one row, never two.
  const again = await call(db, "dispatch_v2_save_line", {
    job_id: JOB.fence,
    line: { id: L(1), description: "Plinths" },
  });
  assertEquals(again.unchanged, true);
  assertEquals(db.tables.job_material_lines.length, 1);
  await call(db, "dispatch_v2_delete_line", {
    job_id: JOB.fence,
    id: L(1),
    expected_updated_at: edited.updated_at,
  });
  assertEquals(db.tables.job_material_lines.length, 0);
  assertOnlyV2Writes(db);
});

Deno.test("suggest: fills the draft list from the scope, leaves concrete bags out, and only once", async () => {
  const db = makeDb();
  const first = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assertEquals(first.added, 1);
  assertEquals(first.lines[0].supplier_id, null);
  assertEquals(first.lines[0].source, "scope");
  assert(!first.lines.some((l: any) => /concrete/i.test(l.description)));
  await refused(
    call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence }),
    409,
    "lines_exist",
  );
  await refused(
    call(db, "dispatch_v2_suggest_draft", { job_id: JOB.repair }),
    409,
    "no_suggestion_for_work_type",
  );
});

// ── Boxes and the main tick ─────────────────────────────────────────────────

Deno.test("boxes: add flags a supplier with no approved email; an occupied box cannot be removed", async () => {
  const db = makeDb();
  const plain = await addBox(db, JOB.fence, SUP.plain);
  assertEquals(plain.supplier.send_blocked.code, "no_approved_email");
  const stratco = await addBox(db, JOB.fence, SUP.stratco);
  assertEquals(stratco.supplier.send_blocked, null);
  assertEquals(stratco.supplier.approved_email.cc, [
    "tony.bacich@stratcowa.com.au",
  ]);
  assertEquals((await addBox(db, JOB.fence, SUP.stratco)).unchanged, true);
  // A retired approved entry counts as none.
  assertEquals(
    (await addBox(db, JOB.fence, SUP.oldlink)).supplier.send_blocked.code,
    "no_approved_email",
  );
  await refused(addBox(db, JOB.fence, SUP.inactive), 409, "supplier_inactive");
  await refused(addBox(db, JOB.fence, SUP.otherOrg), 404, "supplier_not_found");
  await addLine(db, JOB.fence, 1, { supplier_id: SUP.stratco, description: "x" });
  await refused(
    call(db, "dispatch_v2_remove_supplier", {
      job_id: JOB.fence,
      supplier_id: SUP.stratco,
    }),
    409,
    "supplier_has_lines",
  );
  await call(db, "dispatch_v2_remove_supplier", {
    job_id: JOB.fence,
    supplier_id: SUP.plain,
  });
  assertEquals(
    db.tables.job_material_suppliers.map((b) => b.supplier_id).sort(),
    [SUP.oldlink, SUP.stratco].sort(),
  );
});

Deno.test("main tick: moves the standing lines to the ticked box; null clears it", async () => {
  const db = await fencingJob();
  const ticked = await call(db, "dispatch_v2_set_main_supplier", {
    job_id: JOB.fence,
    supplier_id: SUP.metroll,
  });
  assertEquals(ticked, {
    success: true,
    main_supplier_id: SUP.metroll,
    main_supplier_ticked: true,
  });
  const metroll = (await makeEmail(db, JOB.fence, SUP.metroll)).email;
  assertEquals(metroll.is_main_supplier, true);
  assertEquals(metroll.standing_lines_included, true);
  assert(metroll.body_text.includes("3. Fixings, Post Caps and Screws"));
  const stratco = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  assertEquals(stratco.standing_lines_included, false);
  assert(!stratco.body_text.includes("quickset"));
  const cleared = await call(db, "dispatch_v2_set_main_supplier", {
    job_id: JOB.fence,
    supplier_id: null,
  });
  assertEquals(cleared.main_supplier_id, SUP.stratco);
  assertEquals(cleared.main_supplier_ticked, false);
  assertEquals(
    db.tables.job_material_suppliers.filter((b) => b.is_main_supplier).length,
    0,
  );
});

// ── Photos ──────────────────────────────────────────────────────────────────

function jpegBase64(size = 64): string {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

Deno.test("photos: a small JPEG goes in a box privately; 3 MB or more and HEIC are refused", async () => {
  const db = makeDb();
  await addBox(db, JOB.fence, SUP.stratco);
  const up = await call(db, "dispatch_v2_upload_photo", {
    job_id: JOB.fence,
    supplier_id: SUP.stratco,
    file_name: "Nithin list.jpeg",
    data_base64: jpegBase64(),
  });
  assertEquals(up.photo.content_type, "image/jpeg");
  assertEquals(up.photo.file_name, "Nithin-list.jpg");
  assertEquals(up.photo.size_bytes, 64);
  assertEquals(db.files.size, 1);
  const link = await get(db, "dispatch_v2_photo_url", {
    job_id: JOB.fence,
    photo_id: up.photo.id,
  });
  assertEquals(link.expires_in_seconds, 600);
  assert(link.url.startsWith("https://storage.test/"));
  const big = await refused(
    call(db, "dispatch_v2_upload_photo", {
      job_id: JOB.fence,
      data_base64: "A".repeat(4_000_004),
    }),
    413,
    "photo_too_large",
  );
  assert(big.message.includes("MB"));
  const heic = btoa("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00");
  await refused(
    call(db, "dispatch_v2_upload_photo", { job_id: JOB.fence, data_base64: heic }),
    400,
    "photo_type_not_allowed",
  );
  // Moved to the draft list, then removed with its file.
  const moved = await call(db, "dispatch_v2_move_photo", {
    job_id: JOB.fence,
    photo_id: up.photo.id,
    supplier_id: null,
  });
  assertEquals(moved.photo.supplier_id, null);
  await call(db, "dispatch_v2_delete_photo", {
    job_id: JOB.fence,
    photo_id: up.photo.id,
  });
  assertEquals(db.tables.dispatch_material_photos.length, 0);
  assertEquals(db.files.size, 0);
});

// ── Make email ──────────────────────────────────────────────────────────────

Deno.test("make email: fencing main supplier, To and CC from the approved list plus fencing@", async () => {
  const db = await fencingJob();
  const made = await makeEmail(db, JOB.fence, SUP.stratco);
  const email = made.email;
  assertEquals(email.status, "draft");
  assertEquals(email.from, "admin@secureworkswa.com.au");
  assertEquals(email.to, ["tradewa@stratcowa.com.au"]);
  assertEquals(email.cc, [
    "tony.bacich@stratcowa.com.au",
    "fencing@secureworkswa.com.au",
  ]);
  assertEquals(email.subject, "Material Order Ref SWF-900001");
  assertEquals(email.is_main_supplier, true);
  assertEquals(email.standing_lines_included, true);
  assertEquals(email.edited, false);
  assertEquals(email.empty_detail_lines, []);
  assertEquals(made.missing, []);
  // The In stock line is left out.
  assert(!email.body_text.includes("Tek screws we have"));
  assert(
    email.body_text.endsWith(
      "3. 4 x bags of quickset\n\n4. Fixings, Post Caps and Screws as necessary\n\n\nPlease confirm when you can, thank you.",
    ),
  );
  assertEquals(email.line_count, 4);
  // Pressing again returns the same held email.
  const again = await makeEmail(db, JOB.fence, SUP.stratco);
  assertEquals([again.unchanged, again.email.id], [true, email.id]);
  // The non-main box: no standing lines.
  const metroll = (await makeEmail(db, JOB.fence, SUP.metroll)).email;
  assertEquals(metroll.standing_lines_included, false);
  assertEquals(
    metroll.body_text.split("\n").filter((l: string) => /^\d+\. /.test(l)),
    ["1. 2 x gate posts"],
  );
  assertEquals(metroll.cc, ["fencing@secureworkswa.com.au"]);
  assertOnlyV2Writes(db);
});

Deno.test("make email: patio CCs patios@, repair CCs ses@, decking CCs patios@ and says it is open", async () => {
  const db = makeDb();
  for (const jobId of [JOB.patio, JOB.repair, JOB.decking]) {
    await addBox(db, jobId, SUP.metroll);
    await call(db, "dispatch_v2_save_line", {
      job_id: jobId,
      line: {
        id: crypto.randomUUID(),
        supplier_id: SUP.metroll,
        description: "Insulated roof panels",
        quantity: 6,
      },
    });
  }
  const patio = await makeEmail(db, JOB.patio, SUP.metroll);
  assertEquals(patio.email.cc, ["patios@secureworkswa.com.au"]);
  assertEquals(patio.email.standing_lines_included, false);
  assertEquals(patio.team_cc_open_question, null);
  const repair = await makeEmail(db, JOB.repair, SUP.metroll);
  assertEquals(repair.email.cc, ["ses@secureworkswa.com.au"]);
  assertEquals(repair.email.subject, "Material Order Ref SWR-900003");
  const decking = await makeEmail(db, JOB.decking, SUP.metroll);
  assertEquals(decking.email.cc, ["patios@secureworkswa.com.au"]);
  assert(decking.team_cc_open_question);
});

Deno.test("make email: no approved email, no lines and a bad date are refused", async () => {
  const db = makeDb();
  await addBox(db, JOB.fence, SUP.plain);
  await addLine(db, JOB.fence, 1, { supplier_id: SUP.plain, description: "x" });
  await refused(makeEmail(db, JOB.fence, SUP.plain), 409, "no_approved_email");
  await addBox(db, JOB.fence, SUP.stratco);
  await refused(makeEmail(db, JOB.fence, SUP.stratco), 409, "no_lines_to_order");
  await refused(
    makeEmail(db, JOB.fence, SUP.stratco, { delivery_date: "4/11/2026" }),
    400,
    "invalid_request",
  );
  assertEquals(db.tables.dispatch_supplier_order_emails.length, 0);
});

Deno.test("save and discard: edits are kept and seen as edited; a stale stamp is refused", async () => {
  const db = await fencingJob();
  const email = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  const saved = (await call(db, "dispatch_v2_save_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
    to: ["TradeWA@stratcowa.com.au", "second@stratcowa.com.au"],
    body_text: email.body_text.replace("Hi Team", "Hi Tony"),
  })).email;
  assertEquals(saved.to, ["tradewa@stratcowa.com.au", "second@stratcowa.com.au"]);
  assertEquals(saved.edited, true);
  await refused(
    call(db, "dispatch_v2_save_email", {
      email_id: email.id,
      expected_updated_at: email.updated_at,
      subject: "x",
    }),
    409,
    "email_changed",
  );
  await refused(
    call(db, "dispatch_v2_save_email", {
      email_id: email.id,
      expected_updated_at: saved.updated_at,
      to: ["not an email"],
    }),
    400,
    "invalid_request",
  );
  await call(db, "dispatch_v2_discard_email", {
    email_id: email.id,
    expected_updated_at: saved.updated_at,
  });
  assertEquals(db.tables.dispatch_supplier_order_emails[0].status, "discarded");
  // A discarded email does not block a new one.
  const fresh = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  assert(fresh.id !== email.id);
});

// ── Send ────────────────────────────────────────────────────────────────────

Deno.test("send: test copy to admin@ only, then the real send from admin@ records the ids and locks the lines", async () => {
  const db = await fencingJob();
  await call(db, "dispatch_v2_upload_photo", {
    job_id: JOB.fence,
    supplier_id: SUP.stratco,
    data_base64: jpegBase64(),
  });
  const { sent, sender } = fakeSender();
  const c = ctx(sender);
  const email = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  assertEquals(email.photo_ids.length, 1);

  // A real send before any test send is refused, and nothing goes.
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: email.updated_at,
    }, c),
    409,
    "test_send_first",
  );
  assertEquals(sent.length, 0);

  const test = await call(db, "dispatch_v2_send_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
    test: true,
  }, c);
  assertEquals([test.success, test.test, test.sent_to, test.recorded], [
    true,
    true,
    "admin@secureworkswa.com.au",
    true,
  ]);
  assertEquals(sent[0].to, ["admin@secureworkswa.com.au"]);
  assertEquals(sent[0].cc, []);
  assert(sent[0].subject.startsWith("TEST ONLY: "));
  assert(sent[0].htmlBody.includes("tradewa@stratcowa.com.au"));
  assertEquals(sent[0].attachments.length, 1);
  assertEquals(test.email.status, "draft");
  assertEquals(test.email.sent, null);
  assertEquals(test.email.test.sent_to, "admin@secureworkswa.com.au");
  // The test left the stamp alone, so the same stamp sends for real.
  assertEquals(test.email.updated_at, email.updated_at);
  const row0 = db.tables.dispatch_supplier_order_emails[0];
  assertEquals(row0.sent_conversation_id ?? null, null);
  assertEquals(row0.test_conversation_id, "conv-1");

  const real = await call(db, "dispatch_v2_send_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
  }, c);
  assertEquals([real.success, real.test, real.recorded], [true, false, true]);
  assertEquals(sent.length, 2);
  const payload = sent[1];
  assertEquals(payload.from, "admin@secureworkswa.com.au");
  assertEquals(payload.to, ["tradewa@stratcowa.com.au"]);
  assertEquals(payload.cc, [
    "tony.bacich@stratcowa.com.au",
    "fencing@secureworkswa.com.au",
  ]);
  assertEquals(payload.subject, "Material Order Ref SWF-900001");
  assertEquals(payload.signature, "none");
  assertEquals(payload.capture_thread_ids, true);
  assertEquals((payload as any).job_id, undefined);
  assertEquals(payload.attachments[0].contentType, "image/jpeg");
  assertEquals(payload.attachments[0].contentBytes, jpegBase64());
  assertEquals(real.email.status, "sent");
  assertEquals(real.email.sent.internet_message_id, "<order-2@secureworkswa.test>");
  assertEquals(real.email.sent.conversation_id, "conv-2");
  const row = db.tables.dispatch_supplier_order_emails[0];
  assertEquals(row.sent_graph_message_id, "graph-2");
  assertEquals(row.sent_by_email, "shaun@ops.test");
  assertEquals(row.sent_from_mailbox, "admin@secureworkswa.com.au");
  assertEquals(row.sent_to_emails, ["tradewa@stratcowa.com.au"]);
  // The two ordered lines are locked to the email; In stock and Metroll's are not.
  assertEquals(
    db.tables.job_material_lines.map((l) => [l.id, l.dispatch_order_email_id ?? null]),
    [[L(1), email.id], [L(2), email.id], [L(3), null], [L(4), null]],
  );
  await refused(
    call(db, "dispatch_v2_move_line", {
      job_id: JOB.fence,
      id: L(1),
      supplier_id: null,
      expected_updated_at: db.tables.job_material_lines[0].updated_at,
    }),
    409,
    "line_locked",
  );
  // Sending again is refused and nothing goes.
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: row.updated_at,
    }, c),
    409,
    "email_not_sendable",
  );
  assertEquals(sent.length, 2);
  // The photo that went is kept.
  await refused(
    call(db, "dispatch_v2_delete_photo", {
      job_id: JOB.fence,
      photo_id: email.photo_ids[0],
    }),
    409,
    "photo_on_email",
  );
  // Metroll's box (a non-main supplier) can still be ordered next.
  const metroll = (await makeEmail(db, JOB.fence, SUP.metroll)).email;
  const second = await call(db, "dispatch_v2_send_email", {
    email_id: metroll.id,
    expected_updated_at: metroll.updated_at,
  }, c);
  assertEquals(second.email.status, "sent");
  assertEquals(sent[2].to, ["orders@metroll.test"]);
  assert(!sent[2].htmlBody.includes("quickset"));
  assertOnlyV2Writes(db);
});

async function testedEmail(db: ReturnType<typeof makeDb>) {
  await fencingJob(db);
  const email = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  await call(db, "dispatch_v2_send_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
    test: true,
  });
  return email;
}

Deno.test("send: changed lines, an empty Date line or a lost approval stop the send before anything goes", async () => {
  const db = makeDb();
  const email = await testedEmail(db);
  const { sent, sender } = fakeSender();
  const c = ctx(sender);
  // A line added to the box after the email was made.
  await addLine(db, JOB.fence, 5, { supplier_id: SUP.stratco, description: "Extra" });
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: email.updated_at,
    }, c),
    409,
    "order_lines_changed",
  );
  await call(db, "dispatch_v2_delete_line", {
    job_id: JOB.fence,
    id: L(5),
    expected_updated_at: db.tables.job_material_lines.find((l) => l.id === L(5))!
      .updated_at,
  });
  // The Date line emptied by an edit.
  const blanked = (await call(db, "dispatch_v2_save_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
    body_text: email.body_text.replace("Date: 4 November 2026", "Date:"),
  })).email;
  const missing = await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: blanked.updated_at,
    }, c),
    409,
    "email_details_missing",
  );
  assertEquals(missing.body.missing, ["date"]);
  // The supplier's approved entry is retired.
  db.tables.dispatch_approved_supplier_emails[0].active = false;
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: blanked.updated_at,
    }, c),
    409,
    "no_approved_email",
  );
  assertEquals(sent.length, 0);
  // No operator email: refused before anything goes.
  db.tables.dispatch_approved_supplier_emails[0].active = true;
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: blanked.updated_at,
    }, ctx(sender, { actor: { userId: null, email: null, orgId: null } })),
    400,
    "operator_email_required",
  );
  assertEquals(sent.length, 0);
});

Deno.test("send: a refused send goes back to held; an unknown one keeps its ids and needs confirm_resend", async () => {
  const db = makeDb();
  const email = await testedEmail(db);
  const refusedSender = fakeSender(() => ({
    kind: "refused",
    reason: "Graph said no",
  }));
  const no = await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: email.updated_at,
    }, ctx(refusedSender.sender)),
    502,
    "send_refused",
  );
  assert(no.message.includes("Graph said no"));
  let row = db.tables.dispatch_supplier_order_emails[0];
  assertEquals([row.status, row.last_error], ["draft", "Graph said no"]);
  assertEquals(db.tables.job_material_lines.filter((l) => l.dispatch_order_email_id).length, 0);

  const lost = fakeSender(() => ({
    kind: "unknown",
    reason: "timeout",
    ids: {
      graph_message_id: "g-lost",
      internet_message_id: "<lost@x>",
      conversation_id: "conv-lost",
    },
  }));
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: row.updated_at,
    }, ctx(lost.sender)),
    502,
    "send_unknown",
  );
  row = db.tables.dispatch_supplier_order_emails[0];
  assertEquals(row.status, "send_unknown");
  assertEquals(row.sent_conversation_id, "conv-lost");
  assertEquals(row.sent_internet_message_id, "<lost@x>");
  // Without confirm_resend nothing goes.
  const ok = fakeSender();
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: row.updated_at,
    }, ctx(ok.sender)),
    409,
    "send_unknown",
  );
  assertEquals(ok.sent.length, 0);
  // Cannot be discarded while it may have gone.
  await refused(
    call(db, "dispatch_v2_discard_email", {
      email_id: email.id,
      expected_updated_at: row.updated_at,
    }),
    409,
    "email_not_discardable",
  );
  const resent = await call(db, "dispatch_v2_send_email", {
    email_id: email.id,
    expected_updated_at: row.updated_at,
    confirm_resend: true,
  }, ctx(ok.sender));
  assertEquals(resent.email.status, "sent");
  assertEquals(ok.sent.length, 1);
  assertEquals(resent.email.sent.conversation_id, "conv-1");
});

Deno.test("send: a send claimed long ago with no answer reads as unknown", () => {
  const view = projectDispatchV2Email({
    id: "e",
    status: "sending",
    send_claimed_at: "2026-10-23T01:00:00Z",
    body_text: "x",
    built_body_text: "x",
  }, Date.parse("2026-10-23T01:05:00Z"));
  assertEquals(view.status, "send_unknown");
  const fresh = projectDispatchV2Email({
    id: "e",
    status: "sending",
    send_claimed_at: "2026-10-23T01:04:30Z",
    body_text: "x",
    built_body_text: "x",
  }, Date.parse("2026-10-23T01:05:00Z"));
  assertEquals(fresh.status, "sending");
});

// ── The gate ────────────────────────────────────────────────────────────────

Deno.test("gate: the seventeen actions are staff only and on no allow-list", () => {
  assertEquals(DISPATCH_V2_ACTIONS.length, 17);
  assertEquals(DISPATCH_V2_READ_ACTIONS.length, 3);
  assertEquals(DISPATCH_V2_WRITE_ACTIONS.length, 14);
  for (const action of DISPATCH_V2_ACTIONS) {
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
      ], `${action} ${authUser.role}`);
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

Deno.test("gate: the routine key is refused on all seventeen before any call; a write by GET is 405", async () => {
  await withEnvAndFetchSpy(async (calls) => {
    for (const action of DISPATCH_V2_ACTIONS) {
      const isRead = (DISPATCH_V2_READ_ACTIONS as readonly string[]).includes(
        action,
      );
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
    for (const action of DISPATCH_V2_WRITE_ACTIONS) {
      const res = await _opsApiRequestHandlerForTest(
        new Request(`https://example.invalid/ops-api?action=${action}`, {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SERVICE_KEY}`,
          },
        }),
      );
      assertEquals(res.status, 405, action);
      await res.body?.cancel();
    }
    // The privileged key reaches the action; a bad id is a 400 before any read.
    const bad = await _opsApiRequestHandlerForTest(
      new Request(
        "https://example.invalid/ops-api?action=dispatch_v2_send_email",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify({ email_id: "nope", operator_email: "shaun@ops.test" }),
        },
      ),
    );
    assertEquals(bad.status, 400);
    await bad.body?.cancel();
    assertEquals(calls, []);
  });
});
