// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import vectors from "./makesafe_readiness_golden_vectors.json" with {
  type: "json",
};
import {
  canonicalReadinessJson,
  computeAttendanceCycleSetHash,
  computeMakesafeReadinessRevision,
  type ReadinessDependencyEnvelope,
  readinessDependencyErrors,
} from "./makesafe_readiness_revision.ts";

const vector = vectors[0] as {
  envelope: ReadinessDependencyEnvelope;
  readiness_revision: string;
};

Deno.test("readiness canonicalization matches the committed cross-language vector", async () => {
  for (const item of vectors as Array<typeof vector>) {
    assertEquals(
      await computeMakesafeReadinessRevision(item.envelope),
      item.readiness_revision,
    );
    assertEquals(readinessDependencyErrors(item.envelope), []);
  }
});

Deno.test("readiness canonicalization is key/order/NFC stable", async () => {
  const reordered = structuredClone(vector.envelope);
  reordered.attendance.attendance_cycle_ids.reverse();
  reordered.attendance.cycles.reverse();
  reordered.current_cycle.assignments.reverse();
  reordered.source_instruction.id = "instruction-\u00e9";
  assertEquals(
    await computeMakesafeReadinessRevision(reordered),
    vector.readiness_revision,
  );
});

Deno.test("readiness dependency ordering is Unicode code-point stable", () => {
  const ordered = structuredClone(vector.envelope);
  ordered.current_cycle.assignments = [
    {
      id: "é",
      version: 1,
      content_hash:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    },
    {
      id: "z",
      version: 1,
      content_hash:
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    },
  ];
  const canonical = canonicalReadinessJson(ordered);
  assertEquals(
    canonical.indexOf('"id":"z"') < canonical.indexOf('"id":"é"'),
    true,
  );
});

Deno.test("attendance-cycle set hashing matches the SQL golden vector", async () => {
  assertEquals(
    await computeAttendanceCycleSetHash([
      "00000000-0000-0000-0000-000000000102",
      "00000000-0000-0000-0000-000000000101",
    ]),
    "sha256:ea837da72d6a80810ebd5116945ea2a47736eaa5354164a12e58585ddda25690",
  );
});

Deno.test("each named dependency class changes the readiness revision", async () => {
  const baseline = await computeMakesafeReadinessRevision(vector.envelope);
  const mutations: Array<(value: ReadinessDependencyEnvelope) => void> = [
    (value) => value.source_instruction.version = 3,
    (value) => value.lineage.version = 4,
    (value) => value.attendance.current_attendance_cycle_id = "cycle-a",
    (value) => value.current_cycle.assignments[0].version = 5,
    (value) => value.current_cycle.service_reports[0].version = 8,
    (value) =>
      value.current_cycle.documents.push({
        id: "doc-1",
        version: 1,
        content_hash:
          "sha256:9999999999999999999999999999999999999999999999999999999999999999",
      }),
    (value) => value.current_cycle.completion_photos[0].version = 2,
    (value) =>
      value.current_cycle.portal_captures.push({
        id: "portal-1",
        version: 1,
        content_hash:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    (value) => value.family.matrix_revision = "family-2026-07-28",
    (value) => value.pricing.revision = "pricing-4",
    (value) => {
      value.invoice_obligation.id = "obligation-1";
      value.invoice_obligation.revision = "obligation-revision-1";
    },
    (value) => value.docket.revision_id = "docket-10",
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(vector.envelope);
    mutate(changed);
    assertEquals(
      (await computeMakesafeReadinessRevision(changed)) === baseline,
      false,
    );
  }
});

Deno.test("readiness rejects floats and undefined rather than hashing ambiguity", async () => {
  const floating = structuredClone(vector.envelope);
  floating.source_instruction.version = 1.5;
  await assertRejects(
    () => computeMakesafeReadinessRevision(floating),
    TypeError,
    "finite base-10 integer",
  );
  const undefinedValue = structuredClone(vector.envelope) as any;
  undefinedValue.pricing.revision = undefined;
  await assertRejects(
    () => computeMakesafeReadinessRevision(undefinedValue),
    TypeError,
    "explicit null",
  );
});
