// deno-lint-ignore-file no-explicit-any no-import-prefix

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildHugoTradeDeepLink,
  buildRepairNotificationMessage,
  buildRepairOpsDeepLink,
  type HugoNotificationDeps,
  notifyDeterministicPhysicalJob,
} from "./makesafe_hugo_notification.ts";
import {
  auditClient,
  MAKESAFE_TEXT_RECIPIENT,
  REPAIR_TEXT_RECIPIENT,
} from "./makesafe_hugo_notification_test_fakes.ts";

const CASE_ID = "11111111-1111-1111-1111-111111111111";
const JOB_ID = "22222222-2222-2222-2222-222222222222";
const ATTEMPTED_AT = "2026-07-28T04:00:00.000Z";

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
        recipient: MAKESAFE_TEXT_RECIPIENT,
        failureReason: null,
      }),
    loadRepairConfig: () =>
      Promise.resolve({
        enabled: true,
        fromNumber: "+61000000000",
        recipient: REPAIR_TEXT_RECIPIENT,
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
    { ...input(), caseId: "44444444-4444-4444-4444-444444444444" },
    notificationDeps,
  );

  assertEquals(first.accepted, true);
  assertEquals(second.accepted, true);
  assertEquals(second.reason, "already_recorded");
  assertEquals(sends, 1);
});

Deno.test("Hugo notification never retries an ambiguous provider failure", async () => {
  const audit = auditClient({ duplicateAfterFirst: true });
  let sends = 0;
  const notificationDeps = deps({
    sendSms: () => {
      sends++;
      return Promise.resolve(
        {
          accepted: false,
          messageId: null,
          failureReason: "ghl_http_500:provider unavailable",
        },
      );
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

  assertEquals(first.accepted, false);
  assertEquals(second.accepted, false);
  assertEquals(second.reason, "already_recorded_pending");
  assertEquals(audit.inserts.length, 2);
  assertEquals(sends, 1);
});

Deno.test("Hugo notification covers report-family jobs after canonical board proof", async () => {
  const audit = auditClient();
  let sends = 0;
  const result = await notifyDeterministicPhysicalJob(
    audit.client,
    input(),
    deps({
      loadBoardJob: () =>
        Promise.resolve({
          jobId: JOB_ID,
          jobNumber: "SWMS-270002",
          canonicalStage: "new",
          sesFamily: "roof_report",
        }),
      sendSms: () => {
        sends++;
        return Promise.resolve({
          accepted: true,
          messageId: "report-message",
          failureReason: null,
        });
      },
    }),
  );

  assertEquals(result.accepted, true);
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

// ── Repair jobs: the one staff text goes to the repair recipient ────────────

const REPAIR_JOB_ID = "66666666-6666-6666-6666-666666666666";
const REPAIR_OPS_LINK =
  `https://secureworks-group.github.io/secureworks-ux/ops.html#job/${REPAIR_JOB_ID}`;

function repairBoardJob(overrides: Record<string, unknown> = {}) {
  return () =>
    Promise.resolve({
      jobId: REPAIR_JOB_ID,
      jobNumber: "SWR-270010",
      canonicalStage: "new",
      sesFamily: "repair",
      jobType: "repair",
      siteSuburb: "Testville",
      ...overrides,
    });
}

function repairInput() {
  return { ...input(), jobId: REPAIR_JOB_ID };
}

function capturingSms() {
  const sends: Array<
    { phone: string; message: string; fromNumber: string | null }
  > = [];
  return {
    sends,
    sendSms: (phone: string, message: string, fromNumber: string | null) => {
      sends.push({ phone, message, fromNumber });
      return Promise.resolve({
        accepted: true,
        messageId: `ghl-message-${sends.length}`,
        failureReason: null,
      });
    },
  };
}

Deno.test("a new repair job sends one text to the repair recipient, worded as a repair with an Ops link", async () => {
  const audit = auditClient();
  const sms = capturingSms();
  const result = await notifyDeterministicPhysicalJob(
    audit.client,
    repairInput(),
    deps({ loadBoardJob: repairBoardJob(), sendSms: sms.sendSms }),
  );

  assertEquals(result.accepted, true);
  assertEquals(sms.sends, [{
    phone: REPAIR_TEXT_RECIPIENT.phone,
    message:
      `SecureWorks: New repair job SWR-270010, Testville. Open in Ops: ${REPAIR_OPS_LINK}`,
    fromNumber: "+61000000000",
  }]);
  assertEquals(audit.inserts.length, 1);
  assertEquals(audit.inserts[0].job_id, REPAIR_JOB_ID);
  assertEquals(audit.inserts[0].job_number, "SWR-270010");
  assertEquals(audit.inserts[0].deep_link, REPAIR_OPS_LINK);
  assertEquals(audit.inserts[0].message, sms.sends[0].message);
  assertEquals(audit.inserts[0].recipient_set, [{
    user_id: REPAIR_TEXT_RECIPIENT.userId,
    name: REPAIR_TEXT_RECIPIENT.name,
    phone: REPAIR_TEXT_RECIPIENT.phone,
  }]);
  assertEquals(audit.updates[0].state, "accepted");
});

Deno.test("the repair wording carries no job id in brackets, no make-safe words and no long dash", () => {
  const message = buildRepairNotificationMessage(
    REPAIR_JOB_ID,
    "SWR-270010",
    "Testville",
  );
  assertEquals(
    message,
    `SecureWorks: New repair job SWR-270010, Testville. Open in Ops: ${REPAIR_OPS_LINK}`,
  );
  assertEquals(buildRepairOpsDeepLink(REPAIR_JOB_ID), REPAIR_OPS_LINK);
  assertEquals(message.includes("("), false);
  assertEquals(/make-safe|Assign in Trade|trade\.html/.test(message), false);
  assertEquals(/[\u2012-\u2015]/.test(message), false);
  assertEquals(message.includes("\n"), false);
});

Deno.test("the repair wording leaves a missing suburb out cleanly and never prints a long dash from the job", () => {
  for (const suburb of [null, undefined, "", "   "]) {
    assertEquals(
      buildRepairNotificationMessage(REPAIR_JOB_ID, "SWR-270010", suburb),
      `SecureWorks: New repair job SWR-270010. Open in Ops: ${REPAIR_OPS_LINK}`,
    );
  }
  assertEquals(
    buildRepairNotificationMessage(
      REPAIR_JOB_ID,
      "SWR-270010",
      " Test\u2014ville  East ",
    ),
    `SecureWorks: New repair job SWR-270010, Test-ville East. Open in Ops: ${REPAIR_OPS_LINK}`,
  );
});

Deno.test("a job the board reads as a repair family is told as a repair even when its type is not repair", async () => {
  const audit = auditClient();
  const sms = capturingSms();
  await notifyDeterministicPhysicalJob(
    audit.client,
    repairInput(),
    deps({
      loadBoardJob: repairBoardJob({ jobType: "makesafe" }),
      sendSms: sms.sendSms,
    }),
  );
  assertEquals(sms.sends.length, 1);
  assertEquals(sms.sends[0].phone, REPAIR_TEXT_RECIPIENT.phone);
  assertStringIncludes(sms.sends[0].message, "New repair job SWR-270010");
});

// PINNED: the make-safe text and its recipient, byte for byte. This test fails
// if either changes, and it runs with a repair recipient configured beside it.
Deno.test("PINNED: a make-safe job sends today's text to today's make-safe recipient, unchanged by the repair recipient", async () => {
  const audit = auditClient();
  const sms = capturingSms();
  let repairConfigReads = 0;
  const result = await notifyDeterministicPhysicalJob(
    audit.client,
    input(),
    deps({
      loadBoardJob: () =>
        Promise.resolve({
          jobId: JOB_ID,
          jobNumber: "SWMS-270001",
          canonicalStage: "new",
          sesFamily: "physical_makesafe",
          jobType: "makesafe",
          siteSuburb: "Testville",
        }),
      loadRepairConfig: () => {
        repairConfigReads++;
        return Promise.reject(new Error("must not be read for a make-safe"));
      },
      sendSms: sms.sendSms,
    }),
  );

  assertEquals(result.accepted, true);
  assertEquals(repairConfigReads, 0);
  assertEquals(sms.sends, [{
    phone: "+61000000001",
    message:
      "SecureWorks: New make-safe SWMS-270001 (22222222-2222-2222-2222-222222222222)\n" +
      "Assign in Trade: https://secureworks-group.github.io/secureworks-ux/trade.html#job/22222222-2222-2222-2222-222222222222",
    fromNumber: "+61000000000",
  }]);
  assertEquals(audit.inserts[0], {
    org_id: "00000000-0000-0000-0000-000000000001",
    case_id: CASE_ID,
    source_post_ids: ["source-a", "source-b"],
    job_id: JOB_ID,
    job_number: "SWMS-270001",
    board_stage: "new",
    board_observed_at: ATTEMPTED_AT,
    attempted_at: ATTEMPTED_AT,
    recipient_set: [{
      user_id: "33333333-3333-3333-3333-333333333333",
      name: "Configured make-safe manager",
      phone: "+61000000001",
    }],
    deep_link:
      "https://secureworks-group.github.io/secureworks-ux/trade.html#job/22222222-2222-2222-2222-222222222222",
    message: sms.sends[0].message,
    state: "attempting",
    failure_reason: "provider_result_not_recorded",
  });
});

Deno.test("PINNED: every non-repair family keeps the make-safe text and recipient", async () => {
  for (
    const sesFamily of [
      "physical_makesafe",
      "temporary_fencing",
      "roof_report",
      "assessment",
      "restoration",
    ]
  ) {
    const audit = auditClient();
    const sms = capturingSms();
    await notifyDeterministicPhysicalJob(
      audit.client,
      input(),
      deps({
        loadBoardJob: () =>
          Promise.resolve({
            jobId: JOB_ID,
            jobNumber: "SWMS-270001",
            canonicalStage: "new",
            sesFamily,
            jobType: sesFamily === "restoration" ? "insurance" : "makesafe",
            siteSuburb: "Testville",
          }),
        sendSms: sms.sendSms,
      }),
    );
    assertEquals(sms.sends.length, 1, sesFamily);
    assertEquals(sms.sends[0].phone, MAKESAFE_TEXT_RECIPIENT.phone, sesFamily);
    assertEquals(
      sms.sends[0].message,
      `SecureWorks: New make-safe SWMS-270001 (${JOB_ID})\nAssign in Trade: ${
        buildHugoTradeDeepLink(JOB_ID)
      }`,
      sesFamily,
    );
  }
});

Deno.test("an empty repair recipient list sends nothing, records why, and never uses the make-safe list", async () => {
  for (
    const reason of [
      "repair_recipient_not_configured",
      "repair_recipient_config_ambiguous",
      "repair_recipient_user_missing",
      "repair_recipient_phone_missing",
    ]
  ) {
    const audit = auditClient();
    const sms = capturingSms();
    const result = await notifyDeterministicPhysicalJob(
      audit.client,
      repairInput(),
      deps({
        loadBoardJob: repairBoardJob(),
        loadRepairConfig: () =>
          Promise.resolve({
            enabled: true,
            fromNumber: "+61000000000",
            recipient: null,
            failureReason: reason,
          }),
        sendSms: sms.sendSms,
      }),
    );

    assertEquals(result.attempted, false, reason);
    assertEquals(result.accepted, false, reason);
    assertEquals(result.reason, reason);
    assertEquals(sms.sends, [], reason);
    assertEquals(audit.inserts.length, 1, reason);
    assertEquals(audit.inserts[0].state, "failed", reason);
    assertEquals(audit.inserts[0].failure_reason, reason);
    assertEquals(audit.inserts[0].recipient_set, [], reason);
    assertEquals(audit.updates, [], reason);
  }
});

Deno.test("a repair recipient that cannot be read, or was never wired, sends nothing and never uses the make-safe list", async () => {
  const unreadable: Array<Partial<HugoNotificationDeps>> = [
    {
      loadRepairConfig: () => Promise.reject(new Error("settings read failed")),
    },
    {
      loadRepairConfig: () => {
        throw new Error("settings read threw");
      },
    },
    { loadRepairConfig: undefined },
  ];
  for (const override of unreadable) {
    const audit = auditClient();
    const sms = capturingSms();
    const result = await notifyDeterministicPhysicalJob(
      audit.client,
      repairInput(),
      deps({
        loadBoardJob: repairBoardJob(),
        sendSms: sms.sendSms,
        ...override,
      }),
    );

    assertEquals(result.reason, "repair_recipient_config_read_failed");
    assertEquals(result.accepted, false);
    assertEquals(sms.sends, []);
    assertEquals(
      audit.inserts[0].failure_reason,
      "repair_recipient_config_read_failed",
    );
    assertEquals(audit.inserts[0].recipient_set, []);
  }
});

Deno.test("the notify kill switch holds a repair text too", async () => {
  const audit = auditClient();
  const sms = capturingSms();
  const result = await notifyDeterministicPhysicalJob(
    audit.client,
    repairInput(),
    deps({
      loadBoardJob: repairBoardJob(),
      loadRepairConfig: () =>
        Promise.resolve({
          enabled: false,
          fromNumber: "+61000000000",
          recipient: REPAIR_TEXT_RECIPIENT,
          failureReason: null,
        }),
      sendSms: sms.sendSms,
    }),
  );
  assertEquals(result.reason, "notification_disabled");
  assertEquals(sms.sends, []);
});

Deno.test("the once-per-job claim holds for a repair job: a second call sends no second text", async () => {
  const audit = auditClient({ duplicateAfterFirst: true });
  const sms = capturingSms();
  const notificationDeps = deps({
    loadBoardJob: repairBoardJob(),
    sendSms: sms.sendSms,
  });

  const first = await notifyDeterministicPhysicalJob(
    audit.client,
    repairInput(),
    notificationDeps,
  );
  const second = await notifyDeterministicPhysicalJob(
    audit.client,
    { ...repairInput(), caseId: "44444444-4444-4444-4444-444444444444" },
    notificationDeps,
  );

  assertEquals(first.accepted, true);
  assertEquals(second.accepted, true);
  assertEquals(second.reason, "already_recorded");
  assertEquals(sms.sends.length, 1);
  assertEquals(sms.sends[0].phone, REPAIR_TEXT_RECIPIENT.phone);
});

Deno.test("a repair text that failed for want of a recipient is sent once the recipient is set", async () => {
  const audit = auditClient({ duplicateAfterFirst: true });
  const sms = capturingSms();
  const unset = await notifyDeterministicPhysicalJob(
    audit.client,
    repairInput(),
    deps({
      loadBoardJob: repairBoardJob(),
      loadRepairConfig: () =>
        Promise.resolve({
          enabled: true,
          fromNumber: "+61000000000",
          recipient: null,
          failureReason: "repair_recipient_not_configured",
        }),
      sendSms: sms.sendSms,
    }),
  );
  assertEquals(unset.reason, "repair_recipient_not_configured");
  assertEquals(sms.sends, []);

  const set = await notifyDeterministicPhysicalJob(
    audit.client,
    repairInput(),
    deps({ loadBoardJob: repairBoardJob(), sendSms: sms.sendSms }),
  );
  assertEquals(set.accepted, true);
  assertEquals(sms.sends.length, 1);
  assertEquals(sms.sends[0].phone, REPAIR_TEXT_RECIPIENT.phone);
});
