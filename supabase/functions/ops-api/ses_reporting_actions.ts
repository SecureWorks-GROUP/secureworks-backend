// deno-lint-ignore-file no-explicit-any
import {
  fetchAllAccrecInvoices,
  MAKESAFE_CC,
  normRef,
  resolveExistingInvoice,
  splitEmails,
} from "./makesafe_send_pack.ts";
import {
  prepareSesInvoiceObligation,
  SES_PRICING_CANON_VERSION,
  type SesInvoiceProposalV1,
  type SesPricingDisposition,
} from "./makesafe_invoice_obligation.ts";
import {
  buildCommercialQuantityOverrideLines,
  SesCommercialQuantityOverrideError,
} from "./ses_commercial_quantity_override.ts";
import {
  resolveSesInvoiceDuplicates,
  type SesInvoiceDuplicateRequest,
  type SesInvoiceIndexRow,
} from "./makesafe_invoice_duplicate_resolver.ts";
import {
  buildSesEffect,
  executeSesExternalEffect,
  type SesEffectClaim,
  type SesExternalAdapter,
  type SesExternalEffect,
  type SesExternalEffectStore,
} from "./ses_external_effects.ts";
import {
  assertSesRouteRecipients,
  buildSesCockpitView,
  buildSesReleaseRevision,
  canRecordSesApproval,
  classifySesReleaseSendProgress,
  evaluateSesMechanicalClean,
  SES_ROUTE_ORDER,
  type SesApprovalAuth,
  type SesCleanInput,
  type SesCockpitDocket,
  type SesReviewRoute,
} from "./ses_review_cockpit.ts";
import { presentSesPackHonesty } from "./ses_pack_presentation.ts";
import {
  ajsPackCc,
  ajsPackRecipients,
  isAjsBuilderKey,
  mlbPhysicalRouteRecipients,
  mlbPrimeMailerRouteCarriesInvoice,
  sesReleaseRouteOrder,
} from "./ses_release_route_shape.ts";
import {
  applyMlbThreadReplyToRoute,
  isMlbPhysicalReleaseShape,
  mlbOrdinaryMailSendEffectPayloadFields,
  mlbPhysicalUsesOrdinaryMailSendFallback,
  routingIntakeThread,
} from "./ses_mlb_thread_reply.ts";
import {
  sesSha256,
  sesSha256Bytes,
  stableUuidFromSha256,
} from "./ses_docket_envelope.ts";
import {
  inspectSesSupportingReportProof,
  rawSesSupportingReportSha,
  SES_CURATED_SOURCE_BIND_EVENT_TYPE,
  SES_CURATED_SOURCE_SUPERSEDED_REASON,
  SES_CURATED_SOURCE_SUPERSESSION_UNREADABLE_REASON,
  SES_SUPPORTING_REPORT_MAX_BYTES,
  type SesCuratedSourceSupersession,
  sesCuratedSourceSupersessionsFromEvents,
  sesSupportingReportDocumentBinding,
  sesSupportingReportIsSuperseded,
  type SesSupportingReportTrust,
} from "./ses_supporting_report_trust.ts";
export { inspectSesSupportingReportProof } from "./ses_supporting_report_trust.ts";
import {
  canManageSesDocsReadySignoff,
  nextSesDocsReadyState,
} from "./ses_docs_ready.ts";
import { SES_DOCKET_BUCKET } from "./ses_docket_persistence.ts";
import {
  isSesRefusal,
  type SesRefusal,
  sesRefusal,
} from "./ses_reporting_refusals.ts";
import {
  evaluateSesPhotoMailVolume,
  resolveSesMailTransport,
  sesPhotoMailVolumeRefusal,
} from "./ses_photo_mail_volume_guard.ts";

interface SupabaseResponse<T> {
  data: T | null;
  error: { message?: string } | null;
}

export interface SesSupabaseClient {
  from(table: string): any;
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<SupabaseResponse<any>>;
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        bytes: Uint8Array,
        options: { contentType: string; upsert: boolean },
      ): Promise<SupabaseResponse<any>>;
      createSignedUrl(
        path: string,
        expiresIn: number,
      ): Promise<SupabaseResponse<{ signedUrl: string }>>;
      download(path: string): Promise<SupabaseResponse<Blob>>;
    };
  };
}

export interface SesActionAuth {
  mode: "api_key" | "jwt" | "routine";
  user: {
    id: string;
    email: string;
    role: string;
  } | null;
}

export class SesActionError extends Error {
  constructor(
    public status: number,
    public refusal: SesRefusal | { state: "refused"; fact: string },
  ) {
    super(refusal.fact);
  }
}

/** Human label for a typed docket artifact role; storage object keys are not UI. */
export function sesReviewArtifactDisplayLabel(role: unknown): string | null {
  return String(role || "") === "source_attachment" ? "Works Order" : null;
}

function requireValue(
  response: SupabaseResponse<any>,
  fact: string,
): any {
  if (response.error || !response.data) {
    throw new SesActionError(409, {
      state: "refused",
      fact: `${fact} ${
        response.error?.message ? `(${response.error.message})` : ""
      }`.trim(),
    });
  }
  return response.data;
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

export const SES_CURATED_SOURCE_RECOVERY_ACTION =
  "POST ops-api?action=bind_current_cycle_curated_makesafe_report with job_id, document_id, pdf_base64, pdf_sha256 (sha256:<64 lowercase hex>), report_job (photo content_sha256 same format), curation_revision_id, and curation_artifact_id; server derives current attendance cycle, renderer provenance, artifact content hash and report_input_hash, then establishes cycle attribution. Then prepare_ses_docket_revision (dry_run or draft only).";

/**
 * Curated-bind supersessions recorded on ONE job. `null` means the audit trail
 * could not be read, which every caller must treat as untrusted rather than as
 * "no supersession" - a superseded report is the one thing that must never
 * reach a builder.
 */
async function loadSesCuratedSourceSupersessions(
  client: SesSupabaseClient,
  jobId: string,
): Promise<SesCuratedSourceSupersession[] | null> {
  if (!String(jobId || "").trim()) return null;
  const response = await client.from("job_events")
    .select("detail_json,created_at")
    .eq("job_id", jobId)
    .eq("event_type", SES_CURATED_SOURCE_BIND_EVENT_TYPE);
  if (response.error) return null;
  return sesCuratedSourceSupersessionsFromEvents(response.data || []);
}

async function verifyStoredSupportingReport(
  client: SesSupabaseClient,
  artifact: Record<string, any>,
  supersessions: SesCuratedSourceSupersession[] | null,
): Promise<SesSupportingReportTrust> {
  const inspected = inspectSesSupportingReportProof(artifact);
  if (!inspected.trusted) return inspected;
  if (!supersessions) {
    return {
      trusted: false,
      reason: SES_CURATED_SOURCE_SUPERSESSION_UNREADABLE_REASON,
    };
  }
  if (sesSupportingReportIsSuperseded(artifact, supersessions)) {
    return { trusted: false, reason: SES_CURATED_SOURCE_SUPERSEDED_REASON };
  }
  const metadata = object(artifact.metadata);
  const documentId = String(
    metadata.report_document_id || metadata.source_document_id || "",
  );
  const documentResponse = await client.from("job_documents")
    .select("id,data_snapshot_json")
    .eq("id", documentId)
    .maybeSingle();
  if (documentResponse.error) {
    return { trusted: false, reason: "source_document_unreadable" };
  }
  if (!documentResponse.data) {
    return { trusted: false, reason: "source_document_missing" };
  }
  if (
    sesSupportingReportDocumentBinding(
      metadata.expected_raw_sha256,
      documentResponse.data.data_snapshot_json,
    ) === "diverged"
  ) {
    return { trusted: false, reason: "source_document_bytes_diverged" };
  }
  const prefix = `${SES_DOCKET_BUCKET}/`;
  const objectKey = String(artifact.object_key || "");
  if (!objectKey.startsWith(prefix)) {
    return { trusted: false, reason: "source_object_outside_private_bucket" };
  }
  const recovered = await client.storage.from(SES_DOCKET_BUCKET)
    .download(objectKey.slice(prefix.length));
  if (recovered.error || !recovered.data) {
    return { trusted: false, reason: "source_bytes_unrecoverable" };
  }
  const bytes = new Uint8Array(await recovered.data.arrayBuffer());
  if (
    bytes.byteLength !== Number(artifact.size_bytes) ||
    bytes.byteLength > SES_SUPPORTING_REPORT_MAX_BYTES ||
    new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-" ||
    await sesSha256Bytes(bytes) !== artifact.content_hash
  ) {
    return { trusted: false, reason: "served_pdf_content_hash_mismatch" };
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const raw = Array.from(digest).map((value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
  if (
    raw !==
      rawSesSupportingReportSha(object(artifact.metadata).expected_raw_sha256)
  ) {
    return { trusted: false, reason: "served_pdf_raw_sha256_mismatch" };
  }
  return { trusted: true };
}

export const SES_SUPERSEDED_SOURCE_RECOVERY_ACTION =
  "A corrected curated bind superseded the report this pack was built from, so the pack still carries the superseded bytes. Run POST ops-api?action=prepare_ses_docket_revision with dry_run true, then dry_run false, to rebuild it from the currently bound curated report, and record a fresh Docs Ready signoff. The superseded revision stays in the audit trail and is never served again.";

function curatedSourceMissingRefusal(reason: string): SesRefusal {
  const superseded = reason === SES_CURATED_SOURCE_SUPERSEDED_REASON;
  return sesRefusal(
    "curated_source_missing",
    superseded
      ? SES_SUPERSEDED_SOURCE_RECOVERY_ACTION
      : SES_CURATED_SOURCE_RECOVERY_ACTION,
    {
      ...(superseded
        ? {
          fact:
            "The completion report in this pack was superseded by a corrected curated bind, so the pack must be re-prepared before it can be reviewed or released.",
        }
        : {}),
      evidence: { suppression_reason: reason },
    },
  );
}

function parseDraft(
  routeKind: "report" | "photo" | "invoice" | "report_invoice",
  value: unknown,
): SesReviewRoute | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const headerLines = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):[ \t]*(.*)$/);
    if (match) headerLines.set(match[1].trim().toLowerCase(), match[2].trim());
  }
  const header = (name: string): string =>
    headerLines.get(name.toLowerCase()) || "";
  const recipients = splitEmails(header("To"));
  const cc = splitEmails(header("Cc"));
  const subject = header("Subject");
  const attachments = header("Attachments").split(",").map((item) =>
    item.trim()
  ).filter(Boolean);
  const body = text.replace(/^(?:To|Cc|Subject|Attachments):.*$/gmi, "")
    .trim();
  const route = {
    route_kind: routeKind,
    recipients,
    cc,
    subject,
    body,
    attachment_hashes: attachments,
    ready: !!subject && !!body && recipients.length > 0,
  };
  try {
    assertSesRouteRecipients(route);
  } catch {
    route.recipients = [];
    route.cc = [];
    route.ready = false;
  }
  return route;
}

export const _parseSesDraftForTest = parseDraft;

function refusalFromStored(value: unknown): SesRefusal {
  const row = object(value);
  const fact = String(
    row.fact || row.reason ||
      "The current readiness row does not record which real-world fact is missing.",
  );
  return {
    state: "refused",
    code: String(row.code || row.reason_code || "readiness_fact_missing"),
    fact,
    recovery_action: String(
      row.recovery_action ||
        "Resolve the named real-world fact and prepare a new docket revision.",
    ),
    ...(row.decision_key ? { decision_key: String(row.decision_key) } : {}),
  };
}

function draftRoutes(docket: Record<string, any>): SesReviewRoute[] {
  const drafts = object(docket.email_drafts);
  const candidates: Array<[typeof SES_ROUTE_ORDER[number], unknown]> = [
    ["report", drafts.REPORT_EMAIL_DRAFT],
    ["photo", drafts.PHOTO_EMAIL_DRAFT],
    ["invoice", drafts.INVOICE_EMAIL_DRAFT],
  ];
  return candidates.map(([kind, value]) => parseDraft(kind, value)).filter((
    value,
  ): value is SesReviewRoute => !!value);
}

/**
 * Effective Xero binding for route readiness: docket stage `invoice_bound`
 * carries the AUTHORISED binding, while Option B mint binds a DRAFT only on
 * the obligation revision and leaves the docket at `pre_xero`. Prefer the
 * docket binding when it names an invoice; otherwise fall through to the
 * obligation so cockpit C11 cannot claim "no Xero invoice" after a live mint.
 */
export function resolveSesRouteXeroBinding(
  docket: Record<string, any>,
  obligation: Record<string, any> | null,
): Record<string, unknown> {
  const docketXero = object(docket.xero_binding);
  if (String(docketXero.xero_invoice_id || "").trim()) return docketXero;
  const obligationXero = object(obligation?.xero_binding);
  if (String(obligationXero.xero_invoice_id || "").trim()) {
    return obligationXero;
  }
  return {};
}

function docketBuilderKey(docket: Record<string, any>): string {
  const classification = object(object(docket.envelope).v2).classification;
  return String(
    object(classification).builder_key ||
      object(docket.review_spec).builder_key ||
      "",
  ).trim();
}

/**
 * Map a stored docket artifact `object_key` to the pack-relative path used in
 * email draft Attachments headers (e.g. `ARTIFACTS/photos/001-….jpg`).
 *
 * Invoice-bound dockets copy parent pre_xero artifacts and keep the parent's
 * revision id in the object key (`…/{based_on}/ARTIFACTS/photos/…`). Matching
 * only `/${docket.id}/` then falling back to the last two path segments breaks
 * nested photo paths while flat `ARTIFACTS/report.pdf` still matches — which is
 * exactly the live Bertram HOLD (`photo` drafted, `attachment_count: 0` despite
 * 35 `completion_photo` rows). Prefer the current id, then `based_on`, then a
 * durable `ARTIFACTS|SOURCE|DRAFTS` root cut.
 */
export function docketArtifactPackRelativePath(
  objectKey: string,
  docketRevisionId: string,
  basedOnRevisionId?: string | null,
): string {
  const key = String(objectKey || "");
  if (!key) return "";
  const markers: string[] = [];
  const current = String(docketRevisionId || "").trim();
  if (current) markers.push(`/${current}/`);
  const basedOn = String(basedOnRevisionId || "").trim();
  if (basedOn && basedOn !== current) markers.push(`/${basedOn}/`);
  for (const marker of markers) {
    const idx = key.indexOf(marker);
    if (idx >= 0) return key.slice(idx + marker.length);
  }
  for (const root of ["ARTIFACTS/", "SOURCE/", "DRAFTS/"]) {
    const withSlash = `/${root}`;
    const idx = key.indexOf(withSlash);
    if (idx >= 0) return key.slice(idx + 1);
    if (key.startsWith(root)) return key;
  }
  return key.split("/").filter(Boolean).slice(-2).join("/");
}

export function resolveDocketRoutes(
  docket: Record<string, any>,
  artifacts: Array<Record<string, any>>,
  obligation: Record<string, any> | null,
  options?: { mlbOrdinaryMailSendFallback?: boolean },
): SesReviewRoute[] {
  const byPath = new Map<string, Record<string, any>>();
  const basedOnRevisionId = String(docket.based_on_revision_id || "").trim();
  for (const artifact of artifacts) {
    const path = docketArtifactPackRelativePath(
      String(artifact.object_key || ""),
      String(docket.id || ""),
      basedOnRevisionId,
    );
    if (path) byPath.set(path, artifact);
  }
  const xero = resolveSesRouteXeroBinding(docket, obligation);
  const boundInvoiceId = String(xero.xero_invoice_id || "");
  const boundInvoiceNumber = String(xero.invoice_number || "");
  const xeroStatus = String(xero.status || "").toUpperCase();
  const invoicePdfs = artifacts.filter((artifact) =>
    artifact.role === "xero_invoice_pdf" &&
    artifact.media_type === "application/pdf"
  );
  const invoicePdf = invoicePdfs.length === 1 &&
      object(invoicePdfs[0].metadata).xero_invoice_id === boundInvoiceId &&
      object(invoicePdfs[0].metadata).invoice_number === boundInvoiceNumber
    ? invoicePdfs[0]
    : null;
  const noAdditionalCharge =
    obligation?.pricing_disposition === "no_additional_charge";
  const builderKey = docketBuilderKey(docket);
  const ajs = isAjsBuilderKey(builderKey);
  const routing = object(object(object(docket.envelope).v2).routing);
  const workOrderSender = String(
    routing.report_to || routing.photo_to || "",
  ).trim();

  const resolvedRoutes = draftRoutes(docket).map((route) => {
    const referenced = route.attachment_hashes.map((path) => byPath.get(path));
    const resolved = referenced
      .filter((artifact): artifact is Record<string, any> => !!artifact)
      .map((artifact) => String(artifact.content_hash));
    if (route.route_kind !== "invoice") {
      return {
        ...route,
        attachment_hashes: resolved,
        ready: route.ready &&
          resolved.length === route.attachment_hashes.length,
      };
    }

    // Builder-facing invoice routes may carry only approved PDF support.
    // The local invoice proposal remains an internal pre-Xero artifact and
    // legacy draft references to it are deliberately ignored.
    const approvedSupport = referenced.filter((artifact) =>
      artifact &&
      (artifact.role === "supporting_report_pdf" ||
        artifact.role === "swms_artifact") &&
      artifact.media_type === "application/pdf"
    ) as Array<Record<string, any>>;
    const unsupportedReference = referenced.some((artifact) =>
      !artifact || (artifact.role !== "invoice_proposal" &&
        !approvedSupport.includes(artifact))
    );
    const supportHashes = approvedSupport.map((artifact) =>
      String(artifact.content_hash)
    );
    const reference = String(
      object(docket.local_invoice_proposal).builder_reference || "",
    );

    if (noAdditionalCharge) {
      return {
        ...route,
        subject: `${reference || "Make-safe"} - no additional charge`,
        body:
          "This later attendance is recorded as document only with no additional charge. The current report and photo evidence are supplied through the accompanying approved routes.",
        attachment_hashes: [...new Set(supportHashes)],
        ready: route.ready && !unsupportedReference,
      };
    }

    // Live Xero DRAFT bound to the current obligation (Option B mint). The
    // docket may still be pre_xero and the authorised PDF attaches later at
    // approve time — readiness must not claim the draft is missing, and the
    // email body must not say "No Xero invoice exists".
    if (boundInvoiceId && xeroStatus === "DRAFT") {
      const invoiceNumber = boundInvoiceNumber || "pending-number";
      return {
        ...route,
        subject: `${reference || "Make-safe"} - Xero draft ${invoiceNumber}`
          .trim(),
        body:
          `Xero DRAFT invoice ${invoiceNumber} is bound to this obligation revision. The builder-facing Xero PDF attaches when the draft is authorised. No release is approved yet.`,
        attachment_hashes: [...new Set(supportHashes)],
        ready: route.ready && !unsupportedReference,
      };
    }

    if (docket.stage !== "invoice_bound" || xeroStatus !== "AUTHORISED") {
      return {
        ...route,
        attachment_hashes: [...new Set(supportHashes)],
        // Support PDFs are not an invoice. Until a live Xero draft is bound
        // (above) or an authorised Xero PDF is bound (below), the
        // builder-facing invoice route must remain non-sendable.
        ready: false,
      };
    }
    const invoiceAttachments = [...supportHashes];
    if (invoicePdf?.content_hash) {
      invoiceAttachments.unshift(String(invoicePdf.content_hash));
    }
    const invoiceNumber = boundInvoiceNumber;
    return {
      ...route,
      subject: `${reference || "Make-safe"} - Xero invoice ${invoiceNumber}`
        .trim(),
      body:
        "Please find the authorised SecureWorks Xero invoice and the supporting current-cycle documents attached.",
      attachment_hashes: [...new Set(invoiceAttachments)],
      ready: route.ready && !!invoicePdf?.content_hash &&
        xeroStatus === "AUTHORISED" && !unsupportedReference,
    };
  });

  if (!ajs) {
    // MLB physical (Captain 2026-08-05 locked shape): report + photo reply on
    // the intake thread; invoice is ordinary makesafes@ billing pack.
    // TEMPORARY exception (MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1): report
    // and photo also use ordinary Mail.Send because conversationThread:reply
    // is Application: Not supported. applyMlbThreadReplyToRoute stamps the
    // exception transport visibly; restore by flipping that flag.
    //
    // Under ordinary Mail.Send, report/photo subjects use the EXACT original
    // work-order email subject from routing.intake_email_subject when present
    // (emails.subject preferred at prepare). That is inbox grouping only —
    // not real threading. Missing subject falls back to the generated draft
    // subject and still sends (subject_source: generated_fallback).
    const classification = object(
      object(object(docket.envelope).v2).classification,
    );
    const family = String(
      classification.family || object(docket.review_spec).family || "",
    );
    const shape = { builder_key: builderKey, family };
    if (!isMlbPhysicalReleaseShape(shape)) return resolvedRoutes;
    const thread = routingIntakeThread(routing);
    // Captain 2026-08-06: the three destinations are SET here, not inherited
    // from the stored draft's To: header. mlbPhysicalRouteRecipients is the one
    // producer (prepare writes the same values into the draft), so the cockpit
    // tab, the persisted release route and the send can never disagree — and a
    // revision drafted before this ruling resolves to the correct addresses
    // without a re-prepare. The billing mailbox stays the sealed matrix value
    // that the envelope already declares (Perth makesafes@ / south-west bunbury@).
    const billingMailbox = String(routing.invoice_to || "").trim();
    const invoicePdfHash = String(invoicePdf?.content_hash || "").trim() ||
      null;
    const ordinaryMailSend = options?.mlbOrdinaryMailSendFallback ??
      mlbPhysicalUsesOrdinaryMailSendFallback();
    const originalSubject = String(
      (routing as any).intake_email_subject || "",
    ).trim() || null;
    const originalSubjectSourceRaw = String(
      (routing as any).intake_email_subject_source || "",
    ).trim();
    // Unrecognised or absent provenance stays null — never claim the strongest
    // store for a subject whose origin the envelope does not actually name.
    const originalSubjectSource =
      originalSubjectSourceRaw === "emails_subject" ||
        originalSubjectSourceRaw === "intake_draft_subject" ||
        originalSubjectSourceRaw === "job_metadata_builder_email_subject"
        ? originalSubjectSourceRaw
        : null;
    return resolvedRoutes.map((route) => {
      const declared = mlbPhysicalRouteRecipients(
        route.route_kind,
        billingMailbox,
      );
      // A legacy envelope that declares no billing mailbox keeps whatever the
      // draft addressed the invoice to: emptying a money route is worse than
      // leaving it as prepared, and assertSesRouteRecipients still guards it.
      const recipients = declared.length > 0 ? declared : route.recipients;
      const invoiceOnMailerRoute = mlbPrimeMailerRouteCarriesInvoice({
        routeKind: route.route_kind,
        attachmentHashes: route.attachment_hashes,
        invoicePdfContentHash: invoicePdfHash,
      });
      return applyMlbThreadReplyToRoute(
        {
          ...route,
          recipients,
          // The Captain's boundary is absolute, so a Prime mailer route holding
          // the invoice PDF is refused rather than silently stripped.
          ready: route.ready && recipients.length > 0 && !invoiceOnMailerRoute,
        },
        shape,
        thread,
        ordinaryMailSend,
        ordinaryMailSend
          ? {
            originalSubject,
            originalSubjectSource,
          }
          : null,
      );
    });
  }

  // AJS/AJBR two-email shape (skill backend release contract / Captain 2026-08-04):
  //   route_kind report_invoice = report PDF + real Xero invoice PDF
  //   route_kind photo = labelled images follow-up
  // Separate invoice route is dropped so SEND IT only releases two emails.
  // Builder-facing body is set here (not inherited from internal draft jargon):
  // what is attached, job ref, thanks. No draft/docket/pack/route/cycle/revision.
  const byKind = new Map(
    resolvedRoutes.map((route) => [route.route_kind, route]),
  );
  const report = byKind.get("report");
  const photo = byKind.get("photo");
  const invoice = byKind.get("invoice");
  // Explicit invoice_to bind: workorders@ajs.build first — never silent inherit
  // of work-order sender alone without the processing mailbox.
  const recipients = ajsPackRecipients({ workOrderSender });
  const cc = ajsPackCc();
  const out: SesReviewRoute[] = [];
  const reference = String(
    object(docket.local_invoice_proposal).builder_reference || "",
  );
  const jobRef = reference || "this job";
  const ajsReportInvoiceBody =
    `Please find attached the report and invoice for ${jobRef}.\n\nThank you.`;
  const ajsPhotoBody =
    `Please find attached site photos for ${jobRef}.\n\nThank you.`;
  const ajsNoChargeBody =
    `Please find attached the report for ${jobRef}. There is no additional charge for this attendance.\n\nThank you.`;

  if (report || invoice) {
    const reportHashes = report?.attachment_hashes || [];
    const invoiceHashes = (invoice?.attachment_hashes || []).filter((hash) => {
      return !!hash;
    });
    const combinedHashes = [
      ...new Set([
        ...(invoicePdf?.content_hash ? [String(invoicePdf.content_hash)] : []),
        ...reportHashes,
        ...invoiceHashes,
      ]),
    ];
    const invoiceNumber = boundInvoiceNumber;
    const authorised = xeroStatus === "AUTHORISED" &&
      !!invoicePdf?.content_hash;
    const combined: SesReviewRoute = {
      route_kind: "report_invoice",
      recipients,
      cc,
      subject: authorised
        ? `${
          reference || "Make-safe"
        } - report and Xero invoice ${invoiceNumber}`
          .trim()
        : (report?.subject ||
          `${reference || "Make-safe"} - report and invoice`).trim(),
      body: ajsReportInvoiceBody,
      attachment_hashes: combinedHashes,
      ready: !!report?.ready && authorised && recipients.length > 0,
    };
    if (noAdditionalCharge && report) {
      combined.subject = `${
        reference || "Make-safe"
      } - report (no additional charge)`;
      combined.body = ajsNoChargeBody;
      combined.attachment_hashes = [...new Set(reportHashes)];
      combined.ready = report.ready && recipients.length > 0;
    }
    out.push(combined);
  }

  if (photo) {
    out.push({
      ...photo,
      route_kind: "photo",
      body: ajsPhotoBody,
      recipients: recipients.length ? recipients : photo.recipients,
      cc,
      ready: photo.ready &&
        (recipients.length > 0 || photo.recipients.length > 0),
    });
  }

  return out;
}

function cleanInputFromRows(args: {
  docket: Record<string, any>;
  readiness: Record<string, any>;
  obligation: Record<string, any> | null;
  routes: SesReviewRoute[];
}): SesCleanInput {
  const envelope = object(args.docket.envelope);
  const manifest = object(envelope.v2);
  const classification = object(manifest.classification);
  const routing = object(manifest.routing);
  const routingDeclared = Object.keys(routing).length > 0;
  const review = object(args.docket.review_spec);
  const cards = Array.isArray(review.cards) ? review.cards : [];
  const card = object(cards[0]);
  const portalProof = Array.isArray(card.portal_proof) ? card.portal_proof : [];
  const portalStatus =
    portalProof.some((proof) => object(proof).status === "unreachable")
      ? "unreachable"
      : (portalProof.some((proof) => object(proof).status === "not_done")
        ? "not_done"
        : (portalProof.length ? "done" : "not_applicable"));
  const items = object(manifest.items);
  const blockers = Array.isArray(args.readiness.blockers)
    ? args.readiness.blockers.map(refusalFromStored)
    : [];
  const storedBlockers = Array.isArray(args.docket.blockers)
    ? args.docket.blockers.map(refusalFromStored)
    : [];
  const obligationBlockers = Array.isArray(args.obligation?.blockers)
    ? args.obligation.blockers.map(refusalFromStored)
    : [];
  const family = String(card.family || classification.family || "");
  const physical = family === "physical_makesafe" ||
    family === "temporary_fencing";
  const pricingDisposition = String(
    args.obligation?.pricing_disposition || "money_review_required",
  ) as SesPricingDisposition;
  const duplicate = object(args.obligation?.duplicate_probe);
  return {
    pre_xero_docs_ready: args.docket.pre_xero_docs_ready === true,
    readiness_ready: args.readiness.ready === true,
    readiness_blockers: [
      ...blockers,
      ...storedBlockers,
      ...obligationBlockers,
    ],
    pricing_disposition: pricingDisposition,
    line_overrides_audited: pricingDisposition !==
        "priced_with_line_override" ||
      (Array.isArray(args.obligation?.proposal?.lines) &&
        args.obligation.proposal.lines.every((line: any) =>
          line.rate_override_approved && line.rate_override_by &&
          line.rate_override_at
        )),
    duplicate_allows_create: duplicate.allows_create === true,
    invoice_already_bound: args.docket.stage === "invoice_bound" &&
      object(args.docket.xero_binding).status === "AUTHORISED",
    duplicate_ambiguity: String(duplicate.ambiguity || "none"),
    money_blocker_codes: [
      ...blockers,
      ...storedBlockers,
      ...obligationBlockers,
    ].map((blocker) => blocker.code),
    post_release_disposition_outstanding: [
      "blocked_billing_disposition",
      "billing_disposition_required",
    ].includes(pricingDisposition),
    family,
    family_matrix_version: String(args.docket.family_matrix_version || "") ||
      null,
    assessment_recipe_version: classification
        .assessment_outbound_recipe_version
      ? String(classification.assessment_outbound_recipe_version)
      : null,
    portal_required: portalProof.length > 0,
    portal_capture_status: portalStatus,
    own_document_exemption: classification.report_delivery === "own_document",
    physical_media_complete: !physical ||
      object(items.physical_reporting_evidence).state === "ready",
    completed_work_photo_proven: !physical ||
      object(items.physical_reporting_evidence).state === "ready",
    obligation_revision_count: args.obligation ? 1 : 0,
    routes: args.routes,
    // The matrix stamps routing.photo_to at prepare time: empty means
    // `photo_route: "not_applicable"` and no PHOTO_EMAIL_DRAFT is produced.
    // A legacy envelope that declares no routing block at all keeps the old
    // behaviour (photo required) rather than silently dropping the route.
    photo_route_applicable: !routingDeclared ||
      String(routing.photo_to || "").trim().length > 0,
    // The manifest's own declaration, not `report_only`. A card whose report is
    // the builder portal stamps draft_builder_report_email: not_applicable
    // ("portal-is-the-report") and never produces a REPORT_EMAIL_DRAFT, so the
    // cockpit must not demand one (Captain 2026-08-06: one email, group inbox,
    // carrying the invoice). Keying on `report_only` instead would ALSO exempt
    // own_template_roof, which is report-only but sends a real report email on
    // our own letterhead — a loosening that ruling does not authorise. Every
    // other state (ready, blocked, and the initial "Evidence not recorded")
    // keeps the route required, so a family that owes a report email and failed
    // to build one is still held, honestly.
    report_route_applicable:
      object(items.draft_builder_report_email).state !== "not_applicable",
    type_check_hold: storedBlockers.some((blocker) =>
      blocker.code === "type_check"
    ),
    story_unverified: storedBlockers.some((blocker) =>
      blocker.code === "story_unverified"
    ),
    trade_report_submitted: !physical ||
      object(items.physical_reporting_evidence).state === "ready",
    roof_report_required: family === "own_template_roof",
    roof_report_filled: family !== "own_template_roof" ||
      object(items.supporting_report_pdf).state === "ready",
    report_only: classification.report_only === true,
    builder_key: String(classification.builder_key || "").trim() || null,
  };
}

/**
 * One rule for "which obligation revision backs this docket": the docket's own
 * pointer when it names one, otherwise the newest current revision for the job.
 * The raw response is returned so each caller applies its own refusal for a
 * read failure — a database error must never be read as "no obligation".
 */
async function readSesObligationForDocket(
  client: SesSupabaseClient,
  args: {
    job_id: string;
    invoice_obligation_revision_id?: string | null;
    columns: string;
  },
): Promise<SupabaseResponse<any>> {
  if (args.invoice_obligation_revision_id) {
    return await client.from("makesafe_invoice_obligation_revisions")
      .select(args.columns)
      .eq("id", args.invoice_obligation_revision_id)
      .maybeSingle();
  }
  return await client.from("makesafe_invoice_obligation_revisions_current")
    .select(args.columns)
    .eq("job_id", args.job_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function loadSesCockpitDocket(
  client: SesSupabaseClient,
  jobId: string,
  deps: {
    fetchInvoicePdfBytes?: (invoiceId: string) => Promise<Uint8Array>;
  } = {},
): Promise<SesCockpitDocket> {
  const docketResponse = await client.from("makesafe_docket_revisions_current")
    .select("*").eq("job_id", jobId).maybeSingle();
  const docket = requireValue(
    docketResponse,
    "No current SES docket revision exists for this job.",
  );
  const readinessResponse = await client.from("makesafe_readiness_current_v2")
    .select("*").eq("job_id", jobId).maybeSingle();
  const readiness = requireValue(
    readinessResponse,
    "No current readiness revision exists for this job.",
  );
  const obligationResponse = await readSesObligationForDocket(client, {
    job_id: jobId,
    invoice_obligation_revision_id: docket.invoice_obligation_revision_id,
    columns: "*",
  });
  if (obligationResponse.error) {
    throw new SesActionError(409, {
      state: "refused",
      fact: `The current invoice obligation could not be read (${
        obligationResponse.error.message || "unknown database error"
      }).`,
    });
  }
  const obligation = obligationResponse.data || null;
  const artifactsResponse = await client.from("makesafe_docket_artifacts")
    .select("id,role,object_key,media_type,content_hash,size_bytes,metadata")
    .eq("revision_id", docket.id)
    .order("object_key");
  if (artifactsResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The current docket attachments could not be read (${
        artifactsResponse.error.message || "unknown database error"
      }).`,
    });
  }
  const manifest = object(object(docket.envelope).v2);
  const family = String(object(manifest.classification).family || "");
  const physical = family === "physical_makesafe" ||
    family === "temporary_fencing";
  let cockpitArtifacts = artifactsResponse.data || [];
  let sourceRefusal: SesRefusal | null = null;
  if (physical) {
    const reportArtifacts = cockpitArtifacts.filter((artifact: any) =>
      artifact.role === "supporting_report_pdf"
    );
    const trust = reportArtifacts.length === 1
      ? await verifyStoredSupportingReport(
        client,
        reportArtifacts[0],
        await loadSesCuratedSourceSupersessions(client, jobId),
      )
      : {
        trusted: false as const,
        reason: reportArtifacts.length === 0
          ? "supporting_report_pdf_missing"
          : "multiple_supporting_report_pdfs",
      };
    if (!trust.trusted) {
      sourceRefusal = curatedSourceMissingRefusal(trust.reason);
      cockpitArtifacts = cockpitArtifacts.filter((artifact: any) =>
        artifact.role !== "supporting_report_pdf"
      );
    }
  }
  const [assignmentsResponse, reportsResponse] = await Promise.all([
    client.from("job_assignments")
      .select(
        "id,job_id,user_id,scheduled_date,status,role,crew_name,travel_started_at,arrived_at,started_at,clocked_on_at,completed_at,attendance_cycle_id,cycle_attribution,users:user_id(id,name,phone)",
      )
      .eq("job_id", jobId)
      .order("scheduled_date", { ascending: true }),
    client.from("job_service_reports")
      .select(
        "id,job_id,submitted_by,status,submitted_at,created_at,cycle_number,attendance_cycle_id,cycle_attribution,checklist_json,notes,signature_name,weather,start_time,end_time,variations",
      )
      .eq("job_id", jobId)
      .order("created_at", { ascending: true }),
  ]);
  if (assignmentsResponse.error || reportsResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The crew and raw trade visit history could not be read (${
        assignmentsResponse.error?.message ||
        reportsResponse.error?.message ||
        "unknown database error"
      }).`,
    });
  }
  const routes = resolveDocketRoutes(
    docket,
    cockpitArtifacts,
    obligation,
  );
  const cleanInput = cleanInputFromRows({
    docket,
    readiness,
    obligation,
    routes,
  });
  if (sourceRefusal) {
    cleanInput.readiness_blockers.push(sourceRefusal);
    cleanInput.money_blocker_codes.push(sourceRefusal.code);
  }
  const rawBinding = resolveSesRouteXeroBinding(docket, obligation);
  type CockpitXeroBinding = {
    xero_invoice_id: string;
    invoice_number: string;
    status: string;
    total?: number | null;
    pdf_content_hash?: string;
    pdf_object_key?: string;
    pdf_size_bytes?: number;
  };
  let xeroBinding: CockpitXeroBinding | null = null;
  if (String(rawBinding.xero_invoice_id || "").trim()) {
    xeroBinding = {
      xero_invoice_id: String(rawBinding.xero_invoice_id || ""),
      invoice_number: String(rawBinding.invoice_number || ""),
      status: String(rawBinding.status || ""),
      ...(rawBinding.pdf_content_hash
        ? { pdf_content_hash: String(rawBinding.pdf_content_hash) }
        : {}),
      ...(rawBinding.pdf_object_key
        ? { pdf_object_key: String(rawBinding.pdf_object_key) }
        : {}),
      ...(rawBinding.pdf_size_bytes != null
        ? { pdf_size_bytes: Number(rawBinding.pdf_size_bytes) }
        : {}),
      ...(rawBinding.total !== undefined && rawBinding.total !== null
        ? { total: Number(rawBinding.total) }
        : {}),
    };
    if (
      xeroBinding.total === undefined || !Number.isFinite(xeroBinding.total)
    ) {
      // Enrich total for the Invoice tab when older DRAFT binds omitted it.
      // Prefer the local Xero mirror (authoritative issued total), then the
      // obligation proposal totals (pre-authorise DRAFT identity display).
      const boundId = xeroBinding.xero_invoice_id;
      const mirror = boundId
        ? await client.from("xero_invoices")
          .select("total,invoice_number,status")
          .eq("xero_invoice_id", boundId)
          .maybeSingle()
        : { data: null, error: null };
      const mirrorTotal = Number(object(mirror.data).total);
      if (Number.isFinite(mirrorTotal)) {
        xeroBinding = { ...xeroBinding, total: mirrorTotal };
      } else {
        const proposal = object(obligation?.proposal);
        const totals = object(proposal.totals);
        const proposalTotal = Number(
          totals.inc ?? totals.total_inc_gst ?? totals.total,
        );
        if (Number.isFinite(proposalTotal)) {
          xeroBinding = { ...xeroBinding, total: proposalTotal };
        } else {
          xeroBinding = { ...xeroBinding, total: null };
        }
      }
    }
  }
  // The Invoice tab may only claim a PDF it can actually show. An AUTHORISED
  // bind carries the real rendered document as a docket artifact; a DRAFT
  // proves itself only by a successful live re-fetch, because a stamped
  // pdf_content_hash is a pointer to yesterday's bytes, not a current document.
  // This is the same projection the pack read performs, so the cockpit's
  // money.bound_invoice and the pack's invoice_pdf cannot disagree.
  let xeroInvoicePdfAvailable = false;
  if (xeroBinding) {
    if (String(xeroBinding.status || "").toUpperCase() === "DRAFT") {
      if (deps.fetchInvoicePdfBytes) {
        const projected = await resolveSesBoundDraftInvoicePdfArtifact(client, {
          job_id: jobId,
          docket,
          obligation,
          fetchInvoicePdfBytes: deps.fetchInvoicePdfBytes,
        });
        xeroInvoicePdfAvailable = projected.source === "live_fetch" &&
          !!projected.artifact.signed_url;
      }
    } else {
      const boundArtifact = matchingXeroInvoicePdfArtifact(
        cockpitArtifacts,
        rawBinding,
      );
      xeroInvoicePdfAvailable = !!String(boundArtifact?.object_key || "")
        .trim();
    }
  }
  const releaseSendProgress = await loadSesReleaseSendProgressForJob(
    client,
    jobId,
  );
  return {
    job_id: jobId,
    job_number: object(manifest.classification).job_number || null,
    docket_revision_id: docket.id,
    readiness_revision: readiness.readiness_revision,
    dependency_generation: Number(readiness.dependency_generation),
    invoice_obligation_revision_id: obligation?.id || null,
    attendance_cycle_ids: docket.attendance_cycle_ids || [],
    xero_binding: xeroBinding,
    xero_invoice_pdf_available: xeroInvoicePdfAvailable,
    // The cockpit/list contract consumes the docket proposal shape
    // (`subtotal_ex_gst` / `total_inc_gst`). The obligation proposal is a
    // separately typed canonical-pricing record and must not mask it.
    local_invoice_proposal: docket.local_invoice_proposal || null,
    work_order: object(manifest.items).source_work_order_attachment || null,
    family_evidence: object(manifest.items),
    swms: object(manifest.items).swms_current_cycle || {},
    routes,
    crew_and_trade_visits: {
      assignments: assignmentsResponse.data || [],
      visit_reports: reportsResponse.data || [],
    },
    clean_input: cleanInput,
    release_send_progress: releaseSendProgress,
  };
}

/**
 * Read the latest non-proposed release membership for this job and classify
 * send progress from the route-proof ledger + closeout verification. Failures
 * degrade to `none` rather than inventing a send (SEND_READY is safer than a
 * false RELEASED when the ledger is unreadable — the Captain still sees the
 * board facts).
 */
async function loadSesReleaseSendProgressForJob(
  client: SesSupabaseClient,
  jobId: string,
) {
  const membersResponse = await client.from("makesafe_release_revision_members")
    .select("release_revision_id, ordinal")
    .eq("job_id", jobId)
    .order("ordinal", { ascending: true });
  if (membersResponse.error || !membersResponse.data?.length) {
    return classifySesReleaseSendProgress({});
  }
  const releaseIds = [
    ...new Set(
      membersResponse.data
        .map((row: any) => String(row.release_revision_id || "").trim())
        .filter(Boolean),
    ),
  ];
  if (releaseIds.length === 0) {
    return classifySesReleaseSendProgress({});
  }
  const releasesResponse = await client.from("makesafe_release_revisions")
    .select("id, state, updated_at, created_at")
    .in("id", releaseIds)
    .in("state", ["approved", "dispatching", "released"])
    .order("updated_at", { ascending: false });
  if (releasesResponse.error || !releasesResponse.data?.length) {
    return classifySesReleaseSendProgress({});
  }
  // Prefer a released revision; otherwise the most recently updated active one.
  const sorted = [...releasesResponse.data].sort((a: any, b: any) => {
    const aReleased = String(a.state || "") === "released" ? 1 : 0;
    const bReleased = String(b.state || "") === "released" ? 1 : 0;
    if (aReleased !== bReleased) return bReleased - aReleased;
    return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  });
  const release = sorted[0];
  const releaseId = String(release.id || "").trim();
  const [routesResponse, proofsResponse, closeoutResponse] = await Promise.all([
    client.from("makesafe_release_revision_routes")
      .select("route_kind, required")
      .eq("release_revision_id", releaseId)
      .order("ordinal"),
    client.from("ses_release_route_proofs")
      .select("route_kind, proof_hash")
      .eq("release_revision_id", releaseId),
    client.from("makesafe_closeout_revisions")
      .select("id, verified")
      .eq("release_revision_id", releaseId)
      .maybeSingle(),
  ]);
  if (routesResponse.error || proofsResponse.error) {
    return classifySesReleaseSendProgress({});
  }
  const requiredKinds = (routesResponse.data || [])
    .filter((row: any) => row.required !== false)
    .map((row: any) => String(row.route_kind || "").trim())
    .filter(Boolean);
  const provedKinds = (proofsResponse.data || [])
    .map((row: any) => String(row.route_kind || "").trim())
    .filter(Boolean);
  const closeoutVerified = !closeoutResponse.error &&
    !!closeoutResponse.data &&
    closeoutResponse.data.verified === true;
  return classifySesReleaseSendProgress({
    release_revision_id: releaseId,
    release_state: String(release.state || ""),
    required_route_kinds: requiredKinds,
    proved_route_kinds: provedKinds,
    closeout_verified: closeoutVerified,
  });
}

export async function querySesReviewCockpitAction(
  client: SesSupabaseClient,
  jobId: string,
  displayedBinding?: {
    readiness_revision: string;
    dependency_generation: number;
  },
  releaseRevisionId?: string,
  deps: {
    fetchInvoicePdfBytes?: (invoiceId: string) => Promise<Uint8Array>;
  } = {},
) {
  const cockpit = buildSesCockpitView(
    await loadSesCockpitDocket(client, jobId, deps),
    displayedBinding,
  );
  if (!releaseRevisionId) return cockpit;
  const [releaseResponse, membersResponse, routesResponse] = await Promise.all([
    client.from("makesafe_release_revisions").select("*")
      .eq("id", releaseRevisionId).maybeSingle(),
    client.from("makesafe_release_revision_members").select("*")
      .eq("release_revision_id", releaseRevisionId).order("ordinal"),
    client.from("makesafe_release_revision_routes").select("*")
      .eq("release_revision_id", releaseRevisionId).order("ordinal"),
  ]);
  const release = requireValue(
    releaseResponse,
    "The displayed composite release revision no longer exists.",
  );
  const members = membersResponse.data || [];
  const routes = routesResponse.data || [];
  if (
    membersResponse.error || routesResponse.error ||
    !members.some((member: any) => member.job_id === jobId) ||
    (routes.length !== 3 && routes.length !== 2)
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The displayed composite release does not contain this job and the exact email routes.",
    });
  }
  return {
    ...cockpit,
    release_revision: {
      id: release.id,
      content_hash: release.content_hash,
      state: release.state,
      readiness_bindings: release.readiness_bindings,
      members,
      routes,
    },
  };
}

async function loadIndexedInvoiceRows(
  client: SesSupabaseClient,
  orgId: string,
  requests: SesInvoiceDuplicateRequest[],
): Promise<SesInvoiceIndexRow[]> {
  const jobs = [...new Set(requests.map((request) => request.job_id))];
  const refs = [
    ...new Set(
      requests.map((request) => normRef(request.external_ref)).filter((value) =>
        value.length >= 5
      ),
    ),
  ];
  const columns =
    "id,job_id,xero_invoice_id,invoice_number,status,reference,reference_normalized,invoice_type,invoice_obligation_revision_id";
  const byJob = await client.from("xero_invoices").select(columns)
    .eq("org_id", orgId).in("job_id", jobs);
  if (byJob.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The indexed Xero mirror could not be checked by job (${
        byJob.error.message || "unknown database error"
      }).`,
    });
  }
  const referenceRows: SesInvoiceIndexRow[] = [];
  for (const ref of refs) {
    const byReference = await client.from("xero_invoices").select(columns)
      .eq("org_id", orgId)
      .eq("invoice_type", "ACCREC")
      .not("status", "in", '("VOIDED","DELETED")')
      .or(`reference_normalized.eq.${ref},reference_normalized.like.*${ref}*`)
      .limit(25);
    if (byReference.error) {
      throw new SesActionError(503, {
        state: "refused",
        fact:
          `The indexed Xero mirror could not be checked by builder reference (${
            byReference.error.message || "unknown database error"
          }).`,
      });
    }
    referenceRows.push(...(byReference.data || []));
  }
  return [...(byJob.data || []), ...referenceRows];
}

export async function resolveSesInvoiceDuplicatesAction(
  client: SesSupabaseClient,
  orgId: string,
  requests: SesInvoiceDuplicateRequest[],
) {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 50) {
    throw new TypeError("requests must contain 1..50 invoice duplicate probes");
  }
  const rows = await loadIndexedInvoiceRows(client, orgId, requests);
  return {
    results: resolveSesInvoiceDuplicates(requests, rows),
    query_shape: "indexed_job_then_normalized_reference",
    scanned_full_estate: false,
  };
}

export async function prepareSesInvoiceObligationAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    job_id: string;
    docket_revision_id?: string;
    post_release_disposition?: string | null;
    created_by: string;
    /**
     * Captain-authorised commercial quantity/materials figure above the sealed
     * schedule. Leaves trade attendance evidence untouched. Privileged only.
     */
    commercial_quantity_override?: unknown;
  },
) {
  if (
    args.post_release_disposition &&
    (auth.mode !== "jwt" || !auth.user)
  ) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "The later attendance has no identified human disposition; an operator must choose second invoice, combine/credit review, document only, or hold pricing.",
    });
  }
  if (args.commercial_quantity_override != null) {
    // Same authority bar as draft mint: api_key / routine, or captain/admin JWT.
    // Never a silent trade-evidence rewrite and never a schedule floor change.
    await requireSesInvoiceMintAuthority(client, auth);
  }
  const docketQuery = client.from("makesafe_docket_revisions")
    .select("*").eq("job_id", args.job_id);
  const docketResponse = args.docket_revision_id
    ? await docketQuery.eq("id", args.docket_revision_id).maybeSingle()
    : await docketQuery.order("committed_at", { ascending: false }).limit(1)
      .maybeSingle();
  const docket = requireValue(
    docketResponse,
    "No U4 pre-Xero docket exists for this invoice proposal.",
  );
  if (docket.stage !== "pre_xero" || !docket.local_invoice_proposal) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The current docket is not a pre-Xero proposal that can mint an invoice obligation.",
    });
  }
  const manifest = object(object(docket.envelope).v2);
  const company = String(object(manifest.routing).builder || "").trim();
  if (!company) {
    throw new SesActionError(
      409,
      sesRefusal(
        "pricing_evidence_missing",
        "Recover the classified builder company from the source work order before preparing an invoice.",
        {
          fact:
            "The U4 docket has no classified builder company, so the Xero contact and pricing schedule are not proven.",
        },
      ),
    );
  }
  const existingResponse = await client.from(
    "makesafe_invoice_obligation_revisions_current",
  ).select("*").eq("job_id", args.job_id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (existingResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The current invoice obligation could not be read (${
        existingResponse.error.message || "unknown database error"
      }).`,
    });
  }
  const existing = existingResponse.data || null;
  if (
    existing &&
    ["create_executed", "authorised"].includes(existing.state)
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "This work already has a Xero-bound invoice that has not been released; use or compensate that exact invoice instead of proposing another one.",
    });
  }
  const local = object(docket.local_invoice_proposal);
  const reference = String(local.builder_reference || "");
  const [duplicate] = (await resolveSesInvoiceDuplicatesAction(
    client,
    args.org_id,
    [{
      job_id: args.job_id,
      external_ref: reference,
      obligation_revision_id: existing?.id || null,
    }],
  )).results;
  const existingIsCommerciallyBound = !!existing &&
    ["create_executed", "authorised", "released"].includes(existing.state);
  const explicitSecondInvoice = existingIsCommerciallyBound &&
    args.post_release_disposition === "second_invoice";
  const explicitDocumentOnly = existingIsCommerciallyBound &&
    args.post_release_disposition === "document_only";
  const currentCycleId = String(docket.current_attendance_cycle_id || "");
  const currentCycleWasAlreadyCovered = explicitSecondInvoice &&
    (existing.attendance_cycle_ids || []).includes(currentCycleId);
  const oldBoundInvoiceOnly = duplicate.live_invoices.length > 0 &&
    duplicate.live_invoices.every((invoice: SesInvoiceIndexRow) =>
      invoice.invoice_obligation_revision_id === existing?.id
    );
  const effectiveDuplicate = explicitSecondInvoice &&
      currentCycleId &&
      !currentCycleWasAlreadyCovered &&
      oldBoundInvoiceOnly &&
      duplicate.ambiguity !== "multi_live"
    ? {
      ...duplicate,
      allows_create: true,
      live_invoices: [],
      reason_codes: [
        ...duplicate.reason_codes,
        "prior_released_cycle_does_not_block_explicit_second_invoice",
      ],
    }
    : duplicate;
  type ObligationLine = {
    description: string;
    quantity: number;
    unit_price: number;
    account_code: string;
    evidence: Record<string, unknown>;
    rate_override_approved?: boolean;
    rate_override_by?: string;
    rate_override_at?: string;
  };
  let lines: ObligationLine[] = Array.isArray(local.line_items)
    ? local.line_items.map((line: any) => ({
      description: String(line.description || ""),
      quantity: Number(line.quantity),
      unit_price: Number(line.unit_price_ex_gst),
      account_code: "210",
      evidence: {
        source: "u4-local-invoice-proposal",
        docket_revision_id: docket.id,
        attendance_cycle_ids: docket.attendance_cycle_ids,
      },
    }))
    : [];
  let commercialProvenance: Record<string, unknown> | null = null;
  let pricingDisposition: SesPricingDisposition = explicitDocumentOnly
    ? "no_additional_charge"
    : (existingIsCommerciallyBound &&
        ["combine_credit", "hold_pricing"].includes(
          String(args.post_release_disposition || ""),
        )
      ? "money_review_required"
      : (existingIsCommerciallyBound && !args.post_release_disposition
        ? "blocked_billing_disposition"
        : (effectiveDuplicate.allows_create
          ? "priced_from_canon"
          : "blocked_duplicate_live")));

  if (args.commercial_quantity_override != null && !explicitDocumentOnly) {
    if (pricingDisposition !== "priced_from_canon") {
      throw new SesActionError(409, {
        state: "refused",
        fact:
          `A commercial_quantity_override cannot be applied while pricing disposition is ${pricingDisposition}. Clear the live draft/void or disposition block first.`,
      });
    }
    // Sealed labour rate from the U4 proposal (first positive line unit price).
    // Commercial path must keep this rate; only quantity/materials may change.
    const sealedLabourRate = (() => {
      for (
        const line of Array.isArray(local.line_items) ? local.line_items : []
      ) {
        const price = Number(
          (line as any)?.unit_price_ex_gst ?? (line as any)?.unit_price,
        );
        if (Number.isFinite(price) && price > 0) return price;
      }
      return null;
    })();
    try {
      const built = buildCommercialQuantityOverrideLines({
        override: args.commercial_quantity_override,
        docket_revision_id: docket.id,
        attendance_cycle_ids: docket.attendance_cycle_ids,
        sealed_labour_unit_price_ex_gst: sealedLabourRate,
        builder_reference: reference,
      });
      lines = built.lines;
      commercialProvenance = built.provenance as unknown as Record<
        string,
        unknown
      >;
      // Hosted on priced_with_line_override (existing DB CHECK) with explicit
      // evidence.override_kind=commercial_quantity_not_rate — not a false rate.
      pricingDisposition = "priced_with_line_override";
    } catch (error) {
      if (error instanceof SesCommercialQuantityOverrideError) {
        throw new SesActionError(error.httpStatus, {
          state: "refused",
          fact: error.message,
        });
      }
      throw error;
    }
  }

  const prepared = await prepareSesInvoiceObligation({
    org_id: args.org_id,
    job_id: args.job_id,
    docket_revision_id: docket.id,
    attendance_cycle_ids: existing?.state === "released" && currentCycleId
      ? [currentCycleId]
      : docket.attendance_cycle_ids,
    pricing_disposition: pricingDisposition,
    pricing_canon_version: SES_PRICING_CANON_VERSION,
    company,
    reference,
    contact_name: company,
    lines: explicitDocumentOnly ? [] : lines,
    guard_result: {
      hard_failures: [],
      warnings: commercialProvenance
        ? [
          "commercial_quantity_override_applied: Captain-authorised figure above sealed schedule; trade attendance evidence unchanged",
        ]
        : [],
    },
    duplicate_probe: effectiveDuplicate,
    created_by: args.created_by,
    existing: existing
      ? {
        obligation_id: existing.obligation_id,
        revision_id: existing.id,
        state: existing.state,
        released_cycle_ids: existing.attendance_cycle_ids,
      }
      : null,
    post_release_disposition: args.post_release_disposition as any,
  });
  if (commercialProvenance) {
    // Stamp the committed proposal so a year later the commercial figure is
    // attributable. proposal is jsonb — extra keys are retained as written.
    (prepared.proposal as any).commercial_quantity_override =
      commercialProvenance;
    (prepared.revision as any).proposal = prepared.proposal;
  }
  const committed = await client.rpc(
    "commit_ses_invoice_obligation_revision_v1",
    {
      p_obligation: prepared.obligation,
      p_revision: prepared.revision,
    },
  );
  return {
    ...prepared,
    commercial_quantity_override: commercialProvenance,
    commit: requireValue(
      committed,
      "The invoice obligation revision could not be committed.",
    ),
    external_mutations: { xero: 0, email: 0 },
  };
}

async function requireSesInvoiceMintAuthority(
  client: SesSupabaseClient,
  auth: SesActionAuth,
) {
  if (auth.mode === "api_key" || auth.mode === "routine") return;
  const operator = await loadOperatorAuth(client, auth);
  if (
    !canManageSesDocsReadySignoff({
      mode: operator.mode,
      role: operator.mode === "jwt" ? operator.role : null,
      operator_class: operator.mode === "jwt" ? operator.operator_class : null,
    })
  ) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "Minting a Xero DRAFT is restricted to the Captain, an admin-owner, the privileged ops key, or the make-safe automation routine.",
    });
  }
}

/**
 * Option B (Captain 2026-08-04): mint a real Xero DRAFT without a prior human
 * APPROVE INVOICE click. Approval still gates authorise/release.
 *
 * Mandatory first money step: full live-ACCREC fetch + resolveExistingInvoice
 * (invoice_utils.py semantics via makesafe_send_pack) BEFORE buildSesEffect /
 * gateway.createDraft. Never reimplement that resolver here.
 */
export async function createSesInvoiceDraftAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    job_id: string;
    invoice_obligation_revision_id?: string;
    actor: string;
  },
  gateway: SesXeroGateway,
  deps: {
    fetchAllAccrecInvoices?: (
      client: SesSupabaseClient,
    ) => Promise<any[]>;
  } = {},
) {
  // Mint is agent/api_key/routine-safe; a browser session must still be an
  // identified Captain or admin-owner. Authorise remains JWT-gated on execute.
  await requireSesInvoiceMintAuthority(client, auth);
  const revisionQuery = client.from("makesafe_invoice_obligation_revisions")
    .select("*")
    .eq("job_id", args.job_id);
  const revisionResponse = args.invoice_obligation_revision_id
    ? await revisionQuery.eq("id", args.invoice_obligation_revision_id)
      .maybeSingle()
    : await client.from("makesafe_invoice_obligation_revisions_current")
      .select("*")
      .eq("job_id", args.job_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  const revision = requireValue(
    revisionResponse,
    "No invoice obligation revision exists to mint a Xero DRAFT for.",
  );
  if (revision.pricing_disposition === "no_additional_charge") {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "This obligation is explicitly no additional charge, so no Xero invoice may be created.",
    });
  }
  if (
    revision.state === "blocked" ||
    !["priced_from_canon", "priced_with_line_override"].includes(
      revision.pricing_disposition,
    )
  ) {
    const blocker = Array.isArray(revision.blockers) &&
        revision.blockers.length > 0
      ? refusalFromStored(revision.blockers[0])
      : sesRefusal(
        "pricing_evidence_missing",
        "Prepare a new invoice obligation revision with real trade evidence and an executable priced line set.",
        {
          fact:
            "The current invoice obligation has no executable priced line set.",
        },
      );
    throw new SesActionError(409, blocker);
  }
  if (
    ["superseded", "void_linked"].includes(String(revision.state || ""))
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "This invoice obligation revision is no longer current (superseded or void-linked); prepare a fresh revision before minting a Xero DRAFT.",
    });
  }
  if (
    ["authorised", "released"].includes(String(revision.state || ""))
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "This obligation is already past DRAFT mint; use the bound invoice or a post-release disposition.",
    });
  }

  const proposal = revision.proposal as SesInvoiceProposalV1;
  const externalRef = String(
    proposal?.reference || revision.reference || "",
  ).trim();
  if (!externalRef) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The invoice obligation has no builder reference, so the duplicate-invoice guard cannot run.",
    });
  }

  // ── MANDATORY DUP GUARD (unskippable) — before any effect or Xero create ──
  const fetchAll = deps.fetchAllAccrecInvoices || fetchAllAccrecInvoices;
  let accrecRows: any[];
  try {
    accrecRows = await fetchAll(client);
  } catch (error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The full live ACCREC duplicate-invoice scan failed (${
        (error as Error)?.message || "unknown error"
      }).`,
    });
  }
  const existingHit = resolveExistingInvoice(
    accrecRows,
    args.job_id,
    externalRef,
  );
  if (existingHit) {
    const binding = object(revision.xero_binding);
    const boundId = String(binding.xero_invoice_id || "");
    const hitId = String(existingHit.xero_invoice_id || "");
    const hitIsDraft = String(existingHit.status || "").toUpperCase() ===
      "DRAFT";
    const sameBoundDraft = !!boundId && !!hitId && boundId === hitId &&
      hitIsDraft;
    // Idempotent re-mint: the live hit is already this obligation's SES-bound DRAFT.
    const hitRow = (accrecRows || []).find((row) =>
      String(row?.xero_invoice_id || "") === hitId
    );
    const sameObligation = hitIsDraft && !!hitRow &&
      String(hitRow.invoice_obligation_revision_id || "") ===
        String(revision.id);
    if (sameBoundDraft || sameObligation) {
      // Repair, never assume: a first mint whose Xero create landed but whose
      // binding write did not would otherwise be stranded unapprovable here.
      const repairEffect = await buildSesEffect({
        org_id: args.org_id,
        job_id: args.job_id,
        effect_kind: "invoice_create",
        invoice_obligation_revision_id: revision.id,
        payload: proposal,
      });
      const repairInvoice = {
        xero_invoice_id: String(existingHit.xero_invoice_id || ""),
        invoice_number: String(existingHit.invoice_number || ""),
        status: String(existingHit.status || ""),
        reference: String(hitRow?.reference || externalRef),
        total: Number(existingHit.total ?? 0),
      };
      // Prefer any PDF already stamped on the live binding; otherwise fetch the
      // real Xero DRAFT PDF so the Invoice tab never falls back to a local HTML
      // invention on an idempotent re-mint.
      const existingPdfKey = String(
        object(revision.xero_binding).pdf_object_key || "",
      ).trim();
      const existingPdfHash = String(
        object(revision.xero_binding).pdf_content_hash || "",
      ).trim();
      const draftPdf = existingPdfKey && existingPdfHash
        ? {
          pdf_object_key: existingPdfKey,
          pdf_content_hash: existingPdfHash,
          pdf_size_bytes:
            Number(object(revision.xero_binding).pdf_size_bytes) ||
            0,
          pdf_stored_at: String(
            object(revision.xero_binding).pdf_stored_at || "",
          ),
        }
        : await tryStoreSesDraftInvoicePdf(client, gateway, {
          job_id: args.job_id,
          invoice: repairInvoice,
        });
      await bindSesDraftInvoiceToRevision(client, {
        org_id: args.org_id,
        job_id: args.job_id,
        invoice_obligation_revision_id: revision.id,
        external_token: String(
          hitRow?.ses_external_token || repairEffect.external_token,
        ),
        invoice: repairInvoice,
        draft_pdf: draftPdf,
      });
      return {
        state: "xero_draft_created",
        skipped: true,
        reason: "existing_ses_bound_draft",
        invoice: {
          xero_invoice_id: existingHit.xero_invoice_id,
          invoice_number: existingHit.invoice_number,
          status: existingHit.status,
          reference: externalRef,
          total: existingHit.total ?? 0,
        },
        draft_pdf: draftPdf
          ? {
            content_hash: draftPdf.pdf_content_hash,
            size_bytes: draftPdf.pdf_size_bytes,
            object_key: draftPdf.pdf_object_key,
          }
          : null,
        match_method: existingHit.match_method,
        scanned_accrec: accrecRows.length,
        invoice_create_dispatched: false,
        send_dispatched: false,
        external_mutations: { xero: 0, email: 0 },
      };
    }
    const ino = existingHit.invoice_number || "?";
    const st = existingHit.status || "?";
    throw new SesActionError(
      409,
      sesRefusal(
        "invoice_duplicate_live",
        "Use the existing live invoice or void it before minting a new DRAFT on this card.",
        {
          fact:
            `${externalRef} already has ${ino} (${st}) — no new invoice created (matched via ${existingHit.match_method}; scanned ${accrecRows.length} ACCREC invoices).`,
          evidence: {
            existing_invoice: {
              invoice_number: existingHit.invoice_number,
              status: existingHit.status,
              xero_invoice_id: existingHit.xero_invoice_id,
              match_method: existingHit.match_method,
            },
            scanned_accrec: accrecRows.length,
          },
        },
      ),
    );
  }

  // Optional SES obligation-index probe — never replaces the full-set guard above.
  const indexedRows = await loadIndexedInvoiceRows(client, args.org_id, [{
    job_id: args.job_id,
    external_ref: externalRef,
    obligation_revision_id: revision.id,
  }]);
  const [duplicate] = resolveSesInvoiceDuplicates([{
    job_id: args.job_id,
    external_ref: externalRef,
    obligation_revision_id: revision.id,
  }], indexedRows);
  if (
    !duplicate.allows_create &&
    duplicate.match_tier !== "obligation_binding"
  ) {
    throw new SesActionError(
      409,
      duplicate.ambiguity === "multi_live"
        ? sesRefusal(
          "invoice_duplicate_ambiguous",
          "Resolve which Xero invoice owns this work before minting a DRAFT.",
        )
        : sesRefusal(
          "invoice_duplicate_live",
          "Use the live invoice already bound to this work; no second invoice can be created.",
        ),
    );
  }

  const store = createSupabaseSesEffectStore(client);
  const createEffect = await buildSesEffect({
    org_id: args.org_id,
    job_id: args.job_id,
    effect_kind: "invoice_create",
    invoice_obligation_revision_id: revision.id,
    payload: proposal,
  });
  const createAdapter: SesExternalAdapter<
    SesInvoiceProposalV1,
    SesXeroInvoiceResult
  > = {
    dispatch: (payload, context) => gateway.createDraft(payload, context),
    reconcile: (context) => gateway.reconcileCreate(context.external_token),
    identify: (result) => result.xero_invoice_id,
    digest: (result) => ({
      invoice_number: result.invoice_number,
      status: result.status,
      reference: result.reference,
      total: result.total,
    }),
  };
  const created = await executeSesExternalEffect({
    store,
    effect: createEffect,
    payload: proposal,
    adapter: createAdapter,
    actor: args.actor,
  });
  if (created.state !== "confirmed") {
    throw new SesActionError(409, created.refusal!);
  }
  const createdInvoice = created.result ||
    await gateway.reconcileCreate(createEffect.external_token).then((rows) =>
      rows[0]
    );
  if (!createdInvoice) {
    throw new SesActionError(
      409,
      sesRefusal(
        "xero_outcome_unknown",
        "Reconcile Xero by the exact SES token before resuming.",
      ),
    );
  }
  if (String(createdInvoice.status || "").toUpperCase() !== "DRAFT") {
    throw new SesActionError(409, {
      state: "refused",
      fact: `SES draft mint requires Xero status DRAFT; got ${
        createdInvoice.status || "unknown"
      }.`,
    });
  }
  // Preferred shape: store the real Xero DRAFT PDF at mint so the cockpit can
  // show INV-n before APPROVE. Soft-fail when Xero PDF is temporarily down —
  // mint still succeeds; pack/cockpit then report "document unavailable".
  const draftPdf = await tryStoreSesDraftInvoicePdf(client, gateway, {
    job_id: args.job_id,
    invoice: createdInvoice,
  });
  await bindSesDraftInvoiceToRevision(client, {
    org_id: args.org_id,
    job_id: args.job_id,
    invoice_obligation_revision_id: revision.id,
    external_token: createEffect.external_token,
    invoice: createdInvoice,
    draft_pdf: draftPdf,
  });

  return {
    state: "xero_draft_created",
    invoice: createdInvoice,
    draft_pdf: draftPdf
      ? {
        content_hash: draftPdf.pdf_content_hash,
        size_bytes: draftPdf.pdf_size_bytes,
        object_key: draftPdf.pdf_object_key,
      }
      : null,
    invoice_create_dispatched: created.dispatched,
    send_dispatched: false,
    scanned_accrec: accrecRows.length,
    external_mutations: {
      xero: created.dispatched ? 1 : 0,
      email: 0,
    },
  };
}

const SES_EFFECT_CONTENT_DRIFT_SQLSTATE = "23505";

const SES_EFFECT_CLAIM_COLUMNS = [
  "id",
  "operation_key",
  "org_id",
  "job_id",
  "effect_kind",
  "invoice_obligation_revision_id",
  "release_revision_id",
  "docket_revision_id",
  "route_kind",
  "artifact_hash",
  "payload_hash",
  "external_token",
  "state",
  "external_id",
  "provider_digest",
].join(",");

/**
 * `claim_ses_external_effect_v1` raises SQLSTATE 23505 when an existing
 * operation_key's stored content no longer matches the caller's. That guard is
 * correct, but on its own it strands an already-dispatched effect: the
 * temporary MLB ordinary Mail.Send exception changes the route_send payload
 * (transport stamp, cleared reply_to_thread_id), so re-running `execute` on a
 * release whose route already reached `unknown` recomputes a different
 * payload_hash for the SAME operation_key and can never reach reconcile.
 *
 * Resolution is reconcile-only and never redispatch: re-read the stored row and
 * return the ORIGINAL effect (original external_token, payload_hash and state),
 * which is exactly the claim the SQL would have returned had the payload not
 * drifted. Dispatch stays structurally unreachable here — only a freshly
 * INSERTED reservation ever claims `dispatch`, and a new release_revision_id
 * mints a new operation_key rather than reusing this one.
 *
 * Identity drift must still refuse. effect_kind and external_token are derived
 * from the same identity hash as operation_key, so a stored row disagreeing on
 * either is a real collision, not payload drift: return null and let the
 * original refusal stand. Returns null on any unreadable row for the same
 * reason — an unproven effect must never be reported as reconcilable.
 */
async function reconcileSesEffectAfterContentDrift(
  client: SesSupabaseClient,
  effect: Omit<SesExternalEffect, "state">,
  error: { message?: string; code?: string } | null,
): Promise<SesEffectClaim | null> {
  if (
    String(error?.code || "").trim() !== SES_EFFECT_CONTENT_DRIFT_SQLSTATE
  ) {
    return null;
  }
  const existing = await client.from("ses_external_effects")
    .select(SES_EFFECT_CLAIM_COLUMNS)
    .eq("operation_key", effect.operation_key)
    .maybeSingle();
  if (existing.error || !existing.data) return null;
  const stored = existing.data as SesExternalEffect;
  if (
    String(stored.operation_key || "") !== effect.operation_key ||
    String(stored.effect_kind || "") !== effect.effect_kind ||
    String(stored.external_token || "") !== effect.external_token
  ) {
    return null;
  }
  return {
    effect: stored,
    claim_mode: stored.state === "confirmed" ? "confirmed" : "reconcile",
    duplicate_refused: true,
  };
}

export function createSupabaseSesEffectStore(
  client: SesSupabaseClient,
): SesExternalEffectStore {
  return {
    async claim(effect, leaseOwner) {
      const claimed = await client.rpc("claim_ses_external_effect_v1", {
        p_effect: effect,
        p_lease_owner: leaseOwner,
        p_lease_seconds: 120,
      });
      if (claimed.error) {
        const reconciled = await reconcileSesEffectAfterContentDrift(
          client,
          effect,
          claimed.error,
        );
        if (reconciled) return reconciled;
      }
      return requireValue(
        claimed,
        "The exact external-effect reservation could not be claimed.",
      );
    },
    async transition(operationKey, from, to, eventKind, detail, actor) {
      return requireValue(
        await client.rpc("transition_ses_external_effect_v1", {
          p_operation_key: operationKey,
          p_from_state: from,
          p_to_state: to,
          p_event_kind: eventKind,
          p_detail: detail,
          p_actor: actor,
        }),
        "The exact external-effect ledger could not record its next state.",
      );
    },
  };
}

async function loadOperatorAuth(
  client: SesSupabaseClient,
  auth: SesActionAuth,
): Promise<SesApprovalAuth> {
  if (auth.mode === "api_key" || auth.mode === "routine") {
    return { mode: auth.mode };
  }
  if (!auth.user) {
    throw new SesActionError(401, {
      state: "refused",
      fact: "The identified SES operator session is missing.",
    });
  }
  const operator = await client.from("ses_release_operators")
    .select("operator_class").eq("user_id", auth.user.id).eq("active", true)
    .maybeSingle();
  if (operator.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The SES operator allowlist could not be read (${
        operator.error.message || "unknown database error"
      }).`,
    });
  }
  return {
    mode: "jwt",
    user_id: auth.user.id,
    role: auth.user.role,
    operator_class: operator.data?.operator_class || null,
  };
}

async function requireSesDocsReadyViewer(
  client: SesSupabaseClient,
  auth: SesActionAuth,
) {
  if (auth.mode === "api_key") return;
  const operator = await loadOperatorAuth(client, auth);
  if (
    !canManageSesDocsReadySignoff({
      mode: operator.mode,
      role: operator.mode === "jwt" ? operator.role : null,
      operator_class: operator.mode === "jwt" ? operator.operator_class : null,
    })
  ) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "The Docs Ready review pack is restricted to the Captain, an admin-owner, or the privileged ops key.",
    });
  }
}

async function requireSesDocsReadySigner(
  client: SesSupabaseClient,
  auth: SesActionAuth,
) {
  const operator = await loadOperatorAuth(client, auth);
  if (
    operator.mode !== "jwt" || !auth.user ||
    !canManageSesDocsReadySignoff({
      mode: operator.mode,
      role: operator.role,
      operator_class: operator.operator_class,
    })
  ) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "Docs Ready signoff requires an identified Captain or admin-owner session; API and automation keys cannot tick or revoke it.",
    });
  }
  return operator;
}

export async function listSesDocsReadyReviewsAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  limit = 50,
) {
  await requireSesDocsReadyViewer(client, auth);
  const safeLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(limit, 100))
    : 50;
  const response = await client.from("ses_docket_review_current").select(
    "org_id,job_id,docket_revision_id,docket_output_content_hash,assembler_version,family_matrix_version,docket_stage,docket_committed_at,review_event_id,review_event_sequence,review_state,event_kind,review_state_changed_at,invalidated_signoff_event_id",
  ).eq("review_state", "needs_review")
    .order("review_state_changed_at", { ascending: true })
    .limit(safeLimit);
  if (response.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The Docs Ready review queue could not be read (${
        response.error.message || "unknown database error"
      }).`,
    });
  }
  const dockets = response.data || [];
  if (dockets.length === 0) {
    return { state: "needs_review", dockets: [] };
  }
  const revisionIds = dockets.map((row: any) => row.docket_revision_id);
  const proposalResponse = await client.from("makesafe_docket_revisions")
    .select("id,local_invoice_proposal")
    .in("id", revisionIds);
  if (proposalResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The Docs Ready invoice proposal summaries could not be read (${
        proposalResponse.error.message || "unknown database error"
      }).`,
    });
  }
  const proposalByRevision = new Map(
    (proposalResponse.data || []).map((row: any) => [
      String(row.id),
      row.local_invoice_proposal ?? null,
    ]),
  );
  return {
    state: "needs_review",
    dockets: dockets.map((row: any) => ({
      ...row,
      local_invoice_proposal:
        proposalByRevision.get(String(row.docket_revision_id)) ?? null,
    })),
  };
}

export async function getSesReviewablePackAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  docketRevisionId: string,
  deps: {
    fetchInvoicePdfBytes?: (invoiceId: string) => Promise<Uint8Array>;
  } = {},
) {
  await requireSesDocsReadyViewer(client, auth);
  if (!docketRevisionId) {
    throw new SesActionError(400, {
      state: "refused",
      fact: "docket_revision_id is required.",
    });
  }
  const review = requireValue(
    await client.from("ses_docket_review_current").select("*")
      .eq("docket_revision_id", docketRevisionId).maybeSingle(),
    "The requested docket is no longer the current reviewable pack.",
  );
  const docket = requireValue(
    await client.from("makesafe_docket_revisions").select(
      "id,org_id,job_id,output_content_hash,assembler_version,family_matrix_version,stage,committed_at,envelope,blockers,email_drafts,review_spec,local_invoice_proposal,xero_binding,artifact_count,artifact_size_bytes,invoice_obligation_revision_id",
    ).eq("id", docketRevisionId).maybeSingle(),
    "The exact reviewable docket revision no longer exists.",
  );
  if (
    review.docket_output_content_hash !== docket.output_content_hash ||
    review.assembler_version !== docket.assembler_version ||
    review.family_matrix_version !== docket.family_matrix_version
  ) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Reload the current Docs Ready queue and open the exact current pack.",
      ),
    );
  }
  const reviewManifest = object(object(docket.envelope).v2);
  const reviewFamily = String(
    object(reviewManifest.classification).family || "",
  );
  const physicalReview = reviewFamily === "physical_makesafe" ||
    reviewFamily === "temporary_fencing";
  const artifactsResponse = await client.from("makesafe_docket_artifacts")
    .select("id,role,object_key,media_type,content_hash,size_bytes,metadata")
    .eq("revision_id", docketRevisionId)
    .order("object_key");
  if (artifactsResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The reviewable pack artifacts could not be read (${
        artifactsResponse.error.message || "unknown database error"
      }).`,
    });
  }
  const supersessions = physicalReview
    ? await loadSesCuratedSourceSupersessions(client, String(docket.job_id))
    : [];
  const projectedArtifacts = await Promise.all(
    (artifactsResponse.data || []).map(async (artifact: any) => {
      if (physicalReview && artifact.role === "supporting_report_pdf") {
        const trust = await verifyStoredSupportingReport(
          client,
          artifact,
          supersessions,
        );
        if (!trust.trusted) {
          return {
            suppressed: true as const,
            artifact: {
              role: artifact.role,
              media_type: artifact.media_type,
              content_hash: artifact.content_hash,
              size_bytes: artifact.size_bytes,
              signed_url: null,
              trust_state: "blocked",
              blocker_code: "curated_source_missing",
              suppression_reason: trust.reason,
            },
          };
        }
      }
      const prefix = `${SES_DOCKET_BUCKET}/`;
      const objectKey = String(artifact.object_key || "");
      if (!objectKey.startsWith(prefix)) {
        throw new SesActionError(503, {
          state: "refused",
          fact:
            "A reviewable pack artifact points outside the private SES docket bucket.",
        });
      }
      const signed = await client.storage.from(SES_DOCKET_BUCKET)
        .createSignedUrl(objectKey.slice(prefix.length), 300);
      if (signed.error || !signed.data?.signedUrl) {
        throw new SesActionError(503, {
          state: "refused",
          fact: `A reviewable pack artifact URL could not be signed (${
            signed.error?.message || objectKey
          }).`,
        });
      }
      return {
        suppressed: false as const,
        artifact: {
          ...artifact,
          display_label: sesReviewArtifactDisplayLabel(artifact.role),
          signed_url: signed.data.signedUrl,
          signed_url_expires_in_seconds: 300,
        },
      };
    }),
  );
  let artifacts = projectedArtifacts.filter((entry) => !entry.suppressed)
    .map((entry) => entry.artifact);
  const suppressedArtifacts: Array<Record<string, any>> = projectedArtifacts
    .filter((entry) => entry.suppressed).map((entry) => entry.artifact);
  let sourceRefusal: SesRefusal | null = null;
  if (physicalReview) {
    const trustedReports = artifacts.filter((artifact: any) =>
      artifact.role === "supporting_report_pdf"
    );
    if (trustedReports.length !== 1) {
      sourceRefusal = curatedSourceMissingRefusal(
        String(
          suppressedArtifacts[0]?.suppression_reason ||
            (trustedReports.length === 0
              ? "supporting_report_pdf_missing"
              : "multiple_supporting_report_pdfs"),
        ),
      );
    }
  }

  // Bound Xero DRAFT: surface the REAL Xero PDF on the Invoice tab. Option B
  // mint stores it on the obligation binding; AUTHORISED binds live on the
  // docket. Never leave the cockpit inventing a local tax-invoice HTML page
  // when a genuine DRAFT document exists (or must be reported unavailable).
  const obligationForPack = await readSesObligationForDocket(client, {
    job_id: docket.job_id,
    invoice_obligation_revision_id: docket.invoice_obligation_revision_id,
    columns: "id,xero_binding,pricing_disposition,state",
  });
  if (obligationForPack.error) {
    // Fail closed: an unreadable obligation hides a bound DRAFT, and degrading
    // to null would silently hand the Invoice tab back to the local proposal.
    throw new SesActionError(503, {
      state: "refused",
      fact: `The invoice obligation behind this pack could not be read (${
        obligationForPack.error.message || "unknown database error"
      }).`,
    });
  }
  const packObligation = obligationForPack.data || null;
  const routeBinding = resolveSesRouteXeroBinding(docket, packObligation);
  const boundDraftStatus = String(routeBinding.status || "").toUpperCase();
  let invoicePdfProjection: {
    source: string;
    pdf_unavailable: boolean;
    xero_invoice_id: string | null;
    invoice_number: string | null;
  } | null = null;
  if (
    String(routeBinding.xero_invoice_id || "").trim() &&
    boundDraftStatus === "DRAFT"
  ) {
    const resolved = await resolveSesBoundDraftInvoicePdfArtifact(client, {
      job_id: String(docket.job_id),
      docket,
      obligation: packObligation,
      fetchInvoicePdfBytes: deps.fetchInvoicePdfBytes,
    });
    // Drop any non-matching xero_invoice_pdf so a stale local concoction cannot
    // occupy the Invoice tab ahead of the bound DRAFT document. Every dropped
    // row is recorded so the Captain who ticks this pack can see what left it.
    const resolvedObjectKey = String(resolved.artifact.object_key || "");
    for (const artifact of artifacts) {
      if (artifact.role !== "xero_invoice_pdf") continue;
      if (
        resolvedObjectKey &&
        String(artifact.object_key || "") === resolvedObjectKey
      ) {
        continue;
      }
      suppressedArtifacts.push({
        ...artifact,
        signed_url: null,
        trust_state: "suppressed",
        suppression_reason: "xero_invoice_pdf_not_bound_draft",
      });
    }
    artifacts = artifacts.filter((artifact) =>
      artifact.role !== "xero_invoice_pdf"
    );
    artifacts.push(resolved.artifact);
    invoicePdfProjection = {
      source: resolved.source,
      pdf_unavailable: resolved.artifact.pdf_unavailable === true ||
        !resolved.artifact.signed_url,
      xero_invoice_id: String(routeBinding.xero_invoice_id || "") || null,
      invoice_number: String(routeBinding.invoice_number || "") || null,
    };
  }

  const historyResponse = await client.from("ses_docket_review_events").select(
    "id,event_sequence,review_state,event_kind,actor_user_id,actor_identity,reason,signed_off_at,created_at,docket_output_content_hash,assembler_version,family_matrix_version,invalidated_signoff_event_id",
  ).eq("docket_revision_id", docketRevisionId)
    .order("event_sequence", { ascending: true });
  if (historyResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The review audit trail could not be read (${
        historyResponse.error.message || "unknown database error"
      }).`,
    });
  }
  const storedBlockers: Record<string, unknown>[] =
    Array.isArray(docket.blockers)
      ? (docket.blockers as Record<string, unknown>[])
      : [];
  const reviewBlockers: Record<string, unknown>[] = sourceRefusal
    ? [...storedBlockers, sourceRefusal as unknown as Record<string, unknown>]
    : storedBlockers;
  const envelope = object(docket.envelope);
  // Presentation honesty for the review surface: a green READY tick over a
  // trust refusal is the defect this field removes. Kind is refused / ready /
  // incomplete — never collapsed into a single warning.
  const presentation = presentSesPackHonesty({
    docket: {
      id: docket.id,
      state: docket.state ?? null,
      pre_xero_docs_ready: envelope.pre_xero_docs_ready === true ||
        docket.pre_xero_docs_ready === true,
      blockers: storedBlockers,
    },
    review_blockers: sourceRefusal ? [sourceRefusal] : [],
  });
  // Enrich the ORIGINAL refusal objects rather than rebuilding them from the
  // normalized shape: `evidence` and `decision_key` are the only things telling
  // curated_source_superseded apart from supporting_report_pdf_missing.
  const normalizedBlockerByCode = new Map(
    presentation.blockers.map((blocker) => [blocker.code, blocker]),
  );
  const responseBlockers = reviewBlockers.map((raw) => {
    const source: Record<string, unknown> = raw && typeof raw === "object"
      ? { ...(raw as Record<string, unknown>) }
      : { fact: String(raw ?? "") };
    const code = String(
      source.code || source.reason_code || source.reasonCode ||
        "",
    ).trim();
    const normalized = code ? normalizedBlockerByCode.get(code) : undefined;
    const fact = String(source.fact || source.reason || source.message || "")
      .trim();
    const recovery = String(
      source.recovery_action || source.recoveryAction || "",
    ).trim();
    return {
      ...source,
      state: "refused" as const,
      code,
      fact: fact || normalized?.fact || `Pack refused: ${code}.`,
      recovery_action: recovery || normalized?.recovery_action ||
        "Resolve the named refusal and re-prepare the pack.",
      category: String(source.category || normalized?.category || "ses_docket"),
    };
  });
  return {
    review,
    docket: sourceRefusal
      ? {
        ...docket,
        blockers: reviewBlockers,
      }
      : docket,
    artifacts,
    suppressed_artifacts: suppressedArtifacts,
    // All named refusals (stored + read-time trust), not only sourceRefusal.
    blockers: responseBlockers,
    // Operator-facing honesty: ready vs refused vs incomplete, with reason.
    presentation: {
      kind: presentation.kind,
      state: presentation.state,
      reason: presentation.reason,
      pre_xero_docs_ready: presentation.pre_xero_docs_ready,
      review_state: presentation.review_state,
      docket_revision_id: presentation.docket_revision_id,
    },
    audit_trail: historyResponse.data || [],
    // Explicit Invoice-tab projection for bound DRAFTs: the UI must prefer the
    // real Xero PDF (or honest unavailable) over any local proposal invention.
    invoice_pdf: invoicePdfProjection,
  };
}

export async function signOffSesDocketAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    docket_revision_id: string;
    expected_output_content_hash: string;
  },
) {
  await requireSesDocsReadySigner(client, auth);
  if (
    !String(args.docket_revision_id || "").trim() ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(args.expected_output_content_hash || ""),
    )
  ) {
    throw new SesActionError(400, {
      state: "refused",
      fact:
        "docket_revision_id and the exact displayed SHA-256 output hash are required.",
    });
  }
  const current = requireValue(
    await client.from("ses_docket_review_current").select(
      "docket_revision_id,docket_output_content_hash,review_state",
    ).eq("docket_revision_id", args.docket_revision_id).maybeSingle(),
    "The requested docket is no longer the current reviewable pack.",
  );
  if (
    current.docket_output_content_hash !==
      args.expected_output_content_hash
  ) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Reload the current review pack and tick its exact displayed hash.",
      ),
    );
  }
  const displayedPack = await getSesReviewablePackAction(
    client,
    auth,
    args.docket_revision_id,
  );
  const sourceRefusal = displayedPack.blockers.find((blocker) =>
    blocker.code === "curated_source_missing"
  );
  if (sourceRefusal) {
    throw new SesActionError(409, sourceRefusal);
  }
  if (current.review_state !== "signed_off") {
    nextSesDocsReadyState(current.review_state, "signed_off");
  }
  const recorded = await client.rpc("record_ses_docket_review_state_v1", {
    p_event: {
      docket_revision_id: args.docket_revision_id,
      event_kind: "signed_off",
      expected_output_content_hash: args.expected_output_content_hash,
      actor_user_id: auth.user!.id,
      actor_identity: auth.user!.email || auth.user!.id,
      reason: "Captain approved the exact displayed pack bytes.",
    },
  });
  return {
    review: requireValue(
      recorded,
      "The exact Docs Ready signoff could not be recorded.",
    ),
  };
}

export async function revokeSesDocketSignoffAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    docket_revision_id: string;
    expected_output_content_hash: string;
    reason: string;
  },
) {
  await requireSesDocsReadySigner(client, auth);
  if (
    !String(args.docket_revision_id || "").trim() ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(args.expected_output_content_hash || ""),
    )
  ) {
    throw new SesActionError(400, {
      state: "refused",
      fact:
        "docket_revision_id and the exact displayed SHA-256 output hash are required.",
    });
  }
  if (!String(args.reason || "").trim()) {
    throw new SesActionError(400, {
      state: "refused",
      fact: "A concrete signoff revocation reason is required.",
    });
  }
  const current = requireValue(
    await client.from("ses_docket_review_current").select(
      "docket_revision_id,docket_output_content_hash,review_state",
    ).eq("docket_revision_id", args.docket_revision_id).maybeSingle(),
    "The requested docket is no longer the current reviewable pack.",
  );
  if (
    current.docket_output_content_hash !==
      args.expected_output_content_hash
  ) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Reload the current review pack before revoking its exact signoff.",
      ),
    );
  }
  nextSesDocsReadyState(current.review_state, "revoked");
  const recorded = await client.rpc("record_ses_docket_review_state_v1", {
    p_event: {
      docket_revision_id: args.docket_revision_id,
      event_kind: "revoked",
      expected_output_content_hash: args.expected_output_content_hash,
      actor_user_id: auth.user!.id,
      actor_identity: auth.user!.email || auth.user!.id,
      reason: args.reason.trim(),
    },
  });
  return {
    review: requireValue(
      recorded,
      "The exact Docs Ready signoff revocation could not be recorded.",
    ),
  };
}

export const SES_DOCKET_RETIRE_REASON_CODES = [
  "already_reported",
  "wrong_family",
  "superseded",
  "captain_ruling",
] as const;
export type SesDocketRetireReasonCode =
  typeof SES_DOCKET_RETIRE_REASON_CODES[number];

async function requireSesDocketRetireAuthority(
  client: SesSupabaseClient,
  auth: SesActionAuth,
) {
  if (auth.mode === "api_key") return;
  const operator = await loadOperatorAuth(client, auth);
  if (
    !canManageSesDocsReadySignoff({
      mode: operator.mode,
      role: operator.mode === "jwt" ? operator.role : null,
      operator_class: operator.mode === "jwt" ? operator.operator_class : null,
    })
  ) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "Retiring a Docs Ready docket is restricted to the Captain, an admin-owner, or the privileged ops key; the automation routine can never evict a docket from the review queue.",
    });
  }
}

export async function retireSesDocketRevisionAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    docket_revision_id: string;
    reason_code: string;
    reason_text?: string;
    actor?: string;
  },
) {
  await requireSesDocketRetireAuthority(client, auth);
  const docketRevisionId = String(args.docket_revision_id || "").trim();
  const reasonCode = String(args.reason_code || "").trim();
  if (
    !docketRevisionId ||
    !(SES_DOCKET_RETIRE_REASON_CODES as readonly string[]).includes(reasonCode)
  ) {
    throw new SesActionError(400, {
      state: "refused",
      fact:
        "docket_revision_id and a reason_code of already_reported, wrong_family, superseded or captain_ruling are required.",
    });
  }
  const reasonText = String(args.reason_text || "").trim();
  const docket = requireValue(
    await client.from("makesafe_docket_revisions").select("id")
      .eq("id", docketRevisionId).maybeSingle(),
    "The requested docket revision no longer exists.",
  );
  const current = await client.from("makesafe_docket_revisions_current")
    .select("id").eq("id", docketRevisionId).maybeSingle();
  if (current.error || !current.data) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The requested docket is no longer the current exact revision for its job; only the current revision can be retired from the review queue.",
    });
  }
  const latest = await client.from("ses_docket_review_events").select(
    "id,review_state,event_kind",
  ).eq("docket_revision_id", docketRevisionId)
    .order("event_sequence", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The review audit trail could not be read (${
        latest.error.message || "unknown database error"
      }).`,
    });
  }
  if (!latest.data) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The requested docket is not waiting in the Docs Ready review queue.",
    });
  }
  if (latest.data.review_state === "retired") {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The requested docket is already retired; no second retire event was recorded.",
    });
  }
  nextSesDocsReadyState(latest.data.review_state, "retired");
  const recorded = await client.rpc("retire_ses_docket_revision_v1", {
    p_event: {
      docket_revision_id: docket.id,
      retire_reason_code: reasonCode,
      reason: reasonText || null,
      actor_user_id: auth.mode === "jwt" && auth.user ? auth.user.id : null,
      actor_identity: auth.mode === "jwt" && auth.user
        ? auth.user.email || auth.user.id
        : String(args.actor || "").trim() || "ops-api-key",
    },
  });
  return {
    review: requireValue(
      recorded,
      "The exact docket retire could not be recorded.",
    ),
  };
}

export async function approveSesInvoiceRevisionAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    job_id: string;
    includes_authorise: boolean;
    evidence_refs?: unknown[];
  },
) {
  const docket = await loadSesCockpitDocket(client, args.job_id);
  if (
    docket.clean_input.pricing_disposition === "no_additional_charge"
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "This later attendance is explicitly no additional charge, so there is no Xero invoice action to approve; review the document-only routes and use SEND IT.",
    });
  }
  const verdict = evaluateSesMechanicalClean(docket.clean_input);
  const operatorAuth = await loadOperatorAuth(client, auth);
  const authority = canRecordSesApproval(operatorAuth, verdict);
  if (!authority.allowed || operatorAuth.mode !== "jwt" || !auth.user) {
    throw new SesActionError(403, {
      state: "refused",
      fact: authority.refusal ||
        "This identified operator cannot approve the current invoice revision.",
    });
  }
  const cockpit = buildSesCockpitView(docket);
  if (
    !cockpit.controls.approve_invoice.enabled && !authority.captain_override
  ) {
    const blocker = verdict.blockers[0] ||
      sesRefusal(
        "invoice_approval_missing",
        "Resolve the current cockpit hold and review a fresh invoice revision.",
        {
          fact:
            "No current executable invoice obligation revision is bound to this cockpit.",
        },
      );
    throw new SesActionError(409, blocker);
  }
  const contentHash = await sesSha256({
    action: "invoice",
    docket_revision_id: docket.docket_revision_id,
    invoice_obligation_revision_id: docket.invoice_obligation_revision_id,
    readiness_revision: docket.readiness_revision,
    dependency_generation: docket.dependency_generation,
    includes_authorise: args.includes_authorise,
  }, "SecureWorks:ses-approval-content:v1\n");
  const approved = await client.rpc("record_ses_revision_approval_v1", {
    p_approval: {
      org_id: args.org_id,
      job_id: args.job_id,
      action: "invoice",
      operator_id: auth.user.id,
      is_admin_owner: ["admin", "owner"].includes(auth.user.role),
      clean: verdict.clean,
      captain_override: authority.captain_override,
      readiness_revision: docket.readiness_revision,
      dependency_generation: docket.dependency_generation,
      docket_revision_id: docket.docket_revision_id,
      invoice_obligation_revision_id: docket.invoice_obligation_revision_id,
      approval_content_hash: contentHash,
      includes_authorise: args.includes_authorise,
      decided_by: auth.user.email || auth.user.id,
      evidence_refs: args.evidence_refs || [],
    },
  });
  return {
    approval: requireValue(
      approved,
      "The invoice approval could not be recorded.",
    ),
    controls: {
      approve_invoice: "recorded",
      send_it: "not_recorded",
    },
  };
}

export interface SesXeroInvoiceResult {
  xero_invoice_id: string;
  invoice_number: string;
  status: string;
  reference: string;
  total: number;
}

export interface SesXeroGateway {
  createDraft(
    proposal: SesInvoiceProposalV1,
    context: { external_token: string; operation_key: string },
  ): Promise<SesXeroInvoiceResult>;
  reconcileCreate(
    externalToken: string,
  ): Promise<SesXeroInvoiceResult[]>;
  authorise(
    invoice: SesXeroInvoiceResult,
    context: { external_token: string; operation_key: string },
  ): Promise<SesXeroInvoiceResult>;
  reconcileAuthorise(
    invoiceId: string,
  ): Promise<SesXeroInvoiceResult[]>;
  /**
   * Fetch the exact Xero-rendered invoice PDF bytes. Works for DRAFT and
   * AUTHORISED. The historical name predates Option B draft mint; callers that
   * need the real document for a bound DRAFT must use this same path (never a
   * local HTML/proposal invention).
   */
  fetchAuthorisedPdf(invoiceId: string): Promise<Uint8Array>;
}

/** Stored Xero DRAFT PDF pointer written onto the obligation binding. */
export type SesDraftInvoicePdfBinding = {
  pdf_object_key: string;
  pdf_content_hash: string;
  pdf_size_bytes: number;
  pdf_stored_at: string;
};

/**
 * Store the real Xero invoice PDF (DRAFT or AUTHORISED) under the private
 * docket bucket, keyed by job + Xero invoice id so re-mints are idempotent and
 * do not rewrite the current docket hash.
 */
export async function storeSesXeroInvoicePdfBytes(
  client: SesSupabaseClient,
  args: {
    job_id: string;
    invoice: Pick<
      SesXeroInvoiceResult,
      "xero_invoice_id" | "invoice_number" | "status"
    >;
    pdf: Uint8Array;
  },
): Promise<SesDraftInvoicePdfBinding> {
  const invoiceId = String(args.invoice.xero_invoice_id || "").trim();
  if (!invoiceId) {
    throw new TypeError("storeSesXeroInvoicePdfBytes requires xero_invoice_id");
  }
  if (!(args.pdf instanceof Uint8Array) || args.pdf.byteLength < 5) {
    throw new TypeError("storeSesXeroInvoicePdfBytes requires PDF bytes");
  }
  // %PDF magic — refuse storing a non-PDF concoction under the invoice role.
  const magic = String.fromCharCode(
    args.pdf[0],
    args.pdf[1],
    args.pdf[2],
    args.pdf[3],
  );
  if (magic !== "%PDF") {
    throw new TypeError("storeSesXeroInvoicePdfBytes requires a PDF payload");
  }
  const contentHash = await sesSha256Bytes(args.pdf);
  const invoiceNumber = String(args.invoice.invoice_number || invoiceId)
    .replace(/[^A-Za-z0-9._-]+/g, "_");
  const storagePath =
    `${args.job_id}/xero-invoice-pdfs/${invoiceId}/${invoiceNumber}.pdf`;
  const upload = await client.storage.from(SES_DOCKET_BUCKET).upload(
    storagePath,
    args.pdf,
    { contentType: "application/pdf", upsert: true },
  );
  if (
    upload.error &&
    !String(upload.error.message || "").toLowerCase().includes("already")
  ) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The real Xero invoice PDF could not be stored (${
        upload.error.message || "unknown storage error"
      }).`,
    });
  }
  return {
    pdf_object_key: `${SES_DOCKET_BUCKET}/${storagePath}`,
    pdf_content_hash: contentHash,
    pdf_size_bytes: args.pdf.byteLength,
    pdf_stored_at: new Date().toISOString(),
  };
}

async function signSesDocketObjectUrl(
  client: SesSupabaseClient,
  objectKey: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  const prefix = `${SES_DOCKET_BUCKET}/`;
  const key = String(objectKey || "");
  if (!key.startsWith(prefix)) return null;
  const signed = await client.storage.from(SES_DOCKET_BUCKET)
    .createSignedUrl(key.slice(prefix.length), expiresInSeconds);
  if (signed.error || !signed.data?.signedUrl) return null;
  return signed.data.signedUrl;
}

function matchingXeroInvoicePdfArtifact(
  artifacts: Array<Record<string, any>>,
  binding: Record<string, unknown>,
): Record<string, any> | null {
  const boundId = String(binding.xero_invoice_id || "").trim();
  const boundNumber = String(binding.invoice_number || "").trim();
  if (!boundId) return null;
  const matches = artifacts.filter((artifact) => {
    if (artifact.role !== "xero_invoice_pdf") return false;
    if (artifact.media_type && artifact.media_type !== "application/pdf") {
      return false;
    }
    const meta = object(artifact.metadata);
    return String(meta.xero_invoice_id || "") === boundId &&
      (!boundNumber || String(meta.invoice_number || "") === boundNumber ||
        !String(meta.invoice_number || "").trim());
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Stamp the recovered DRAFT PDF pointer onto the obligation binding from a READ
 * path. The row may have been authorised while the PDF was in flight, so the
 * write is state-guarded exactly like `bindSesDraftInvoiceToRevision` and is
 * additionally pinned to the same bound Xero invoice, and it merges onto the
 * row's CURRENT binding rather than replaying the stale read snapshot.
 */
async function stampSesObligationDraftPdfPointer(
  client: SesSupabaseClient,
  args: {
    obligation_id: string;
    bound_invoice_id: string;
    pdf: SesDraftInvoicePdfBinding;
  },
): Promise<void> {
  const currentResponse = await client.from(
    "makesafe_invoice_obligation_revisions",
  ).select("id,state,xero_binding").eq("id", args.obligation_id).maybeSingle();
  if (currentResponse.error || !currentResponse.data) return;
  const current = currentResponse.data;
  const currentBinding = object(current.xero_binding);
  if (
    !SES_DRAFT_BINDABLE_REVISION_STATES.includes(String(current.state || "")) ||
    String(currentBinding.xero_invoice_id || "").trim() !==
      args.bound_invoice_id ||
    String(currentBinding.status || "").toUpperCase() !== "DRAFT"
  ) {
    return;
  }
  await client.from("makesafe_invoice_obligation_revisions").update({
    xero_binding: { ...currentBinding, ...args.pdf },
  })
    .eq("id", args.obligation_id)
    .eq("xero_binding->>xero_invoice_id", args.bound_invoice_id)
    .in("state", SES_DRAFT_BINDABLE_REVISION_STATES)
    .select("id").maybeSingle();
}

/**
 * Once-per-interval brake on live Xero PDF fetches. The cockpit polls the pack
 * read, and a persistently unfetchable DRAFT would otherwise burn the shared
 * Xero rate budget that mint and authorise depend on.
 */
const SES_DRAFT_PDF_FETCH_RETRY_MS = 5 * 60_000;
const sesDraftPdfFetchFailures = new Map<string, number>();

function sesDraftPdfFetchIsCoolingDown(invoiceId: string): boolean {
  const failedAt = sesDraftPdfFetchFailures.get(invoiceId);
  if (failedAt === undefined) return false;
  if (Date.now() - failedAt < SES_DRAFT_PDF_FETCH_RETRY_MS) return true;
  sesDraftPdfFetchFailures.delete(invoiceId);
  return false;
}

/** Test seam: clear the process-local live-fetch backoff between cases. */
export function resetSesDraftPdfFetchBackoff(): void {
  sesDraftPdfFetchFailures.clear();
}

function recordSesDraftPdfFetchFailure(invoiceId: string): void {
  const now = Date.now();
  for (const [key, failedAt] of sesDraftPdfFetchFailures) {
    if (now - failedAt >= SES_DRAFT_PDF_FETCH_RETRY_MS) {
      sesDraftPdfFetchFailures.delete(key);
    }
  }
  sesDraftPdfFetchFailures.set(invoiceId, now);
}

/**
 * Ensure a bound Xero DRAFT is presented as the REAL Xero PDF on the Invoice
 * tab. A DRAFT stays editable in Xero right up to authorisation, so neither a
 * stored docket artifact nor a stamped `pdf_object_key` proves the bytes a
 * Captain is about to tick are the ones Xero would render now. The 2026-08-04
 * ruling is therefore to ALWAYS re-fetch through the same path as
 * `get_invoice_pdf`, and to report the document unavailable when that fetch
 * fails rather than serve stale stored bytes as live. Storing after a
 * successful fetch exists only so the pack can hand out a signed URL; the next
 * read re-fetches again. Never invents a local proposal PDF.
 */
export async function resolveSesBoundDraftInvoicePdfArtifact(
  client: SesSupabaseClient,
  args: {
    job_id: string;
    docket: Record<string, any>;
    obligation: Record<string, any> | null;
    fetchInvoicePdfBytes?: (invoiceId: string) => Promise<Uint8Array>;
  },
): Promise<{
  artifact: Record<string, any>;
  binding_pdf?: SesDraftInvoicePdfBinding | null;
  source: "live_fetch" | "unavailable";
}> {
  const binding = resolveSesRouteXeroBinding(args.docket, args.obligation);
  const boundId = String(binding.xero_invoice_id || "").trim();
  const boundNumber = String(binding.invoice_number || "").trim();
  const status = String(binding.status || "").toUpperCase();
  if (!boundId || status !== "DRAFT") {
    return {
      artifact: {
        role: "xero_invoice_pdf",
        media_type: "application/pdf",
        signed_url: null,
        pdf_unavailable: true,
        metadata: {
          reason: "no_bound_draft",
        },
      },
      source: "unavailable",
    };
  }

  let stored: SesDraftInvoicePdfBinding | null = null;
  let fetchCoolingDown = false;
  if (args.fetchInvoicePdfBytes) {
    if (sesDraftPdfFetchIsCoolingDown(boundId)) {
      fetchCoolingDown = true;
    } else {
      try {
        const pdf = await args.fetchInvoicePdfBytes(boundId);
        stored = await storeSesXeroInvoicePdfBytes(client, {
          job_id: args.job_id,
          invoice: {
            xero_invoice_id: boundId,
            invoice_number: boundNumber || boundId,
            status: "DRAFT",
          },
          pdf,
        });
        sesDraftPdfFetchFailures.delete(boundId);
        // Best-effort: stamp the obligation binding so later reads do not re-fetch.
        if (args.obligation?.id) {
          await stampSesObligationDraftPdfPointer(client, {
            obligation_id: String(args.obligation.id),
            bound_invoice_id: boundId,
            pdf: stored,
          });
        }
      } catch (error) {
        recordSesDraftPdfFetchFailure(boundId);
        console.error(
          "[ses] bound DRAFT Xero PDF could not be recovered for Invoice tab:",
          (error as Error)?.message || error,
        );
        stored = null;
      }
    }
  }

  if (stored?.pdf_object_key) {
    const signedUrl = await signSesDocketObjectUrl(
      client,
      stored.pdf_object_key,
    );
    return {
      artifact: {
        role: "xero_invoice_pdf",
        object_key: stored.pdf_object_key,
        media_type: "application/pdf",
        content_hash: stored.pdf_content_hash,
        size_bytes: stored.pdf_size_bytes,
        display_label: sesReviewArtifactDisplayLabel("xero_invoice_pdf"),
        signed_url: signedUrl,
        signed_url_expires_in_seconds: 300,
        pdf_unavailable: !signedUrl,
        metadata: {
          xero_invoice_id: boundId,
          invoice_number: boundNumber,
          status: "DRAFT",
          source: "live_fetch",
        },
      },
      binding_pdf: stored,
      source: "live_fetch",
    };
  }

  return {
    artifact: {
      role: "xero_invoice_pdf",
      media_type: "application/pdf",
      content_hash: null,
      size_bytes: 0,
      display_label: sesReviewArtifactDisplayLabel("xero_invoice_pdf"),
      signed_url: null,
      signed_url_expires_in_seconds: 0,
      pdf_unavailable: true,
      metadata: {
        xero_invoice_id: boundId,
        invoice_number: boundNumber,
        status: "DRAFT",
        reason: fetchCoolingDown
          ? "xero_draft_pdf_fetch_cooling_down"
          : "xero_draft_pdf_unavailable",
      },
    },
    source: "unavailable",
  };
}

async function currentInvoiceApproval(
  client: SesSupabaseClient,
  obligationRevisionId: string,
): Promise<Record<string, any>> {
  const response = await client.from("makesafe_revision_approvals_current_v2")
    .select("*").eq("action", "invoice")
    .eq("invoice_obligation_revision_id", obligationRevisionId)
    .order("decided_at", { ascending: false }).limit(1).maybeSingle();
  if (response.error || !response.data) {
    throw new SesActionError(
      409,
      sesRefusal(
        "invoice_approval_missing",
        "Open the current cockpit and press APPROVE INVOICE for this exact revision.",
      ),
    );
  }
  return response.data;
}

async function persistSesInvoiceMirror(
  client: SesSupabaseClient,
  args: {
    org_id: string;
    job_id: string;
    invoice_obligation_revision_id: string;
    external_token: string;
    invoice: SesXeroInvoiceResult;
  },
) {
  const result = await client.from("xero_invoices").upsert({
    org_id: args.org_id,
    xero_invoice_id: args.invoice.xero_invoice_id,
    invoice_number: args.invoice.invoice_number,
    invoice_type: "ACCREC",
    status: args.invoice.status,
    reference: args.invoice.reference,
    total: args.invoice.total,
    job_id: args.job_id,
    invoice_obligation_revision_id: args.invoice_obligation_revision_id,
    ses_external_token: args.external_token,
    synced_at: new Date().toISOString(),
  }, {
    onConflict: "org_id,xero_invoice_id",
  }).select("id").maybeSingle();
  requireValue(
    result,
    "The exact Xero invoice exists, but its job, obligation revision, and SES token mirror could not be stored; reconcile that invoice before resuming.",
  );
}

const SES_DRAFT_BINDABLE_REVISION_STATES = [
  "proposed",
  "pending_approval",
  "create_approved",
  "create_executed",
];

const SES_AUTHORISED_OBLIGATION_STATES = ["authorised", "released"] as const;

function moneyTotalsMatch(a: unknown, b: unknown): boolean {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.round(left * 100) === Math.round(right * 100);
}

/** True when PostgREST/Postgres reports the invoice-bound docket unique key hit. */
export function isSesInvoiceBoundDocketDuplicateKeyError(
  error: { message?: string } | null | undefined,
): boolean {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("duplicate key") &&
    (msg.includes("makesafe_docket_revisions_job_id_idempotency") ||
      msg.includes("ses-invoice-bound"));
}

function invoiceIdentityMatchesBinding(
  invoice: SesXeroInvoiceResult,
  binding: Record<string, unknown>,
): boolean {
  if (
    String(binding.xero_invoice_id || "").trim() !==
      String(invoice.xero_invoice_id || "").trim()
  ) {
    return false;
  }
  if (
    String(binding.invoice_number || "").trim() !==
      String(invoice.invoice_number || "").trim()
  ) {
    return false;
  }
  if (String(binding.status || "").toUpperCase() !== "AUTHORISED") return false;
  const storedTotal = Number(binding.total);
  if (
    Number.isFinite(storedTotal) && Number.isFinite(Number(invoice.total)) &&
    !moneyTotalsMatch(storedTotal, invoice.total)
  ) {
    return false;
  }
  return true;
}

/**
 * Load an existing invoice_bound docket for this job/obligation/INV identity.
 *
 * `adoptable` is returned ONLY for a bind whose `based_on_revision_id` is the
 * exact pre_xero base under review. A bind carrying the same AUTHORISED invoice
 * but a DIFFERENT base is reported separately in `same_invoice_other_base` and
 * is never adopted: its pack bytes are a superseded assembly, so returning it
 * would bind the Captain's money approval to a document he never reviewed (and,
 * on a card whose report was corrected, would re-serve the superseded report).
 * The caller refuses loudly and names the differing base instead.
 *
 * This is deliberately stricter than the SQL commit function's own adopt: the
 * SQL falls through and mints a NEW current bind on the current base, which is
 * the real repair. TypeScript never substitutes an older row for that.
 */
export async function findExistingAuthorisedInvoiceBoundDocket(
  client: SesSupabaseClient,
  args: {
    job_id: string;
    invoice_obligation_revision_id: string;
    invoice: SesXeroInvoiceResult;
    based_on_revision_id?: string | null;
  },
): Promise<{
  adoptable:
    | { docket: Record<string, any>; pdf_content_hash: string | null }
    | null;
  same_invoice_other_base: Record<string, any>[];
}> {
  const response = await client.from("makesafe_docket_revisions")
    .select("*")
    .eq("job_id", args.job_id)
    .eq("stage", "invoice_bound")
    .eq("invoice_obligation_revision_id", args.invoice_obligation_revision_id)
    .order("committed_at", { ascending: false });
  if (response.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `Existing invoice-bound dockets could not be read (${
        response.error.message || "unknown database error"
      }).`,
    });
  }
  const rows = Array.isArray(response.data) ? response.data : [];
  const basedOn = String(args.based_on_revision_id || "").trim();
  const candidates = rows.filter((row: any) =>
    invoiceIdentityMatchesBinding(args.invoice, object(row.xero_binding))
  );
  const sameBase = (row: any) =>
    String(row.based_on_revision_id || "").trim() === basedOn;
  // No base to compare against means nothing is provably the reviewed pack, so
  // nothing is adoptable. Never fall back to "newest same-INV bind".
  const chosen = basedOn ? candidates.find(sameBase) || null : null;
  const sameInvoiceOtherBase = candidates.filter((row: any) => !sameBase(row));
  if (!chosen) {
    return { adoptable: null, same_invoice_other_base: sameInvoiceOtherBase };
  }

  const artifactsResponse = await client.from("makesafe_docket_artifacts")
    .select("role,content_hash,metadata")
    .eq("revision_id", chosen.id)
    .eq("role", "xero_invoice_pdf");
  if (artifactsResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The invoice-bound PDF artifact could not be read (${
        artifactsResponse.error.message || "unknown database error"
      }).`,
    });
  }
  const pdfs = Array.isArray(artifactsResponse.data)
    ? artifactsResponse.data
    : [];
  const matchingPdf =
    pdfs.find((artifact: any) =>
      object(artifact.metadata).xero_invoice_id ===
        args.invoice.xero_invoice_id &&
      object(artifact.metadata).invoice_number === args.invoice.invoice_number
    ) || pdfs[0] || null;
  return {
    adoptable: {
      docket: chosen,
      pdf_content_hash: matchingPdf?.content_hash
        ? String(matchingPdf.content_hash)
        : (object(chosen.xero_binding).pdf_content_hash
          ? String(object(chosen.xero_binding).pdf_content_hash)
          : null),
    },
    same_invoice_other_base: sameInvoiceOtherBase,
  };
}

/**
 * Shared AUTHORISED PDF bind: fetch the real Xero PDF, store it once, and
 * commit an invoice_bound docket from the reviewed pre_xero base. Idempotent
 * via content-addressed docket id + storage "already exists" tolerance + the
 * SQL commit function's same-id / same-key adopt path. On unique-key collision
 * for the same INV identity, adopt the existing bound docket rather than fail.
 */
export async function bindAuthorisedInvoicePdfToDocket(
  client: SesSupabaseClient,
  args: {
    org_id: string;
    job_id: string;
    invoice_obligation_revision_id: string;
    based_on_revision_id: string;
    actor: string;
    invoice: SesXeroInvoiceResult;
  },
  gateway: Pick<SesXeroGateway, "fetchAuthorisedPdf">,
): Promise<{
  state: "authorised_invoice_bound" | "authorised_invoice_already_bound";
  invoice: SesXeroInvoiceResult;
  docket_revision: Record<string, any>;
  pdf_content_hash: string;
  recovery: boolean;
  adopted_existing: boolean;
}> {
  if (String(args.invoice.status || "").toUpperCase() !== "AUTHORISED") {
    throw new SesActionError(
      409,
      sesRefusal(
        "xero_not_authorised",
        "Authorise the exact bound invoice under the approved money action, then resume.",
      ),
    );
  }

  // Pre-adopt: same base already bound for this INV — no second commit.
  const preExisting = await findExistingAuthorisedInvoiceBoundDocket(client, {
    job_id: args.job_id,
    invoice_obligation_revision_id: args.invoice_obligation_revision_id,
    invoice: args.invoice,
    based_on_revision_id: args.based_on_revision_id,
  });
  if (preExisting.adoptable?.pdf_content_hash) {
    return {
      state: "authorised_invoice_already_bound",
      invoice: args.invoice,
      docket_revision: preExisting.adoptable.docket,
      pdf_content_hash: preExisting.adoptable.pdf_content_hash,
      recovery: false,
      adopted_existing: true,
    };
  }

  const pdf = await gateway.fetchAuthorisedPdf(args.invoice.xero_invoice_id);
  const pdfHash = await sesSha256(
    Array.from(pdf),
    "SecureWorks:ses-docket-artifact-bytes:v1\n",
  );
  const docketHash = await sesSha256({
    based_on_revision_id: args.based_on_revision_id,
    invoice_obligation_revision_id: args.invoice_obligation_revision_id,
    xero_invoice_id: args.invoice.xero_invoice_id,
    pdf_content_hash: pdfHash,
  }, "SecureWorks:ses-invoice-bound-docket:v1\n");
  const boundDocketId = stableUuidFromSha256(docketHash);
  const storagePath =
    `${args.job_id}/${boundDocketId}/ARTIFACTS/Xero Invoice - ${args.invoice.invoice_number}.pdf`;
  const upload = await client.storage.from("makesafe-docket-artifacts").upload(
    storagePath,
    pdf,
    { contentType: "application/pdf", upsert: false },
  );
  if (
    upload.error && !String(upload.error.message || "").toLowerCase().includes(
      "already",
    )
  ) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The real AUTHORISED Xero PDF could not be stored (${
        upload.error.message || "unknown storage error"
      }).`,
    });
  }
  const bound = await client.rpc("commit_ses_invoice_bound_docket_v1", {
    p_binding: {
      id: boundDocketId,
      job_id: args.job_id,
      based_on_revision_id: args.based_on_revision_id,
      invoice_obligation_revision_id: args.invoice_obligation_revision_id,
      output_content_hash: docketHash,
      xero_binding: {
        xero_invoice_id: args.invoice.xero_invoice_id,
        invoice_number: args.invoice.invoice_number,
        status: args.invoice.status,
        total: Number.isFinite(Number(args.invoice.total))
          ? Number(args.invoice.total)
          : null,
        bound_at: new Date().toISOString(),
        pdf_content_hash: pdfHash,
      },
      created_by: args.actor,
    },
    p_pdf_artifact: {
      role: "xero_invoice_pdf",
      object_key: `makesafe-docket-artifacts/${storagePath}`,
      content_hash: pdfHash,
      size_bytes: pdf.byteLength,
      metadata: {
        invoice_number: args.invoice.invoice_number,
        xero_invoice_id: args.invoice.xero_invoice_id,
      },
    },
  });
  if (bound.error && isSesInvoiceBoundDocketDuplicateKeyError(bound.error)) {
    // A true replay of THIS base is adoptable; nothing else is.
    const adopted = await findExistingAuthorisedInvoiceBoundDocket(client, {
      job_id: args.job_id,
      invoice_obligation_revision_id: args.invoice_obligation_revision_id,
      invoice: args.invoice,
      based_on_revision_id: args.based_on_revision_id,
    });
    if (adopted.adoptable?.pdf_content_hash) {
      return {
        state: "authorised_invoice_already_bound",
        invoice: args.invoice,
        docket_revision: adopted.adoptable.docket,
        pdf_content_hash: adopted.adoptable.pdf_content_hash,
        recovery: false,
        adopted_existing: true,
      };
    }
    // Same AUTHORISED invoice, different pre_xero base. Adopting it would
    // report success while the current pack stays unbound, and would attach
    // this money decision to superseded pack bytes. Refuse and name the base.
    if (adopted.same_invoice_other_base.length > 0) {
      const bases = adopted.same_invoice_other_base
        .map((row: any) => String(row.based_on_revision_id || "unknown"))
        .join(", ");
      throw new SesActionError(409, {
        state: "refused",
        fact:
          `The AUTHORISED Xero PDF for ${args.invoice.invoice_number} is already bound to a docket built on a different pre-Xero base (${bases}); the reviewed base is ${args.based_on_revision_id}. Apply the based_on-scoped invoice-bound idempotency migration so the same invoice can bind to the current pack; do not adopt the superseded bind.`,
      });
    }
  }
  const boundDocket = requireValue(
    bound,
    "The real AUTHORISED Xero PDF could not be bound to a new docket revision.",
  );
  requireValue(
    await client.rpc("record_ses_docket_review_state_v1", {
      p_event: {
        docket_revision_id: boundDocket.id,
        event_kind: "prepared",
        expected_output_content_hash: boundDocket.output_content_hash ||
          docketHash,
        actor_identity: args.actor,
        reason:
          "The AUTHORISED Xero PDF changed the exact pack bytes and requires a fresh Captain tick.",
      },
    }),
    "The invoice-bound pack could not be queued for a fresh Docs Ready review.",
  );
  return {
    state: "authorised_invoice_bound",
    invoice: args.invoice,
    docket_revision: boundDocket,
    pdf_content_hash: pdfHash,
    recovery: false,
    adopted_existing: false,
  };
}

/**
 * Narrow recovery: the human already authorised money, but a later docket
 * re-prepare (or a half-finished execute) left the current pre_xero docket
 * without the Xero PDF bind. Re-bind the exact same AUTHORISED invoice to the
 * current docket without demanding a second APPROVE INVOICE.
 *
 * Scoped only to already-authorised obligation revisions (or an obligation
 * whose stored xero_binding is already AUTHORISED). Never mints, never
 * re-authorises, never voids, never sends.
 */
export async function recoverAuthorisedInvoicePdfBind(
  client: SesSupabaseClient,
  args: {
    org_id: string;
    job_id: string;
    invoice_obligation_revision_id: string;
    actor: string;
  },
  gateway: Pick<SesXeroGateway, "fetchAuthorisedPdf" | "reconcileAuthorise">,
): Promise<{
  state: "authorised_invoice_bound" | "authorised_invoice_already_bound";
  invoice: SesXeroInvoiceResult;
  docket_revision: Record<string, any>;
  pdf_content_hash: string | null;
  recovery: true;
  invoice_create_dispatched: false;
  invoice_authorise_dispatched: false;
  send_dispatched: false;
}> {
  const revision = requireValue(
    await client.from("makesafe_invoice_obligation_revisions").select("*")
      .eq("id", args.invoice_obligation_revision_id)
      .eq("job_id", args.job_id).maybeSingle(),
    "The authorised invoice obligation revision no longer exists.",
  );
  const binding = object(revision.xero_binding);
  const boundInvoiceId = String(binding.xero_invoice_id || "").trim();
  const boundInvoiceNumber = String(binding.invoice_number || "").trim();
  const boundStatus = String(binding.status || "").toUpperCase();
  const obligationAlreadyAuthorised =
    (SES_AUTHORISED_OBLIGATION_STATES as readonly string[]).includes(
      String(revision.state || ""),
    ) || boundStatus === "AUTHORISED";
  if (!obligationAlreadyAuthorised) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Review the newest docket revision and record a fresh APPROVE INVOICE decision.",
        {
          fact:
            "Authorised-PDF recovery only applies when the obligation is already authorised; this revision is not.",
        },
      ),
    );
  }
  if (!boundInvoiceId || !boundInvoiceNumber) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The authorised obligation has no exact Xero invoice identity to re-bind; refuse rather than guess.",
    });
  }

  const liveRows = await gateway.reconcileAuthorise(boundInvoiceId);
  if (liveRows.length !== 1) {
    throw new SesActionError(
      409,
      sesRefusal(
        "xero_outcome_unknown",
        "Reconcile the exact bound invoice in Xero before recovering its PDF bind.",
        {
          fact:
            "Authorised-PDF recovery could not prove a single live Xero invoice for the stored identity.",
        },
      ),
    );
  }
  const live = liveRows[0];
  const liveStatus = String(live.status || "").toUpperCase();
  const liveNumber = String(live.invoice_number || "").trim();
  const liveId = String(live.xero_invoice_id || "").trim();
  if (
    liveStatus !== "AUTHORISED" ||
    liveId !== boundInvoiceId ||
    liveNumber !== boundInvoiceNumber
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        `Authorised-PDF recovery refused: stored binding ${boundInvoiceNumber}/${boundInvoiceId} does not match live Xero ${liveNumber}/${liveId} (${liveStatus}). Do not mint or re-authorise.`,
    });
  }
  const boundTotal = Number(binding.total);
  if (
    Number.isFinite(boundTotal) && !moneyTotalsMatch(boundTotal, live.total)
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        `Authorised-PDF recovery refused: stored total ${boundTotal} does not match live Xero total ${live.total} for ${boundInvoiceNumber}. Do not mint or re-authorise.`,
    });
  }

  const authorisedInvoice: SesXeroInvoiceResult = {
    xero_invoice_id: liveId,
    invoice_number: liveNumber,
    status: "AUTHORISED",
    reference: String(live.reference || ""),
    total: Number.isFinite(Number(live.total))
      ? Number(live.total)
      : (Number.isFinite(boundTotal) ? boundTotal : 0),
  };

  const cockpit = await loadSesCockpitDocket(client, args.job_id);
  if (
    cockpit.invoice_obligation_revision_id &&
    cockpit.invoice_obligation_revision_id !== revision.id
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The current docket is bound to a different invoice obligation revision; refuse rather than re-bind the wrong money.",
    });
  }

  // Current docket already carries this AUTHORISED PDF — pure idempotent hit.
  const currentDocketResponse = await client.from(
    "makesafe_docket_revisions_current",
  ).select("*").eq("job_id", args.job_id).maybeSingle();
  const currentDocket = requireValue(
    currentDocketResponse,
    "No current SES docket revision exists for this job.",
  );
  const currentXero = object(currentDocket.xero_binding);
  if (
    currentDocket.stage === "invoice_bound" &&
    String(currentXero.xero_invoice_id || "") ===
      authorisedInvoice.xero_invoice_id &&
    String(currentXero.invoice_number || "") ===
      authorisedInvoice.invoice_number &&
    String(currentXero.status || "").toUpperCase() === "AUTHORISED"
  ) {
    const artifactsResponse = await client.from("makesafe_docket_artifacts")
      .select("role,content_hash,metadata")
      .eq("revision_id", currentDocket.id)
      .eq("role", "xero_invoice_pdf");
    if (artifactsResponse.error) {
      throw new SesActionError(503, {
        state: "refused",
        fact: `The current docket invoice PDF could not be read (${
          artifactsResponse.error.message || "unknown database error"
        }).`,
      });
    }
    const pdfs = artifactsResponse.data || [];
    const matchingPdf = pdfs.find((artifact: any) =>
      object(artifact.metadata).xero_invoice_id ===
        authorisedInvoice.xero_invoice_id &&
      object(artifact.metadata).invoice_number ===
        authorisedInvoice.invoice_number
    );
    if (matchingPdf) {
      return {
        state: "authorised_invoice_already_bound",
        invoice: authorisedInvoice,
        docket_revision: currentDocket,
        pdf_content_hash: matchingPdf.content_hash
          ? String(matchingPdf.content_hash)
          : null,
        recovery: true,
        invoice_create_dispatched: false,
        invoice_authorise_dispatched: false,
        send_dispatched: false,
      };
    }
  }

  if (currentDocket.stage !== "pre_xero") {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        `Authorised-PDF recovery needs a pre_xero current docket to bind from; current stage is ${
          currentDocket.stage || "unknown"
        }.`,
    });
  }

  // Do not invent a SES external token or re-mint money state. The original
  // authorise path already wrote the Xero mirror; recovery only rebinds PDF.

  const bound = await bindAuthorisedInvoicePdfToDocket(
    client,
    {
      org_id: args.org_id,
      job_id: args.job_id,
      invoice_obligation_revision_id: revision.id,
      based_on_revision_id: currentDocket.id,
      actor: args.actor,
      invoice: authorisedInvoice,
    },
    gateway,
  );
  return {
    ...bound,
    recovery: true,
    invoice_create_dispatched: false,
    invoice_authorise_dispatched: false,
    send_dispatched: false,
  };
}

/**
 * Idempotent draft binding: the local money mirror plus the revision's
 * xero_binding are written together so a re-mint that finds its own DRAFT can
 * repair a half-written first attempt instead of stranding the card.
 * When the real Xero DRAFT PDF was recovered, stamp its storage pointer so the
 * Invoice tab can show that document before APPROVE.
 */
async function bindSesDraftInvoiceToRevision(
  client: SesSupabaseClient,
  args: {
    org_id: string;
    job_id: string;
    invoice_obligation_revision_id: string;
    external_token: string;
    invoice: SesXeroInvoiceResult;
    draft_pdf?: SesDraftInvoicePdfBinding | null;
  },
) {
  await persistSesInvoiceMirror(client, args);
  const bindingUpdate = await client.from(
    "makesafe_invoice_obligation_revisions",
  ).update({
    state: "create_executed",
    xero_binding: {
      xero_invoice_id: args.invoice.xero_invoice_id,
      invoice_number: args.invoice.invoice_number,
      status: args.invoice.status,
      total: Number.isFinite(Number(args.invoice.total))
        ? Number(args.invoice.total)
        : null,
      bound_at: new Date().toISOString(),
      ...(args.draft_pdf
        ? {
          pdf_object_key: args.draft_pdf.pdf_object_key,
          pdf_content_hash: args.draft_pdf.pdf_content_hash,
          pdf_size_bytes: args.draft_pdf.pdf_size_bytes,
          pdf_stored_at: args.draft_pdf.pdf_stored_at,
        }
        : {}),
    },
  }).eq("id", args.invoice_obligation_revision_id).in(
    "state",
    SES_DRAFT_BINDABLE_REVISION_STATES,
  ).select("id").maybeSingle();
  requireValue(
    bindingUpdate,
    "The exact Xero draft exists under its SES token, but its invoice obligation binding could not be stored; reconcile that draft before resuming.",
  );
}

/**
 * Best-effort: fetch the real Xero DRAFT PDF and store it for the Invoice tab.
 * Mint must not fail when the PDF is temporarily unavailable — the binding still
 * names the live DRAFT and the pack read path reports "not available" honestly.
 */
async function tryStoreSesDraftInvoicePdf(
  client: SesSupabaseClient,
  gateway: SesXeroGateway,
  args: {
    job_id: string;
    invoice: SesXeroInvoiceResult;
  },
): Promise<SesDraftInvoicePdfBinding | null> {
  try {
    const pdf = await gateway.fetchAuthorisedPdf(args.invoice.xero_invoice_id);
    return await storeSesXeroInvoicePdfBytes(client, {
      job_id: args.job_id,
      invoice: args.invoice,
      pdf,
    });
  } catch (error) {
    console.error(
      "[ses] create_ses_invoice_draft could not store the real Xero DRAFT PDF:",
      (error as Error)?.message || error,
    );
    return null;
  }
}

export async function executeSesInvoiceRevisionAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    job_id: string;
    invoice_obligation_revision_id: string;
    actor: string;
  },
  gateway: SesXeroGateway,
) {
  if (auth.mode === "routine") {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "The make-safe automation key cannot execute an approved Xero invoice.",
    });
  }
  const revision = requireValue(
    await client.from("makesafe_invoice_obligation_revisions").select("*")
      .eq("id", args.invoice_obligation_revision_id)
      .eq("job_id", args.job_id).maybeSingle(),
    "The approved invoice obligation revision no longer exists.",
  );
  // Already-authorised recovery: the human decision happened; only the docket
  // PDF pointer was lost (typically a re-prepare after approve). Bind the same
  // AUTHORISED invoice PDF to the current docket without re-approval. Never
  // mint, re-authorise, void, or send from this branch.
  const recoveryBinding = object(revision.xero_binding);
  const recoveryEligible =
    (SES_AUTHORISED_OBLIGATION_STATES as readonly string[]).includes(
      String(revision.state || ""),
    ) ||
    String(recoveryBinding.status || "").toUpperCase() === "AUTHORISED";
  if (
    recoveryEligible && String(recoveryBinding.xero_invoice_id || "").trim()
  ) {
    return await recoverAuthorisedInvoicePdfBind(client, args, gateway);
  }
  if (revision.pricing_disposition === "no_additional_charge") {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "This obligation is explicitly no additional charge, so no Xero invoice may be created; release only the approved document routes.",
    });
  }
  if (
    revision.state === "blocked" ||
    !["priced_from_canon", "priced_with_line_override"].includes(
      revision.pricing_disposition,
    )
  ) {
    const blocker = Array.isArray(revision.blockers) &&
        revision.blockers.length > 0
      ? refusalFromStored(revision.blockers[0])
      : sesRefusal(
        "pricing_evidence_missing",
        "Prepare a new invoice obligation revision with real trade evidence and an executable priced line set.",
        {
          fact:
            "The current invoice obligation has no executable priced line set.",
        },
      );
    throw new SesActionError(409, blocker);
  }
  const approval = await currentInvoiceApproval(client, revision.id);
  const cockpit = await loadSesCockpitDocket(client, args.job_id);
  if (
    cockpit.readiness_revision !== approval.readiness_revision ||
    cockpit.dependency_generation !==
      Number(approval.dependency_generation) ||
    cockpit.docket_revision_id !== approval.docket_revision_id
  ) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Review the newest docket revision and record a fresh APPROVE INVOICE decision.",
      ),
    );
  }
  const approvalContentHash = await sesSha256({
    action: "invoice",
    docket_revision_id: cockpit.docket_revision_id,
    invoice_obligation_revision_id: cockpit.invoice_obligation_revision_id,
    readiness_revision: cockpit.readiness_revision,
    dependency_generation: cockpit.dependency_generation,
    includes_authorise: approval.includes_authorise === true,
  }, "SecureWorks:ses-approval-content:v1\n");
  if (approval.approval_content_hash !== approvalContentHash) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Review the exact current invoice action and record a fresh APPROVE INVOICE decision.",
      ),
    );
  }
  requireValue(
    await client.rpc("begin_ses_invoice_execution_v1", {
      p_job_id: args.job_id,
      p_invoice_obligation_revision_id: revision.id,
      p_approval_content_hash: approvalContentHash,
    }),
    "The current readiness and invoice approval could not be reserved for execution.",
  );

  const rows = await loadIndexedInvoiceRows(client, args.org_id, [{
    job_id: args.job_id,
    external_ref: revision.proposal.reference,
    obligation_revision_id: revision.id,
  }]);
  const [duplicate] = resolveSesInvoiceDuplicates([{
    job_id: args.job_id,
    external_ref: revision.proposal.reference,
    obligation_revision_id: revision.id,
  }], rows);
  if (
    !duplicate.allows_create &&
    duplicate.match_tier !== "obligation_binding"
  ) {
    throw new SesActionError(
      409,
      duplicate.ambiguity === "multi_live"
        ? sesRefusal(
          "invoice_duplicate_ambiguous",
          "Resolve which Xero invoice owns this work before execution.",
        )
        : sesRefusal(
          "invoice_duplicate_live",
          "Use the live invoice already bound to this work; no second invoice can be created.",
        ),
    );
  }

  const proposal = revision.proposal as SesInvoiceProposalV1;
  const store = createSupabaseSesEffectStore(client);
  const createEffect = await buildSesEffect({
    org_id: args.org_id,
    job_id: args.job_id,
    effect_kind: "invoice_create",
    invoice_obligation_revision_id: revision.id,
    payload: proposal,
  });
  const createAdapter: SesExternalAdapter<
    SesInvoiceProposalV1,
    SesXeroInvoiceResult
  > = {
    dispatch: (payload, context) => gateway.createDraft(payload, context),
    reconcile: (context) => gateway.reconcileCreate(context.external_token),
    identify: (result) => result.xero_invoice_id,
    digest: (result) => ({
      invoice_number: result.invoice_number,
      status: result.status,
      reference: result.reference,
      total: result.total,
    }),
  };
  const created = await executeSesExternalEffect({
    store,
    effect: createEffect,
    payload: proposal,
    adapter: createAdapter,
    actor: args.actor,
  });
  if (created.state !== "confirmed") {
    throw new SesActionError(409, created.refusal!);
  }
  const createdInvoice = created.result ||
    await gateway.reconcileCreate(createEffect.external_token).then((rows) =>
      rows[0]
    );
  if (!createdInvoice) {
    throw new SesActionError(
      409,
      sesRefusal(
        "xero_outcome_unknown",
        "Reconcile Xero by the exact SES token before resuming.",
      ),
    );
  }
  await persistSesInvoiceMirror(client, {
    org_id: args.org_id,
    job_id: args.job_id,
    invoice_obligation_revision_id: revision.id,
    external_token: createEffect.external_token,
    invoice: createdInvoice,
  });
  if (!["authorised", "released"].includes(revision.state)) {
    const bindingUpdate = await client.from(
      "makesafe_invoice_obligation_revisions",
    ).update({
      state: "create_executed",
      xero_binding: {
        xero_invoice_id: createdInvoice.xero_invoice_id,
        invoice_number: createdInvoice.invoice_number,
        status: createdInvoice.status,
        total: Number.isFinite(Number(createdInvoice.total))
          ? Number(createdInvoice.total)
          : null,
        bound_at: new Date().toISOString(),
      },
    }).eq("id", revision.id).in("state", [
      "proposed",
      "pending_approval",
      "create_approved",
      "create_executed",
    ]).select("id").maybeSingle();
    requireValue(
      bindingUpdate,
      "The exact Xero draft exists under its SES token, but its invoice obligation binding could not be stored; reconcile that draft before resuming.",
    );
  }

  if (!approval.includes_authorise) {
    return {
      state: "xero_draft_created",
      invoice: createdInvoice,
      invoice_create_dispatched: created.dispatched,
      send_dispatched: false,
    };
  }
  const authorisePayload = {
    xero_invoice_id: createdInvoice.xero_invoice_id,
    expected_status: "AUTHORISED",
  };
  const authoriseEffect = await buildSesEffect({
    org_id: args.org_id,
    job_id: args.job_id,
    effect_kind: "invoice_authorise",
    invoice_obligation_revision_id: revision.id,
    payload: authorisePayload,
  });
  const authoriseAdapter: SesExternalAdapter<
    typeof authorisePayload,
    SesXeroInvoiceResult
  > = {
    dispatch: (_payload, context) => gateway.authorise(createdInvoice, context),
    reconcile: () => gateway.reconcileAuthorise(createdInvoice.xero_invoice_id),
    identify: (result) => result.xero_invoice_id,
    digest: (result) => ({
      invoice_number: result.invoice_number,
      status: result.status,
      reference: result.reference,
      total: result.total,
    }),
  };
  const authorised = await executeSesExternalEffect({
    store,
    effect: authoriseEffect,
    payload: authorisePayload,
    adapter: authoriseAdapter,
    actor: args.actor,
  });
  if (authorised.state !== "confirmed") {
    throw new SesActionError(409, authorised.refusal!);
  }
  const authorisedInvoice = authorised.result ||
    await gateway.reconcileAuthorise(createdInvoice.xero_invoice_id).then((
      rows,
    ) => rows[0]);
  if (!authorisedInvoice || authorisedInvoice.status !== "AUTHORISED") {
    throw new SesActionError(
      409,
      sesRefusal(
        "xero_not_authorised",
        "Authorise the exact bound invoice under the approved money action, then resume.",
      ),
    );
  }
  await persistSesInvoiceMirror(client, {
    org_id: args.org_id,
    job_id: args.job_id,
    invoice_obligation_revision_id: revision.id,
    external_token: createEffect.external_token,
    invoice: authorisedInvoice,
  });
  const bound = await bindAuthorisedInvoicePdfToDocket(
    client,
    {
      org_id: args.org_id,
      job_id: args.job_id,
      invoice_obligation_revision_id: revision.id,
      based_on_revision_id: cockpit.docket_revision_id,
      actor: args.actor,
      invoice: authorisedInvoice,
    },
    gateway,
  );
  return {
    state: "authorised_invoice_bound",
    invoice: authorisedInvoice,
    docket_revision: bound.docket_revision,
    invoice_create_dispatched: created.dispatched,
    invoice_authorise_dispatched: authorised.dispatched,
    send_dispatched: false,
  };
}

export async function prepareSesReleaseRevisionAction(
  client: SesSupabaseClient,
  args: {
    org_id: string;
    job_ids: string[];
    routes?: SesReviewRoute[];
    created_by: string;
  },
) {
  const dockets = await Promise.all(
    args.job_ids.map((jobId) => loadSesCockpitDocket(client, jobId)),
  );
  const routes = args.routes ||
    (dockets.length === 1 ? dockets[0].routes : []);
  // Composite multi-job releases keep the universal three-route order unless
  // every member is AJS/AJBR (Captain carve-out is AJS/AJBR only).
  const builderKeys = dockets.map((docket) =>
    String(docket.clean_input.builder_key || "")
  );
  const builderKey = builderKeys.length > 0 &&
      builderKeys.every((key) => isAjsBuilderKey(key))
    ? builderKeys[0]
    : (builderKeys.length === 1 ? builderKeys[0] : null);
  const plan = await buildSesReleaseRevision({
    org_id: args.org_id,
    members: dockets.map((docket) => ({
      job_id: docket.job_id,
      docket_revision_id: docket.docket_revision_id,
      invoice_obligation_revision_id: docket.invoice_obligation_revision_id,
      attendance_cycle_ids: docket.attendance_cycle_ids,
      readiness_revision: docket.readiness_revision,
      dependency_generation: docket.dependency_generation,
    })),
    routes,
    created_by: args.created_by,
    builder_key: builderKey,
  });
  const committed = await client.rpc("commit_ses_release_revision_v1", {
    p_release: plan.release,
    p_members: plan.members,
    p_routes: plan.routes,
  });
  return {
    ...plan,
    commit: requireValue(
      committed,
      "The content-addressed release revision could not be committed.",
    ),
    external_mutations: { xero: 0, email: 0 },
  };
}

/**
 * SEND IT invoice-approval gate for a priced invoice_bound member.
 *
 * A human APPROVE INVOICE (includes_authorise) row against the pre-Xero base is
 * normally required. When that row is missing after a re-prepare/re-bind, an
 * obligation whose xero_binding.status is already AUTHORISED is downstream
 * proof that execute_ses_invoice_revision (itself approval-gated) already ran —
 * a records gap, not a missing decision. Non-AUTHORISED bindings still refuse.
 * Does not touch Docs Ready signoff, recipients, readiness, or the money fence.
 */
export function sesReleaseInvoiceApprovalSatisfied(args: {
  hasInvoiceApprovalRow: boolean;
  /** Bound obligation `xero_binding.status` (invoice_bound path only). */
  obligationXeroBindingStatus?: string | null;
}): boolean {
  if (args.hasInvoiceApprovalRow) return true;
  return String(args.obligationXeroBindingStatus || "").toUpperCase() ===
    "AUTHORISED";
}

/**
 * Both SEND IT invoice-approval reads are business-meaningful, so a PostgREST
 * fault must never be reported as a missing human decision: an operator told to
 * press APPROVE INVOICE on an already-AUTHORISED card is being sent to
 * re-approve money. An approval response with no row is a trustworthy answer
 * (the bookkeeping gap this gate exists for); an obligation response with no row
 * is not, because the AUTHORISED pass may only be granted on a read that
 * actually returned the binding.
 */
export function sesReleaseInvoiceApprovalReadRefusal(
  source: "approval" | "obligation",
  response: SupabaseResponse<any>,
): SesRefusal | null {
  const unreadable = !!response.error ||
    (source === "obligation" && !response.data);
  if (!unreadable) return null;
  const subject = source === "approval"
    ? "The human APPROVE INVOICE record"
    : "The bound invoice obligation Xero binding";
  const detail = response.error?.message ? ` (${response.error.message})` : "";
  return sesRefusal(
    "invoice_approval_unreadable",
    "Retry SEND IT once the invoice approval and obligation records read cleanly. Do not press APPROVE INVOICE again for an invoice that is already AUTHORISED in Xero.",
    {
      fact:
        `${subject} could not be read, so the invoice decision cannot be proven either way.${detail}`,
    },
  );
}

export async function approveSesReleaseRevisionAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    release_revision_id: string;
    evidence_refs?: unknown[];
  },
) {
  const release = requireValue(
    await client.from("makesafe_release_revisions").select("*")
      .eq("id", args.release_revision_id).maybeSingle(),
    "The displayed release revision no longer exists.",
  );
  const membersResponse = await client.from("makesafe_release_revision_members")
    .select("*").eq("release_revision_id", args.release_revision_id)
    .order("ordinal");
  const members = membersResponse.data || [];
  if (membersResponse.error || members.length === 0) {
    throw new SesActionError(409, {
      state: "refused",
      fact: "The displayed release revision has no complete member docket set.",
    });
  }
  const operatorAuth = await loadOperatorAuth(client, auth);
  if (operatorAuth.mode !== "jwt" || !auth.user) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "Human SEND IT approval requires an identified SES operator session; API keys and automation keys cannot approve.",
    });
  }
  const approvals = [];
  for (const member of members) {
    const docket = await loadSesCockpitDocket(client, member.job_id);
    const verdict = evaluateSesMechanicalClean(docket.clean_input);
    const authority = canRecordSesApproval(operatorAuth, verdict);
    const cockpit = buildSesCockpitView(docket);
    if (
      !authority.allowed || (!cockpit.controls.send_it.enabled &&
        !authority.captain_override)
    ) {
      throw new SesActionError(
        409,
        verdict.blockers[0] ||
          sesRefusal(
            "xero_not_authorised",
            "Bind the real AUTHORISED Xero PDF to the current docket before SEND IT.",
          ),
      );
    }
    if (
      member.docket_revision_id !== docket.docket_revision_id ||
      !release.readiness_bindings.some((binding: any) =>
        binding.job_id === docket.job_id &&
        binding.readiness_revision === docket.readiness_revision &&
        Number(binding.dependency_generation) ===
          docket.dependency_generation
      )
    ) {
      throw new SesActionError(
        409,
        sesRefusal(
          "stale_review",
          "Prepare and review a release revision from the newest docket evidence.",
        ),
      );
    }
    if (docket.clean_input.pricing_disposition === "no_additional_charge") {
      const noChargeRevision = await client.from(
        "makesafe_invoice_obligation_revisions",
      ).select("id").eq("id", member.invoice_obligation_revision_id)
        .eq("pricing_disposition", "no_additional_charge")
        .eq("state", "proposed")
        .maybeSingle();
      if (noChargeRevision.error || !noChargeRevision.data) {
        throw new SesActionError(409, {
          state: "refused",
          fact:
            "The current later attendance is not recorded as a proposed no-additional-charge obligation.",
        });
      }
    } else {
      const boundDocket = requireValue(
        await client.from("makesafe_docket_revisions")
          .select("based_on_revision_id,invoice_obligation_revision_id")
          .eq("id", member.docket_revision_id)
          .eq("stage", "invoice_bound")
          .maybeSingle(),
        "The displayed release is not bound to a real AUTHORISED Xero PDF docket.",
      );
      const invoiceApproval = await client.from("makesafe_revision_approvals")
        .select("id")
        .eq("action", "invoice")
        .eq("decision", "approved")
        .eq(
          "invoice_obligation_revision_id",
          boundDocket.invoice_obligation_revision_id,
        )
        .eq("docket_revision_id", boundDocket.based_on_revision_id)
        .eq("includes_authorise", true)
        .order("decided_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const approvalReadRefusal = sesReleaseInvoiceApprovalReadRefusal(
        "approval",
        invoiceApproval,
      );
      if (approvalReadRefusal) {
        throw new SesActionError(409, approvalReadRefusal);
      }
      const hasInvoiceApprovalRow = !!invoiceApproval.data;
      let obligationXeroBindingStatus: string | null = null;
      // Only consult the money binding when the approval row is absent: an
      // AUTHORISED obligation proves the approval already ran (and re-prepare
      // orphaned the pointer). Non-AUTHORISED still refuses without the row.
      if (!hasInvoiceApprovalRow) {
        const obligation = await client
          .from("makesafe_invoice_obligation_revisions")
          .select("xero_binding")
          .eq("id", boundDocket.invoice_obligation_revision_id)
          .maybeSingle();
        const obligationReadRefusal = sesReleaseInvoiceApprovalReadRefusal(
          "obligation",
          obligation,
        );
        if (obligationReadRefusal) {
          throw new SesActionError(409, obligationReadRefusal);
        }
        obligationXeroBindingStatus = String(
          object(obligation.data?.xero_binding).status || "",
        ) || null;
      }
      if (
        !sesReleaseInvoiceApprovalSatisfied({
          hasInvoiceApprovalRow,
          obligationXeroBindingStatus,
        })
      ) {
        throw new SesActionError(
          409,
          sesRefusal(
            "invoice_approval_missing",
            "Review the exact invoice proposal and press APPROVE INVOICE with authorise included before SEND IT.",
          ),
        );
      }
    }
    const approved = await client.rpc("record_ses_revision_approval_v1", {
      p_approval: {
        org_id: args.org_id,
        job_id: member.job_id,
        action: "release",
        operator_id: auth.user.id,
        is_admin_owner: ["admin", "owner"].includes(auth.user.role),
        clean: verdict.clean,
        captain_override: authority.captain_override,
        readiness_revision: docket.readiness_revision,
        dependency_generation: docket.dependency_generation,
        docket_revision_id: docket.docket_revision_id,
        release_revision_id: args.release_revision_id,
        invoice_obligation_revision_id: docket.invoice_obligation_revision_id,
        approval_content_hash: release.content_hash,
        includes_authorise: false,
        decided_by: auth.user.email || auth.user.id,
        evidence_refs: args.evidence_refs || [],
      },
    });
    approvals.push(
      requireValue(approved, "The SEND IT approval could not be recorded."),
    );
  }
  const releaseState = await client.from("makesafe_release_revisions").update({
    state: "approved",
    updated_at: new Date().toISOString(),
  }).eq("id", args.release_revision_id).in("state", [
    "proposed",
    "approved",
  ]).select("id").maybeSingle();
  requireValue(
    releaseState,
    "The exact release revision approval was recorded, but its SEND IT state could not be stored.",
  );
  return {
    release_revision_id: args.release_revision_id,
    approvals,
    controls: {
      approve_invoice: "separate",
      send_it: "recorded",
    },
  };
}

export interface SesRouteSendResult {
  message_id: string;
  internet_message_id?: string;
  state: "sent";
  operation_token: string;
}

export interface SesMailGateway {
  createDraftAndSend(
    route: Record<string, any>,
    context: { external_token: string; operation_key: string },
  ): Promise<SesRouteSendResult>;
  reconcileSent(externalToken: string): Promise<SesRouteSendResult[]>;
}

export interface SesReleaseXeroReader {
  readAuthorised(invoiceId: string): Promise<boolean>;
}

/**
 * A signoff records approval of exact pack bytes, and a curated content
 * supersession is the one event that can invalidate those bytes after the tick
 * was recorded. The recorded signoff is left alone as history; this wall is
 * what stops it from still authorising superseded content at send time.
 */
async function assertSesReleasedSourcesNotSuperseded(
  client: SesSupabaseClient,
  docketRevisionIds: string[],
): Promise<void> {
  for (const revisionId of docketRevisionIds) {
    const revision = await client.from("makesafe_docket_revisions")
      .select("id,job_id").eq("id", revisionId).maybeSingle();
    const jobId = String(object(revision.data).job_id || "").trim();
    const artifacts = jobId
      ? await client.from("makesafe_docket_artifacts")
        .select("role,metadata").eq("revision_id", revisionId)
      : { data: null, error: { message: "job identity missing" } };
    const supersessions = jobId
      ? await loadSesCuratedSourceSupersessions(client, jobId)
      : null;
    if (revision.error || !jobId || artifacts.error || !supersessions) {
      throw new SesActionError(
        409,
        curatedSourceMissingRefusal(
          SES_CURATED_SOURCE_SUPERSESSION_UNREADABLE_REASON,
        ),
      );
    }
    const superseded = (artifacts.data || []).some((artifact: any) =>
      artifact.role === "supporting_report_pdf" &&
      sesSupportingReportIsSuperseded(artifact, supersessions)
    );
    if (superseded) {
      throw new SesActionError(
        409,
        curatedSourceMissingRefusal(SES_CURATED_SOURCE_SUPERSEDED_REASON),
      );
    }
  }
}

export async function assertSesDocketsSignedOffForSend(
  client: SesSupabaseClient,
  docketRevisionIds: string[],
): Promise<void> {
  const exactIds = [...new Set(docketRevisionIds.filter(Boolean))].sort();
  const asserted = await client.rpc("assert_ses_dockets_signed_off_v1", {
    p_docket_revision_ids: exactIds,
  });
  if (asserted.error || !asserted.data) {
    throw new SesActionError(
      409,
      sesRefusal(
        "docs_ready_signoff_missing",
        "Open each current reviewable pack and record the Captain tick before SEND IT.",
        {
          fact: asserted.error?.message ||
            "No current Captain Docs Ready signoff covers every exact release member.",
          evidence: { docket_revision_ids: exactIds },
        },
      ),
    );
  }
  await assertSesReleasedSourcesNotSuperseded(client, exactIds);
}

export async function executeSesReleaseRevisionAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    release_revision_id: string;
    actor: string;
  },
  mailGateway: SesMailGateway,
  xeroReader: SesReleaseXeroReader,
) {
  if (auth.mode === "routine") {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "The make-safe automation key cannot execute a human-approved builder release.",
    });
  }
  const release = requireValue(
    await client.from("makesafe_release_revisions").select("*")
      .eq("id", args.release_revision_id).maybeSingle(),
    "The approved release revision no longer exists.",
  );
  const membersResponse = await client.from("makesafe_release_revision_members")
    .select("*").eq("release_revision_id", args.release_revision_id)
    .order("ordinal");
  const routesResponse = await client.from("makesafe_release_revision_routes")
    .select("*").eq("release_revision_id", args.release_revision_id)
    .order("ordinal");
  const members = membersResponse.data || [];
  const routes = routesResponse.data || [];
  if (membersResponse.error || routesResponse.error || members.length === 0) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The approved release does not contain the exact member set and required routes.",
    });
  }
  // Infer shape from the release's own route set (not live job state):
  //   AJS: report_invoice + photo (or legacy report+photo half-match)
  //   universal: report + photo + invoice
  const routeKinds = routes.map((route: any) => String(route.route_kind || ""));
  const isAjsRelease = routeKinds.length === 2 &&
    routeKinds.includes("photo") &&
    !routeKinds.includes("invoice") &&
    (routeKinds.includes("report_invoice") || routeKinds.includes("report"));
  const requiredOrder = isAjsRelease
    ? (routeKinds.includes("report_invoice")
      ? sesReleaseRouteOrder("AJS")
      : (["report", "photo"] as typeof SES_ROUTE_ORDER))
    : SES_ROUTE_ORDER;
  if (routes.length !== requiredOrder.length) {
    throw new SesActionError(409, {
      state: "refused",
      fact: isAjsRelease
        ? "The approved AJS release does not contain the exact report_invoice and photo routes."
        : "The approved release does not contain the exact member set and all three required routes.",
    });
  }
  for (const route of routes) {
    try {
      assertSesRouteRecipients({
        recipients: Array.isArray(route.recipients) ? route.recipients : [],
        cc: Array.isArray(route.cc) ? route.cc : [],
      });
    } catch {
      throw new SesActionError(
        409,
        sesRefusal(
          "route_recipient_invalid",
          "Prepare and approve a new release revision with actual email recipients only.",
        ),
      );
    }
  }
  await assertSesDocketsSignedOffForSend(
    client,
    members.map((member: any) => String(member.docket_revision_id || "")),
  );
  requireValue(
    await client.rpc("begin_ses_release_execution_v1", {
      p_release_revision_id: args.release_revision_id,
      p_release_content_hash: release.content_hash,
    }),
    "The current readiness rows and exact SEND IT release could not be reserved for execution.",
  );
  for (const member of members) {
    const approval = await client.from(
      "makesafe_revision_approvals_current_v2",
    ).select("id,approval_content_hash").eq("action", "release")
      .eq("release_revision_id", args.release_revision_id)
      .eq("job_id", member.job_id).limit(1).maybeSingle();
    if (
      approval.error || !approval.data ||
      approval.data.approval_content_hash !== release.content_hash
    ) {
      throw new SesActionError(
        409,
        sesRefusal(
          "release_approval_missing",
          "Open the current composite cockpit and press SEND IT again.",
        ),
      );
    }
    const docket = requireValue(
      await client.from("makesafe_docket_revisions").select(
        "id,xero_binding,invoice_obligation_revision_id",
      ).eq("id", member.docket_revision_id).maybeSingle(),
      "A release member's exact docket revision no longer exists.",
    );
    const xero = object(docket.xero_binding);
    if (xero.status === "AUTHORISED") {
      if (
        !await xeroReader.readAuthorised(String(xero.xero_invoice_id || ""))
      ) {
        throw new SesActionError(
          409,
          sesRefusal(
            "xero_not_authorised",
            "Refresh and authorise the exact Xero invoice, then prepare and approve a new release revision.",
          ),
        );
      }
    } else {
      const noChargeRevision = await client.from(
        "makesafe_invoice_obligation_revisions",
      ).select("id").eq(
        "id",
        member.invoice_obligation_revision_id,
      ).eq("pricing_disposition", "no_additional_charge")
        .eq("state", "proposed").maybeSingle();
      if (noChargeRevision.error || !noChargeRevision.data) {
        throw new SesActionError(
          409,
          sesRefusal(
            "xero_not_authorised",
            "Bind the real AUTHORISED Xero invoice or record this later attendance as no additional charge before release.",
          ),
        );
      }
    }
  }

  const store = createSupabaseSesEffectStore(client);
  const routeProofs = [];
  const exactDocketRevisionIds = members.map((member: any) =>
    String(member.docket_revision_id || "")
  );
  // Reload primary docket envelope so MLB intake-thread coordinates survive
  // even when release_revision_routes has no reply columns (no migration).
  const primaryDocket = members[0]
    ? await client.from("makesafe_docket_revisions").select(
      "id,envelope,review_spec",
    ).eq("id", members[0].docket_revision_id).maybeSingle()
    : { data: null, error: null };
  const primaryEnvelope = object(primaryDocket.data?.envelope);
  const primaryRouting = object(object(primaryEnvelope.v2).routing);
  const primaryClassification = object(
    object(primaryEnvelope.v2).classification,
  );
  const primaryShape = {
    builder_key: String(
      primaryClassification.builder_key ||
        object(primaryDocket.data?.review_spec).builder_key ||
        "",
    ),
    family: String(
      primaryClassification.family ||
        object(primaryDocket.data?.review_spec).family ||
        "",
    ),
  };
  const primaryThread = routingIntakeThread(primaryRouting);
  // Once ANY route of this release has a send effect, execution is in flight:
  // the loop reconciles those routes rather than re-dispatching them, and the
  // stored envelope of the routes still to go cannot be rewritten. Enforcing a
  // CC rule minted after that envelope was approved would strand the release —
  // the only escape a refusal can offer is a new release revision, whose
  // content-derived id mints fresh operation keys and re-mails whatever already
  // went. So an in-flight release keeps the ses@ floor that governed when it
  // was approved; a release that has never dispatched is fully gated, and
  // re-preparing it is safe because no builder copy exists yet.
  let releaseSendInFlight = false;
  if (isAjsRelease) {
    const priorSends = await client.from("ses_external_effects")
      .select("operation_key")
      .eq("release_revision_id", args.release_revision_id)
      .eq("effect_kind", "route_send")
      .limit(1);
    if (priorSends.error) {
      throw new SesActionError(
        503,
        sesRefusal(
          "route_send_proof_unreadable",
          "Retry SEND IT once the release send ledger is readable; never prepare a new release revision to work around this read fault.",
          {
            fact: priorSends.error.message ||
              "The release send effect ledger could not be read.",
            evidence: { release_revision_id: args.release_revision_id },
          },
        ),
      );
    }
    releaseSendInFlight = (priorSends.data || []).length > 0;
  }

  for (const kind of requiredOrder) {
    const route = routes.find((candidate: any) =>
      candidate.route_kind === kind
    );
    if (!route) {
      throw new SesActionError(
        409,
        sesRefusal(
          "route_draft_missing",
          `Prepare and approve the missing ${kind} route on a new release revision.`,
        ),
      );
    }
    await assertSesDocketsSignedOffForSend(
      client,
      exactDocketRevisionIds,
    );
    // Envelope check for AJS two-email shape: cc must include the permanent pack
    // set (ses@ + vanessa@ajs.build + mandi@ajs.build), TO present. A release
    // already in flight keeps the ses@ floor that governed at approval — see
    // releaseSendInFlight above.
    // Filename-level client-send gates (report+invoice PDFs / photo images) are
    // applied when operators build the payload; at execute we only have content
    // hashes, so we enforce the sealed envelope facts that survive hashing.
    if (isAjsRelease) {
      const ccList = (Array.isArray(route.cc) ? route.cc : []).map((
        v: string,
      ) => String(v || "").trim().toLowerCase());
      const requiredCc = releaseSendInFlight ? [MAKESAFE_CC] : ajsPackCc();
      for (const required of requiredCc) {
        if (!ccList.includes(required.trim().toLowerCase())) {
          throw new SesActionError(
            409,
            sesRefusal(
              "route_recipient_invalid",
              releaseSendInFlight
                ? `AJS pack routes must CC ${required}; this release has already dispatched a route, so reconcile it by its SES operation token and raise the envelope on the next release, never by re-preparing this one.`
                : `AJS pack routes must CC ${required}; prepare a new release revision.`,
              {
                evidence: {
                  route_kind: kind,
                  cc: ccList,
                  required: requiredCc,
                  release_send_in_flight: releaseSendInFlight,
                },
              },
            ),
          );
        }
      }
      if (
        (kind === "report_invoice" || kind === "report") &&
        (!Array.isArray(route.attachment_hashes) ||
          route.attachment_hashes.length < 1)
      ) {
        throw new SesActionError(
          409,
          sesRefusal(
            "route_draft_missing",
            "AJS report+invoice route has no attachments; prepare a new release with the report and authorised Xero invoice.",
            { evidence: { route_kind: kind } },
          ),
        );
      }
    }
    // MLB physical report/photo: stamp transport. Locked shape requires intake
    // thread reply and refuses a quiet new thread. Under the temporary Captain
    // ordinary-mail exception, requires_thread_reply stays false and routes
    // use admin@ Mail.Send with Sent Items header proof (see
    // MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1).
    const sendRoute = applyMlbThreadReplyToRoute(
      {
        ...route,
        route_kind: kind,
        ready: true,
      },
      primaryShape,
      primaryThread,
    );
    if (
      sendRoute.requires_thread_reply &&
      !String(sendRoute.reply_to_thread_id || "").trim()
    ) {
      throw new SesActionError(
        409,
        sesRefusal(
          "intake_thread_reply_unavailable",
          "MLB physical report and photo routes must reply on the work-order intake thread. The docket has no intake_thread_id — re-prepare after the intake case source is bound, or recover the thread id. A new thread is refused.",
          {
            evidence: {
              route_kind: kind,
              builder_key: primaryShape.builder_key,
              family: primaryShape.family,
            },
          },
        ),
      );
    }
    // Pre-Graph volume guard from stored size_bytes (no byte download). Loud
    // refusal if the pack cannot fit one message; never cull photos.
    {
      const attachmentHashes: unknown[] = Array.isArray(route.attachment_hashes)
        ? route.attachment_hashes
        : [];
      const hashes: string[] = [
        ...new Set<string>(
          attachmentHashes
            .map((h: unknown) => String(h || "").trim())
            .filter((h): h is string => typeof h === "string" && h.length > 0),
        ),
      ];
      if (hashes.length > 0) {
        const sizeRows = await client.from("makesafe_docket_artifacts").select(
          "content_hash,size_bytes,object_key,media_type",
        ).in("content_hash", hashes);
        if (sizeRows.error) {
          throw new SesActionError(503, {
            state: "refused",
            fact:
              `Attachment sizes could not be read before Graph send (${sizeRows.error.message})`,
          });
        }
        const byHash = new Map<string, any>();
        for (const row of sizeRows.data || []) {
          if (!byHash.has(row.content_hash)) byHash.set(row.content_hash, row);
        }
        const missing = hashes.filter((hash) => !byHash.has(hash));
        if (missing.length) {
          throw new SesActionError(
            409,
            sesRefusal(
              "route_draft_missing",
              "Release attachments are missing size metadata; re-prepare the docket before SEND IT.",
              {
                evidence: { missing_content_hashes: missing, route_kind: kind },
              },
            ),
          );
        }
        const transport = resolveSesMailTransport(sendRoute);
        const volumeVerdict = evaluateSesPhotoMailVolume(
          hashes.map((hash) => {
            const row = byHash.get(hash)!;
            const objectKey = String(row.object_key || "");
            const name = decodeURIComponent(
              objectKey.split("/").pop() || hash.slice(0, 12),
            );
            return {
              name,
              size_bytes: Number(row.size_bytes) || 0,
            };
          }),
          transport,
        );
        if (!volumeVerdict.ok) {
          throw new SesActionError(
            409,
            sesPhotoMailVolumeRefusal(volumeVerdict),
          );
        }
      }
    }
    const mlbExceptionRouteFields = mlbOrdinaryMailSendEffectPayloadFields(
      sendRoute as any,
    );
    const effect = await buildSesEffect({
      org_id: args.org_id,
      effect_kind: "route_send",
      release_revision_id: args.release_revision_id,
      route_kind: kind,
      payload: {
        recipients: route.recipients,
        cc: route.cc,
        subject: route.subject,
        body: route.body,
        body_hash: route.body_hash,
        attachment_hashes: route.attachment_hashes,
        reply_to_thread_id: sendRoute.reply_to_thread_id || null,
        reply_to_graph_message_id: sendRoute.reply_to_graph_message_id || null,
        requires_thread_reply: sendRoute.requires_thread_reply === true,
        ...mlbExceptionRouteFields,
      },
    });
    const adapter: SesExternalAdapter<
      Record<string, any>,
      SesRouteSendResult
    > = {
      dispatch: (payload, context) =>
        mailGateway.createDraftAndSend(payload, context),
      reconcile: (context) => mailGateway.reconcileSent(context.external_token),
      identify: (result) => result.message_id,
      digest: (result) => ({
        message_id: result.message_id,
        internet_message_id: result.internet_message_id || null,
        operation_token: result.operation_token,
      }),
    };
    const sent = await executeSesExternalEffect({
      store,
      effect,
      payload: {
        ...route,
        reply_to_thread_id: sendRoute.reply_to_thread_id || null,
        reply_to_graph_message_id: sendRoute.reply_to_graph_message_id || null,
        requires_thread_reply: sendRoute.requires_thread_reply === true,
        ...mlbExceptionRouteFields,
      },
      adapter,
      actor: args.actor,
    });
    if (sent.state !== "confirmed") {
      // Surface the underlying Graph/transport failure when the effect ledger
      // recorded one — graph_outcome_unknown alone was swallowing 4xx/5xx text
      // and leaving operators with a permanent "unknown" dead end.
      const refusal = sent.refusal!;
      const failureDetail = object(
        object(sent.effect as any).failure ||
          object((sent.effect as any).provider_digest).failure,
      );
      const failureMessage = String(
        failureDetail.message || (sent.effect as any)?.failure?.message || "",
      ).trim();
      if (failureMessage && refusal.code === "graph_outcome_unknown") {
        throw new SesActionError(409, {
          ...refusal,
          fact: `${refusal.fact} Underlying error: ${
            failureMessage.slice(0, 400)
          }`,
          evidence: {
            ...(refusal.evidence || {}),
            underlying_error: failureMessage.slice(0, 500),
            effect_state: sent.effect.state,
            route_kind: kind,
            external_token: effect.external_token,
          },
        });
      }
      throw new SesActionError(409, {
        ...refusal,
        evidence: {
          ...(refusal.evidence || {}),
          effect_state: sent.effect.state,
          route_kind: kind,
          external_token: effect.external_token,
        },
      });
    }
    const result = sent.result ||
      await mailGateway.reconcileSent(effect.external_token).then((rows) =>
        rows[0]
      );
    if (!result) {
      throw new SesActionError(
        409,
        sesRefusal(
          "graph_outcome_unknown",
          "Reconcile Sent Items by the exact SES operation token; never send this route again.",
          {
            evidence: {
              route_kind: kind,
              external_token: effect.external_token,
              effect_state: sent.effect.state,
            },
          },
        ),
      );
    }
    const proofHash = await sesSha256({
      release_revision_id: args.release_revision_id,
      route_kind: kind,
      effect_operation_key: effect.operation_key,
      external_token: effect.external_token,
      external_message_id: result.message_id,
      members,
    }, "SecureWorks:ses-release-route-proof:v1\n");
    const proof = await client.rpc("confirm_ses_release_route_v1", {
      p_release_revision_id: args.release_revision_id,
      p_route_kind: kind,
      p_proof_hash: proofHash,
      p_actor: args.actor,
    });
    routeProofs.push(
      requireValue(proof, `The confirmed ${kind} route proof was not stored.`),
    );
  }

  const proofHashes = routeProofs.map((proof) => proof.proof_hash).sort();
  const closeoutHash = await sesSha256({
    release_revision_id: args.release_revision_id,
    required_proof_hashes: proofHashes,
  }, "SecureWorks:ses-release-closeout:v1\n");
  const closeout = await client.rpc("commit_ses_release_closeout_v1", {
    p_closeout: {
      id: stableUuidFromSha256(closeoutHash),
      org_id: args.org_id,
      release_revision_id: args.release_revision_id,
      content_hash: closeoutHash,
      required_proof_hashes: proofHashes,
      created_by: args.actor,
    },
  });
  const committedCloseout = requireValue(
    closeout,
    "Every route sent, but the exact release closeout could not be verified.",
  );
  const verification = await client.from("makesafe_closeout_revisions")
    .select(
      "id,release_revision_id,content_hash,required_proof_hashes,verified,verified_at",
    )
    .eq("id", committedCloseout.id)
    .eq("release_revision_id", args.release_revision_id)
    .eq("verified", true)
    .maybeSingle();
  if (
    verification.error || !verification.data ||
    verification.data.content_hash !== closeoutHash ||
    JSON.stringify(
        [...(verification.data.required_proof_hashes || [])].sort(),
      ) !== JSON.stringify(proofHashes)
  ) {
    throw new SesActionError(503, {
      state: "refused",
      fact: isAjsRelease
        ? "Both AJS routes are sent, but the independent closeout read-back does not prove the exact route-proof set; do not send again."
        : "All three routes are sent, but the independent closeout read-back does not prove the exact route-proof set; do not send again.",
    });
  }
  return {
    state: "released",
    release_revision_id: args.release_revision_id,
    release_content_hash: release.content_hash,
    route_proofs: routeProofs,
    closeout: verification.data,
  };
}

export async function querySesProofLedgerAction(
  client: SesSupabaseClient,
  releaseRevisionId: string,
) {
  const response = await client.from("ses_release_proof_ledger")
    .select("*").eq("release_revision_id", releaseRevisionId)
    .order("route_kind");
  if (response.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The release proof ledger could not be read (${
        response.error.message || "unknown database error"
      }).`,
    });
  }
  return { proofs: response.data || [] };
}

export async function recordSesReviewFeedbackAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    docket_revision_id: string;
    job_id: string;
    change_type: string;
    before: unknown;
    after: unknown;
  },
) {
  const operatorAuth = await loadOperatorAuth(client, auth);
  const identifiedOperator = operatorAuth.mode === "jwt" &&
    !!auth.user &&
    (
      !!operatorAuth.operator_class ||
      ["admin", "owner"].includes(auth.user.role)
    );
  if (!identifiedOperator || !auth.user) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "Review feedback has no identified SES operator; sign in as an allowlisted reviewer or admin-owner.",
    });
  }
  const inserted = await client.rpc("record_ses_review_feedback_v1", {
    p_feedback: {
      docket_revision_id: args.docket_revision_id,
      job_id: args.job_id,
      change_type: args.change_type,
      before: args.before,
      after: args.after,
      operator_id: auth.user.id,
      operator: auth.user.email || auth.user.id,
    },
  });
  return {
    feedback: requireValue(
      inserted,
      "The review feedback entry could not be appended.",
    ),
    release_executed: false,
  };
}

export function sesActionErrorResponse(error: unknown): {
  status: number;
  body: Record<string, unknown>;
} | null {
  if (error instanceof SesActionError) {
    return {
      status: error.status,
      body: {
        success: false,
        refusal: error.refusal,
        error: error.refusal.fact,
      },
    };
  }
  if (isSesRefusal(error)) {
    return {
      status: 409,
      body: { success: false, refusal: error, error: error.fact },
    };
  }
  return null;
}
