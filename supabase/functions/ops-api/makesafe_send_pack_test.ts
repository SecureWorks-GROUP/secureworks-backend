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
  sendPackAllowed,
  checkClientSendGate,
  resolveExistingInvoice,
  isPackSentMainEvent,
  hasPackSentMainMarker,
  buildPackSentMarkerText,
  canAcquireSendLock,
  SendLockCell,
  isReportPdf,
  isXeroInvoicePdf,
  hasReviewMarker,
  MAKESAFE_ADMIN_FROM,
  MAKESAFE_CC,
  // C-1 / P-1 / N-1 last-round helpers (post-send recovery, 'sending' resolution,
  // ambiguous-invoice fail-closed).
  planPostSendResume,
  planSendingResolution,
  isSendingStale,
  isInvoiceAmbiguous,
  countLiveInvoices,
  SENDING_STALE_SECONDS,
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
  for (const role of ["admin", "owner", "ops", "viewer", "unknown", undefined]) {
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
  for (const role of ["admin", "owner", "ops", "viewer", "unknown", undefined]) {
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
    if (authMode === "routine" && ROUTINE_FORBIDDEN_ACTIONS.has(action)) return 403;
    return 200; // falls through to the route case (which also gates via sendPackAllowed)
  }
  assertEquals(centralAuthStatus("routine", "makesafe_send_pack"), 403);
  // The privileged classes are NOT centrally denied — they reach the route case.
  assertEquals(centralAuthStatus("api_key", "makesafe_send_pack"), 200);
  assertEquals(centralAuthStatus("jwt", "makesafe_send_pack"), 200);
  // The routine CAN reach the draft-only verbs (not on the deny-list).
  assertEquals(centralAuthStatus("routine", "create_makesafe_draft_invoice"), 200);
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

Deno.test("send-lock: two racers -> exactly one acquires, the other gets 0 rows (409)", () => {
  const cell = new SendLockCell("admin_to_send_report");
  // Serialized contention: racer A then racer B both try to take the lock.
  const aGot = cell.tryAcquire();
  const bGot = cell.tryAcquire();
  assertEquals(aGot, true, "first racer wins the lock");
  assertEquals(bGot, false, "second racer sees status=sending -> 0 rows -> 409");
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
    return { result: "already_sent", pack, log, authorisedThisRun: false, emailedThisRun: false };
  }
  // LOCK
  const cell = new SendLockCell(pack.status);
  if (!cell.tryAcquire()) return { result: "conflict", pack, log, authorisedThisRun: false, emailedThisRun: false };
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
    return { result: "send_failed", pack, log, authorisedThisRun, emailedThisRun };
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
  const r = simulateSend({ initialStatus: "admin_to_send_report", invoiceAlreadyAuthorised: false, emailOk: false, markerPresent: false });
  assertEquals(r.result, "send_failed");
  assertEquals(r.pack.status, "authorised_not_sent");
  assertEquals(r.pack.sent_at, null);
  assert(!r.log.includes("marker"), "no marker written on send failure");
  assert(!r.log.includes("close"), "no close on send failure");
  assert(r.log.includes("authorise"), "invoice was authorised before the send attempt");
});

Deno.test("resume after email-fail: does NOT re-authorise, can complete on a good send", () => {
  // First attempt: authorise happened, send failed -> authorised_not_sent.
  const first = simulateSend({ initialStatus: "admin_to_send_report", invoiceAlreadyAuthorised: false, emailOk: false, markerPresent: false });
  assertEquals(first.pack.status, "authorised_not_sent");
  // Resume: pack is authorised_not_sent (lockable), invoice ALREADY authorised.
  const resume = simulateSend({ initialStatus: "authorised_not_sent", invoiceAlreadyAuthorised: true, emailOk: true, markerPresent: false });
  assertEquals(resume.result, "sent");
  assertEquals(resume.authorisedThisRun, false, "resume must NOT re-authorise");
  assert(resume.log.includes("skip_authorise"));
  assertEquals(resume.pack.status, "sent");
});

Deno.test("resume after a confirmed send: marker present -> already_sent, no re-email", () => {
  const resume = simulateSend({ initialStatus: "sent", invoiceAlreadyAuthorised: true, emailOk: true, markerPresent: true });
  assertEquals(resume.result, "already_sent");
  assertEquals(resume.emailedThisRun, false, "never re-email when the marker exists");
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
  const f = checkClientSendGate(basePayload({ subject: "DRAFT Make Safe Completion" }));
  assert(f.length > 0);
  assert(f.some((x) => x.includes("review/test marker") && x.includes("DRAFT")));
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
  assert(checkClientSendGate(basePayload({ from: "marnin@gmail.com" })).some((x) => x.includes("sender must be")));
  assert(checkClientSendGate(basePayload({ cc: "" })).some((x) => x.includes("cc must include")));
  assert(checkClientSendGate(basePayload({ attachments: [cleanAttachments[0]] })).some((x) => x.includes("at least two")));
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
    { job_id: "job-1", status: "AUTHORISED", invoice_number: "INV-1", reference: "MLB-100", xero_invoice_id: "x1" },
  ];
  const hit = resolveExistingInvoice(rows, "job-1", "MLB-100");
  assert(hit);
  assertEquals(hit!.match_method, "job_id");
  assertEquals(hit!.invoice_number, "INV-1");
});

Deno.test("dup-guard: exact normalised reference match (case + whitespace folded)", () => {
  const rows = [
    { job_id: "other", status: "DRAFT", invoice_number: "INV-2", reference: " MLB-24981 ", xero_invoice_id: "x2" },
  ];
  // normRef folds case + strips surrounding/inner whitespace (NOT hyphens),
  // matching the python _norm. " MLB-24981 " -> "mlb-24981" == "mlb-24981".
  const hit = resolveExistingInvoice(rows, "job-x", "mlb-24981");
  assert(hit);
  assertEquals(hit!.match_method, "reference");
});

Deno.test("dup-guard: reference substring (>=5 chars) match", () => {
  const rows = [
    { job_id: "other", status: "AUTHORISED", invoice_number: "INV-3", reference: "Deposit MLB-24981 stage 1", xero_invoice_id: "x3" },
  ];
  const hit = resolveExistingInvoice(rows, "job-x", "MLB-24981");
  assert(hit);
  assertEquals(hit!.match_method, "reference_substring");
});

Deno.test("dup-guard: short ref (<5 chars) does NOT substring-match", () => {
  const rows = [
    { job_id: "other", status: "AUTHORISED", invoice_number: "INV-4", reference: "Job AB12 deposit", xero_invoice_id: "x4" },
  ];
  assertEquals(resolveExistingInvoice(rows, "job-x", "AB12"), null);
});

Deno.test("dup-guard: VOIDED/DELETED invoice does NOT block creation", () => {
  const rows = [
    { job_id: "job-1", status: "VOIDED", invoice_number: "INV-V", reference: "MLB-100", xero_invoice_id: "xv" },
    { job_id: "job-1", status: "DELETED", invoice_number: "INV-D", reference: "MLB-100", xero_invoice_id: "xd" },
  ];
  assertEquals(resolveExistingInvoice(rows, "job-1", "MLB-100"), null);
});

Deno.test("dup-guard: live invoice wins even when a voided one is newer/first", () => {
  // job_id tier: a voided row is present but a live row exists -> the live one.
  const rows = [
    { job_id: "job-1", status: "VOIDED", invoice_number: "INV-OLD", reference: "MLB-100", xero_invoice_id: "xo" },
    { job_id: "job-1", status: "AUTHORISED", invoice_number: "INV-NEW", reference: "MLB-100", xero_invoice_id: "xn" },
  ];
  const hit = resolveExistingInvoice(rows, "job-1", "MLB-100");
  assert(hit);
  assertEquals(hit!.invoice_number, "INV-NEW");
});

Deno.test("dup-guard: no match -> null (safe to create the single draft)", () => {
  const rows = [
    { job_id: "other", status: "AUTHORISED", invoice_number: "INV-Z", reference: "AJS-9999", xero_invoice_id: "xz" },
  ];
  assertEquals(resolveExistingInvoice(rows, "job-1", "MLB-100"), null);
});

// ─────────────────────────────────────────────────────────────────
// 6. MARKER idempotency stop — marker present -> already_sent without re-email.
// ─────────────────────────────────────────────────────────────────

Deno.test("marker: isPackSentMainEvent matches only a main-pack note", () => {
  assert(isPackSentMainEvent({ event_type: "note", detail_json: { text: "MAKESAFE_PACK_SENT | main | INV-1 | to=x | t | msgid=a" } }));
  // string-encoded detail_json is parsed.
  assert(isPackSentMainEvent({ event_type: "note", detail_json: JSON.stringify({ text: "MAKESAFE_PACK_SENT | main | x" }) }));
  // photo pack does NOT count as main.
  assert(!isPackSentMainEvent({ event_type: "note", detail_json: { text: "MAKESAFE_PACK_SENT | photo | x" } }));
  // wrong event type.
  assert(!isPackSentMainEvent({ event_type: "invoice.emailed", detail_json: { text: "MAKESAFE_PACK_SENT | main" } }));
});

Deno.test("marker: hasPackSentMainMarker scans an event set", () => {
  assert(hasPackSentMainMarker([
    { event_type: "note", detail_json: { text: "hello" } },
    { event_type: "note", detail_json: { text: "MAKESAFE_PACK_SENT | main | INV-1" } },
  ]));
  assert(!hasPackSentMainMarker([{ event_type: "note", detail_json: { text: "no marker here" } }]));
  assert(!hasPackSentMainMarker([]));
});

Deno.test("marker: buildPackSentMarkerText starts with the main prefix (round-trips through the matcher)", () => {
  const text = buildPackSentMarkerText({ invoiceNumber: "INV-0712", to: "builder@x.com", nowIso: "2026-06-17T00:00:00Z", messageId: "m1" });
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
    return { status: 200, resumed: true, action: postSendPlan.action, packStatus: "sent", sent: true, closed: true, fx };
  }

  // 'sending' hard-crash window (P-1) — requires explicit resolution (index.ts ~14872).
  if (opts.priorStatus === "sending") {
    const resolution = planSendingResolution(opts.sendingResolution);
    if (!resolution) {
      // No valid resolution -> 409, NO side effects.
      return { status: 409, packStatus: "sending", fx, body: { requires: "sending_resolution" } };
    }
    if (resolution.writeMarkerAndClose) {
      // confirmed_sent -> marker + close, status='sent', NO re-email/authorise.
      fx.marker++;
      fx.close++;
      return { status: 200, resumed: true, action: "confirmed_sent_marker_and_close", packStatus: "sent", sent: true, closed: true, fx };
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
    ...Array.from({ length: liveCount }, (_, i) => ({ status: "DRAFT", invoice_number: `INV-${i}` })),
    { status: "VOIDED", invoice_number: "INV-DEAD" }, // a void row never counts
  ];
  if (isInvoiceAmbiguous(invoiceRows)) {
    return { status: 412, packStatus: "failed", fx, body: { failed_step: "preflight_invoice_ambiguous", count: countLiveInvoices(invoiceRows) } };
  }
  if (liveCount === 0) {
    // No live invoice -> the OTHER 412 (preflight_invoice). Not the focus here.
    return { status: 412, packStatus: "failed", fx, body: { failed_step: "preflight_invoice" } };
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
  assertEquals(planPostSendResume("sent_marker_failed")?.action, "marker_and_close");
  assertEquals(planPostSendResume("sent_not_closed")?.action, "close");
  assertEquals(planPostSendResume("close_failed")?.action, "close");
  // Never recovers these (normal path / explicit-resolution path / terminal).
  for (const s of ["admin_to_send_report", "drafted", "authorised_not_sent", "sending", "sent", "failed", "", undefined]) {
    assertEquals(planPostSendResume(s as string), null, `${s} must not auto-recover`);
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
  const r = simulateResume({ priorStatus: "sending", sendingResolution: "confirmed_sent" });
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
  assertEquals(r.fx.authorise, 0, "invoice already authorised -> NO re-authorise");
  assertEquals(r.fx.marker, 1);
  assertEquals(r.fx.close, 1);
});

// planSendingResolution pure-contract: only the two literals plan; else null (-> 409).
Deno.test("P-1 planSendingResolution: only confirmed_sent / confirmed_not_sent are valid", () => {
  assertEquals(planSendingResolution("confirmed_sent")?.writeMarkerAndClose, true);
  assertEquals(planSendingResolution("confirmed_sent")?.reEnterSend, false);
  assertEquals(planSendingResolution("confirmed_not_sent")?.reEnterSend, true);
  assertEquals(planSendingResolution("confirmed_not_sent")?.writeMarkerAndClose, false);
  // Neither resolution ever re-authorises from 'sending'.
  assertEquals(planSendingResolution("confirmed_sent")?.reAuthorise, false);
  assertEquals(planSendingResolution("confirmed_not_sent")?.reAuthorise, false);
  for (const bad of ["", "yes", "sent", "CONFIRMED_SENT", null, undefined, 1, {}]) {
    assertEquals(planSendingResolution(bad as unknown), null, `${String(bad)} must be invalid -> 409`);
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
  assertEquals(isSendingStale("sending", new Date(exactlyAt).toISOString(), now), true);
});

// ── N-1: TWO non-void mapped invoices -> 412 ambiguous, NO authorise, NO send.
Deno.test("N-1: two live invoices map to the job -> 412 ambiguous, NO authorise/send", () => {
  const r = simulateResume({ priorStatus: "admin_to_send_report", liveInvoiceCount: 2 });
  assertEquals(r.status, 412);
  assertEquals(r.packStatus, "failed");
  assertEquals(r.body?.failed_step, "preflight_invoice_ambiguous");
  assertEquals(r.body?.count, 2);
  assertEquals(r.fx.authorise, 0, "FAIL CLOSED before any authorise");
  assertEquals(r.fx.email, 0, "FAIL CLOSED before any send");
});

// N-1: EXACTLY ONE live invoice proceeds normally (authorise + send happen once).
Deno.test("N-1: exactly one live invoice proceeds (authorise + send once)", () => {
  const r = simulateResume({ priorStatus: "admin_to_send_report", liveInvoiceCount: 1, emailOk: true });
  assertEquals(r.status, 200);
  assertEquals(r.packStatus, "sent");
  assertEquals(r.fx.authorise, 1);
  assertEquals(r.fx.email, 1);
});

// N-1 pure-contract: isInvoiceAmbiguous / countLiveInvoices ignore VOIDED/DELETED.
Deno.test("N-1 isInvoiceAmbiguous: >1 non-void is ambiguous; voided/deleted never count", () => {
  assertEquals(isInvoiceAmbiguous([]), false);
  assertEquals(isInvoiceAmbiguous([{ status: "DRAFT" }]), false);
  assertEquals(isInvoiceAmbiguous([{ status: "AUTHORISED" }, { status: "DRAFT" }]), true);
  // Voided/deleted rows are ignored: one live + two dead is NOT ambiguous.
  assertEquals(
    isInvoiceAmbiguous([{ status: "AUTHORISED" }, { status: "VOIDED" }, { status: "DELETED" }]),
    false,
  );
  assertEquals(countLiveInvoices([{ status: "AUTHORISED" }, { status: "VOIDED" }, { status: "PAID" }]), 2);
});
