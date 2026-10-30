// deno-lint-ignore-file no-explicit-any require-await
import { deepStrictEqual as assertEquals } from "node:assert";
import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts";
import { readWorkOrderScopeIdentity } from "./job_work_order_scope_identity.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const REV = "22222222-2222-4222-8222-222222222222";
async function revision(
  scope: unknown = { lines: [{ id: "source-a" }, { id: "source-b" }] },
) {
  const { canonical, hash } = await canonicalJsonAndHash(scope);
  return {
    id: REV,
    job_id: JOB,
    status: "frozen",
    frozen_at: "2026-10-20T00:00:00Z",
    scope_canonical_text: canonical,
    scope_hash: hash,
  };
}
function reader(row: any, error: any = null) {
  const calls: unknown[] = [];
  const query = {
    select(columns: string) {
      calls.push(["select", columns]);
      return this;
    },
    eq(key: string, value: string) {
      calls.push([key, value]);
      return this;
    },
    async maybeSingle() {
      return { data: row, error };
    },
  };
  return {
    calls,
    from(table: string) {
      calls.push(["from", table]);
      return query;
    },
  };
}

Deno.test("work order returns exact source IDs from its named superseded revision, without choosing current scope", async () => {
  const row = await revision();
  row.status = "superseded";
  const db = reader(row);
  const result = await readWorkOrderScopeIdentity(db, JOB, REV);
  assertEquals(result, {
    job_id: JOB,
    scope_revision_id: REV,
    status: "known",
    reason: "verified_scope_manifest",
    scope_hash: row.scope_hash,
    revision_status: "superseded",
    scope_line_ids: ["source-a", "source-b"],
    basis: "named_revision_manifest",
  });
  assertEquals(db.calls.filter((x: any) => x[0] !== "select"), [
    ["from", "scope_revisions"],
    ["id", REV],
    ["job_id", JOB],
  ]);
  assertEquals(await readWorkOrderScopeIdentity(db, JOB, REV), result);
});

Deno.test("work order with no revision reads nothing and does not invent empty source IDs", async () => {
  const db = reader(await revision());
  const result = await readWorkOrderScopeIdentity(db, JOB, null);
  assertEquals(result.reason, "work_order_revision_missing");
  assertEquals(result.scope_line_ids, null);
  assertEquals(db.calls, []);
});

for (
  const [name, mutate, reason] of [
    ["missing row", (_r: any) => null, "scope_revision_missing"],
    [
      "wrong job",
      (r: any) => ({ ...r, job_id: "other-job" }),
      "scope_revision_identity_mismatch",
    ],
    [
      "wrong revision",
      (r: any) => ({ ...r, id: "other-revision" }),
      "scope_revision_identity_mismatch",
    ],
    [
      "draft",
      (r: any) => ({ ...r, status: "draft" }),
      "scope_revision_not_frozen",
    ],
    [
      "no freeze evidence",
      (r: any) => ({ ...r, frozen_at: null }),
      "scope_revision_not_frozen",
    ],
    [
      "corrupted bytes",
      (r: any) => ({
        ...r,
        scope_canonical_text: r.scope_canonical_text + " ",
      }),
      "scope_hash_mismatch",
    ],
  ] as const
) {
  Deno.test(`work order source remains unknown for ${name}`, async () => {
    const result = await readWorkOrderScopeIdentity(
      reader(mutate(await revision())),
      JOB,
      REV,
    );
    assertEquals(result.status, "unknown");
    assertEquals(result.reason, reason);
    assertEquals(result.scope_line_ids, null);
    assertEquals(result.scope_hash, null);
  });
}

for (
  const [name, scope, reason] of [
    ["legacy scope without lines", { config: {} }, "scope_lines_missing"],
    [
      "missing ID",
      { lines: [{ description: "Material" }] },
      "scope_line_id_missing",
    ],
    [
      "partial IDs",
      { lines: [{ id: "source-a" }, {}] },
      "scope_line_id_missing",
    ],
    [
      "duplicate IDs",
      { lines: [{ id: "source-a" }, { id: "source-a" }] },
      "scope_line_ids_ambiguous",
    ],
    ["padded ID", { lines: [{ id: " source-a " }] }, "scope_line_id_malformed"],
  ] as const
) {
  Deno.test(`work order does not repair or silently filter ${name}`, async () => {
    const result = await readWorkOrderScopeIdentity(
      reader(await revision(scope)),
      JOB,
      REV,
    );
    assertEquals(result.status, "unknown");
    assertEquals(result.reason, reason);
    assertEquals(result.scope_line_ids, null);
  });
}

Deno.test("explicit empty sealed manifest is distinct from missing source evidence", async () => {
  const result = await readWorkOrderScopeIdentity(
    reader(await revision({ lines: [] })),
    JOB,
    REV,
  );
  assertEquals(result.status, "known");
  assertEquals(result.scope_line_ids, []);
});

Deno.test("provider errors and exceptions retain unknown source instead of failing the work-order read", async () => {
  for (
    const db of [reader(null, { message: "unavailable" }), {
      from() {
        throw new Error("offline");
      },
    }]
  ) {
    const result = await readWorkOrderScopeIdentity(db, JOB, REV);
    assertEquals(result.reason, "scope_revision_unreadable");
    assertEquals(result.scope_line_ids, null);
  }
});
