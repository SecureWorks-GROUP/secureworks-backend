// deno-lint-ignore-file no-import-prefix require-await
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BWCWA_6648_SOURCE_POST_ID,
  MLB_27309_SOURCE_POST_ID,
  runAdjudicatedExactRescan,
  runAdjudicatedHistoricalBackfill,
  SES_MISSED_JOB_ADJUDICATION_REF,
  SES_MISSED_JOB_RULING_DATE,
  SesMissedJobRecoveryError,
} from "./ses_missed_job_recovery.ts";

function boundRoofJob(id = "job-mlb") {
  const cycleId = `${id}:attendance:1`;
  return {
    id,
    jobNumber: "SWMS-27309",
    jobFamily: "roof_report",
    attendance: {
      currentAttendanceCycleId: cycleId,
      immutableAttendanceCycleIds: [cycleId],
      attribution: "bound",
      cycleNumber: 1,
    },
  };
}

Deno.test("adjudicated exact rescan reuses the exact scanner and records fixed provenance", async () => {
  const calls: string[] = [];
  const result = await runAdjudicatedExactRescan({
    post_id: MLB_27309_SOURCE_POST_ID,
    expected_job_family: "roof_report",
  }, {
    loadAuthority: async () => ({
      caseId: "case-mlb",
      state: "exception",
      jobId: null,
      targetJobId: null,
    }),
    scan: async (postId) => {
      calls.push(`scan:${postId}`);
      return { totals: { jobs_created: 1 } };
    },
    loadJob: async () => boundRoofJob(),
    appendProvenance: async ({ postId, job }) => {
      calls.push(`provenance:${postId}:${job.id}`);
    },
    hasProvenance: async () => false,
    canRepairProvenance: async () => false,
  });

  assertEquals(calls, [
    `scan:${MLB_27309_SOURCE_POST_ID}`,
    `provenance:${MLB_27309_SOURCE_POST_ID}:job-mlb`,
  ]);
  assertEquals(result.outcome, "minted");
  assertEquals(result.job_family, "roof_report");
  assertEquals(SES_MISSED_JOB_RULING_DATE, "2026-08-01");
  assertEquals(
    SES_MISSED_JOB_ADJUDICATION_REF,
    "data/ses-shadow-adjudicate-v1/report.md#6.1",
  );
});

Deno.test("adjudicated exact rescan refuses non-exception and already-bound sources before scanning", async () => {
  let scans = 0;
  const deps = (state: string, targetJobId: string | null = null) => ({
    loadAuthority: async () => ({
      caseId: "case-1",
      state,
      jobId: null,
      targetJobId,
    }),
    scan: async () => {
      scans++;
      return {};
    },
    loadJob: async () => null,
    appendProvenance: async () => {},
    hasProvenance: async () => false,
    canRepairProvenance: async () => false,
  });

  await assertRejects(
    () =>
      runAdjudicatedExactRescan({
        post_id: MLB_27309_SOURCE_POST_ID,
        expected_job_family: "roof_report",
      }, deps("accounted_non_wo")),
    SesMissedJobRecoveryError,
    "prior no-job fate accounted_non_wo is not eligible",
  );
  await assertRejects(
    () =>
      runAdjudicatedExactRescan({
        post_id: MLB_27309_SOURCE_POST_ID,
        expected_job_family: "roof_report",
      }, deps("exception", "job-existing")),
    SesMissedJobRecoveryError,
    "corrected target job binding",
  );
  assertEquals(scans, 0);
});

Deno.test("adjudicated exact rescan accepts no broad or extra selector", async () => {
  await assertRejects(
    () =>
      runAdjudicatedExactRescan({
        post_id: "post-1",
        expected_job_family: "roof_report",
        source_ids: ["post-1", "post-2"],
      } as never, {} as never),
    SesMissedJobRecoveryError,
    "must contain exactly",
  );
});

Deno.test("adjudicated exact rescan repairs partial provenance only after settled mint and accepted Hugo proof", async () => {
  let complete = false;
  let scans = 0;
  const result = await runAdjudicatedExactRescan({
    post_id: MLB_27309_SOURCE_POST_ID,
    expected_job_family: "roof_report",
  }, {
    loadAuthority: async () => ({
      caseId: "case-mlb",
      state: "confirmed_live_job",
      jobId: "job-mlb",
      targetJobId: null,
    }),
    scan: async () => {
      scans++;
      return {};
    },
    loadJob: async () => boundRoofJob(),
    appendProvenance: async () => {
      complete = true;
    },
    hasProvenance: async () => complete,
    canRepairProvenance: async () => true,
  });
  assertEquals(scans, 0);
  assertEquals(complete, true);
  assertEquals(result.outcome, "already_completed");
});

Deno.test("adjudicated exact rescan refuses an unbound roof result before provenance", async () => {
  let provenanceWrites = 0;
  await assertRejects(
    () =>
      runAdjudicatedExactRescan({
        post_id: MLB_27309_SOURCE_POST_ID,
        expected_job_family: "roof_report",
      }, {
        loadAuthority: async () => ({
          caseId: "case-mlb",
          state: "exception",
          jobId: null,
          targetJobId: null,
        }),
        scan: async () => ({ totals: { jobs_created: 1 } }),
        loadJob: async () => ({
          ...boundRoofJob(),
          attendance: {
            currentAttendanceCycleId: null,
            immutableAttendanceCycleIds: [],
            attribution: null,
            cycleNumber: 1,
          },
        }),
        appendProvenance: async () => {
          provenanceWrites++;
        },
        hasProvenance: async () => false,
        canRepairProvenance: async () => false,
      }),
    SesMissedJobRecoveryError,
    "current attendance cycle is not bound inside the immutable cycle set",
  );
  assertEquals(provenanceWrites, 0);
});

Deno.test("captain ruling cannot be reused for an unrelated exact source", async () => {
  await assertRejects(
    () =>
      runAdjudicatedExactRescan({
        post_id: "unrelated-post",
        expected_job_family: "roof_report",
      }, {} as never),
    SesMissedJobRecoveryError,
    "authorizes only MLB-27309",
  );
});

Deno.test("historical backfill creates, binds, links, archives, and records provenance without a communication callback", async () => {
  const calls: string[] = [];
  const result = await runAdjudicatedHistoricalBackfill({
    post_id: BWCWA_6648_SOURCE_POST_ID,
    invoice_number: "INV-0754",
    external_ref: "BWCWA-6648",
    invoice_date: "2026-06-24",
    requesting_company_slug: "bw",
    expected_job_family: "general_makesafe",
  }, {
    loadAuthority: async () => ({
      caseId: "case-bwcwa",
      state: "exception",
      jobId: null,
      targetJobId: null,
      sourcePostIds: [BWCWA_6648_SOURCE_POST_ID, "mailbox-twin"],
      sourceCorrections: [],
      fromEmail: "builderwest.mailer@primeeco.tech",
      subject: "BWCWA6648 Builderwest New Make safe work order request",
    }),
    loadInvoice: async () => ({
      xeroInvoiceId: "xero-0754",
      invoiceNumber: "INV-0754",
      invoiceDate: "2026-06-24",
      invoiceType: "ACCREC",
      status: "AUTHORISED",
      reference: "PO20605 - BWCWA6648",
      contactName: "Builderwest",
      jobId: null,
      lineItems: [{ description: "BWCWA6648 - make safe - 2 trades" }],
    }),
    loadExistingJob: async () => null,
    createJob: async ({ recoveryKey }) => {
      calls.push(`create:${recoveryKey}`);
      return {
        id: "job-bwcwa",
        jobNumber: "SWMS-26648",
        jobFamily: "general_makesafe",
      };
    },
    ensureJobCard: async () => {
      calls.push("ensure-job-card");
    },
    bindLineage: async () => {
      calls.push("bind-lineage");
    },
    linkInvoice: async () => {
      calls.push("link-invoice");
    },
    archiveDisplay: async () => {
      calls.push("archive-display");
    },
    appendProvenance: async () => {
      calls.push("append-provenance");
    },
  });

  assertEquals(calls, [
    "create:ses-historical:BWCWA-6648:INV-0754",
    "ensure-job-card",
    "bind-lineage",
    "link-invoice",
    "archive-display",
    "append-provenance",
  ]);
  assertEquals(result.display_stage, "ARCHIVED");
  assertEquals(result.communications_sent, 0);
  assertEquals(result.invoice_number, "INV-0754");
});

Deno.test("historical backfill stops when the exact invoice evidence is absent or drifted", async () => {
  let writes = 0;
  const baseDeps = {
    loadAuthority: async () => ({
      caseId: "case-bwcwa",
      state: "exception",
      jobId: null,
      targetJobId: null,
      sourcePostIds: [BWCWA_6648_SOURCE_POST_ID],
      sourceCorrections: [],
      fromEmail: "builderwest.mailer@primeeco.tech",
      subject: "BWCWA6648 make safe",
    }),
    loadInvoice: async () => null,
    loadExistingJob: async () => null,
    createJob: async () => {
      writes++;
      return { id: "job", jobNumber: "SWMS-1", jobFamily: "general_makesafe" };
    },
    ensureJobCard: async () => {
      writes++;
    },
    bindLineage: async () => {
      writes++;
    },
    linkInvoice: async () => {
      writes++;
    },
    archiveDisplay: async () => {
      writes++;
    },
    appendProvenance: async () => {
      writes++;
    },
  };
  await assertRejects(
    () =>
      runAdjudicatedHistoricalBackfill({
        post_id: BWCWA_6648_SOURCE_POST_ID,
        invoice_number: "INV-0754",
        external_ref: "BWCWA-6648",
        invoice_date: "2026-06-24",
        requesting_company_slug: "bw",
        expected_job_family: "general_makesafe",
      }, baseDeps),
    SesMissedJobRecoveryError,
    "exact invoice was not found",
  );
  assertEquals(writes, 0);
});

Deno.test("captain ruling cannot be reused for another Builderwest reference", async () => {
  await assertRejects(
    () =>
      runAdjudicatedHistoricalBackfill({
        post_id: BWCWA_6648_SOURCE_POST_ID,
        invoice_number: "INV-0755",
        external_ref: "BWCWA-6649",
        invoice_date: "2026-06-24",
        requesting_company_slug: "bw",
        expected_job_family: "general_makesafe",
      }, {} as never),
    SesMissedJobRecoveryError,
    "authorizes only BWCWA-6648 with INV-0754",
  );
});
