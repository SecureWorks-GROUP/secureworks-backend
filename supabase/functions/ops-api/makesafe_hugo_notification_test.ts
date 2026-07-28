// deno-lint-ignore-file no-explicit-any no-import-prefix

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildHugoTradeDeepLink,
  type HugoNotificationDeps,
  notifyDeterministicPhysicalJob,
} from "./makesafe_hugo_notification.ts";

const CASE_ID = "11111111-1111-1111-1111-111111111111";
const JOB_ID = "22222222-2222-2222-2222-222222222222";
const ATTEMPTED_AT = "2026-07-28T04:00:00.000Z";

function auditClient(options: {
  duplicateAfterFirst?: boolean;
  insertError?: any;
  updateError?: any;
} = {}) {
  const inserts: any[] = [];
  const updates: any[] = [];
  return {
    inserts,
    updates,
    client: {
      from(table: string) {
        assertEquals(table, "makesafe_intake_hugo_notifications");
        return {
          insert(row: any) {
            inserts.push(row);
            return {
              select() {
                return {
                  single: () => {
                    const duplicate = options.duplicateAfterFirst &&
                      inserts.length > 1;
                    const error = duplicate
                      ? { code: "23505", message: "unique violation" }
                      : options.insertError || null;
                    return Promise.resolve({
                      data: error ? null : { id: `audit-${inserts.length}` },
                      error,
                    });
                  },
                };
              },
            };
          },
          update(patch: any) {
            updates.push(patch);
            return {
              eq() {
                return {
                  select() {
                    return {
                      maybeSingle: () =>
                        Promise.resolve({
                          data: options.updateError ? null : { id: "audit-1" },
                          error: options.updateError || null,
                        }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    },
  };
}

function deps(
  overrides: Partial<HugoNotificationDeps> = {},
): HugoNotificationDeps {
  return {
    loadBoardJob: () =>
      Promise.resolve({
        jobId: JOB_ID,
        jobNumber: "SWMS-270001",
        canonicalStage: "new",
        sesFamily: "physical_makesafe",
      }),
    loadConfig: () =>
      Promise.resolve({
        enabled: true,
        fromNumber: "+61000000000",
        recipient: {
          userId: "33333333-3333-3333-3333-333333333333",
          name: "Configured make-safe manager",
          phone: "+61000000001",
        },
        failureReason: null,
      }),
    sendSms: () =>
      Promise.resolve({
        accepted: true,
        messageId: "ghl-message-1",
        failureReason: null,
      }),
    now: () => ATTEMPTED_AT,
    ...overrides,
  };
}

function input(syntheticLivefireMarker?: string | null) {
  return {
    caseId: CASE_ID,
    sourcePostIds: ["source-a", "source-b", "source-a"],
    jobId: JOB_ID,
    syntheticLivefireMarker,
  };
}

Deno.test("Hugo notification claims once, sends through the injected SMS transport, and records provider acceptance", async () => {
  const audit = auditClient();
  const sends: any[] = [];
  const result = await notifyDeterministicPhysicalJob(
    audit.client,
    input(),
    deps({
      sendSms: (phone, message, fromNumber) => {
        sends.push({ phone, message, fromNumber });
        return Promise.resolve({
          accepted: true,
          messageId: "ghl-message-1",
          failureReason: null,
        });
      },
    }),
  );

  assertEquals(result.accepted, true);
  assertEquals(result.providerMessageId, "ghl-message-1");
  assertEquals(sends.length, 1);
  assertEquals(audit.inserts.length, 1);
  assertEquals(audit.updates.length, 1);
  assertEquals(audit.inserts[0].case_id, CASE_ID);
  assertEquals(audit.inserts[0].source_post_ids, ["source-a", "source-b"]);
  assertEquals(audit.inserts[0].job_id, JOB_ID);
  assertEquals(audit.inserts[0].board_stage, "new");
  assertEquals(audit.inserts[0].board_observed_at, ATTEMPTED_AT);
  assertEquals(audit.inserts[0].attempted_at, ATTEMPTED_AT);
  assertEquals(audit.inserts[0].state, "attempting");
  assertEquals(
    audit.inserts[0].failure_reason,
    "provider_result_not_recorded",
  );
  assertEquals(audit.inserts[0].recipient_set.length, 1);
  assertEquals(
    audit.inserts[0].deep_link,
    buildHugoTradeDeepLink(JOB_ID),
  );
  assertStringIncludes(sends[0].message, JOB_ID);
  assertStringIncludes(sends[0].message, `#job/${JOB_ID}`);
  assertEquals(audit.updates[0], {
    state: "accepted",
    provider_message_id: "ghl-message-1",
    provider_accepted_at: ATTEMPTED_AT,
    failure_reason: null,
    updated_at: ATTEMPTED_AT,
  });
});

Deno.test("Hugo notification unique claim prevents a second provider dispatch", async () => {
  const audit = auditClient({ duplicateAfterFirst: true });
  let sends = 0;
  const notificationDeps = deps({
    sendSms: () => {
      sends++;
      return Promise.resolve({
        accepted: true,
        messageId: `message-${sends}`,
        failureReason: null,
      });
    },
  });

  const first = await notifyDeterministicPhysicalJob(
    audit.client,
    input(),
    notificationDeps,
  );
  const second = await notifyDeterministicPhysicalJob(
    audit.client,
    input(),
    notificationDeps,
  );

  assertEquals(first.accepted, true);
  assertEquals(second.reason, "already_recorded");
  assertEquals(sends, 1);
});

Deno.test("Hugo notification persists a provider rejection as a visible failure", async () => {
  const audit = auditClient();
  const result = await notifyDeterministicPhysicalJob(
    audit.client,
    input(),
    deps({
      sendSms: () =>
        Promise.resolve({
          accepted: false,
          messageId: null,
          failureReason: "ghl_http_500:provider unavailable",
        }),
    }),
  );

  assertEquals(result.attempted, true);
  assertEquals(result.accepted, false);
  assertEquals(result.reason, "ghl_http_500:provider unavailable");
  assertEquals(audit.updates[0].state, "failed");
  assertEquals(
    audit.updates[0].failure_reason,
    "ghl_http_500:provider unavailable",
  );
});

Deno.test("Hugo notification records board/config precondition failures without sending", async () => {
  const audit = auditClient();
  let sends = 0;
  const result = await notifyDeterministicPhysicalJob(
    audit.client,
    input(),
    deps({
      loadBoardJob: () => Promise.resolve(null),
      sendSms: () => {
        sends++;
        return Promise.resolve({
          accepted: true,
          messageId: "must-not-send",
          failureReason: null,
        });
      },
    }),
  );

  assertEquals(result.reason, "job_not_on_canonical_board");
  assertEquals(result.attempted, false);
  assertEquals(sends, 0);
  assertEquals(audit.inserts[0].state, "failed");
  assertEquals(
    audit.inserts[0].failure_reason,
    "job_not_on_canonical_board",
  );
});

Deno.test("Hugo notification preserves an unsupported canonical stage in the failure audit", async () => {
  const audit = auditClient();
  let sends = 0;
  const result = await notifyDeterministicPhysicalJob(
    audit.client,
    input(),
    deps({
      loadBoardJob: () =>
        Promise.resolve({
          jobId: JOB_ID,
          jobNumber: "SWMS-999999",
          canonicalStage: "future_stage",
          sesFamily: "physical_makesafe",
        }),
      sendSms: () => {
        sends++;
        return Promise.resolve({
          accepted: true,
          messageId: "must-not-send",
          failureReason: null,
        });
      },
    }),
  );

  assertEquals(result.reason, "canonical_board_stage_unsupported");
  assertEquals(sends, 0);
  assertEquals(audit.inserts[0].board_stage, "future_stage");
  assertEquals(
    audit.inserts[0].failure_reason,
    "canonical_board_stage_unsupported",
  );
});

Deno.test("Hugo notification kill switch suppresses transport even when recipient configuration is incomplete", async () => {
  const audit = auditClient();
  let sends = 0;
  const result = await notifyDeterministicPhysicalJob(
    audit.client,
    input(),
    deps({
      loadConfig: () =>
        Promise.resolve({
          enabled: false,
          fromNumber: null,
          recipient: null,
          failureReason: "hugo_recipient_missing",
        }),
      sendSms: () => {
        sends++;
        return Promise.resolve({
          accepted: true,
          messageId: "must-not-send",
          failureReason: null,
        });
      },
    }),
  );

  assertEquals(result.reason, "notification_disabled");
  assertEquals(sends, 0);
  assertEquals(audit.inserts[0].failure_reason, "notification_disabled");
});

Deno.test("synthetic live-fire suppresses board, config, audit, and provider work", async () => {
  let reads = 0;
  let sends = 0;
  const client = {
    from() {
      throw new Error("synthetic notification must not touch the audit table");
    },
  };
  const result = await notifyDeterministicPhysicalJob(
    client,
    input("SWG-SES-LIVEFIRE-TEST-ONLY-RUN-1"),
    deps({
      loadBoardJob: () => {
        reads++;
        return Promise.resolve(null);
      },
      loadConfig: () => {
        reads++;
        return Promise.reject(new Error("must not read config"));
      },
      sendSms: () => {
        sends++;
        return Promise.resolve({
          accepted: true,
          messageId: "must-not-send",
          failureReason: null,
        });
      },
    }),
  );

  assertEquals(result.reason, "synthetic_livefire_suppressed");
  assertEquals(result.auditId, null);
  assertEquals(reads, 0);
  assertEquals(sends, 0);
});
