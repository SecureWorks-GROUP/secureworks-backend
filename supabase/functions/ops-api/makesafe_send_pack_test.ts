// Wave 2 — makesafe_send_pack reimplement-pure tests.
//
// MONEY/COMMS critical. These tests are reimplement-pure + mocked: NO network,
// NO live Supabase, NO Xero, NO jsPDF. They exercise the pure building blocks in
// makesafe_send_pack.ts that the index.ts orchestration composes, plus a small
// model of the atomic send-lock and the resume invariants.
//
// They cross-reference index.ts:makesafeSendPack (the orchestration) and the
// route gate at the `makesafe_send_pack` case (auth per decision
// scoped-routine-key-2026-06-17: privileged dashboard api_key OR admin/owner jwt;
// the lesser make-safe routine key is rejected).
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        supabase/functions/ops-api/makesafe_send_pack_test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPackSentMarkerText,
  canAcquireSendLock,
  canResetDraftPackGenerationLock,
  checkApprovedPhotoFollowupGate,
  checkClientSendGate,
  checkExactRecipientGate,
  checkPositiveInvoiceTotalGate,
  checkResetFailedGate,
  checkResumeCloseGate,
  countLiveInvoices,
  // Phase 1b — resume-aware feed mapping + close-only / failed-reset gates.
  deriveResumeAction,
  emailFailureIsProvablyPreDispatch,
  hasPackSentMainMarker,
  hasReviewMarker,
  isInvoiceAmbiguous,
  isPackSentMainEvent,
  isReportPdf,
  isSendingStale,
  isXeroInvoicePdf,
  MAKESAFE_ADMIN_FROM,
  MAKESAFE_CC,
  normRef,
  // C-1 / P-1 / N-1 last-round helpers (post-send recovery, 'sending' resolution,
  // ambiguous-invoice fail-closed).
  planPostSendResume,
  planSendingResolution,
  resolveExistingInvoice,
  RESUMABLE_PACK_STATUSES,
  RESUME_CLOSE_ALLOWED_STATUSES,
  SENDING_STALE_SECONDS,
  SendLockCell,
  sendPackAllowed,
} from "./makesafe_send_pack.ts";

// ─────────────────────────────────────────────────────────────────
// 1. PRIVILEGED-CALLER gate (decision: scoped-routine-key-2026-06-17).
//    send_pack is reachable by the privileged dashboard key (authMode='api_key',
//    the master SW_API_KEY — the ops dashboard has NO per-user login) OR an
//    admin/owner JWT. The lesser make-safe routine key (authMode='routine',
//    Sentinel Wave 0 PR #179) is REJECTED.
//    (Mirrors index.ts route case: if (!sendPackAllowed(...)) return 403.)
// ─────────────────────────────────────────────────────────────────

Deno.test("gate: api_key (the dashboard / master key) is ALLOWED for any role", () => {
  // The ops dashboard authenticates with the master SW_API_KEY, never a user
  // JWT, so its own approve/send button arrives as authMode='api_key'. A
  // "reject all api_key" gate would 403 the live dashboard — the bug this fixes.
  for (
    const role of ["admin", "owner", "ops", "viewer", "unknown", undefined]
  ) {
    assertEquals(
      sendPackAllowed("api_key", role ? { role } : null),
      true,
      `api_key + role=${role} (dashboard / master key) must be allowed`,
    );
  }
});

Deno.test("gate: admin/owner JWT allowed; ops/viewer/unknown/'' JWT rejected", () => {
  assertEquals(sendPackAllowed("jwt", { role: "admin" }), true);
  assertEquals(sendPackAllowed("jwt", { role: "owner" }), true);
  assertEquals(sendPackAllowed("jwt", { role: "ops" }), false);
  assertEquals(sendPackAllowed("jwt", { role: "trade" }), false);
  assertEquals(sendPackAllowed("jwt", { role: "viewer" }), false);
  assertEquals(sendPackAllowed("jwt", { role: "unknown" }), false);
  assertEquals(sendPackAllowed("jwt", { role: "" }), false);
  assertEquals(sendPackAllowed("jwt", null), false);
});

Deno.test("gate: routine (the lesser MAKESAFE_ROUTINE_KEY) is REJECTED — drafts only", () => {
  // The 3-class model: 'routine' is neither 'api_key' nor jwt admin/owner, so the
  // standalone predicate returns false regardless of any role hint the caller
  // sends. Sentinel Wave 0 PR #179 also pre-denies it centrally (next test).
  for (
    const role of ["admin", "owner", "ops", "viewer", "unknown", undefined]
  ) {
    assertEquals(
      sendPackAllowed("routine", role ? { role } : null),
      false,
      `routine + role=${role} must be rejected (the automation cannot send)`,
    );
  }
});

// Belt-and-braces: even before the route case runs, Sentinel Wave 0's central
// deny-list (ROUTINE_FORBIDDEN_ACTIONS in index.ts global auth, branch
// origin/sentinel/makesafe-wave0-hardening PR #179) 403s the routine for
// 'makesafe_send_pack'. We model that Set here and assert the cross-check.
Deno.test("central deny-list: routine + 'makesafe_send_pack' -> 403 (Sentinel Wave 0)", () => {
  // Mirrors Sentinel's `const ROUTINE_FORBIDDEN_ACTIONS = new Set([... 'makesafe_send_pack' ...])`
  const ROUTINE_FORBIDDEN_ACTIONS = new Set<string>(["makesafe_send_pack"]);
  function centralAuthStatus(authMode: string, action: string): number {
    // Mirrors `if (authMode === 'routine' && ROUTINE_FORBIDDEN_ACTIONS.has(action)) return 403`.
    if (authMode === "routine" && ROUTINE_FORBIDDEN_ACTIONS.has(action)) {
      return 403;
    }
    return 200; // falls through to the route case (which also gates via sendPackAllowed)
  }
  assertEquals(centralAuthStatus("routine", "makesafe_send_pack"), 403);
  // The privileged classes are NOT centrally denied — they reach the route case.
  assertEquals(centralAuthStatus("api_key", "makesafe_send_pack"), 200);
  assertEquals(centralAuthStatus("jwt", "makesafe_send_pack"), 200);
  // The routine CAN reach the draft-only verbs (not on the deny-list).
  assertEquals(
    centralAuthStatus("routine", "create_makesafe_draft_invoice"),
    200,
  );
  assertEquals(centralAuthStatus("routine", "makesafe_render_report"), 200);
});

// ─────────────────────────────────────────────────────────────────
// 2. ATOMIC SEND-LOCK — concurrent send yields exactly ONE send.
//    Models the conditional UPDATE ... WHERE status IN(...) RETURNING as a
//    serialized acquire on one cell.
// ─────────────────────────────────────────────────────────────────

Deno.test("send-lock: lockable statuses only", () => {
  assert(canAcquireSendLock("drafted"));
  assert(canAcquireSendLock("admin_to_send_report"));
  assert(canAcquireSendLock("authorised_not_sent")); // resume re-enters the lock
  assert(!canAcquireSendLock("sending"));
  assert(!canAcquireSendLock("sent"));
  assert(!canAcquireSendLock("sent_not_closed"));
  assert(!canAcquireSendLock("failed"));
  assert(!canAcquireSendLock(undefined));
});

Deno.test("draft-pack lock recovery: only completed DRAFT artifacts can reset a draft-generation lock", () => {
  assertEquals(
    canResetDraftPackGenerationLock({
      packStatus: "sending",
      failedStep: "draft_pack",
      invoiceStatus: "DRAFT",
      hasInvoiceDoc: true,
      hasReportDoc: true,
    }),
    true,
  );
  assertEquals(
    canResetDraftPackGenerationLock({
      packStatus: "sending",
      failedStep: "draft_pack",
      invoiceStatus: "AUTHORISED",
      hasInvoiceDoc: true,
      hasReportDoc: true,
    }),
    false,
  );
  assertEquals(
    canResetDraftPackGenerationLock({
      packStatus: "sending",
      failedStep: "draft_pack",
      invoiceStatus: "DRAFT",
      hasInvoiceDoc: true,
      hasReportDoc: false,
    }),
    false,
  );
  assertEquals(
    canResetDraftPackGenerationLock({
      packStatus: "sending",
      failedStep: "email_send",
      invoiceStatus: "DRAFT",
      hasInvoiceDoc: true,
      hasReportDoc: true,
    }),
    false,
  );
});

Deno.test("send-lock: two racers -> exactly one acquires, the other gets 0 rows (409)", () => {
  const cell = new SendLockCell("admin_to_send_report");
  // Serialized contention: racer A then racer B both try to take the lock.
  const aGot = cell.tryAcquire();
  const bGot = cell.tryAcquire();
  assertEquals(aGot, true, "first racer wins the lock");
  assertEquals(
    bGot,
    false,
    "second racer sees status=sending -> 0 rows -> 409",
  );
  assertEquals(cell.status, "sending");
});

Deno.test("send-lock: N racers -> at most one winner", () => {
  const cell = new SendLockCell("drafted");
  let winners = 0;
  for (let i = 0; i < 25; i++) if (cell.tryAcquire()) winners++;
  assertEquals(winners, 1);
});

// ─────────────────────────────────────────────────────────────────
// 3. EMAIL-FAIL leaves a RECOVERABLE state, does NOT mark sent, and a resume
//    does not re-email or re-authorise. Models the index.ts ordering:
//    lock -> authorise -> (send NON-OK) -> status=authorised_not_sent.
// ─────────────────────────────────────────────────────────────────

// A tiny model of the pack row + the send machine's irreversible-step guards.
function simulateSend(opts: {
  initialStatus: string;
  invoiceAlreadyAuthorised: boolean;
  emailOk: boolean;
  markerPresent: boolean;
}) {
  const log: string[] = [];
  const pack = { status: opts.initialStatus, sent_at: null as string | null };
  let invoiceAuthorised = opts.invoiceAlreadyAuthorised;

  // IDEMPOTENCY STOP — marker present means never re-email.
  if (opts.markerPresent) {
    return {
      result: "already_sent",
      pack,
      log,
      authorisedThisRun: false,
      emailedThisRun: false,
    };
  }
  // LOCK
  const cell = new SendLockCell(pack.status);
  if (!cell.tryAcquire()) {
    return {
      result: "conflict",
      pack,
      log,
      authorisedThisRun: false,
      emailedThisRun: false,
    };
  }
  pack.status = "sending";

  // AUTHORISE only if not already authorised (resume safety).
  let authorisedThisRun = false;
  if (!invoiceAuthorised) {
    log.push("authorise");
    invoiceAuthorised = true;
    authorisedThisRun = true;
  } else {
    log.push("skip_authorise");
  }
  pack.status = "authorised_not_sent";

  // SEND
  let emailedThisRun = false;
  if (!opts.emailOk) {
    log.push("send_failed");
    pack.status = "authorised_not_sent"; // FAIL CLOSED — not sent
    return {
      result: "send_failed",
      pack,
      log,
      authorisedThisRun,
      emailedThisRun,
    };
  }
  log.push("send_ok");
  emailedThisRun = true;
  // MARKER + CLOSE
  log.push("marker");
  log.push("close");
  pack.status = "sent";
  pack.sent_at = "2026-06-17T00:00:00Z";
  return { result: "sent", pack, log, authorisedThisRun, emailedThisRun };
}

Deno.test("email-fail: status=authorised_not_sent, NOT sent, no marker", () => {
  const r = simulateSend({
    initialStatus: "admin_to_send_report",
    invoiceAlreadyAuthorised: false,
    emailOk: false,
    markerPresent: false,
  });
  assertEquals(r.result, "send_failed");
  assertEquals(r.pack.status, "authorised_not_sent");
  assertEquals(r.pack.sent_at, null);
  assert(!r.log.includes("marker"), "no marker written on send failure");
  assert(!r.log.includes("close"), "no close on send failure");
  assert(
    r.log.includes("authorise"),
    "invoice was authorised before the send attempt",
  );
});

Deno.test("resume after email-fail: does NOT re-authorise, can complete on a good send", () => {
  // First attempt: authorise happened, send failed -> authorised_not_sent.
  const first = simulateSend({
    initialStatus: "admin_to_send_report",
    invoiceAlreadyAuthorised: false,
    emailOk: false,
    markerPresent: false,
  });
  assertEquals(first.pack.status, "authorised_not_sent");
  // Resume: pack is authorised_not_sent (lockable), invoice ALREADY authorised.
  const resume = simulateSend({
    initialStatus: "authorised_not_sent",
    invoiceAlreadyAuthorised: true,
    emailOk: true,
    markerPresent: false,
  });
  assertEquals(resume.result, "sent");
  assertEquals(resume.authorisedThisRun, false, "resume must NOT re-authorise");
  assert(resume.log.includes("skip_authorise"));
  assertEquals(resume.pack.status, "sent");
});

Deno.test("resume after a confirmed send: marker present -> already_sent, no re-email", () => {
  const resume = simulateSend({
    initialStatus: "sent",
    invoiceAlreadyAuthorised: true,
    emailOk: true,
    markerPresent: true,
  });
  assertEquals(resume.result, "already_sent");
  assertEquals(
    resume.emailedThisRun,
    false,
    "never re-email when the marker exists",
  );
  assertEquals(resume.authorisedThisRun, false);
});

// ─────────────────────────────────────────────────────────────────
// 4. CLIENT-SEND GATE — blocks draft/preview; passes a clean 2-PDF payload.
// ─────────────────────────────────────────────────────────────────

const cleanAttachments = [
  { name: "Make Safe Report - MLB-24981 - 12-Smith-St.pdf" },
  { name: "Xero Invoice - INV-0712.pdf" },
];
function basePayload(over: Record<string, unknown> = {}) {
  return {
    from: MAKESAFE_ADMIN_FROM,
    to: "builder@example.com",
    cc: MAKESAFE_CC,
    subject: "Make Safe Completion - 12 Smith St",
    htmlBody: "<p>Please find the completion report and invoice attached.</p>",
    attachments: cleanAttachments,
    ...over,
  };
}

Deno.test("client-gate: a clean report + Xero invoice payload PASSES", () => {
  assertEquals(checkClientSendGate(basePayload()), []);
});

Deno.test("client-gate: 'DRAFT' in subject FAILS", () => {
  const f = checkClientSendGate(
    basePayload({ subject: "DRAFT Make Safe Completion" }),
  );
  assert(f.length > 0);
  assert(
    f.some((x) => x.includes("review/test marker") && x.includes("DRAFT")),
  );
});

Deno.test("client-gate: 'PREVIEW' in an attachment filename FAILS", () => {
  const f = checkClientSendGate(basePayload({
    attachments: [
      { name: "Make Safe Report - PREVIEW - 12-Smith-St.pdf" },
      { name: "Xero Invoice - INV-0712.pdf" },
    ],
  }));
  assert(f.some((x) => x.includes("PREVIEW")));
});

Deno.test("client-gate: wrong sender / missing cc / single PDF all FAIL closed", () => {
  assert(
    checkClientSendGate(basePayload({ from: "marnin@gmail.com" })).some((x) =>
      x.includes("sender must be")
    ),
  );
  assert(
    checkClientSendGate(basePayload({ cc: "" })).some((x) =>
      x.includes("cc must include")
    ),
  );
  assert(
    checkClientSendGate(basePayload({ attachments: [cleanAttachments[0]] }))
      .some((x) => x.includes("at least two")),
  );
});

Deno.test("client-gate: exactly one report + one Xero invoice required", () => {
  // Two reports, no invoice.
  const f = checkClientSendGate(basePayload({
    attachments: [
      { name: "Make Safe Report - A.pdf" },
      { name: "Make Safe Report - B.pdf" },
    ],
  }));
  assert(f.some((x) => x.includes("exactly one final make-safe report")));
  assert(f.some((x) => x.includes("exactly one actual Xero invoice")));
});

Deno.test("photo follow-up gate: approved photos are mandatory before email-path send", () => {
  assertEquals(checkApprovedPhotoFollowupGate([]).length, 1);
  assertEquals(
    checkApprovedPhotoFollowupGate([{ url: "https://example.com/photo.jpg" }]),
    [],
  );
});

Deno.test("client-gate classifiers: report/invoice/marker detection", () => {
  assert(isReportPdf("Make Safe Report - X.pdf"));
  assert(isReportPdf("MakeSafe Report - X.pdf"));
  assert(!isReportPdf("Xero Invoice - INV-1.pdf"));
  assert(isXeroInvoicePdf("Xero Invoice - INV-1.pdf"));
  assert(!isXeroInvoicePdf("Invoice Line Review - INV-1.pdf")); // rejected token
  assert(!isXeroInvoicePdf("Tax Invoice INV-1.pdf")); // lacks 'xero'
  assertEquals(hasReviewMarker("a TEST file.pdf"), "TEST");
  assertEquals(hasReviewMarker("Greatest hits.pdf"), null); // not a whole-token match
});

// ─────────────────────────────────────────────────────────────────
// 5. DUPLICATE-INVOICE 3-tier resolver — existing live invoice -> skip;
//    VOIDED/DELETED never blocks.
// ─────────────────────────────────────────────────────────────────

Deno.test("dup-guard: existing live invoice on job_id -> hit (skip create)", () => {
  const rows = [
    {
      job_id: "job-1",
      status: "AUTHORISED",
      invoice_number: "INV-1",
      reference: "MLB-100",
      xero_invoice_id: "x1",
    },
  ];
  const hit = resolveExistingInvoice(rows, "job-1", "MLB-100");
  assert(hit);
  assertEquals(hit!.match_method, "job_id");
  assertEquals(hit!.invoice_number, "INV-1");
});

Deno.test("dup-guard: exact normalised reference match (case + whitespace folded)", () => {
  const rows = [
    {
      job_id: "other",
      status: "DRAFT",
      invoice_number: "INV-2",
      reference: " MLB-24981 ",
      xero_invoice_id: "x2",
    },
  ];
  // normRef folds case + strips surrounding/inner whitespace AND hyphens, so
  // " MLB-24981 " -> "mlb24981" == "mlb24981" (BLOCKER B pt2 hyphen-robust).
  const hit = resolveExistingInvoice(rows, "job-x", "mlb-24981");
  assert(hit);
  assertEquals(hit!.match_method, "reference");
});

Deno.test("dup-guard: reference substring (>=5 chars) match", () => {
  const rows = [
    {
      job_id: "other",
      status: "AUTHORISED",
      invoice_number: "INV-3",
      reference: "Deposit MLB-24981 stage 1",
      xero_invoice_id: "x3",
    },
  ];
  const hit = resolveExistingInvoice(rows, "job-x", "MLB-24981");
  assert(hit);
  assertEquals(hit!.match_method, "reference_substring");
});

Deno.test("dup-guard: short ref (<5 chars) does NOT substring-match", () => {
  const rows = [
    {
      job_id: "other",
      status: "AUTHORISED",
      invoice_number: "INV-4",
      reference: "Job AB12 deposit",
      xero_invoice_id: "x4",
    },
  ];
  assertEquals(resolveExistingInvoice(rows, "job-x", "AB12"), null);
});

Deno.test("dup-guard: VOIDED/DELETED invoice does NOT block creation", () => {
  const rows = [
    {
      job_id: "job-1",
      status: "VOIDED",
      invoice_number: "INV-V",
      reference: "MLB-100",
      xero_invoice_id: "xv",
    },
    {
      job_id: "job-1",
      status: "DELETED",
      invoice_number: "INV-D",
      reference: "MLB-100",
      xero_invoice_id: "xd",
    },
  ];
  assertEquals(resolveExistingInvoice(rows, "job-1", "MLB-100"), null);
});

Deno.test("dup-guard: live invoice wins even when a voided one is newer/first", () => {
  // job_id tier: a voided row is present but a live row exists -> the live one.
  const rows = [
    {
      job_id: "job-1",
      status: "VOIDED",
      invoice_number: "INV-OLD",
      reference: "MLB-100",
      xero_invoice_id: "xo",
    },
    {
      job_id: "job-1",
      status: "AUTHORISED",
      invoice_number: "INV-NEW",
      reference: "MLB-100",
      xero_invoice_id: "xn",
    },
  ];
  const hit = resolveExistingInvoice(rows, "job-1", "MLB-100");
  assert(hit);
  assertEquals(hit!.invoice_number, "INV-NEW");
});

Deno.test("dup-guard: no match -> null (safe to create the single draft)", () => {
  const rows = [
    {
      job_id: "other",
      status: "AUTHORISED",
      invoice_number: "INV-Z",
      reference: "AJS-9999",
      xero_invoice_id: "xz",
    },
  ];
  assertEquals(resolveExistingInvoice(rows, "job-1", "MLB-100"), null);
});

// ─────────────────────────────────────────────────────────────────
// 6. MARKER idempotency stop — marker present -> already_sent without re-email.
// ─────────────────────────────────────────────────────────────────

Deno.test("marker: isPackSentMainEvent matches only a main-pack note", () => {
  assert(
    isPackSentMainEvent({
      event_type: "note",
      detail_json: {
        text: "MAKESAFE_PACK_SENT | main | INV-1 | to=x | t | msgid=a",
      },
    }),
  );
  // string-encoded detail_json is parsed.
  assert(
    isPackSentMainEvent({
      event_type: "note",
      detail_json: JSON.stringify({ text: "MAKESAFE_PACK_SENT | main | x" }),
    }),
  );
  // photo pack does NOT count as main.
  assert(
    !isPackSentMainEvent({
      event_type: "note",
      detail_json: { text: "MAKESAFE_PACK_SENT | photo | x" },
    }),
  );
  // wrong event type.
  assert(
    !isPackSentMainEvent({
      event_type: "invoice.emailed",
      detail_json: { text: "MAKESAFE_PACK_SENT | main" },
    }),
  );
});

Deno.test("marker: hasPackSentMainMarker scans an event set", () => {
  assert(hasPackSentMainMarker([
    { event_type: "note", detail_json: { text: "hello" } },
    {
      event_type: "note",
      detail_json: { text: "MAKESAFE_PACK_SENT | main | INV-1" },
    },
  ]));
  assert(
    !hasPackSentMainMarker([{
      event_type: "note",
      detail_json: { text: "no marker here" },
    }]),
  );
  assert(!hasPackSentMainMarker([]));
});

Deno.test("marker: buildPackSentMarkerText starts with the main prefix (round-trips through the matcher)", () => {
  const text = buildPackSentMarkerText({
    invoiceNumber: "INV-0712",
    to: "builder@x.com",
    nowIso: "2026-06-17T00:00:00Z",
    messageId: "m1",
  });
  assert(text.startsWith("MAKESAFE_PACK_SENT | main"));
  assert(isPackSentMainEvent({ event_type: "note", detail_json: { text } }));
});

// ═════════════════════════════════════════════════════════════════
// 7. POST-SEND RESUME + 'sending' RESOLUTION + AMBIGUOUS-INVOICE (N-3 — proves
//    C-1, P-1, N-1). reimplement-pure + mocked: NO network, NO Supabase, NO Xero.
//
//    A faithful model of index.ts:makesafeSendPack's RESUME RE-ENTRY block
//    (just after the pack-row load, BEFORE the atomic lock) + the N-1 ambiguity
//    preflight. It drives the SAME pure decision functions the orchestration
//    imports (planPostSendResume / planSendingResolution / isInvoiceAmbiguous)
//    and tracks every irreversible side effect, so the tests assert "no
//    re-email / no re-authorise / no re-marker" as hard counters.
//
//    Cross-ref index.ts:
//      ~14827  RESUME RE-ENTRY (C-1 + P-1): const postSendPlan = planPostSendResume(priorStatus)
//      ~14874  'sending': const resolution = planSendingResolution(body.sending_resolution)
//      ~14935  N-1 AMBIGUOUS INVOICE: if (isInvoiceAmbiguous(jobInvoices)) -> 412
// ═════════════════════════════════════════════════════════════════

interface SideEffects {
  authorise: number; // Xero invoice AUTHORISE writes
  email: number; // builder email sends
  marker: number; // MAKESAFE_PACK_SENT | main marker writes
  close: number; // make-safe close (substatus=complete + report_sent_at)
}

interface ResumeResult {
  status: number; // HTTP-ish: 200 ok, 409 conflict, 412 fail-closed
  resumed?: boolean;
  action?: string;
  packStatus?: string;
  sent?: boolean;
  closed?: boolean;
  fx: SideEffects;
  body?: Record<string, unknown>;
}

// Models the makesafeSendPack ENTRY -> resume -> (fall-through) send path with
// explicit side-effect counters. emailOk lets us drive the confirmed_not_sent
// re-entry to a successful send. Mirrors the index.ts ordering exactly.
function simulateResume(opts: {
  priorStatus: string; // pack.status at entry
  markerPresent?: boolean; // the unconditional marker idempotency stop
  sendingResolution?: unknown; // body.sending_resolution
  liveInvoiceCount?: number; // count of NON-void mapped invoices (N-1)
  invoiceAlreadyAuthorised?: boolean; // for the confirmed_not_sent send path
  emailOk?: boolean; // does the re-entered send succeed
}): ResumeResult {
  const fx: SideEffects = { authorise: 0, email: 0, marker: 0, close: 0 };

  // ENTRY: unconditional marker idempotency stop (index.ts ~14806).
  if (opts.markerPresent) {
    return { status: 200, resumed: false, action: "already_sent", fx };
  }

  // RESUME RE-ENTRY (C-1) — post-send recovery (index.ts ~14837).
  const postSendPlan = planPostSendResume(opts.priorStatus);
  if (postSendPlan) {
    if (postSendPlan.writeMarker) fx.marker++; // marker_and_close only
    if (postSendPlan.applyClose) fx.close++;
    // NEVER re-email, NEVER re-authorise (the plan encodes both as false).
    return {
      status: 200,
      resumed: true,
      action: postSendPlan.action,
      packStatus: "sent",
      sent: true,
      closed: true,
      fx,
    };
  }

  // 'sending' hard-crash window (P-1) — requires explicit resolution (index.ts ~14872).
  if (opts.priorStatus === "sending") {
    const resolution = planSendingResolution(opts.sendingResolution);
    if (!resolution) {
      // No valid resolution -> 409, NO side effects.
      return {
        status: 409,
        packStatus: "sending",
        fx,
        body: { requires: "sending_resolution" },
      };
    }
    if (resolution.writeMarkerAndClose) {
      // confirmed_sent -> marker + close, status='sent', NO re-email/authorise.
      fx.marker++;
      fx.close++;
      return {
        status: 200,
        resumed: true,
        action: "confirmed_sent_marker_and_close",
        packStatus: "sent",
        sent: true,
        closed: true,
        fx,
      };
    }
    // confirmed_not_sent -> move to authorised_not_sent and FALL THROUGH to the
    // normal send path below. The pack is now lockable; invoice already authorised.
    // (We continue past this block with an effective priorStatus of authorised_not_sent.)
  }

  // ── N-1 preflight: AMBIGUOUS INVOICE = FAIL CLOSED (index.ts ~14935). Runs in
  // the normal (non-recovery) path BEFORE the lock/authorise. We model the
  // invoice set as a count of non-void rows; >1 -> 412, NO authorise, NO send.
  const liveCount = opts.liveInvoiceCount ?? 1;
  // Build a representative invoice-row set so we exercise the REAL isInvoiceAmbiguous.
  const invoiceRows = [
    ...Array.from(
      { length: liveCount },
      (_, i) => ({ status: "DRAFT", invoice_number: `INV-${i}` }),
    ),
    { status: "VOIDED", invoice_number: "INV-DEAD" }, // a void row never counts
  ];
  if (isInvoiceAmbiguous(invoiceRows)) {
    return {
      status: 412,
      packStatus: "failed",
      fx,
      body: {
        failed_step: "preflight_invoice_ambiguous",
        count: countLiveInvoices(invoiceRows),
      },
    };
  }
  if (liveCount === 0) {
    // No live invoice -> the OTHER 412 (preflight_invoice). Not the focus here.
    return {
      status: 412,
      packStatus: "failed",
      fx,
      body: { failed_step: "preflight_invoice" },
    };
  }

  // ── Normal send path (or confirmed_not_sent re-entry). LOCK -> AUTHORISE (only
  // if not already) -> SEND -> MARKER -> CLOSE.
  // For the confirmed_not_sent re-entry, invoiceAlreadyAuthorised is true so we
  // SKIP re-authorise (P-1 requirement).
  if (!opts.invoiceAlreadyAuthorised) fx.authorise++;
  // SEND
  if (opts.emailOk === false) {
    // FAIL CLOSED: invoice authorised but not sent. No marker, no close.
    return { status: 502, packStatus: "authorised_not_sent", sent: false, fx };
  }
  fx.email++;
  fx.marker++;
  fx.close++;
  return { status: 200, packStatus: "sent", sent: true, closed: true, fx };
}

// ── C-1: sent_marker_failed resume -> marker (idempotent) + close -> sent; NO re-email.
Deno.test("C-1 resume: sent_marker_failed -> writes marker + closes, status sent, NO re-email", () => {
  const r = simulateResume({ priorStatus: "sent_marker_failed" });
  assertEquals(r.status, 200);
  assertEquals(r.resumed, true);
  assertEquals(r.action, "marker_and_close");
  assertEquals(r.packStatus, "sent");
  assertEquals(r.fx.email, 0, "MUST NOT re-email — the email already went out");
  assertEquals(r.fx.authorise, 0, "MUST NOT re-authorise");
  assertEquals(r.fx.marker, 1, "writes the missing marker once (idempotent)");
  assertEquals(r.fx.close, 1, "applies the make-safe close");
});

// ── C-1: sent_not_closed resume -> close ONLY -> sent; NO re-email, NO re-marker.
Deno.test("C-1 resume: sent_not_closed -> close only, status sent, NO re-email, NO re-marker", () => {
  const r = simulateResume({ priorStatus: "sent_not_closed" });
  assertEquals(r.status, 200);
  assertEquals(r.action, "close");
  assertEquals(r.packStatus, "sent");
  assertEquals(r.fx.email, 0, "NO re-email");
  assertEquals(r.fx.marker, 0, "NO re-marker (marker already written)");
  assertEquals(r.fx.authorise, 0, "NO re-authorise");
  assertEquals(r.fx.close, 1, "applies the close only");
});

// ── C-1: close_failed resume -> close ONLY -> sent; NO re-email.
Deno.test("C-1 resume: close_failed -> close only, status sent, NO re-email", () => {
  const r = simulateResume({ priorStatus: "close_failed" });
  assertEquals(r.status, 200);
  assertEquals(r.action, "close");
  assertEquals(r.packStatus, "sent");
  assertEquals(r.fx.email, 0);
  assertEquals(r.fx.marker, 0);
  assertEquals(r.fx.close, 1);
});

// planPostSendResume pure-contract: only the three post-send states recover.
Deno.test("C-1 planPostSendResume: only post-send states recover; lockable/terminal/sending do NOT", () => {
  assertEquals(
    planPostSendResume("sent_marker_failed")?.action,
    "marker_and_close",
  );
  assertEquals(planPostSendResume("sent_not_closed")?.action, "close");
  assertEquals(planPostSendResume("close_failed")?.action, "close");
  // Never recovers these (normal path / explicit-resolution path / terminal).
  for (
    const s of [
      "admin_to_send_report",
      "drafted",
      "authorised_not_sent",
      "sending",
      "sent",
      "failed",
      "",
      undefined,
    ]
  ) {
    assertEquals(
      planPostSendResume(s as string),
      null,
      `${s} must not auto-recover`,
    );
  }
  // The recovery plans hard-encode no-reemail / no-reauthorise.
  const p = planPostSendResume("sent_marker_failed")!;
  assertEquals(p.reEmail, false);
  assertEquals(p.reAuthorise, false);
});

// ── P-1: 'sending' with NO resolution -> 409, no send.
Deno.test("P-1 resume: 'sending' + NO resolution -> 409, NO send/authorise/marker/close", () => {
  const r = simulateResume({ priorStatus: "sending" });
  assertEquals(r.status, 409);
  assertEquals(r.packStatus, "sending");
  assertEquals(r.body?.requires, "sending_resolution");
  assertEquals(r.fx.email, 0);
  assertEquals(r.fx.authorise, 0);
  assertEquals(r.fx.marker, 0);
  assertEquals(r.fx.close, 0);
});

// ── P-1: 'sending' + confirmed_sent -> marker + close, NO re-email.
Deno.test("P-1 resume: 'sending' + confirmed_sent -> marker+close, status sent, NO re-email", () => {
  const r = simulateResume({
    priorStatus: "sending",
    sendingResolution: "confirmed_sent",
  });
  assertEquals(r.status, 200);
  assertEquals(r.resumed, true);
  assertEquals(r.action, "confirmed_sent_marker_and_close");
  assertEquals(r.packStatus, "sent");
  assertEquals(r.fx.email, 0, "operator confirmed it sent — never re-email");
  assertEquals(r.fx.authorise, 0);
  assertEquals(r.fx.marker, 1);
  assertEquals(r.fx.close, 1);
});

// ── P-1: 'sending' + confirmed_not_sent -> re-enters the send path (email sent
//    EXACTLY ONCE), invoice already authorised so NO re-authorise.
Deno.test("P-1 resume: 'sending' + confirmed_not_sent -> re-enters send (email once), NO re-authorise", () => {
  const r = simulateResume({
    priorStatus: "sending",
    sendingResolution: "confirmed_not_sent",
    invoiceAlreadyAuthorised: true, // it was authorised before the crash
    emailOk: true,
  });
  assertEquals(r.status, 200);
  assertEquals(r.packStatus, "sent");
  assertEquals(r.fx.email, 1, "the email is sent EXACTLY once on re-entry");
  assertEquals(
    r.fx.authorise,
    0,
    "invoice already authorised -> NO re-authorise",
  );
  assertEquals(r.fx.marker, 1);
  assertEquals(r.fx.close, 1);
});

// planSendingResolution pure-contract: only the two literals plan; else null (-> 409).
Deno.test("P-1 planSendingResolution: only confirmed_sent / confirmed_not_sent are valid", () => {
  assertEquals(
    planSendingResolution("confirmed_sent")?.writeMarkerAndClose,
    true,
  );
  assertEquals(planSendingResolution("confirmed_sent")?.reEnterSend, false);
  assertEquals(planSendingResolution("confirmed_not_sent")?.reEnterSend, true);
  assertEquals(
    planSendingResolution("confirmed_not_sent")?.writeMarkerAndClose,
    false,
  );
  // Neither resolution ever re-authorises from 'sending'.
  assertEquals(planSendingResolution("confirmed_sent")?.reAuthorise, false);
  assertEquals(planSendingResolution("confirmed_not_sent")?.reAuthorise, false);
  for (
    const bad of ["", "yes", "sent", "CONFIRMED_SENT", null, undefined, 1, {}]
  ) {
    assertEquals(
      planSendingResolution(bad as unknown),
      null,
      `${String(bad)} must be invalid -> 409`,
    );
  }
});

// P-1 read-endpoint flag: isSendingStale only fires for a 'sending' pack past the
// threshold; absent/unparseable timestamps fail VISIBLE (treated stale).
Deno.test("P-1 isSendingStale: only 'sending' past threshold; fail-visible on bad timestamp", () => {
  const now = Date.parse("2026-06-17T00:10:00Z");
  const old = "2026-06-17T00:00:00Z"; // 10 min ago > 2 min
  const fresh = "2026-06-17T00:09:30Z"; // 30s ago < 2 min
  assertEquals(isSendingStale("sending", old, now), true);
  assertEquals(isSendingStale("sending", fresh, now), false);
  // Non-'sending' packs are never in-flight stale.
  assertEquals(isSendingStale("sent", old, now), false);
  assertEquals(isSendingStale("authorised_not_sent", old, now), false);
  // Fail-visible: missing / unparseable send_started_at on a 'sending' pack -> stale.
  assertEquals(isSendingStale("sending", null, now), true);
  assertEquals(isSendingStale("sending", "not-a-date", now), true);
  // The boundary uses the configured threshold.
  const exactlyAt = now - SENDING_STALE_SECONDS * 1000;
  assertEquals(
    isSendingStale("sending", new Date(exactlyAt).toISOString(), now),
    true,
  );
});

// ── N-1: TWO non-void mapped invoices -> 412 ambiguous, NO authorise, NO send.
Deno.test("N-1: two live invoices map to the job -> 412 ambiguous, NO authorise/send", () => {
  const r = simulateResume({
    priorStatus: "admin_to_send_report",
    liveInvoiceCount: 2,
  });
  assertEquals(r.status, 412);
  assertEquals(r.packStatus, "failed");
  assertEquals(r.body?.failed_step, "preflight_invoice_ambiguous");
  assertEquals(r.body?.count, 2);
  assertEquals(r.fx.authorise, 0, "FAIL CLOSED before any authorise");
  assertEquals(r.fx.email, 0, "FAIL CLOSED before any send");
});

// N-1: EXACTLY ONE live invoice proceeds normally (authorise + send happen once).
Deno.test("N-1: exactly one live invoice proceeds (authorise + send once)", () => {
  const r = simulateResume({
    priorStatus: "admin_to_send_report",
    liveInvoiceCount: 1,
    emailOk: true,
  });
  assertEquals(r.status, 200);
  assertEquals(r.packStatus, "sent");
  assertEquals(r.fx.authorise, 1);
  assertEquals(r.fx.email, 1);
});

Deno.test("money gate: zero-dollar invoice cannot be authorised or sent", () => {
  const failures = checkPositiveInvoiceTotalGate({
    status: "DRAFT",
    total: 0,
    sub_total: 0,
    line_items: [
      { Description: "Labour", Quantity: 4, UnitAmount: 0, LineAmount: 0 },
    ],
  });

  assertEquals(failures.length, 2);
  assert(failures[0].includes("greater than $0"));
});

Deno.test("money gate: positive invoice with zero-priced line still needs review", () => {
  const failures = checkPositiveInvoiceTotalGate({
    status: "DRAFT",
    total: 255,
    sub_total: 255,
    line_items: [
      { Description: "Labour", Quantity: 3, UnitAmount: 85, LineAmount: 255 },
      {
        Description: "Temporary fencing",
        Quantity: 1,
        UnitAmount: 0,
        LineAmount: 0,
      },
    ],
  });

  assertEquals(failures.length, 1);
  assert(failures[0].includes("Temporary fencing"));
});

Deno.test("money gate: positive header or line total is accepted", () => {
  assertEquals(checkPositiveInvoiceTotalGate({ total: 704 }).length, 0);
  assertEquals(
    checkPositiveInvoiceTotalGate({
      total: 0,
      line_items: [{ Description: "Labour", Quantity: 2, UnitAmount: 80 }],
    }).length,
    0,
  );
});

// N-1 pure-contract: isInvoiceAmbiguous / countLiveInvoices ignore VOIDED/DELETED.
Deno.test("N-1 isInvoiceAmbiguous: >1 non-void is ambiguous; voided/deleted never count", () => {
  assertEquals(isInvoiceAmbiguous([]), false);
  assertEquals(isInvoiceAmbiguous([{ status: "DRAFT" }]), false);
  assertEquals(
    isInvoiceAmbiguous([{ status: "AUTHORISED" }, { status: "DRAFT" }]),
    true,
  );
  // Voided/deleted rows are ignored: one live + two dead is NOT ambiguous.
  assertEquals(
    isInvoiceAmbiguous([{ status: "AUTHORISED" }, { status: "VOIDED" }, {
      status: "DELETED",
    }]),
    false,
  );
  assertEquals(
    countLiveInvoices([{ status: "AUTHORISED" }, { status: "VOIDED" }, {
      status: "PAID",
    }]),
    2,
  );
});

// ═════════════════════════════════════════════════════════════════
// 8. EXACT-RECIPIENT GATE (BLOCKER C — money/comms, FAIL CLOSED).
//    The To MUST equal the SERVER-CONFIGURED work-orders inbox (report_recipient)
//    and the CC MUST be EXACTLY [ses@secureworkswa.com.au]. vanessa@ajs.build (the
//    billing contact) must NEVER be a To or a CC. Cross-ref index.ts:makesafeSendPack
//    recipient-gate block (server-derives report_recipient from makesafe_companies).
// ═════════════════════════════════════════════════════════════════

const AJS_WORKORDERS = "workorders@ajs.build";
const VANESSA = "vanessa@ajs.build";

Deno.test("recipient-gate: To=work-orders inbox + CC=[ses@] PASSES", () => {
  assertEquals(
    checkExactRecipientGate({
      configuredReportRecipient: AJS_WORKORDERS,
      to: AJS_WORKORDERS,
      cc: [MAKESAFE_CC],
    }),
    [],
  );
  // A comma-joined string To/CC is tolerated as long as the set is exact.
  assertEquals(
    checkExactRecipientGate({
      configuredReportRecipient: AJS_WORKORDERS,
      to: AJS_WORKORDERS,
      cc: MAKESAFE_CC,
    }),
    [],
  );
});

Deno.test("recipient-gate: CC containing vanessa is REJECTED (vanessa never on CC)", () => {
  const f = checkExactRecipientGate({
    configuredReportRecipient: AJS_WORKORDERS,
    to: AJS_WORKORDERS,
    cc: [MAKESAFE_CC, VANESSA],
  });
  assert(f.length > 0);
  assert(
    f.some((x) => x.includes("EXACTLY") && x.includes(VANESSA)),
    `expected a vanessa cc rejection, got: ${f.join(" | ")}`,
  );
});

Deno.test("recipient-gate: CC with an extra (non-ses) address is REJECTED", () => {
  const f = checkExactRecipientGate({
    configuredReportRecipient: AJS_WORKORDERS,
    to: AJS_WORKORDERS,
    cc: [MAKESAFE_CC, "someone-else@example.com"],
  });
  assert(
    f.some((x) => x.includes("someone-else@example.com")),
    `expected an extra-cc rejection, got: ${f.join(" | ")}`,
  );
});

Deno.test("recipient-gate: missing ses@ on CC is REJECTED", () => {
  const f = checkExactRecipientGate({
    configuredReportRecipient: AJS_WORKORDERS,
    to: AJS_WORKORDERS,
    cc: [],
  });
  assert(
    f.some((x) => x.includes("cc must be exactly")),
    `expected a missing-ses cc rejection, got: ${f.join(" | ")}`,
  );
});

Deno.test("recipient-gate: To != configured report_recipient is REJECTED (vanessa as To blocked)", () => {
  const f = checkExactRecipientGate({
    configuredReportRecipient: AJS_WORKORDERS,
    to: VANESSA, // the billing contact must never be the To
    cc: [MAKESAFE_CC],
  });
  assert(
    f.some((x) =>
      x.includes("to must equal the configured work-orders inbox") &&
      x.includes(VANESSA)
    ),
    `expected a wrong-To rejection naming vanessa, got: ${f.join(" | ")}`,
  );
});

Deno.test("recipient-gate: no report_recipient configured is REJECTED (cannot send)", () => {
  const f = checkExactRecipientGate({
    configuredReportRecipient: null,
    to: VANESSA,
    cc: [MAKESAFE_CC],
  });
  assert(
    f.some((x) => x.includes("no work-order recipient")),
    `expected a no-recipient rejection, got: ${f.join(" | ")}`,
  );
});

Deno.test("recipient-gate: a second To address is REJECTED (exactly one recipient)", () => {
  const f = checkExactRecipientGate({
    configuredReportRecipient: AJS_WORKORDERS,
    to: [AJS_WORKORDERS, VANESSA],
    cc: [MAKESAFE_CC],
  });
  assert(
    f.some((x) =>
      x.includes("to must be exactly the configured work-orders inbox")
    ),
    `expected a too-many-To rejection, got: ${f.join(" | ")}`,
  );
});

// ═════════════════════════════════════════════════════════════════
// 9. HYPHEN-ROBUST normRef (BLOCKER B pt2). 'AJBR 67713' == 'AJBR-67713' ==
//    'AJBR67713' all normalise to 'ajbr67713'. The dup-resolver therefore matches
//    hyphen/space variants of the same external_ref. (Mirrors index.ts
//    _makesafeNormRef; both sites changed together.)
// ═════════════════════════════════════════════════════════════════
Deno.test("normRef: space, hyphen, and compact ref variants collapse to one key", () => {
  assertEquals(normRef("AJBR 67713"), "ajbr67713");
  assertEquals(normRef("AJBR-67713"), "ajbr67713");
  assertEquals(normRef("AJBR67713"), "ajbr67713");
  assertEquals(normRef(" ajbr - 67713 "), "ajbr67713");
  assertEquals(normRef("AJBR 67713"), normRef("AJBR-67713"));
});

Deno.test("dup-guard: a SPACED external_ref matches a HYPHENATED stored reference (BLOCKER B pt2)", () => {
  const rows = [
    {
      job_id: "other",
      status: "AUTHORISED",
      invoice_number: "INV-H",
      reference: "AJBR-67713",
      xero_invoice_id: "xh",
    },
  ];
  // Typed 'AJBR 67713' (space) must resolve the same invoice stored as 'AJBR-67713'.
  const hit = resolveExistingInvoice(rows, "job-x", "AJBR 67713");
  assert(hit, "spaced ref must match the hyphenated stored reference");
  assertEquals(hit!.match_method, "reference");
  assertEquals(hit!.invoice_number, "INV-H");
});

// ═════════════════════════════════════════════════════════════════
// PHASE 1b — RESUME-AWARE FEED ACTION MAPPING (TASK A, deriveResumeAction).
// The 6 contract mapping rows, each returning the right resume_action, plus the
// double-email firewall (marker present => never 'finish_send') and EXCLUSION of
// a sent/terminal job.
// ═════════════════════════════════════════════════════════════════

Deno.test("resume-map row 1: readyForReview -> 'send'", () => {
  assertEquals(
    deriveResumeAction({
      readyForReview: true,
      invoiceAuthorisedLive: false,
      packStatus: "drafted",
      markerPresent: false,
    }),
    "send",
  );
  // readyForReview wins even if a pack status string is present (DRAFT invoice).
  assertEquals(
    deriveResumeAction({
      readyForReview: true,
      invoiceAuthorisedLive: false,
      packStatus: null,
      markerPresent: false,
    }),
    "send",
  );
});

Deno.test("resume-map row 2: authorised_not_sent + authorised invoice + NO marker -> 'finish_send'", () => {
  assertEquals(
    deriveResumeAction({
      readyForReview: false,
      invoiceAuthorisedLive: true,
      packStatus: "authorised_not_sent",
      markerPresent: false,
    }),
    "finish_send",
  );
});

Deno.test("resume-map row 2 (firewall): authorised_not_sent WITH marker -> NOT 'finish_send' (excluded, no double-email)", () => {
  // The double-email firewall: a marker means the email already went out, so we
  // must NEVER offer another send for an authorised_not_sent pack.
  assertEquals(
    deriveResumeAction({
      readyForReview: false,
      invoiceAuthorisedLive: true,
      packStatus: "authorised_not_sent",
      markerPresent: true,
    }),
    null,
  );
});

Deno.test("resume-map row 2 (guard): authorised_not_sent but invoice NOT authorised-live -> excluded", () => {
  assertEquals(
    deriveResumeAction({
      readyForReview: false,
      invoiceAuthorisedLive: false,
      packStatus: "authorised_not_sent",
      markerPresent: false,
    }),
    null,
  );
});

Deno.test("resume-map row 3: sent_marker_failed + NO marker -> 'finish_send' (marker_and_close on backend)", () => {
  assertEquals(
    deriveResumeAction({
      readyForReview: false,
      invoiceAuthorisedLive: true,
      packStatus: "sent_marker_failed",
      markerPresent: false,
    }),
    "finish_send",
  );
  // If the marker is now present, it is a bare terminal -> excluded.
  assertEquals(
    deriveResumeAction({
      readyForReview: false,
      invoiceAuthorisedLive: true,
      packStatus: "sent_marker_failed",
      markerPresent: true,
    }),
    null,
  );
});

Deno.test("resume-map row 4: (sent_not_closed | close_failed) + marker PRESENT -> 'finish_close_out'", () => {
  assertEquals(
    deriveResumeAction({
      readyForReview: false,
      invoiceAuthorisedLive: true,
      packStatus: "sent_not_closed",
      markerPresent: true,
    }),
    "finish_close_out",
  );
  assertEquals(
    deriveResumeAction({
      readyForReview: false,
      invoiceAuthorisedLive: true,
      packStatus: "close_failed",
      markerPresent: true,
    }),
    "finish_close_out",
  );
});

Deno.test("resume-map row 5: sending + NO marker -> 'resolve_send_state'", () => {
  assertEquals(
    deriveResumeAction({
      readyForReview: false,
      invoiceAuthorisedLive: true,
      packStatus: "sending",
      markerPresent: false,
    }),
    "resolve_send_state",
  );
});

Deno.test("resume-map guard: sending + draft_pack is NOT an email-send recovery state", () => {
  assertEquals(
    deriveResumeAction({
      readyForReview: false,
      invoiceAuthorisedLive: true,
      packStatus: "sending",
      failedStep: "draft_pack",
      markerPresent: false,
    }),
    null,
  );
  assertEquals(
    deriveResumeAction({
      readyForReview: true,
      invoiceAuthorisedLive: false,
      packStatus: "sending",
      failedStep: "draft_pack",
      markerPresent: false,
    }),
    "send",
    "completed DRAFT artifacts may surface as the normal review/send path; it is not an email-send recovery state",
  );
});

Deno.test("resume-map row 6: sending + marker PRESENT -> 'finish_close_out'", () => {
  assertEquals(
    deriveResumeAction({
      readyForReview: false,
      invoiceAuthorisedLive: true,
      packStatus: "sending",
      markerPresent: true,
    }),
    "finish_close_out",
  );
});

Deno.test("resume-map row 7: a sent / terminal job is EXCLUDED (null)", () => {
  for (
    const status of [
      "sent",
      "drafted",
      "failed",
      "complete",
      "",
      null,
      undefined,
    ]
  ) {
    assertEquals(
      deriveResumeAction({
        readyForReview: false,
        invoiceAuthorisedLive: true,
        packStatus: status as any,
        markerPresent: false,
      }),
      null,
      `status=${status} must be excluded when not readyForReview`,
    );
  }
  // A bare marker-only terminal (marker present, no recoverable in-progress state).
  assertEquals(
    deriveResumeAction({
      readyForReview: false,
      invoiceAuthorisedLive: true,
      packStatus: "sent",
      markerPresent: true,
    }),
    null,
  );
});

Deno.test("RESUMABLE_PACK_STATUSES: the in-progress set the feed unions in", () => {
  // These are the statuses whose substatus may have moved off admin_to_send_report
  // but which must still surface for resume.
  for (
    const s of [
      "authorised_not_sent",
      "sent_marker_failed",
      "sent_not_closed",
      "close_failed",
      "sending",
    ]
  ) {
    assert(
      RESUMABLE_PACK_STATUSES.includes(s),
      `${s} must be a resumable status`,
    );
  }
  // A terminal 'sent' / fresh 'drafted' must NOT be in the union set.
  assert(!RESUMABLE_PACK_STATUSES.includes("sent"));
  assert(!RESUMABLE_PACK_STATUSES.includes("drafted"));
});

// ═════════════════════════════════════════════════════════════════
// PHASE 1b — makesafe_resume_close GATE (TASK B). Both asserts: status in
// {sent_not_closed, close_failed} AND marker present, else fail-closed.
// ═════════════════════════════════════════════════════════════════

Deno.test("resume_close gate: sent_not_closed + marker -> ok", () => {
  const g = checkResumeCloseGate({
    packStatus: "sent_not_closed",
    markerPresent: true,
  });
  assertEquals(g.ok, true);
});

Deno.test("resume_close gate: close_failed + marker -> ok", () => {
  assertEquals(
    checkResumeCloseGate({ packStatus: "close_failed", markerPresent: true })
      .ok,
    true,
  );
});

Deno.test("resume_close gate: wrong status -> rejected (409), even WITH a marker", () => {
  for (
    const s of [
      "sent",
      "authorised_not_sent",
      "sending",
      "drafted",
      "failed",
      "",
      null,
    ]
  ) {
    const g = checkResumeCloseGate({
      packStatus: s as any,
      markerPresent: true,
    });
    assertEquals(g.ok, false, `status ${s} must be rejected`);
    assertEquals(g.httpStatus, 409);
  }
});

Deno.test("resume_close gate: marker ABSENT -> rejected (no proof of send)", () => {
  const g = checkResumeCloseGate({
    packStatus: "sent_not_closed",
    markerPresent: false,
  });
  assertEquals(g.ok, false);
  assertEquals(g.httpStatus, 409);
  assert(g.reason!.includes("marker absent"));
});

Deno.test("resume_close gate: RESUME_CLOSE_ALLOWED_STATUSES is exactly the close-recoverable set", () => {
  assertEquals(RESUME_CLOSE_ALLOWED_STATUSES.slice().sort(), [
    "close_failed",
    "sent_not_closed",
  ]);
});

// ═════════════════════════════════════════════════════════════════
// PHASE 1b — makesafe_reset_failed_pack GATE (TASK D). Resets a PRE-SEND failed
// pack with NO marker; refuses a marker or a post-email failed_step.
// ═════════════════════════════════════════════════════════════════

Deno.test("reset gate: failed + pre-send step + NO marker -> ok", () => {
  for (
    const step of [
      "recipient_gate",
      "preflight_docs",
      "preflight_invoice",
      "preflight_invoice_ambiguous",
      "load_report_pdf",
      "client_send_gate",
      "draft_pack",
      "unexpected",
    ]
  ) {
    const g = checkResetFailedGate({
      packStatus: "failed",
      failedStep: step,
      markerPresent: false,
    });
    assertEquals(g.ok, true, `pre-send step ${step} must be resettable`);
  }
});

Deno.test("reset gate: a marker present -> REFUSED (the email may have gone out)", () => {
  const g = checkResetFailedGate({
    packStatus: "failed",
    failedStep: "preflight_docs",
    markerPresent: true,
  });
  assertEquals(g.ok, false);
  assert(g.reason!.includes("marker present"));
});

Deno.test("reset gate: a POST-email failed_step -> REFUSED (send/marker/close)", () => {
  for (const step of ["send", "marker", "close", "send_unknown_outcome"]) {
    const g = checkResetFailedGate({
      packStatus: "failed",
      failedStep: step,
      markerPresent: false,
    });
    assertEquals(g.ok, false, `post-email step ${step} must NOT be resettable`);
  }
});

Deno.test("reset gate: status not 'failed' -> REFUSED", () => {
  for (
    const s of [
      "sent",
      "sending",
      "authorised_not_sent",
      "drafted",
      "sent_not_closed",
    ]
  ) {
    assertEquals(
      checkResetFailedGate({
        packStatus: s,
        failedStep: "preflight_docs",
        markerPresent: false,
      }).ok,
      false,
    );
  }
});

// ═════════════════════════════════════════════════════════════════
// PHASE 1b (TASK C, D-d) — email-outcome classifier. Only a narrow set of 4xx
// codes PROVE a pre-dispatch rejection; timeout/rate-limit 4xx + ALL 5xx are
// AMBIGUOUS (=> 'sending', never authorised_not_sent). FAIL CLOSED.
// ═════════════════════════════════════════════════════════════════
Deno.test("email classifier: 400/401/403/404/422 are provably pre-dispatch (authorised_not_sent OK)", () => {
  for (const s of [400, 401, 403, 404, 422]) {
    assertEquals(
      emailFailureIsProvablyPreDispatch(s),
      true,
      `${s} should be provably pre-dispatch`,
    );
  }
});

Deno.test("email classifier: AMBIGUOUS 4xx (408/409/425/429) are NOT pre-dispatch -> 'sending'", () => {
  // The codex-review hardening: a timeout / conflict / too-early / rate-limit is
  // NOT proof the email was rejected before dispatch.
  for (const s of [408, 409, 425, 429, 451, 499]) {
    assertEquals(
      emailFailureIsProvablyPreDispatch(s),
      false,
      `${s} is ambiguous, must NOT be pre-dispatch`,
    );
  }
});

Deno.test("email classifier: ALL 5xx are ambiguous (NOT pre-dispatch)", () => {
  for (const s of [500, 502, 503, 504, 599]) {
    assertEquals(
      emailFailureIsProvablyPreDispatch(s),
      false,
      `${s} (5xx) is ambiguous`,
    );
  }
});

Deno.test("email classifier: 0/NaN/negative (thrown-fetch sentinel) are ambiguous -> fail closed", () => {
  assertEquals(emailFailureIsProvablyPreDispatch(0), false);
  assertEquals(emailFailureIsProvablyPreDispatch(NaN), false);
  assertEquals(emailFailureIsProvablyPreDispatch(-1), false);
});
