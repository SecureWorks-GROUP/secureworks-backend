// deno-lint-ignore-file no-import-prefix
//
// Scoped identity-spine seed route.
//
// REGRESSION BAR: the first test in this file fails on the pre-change shape of
// the repository (an ops-api with no scoped route to
// `seed_makesafe_state_authority_scoped_v2`). Reverting the handler in
// `index.ts` makes it red.
//
// CONTROLS: two jobs that must NOT be seeded are pinned here — a non-canonical
// job (refused before the RPC is called) and a card whose intake authority is
// ambiguous (minted `unresolved_authority`, still refused by U4). Both controls
// hold on the old shape too; see the notes on each.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkMakesafeStateSeedScopeResult,
  deriveSesSpineFacts,
  isCanonicalSeedScopeJob,
  MAKESAFE_STATE_SEED_SCOPE_CONTRACT,
  MAKESAFE_STATE_SEED_SCOPE_MAX_CARDS,
  normalizeMakesafeStateSeedScopeRequest,
  resolveMakesafeStateSeedScope,
} from "./makesafe_state_seed_scope.ts";

const indexSource = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);
const requiredActions = await Deno.readTextFile(
  new URL("../../../scripts/_ops-api-required-actions.txt", import.meta.url),
);

function ok(result: ReturnType<typeof normalizeMakesafeStateSeedScopeRequest>) {
  assert(
    result.ok,
    `expected an accepted request, got ${JSON.stringify(result)}`,
  );
  return result.request;
}

function refused(
  result: ReturnType<typeof normalizeMakesafeStateSeedScopeRequest>,
) {
  assert(!result.ok, "expected the request to be refused");
  return result;
}

// ── The regression: the producer now has a scoped door ────────────────────────
//
// FAILS ON THE OLD SHAPE. Before this change `seed_makesafe_state_authority_v1`
// / `_scoped_v2` were reachable only through `makesafe_state_seed`, which
// selects the entire canonical board and refuses to be narrowed, so no named
// tranche could ever be run and the seeder had never executed in production.
Deno.test("a named tranche has a scoped route to the existing seeder", () => {
  assertStringIncludes(indexSource, "case 'makesafe_state_seed_scoped'");
  // The scoped route reuses the accounted v2 wrapper, never the bare v1
  // producer, so every requested job is partitioned and ledgered.
  const handler = indexSource.slice(
    indexSource.indexOf("case 'makesafe_state_seed_scoped'"),
    indexSource.indexOf("case 'makesafe_state_reconcile'"),
  );
  assert(
    handler.length > 0,
    "scoped handler must precede makesafe_state_reconcile",
  );
  assertStringIncludes(handler, "'seed_makesafe_state_authority_scoped_v2'");
  assertEquals(handler.includes("seed_makesafe_state_authority_v1"), false);
  // Same posture as its full-board sibling: privileged, POST-only, dry by
  // default, and structurally unable to claim it covered the board.
  assertStringIncludes(handler, "authMode !== 'api_key'");
  assertStringIncludes(handler, "req.method !== 'POST'");
  assertStringIncludes(handler, "board_complete: false");
  // Validation runs before any read, so a bad body never reaches production
  // rows; the run-key rule itself is asserted directly further down.
  assertStringIncludes(handler, "normalizeMakesafeStateSeedScopeRequest(body)");
  // The deploy gate iterates this list; an unlisted action can be dropped by a
  // stale deploy without anything going red.
  assertStringIncludes(requiredActions, "\nmakesafe_state_seed_scoped\n");
});

Deno.test("the full-board bootstrap keeps its own board-wide gate", () => {
  // The scoped action must not have been implemented by loosening the sweep.
  assertStringIncludes(indexSource, "case 'makesafe_state_seed'");
  const fullBoard = indexSource.slice(
    indexSource.indexOf("case 'makesafe_state_seed'"),
    indexSource.indexOf("case 'makesafe_state_seed_scoped'"),
  );
  assertStringIncludes(
    fullBoard,
    "const canonicalRows = await loadCanonicalMakesafeBoard(client)",
  );
  assertStringIncludes(
    fullBoard,
    "const acceptancePassed = inputErrors === 0 && spineBlockers.length === 0",
  );
  // No caller-chosen selection leaked into the sweep.
  assertEquals(fullBoard.includes("job_numbers"), false);
});

// ── Request validation ────────────────────────────────────────────────────────

Deno.test("scoped seed defaults to dry run and demands a run key to write", () => {
  const dry = ok(normalizeMakesafeStateSeedScopeRequest({
    job_numbers: ["SWMS-261020"],
  }));
  assertEquals(dry.dryRun, true);
  assertEquals(dry.runKey, "");

  refused(
    normalizeMakesafeStateSeedScopeRequest({
      job_numbers: ["SWMS-261020"],
      dry_run: false,
    }),
  );

  const live = ok(normalizeMakesafeStateSeedScopeRequest({
    job_numbers: ["SWMS-261020"],
    dry_run: false,
    run_key: "ses-spine-tranche-1",
  }));
  assertEquals(live.dryRun, false);
  assertEquals(live.runKey, "ses-spine-tranche-1");
});

Deno.test("scoped seed refuses a selection it cannot account for", () => {
  assertEquals(refused(normalizeMakesafeStateSeedScopeRequest({})).status, 400);
  assertEquals(
    refused(normalizeMakesafeStateSeedScopeRequest({ job_numbers: [] })).status,
    400,
  );
  assertEquals(
    refused(normalizeMakesafeStateSeedScopeRequest({ job_numbers: ["  "] }))
      .status,
    400,
  );
  assertEquals(
    refused(normalizeMakesafeStateSeedScopeRequest({ job_numbers: [123] }))
      .status,
    400,
  );
  // A duplicate would make the RPC's distinct-count guard reject the whole
  // array; refuse it here with a message that names the card.
  const duplicate = refused(normalizeMakesafeStateSeedScopeRequest({
    job_numbers: ["SWMS-261020", "SWMS-261020"],
  }));
  assertStringIncludes(duplicate.error, "SWMS-261020");
});

Deno.test("the batch ceiling keeps a tranche from becoming a sweep", () => {
  // ~437 canonical cards: the cap must be far below the board, so reaching it
  // would take many separately authorised, separately ledgered runs.
  assert(MAKESAFE_STATE_SEED_SCOPE_MAX_CARDS < 100);
  const atCap = Array.from(
    { length: MAKESAFE_STATE_SEED_SCOPE_MAX_CARDS },
    (_, index) => `SWMS-2610${String(index).padStart(2, "0")}`,
  );
  assertEquals(
    ok(normalizeMakesafeStateSeedScopeRequest({ job_numbers: atCap }))
      .jobNumbers.length,
    MAKESAFE_STATE_SEED_SCOPE_MAX_CARDS,
  );
  const overCap = refused(normalizeMakesafeStateSeedScopeRequest({
    job_numbers: [...atCap, "SWMS-261999"],
  }));
  assertStringIncludes(overCap.error, "makesafe_state_seed");
});

// ── Scope resolution, including the non-canonical control ─────────────────────

Deno.test("scope resolution partitions every named card exactly once", () => {
  const plan = resolveMakesafeStateSeedScope(
    ["SWMS-261020", "SWMS-999999", "SWMS-261030", "SWMS-261040"],
    [
      {
        id: "job-a",
        job_number: "SWMS-261020",
        type: "makesafe",
        metadata: {},
      },
      {
        id: "job-b",
        job_number: "SWMS-261030",
        type: "insurance",
        metadata: { insurance_job_type: "restoration" },
      },
      { id: "job-c", job_number: "SWMS-261040", type: "fencing", metadata: {} },
    ],
  );
  assertEquals(plan.selected.map((item) => item.job_id), ["job-a", "job-b"]);
  assertEquals(plan.unknown_job_numbers, ["SWMS-999999"]);
  assertEquals(plan.out_of_scope.map((item) => item.job_number), [
    "SWMS-261040",
  ]);
  assertEquals(plan.ambiguous_job_numbers, []);
  assertEquals(
    plan.selected.length + plan.unknown_job_numbers.length +
      plan.out_of_scope.length + plan.ambiguous_job_numbers.length,
    4,
  );
});

Deno.test("two cards on one job number is ambiguity, not a card to pick", () => {
  const plan = resolveMakesafeStateSeedScope(["SWMS-261020"], [
    { id: "job-a", job_number: "SWMS-261020", type: "makesafe", metadata: {} },
    { id: "job-b", job_number: "SWMS-261020", type: "makesafe", metadata: {} },
  ]);
  assertEquals(plan.selected, []);
  assertEquals(plan.ambiguous_job_numbers, ["SWMS-261020"]);
});

// CONTROL 1 — a job that must not be seeded is not seeded.
//
// This control HOLDS ON BOTH SHAPES, and deliberately so. On the old shape it
// held because the RPC's own guard refused a non-canonical job; on the new
// shape the scoped route refuses it before the RPC is reached AND the RPC guard
// is still there behind it. What the new shape adds is that the refusal is
// reported per card instead of being an anonymous skip count.
Deno.test("control: a non-canonical job is never selected for seeding", () => {
  for (
    const row of [
      { id: "j", job_number: "SWMS-1", type: "fencing", metadata: {} },
      { id: "j", job_number: "SWMS-1", type: "patio", metadata: {} },
      {
        id: "j",
        job_number: "SWMS-1",
        type: "insurance",
        metadata: { insurance_job_type: "contents" },
      },
      { id: "j", job_number: "SWMS-1", type: "insurance", metadata: {} },
    ]
  ) {
    assertEquals(isCanonicalSeedScopeJob(row), false, JSON.stringify(row));
    const plan = resolveMakesafeStateSeedScope(["SWMS-1"], [row]);
    assertEquals(plan.selected, []);
    assertEquals(plan.out_of_scope.length, 1);
  }
  // The canonical two, for contrast.
  assert(isCanonicalSeedScopeJob({ type: "makesafe" }));
  assert(
    isCanonicalSeedScopeJob({
      type: "insurance",
      metadata: { insurance_job_type: "restoration" },
    }),
  );
});

// ── Spine diagnostic ──────────────────────────────────────────────────────────

Deno.test("spine_missing_lineage is really a missing source content hash", () => {
  // The exact production shape of the four proof cards on 2026-08-03: one live
  // intake case that HAS a lineage id and an instruction key, but whose
  // source_content_hash was never stamped. Lineage is present; the card is
  // still blocked, because U4 requires all three terms.
  const before = deriveSesSpineFacts({
    job_id: "job-a",
    job_number: "SWMS-261020",
    cases: [{
      state: "confirmed_live_job",
      lineage_id: "case-a",
      instruction_key: "fingerprint:abc/deliverable:wo/cycle:1",
      source_content_hash: null,
    }],
    identity_revision: null,
  });
  assertEquals(before.lineage_id_present, true);
  assertEquals(before.source_instruction_present, true);
  assertEquals(before.source_content_hash_present, false);
  assertEquals(before.spine_complete, false);

  // After the seed the case row carries its stamped hash; nothing else changed.
  const after = deriveSesSpineFacts({
    job_id: "job-a",
    job_number: "SWMS-261020",
    cases: [{
      state: "confirmed_live_job",
      lineage_id: "case-a",
      instruction_key: "fingerprint:abc/deliverable:wo/cycle:1",
      source_content_hash: `sha256:${"a".repeat(64)}`,
    }],
    identity_revision: null,
  });
  assertEquals(after.spine_complete, true);
});

Deno.test("a caseless card is completed by a legacy_job_record revision", () => {
  const before = deriveSesSpineFacts({
    job_id: "job-b",
    job_number: "SWMS-261099",
    cases: [],
    identity_revision: null,
  });
  assertEquals(before.live_case_count, 0);
  assertEquals(before.spine_complete, false);

  const after = deriveSesSpineFacts({
    job_id: "job-b",
    job_number: "SWMS-261099",
    cases: [],
    identity_revision: {
      authority_kind: "legacy_job_record",
      lineage_id: "job-b",
      source_instruction_id: "legacy-job:job-b",
      source_content_hash: `sha256:${"b".repeat(64)}`,
    },
  });
  assertEquals(after.identity_authority_kind, "legacy_job_record");
  assertEquals(after.spine_complete, true);
});

// CONTROL 2 — the ambiguous card the seeder must refuse to resolve.
//
// The producer mints `unresolved_authority` when a job has more than one live
// intake case, and U4 treats that as ABSENT rather than as authority. This
// control HOLDS ON BOTH SHAPES: the refusal lives in the adapter and the RPC,
// neither of which this change touches. It is pinned here because the scoped
// route is what makes the seeder reachable at all, so the thing it must never
// resolve now needs a standing test. Production carried zero such cards on
// 2026-08-03, which is why this is a fixture and not a live card.
Deno.test("control: an ambiguous authority is refused, not resolved", () => {
  const twoLiveCases = deriveSesSpineFacts({
    job_id: "job-c",
    job_number: "SWMS-261098",
    cases: [
      {
        state: "confirmed_live_job",
        lineage_id: "case-x",
        instruction_key: "k-x",
        source_content_hash: `sha256:${"c".repeat(64)}`,
      },
      {
        state: "blocked_live_job",
        lineage_id: "case-y",
        instruction_key: "k-y",
        source_content_hash: `sha256:${"d".repeat(64)}`,
      },
    ],
    identity_revision: null,
  });
  // Two live cases resolve to no source case at all — recorded ambiguity is not
  // authority, so the card stays blocked even though both cases are complete.
  assertEquals(twoLiveCases.live_case_count, 2);
  assertEquals(twoLiveCases.spine_complete, false);

  // Seeding such a card mints `unresolved_authority`, which must not rescue it.
  const seeded = deriveSesSpineFacts({
    job_id: "job-c",
    job_number: "SWMS-261098",
    cases: [
      {
        state: "confirmed_live_job",
        lineage_id: "case-x",
        instruction_key: "k-x",
        source_content_hash: `sha256:${"c".repeat(64)}`,
      },
      {
        state: "blocked_live_job",
        lineage_id: "case-y",
        instruction_key: "k-y",
        source_content_hash: `sha256:${"d".repeat(64)}`,
      },
    ],
    identity_revision: {
      authority_kind: "unresolved_authority",
      lineage_id: "case-x",
      source_instruction_id: "unresolved-job:job-c",
      source_content_hash: `sha256:${"e".repeat(64)}`,
    },
  });
  assertEquals(seeded.identity_authority_kind, "unresolved_authority");
  assertEquals(seeded.spine_complete, false);
});

// ── RPC accounting ────────────────────────────────────────────────────────────

Deno.test("the RPC must answer for the exact selection it was sent", () => {
  assertEquals(
    checkMakesafeStateSeedScopeResult(
      { requested: 4, accounted: 4, seeded: 4, skipped: 0 },
      4,
    ),
    { agrees: true, requested: 4, seeded: 4, skipped: 0, error: null },
  );
  // A silently narrowed run must not read as a clean seed.
  assertEquals(
    checkMakesafeStateSeedScopeResult(
      { requested: 3, accounted: 3, seeded: 3, skipped: 0 },
      4,
    ).agrees,
    false,
  );
  assertEquals(
    checkMakesafeStateSeedScopeResult(
      { requested: 4, accounted: 4, seeded: 3, skipped: 0 },
      4,
    ).agrees,
    false,
  );
  assertEquals(checkMakesafeStateSeedScopeResult(null, 4).agrees, false);
  assertEquals(
    checkMakesafeStateSeedScopeResult({ requested: "4" }, 4).agrees,
    false,
  );
});

Deno.test("the selection contract is versioned and named", () => {
  assertEquals(
    MAKESAFE_STATE_SEED_SCOPE_CONTRACT,
    "makesafe-state-authority-seed-scoped.v1",
  );
  // The full-board contract must stay distinct, so a scoped run's selection
  // hash can never collide with a sweep's.
  assertStringIncludes(indexSource, "makesafe-state-authority-seed.v1");
});
