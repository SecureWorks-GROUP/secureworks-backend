/** P1-02.1 and P1-02.2. Private terminal tool; never writes a report or log.
 * Coverage needs read permission only. Preview also needs DATABASE_URL and net
 * permission. Run with deno run --no-lock to keep dependency caching from
 * updating a repository lockfile. Apply is the director's act:
 * --apply --with-switch, after coverage
 * and the exact-head money review. No connection is opened in coverage mode.
 */
export type Query = (
  sql: string,
  params?: readonly unknown[],
) => Promise<Record<string, unknown>[]>;
export interface Database {
  transaction<T>(
    write: boolean,
    body: (query: Query) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}
export interface Dependencies {
  readTextFile(path: string): Promise<string>;
  realPath(path: string): Promise<string>;
  gitEntryExists(path: string): Promise<boolean>;
  connect(): Promise<Database>;
  print(line: string): void;
}
type RateRow = { userId: string; rate: string; row: number };
class Refusal extends Error {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function options(args: string[]) {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (values.has(key) || switches.has(key)) {
      throw new Refusal("Repeated option");
    }
    if (["--coverage", "--apply", "--with-switch"].includes(key)) {
      switches.add(key);
    } else if (["--file", "--ids", "--effective-from"].includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        throw new Refusal("Missing option value");
      }
      values.set(key, value);
    } else throw new Refusal("Unknown option");
  }
  const coverage = switches.has("--coverage");
  const apply = switches.has("--apply");
  if (apply && !switches.has("--with-switch")) {
    throw new Refusal("--apply requires --with-switch");
  }
  if (coverage && (apply || switches.has("--with-switch"))) {
    throw new Refusal("Coverage is read only");
  }
  if (!apply && switches.has("--with-switch")) {
    throw new Refusal("--with-switch requires --apply");
  }
  const file = values.get("--file");
  if (!file) throw new Refusal("--file is required");
  if (coverage) {
    if (!values.has("--ids")) {
      throw new Refusal("--ids is required for coverage");
    }
  } else {
    const day = values.get("--effective-from") ?? "";
    const date = new Date(`${day}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== day || date.getUTCDay() !== 1
    ) {
      throw new Refusal(
        "--effective-from must be a valid Monday in YYYY-MM-DD form",
      );
    }
    if (values.has("--ids")) throw new Refusal("--ids requires --coverage");
  }
  return {
    file,
    coverage,
    apply,
    ids: values.get("--ids"),
    day: values.get("--effective-from")!,
  };
}

async function outsideGit(path: string, deps: Dependencies): Promise<string> {
  const resolved = await deps.realPath(path);
  let parent = resolved.slice(0, resolved.lastIndexOf("/")) || "/";
  while (true) {
    if (await deps.gitEntryExists(`${parent === "/" ? "" : parent}/.git`)) {
      throw new Refusal("Input file must be outside every git work tree");
    }
    if (parent === "/") return resolved;
    parent = parent.slice(0, parent.lastIndexOf("/")) || "/";
  }
}

function parseSheet(text: string, allowDuplicates: boolean): RateRow[] {
  const lines = text.replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
  const fields = (line: string) =>
    line.split(",").map((s) => {
      const value = s.trim();
      return value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value;
    });
  if (fields(lines[0]).join(",") !== "user_id,new_hourly_rate") {
    throw new Refusal("CSV row 1: expected user_id,new_hourly_rate header");
  }
  if (lines.length < 2) throw new Refusal("CSV row 2: a rate row is required");
  const seen = new Set<string>();
  return lines.slice(1).map((line, i) => {
    const row = i + 2;
    const cells = fields(line);
    const userId = (cells[0] ?? "").toLowerCase();
    const rate = cells[1] ?? "";
    if (cells.length !== 2 || !UUID.test(userId)) {
      throw new Refusal(`CSV row ${row}: invalid user_id or column count`);
    }
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(rate) || !Number.isFinite(Number(rate)) ||
      Number(rate) <= 0
    ) {
      throw new Refusal(
        `CSV row ${row}: rate must be positive with at most two decimals`,
      );
    }
    if (!allowDuplicates && seen.has(userId)) {
      throw new Refusal(`CSV row ${row}: duplicate user_id`);
    }
    seen.add(userId);
    return { userId, rate, row };
  });
}

function coverageCounts(rows: RateRow[], text: string): [string, number][] {
  const active = new Set<string>();
  for (const [i, line] of text.trim().split(/\r?\n/).entries()) {
    if (!text.trim()) break;
    const id = line.trim().toLowerCase();
    if (!UUID.test(id)) {
      throw new Refusal(`Active list row ${i + 1}: invalid user_id`);
    }
    active.add(id);
  }
  const frequency = new Map<string, number>();
  for (const row of rows) {
    frequency.set(row.userId, (frequency.get(row.userId) ?? 0) + 1);
  }
  return [
    ["on both lists", [...active].filter((id) => frequency.has(id)).length],
    [
      "on the sheet twice",
      [...frequency.values()].filter((count) => count > 1).length,
    ],
    [
      "active but not on the sheet",
      [...active].filter((id) => !frequency.has(id)).length,
    ],
    [
      "on the sheet but not active",
      [...frequency.keys()].filter((id) => !active.has(id)).length,
    ],
  ];
}

export async function runChangeover(
  args: string[],
  deps: Dependencies = defaults,
): Promise<number> {
  let db: Database | undefined;
  try {
    const opts = options(args);
    const file = await outsideGit(opts.file, deps);
    const rows = parseSheet(await deps.readTextFile(file), opts.coverage);
    if (opts.coverage) {
      const idsPath = await outsideGit(opts.ids!, deps);
      const counts = coverageCounts(rows, await deps.readTextFile(idsPath));
      for (const [label, count] of counts) deps.print(`${label} ${count}`);
      return counts[1][1] > 0 || counts[2][1] > 0 ? 1 : 0;
    }
    db = await deps.connect();
    await db.transaction(opts.apply, async (query) => {
      const users = await query(
        "SELECT id::text AS user_id, org_id::text FROM public.users WHERE id = ANY($1::uuid[])",
        [rows.map((row) => row.userId)],
      );
      const orgs = new Map(
        users.map((user) => [String(user.user_id), String(user.org_id ?? "")]),
      );
      for (const row of rows) {
        if (!UUID.test(orgs.get(row.userId) ?? "")) {
          throw new Refusal(
            `CSV row ${row.row}: user or organisation not found`,
          );
        }
      }
      const existing = await query(
        "SELECT user_id::text, org_id::text FROM public.trade_rates WHERE effective_from = $1::date AND user_id = ANY($2::uuid[])",
        [opts.day, rows.map((row) => row.userId)],
      );
      const conflicts = new Set(
        existing.filter((row) => orgs.get(String(row.user_id)) === row.org_id)
          .map((row) => String(row.user_id)),
      );
      for (const row of rows) {
        deps.print(`${row.userId}, ${opts.day}, ${row.rate}`);
      }
      deps.print(`insert ${rows.length - conflicts.size}`);
      deps.print(`already present ${conflicts.size}`);
      for (const id of conflicts) deps.print(`already present: ${id}`);
      if (conflicts.size) {
        throw new Refusal(
          "Existing rate rows for this date: stopped without writes",
        );
      }
      if (!opts.apply) return;
      for (const row of rows) {
        await query(
          "INSERT INTO public.trade_rates (org_id, user_id, hourly_rate, effective_from) VALUES ($1::uuid, $2::uuid, $3::numeric, $4::date)",
          [orgs.get(row.userId), row.userId, row.rate, opts.day],
        );
      }
      const settings = await query(
        "UPDATE public.trade_pay_settings SET inclusive_super_from = $1::date, updated_at = now(), updated_by = 'trade-rate-changeover' WHERE id = 1 RETURNING id",
        [opts.day],
      );
      if (settings.length !== 1) {
        throw new Refusal("Pay settings row missing: changeover rolled back");
      }
      const flag = await query(
        "UPDATE public.feature_flags SET enabled = true WHERE flag_name = $1 RETURNING flag_name",
        ["trade_pay_inclusive_super_v1"],
      );
      if (flag.length !== 1) {
        throw new Refusal("Pay switch row missing: changeover rolled back");
      }
    });
    if (opts.apply) {
      deps.print(`inserted ${rows.length}`);
      deps.print(`start date ${opts.day}`);
      deps.print("switch on");
    }
    return 0;
  } catch (error) {
    // Database errors can contain the input values. Never print their details.
    deps.print(
      error instanceof Refusal
        ? error.message
        : "Unable to complete changeover; no successful transaction confirmed",
    );
    return 1;
  } finally {
    await db?.close().catch(() => {});
  }
}

const defaults: Dependencies = {
  readTextFile: (path) => Deno.readTextFile(path),
  realPath: (path) => Deno.realPath(path),
  gitEntryExists: async (path) => {
    try {
      await Deno.lstat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  },
  print: (line) => console.log(line),
  connect: async () => {
    const url = Deno.env.get("DATABASE_URL");
    if (!url) {
      throw new Refusal("DATABASE_URL is required for preview or apply");
    }
    const driverModule = "npm:postgres@3.4.5";
    const { default: postgres } = await import(driverModule);
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    return {
      transaction<T>(
        write: boolean,
        body: (query: Query) => Promise<T>,
      ): Promise<T> {
        return sql.begin(write ? "read write" : "read only", async (tx: {
          unsafe(
            statement: string,
            params: unknown[],
          ): Promise<Record<string, unknown>[]>;
        }) => {
          const query: Query = (statement, params = []) =>
            tx.unsafe(statement, [...params]);
          return await body(query);
        }) as Promise<T>;
      },
      close: async () => {
        await sql.end();
      },
    };
  },
};

if (import.meta.main) Deno.exit(await runChangeover(Deno.args));
