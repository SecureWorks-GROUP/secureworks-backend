// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFieldUpdateSql,
  buildLinkInsertSql,
  evaluateField,
  evaluateLinks,
  parseFieldFixture,
  parseLinkFixture,
  parseLinkSourceFixture,
  parseTempFenceFixture,
} from "../apply-board-fixes-round2-v1.ts";

const ROOT = new URL("../../", import.meta.url);

Deno.test("round-2 fixtures preserve the adjudicated cardinalities", async () => {
  const fields = parseFieldFixture(
    await Deno.readTextFile(
      new URL("scripts/board-fixes-round2-field.fixture.txt", ROOT),
    ),
  );
  const linkSourceText = await Deno.readTextFile(
    new URL("scripts/board-fixes-round2-link-sources.fixture.txt", ROOT),
  );
  const links = parseLinkFixture(
    await Deno.readTextFile(
      new URL("scripts/board-fixes-round2-links.fixture.txt", ROOT),
    ),
    linkSourceText,
  );
  const linkSources = parseLinkSourceFixture(linkSourceText);
  const tempFence = parseTempFenceFixture(
    await Deno.readTextFile(
      new URL("scripts/board-fixes-round2-temp-fence.fixture.txt", ROOT),
    ),
  );
  assertEquals(fields.length, 11);
  assertEquals(
    links.filter((row) => row.fixture_class === "exact_reference_existing_job")
      .length,
    246,
  );
  assertEquals(
    links.filter((row) => row.fixture_class === "recovered_orphan_source")
      .length,
    43,
  );
  assertEquals(linkSources.length, 246);
  assertEquals(tempFence.length, 56);
  assert(!tempFence.some((row) => row.card === "SWMS-26894"));
});

Deno.test("a deferred temp-fence target the class does not cover is reported, not hidden", () => {
  // SWMS-26692's regression: the safe-field pass deferred it with
  // `handled_by_temp_fence_class`, but it is absent from the temp-fence
  // fixture, so nothing applied it and the family stayed NULL. When coverage
  // is known and the card is missing from it, the reason must say so.
  const fixture = {
    card: "SWMS-26692",
    column: "jobs.metadata.makesafe_job_family" as const,
    before: null,
    after: "temp_fence_makesafe",
    rationale: "fixture",
    evidence: "sha256:test",
  };
  const jobs = [{
    id: "00000000-0000-4000-8000-000000000002",
    job_number: "SWMS-26692",
    type: "makesafe",
    status: "archived",
    metadata: {},
  }];
  const details = [{
    job_id: "00000000-0000-4000-8000-000000000002",
    external_ref: "BWCWA6771",
    report_type: null,
    requesting_company_slug: "bw",
  }];

  const uncovered = evaluateField(
    fixture,
    jobs,
    details,
    false,
    "safe-field",
    new Set<string>(["SWMS-26893"]),
  );
  assertEquals(uncovered.eligible, false);
  assertEquals(uncovered.reason, "temp_fence_target_not_in_class");

  // A card the class genuinely covers keeps the original deferral.
  const covered = evaluateField(
    fixture,
    jobs,
    details,
    false,
    "safe-field",
    new Set<string>(["SWMS-26692"]),
  );
  assertEquals(covered.reason, "handled_by_temp_fence_class");

  // The captain hold outranks coverage bookkeeping either way.
  const held = evaluateField(
    { ...fixture, card: "SWMS-26894" },
    [{ ...jobs[0], job_number: "SWMS-26894" }],
    details,
    false,
    "safe-field",
    new Set<string>(),
  );
  assertEquals(held.reason, "captain_hold_temp_fence");
});

Deno.test("temp-fence relabel requires explicit umpire-class authority", () => {
  const result = evaluateField(
    {
      card: "SWMS-26893",
      column: "jobs.metadata.makesafe_job_family",
      before: "general_makesafe",
      after: "temp_fence_makesafe",
      rationale: "fixture",
      evidence: "sha256:test",
    },
    [{
      id: "00000000-0000-4000-8000-000000000001",
      job_number: "SWMS-26893",
      type: "makesafe",
      status: "processing",
      metadata: { makesafe_job_family: "general_makesafe" },
    }],
    [{
      job_id: "00000000-0000-4000-8000-000000000001",
      external_ref: "MLB-1",
      report_type: null,
      requesting_company_slug: "mlb",
    }],
  );
  assertEquals(result.eligible, false);
  assertEquals(result.reason, "handled_by_temp_fence_class");

  const umpireResult = evaluateField(
    {
      card: "SWMS-26893",
      column: "jobs.metadata.makesafe_job_family",
      before: "general_makesafe",
      after: "temp_fence_makesafe",
      rationale: "fixture",
      evidence: "sha256:test",
    },
    [{
      id: "00000000-0000-4000-8000-000000000001",
      job_number: "SWMS-26893",
      type: "makesafe",
      status: "processing",
      metadata: { makesafe_job_family: "general_makesafe" },
    }],
    [{
      job_id: "00000000-0000-4000-8000-000000000001",
      external_ref: "MLB-1",
      report_type: null,
      requesting_company_slug: "mlb",
    }],
    true,
    "temp-fence",
  );
  assertEquals(umpireResult.eligible, true);
  assertEquals(umpireResult.board_kind_before, umpireResult.board_kind_after);
});

Deno.test("re-mint orphan findings remain outside the additive binding lane", () => {
  const fixtures = parseLinkFixture([
    "# Class: recovered_orphan_source (43 cards, source post hash per card)",
    "SWMS-26440 | SOURCE_FOUND | ref_digits | source:034ac9891ab66ea5 d=2026-06-02 from=ajs.build in=1/3 fields=subject,pdf | link_row_missing:source_case_already_carries_job_SWMS-261095 (re-mint supersession)",
    ...Array.from(
      { length: 42 },
      (_, index) =>
        `ORPHAN-${index} | SOURCE_FOUND | ref_full | source:${
          String(index).padStart(8, "0")
        }1ab66ea5 d=2026-06-02 from=builder in=1/1 fields=subject | link_row_missing:source_case_still_open_as_exception/conflicting_fields`,
    ),
    ...Array.from(
      { length: 246 },
      (_, index) =>
        `instruction:${
          String(index).padStart(8, "0")
        }68a45907 | codex:live_instruction_has_no_durable_job | ADJUDICATED_FALSE:job_exists_link_missing | ledger_ref=MLB-${index} board_job=SWMS-${index} status=processing job_created=2026-07-01 first_source=2026-07-01 reason=adapter_parse_failure match=exact_ref`,
    ),
  ].join("\n"));
  const result = evaluateLinks({
    fixtures: [fixtures[0]],
    jobs: [],
    details: [],
    cases: [],
    sources: [],
    sourceJobLinks: [],
  });
  assertEquals(result[0].eligible, false);
  assertEquals(
    result[0].reason,
    "scope_excluded_remint_supersession_captain_pile",
  );
});

Deno.test("exact-reference link uses the replay-proven primary source coordinate", () => {
  const fixture = {
    fixture_class: "exact_reference_existing_job" as const,
    fixture_key: "instruction:495d02870ec6d377",
    instruction_hash: "495d02870ec6d377",
    external_ref: "MLB-24664",
    job_number: "SWMS-26931",
    match_key: "exact_ref",
    source_hashes: ["e1c30d9c404ba46d", "c3d09f10404ba46d"],
    instruction_source_count: 2,
  };
  const instructionKey = "fixture-instruction";
  const result = evaluateLinks({
    fixtures: [fixture],
    jobs: [{
      id: "00000000-0000-4000-8000-000000000031",
      job_number: "SWMS-26931",
      type: "insurance",
      status: "accepted",
      metadata: {},
    }],
    details: [{
      job_id: "00000000-0000-4000-8000-000000000031",
      external_ref: "MLB-24664",
      report_type: null,
      requesting_company_slug: "mlb",
    }],
    cases: [{
      id: "00000000-0000-4000-8000-000000000041",
      instruction_key: instructionKey,
      state: "exception",
      reason_code: "conflicting_fields",
      job_id: null,
      external_ref_canonical: "MLB-24664",
      wo_po_identity_key: "wo:MLB-24664",
    }],
    sources: [
      {
        id: "s2",
        case_id: "00000000-0000-4000-8000-000000000041",
        post_id: "post-later",
        received_at: "2026-07-04T00:00:00Z",
      },
      {
        id: "s1",
        case_id: "00000000-0000-4000-8000-000000000041",
        post_id: "post-first",
        received_at: "2026-07-03T00:00:00Z",
      },
    ],
    sourceJobLinks: [],
  });
  assertEquals(result[0].source_post_id, "post-first");
  assertEquals(result[0].source_count, 2);
  assertEquals(result[0].eligible, true);
});

Deno.test("field SQL is compare-and-set and field-scoped", () => {
  const sql = buildFieldUpdateSql({
    fixture_key: "field:BWCWA6773",
    card: "BWCWA6773",
    column: "jobs.metadata.makesafe_job_family",
    expected_before: null,
    observed_before: null,
    after: "general_makesafe",
    job_id: "00000000-0000-4000-8000-000000000001",
    board_kind_before: "physical_makesafe",
    board_kind_after: "physical_makesafe",
    eligible: true,
    reason: null,
  });
  assertStringIncludes(sql, "IS NOT DISTINCT FROM NULL");
  assertStringIncludes(sql, "jsonb_set");
  assert(
    !/UPDATE public\.(makesafe_job_details|makesafe_intake_cases|makesafe_intake_drafts)/i
      .test(sql),
  );
});

Deno.test("link SQL is additive, provenance-bearing, and never mutates operational rows", () => {
  const sql = buildLinkInsertSql([{
    fixture_class: "exact_reference_existing_job",
    fixture_key: "instruction:test",
    source_post_id: "post-1",
    target_job_id: "00000000-0000-4000-8000-000000000001",
    target_job_number: "SWMS-1",
    expected_identity_key: "wo:MLB-1",
    match_key: "exact_ref",
    eligible: true,
    already_applied: false,
    reason: null,
  }]);
  assertStringIncludes(
    sql,
    "INSERT INTO public.makesafe_source_job_links",
  );
  assertStringIncludes(sql, "data/ses-shadow-adjudicate-v1/report.md");
  assertStringIncludes(sql, "'match_key'");
  assertStringIncludes(
    sql,
    "ON CONFLICT (org_id, source_post_id, job_id) DO NOTHING",
  );
  assert(!sql.includes("makesafe_intake_source_authority_corrections"));
  assert(!/\b(UPDATE|DELETE)\b/i.test(sql));
  assert(
    !/INSERT INTO public\.(jobs|makesafe_intake_drafts|makesafe_intake_cases|job_assignments)/i
      .test(sql),
  );
});

Deno.test("source-job link migration is append-only and authority-independent", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "supabase/migrations/20260801000001_makesafe_source_job_links.sql",
      ROOT,
    ),
  );
  assertStringIncludes(sql, "CREATE TABLE public.makesafe_source_job_links");
  assertStringIncludes(sql, "UNIQUE (org_id, source_post_id, job_id)");
  assertStringIncludes(
    sql,
    "EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation()",
  );
  assert(!sql.includes("makesafe_intake_source_authority_corrections"));
  assert(
    !sql.includes("makesafe_intake_source_authority_correction_supersessions"),
  );
});
