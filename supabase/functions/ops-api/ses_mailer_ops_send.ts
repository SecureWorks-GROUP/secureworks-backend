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
 *   - To is never auto-selected: the operator names it and it must be on the
 *     card-bound / configured destination allowlist
 *   - the effect identity moves ONLY on a deliberate attempt_key, so a stuck
 *     `unknown` token is never redispatched, a named retry can still run, and
 *     re-resolved content can never mint a second builder email by itself
 *   - evidence is current-attendance-cycle scoped and never carries receipts
 */

import {
  buildSesEffect,
  executeSesExternalEffect,
  type SesExternalAdapter,
  type SesExternalEffectStore,
} from "./ses_external_effects.ts";
import { sesSha256, sesSha256Bytes } from "./ses_docket_envelope.ts";
import {
  filterMediaForCurrentCycle,
  hasReattendBoundary,
  isEvidenceBoundToCurrentCycle,
} from "./makesafe_cycle_evidence.ts";
import {
  SES_OPERATION_HEADER,
  SES_RELEASE_CC,
  SES_RELEASE_MAILBOX,
  type SesMailGateway,
  type SesRouteAttachment,
  type SesRouteSendResult,
} from "./ses_graph_mail_gateway.ts";
import {
  type MlbIntakeEmailSubjectSource,
  mlbOrdinaryMailSubject,
  pickIntakeWorkOrderEmailSubject,
} from "./ses_mlb_thread_reply.ts";
import {
  evaluateSesPhotoMailVolume,
  sesPhotoMailVolumeRefusal,
} from "./ses_photo_mail_volume_guard.ts";
import { type SesActionAuth, SesActionError } from "./ses_reporting_actions.ts";
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

export function isMailerOpsRouteKind(
  value: unknown,
): value is MailerOpsRouteKind {
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
  // k === 1 would divide by zero in the spread below; one slot is the head.
  if (k === 1) return [0];
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

/** Normalise a candidate destination list (full addresses, lowercased, unique). */
function normaliseAddressList(
  values: readonly (string | null | undefined)[] | undefined,
): string[] {
  return extractMailerAddressesFromSenderPatterns([...(values || [])]);
}

export type MailerOpsRecipientSource =
  /** The address that actually sent this card's own work order (card-bound). */
  | "card_intake_work_order_sender"
  /** Configured on the company row. Inbound trust list, so confirmation-only. */
  | "company_sender_patterns";

/**
 * Destination resolution. `sender_patterns` is an INBOUND trust list (who we
 * accept work orders FROM), so it may only CONFIRM an address the operator
 * named — it can never auto-select one. The stronger coordinate is card-bound:
 * the From address of this card's own intake work-order email.
 */
export function resolveMailerOpsRecipient(args: {
  senderPatterns: unknown;
  cardIntakeSenders?: readonly (string | null | undefined)[];
  requestedTo?: string | null;
}): {
  to: string;
  source: MailerOpsRecipientSource;
  card_bound: boolean;
  card_intake_senders: string[];
  configured_senders: string[];
} {
  const configured = extractMailerAddressesFromSenderPatterns(
    args.senderPatterns,
  );
  const cardBound = normaliseAddressList(args.cardIntakeSenders);
  const allowlisted = [...new Set([...cardBound, ...configured])];
  if (allowlisted.length === 0) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_recipient_unresolved",
        "No work-order mailer address is known for this card: the company has no full-email sender_patterns entry and this card's intake sources carry no sender address.",
        {
          recovery_action:
            "Add the builder work-order mailer (full address, e.g. mlb.mailer@primeeco.tech) to makesafe_companies.sender_patterns, then retry with that address as body.to.",
        },
      ),
    );
  }
  const requested = String(args.requestedTo || "").trim().toLowerCase();
  if (!requested) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_recipient_confirmation_required",
        "The mailer ops To address must be named explicitly; sender_patterns is an inbound trust list and is never auto-selected as a destination.",
        {
          recovery_action:
            "Retry with body.to set to exactly one of the allowlisted addresses below (prefer the card-bound work-order sender).",
          evidence: {
            card_intake_senders: cardBound,
            configured_senders: configured,
          },
        },
      ),
    );
  }
  if (!allowlisted.includes(requested)) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_recipient_not_allowlisted",
        "The requested To address is neither this card's own work-order sender nor a configured company mailer address.",
        {
          recovery_action:
            "Pass a To that matches this card's intake sender or a full-email sender_patterns entry for the company.",
          evidence: {
            requested,
            card_intake_senders: cardBound,
            configured_senders: configured,
          },
        },
      ),
    );
  }
  return {
    to: requested,
    source: cardBound.includes(requested)
      ? "card_intake_work_order_sender"
      : "company_sender_patterns",
    card_bound: cardBound.includes(requested),
    card_intake_senders: cardBound,
    configured_senders: configured,
  };
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
  attendance_cycle_id: string | null;
  cycle_scoped: boolean;
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

/** A stalled object URL must become a refusal, not a burnt edge invocation. */
const MAILER_OPS_FETCH_TIMEOUT_MS = 20_000;

const IMAGE_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/**
 * Real media type for a photo attachment. Storage reports the stored
 * content-type; the file extension is the fallback. Never assume JPEG — a PNG
 * or HEIC handed to Graph mislabelled renders wrong in the builder's client.
 */
export function resolvePhotoContentType(
  storedContentType: string | null | undefined,
  ...names: (string | null | undefined)[]
): string {
  const stored = String(storedContentType || "").trim().toLowerCase().split(
    ";",
  )[0];
  if (stored.startsWith("image/") || stored.startsWith("video/")) return stored;
  for (const name of names) {
    const match = String(name || "").trim().toLowerCase().match(
      /\.([a-z0-9]+)(?:\?|$)/,
    );
    const ext = match?.[1];
    if (ext && IMAGE_CONTENT_TYPE_BY_EXTENSION[ext]) {
      return IMAGE_CONTENT_TYPE_BY_EXTENSION[ext];
    }
  }
  return "application/octet-stream";
}

interface DownloadedAttachment {
  bytes: Uint8Array;
  content_type: string | null;
}

async function downloadStorageBytes(
  client: any,
  storageUrl: string,
): Promise<DownloadedAttachment> {
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
    return {
      bytes: new Uint8Array(await downloaded.data.arrayBuffer()),
      content_type: text(downloaded.data.type) || null,
    };
  }
  // Fallback: HTTP fetch of the public URL (no Graph).
  try {
    const response = await fetch(storageUrl, {
      signal: AbortSignal.timeout(MAILER_OPS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type");
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      content_type: text(contentType) || null,
    };
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
 * Attendance-cycle facts for this card. A reattended card must never carry a
 * previous visit's photos or report to the builder paying for the current one,
 * so both resolvers scope through the ONE shared boundary in
 * `makesafe_cycle_evidence.ts` — never a private copy of the rule.
 */
export interface MailerOpsCycleContext {
  detail: Record<string, unknown> | null;
  attendance_cycle_id: string | null;
  cycle_number: number | null;
  cycle_scoped: boolean;
}

export function mailerOpsCycleContext(detail: unknown): MailerOpsCycleContext {
  const row = detail && typeof detail === "object"
    ? detail as Record<string, unknown>
    : null;
  const cycleNumber = Number(row?.cycle_number ?? NaN);
  return {
    detail: row,
    attendance_cycle_id: text(row?.attendance_cycle_id) || null,
    cycle_number: Number.isFinite(cycleNumber) ? cycleNumber : null,
    cycle_scoped: hasReattendBoundary(row),
  };
}

const UNSCOPED_CYCLE: MailerOpsCycleContext = {
  detail: null,
  attendance_cycle_id: null,
  cycle_number: null,
  cycle_scoped: false,
};

/**
 * Resolve the make-safe report PDF and prove provenance.
 * Satisfies pdf_provenance_required: document is a job_documents row of type
 * makesafe_report owned by this job_id; curated bind stamps preferred.
 */
export async function resolveMailerOpsReportAttachment(
  client: any,
  jobId: string,
  preferredDocumentId?: string | null,
  cycle: MailerOpsCycleContext = UNSCOPED_CYCLE,
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
  const allRows: any[] = Array.isArray(docs.data) ? docs.data : [];
  // Current-attendance-cycle scope through the shared evidence boundary.
  const rows = cycle.cycle_scoped
    ? allRows.filter((row) =>
      isEvidenceBoundToCurrentCycle(
        row,
        cycle.detail,
        cycle.attendance_cycle_id,
      )
    )
    : allRows;
  if (rows.length === 0) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_ops_report_missing",
        cycle.cycle_scoped && allRows.length > 0
          ? "No makesafe_report job_document is bound to this card's CURRENT attendance cycle; a previous visit's report must never be mailed as this visit's evidence."
          : "No makesafe_report job_document is bound to this job; cannot satisfy pdf provenance for mailer ops send.",
        {
          recovery_action:
            "Bind a curated make-safe report (bind_current_cycle_curated_makesafe_report) for the current attendance cycle before mailer ops send.",
          evidence: {
            job_id: jobId,
            cycle_scoped: cycle.cycle_scoped,
            attendance_cycle_id: cycle.attendance_cycle_id,
            cycle_number: cycle.cycle_number,
            documents_on_job: allRows.length,
            documents_in_current_cycle: 0,
          },
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
            "The PDF job_document_id does not belong to the supplied job_id, is not a makesafe_report, or is not bound to the current attendance cycle.",
          recovery_action:
            "Use the makesafe_report document and job identities stored together for the current attendance cycle.",
          evidence: {
            job_document_id: preferred,
            job_id: jobId,
            cycle_scoped: cycle.cycle_scoped,
            attendance_cycle_id: cycle.attendance_cycle_id,
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
        fact:
          "Mailer ops report attachment must be a makesafe_report job_document.",
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

  const { bytes } = await downloadStorageBytes(client, storageUrl);
  if (
    bytes.byteLength < 5 ||
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) !==
      "%PDF-"
  ) {
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
    attendance_cycle_id: text(chosen.attendance_cycle_id) || null,
    cycle_scoped: cycle.cycle_scoped,
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
  excluded_receipt_count: number;
  excluded_other_cycle_count: number;
  cycle_scoped: boolean;
  attendance_cycle_id: string | null;
  photos: Array<{
    media_id: string;
    file_name: string;
    storage_url: string;
    size_bytes: number;
    content_hash: string;
    content_type: string;
    bytes: Uint8Array;
    role: "site_photo";
  }>;
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/tiff": "tif",
};

function photoExtension(storageUrl: string, contentType: string): string {
  const fromPath = storageUrl.split("?")[0].split(".").pop()?.toLowerCase() ||
    "";
  if (fromPath && IMAGE_CONTENT_TYPE_BY_EXTENSION[fromPath]) return fromPath;
  return EXTENSION_BY_CONTENT_TYPE[contentType.toLowerCase()] || "jpg";
}

/**
 * Builder-facing attachment name. Storage objects are named by UUID, so the
 * trade's own `label` is the only human description of what a photo shows and
 * is what the builder must see. Ordinal-prefixed so the pack keeps its order
 * and two identically labelled photos cannot collide.
 */
export function mailerOpsPhotoFileName(
  label: string | null | undefined,
  ordinal: number,
  storageUrl: string,
  contentType: string,
): string {
  const extension = photoExtension(storageUrl, contentType);
  const position = String(Math.max(1, Math.floor(ordinal))).padStart(2, "0");
  const raw = String(label ?? "").trim();
  const trailingExtension = raw.split(".").pop()?.toLowerCase() || "";
  const slug = (
    raw.includes(".") && IMAGE_CONTENT_TYPE_BY_EXTENSION[trailingExtension]
      ? raw.slice(0, raw.length - trailingExtension.length - 1)
      : raw
  )
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "")
    .toLowerCase();
  return slug
    ? `${position}-${slug}.${extension}`
    : `site-photo-${position}.${extension}`;
}

export async function resolveMailerOpsPhotoAttachments(
  client: any,
  jobId: string,
  cycle: MailerOpsCycleContext = UNSCOPED_CYCLE,
  cap: number = MAILER_OPS_PHOTO_CAP,
): Promise<MailerOpsPhotoSelection> {
  const media = await client.from("job_media")
    .select(
      "id,job_id,type,phase,storage_url,label,created_at,attendance_cycle_id,cycle_attribution,makesafe_content_hash",
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
  const rows: any[] = Array.isArray(media.data) ? media.data : [];
  // Receipts are our cost evidence, never builder-facing site photos. They are
  // stored as type 'photo' with phase 'receipt', so type alone does not exclude
  // them (same rule as the site-photo build in index.ts).
  const siteRows = rows.filter((row: any) => {
    const t = text(row.type).toLowerCase();
    if (t && t !== "photo") return false;
    return text(row.phase).toLowerCase() !== "receipt";
  });
  const excludedReceiptCount = rows.length - siteRows.length;
  // Current attendance cycle only — one shared boundary, no private copy.
  const all = filterMediaForCurrentCycle(
    siteRows,
    cycle.detail,
    cycle.attendance_cycle_id,
  );
  const excludedOtherCycleCount = siteRows.length - all.length;
  if (all.length === 0) {
    throw new SesActionError(
      409,
      mailerRefusal(
        "mailer_ops_photos_missing",
        cycle.cycle_scoped && siteRows.length > 0
          ? "No site photos are bound to this card's CURRENT attendance cycle; a previous visit's photos must never be mailed as this visit's evidence."
          : "No site photos are available on this job for mailer ops visibility.",
        {
          evidence: {
            job_id: jobId,
            media_rows: rows.length,
            excluded_receipt_count: excludedReceiptCount,
            excluded_other_cycle_count: excludedOtherCycleCount,
            cycle_scoped: cycle.cycle_scoped,
            attendance_cycle_id: cycle.attendance_cycle_id,
          },
        },
      ),
    );
  }

  const indices = selectRepresentativePhotoIndices(all.length, cap);
  const selectedRows = indices.map((i) => all[i]!);
  const photos: MailerOpsPhotoSelection["photos"] = [];

  let ordinal = 0;
  for (const row of selectedRows) {
    ordinal += 1;
    const storageUrl = text(row.storage_url);
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
    const downloaded = await downloadStorageBytes(client, storageUrl);
    const bytes = downloaded.bytes;
    const contentHash = text(row.makesafe_content_hash) &&
        /^sha256:[0-9a-f]{64}$/i.test(text(row.makesafe_content_hash))
      ? text(row.makesafe_content_hash).toLowerCase()
      : await sesSha256Bytes(bytes);
    const contentType = resolvePhotoContentType(
      downloaded.content_type,
      storageUrl,
    );
    photos.push({
      media_id: text(row.id),
      file_name: mailerOpsPhotoFileName(
        row.label,
        ordinal,
        storageUrl,
        contentType,
      ),
      storage_url: storageUrl,
      size_bytes: bytes.byteLength,
      content_hash: contentHash,
      content_type: contentType,
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
    excluded_receipt_count: excludedReceiptCount,
    excluded_other_cycle_count: excludedOtherCycleCount,
    cycle_scoped: cycle.cycle_scoped,
    attendance_cycle_id: cycle.attendance_cycle_id,
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
  /** From addresses of THIS card's own intake work-order emails. */
  intakeSenders: string[];
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
  const intakeSenders: string[] = [];
  if (sourcePostIds.length) {
    // Chunk by URL budget.
    for (let i = 0; i < sourcePostIds.length; i += 25) {
      const chunk = sourcePostIds.slice(i, i + 25);
      const emails = await client.from("emails")
        .select("post_id,subject,from_email")
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
        const from = text(row.from_email);
        if (from) intakeSenders.push(from);
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
    intakeSenders: [...new Set(intakeSenders)],
  };
}

// ── Action ─────────────────────────────────────────────────────────────────

export interface SendMailerOpsVisibilityArgs {
  org_id: string;
  job_id: string;
  /** One card, one kind per call — cards are independently driveable. */
  kind: MailerOpsRouteKind;
  /**
   * REQUIRED destination. Named by the operator and allowlisted against this
   * card's own intake sender / the company's configured addresses — never
   * auto-selected from the inbound sender_patterns trust list.
   */
  to?: string | null;
  /** Optional preferred makesafe_report document id. */
  job_document_id?: string | null;
  /**
   * The ONLY deliberate retry coordinate. A Graph failure parks the ledger row
   * on `unknown`; naming a new attempt key mints a new operation_key so the
   * card is not stranded. The stuck token itself is never redispatched, and
   * nothing else may move the identity.
   */
  attempt_key?: string | null;
  /**
   * Live Graph send requires dry_run:false. Default true so a deploy cannot
   * accidentally mail builders; the Captain supervises the live send.
   */
  dry_run?: boolean;
  actor?: string;
}

/**
 * The attempt coordinate. STABLE facts only: route kind, the recipients, and
 * the operator's attempt key. Re-resolved content — subject, attachment hashes,
 * photo selection — is deliberately EXCLUDED, because that content moves on its
 * own (one more uploaded photo re-picks the spread; a transient `emails` read
 * error changes the recovered subject) and any of it in the identity would let
 * incidental drift mint a second operation_key and mail the builder twice.
 * Content still travels in `payload_hash`, so drift on the same identity is a
 * reconcile of the ORIGINAL effect, never a new send.
 */
export async function mailerOpsAttemptHash(input: {
  kind: MailerOpsRouteKind;
  to: string;
  cc: readonly string[];
  attempt_key?: string | null;
}): Promise<string> {
  return await sesSha256({
    contract_version: MAILER_OPS_SEND_CONTRACT_VERSION,
    kind: input.kind,
    to: input.to,
    cc: [...input.cc],
    attempt_key: text(input.attempt_key) || null,
  }, "SecureWorks:mailer-ops-send-attempt:v1\n");
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
  // Make-safe detail carries the attendance-cycle facts (and the fallback
  // company slug). Read it once for both.
  const detailRes = await client.from("makesafe_job_details")
    .select(
      "job_id,requesting_company_slug,requesting_company_name,attendance_cycle_id,cycle_number,reattend_count",
    )
    .eq("job_id", jobId)
    .maybeSingle();
  if (detailRes.error) {
    throw new SesActionError(
      503,
      mailerRefusal(
        "mailer_ops_detail_lookup_failed",
        `Make-safe job detail could not be read (${detailRes.error.message}); attendance-cycle scope is unprovable.`,
      ),
    );
  }
  const cycle = mailerOpsCycleContext(detailRes.data);

  let company = companyRes.data || null;
  if (!company?.sender_patterns) {
    const detailSlug = text(detailRes.data?.requesting_company_slug);
    if (detailSlug && detailSlug !== slug) {
      const co2 = await client.from("makesafe_companies")
        .select("slug,name,sender_patterns,report_recipient")
        .eq("slug", detailSlug)
        .maybeSingle();
      if (co2.data) company = co2.data;
    }
  }
  const senderPatterns = company?.sender_patterns;

  const subjectInputs = await loadMailerOpsSubjectInputs(
    client,
    jobId,
    metadata,
  );

  const recipient = resolveMailerOpsRecipient({
    senderPatterns,
    cardIntakeSenders: subjectInputs.intakeSenders,
    requestedTo: args.to,
  });

  // Structural: never use report_recipient (makesafes@) as To on this path.
  const reportRecipient = text(company?.report_recipient).toLowerCase();
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
    excluded_receipt_count: number;
    excluded_other_cycle_count: number;
    cycle_scoped: boolean;
    attendance_cycle_id: string | null;
    media_ids: string[];
    content_types: string[];
  } | null = null;

  if (kind === "report") {
    const report = await resolveMailerOpsReportAttachment(
      client,
      jobId,
      args.job_document_id,
      cycle,
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
    const photos = await resolveMailerOpsPhotoAttachments(
      client,
      jobId,
      cycle,
    );
    for (const photo of photos.photos) {
      attachmentByHash.set(photo.content_hash, {
        name: photo.file_name,
        contentType: photo.content_type,
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
      excluded_receipt_count: photos.excluded_receipt_count,
      excluded_other_cycle_count: photos.excluded_other_cycle_count,
      cycle_scoped: photos.cycle_scoped,
      attendance_cycle_id: photos.attendance_cycle_id,
      media_ids: photos.photos.map((p) => p.media_id),
      content_types: photos.photos.map((p) => p.content_type),
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

  const attemptKey = text(args.attempt_key) || null;
  const attemptHash = await mailerOpsAttemptHash({
    kind,
    to: recipient.to,
    cc,
    attempt_key: attemptKey,
  });

  const effectPayload = {
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
    attachment_hashes: attachmentHashes,
    attachment_names: attachmentNames,
    attachment_roles: attachmentRoles,
    attempt_key: attemptKey,
    attempt_hash: attemptHash,
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
    // Retry coordinate: stable recipients plus the operator's attempt key only.
    artifact_hash: attemptHash,
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
      to_card_bound: recipient.card_bound,
      to_allowlist: {
        card_intake_senders: recipient.card_intake_senders,
        configured_senders: recipient.configured_senders,
      },
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
      attendance_cycle: {
        cycle_scoped: cycle.cycle_scoped,
        attendance_cycle_id: cycle.attendance_cycle_id,
        cycle_number: cycle.cycle_number,
      },
      effect_preview: {
        operation_key: effect.operation_key,
        external_token: effect.external_token,
        payload_hash: effect.payload_hash,
        effect_kind: effect.effect_kind,
        route_kind: effect.route_kind,
        attempt_key: attemptKey,
        attempt_hash: attemptHash,
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

  // Only a message this call actually composed may be described by this call's
  // subject and attachment names. A reconcile proves an EARLIER attempt's
  // message, whose content this call never saw.
  let dispatchedByThisCall = false;
  const adapter: SesExternalAdapter<typeof routePayload, SesRouteSendResult> = {
    dispatch: (payload, context) => {
      dispatchedByThisCall = true;
      return mailGateway.createDraftAndSend(payload, context);
    },
    reconcile: (context) => mailGateway.reconcileSent(context.external_token),
    identify: (result) => result.message_id,
    digest: (result) => ({
      message_id: result.message_id,
      internet_message_id: result.internet_message_id || null,
      operation_token: result.operation_token,
      // Recipients are identity coordinates, so they are the original send's.
      to: [recipient.to],
      cc: [...cc],
      operation_header: SES_OPERATION_HEADER,
      // ses@ CC is a second proof surface (intake mailbox we control).
      proof_surfaces: ["admin_sent_items", "ses_intake_cc"],
      ...(dispatchedByThisCall
        ? {
          content_proof: "dispatched_by_this_call",
          subject_as_sent: subjectDecision.subject,
          attachment_names: attachmentNames,
          attachment_roles: attachmentRoles,
        }
        : {
          content_proof: "reconciled_prior_attempt",
          content_recomposed: false,
        }),
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
        attempt_key: attemptKey,
        attempt_hash: attemptHash,
        // This token is never redispatched. A deliberate retry of the same
        // content is a NEW attempt: pass a fresh attempt_key.
        retry_instruction:
          "Reconcile this token first. To retry deliberately, call again with a new attempt_key; never redispatch this token.",
      },
    });
  }

  const writeMailerOpsAudit = async (
    eventType: string,
    detail: Record<string, unknown>,
  ) => {
    // Append-only human-readable audit (best-effort; effect ledger is
    // authoritative). supabase-js reports database failures on `error` rather
    // than throwing, so check both.
    try {
      const audit = await client.from("job_events").insert({
        job_id: jobId,
        event_type: eventType,
        detail_json: {
          contract_version: MAILER_OPS_SEND_CONTRACT_VERSION,
          kind,
          effect_operation_key: effect.operation_key,
          effect_id: sent.effect.id || null,
          attempt_key: attemptKey,
          attempt_hash: attemptHash,
          actor,
          ...detail,
        },
      });
      if (audit?.error) {
        console.warn(
          "[mailer-ops] job_events insert failed:",
          audit.error.message,
        );
      }
    } catch (err) {
      console.warn(
        "[mailer-ops] job_events insert failed:",
        (err as Error).message,
      );
    }
  };

  // This call did not compose the message: either the effect was already
  // confirmed (no result at all) or a reconcile proved an EARLIER attempt's
  // message under the same token. Report the ORIGINAL ledger proof. Never
  // recompose one from this call's freshly resolved subject/attachments — a
  // newly uploaded photo or a re-recovered subject would otherwise be asserted
  // as delivered under a message id that never carried it.
  if (!sent.dispatched) {
    const storedDigest = object(sent.effect.provider_digest);
    const recordedProof = {
      message_id: text(sent.effect.external_id) ||
        text(sent.result?.message_id) || null,
      operation_token: effect.external_token,
      operation_header: SES_OPERATION_HEADER,
      provider_digest: storedDigest,
      proof_surfaces: ["admin_sent_items", "ses_intake_cc"],
    };
    const reconciled = Boolean(sent.result);
    if (reconciled) {
      await writeMailerOpsAudit("mailer_ops_visibility_reconciled", {
        recorded_proof: recordedProof,
        effect_state: sent.effect.state,
      });
    }
    return {
      success: true,
      dry_run: false,
      already_sent: true,
      reconciled_prior_attempt: reconciled,
      contract_version: MAILER_OPS_SEND_CONTRACT_VERSION,
      job_id: jobId,
      job_number: text(job.job_number) || null,
      kind,
      proof_source: "ses_external_effects_ledger",
      recorded_proof: recordedProof,
      effect: {
        operation_key: effect.operation_key,
        external_token: effect.external_token,
        state: sent.effect.state,
        effect_kind: "mailer_ops_send",
        route_kind: kind,
        attempt_key: attemptKey,
        attempt_hash: attemptHash,
      },
      note: reconciled
        ? "An earlier attempt under this token is now proven sent; this call dispatched nothing. The fields above are that attempt's recorded proof, not this call's freshly resolved content. A deliberately different send needs a new attempt_key."
        : "This exact send is already confirmed; no email was sent and no new proof exists. The fields above are the ORIGINAL recorded proof. A deliberately different send needs a new attempt_key.",
    };
  }

  const result = sent.result;
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

  await writeMailerOpsAudit("mailer_ops_visibility_sent", {
    proof,
    report_provenance: reportProvenance,
    photo_selection: photoSelectionMeta,
  });

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
      attempt_key: attemptKey,
      attempt_hash: attemptHash,
    },
    to_source: recipient.source,
    to_card_bound: recipient.card_bound,
    subject_source: subjectDecision.subject_source,
    original_subject: subjectDecision.original_subject,
    report_provenance: reportProvenance,
    photo_selection: photoSelectionMeta,
    attendance_cycle: {
      cycle_scoped: cycle.cycle_scoped,
      attendance_cycle_id: cycle.attendance_cycle_id,
      cycle_number: cycle.cycle_number,
    },
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
