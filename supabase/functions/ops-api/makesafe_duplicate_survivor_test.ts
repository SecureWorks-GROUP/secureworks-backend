// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MAKESAFE_AUTHORIZED_DUPLICATE_GROUPS,
  planMakesafeDuplicateSurvivorArchives,
} from "./makesafe_duplicate_survivor.ts";

const NOW = "2026-08-01T04:15:00.000Z";

function row(
  jobNumber: string,
  stage: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `id-${jobNumber}`,
    job_number: jobNumber,
    job_state: "processing",
    declared_stage: stage,
    canonical_stage: stage,
    ...overrides,
  };
}

/** The live board as verified on 2026-08-01 for the four adjudicated groups. */
function boardRows(overrides: Record<string, Record<string, unknown>> = {}) {
  const stages: Record<string, string> = {
    "SWMS-26736": "report_ready",
    "SWMS-26998": "allocated",
    "SWMS-26787": "report_ready",
    "SWMS-26791": "report_ready",
    "SWMS-26845": "report_ready",
    "SWMS-26920": "allocated",
    "SWMS-261065": "report_ready",
    "SWMS-261118": "new",
  };
  return Object.entries(stages).map(([jobNumber, stage]) =>
    row(jobNumber, stage, overrides[jobNumber] || {})
  );
}

Deno.test("the authorized list is exactly the four re-verified duplicate pairs", () => {
  assertEquals(MAKESAFE_AUTHORIZED_DUPLICATE_GROUPS.length, 4);
  assertEquals(
    MAKESAFE_AUTHORIZED_DUPLICATE_GROUPS.map((group) =>
      `${group.survivor_job_number}>${group.loser_job_number}`
    ),
    [
      "SWMS-26736>SWMS-26998",
      "SWMS-26787>SWMS-26791",
      "SWMS-26845>SWMS-26920",
      "SWMS-261065>SWMS-261118",
    ],
  );
});

Deno.test("groups that failed re-verification are absent and cannot be requested", () => {
  // The five groups whose members resolve DIFFERENT builder POs are distinct
  // jobs, not duplicates. None of their cards may ever be planned.
  const skippedCards = [
    "SWMS-26706",
    "SWMS-26957",
    "SWMS-26721",
    "SWMS-26855",
    "SWMS-26735",
    "SWMS-26852",
    "SWMS-26759",
    "SWMS-26853",
    "SWMS-26657",
    "SWMS-26660",
    // MLB-25625's assessment card: a distinct instruction (PO-54006), never a
    // member of the roof duplicate pair.
    "SWMS-26851",
  ];
  const planned = MAKESAFE_AUTHORIZED_DUPLICATE_GROUPS.flatMap((group) => [
    group.survivor_job_number,
    group.loser_job_number,
  ]);
  for (const card of skippedCards) {
    assert(!planned.includes(card), `${card} must not be planned`);
  }
});

Deno.test("an unauthorized group key is refused rather than planned", () => {
  const plan = planMakesafeDuplicateSurvivorArchives(
    boardRows(),
    ["mlb-26072-sorrento"],
    NOW,
  );
  assertEquals(plan.archives.length, 0);
  assertEquals(plan.skipped.length, 1);
  assertEquals(plan.skipped[0].reason, "group_not_authorized");
});

Deno.test("planning all four groups archives exactly the four losers with pointers", () => {
  const plan = planMakesafeDuplicateSurvivorArchives(boardRows(), null, NOW);
  assertEquals(plan.skipped, []);
  assertEquals(plan.archives.length, 4);
  for (const archive of plan.archives) {
    assertEquals(archive.after_status, "archive");
    assertEquals(archive.computed_missing, []);
    assert(archive.duplicate_of_job_id.length > 0);
    assert(archive.duplicate_of_job_id !== archive.job_id);
    assert(archive.computed_reasons.includes("duplicate_survivor_archive"));
    // Every 2026-08-01 pick is an activity pick: both cards carry the same PO.
    assertEquals(archive.duplicate_rule, "activity_evidence");
    assert(String(archive.duplicate_evidence.reasoning).length > 0);
  }
  assertEquals(
    plan.archives.map((archive) => archive.job_number),
    ["SWMS-26998", "SWMS-26791", "SWMS-26920", "SWMS-261118"],
  );
  assertEquals(
    plan.archives.map((archive) => archive.duplicate_of_job_number),
    ["SWMS-26736", "SWMS-26787", "SWMS-26845", "SWMS-261065"],
  );
});

Deno.test("before_status tracks the card's live stage, not a hardcoded value", () => {
  const plan = planMakesafeDuplicateSurvivorArchives(boardRows(), null, NOW);
  const byNumber = new Map(
    plan.archives.map((archive) => [archive.job_number, archive]),
  );
  assertEquals(byNumber.get("SWMS-26998")?.before_status, "allocated");
  assertEquals(byNumber.get("SWMS-261118")?.before_status, "new");
  assertEquals(byNumber.get("SWMS-26791")?.before_status, "report_ready");
});

Deno.test("a terminal loser is skipped, never re-archived", () => {
  for (
    const [override, reason] of [
      [{ canonical_stage: "archive" }, "loser_terminal_display_status"],
      [{ canonical_stage: "cancelled" }, "loser_terminal_display_status"],
      [{ job_state: "cancelled" }, "loser_terminal_job_status"],
    ] as const
  ) {
    const plan = planMakesafeDuplicateSurvivorArchives(
      boardRows({ "SWMS-26920": override }),
      ["mlb-23067-makesafe"],
      NOW,
    );
    assertEquals(plan.archives.length, 0);
    assertEquals(plan.skipped[0].reason, reason);
  }
});

Deno.test("a dead survivor blocks the archive so work is never stranded", () => {
  for (
    const [override, reason] of [
      [{ canonical_stage: "archive" }, "survivor_terminal_display_status"],
      [{ job_state: "lost" }, "survivor_terminal_job_status"],
    ] as const
  ) {
    const plan = planMakesafeDuplicateSurvivorArchives(
      boardRows({ "SWMS-26845": override }),
      ["mlb-23067-makesafe"],
      NOW,
    );
    assertEquals(plan.archives.length, 0);
    assertEquals(plan.skipped[0].reason, reason);
  }
});

Deno.test("a card already archived as a duplicate is skipped on replay", () => {
  const plan = planMakesafeDuplicateSurvivorArchives(
    boardRows({
      "SWMS-26920": { duplicate_of_job_id: "id-SWMS-26845" },
    }),
    ["mlb-23067-makesafe"],
    NOW,
  );
  assertEquals(plan.archives.length, 0);
  assertEquals(plan.skipped[0].reason, "already_archived_as_duplicate");
});

Deno.test("a missing card is skipped rather than silently dropped", () => {
  const rows = boardRows().filter((candidate) =>
    candidate.job_number !== "SWMS-261118"
  );
  const plan = planMakesafeDuplicateSurvivorArchives(rows, null, NOW);
  assertEquals(plan.archives.length, 3);
  assertEquals(plan.skipped.length, 1);
  assertEquals(plan.skipped[0].reason, "loser_not_found");
  assertEquals(plan.skipped[0].loser_job_number, "SWMS-261118");
});

Deno.test("every survivor is reported so the caller can verify it stayed live", () => {
  const plan = planMakesafeDuplicateSurvivorArchives(boardRows(), null, NOW);
  assertEquals(plan.survivors.length, 4);
  assertEquals(
    plan.survivors.map((survivor) => survivor.job_number),
    ["SWMS-26736", "SWMS-26787", "SWMS-26845", "SWMS-261065"],
  );
});
