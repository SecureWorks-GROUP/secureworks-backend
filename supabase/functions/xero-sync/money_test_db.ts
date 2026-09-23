// Test-only in-memory stand-in for the PostgREST client the money slice's
// xero-sync code uses (money MN1 tests). Tables are arrays of plain rows; the
// query builder applies the filters those modules call (eq, in, is, not,
// ilike, gt, lt, order, range, limit, maybeSingle), upsert merges on the
// conflict columns, and rpc serves automation_lane_enabled and a
// record_capture_run with the one writer's validation rules (F1, F1b).
// No network, no database.

// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>;

export interface FakeDbOptions {
  tables?: Record<string, Row[]>;
  captureLane?: boolean;
  // Makes the named table's reads or writes return an error.
  failRead?: Set<string>;
  failWrite?: Set<string>;
}

export interface CaptureRunRecord {
  id: string;
  source: string;
  status: string;
  counts: Record<string, number>;
  cursor: unknown;
  error_code: string | null;
  window_to: string | null;
  calls: Row[];
}

// jsonb::text writes a space after every ":" and ","; JSON.stringify does not.
export function jsonbTextBytes(v: unknown): number {
  const s = JSON.stringify(v);
  let extra = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== "\\") inString = !inString;
    if (!inString && (c === ":" || c === ",")) extra++;
  }
  return new TextEncoder().encode(s).length + extra;
}

export function fakeDb(options: FakeDbOptions = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(options.tables ?? {})) {
    tables[k] = v.map((r) => ({ ...r }));
  }
  const runs = new Map<string, CaptureRunRecord>();
  const log: Array<{ op: string; table: string; value?: unknown }> = [];
  let runSeq = 0;

  const table = (name: string) => (tables[name] ??= []);

  function query(name: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "upsert" | "insert" = "select";
    let payload: any = null;
    let conflict: string[] = [];
    let returning = false;
    let orderBy: { field: string; asc: boolean } | null = null;
    let from = 0;
    let to: number | null = null;
    let single = false;

    const matches = (r: Row) => filters.every((f) => f(r));
    const b: any = {
      select(_cols?: string) {
        if (op !== "select") returning = true;
        return b;
      },
      eq(f: string, v: unknown) {
        filters.push((r) => r[f] === v);
        return b;
      },
      in(f: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[f]));
        return b;
      },
      is(f: string, v: null) {
        filters.push((r) => (r[f] ?? null) === v);
        return b;
      },
      not(f: string, kind: string, v: unknown) {
        if (kind === "is") filters.push((r) => (r[f] ?? null) !== v);
        else if (kind === "eq") filters.push((r) => r[f] !== v);
        else if (kind === "in") {
          const list = String(v).replace(/[()"]/g, "").split(",");
          filters.push((r) => !list.includes(r[f]));
        } else throw new Error(`fake not(${kind})`);
        return b;
      },
      ilike(f: string, pattern: string) {
        const re = new RegExp(
          "^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(
            /%/g,
            ".*",
          ) + "$",
          "i",
        );
        filters.push((r) => typeof r[f] === "string" && re.test(r[f]));
        return b;
      },
      gt(f: string, v: any) {
        filters.push((r) => r[f] > v);
        return b;
      },
      lt(f: string, v: any) {
        filters.push((r) => r[f] < v);
        return b;
      },
      order(f: string, o?: { ascending?: boolean }) {
        orderBy = { field: f, asc: o?.ascending !== false };
        return b;
      },
      range(a: number, z: number) {
        from = a;
        to = z;
        return b;
      },
      limit(n: number) {
        to = from + n - 1;
        return b;
      },
      maybeSingle() {
        single = true;
        return b;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return b;
      },
      upsert(p: Row, o?: { onConflict?: string }) {
        op = "upsert";
        payload = p;
        conflict = (o?.onConflict ?? "id").split(",").map((s) => s.trim());
        return b;
      },
      insert(p: Row | Row[]) {
        op = "insert";
        payload = p;
        return b;
      },
      then(resolve: (v: { data: any; error: any }) => void, reject?: any) {
        try {
          resolve(run());
        } catch (e) {
          if (reject) reject(e);
          else throw e;
        }
      },
    };

    function run(): { data: any; error: any } {
      const rows = table(name);
      if (op === "select") {
        if (options.failRead?.has(name)) {
          return { data: null, error: { message: `read ${name} failed` } };
        }
        log.push({ op, table: name });
        let out = rows.filter(matches);
        if (orderBy) {
          const { field, asc } = orderBy;
          out = [...out].sort((x, y) =>
            (x[field] < y[field] ? -1 : x[field] > y[field] ? 1 : 0) *
            (asc ? 1 : -1)
          );
        }
        out = out.slice(from, to === null ? undefined : to + 1).map((r) => ({
          ...r,
        }));
        return { data: single ? (out[0] ?? null) : out, error: null };
      }
      if (options.failWrite?.has(name)) {
        return { data: null, error: { message: `write ${name} failed` } };
      }
      log.push({ op, table: name, value: payload });
      if (op === "update") {
        const hit = rows.filter(matches);
        for (const r of hit) Object.assign(r, payload);
        return {
          data: returning ? hit.map((r) => ({ ...r })) : null,
          error: null,
        };
      }
      if (op === "insert") {
        for (const r of Array.isArray(payload) ? payload : [payload]) {
          rows.push({ ...r });
        }
        return { data: null, error: null };
      }
      // upsert
      const existing = rows.find((r) =>
        conflict.every((k) => r[k] === payload[k])
      );
      if (existing) Object.assign(existing, payload);
      else rows.push({ ...payload });
      return { data: null, error: null };
    }
    return b;
  }

  function recordCaptureRun(p: Row): { data: any; error: any } {
    const allowed = [
      "run_id",
      "source",
      "status",
      "window_from",
      "window_to",
      "window_end_id",
      "watermark",
      "cursor",
      "counts",
      "error_code",
    ];
    const fail = (code: string) => ({ data: null, error: { message: code } });
    if (!p || Object.keys(p).some((k) => !allowed.includes(k))) {
      return fail("capture_run_invalid");
    }
    if (!/^[a-z][a-z0-9_]{2,62}$/.test(String(p.source ?? ""))) {
      return fail("capture_run_source_invalid");
    }
    if (
      "status" in p &&
      !["running", "succeeded", "partial", "failed"].includes(p.status)
    ) return fail("capture_run_status_invalid");
    if ("counts" in p) {
      const c = p.counts;
      if (
        !c || typeof c !== "object" || Object.keys(c).length > 40 ||
        Object.entries(c).some(([k, v]) =>
          !/^[a-z][a-z0-9_]{0,62}$/.test(k) || typeof v !== "number" ||
          v < 0 || !Number.isInteger(v) || v > 2147483647
        )
      ) return fail("capture_run_counts_invalid");
    }
    if (
      "cursor" in p && p.cursor !== null &&
      jsonbTextBytes(p.cursor) > 4096
    ) return fail("capture_run_invalid");
    if (
      "error_code" in p && p.error_code !== null &&
      !/^[a-z0-9][a-z0-9_.:-]{0,119}$/.test(p.error_code)
    ) return fail("capture_run_error_code_invalid");
    const status = p.status ?? "running";
    if (status === "failed" && !p.error_code) {
      return fail("capture_run_error_code_required");
    }
    let run = p.run_id ? runs.get(p.run_id) : undefined;
    if (p.run_id && !run) return fail("capture_run_invalid");
    if (run && run.status !== "running") return fail("capture_run_finished");
    if (!run) {
      run = {
        id: `run-${++runSeq}`,
        source: p.source,
        status: "running",
        counts: {},
        cursor: null,
        error_code: null,
        window_to: null,
        calls: [],
      };
      runs.set(run.id, run);
    }
    if (run.source !== p.source) return fail("capture_run_source_mismatch");
    run.status = status;
    if ("counts" in p) run.counts = { ...p.counts };
    if ("cursor" in p) run.cursor = p.cursor;
    if ("error_code" in p) run.error_code = p.error_code;
    if ("window_to" in p) run.window_to = p.window_to;
    run.calls.push(structuredClone(p));
    return { data: { run_id: run.id, outcome: "created" }, error: null };
  }

  const client = {
    from: (name: string) => query(name),
    rpc(name: string, args: Row) {
      if (name === "automation_lane_enabled") {
        return Promise.resolve({
          data: options.captureLane ?? true,
          error: null,
        });
      }
      if (name === "record_capture_run") {
        return Promise.resolve(recordCaptureRun(args.p_run));
      }
      return Promise.resolve({
        data: null,
        error: { message: `fake rpc ${name}` },
      });
    },
  };
  return { client, tables, runs, log, table };
}
