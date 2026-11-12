// Restoration document send (owner, 12 Nov 2026).
//
// A restoration card's invoice and quote go to the builder's restoration
// contact (makesafe_companies.restoration_recipients, today ML Builders'
// restoration coordinator), not through the make-safe release graph, which
// only knows the make-safe billing mailbox and the Prime mailer. The report and
// photos already reach that contact through send_mailer_ops_visibility; this
// route carries the two documents that route must never carry.
//
// One named document per call:
//   - kind "invoice": a Xero ACCREC invoice on THIS job that Xero already holds
//     as AUTHORISED or PAID (a DRAFT cannot be paid and is refused). The bytes
//     are the Xero-rendered PDF, fetched at send time.
//   - kind "quote": the card's restoration quote document (job_documents type
//     'other', metadata.restoration_document = 'quote'), its stored PDF.
// Restoration cards only. `to` is required and must be one of the builder's
// restoration_recipients; ses@ is always copied. Sent from admin@ by ordinary
// Mail.Send with the SES operation header, proved in Sent Items, exact-once per
// attempt in the ses_external_effects ledger (effect_kind restoration_send).
// dry_run defaults to true. It never mints, authorises, changes or voids money.

import {
  buildSesEffect,
  executeSesExternalEffect,
  type SesExternalAdapter,
  type SesExternalEffectStore,
} from "./ses_external_effects.ts";
import { sesSha256, sesSha256Bytes } from "./ses_docket_envelope.ts";
import {
  SES_OPERATION_HEADER,
  SES_RELEASE_CC,
  SES_RELEASE_MAILBOX,
  type SesMailGateway,
  type SesRouteAttachment,
  type SesRouteSendResult,
} from "./ses_graph_mail_gateway.ts";
import { isRestorationCardForMailer } from "./ses_mailer_ops_send.ts";
import { isRestorationQuoteDocument } from "./restoration_workflow_store.ts";
import { type SesActionAuth, SesActionError } from "./ses_reporting_actions.ts";
import type { SesRefusal } from "./ses_reporting_refusals.ts";

export const RESTORATION_SEND_CONTRACT_VERSION = "restoration-document-send/v1";
export const RESTORATION_SEND_FROM = SES_RELEASE_MAILBOX;
export const RESTORATION_SEND_CC = SES_RELEASE_CC;

export type RestorationSendKind = "invoice" | "quote";

export function isRestorationSendKind(value: unknown): value is RestorationSendKind {
  return value === "invoice" || value === "quote";
}

const SENDABLE_INVOICE_STATUSES = new Set(["AUTHORISED", "PAID"]);

function refusal(
  code: string,
  fact: string,
  extra: { recovery_action?: string; evidence?: Record<string, unknown> } = {},
): SesRefusal {
  return {
    state: "refused",
    code,
    fact,
    recovery_action: extra.recovery_action || "Resolve the refusal and retry.",
    ...(extra.evidence ? { evidence: extra.evidence } : {}),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normaliseRestorationRecipients(values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const address = text(value).toLowerCase();
    if (address && address.includes("@") && !out.includes(address)) out.push(address);
  }
  return out;
}

/** The named `to` must be one of the builder's restoration contacts. */
export function resolveRestorationRecipient(
  requestedTo: unknown,
  allowed: string[],
): string {
  const to = text(requestedTo).toLowerCase();
  if (!to) {
    throw new SesActionError(
      400,
      refusal(
        "restoration_send_to_required",
        "Name the recipient (to). It must be one of the builder's restoration contacts.",
        { evidence: { allowed } },
      ),
    );
  }
  if (!allowed.includes(to)) {
    throw new SesActionError(
      409,
      refusal(
        "restoration_send_to_not_allowed",
        `${to} is not one of this builder's restoration contacts.`,
        {
          recovery_action:
            "Add the address to makesafe_companies.restoration_recipients for this builder, or name a listed contact.",
          evidence: { allowed },
        },
      ),
    );
  }
  return to;
}

/** A Xero invoice may go only when it is this job's, a sales invoice, and payable. */
export function assertRestorationInvoiceSendable(
  row: Record<string, unknown> | null,
  jobId: string,
): void {
  if (!row) {
    throw new SesActionError(
      404,
      refusal("restoration_send_invoice_missing", "That invoice is not in our Xero copy."),
    );
  }
  if (text(row.job_id) !== jobId) {
    throw new SesActionError(
      409,
      refusal(
        "restoration_send_invoice_other_job",
        "That invoice is not linked to this job.",
        { evidence: { invoice_job_id: row.job_id || null, job_id: jobId } },
      ),
    );
  }
  if (text(row.invoice_type).toUpperCase() !== "ACCREC") {
    throw new SesActionError(
      409,
      refusal("restoration_send_invoice_not_sales", "Only a sales invoice (ACCREC) can be sent."),
    );
  }
  const status = text(row.status).toUpperCase();
  if (!SENDABLE_INVOICE_STATUSES.has(status)) {
    throw new SesActionError(
      409,
      refusal(
        "restoration_send_invoice_not_authorised",
        `The invoice is ${status || "of unknown status"} in Xero. Only an AUTHORISED or PAID invoice is sent; approve it first.`,
        { evidence: { status } },
      ),
    );
  }
}

export function restorationSendSubject(args: {
  kind: RestorationSendKind;
  documentLabel: string;
  builderRef: string;
  site: string;
  jobNumber: string;
}): string {
  const lead = args.kind === "invoice"
    ? `Tax invoice ${args.documentLabel}`
    : `Quote ${args.documentLabel}`;
  return [lead, args.builderRef, args.site || args.jobNumber]
    .filter((part) => text(part))
    .join(" | ");
}

export function restorationSendBody(args: {
  kind: RestorationSendKind;
  documentLabel: string;
  builderRef: string;
  site: string;
  note?: string | null;
}): string {
  const where = [args.builderRef, args.site].filter((p) => text(p)).join(", ");
  const opening = args.kind === "invoice"
    ? `Please find attached our tax invoice ${args.documentLabel}${where ? ` for ${where}` : ""}.`
    : `Please find attached our quote ${args.documentLabel}${where ? ` for ${where}` : ""}. Please let us know if you would like us to proceed.`;
  const note = text(args.note);
  return [`Hi,`, opening, note, `Thank you.`].filter(Boolean).join("\n\n");
}

export async function restorationSendAttemptHash(input: {
  kind: RestorationSendKind;
  document_id: string;
  to: string;
  cc: readonly string[];
  attempt_key?: string | null;
}): Promise<string> {
  return await sesSha256({
    contract_version: RESTORATION_SEND_CONTRACT_VERSION,
    kind: input.kind,
    document_id: input.document_id,
    to: input.to,
    cc: [...input.cc],
    attempt_key: text(input.attempt_key) || null,
  }, "SecureWorks:restoration-send-attempt:v1\n");
}

export interface SendRestorationDocumentArgs {
  org_id?: string;
  job_id: string;
  kind: unknown;
  to?: unknown;
  xero_invoice_id?: unknown;
  job_document_id?: unknown;
  note?: unknown;
  attempt_key?: unknown;
  dry_run?: unknown;
  actor?: string;
}

export interface SendRestorationDocumentDeps {
  makeMailGateway: (
    loadAttachments: (hashes: string[]) => Promise<SesRouteAttachment[]>,
  ) => Pick<SesMailGateway, "createDraftAndSend" | "reconcileSent">;
  effectStore: SesExternalEffectStore;
  /** Xero-rendered PDF bytes for one invoice. */
  fetchInvoicePdf: (xeroInvoiceId: string) => Promise<Uint8Array>;
  /** Bytes of a stored document (public or signed URL). */
  fetchDocumentBytes: (url: string) => Promise<Uint8Array>;
}

export async function sendRestorationDocumentAction(
  client: any,
  auth: SesActionAuth,
  args: SendRestorationDocumentArgs,
  deps: SendRestorationDocumentDeps,
): Promise<Record<string, unknown>> {
  if (auth.mode === "routine") {
    throw new SesActionError(
      403,
      refusal("restoration_send_privileged_only", "A routine may never send a restoration document."),
    );
  }
  if (auth.mode === "jwt") {
    const role = text(auth.user?.role).toLowerCase();
    if (role !== "admin" && role !== "owner") {
      throw new SesActionError(
        403,
        refusal("restoration_send_privileged_only", "Sending a restoration document needs an admin or owner session."),
      );
    }
  }
  const jobId = text(args.job_id);
  if (!jobId) {
    throw new SesActionError(400, refusal("restoration_send_job_required", "job_id is required."));
  }
  if (!isRestorationSendKind(args.kind)) {
    throw new SesActionError(
      400,
      refusal("restoration_send_kind_invalid", "kind must be 'invoice' or 'quote'.", {
        evidence: { received: args.kind ?? null },
      }),
    );
  }
  const kind: RestorationSendKind = args.kind;
  const dryRun = args.dry_run !== false;
  const actor = text(args.actor) || auth.user?.email || "restoration-send-operator";

  const jobRes = await client.from("jobs")
    .select("id,org_id,type,job_number,status,metadata,site_address,site_suburb")
    .eq("id", jobId)
    .maybeSingle();
  if (jobRes.error || !jobRes.data) {
    throw new SesActionError(
      404,
      refusal("restoration_send_job_missing", `Job not found (${jobRes.error?.message || "no row"}).`),
    );
  }
  const job = jobRes.data;
  if (!isRestorationCardForMailer(job)) {
    throw new SesActionError(
      409,
      refusal(
        "restoration_send_not_restoration",
        "This route sends only a restoration card's invoice or quote. Make-safe packs go through SEND IT.",
      ),
    );
  }

  const detailRes = await client.from("makesafe_job_details")
    .select("job_id,requesting_company_id,requesting_company_slug,external_ref")
    .eq("job_id", jobId)
    .maybeSingle();
  if (detailRes.error) {
    throw new SesActionError(
      503,
      refusal("restoration_send_detail_unreadable", `Job detail could not be read (${detailRes.error.message}).`),
    );
  }
  const detail = detailRes.data || {};
  const companies: Array<Record<string, unknown>> = [];
  for (const [column, value] of [
    ["id", text(detail.requesting_company_id)],
    ["slug", text(detail.requesting_company_slug) || text(object(job.metadata).requesting_company_slug)],
  ] as const) {
    if (!value) continue;
    const res = await client.from("makesafe_companies")
      .select("id,slug,name,restoration_recipients")
      .eq(column, value)
      .maybeSingle();
    if (res.error) {
      throw new SesActionError(
        503,
        refusal("restoration_send_company_unreadable", `Builder lookup by ${column} failed (${res.error.message}).`),
      );
    }
    if (res.data) companies.push(res.data);
  }
  const allowed = normaliseRestorationRecipients(
    companies.flatMap((row) => Array.isArray(row.restoration_recipients) ? row.restoration_recipients : []),
  );
  const to = resolveRestorationRecipient(args.to, allowed);
  const cc = [RESTORATION_SEND_CC] as const;

  // ── The one named document ──────────────────────────────────────────────
  let documentId = "";
  let documentLabel = "";
  let fileName = "";
  let loadBytes: () => Promise<Uint8Array>;
  let documentEvidence: Record<string, unknown> = {};
  if (kind === "invoice") {
    documentId = text(args.xero_invoice_id);
    if (!documentId) {
      throw new SesActionError(
        400,
        refusal("restoration_send_invoice_required", "Name the invoice (xero_invoice_id)."),
      );
    }
    const invRes = await client.from("xero_invoices")
      .select("xero_invoice_id,invoice_number,invoice_type,status,total,amount_due,reference,job_id")
      .eq("xero_invoice_id", documentId)
      .maybeSingle();
    if (invRes.error) {
      throw new SesActionError(
        503,
        refusal("restoration_send_invoice_unreadable", `The invoice could not be read (${invRes.error.message}).`),
      );
    }
    assertRestorationInvoiceSendable(invRes.data, jobId);
    documentLabel = text(invRes.data.invoice_number) || documentId;
    fileName = `${documentLabel}.pdf`;
    documentEvidence = {
      xero_invoice_id: documentId,
      invoice_number: invRes.data.invoice_number || null,
      status: text(invRes.data.status).toUpperCase(),
      total: invRes.data.total ?? null,
      amount_due: invRes.data.amount_due ?? null,
      reference: invRes.data.reference || null,
    };
    loadBytes = () => deps.fetchInvoicePdf(documentId);
  } else {
    let docRow: Record<string, unknown> | null = null;
    const requested = text(args.job_document_id);
    const docQuery = client.from("job_documents")
      .select("id,job_id,type,file_name,pdf_url,storage_url,metadata,created_at")
      .eq("job_id", jobId);
    const docRes = requested
      ? await docQuery.eq("id", requested).maybeSingle()
      : await docQuery.eq("type", "other").order("created_at", { ascending: false }).limit(20);
    if (docRes.error) {
      throw new SesActionError(
        503,
        refusal("restoration_send_quote_unreadable", `The quote document could not be read (${docRes.error.message}).`),
      );
    }
    if (requested) {
      docRow = docRes.data || null;
    } else {
      docRow = (Array.isArray(docRes.data) ? docRes.data : [])
        .find((row: unknown) => isRestorationQuoteDocument(row)) || null;
    }
    if (!docRow || !isRestorationQuoteDocument(docRow) || text(docRow.job_id) !== jobId) {
      throw new SesActionError(
        404,
        refusal(
          "restoration_send_quote_missing",
          "No restoration quote document on this job matches. Save the quote first (restoration_save_quote).",
        ),
      );
    }
    documentId = text(docRow.id);
    const meta = object(docRow.metadata);
    documentLabel = text(meta.quote_number) || text(meta.restoration_quote_number) ||
      text(docRow.file_name).replace(/\.pdf$/i, "");
    fileName = text(docRow.file_name) || `${documentLabel}.pdf`;
    const url = text(docRow.pdf_url) || text(docRow.storage_url);
    if (!/^https:\/\//i.test(url)) {
      throw new SesActionError(
        409,
        refusal("restoration_send_quote_no_file", "The quote document has no stored PDF to send."),
      );
    }
    documentEvidence = { job_document_id: documentId, file_name: fileName, url };
    loadBytes = () => deps.fetchDocumentBytes(url);
  }

  const builderRef = text(detail.external_ref);
  const site = [text(job.site_address), text(job.site_suburb)]
    .filter(Boolean)
    .filter((part, index, all) => index === 0 || !all[0].toLowerCase().includes(part.toLowerCase()))
    .join(", ");
  const subject = restorationSendSubject({
    kind,
    documentLabel,
    builderRef,
    site,
    jobNumber: text(job.job_number),
  });
  const body = restorationSendBody({ kind, documentLabel, builderRef, site, note: text(args.note) || null });
  const attemptKey = text(args.attempt_key) || null;
  const attemptHash = await restorationSendAttemptHash({
    kind,
    document_id: documentId,
    to,
    cc,
    attempt_key: attemptKey,
  });

  // Bytes are read up front so a dry run proves the document can be sent.
  const bytes = await loadBytes();
  if (!bytes || bytes.byteLength < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new SesActionError(
      409,
      refusal("restoration_send_not_pdf", "The document bytes are not a PDF; nothing was sent."),
    );
  }
  const contentHash = await sesSha256Bytes(bytes);
  const attachment: SesRouteAttachment = {
    name: fileName,
    contentType: "application/pdf",
    bytes,
  } as SesRouteAttachment;

  const routePayload = {
    route_kind: kind,
    recipients: [to],
    cc: [...cc],
    subject,
    body,
    attachment_hashes: [contentHash],
    requires_thread_reply: false,
    reply_to_thread_id: null,
    restoration_send: true,
    contract_version: RESTORATION_SEND_CONTRACT_VERSION,
  };
  const effectPayload = {
    contract_version: RESTORATION_SEND_CONTRACT_VERSION,
    job_id: jobId,
    job_number: text(job.job_number) || null,
    kind,
    from: RESTORATION_SEND_FROM,
    to: [to],
    cc: [...cc],
    subject,
    document: documentEvidence,
    attachment_hash: contentHash,
    attachment_name: fileName,
    attempt_key: attemptKey,
    attempt_hash: attemptHash,
  };
  const effect = await buildSesEffect({
    org_id: text(args.org_id) || text(job.org_id) || "00000000-0000-0000-0000-000000000001",
    job_id: jobId,
    effect_kind: "restoration_send",
    artifact_hash: attemptHash,
    payload: effectPayload,
  });

  const summary = {
    contract_version: RESTORATION_SEND_CONTRACT_VERSION,
    job_id: jobId,
    job_number: text(job.job_number) || null,
    kind,
    from: RESTORATION_SEND_FROM,
    to: [to],
    cc: [...cc],
    subject,
    body,
    document: documentEvidence,
    attachment: { name: fileName, content_hash: contentHash, size_bytes: bytes.byteLength },
    attempt_key: attemptKey,
  };
  if (dryRun) {
    return {
      success: true,
      dry_run: true,
      ...summary,
      effect_preview: { operation_key: effect.operation_key, effect_kind: effect.effect_kind },
      note: "dry_run: nothing was sent. Pass dry_run:false to send.",
    };
  }

  const mailGateway = deps.makeMailGateway(async (hashes) => {
    if (hashes.length !== 1 || hashes[0] !== contentHash) {
      throw new Error("Restoration send attachment bytes missing for the requested hash");
    }
    return [attachment];
  });
  const adapter: SesExternalAdapter<typeof routePayload, SesRouteSendResult> = {
    dispatch: (payload, context) => mailGateway.createDraftAndSend(payload, context),
    reconcile: (context) => mailGateway.reconcileSent(context.external_token, undefined, context),
    identify: (result) => result.message_id,
    digest: (result) => ({
      message_id: result.message_id,
      internet_message_id: result.internet_message_id || null,
      operation_token: result.operation_token,
      to: [to],
      cc: [...cc],
      operation_header: SES_OPERATION_HEADER,
      proof_surfaces: ["admin_sent_items", "ses_intake_cc"],
    }),
  };
  const sent = await executeSesExternalEffect({
    store: deps.effectStore,
    effect,
    payload: routePayload,
    adapter,
    actor,
  });
  if (sent.state !== "confirmed") {
    const failure = sent.refusal!;
    throw new SesActionError(409, {
      ...failure,
      evidence: {
        ...(failure.evidence || {}),
        effect_state: sent.effect.state,
        external_token: effect.external_token,
        job_id: jobId,
        attempt_key: attemptKey,
        retry_instruction:
          "Reconcile this token first. To retry deliberately, call again with a new attempt_key; never redispatch this token.",
      },
    });
  }
  const proof = {
    message_id: text(sent.effect.external_id) || text(sent.result?.message_id) || null,
    operation_token: effect.external_token,
    operation_header: SES_OPERATION_HEADER,
    provider_digest: object(sent.effect.provider_digest),
  };
  try {
    const audit = await client.from("job_events").insert({
      job_id: jobId,
      event_type: sent.dispatched ? "restoration_document_sent" : "restoration_document_send_reconciled",
      detail_json: { ...summary, actor, proof },
    });
    if (audit?.error) console.warn("[restoration-send] job_events insert failed:", audit.error.message);
  } catch (err) {
    console.warn("[restoration-send] job_events insert failed:", (err as Error).message);
  }
  return {
    success: true,
    dry_run: false,
    already_sent: !sent.dispatched,
    ...summary,
    proof,
  };
}
