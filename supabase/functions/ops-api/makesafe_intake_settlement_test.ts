// deno-lint-ignore-file no-import-prefix no-explicit-any

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ensureIntakeWorkOrderEvidence,
  settleApprovedIntakeDraft,
} from "./makesafe_intake_settlement.ts";

function client(existing: any[] = [], insertError: any = null) {
  const inserts: any[] = [];
  const query: any = {
    select() {
      return query;
    },
    in() {
      return query;
    },
    eq() {
      return Promise.resolve({ data: existing, error: null });
    },
  };
  return {
    inserts,
    client: {
      from() {
        return {
          select() {
            return query;
          },
          insert(row: any) {
            inserts.push(row);
            return Promise.resolve({ data: null, error: insertError });
          },
        };
      },
    },
  };
}

Deno.test("work-order evidence continuation fans every source PDF to every minted job idempotently", async () => {
  const db = client([
    {
      job_id: "job-1",
      storage_url: "storage/work-order.pdf",
      pdf_url: "storage/work-order.pdf",
    },
  ]);
  await ensureIntakeWorkOrderEvidence(
    db.client,
    ["job-1", "job-2", "job-2"],
    [{
      file_name: "work-order.pdf",
      storage_url: "storage/work-order.pdf",
    }],
    {},
  );

  assertEquals(db.inserts, [{
    job_id: "job-2",
    type: "work_order",
    file_name: "work-order.pdf",
    storage_url: "storage/work-order.pdf",
    pdf_url: "storage/work-order.pdf",
    visible_to_trades: true,
  }]);
});

Deno.test("work-order evidence continuation remains retryable after an insert failure", async () => {
  const db = client([], { message: "storage write failed" });
  await assertRejects(
    () =>
      ensureIntakeWorkOrderEvidence(
        db.client,
        ["job-1"],
        [{ pdf_url: "storage/work-order.pdf" }],
        {},
      ),
    Error,
    "work-order evidence attach failed",
  );
});

Deno.test("settlement repairs legacy evidence but only explicit mint authority can notify", async () => {
  const notifications: string[] = [];
  const mintRows: any[] = [];
  const db = client([]);
  const settlementClient: any = db.client;
  const originalFrom = settlementClient.from;
  settlementClient.from = (table: string) => {
    if (table === "makesafe_intake_job_mints") {
      const query: any = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        order() {
          return Promise.resolve({ data: mintRows, error: null });
        },
      };
      return query;
    }
    return originalFrom(table);
  };

  const result = await settleApprovedIntakeDraft(settlementClient, {
    draftId: "draft-legacy",
    approvedJobId: "legacy-job",
    attachments: [{ pdf_url: "storage/work-order.pdf" }],
    extraction: { deterministic_intake: true },
    notify: async (input) => {
      notifications.push(input.jobId);
      return { accepted: true, reason: "accepted", auditId: "audit-1" };
    },
  });

  assertEquals(result.jobIds, ["legacy-job"]);
  assertEquals(result.notificationJobIds, []);
  assertEquals(notifications, []);
  assertEquals(db.inserts[0].job_id, "legacy-job");
});
