#!/usr/bin/env -S deno run --allow-read
// Replay the shipped fencing stage-truth recipe over the frozen 38-job
// cohort. Exit 0 on a clean proof. Exit 1 if any frozen expected misses,
// if a perturbation does not move, or if --planted-lie is set.
//
//   deno run --allow-read scripts/fencing-stage-truth-harness.ts
//   deno run --allow-read scripts/fencing-stage-truth-harness.ts --planted-lie

import { deriveFencingStageV1 } from "../supabase/functions/ops-api/fencing_stage_engine_v1.ts";
import { isFencingMaterialsOrLater } from "../supabase/functions/ops-api/fencing_stage_recipe_v1.ts";
import {
  FENCING_STAGE_TRUTH_BOUNDARY,
  FENCING_STAGE_TRUTH_COHORT,
  FENCING_STAGE_TRUTH_EMPTY_COMPLETE,
  FENCING_STAGE_TRUTH_PERTURBATIONS,
  FENCING_STAGE_TRUTH_PINNED_NOW,
  FENCING_STAGE_TRUTH_PLANTED_LIE,
} from "../supabase/functions/ops-api/fixtures/fencing_stage_truth_cohort_v1.ts";

const NOW = new Date(FENCING_STAGE_TRUTH_PINNED_NOW);
const plantedLie = Deno.args.includes("--planted-lie");

const failures: string[] = [];
const counts = new Map<string, number>();

for (const row of FENCING_STAGE_TRUTH_COHORT) {
  const expected = plantedLie && row.id === FENCING_STAGE_TRUTH_PLANTED_LIE.id
    ? FENCING_STAGE_TRUTH_PLANTED_LIE.false_expected
    : row.expected_canonical;
  const got = deriveFencingStageV1(row.evidence, { now: NOW });
  counts.set(got.canonical_stage, (counts.get(got.canonical_stage) || 0) + 1);
  if (got.canonical_stage !== expected) {
    failures.push(
      `${row.id}: got ${got.canonical_stage} expected ${expected}`,
    );
  }
  if (
    isFencingMaterialsOrLater(got.canonical_stage) && !got.facts.deposit_paid
  ) {
    failures.push(`${row.id}: ${got.canonical_stage} without deposit_paid`);
  }
}

for (const row of FENCING_STAGE_TRUTH_BOUNDARY) {
  const got = deriveFencingStageV1(row.evidence, { now: NOW });
  if (got.canonical_stage !== row.expected_canonical) {
    failures.push(
      `boundary ${row.id}: got ${got.canonical_stage} expected ${row.expected_canonical}`,
    );
  }
}

for (const pert of FENCING_STAGE_TRUTH_PERTURBATIONS) {
  const base = [...FENCING_STAGE_TRUTH_COHORT, ...FENCING_STAGE_TRUTH_BOUNDARY]
    .find((row) => row.id === pert.base_id);
  if (!base) {
    failures.push(`perturbation ${pert.id}: missing base ${pert.base_id}`);
    continue;
  }
  const after = deriveFencingStageV1(pert.mutate(base.evidence), { now: NOW });
  if (after.canonical_stage === pert.must_not_remain) {
    failures.push(`perturbation ${pert.id} did not move`);
  }
  if (after.canonical_stage !== pert.expected_canonical) {
    failures.push(
      `perturbation ${pert.id}: got ${after.canonical_stage} expected ${pert.expected_canonical}`,
    );
  }
}

const emptyComplete = deriveFencingStageV1(
  FENCING_STAGE_TRUTH_EMPTY_COMPLETE.evidence,
  { now: NOW },
);
if (emptyComplete.canonical_stage !== "unknown") {
  failures.push(
    `claimed complete with empty evidence classified ${emptyComplete.canonical_stage}`,
  );
}

const unknown = counts.get("unknown") || 0;
const classified = FENCING_STAGE_TRUTH_COHORT.length;
console.log(`classified=${classified} unknown=${unknown}`);
console.log(`buckets=${JSON.stringify(Object.fromEntries(counts))}`);
console.log(
  `perturbations=${FENCING_STAGE_TRUTH_PERTURBATIONS.length} boundary=${FENCING_STAGE_TRUTH_BOUNDARY.length}`,
);

if (failures.length > 0) {
  for (const line of failures) console.error(line);
  Deno.exit(1);
}

if (plantedLie) {
  console.error("planted lie was expected to fail but all expecteds matched");
  Deno.exit(1);
}
