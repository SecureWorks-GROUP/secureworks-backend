// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifySweepRow,
  REPORT_MAX_BYTES,
  runGuardedSweep,
  type SweepRender,
  type SweepRow,
} from "./ses-curated-docket-sweep-v1-core.ts";
import {
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
} from "../supabase/functions/ops-api/makesafe_report_render.ts";

function row(overrides: Partial<SweepRow> = {}): SweepRow {
  return {
    job_id: "00000000-0000-0000-0000-000000000001",
    job_number: "SWMS-TEST-1",
    builder_reference: "REF-TEST-1",
    suburb: "Sampleton",
    docket_revision_id: "revision-1",
    docket_artifact_hash: "sha256:old",
    docket_object_key: "makesafe-docket-artifacts/old.pdf",
    artifact_metadata: { render_hash: "old" },
    family: "physical_makesafe",
    source: {},
    ...overrides,
  };
}

function rendered(size = 12): SweepRender {
  return {
    bytes: new Uint8Array(size),
    pdf_sha256: "a".repeat(64),
    report_input_hash: `sha256:${"b".repeat(64)}`,
    report_job: {},
    searched_sources: ["jobs", "job_service_reports.current_cycle"],
    rejected_candidates: [],
  };
}

Deno.test("classification separates legacy, contact-stale, current, protected and no-report", () => {
  assertEquals(classifySweepRow(row()), "stale_legacy");
  assertEquals(
    classifySweepRow(row({
      artifact_metadata: {
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        report_renderer_version: "secureworks.wiki-python/older",
      },
    })),
    "contact_contract_stale",
  );
  assertEquals(
    classifySweepRow(row({
      artifact_metadata: {
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        report_renderer_version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
        evidence_source: "current_cycle_curated_makesafe_report",
        render_hash: "c".repeat(64),
        source_document_id: "document-1",
      },
    })),
    "already_current",
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

Deno.test("dry-run proves every eligible card without invoking writes", async () => {
  let renders = 0;
  const entries = await runGuardedSweep([
    row(),
    row({
      job_id: "job-current",
      artifact_metadata: {
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        report_renderer_version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
        evidence_source: "current_cycle_curated_makesafe_report",
        render_hash: "c".repeat(64),
        source_document_id: "doc-current",
      },
    }),
  ], {
    render: () => {
      renders++;
      return Promise.resolve(rendered());
    },
    attach: () => {
      throw new Error("dry-run must not attach");
    },
    prepare: () => {
      throw new Error("dry-run must not persist");
    },
  }, "dry_run");
  assertEquals(renders, 1);
  assertEquals(entries.map((entry) => entry.verification_state), [
    "dry_run_proven",
    "not_selected",
  ]);
  assertEquals(entries[0].old_object_key, null);
});

Deno.test("one refusal continues to the next card", async () => {
  const entries = await runGuardedSweep([
    row(),
    row({ job_id: "job-2", docket_revision_id: "revision-2" }),
  ], {
    render: (candidate) =>
      candidate.job_id.endsWith("1")
        ? Promise.reject(new Error("source refused"))
        : Promise.resolve(rendered()),
  }, "dry_run");
  assertEquals(entries[0].refusal?.code, "candidate_reconstruction_failed");
  assertEquals(entries[1].verification_state, "dry_run_proven");
});

Deno.test("oversize current-wiki output is a stable per-card refusal", async () => {
  const [entry] = await runGuardedSweep([row()], {
    render: () => Promise.resolve(rendered(REPORT_MAX_BYTES + 1)),
  }, "dry_run");
  assertEquals(entry.refusal?.code, "current_wiki_report_oversize");
  assertEquals(entry.render_size_bytes, REPORT_MAX_BYTES + 1);
  assertEquals(entry.max_size_bytes, REPORT_MAX_BYTES);
});

Deno.test("apply uses only exact reviewed targets and content", async () => {
  const dry = await runGuardedSweep([row()], {
    render: () => Promise.resolve(rendered()),
  }, "dry_run");
  let attaches = 0;
  let prepares = 0;
  const applied = await runGuardedSweep(
    [row()],
    {
      render: () => Promise.resolve(rendered()),
      attach: () => {
        attaches++;
        return Promise.resolve({ document_id: "doc-new", skipped: false });
      },
      prepare: () => {
        prepares++;
        return Promise.resolve({ revision_id: "revision-new" });
      },
    },
    "apply",
    dry,
  );
  assertEquals(applied[0].verification_state, "applied");
  assertEquals([attaches, prepares], [1, 1]);

  const drifted = await runGuardedSweep(
    [row({ docket_revision_id: "changed" })],
    {
      render: () => Promise.resolve(rendered()),
      attach: () => {
        attaches++;
        return Promise.resolve({ document_id: "unexpected", skipped: false });
      },
      prepare: () => {
        prepares++;
        return Promise.resolve({ revision_id: "unexpected" });
      },
    },
    "apply",
    dry,
  );
  assertEquals(drifted[0].refusal?.code, "reviewed_target_drift");
  assertEquals([attaches, prepares], [1, 1]);
});

Deno.test("idempotent retry accepts no-op attachment and one content-addressed prepare", async () => {
  const dry = await runGuardedSweep([row()], {
    render: () => Promise.resolve(rendered()),
  }, "dry_run");
  const writes: string[] = [];
  const deps = {
    render: () => Promise.resolve(rendered()),
    attach: () => Promise.resolve({ document_id: "same-doc", skipped: true }),
    prepare: () => {
      writes.push("prepare-content-addressed");
      return Promise.resolve({ revision_id: "same-revision" });
    },
  };
  const first = await runGuardedSweep([row()], deps, "apply", dry);
  const retry = await runGuardedSweep([row()], deps, "apply", dry);
  assertEquals(first[0].new_document_id, "same-doc");
  assertEquals(retry[0].new_revision_id, "same-revision");
  assertEquals(writes, [
    "prepare-content-addressed",
    "prepare-content-addressed",
  ]);
});
