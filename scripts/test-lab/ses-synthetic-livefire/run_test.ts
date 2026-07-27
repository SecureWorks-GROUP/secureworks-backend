// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildFixtureRun } from "./fixtures.ts";
import {
  assertCleanupSettled,
  guardInventory,
  type Inventory,
  operationalCounts,
} from "./run.ts";

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

Deno.test("cleanup guard refuses any forbidden release residue", async () => {
  const { run, inventory } = await validInventory();
  inventory.releaseRevisions.push({ id: "release-1" });
  assertThrows(
    () => guardInventory(run, inventory),
    Error,
    "unexpectedly created 1 release revisions",
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
