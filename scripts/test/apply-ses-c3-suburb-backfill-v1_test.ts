// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  type CardStage,
  deriveSuburb,
  evaluateCard,
  FIXTURE,
  type FixtureRow,
  type LiveCard,
  parseMode,
  stageUnchanged,
  titleCaseSuburb,
  UsageError,
} from "../apply-ses-c3-suburb-backfill-v1.ts";

const STAGE: CardStage = {
  job_status: "accepted",
  substatus: null,
  detail_computed_status: "allocated",
  latest_status_application: null,
};

function liveFor(
  row: FixtureRow,
  overrides: Partial<LiveCard> = {},
): LiveCard {
  return {
    card: row.card,
    jobId: row.jobId,
    siteAddress: `10 Example Street${row.sourceTail}`,
    siteSuburb: null,
    caseId: row.caseId,
    caseAddress: null,
    stage: { ...STAGE },
    ...overrides,
  };
}

Deno.test("the fixture is the closed 2026-08-01 blank-suburb board set", () => {
  assertEquals(FIXTURE.length, 30);
  assertEquals(FIXTURE.filter((row) => row.suburb !== "").length, 29);
  const skips = FIXTURE.filter((row) => row.suburb === "");
  assertEquals(skips.map((row) => row.card), ["SWMS-261124"]);
  // Card and job id are both unique, so no card can be written twice.
  assertEquals(new Set(FIXTURE.map((row) => row.card)).size, 30);
  assertEquals(new Set(FIXTURE.map((row) => row.jobId)).size, 30);
  // The committed source quote is suburb-and-postcode only: no street data.
  for (const row of FIXTURE.filter((r) => r.suburb !== "")) {
    assert(
      /^,\s*[A-Za-z][A-Za-z' -]*?\s*,?\s*WA\s+\d{4}$/i.test(row.sourceTail),
      `${row.card} source quote is not a bare suburb/postcode tail`,
    );
    assert(!/\d+\s/.test(row.sourceTail), `${row.card} quote has a number`);
  }
});

Deno.test("every fixture suburb is what its own source quote derives", () => {
  for (const row of FIXTURE.filter((r) => r.suburb !== "")) {
    const derived = deriveSuburb(`10 Example Street${row.sourceTail}`);
    assert(derived, `${row.card} did not derive`);
    assertEquals(derived.suburb, row.suburb, row.card);
    assertEquals(derived.sourceTail, row.sourceTail.trim(), row.card);
  }
});

Deno.test("derivation handles the two shapes the in-repo helper misses", () => {
  // Street parts are synthetic; the punctuation shapes are the real production
  // ones these three cards carry.
  // A comma between suburb and WA — SWMS-261022's shape.
  assertEquals(
    deriveSuburb("12 Example Blv, Helena Valley, WA 6056")?.suburb,
    "Helena Valley",
  );
  // A trailing country — SWMS-26393's shape.
  assertEquals(
    deriveSuburb("12 Example Mews, Beeliar WA 6164, Australia")?.suburb,
    "Beeliar",
  );
  // A stray space before the comma — SWMS-261088's shape.
  assertEquals(
    deriveSuburb("21 EXAMPLE HEIGHTS , BALLAJURA WA 6066")?.suburb,
    "Ballajura",
  );
});

Deno.test("derivation refuses an address with no locatable suburb", () => {
  assertEquals(
    deriveSuburb("Legacy backfill - site evidence unavailable"),
    null,
  );
  assertEquals(deriveSuburb(""), null);
  assertEquals(deriveSuburb("   "), null);
  // No state/postcode terminator: nothing to anchor the suburb against.
  assertEquals(deriveSuburb("12 Somewhere Road, Nowhere"), null);
  // An interstate address must not be mined by a WA-anchored rule.
  assertEquals(deriveSuburb("5 Test Street, Richmond VIC 3121"), null);
});

Deno.test("title casing normalises to the house shape without inventing text", () => {
  assertEquals(titleCaseSuburb("CANNING VALE"), "Canning Vale");
  assertEquals(titleCaseSuburb("east bunbury"), "East Bunbury");
  assertEquals(titleCaseSuburb("Helena Valley"), "Helena Valley");
  // Only case changes: word count and order are preserved.
  for (const value of ["ALEXANDER HEIGHTS", "bennett springs"]) {
    assertEquals(
      titleCaseSuburb(value).toLowerCase(),
      value.toLowerCase(),
    );
  }
});

Deno.test("a blank-suburb card with a derivable address is filled", () => {
  const row = FIXTURE.find((r) => r.card === "SWMS-261064")!;
  const decision = evaluateCard(row, liveFor(row));
  assertEquals(decision.action, "fill");
  assert(decision.action === "fill");
  assertEquals(decision.suburb, "Dianella");
  assertEquals(decision.sourceTail, ", Dianella WA 6059");
});

Deno.test("a populated suburb is never overwritten", () => {
  const row = FIXTURE.find((r) => r.card === "SWMS-261064")!;
  const decision = evaluateCard(
    row,
    liveFor(row, { siteSuburb: "Somewhere Else" }),
  );
  assertEquals(decision.action, "skip");
  assert(decision.action === "skip");
  assert(decision.reason.startsWith("already_populated"));
});

Deno.test("the evidence-absent card is skipped, not guessed", () => {
  const row = FIXTURE.find((r) => r.card === "SWMS-261124")!;
  const decision = evaluateCard(
    row,
    liveFor(row, {
      siteAddress: "Legacy backfill - site evidence unavailable",
    }),
  );
  assertEquals(decision.action, "skip");
  assert(decision.action === "skip");
  assertEquals(decision.reason, "no_locatable_suburb_in_source");
});

Deno.test("production is the data source; the fixture only authorises", () => {
  const row = FIXTURE.find((r) => r.card === "SWMS-261064")!;
  // The live address now names a different suburb than the adjudicated one.
  const drifted = evaluateCard(
    row,
    liveFor(row, { siteAddress: "10 Example Street, Morley WA 6062" }),
  );
  assertEquals(drifted.action, "refuse");
  assert(drifted.action === "refuse");
  assert(drifted.reason.includes("Morley"));

  // A card whose address lost its suburb entirely is a refusal, not a skip:
  // the fixture said there was one.
  const lost = evaluateCard(row, liveFor(row, { siteAddress: "unknown" }));
  assertEquals(lost.action, "refuse");
  assert(lost.action === "refuse");
  assertEquals(lost.reason, "fixture_expected_a_suburb");

  // The skip card gaining an address is equally a refusal: it needs re-planning.
  const skipRow = FIXTURE.find((r) => r.card === "SWMS-261124")!;
  const gained = evaluateCard(
    skipRow,
    liveFor(skipRow, { siteAddress: "1 New Road, Morley WA 6062" }),
  );
  assertEquals(gained.action, "refuse");
});

Deno.test("a disagreeing intake case address blocks the write", () => {
  const row = FIXTURE.find((r) => r.card === "SWMS-261064")!;
  const agrees = evaluateCard(
    row,
    liveFor(row, { caseAddress: "10 Example Street, Dianella WA 6059" }),
  );
  assertEquals(agrees.action, "fill");

  const disagrees = evaluateCard(
    row,
    liveFor(row, { caseAddress: "10 Example Street, Morley WA 6062" }),
  );
  assertEquals(disagrees.action, "refuse");
  assert(disagrees.action === "refuse");
  assertEquals(disagrees.reason, "intake_case_address_disagrees");
});

Deno.test("a disagreeing intake case identity blocks the write", () => {
  const row = FIXTURE.find((r) => r.card === "SWMS-261064")!;
  const matching = evaluateCard(row, liveFor(row));
  assertEquals(matching.action, "fill");

  const repointed = evaluateCard(
    row,
    liveFor(row, { caseId: "00000000-0000-4000-8000-000000000000" }),
  );
  assertEquals(repointed.action, "refuse");
  assert(repointed.action === "refuse");
  assertEquals(repointed.reason, "intake_case_identity_drift");

  const vanished = evaluateCard(row, liveFor(row, { caseId: null }));
  assertEquals(vanished.action, "refuse");
  assert(vanished.action === "refuse");
  assertEquals(vanished.reason, "intake_case_identity_drift");

  const appearedRow = { ...row, caseId: null };
  const appeared = evaluateCard(
    appearedRow,
    liveFor(appearedRow, { caseId: "00000000-0000-4000-8000-000000000000" }),
  );
  assertEquals(appeared.action, "refuse");
  assert(appeared.action === "refuse");
  assertEquals(appeared.reason, "intake_case_identity_drift");
});

Deno.test("an unreadable or re-pointed card is refused", () => {
  const row = FIXTURE.find((r) => r.card === "SWMS-261064")!;
  assertEquals(evaluateCard(row, null).action, "refuse");
  const moved = evaluateCard(
    row,
    liveFor(row, { jobId: "00000000-0000-4000-8000-000000000000" }),
  );
  assertEquals(moved.action, "refuse");
  assert(moved.action === "refuse");
  assertEquals(moved.reason, "job_id_drift");
});

Deno.test("the stage guard notices any board-shape movement", () => {
  assertEquals(stageUnchanged(STAGE, { ...STAGE }), true);
  for (
    const key of [
      "job_status",
      "substatus",
      "detail_computed_status",
      "latest_status_application",
    ] as const
  ) {
    assertEquals(
      stageUnchanged(STAGE, { ...STAGE, [key]: "moved" }),
      false,
      key,
    );
  }
});

Deno.test("--mode accepts only the three modes", () => {
  assertEquals(parseMode("dry-run"), "dry-run");
  assertEquals(parseMode("apply"), "apply");
  assertEquals(parseMode("verify"), "verify");
  assertThrows(() => parseMode(null), UsageError);
  assertThrows(() => parseMode("measure"), UsageError);
});
