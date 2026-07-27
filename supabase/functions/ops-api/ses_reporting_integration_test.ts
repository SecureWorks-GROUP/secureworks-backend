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

Deno.test("legacy invoice sends hit the sealed SES U6R gate before provider effects", () => {
  const sendStart = INDEX.indexOf("case 'send_invoice_email'");
  const sendGate = INDEX.indexOf(
    "assertLegacySesInvoiceSendAllowed(client, siId, 'send_invoice_email')",
    sendStart,
  );
  const sendProvider = INDEX.indexOf("xeroPost(`/Invoices/${siId}/Email`", sendStart);
  assert(sendGate > sendStart && sendGate < sendProvider);

  const approveStart = INDEX.indexOf("case 'approve_and_send_invoice'");
  const approveGate = INDEX.indexOf(
    "assertLegacySesInvoiceSendAllowed(client, asId, 'approve_and_send_invoice')",
    approveStart,
  );
  const approveProvider = INDEX.indexOf("xeroPost(`/Invoices/${asId}`", approveStart);
  assert(approveGate > approveStart && approveGate < approveProvider);
  assertStringIncludes(INDEX, "code: 'u6r_release_required'");
  assertStringIncludes(INDEX, "execute_ses_release_revision");
});

Deno.test("routine allowlist exposes only SES prepare and read actions", () => {
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
    "This make-safe has a sealed U4 docket but no current human APPROVE INVOICE decision",
  );
});

Deno.test("Graph sends the checkpointed draft by id and never uses sendMail", () => {
  assertStringIncludes(
    INDEX,
    "/messages/${encodeURIComponent(message.id)}/send",
  );
  assertStringIncludes(INDEX, "phase: 'draft_created'");
  assert(
    !INDEX.slice(
      INDEX.indexOf("function makeSesGraphMailGateway"),
      INDEX.indexOf("function opsApiVersion"),
    ).includes("/sendMail"),
    "sealed SES route adapter must not use bare sendMail",
  );
});

Deno.test("external effects reconcile the exact provider token before dispatch", () => {
  const transition = EFFECTS.indexOf('"dispatching",');
  const reconcile = EFFECTS.indexOf("preDispatchMatches", transition);
  const dispatch = EFFECTS.indexOf("args.adapter.dispatch", transition);
  assert(transition >= 0 && reconcile > transition && dispatch > reconcile);
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
    "The displayed composite release does not contain this job and all three exact email routes.",
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
    (ACTIONS.match(/await persistSesInvoiceMirror\(client,/g) || []).length,
    2,
  );
});
