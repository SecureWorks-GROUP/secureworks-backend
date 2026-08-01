// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  advanceVerdictTable,
  assertNoPiiColumns,
  assertReadOnlySql,
  buildMergeGroups,
  evaluateCensusInvariants,
  parseAccountingFixture,
  parseRound1Fixture,
  parseRound2FieldFixture,
  parseTempFenceFixture,
} from "../ses-ab-certificate-checker.ts";

const ROOT = new URL("../../", import.meta.url);
const FAMILY = "jobs.metadata.makesafe_job_family";

function read(relative: string): Promise<string> {
  return Deno.readTextFile(new URL(relative, ROOT));
}

Deno.test("read-only guard refuses anything that is not a single SELECT", () => {
  assertReadOnlySql("select 1");
  assertReadOnlySql("WITH x as (select 1) select * from x");
  assertThrows(
    () => assertReadOnlySql("update jobs set status = 'x'"),
    Error,
    "does not start with SELECT or WITH",
  );
  assertThrows(
    () => assertReadOnlySql("select 1; delete from jobs"),
    Error,
    "multi-statement",
  );
  assertThrows(
    () => assertReadOnlySql("select 1 /* harmless */ union insert into jobs"),
    Error,
    "write verb insert",
  );
  assertThrows(() => assertReadOnlySql("   "), Error, "empty statement");
});

Deno.test("a write verb cannot hide behind a comment", () => {
  // The comment is stripped, so the trailing DELETE is seen and refused.
  assertThrows(
    () => assertReadOnlySql("select 1 -- ok\n delete from jobs"),
    Error,
    "write verb delete",
  );
  // Conversely a write verb that only appears inside a comment is not a false
  // positive, because the comment is stripped before the scan.
  assertReadOnlySql("select 1 -- we never update here\n");
});

Deno.test("PII guard refuses client-identifying columns", () => {
  assertNoPiiColumns("select job_number, site_suburb from jobs");
  assertThrows(
    () => assertNoPiiColumns("select client_name from jobs"),
    Error,
    "client_name",
  );
  assertThrows(
    () => assertNoPiiColumns("select body_content from emails"),
    Error,
    "body_content",
  );
});

Deno.test("committed fixtures still carry the adjudicated cardinalities", async () => {
  const round1 = parseRound1Fixture(
    await read("scripts/board-safe-fixes-v1.fixture.txt"),
  );
  const field = parseRound2FieldFixture(
    await read("scripts/board-fixes-round2-field.fixture.txt"),
  );
  const tempFence = parseTempFenceFixture(
    await read("scripts/board-fixes-round2-temp-fence.fixture.txt"),
  );
  assertEquals(round1.length, 194);
  assertEquals(field.length, 11);
  assertEquals(tempFence.length, 56);
  assertEquals(round1.filter((row) => row.column === FAMILY).length, 114);
});

Deno.test("the advance model supersedes exactly the 40 round-2 relabelled cards", async () => {
  const round1 = parseRound1Fixture(
    await read("scripts/board-safe-fixes-v1.fixture.txt"),
  );
  const round2Field = parseRound2FieldFixture(
    await read("scripts/board-fixes-round2-field.fixture.txt"),
  );
  const round2TempFence = parseTempFenceFixture(
    await read("scripts/board-fixes-round2-temp-fence.fixture.txt"),
  );
  const result = advanceVerdictTable({
    round1,
    round2Field,
    round2TempFence,
    backfills: [{
      card: "SWMS-26692",
      column: FAMILY,
      after: "temp_fence_makesafe",
      provenance: "swms-26692-backfill",
    }],
    holds: [{
      card: "SWMS-26894",
      column: FAMILY,
      held_value: "general_makesafe",
    }],
  });
  assertEquals(result.superseded_family_cards.length, 40);
  assertEquals(result.expected.length, 216);

  const byCard = new Map(
    result.expected.map((row) => [`${row.card} ${row.column}`, row]),
  );
  // The captain hold wins over the round-2 temp-fence relabel.
  assertEquals(byCard.get(`SWMS-26894 ${FAMILY}`)?.expect, "general_makesafe");
  assertEquals(byCard.get(`SWMS-26894 ${FAMILY}`)?.provenance, "captain-hold");
  // SWMS-26692's family came from the follow-up backfill, not the round-2 pass.
  assertEquals(
    byCard.get(`SWMS-26692 ${FAMILY}`)?.provenance,
    "swms-26692-backfill",
  );
  // A round-1 card that round 2 relabelled ends on the round-2 value.
  assertEquals(
    byCard.get(`AJBR 66933 ${FAMILY}`)?.expect,
    "temp_fence_makesafe",
  );
});

Deno.test("merge groups keep only work orders that resolve to several cards", () => {
  const groups = buildMergeGroups([
    { job_number: "SWMS-1", claim_ref: "MLB-1", po: "1000" },
    { job_number: "SWMS-2", claim_ref: "MLB-1", po: "1000" },
    { job_number: "SWMS-2", claim_ref: "MLB-1", po: "1000" },
    { job_number: "SWMS-3", claim_ref: "MLB-2", po: "2000" },
  ]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].work_order, "MLB-1PO-1000");
  assertEquals(groups[0].cards, ["SWMS-1", "SWMS-2"]);
});

Deno.test("the accounting fixture covers every disposition and validates its rows", async () => {
  const rows = parseAccountingFixture(
    await read("scripts/ses-ab-certificate-v1.duplicate-accounting.txt"),
  );
  assertEquals(rows.length, 21);
  assertEquals(rows.filter((row) => row.era === "historical").length, 17);
  assertEquals(rows.filter((row) => row.era === "drain_minted").length, 4);
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.disposition, (counts.get(row.disposition) ?? 0) + 1);
  }
  assertEquals(counts.get("archived_duplicate_pointer"), 4);
  assertEquals(counts.get("adjudicated_not_duplicate"), 9);
  assertEquals(counts.get("captain_excluded"), 1);
  assertEquals(counts.get("open_hold"), 6);
  assertEquals(counts.get("captain_hold_live_pair"), 1);

  assertThrows(
    () =>
      parseAccountingFixture(
        "MLB-1PO-1 | historical | invented | SWMS-1,SWMS-2 | - | evidence",
      ),
    Error,
    "unknown disposition",
  );
  assertThrows(
    () =>
      parseAccountingFixture(
        "MLB-1PO-1 | historical | open_hold | SWMS-1 | - | evidence",
      ),
    Error,
    "at least two cards",
  );
  // An unruled live pair with no decision key is a hold nobody can close.
  assertThrows(
    () =>
      parseAccountingFixture(
        "MLB-1PO-1 | historical | captain_hold_live_pair | SWMS-1,SWMS-2 | - | evidence",
      ),
    Error,
    "must name a decision key",
  );
});

Deno.test("every unruled live-pair hold names the captain decision key that closes it", async () => {
  const rows = parseAccountingFixture(
    await read("scripts/ses-ab-certificate-v1.duplicate-accounting.txt"),
  );
  const holds = rows.filter((row) =>
    row.disposition === "captain_hold_live_pair"
  );
  // A live pair is the one disposition the checker accounts WITHOUT the group
  // being settled, so it must stay traceable to a ruling that can close it.
  assertEquals(holds.length, 1);
  for (const hold of holds) {
    assertEquals(hold.decision_key, "duplicate-mlb-27100-po-56960-survivor");
    assertEquals(hold.cards.length, 2);
    assertStringIncludes(hold.evidence, "one instruction");
  }
});

Deno.test("the baseline stays consistent with the accounting fixture", async () => {
  const baseline = JSON.parse(
    await read("scripts/ses-ab-certificate-v1.baseline.json"),
  );
  const rows = parseAccountingFixture(
    await read("scripts/ses-ab-certificate-v1.duplicate-accounting.txt"),
  );
  assertEquals(baseline.droid_cross_check.merge_groups_total, rows.length);
  assertEquals(
    baseline.droid_cross_check.merge_groups_historical +
      baseline.droid_cross_check.merge_groups_drain_minted,
    rows.length,
  );
  const declared = Object.values(
    baseline.droid_cross_check.disposition_counts as Record<string, number>,
  ).reduce((total, value) => total + value, 0);
  assertEquals(declared, rows.length);
  assertStringIncludes(
    baseline.phase_a.brief_pre_recovery_census.reconciliation,
    "wo:MLB-27309/po:PO-57445",
  );
});

Deno.test("healthy intake growth satisfies the census invariants", () => {
  const floor = { total: 534, live_job: 157, synthetic: 4 };
  // The exact 2026-08-01 drift that failed the pinned check: three keys
  // promoted exception -> live, total unchanged. Every invariant holds.
  assertEquals(
    evaluateCensusInvariants(floor, {
      total: 534,
      live_job: 160,
      exception_only: 370,
      synthetic: 4,
      unaccounted: 0,
    }),
    {
      unaccounted: 0,
      partition_complete: true,
      keys_lost: 0,
      live_job_regression: 0,
      synthetic: 4,
    },
  );
  // Brand new intake keys are growth too, not a defect.
  const grown = evaluateCensusInvariants(floor, {
    total: 600,
    live_job: 200,
    exception_only: 396,
    synthetic: 4,
    unaccounted: 0,
  });
  assertEquals(grown.keys_lost, 0);
  assertEquals(grown.live_job_regression, 0);
  assertEquals(grown.partition_complete, true);
});

Deno.test("each census invariant still catches the defect it protects", () => {
  const floor = { total: 534, live_job: 157, synthetic: 4 };
  const healthy = {
    total: 534,
    live_job: 160,
    exception_only: 370,
    synthetic: 4,
    unaccounted: 0,
  };
  // Keys destroyed rather than a quiet intake week.
  assertEquals(
    evaluateCensusInvariants(floor, { ...healthy, total: 530, live_job: 156 })
      .keys_lost,
    4,
  );
  // A live job un-bound from its key.
  assertEquals(
    evaluateCensusInvariants(floor, { ...healthy, live_job: 150 })
      .live_job_regression,
    7,
  );
  // A key in no bucket at all.
  assertEquals(
    evaluateCensusInvariants(floor, { ...healthy, unaccounted: 2 }).unaccounted,
    2,
  );
  // Buckets that do not sum to the total: the census is not a partition.
  assertEquals(
    evaluateCensusInvariants(floor, { ...healthy, exception_only: 369 })
      .partition_complete,
    false,
  );
  // Live-fire residue must surface rather than be absorbed as growth.
  assertEquals(
    evaluateCensusInvariants(floor, { ...healthy, synthetic: 5, total: 535 })
      .synthetic,
    5,
  );
});

Deno.test("the identity-key census states invariants, not pinned counts", async () => {
  const baseline = JSON.parse(
    await read("scripts/ses-ab-certificate-v1.baseline.json"),
  );
  // a3/a4 previously pinned the exact census and so failed on healthy intake
  // growth. The recorded numbers are now a floor; the rule text is what keeps a
  // future maintainer from "fixing" a failure by re-pinning them.
  const rule = baseline.phase_a.identity_key_census_rule as string;
  assertStringIncludes(rule, "FLOOR");
  assertStringIncludes(rule, "Do not re-pin them");
  // The floor itself must stay a real certified observation.
  assertEquals(baseline.phase_a.live_case_without_job, 0);
  assertEquals(baseline.phase_a.dangling_job_ids, 0);
  assertEquals(baseline.phase_a.identity_keys_with_two_live_case_bound_jobs, 0);
});

Deno.test("the work-order identity rule states an invariant, not an observation", async () => {
  const baseline = JSON.parse(
    await read("scripts/ses-ab-certificate-v1.baseline.json"),
  );
  // The captain's rule is that a blank or absent work-order identity is
  // impossible. The expected unexcepted count must stay 0: raising it to match
  // production would certify an unadjudicated defect as a fact. A new offender
  // is adjudicated into card_work_order_identity_exceptions instead.
  assertEquals(baseline.phase_b.cards_without_work_order_identity, 0);
  assertStringIncludes(
    baseline.phase_b.card_work_order_identity_rule,
    "never raise the number",
  );
});

Deno.test("every work-order identity exception is named and convertible", async () => {
  const baseline = JSON.parse(
    await read("scripts/ses-ab-certificate-v1.baseline.json"),
  );
  const exceptions = baseline.phase_b
    .card_work_order_identity_exceptions as Record<string, string>[];
  assertEquals(exceptions.length, 1);
  const [swms26001] = exceptions;
  assertEquals(swms26001.card, "SWMS-26001");
  assertEquals(swms26001.decision_key, "swms-26001-work-order-identity");
  assertEquals(swms26001.ruled_at, "2026-08-01");
  // Every exception must carry a reason and the path back to a real backfill,
  // so the carve-out can never become permanent by default.
  for (const row of exceptions) {
    assertStringIncludes(row.reason, "identity floor");
    assertStringIncludes(row.conversion_path, "remove this entry");
  }
});
