// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifySweepRow,
  runGuardedSweep,
  type SweepRow,
} from "./ses-curated-docket-sweep-v1-core.ts";
import {
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
} from "../supabase/functions/ops-api/makesafe_report_render.ts";
import type { SesPhysicalReportProof } from "../supabase/functions/ops-api/ses_docket_envelope.ts";

function row(overrides: Partial<SweepRow> = {}): SweepRow {
  return {
    job_id: "00000000-0000-0000-0000-000000000001",
    job_number: "SWMS-TEST-1",
    builder_reference: "REF-TEST-1",
    suburb: "Sampleton",
    docket_revision_id: "revision-current",
    docket_artifact_hash: `sha256:${"1".repeat(64)}`,
    docket_object_key: "makesafe-docket-artifacts/redacted.pdf",
    artifact_metadata: { render_hash: "2".repeat(64) },
    family: "physical_makesafe",
    source: {},
    ...overrides,
  };
}

function sourceProof(
  overrides: Partial<SesPhysicalReportProof> = {},
): SesPhysicalReportProof {
  return {
    source_kind: "previously_committed_pdf",
    source_identity: "docket-revision:revision-source/artifact:artifact-source",
    source_document_id: "document-source",
    source_revision_id: "revision-source",
    source_artifact_id: "artifact-source",
    expected_raw_sha256: `sha256:${"4".repeat(64)}`,
    source_artifact_content_hash: `sha256:${"3".repeat(64)}`,
    ...overrides,
  };
}

function currentMetadata(): Record<string, unknown> {
  const proof = sourceProof();
  return {
    ...proof,
    evidence_source: "current_cycle_curated_makesafe_report",
    report_document_id: proof.source_document_id,
    report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
    report_renderer_version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
    render_hash: proof.expected_raw_sha256.slice(7),
    output_sha256: proof.expected_raw_sha256,
    expected_raw_sha256: proof.expected_raw_sha256,
  };
}

Deno.test("classification requires independent identity plus exact input and output hashes", () => {
  assertEquals(classifySweepRow(row()), "stale_legacy");
  assertEquals(
    classifySweepRow(row({ artifact_metadata: currentMetadata() })),
    "already_current",
  );
  assertEquals(
    classifySweepRow(row({
      artifact_metadata: {
        ...currentMetadata(),
        report_renderer_version: "previous-byte-producer/v1",
      },
    })),
    "already_current",
  );
  assertEquals(
    classifySweepRow(row({
      artifact_metadata: {
        ...currentMetadata(),
        source_identity: "document-source",
      },
    })),
    "contact_contract_stale",
  );
  assertEquals(
    classifySweepRow(row({ job_number: "SWMS-261109" })),
    "protected_excluded",
  );
  assertEquals(
    classifySweepRow(row({ docket_object_key: null })),
    "not_applicable_no_report",
  );
});

Deno.test("dry-run records the selected committed source proof without render or attachment", async () => {
  const proof = sourceProof();
  let prepares = 0;
  const [entry] = await runGuardedSweep([row()], {
    prepare: (_candidate, args) => {
      prepares++;
      assertEquals(args, { dry_run: true });
      return Promise.resolve({
        revision_id: "dry-run-revision",
        source: proof,
      });
    },
  }, "dry_run");
  assertEquals(prepares, 1);
  assertEquals(entry.verification_state, "dry_run_proven");
  assertEquals(entry.selected_source, proof);
  assertEquals(entry.render_hash, proof.expected_raw_sha256.slice(7));
  assertEquals(entry.old_object_key, null);
});

Deno.test("hostile raw storm and generic materials refuse when no curated source exists", async () => {
  const hostile = row({
    source: {
      checklist_json: {
        damage_cause: "Storm / wind",
        materials_used: [
          "Temporary fence panels",
          "Bases / feet",
          "Tarps / roof materials",
          "Fixings / consumables",
        ],
      },
    },
  });
  const [entry] = await runGuardedSweep([hostile], {
    prepare: () =>
      Promise.resolve({
        revision_id: null,
        source: null,
        refusal: {
          code: "curated_source_missing",
          remedy: "Bind exact committed curated bytes.",
        },
      }),
  }, "dry_run");
  assertEquals(entry.verification_state, "refused");
  assertEquals(entry.refusal?.code, "curated_source_missing");
  assertEquals(entry.render_hash, null);
  assertEquals(entry.rejected_candidates, [{
    source: "raw_trade_report_fields",
    code: "raw_trade_fields_not_curated_authority",
  }]);
});

Deno.test("apply verifies the reviewed target and passes the exact selected proof to prepare", async () => {
  const proof = sourceProof();
  const dry = await runGuardedSweep([row()], {
    prepare: () => Promise.resolve({ revision_id: null, source: proof }),
  }, "dry_run");
  let applyCalls = 0;
  const [applied] = await runGuardedSweep(
    [row()],
    {
      prepare: (_candidate, args) => {
        applyCalls++;
        assertEquals(args, {
          dry_run: false,
          expected_physical_report_proof: proof,
        });
        return Promise.resolve({
          revision_id: "revision-new",
          source: proof,
        });
      },
    },
    "apply",
    dry,
  );
  assertEquals(applyCalls, 1);
  assertEquals(applied.verification_state, "applied");
  assertEquals(applied.new_revision_id, "revision-new");

  const [drifted] = await runGuardedSweep(
    [
      row({ docket_revision_id: "revision-changed" }),
    ],
    {
      prepare: () => {
        throw new Error("target drift must refuse before prepare");
      },
    },
    "apply",
    dry,
  );
  assertEquals(drifted.refusal?.code, "reviewed_target_drift");
  assertEquals(applyCalls, 1);
});

Deno.test("apply refuses when the assembler re-resolves a different source proof", async () => {
  const proof = sourceProof();
  const dry = await runGuardedSweep([row()], {
    prepare: () => Promise.resolve({ revision_id: null, source: proof }),
  }, "dry_run");
  const [entry] = await runGuardedSweep(
    [row()],
    {
      prepare: () =>
        Promise.resolve({
          revision_id: "must-not-accept",
          source: sourceProof({
            source_identity:
              "docket-revision:revision-source/artifact:artifact-drifted",
            source_artifact_id: "artifact-drifted",
          }),
        }),
    },
    "apply",
    dry,
  );
  assertEquals(entry.verification_state, "refused");
  assertEquals(entry.refusal?.code, "reviewed_candidate_drift");
});

Deno.test("apply never accepts a valid source when persistent prepare refuses or returns no revision", async () => {
  const proof = sourceProof();
  const dry = await runGuardedSweep([row()], {
    prepare: () => Promise.resolve({ revision_id: null, source: proof }),
  }, "dry_run");
  const cases = [
    {
      revision_id: "revision-must-not-accept",
      source: proof,
      refusal: {
        code: "persistent_prepare_refused",
        remedy: "Persistence was refused.",
      },
    },
    { revision_id: null, source: proof },
  ];
  for (const prepared of cases) {
    const [entry] = await runGuardedSweep(
      [row()],
      { prepare: () => Promise.resolve(prepared) },
      "apply",
      dry,
    );
    assertEquals(entry.verification_state, "refused");
    assertEquals(entry.refusal?.code, "persistent_prepare_refused");
    assertEquals(entry.new_revision_id, null);
  }
});

Deno.test("one missing curated source does not stop the next card", async () => {
  const entries = await runGuardedSweep([
    row(),
    row({ job_id: "00000000-0000-0000-0000-000000000002" }),
  ], {
    prepare: (candidate) =>
      Promise.resolve(
        candidate.job_id.endsWith("1")
          ? {
            revision_id: null,
            source: null,
            refusal: { code: "curated_source_missing", remedy: "Bind source." },
          }
          : { revision_id: null, source: sourceProof() },
      ),
  }, "dry_run");
  assertEquals(entries.map((entry) => entry.verification_state), [
    "refused",
    "dry_run_proven",
  ]);
});
