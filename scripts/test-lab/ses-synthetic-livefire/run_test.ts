// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildFixtureRun } from "./fixtures.ts";
import {
  assertCleanupSettled,
  assertExclusiveJobDocumentStorageRefs,
  guardInventory,
  type Inventory,
  isMissingOptionalMutableTable,
  operationalCounts,
} from "./run.ts";
import { LivefireHttpError } from "./client.ts";

const RUN_ID = "018f7f2c-4db4-7c61-92c7-2b2b97e0a111";

async function validInventory(): Promise<{
  run: Awaited<ReturnType<typeof buildFixtureRun>>;
  inventory: Inventory;
}> {
  const run = await buildFixtureRun({
    runId: RUN_ID,
    expiresAtMs: Date.now() + 60_000,
    secret: "cleanup-guard-test-secret",
  });
  const subject = run.fixtures[0].subject;
  const postId = "synthetic-post-1";
  const caseId = "case-1";
  const jobId = "job-1";
  const markerObject = { synthetic_livefire_marker: run.marker };
  return {
    run,
    inventory: {
      marker: run.marker,
      emails: [{
        post_id: postId,
        mailbox: run.mailbox,
        from_email: run.sender,
        subject,
        attachments_settled: true,
      }],
      attachments: [{
        id: "attachment-1",
        email_id: postId,
        storage_path: `${postId}/fixture.pdf`,
      }],
      rawEvents: [{ id: "raw-1", post_id: postId, change_type: "created" }],
      sourceIssues: [],
      caseSources: [{
        id: "source-1",
        post_id: postId,
        case_id: caseId,
        raw_identity_json: markerObject,
        evidence: markerObject,
      }],
      cases: [{ id: caseId, job_id: jobId, ...markerObject }],
      caseEvents: [{
        id: "case-event-1",
        case_id: caseId,
        evidence: markerObject,
      }],
      intakeArtifacts: [{
        id: "artifact-1",
        case_id: caseId,
        evidence: markerObject,
      }],
      jobs: [{ id: jobId, metadata: markerObject }],
      details: [],
      jobEvents: [{
        id: "job-event-1",
        job_id: jobId,
        detail_json: markerObject,
      }],
      jobDocuments: [{
        id: "document-1",
        job_id: jobId,
        storage_url: `${jobId}/work-order.pdf`,
        data_snapshot_json: markerObject,
      }],
      attendanceCycles: [],
      readinessCurrent: [{
        job_id: jobId,
        dependency_generation: 0,
      }],
      readinessInvalidations: [{
        id: "readiness-invalidation-1",
        job_id: jobId,
        generation_before: 0,
        generation_after: 1,
      }],
      boardApplications: [],
      docketRevisions: [],
      docketArtifacts: [],
      releaseRevisions: [],
      releaseMembers: [],
      revisionApprovals: [],
      externalEffects: [],
      xeroInvoices: [],
      emailEvents: [{
        id: "email-event-1",
        sender: run.sender,
        recipient: run.mailbox,
        subject,
      }],
      intakeDrafts: [{
        id: "draft-1",
        extraction_json: markerObject,
      }],
      mutableOperationalRows: {},
    },
  };
}

Deno.test("cleanup guard accepts only an end-to-end exact marker chain", async () => {
  const { run, inventory } = await validInventory();
  guardInventory(run, inventory);
  assertEquals(operationalCounts(inventory), {
    active_jobs: 1,
    attachment_objects: 1,
    intake_drafts: 1,
    job_documents: 1,
    document_objects: 1,
    email_events: 1,
    docket_revisions: 0,
    docket_artifacts: 0,
    release_revisions: 0,
    release_members: 0,
    revision_approvals: 0,
    external_effects: 0,
    xero_invoices: 0,
    mutable_operational_rows: 0,
  });
});

Deno.test("cleanup guard refuses an unmarked deletable row", async () => {
  const { run, inventory } = await validInventory();
  inventory.jobDocuments[0].data_snapshot_json = {};
  assertThrows(
    () => guardInventory(run, inventory),
    Error,
    "job document without exact marker",
  );
});

Deno.test("cleanup guard refuses readiness residue outside marker jobs", async () => {
  const { run, inventory } = await validInventory();
  inventory.readinessInvalidations[0].job_id = "foreign-job";
  assertThrows(
    () => guardInventory(run, inventory),
    Error,
    "operational child outside marker jobs",
  );
});

Deno.test("cleanup guard refuses any forbidden release residue", async () => {
  const { run, inventory } = await validInventory();
  inventory.releaseRevisions.push({ id: "release-1" });
  assertThrows(
    () => guardInventory(run, inventory),
    Error,
    "unexpectedly created 1 release revisions",
  );
});

Deno.test("cleanup guard refuses synthetic-linked trade invoice residue", async () => {
  const { run, inventory } = await validInventory();
  inventory.mutableOperationalRows.trade_invoice_lines = [{
    id: "trade-invoice-line-1",
    job_id: inventory.jobs[0].id,
    trade_invoice_id: "trade-invoice-1",
  }];
  assertThrows(
    () => guardInventory(run, inventory),
    Error,
    "unexpectedly created 1 trade invoice lines",
  );
});

Deno.test("cleanup guard retains an unmarked append-only issue only under an exact marker source", async () => {
  const { run, inventory } = await validInventory();
  const issue = {
    id: "source-issue-1",
    post_id: inventory.emails[0].post_id,
    mailbox: run.mailbox,
    change_type: "intake_deferred_scan_run_cap_deferred",
    page_meta: { source_fate: "deferred_next_run" },
  };
  inventory.rawEvents.push(issue);
  inventory.sourceIssues.push(issue);
  guardInventory(run, inventory);

  issue.post_id = "foreign-post";
  assertThrows(
    () => guardInventory(run, inventory),
    Error,
    "source child outside marker roots",
  );
});

Deno.test("content-addressed job documents require exact exclusive marker references", async () => {
  const { run, inventory } = await validInventory();
  const path =
    "makesafe-deterministic/0123456789abcdef/sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.pdf";
  inventory.jobDocuments[0].storage_url = path;
  guardInventory(run, inventory);
  assertExclusiveJobDocumentStorageRefs(
    run,
    inventory,
    path,
    [inventory.jobDocuments[0]],
  );

  assertThrows(
    () =>
      assertExclusiveJobDocumentStorageRefs(run, inventory, path, [{
        ...inventory.jobDocuments[0],
        id: "foreign-document",
      }]),
    Error,
    "shared or foreign job-document object",
  );
});

Deno.test("cleanup waits for every attempted message and attachment sync", async () => {
  const { inventory } = await validInventory();
  assertCleanupSettled(inventory, 1);

  assertThrows(
    () => assertCleanupSettled(inventory, 2),
    Error,
    "captured 1/2 attempted fixture messages",
  );

  inventory.emails[0].attachments_settled = false;
  assertThrows(
    () => assertCleanupSettled(inventory, 1),
    Error,
    "has not finished attachment sync",
  );
});

Deno.test("inventory tolerates only the exact missing optional mutable table", () => {
  const missingDraftNotes = new LivefireHttpError(
    "GET draft_notes",
    404,
    '{"code":"PGRST205","message":"Could not find the table \'public.draft_notes\' in the schema cache"}',
  );
  assertEquals(
    isMissingOptionalMutableTable(missingDraftNotes, "draft_notes"),
    true,
  );
  assertEquals(
    isMissingOptionalMutableTable(missingDraftNotes, "job_variations"),
    false,
  );
  assertEquals(
    isMissingOptionalMutableTable(
      new LivefireHttpError("GET draft_notes", 500, missingDraftNotes.detail),
      "draft_notes",
    ),
    false,
  );
});

Deno.test("readiness cleanup migration is marker- and run-ledger-bound", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "../../../supabase/migrations/20260728030000_synthetic_livefire_readiness_cleanup.sql",
      import.meta.url,
    ),
  );
  for (
    const required of [
      "CREATE OR REPLACE FUNCTION public.purge_synthetic_livefire_jobs",
      "job.metadata->>'synthetic_livefire_marker' = run.marker",
      "run.job_ids ? p_job_id::text",
      "run.state IN ('active', 'cleanup_complete')",
      "PERFORM set_config('app.synthetic_livefire_purge_marker', p_marker, true)",
      "TG_TABLE_NAME = 'makesafe_readiness_invalidations'",
      "DELETE FROM public.makesafe_readiness_invalidations",
      "DELETE FROM public.makesafe_readiness_current",
      "DELETE FROM public.jobs",
      "v_marked_count > v_ledger_count OR v_bound_count <> v_marked_count",
      "synthetic live-fire purge scope mismatch",
      "synthetic live-fire purge refused money, release, docket, projection, or committed-readiness residue",
      "REVOKE ALL ON FUNCTION public.purge_synthetic_livefire_jobs(text)",
    ]
  ) {
    if (!migration.includes(required)) {
      throw new Error(`missing readiness cleanup guard: ${required}`);
    }
  }
});
