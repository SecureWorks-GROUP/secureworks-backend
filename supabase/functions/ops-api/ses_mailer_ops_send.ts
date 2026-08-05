// deno-lint-ignore-file no-explicit-any
/**
 * Ops-visibility ordinary Mail.Send to the builder WORK-ORDER mailer.
 *
 * Captain 2026-08-05 (mailer ops visibility):
 *   (1) NEW Mail.Send TO work-order mailer, CC ses@secureworkswa.com.au,
 *       FROM admin@, EXACT original WO subject, make-safe report PDF only.
 *   (2) NEW Mail.Send same To/CC/From/subject (or "Photo Evidence - REF" when
 *       the original subject is missing), capped photo set.
 *   No invoice on this path. Prove admin@ Sent Items. Do not resend makesafes@ packs.
 *
 * This action is itself the audited route. It does NOT weaken:
 *   - send-outlook-email (still refuses sealed SES / pdf without provenance)
 *   - sealed_ses_money_fence (money still only through SES release)
 *   - execute_ses_release_revision (billing pack untouched)
 *
 * Structural invariants (not conventions):
 *   - route kind is report|photo only (TypeScript + runtime + DB CHECK)
 *   - attachment roles are report_pdf|site_photo only (no invoice code path)
 *   - CC is always and only ses@secureworkswa.com.au (intake mailbox proof surface)
 *   - photo cap lives ONLY in this module (billing pack never imports it)
 *   - dry_run defaults true; live Graph requires dry_run:false
 *   - one job_id per call (cards are independently driveable; hard stop after card one)
 */

import {
  buildSesEffect,
  executeSesExternalEffect,
  type SesExternalAdapter,
  type SesExternalEffectStore,
} from "./ses_external_effects.ts";
import {
  sesSha256,
  sesSha256Bytes,
} from "./ses_docket_envelope.ts";
import {
  SES_OPERATION_HEADER,
  SES_RELEASE_CC,
  SES_RELEASE_MAILBOX,
  type SesMailGateway,
  type SesRouteAttachment,
  type SesRouteSendResult,
} from "./ses_graph_mail_gateway.ts";
import {
  mlbOrdinaryMailSubject,
  pickIntakeWorkOrderEmailSubject,
  type MlbIntakeEmailSubjectSource,
} from "./ses_mlb_thread_reply.ts";
import {
  evaluateSesPhotoMailVolume,
  sesPhotoMailVolumeRefusal,
} from "./ses_photo_mail_volume_guard.ts";
import {
  SesActionError,
  type SesActionAuth,
} from "./ses_reporting_actions.ts";
import { type SesRefusal, sesRefusal } from "./ses_reporting_refusals.ts";

/** Local refusal builder — mailer-ops codes are not on the shared FACTS table. */
function mailerRefusal(
  code: string,
  fact: string,
  options: {
    recovery_action?: string;
    evidence?: Record<string, unknown>;
  } = {},
): SesRefusal {
  return {
    state: "refused",
    code,
    fact,
    recovery_action: options.recovery_action ||
      "Resolve the refusal evidence and retry.",
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

// ── Structural constants ───────────────────────────────────────────────────

/** Contract version for payloads / proofs. Bump only on semantics change. */
export const MAILER_OPS_SEND_CONTRACT_VERSION = "mailer-ops-visibility-send/v1";

/**
 * From mailbox — always admin@. Same mailbox the SES release ordinary path uses.
 * Not caller-overridable.
 */
export const MAILER_OPS_FROM = SES_RELEASE_MAILBOX;

/**
 * Mandatory CC — Captain confirmation: exact address ses@secureworkswa.com.au.
 * This is our intake mailbox: a second independent proof surface beyond admin@
 * Sent Items. Not caller-overridable; never abbreviated or variant-guessed.
 */
export const MAILER_OPS_CC = SES_RELEASE_CC; // "ses@secureworkswa.com.au"

/**
 * Photo cap for THIS route only. Billing pack / docket / curated report paths
 * must never import this constant.
 */
export const MAILER_OPS_PHOTO_CAP = 12;

/** Allowed route kinds. Invoice is intentionally absent. */
export type MailerOpsRouteKind = "report" | "photo";

/** Attachment roles this route can ever carry. Invoice is intentionally absent. */
export type MailerOpsAttachmentRole = "report_pdf" | "site_photo";

const MONEY_DOCUMENT_TYPES = new Set([
  "invoice",
  "supplier_invoice",
  "xero_invoice",
  "deposit_invoice",
]);

// ── Pure helpers (exported for in-process tests) ───────────────────────────

export function isMailerOpsRouteKind(value: unknown): value is MailerOpsRouteKind {
  return value === "report" || value === "photo";
}

/** Structural: invoice is never a valid mailer-ops kind. */
export function mailerOpsRouteKindAllowsInvoice(): boolean {
  return false;
}

/**
 * Representative spread across the full ordered photo list — not first N.
 * Returns indices into the available array. Cap only shrinks the selection;
 * never re-orders for billing completeness elsewhere.
 */
export function selectRepresentativePhotoIndices(
  availableCount: number,
  cap: number = MAILER_OPS_PHOTO_CAP,
): number[] {
  const n = Math.max(0, Math.floor(availableCount));
  const k = Math.max(0, Math.floor(cap));
  if (n === 0 || k === 0) return [];
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  const picked = new Set<number>();
  for (let i = 0; i < k; i++) {
    picked.add(Math.round((i * (n - 1)) / (k - 1)));
  }
  // Rounding can collapse a few slots; fill gaps from the middle outward so we
  // still prefer a spread rather than only the head of the list.
  if (picked.size < k) {
    const mid = Math.floor(n / 2);
    for (let d = 0; d < n && picked.size < k; d++) {
      const left = mid - d;
      const right = mid + d;
      if (left >= 0) picked.add(left);
      if (picked.size >= k) break;
      if (right < n) picked.add(right);
    }
  }
  return [...picked].sort((a, b) => a - b).slice(0, k);
}

/**
 * Full-email entries from company sender_patterns. Domain-only patterns are
 * not usable as a To address.
 */
export function extractMailerAddressesFromSenderPatterns(
  patterns: unknown,
): string[] {
  if (!Array.isArray(patterns)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of patterns) {
    const value = String(raw || "").trim().toLowerCase();
    if (!value || !value.includes("@")) continue;
    // Reject bare domains that somehow include @ without a local part.
    const [local, domain] = value.split("@");
    if (!local || !domain || domain.includes("@")) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function resolveMailerOpsRecipient(args: {
  senderPatterns: unknown;
  requestedTo?: string | null;
}): { to: string; source: "sender_patterns" | "requested_allowlisted" } {
  const candidates = extractMailerAddressesFromSenderPatterns(
    args.senderPatterns,
  );
  if (candidates.length === 0) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_recipient_unresolved",
        "No full-email work-order mailer address is configured on the company sender_patterns; cannot send mailer ops visibility.",
        {
          recovery_action:
            "Add the builder work-order mailer (full address, e.g. mlb.mailer@primeeco.tech) to makesafe_companies.sender_patterns.",
        },
      ),
    );
  }
  const requested = String(args.requestedTo || "").trim().toLowerCase();
  if (requested) {
    if (!candidates.includes(requested)) {
      throw new SesActionError(
        409,
        mailerRefusal(
          "mailer_recipient_not_allowlisted",
          "The requested To address is not one of this company's work-order mailer addresses.",
          {
            recovery_action:
              "Pass a To that matches a full-email sender_patterns entry for the company.",
            evidence: {
              requested,
              allowlisted: candidates,
            },
          },
        ),
      );
    }
    return { to: requested, source: "requested_allowlisted" };
  }
  if (candidates.length > 1) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_recipient_ambiguous",
        "Multiple work-order mailer addresses are configured; pass an explicit To from the allowlist.",
        {
          recovery_action:
            "Retry with body.to set to exactly one of the company sender_patterns full-email addresses.",
          evidence: { allowlisted: candidates },
        },
      ),
    );
  }
  return { to: candidates[0]!, source: "sender_patterns" };
}

/**
 * Subject for mailer ops: exact original WO subject when recoverable (PR 591
 * path via pickIntakeWorkOrderEmailSubject), else generated fallback.
 * Photo kind uses "Photo Evidence - {ref}" when original is missing.
 */
export function resolveMailerOpsSubject(args: {
  kind: MailerOpsRouteKind;
  emailsSubjects?: readonly (string | null | undefined)[] | string | null;
  draftSubjects?: readonly (string | null | undefined)[] | string | null;
  jobMetadataSubject?: string | null;
  builderReference?: string | null;
  jobNumber?: string | null;
}): {
  subject: string;
  subject_source: MlbIntakeEmailSubjectSource | "generated_fallback" | null;
  original_subject: string | null;
  pick_ambiguous: boolean;
} {
  const pick = pickIntakeWorkOrderEmailSubject({
    emailsSubjects: args.emailsSubjects,
    draftSubjects: args.draftSubjects,
    jobMetadataSubject: args.jobMetadataSubject,
  });
  const ref = String(args.builderReference || args.jobNumber || "WORK-ORDER")
    .trim() || "WORK-ORDER";
  const generated = args.kind === "photo"
    ? `Photo Evidence - ${ref}`
    : `Make-Safe Report - ${ref}`;
  const ordinary = mlbOrdinaryMailSubject(
    pick.subject,
    generated,
    pick.subject_source,
  );
  return {
    subject: ordinary.subject,
    subject_source: ordinary.subject_source,
    original_subject: ordinary.original_subject,
    pick_ambiguous: pick.ambiguous,
  };
}

/** Parse a public storage URL into bucket + path for storage.download. */
export function parsePublicStorageUrl(
  url: string,
): { bucket: string; path: string } | null {
  const raw = String(url || "").trim();
  if (!raw) return null;
  // /storage/v1/object/public/<bucket>/<path>
  // /storage/v1/object/sign/<bucket>/<path>?...
  const match = raw.match(
    /\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+?)(?:\?|$)/i,
  );
  if (!match) return null;
  const bucket = decodeURIComponent(match[1] || "").trim();
  const path = decodeURIComponent(match[2] || "").trim();
  if (!bucket || !path) return null;
  return { bucket, path };
}

export function assertNotMoneyDocumentType(docType: unknown): void {
  const t = String(docType || "").trim().toLowerCase();
  if (MONEY_DOCUMENT_TYPES.has(t) || t.includes("invoice")) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_ops_invoice_structurally_forbidden",
        "The mailer ops visibility route cannot attach a money document. Invoice is not a valid attachment on this path.",
        {
          recovery_action:
            "Use execute_ses_release_revision for billing packs. This route only carries makesafe_report or site photos.",
          evidence: { refused_document_type: t },
        },
      ),
    );
  }
}

export function assertMailerOpsCcInvariant(cc: readonly string[]): void {
  if (cc.length !== 1 || cc[0] !== MAILER_OPS_CC) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_ops_cc_invariant",
        `Mailer ops visibility must CC exactly ${MAILER_OPS_CC} (intake mailbox proof surface).`,
        {
          recovery_action:
            "Do not override CC. The action always sets this address server-side.",
          evidence: { received_cc: cc, required_cc: MAILER_OPS_CC },
        },
      ),
    );
  }
}

export function assertMailerOpsAttachmentRoles(
  roles: readonly MailerOpsAttachmentRole[],
  kind: MailerOpsRouteKind,
): void {
  if (kind === "report") {
    if (roles.length !== 1 || roles[0] !== "report_pdf") {
      throw new SesActionError(
        409,
        mailerRefusal(
          "mailer_ops_attachment_role_mismatch",
          "Report mailer ops email must carry exactly one report_pdf attachment.",
          { evidence: { roles: [...roles], kind } },
        ),
      );
    }
    return;
  }
  if (roles.some((r) => r !== "site_photo") || roles.length === 0) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_ops_attachment_role_mismatch",
        "Photo mailer ops email must carry only site_photo attachments.",
        { evidence: { roles: [...roles], kind } },
      ),
    );
  }
}

// ── Provenance for the report PDF ──────────────────────────────────────────

export interface MailerOpsReportProvenance {
  job_document_id: string;
  job_id: string;
  type: "makesafe_report";
  file_name: string;
  storage_url: string | null;
  expected_raw_sha256: string | null;
  report_input_hash: string | null;
  curated_source_kind: string | null;
  curated_source_identity: string | null;
  provenance_satisfied: "curated_bind" | "job_document_bound";
  content_hash: string;
  size_bytes: number;
  bytes: Uint8Array;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function rawSha(value: unknown): string {
  const normalized = String(value || "").toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : "";
}

async function downloadStorageBytes(
  client: any,
  storageUrl: string,
): Promise<Uint8Array> {
  const parsed = parsePublicStorageUrl(storageUrl);
  if (parsed) {
    const downloaded = await client.storage.from(parsed.bucket).download(
      parsed.path,
    );
    if (downloaded.error || !downloaded.data) {
      throw new SesActionError(
        503,
        mailerRefusal(
          "mailer_ops_attachment_unreadable",
          `Attachment bytes could not be downloaded from storage (${
            downloaded.error?.message || "no bytes"
          }).`,
          { evidence: { storage_url: storageUrl, bucket: parsed.bucket } },
        ),
      );
    }
    return new Uint8Array(await downloaded.data.arrayBuffer());
  }
  // Fallback: HTTP fetch of the public URL (no Graph).
  try {
    const response = await fetch(storageUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    throw new SesActionError(
      503,
      mailerRefusal(
        "mailer_ops_attachment_unreadable",
        `Attachment bytes could not be fetched (${
          (err as Error).message || "unknown"
        }).`,
        { evidence: { storage_url: storageUrl } },
      ),
    );
  }
}

/**
 * Resolve the make-safe report PDF and prove provenance.
 * Satisfies pdf_provenance_required: document is a job_documents row of type
 * makesafe_report owned by this job_id; curated bind stamps preferred.
 */
export async function resolveMailerOpsReportAttachment(
  client: any,
  jobId: string,
  preferredDocumentId?: string | null,
): Promise<MailerOpsReportProvenance> {
  const docs = await client.from("job_documents")
    .select(
      "id,job_id,type,file_name,storage_url,pdf_url,data_snapshot_json,created_at,attendance_cycle_id,cycle_attribution,version",
    )
    .eq("job_id", jobId)
    .eq("type", "makesafe_report")
    .order("created_at", { ascending: false });
  if (docs.error) {
    throw new SesActionError(
      503,
      mailerRefusal(
        "mailer_ops_report_lookup_failed",
        `job_documents lookup failed (${docs.error.message}).`,
      ),
    );
  }
  const rows: any[] = Array.isArray(docs.data) ? docs.data : [];
  if (rows.length === 0) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_ops_report_missing",
        "No makesafe_report job_document is bound to this job; cannot satisfy pdf provenance for mailer ops send.",
        {
          recovery_action:
            "Bind a curated make-safe report (bind_current_cycle_curated_makesafe_report) before mailer ops send.",
          evidence: { job_id: jobId },
        },
      ),
    );
  }

  let chosen: any | null = null;
  const preferred = text(preferredDocumentId);
  if (preferred) {
    chosen = rows.find((r) => text(r.id) === preferred) || null;
    if (!chosen) {
      throw new SesActionError(
        409,
        {
          state: "refused",
          code: "pdf_provenance_required",
          fact:
            "The PDF job_document_id does not belong to the supplied job_id or is not a makesafe_report.",
          recovery_action:
            "Use the makesafe_report document and job identities stored together.",
          evidence: {
            job_document_id: preferred,
            job_id: jobId,
          },
        } as SesRefusal,
      );
    }
  } else {
    // Prefer curated-bound report (durable stamps), else newest makesafe_report.
    chosen = rows.find((r) => {
      const snap = object(r.data_snapshot_json);
      return text(snap.curated_source_kind) === "durable_curated_revision" &&
        rawSha(
          snap.curated_source_expected_raw_sha256 || snap.report_render_hash,
        );
    }) || rows[0];
  }

  assertNotMoneyDocumentType(chosen.type);
  if (text(chosen.type).toLowerCase() !== "makesafe_report") {
    throw new SesActionError(
      409,
      {
        state: "refused",
        code: "pdf_provenance_required",
        fact: "Mailer ops report attachment must be a makesafe_report job_document.",
        recovery_action: "Attach only the bound make-safe report PDF.",
        evidence: {
          job_document_id: chosen.id,
          type: chosen.type,
        },
      } as SesRefusal,
    );
  }
  if (text(chosen.job_id) !== jobId) {
    throw new SesActionError(
      409,
      {
        state: "refused",
        code: "pdf_provenance_required",
        fact: "The PDF job_document_id does not belong to the supplied job_id.",
        recovery_action: "Use the document and job identities stored together.",
        evidence: {
          job_document_id: chosen.id,
          stored_job_id: chosen.job_id,
          received_job_id: jobId,
        },
      } as SesRefusal,
    );
  }

  const storageUrl = text(chosen.storage_url) || text(chosen.pdf_url);
  if (!storageUrl) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_ops_report_storage_missing",
        "The makesafe_report document has no storage_url/pdf_url to download.",
        { evidence: { job_document_id: chosen.id } },
      ),
    );
  }

  const bytes = await downloadStorageBytes(client, storageUrl);
  if (bytes.byteLength < 5 ||
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) !==
      "%PDF-") {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_ops_report_not_pdf",
        "Downloaded report bytes are not a PDF.",
        {
          evidence: {
            job_document_id: chosen.id,
            size_bytes: bytes.byteLength,
          },
        },
      ),
    );
  }

  // Content hash for attachment identity (artifact-bytes domain).
  const contentHash = await sesSha256Bytes(bytes);
  const snap = object(chosen.data_snapshot_json);
  const expectedRaw = rawSha(
    snap.curated_source_expected_raw_sha256 || snap.report_render_hash,
  );
  if (expectedRaw) {
    // Prove served bytes match the curated bind coordinate (satisfy provenance).
    const actualRaw = contentHash.slice("sha256:".length);
    // Note: sesSha256Bytes uses artifact domain; curated raw is plain file SHA.
    // Recompute plain SHA-256 of raw bytes for the bind coordinate check.
    const plainDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    );
    const plainHex = Array.from(plainDigest).map((b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
    if (plainHex !== expectedRaw) {
      throw new SesActionError(
        409,
        {
          state: "refused",
          code: "pdf_provenance_required",
          fact:
            "Downloaded report PDF bytes do not match the curated expected_raw_sha256 provenance stamp.",
          recovery_action:
            "Re-bind the current-cycle curated report, or re-prepare so the served document matches the bind.",
          evidence: {
            job_document_id: chosen.id,
            expected_raw_sha256: `sha256:${expectedRaw}`,
            actual_raw_sha256: `sha256:${plainHex}`,
          },
        } as SesRefusal,
      );
    }
  }

  const provenanceSatisfied: MailerOpsReportProvenance["provenance_satisfied"] =
    text(snap.curated_source_kind) === "durable_curated_revision" && expectedRaw
      ? "curated_bind"
      : "job_document_bound";

  if (provenanceSatisfied === "job_document_bound" && !expectedRaw) {
    // Still valid provenance: job_document_id + type + job ownership. Prefer
    // curated when present; do not refuse a typed bound report solely for
    // missing curated stamps (historical cards may only have the document row).
  }

  return {
    job_document_id: text(chosen.id),
    job_id: jobId,
    type: "makesafe_report",
    file_name: text(chosen.file_name) || "makesafe-report.pdf",
    storage_url: storageUrl,
    expected_raw_sha256: expectedRaw ? `sha256:${expectedRaw}` : null,
    report_input_hash: text(snap.report_input_hash) || null,
    curated_source_kind: text(snap.curated_source_kind) || null,
    curated_source_identity: text(snap.curated_source_identity) || null,
    provenance_satisfied: provenanceSatisfied,
    content_hash: contentHash,
    size_bytes: bytes.byteLength,
    bytes,
  };
}

// ── Photos ─────────────────────────────────────────────────────────────────

export interface MailerOpsPhotoSelection {
  available_count: number;
  selected_count: number;
  cap: number;
  photos: Array<{
    media_id: string;
    file_name: string;
    storage_url: string;
    size_bytes: number;
    content_hash: string;
    bytes: Uint8Array;
    role: "site_photo";
  }>;
}

export async function resolveMailerOpsPhotoAttachments(
  client: any,
  jobId: string,
  cap: number = MAILER_OPS_PHOTO_CAP,
): Promise<MailerOpsPhotoSelection> {
  const media = await client.from("job_media")
    .select(
      "id,job_id,type,storage_url,url,file_name,label,created_at,size_bytes,makesafe_content_hash",
    )
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });
  if (media.error) {
    throw new SesActionError(
      503,
      mailerRefusal(
        "mailer_ops_photo_lookup_failed",
        `job_media lookup failed (${media.error.message}).`,
      ),
    );
  }
  const all: any[] = (Array.isArray(media.data) ? media.data : []).filter(
    (row: any) => {
      const t = text(row.type).toLowerCase();
      return !t || t === "photo";
    },
  );
  if (all.length === 0) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_ops_photos_missing",
        "No site photos are available on this job for mailer ops visibility.",
        { evidence: { job_id: jobId } },
      ),
    );
  }

  const indices = selectRepresentativePhotoIndices(all.length, cap);
  const selectedRows = indices.map((i) => all[i]!);
  const photos: MailerOpsPhotoSelection["photos"] = [];

  for (const row of selectedRows) {
    const storageUrl = text(row.storage_url) || text(row.url);
    if (!storageUrl) {
      throw new SesActionError(
        409,
        mailerRefusal(
          "mailer_ops_photo_storage_missing",
          "A selected photo has no storage_url.",
          { evidence: { media_id: row.id, job_id: jobId } },
        ),
      );
    }
    const bytes = await downloadStorageBytes(client, storageUrl);
    const contentHash = text(row.makesafe_content_hash) &&
        /^sha256:[0-9a-f]{64}$/i.test(text(row.makesafe_content_hash))
      ? text(row.makesafe_content_hash).toLowerCase()
      : await sesSha256Bytes(bytes);
    const name = text(row.file_name) || text(row.label) ||
      `photo-${text(row.id).slice(0, 8)}.jpg`;
    photos.push({
      media_id: text(row.id),
      file_name: name,
      storage_url: storageUrl,
      size_bytes: bytes.byteLength,
      content_hash: contentHash,
      bytes,
      role: "site_photo",
    });
  }

  // Oversize guard (PR 587): refuse, never trim further after the cap.
  const volume = evaluateSesPhotoMailVolume(
    photos.map((p) => ({ name: p.file_name, size_bytes: p.size_bytes })),
    "user_mailbox",
  );
  if (!volume.ok) {
    throw new SesActionError(409, sesPhotoMailVolumeRefusal(volume));
  }

  return {
    available_count: all.length,
    selected_count: photos.length,
    cap,
    photos,
  };
}

// ── Subject resolution (DB load) ───────────────────────────────────────────

async function loadMailerOpsSubjectInputs(
  client: any,
  jobId: string,
  jobMetadata: Record<string, unknown>,
): Promise<{
  emailsSubjects: string[];
  draftSubjects: string[];
  jobMetadataSubject: string | null;
  builderReference: string | null;
}> {
  const cases = await client.from("makesafe_intake_cases")
    .select(
      "id,job_id,builder_wo_canonical,builder_po_canonical,external_ref_canonical,status",
    )
    .eq("job_id", jobId);
  if (cases.error) {
    throw new SesActionError(
      503,
      mailerRefusal(
        "mailer_ops_subject_lookup_failed",
        `Intake cases could not be read (${cases.error.message}).`,
      ),
    );
  }
  const caseRows: any[] = Array.isArray(cases.data) ? cases.data : [];
  const caseIds = caseRows.map((r) => text(r.id)).filter(Boolean);

  let sourcePostIds: string[] = [];
  if (caseIds.length) {
    const sources = await client.from("makesafe_intake_case_sources")
      .select("case_id,post_id")
      .in("case_id", caseIds);
    if (sources.error) {
      throw new SesActionError(
        503,
        mailerRefusal(
          "mailer_ops_subject_lookup_failed",
          `Intake case sources could not be read (${sources.error.message}).`,
        ),
      );
    }
    const posts = ((Array.isArray(sources.data) ? sources.data : []) as any[])
      .map((r: any) => text(r.post_id))
      .filter((id: string) => id.length > 0);
    sourcePostIds = [...new Set(posts)];
  }

  const emailsSubjects: string[] = [];
  if (sourcePostIds.length) {
    // Chunk by URL budget.
    for (let i = 0; i < sourcePostIds.length; i += 25) {
      const chunk = sourcePostIds.slice(i, i + 25);
      const emails = await client.from("emails")
        .select("post_id,subject")
        .in("post_id", chunk);
      if (emails.error) {
        // Degrade: missing emails table/rows is not fatal; drafts/metadata may recover.
        console.warn(
          "[mailer-ops] emails.subject read failed:",
          emails.error.message,
        );
        break;
      }
      for (const row of emails.data || []) {
        const s = text(row.subject);
        if (s) emailsSubjects.push(s);
      }
    }
  }

  const drafts = await client.from("makesafe_intake_drafts")
    .select("id,subject,status,approved_job_id,graph_message_id")
    .eq("approved_job_id", jobId);
  const draftSubjects: string[] = [];
  if (!drafts.error) {
    for (const row of drafts.data || []) {
      const s = text(row.subject);
      if (s) draftSubjects.push(s);
    }
  }

  const builderReference = text(jobMetadata.builder_reference) ||
    text(caseRows[0]?.builder_wo_canonical) ||
    text(caseRows[0]?.external_ref_canonical) ||
    text(caseRows[0]?.builder_po_canonical) ||
    null;

  return {
    emailsSubjects,
    draftSubjects,
    jobMetadataSubject: text(jobMetadata.builder_email_subject) || null,
    builderReference,
  };
}

// ── Action ─────────────────────────────────────────────────────────────────

export interface SendMailerOpsVisibilityArgs {
  org_id: string;
  job_id: string;
  /** One card, one kind per call — cards are independently driveable. */
  kind: MailerOpsRouteKind;
  /** Optional explicit To; must match company sender_patterns full-email. */
  to?: string | null;
  /** Optional preferred makesafe_report document id. */
  job_document_id?: string | null;
  /**
   * Live Graph send requires dry_run:false. Default true so a deploy cannot
   * accidentally mail builders; the Captain supervises the live send.
   */
  dry_run?: boolean;
  actor?: string;
}

export interface MailerOpsSendProof {
  message_id: string | null;
  internet_message_id: string | null;
  operation_token: string;
  operation_header: typeof SES_OPERATION_HEADER;
  subject_as_sent: string;
  from: typeof MAILER_OPS_FROM;
  to: string[];
  cc: string[];
  attachment_names: string[];
  attachment_roles: MailerOpsAttachmentRole[];
  /** Sent Items is the primary proof; CC to ses@ is the second surface. */
  proof_surfaces: Array<"admin_sent_items" | "ses_intake_cc">;
}

export async function sendMailerOpsVisibilityAction(
  client: any,
  auth: SesActionAuth,
  args: SendMailerOpsVisibilityArgs,
  deps: {
    /**
     * Build a Graph mail gateway whose loadAttachments resolves THIS send's
     * prepared bytes (job_documents / job_media), never docket release hashes
     * and never invoice artifacts.
     */
    makeMailGateway: (
      loadAttachments: (hashes: string[]) => Promise<SesRouteAttachment[]>,
    ) => SesMailGateway;
    effectStore: SesExternalEffectStore;
  },
): Promise<Record<string, unknown>> {
  // Privileged only — never routine (default-deny also blocks, but pin here).
  if (auth.mode === "routine") {
    throw new SesActionError(
      403,
      mailerRefusal(
        "mailer_ops_privileged_only",
        "send_mailer_ops_visibility requires the privileged ops key or an admin/owner session.",
      ),
    );
  }
  if (auth.mode === "jwt") {
    const role = String(auth.user?.role || "").trim().toLowerCase();
    if (role !== "admin" && role !== "owner") {
      throw new SesActionError(
        403,
        mailerRefusal(
          "mailer_ops_privileged_only",
          "send_mailer_ops_visibility requires an admin/owner session.",
        ),
      );
    }
  }

  const jobId = text(args.job_id);
  if (!jobId) {
    throw new SesActionError(
      400,
      mailerRefusal("mailer_ops_job_required", "job_id is required."),
    );
  }
  if (!isMailerOpsRouteKind(args.kind)) {
    throw new SesActionError(
      400,
      mailerRefusal(
        "mailer_ops_kind_invalid",
        "kind must be 'report' or 'photo'. Invoice is structurally forbidden on this route.",
        { evidence: { received: args.kind } },
      ),
    );
  }
  const kind: MailerOpsRouteKind = args.kind;
  const dryRun = args.dry_run !== false; // default true
  const actor = text(args.actor) || auth.user?.email || "mailer-ops-operator";

  // Load job + company
  const jobRes = await client.from("jobs")
    .select(
      "id,org_id,type,job_number,status,metadata,requesting_company_slug,external_ref,site_suburb,ses_money_sealed_at",
    )
    .eq("id", jobId)
    .maybeSingle();
  if (jobRes.error || !jobRes.data) {
    throw new SesActionError(
      404,
      mailerRefusal(
        "mailer_ops_job_missing",
        `Job not found (${jobRes.error?.message || "no row"}).`,
      ),
    );
  }
  const job = jobRes.data;
  const metadata = object(job.metadata);
  const slug = text(job.requesting_company_slug) ||
    text(metadata.requesting_company_slug) ||
    text(metadata.company_slug);

  const companyRes = slug
    ? await client.from("makesafe_companies")
      .select("slug,name,sender_patterns,report_recipient")
      .eq("slug", slug)
      .maybeSingle()
    : { data: null, error: null };
  if (companyRes.error) {
    throw new SesActionError(
      503,
      mailerRefusal(
        "mailer_ops_company_lookup_failed",
        `Company lookup failed (${companyRes.error.message}).`,
      ),
    );
  }
  // Also try detail requesting company when slug missing.
  let senderPatterns = companyRes.data?.sender_patterns;
  if (!senderPatterns) {
    const detail = await client.from("makesafe_job_details")
      .select("job_id,requesting_company_slug,requesting_company_name")
      .eq("job_id", jobId)
      .maybeSingle();
    const detailSlug = text(detail.data?.requesting_company_slug);
    if (detailSlug) {
      const co2 = await client.from("makesafe_companies")
        .select("slug,name,sender_patterns,report_recipient")
        .eq("slug", detailSlug)
        .maybeSingle();
      senderPatterns = co2.data?.sender_patterns;
    }
  }

  const recipient = resolveMailerOpsRecipient({
    senderPatterns,
    requestedTo: args.to,
  });

  // Structural: never use report_recipient (makesafes@) as To on this path.
  const reportRecipient = text(companyRes.data?.report_recipient).toLowerCase();
  if (reportRecipient && recipient.to === reportRecipient) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_ops_billing_recipient_forbidden",
        "Mailer ops visibility must not send to the billing pack report_recipient (makesafes@ path). Use the work-order mailer address.",
        {
          recovery_action:
            "Configure sender_patterns with the work-order mailer full address and pass that as To.",
          evidence: {
            refused_to: recipient.to,
            report_recipient: reportRecipient,
          },
        },
      ),
    );
  }

  const subjectInputs = await loadMailerOpsSubjectInputs(
    client,
    jobId,
    metadata,
  );
  const subjectDecision = resolveMailerOpsSubject({
    kind,
    emailsSubjects: subjectInputs.emailsSubjects,
    draftSubjects: subjectInputs.draftSubjects,
    jobMetadataSubject: subjectInputs.jobMetadataSubject,
    builderReference: subjectInputs.builderReference ||
      text(job.external_ref) || null,
    jobNumber: text(job.job_number) || null,
  });

  // Build attachments — structural roles only.
  const attachmentByHash = new Map<string, SesRouteAttachment>();
  const attachmentRoles: MailerOpsAttachmentRole[] = [];
  const attachmentNames: string[] = [];
  const attachmentHashes: string[] = [];
  let reportProvenance: Omit<MailerOpsReportProvenance, "bytes"> | null = null;
  let photoSelectionMeta: {
    available_count: number;
    selected_count: number;
    cap: number;
    media_ids: string[];
  } | null = null;

  if (kind === "report") {
    const report = await resolveMailerOpsReportAttachment(
      client,
      jobId,
      args.job_document_id,
    );
    attachmentByHash.set(report.content_hash, {
      name: report.file_name,
      contentType: "application/pdf",
      bytes: report.bytes,
    });
    attachmentHashes.push(report.content_hash);
    attachmentRoles.push("report_pdf");
    attachmentNames.push(report.file_name);
    const { bytes: _b, ...rest } = report;
    reportProvenance = rest;
  } else {
    const photos = await resolveMailerOpsPhotoAttachments(client, jobId);
    for (const photo of photos.photos) {
      attachmentByHash.set(photo.content_hash, {
        name: photo.file_name,
        contentType: "image/jpeg",
        bytes: photo.bytes,
      });
      attachmentHashes.push(photo.content_hash);
      attachmentRoles.push("site_photo");
      attachmentNames.push(photo.file_name);
    }
    photoSelectionMeta = {
      available_count: photos.available_count,
      selected_count: photos.selected_count,
      cap: photos.cap,
      media_ids: photos.photos.map((p) => p.media_id),
    };
  }

  assertMailerOpsAttachmentRoles(attachmentRoles, kind);

  const cc = [MAILER_OPS_CC] as const;
  assertMailerOpsCcInvariant(cc);

  const bodyText = kind === "report"
    ? `Please find attached the make-safe report for ${
      text(job.job_number) || jobId
    }.`
    : `Please find attached site photo evidence for ${
      text(job.job_number) || jobId
    }.`;

  const routePayload = {
    route_kind: kind,
    recipients: [recipient.to],
    cc: [...cc],
    subject: subjectDecision.subject,
    body: bodyText,
    attachment_hashes: attachmentHashes,
    // Never thread-reply on this path — ordinary Mail.Send only.
    requires_thread_reply: false,
    reply_to_thread_id: null,
    mailer_ops: true,
    contract_version: MAILER_OPS_SEND_CONTRACT_VERSION,
  };

  // Final volume guard on the exact attachment set (report is usually one PDF;
  // photos already checked, but re-check the composed set).
  const volume = evaluateSesPhotoMailVolume(
    [...attachmentByHash.values()].map((a) => ({
      name: a.name,
      size_bytes: a.bytes.byteLength,
    })),
    "user_mailbox",
  );
  if (!volume.ok) {
    throw new SesActionError(409, sesPhotoMailVolumeRefusal(volume));
  }

  const effectPayload = {
    contract_version: MAILER_OPS_SEND_CONTRACT_VERSION,
    job_id: jobId,
    job_number: text(job.job_number) || null,
    kind,
    from: MAILER_OPS_FROM,
    to: [recipient.to],
    cc: [...cc],
    subject: subjectDecision.subject,
    subject_source: subjectDecision.subject_source,
    original_subject: subjectDecision.original_subject,
    attachment_hashes: attachmentHashes,
    attachment_names: attachmentNames,
    attachment_roles: attachmentRoles,
    report_provenance: reportProvenance,
    photo_selection: photoSelectionMeta,
    // Explicit: no invoice identity on this effect.
    invoice_document_id: null,
    xero_invoice_id: null,
  };

  const effect = await buildSesEffect({
    org_id: text(args.org_id) || text(job.org_id) ||
      "00000000-0000-0000-0000-000000000001",
    job_id: jobId,
    effect_kind: "mailer_ops_send",
    route_kind: kind,
    payload: effectPayload,
  });

  if (dryRun) {
    return {
      success: true,
      dry_run: true,
      contract_version: MAILER_OPS_SEND_CONTRACT_VERSION,
      job_id: jobId,
      job_number: text(job.job_number) || null,
      kind,
      from: MAILER_OPS_FROM,
      to: [recipient.to],
      to_source: recipient.source,
      cc: [...cc],
      subject: subjectDecision.subject,
      subject_source: subjectDecision.subject_source,
      original_subject: subjectDecision.original_subject,
      pick_ambiguous: subjectDecision.pick_ambiguous,
      attachment_names: attachmentNames,
      attachment_roles: attachmentRoles,
      attachment_hashes: attachmentHashes,
      report_provenance: reportProvenance,
      photo_selection: photoSelectionMeta,
      effect_preview: {
        operation_key: effect.operation_key,
        external_token: effect.external_token,
        payload_hash: effect.payload_hash,
        effect_kind: effect.effect_kind,
        route_kind: effect.route_kind,
      },
      // Structural evidence for reviewers:
      fences: {
        pdf_provenance: kind === "report"
          ? {
            satisfied: true,
            mode: reportProvenance?.provenance_satisfied || null,
            job_document_id: reportProvenance?.job_document_id || null,
          }
          : { satisfied: "n/a_photo_route" },
        sealed_ses_release_required: {
          satisfied_by: "this_action_is_the_audited_route",
          effect_kind: "mailer_ops_send",
          notes:
            "Does not exempt send-outlook-email or weaken the money fence; carries its own provenance, effect, and Sent Items proof.",
        },
        invoice_structurally_impossible: true,
        invoice_code_paths: [],
      },
      note:
        "dry_run: no Graph call, no effect claim, no email. Pass dry_run:false under Captain supervision to send.",
    };
  }

  // Live path: claim effect + gateway send + Sent Items proof.
  // Attachment loader is closed over THIS send's prepared map only — no docket
  // artifact read, no invoice path, no shared release loader.
  const loadAttachments = async (
    hashes: string[],
  ): Promise<SesRouteAttachment[]> => {
    const out: SesRouteAttachment[] = [];
    for (const hash of hashes) {
      const row = attachmentByHash.get(hash);
      if (!row) {
        throw new Error(
          `Mailer ops attachment bytes missing for hash ${hash}`,
        );
      }
      out.push(row);
    }
    return out;
  };
  const mailGateway = deps.makeMailGateway(loadAttachments);

  const adapter: SesExternalAdapter<typeof routePayload, SesRouteSendResult> = {
    dispatch: (payload, context) =>
      mailGateway.createDraftAndSend(payload, context),
    reconcile: (context) => mailGateway.reconcileSent(context.external_token),
    identify: (result) => result.message_id,
    digest: (result) => ({
      message_id: result.message_id,
      internet_message_id: result.internet_message_id || null,
      operation_token: result.operation_token,
      subject_as_sent: subjectDecision.subject,
      to: [recipient.to],
      cc: [...cc],
      attachment_names: attachmentNames,
      attachment_roles: attachmentRoles,
      operation_header: SES_OPERATION_HEADER,
      // ses@ CC is a second proof surface (intake mailbox we control).
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
    const refusal = sent.refusal!;
    throw new SesActionError(409, {
      ...refusal,
      evidence: {
        ...(refusal.evidence || {}),
        effect_state: sent.effect.state,
        route_kind: kind,
        external_token: effect.external_token,
        job_id: jobId,
      },
    });
  }

  const result = sent.result ||
    (await mailGateway.reconcileSent(effect.external_token))[0];
  if (!result?.message_id) {
    throw new SesActionError(
      409,
      sesRefusal(
        "graph_outcome_unknown",
        "Reconcile admin@ Sent Items by the exact SES operation token; do not redispatch this mailer ops send.",
        {
          evidence: {
            external_token: effect.external_token,
            job_id: jobId,
            kind,
          },
        },
      ),
    );
  }

  const proof: MailerOpsSendProof = {
    message_id: result.message_id,
    internet_message_id: result.internet_message_id || null,
    operation_token: effect.external_token,
    operation_header: SES_OPERATION_HEADER,
    subject_as_sent: subjectDecision.subject,
    from: MAILER_OPS_FROM,
    to: [recipient.to],
    cc: [...cc],
    attachment_names: attachmentNames,
    attachment_roles: attachmentRoles,
    proof_surfaces: ["admin_sent_items", "ses_intake_cc"],
  };

  // Append-only human-readable audit (best-effort; effect ledger is authoritative).
  try {
    await client.from("job_events").insert({
      job_id: jobId,
      event_type: "mailer_ops_visibility_sent",
      detail_json: {
        contract_version: MAILER_OPS_SEND_CONTRACT_VERSION,
        kind,
        proof,
        effect_operation_key: effect.operation_key,
        effect_id: sent.effect.id || null,
        report_provenance: reportProvenance,
        photo_selection: photoSelectionMeta,
        actor,
      },
    });
  } catch (err) {
    console.warn(
      "[mailer-ops] job_events insert failed:",
      (err as Error).message,
    );
  }

  return {
    success: true,
    dry_run: false,
    contract_version: MAILER_OPS_SEND_CONTRACT_VERSION,
    job_id: jobId,
    job_number: text(job.job_number) || null,
    kind,
    proof,
    effect: {
      operation_key: effect.operation_key,
      external_token: effect.external_token,
      state: sent.effect.state,
      effect_kind: "mailer_ops_send",
      route_kind: kind,
    },
    subject_source: subjectDecision.subject_source,
    original_subject: subjectDecision.original_subject,
    report_provenance: reportProvenance,
    photo_selection: photoSelectionMeta,
    fences: {
      pdf_provenance: kind === "report"
        ? {
          satisfied: true,
          mode: reportProvenance?.provenance_satisfied || null,
          job_document_id: reportProvenance?.job_document_id || null,
        }
        : { satisfied: "n/a_photo_route" },
      sealed_ses_release_required: {
        satisfied_by: "this_action_is_the_audited_route",
        effect_kind: "mailer_ops_send",
      },
      invoice_structurally_impossible: true,
    },
  };
}
