// deno-lint-ignore-file no-explicit-any
// In-memory PostgREST and storage for Dispatch tests. Nothing here opens a
// socket or a database. purchase_orders updates bump updated_at the way
// trg_po_updated does, so an optimistic lock on the previous stamp misses.
// job_dispatch_state refuses a second row for the same job (23505).

export type DispatchMemoryRow = Record<string, any>;

type OrPart = { op: string; column: string; value: unknown };
type Filter = [string, string, unknown];

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
    "council_required",
  ],
  users: ["id", "org_id", "name", "email"],
  suppliers: ["id", "org_id", "name", "email"],
  purchase_orders: [
    "id",
    "org_id",
    "job_id",
    "po_number",
    "supplier_name",
    "supplier_id",
    "source",
    "status",
    "po_type",
    "line_items",
    "reference",
    "xero_po_id",
    "created_at",
    "updated_at",
    "pdf_path",
    "pdf_sha256",
    "pdf_version",
    "last_sent_pdf_version",
    "last_sent_at",
    "delivery_date",
    "delivery_confirmed_at",
    "confirmed_delivery_date",
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
    "created_at",
    "updated_at",
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
    "delivery_status",
    "created_by",
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
  job_events: ["id", "job_id", "user_id", "event_type", "detail_json", "created_at"],
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
    "position",
  ],
  job_assignments: [
    "id",
    "job_id",
    "user_id",
    "scheduled_date",
    "scheduled_end",
    "assignment_type",
    "status",
    "is_ghost",
    "role",
    "is_lead",
    "confirmation_status",
  ],
  job_dispatch_state: [
    "job_id",
    "org_id",
    "stage",
    "stage_set_at",
    "stage_set_by",
    "stage_set_by_email",
    "next_step",
    "next_step_set_at",
    "install_confirmed_at",
    "install_confirmed_by",
    "install_confirmed_by_email",
    "install_confirmed_for_day",
    "updated_at",
    "created_at",
  ],
};

function violation(code: string, message: string) {
  return { data: null, error: { code, message } };
}

function columnsOf(select: string): Array<[string, string]> {
  if (!select || select === "*") return [];
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < select.length; i++) {
    const ch = select[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(select.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(select.slice(start));
  return parts.map((raw) => raw.trim()).filter(Boolean).map((item) => {
    const colon = item.indexOf(":");
    return colon >= 0
      ? [item.slice(0, colon), item.slice(colon + 1)]
      : [item, item];
  });
}

function baseColumn(expression: string): string {
  const head = expression.split("->")[0];
  const paren = head.indexOf("(");
  return paren >= 0 ? head.slice(0, paren) : head;
}

function likeMatch(actual: string, pattern: string): boolean {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      if (i < pattern.length) {
        re += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      continue;
    }
    if (ch === "%") {
      re += ".*";
      continue;
    }
    if (ch === "_") {
      re += ".";
      continue;
    }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`, "i").test(actual);
}

function parseOr(input: string): OrPart[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter(Boolean).map((part) => {
    const match = /^([A-Za-z0-9_]+)\.(is|eq|neq|ilike|like)\.(.*)$/.exec(part);
    if (!match) throw new Error(`unparsed or filter: ${part}`);
    let value: unknown = match[3];
    if (match[2] === "is" && value === "null") value = null;
    if (match[2] === "is" && value === "true") value = true;
    if (match[2] === "is" && value === "false") value = false;
    return { op: match[2], column: match[1], value };
  });
}

export function makeDispatchMemory(
  seed: Record<string, DispatchMemoryRow[]> = {},
) {
  const tables: Record<string, DispatchMemoryRow[]> = {};
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((row) => ({ ...row }));
  }
  const files = new Map<string, Uint8Array>();
  const failures = new Set<string>();
  const once: Array<{ kind: string; table: string; error: { code: string; message: string } }> = [];
  const hooks: Array<{ kind: string; table: string; fn: () => void }> = [];
  let clock = Date.parse("2026-10-18T03:00:00.000Z");
  const tick = () => new Date(clock += 1000).toISOString();

  function valueOf(row: DispatchMemoryRow, expression: string): unknown {
    const text = /^(\w+)->>(\w+)$/.exec(expression);
    if (text) {
      const value = row[text[1]]?.[text[2]];
      return value === undefined || value === null ? null : String(value);
    }
    const embed = /^(\w+)\(([^)]*)\)$/.exec(expression);
    if (embed) {
      const id = row[embed[1]];
      if (id == null) return null;
      const user = (tables.users || []).find((item) =>
        String(item.id) === String(id)
      );
      if (!user) return null;
      const out: DispatchMemoryRow = {};
      for (const field of embed[2].split(",").map((item) => item.trim()).filter(Boolean)) {
        out[field] = user[field] ?? null;
      }
      return out;
    }
    return row[expression];
  }

  function unknownColumn(table: string, names: string[]) {
    const known = SCHEMA[table];
    if (!known) return null;
    const bad = names.find((name) => !known.includes(baseColumn(name)));
    return bad
      ? violation("42703", `column ${table}.${bad} does not exist`)
      : null;
  }

  function project(row: DispatchMemoryRow, select: string): DispatchMemoryRow {
    if (!select || select === "*") return { ...row };
    const out: DispatchMemoryRow = {};
    for (const [alias, expression] of columnsOf(select)) {
      const value = valueOf(row, expression);
      out[alias] = value === undefined ? null : value;
    }
    return out;
  }

  function checkRow(
    table: string,
    row: DispatchMemoryRow,
    all: DispatchMemoryRow[],
  ) {
    if (table === "job_dispatch_state") {
      if (all.some((other) => other !== row && other.job_id === row.job_id)) {
        return violation("23505", "job_dispatch_state_pkey");
      }
      const at = row.install_confirmed_at ?? null;
      const email = row.install_confirmed_by_email ?? null;
      if ((at === null) !== (email === null)) {
        return violation("23514", "job_dispatch_state_install_confirmed_named");
      }
      if (
        at === null &&
        (row.install_confirmed_by != null ||
          row.install_confirmed_for_day != null)
      ) {
        return violation("23514", "job_dispatch_state_install_confirmed_dated");
      }
    }
    if (table === "purchase_orders") {
      const at = row.delivery_sighted_at ?? null;
      const email = row.delivery_sighted_by_email ?? null;
      if ((at === null) !== (email === null)) {
        return violation("23514", "purchase_orders_delivery_sighted_named");
      }
    }
    return null;
  }

  function matchOne(
    row: DispatchMemoryRow,
    op: string,
    column: string,
    value: unknown,
  ): boolean {
    if (op === "or") {
      return (value as OrPart[]).some((part) =>
        matchOne(row, part.op, part.column, part.value)
      );
    }
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
      return (value as unknown[]).map(String).includes(
        actual === undefined || actual === null ? "" : String(actual),
      );
    }
    if (op === "is") return (actual ?? null) === value;
    if (op === "ilike") {
      return actual !== null && actual !== undefined &&
        likeMatch(String(actual), String(value));
    }
    return false;
  }

  function from(table: string) {
    const filters: Filter[] = [];
    const orders: Array<[string, boolean]> = [];
    let kind = "select";
    let select = "";
    let returning: string | null = null;
    let payload: any = null;
    let limit: number | null = null;
    let single: "single" | "maybe" | null = null;

    const execute = () => {
      for (const hook of hooks) {
        if (hook.kind === kind && hook.table === table) hook.fn();
      }
      const forced = once.findIndex((item) =>
        item.kind === kind && item.table === table
      );
      if (forced >= 0) {
        const error = once.splice(forced, 1)[0].error;
        return { data: null, error };
      }
      if (failures.has(`${kind}:${table}`)) {
        return violation("XX000", `forced failure on ${kind} ${table}`);
      }
      const rows = tables[table] ||= [];
      const named = [
        ...columnsOf(kind === "select" ? select : (returning || "")).map(([, expression]) => expression),
        ...filters.flatMap(([, column, value]) =>
          column === ""
            ? (value as OrPart[]).map((part) => part.column)
            : [column]
        ),
        ...orders.map(([column]) => column),
      ];
      const bad = unknownColumn(table, named);
      if (bad) return bad;

      const matched = () => rows.filter((row) =>
        filters.every(([op, column, value]) => matchOne(row, op, column, value))
      );

      const finish = (found: DispatchMemoryRow[]) => {
        if (single === "single") {
          return found.length === 1
            ? { data: found[0], error: null }
            : violation("PGRST116", "not one row");
        }
        if (single === "maybe") {
          return found.length > 1
            ? violation("PGRST116", "many rows")
            : { data: found[0] ?? null, error: null };
        }
        if (kind !== "select" && returning === null) {
          return { data: null, error: null };
        }
        return { data: found, error: null };
      };

      if (kind === "select") {
        let found = matched();
        found.sort((a, b) => {
          for (const [column, ascending] of orders) {
            const left = a[column];
            const right = b[column];
            if (left === right) continue;
            if (left == null) return ascending ? -1 : 1;
            if (right == null) return ascending ? 1 : -1;
            return (left < right ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        });
        if (limit !== null) found = found.slice(0, limit);
        return finish(found.map((row) => project(row, select)));
      }

      if (kind === "insert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map((
          row: DispatchMemoryRow,
        ) => ({ ...row }));
        const badWrite = unknownColumn(
          table,
          incoming.flatMap((row) => Object.keys(row)),
        );
        if (badWrite) return badWrite;
        for (const row of incoming) {
          if (SCHEMA[table]?.includes("id") && row.id == null) {
            row.id = crypto.randomUUID();
          }
          const failure = checkRow(table, row, [...rows, ...incoming]);
          if (failure) return failure;
        }
        rows.push(...incoming);
        return finish(incoming.map((row) => project(row, returning || "*")));
      }

      if (kind === "update") {
        const badWrite = unknownColumn(table, Object.keys(payload || {}));
        if (badWrite) return badWrite;
        const targets = matched();
        const next = targets.map((row) => {
          const updated = { ...row, ...payload };
          if (table === "purchase_orders") updated.updated_at = tick();
          return updated;
        });
        for (const row of next) {
          const others = rows.filter((item) => !targets.includes(item));
          const failure = checkRow(table, row, [...others, row]);
          if (failure) return failure;
        }
        targets.forEach((row, index) => Object.assign(row, next[index]));
        return finish(targets.map((row) => project(row, returning || "*")));
      }

      return violation("XX000", `unsupported ${kind}`);
    };

    const builder: any = {
      select(columns: string) {
        if (kind === "select") select = columns;
        else returning = columns;
        return builder;
      },
      insert(value: any) {
        kind = "insert";
        payload = value;
        return builder;
      },
      update(value: any) {
        kind = "update";
        payload = value;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push(["eq", column, value]);
        return builder;
      },
      neq(column: string, value: unknown) {
        filters.push(["neq", column, value]);
        return builder;
      },
      in(column: string, value: unknown[]) {
        filters.push(["in", column, value]);
        return builder;
      },
      is(column: string, value: unknown) {
        filters.push(["is", column, value]);
        return builder;
      },
      ilike(column: string, value: string) {
        filters.push(["ilike", column, value]);
        return builder;
      },
      or(input: string) {
        filters.push(["or", "", parseOr(input)]);
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        orders.push([column, options?.ascending !== false]);
        return builder;
      },
      limit(count: number) {
        limit = count;
        return builder;
      },
      single() {
        single = "single";
        return builder;
      },
      maybeSingle() {
        single = "maybe";
        return builder;
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    from,
    storage: {
      from(bucket: string) {
        return {
          download(path: string) {
            const bytes = files.get(`${bucket}/${path}`);
            if (!bytes) {
              return {
                data: null,
                error: { message: "Object not found" },
              };
            }
            const copy = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(copy).set(bytes);
            return { data: new Blob([copy]), error: null };
          },
        };
      },
    },
    rows(table: string): DispatchMemoryRow[] {
      return tables[table] ||= [];
    },
    putFile(bucket: string, path: string, bytes: Uint8Array) {
      files.set(`${bucket}/${path}`, bytes);
    },
    fail(kind: string, table: string) {
      failures.add(`${kind}:${table}`);
    },
    failNext(
      kind: string,
      table: string,
      error: { code: string; message: string },
    ) {
      once.push({ kind, table, error });
    },
    before(kind: string, table: string, fn: () => void) {
      hooks.push({ kind, table, fn });
    },
  };
}
