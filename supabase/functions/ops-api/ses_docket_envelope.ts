import type { SesBuilderKey, SesFamilyId } from "./ses_family_matrix.ts";
import type { SesMaterialsChargeAuthorisation } from "./ses_materials_charge_guard.ts";

export const SES_ASSEMBLER_VERSION = "ses-pack-assembler/v1";
export const SES_INPUT_CONTRACT_VERSION = "ses.assembler-input/v1";
export const SES_DOCKET_ENVELOPE_VERSION =
  "secureworks.makesafe.docket-manifest/v3-envelope";
export const SES_MANIFEST_V2_VERSION =
  "secureworks.makesafe.docket-manifest/v2";

export type SesSha256 = `sha256:${string}`;

export type SesDeliveryRenderRoute =
  | "builder_portal"
  | "secureworks_own_letterhead"
  | "unroutable"
  | "not_applicable";

export interface SesSwmsFactContext {
  evidence_kind: "current_card" | "sibling_bundle";
  evidence_job_id: string;
  evidence_job_number: string | null;
  trade_report: Record<string, unknown> | null;
  job_client_name: string | null;
  assignment: {
    id: string | null;
    crew_name: string | null;
    /** Name on the user record joined to THIS assignment row. Same provenance the board already
     * shows via `makesafeCrew`. Never inferred, defaulted, or taken from another card. */
    assigned_user_name: string | null;
    scheduled_date: string | null;
    arrived_at: string | null;
  } | null;
}

interface SesSiblingBundleCandidate {
  suspected_sibling_job_id: string | null;
  suspected_sibling_job_number: string;
  suspected_invoice_number: string | null;
}

export type SesSiblingBundleEvidence =
  | (SesSiblingBundleCandidate & {
    status:
      | "binding_missing"
      | "binding_not_bidirectional"
      | "scope_evidence_missing";
    bundle_id: string | null;
    binding_revision_id: string | null;
    reverse_binding_revision_id: string | null;
    coverage_failures: string[];
  })
  | {
    status: "accepted";
    bundle_id: string;
    claiming_binding: {
      revision_id: string;
      recorded_by: string;
      recorded_via: string;
      provenance: Record<string, unknown>;
    };
    reverse_binding: {
      revision_id: string;
      recorded_by: string;
      recorded_via: string;
      provenance: Record<string, unknown>;
    };
    sibling: {
      job_id: string;
      job_number: string;
    };
    coverage: {
      invoice: {
        invoice_id: string;
        invoice_number: string;
        line_item_id: string;
        scope_phrase: string;
      };
      delivery: {
        email_post_id: string;
        content_sha256: string;
        scope_phrase: string;
      };
      photo: {
        email_post_id: string;
        content_sha256: string;
        scope_phrase: string;
        media_id: string;
        content_hash: SesSha256;
      };
      report_document_id: string;
      swms_document_id: string;
    };
  };

export interface SesAssemblerInputV1 {
  contract_version: "ses.assembler-input/v1";
  identity: {
    source_instruction_id: string;
    source_version: string;
    source_content_hash: SesSha256;
    lineage_id: string;
    case_id: string | null;
    job_id: string;
    job_number: string | null;
    card_id: string | null;
    property_id: string | null;
  };
  attendance: {
    attendance_cycle_ids: string[];
    current_attendance_cycle_id: string;
    cycle_number: number;
    attribution: "bound" | "backfill_cycle_scope" | "legacy_unscoped";
  };
  classification: {
    builder_key: SesBuilderKey;
    builder_label: string;
    family: SesFamilyId;
    subtype: string | null;
    report_only: boolean;
    report_delivery: "portal" | "own_document" | null;
    delivery_render_route: SesDeliveryRenderRoute;
    delivery_render_route_reason_code: string;
    delivery_render_route_reason: string;
    delivery_render_route_evidence: string[];
    strata: boolean;
    own_template_requested: boolean;
    workflow: "active" | "cancellation" | "revision" | "no_access";
    lineage_kind: "none" | "revision" | "sibling";
    family_matrix_version: string;
    assessment_outbound_recipe_version: string | null;
  };
  source: {
    work_order_sender: string | null;
    builder_reference: string;
    po_or_external_ref: string | null;
    site_address: string | null;
    site_suburb: string | null;
    instruction_text: string | null;
    deliverables: Array<{ id: string; kind: string }>;
    attachment_pointers: string[];
    portal_links: Array<{
      role:
        | "roof_report"
        | "assessment"
        | "photos"
        | "scope"
        | "quote"
        | "builder_portal"
        | "other";
      url: string;
      source: "intake" | "job_detail" | "email_recovery";
    }>;
    /**
     * Graph Groups conversationThreadId from makesafe_intake_case_sources.
     * Plumbed onto envelope.routing for MLB physical report/photo reply.
     */
    intake_thread_id?: string | null;
    /** Group post id of the chosen intake source (audit anchor). */
    intake_post_id?: string | null;
    intake_conversation_id?: string | null;
    /**
     * Verbatim original work-order email subject (emails.subject preferred).
     * Used only for MLB physical report/photo ordinary Mail.Send inbox
     * grouping — not real threading. Never reconstructed.
     */
    intake_email_subject?: string | null;
    /** Which store supplied intake_email_subject (audit). */
    intake_email_subject_source?:
      | "emails_subject"
      | "intake_draft_subject"
      | "job_metadata_builder_email_subject"
      | null;
  };
  cycle_facts: {
    trade_report: Record<string, unknown> | null;
    photos: Array<{
      id: string;
      path_or_key: string;
      caption?: string;
      order: number;
    }>;
    roof_report_fields: Record<string, unknown> | null;
    hours_and_materials: Record<string, unknown> | null;
    swms_fact_context?: SesSwmsFactContext | null;
    prior_release: {
      released: boolean;
      release_revision_id: string | null;
      cycle_set_hash: string | null;
    };
  };
  sibling_bundle_evidence?: SesSiblingBundleEvidence;
  hrcw: {
    hrcw: boolean;
    categories: Array<
      "asbestos" | "work_at_height" | "structural" | "other_registered_hrcw"
    >;
    source_hazard_terms: string[];
  };
  routing_seed: {
    report_to: string | null;
    invoice_to: string | null;
  };
  readiness: {
    readiness_revision: SesSha256 | null;
    dependency_generation: number | null;
  };
}

export interface SesPhysicalReportProof {
  source_kind: "durable_curated_revision" | "previously_committed_pdf";
  source_identity: string;
  source_document_id: string;
  source_revision_id: string;
  source_artifact_id: string;
  source_artifact_content_hash: SesSha256;
  expected_raw_sha256: SesSha256;
  report_input_hash?: SesSha256;
}

export interface SesPrepareRequest {
  selection: {
    mode: "job_id" | "job_number" | "board_batch";
    job_id?: string;
    job_number?: string;
    limit?: number;
  };
  idempotency_key: string;
  assembler_version: "ses-pack-assembler/v1";
  dry_run: boolean;
  force_refresh: boolean;
  require_ready_for_persistence?: boolean;
  expected_physical_report_proof?: SesPhysicalReportProof;
  /**
   * Operator answer to `materials_charge_figure_required` on a
   * `standard_labour_materials` card. Single-card selections only, and folded
   * into the docket input hash so two different figures can never collide on
   * one revision id.
   */
  materials_charge?: SesMaterialsChargeAuthorisation;
  /**
   * The operator explicitly withdrew the figure this card was carrying. This
   * is NOT the same state as omitting `materials_charge`, which inherits the
   * standing figure — a withdrawn figure must never come back by inheritance.
   */
  materials_charge_cleared?: true;
}

export interface SesBlocker {
  state: "blocked";
  reason: string;
  reason_code: string;
  searches_attempted: string[];
  rejected_candidates: string[];
  recovery_action: string;
  facts?: Record<string, unknown>;
}

export interface SesReadyState {
  state: "ready";
  evidence: string;
}

export interface SesNotApplicableState {
  state: "not_applicable";
  rule: string;
}

export type SesObligationState =
  | SesBlocker
  | SesReadyState
  | SesNotApplicableState;

export interface SesArtifact {
  role: string;
  path: string;
  media_type: string;
  bytes: Uint8Array;
  content_hash: SesSha256;
  size_bytes: number;
  metadata: Record<string, unknown>;
}

export interface SesPortalCapture {
  status: "done" | "not_done" | "unreachable" | "missing" | "invalid";
  role: "roof_report" | "assessment" | "photos" | "scope";
  url: string;
  docket_id: string;
  job_id: string;
  builder_reference: string;
  captured_at: string;
  captured_by: string;
  capture_producer: string;
  evidence_revision_id: string;
  content_fingerprint: SesSha256;
  idempotency_key: string;
  signal: string;
  screenshot_bytes?: Uint8Array;
}

export interface SesManifestV2 {
  version: "secureworks.makesafe.docket-manifest/v2";
  docket_id: string;
  classification: Record<string, unknown>;
  routing: {
    builder: string;
    report_to: string;
    photo_to: string;
    invoice_to: string;
    /** Graph Groups conversationThreadId for MLB physical report/photo reply. */
    intake_thread_id?: string;
    intake_post_id?: string;
    intake_conversation_id?: string;
    /**
     * Verbatim original WO email subject for ordinary-mail inbox grouping.
     * Inbox grouping only — not real threading. Empty when unrecovered.
     */
    intake_email_subject?: string;
    intake_email_subject_source?: string;
  };
  items: Record<string, SesObligationState>;
  deliverables: Array<{
    id: string;
    kind: string;
    completion: SesObligationState;
  }>;
}

export interface SesDocketEnvelopeV3 {
  version: "secureworks.makesafe.docket-manifest/v3-envelope";
  v2: SesManifestV2;
  spine: {
    source_instruction_id: string;
    lineage_id: string;
    job_id: string;
    card_id: string | null;
    property_id: string | null;
    attendance_cycle_ids: string[];
    current_attendance_cycle_id: string;
    readiness_revision: SesSha256 | null;
    docket_revision_id: string;
  };
  pre_xero_docs_ready: boolean;
  local_invoice_proposal: {
    state: "ready" | "blocked";
    evidence: string;
  };
  invoice_create_approved: false;
  client_send_approved: false;
  family_matrix_version: string;
  assembler_version: "ses-pack-assembler/v1";
  input_content_hash: SesSha256;
  output_content_hash: SesSha256;
}

export interface SesTiming {
  job_id: string;
  accepted_at: string;
  committed_at: string;
  duration_ms: number;
  stages_ms: Record<string, number>;
  retries: Record<string, number>;
  degraded_capabilities: string[];
  within_five_minutes: boolean;
}

export interface SesPreparedRevision {
  state: "ready" | "blocked";
  docket_revision_id: string;
  input_content_hash: SesSha256;
  output_content_hash: SesSha256;
  envelope: SesDocketEnvelopeV3;
  blockers: SesBlocker[];
  artifacts: SesArtifact[];
  portal_evidence: SesPortalCapture[];
  invoice_proposal: Record<string, unknown> | null;
  email_drafts: Record<string, string>;
  review_spec: Record<string, unknown>;
  release_payload: Record<string, unknown>;
  timing: SesTiming;
  persisted: boolean;
}

function compareText(a: string, b: string): number {
  const left = Array.from(
    a.normalize("NFC"),
    (value) => value.codePointAt(0) as number,
  );
  const right = Array.from(
    b.normalize("NFC"),
    (value) => value.codePointAt(0) as number,
  );
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function canonicalValue(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite number`);
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${
      value.map((item, index) => canonicalValue(item, `${path}[${index}]`))
        .join(",")
    }]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareText);
    for (const key of keys) {
      if (record[key] === undefined) {
        throw new TypeError(
          `${path}.${key} must be explicit null, not undefined`,
        );
      }
    }
    return `{${
      keys.map((key) =>
        `${JSON.stringify(key.normalize("NFC"))}:${
          canonicalValue(record[key], `${path}.${key}`)
        }`
      ).join(",")
    }}`;
  }
  throw new TypeError(`${path} contains unsupported ${typeof value}`);
}

export function canonicalSesJson(value: unknown): string {
  return canonicalValue(value, "$");
}

export async function sesSha256(
  value: unknown,
  domain = "SecureWorks:ses-pack-assembler:v1\n",
): Promise<SesSha256> {
  const bytes = new TextEncoder().encode(domain + canonicalSesJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `sha256:${hex}`;
}

/** Domain separator for artifact CONTENT hashes.
 *
 * v2 (2026-08-02) digests the artifact bytes directly. v1 routed them through
 * `sesSha256(Array.from(bytes))`, which turned every byte into a JS number and then into a
 * decimal JSON string: a measured ~20x transient allocation that made the persist path exceed
 * the edge function's resource budget on any docket carrying real photos. The bytes hashed are
 * the SAME bytes over the SAME artifacts; only the encoding fed to SHA-256 changed, so no
 * evidence is skipped, reduced or sampled.
 */
export const SES_ARTIFACT_BYTES_DOMAIN =
  "SecureWorks:ses-docket-artifact-bytes:v2\n";

/** SHA-256 over `domain || bytes`, without materialising a number-array/JSON copy.
 *
 * Peak transient cost is one framed copy of the input rather than ~20 copies, so a docket's
 * photo artifacts stay inside the worker budget no matter how many photos the cycle carries.
 */
export async function sesSha256Bytes(
  bytes: Uint8Array,
  domain = SES_ARTIFACT_BYTES_DOMAIN,
): Promise<SesSha256> {
  const prefix = new TextEncoder().encode(domain);
  const framed = new Uint8Array(prefix.byteLength + bytes.byteLength);
  framed.set(prefix, 0);
  framed.set(bytes, prefix.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", framed));
  const hex = Array.from(digest).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `sha256:${hex}`;
}

export function stableUuidFromSha256(value: SesSha256): string {
  const chars = value.slice("sha256:".length, "sha256:".length + 32).split("");
  chars[12] = "5";
  const variant = parseInt(chars[16], 16);
  chars[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20, 32)}`;
}

export async function artifactFromText(args: {
  role: string;
  path: string;
  media_type: string;
  text: string;
  metadata?: Record<string, unknown>;
}): Promise<SesArtifact> {
  const bytes = new TextEncoder().encode(args.text);
  const content_hash = await sesSha256Bytes(bytes);
  return {
    role: args.role,
    path: args.path,
    media_type: args.media_type,
    bytes,
    content_hash,
    size_bytes: bytes.byteLength,
    metadata: args.metadata || {},
  };
}

export async function artifactFromBytes(args: {
  role: string;
  path: string;
  media_type: string;
  bytes: Uint8Array;
  metadata?: Record<string, unknown>;
}): Promise<SesArtifact> {
  const content_hash = await sesSha256Bytes(args.bytes);
  return {
    ...args,
    content_hash,
    size_bytes: args.bytes.byteLength,
    metadata: args.metadata || {},
  };
}
