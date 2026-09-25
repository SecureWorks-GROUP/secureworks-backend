// ════════════════════════════════════════════════════════════
// GHL webhook receiver: two-proof authentication and ids-only receipts
// (context build slice C1b; design sms.md §7 step 3, review M5 and M14).
//
// Two accepted proofs, chosen by event type:
//   - App events (messages, notes, tasks, appointments from the GHL app):
//     Ed25519 signature in `X-GHL-Signature` over the RAW request body,
//     verified against env GHL_WEBHOOK_PUBLIC_KEY, plus
//     body.locationId === env GHL_LOCATION_ID.
//   - Workflow events (CallCompleted, CustomerReplied, UserReplied, Voicemail,
//     ContactStageChanged and the legacy workflow posts): the shared secret, the same header check as
//     ghl-webhook (`X-Webhook-Secret`, or `Authorization` raw or Bearer),
//     against env GHL_WEBHOOK_SECRET.
//   - ContactCreate / ContactUpdate (either sender until the first-delivery
//     check names it) and unrecognised types accept either proof.
//
// Mode (env GHL_WEBHOOK_AUTH_MODE): `enforce` refuses every delivery without
// an accepted proof with a 401. Anything else, including unset, is OBSERVE:
// the delivery is processed as before and its receipt says `auth: "missing"`
// so the switch-over is visible. The enforcing flip is one env change after
// `auth=missing` receipts have been zero for 48 hours (gate G-AUTH).
//
// Receipts: one ids-only `webhook_log` row per delivery, written after the
// auth decision, for every event type. No message text, no names, no phone
// numbers, no email addresses, no custom fields: identifiers and codes only.
// ════════════════════════════════════════════════════════════

export type AuthProof = "app_signature" | "workflow_secret";
export type AuthResult = AuthProof | "missing";
export type AuthMode = "observe" | "enforce";

export type AuthDetail =
  | "no_proof"
  | "signature_invalid"
  | "signature_key_unset"
  | "signature_verifier_unavailable"
  | "legacy_signature_unsupported"
  | "location_mismatch"
  | "location_unset"
  | "secret_invalid"
  | "secret_unset"
  | "proof_not_accepted_for_type";

export interface AuthDecision {
  auth: AuthResult;
  /** Why the delivery is not authenticated; null when it is. */
  detail: AuthDetail | null;
  /** Proof classes this event type accepts. */
  accepts: AuthProof[];
}

/** Events the GHL app signs (sms.md §13 P1 event list, plus legacy names). */
export const APP_SIGNED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "InboundMessage",
  "OutboundMessage",
  "NoteCreate",
  "NoteUpdate",
  "NoteDelete",
  "TaskCreate",
  "TaskComplete",
  "TaskDelete",
  "AppointmentCreate",
  "AppointmentUpdate",
  "AppointmentDelete",
]);

/** Events posted by GHL workflows, which carry the shared secret instead. */
export const WORKFLOW_EVENT_TYPES: ReadonlySet<string> = new Set([
  "CallCompleted",
  "CustomerReplied",
  "UserReplied",
  "Voicemail",
  "ContactStageChanged",
  "AppointmentCreated",
  "NoteAdded",
]);

export function acceptedProofsForType(type: string | null): AuthProof[] {
  if (type && APP_SIGNED_EVENT_TYPES.has(type)) return ["app_signature"];
  if (type && WORKFLOW_EVENT_TYPES.has(type)) return ["workflow_secret"];
  // ContactCreate / ContactUpdate come from the app or a workflow; an
  // unrecognised type is skipped by the receiver but must still prove itself.
  return ["app_signature", "workflow_secret"];
}

export function resolveAuthMode(raw: string | null | undefined): AuthMode {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "enforce" ? "enforce" : "observe";
}

/** Constant-time string comparison (length is not secret). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const clean = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Import an Ed25519 public key given as PEM (SPKI), base64 SPKI DER, or a
 * base64 raw 32-byte key. Returns null when the text is not a usable key;
 * throws only when the runtime lacks Ed25519 support.
 */
export async function importEd25519PublicKey(
  text: string,
): Promise<CryptoKey | null> {
  const body = text
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\\n/g, "")
    .trim();
  const bytes = base64ToBytes(body);
  if (!bytes || bytes.length === 0) return null;
  const format = bytes.length === 32 ? "raw" : "spki";
  try {
    return await crypto.subtle.importKey(
      format,
      bytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch (e) {
    if ((e as Error)?.name === "NotSupportedError") throw e;
    return null;
  }
}

export async function verifyEd25519Signature(
  key: CryptoKey,
  signatureB64: string,
  rawBody: string,
): Promise<boolean> {
  const sig = base64ToBytes(signatureB64.trim());
  if (!sig || sig.length !== 64) return false;
  try {
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      sig,
      new TextEncoder().encode(rawBody),
    );
  } catch {
    return false;
  }
}

export interface AuthInput {
  headers: Headers;
  rawBody: string;
  type: string | null;
  locationId: string | null;
  env: (name: string) => string | undefined;
}

type ProofCheck = { ok: true } | { ok: false; detail: AuthDetail } | null;

async function checkAppSignature(input: AuthInput): Promise<ProofCheck> {
  const signature = input.headers.get("x-ghl-signature");
  if (!signature) {
    // The RSA `X-WH-Signature` was deprecated by GHL on 1 Sep 2026.
    return input.headers.get("x-wh-signature")
      ? { ok: false, detail: "legacy_signature_unsupported" }
      : null;
  }
  const keyText = input.env("GHL_WEBHOOK_PUBLIC_KEY") ?? "";
  if (!keyText.trim()) return { ok: false, detail: "signature_key_unset" };
  let key: CryptoKey | null;
  try {
    key = await importEd25519PublicKey(keyText);
  } catch {
    return { ok: false, detail: "signature_verifier_unavailable" };
  }
  if (!key) return { ok: false, detail: "signature_key_unset" };
  if (!(await verifyEd25519Signature(key, signature, input.rawBody))) {
    return { ok: false, detail: "signature_invalid" };
  }
  const expectedLocation = (input.env("GHL_LOCATION_ID") ?? "").trim();
  if (!expectedLocation) return { ok: false, detail: "location_unset" };
  if (input.locationId !== expectedLocation) {
    return { ok: false, detail: "location_mismatch" };
  }
  return { ok: true };
}

function checkWorkflowSecret(input: AuthInput): ProofCheck {
  const presented = input.headers.get("x-webhook-secret") ??
    input.headers.get("authorization");
  if (!presented) return null;
  const secret = input.env("GHL_WEBHOOK_SECRET") ?? "";
  if (!secret) return { ok: false, detail: "secret_unset" };
  const ok = timingSafeEqual(presented, secret) ||
    timingSafeEqual(presented, `Bearer ${secret}`);
  return ok ? { ok: true } : { ok: false, detail: "secret_invalid" };
}

/** Decide which proof, if any, authenticates this delivery. Never throws. */
export async function decideAuth(input: AuthInput): Promise<AuthDecision> {
  const accepts = acceptedProofsForType(input.type);
  const app = await checkAppSignature(input);
  const workflow = checkWorkflowSecret(input);

  if (accepts.includes("app_signature") && app?.ok) {
    return { auth: "app_signature", detail: null, accepts };
  }
  if (accepts.includes("workflow_secret") && workflow?.ok) {
    return { auth: "workflow_secret", detail: null, accepts };
  }

  // Not authenticated: report the most specific reason among the proofs
  // this type accepts, then a proof of the wrong class for this type.
  for (const proof of accepts) {
    const check = proof === "app_signature" ? app : workflow;
    if (check && !check.ok) {
      return { auth: "missing", detail: check.detail, accepts };
    }
  }
  if (app || workflow) {
    return { auth: "missing", detail: "proof_not_accepted_for_type", accepts };
  }
  return { auth: "missing", detail: "no_proof", accepts };
}

// ── ids-only receipt ───────────────────────────────────────

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TYPE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** An identifier or null. Anything that is not a short id-shaped token is dropped. */
export function safeId(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  return ID_PATTERN.test(s) ? s : null;
}

export function safeEventType(raw: unknown): string {
  if (raw == null || raw === "") return "unknown";
  return typeof raw === "string" && TYPE_PATTERN.test(raw) ? raw : "invalid";
}

export type ReceiptOutcome =
  | "event_created"
  | "duplicate"
  | "skipped"
  | "unresolved_id"
  | "skipped_unsupported"
  | "capture_disabled"
  | "attribution_captured"
  | "unauthorized"
  | "invalid_json"
  | "error";

export interface WebhookReceipt {
  org_id: string;
  source: "ghl_webhook";
  event_type: string;
  status: "processed" | "rejected" | "failed";
  error_message: string | null;
  payload: {
    receipt: "ids_only_v1";
    type: string;
    webhook_id: string | null;
    message_id: string | null;
    contact_id: string | null;
    outcome: ReceiptOutcome;
    auth: AuthResult;
    auth_detail: AuthDetail | null;
    auth_mode: AuthMode;
  };
}

export function buildWebhookReceipt(args: {
  orgId: string;
  body: Record<string, unknown>;
  decision: AuthDecision;
  mode: AuthMode;
  outcome: ReceiptOutcome;
  errorCode?: string | null;
}): WebhookReceipt {
  const { body, decision, mode, outcome } = args;
  const type = safeEventType(body.type);
  const status = outcome === "error"
    ? "failed"
    : outcome === "unauthorized" || outcome === "invalid_json"
    ? "rejected"
    : "processed";
  return {
    org_id: args.orgId,
    source: "ghl_webhook",
    event_type: type,
    status,
    error_message: args.errorCode ? safeId(args.errorCode) ?? "error" : null,
    payload: {
      receipt: "ids_only_v1",
      type,
      webhook_id: safeId(body.webhookId ?? body.webhook_id),
      message_id: safeId(body.messageId ?? body.message_id),
      // GHL app contact events name the contact as `id`.
      contact_id: safeId(
        body.contactId ?? body.contact_id ??
          (type.startsWith("Contact") ? body.id : null),
      ),
      outcome,
      auth: decision.auth,
      auth_detail: decision.detail,
      auth_mode: mode,
    },
  };
}

/** Capture detail recorded on a ghl_webhook_receipts row (slice C1c). Ids and counts only. */
export interface ReceiptCapture {
  reason?: string | null;
  itemId?: string | null;
  eventId?: string | null;
  upgraded?: boolean;
  targeted?: {
    status: "ok" | "failed" | "skipped";
    seen: number;
    inserted: number;
    duplicates: number;
    skipped: number;
    errors: number;
  } | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The argument of public.record_ghl_webhook_receipt: one row of
 * ghl_webhook_receipts (sms.md §7 step 8). No body, no text: identifiers,
 * codes and counts only; the database refuses anything that is not id-shaped.
 */
export function buildGhlReceiptRow(args: {
  body: Record<string, unknown>;
  decision: AuthDecision;
  mode: AuthMode;
  outcome: ReceiptOutcome;
  errorCode?: string | null;
  capture?: ReceiptCapture | null;
}): Record<string, unknown> {
  const { body, decision, mode, outcome, capture } = args;
  const type = safeEventType(body.type);
  const appointment = body.appointment && typeof body.appointment === "object"
    ? body.appointment as Record<string, unknown>
    : null;
  const eventId = capture?.eventId && UUID_PATTERN.test(capture.eventId)
    ? capture.eventId
    : null;
  const t = capture?.targeted ?? null;
  return {
    event_type: type,
    webhook_id: safeId(body.webhookId ?? body.webhook_id),
    message_id: capture?.itemId ?? safeId(body.messageId ?? body.message_id),
    contact_id: safeId(
      body.contactId ?? body.contact_id ?? appointment?.contactId ??
        (type.startsWith("Contact") ? body.id : null),
    ),
    outcome,
    reason: safeId(capture?.reason ?? null),
    event_id: eventId,
    upgraded: capture?.upgraded === true,
    auth: decision.auth,
    auth_detail: decision.detail,
    auth_mode: mode,
    error_code: args.errorCode ? safeId(args.errorCode) ?? "error" : null,
    targeted_read: t?.status ?? null,
    targeted_seen: t ? t.seen : null,
    targeted_inserted: t ? t.inserted : null,
    targeted_duplicates: t ? t.duplicates : null,
    targeted_skipped: t ? t.skipped : null,
    targeted_errors: t ? t.errors : null,
  };
}

/** A log-safe error code: a database or provider code, else the error class name. */
export function errorCode(e: unknown): string {
  const obj = e as { code?: unknown; name?: unknown } | null;
  const code = safeId(obj?.code);
  if (code) return code;
  const name = safeId(obj?.name);
  return name ?? "error";
}
