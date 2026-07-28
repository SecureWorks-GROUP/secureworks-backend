import {
  buildSesAssemblerInput,
  loadSesAssemblerLiveSnapshot,
} from "./ses_assembler_input_adapter.ts";
import type { SesSha256 } from "./ses_docket_envelope.ts";
import {
  canonicalSesPortalCaptureResult,
  canonicalSesPortalCaptureRole,
  canonicalSesPortalSourceUrl,
  captureScreenshotStoragePath,
  isSesPortalCapturePng,
  isSesSha256,
  rawSesPortalCaptureSha256,
  SES_PORTAL_CAPTURE_BUCKET,
  SES_PORTAL_CAPTURE_MAX_SCREENSHOT_BYTES,
  SES_PORTAL_CAPTURE_PRODUCER,
  type SesPortalCaptureRevisionContent,
  sesPortalCaptureRevisionHash,
} from "./ses_portal_capture_contract.ts";

type StorageError = {
  message?: string;
  status?: number;
  statusCode?: string;
};

interface StorageResult<T> {
  data: T | null;
  error: StorageError | null;
}

export interface SesPortalCaptureEvidenceClient {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Uint8Array,
        options: { contentType: "image/png"; upsert: false },
      ): Promise<StorageResult<unknown>>;
      download(path: string): Promise<StorageResult<Blob>>;
    };
  };
  from(table: string): unknown;
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<StorageResult<Record<string, unknown>>>;
}

export class SesPortalCaptureEvidenceError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SesPortalCaptureEvidenceError";
    this.status = status;
    this.code = code;
  }
}

function requiredText(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (!value) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_invalid",
      `${key} is required.`,
    );
  }
  return value;
}

function stringField(
  body: Record<string, unknown>,
  key: string,
): string {
  if (typeof body[key] !== "string") {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_invalid",
      `${key} must be a string.`,
    );
  }
  return body[key].trim();
}

function requiredUuid(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = requiredText(body, key).toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      .test(value)
  ) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_invalid",
      `${key} must be a UUID.`,
    );
  }
  return value;
}

function parseHttpsUrl(value: string): string {
  const parsed = canonicalSesPortalSourceUrl(value);
  if (!parsed) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_invalid",
      "source_url must be a valid HTTPS URL.",
    );
  }
  return parsed;
}

function parseTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_invalid",
      "captured_at must be a valid ISO timestamp.",
    );
  }
  if (milliseconds > Date.now() + 10 * 60 * 1000) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_invalid",
      "captured_at cannot be more than ten minutes in the future.",
    );
  }
  return new Date(milliseconds).toISOString();
}

function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/\s+/g, "");
  if (
    compact.length >
      Math.ceil(SES_PORTAL_CAPTURE_MAX_SCREENSHOT_BYTES / 3) * 4 + 4
  ) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_too_large",
      `screenshot exceeds ${SES_PORTAL_CAPTURE_MAX_SCREENSHOT_BYTES} bytes.`,
      413,
    );
  }
  let decoded: string;
  try {
    decoded = atob(compact);
  } catch {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_invalid",
      "screenshot.bytes_base64 must be valid base64.",
    );
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  if (!bytes.byteLength) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_invalid",
      "screenshot bytes cannot be empty.",
    );
  }
  if (bytes.byteLength > SES_PORTAL_CAPTURE_MAX_SCREENSHOT_BYTES) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_too_large",
      `screenshot exceeds ${SES_PORTAL_CAPTURE_MAX_SCREENSHOT_BYTES} bytes.`,
      413,
    );
  }
  return bytes;
}

function duplicateUpload(error: StorageError): boolean {
  const status = Number(error.statusCode || error.status);
  const message = String(error.message || "").toLowerCase();
  return status === 409 || message.includes("already exists") ||
    message.includes("duplicate");
}

async function assertExistingScreenshotMatches(
  client: SesPortalCaptureEvidenceClient,
  path: string,
  expectedHash: SesSha256,
  expectedSize: number,
): Promise<void> {
  const downloaded = await client.storage.from(SES_PORTAL_CAPTURE_BUCKET)
    .download(path);
  if (downloaded.error || !downloaded.data) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_storage_conflict",
      `existing screenshot could not be verified: ${path}`,
      409,
    );
  }
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (
    bytes.byteLength !== expectedSize ||
    await rawSesPortalCaptureSha256(bytes) !== expectedHash
  ) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_storage_conflict",
      `existing screenshot bytes do not match the submitted hash: ${path}`,
      409,
    );
  }
}

export async function recordSesPortalCaptureEvidence(
  client: SesPortalCaptureEvidenceClient,
  body: Record<string, unknown>,
  actor: string,
): Promise<Record<string, unknown>> {
  if (!actor.trim()) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_invalid",
      "authenticated actor is required.",
    );
  }
  const jobId = requiredUuid(body, "job_id");
  const attendanceCycleId = requiredUuid(body, "attendance_cycle_id");
  const role = canonicalSesPortalCaptureRole(body.role);
  const captureResult = canonicalSesPortalCaptureResult(body.capture_result);
  const sourceUrl = parseHttpsUrl(requiredText(body, "source_url"));
  const sourceContentHash = requiredText(body, "source_content_hash");
  const builderReference = stringField(body, "builder_reference");
  const capturedAt = parseTimestamp(requiredText(body, "captured_at"));
  const capturedBy = requiredText(body, "captured_by");
  const captureProducer = requiredText(body, "capture_producer");
  const captureIdempotencyKey = requiredText(
    body,
    "capture_idempotency_key",
  );
  const signal = requiredText(body, "signal");

  if (!role || !captureResult || !isSesSha256(sourceContentHash)) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_invalid",
      "role, capture_result or source_content_hash is invalid.",
    );
  }
  if (captureProducer !== SES_PORTAL_CAPTURE_PRODUCER) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_producer_unapproved",
      `capture_producer must be ${SES_PORTAL_CAPTURE_PRODUCER}.`,
    );
  }

  const snapshot = await loadSesAssemblerLiveSnapshot(
    client,
    { mode: "job_id", job_id: jobId },
  );
  const input = buildSesAssemblerInput(snapshot);
  if (input.attendance.current_attendance_cycle_id !== attendanceCycleId) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_cycle_stale",
      `capture cycle ${attendanceCycleId} is not the card's current cycle ${
        input.attendance.current_attendance_cycle_id || "(missing)"
      }.`,
      409,
    );
  }
  if (input.source.builder_reference !== builderReference) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_reference_mismatch",
      "builder_reference does not match the canonical U4 input.",
      409,
    );
  }
  const matchingLinks = input.source.portal_links.filter((link) =>
    canonicalSesPortalCaptureRole(link.role) === role &&
    canonicalSesPortalSourceUrl(link.url) === sourceUrl
  );
  if (matchingLinks.length !== 1) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_source_mismatch",
      `source_url is not the single canonical ${role} link for this card.`,
      409,
    );
  }

  const screenshot = body.screenshot && typeof body.screenshot === "object" &&
      !Array.isArray(body.screenshot)
    ? body.screenshot as Record<string, unknown>
    : null;
  let screenshotBytes: Uint8Array | null = null;
  let screenshotContentHash: SesSha256 | null = null;
  let screenshotSizeBytes: number | null = null;
  let screenshotMediaType: "image/png" | null = null;

  if (captureResult !== "unreachable") {
    if (!screenshot) {
      throw new SesPortalCaptureEvidenceError(
        "ses_portal_capture_invalid",
        `screenshot is required when capture_result is ${captureResult}.`,
      );
    }
    if (requiredText(screenshot, "media_type") !== "image/png") {
      throw new SesPortalCaptureEvidenceError(
        "ses_portal_capture_invalid",
        "screenshot.media_type must be image/png.",
      );
    }
    const claimedHash = requiredText(screenshot, "content_hash");
    if (!isSesSha256(claimedHash)) {
      throw new SesPortalCaptureEvidenceError(
        "ses_portal_capture_invalid",
        "screenshot.content_hash must be sha256:<64 lowercase hex>.",
      );
    }
    screenshotBytes = decodeBase64(requiredText(screenshot, "bytes_base64"));
    if (!isSesPortalCapturePng(screenshotBytes)) {
      throw new SesPortalCaptureEvidenceError(
        "ses_portal_capture_invalid",
        "screenshot.bytes_base64 must contain PNG bytes.",
      );
    }
    screenshotContentHash = await rawSesPortalCaptureSha256(screenshotBytes);
    if (screenshotContentHash !== claimedHash) {
      throw new SesPortalCaptureEvidenceError(
        "ses_portal_capture_hash_mismatch",
        "screenshot.content_hash does not match screenshot.bytes_base64.",
        409,
      );
    }
    screenshotSizeBytes = screenshotBytes.byteLength;
    screenshotMediaType = "image/png";
  } else if (screenshot) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_invalid",
      "unreachable captures must not include a screenshot.",
    );
  }

  const content: SesPortalCaptureRevisionContent = {
    job_id: jobId,
    attendance_cycle_id: attendanceCycleId,
    role,
    capture_result: captureResult,
    source_url: sourceUrl,
    source_content_hash: sourceContentHash,
    builder_reference: builderReference,
    captured_at: capturedAt,
    captured_by: capturedBy,
    capture_producer: SES_PORTAL_CAPTURE_PRODUCER,
    capture_idempotency_key: captureIdempotencyKey,
    signal,
    screenshot_object_key: null,
    screenshot_media_type: screenshotMediaType,
    screenshot_content_hash: screenshotContentHash,
    screenshot_size_bytes: screenshotSizeBytes,
  };

  if (screenshotBytes && screenshotContentHash) {
    const storagePath = captureScreenshotStoragePath(content);
    content.screenshot_object_key =
      `${SES_PORTAL_CAPTURE_BUCKET}/${storagePath}`;
    const uploaded = await client.storage.from(SES_PORTAL_CAPTURE_BUCKET)
      .upload(
        storagePath,
        screenshotBytes,
        { contentType: "image/png", upsert: false },
      );
    if (uploaded.error) {
      if (!duplicateUpload(uploaded.error)) {
        throw new SesPortalCaptureEvidenceError(
          "ses_portal_capture_storage_failed",
          uploaded.error.message || "portal screenshot upload failed.",
          502,
        );
      }
      await assertExistingScreenshotMatches(
        client,
        storagePath,
        screenshotContentHash,
        screenshotBytes.byteLength,
      );
    }
  }

  const makesafeContentHash = await sesPortalCaptureRevisionHash(content);
  const evidenceRefs: Array<Record<string, unknown>> = [{
    kind: "portal_source",
    url: sourceUrl,
    content_hash: sourceContentHash,
  }];
  if (content.screenshot_object_key) {
    evidenceRefs.push({
      kind: "portal_screenshot",
      object_key: content.screenshot_object_key,
      media_type: content.screenshot_media_type,
      content_hash: content.screenshot_content_hash,
      size_bytes: content.screenshot_size_bytes,
    });
  }

  const committed = await client.rpc("commit_makesafe_portal_capture_v1", {
    p_capture: {
      ...content,
      status: captureResult === "done"
        ? "verified"
        : captureResult === "not_done"
        ? "captured"
        : "rejected",
      makesafe_content_hash: makesafeContentHash,
      evidence_refs: evidenceRefs,
      created_by: actor,
    },
  });
  if (committed.error || !committed.data) {
    throw new SesPortalCaptureEvidenceError(
      "ses_portal_capture_commit_failed",
      committed.error?.message || "portal capture commit returned no row.",
      409,
    );
  }
  return committed.data;
}
