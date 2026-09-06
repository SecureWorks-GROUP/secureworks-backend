// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const SEND_QUOTE = await Deno.readTextFile(
  new URL("../send-quote/index.ts", import.meta.url),
);
const INVOICE_DELIVERY_FENCE = await Deno.readTextFile(
  new URL("../send-quote/invoice_delivery_fence.ts", import.meta.url),
);
const SEND_INVOICE_ACCESS = await Deno.readTextFile(
  new URL("../send-quote/send_invoice_access.ts", import.meta.url),
);
const OUTLOOK = await Deno.readTextFile(
  new URL("../send-outlook-email/index.ts", import.meta.url),
);
const FENCE = await Deno.readTextFile(
  new URL("../_shared/sealed_ses_money_fence.ts", import.meta.url),
);
const MIGRATION = await Deno.readTextFile(
  new URL(
    "../../migrations/20260728050000_makesafe_ses_fence_hardening.sql",
    import.meta.url,
  ),
);
const ACTION_MANIFEST = await Deno.readTextFile(
  new URL("../../../scripts/_ops-api-required-actions.txt", import.meta.url),
);
const SCHEMA_MANIFEST = await Deno.readTextFile(
  new URL(
    "../../../scripts/edge-function-schema-requirements.txt",
    import.meta.url,
  ),
);

function before(
  source: string,
  startText: string,
  guardText: string,
  effectText: string,
) {
  const start = source.indexOf(startText);
  const guard = source.indexOf(guardText, start);
  const effect = source.indexOf(effectText, start);
  assert(
    start >= 0 && guard > start && effect > guard,
    `${startText} must call ${guardText} before ${effectText}`,
  );
}

Deno.test("every wave-2 outbound action fences the authoritative job before effects", () => {
  for (
    const [start, effect] of [
      ["async function sendWorkOrder(", ".update({ status: 'sent'"],
      ["async function sendReviewRequest(", "functions/v1/ghl-proxy"],
      ["async function sendCouncilEmail(", "https://api.resend.com/emails"],
      ["async function sendCouncilSMS(", "functions/v1/ghl-proxy"],
      ["async function sendVariation(", "https://api.resend.com/emails"],
      ["async function sendQuickQuoteEmail(", "https://api.resend.com/emails"],
      ["async function sendProposedSms(", "functions/v1/ghl-proxy"],
      ["async function editAndSend(", ".update({ drafted_message: trimmed })"],
      ["async function sendQuoteFollowupSms(", "status: 'approved'"],
      ["async function sendCommsMessageAction(", "conversations/messages"],
      ["async function sendOpsNoteToTrade(", ".from('job_media').insert"],
    ]
  ) {
    before(
      INDEX,
      start,
      "assertLegacySesMoneyActionAllowedForJob(",
      effect,
    );
  }
});

Deno.test("chase workflow actions fence supplied identity before GHL effects", () => {
  for (
    const [start, effect] of [
      ["async function sendChaseSms(", "functions/v1/ghl-proxy"],
      ["async function triggerChaseWorkflow(", "?action=add_contact_tag"],
      ["async function stopChaseWorkflow(", "?action=remove_contact_tag"],
    ]
  ) {
    before(
      INDEX,
      start,
      "assertLegacySesInvoiceOrJobActionAllowed(",
      effect,
    );
    before(
      INDEX,
      start,
      "assertGhlContactMatchesResolvedJob(",
      effect,
    );
  }
  assertStringIncludes(FENCE, "invoice_link_required");
  assertStringIncludes(
    INDEX,
    "stopChaseWorkflow(client, {",
  );
  assertStringIncludes(INDEX, "xero_invoice_id,");
});

// Captain's ruling, 2026-08-02: reading an invoice PDF is exempt from the
// sealed-SES money wall. The gate still runs first — only its sealed refusal is
// lifted, and only for an operator caller the SERVER resolved.
Deno.test("the invoice PDF read exemption is declared in the fence and keyed to server-resolved identity", () => {
  // The fence module is the single authority on what is exempt, and the set is
  // exactly one read action.
  assertStringIncludes(FENCE, "SEALED_SES_MONEY_READ_EXEMPT_ACTIONS");
  assertStringIncludes(FENCE, "sealedSesMoneyReadExemptionApplies");
  const setStart = FENCE.indexOf("SEALED_SES_MONEY_READ_EXEMPT_ACTIONS");
  const setEnd = FENCE.indexOf(");", setStart);
  assert(setStart >= 0 && setEnd > setStart);
  const declared = FENCE.slice(setStart, setEnd);
  assertStringIncludes(declared, '"get_invoice_pdf"');
  for (
    const forbidden of [
      "void_invoice",
      "send_invoice_email",
      "update_invoice",
      "approve_invoice",
      "create_invoice",
      "update_invoice_job_link",
    ]
  ) {
    assert(
      !declared.includes(forbidden),
      `${forbidden} must never be read-exempt`,
    );
  }

  // The route supplies the caller from the resolved auth mode and the profile
  // role, never from request parameters.
  const routeStart = INDEX.indexOf("case 'get_invoice_pdf': return json(");
  assert(routeStart >= 0);
  const route = INDEX.slice(routeStart, routeStart + 400);
  assertStringIncludes(route, "mode: authMode");
  assertStringIncludes(route, "role: authUser?.role");

  // And the automation routine cannot reach the action at all.
  const routineStart = INDEX.indexOf(
    "const ROUTINE_ALLOWED_ACTIONS = new Set([",
  );
  const routineEnd = INDEX.indexOf("])", routineStart);
  assert(routineStart >= 0 && routineEnd > routineStart);
  assert(
    !INDEX.slice(routineStart, routineEnd).includes("get_invoice_pdf"),
    "get_invoice_pdf must stay off the routine allow-list",
  );
});

Deno.test("invoice PDF and branded delivery bind to the invoice mirror", () => {
  before(
    INDEX,
    "async function getInvoicePdf(",
    "assertLegacySesInvoiceActionAllowed(",
    "await getToken(client)",
  );
  const sendInvoice = SEND_QUOTE.indexOf(
    "if (path === 'send-invoice'",
  );
  const authorize = SEND_QUOTE.indexOf(
    "authorizeSendInvoiceAccess(",
    sendInvoice,
  );
  const invoiceLookup = SEND_QUOTE.indexOf(
    ".from('xero_invoices')",
    sendInvoice,
  );
  const jobFence = SEND_QUOTE.indexOf(
    "inspectSealedSesJob(sb, linkedJobId)",
    invoiceLookup,
  );
  const provider = SEND_QUOTE.indexOf(
    "https://api.resend.com/emails",
    sendInvoice,
  );
  assert(
    sendInvoice >= 0 && authorize > sendInvoice &&
      invoiceLookup > authorize && jobFence > invoiceLookup &&
      provider > jobFence,
  );
  assertStringIncludes(FENCE, "invoice_link_required");
  assertStringIncludes(
    INVOICE_DELIVERY_FENCE,
    "invoiceRecord.job_id !== callerJobId",
  );
  const tenantStep = SEND_INVOICE_ACCESS.indexOf("steps.push('tenant')");
  const bindingStep = SEND_INVOICE_ACCESS.indexOf("steps.push('binding')");
  const sealedStep = SEND_INVOICE_ACCESS.indexOf("steps.push('sealed')");
  const bindingCall = SEND_INVOICE_ACCESS.indexOf(
    "validateBrandedInvoiceDeliveryBinding(",
  );
  const inspectCall = SEND_INVOICE_ACCESS.indexOf(
    "input.deps.inspectSealedJob(linkedJobId)",
  );
  assert(
    tenantStep >= 0 && bindingStep > tenantStep &&
      sealedStep > bindingStep && bindingCall > bindingStep &&
      inspectCall > sealedStep,
  );
});

Deno.test("generic Outlook delivery refuses unproven PDF provenance before Graph", () => {
  const handler = OUTLOOK.indexOf("serve(async (req: Request)");
  const guard = OUTLOOK.indexOf("assertOutlookSesDeliveryAllowed(", handler);
  const forward = OUTLOOK.indexOf("handleForward(body", handler);
  const sendMail = OUTLOOK.indexOf("/sendMail", handler);
  assert(
    handler >= 0 && guard > handler && forward > guard && sendMail > guard,
  );
  assertStringIncludes(OUTLOOK, "pdf_provenance_required");
  assertStringIncludes(OUTLOOK, "xero_invoice_id");
  assertStringIncludes(OUTLOOK, "job_document_id");
});

Deno.test("write-once seal and SES-native void authority are migration-backed", () => {
  for (
    const marker of [
      "ses_money_sealed_at",
      "refuses any clear or mutation",
      "makesafe_invoice_void_revisions",
      "makesafe_invoice_void_approvals",
      "commit_ses_invoice_void_revision_v1",
      "approve_ses_invoice_void_revision_v1",
      "begin_ses_invoice_void_execution_v1",
      "confirm_ses_invoice_void_execution_v1",
      "'invoice_void'",
    ]
  ) {
    assertStringIncludes(MIGRATION, marker);
  }
  for (
    const action of [
      "prepare_ses_invoice_void_revision",
      "approve_ses_invoice_void_revision",
      "execute_ses_invoice_void_revision",
    ]
  ) {
    assertStringIncludes(INDEX, `case '${action}'`);
    assertStringIncludes(ACTION_MANIFEST, `${action} # probe=source-only`);
  }
  for (
    const fn of [
      "ops-api",
      "send-quote",
      "send-outlook-email",
      "reporting-api",
      "xero-sync",
    ]
  ) {
    assertStringIncludes(
      SCHEMA_MANIFEST,
      `${fn}|supabase/migrations/20260728050000_makesafe_ses_fence_hardening.sql|column|jobs.ses_money_sealed_at`,
    );
  }
});

Deno.test("confirmed void retry re-proves the current ACCREC mirror", () => {
  const confirmation = MIGRATION.slice(
    MIGRATION.indexOf(
      "CREATE OR REPLACE FUNCTION public.confirm_ses_invoice_void_execution_v1",
    ),
  );
  const confirmedBranch = confirmation.slice(
    confirmation.indexOf("IF target.state = 'confirmed' THEN"),
    confirmation.indexOf("UPDATE public.xero_invoices"),
  );
  assertStringIncludes(confirmedBranch, "org_id = target.org_id");
  assertStringIncludes(
    confirmedBranch,
    "xero_invoice_id = target.xero_invoice_id",
  );
  assertStringIncludes(confirmedBranch, "job_id = target.job_id");
  assertStringIncludes(confirmedBranch, "job_id IS NOT NULL");
  assertStringIncludes(confirmedBranch, "invoice_type = 'ACCREC'");
  assertStringIncludes(confirmedBranch, "status = target.target_status");
  assertStringIncludes(confirmedBranch, "USING ERRCODE = '40001'");
});
