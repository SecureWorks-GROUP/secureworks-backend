// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runSourcePersistRecovery,
  SourcePersistRecoveryError,
} from "./makesafe_source_persist_recovery.ts";

function successfulDeps() {
  let snapshots = 0;
  return {
    loadQueueSnapshot: () => {
      snapshots++;
      return Promise.resolve({
        targetCards: snapshots === 1 ? 1 : 0,
        unrelatedCards: 6,
        unrelatedFingerprint: "unchanged-six",
      });
    },
    loadAuthority: () =>
      Promise.resolve({
        caseId: "exact-fallback-case",
        instructionKey: "exact-obligation/cycle:1",
        state: "exception",
        reasonCode: "adapter_parse_failure",
        lastDecisionReason: "deterministic source_persist_failed case_insert",
        isAuthoritative: false,
        jobId: null,
        sourceCount: 2,
      }),
    recover: () =>
      Promise.resolve({
        totals: {
          cases_attempted: 1,
          cases_failed: 0,
          jobs_created: 1,
          hugo_notifications_required: 1,
          hugo_notifications_suppressed: 1,
          hugo_notifications_recorded: 0,
          hugo_notifications_accepted: 0,
          hugo_notifications_failed: 0,
        },
      }),
    loadOutcome: () =>
      Promise.resolve({
        caseAuthoritative: true,
        caseState: "confirmed_live_job",
        caseReasonCode: null,
        jobExists: true,
        jobUnassigned: true,
        logicalJobs: 1,
        assignments: 0,
        invoices: 0,
        communications: 0,
        notifications: 0,
        outboundQueueRows: 0,
      }),
  };
}

Deno.test("exact fallback recovery returns one unassigned no-send card and preserves the other six", async () => {
  const result = await runSourcePersistRecovery({
    external_ref: "MLB-RR-26836",
    builder_purchase_order: "PO-57602",
  }, successfulDeps());

  assertEquals(result.target, {
    external_ref: "MLB-RR-26836",
    builder_purchase_order: "PO-57602",
  });
  assertEquals(result.scope, { authoritative: true, source_rows: 2 });
  assertEquals(result.job, {
    created: true,
    unassigned: true,
    logical_jobs: 1,
  });
  assertEquals(result.notifications, {
    required: 1,
    suppressed: 1,
    recorded: 0,
    accepted: 0,
    failed: 0,
  });
  assertEquals(result.side_effects, {
    assignments: 0,
    invoices: 0,
    communications: 0,
    outbound_queue_rows: 0,
    unrelated_exception_cards_unchanged: true,
    unrelated_exception_cards: 6,
  });
});

Deno.test("recovery refuses every identity outside MLB-RR-26836 and PO-57602", async () => {
  await assertRejects(
    () =>
      runSourcePersistRecovery({
        external_ref: "MLB-RR-26836",
        builder_purchase_order: "PO-00000",
      }, successfulDeps()),
    SourcePersistRecoveryError,
    "authorized only for the exact named obligation",
  );
});

Deno.test("recovery fails closed if any send or queue side effect appears", async () => {
  const deps = successfulDeps();
  deps.loadOutcome = () =>
    Promise.resolve({
      caseAuthoritative: true,
      caseState: "confirmed_live_job",
      caseReasonCode: null,
      jobExists: true,
      jobUnassigned: true,
      logicalJobs: 1,
      assignments: 0,
      invoices: 0,
      communications: 0,
      notifications: 1,
      outboundQueueRows: 0,
    });
  await assertRejects(
    () =>
      runSourcePersistRecovery({
        external_ref: "MLB-RR-26836",
        builder_purchase_order: "PO-57602",
      }, deps),
    SourcePersistRecoveryError,
    "operational postcondition failed",
  );
});
