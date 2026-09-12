// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isCurrentContextFact } from "./context_visibility.ts";
import {
  _assembleJobDossierForTest,
  _getJobContextFactsForTest,
} from "./index.ts";

const active = {
  id: "current",
  job_id: "job",
  kind: "note",
  value: { text: "CURRENT_SOURCE" },
  _context_store: "job_context",
  expires_at: null,
  provenance: { safety: { memory_trusted: true } },
};
const rows = [
  active,
  {
    ...active,
    id: "superseded",
    value: { text: "OLD_SOURCE" },
    provenance: { lifecycle: "superseded", safety: { memory_trusted: true } },
  },
  { ...active, id: "retracted", provenance: { lifecycle: "retracted" } },
  {
    ...active,
    id: "untrusted",
    provenance: { safety: { memory_trusted: false } },
  },
  {
    ...active,
    id: "expired",
    kind: "pending_action",
    expires_at: "2000-01-01T00:00:00Z",
  },
];
function client() {
  return {
    from(table: string) {
      let single = false;
      const q: any = {
        select() {
          return q;
        },
        eq() {
          return q;
        },
        in() {
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        neq() {
          return q;
        },
        gt() {
          return q;
        },
        contains() {
          return q;
        },
        maybeSingle() {
          single = true;
          return q;
        },
        then(resolve: any) {
          const data = table === "current_job_context_facts"
            ? rows
            : table === "jobs"
            ? [{ id: "job", job_number: "SWF-fixture" }]
            : [];
          return Promise.resolve({
            data: single ? data[0] ?? null : data,
            error: null,
          }).then(resolve);
        },
      };
      // No mutation surface is supplied: actual handlers must remain SELECT-only.
      return q;
    },
  };
}
Deno.test("lifecycle invalidation outranks an old true trust flag", () => {
  assertEquals(rows.map((r) => isCurrentContextFact(r)), [
    true,
    false,
    false,
    false,
    false,
  ]);
  assertEquals(
    isCurrentContextFact({
      ...active,
      provenance: { superseded_by: "replacement" },
    }),
    false,
  );
  assertEquals(
    isCurrentContextFact({
      ...active,
      kind: "pending_action",
      expires_at: "invalid",
    }),
    false,
  );
  assertEquals(
    isCurrentContextFact({
      ...active,
      kind: "pending_action",
      expires_at: "2999-01-01",
    }),
    true,
  );
});
Deno.test("actual facts endpoint excludes historical rows and discloses bounded exclusion", async () => {
  const result = await _getJobContextFactsForTest(client(), {
    job_uuids: ["job"],
  });
  assertEquals(result.rows, [active]);
  assertEquals(result.excluded_count, 4);
  assertEquals(result.coverage, "bounded_rows_only");
});
Deno.test("actual dossier excludes obsolete facts and their current evidence refs", async () => {
  const result = await _assembleJobDossierForTest(client(), { job_id: "job" });
  assertEquals(result.facts, [active]);
  assertEquals(
    result.evidenceRefs.filter((r: any) => r.type === "fact").map((r: any) =>
      r.id
    ),
    ["current"],
  );
  assertEquals(result.diagnostics.sourceStatus.facts.count, 1);
  assert(
    result.diagnostics.warnings.some((w: string) => w.includes("4 superseded")),
  );
  assert(!JSON.stringify(result).includes("OLD_SOURCE"));
});

Deno.test("ongoing temporary facts with null expiry remain current", () => {
  assertEquals(
    isCurrentContextFact({
      ...active,
      kind: "pending_action",
      _context_store: "job_temporary_context",
      expires_at: null,
      validity_basis: "ongoing",
    }),
    true,
  );
  assertEquals(
    isCurrentContextFact({
      ...active,
      kind: "current_state",
      _context_store: "job_temporary_context",
      expires_at: null,
      validity_basis: "uncertain",
    }),
    true,
  );
  assertEquals(
    isCurrentContextFact({
      ...active,
      kind: "proposal",
      expires_at: null,
      validity_basis: "unknown_end",
      last_verified_at: null,
    }),
    true,
  );
});

Deno.test("view permanent null expiry remains visible, current temporary facts reach dossier", async () => {
  const future = {
    ...active,
    id: "temporary-current",
    kind: "pending_action",
    _context_store: "job_temporary_context",
    expires_at: "2999-01-01T00:00:00Z",
  };
  rows.push(future);
  try {
    const result = await _assembleJobDossierForTest(client(), {
      job_id: "job",
    });
    assertEquals(result.facts, [active]);
    assertEquals(result.temporaryFacts, [future]);
    assertEquals(
      result.evidenceRefs.find((r: any) => r.id === future.id)?.source_table,
      "job_temporary_context",
    );
  } finally {
    rows.pop();
  }
});
