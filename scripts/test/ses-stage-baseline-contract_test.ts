// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSesStageBaseline,
  type ParityHarnessCard,
  type ParityHarnessOutput,
  SES_STAGE_BASELINE_CONTRACT_VERSION,
  sesStageCardInputHash,
  verifySesStageBaseline,
} from "../ses-stage-baseline-contract.ts";

const FROZEN_BASELINE = new URL(
  "../ses-e1-stage-baseline-v1.json",
  import.meta.url,
);

function card(over: Partial<ParityHarnessCard> = {}): ParityHarnessCard {
  return {
    job_ref: "SWMS-1",
    job_id: "job-1",
    job_status: "in_progress",
    substatus: null,
    company_slug: "mlb",
    report_type: null,
    ses_family: "physical_makesafe",
    legacy_stage: "allocated",
    legacy_canonical_stage: "allocated",
    m1_published: "allocated",
    m1_pure: "allocated",
    post_cutover_stage: "allocated",
    post_cutover_overlay_binds: false,
    overlay: {
      present: false,
      binds_today: false,
      source_status: null,
      after_status: null,
    },
    facts: { assignments: 1, photo_count: 0 },
    legacy_branch: "13522 allocated: assignment row exists",
    divergence_cause: "agree",
    ...over,
  };
}

function parity(cards: ParityHarnessCard[]): ParityHarnessOutput {
  return {
    computed_at: "2026-08-02T00:00:00.000Z",
    population_contract_version: "ses-board-population/active-v1",
    population_contract: "active-v1 (test)",
    board_cards: cards.length,
    summary: {
      legacy_canonical_column_counts: {},
      m1_pure_column_counts: {},
      post_cutover_column_counts: {},
      cards_changing_column_m1_pure_vs_legacy_canonical: 0,
      cards_changing_column_after_cutover_with_overlays_reapplied:
        cards.filter((c) => c.legacy_canonical_stage !== c.post_cutover_stage)
          .length,
      overlays_total: 0,
      overlays_binding_today: 0,
      overlays_binding_today_that_would_unbind: 0,
    },
    cards,
  };
}

Deno.test("generation_id is content-derived, so a rerun over unchanged state reproduces it", async () => {
  const a = await buildSesStageBaseline(parity([card()]));
  const b = await buildSesStageBaseline({
    ...parity([card()]),
    // A different wall clock must NOT change the id — that is the whole point.
    computed_at: "2026-09-09T09:09:09.000Z",
  });
  assertEquals(a.generation_id, b.generation_id);
  assert(a.snapshot_at !== b.snapshot_at);
});

Deno.test("read order cannot change the generation id", async () => {
  const one = card({ job_id: "job-1", job_ref: "SWMS-1" });
  const two = card({ job_id: "job-2", job_ref: "SWMS-2" });
  const forward = await buildSesStageBaseline(parity([one, two]));
  const reverse = await buildSesStageBaseline(parity([two, one]));
  assertEquals(forward.generation_id, reverse.generation_id);
  assertEquals(forward.disputed_manifest_id, reverse.disputed_manifest_id);
});

Deno.test("the per-card hash covers card inputs, never either engine's verdict", async () => {
  const base = card();
  const reStaged = card({
    // Every engine output moves; not one input fact does.
    legacy_stage: "report_ready",
    legacy_canonical_stage: "report_ready",
    m1_published: "completed",
    m1_pure: "archive",
    post_cutover_stage: "archive",
    divergence_cause: "something else entirely",
    legacy_branch: "13519 invoiceDone",
  });
  assertEquals(
    await sesStageCardInputHash(base),
    await sesStageCardInputHash(reStaged),
  );

  const movedFacts = card({ facts: { assignments: 2, photo_count: 0 } });
  assert(
    await sesStageCardInputHash(base) !==
      await sesStageCardInputHash(movedFacts),
  );
});

Deno.test("only cards whose column would change after a cutover enter the manifest", async () => {
  const baseline = await buildSesStageBaseline(parity([
    card({ job_id: "a", job_ref: "SWMS-A" }),
    card({
      job_id: "b",
      job_ref: "SWMS-B",
      legacy_canonical_stage: "archive",
      m1_pure: "completed",
      post_cutover_stage: "completed",
    }),
  ]));
  assertEquals(baseline.disputed.length, 1);
  assertEquals(baseline.disputed[0].job_ref, "SWMS-B");
  assertEquals(baseline.disputed[0].current, "archive");
  assertEquals(baseline.disputed[0].post_cutover, "completed");
});

Deno.test("verify fails when a certified card leaves the population", async () => {
  const frozen = await buildSesStageBaseline(parity([
    card({ job_id: "a", job_ref: "SWMS-A" }),
    card({ job_id: "b", job_ref: "SWMS-B" }),
  ]));
  const fresh = await buildSesStageBaseline(
    parity([card({ job_id: "a", job_ref: "SWMS-A" })]),
  );
  const result = verifySesStageBaseline(frozen, fresh);
  assertEquals(result.ok, false);
  assert(result.failures.some((f) => f.includes("SWMS-B")));
});

Deno.test("verify fails when a certified adjudication changes", async () => {
  const disputed = card({
    job_id: "b",
    job_ref: "SWMS-B",
    legacy_canonical_stage: "archive",
    post_cutover_stage: "completed",
  });
  const frozen = await buildSesStageBaseline(parity([disputed]));
  const fresh = await buildSesStageBaseline(parity([
    { ...disputed, post_cutover_stage: "allocated" },
  ]));
  const result = verifySesStageBaseline(frozen, fresh);
  assertEquals(result.ok, false);
  assertEquals(result.disputed_changed.length, 1);
  assertEquals(result.disputed_changed[0].fresh, "archive -> allocated");
});

Deno.test("verify fails when a certified card stops being disputed", async () => {
  const disputed = card({
    job_id: "b",
    job_ref: "SWMS-B",
    legacy_canonical_stage: "archive",
    post_cutover_stage: "completed",
  });
  const frozen = await buildSesStageBaseline(parity([disputed]));
  const fresh = await buildSesStageBaseline(
    parity([{ ...disputed, post_cutover_stage: "archive" }]),
  );
  const result = verifySesStageBaseline(frozen, fresh);
  assertEquals(result.ok, false);
  assertEquals(result.disputed_missing, ["SWMS-B"]);
});

Deno.test("growth above the frozen floor is reported, never failed", async () => {
  const frozen = await buildSesStageBaseline(
    parity([card({ job_id: "a", job_ref: "SWMS-A" })]),
  );
  const fresh = await buildSesStageBaseline(parity([
    card({ job_id: "a", job_ref: "SWMS-A" }),
    card({
      job_id: "c",
      job_ref: "SWMS-C",
      legacy_canonical_stage: "archive",
      post_cutover_stage: "new",
    }),
  ]));
  const result = verifySesStageBaseline(frozen, fresh);
  assertEquals(result.ok, true);
  assertEquals(result.disputed_added, ["SWMS-C"]);
  assert(result.observations.some((o) => o.includes("SWMS-C")));
});

Deno.test("a moved input hash is an observation, not a failure", async () => {
  const frozen = await buildSesStageBaseline(
    parity([card({ job_id: "a", job_ref: "SWMS-A" })]),
  );
  const fresh = await buildSesStageBaseline(parity([
    card({ job_id: "a", job_ref: "SWMS-A", facts: { assignments: 3 } }),
  ]));
  const result = verifySesStageBaseline(frozen, fresh);
  assertEquals(result.ok, true);
  assertEquals(result.cards_with_moved_input_hash, ["SWMS-A"]);
});

Deno.test("a different denominator is refused rather than compared", async () => {
  const frozen = await buildSesStageBaseline(parity([card()]));
  const fresh = await buildSesStageBaseline({
    ...parity([card()]),
    population_contract_version: "ses-board-population/all-v2",
  });
  const result = verifySesStageBaseline(frozen, fresh);
  assertEquals(result.ok, false);
  assert(result.failures.some((f) => f.includes("denominator")));
});

Deno.test("population prose drift is observed while version drift still fails", async () => {
  const frozen = await buildSesStageBaseline(parity([card()]));
  const fresh = await buildSesStageBaseline({
    ...parity([card()]),
    population_contract: "active-v1 (reworded test)",
  });
  const proseResult = verifySesStageBaseline(frozen, fresh);
  assertEquals(proseResult.ok, true);
  assert(
    proseResult.observations.some((observation) =>
      observation.includes("active-v1 (test)") &&
      observation.includes("active-v1 (reworded test)")
    ),
  );

  const versionResult = verifySesStageBaseline(frozen, {
    ...fresh,
    population_contract_version: "ses-board-population/active-v2",
  });
  assertEquals(versionResult.ok, false);
  assert(
    versionResult.failures.some((failure) => failure.includes("denominator")),
  );
});

// ── The committed Release 0 artifact itself ─────────────────────────────────
// These assertions pin the FROZEN file, not a live read, so they run offline
// and fail loudly if anyone edits the baseline to make a drifted run green.

Deno.test("the committed Release 0 baseline is the certified 71-card manifest", async () => {
  const frozen = JSON.parse(await Deno.readTextFile(FROZEN_BASELINE));
  assertEquals(frozen.contract_version, SES_STAGE_BASELINE_CONTRACT_VERSION);
  assertEquals(
    frozen.population_contract_version,
    "ses-board-population/active-v1",
  );
  assertEquals(frozen.board_cards, 407);
  assertEquals(frozen.cards.length, 407);
  assertEquals(frozen.disputed.length, 71);
  assertEquals(
    frozen.counts.cards_changing_column_after_cutover_with_overlays_reapplied,
    71,
  );
  assertEquals(
    frozen.counts.cards_changing_column_m1_pure_vs_legacy_canonical,
    104,
  );
  assertEquals(frozen.counts.overlays_total, 46);
  assertEquals(frozen.counts.overlays_binding_today, 42);
  assertEquals(frozen.counts.overlays_binding_today_that_would_unbind, 9);
});

Deno.test("the frozen transition histogram is the design's adjudicated split", async () => {
  const frozen = JSON.parse(await Deno.readTextFile(FROZEN_BASELINE));
  const histogram: Record<string, number> = {};
  for (const row of frozen.disputed) {
    const key = `${row.current} -> ${row.post_cutover}`;
    histogram[key] = (histogram[key] || 0) + 1;
  }
  // data/ses-f10-stage-engine-v2-design-v1/report.md section 4, causes G1-G8.
  assertEquals(histogram, {
    "archive -> completed": 34, // G1 — no seven-day clock on the terminal path
    "report_ready -> allocated": 23, // G2 (17) + G3 (6)
    "trade_report_in -> completed": 2, // G4 — terminal shortcut beats evidence
    "report_ready -> completed": 1, // G4 — SWMS-261059, unadjudicated
    "trade_report_in -> allocated": 2, // G5 — screenshot floor
    "archive -> new": 2, // G6 — captain archive overlay unbinds
    "archive -> allocated": 4, // G6 (3) + G7 (1)
    "archive -> trade_report_in": 1, // G7
    "allocated -> new": 2, // G8 — all-cancelled assignments
  });
});

Deno.test("the frozen manifest carries the three captain-visible cohorts", async () => {
  const frozen = JSON.parse(await Deno.readTextFile(FROZEN_BASELINE));
  const byRef = new Map<string, any>(
    frozen.disputed.map((row: any) => [row.job_ref, row]),
  );
  // The five captain archive rulings held only by a display overlay.
  for (
    const ref of [
      "SWMS-261124",
      "SWMS-26651",
      "SWMS-26782",
      "SWMS-26791",
      "SWMS-26855",
    ]
  ) {
    const row = byRef.get(ref);
    assert(row, `${ref} must be in the frozen manifest`);
    assertEquals(row.current, "archive");
    assertEquals(row.overlay_binds_today, true);
    assertEquals(
      row.post_cutover_overlay_binds,
      false,
      `${ref}'s overlay must be recorded as unbinding after a derivation change`,
    );
  }
  // The three raw-terminal cards with no issued invoice (design C2).
  for (const ref of ["SWMS-261024", "SWMS-261025", "SWMS-261059"]) {
    assertEquals(byRef.get(ref)?.post_cutover, "completed");
  }
  // The unadjudicated card must never be recorded as resolved here.
  assertEquals(byRef.get("SWMS-261059")?.current, "report_ready");
});
