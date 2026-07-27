// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _makesafeBoardActionForTest } from "./index.ts";
import { computeAttendanceCycleSetHash } from "./makesafe_readiness_revision.ts";
import {
  attachMakesafeStateV2Comparison,
  buildMakesafeV2Comparison,
  type MakesafeV2FactSet,
} from "./makesafe_state_compare.ts";

const SHA_A =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const GENERATED_AT = "2026-07-27T04:00:00.000Z";

function emptyFactSet(): MakesafeV2FactSet {
  return {
    projectionConfig: {
      default_contract_version: "v1",
      compare_enabled: true,
      authority_flipped: false,
    },
    jobFamilies: [],
    cycles: [],
    cases: [],
    assignments: [],
    serviceReports: [],
    documents: [],
    media: [],
    portalCaptures: [],
    familyRules: [],
    readiness: [],
    holds: [],
    cancellations: [],
    terminalProofs: [],
    packCycles: [],
    packs: [],
    approvals: [],
  };
}

function comparisonFixture(count: number) {
  const facts = emptyFactSet();
  facts.familyRules.push({
    id: "family-rule-1",
    family_code: "physical_makesafe",
    family_kind: "physical",
    matrix_revision: "family-1",
    matrix_content_hash: SHA_A,
    completion_photo_floor: 5,
    required_document_types: [],
    required_portal_roles: [],
  });
  const rows = Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(4, "0");
    const jobId = `job-${suffix}`;
    const cycleId = `cycle-${suffix}`;
    facts.jobFamilies.push({
      id: jobId,
      metadata: { makesafe_job_family: "physical_makesafe" },
    });
    facts.cycles.push({
      id: cycleId,
      job_id: jobId,
      cycle_number: 1,
      closed_at: null,
      makesafe_fact_version: 1,
      makesafe_content_hash: SHA_A,
    });
    facts.cases.push({
      id: `case-${suffix}`,
      job_id: jobId,
      instruction_key: `instruction-${suffix}`,
      lineage_id: `lineage-${suffix}`,
      state: "confirmed_live_job",
      state_version: 1,
      source_version: 1,
      source_content_hash: SHA_A,
      lineage_version: 1,
      lineage_correction_hash: SHA_B,
      lineage_supersession_hash: SHA_C,
    });
    return {
      id: jobId,
      job_number: `SWMS-${suffix}`,
      makesafe_type: "Physical Make-safe",
      substatus: "company_contact_required",
      canonical_stage: "new",
      canonical_stage_label: "New",
      attendance_cycle_id: cycleId,
      readiness_revision: null,
      contact: { client_name: "Client", phone: "0400000000" },
      assignments: [],
      cancelled: null,
    };
  });
  return { rows, facts };
}

function emptyCanonicalBoardClient(compareEnabled = false) {
  const calls: string[] = [];
  function builder(table: string) {
    calls.push(table);
    const predicates: Array<(row: any) => boolean> = [];
    const rows: any[] = [];
    const query: any = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        predicates.push((row) => row?.[column] === value);
        return query;
      },
      neq: () => query,
      not: () => query,
      gte: () => query,
      in: () => query,
      order: () => query,
      range: async (from: number, to: number) => ({
        data: rows.filter((row) =>
          predicates.every((predicate) => predicate(row))
        ).slice(from, to + 1),
        error: null,
      }),
      maybeSingle: async () => ({
        data: table === "makesafe_state_projection_config" && compareEnabled
          ? {
            default_contract_version: "v1",
            compare_enabled: true,
            authority_flipped: false,
          }
          : null,
        error: null,
      }),
      then: (resolve: (value: any) => any) =>
        resolve({ data: [], error: null }),
    };
    return query;
  }
  return {
    calls,
    from: (table: string) => builder(table),
  };
}

Deno.test("default makesafe-board response remains the exact v1 byte contract", async () => {
  const client = emptyCanonicalBoardClient();
  const response = await _makesafeBoardActionForTest(
    client,
    "api_key",
    null,
    "ops",
    { generatedAt: GENERATED_AT },
  );
  const body = await response.text();
  assertEquals(response.status, 200);
  assertEquals(
    body,
    JSON.stringify({
      contract_version: "makesafe-board.v1",
      projection: "ops",
      generated_at: GENERATED_AT,
      columns: {
        new: [],
        allocated: [],
        trade_report_in: [],
        report_ready: [],
        completed: [],
        archive: [],
        cancelled: [],
      },
      rows: [],
      unmapped_stage_job_ids: [],
      parity: {
        ok: true,
        checked: 0,
        errors: [],
        unmapped_stage_job_ids: [],
      },
    }),
  );
  assertEquals(
    client.calls.includes("makesafe_state_projection_config"),
    false,
    "default v1 must not touch Phase-1 schema",
  );
});

Deno.test("explicit v1 flag is byte-identical to the absent flag", async () => {
  const absent = await _makesafeBoardActionForTest(
    emptyCanonicalBoardClient(),
    "api_key",
    null,
    "ops",
    { generatedAt: GENERATED_AT },
  );
  const explicit = await _makesafeBoardActionForTest(
    emptyCanonicalBoardClient(),
    "api_key",
    null,
    "ops",
    { generatedAt: GENERATED_AT, contractVersion: "v1" },
  );
  assertEquals(await absent.text(), await explicit.text());
});

Deno.test("v2 comparison is privileged and never exposed to routine or trade reads", async () => {
  const routine = await _makesafeBoardActionForTest(
    emptyCanonicalBoardClient(),
    "routine",
    null,
    "ops",
    { contractVersion: "v2" },
  );
  assertEquals(routine.status, 403);
  const trade = await _makesafeBoardActionForTest(
    emptyCanonicalBoardClient(),
    "jwt",
    {
      id: "owner-1",
      email: "owner@example.invalid",
      orgId: "org-1",
      role: "owner",
      managedVerticals: ["makesafe"],
    },
    "trade",
    { contractVersion: "v2" },
  );
  assertEquals(trade.status, 403);
});

Deno.test("privileged v2 route returns only the compare contract", async () => {
  const response = await _makesafeBoardActionForTest(
    emptyCanonicalBoardClient(true),
    "api_key",
    null,
    "ops",
    { generatedAt: GENERATED_AT, contractVersion: "v2" },
  );
  assertEquals(response.status, 200);
  const body = JSON.parse(await response.text());
  assertEquals(body.contract_version, "makesafe-board.v2");
  assertEquals(body.state_contract_version, "makesafe-state.v2");
  assertEquals(body.projection_health, {
    complete: true,
    requested_job_count: 0,
    projected_job_count: 0,
    differing_job_count: 0,
    projection_input_error_job_count: 0,
    duplicate_job_ids: [],
  });
});

Deno.test("comparison attaches complete state and a machine-readable diff to every job", async () => {
  const fixture = comparisonFixture(2);
  const result = await buildMakesafeV2Comparison(
    fixture.rows,
    fixture.facts,
    GENERATED_AT,
  );
  assertEquals(result.projection_health.complete, true);
  assertEquals(result.projection_health.requested_job_count, 2);
  assertEquals(result.projection_health.projected_job_count, 2);
  assertEquals(result.rows.length, 2);
  for (const row of result.rows) {
    assertEquals(row.state_v2.contract_version, "makesafe-state.v2");
    assert(Array.isArray(row.v1_v2_diff.fields));
    assertEquals(typeof row.v1_v2_diff.equal, "boolean");
  }
});

Deno.test("comparison projects 392/500/1001 rows without truncation or duplicates", async () => {
  for (const count of [392, 500, 1001]) {
    const fixture = comparisonFixture(count);
    const result = await buildMakesafeV2Comparison(
      fixture.rows,
      fixture.facts,
      GENERATED_AT,
    );
    assertEquals(result.rows.length, count);
    assertEquals(result.projection_health.requested_job_count, count);
    assertEquals(result.projection_health.projected_job_count, count);
    assertEquals(
      new Set(result.rows.map((row) => row.id)).size,
      count,
    );
  }
});

Deno.test("comparison loader errors reject the whole response rather than returning partial truth", async () => {
  const fixture = comparisonFixture(1);
  await assertRejects(
    () =>
      attachMakesafeStateV2Comparison(
        {},
        fixture.rows,
        GENERATED_AT,
        async () => {
          throw new Error("forced PostgREST failure");
        },
      ),
    Error,
    "forced PostgREST failure",
  );
});

Deno.test("a partial fact join cannot preserve a stored Docs Ready pointer", async () => {
  const fixture = comparisonFixture(1);
  const cycleId = fixture.rows[0].attendance_cycle_id;
  fixture.facts.readiness.push({
    job_id: fixture.rows[0].id,
    dependency_generation: 3,
    readiness_revision: SHA_C,
    attendance_cycle_set_hash: await computeAttendanceCycleSetHash([cycleId]),
    ready: true,
    invalidated_at: null,
    invalidation_reason: null,
    dependency_envelope: {},
  });
  const result = await buildMakesafeV2Comparison(
    fixture.rows,
    fixture.facts,
    GENERATED_AT,
  );
  assertEquals(result.rows[0].state_v2.ops_stage, "new");
  assertEquals(result.rows[0].state_v2.readiness.ready, false);
  assert(
    result.rows[0].state_v2.diagnostics.some((item: any) =>
      item.code === "projection_input_error"
    ),
  );
});

Deno.test("duplicate canonical job ids fail loudly", async () => {
  const fixture = comparisonFixture(1);
  await assertRejects(
    () =>
      buildMakesafeV2Comparison(
        [fixture.rows[0], fixture.rows[0]],
        fixture.facts,
        GENERATED_AT,
      ),
    Error,
    "duplicate canonical job ids",
  );
});

Deno.test("historical pack-cycle attribution cannot poison the current cycle", async () => {
  const fixture = comparisonFixture(1);
  const jobId = fixture.rows[0].id;
  const currentCycleId = fixture.rows[0].attendance_cycle_id;
  fixture.facts.packCycles.push(
    {
      id: "pack-cycle-current",
      pack_id: "pack-current",
      job_id: jobId,
      attendance_cycle_id: currentCycleId,
      cycle_attribution: "bound",
    },
    {
      id: "pack-cycle-historical",
      pack_id: "pack-old",
      job_id: jobId,
      attendance_cycle_id: "historical-cycle",
      cycle_attribution: "legacy_unscoped",
    },
  );
  fixture.facts.packs.push({
    id: "pack-current",
    job_id: jobId,
    status: "draft",
  });
  const result = await buildMakesafeV2Comparison(
    fixture.rows,
    fixture.facts,
    GENERATED_AT,
  );
  assertEquals(result.rows[0].state_v2.ops_stage, "allocated");
  assert(
    !result.rows[0].state_v2.blocker.active.some((item: any) =>
      item.code === "backfill_cycle_scope"
    ),
  );
});
