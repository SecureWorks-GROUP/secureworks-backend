// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseOptions,
  sweepPrepareOutcome,
} from "./ses-curated-docket-sweep-v1.ts";

const SOURCE_PROOF = {
  source_kind: "previously_committed_pdf",
  source_identity: "docket-revision:source-revision/artifact:source-artifact",
  source_document_id: "source-document",
  source_revision_id: "source-revision",
  source_artifact_id: "source-artifact",
  source_artifact_content_hash: `sha256:${"a".repeat(64)}`,
  expected_raw_sha256: `sha256:${"b".repeat(64)}`,
};

function revision(overrides: Record<string, unknown> = {}) {
  return {
    state: "ready",
    persisted: false,
    blockers: [],
    docket_revision_id: "prepared-revision",
    artifacts: [{
      role: "supporting_report_plan",
      metadata: { selected_source: SOURCE_PROOF },
    }],
    ...overrides,
  };
}

Deno.test("operator defaults to prepare-only dry-run and an untracked manifest path", () => {
  const options = parseOptions([]);
  assertEquals(options.mode, "dry_run");
  assert(options.manifest.startsWith("/tmp/"));
});

Deno.test("apply is explicit and consumes a named reviewed manifest", () => {
  assertEquals(parseOptions(["--apply", "--manifest", "/tmp/reviewed.json"]), {
    mode: "apply",
    manifest: "/tmp/reviewed.json",
  });
  assertThrows(() => parseOptions(["--unknown"]), Error, "unknown option");
});

Deno.test("sweep has no raw-report renderer or attachment capability", async () => {
  const source = await Deno.readTextFile(
    new URL("./ses-curated-docket-sweep-v1.ts", import.meta.url),
  );
  for (
    const forbidden of [
      "job_service_reports",
      "render_makesafe_report.py",
      "attach_current_wiki_curated_report",
      "currentWikiRendererCommand",
      "SW_WIKI_REPO",
      "--allow-run",
    ]
  ) {
    assertEquals(source.includes(forbidden), false, forbidden);
  }
  assertStringIncludes(source, 'opsAction("prepare_ses_docket_revision"');
  assertStringIncludes(source, "expected_physical_report_proof");
  assertStringIncludes(source, "require_ready_for_persistence: true");
});

Deno.test("prepare outcome refuses every blocker, non-ready state, and unpersisted apply", () => {
  const blocked = sweepPrepareOutcome(
    revision({
      state: "blocked",
      blockers: [{
        reason_code: "pricing_evidence_missing",
        recovery_action: "Recover pricing evidence.",
      }],
    }),
    { dry_run: true },
  );
  assertEquals(blocked.source, SOURCE_PROOF);
  assertEquals(blocked.refusal?.code, "pricing_evidence_missing");

  const unpersisted = sweepPrepareOutcome(revision(), { dry_run: false });
  assertEquals(unpersisted.source, SOURCE_PROOF);
  assertEquals(unpersisted.refusal?.code, "persistent_prepare_refused");

  const applied = sweepPrepareOutcome(revision({ persisted: true }), {
    dry_run: false,
  });
  assertEquals(applied.refusal, undefined);
});
