import { type SesSha256, sesSha256 } from "./ses_docket_envelope.ts";

export const SES_PORTAL_CAPTURE_PRODUCER =
  "capture_portal_evidence.py/v1" as const;

/**
 * PRODUCER TRUST IS UNSEALED — this set is the seam, not the ruling.
 *
 * Who may assert that a Prime portal report was completed (this observer, the
 * trade app, a named service account) has NOT been ruled on by the captain.
 * Every reader that consumes `makesafe_portal_capture_revisions` asks this one
 * predicate instead of restating a literal, so a future ruling is a one-line
 * membership change in ONE place rather than a hunt through three modules.
 *
 * It holds exactly two members: the deterministic reader and the trade
 * attestation approved by the captain's 2026-08-02 ruling and migration
 * `20260802030000_makesafe_trade_portal_confirmation.sql`. Do NOT add a third
 * member to make a write readable — widening trust is a migration plus a
 * captain ruling, never a code edit.
 *
 * `capture_producer` names the approved producer CONTRACT. The concrete agent
 * that did the looking is recorded separately and freely on every revision in
 * `captured_by`, so attribution never depends on this set being widened.
 */
/** The SECOND approved producer of the same kind of fact (captain ruling,
 * 2026-08-02, `portal-producer-and-voice-notes.md` section 1): a trade assigned
 * to the job ticks "is this roof report done?" and the tick is recorded as
 * current-cycle portal evidence, exactly like the deterministic reader's.
 *
 * The two producers differ in ONE way and it is deliberate: the deterministic
 * reader renders the Prime page and stores the screenshot that proves what it
 * saw, so it always carries one. A trade attestation has no rendered page and
 * therefore no screenshot — it is a named human's statement, and its provenance
 * is the authenticated `captured_by` user id, not an image. Consumers that need
 * a picture (the U4 docket assembler) keep requiring the reader's producer;
 * consumers that need the FACT (the board read model, M1 report-in) accept
 * either. Never let a trade attestation stand in for a screenshot.
 */
export const SES_TRADE_PORTAL_CONFIRMATION_PRODUCER =
  "trade_portal_confirmation/v1" as const;

export const SES_TRUSTED_PORTAL_CAPTURE_PRODUCERS: ReadonlySet<string> = Object
  .freeze(new Set<string>([
  SES_PORTAL_CAPTURE_PRODUCER,
  SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
  ]));

export function isTrustedSesPortalCaptureProducer(value: unknown): boolean {
  return typeof value === "string" &&
    SES_TRUSTED_PORTAL_CAPTURE_PRODUCERS.has(value);
}
export type SesPortalCaptureProducer =
  | typeof SES_PORTAL_CAPTURE_PRODUCER
  | typeof SES_TRADE_PORTAL_CONFIRMATION_PRODUCER;

/** The single role the trade tick may attest. Roof only, by the ruling. */
export const SES_TRADE_PORTAL_CONFIRMATION_ROLE = "roof_report" as const;

export const SES_PORTAL_CAPTURE_BUCKET = "makesafe-docket-artifacts";
export const SES_PORTAL_CAPTURE_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/**
 * Does this producer's evidence carry a stored screenshot? Only the headless
 * reader renders a page, so only the reader's rows are screenshot-bearing.
 */
export function sesPortalCaptureProducerHasScreenshot(
  value: unknown,
): boolean {
  return value === SES_PORTAL_CAPTURE_PRODUCER;
}

export const SES_PORTAL_CAPTURE_ROLES = [
  "roof_report",
  "assessment",
  "photos",
  "scope",
] as const;
export type SesPortalCaptureRole = typeof SES_PORTAL_CAPTURE_ROLES[number];

export const SES_PORTAL_CAPTURE_RESULTS = [
  "done",
  "not_done",
  "unreachable",
] as const;
export type SesPortalCaptureResult = typeof SES_PORTAL_CAPTURE_RESULTS[number];

export interface SesPortalCaptureRevisionContent {
  job_id: string;
  attendance_cycle_id: string;
  role: SesPortalCaptureRole;
  capture_result: SesPortalCaptureResult;
  source_url: string;
  source_content_hash: SesSha256;
  builder_reference: string;
  captured_at: string;
  captured_by: string;
  capture_producer: SesPortalCaptureProducer;
  capture_idempotency_key: string;
  signal: string;
  screenshot_object_key: string | null;
  screenshot_media_type: "image/png" | null;
  screenshot_content_hash: SesSha256 | null;
  screenshot_size_bytes: number | null;
}

export interface SesPersistedPortalCaptureRow
  extends SesPortalCaptureRevisionContent {
  id: string;
  org_id: string;
  status: "captured" | "verified" | "rejected";
  makesafe_fact_version: number;
  makesafe_content_hash: SesSha256;
  evidence_refs: unknown[];
  created_at: string;
  created_by: string;
}

export function isSesSha256(value: unknown): value is SesSha256 {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function canonicalSesPortalCaptureRole(
  value: unknown,
): SesPortalCaptureRole | null {
  const role = String(value || "").trim().toLowerCase();
  if (role === "assessment_report") return "assessment";
  if (role === "quote") return "scope";
  return (SES_PORTAL_CAPTURE_ROLES as readonly string[]).includes(role)
    ? role as SesPortalCaptureRole
    : null;
}

export function canonicalSesPortalCaptureResult(
  value: unknown,
): SesPortalCaptureResult | null {
  const result = String(value || "").trim().toLowerCase();
  return (SES_PORTAL_CAPTURE_RESULTS as readonly string[]).includes(result)
    ? result as SesPortalCaptureResult
    : null;
}

export function canonicalSesPortalSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function isSesPortalCapturePng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return bytes.byteLength >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte);
}

export async function rawSesPortalCaptureSha256(
  bytes: Uint8Array,
): Promise<SesSha256> {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedBytes),
  );
  return `sha256:${
    Array.from(digest)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

export async function sesPortalCaptureRevisionHash(
  content: SesPortalCaptureRevisionContent,
): Promise<SesSha256> {
  return await sesSha256(
    content,
    "SecureWorks:ses-portal-capture-revision:v1\n",
  );
}

/**
 * The one question the trade is asked. It is a CONSTANT because the ruling is
 * that the card already knows what it is: no family picker, no job-type
 * dropdown, nothing to classify. The trade answers this and only this.
 */
export const SES_TRADE_PORTAL_CONFIRMATION_QUESTION =
  "Is this roof report done?" as const;

export interface SesTradePortalConfirmationAttestation {
  job_id: string;
  attendance_cycle_id: string;
  role: typeof SES_TRADE_PORTAL_CONFIRMATION_ROLE;
  source_url: string;
  builder_reference: string;
  confirmed_by_user_id: string;
  confirmed_at: string;
  question: typeof SES_TRADE_PORTAL_CONFIRMATION_QUESTION;
  answer: "yes";
}

/**
 * `source_content_hash` for a trade attestation. The reader's value fingerprints
 * the RENDERED Prime content it classified; a trade tick renders nothing, so its
 * value fingerprints the ATTESTATION itself — who answered, for which job,
 * cycle, role and link, and when. Same column, same format, producer-specific
 * meaning, and the producer column is what tells them apart.
 */
export async function sesTradePortalConfirmationAttestationHash(
  attestation: SesTradePortalConfirmationAttestation,
): Promise<SesSha256> {
  return await sesSha256(
    attestation,
    "SecureWorks:ses-trade-portal-confirmation:v1\n",
  );
}

/**
 * One confirmation per job + attendance cycle + role, whoever ticks first. The
 * key deliberately EXCLUDES the confirming user so a second trade's tick
 * collides with the first instead of appending a rival record.
 */
export function sesTradePortalConfirmationIdempotencyKey(
  attendanceCycleId: string,
): string {
  return `trade-portal-confirmation:v1:${attendanceCycleId}`;
}

export function captureScreenshotStoragePath(
  content: Pick<
    SesPortalCaptureRevisionContent,
    | "job_id"
    | "attendance_cycle_id"
    | "role"
    | "screenshot_content_hash"
  >,
): string {
  if (!content.screenshot_content_hash) {
    throw new TypeError("screenshot_content_hash is required");
  }
  return [
    "portal-captures",
    content.job_id,
    content.attendance_cycle_id,
    content.role,
    `${content.screenshot_content_hash.slice("sha256:".length)}.png`,
  ].join("/");
}
