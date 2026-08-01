// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  describeSesBoardPopulation,
  SES_BOARD_POPULATION_ACTIVE_V1,
  SES_BOARD_POPULATION_CONTRACT,
  SES_BOARD_POPULATION_CONTRACT_VERSION,
  sesBoardMembershipPredicate,
  sesBoardPopulationPredicate,
  sesBoardStatusPredicate,
  sesBoardSyntheticExclusionPredicate,
} from "../ses-board-population-contract.ts";

// The point of naming the contract is that a measurement records WHICH
// denominator it measured. If the default silently changes, every artifact
// carrying the old version string becomes unattributable.
Deno.test("the default contract is the active board, named and versioned", () => {
  assertEquals(
    SES_BOARD_POPULATION_CONTRACT,
    SES_BOARD_POPULATION_ACTIVE_V1,
  );
  assertEquals(
    SES_BOARD_POPULATION_CONTRACT_VERSION,
    "ses-board-population/active-v1",
  );
  assertEquals(
    SES_BOARD_POPULATION_CONTRACT.excluded_job_statuses,
    ["cancelled", "lost"],
  );
});

// Batch 0 explicitly must NOT freeze the denominator: Captain decision C.5 is
// open. This test is the guard against a later reader mistaking the default for
// a ruling — it fails the moment someone clears the pending decision without
// also recording the ruled contract as a new version.
Deno.test("the contract declares itself NOT final while C.5 is open", () => {
  assert(
    SES_BOARD_POPULATION_CONTRACT.pending_captain_decision,
    "C.5 is unruled, so the contract must name it as pending",
  );
  assertStringIncludes(
    SES_BOARD_POPULATION_CONTRACT.pending_captain_decision!,
    "C.5",
  );
});

Deno.test("the rendered description refuses to read as 'the whole board'", () => {
  const rendered = describeSesBoardPopulation();
  assertStringIncludes(rendered, "ses-board-population/active-v1");
  assertStringIncludes(rendered, "NOT FINAL");
  assertStringIncludes(rendered, "C.5");
  // The caveat states the negative outright, so a count quoted out of an
  // artifact header cannot be read as board-complete.
  assertStringIncludes(rendered, 'this is not "the whole board"');
});

Deno.test("a ruled contract renders without the caveat", () => {
  const ruled = {
    ...SES_BOARD_POPULATION_ACTIVE_V1,
    version: "ses-board-population/ruled-vX",
    pending_captain_decision: null,
  };
  const rendered = describeSesBoardPopulation(ruled);
  assertEquals(rendered, "ses-board-population/ruled-vX");
});

// The predicate must stay byte-equivalent to the hand-written SQL the harnesses
// ran before it was named, or naming it would have moved measured numbers.
Deno.test("the full predicate keeps the three original clauses", () => {
  const sql = sesBoardPopulationPredicate();
  assertStringIncludes(sql, "j.status not in ('cancelled','lost')");
  assertStringIncludes(sql, "j.type = 'makesafe'");
  assertStringIncludes(
    sql,
    "j.metadata->>'insurance_job_type' = 'restoration'",
  );
  assertStringIncludes(
    sql,
    "select 1 from makesafe_job_details d where d.job_id = j.id",
  );
  assertStringIncludes(sql, "ses_synthetic_livefire_runs r");
  assertStringIncludes(sql, "r.state = 'terminal'");
});

// Board-SCOPED joins already bind a `d` alias, so the detail alias has to be
// overridable or the generated SQL self-collides.
Deno.test("the detail alias is overridable for board-scoped joins", () => {
  const sql = sesBoardPopulationPredicate({
    detailAlias: "d2",
    includeSyntheticExclusion: false,
  });
  assertStringIncludes(
    sql,
    "select 1 from makesafe_job_details d2 where d2.job_id = j.id",
  );
  assert(
    !sql.includes("ses_synthetic_livefire_runs"),
    "scoped joins inherit the card set's synthetic exclusion, never restate it",
  );
});

Deno.test("the job alias is overridable", () => {
  const sql = sesBoardPopulationPredicate({ alias: "jobs" });
  assertStringIncludes(sql, "jobs.status not in ('cancelled','lost')");
  assertStringIncludes(sql, "jobs.type = 'makesafe'");
});

Deno.test("the clause helpers compose into the full predicate", () => {
  const full = sesBoardPopulationPredicate();
  for (
    const clause of [
      sesBoardStatusPredicate(),
      sesBoardMembershipPredicate(),
      sesBoardSyntheticExclusionPredicate(),
    ]
  ) {
    assertStringIncludes(full, clause);
  }
});

// A contract that excluded nothing would quietly widen every measurement.
Deno.test("the excluded statuses drive the generated status clause", () => {
  const widened = {
    ...SES_BOARD_POPULATION_ACTIVE_V1,
    excluded_job_statuses: ["cancelled"],
  };
  assertEquals(
    sesBoardStatusPredicate("j", widened),
    "j.status not in ('cancelled')",
  );
});
