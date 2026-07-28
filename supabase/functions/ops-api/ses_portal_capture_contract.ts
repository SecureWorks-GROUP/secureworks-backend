import { type SesSha256, sesSha256 } from "./ses_docket_envelope.ts";

export const SES_PORTAL_CAPTURE_PRODUCER =
  "capture_portal_evidence.py/v1" as const;
export const SES_PORTAL_CAPTURE_BUCKET = "makesafe-docket-artifacts";
export const SES_PORTAL_CAPTURE_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

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
  capture_producer: typeof SES_PORTAL_CAPTURE_PRODUCER;
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
