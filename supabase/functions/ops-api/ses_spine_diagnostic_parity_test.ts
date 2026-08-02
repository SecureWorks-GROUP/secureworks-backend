// deno-lint-ignore-file no-import-prefix
//
// `deriveSesSpineFacts` is a REPORTING mirror of the identity terms U4 actually
// reads. A mirror that drifts is worse than no mirror, so this suite drives the
// REAL adapter (`buildSesAssemblerInput`) over a real production-shaped
// snapshot and asserts the mirror agrees with it — not with a stub of it.
//
// The snapshot fixture is the live SWMS-26980 card, which carries no intake
// case, so each scenario below adds exactly the identity rows under test.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import fixture from "./fixtures/ses_u4_swms_26980_live_snapshot.json" with {
  type: "json",
};
import {
  buildSesAssemblerInput,
  type SesAssemblerLiveSnapshot,
} from "./ses_assembler_input_adapter.ts";
import {
  deriveSesSpineFacts,
  type SesSpineCaseRow,
  type SesSpineIdentityRow,
} from "./makesafe_state_seed_scope.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function snapshotWith(
  cases: SesSpineCaseRow[],
  identityRevision: SesSpineIdentityRow | null,
): SesAssemblerLiveSnapshot {
  const live = structuredClone(fixture) as unknown as SesAssemblerLiveSnapshot;
  // deno-lint-ignore no-explicit-any
  (live as any).cases = cases;
  // deno-lint-ignore no-explicit-any
  (live as any).identity_revision = identityRevision;
  return live;
}

/**
 * The three spine terms as the real adapter emits them, plus the exact
 * conditions `ses_prepare_docket_revision.ts` uses to raise
 * `spine_missing_source` / `spine_missing_lineage`.
 */
function adapterSpine(
  cases: SesSpineCaseRow[],
  identityRevision: SesSpineIdentityRow | null,
) {
  const input = buildSesAssemblerInput(snapshotWith(cases, identityRevision));
  const lineage = String(input.identity.lineage_id || "");
  const jobId = String(input.identity.job_id || "");
  const hash = String(input.identity.source_content_hash || "");
  const instruction = String(input.identity.source_instruction_id || "");
  return {
    lineage_id_present: Boolean(lineage),
    source_instruction_present: Boolean(instruction),
    source_content_hash_present: Boolean(hash),
    // `spine_missing_lineage` is `!lineage_id || !job_id || !source_content_hash`
    // and `spine_missing_source` is `!source_instruction_id`. Complete means
    // neither fires.
    spine_complete: Boolean(lineage && jobId && hash && instruction),
  };
}

function assertMirrorsAdapter(
  label: string,
  cases: SesSpineCaseRow[],
  identityRevision: SesSpineIdentityRow | null,
) {
  const expected = adapterSpine(cases, identityRevision);
  const actual = deriveSesSpineFacts({
    job_id: String(
      // deno-lint-ignore no-explicit-any
      (fixture as any).job?.id || "",
    ),
    job_number: "SWMS-26980",
    cases,
    identity_revision: identityRevision,
  });
  assertEquals(
    {
      lineage_id_present: actual.lineage_id_present,
      source_instruction_present: actual.source_instruction_present,
      source_content_hash_present: actual.source_content_hash_present,
      spine_complete: actual.spine_complete,
    },
    expected,
    `spine diagnostic disagreed with the real adapter for: ${label}`,
  );
  return expected;
}

const liveCase = (
  overrides: Partial<SesSpineCaseRow> = {},
): SesSpineCaseRow => ({
  state: "confirmed_live_job",
  lineage_id: "case-1",
  instruction_key: "fingerprint:abc/deliverable:wo%3AMLB-1/cycle:1",
  source_content_hash: HASH_A,
  ...overrides,
});

Deno.test("mirror agrees with the adapter: no case and no revision", () => {
  const spine = assertMirrorsAdapter("bare caseless card", [], null);
  assertEquals(spine.spine_complete, false);
});

Deno.test("mirror agrees with the adapter: the live four-card shape", () => {
  // One live case with lineage and instruction key but no stamped source hash —
  // the shape all four proof cards carried in production on 2026-08-03.
  const spine = assertMirrorsAdapter(
    "case present, source_content_hash null",
    [liveCase({ source_content_hash: null })],
    null,
  );
  assertEquals(spine.lineage_id_present, true);
  assertEquals(spine.source_instruction_present, true);
  assertEquals(spine.source_content_hash_present, false);
  assertEquals(spine.spine_complete, false);
});

Deno.test("mirror agrees with the adapter: case fully stamped", () => {
  const spine = assertMirrorsAdapter("complete case", [liveCase()], null);
  assertEquals(spine.spine_complete, true);
});

Deno.test("mirror agrees with the adapter: legacy_job_record revision", () => {
  const spine = assertMirrorsAdapter("caseless card seeded as legacy", [], {
    authority_kind: "legacy_job_record",
    lineage_id: "job-26980",
    source_instruction_id: "legacy-job:job-26980",
    source_content_hash: HASH_B,
  });
  assertEquals(spine.spine_complete, true);
});

Deno.test("mirror agrees with the adapter: unresolved_authority is not authority", () => {
  const spine = assertMirrorsAdapter("caseless card, unresolved revision", [], {
    authority_kind: "unresolved_authority",
    lineage_id: "job-26980",
    source_instruction_id: "unresolved-job:job-26980",
    source_content_hash: HASH_B,
  });
  assertEquals(spine.spine_complete, false);
});

Deno.test("mirror agrees with the adapter: two live cases are no authority", () => {
  const spine = assertMirrorsAdapter(
    "ambiguous case set",
    [
      liveCase({ lineage_id: "case-1" }),
      liveCase({ state: "blocked_live_job", lineage_id: "case-2" }),
    ],
    null,
  );
  assertEquals(spine.spine_complete, false);
});

Deno.test("mirror agrees with the adapter: a non-live case is ignored", () => {
  const spine = assertMirrorsAdapter(
    "case in a non-live state",
    [liveCase({ state: "exception" })],
    null,
  );
  assertEquals(spine.spine_complete, false);
});

Deno.test("mirror agrees with the adapter: revision backfills a partial case", () => {
  // The case wins term by term, so a revision can supply only what the case
  // lacks. Pinning this keeps the mirror's precedence identical to `firstText`.
  const spine = assertMirrorsAdapter(
    "case without a hash plus a legacy revision",
    [liveCase({ source_content_hash: null })],
    {
      authority_kind: "legacy_job_record",
      lineage_id: "job-26980",
      source_instruction_id: "legacy-job:job-26980",
      source_content_hash: HASH_B,
    },
  );
  assertEquals(spine.spine_complete, true);
});

Deno.test("the parity harness drives the real adapter, not a stub", () => {
  // If the adapter ever stopped reading these rows the scenarios above would
  // all agree trivially, so prove the fixture actually moves the adapter.
  const withCase = buildSesAssemblerInput(snapshotWith([liveCase()], null));
  const without = buildSesAssemblerInput(snapshotWith([], null));
  assert(String(withCase.identity.source_content_hash || "").length > 0);
  assertEquals(String(without.identity.source_content_hash || ""), "");
});
