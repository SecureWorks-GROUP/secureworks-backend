// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const ACTIONS = await Deno.readTextFile(
  new URL("./ses_reporting_actions.ts", import.meta.url),
);
const EFFECTS = await Deno.readTextFile(
  new URL("./ses_external_effects.ts", import.meta.url),
);
const SEND_QUOTE = await Deno.readTextFile(
  new URL("../send-quote/index.ts", import.meta.url),
);
const FENCE = await Deno.readTextFile(
  new URL("../_shared/sealed_ses_money_fence.ts", import.meta.url),
);
const REPORTING = await Deno.readTextFile(
  new URL("../reporting-api/index.ts", import.meta.url),
);
const XERO_SYNC = await Deno.readTextFile(
  new URL("../xero-sync/index.ts", import.meta.url),
);
const REQUIRED_ACTIONS = await Deno.readTextFile(
  new URL("../../../scripts/_ops-api-required-actions.txt", import.meta.url),
);

Deno.test("legacy free invoice and combined-send actions are retired", () => {
  for (
    const action of [
      "create_makesafe_draft_invoice",
      "draft_makesafe_report_pack",
      "draft_makesafe_report_pack_due",
      "makesafe_send_pack",
      "makesafe_send_photo_followup",
    ]
  ) {
    assertStringIncludes(INDEX, `case '${action}'`);
  }
  assertStringIncludes(INDEX, "legacy_free_invoice_path_retired");
  assertStringIncludes(INDEX, "legacy_combined_release_retired");
  assertStringIncludes(INDEX, "legacy_route_send_retired");
});

Deno.test("legacy invoice sends hit the sealed SES release gate before provider effects", () => {
  const sendStart = INDEX.indexOf("case 'send_invoice_email'");
  const sendGate = INDEX.indexOf(
    "assertLegacySesInvoiceActionAllowed(",
    sendStart,
  );
  const sendProvider = INDEX.indexOf(
    "xeroPost(`/Invoices/${siId}/Email`,",
    sendStart,
  );
  assert(sendGate > sendStart && sendGate < sendProvider);

  const approveStart = INDEX.indexOf("case 'approve_and_send_invoice'");
  const approveGate = INDEX.indexOf(
    "assertLegacySesInvoiceActionAllowed(",
    approveStart,
  );
  const approveProvider = INDEX.indexOf(
    "xeroPost(`/Invoices/${asId}`",
    approveStart,
  );
  assert(approveGate > approveStart && approveGate < approveProvider);
  assertStringIncludes(INDEX, "invoice_obligation_revision_id");
  assertStringIncludes(INDEX, "sealedSesMoneyRefusal(action");
  assertStringIncludes(FENCE, 'code: "sealed_ses_release_required"');
  assertStringIncludes(FENCE, "execute_ses_invoice_revision");
  assertStringIncludes(FENCE, "execute_ses_release_revision");
});

Deno.test("all legacy sealed-SES money and link surfaces fence before effects", () => {
  const before = (
    startText: string,
    gateText: string,
    effectText: string,
  ) => {
    const start = INDEX.indexOf(startText);
    const gate = INDEX.indexOf(gateText, start);
    const effect = INDEX.indexOf(effectText, start);
    assert(
      start >= 0 && gate > start && effect > gate,
      `${startText} must call ${gateText} before ${effectText}`,
    );
  };

  before(
    "case 'update_invoice_job_link'",
    "assertLegacySesInvoiceActionAllowed(",
    ".update({ job_id: jid",
  );
  before(
    "case 'void_invoice'",
    "assertLegacySesInvoiceActionAllowed(client, vid",
    "xeroPost(`/Invoices/${vid}`",
  );
  before(
    "case 'approve_invoice'",
    "assertLegacySesInvoiceActionAllowed(client, aid",
    "xeroPost(`/Invoices/${aid}`",
  );
  before(
    "async function updateInvoice(",
    "assertLegacySesInvoiceActionAllowed(",
    "xeroPost(`/Invoices/${xero_invoice_id}`",
  );
  before(
    "async function markInvoicePaid(",
    "assertLegacySesInvoiceActionAllowed(",
    ".update({\n    status: 'PAID'",
  );
  before(
    "async function completeAndInvoice(",
    "assertLegacySesMoneyActionAllowedForJob(",
    ".update({ status: 'complete'",
  );
  before(
    "async function sendPaymentLink(",
    "assertLegacySesMoneyActionAllowedForJob(",
    "fetch(ghlUrl",
  );
  before(
    "async function sendAcceptanceInvoice(",
    "assertLegacySesMoneyActionAllowedForJob(",
    "createDepositInvoice(client",
  );
  before(
    "async function syncJobInvoices(",
    "assertLegacySesMoneyActionAllowedForJob(",
    "xeroGet('/Invoices'",
  );
  before(
    "async function reconcilePayment(",
    "assertLegacySesInvoiceActionAllowed(",
    "xeroPost('/Payments'",
  );
  before(
    "async function sendClientUpdate(",
    "assertLegacySesMoneyActionAllowedForJob(",
    "fetch(ghlUrl",
  );
});

Deno.test("create choke fences F9 email and resolves duplicates before Xero", () => {
  const start = INDEX.indexOf("async function createInvoice(");
  const fence = INDEX.indexOf(
    "assertLegacySesMoneyActionAllowedForJob(",
    start,
  );
  const duplicate = INDEX.indexOf(
    "assertSealedSesInvoiceCreateIsUnique(",
    start,
  );
  const create = INDEX.indexOf("xeroPost('/Invoices'", start);
  const email = INDEX.indexOf(
    "xeroPost(`/Invoices/${xeroInvId}/Email`",
    start,
  );
  assert(start >= 0 && fence > start);
  assert(duplicate > fence && create > duplicate && email > create);
  for (
    const wrapper of [
      "completeAndInvoice",
      "createGeneralInvoice",
      "createUnifiedInvoice",
      "createDepositInvoice",
    ]
  ) {
    const wrapperStart = INDEX.indexOf(`async function ${wrapper}(`);
    assert(
      INDEX.indexOf("createInvoice(client", wrapperStart) > wrapperStart,
      `${wrapper} must delegate ACCREC creation to the fenced choke`,
    );
  }
});

Deno.test("send-quote preserves explicit SES binding refusal before Resend", () => {
  const start = SEND_QUOTE.indexOf("if (path === 'send-invoice'");
  const invoiceLink = SEND_QUOTE.indexOf(".from('xero_invoices')", start);
  const binding = SEND_QUOTE.indexOf(
    "validateBrandedInvoiceDeliveryBinding(",
    start,
  );
  const provider = SEND_QUOTE.indexOf(
    "fetch('https://api.resend.com/emails'",
    start,
  );
  assert(
    start >= 0 && invoiceLink > start && binding > invoiceLink &&
      provider > binding,
  );
  assertStringIncludes(FENCE, "sealed_ses_fence_check_failed");
  assertStringIncludes(FENCE, "invoice_link_required");
});

Deno.test("reporting auto-match preserves explicit SES binding refusal", () => {
  const start = REPORTING.indexOf("async function matchInvoicesToJobs(");
  const obligation = REPORTING.indexOf(
    "plan.invoice.invoice_obligation_revision_id",
    start,
  );
  const token = REPORTING.indexOf(
    "plan.invoice.ses_external_token",
    obligation,
  );
  const refusal = REPORTING.indexOf(
    "sealedSesMoneyRefusal('reporting-api/match_invoices'",
    token,
  );
  const update = REPORTING.indexOf(".update({ job_id: plan.job.id })", start);
  assert(
    start >= 0 && obligation > start && token > obligation &&
      refusal > token && update > refusal,
  );
  assertStringIncludes(REPORTING, "ReportingApiRefusalError");
  assertStringIncludes(
    REPORTING,
    "sealedSesMoneyRefusal('reporting-api/match_invoices'",
  );
});

Deno.test("all xero-sync ACCREC auto-link writers use the sealed SES fence", () => {
  assertStringIncludes(XERO_SYNC, "sealedSesXeroLinkRefusal(");
  assertStringIncludes(XERO_SYNC, "linkContactInvoicesToJob(");
  assertStringIncludes(XERO_SYNC, "invoice_obligation_revision_id");
  assertStringIncludes(XERO_SYNC, "ses_external_token");
  assertStringIncludes(XERO_SYNC, "ses_link_refusals");

  const unlinkedStart = XERO_SYNC.indexOf(
    "export async function matchUnlinkedInvoices(",
  );
  const unlinkedFence = XERO_SYNC.indexOf(
    "sealedSesXeroLinkRefusal(",
    unlinkedStart,
  );
  const unlinkedUpdate = XERO_SYNC.indexOf(
    ".update({ job_id: job.id",
    unlinkedStart,
  );
  assert(
    unlinkedStart >= 0 && unlinkedFence > unlinkedStart &&
      unlinkedUpdate > unlinkedFence,
  );

  const referenceStart = XERO_SYNC.indexOf(
    "async function matchInvoicesByReference(",
  );
  const referenceFence = XERO_SYNC.indexOf(
    "sealedSesXeroLinkRefusal(",
    referenceStart,
  );
  const referenceUpdate = XERO_SYNC.indexOf(
    ".update({ job_id: job.id })",
    referenceStart,
  );
  assert(
    referenceStart >= 0 && referenceFence > referenceStart &&
      referenceUpdate > referenceFence,
  );
});

Deno.test("annotation relinking fences before resolving or linking", () => {
  const start = INDEX.indexOf("async function resolveAnnotation(");
  const targetFence = INDEX.indexOf(
    "assertLegacySesMoneyActionAllowedForJob(",
    start,
  );
  const sourceFence = INDEX.indexOf(
    "assertLegacySesInvoiceRowsActionAllowed(",
    start,
  );
  const resolve = INDEX.indexOf(
    ".update({\n      status: 'resolved'",
    start,
  );
  const link = INDEX.indexOf(
    ".update({ job_id: ann.structured_data.job_id })",
    start,
  );
  assert(
    start >= 0 && targetFence > start && sourceFence > targetFence &&
      resolve > sourceFence && link > resolve,
  );
  assertStringIncludes(INDEX, "synthetic_livefire_invoice_unresolved");
  assertStringIncludes(FENCE, 'code: "invoice_link_required"');
  assertStringIncludes(
    FENCE,
    "execute_ses_release_revision",
  );
  assertStringIncludes(INDEX, "execute_ses_release_revision");
});

Deno.test("routine allowlist exposes SES preparation, reads, and bounded attach-only binds", () => {
  const start = INDEX.indexOf("const ROUTINE_ALLOWED_ACTIONS");
  const end = INDEX.indexOf("if (authMode === 'routine'", start);
  const allowlist = INDEX.slice(start, end);
  for (
    const safe of [
      "prepare_ses_invoice_obligation",
      "resolve_ses_invoice_duplicates",
      "query_ses_invoice_obligation",
      "prepare_ses_release_revision",
      "query_ses_review_cockpit",
      "query_ses_proof_ledger",
      "bind_current_cycle_curated_makesafe_report",
      "bind_existing_makesafe_invoice_pack",
    ]
  ) {
    assertStringIncludes(allowlist, `'${safe}'`);
  }
  for (
    const humanOrEffect of [
      "approve_ses_invoice_revision",
      "execute_ses_invoice_revision",
      "approve_ses_release_revision",
      "execute_ses_release_revision",
      "record_ses_review_feedback",
    ]
  ) {
    assert(
      !allowlist.includes(`'${humanOrEffect}'`),
      `${humanOrEffect} must remain routine-forbidden`,
    );
  }
});

Deno.test("curated bind is routed, source-surface declared and has no effect authority", () => {
  assertStringIncludes(
    INDEX,
    "case 'bind_current_cycle_curated_makesafe_report'",
  );
  assertStringIncludes(
    REQUIRED_ACTIONS,
    "bind_current_cycle_curated_makesafe_report # probe=source-only",
  );
  const start = INDEX.indexOf(
    "async function bindCurrentCycleCuratedMakesafeReport(",
  );
  const end = INDEX.indexOf(
    "async function attachCurrentWikiCuratedReport(",
    start,
  );
  const implementation = INDEX.slice(start, end);
  assert(start >= 0 && end > start);
  assertStringIncludes(implementation, ".from('job_events').insert({");
  assertStringIncludes(implementation, ".from('job_documents').update({");
  // Server owns cycle, renderer and input hash; caller does not guess them.
  assertStringIncludes(
    implementation,
    "detailResponse.data.attendance_cycle_id",
  );
  assertStringIncludes(
    implementation,
    "MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION",
  );
  assertStringIncludes(implementation, "cycle_attribution: 'bound'");
  assertStringIncludes(implementation, "prior_data_snapshot_json: prior");
  assertStringIncludes(implementation, "requireCuratedBindSha256");
  assertStringIncludes(implementation, "recoverCuratedBindDocumentBytes(");
  assertStringIncludes(implementation, "persistRecoveredCuratedBindDocumentBytes(");
  assertStringIncludes(INDEX, "CURATED_BIND_SHA256_RE");
  assertStringIncludes(INDEX, "async function persistMakesafeDocumentPdfBytes(");
  assertStringIncludes(
    INDEX,
    "async function recoverCuratedBindDocumentBytes(",
  );
  assertStringIncludes(
    INDEX,
    "async function persistRecoveredCuratedBindDocumentBytes(",
  );
  assertStringIncludes(
    INDEX,
    "sourceResponse.status !== 400 && sourceResponse.status !== 404",
  );
  assertStringIncludes(INDEX, "curated_bind_document_bytes_persist_refused");
  {
    const recoverCall = implementation.indexOf(
      "recoverCuratedBindDocumentBytes(",
    );
    const evidenceCall = implementation.indexOf(
      "assertCurrentWikiSourceEvidence(",
    );
    const persistCall = implementation.indexOf(
      "persistRecoveredPlaceholderIfNeeded()",
    );
    const lastPersist = implementation.lastIndexOf(
      "persistRecoveredPlaceholderIfNeeded()",
    );
    const casMarker = implementation.lastIndexOf(
      "data_snapshot_json: exactSnapshot",
    );
    assert(
      recoverCall >= 0 && evidenceCall > recoverCall,
      "inspect recover must run before source-evidence",
    );
    assert(
      persistCall > evidenceCall,
      "placeholder persist must run after source-evidence",
    );
    assert(
      casMarker > lastPersist && lastPersist > 0,
      "placeholder persist must run before the version CAS",
    );
  }
  // Prior poisoned provenance is preserved in the audit event, not deleted
  // as a permanent gate on exact verified replacement bytes.
  assert(
    !implementation.includes(
      "raw, retired, or self-stamped report provenance cannot be bound",
    ),
    "poisoned prior provenance must no longer permanently refuse an exact bind",
  );
  for (
    const forbidden of [
      "xeroPost(",
      "createInvoice(",
      ".upload(",
      "executeSes",
      "sendMail",
      "createSignedUrl",
    ]
  ) {
    assert(
      !implementation.includes(forbidden),
      `bind action must not gain ${forbidden} authority`,
    );
  }
});

Deno.test("Xero create is DRAFT-only and suppresses legacy side effects", () => {
  assertStringIncludes(INDEX, "const invoiceStatus = sesContext ? 'DRAFT'");
  assertStringIncludes(INDEX, "if (!sesContext && send_email && xeroInvId)");
  assertStringIncludes(INDEX, "if (!sesContext) {");
  assertStringIncludes(INDEX, "ses_external_token:");
  assertStringIncludes(
    INDEX,
    "Sealed SES invoices bill the classified builder Xero contact.",
  );
  assertStringIncludes(
    INDEX,
    "assertSealedSesInvoiceCreateIsUnique(",
  );
});

Deno.test("Graph sends the checkpointed draft by id and never uses sendMail", () => {
  // Gateway implementation lives in ses_graph_mail_gateway.ts; index.ts only
  // wires createSesGraphMailGateway with storage/checkpoint deps.
  const GATEWAY = Deno.readTextFileSync(
    new URL("./ses_graph_mail_gateway.ts", import.meta.url),
  );
  assertStringIncludes(GATEWAY, "/send");
  assertStringIncludes(GATEWAY, "createSesGraphMailGateway");
  assertStringIncludes(INDEX, "createSesGraphMailGateway");
  assertStringIncludes(INDEX, "phase: 'draft_created'");
  assert(
    !GATEWAY.includes("/sendMail"),
    "sealed SES route adapter must not use bare sendMail",
  );
  assert(
    !INDEX.slice(
      INDEX.indexOf("function makeSesGraphMailGateway"),
      INDEX.indexOf("function opsApiVersion"),
    ).includes("/sendMail"),
    "index wiring must not use bare sendMail",
  );
});

Deno.test("SES operation token stays off builder-facing subject/body/reference", () => {
  const GATEWAY = Deno.readTextFileSync(
    new URL("./ses_graph_mail_gateway.ts", import.meta.url),
  );
  // Non-visible Graph header is the mail proof carrier.
  assertStringIncludes(
    GATEWAY,
    'SES_OPERATION_HEADER = "x-secureworks-ses-operation"',
  );
  assertStringIncludes(GATEWAY, "internetMessageHeaders");
  // Subject must not re-inject `[${token}]`.
  assert(
    !GATEWAY.includes("return `${base} [${token}]`"),
    "builder-facing subject must not stamp the SES operation token",
  );
  // Invoice Reference no longer appends `| ${token}`.
  assert(
    !INDEX.includes("| ${sesContext.externalToken}"),
    "builder-facing Xero Reference must not stamp the SES operation token",
  );
  // Reconcile carriers for invoice mint after the strip.
  assertStringIncludes(INDEX, "phase: 'xero_draft_created'");
  assertStringIncludes(INDEX, ".eq('ses_external_token', token)");
});

Deno.test("external effects reconcile the exact provider token before dispatch", () => {
  const transition = EFFECTS.indexOf('"dispatching",');
  const reconcile = EFFECTS.indexOf("preDispatchMatches", transition);
  const dispatch = EFFECTS.indexOf(
    "return await dispatchFrom(dispatching)",
    reconcile,
  );
  assert(transition >= 0 && reconcile > transition && dispatch > reconcile);
  assertStringIncludes(EFFECTS, "await args.adapter.dispatch(args.payload");
  assertStringIncludes(INDEX, "readSesXeroInvoicesByToken");
  assertStringIncludes(ACTIONS, "reconcileCreate");
});

Deno.test("post-release disposition is an identified human decision", () => {
  assertStringIncludes(
    ACTIONS,
    "args.post_release_disposition &&",
  );
  assertStringIncludes(
    ACTIONS,
    'auth.mode !== "jwt" || !auth.user',
  );
  assertStringIncludes(
    ACTIONS,
    "The later attendance has no identified human disposition",
  );
});

Deno.test("Captain approval cannot execute a blocked money proposal", () => {
  const executeStart = ACTIONS.indexOf(
    "export async function executeSesInvoiceRevisionAction",
  );
  const approvalRead = ACTIONS.indexOf(
    "const approval = await currentInvoiceApproval",
    executeStart,
  );
  const blockedGuard = ACTIONS.indexOf(
    'revision.state === "blocked"',
    executeStart,
  );
  assert(
    blockedGuard > executeStart && blockedGuard < approvalRead,
    "blocked pricing must be refused before any approval can authorize Xero execution",
  );
  assertStringIncludes(
    ACTIONS,
    "The current invoice obligation has no executable priced line set.",
  );
});

Deno.test("invoice and SEND IT execution reserve current approval in SQL", () => {
  assertStringIncludes(ACTIONS, 'client.rpc("begin_ses_invoice_execution_v1"');
  assertStringIncludes(ACTIONS, 'client.rpc("begin_ses_release_execution_v1"');
});

Deno.test("one cockpit query returns the exact composite release being approved", () => {
  assertStringIncludes(INDEX, "body.release_revision_id");
  assertStringIncludes(ACTIONS, "release_revision: {");
  assertStringIncludes(
    ACTIONS,
    "readiness_bindings: release.readiness_bindings",
  );
  assertStringIncludes(
    ACTIONS,
    "The displayed composite release does not contain this job and the exact email routes.",
  );
});

Deno.test("dispatch and reconciliation both persist the exact Xero mirror", () => {
  assertStringIncludes(ACTIONS, "async function persistSesInvoiceMirror");
  assertStringIncludes(
    ACTIONS,
    "invoice_obligation_revision_id: args.invoice_obligation_revision_id",
  );
  assertStringIncludes(ACTIONS, "ses_external_token: args.external_token");
  assertStringIncludes(
    ACTIONS,
    "The exact Xero invoice exists, but its job, obligation revision, and SES token mirror could not be stored",
  );
  assertEquals(
    (ACTIONS.match(/await persistSesInvoiceMirror\(client, \{/g) || []).length,
    2,
    "the execute path persists the mirror on dispatch and on reconciliation",
  );
  assertStringIncludes(
    ACTIONS,
    "async function bindSesDraftInvoiceToRevision",
  );
  assertStringIncludes(ACTIONS, "await persistSesInvoiceMirror(client, args);");
  assertEquals(
    (ACTIONS.match(/await bindSesDraftInvoiceToRevision\(client, \{/g) || [])
      .length,
    1,
    "draft mint and idempotent reconciliation share one binding path",
  );
});
