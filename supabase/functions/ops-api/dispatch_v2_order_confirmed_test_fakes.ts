// deno-lint-ignore-file no-explicit-any
// An in-memory stand-in for PostgREST (and, for the documents, Supabase
// Storage) used by dispatch_v2_order_confirmed_test.ts. It keeps the unique
// keys the migrations declare, so a second claim of the same line or the
// same document is refused with 23505 exactly as the database would.
//
// Nothing here reaches the network or production. All data in the tests is
// made up.

export type Row = Record<string, any>;

export type FakeOptions = {
  // Unique keys per table: each is a list of columns that together must be
  // unique (null in any column = no clash, as in Postgres).
  unique?: Record<string, string[][]>;
  // Runs just before an insert lands (a second press in between).
  beforeInsert?: (table: string, row: Row) => void;
  // A table whose reads, inserts, updates or deletes fail.
  fail?: Record<string, Partial<Record<"select" | "insert" | "update" | "delete", any>>>;
  // Storage: objects by "bucket/path", and buckets whose uploads or
  // downloads fail.
  objects?: Map<string, Uint8Array>;
  failUpload?: string[];
  failDownload?: string[];
};

export const FAKE_STORAGE_URL = "https://fake.supabase.test/storage/v1/object/public";

let idCounter = 0;
export function fakeId(): string {
  idCounter++;
  return `f0000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

export function makeFakeClient(
  tables: Record<string, Row[]>,
  options: FakeOptions = {},
) {
  const writes: Array<{ table: string; kind: string; row: Row }> = [];

  function clash(table: string, row: Row, ignore?: Row): boolean {
    for (const key of options.unique?.[table] || []) {
      if (key.some((c) => row[c] === null || row[c] === undefined)) continue;
      const hit = (tables[table] || []).some((other) =>
        other !== ignore && key.every((c) => other[c] === row[c])
      );
      if (hit) return true;
    }
    return false;
  }

  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let patch: Row | null = null;
    let insertRows: Row[] | null = null;
    let rowLimit: number | null = null;
    const orders: Array<[string, boolean]> = [];

    const matching = () =>
      (tables[table] || []).filter((row) => filters.every((f) => f(row)));

    const run = (): { data: any; error: any } => {
      const failure = options.fail?.[table]?.[op];
      if (failure) return { data: null, error: failure };
      if (op === "insert") {
        const out: Row[] = [];
        for (const raw of insertRows || []) {
          const row = { id: raw.id ?? fakeId(), created_at: raw.created_at ?? new Date().toISOString(), ...raw };
          options.beforeInsert?.(table, row);
          if (clash(table, row)) {
            return {
              data: null,
              error: { code: "23505", message: "duplicate key value" },
            };
          }
          (tables[table] ||= []).push(row);
          writes.push({ table, kind: "insert", row: { ...row } });
          out.push({ ...row });
        }
        return { data: out, error: null };
      }
      if (op === "update") {
        const hits = matching();
        for (const row of hits) {
          if (clash(table, { ...row, ...patch }, row)) {
            return {
              data: null,
              error: { code: "23505", message: "duplicate key value" },
            };
          }
        }
        for (const row of hits) {
          Object.assign(row, patch);
          writes.push({ table, kind: "update", row: { ...row } });
        }
        return { data: hits.map((r) => ({ ...r })), error: null };
      }
      if (op === "delete") {
        const hits = matching();
        tables[table] = (tables[table] || []).filter((r) => !hits.includes(r));
        for (const row of hits) writes.push({ table, kind: "delete", row });
        return { data: hits, error: null };
      }
      let rows = matching().map((r) => ({ ...r }));
      rows.sort((a, b) => {
        for (const [column, ascending] of orders) {
          if (a[column] === b[column]) continue;
          if (a[column] == null) return 1;
          if (b[column] == null) return -1;
          const before = a[column] < b[column] ? -1 : 1;
          return ascending ? before : -before;
        }
        return 0;
      });
      if (rowLimit != null) rows = rows.slice(0, rowLimit);
      return { data: rows, error: null };
    };

    const builder: any = {
      select: () => builder,
      insert: (r: Row | Row[]) => (
        op = "insert", insertRows = Array.isArray(r) ? r : [r], builder
      ),
      update: (p: Row) => (op = "update", patch = p, builder),
      delete: () => (op = "delete", builder),
      eq: (c: string, v: unknown) => (
        filters.push((row) => row[c] === v), builder
      ),
      neq: (c: string, v: unknown) => (
        filters.push((row) => row[c] !== v), builder
      ),
      is: (c: string, v: unknown) => (
        filters.push((row) => (row[c] ?? null) === v), builder
      ),
      in: (c: string, v: unknown[]) => (
        filters.push((row) => v.includes(row[c])), builder
      ),
      gte: (c: string, v: any) => (
        filters.push((row) => row[c] != null && row[c] >= v), builder
      ),
      lte: (c: string, v: any) => (
        filters.push((row) => row[c] != null && row[c] <= v), builder
      ),
      order: (column: string, o?: { ascending?: boolean }) => {
        orders.push([column, o?.ascending !== false]);
        return builder;
      },
      limit: (n: number) => (rowLimit = n, builder),
      range: (start: number, end: number) => {
        const r = run();
        return Promise.resolve(
          r.error ? r : { data: r.data.slice(start, end + 1), error: null },
        );
      },
      maybeSingle: () => {
        const r = run();
        return Promise.resolve(
          r.error ? r : { data: r.data[0] ?? null, error: null },
        );
      },
      single: () => {
        const r = run();
        if (r.error) return Promise.resolve(r);
        return Promise.resolve(
          r.data[0]
            ? { data: r.data[0], error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } },
        );
      },
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (r: unknown) => unknown,
      ) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  const objects = options.objects ?? new Map<string, Uint8Array>();
  const uploads: Array<{ bucket: string; path: string; contentType: string }> =
    [];
  const storage = {
    from(bucket: string) {
      return {
        download(path: string) {
          if (options.failDownload?.includes(bucket)) {
            return Promise.resolve({ data: null, error: { message: "down" } });
          }
          const bytes = objects.get(`${bucket}/${path}`);
          return Promise.resolve(
            bytes
              ? { data: new Blob([bytes as BlobPart]), error: null }
              : { data: null, error: { message: "Object not found" } },
          );
        },
        upload(path: string, bytes: Uint8Array, opts: any = {}) {
          if (options.failUpload?.includes(bucket)) {
            return Promise.resolve({ data: null, error: { message: "full" } });
          }
          const key = `${bucket}/${path}`;
          if (objects.has(key) && opts.upsert !== true) {
            return Promise.resolve({ data: null, error: { message: "exists" } });
          }
          objects.set(key, new Uint8Array(bytes));
          uploads.push({ bucket, path, contentType: opts.contentType });
          return Promise.resolve({ data: { path }, error: null });
        },
        getPublicUrl(path: string) {
          return { data: { publicUrl: `${FAKE_STORAGE_URL}/${bucket}/${path}` } };
        },
      };
    },
  };

  return { client: { from, storage } as any, writes, tables, objects, uploads };
}
