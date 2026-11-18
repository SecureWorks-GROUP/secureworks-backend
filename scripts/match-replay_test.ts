import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseReplayItems,
  runMatchReplayCli,
  scoreReplay,
} from "./match-replay.ts";
import type { ClueType } from "../supabase/functions/xero-sync/match/types.ts";

const ZZTEST_FIXTURE_PATH = new URL(
  "./fixtures/match-replay-zztest.json",
  import.meta.url,
).pathname;

const BASE_TYPES: Record<string, ClueType> = {
  job_number: {
    code: "job_number",
    class: "key",
    family: "doc_text",
    mode: "counts",
  },
  sealed_scope_order: {
    code: "sealed_scope_order",
    class: "key",
    family: "order",
    mode: "counts",
  },
  overhead_account: {
    code: "overhead_account",
    class: "clue",
    family: "account",
    mode: "suggest_only",
  },
  learned_rule: {
    code: "learned_rule",
    class: "clue",
    family: "rule",
    mode: "suggest_only",
  },
};

Deno.test("4-item ZZTEST fixture scores 3 items (1 auto_right, 1 auto_wrong, 1 suggest_right, 1 unsure skipped) and exits 1", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runMatchReplayCli([ZZTEST_FIXTURE_PATH], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  assertEquals(exitCode, 1);
  assertEquals(stderr, []);
  assertEquals(stdout.length, 1);
  assertEquals(JSON.parse(stdout[0]), {
    items: 3,
    auto_right: 1,
    auto_wrong: 1,
    suggest_right: 1,
    suggest_wrong: 0,
    none: 0,
    auto_wrong_subjects: ["xero_bill:ZZTEST-BILL-002"],
  });
});

Deno.test("zero auto_wrong exits 0 and tallies suggest_wrong, none, overhead and division_stock", () => {
  const items = parseReplayItems([
    {
      subject_id: "xero_bill:ZZTEST-BILL-010",
      clues: [
        {
          clue_code: "job_number",
          class: "key",
          family: "doc_text",
          root: "doc:ZZTEST-BILL-010",
          outcome: "job",
          job_id: "SWF-990001",
          names_one: true,
        },
        {
          clue_code: "sealed_scope_order",
          class: "key",
          family: "order",
          root: "order:ZZTEST-ORD-010",
          outcome: "job",
          job_id: "SWF-990001",
          names_one: true,
        },
      ],
      clue_types: BASE_TYPES,
      stops: [],
      answer: { outcome: "job", job_id: "SWF-990001", division: null },
    },
    {
      subject_id: "xero_bill:ZZTEST-BILL-011",
      clues: [
        {
          clue_code: "overhead_account",
          class: "clue",
          family: "account",
          root: "doc:ZZTEST-BILL-011",
          outcome: "overhead",
          names_one: true,
        },
      ],
      clue_types: BASE_TYPES,
      stops: [],
      answer: { outcome: "overhead", job_id: null, division: null },
    },
    {
      subject_id: "xero_bill:ZZTEST-BILL-012",
      clues: [
        {
          clue_code: "learned_rule",
          class: "clue",
          family: "rule",
          root: "rule:ZZTEST-R1",
          outcome: "division_stock",
          division: "fencing",
          names_one: true,
        },
      ],
      clue_types: BASE_TYPES,
      stops: [],
      answer: { outcome: "division_stock", job_id: null, division: "patios" },
    },
    {
      subject_id: "xero_bill:ZZTEST-BILL-013",
      clues: [],
      clue_types: BASE_TYPES,
      stops: [],
      answer: { outcome: "job", job_id: "SWP-990002", division: null },
    },
  ]);

  assertEquals(scoreReplay(items), {
    items: 4,
    auto_right: 1,
    auto_wrong: 0,
    suggest_right: 1,
    suggest_wrong: 1,
    none: 1,
    auto_wrong_subjects: [],
  });
});

Deno.test("missing, unreadable or malformed replay input refuses with a coded error instead of counting zero", async () => {
  const missingArgErr: string[] = [];
  assertEquals(
    await runMatchReplayCli([], { stderr: (line) => missingArgErr.push(line) }),
    2,
  );
  assertEquals(missingArgErr, ["replay_error:replay_path_required"]);

  const missingFileErr: string[] = [];
  assertEquals(
    await runMatchReplayCli([`${ZZTEST_FIXTURE_PATH}.missing`], {
      stderr: (line) => missingFileErr.push(line),
    }),
    2,
  );
  assertEquals(missingFileErr, ["replay_error:replay_read_failed"]);

  assertThrows(
    () => parseReplayItems({ not: "an_array" }),
    Error,
    "replay_items_not_array",
  );
  assertThrows(
    () =>
      parseReplayItems([
        {
          subject_id: "xero_bill:ZZTEST-BILL-099",
          clues: [],
          clue_types: BASE_TYPES,
          stops: [],
          answer: { outcome: "job", job_id: null, division: null },
        },
      ]),
    Error,
    "replay_missing_answer_job:xero_bill:ZZTEST-BILL-099",
  );
});
