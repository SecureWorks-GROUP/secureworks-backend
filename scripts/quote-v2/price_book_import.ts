#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env=HOME --allow-run=git,psql
// Quote v2, stage 1: load the ten current price stores into the price book.
//
// DRY RUN BY DEFAULT. It reads the source files, prints what it would load,
// and can write the SQL (--sql-out) and the diff report (--diff-out). It only
// writes to a database with --apply, and --apply refuses any database that is
// not on localhost: this script never touches production.
//
//   deno run --allow-read --allow-write --allow-env=HOME --allow-run=git,psql \
//     scripts/quote-v2/price_book_import.ts [--diff-out price-diff.md] [--sql-out import.sql]
//     [--apply --db-url postgresql://postgres@127.0.0.1:5432/scratch]
//     [--fence-dir ~/Projects/fence-designer] [--patio-dir ~/Projects/patio-tool]
//     [--wiki-dir ~/Projects/secureworks-wiki] [--ledger-json export.json]
//
// Sources are read-only. The live `scope_tool_defaults` table, the live
// `material_price_ledger` and each iPad's browser cache are not read (no
// production access); the report names them as not observed. An operator
// export of confirmed ledger rows can be passed with --ledger-json.

import {
  fenceBusinessRules,
  fenceCostPrices,
  fenceParitySeed,
  fenceSellDefaults,
  materialPriceLedger,
  type Observation,
  patioDeviceCache,
  patioEnginePolicy,
  patioEngineSnapshot,
  patioHardcoded,
  scopeToolDefaultsRepoSeed,
  type SourceRefs,
  wikiSupplierCsv,
} from "./price_book_sources.ts";
import { buildPlan, planSql, renderDiff, summarise } from "./price_book_plan.ts";

export const WIKI_CSVS = [
  "ampelite.csv",
  "bd-metals.csv",
  "cmi.csv",
  "metroll.csv",
  "rnr-fencing.csv",
  "stratco-cts.csv",
];

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Only a disposable local database may receive an import. */
export function assertLocalDatabase(url: string | undefined): string {
  if (!url) throw new Error("--apply needs --db-url");
  if (!/^postgres(ql)?:\/\/[^@/]*@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
    throw new Error("--db-url must be a localhost database; this import never writes anywhere else");
  }
  return url;
}

async function gitHead(dir: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["-C", dir, "rev-parse", "--short", "HEAD"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return out.success ? new TextDecoder().decode(out.stdout).trim() : "unknown";
}

export async function readObservations(dirs: {
  fence: string;
  patio: string;
  wiki: string;
  backend: string;
  ledgerJson?: string;
}): Promise<{ observations: Observation[]; refs: SourceRefs; notObserved: string[] }> {
  const refs: SourceRefs = {
    fenceCommit: await gitHead(dirs.fence),
    patioCommit: await gitHead(dirs.patio),
    wikiCommit: await gitHead(dirs.wiki),
    backendCommit: await gitHead(dirs.backend),
  };
  const read = (p: string) => Deno.readTextFileSync(p);
  const fenceIndex = read(`${dirs.fence}/index.html`);
  const patioIndex = read(`${dirs.patio}/index.html`);
  const observations: Observation[] = [
    ...fenceCostPrices(fenceIndex, refs),
    ...fenceSellDefaults(fenceIndex, refs),
    ...fenceBusinessRules(read(`${dirs.fence}/business_rules.js`), refs),
    ...fenceParitySeed(read(`${dirs.fence}/parity/seed_scope_tool_defaults.sql`), refs),
    ...patioHardcoded(patioIndex, refs),
    ...patioDeviceCache(),
    ...patioEngineSnapshot(read(`${dirs.patio}/engine/v1/rate-snapshot.ts`), refs),
    ...patioEnginePolicy(read(`${dirs.patio}/engine/v1/pricing-model.ts`), refs),
    ...scopeToolDefaultsRepoSeed(
      read(`${dirs.backend}/supabase/migrations/20260320000006_scope_tool_defaults.sql`),
      refs,
    ),
  ];
  for (const f of WIKI_CSVS) {
    observations.push(...wikiSupplierCsv(f, read(`${dirs.wiki}/research/supplier-pricing/${f}`), refs));
  }
  const notObserved = [
    "6 patio per-device cache: lives in each iPad's browser storage; no server copy exists.",
    "8 scope_tool_defaults (live table): current rows need a production read; only the repo seed and the fence parity seed (store 4) were read.",
  ];
  if (dirs.ledgerJson) {
    observations.push(...materialPriceLedger(JSON.parse(read(dirs.ledgerJson))));
  } else {
    notObserved.push(
      "9 material_price_ledger (live): needs a production read; pass an operator export with --ledger-json.",
    );
  }
  return { observations, refs, notObserved };
}

async function main(args: string[]) {
  const home = Deno.env.get("HOME") ?? "";
  const dirs = {
    fence: flag(args, "--fence-dir") ?? `${home}/Projects/fence-designer`,
    patio: flag(args, "--patio-dir") ?? `${home}/Projects/patio-tool`,
    wiki: flag(args, "--wiki-dir") ?? `${home}/Projects/secureworks-wiki`,
    backend: flag(args, "--backend-dir") ?? Deno.cwd(),
    ledgerJson: flag(args, "--ledger-json"),
  };
  const apply = args.includes("--apply");
  const dbUrl = apply ? assertLocalDatabase(flag(args, "--db-url")) : undefined;

  const { observations, refs, notObserved } = await readObservations(dirs);
  const plan = buildPlan(observations);
  const sql = planSql(plan);
  const diff = renderDiff(plan, {
    generatedAt: new Date().toISOString().slice(0, 10),
    refs: {
      "fence-designer": refs.fenceCommit,
      "patio-tool": refs.patioCommit,
      "secureworks-wiki": refs.wikiCommit,
      "secureworks-backend": refs.backendCommit,
    },
    notObserved,
  });

  const sqlOut = flag(args, "--sql-out");
  if (sqlOut) Deno.writeTextFileSync(sqlOut, sql);
  const diffOut = flag(args, "--diff-out");
  if (diffOut) Deno.writeTextFileSync(diffOut, diff);

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry_run", refs, summary: summarise(plan) }, null, 2));

  if (apply && dbUrl) {
    const tmp = Deno.makeTempFileSync({ suffix: ".sql" });
    Deno.writeTextFileSync(tmp, sql);
    const out = await new Deno.Command("psql", {
      args: [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", tmp],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    Deno.removeSync(tmp);
    if (!out.success) {
      console.error("apply failed");
      Deno.exit(1);
    }
    console.log("applied to local database");
  }
}

if (import.meta.main) await main(Deno.args);
