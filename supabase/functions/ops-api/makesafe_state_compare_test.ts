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
  attachMakesafeStateV2SeedPreviewComparison,
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
    identities: [],
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
    details: [],
    dockets: [],
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
    facts.identities.push({
      id: `case-${suffix}`,
      job_id: jobId,
      authority_kind: "effective_intake_case",
      effective_case_id: `case-${suffix}`,
      source_instruction_id: `instruction-${suffix}`,
      lineage_id: `lineage-${suffix}`,
      intake_state: "confirmed_live_job",
      family_state: "resolved",
      family_rule_key: "physical_makesafe",
      evidence_refs: [`case-${suffix}`],
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
      lte: () => query,
      lt: () => query,
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

Deno.test("default makesafe-board v1 includes the additive intake exception desk", async () => {
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
      // Default ops board is card-shaped (#553) and active-columns-only.
      fields: "card",
      column_scope: "active",
      generated_at: GENERATED_AT,
      shape: "card",
      columns: {
        new: [],
        allocated: [],
        trade_report_in: [],
        report_ready: [],
        completed: [],
        archive: [],
        cancelled: [],
      },
      unmapped_stage_job_ids: [],
      row_count: 0,
      column_counts: {
        new: 0,
        allocated: 0,
        trade_report_in: 0,
        report_ready: 0,
        completed: 0,
        archive: 0,
        cancelled: 0,
      },
      archive: {
        included: false,
        scope: "active",
        total: 0,
        returned: 0,
        offset: 0,
        limit: null,
        fetch: {
          active_default: "projection=ops",
          include_archive: "projection=ops&include_archive=1",
          archive_only: "projection=ops&columns=archive",
          archive_page: "projection=ops&columns=archive&limit=50&offset=0",
          full_diagnostics: "projection=ops&fields=full",
        },
      },
      intake_exceptions: {
        contract_version: "makesafe-intake-exception-cards.v1",
        generated_at: GENERATED_AT,
        org_id: "00000000-0000-0000-0000-000000000001",
        recent_window: {
          days: 15,
          from: "2026-07-12T04:00:00.000Z",
          to: GENERATED_AT,
        },
        summary: {
          visible_actionable_cards: 0,
          resolved_from_existing_evidence: 0,
          accounted_silently: 0,
          outside_three: 0,
        },
        totals: {
          exception_case_rows: 0,
          recent_exception_case_rows: 0,
          out_of_window_exception_case_rows: 0,
          recent_accounted_non_work_rows: 0,
          recent_deterministic_non_work_exception_rows: 0,
          actionable_case_rows: 0,
          cards: 0,
          source_alarms: 0,
        },
        cards: [],
        source_alarms: [],
        // Additive since 2026-08-01: a healthy projection states `degraded: null`
        // so an empty desk is never mistaken for an unreadable one. See
        // makesafe_board_intake_exception_degrade_test.ts.
        degraded: null,
      },
      parity: {
        ok: true,
        checked: 0,
        mode: "card_placement",
        errors: [],
      },
    }),
  );
  assertEquals(
    client.calls.includes("makesafe_state_projection_config"),
    false,
    "default v1 must not touch Phase-1 schema",
  );
});

Deno.test("archive paging is validated, never coerced into a surprise page", async () => {
  const board = (options: Record<string, unknown>) =>
    _makesafeBoardActionForTest(
      emptyCanonicalBoardClient(),
      "api_key",
      null,
      "ops",
      { generatedAt: GENERATED_AT, columns: "archive", ...options },
    );

  for (const limit of ["abc", "0", "-5", "1.5", "501"]) {
    const response = await board({ limit });
    assertEquals(response.status, 400, `limit=${limit} must be refused`);
    assertEquals(
      (await response.json()).error,
      "limit must be an integer between 1 and 500",
    );
  }
  for (const offset of ["abc", "-1", "2.5"]) {
    const response = await board({ offset });
    assertEquals(response.status, 400, `offset=${offset} must be refused`);
    assertEquals(
      (await response.json()).error,
      "offset must be an integer of 0 or more",
    );
  }

  const ok = await board({ limit: "50", offset: "0" });
  assertEquals(ok.status, 200);
  const body = await ok.json();
  assertEquals(body.column_scope, "archive");
  assertEquals(body.archive.limit, 50);
  assertEquals(body.archive.offset, 0);

  // Absent paging is unpaged, not a clamped page of one.
  const unpaged = await board({});
  assertEquals(unpaged.status, 200);
  assertEquals((await unpaged.json()).archive.limit, null);
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

Deno.test("seed dry-run comparison labels prospective inputs and preserves genuine residuals", async () => {
  const fixture = comparisonFixture(2);
  fixture.facts.assignments.push({
    id: "current-assignment-without-identity",
    job_id: fixture.rows[1].id,
    status: "scheduled",
    attendance_cycle_id: fixture.rows[1].attendance_cycle_id,
    cycle_attribution: "bound",
    makesafe_fact_version: null,
    makesafe_content_hash: null,
  });

  const result = await attachMakesafeStateV2SeedPreviewComparison(
    {},
    fixture.rows,
    GENERATED_AT,
    async () => fixture.facts,
  );

  assertEquals(result.projection_basis, "prospective_seed");
  assertEquals(result.projection_health.requested_job_count, 2);
  assertEquals(result.projection_health.projected_job_count, 2);
  assertEquals(result.projection_health.projection_input_error_job_count, 1);
  assertEquals(
    result.rows[0].state_v2.diagnostics.some((item: any) =>
      item.code === "projection_input_error"
    ),
    false,
  );
  assert(
    result.rows[1].state_v2.diagnostics.some((item: any) =>
      item.code === "projection_input_error" &&
      item.reason.includes("immutable version/hash identity")
    ),
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
  fixture.facts.assignments.push({
    id: "assignment-current",
    job_id: jobId,
    status: "scheduled",
    attendance_cycle_id: currentCycleId,
    cycle_attribution: "bound",
    makesafe_fact_version: 1,
    makesafe_content_hash: SHA_A,
  });
  fixture.facts.packs.push({
    id: "pack-current",
    job_id: jobId,
    status: "draft",
    makesafe_content_hash: SHA_A,
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
