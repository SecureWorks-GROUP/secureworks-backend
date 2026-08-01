#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any
// Backfill the one MakeSafe family the round-2 board correction lost.
//
// The round-2 field fixture names SWMS-26692 exactly:
//
//   SWMS-26692 | jobs.metadata.makesafe_job_family | NULL | temp_fence_makesafe
//
// but the round-2 run skipped it with `handled_by_temp_fence_class` — a claim
// that the temp-fence pass would pick it up. SWMS-26692 is not in the
// temp-fence fixture, so nothing did, and the field stayed NULL. The only
// captain hold in that class is SWMS-26894, which is a different card and is
// deliberately untouched here. The misreported reason itself is fixed in
// apply-board-fixes-round2-v1.ts.
//
// This applies that one field and nothing else. It reuses the round-2
// evaluator and its compare-and-set SQL rather than reimplementing them, so
// the same guards apply: the job must match by id AND job_number, the current
// value must still be exactly the expected NULL, and the board kind must be
// identical before and after (evaluateField refuses with
// `board_kind_would_change` otherwise).
//
// Modes mirror scripts/apply-board-safe-fixes-v1.ts: dry-run (default),
// apply, verify. Nothing outside jobs.metadata.makesafe_job_family is written,
// no status or lineage changes, and no communication is sent.

import {
  buildFieldUpdateSql,
  evaluateField,
  type FieldEvaluation,
  type FieldFixture,
  parseFieldFixture,
} from "./apply-board-fixes-round2-v1.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const TARGET_CARD = "SWMS-26692";
/** The round-2 temp-fence captain hold. A different card; never touched here. */
const TEMP_FENCE_HOLD = "SWMS-26894";
const FIXTURE_PATH = new URL(
  "./board-fixes-round2-field.fixture.txt",
  import.meta.url,
);

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function flag(name: string): string | null {
  const index = Deno.args.findIndex((arg) =>
    arg === name || arg.startsWith(`${name}=`)
  );
  if (index === -1) return null;
  const arg = Deno.args[index];
  return arg.includes("=")
    ? arg.slice(arg.indexOf("=") + 1)
    : Deno.args[index + 1] || null;
}

async function query(sql: string, readOnly: boolean): Promise<any[]> {
  const token = requiredEnv("SUPABASE_ACCESS_TOKEN");
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: sql, read_only: readOnly }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`management query failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : [];
}

function targetFixture(): FieldFixture {
  const fixtures = parseFieldFixture(Deno.readTextFileSync(FIXTURE_PATH));
  const match = fixtures.filter((row) => row.card === TARGET_CARD);
  if (match.length !== 1) {
    throw new Error(
      `expected exactly one ${TARGET_CARD} row in the round-2 field fixture, found ${match.length}`,
    );
  }
  const fixture = match[0];
  // Pin the adjudicated transition. A fixture edit must not silently retarget
  // this script.
  if (fixture.before !== null || fixture.after !== "temp_fence_makesafe") {
    throw new Error(
      `${TARGET_CARD} fixture is not the adjudicated NULL -> temp_fence_makesafe transition`,
    );
  }
  return fixture;
}

async function evaluate(): Promise<FieldEvaluation> {
  const fixture = targetFixture();
  const jobs = await query(
    `SELECT j.id::text, j.job_number, j.status, j.type, j.metadata
     FROM public.jobs j WHERE j.job_number = '${TARGET_CARD}';`,
    true,
  );
  const details = jobs.length === 1
    ? await query(
      `SELECT d.job_id::text, d.substatus, d.report_type, d.external_ref
       FROM public.makesafe_job_details d WHERE d.job_id = '${jobs[0].id}';`,
      true,
    )
    : [];
  // allowTempFence: this IS the deferred temp-fence target the round-2 run
  // lost, and applying it is the whole point of this script.
  return evaluateField(
    fixture,
    jobs as any,
    details as any,
    true,
    "swms-26692-family",
  );
}

async function assertHoldUntouched(): Promise<Record<string, unknown>> {
  const rows = await query(
    `SELECT j.job_number, j.metadata->>'makesafe_job_family' AS family
     FROM public.jobs j WHERE j.job_number = '${TEMP_FENCE_HOLD}';`,
    true,
  );
  return { card: TEMP_FENCE_HOLD, observed: rows[0] ?? null };
}

function write(path: string, payload: unknown) {
  Deno.writeTextFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${path}`);
}

async function main() {
  const mode = flag("--mode") || "dry-run";
  const output = flag("--output");
  if (!["dry-run", "apply", "verify"].includes(mode)) {
    throw new Error(`unknown mode ${mode}`);
  }

  const evaluation = await evaluate();
  const hold = await assertHoldUntouched();

  if (mode === "dry-run") {
    const payload = {
      mode,
      target: TARGET_CARD,
      planned: evaluation.eligible ? 1 : 0,
      skipped: evaluation.eligible ? 0 : 1,
      evaluation,
      temp_fence_hold_untouched: hold,
    };
    console.log(JSON.stringify(payload, null, 2));
    if (output) write(output, payload);
    return;
  }

  if (mode === "verify") {
    const payload = {
      mode,
      target: TARGET_CARD,
      // After a successful apply the value is set, so the NULL-expecting
      // fixture is no longer eligible. That is the proof, not a failure.
      observed_family: evaluation.observed_before,
      applied: evaluation.observed_before === "temp_fence_makesafe",
      board_kind: evaluation.board_kind_before,
      temp_fence_hold_untouched: hold,
    };
    console.log(JSON.stringify(payload, null, 2));
    if (output) write(output, payload);
    return;
  }

  if (!evaluation.eligible) {
    throw new Error(
      `refusing to apply: ${TARGET_CARD} is not eligible (${evaluation.reason})`,
    );
  }
  const changed = await query(buildFieldUpdateSql(evaluation), false);
  if (changed.length !== 1 || changed[0].value !== "temp_fence_makesafe") {
    throw new Error(
      `apply did not produce exactly one updated row: ${
        JSON.stringify(changed)
      }`,
    );
  }
  const payload = {
    mode,
    target: TARGET_CARD,
    applied_count: changed.length,
    applied: changed,
    evaluation,
    temp_fence_hold_untouched: hold,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (output) write(output, payload);
}

if (import.meta.main) {
  await main();
}
