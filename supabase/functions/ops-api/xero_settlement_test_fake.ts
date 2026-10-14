// In-memory PostgREST stand-in for the settlement evidence tests.
type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };

export function settlementFakeClient(
  tables: Record<string, Row[]>,
  faults: { select?: Set<string>; upsert?: Set<string> } = {},
) {
  const conflictKeys: Record<string, string[]> = {
    xero_sync_state: ["key"],
    xero_settlement_evidence: [
      "org_id",
      "tenant_id",
      "record_type",
      "provider_id",
    ],
  };
  const upserts: { table: string; rows: Row[] }[] = [];
  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let orderBy: string | null = null;
    let window: [number, number] | null = null;
    const fault = (kind: "select" | "upsert") =>
      faults[kind]?.has(table) ? { message: `${table} ${kind} failed` } : null;
    const rows = () => {
      let out = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const k = orderBy;
        out = [...out].sort((a, b) => String(a[k]).localeCompare(String(b[k])));
      }
      if (window) out = out.slice(window[0], window[1] + 1);
      return out.map((r) => structuredClone(r));
    };
    const builder = {
      select: () => builder,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), builder),
      in: (
        k: string,
        vs: unknown[],
      ) => (filters.push((r) => vs.includes(r[k])), builder),
      order: (k: string) => ((orderBy = k), builder),
      range: (a: number, b: number) => ((window = [a, b]), builder),
      maybeSingle: (): Promise<Result> => {
        const error = fault("select");
        return Promise.resolve(
          error
            ? { data: null, error }
            : { data: rows()[0] ?? null, error: null },
        );
      },
      then: (
        resolve: (r: Result) => unknown,
        reject?: (e: unknown) => unknown,
      ) => {
        const error = fault("select");
        return Promise.resolve(
          error ? { data: null, error } : { data: rows(), error: null },
        )
          .then(resolve, reject);
      },
      upsert: (input: Row | Row[]): Promise<Result> => {
        const error = fault("upsert");
        if (error) return Promise.resolve({ data: null, error });
        const list = Array.isArray(input) ? input : [input];
        upserts.push({ table, rows: list });
        const keys = conflictKeys[table];
        const store = (tables[table] ??= []);
        for (const row of list) {
          const at = store.findIndex((r) => keys.every((k) => r[k] === row[k]));
          if (at >= 0) store[at] = { ...store[at], ...row };
          else store.push({ ...row });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return builder;
  }
  // deno-lint-ignore no-explicit-any
  return { client: { from } as any, upserts };
}
