// In-memory PostgREST stand-in for the trade invoice money control tests.
// It supports the query shapes those modules use and nothing more: filters
// are applied on read, update and delete; an insert can be refused by a hook.
type Row = Record<string, any>;
type Filter = (row: Row) => boolean;

export interface FakeError {
  message: string;
  code?: string;
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  writes: { table: string; kind: string; row: Row }[] = [];
  /** Return an error for a table read or write to simulate an outage. */
  failOn: (table: string, kind: string) => FakeError | null = () => null;
  /** Runs before an update lands, to simulate a concurrent change. */
  beforeUpdate: (table: string) => void = () => {};
  /** Refuse an insert, as a database trigger would. */
  insertGuard: (table: string, row: Row) => FakeError | null = () => null;
  private seq = 0;

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table] = rows.map((row) => ({ ...row }));
    }
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  client(): any {
    return { from: (table: string) => this.query(table) };
  }

  private query(table: string) {
    const db = this;
    const filters: Filter[] = [];
    let mode: "select" | "update" | "insert" | "delete" | "upsert" = "select";
    let conflictKey = "id";
    let patch: Row | null = null;
    let inserts: Row[] = [];
    let limit: number | null = null;
    let order: { key: string; ascending: boolean } | null = null;
    let single: "maybe" | "one" | null = null;
    let headCount = false;
    const q: any = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) headCount = true;
        return q;
      },
      eq: (key: string, value: unknown) => {
        filters.push((r) =>
          typeof value === "string" && r[key] && typeof r[key] === "object"
            ? JSON.stringify(r[key]) === value
            : r[key] === value
        );
        return q;
      },
      neq: (key: string, value: unknown) => {
        filters.push((r) => r[key] !== value);
        return q;
      },
      is: (key: string, value: unknown) => {
        filters.push((r) => (r[key] ?? null) === value);
        return q;
      },
      in: (key: string, values: unknown[]) => {
        filters.push((r) => values.includes(r[key]));
        return q;
      },
      not: (key: string, op: string, value: unknown) => {
        if (op === "is" && value === null) filters.push((r) => r[key] != null);
        else if (op === "in") {
          const list = String(value).replace(/[()]/g, "").split(",");
          filters.push((r) => !list.includes(String(r[key])));
        } else filters.push((r) => r[key] !== value);
        return q;
      },
      like: (key: string, pattern: string) => {
        const prefix = pattern.replace(/%$/, "");
        filters.push((r) => String(r[key] ?? "").startsWith(prefix));
        return q;
      },
      order: (key: string, opts?: { ascending?: boolean }) => {
        order = { key, ascending: opts?.ascending !== false };
        return q;
      },
      limit: (n: number) => {
        limit = n;
        return q;
      },
      update: (value: Row) => {
        mode = "update";
        patch = value;
        return q;
      },
      insert: (value: Row | Row[]) => {
        mode = "insert";
        inserts = Array.isArray(value) ? value : [value];
        return q;
      },
      upsert: (value: Row | Row[], opts?: { onConflict?: string }) => {
        mode = "upsert";
        inserts = Array.isArray(value) ? value : [value];
        conflictKey = opts?.onConflict ?? "id";
        return q;
      },
      delete: () => {
        mode = "delete";
        return q;
      },
      maybeSingle: () => {
        single = "maybe";
        return q;
      },
      single: () => {
        single = "one";
        return q;
      },
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve().then(() => run()).then(resolve, reject),
    };
    const run = () => {
      const failure = db.failOn(table, mode);
      if (failure) return { data: null, error: failure, count: null };
      const rows = db.rows(table);
      if (mode === "insert") {
        const created: Row[] = [];
        for (const raw of inserts) {
          const row = { id: raw.id ?? `${table}-${++db.seq}`, ...raw };
          const refused = db.insertGuard(table, row);
          if (refused) return { data: null, error: refused, count: null };
          created.push(row);
        }
        for (const row of created) {
          rows.push(row);
          db.writes.push({ table, kind: "insert", row });
        }
        return shape(created);
      }
      if (mode === "upsert") {
        const out: Row[] = [];
        for (const raw of inserts) {
          const existing = rows.find((r) => r[conflictKey] === raw[conflictKey]);
          if (existing) Object.assign(existing, raw);
          else rows.push({ ...raw });
          const row = existing ?? rows[rows.length - 1];
          db.writes.push({ table, kind: "upsert", row: { ...row } });
          out.push(row);
        }
        return shape(out);
      }
      let matched = rows.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        db.beforeUpdate(table);
        matched = rows.filter((r) => filters.every((f) => f(r)));
        for (const row of matched) {
          Object.assign(row, patch);
          db.writes.push({ table, kind: "update", row: { ...row } });
        }
        return shape(matched);
      }
      if (mode === "delete") {
        db.tables[table] = rows.filter((r) => !matched.includes(r));
        for (const row of matched) db.writes.push({ table, kind: "delete", row });
        return shape(matched);
      }
      if (order) {
        const { key, ascending } = order;
        matched = [...matched].sort((a, b) =>
          (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (ascending ? 1 : -1)
        );
      }
      if (limit != null) matched = matched.slice(0, limit);
      if (headCount) return { data: null, error: null, count: matched.length };
      return shape(matched);
    };
    const shape = (list: Row[]) => {
      const copy = list.map((r) => ({ ...r }));
      if (single === "maybe") {
        return { data: copy[0] ?? null, error: null, count: copy.length };
      }
      if (single === "one") {
        return copy.length === 1
          ? { data: copy[0], error: null, count: 1 }
          : { data: null, error: { message: "not exactly one row" }, count: copy.length };
      }
      return { data: copy, error: null, count: copy.length };
    };
    return q;
  }
}
