#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * SES E1 Release 0 — freeze / verify the stage baseline.
 *
 * This tool NEVER touches production. It consumes a parity-harness JSON that
 * was already produced read-only by `scripts/ses-stage-parity-harness.ts`, so
 * the freeze itself is an offline, reproducible transformation.
 *
 *   # 1. take the read-only production reading (13 SELECT-only queries)
 *   SUPABASE_ACCESS_TOKEN=... /Users/marninstobbe/.deno/bin/deno run \
 *     --allow-env --allow-net --allow-read --allow-write \
 *     scripts/ses-stage-parity-harness.ts --out=.audit/parity.json
 *
 *   # 2. freeze it (Release 0 artifact, committed)
 *   deno run --allow-read --allow-write scripts/ses-e1-freeze-stage-baseline.ts \
 *     --mode=freeze --parity=.audit/parity.json \
 *     --baseline=scripts/ses-e1-stage-baseline-v1.json
 *
 *   # 3. an independent agent re-runs step 1 and proves the freeze still holds
 *   deno run --allow-read scripts/ses-e1-freeze-stage-baseline.ts \
 *     --mode=verify --parity=.audit/parity-rerun.json \
 *     --baseline=scripts/ses-e1-stage-baseline-v1.json
 *
 * Verify exits non-zero when a certified identity or a certified adjudication
 * is gone. New cards, new disputes and moved input hashes are REPORTED, never
 * failed and never re-snapshotted into the frozen file to make a run green.
 */

import {
  buildSesStageBaseline,
  type ParityHarnessOutput,
  type SesStageBaseline,
  verifySesStageBaseline,
} from "./ses-stage-baseline-contract.ts";
import { sha256Hex } from "./ses-measurement-generation.ts";

/**
 * Source identity of the code that produced a reading. Advisory: `index.ts`
 * owns the legacy ladder and changes for unrelated reasons constantly, so a
 * fingerprint difference is reported, never failed.
 */
const ENGINE_SOURCES: Record<string, string> = {
  legacy_ladder: "supabase/functions/ops-api/index.ts",
  m1_computed_status: "supabase/functions/ops-api/makesafe_computed_status.ts",
  board_read_model: "supabase/functions/ops-api/makesafe_board_read_model.ts",
  parity_harness: "scripts/ses-stage-parity-harness.ts",
};

function arg(name: string): string | null {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function engineFingerprints(
  repoRoot: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, path] of Object.entries(ENGINE_SOURCES)) {
    try {
      out[key] = await sha256Hex(
        await Deno.readTextFile(`${repoRoot}/${path}`),
      );
    } catch {
      out[key] = "UNREADABLE";
    }
  }
  return out;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

async function main(): Promise<void> {
  const mode = arg("mode") ?? "verify";
  const parityPath = arg("parity");
  const baselinePath = arg("baseline") ??
    "scripts/ses-e1-stage-baseline-v1.json";
  const repoRoot = arg("repo-root") ??
    new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  if (!parityPath) {
    console.error("--parity=<harness output json> is required");
    Deno.exit(2);
  }

  const parity = await readJson<ParityHarnessOutput>(parityPath);
  const fresh = await buildSesStageBaseline(
    parity,
    await engineFingerprints(repoRoot),
  );

  if (mode === "freeze") {
    await Deno.writeTextFile(
      baselinePath,
      JSON.stringify(fresh, null, 2) + "\n",
    );
    console.log(
      `froze ${fresh.board_cards} cards / ${fresh.disputed.length} disputed -> ${baselinePath}`,
    );
    console.log(`generation_id        ${fresh.generation_id}`);
    console.log(`disputed_manifest_id ${fresh.disputed_manifest_id}`);
    console.log(`snapshot_at          ${fresh.snapshot_at}`);
    return;
  }

  if (mode !== "verify") {
    console.error(`unknown --mode=${mode} (expected freeze or verify)`);
    Deno.exit(2);
  }

  const frozen = await readJson<SesStageBaseline>(baselinePath);
  const result = verifySesStageBaseline(frozen, fresh);
  console.log(JSON.stringify(result, null, 2));
  console.error(
    result.ok
      ? `OK: all ${frozen.disputed.length} certified disputed cards reproduce (fresh disputed total ${result.fresh_disputed})`
      : `FAIL: ${result.failures.length} certified fact(s) did not reproduce`,
  );
  if (!result.ok) Deno.exit(1);
}

if (import.meta.main) {
  await main();
}
