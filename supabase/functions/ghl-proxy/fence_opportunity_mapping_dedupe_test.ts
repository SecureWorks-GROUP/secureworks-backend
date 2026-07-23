// Source-contract and pure winner-rule coverage for
// 20260720235959_fence_opportunity_mapping_dedupe.sql.
//
// RUN:
//   deno test --no-check --allow-read \
//     supabase/functions/ghl-proxy/fence_opportunity_mapping_dedupe_test.ts

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

type Evidence = {
  jobId: string;
  updatedAt: string;
  createdAt: string;
  financial: number;
  quotes: number;
  operations: number;
  artifacts: number;
  lifecycle: number;
  scope: boolean;
  pricing: boolean;
  eventTypes: number;
};

// Pure mirror of public._fence_opportunity_mapping_rank. PostgreSQL compares
// arrays lexicographically, so this returns the exact ordered rank dimensions.
function evidenceRank(e: Evidence): number[] {
  const breadth = [
    e.financial,
    e.quotes,
    e.operations,
    e.artifacts,
    e.lifecycle,
    e.eventTypes,
  ].filter((value) => value > 0).length + Number(e.scope) + Number(e.pricing);
  return [
    breadth,
    Number(e.financial > 0),
    e.financial,
    e.quotes,
    e.operations,
    e.artifacts,
    e.lifecycle,
    Number(e.scope),
    Number(e.pricing),
    e.eventTypes,
  ];
}

function compareDescending(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (b[i] ?? 0) - (a[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function chooseWinner(rows: Evidence[]): Evidence {
  return [...rows].sort((a, b) => {
    const evidenceDifference = compareDescending(
      evidenceRank(a),
      evidenceRank(b),
    );
    if (evidenceDifference !== 0) return evidenceDifference;

    // The SQL tie-break prefers the most recently updated non-empty scope,
    // then any latest update, creation time and UUID.
    if (a.scope || b.scope) {
      const scopedA = a.scope ? a.updatedAt : "";
      const scopedB = b.scope ? b.updatedAt : "";
      if (scopedA !== scopedB) return scopedB.localeCompare(scopedA);
    }
    if (a.updatedAt !== b.updatedAt) {
      return b.updatedAt.localeCompare(a.updatedAt);
    }
    if (a.createdAt !== b.createdAt) {
      return b.createdAt.localeCompare(a.createdAt);
    }
    return b.jobId.localeCompare(a.jobId);
  })[0];
}

function row(
  jobId: string,
  patch: Partial<Omit<Evidence, "jobId">> = {},
): Evidence {
  return {
    jobId,
    updatedAt: "2026-07-20T00:00:00Z",
    createdAt: "2026-07-19T00:00:00Z",
    financial: 0,
    quotes: 0,
    operations: 0,
    artifacts: 0,
    lifecycle: 0,
    scope: false,
    pricing: false,
    eventTypes: 0,
    ...patch,
  };
}

Deno.test("duplicate mapping winner: quoted scoped record beats empty retry husk", () => {
  const husk = row("00000000-0000-4000-8000-000000000001", {
    eventTypes: 1,
  });
  const quoted = row("00000000-0000-4000-8000-000000000002", {
    quotes: 1,
    artifacts: 3,
    lifecycle: 2,
    scope: true,
    pricing: true,
    eventTypes: 4,
  });
  assertEquals(chooseWinner([husk, quoted]).jobId, quoted.jobId);
});

Deno.test("duplicate mapping winner: mixed invoiced record wins when both rows are rich", () => {
  // Mocked from a real two-row fencing shape: the archived row had financial and
  // assignment evidence, while the invoiced row additionally had released quote
  // evidence and broader independent categories.
  const archived = row("00000000-0000-4000-8000-000000000010", {
    financial: 4,
    operations: 6,
    artifacts: 4,
    lifecycle: 5,
    scope: true,
    pricing: true,
    eventTypes: 12,
  });
  const invoiced = row("00000000-0000-4000-8000-000000000011", {
    financial: 6,
    quotes: 1,
    operations: 1,
    artifacts: 4,
    lifecycle: 6,
    scope: true,
    pricing: true,
    eventTypes: 14,
  });
  assertEquals(chooseWinner([archived, invoiced]).jobId, invoiced.jobId);
});

Deno.test("duplicate mapping winner: patio retry storm preserves the broad business row", () => {
  const patioBusinessRow = row("00000000-0000-4000-8000-000000000020", {
    financial: 4,
    operations: 1,
    artifacts: 20,
    lifecycle: 5,
    scope: true,
    pricing: true,
    eventTypes: 15,
  });
  const patioDrafts = Array.from(
    { length: 9 },
    (_, index) =>
      row(`00000000-0000-4000-8000-0000000001${index}`, {
        scope: index < 4,
        pricing: index < 4,
        artifacts: index < 4 ? 1 : 0,
        eventTypes: 1,
      }),
  );
  assertEquals(
    chooseWinner([...patioDrafts, patioBusinessRow]).jobId,
    patioBusinessRow.jobId,
  );
});

Deno.test("duplicate mapping winner: exact evidence tie uses latest non-empty scope", () => {
  const older = row("00000000-0000-4000-8000-000000000030", {
    scope: true,
    pricing: true,
    artifacts: 1,
    eventTypes: 2,
    updatedAt: "2026-07-20T00:00:00Z",
  });
  const newer = row("00000000-0000-4000-8000-000000000031", {
    scope: true,
    pricing: true,
    artifacts: 1,
    eventTypes: 2,
    updatedAt: "2026-07-21T00:00:00Z",
  });
  assertEquals(chooseWinner([newer, older]).jobId, newer.jobId);
});

Deno.test("dedupe migration audits every mapping and only nulls losing mappings", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260720235959_fence_opportunity_mapping_dedupe.sql",
      import.meta.url,
    ),
  );

  assertStringIncludes(sql, "public.fence_opportunity_mapping_audit");
  assertStringIncludes(
    sql,
    "CASE WHEN r.mapping_rank = 1 THEN 'kept' ELSE 'unmapped' END",
  );
  assertStringIncludes(sql, "SET ghl_opportunity_id = NULL");
  assertStringIncludes(sql, "WHERE r.mapping_rank > 1");
  assertStringIncludes(sql, "rich_business_row_count > 1");
  assertStringIncludes(sql, "_fence_opportunity_mapping_rank");
  assertStringIncludes(
    sql,
    "CASE WHEN s.scope_nonempty THEN s.updated_at END DESC NULLS LAST",
  );
  assertStringIncludes(
    sql,
    "RAISE EXCEPTION 'fence opportunity mapping dedupe left duplicate mappings'",
  );
  assertEquals(/DELETE\s+FROM\s+public\.jobs/i.test(sql), false);
  assertEquals(/WHERE\s+(?:j\.)?type\s*=\s*'fencing'/i.test(sql), false);
  assertEquals(/send_quote|send_sms|send_email/i.test(sql), false);
  assert(
    sql.indexOf("20260721000001_fence_job_mint.sql") >= 0,
    "migration must document that it precedes the mint uniqueness migration",
  );
});

Deno.test("dedupe migration guards public.job_scope through a to_regclass-safe helper", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260720235959_fence_opportunity_mapping_dedupe.sql",
      import.meta.url,
    ),
  );

  // job_scope has no repository migration, so it must never be queried directly
  // from the set-based statement; the only reference is inside the guarded
  // plpgsql helper's dynamic EXECUTE, which is not planned until execution.
  assertStringIncludes(
    sql,
    "CREATE OR REPLACE FUNCTION public._fence_opportunity_mapping_job_scope_count",
  );
  assertStringIncludes(sql, "to_regclass('public.job_scope') IS NULL");
  assertStringIncludes(sql, "RETURN 0;");
  assertStringIncludes(
    sql,
    "public._fence_opportunity_mapping_job_scope_count(j.id)",
  );
  // The artifact tally must go through the helper, never the old correlated
  // subquery, so a fresh database without job_scope still applies the migration.
  assertEquals(
    /SELECT\s+count\(\*\)\s+FROM\s+public\.job_scope\s+\w+\s+WHERE/i.test(sql),
    false,
  );
  assert(
    sql.indexOf("CREATE OR REPLACE FUNCTION public._fence_opportunity_mapping_job_scope_count") <
      sql.indexOf("WITH duplicate_groups AS"),
    "the guard helper must be defined before the dedupe statement uses it",
  );
});
