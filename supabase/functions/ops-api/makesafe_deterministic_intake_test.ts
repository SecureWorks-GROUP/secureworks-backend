// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adaptDeterministicSource,
  buildDeterministicIntakePlan,
  DETERMINISTIC_ADAPTER_REGISTRY,
  type DeterministicCompanyProfile,
  deterministicModeAllowsAiFallback,
  type DeterministicSourceItem,
  selectIntakeMode,
} from "./makesafe_deterministic_intake.ts";
import {
  loadDeterministicIntakeMode,
} from "./makesafe_deterministic_intake_runtime.ts";

const PROFILES: DeterministicCompanyProfile[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "mlb",
    name: "MLB",
    senderPatterns: ["mlb.test"],
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    slug: "aj",
    name: "AJS / AJBR",
    senderPatterns: ["ajs.test", "ajbr.test"],
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    slug: "prime",
    name: "Prime",
    senderPatterns: ["prime.test"],
  },
  {
    id: "44444444-4444-4444-4444-444444444444",
    slug: "rapid",
    name: "RAPID Repair",
    senderPatterns: ["rapid.test"],
  },
];

function source(
  input: Partial<DeterministicSourceItem> & { postId: string },
): DeterministicSourceItem {
  return {
    postId: input.postId,
    fromEmail: input.fromEmail ?? "dispatch@mlb.test",
    fromName: input.fromName ?? null,
    subject: input.subject ?? "",
    body: input.body ?? "",
    receivedAt: input.receivedAt ?? "2026-07-20T00:00:00.000Z",
    attachments: input.attachments ?? [],
    links: input.links ?? [],
    conversationId: input.conversationId ?? null,
    threadId: input.threadId ?? null,
    replyToPostId: input.replyToPostId ?? null,
    relatedPostIds: input.relatedPostIds ?? [],
    siblingPostIds: input.siblingPostIds ?? [],
  };
}

function pdf(postId: string, id = `${postId}-pdf`) {
  return {
    id,
    sourcePostId: postId,
    name: "Work Order.pdf",
    contentType: "application/pdf",
    storagePath: `${postId}/wo.pdf`,
    status: "uploaded",
    sizeBytes: 1200,
  };
}

Deno.test("registry order is MLB, AJS/AJBR, Prime, RAPID, then chatter", () => {
  assertEquals(DETERMINISTIC_ADAPTER_REGISTRY.map((a) => a.id), [
    "mlb",
    "ajs_ajbr",
    "prime",
    "rapid",
    "chatter",
  ]);
});

Deno.test("MLB adapter builds a confirmed identity without AI", () => {
  const item = source({
    postId: "mlb-1",
    subject: "NEW WORK ORDER MLB-27037 Work Order: WO#27037 PO: 9182",
    body:
      "Client: Test Client\nSite Address: 10 Test Street, Perth\nPhone: 0400000000",
    attachments: [pdf("mlb-1")],
  });
  const adapted = adaptDeterministicSource(item, PROFILES);
  assertEquals(adapted.adapterId, "mlb");
  assertEquals(adapted.identity.builderWoCanonical, "WO-27037");
  assertEquals(adapted.identity.builderPoCanonical, "PO-9182");
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.cases[0].state, "confirmed_live_job");
  assertEquals(plan.aiCalls, 0);
});

Deno.test("AJS and AJBR aliases resolve to one company adapter", () => {
  for (
    const [postId, prefix, sender] of [
      ["ajs-1", "AJS", "dispatch@ajs.test"],
      ["ajbr-1", "AJBR", "dispatch@ajbr.test"],
    ]
  ) {
    const adapted = adaptDeterministicSource(
      source({
        postId,
        fromEmail: sender,
        subject: `Make Safe ${prefix}-67200 Job No 67200 Work Order: 67200`,
        body: "Client: Example Person\nAddress: 20 Alpha Road, Perth",
        attachments: [pdf(postId)],
      }),
      PROFILES,
    );
    assertEquals(adapted.adapterId, "ajs_ajbr");
    assertEquals(adapted.identity.builderSlug, "aj");
    assertEquals(adapted.identity.companyId, PROFILES[1].id);
  }
});

Deno.test("AJ Job No subjects resolve to one isolated AJBR obligation", () => {
  const items = ["aj-70062-graph", "aj-70062-mailbox"].map((postId) =>
    source({
      postId,
      fromEmail: "workorders@ajs.test",
      subject: "Make Safe - Dianella - Job No 70062",
      body:
        "Client: Emma Clingan\nPhone: 0400 000 062\nAddress: 12 Railton Place, Dianella WA 6059",
      attachments: [pdf(postId)],
    })
  );
  const plan = buildDeterministicIntakePlan(items, PROFILES);
  assertEquals(plan.cases.length, 1);
  assertEquals(plan.cases[0].identity.externalRefCanonical, "AJBR-70062");
  assertEquals(plan.cases[0].identity.builderWoCanonical, "AJBR-70062");
  assertEquals(plan.cases[0].identity.builderPoCanonical, null);
  assertEquals(plan.cases[0].identity.jobFamily, "general_makesafe");
  assertEquals(plan.cases[0].sourcePostIds, [
    "aj-70062-graph",
    "aj-70062-mailbox",
  ]);
});

Deno.test("Prime wrapper adapter deterministically captures portal report work", () => {
  const item = source({
    postId: "prime-1",
    fromEmail: "notification@prime.test",
    fromName: "Prime Notification Centre",
    subject: "Roof report work order Work Order: 445566",
    body:
      "Client: Roof Client\nSite Address: 30 Beta Avenue, Perth\nComplete roof report https://portal.prime.test/r/1",
    links: [{ url: "https://portal.prime.test/r/1", sourcePostId: "prime-1" }],
  });
  const adapted = adaptDeterministicSource(item, PROFILES);
  assertEquals(adapted.adapterId, "prime");
  assertEquals(adapted.identity.jobFamily, "roof_report");
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.cases[0].evidenceMap.portal_link.status, "satisfied");
  assertEquals(
    plan.cases[0].evidenceMap.portal_capture.status,
    "recovery_staged",
  );
  assertEquals(plan.cases[0].state, "exception");
  assertEquals(plan.cases[0].reasonCode, "adapter_parse_failure");
});

Deno.test("RAPID adapter is pure and reaches confirmed state on complete evidence", () => {
  const item = source({
    postId: "rapid-1",
    fromEmail: "dispatch@rapid.test",
    subject: "RAPID Repair NEW WORK ORDER RAPID-88001 Work Order: RR#88001",
    body:
      "Insured: Rapid Client\nRisk Address: 40 Gamma Drive, Perth\nPhone: 0411111111",
    attachments: [pdf("rapid-1")],
  });
  assertEquals(adaptDeterministicSource(item, PROFILES).adapterId, "rapid");
  assertEquals(
    buildDeterministicIntakePlan([item], PROFILES).cases[0].state,
    "confirmed_live_job",
  );
});

Deno.test("chatter is accounted exactly once rather than dropped", () => {
  const item = source({
    postId: "chat-1",
    fromEmail: "person@example.test",
    subject: "Thanks, noted",
    body: "Thank you",
  });
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.sourceClassifications, [{
    postId: "chat-1",
    outcome: "accounted_non_work",
    instructionKey: plan.cases[0].instructionKey,
    reasonCode: "non_makesafe",
  }]);
  assertEquals(plan.totals.unaccounted, 0);
});

Deno.test("case-wide recovery finds a late PDF before declaring it missing", () => {
  const instruction = source({
    postId: "case-1",
    threadId: "thread-1",
    subject: "NEW WORK ORDER MLB-27040 Work Order: WO 27040",
    body: "Client: Case Client\nAddress: 50 Delta Street, Perth",
  });
  const latePdf = source({
    postId: "case-2",
    threadId: "thread-1",
    subject: "Requested attachment",
    body: "Attached as requested",
    receivedAt: "2026-07-20T01:00:00.000Z",
    attachments: [pdf("case-2")],
  });
  const plan = buildDeterministicIntakePlan([instruction, latePdf], PROFILES);
  assertEquals(plan.cases.length, 1);
  assertEquals(
    plan.cases[0].evidenceMap.work_order_attachment.status,
    "satisfied",
  );
  assertEquals(plan.cases[0].state, "blocked_live_job");
  assertEquals(plan.cases[0].blockedReasons, ["missing:client_phone"]);
  assertEquals(
    plan.cases[0].evidenceMap.work_order_attachment.searchedSourcePostIds,
    ["case-1", "case-2"],
  );
  assertEquals(plan.cases[0].sourcePostIds, ["case-1", "case-2"]);
  assertEquals(plan.totals.unaccounted, 0);
});

Deno.test("a portal link in a sibling source repairs the report manifest case-wide", () => {
  const first = source({
    postId: "report-1",
    threadId: "report-thread",
    subject: "Roof report Work Order: 76543",
    body: "Client: Report Client\nAddress: 60 Epsilon Road, Perth",
    fromEmail: "notification@prime.test",
  });
  const link = source({
    postId: "report-2",
    threadId: "report-thread",
    subject: "Portal link",
    body: "Use https://portal.prime.test/report/76543",
    fromEmail: "notification@prime.test",
    receivedAt: "2026-07-20T02:00:00.000Z",
  });
  const plan = buildDeterministicIntakePlan([first, link], PROFILES);
  assertEquals(plan.cases.length, 1);
  assertEquals(plan.cases[0].evidenceMap.portal_link.status, "satisfied");
  assertEquals(
    plan.cases[0].evidenceMap.portal_capture.nextRecoveryAction,
    "capture_portal_evidence_headless_with_idempotency_key",
  );
});

Deno.test("address-only evidence never merges distinct work orders", () => {
  const a = source({
    postId: "address-a",
    subject: "NEW WORK ORDER MLB-30001 Work Order: WO-30001",
    body: "Client: Shared Client\nAddress: 70 Same Street, Perth",
    attachments: [pdf("address-a")],
  });
  const b = source({
    postId: "address-b",
    subject: "NEW WORK ORDER MLB-30002 Work Order: WO-30002",
    body: "Client: Shared Client\nAddress: 70 Same Street, Perth",
    attachments: [pdf("address-b")],
  });
  const plan = buildDeterministicIntakePlan([a, b], PROFILES);
  assertEquals(plan.cases.length, 2);
  assertNotEquals(
    plan.cases[0].lineageClusterKey,
    plan.cases[1].lineageClusterKey,
  );
});

Deno.test("distinct POs remain distinct sibling instructions", () => {
  const a = source({
    postId: "po-a",
    subject: "NEW WORK ORDER MLB-27037 Work Order: WO-27037 PO: 91821",
    body: "Client: PO Client\nAddress: 80 Zeta Close, Perth",
    attachments: [pdf("po-a")],
  });
  const b = source({
    postId: "po-b",
    subject: "NEW WORK ORDER MLB-27037 Work Order: WO-27037 PO: 91822",
    body: "Client: PO Client\nAddress: 80 Zeta Close, Perth",
    attachments: [pdf("po-b")],
  });
  const plan = buildDeterministicIntakePlan([a, b], PROFILES);
  assertEquals(plan.cases.length, 2);
  assertEquals(new Set(plan.cases.map((c) => c.lineageClusterKey)).size, 1);
  assertEquals(
    new Set(plan.cases.map((c) => c.identity.builderPoCanonical)).size,
    2,
  );
  assert(plan.cases.some((c) => c.parentRelation === "sibling_of"));
});

Deno.test("ordinary WO punctuation and canonical numeric PO spellings converge", () => {
  const make = (postId: string, wo: string, poLabel: string) =>
    source({
      postId,
      subject: `NEW WORK ORDER MLB-31000 Work Order: ${wo} ${poLabel}`,
      body: "Client: Format Client\nAddress: 90 Eta Way, Perth",
      attachments: [pdf(postId)],
    });
  const woPlan = buildDeterministicIntakePlan([
    make("wo-hash", "WO#31000", "PO: 9182"),
    make("wo-dot", "WO.31000", "Purchase Order 9182"),
  ], PROFILES);
  assertEquals(woPlan.cases.length, 1);
  assertEquals(
    woPlan.cases[0].identity.builderPoCanonical,
    "PO-9182",
  );
});

Deno.test("postal PO Box footers never become purchase-order identity or cross-claim edges", () => {
  const sources = ["26947", "26948", "26949", "26950"].map((claim) =>
    source({
      postId: `postal-${claim}`,
      subject: `Our Ref: MLB-${claim} - Make Safe`,
      body:
        `Client: Claim ${claim}\nAddress: ${claim} Separate Way, Perth\nMLB postal address: PO Box 2143, Malaga WA 6944`,
      attachments: [{
        ...pdf(`postal-${claim}`),
        name: "Supporting report.pdf",
      }],
    })
  );
  const plan = buildDeterministicIntakePlan(sources, PROFILES);
  assertEquals(plan.cases.length, 4);
  assert(
    plan.cases.every((item) => item.identity.builderPoCanonical === null),
  );
  assert(
    plan.cases.every((item) => !item.instructionKey.includes("po%3ABOX")),
  );
  assertEquals(
    new Set(plan.cases.map((item) => item.lineageClusterKey)).size,
    4,
  );
});

Deno.test("equal numeric PO cannot merge different explicit claims without the same WO", () => {
  const make = (claim: string) =>
    source({
      postId: `shared-po-${claim}`,
      subject: `Our Ref: MLB-${claim} - PO: 4477`,
      body:
        `Client: Shared Client\nAddress: 90 Shared Way, Perth\nPurchase Order 4477`,
      attachments: [{
        ...pdf(`shared-po-${claim}`),
        name: "Supporting report.pdf",
      }],
    });
  const plan = buildDeterministicIntakePlan(
    [make("41001"), make("41002")],
    PROFILES,
  );
  assertEquals(plan.cases.length, 2);
  assert(
    plan.cases.every((item) => item.identity.builderPoCanonical === "PO-4477"),
  );
  assertEquals(
    new Set(plan.cases.map((item) => item.lineageClusterKey)).size,
    2,
  );
});

Deno.test("claim-only evidence cannot enter confirmed-live state", () => {
  const item = source({
    postId: "claim-only",
    subject: "NEW WORK ORDER MLB-32000",
    body: "Client: Claim Client\nAddress: 100 Theta Circuit, Perth",
    attachments: [{
      ...pdf("claim-only"),
      name: "Supporting document.pdf",
    }],
  });
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.cases[0].identity.woPoIdentityKey, null);
  assertEquals(plan.cases[0].identity.externalRefCanonical, "MLB-32000");
  assertEquals(plan.cases[0].state, "exception");
  assertEquals(plan.cases[0].reasonCode, "below_identity_floor");
});

Deno.test("revision and reopen cycles remain separate ordered lineage cases", () => {
  const original = source({
    postId: "cycle-1",
    threadId: "cycle-thread",
    subject: "NEW WORK ORDER MLB-33000 Work Order: WO-33000",
    body: "Client: Cycle Client\nAddress: 110 Iota Loop, Perth",
    attachments: [pdf("cycle-1")],
  });
  const revision = source({
    postId: "cycle-2",
    threadId: "cycle-thread",
    subject: "REVISED WORK ORDER MLB-33000 Work Order: WO-33000",
    body:
      "Client: Cycle Client\nAddress: 110 Iota Loop, Perth\nUpdated instruction",
    receivedAt: "2026-07-20T03:00:00.000Z",
    attachments: [pdf("cycle-2")],
  });
  const reopen = source({
    postId: "cycle-3",
    threadId: "cycle-thread",
    subject: "Re-attend MLB-33000 Work Order: WO-33000",
    body: "Client: Cycle Client\nAddress: 110 Iota Loop, Perth\nReturn to site",
    receivedAt: "2026-07-20T04:00:00.000Z",
    attachments: [pdf("cycle-3")],
  });
  const plan = buildDeterministicIntakePlan(
    [original, revision, reopen],
    PROFILES,
  );
  assertEquals(plan.cases.length, 3);
  assert(plan.cases.some((c) => c.parentRelation === "revision_of"));
  assert(
    plan.cases.some((c) => c.parentRelation === "reopen_of" && c.cycle === 2),
  );
  assert(
    plan.cases.every((c) =>
      c.correlatedStory.some((event) => event.sourcePostId === "cycle-1")
    ),
  );
  // Each case's own story stays scoped to its instruction, so received_at and
  // lineage inference cannot be driven by a sibling instruction's events.
  for (const intakeCase of plan.cases) {
    for (const event of intakeCase.story) {
      assert(intakeCase.sourcePostIds.includes(event.sourcePostId));
    }
  }
});

Deno.test("replay is deterministic, idempotent, and every source has exactly one outcome", () => {
  const inputs = [
    source({
      postId: "replay-1",
      subject: "NEW WORK ORDER MLB-34000 Work Order: WO-34000",
      body: "Client: Replay Client\nAddress: 120 Kappa Street, Perth",
      attachments: [pdf("replay-1")],
    }),
    source({
      postId: "replay-chat",
      fromEmail: "person@example.test",
      subject: "Thanks",
      body: "Noted",
    }),
  ];
  const first = buildDeterministicIntakePlan(inputs, PROFILES);
  const second = buildDeterministicIntakePlan(inputs, PROFILES);
  assertEquals(first, second);
  assertEquals(
    new Set(first.sourceClassifications.map((c) => c.postId)).size,
    inputs.length,
  );
  assertEquals(first.totals.unaccounted, 0);
  assertEquals(
    first.cases.flatMap((c) => c.recoveryCursor.sideEffectKeys.invoices),
    [],
  );
  assertEquals(
    first.cases.flatMap((c) =>
      c.recoveryCursor.sideEffectKeys.outboundMessages
    ),
    [],
  );
});

Deno.test("canonical historical twin and resend fixtures converge with AI disabled", () => {
  const twinBase = {
    subject: "NEW WORK ORDER MLB-26567 Work Order: WO-26567 PO: 44001",
    body: "Client: Twin Client\nAddress: 130 Lambda Road, Perth",
    attachments: [pdf("twin-a", "shared-attachment")],
  };
  const twins = [
    source({ postId: "AAMk-MLB-26567", ...twinBase }),
    source({
      postId: "mailbox-MLB-26567-twin",
      ...twinBase,
      attachments: [pdf("mailbox-MLB-26567-twin", "shared-attachment")],
    }),
  ];
  const twinPlan = buildDeterministicIntakePlan(twins, PROFILES);
  assertEquals(twinPlan.cases.length, 1);
  assertEquals(twinPlan.cases[0].sourcePostIds.length, 2);

  const resendBase = {
    subject: "NEW WORK ORDER MLB-26118 Work Order: WO-26118 PO: 55118",
    body: "Client: Resend Client\nAddress: 140 Mu Street, Perth",
  };
  const resends = Array.from({ length: 4 }, (_, index) =>
    source({
      postId: `MLB-26118-resend-${index + 1}`,
      ...resendBase,
      attachments: [pdf(`MLB-26118-resend-${index + 1}`, "same-wo")],
    }));
  const resendPlan = buildDeterministicIntakePlan(resends, PROFILES);
  assertEquals(resendPlan.cases.length, 1);
  assertEquals(resendPlan.sourceClassifications.length, 4);
  assertEquals(resendPlan.aiCalls, 0);
  assertEquals(resendPlan.totals.unaccounted, 0);
});

Deno.test("cancellation and unknown-builder work remain visible exceptions", () => {
  const cancellation = source({
    postId: "MLB-25769-cancel",
    subject: "CANCELLED WORK ORDER MLB-25769 Work Order: WO-25769",
    body: "Cancel this work order",
  });
  const unknown = source({
    postId: "unknown-builder",
    fromEmail: "dispatch@new-builder.test",
    subject: "NEW WORK ORDER Work Order: NEW-9911",
    body: "Client: Unknown Client\nAddress: 150 Nu Avenue, Perth",
    attachments: [pdf("unknown-builder")],
  });
  const plan = buildDeterministicIntakePlan([cancellation, unknown], PROFILES);
  assertEquals(plan.cases.length, 2);
  assert(plan.cases.some((c) => c.reasonCode === "cancellation"));
  assert(plan.cases.some((c) => c.reasonCode === "unknown_builder"));
  assertEquals(plan.totals.unaccounted, 0);
});

Deno.test("deterministic switch is fail-closed and has no AI fallback", async () => {
  assertEquals(selectIntakeMode("deterministic"), "deterministic");
  assertEquals(selectIntakeMode("anything-else"), "legacy");
  assertEquals(deterministicModeAllowsAiFallback(), false);

  const client = (result: unknown) => {
    const query = {
      select() {
        return this;
      },
      eq() {
        return this;
      },
      maybeSingle() {
        return Promise.resolve(result);
      },
    };
    return {
      from() {
        return query;
      },
    };
  };
  assertEquals(
    await loadDeterministicIntakeMode(client({
      data: { intake_mode: "deterministic" },
      error: null,
    })),
    "deterministic",
  );
  assertEquals(
    await loadDeterministicIntakeMode(client({
      data: null,
      error: { code: "42703", message: "column intake_mode does not exist" },
    })),
    "legacy",
  );
  await assertRejects(
    () =>
      loadDeterministicIntakeMode(client({
        data: null,
        error: { code: "57014", message: "statement timeout" },
      })),
    Error,
    "intake mode read failed",
  );
});
