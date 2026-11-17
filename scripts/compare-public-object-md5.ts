/**
 * Offline public-schema comparison. This script never connects to a database.
 * Capture each TSV before contracts/rollbacks, with the SQL below. A CI stack
 * uses setup fixtures and only registered migrations; it is not all migrations.
 * Trace JSONL rows describe each setup/migration's actual before/after catalog.
 */
export const catalogSql = `SET TimeZone = 'UTC';
SELECT 'view' AS kind, c.relname::text AS name, md5(pg_get_viewdef(c.oid, true)) AS md5
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v'
UNION ALL
SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', md5(p.prosrc)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND NOT EXISTS (
  SELECT 1 FROM pg_depend d
  WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
)
ORDER BY 1, 2;`;

export type CatalogRow = {
  kind: "view" | "function";
  name: string;
  md5: string;
};
export type Change = Omit<CatalogRow, "md5"> & {
  before: string | null;
  after: string | null;
  source: string;
};
export type Difference = {
  kind: CatalogRow["kind"];
  name: string;
  live: string | null;
  fresh: string | null;
  status: "changed" | "live_only" | "fresh_only";
  lastWriter: string | null;
  liveHashSeenAt: string[];
};
const digest = /^[a-f0-9]{32}$/;
const key = (row: Pick<CatalogRow, "kind" | "name">) =>
  `${row.kind}\t${row.name}`;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function parseCatalog(tsv: string): Map<string, CatalogRow> {
  const rows = new Map<string, CatalogRow>();
  for (const [index, raw] of tsv.split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.startsWith("#")) continue;
    const fields = raw.split("\t");
    const [kind, name, md5] = fields;
    if (
      fields.length !== 3 || (kind !== "view" && kind !== "function") ||
      !name.trim() || !digest.test(md5)
    ) {
      throw new Error(
        `Invalid catalog row ${index + 1}; expected kind, name, lowercase md5`,
      );
    }
    const row: CatalogRow = { kind, name, md5 };
    if (rows.has(key(row))) {
      throw new Error(`Duplicate catalog object: ${key(row)}`);
    }
    rows.set(key(row), row);
  }
  if (!rows.size) {
    throw new Error("Catalog is empty; refusing a misleading comparison");
  }
  return rows;
}

// Closed CI scope. Use the UNION of both catalogs, so a missing, removed or
// newly introduced object is checked just like a changed body. Object names
// here are schema identifiers, never business row values.
export function parityArea(
  name: string,
): "job-profit" | "context" | "pay" | null {
  const object = name.split("(", 1)[0];
  if (
    /^(?:job_profit|job_cost|v_job_(?:profit|cost|revenue|expected|double_charge)|job_financials$|v_makesafe_charge_ledger$|bookkeeping_|v_bookkeeping_|v_xero_lines$|cfo_bill_cost)/
      .test(object)
  ) {
    return "job-profit";
  }
  if (
    /(?:^|_)context(?:_|$)|^luna_|^v_evidence_health(?:_|$)|^v_unresolved_evidence$/
      .test(object) ||
    ["attribute_business_event", "ensure_booking_draft_job"].includes(object)
  ) {
    return "context";
  }
  if (
    /(?:^|_)(?:trade_invoice|job_work_order)/.test(object) ||
    object === "work_orders_job_kind_guard" ||
    /^(?:group_|trade_|v_trade_|v_invoice_line_completeness$|v_group_coverage$|v_patio_group_coverage$|patio_pay|crew_pay)/
      .test(object) ||
    /group|crew|paid_hours/.test(object) &&
      /^(?:office_|work_orders_|job_work_order_|job_client_signoffs_)/.test(
        object,
      ) ||
    /^(?:freeze|unfreeze|amend|project|claim|rekey|remove|restore|revoke|void)_group_/
      .test(object)
  ) {
    return "pay";
  }
  return null;
}

export function scopedCatalog(
  catalog: Map<string, CatalogRow>,
): Map<string, CatalogRow> {
  const selected = new Map(
    [...catalog].filter(([, row]) => parityArea(row.name)),
  );
  // An unrelated or truncated snapshot must not pass with zero comparisons.
  for (const area of ["job-profit", "context", "pay"]) {
    if (![...selected.values()].some((row) => parityArea(row.name) === area)) {
      throw new Error(
        `Catalog has no ${area} objects; refusing incomplete parity input`,
      );
    }
  }
  return selected;
}

export function parseTrace(jsonl: string): Change[] {
  return jsonl.split(/\r?\n/).filter((line) => line.trim()).map(
    (line, index) => {
      const row = JSON.parse(line);
      if (
        !row || (row.kind !== "view" && row.kind !== "function") ||
        typeof row.name !== "string" || !row.name ||
        typeof row.source !== "string" || !row.source ||
        ![row.before, row.after].every((v) =>
          v === null || typeof v === "string" && digest.test(v)
        ) ||
        row.before === row.after
      ) {
        throw new Error(`Invalid catalog trace row ${index + 1}`);
      }
      return row as Change;
    },
  );
}

export function compareCatalogs(
  live: Map<string, CatalogRow>,
  fresh: Map<string, CatalogRow>,
  trace: Change[] = [],
): Difference[] {
  const events = new Map<string, Change[]>();
  for (const change of trace) {
    const list = events.get(key(change)) ?? [];
    // A trace begins at an empty public catalog and must remain continuous.
    if (change.before !== (list.at(-1)?.after ?? null)) {
      throw new Error(
        `Discontinuous trace for ${key(change)} at ${change.source}`,
      );
    }
    list.push(change);
    events.set(key(change), list);
  }
  if (trace.length) {
    for (const id of new Set([...events.keys(), ...fresh.keys()])) {
      if (
        (events.get(id)?.at(-1)?.after ?? null) !== (fresh.get(id)?.md5 ?? null)
      ) {
        throw new Error(
          `Trace does not end at the supplied fresh catalog: ${id}`,
        );
      }
    }
  }
  const differences: Difference[] = [];
  for (
    const id of [...new Set([...live.keys(), ...fresh.keys()])].sort(order)
  ) {
    const before = live.get(id), after = fresh.get(id);
    if (before?.md5 === after?.md5) continue;
    const row = before ?? after!;
    const history = events.get(id) ?? [];
    differences.push({
      kind: row.kind,
      name: row.name,
      live: before?.md5 ?? null,
      fresh: after?.md5 ?? null,
      status: before && after ? "changed" : before ? "live_only" : "fresh_only",
      lastWriter: history.at(-1)?.source ?? null,
      liveHashSeenAt: before
        ? history.filter((event) => event.after === before.md5).map((event) =>
          event.source
        )
        : [],
    });
  }
  return differences;
}

const cell = (value: string | null) =>
  (value ?? "absent").replaceAll("|", "\\|").replaceAll("\n", " ");
export function renderComparison(
  differences: Difference[],
  liveCount: number,
  freshCount: number,
): string {
  const counts = (status: Difference["status"]) =>
    differences.filter((row) => row.status === status).length;
  return [
    "# Public object md5 comparison",
    "",
    `Live snapshot: ${liveCount} objects. Fresh catalog: ${freshCount} objects.`,
    `Differences: ${differences.length}; changed: ${
      counts("changed")
    }; live only: ${counts("live_only")}; fresh only: ${counts("fresh_only")}.`,
    "",
    "The trace proves the last setup/migration step changing each fresh object. A setup is test infrastructure, not a production migration. No trace writer means attribution is unobserved. Live-only objects were not produced, or were removed, by this build. Equal md5s cover only view definitions/function bodies, not grants, settings or full schema equivalence. PostgreSQL version and view-deparser search_path must be compared separately.",
    "",
    "| Kind | Object | Status | Live md5 | Fresh md5 | Last observed build writer | Build steps that produced the live hash |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...differences.map((row) =>
      `| ${row.kind} | ${cell(row.name)} | ${row.status} | ${
        cell(row.live)
      } | ${cell(row.fresh)} | ${cell(row.lastWriter)} | ${
        cell(row.liveHashSeenAt.join("; ") || null)
      } |`
    ),
    "",
  ].join("\n");
}

const help = `Offline public view/function md5 comparison; no database access.
Usage:
  deno run --allow-read --allow-write scripts/compare-public-object-md5.ts --live <snapshot.tsv> --fresh <fresh.tsv> [--trace <changes.jsonl>] [--scope job-profit-context-pay] --output <report.md>
  deno run scripts/compare-public-object-md5.ts --sql
Flags: --live, --fresh, --trace, --scope, --output, --sql, --help
Exit: 0 equal or SQL/help; 1 differences; 2 invalid input. Never prints bodies.
TSV: kind<TAB>name<TAB>md5; # comments allowed. Trace JSONL: kind,name,before,after,source.
Capture using psql -X -qAt -F <tab>, with UTC and the same search_path/version.
Trace starts at an empty public catalog; capture changes after every build file.`;

async function main(args: string[]): Promise<number> {
  try {
    if (!args.length || args.length === 1 && args[0] === "--help") {
      console.log(help);
      return 0;
    }
    if (args.length === 1 && args[0] === "--sql") {
      console.log(catalogSql);
      return 0;
    }
    const options = new Map<string, string>();
    const known = ["--live", "--fresh", "--trace", "--scope", "--output"];
    for (let i = 0; i < args.length; i += 2) {
      if (
        !known.includes(args[i]) || !args[i + 1] ||
        args[i + 1].startsWith("--") || options.has(args[i])
      ) {
        throw new Error(
          `Invalid or repeated argument ${args[i]}. Valid flags: ${
            known.join(", ")
          }, --sql, --help`,
        );
      }
      options.set(args[i], args[i + 1]);
    }
    for (const required of ["--live", "--fresh", "--output"]) {
      if (!options.has(required)) {
        throw new Error(`Missing ${required}; run with --help`);
      }
    }
    const scope = options.get("--scope");
    if (scope !== undefined && scope !== "job-profit-context-pay") {
      throw new Error("Unknown --scope; expected job-profit-context-pay");
    }
    const output = options.get("--output")!;
    // Never overwrite an input export, including through a symbolic link.
    try {
      await Deno.lstat(output);
      throw new Error("Output already exists; choose a new report path");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const live = parseCatalog(await Deno.readTextFile(options.get("--live")!));
    const fresh = parseCatalog(
      await Deno.readTextFile(options.get("--fresh")!),
    );
    const tracePath = options.get("--trace");
    const trace = tracePath
      ? parseTrace(await Deno.readTextFile(tracePath))
      : [];
    if (tracePath && !trace.length) {
      throw new Error(
        "Trace is empty; omit --trace for an unattributed comparison",
      );
    }
    // Validate a complete trace before selecting a domain; filtering trace
    // rows first could otherwise hide a discontinuity outside that domain.
    const allDifferences = compareCatalogs(live, fresh, trace);
    const scopedLive = scope ? scopedCatalog(live) : live;
    const scopedFresh = scope ? scopedCatalog(fresh) : fresh;
    const differences = scope
      ? allDifferences.filter((row) => parityArea(row.name))
      : allDifferences;
    await Deno.writeTextFile(
      output,
      renderComparison(differences, scopedLive.size, scopedFresh.size),
      { createNew: true },
    );
    console.log(
      `comparison:\n  live: ${scopedLive.size}\n  fresh: ${scopedFresh.size}\n  differences: ${differences.length}\n  report: ${
        JSON.stringify(output)
      }`,
    );
    return differences.length ? 1 : 0;
  } catch (error) {
    console.log(
      `error: ${
        JSON.stringify(error instanceof Error ? error.message : String(error))
      }`,
    );
    return 2;
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
