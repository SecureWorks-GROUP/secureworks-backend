// deno-lint-ignore-file no-explicit-any
// Approved sends: the owner's recorded approval for ONE exact email or SMS.
//
// The owner ruled (29 Sep 2026): "if I give approval for agents to send stuff,
// they can send it". This module is the one place that decides whether a send
// carries that approval. Every other send path is untouched and keeps its own
// checks; nothing here is reachable without an approval id.
//
// Shape:
//   1. RECORD (ops-api `record_send_approval`). Only the seat that records the
//      owner's word may call it (assertApprovalRecorderAllowed). It stores the
//      owner's words verbatim, who/when, the channel and the exact payload:
//      email = mailbox, new or reply (and the message replied to), exact To, CC,
//      BCC, subject, HTML body and attachment files by stored id + sha256;
//      sms = exact mobile, SecureWorks from-line and wording. The payload is
//      hashed (payloadHash) and the row is sealed with an HMAC (sealApproval)
//      keyed by the edge runtime's own service key, so a row written or edited
//      straight into the database, without going through this code, fails the
//      seal at send time. Dry run by default: the recorder must echo the hash
//      the preview returned (the confirmation step) before anything is stored.
//   2. SEND (send-outlook-email / ops-api `send_approved`, body {approval_id}
//      only). prepareApprovedSend re-reads the row, checks the seal, the
//      stored payload hash, status, expiry and the audit, re-reads every
//      attachment's bytes and REBUILDS the payload it is about to send; the
//      rebuilt payload's hash must equal the approved hash exactly. Only then
//      is the approval claimed (status approved -> sending, a compare-and-set
//      the database trigger makes one-way), and only the rebuilt payload is
//      handed to the provider.
//   3. AUDIT. Every record, refusal, claim and outcome is one append-only row in
//      approved_send_audit, and the approval row itself carries the outcome and
//      the provider's message id.
//
// Single use: once claimed an approval can never be sent again, whatever the
// outcome. A failed or unknown outcome needs a fresh approval from the owner.
//
// Schema: 20260929100000_approved_send_approvals.sql.

export const APPROVED_SEND_EMAIL_SCHEMA = "secureworks.approved-send.email/v1";
export const APPROVED_SEND_SMS_SCHEMA = "secureworks.approved-send.sms/v1";
export const APPROVED_SEND_SEAL_DOMAIN = "secureworks.approved-send.seal/v1";

/** Who may approve. Changing who approves is a ruling, not a code edit. */
export const APPROVED_SEND_APPROVER = "marnin";

/**
 * The seat(s) that may RECORD an approval: the main firstmate's service
 * identity, presented as the `x-sw-actor` header on a server-secret call.
 * Deliberately a reviewed code constant, not an environment value, so
 * widening it needs a reviewed change.
 */
export const APPROVED_SEND_RECORDER_ACTORS: ReadonlySet<string> = new Set([
  "seat:rayleigh",
]);

export const APPROVED_SEND_DEFAULT_EXPIRY_MINUTES = 24 * 60;
export const APPROVED_SEND_MAX_EXPIRY_MINUTES = 7 * 24 * 60;
/** Graph direct (inline) attachment boundary, as send-outlook-email. */
export const APPROVED_SEND_MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
export const APPROVED_SEND_MAX_MESSAGE_BYTES = 35 * 1024 * 1024;
export const APPROVED_SEND_MAX_ATTACHMENTS = 10;
export const APPROVED_SEND_MAX_SMS_CHARS = 1600;
/** An approval recorded more than this far in the future is refused. */
const APPROVED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

const KNOWN_GROUP_ADDRESSES = new Set([
  "ses@secureworkswa.com.au",
  "fencing@secureworkswa.com.au",
  "patios@secureworkswa.com.au",
]);

export type ApprovedSendChannel = "email" | "sms";

export class ApprovedSendRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly fact: string,
    readonly evidence: Record<string, unknown> = {},
  ) {
    super(fact);
    this.name = "ApprovedSendRefusal";
  }

  toBody(): Record<string, unknown> {
    return {
      state: "refused",
      code: this.code,
      fact: this.fact,
      ...(Object.keys(this.evidence).length ? { evidence: this.evidence } : {}),
    };
  }
}

function refuse(
  status: number,
  code: string,
  fact: string,
  evidence: Record<string, unknown> = {},
): never {
  throw new ApprovedSendRefusal(status, code, fact, evidence);
}

// ── Canonical JSON and hashing ──────────────────────────────────────────────

/** Deterministic JSON: object keys sorted at every depth, arrays in order. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined)
      .sort();
    return `{${
      keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")
    }}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof value}`);
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

export async function payloadHash(payload: ApprovedSendPayload): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(payload))}`;
}

// ── Payload shapes ──────────────────────────────────────────────────────────

export type AttachmentRef =
  | { source: "job_document"; id: string }
  | { source: "email_attachment"; id: string }
  | { source: "storage_object"; bucket: string; path: string };

export interface ApprovedAttachment {
  ref: AttachmentRef;
  name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
}

export interface EmailPayload {
  schema: typeof APPROVED_SEND_EMAIL_SCHEMA;
  channel: "email";
  mailbox: string;
  mode: "new" | "reply";
  reply_to_message_id: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html_body: string;
  attachments: ApprovedAttachment[];
}

export interface SmsPayload {
  schema: typeof APPROVED_SEND_SMS_SCHEMA;
  channel: "sms";
  to_mobile: string;
  from_line: string;
  message: string;
}

export type ApprovedSendPayload = EmailPayload | SmsPayload;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isEmail(value: string): boolean {
  return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value);
}

/** Exact recipient list: trimmed, lower-cased, order kept, no duplicates. */
export function normalizeRecipientList(
  value: unknown,
  field: string,
  required: boolean,
): string[] {
  if (value === undefined || value === null) {
    if (required) refuse(400, "approval_recipients_required", `${field} must list at least one recipient.`);
    return [];
  }
  if (!Array.isArray(value)) {
    refuse(400, "approval_invalid_recipient", `${field} must be an array of email addresses.`);
  }
  const output: string[] = [];
  for (const entry of value) {
    const email = text(entry).toLowerCase();
    if (!email || !isEmail(email)) {
      refuse(400, "approval_invalid_recipient", `${field} contains an invalid address.`, { field });
    }
    if (output.includes(email)) {
      refuse(400, "approval_duplicate_recipient", `${field} lists ${email} twice.`, { field });
    }
    output.push(email);
  }
  if (required && output.length === 0) {
    refuse(400, "approval_recipients_required", `${field} must list at least one recipient.`);
  }
  return output;
}

/**
 * One mobile number in E.164. Australian local forms (04xx…, 614xx…) are
 * converted; any other number must already be E.164. The approval stores and
 * hashes the normalised number, and the send goes to exactly that number.
 */
export function normalizeMobile(raw: unknown): string {
  const compact = text(raw).replace(/[\s().-]/g, "");
  if (/^\+614\d{8}$/.test(compact)) return compact;
  if (/^04\d{8}$/.test(compact)) return `+61${compact.slice(1)}`;
  if (/^614\d{8}$/.test(compact)) return `+${compact}`;
  if (/^\+[1-9]\d{7,14}$/.test(compact) && !compact.startsWith("+61")) {
    return compact;
  }
  refuse(400, "approval_invalid_mobile", "to_mobile must be one mobile number (Australian 04xx xxx xxx or E.164).");
}

export function normalizeAttachmentRef(raw: unknown): AttachmentRef {
  const input = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const source = text(input.source);
  if (source === "job_document" || source === "email_attachment") {
    const id = text(input.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      refuse(400, "approval_invalid_attachment", `${source} attachments need the stored document id.`);
    }
    return { source, id: id.toLowerCase() };
  }
  if (source === "storage_object") {
    const bucket = text(input.bucket);
    const path = text(input.path);
    if (!bucket || !path || path.includes("..")) {
      refuse(400, "approval_invalid_attachment", "storage_object attachments need a bucket and path.");
    }
    return { source, bucket, path };
  }
  return refuse(400, "approval_invalid_attachment", "attachment source must be job_document, email_attachment or storage_object.");
}

export function buildSmsPayload(
  input: { to_mobile: unknown; from_line?: unknown; message: unknown },
  resolveFrom: (raw: unknown) => { ok: true; fromNumber: string } | { ok: false; error: string },
): SmsPayload {
  const message = typeof input.message === "string" ? input.message : "";
  if (!message.trim()) refuse(400, "approval_message_required", "The SMS wording is required.");
  if (message.length > APPROVED_SEND_MAX_SMS_CHARS) {
    refuse(400, "approval_message_too_long", `The SMS wording is over ${APPROVED_SEND_MAX_SMS_CHARS} characters.`);
  }
  const from = resolveFrom(input.from_line);
  if (!from.ok) refuse(400, "approval_invalid_from_line", from.error);
  return {
    schema: APPROVED_SEND_SMS_SCHEMA,
    channel: "sms",
    to_mobile: normalizeMobile(input.to_mobile),
    from_line: from.fromNumber,
    message,
  };
}

export interface EmailPayloadInput {
  mailbox: unknown;
  mode?: unknown;
  reply_to_message_id?: unknown;
  to: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject: unknown;
  html_body: unknown;
}

/** Everything but attachments, validated. Attachments are resolved from bytes. */
export function buildEmailPayload(
  input: EmailPayloadInput,
  attachments: ApprovedAttachment[],
): EmailPayload {
  const mailbox = text(input.mailbox).toLowerCase();
  if (!mailbox || !isEmail(mailbox)) {
    refuse(400, "approval_invalid_mailbox", "mailbox must be the exact sending mailbox address.");
  }
  if (KNOWN_GROUP_ADDRESSES.has(mailbox)) {
    refuse(400, "approval_invalid_mailbox", "A Microsoft 365 Group address cannot send as a user mailbox.");
  }
  const mode = text(input.mode) || "new";
  if (mode !== "new" && mode !== "reply") {
    refuse(400, "approval_invalid_mode", "mode must be new or reply.");
  }
  const replyTo = text(input.reply_to_message_id);
  if (mode === "reply" && !replyTo) {
    refuse(400, "approval_reply_source_required", "A reply names the provider message_id it answers.");
  }
  if (mode === "new" && replyTo) {
    refuse(400, "approval_invalid_mode", "reply_to_message_id is only for mode reply.");
  }
  const subject = typeof input.subject === "string" ? input.subject : "";
  if (!subject.trim()) refuse(400, "approval_subject_required", "The exact subject is required.");
  const htmlBody = typeof input.html_body === "string" ? input.html_body : "";
  if (!htmlBody.trim()) refuse(400, "approval_body_required", "The exact body is required.");
  const to = normalizeRecipientList(input.to, "to", true);
  const cc = normalizeRecipientList(input.cc ?? [], "cc", false);
  const bcc = normalizeRecipientList(input.bcc ?? [], "bcc", false);
  const all = [...to, ...cc, ...bcc];
  if (new Set(all).size !== all.length) {
    refuse(400, "approval_duplicate_recipient", "An address appears in more than one of To, CC and BCC.");
  }
  return {
    schema: APPROVED_SEND_EMAIL_SCHEMA,
    channel: "email",
    mailbox,
    mode,
    reply_to_message_id: mode === "reply" ? replyTo : null,
    to,
    cc,
    bcc,
    subject,
    html_body: htmlBody,
    attachments,
  };
}

// ── Attachments ─────────────────────────────────────────────────────────────

export interface StoredFile {
  bytes: Uint8Array;
  content_type: string | null;
  /** The stored file name, when the store records one. */
  name: string | null;
}

export type AttachmentReader = (ref: AttachmentRef) => Promise<StoredFile>;

export interface LoadedAttachment {
  approved: ApprovedAttachment;
  bytes: Uint8Array;
}

function encodedLength(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function assertAttachmentLimits(files: { size: number }[]): void {
  if (files.length > APPROVED_SEND_MAX_ATTACHMENTS) {
    refuse(400, "approval_too_many_attachments", `At most ${APPROVED_SEND_MAX_ATTACHMENTS} attachments.`);
  }
  let total = 0;
  for (const file of files) {
    if (file.size > APPROVED_SEND_MAX_ATTACHMENT_BYTES) {
      refuse(413, "approval_attachment_too_large", "An attachment is over the 3 MB direct-attachment limit.");
    }
    total += encodedLength(file.size);
  }
  if (total > APPROVED_SEND_MAX_MESSAGE_BYTES) {
    refuse(413, "approval_message_too_large", "The encoded attachments exceed the 35 MB message limit.");
  }
}

function contentTypeFor(stored: string | null, name: string): string {
  const clean = String(stored || "").split(";")[0].trim().toLowerCase();
  if (clean && clean !== "application/octet-stream") return clean;
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  const byExt: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    heic: "image/heic",
    webp: "image/webp",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
    txt: "text/plain",
  };
  return byExt[ext] || "application/octet-stream";
}

/** At RECORD time: read each file once and pin its name, type, size and hash. */
export async function resolveAttachmentsForRecord(
  rawAttachments: unknown,
  reader: AttachmentReader,
): Promise<LoadedAttachment[]> {
  if (rawAttachments === undefined || rawAttachments === null) return [];
  if (!Array.isArray(rawAttachments)) {
    refuse(400, "approval_invalid_attachment", "attachments must be an array.");
  }
  if (rawAttachments.length > APPROVED_SEND_MAX_ATTACHMENTS) {
    refuse(400, "approval_too_many_attachments", `At most ${APPROVED_SEND_MAX_ATTACHMENTS} attachments.`);
  }
  const loaded: LoadedAttachment[] = [];
  for (const raw of rawAttachments) {
    const ref = normalizeAttachmentRef(raw);
    const file = await reader(ref);
    const override = text((raw as Record<string, unknown>)?.name);
    const fallback = ref.source === "storage_object"
      ? ref.path.split("/").pop() || ""
      : "";
    const name = override || text(file.name) || fallback;
    if (!name) refuse(400, "approval_attachment_name_required", "An attachment has no file name; give one.");
    loaded.push({
      approved: {
        ref,
        name,
        content_type: contentTypeFor(file.content_type, name),
        size_bytes: file.bytes.byteLength,
        sha256: await sha256Hex(file.bytes),
      },
      bytes: file.bytes,
    });
  }
  assertAttachmentLimits(loaded.map((entry) => ({ size: entry.bytes.byteLength })));
  return loaded;
}

/**
 * At SEND time: re-read each approved file. Name and type are the approved
 * labels; size and sha256 are re-derived from the bytes actually about to go.
 */
export async function reloadAttachmentsForSend(
  approved: ApprovedAttachment[],
  reader: AttachmentReader,
): Promise<LoadedAttachment[]> {
  const loaded: LoadedAttachment[] = [];
  for (const entry of approved) {
    const file = await reader(normalizeAttachmentRef(entry.ref));
    loaded.push({
      approved: {
        ref: normalizeAttachmentRef(entry.ref),
        name: entry.name,
        content_type: entry.content_type,
        size_bytes: file.bytes.byteLength,
        sha256: await sha256Hex(file.bytes),
      },
      bytes: file.bytes,
    });
  }
  assertAttachmentLimits(loaded.map((entry) => ({ size: entry.bytes.byteLength })));
  return loaded;
}

// ── Seal ────────────────────────────────────────────────────────────────────

export interface SealFields {
  id: string;
  channel: ApprovedSendChannel;
  schema_version: string;
  payload_hash: string;
  approved_by: string;
  approved_at: string;
  approval_words: string;
  approval_source: string;
  recorded_by_actor: string;
  recorded_via: string;
  expires_at: string;
}

function isoInstant(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`not an instant: ${value}`);
  return new Date(ms).toISOString();
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

export async function sealApproval(secret: string, fields: SealFields): Promise<string> {
  if (!secret) {
    refuse(503, "approval_seal_unavailable", "The approval seal key is not available in this runtime.");
  }
  const message = `${APPROVED_SEND_SEAL_DOMAIN}\n${
    canonicalJson({
      ...fields,
      id: fields.id.toLowerCase(),
      approved_at: isoInstant(fields.approved_at),
      expires_at: isoInstant(fields.expires_at),
      approval_words_sha256: await sha256Hex(fields.approval_words),
      approval_words: undefined,
    })
  }`;
  return `hmac-sha256:${await hmacHex(secret, message)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Recorder restriction ────────────────────────────────────────────────────

export type RecorderCredentialClass =
  | "service_role"
  | "ops_agent_server_key"
  | "shared_key"
  | "routine"
  | "agent_read"
  | "user_jwt"
  | "none";

export interface RecorderIdentity {
  credentialClass: RecorderCredentialClass;
  actor: string;
  /** From request_actor.ts: 'header' means a server-secret caller named itself. */
  actorSource: string;
}

/**
 * The recording door. Only a server-secret credential (the service role or the
 * ops agent server key; never the shared browser key, the routine key, a
 * look-only key or any signed-in app user) AND the recorder seat named on
 * that call. A refusal names what was missing and never echoes a header.
 */
export function assertApprovalRecorderAllowed(identity: RecorderIdentity): void {
  if (
    identity.credentialClass !== "service_role" &&
    identity.credentialClass !== "ops_agent_server_key"
  ) {
    refuse(403, "approval_recorder_required",
      "Recording an owner approval needs the recording seat's server credential; app sessions, shared, routine and look-only keys are refused.",
      { credential_class: identity.credentialClass });
  }
  if (identity.actorSource !== "header" || !APPROVED_SEND_RECORDER_ACTORS.has(identity.actor)) {
    refuse(403, "approval_recorder_required",
      "Only the recording seat may record an owner approval.",
      { credential_class: identity.credentialClass });
  }
}

// ── Rows and the store ──────────────────────────────────────────────────────

export interface ApprovalRow {
  id: string;
  created_at?: string;
  schema_version: string;
  channel: ApprovedSendChannel;
  approved_by: string;
  approved_at: string;
  approval_words: string;
  approval_source: string;
  recorded_by_actor: string;
  recorded_via: string;
  payload: ApprovedSendPayload;
  payload_hash: string;
  seal: string;
  expires_at: string;
  status: "approved" | "sending" | "sent" | "failed" | "outcome_unknown";
  claimed_at?: string | null;
  claim_token?: string | null;
  outcome_at?: string | null;
  outcome_code?: string | null;
  provider_message_id?: string | null;
  provider_detail?: Record<string, unknown> | null;
}

export type AuditEvent =
  | "recorded"
  | "record_refused"
  | "send_refused"
  | "claimed"
  | "sent"
  | "failed"
  | "outcome_unknown";

export interface AuditEntry {
  approval_id: string | null;
  event: AuditEvent;
  channel?: string | null;
  actor?: string | null;
  credential_class?: string | null;
  code?: string | null;
  payload_hash?: string | null;
  provider_message_id?: string | null;
  detail?: Record<string, unknown>;
}

export interface ApprovedSendStore {
  insertApproval(row: ApprovalRow): Promise<void>;
  loadApproval(id: string): Promise<ApprovalRow | null>;
  /** True when the audit already holds a claim for this approval. */
  hasClaimAudit(id: string): Promise<boolean>;
  /** Compare-and-set approved -> sending. False when someone else won. */
  claim(id: string, claimToken: string, nowIso: string): Promise<boolean>;
  finish(
    id: string,
    claimToken: string,
    outcome: {
      status: "sent" | "failed" | "outcome_unknown";
      code: string | null;
      provider_message_id: string | null;
      provider_detail: Record<string, unknown>;
      at: string;
    },
  ): Promise<boolean>;
  audit(entry: AuditEntry): Promise<void>;
  listAudit(id: string): Promise<Record<string, unknown>[]>;
}

const APPROVAL_COLUMNS =
  "id,created_at,schema_version,channel,approved_by,approved_at,approval_words,approval_source,recorded_by_actor,recorded_via,payload,payload_hash,seal,expires_at,status,claimed_at,claim_token,outcome_at,outcome_code,provider_message_id,provider_detail";

function storeUnreadable(what: string, message: string): never {
  refuse(503, "approval_store_unreadable", `The approval store could not be ${what} (${message}).`);
}

/** PostgREST implementation over the service-role client. */
export function supabaseApprovedSendStore(client: any): ApprovedSendStore {
  return {
    async insertApproval(row) {
      const { error } = await client.from("approved_send_approvals").insert({
        id: row.id,
        schema_version: row.schema_version,
        channel: row.channel,
        approved_by: row.approved_by,
        approved_at: row.approved_at,
        approval_words: row.approval_words,
        approval_source: row.approval_source,
        recorded_by_actor: row.recorded_by_actor,
        recorded_via: row.recorded_via,
        payload: row.payload,
        payload_hash: row.payload_hash,
        seal: row.seal,
        expires_at: row.expires_at,
      });
      if (error) storeUnreadable("written", error.message);
    },
    async loadApproval(id) {
      const { data, error } = await client.from("approved_send_approvals")
        .select(APPROVAL_COLUMNS).eq("id", id).maybeSingle();
      if (error) storeUnreadable("read", error.message);
      return (data as ApprovalRow) || null;
    },
    async hasClaimAudit(id) {
      const { data, error } = await client.from("approved_send_audit")
        .select("id").eq("approval_id", id).eq("event", "claimed").limit(1);
      if (error) storeUnreadable("read", error.message);
      return Array.isArray(data) && data.length > 0;
    },
    async claim(id, claimToken, nowIso) {
      const { data, error } = await client.from("approved_send_approvals")
        .update({ status: "sending", claimed_at: nowIso, claim_token: claimToken })
        .eq("id", id).eq("status", "approved").gt("expires_at", nowIso)
        .select("id");
      if (error) storeUnreadable("claimed", error.message);
      return Array.isArray(data) && data.length === 1;
    },
    async finish(id, claimToken, outcome) {
      const { data, error } = await client.from("approved_send_approvals")
        .update({
          status: outcome.status,
          outcome_at: outcome.at,
          outcome_code: outcome.code,
          provider_message_id: outcome.provider_message_id,
          provider_detail: outcome.provider_detail,
        })
        .eq("id", id).eq("status", "sending").eq("claim_token", claimToken)
        .select("id");
      if (error) {
        console.error("[approved_send] outcome write failed:", error.message);
        return false;
      }
      return Array.isArray(data) && data.length === 1;
    },
    async audit(entry) {
      const { error } = await client.from("approved_send_audit").insert({
        approval_id: entry.approval_id,
        event: entry.event,
        channel: entry.channel ?? null,
        actor: entry.actor ?? null,
        credential_class: entry.credential_class ?? null,
        code: entry.code ?? null,
        payload_hash: entry.payload_hash ?? null,
        provider_message_id: entry.provider_message_id ?? null,
        detail: entry.detail ?? {},
      });
      if (error) throw new Error(`approved_send audit write failed: ${error.message}`);
    },
    async listAudit(id) {
      const { data, error } = await client.from("approved_send_audit")
        .select("occurred_at,event,channel,actor,credential_class,code,payload_hash,provider_message_id,detail")
        .eq("approval_id", id).order("occurred_at", { ascending: true });
      if (error) storeUnreadable("read", error.message);
      return data || [];
    },
  };
}

/** Best-effort audit of a refusal: a failed audit write never masks the refusal. */
export async function auditQuietly(store: ApprovedSendStore, entry: AuditEntry): Promise<void> {
  try {
    await store.audit(entry);
  } catch (error) {
    console.error("[approved_send] audit write failed:", (error as Error).message);
  }
}

// ── Record ──────────────────────────────────────────────────────────────────

export interface RecordDeps {
  store: ApprovedSendStore;
  readAttachment: AttachmentReader;
  resolveFrom: (raw: unknown) => { ok: true; fromNumber: string } | { ok: false; error: string };
  sealSecret: string;
  now: () => Date;
  newId: () => string;
}

export interface RecordResult {
  dry_run: boolean;
  approval_id: string | null;
  channel: ApprovedSendChannel;
  payload: ApprovedSendPayload;
  payload_hash: string;
  expires_at: string;
  recovery_action?: string;
}

/**
 * Record one owner approval. Dry run by default: returns the exact payload and
 * its hash. A live record needs dry_run:false AND expected_payload_hash equal
 * to the hash of what is being recorded — the recorder confirms the exact
 * content, never a flag. The caller has already passed
 * assertApprovalRecorderAllowed.
 */
export async function recordApproval(
  deps: RecordDeps,
  identity: RecorderIdentity,
  body: Record<string, unknown>,
): Promise<RecordResult> {
  const channelRaw = text(body.channel);
  if (channelRaw !== "email" && channelRaw !== "sms") {
    refuse(400, "approval_invalid_channel", "channel must be email or sms.");
  }
  const channel: ApprovedSendChannel = channelRaw;
  const approvedBy = text(body.approved_by).toLowerCase();
  if (approvedBy !== APPROVED_SEND_APPROVER) {
    refuse(403, "approval_approver_not_owner", "Only the owner's approval is recorded here.");
  }
  const words = typeof body.approval_words === "string" ? body.approval_words : "";
  if (!words.trim()) {
    refuse(400, "approval_words_required", "The owner's words, verbatim, are required.");
  }
  const source = text(body.approval_source);
  if (!source) {
    refuse(400, "approval_source_required", "Say where the owner gave these words (session, channel, time).");
  }
  const now = deps.now();
  const approvedAtMs = Date.parse(text(body.approved_at));
  if (!Number.isFinite(approvedAtMs)) {
    refuse(400, "approval_time_required", "approved_at must be the time the owner gave his approval.");
  }
  if (approvedAtMs > now.getTime() + APPROVED_AT_FUTURE_SKEW_MS) {
    refuse(400, "approval_time_in_future", "approved_at is in the future.");
  }
  const minutesRaw = body.expires_in_minutes;
  const minutes = minutesRaw === undefined || minutesRaw === null
    ? APPROVED_SEND_DEFAULT_EXPIRY_MINUTES
    : Number(minutesRaw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > APPROVED_SEND_MAX_EXPIRY_MINUTES) {
    refuse(400, "approval_invalid_expiry", `expires_in_minutes must be a whole number from 1 to ${APPROVED_SEND_MAX_EXPIRY_MINUTES}.`);
  }
  const expiresAt = new Date(now.getTime() + minutes * 60_000).toISOString();

  let payload: ApprovedSendPayload;
  if (channel === "sms") {
    const sms = (body.sms && typeof body.sms === "object") ? body.sms as Record<string, unknown> : {};
    payload = buildSmsPayload({
      to_mobile: sms.to_mobile,
      from_line: sms.from_line,
      message: sms.message,
    }, deps.resolveFrom);
  } else {
    const email = (body.email && typeof body.email === "object")
      ? body.email as Record<string, unknown>
      : {};
    // Validate the text fields before any file is read.
    buildEmailPayload(email as unknown as EmailPayloadInput, []);
    const loaded = await resolveAttachmentsForRecord(email.attachments, deps.readAttachment);
    payload = buildEmailPayload(
      email as unknown as EmailPayloadInput,
      loaded.map((entry) => entry.approved),
    );
  }
  const hash = await payloadHash(payload);
  const dryRun = body.dry_run !== false;
  if (dryRun) {
    return {
      dry_run: true,
      approval_id: null,
      channel,
      payload,
      payload_hash: hash,
      expires_at: expiresAt,
      recovery_action:
        "Check this exact payload against the owner's approval, then record it with dry_run:false and expected_payload_hash set to payload_hash.",
    };
  }
  if (text(body.expected_payload_hash) !== hash) {
    refuse(409, "approval_payload_hash_mismatch",
      "expected_payload_hash does not match the content being recorded; preview it again and confirm the exact hash.",
      { payload_hash: hash });
  }

  const id = deps.newId().toLowerCase();
  const fields: SealFields = {
    id,
    channel,
    schema_version: payload.schema,
    payload_hash: hash,
    approved_by: approvedBy,
    approved_at: new Date(approvedAtMs).toISOString(),
    approval_words: words,
    approval_source: source,
    recorded_by_actor: identity.actor,
    recorded_via: identity.credentialClass,
    expires_at: expiresAt,
  };
  const row: ApprovalRow = {
    ...fields,
    payload,
    seal: await sealApproval(deps.sealSecret, fields),
    status: "approved",
  };
  await deps.store.insertApproval(row);
  await deps.store.audit({
    approval_id: id,
    event: "recorded",
    channel,
    actor: identity.actor,
    credential_class: identity.credentialClass,
    payload_hash: hash,
    detail: {
      approved_by: approvedBy,
      approved_at: fields.approved_at,
      approval_words: words,
      approval_source: source,
      expires_at: expiresAt,
      payload,
    },
  });
  return {
    dry_run: false,
    approval_id: id,
    channel,
    payload,
    payload_hash: hash,
    expires_at: expiresAt,
  };
}

// ── Send ────────────────────────────────────────────────────────────────────

export interface SendDeps {
  store: ApprovedSendStore;
  readAttachment: AttachmentReader;
  resolveFrom: (raw: unknown) => { ok: true; fromNumber: string } | { ok: false; error: string };
  sealSecret: string;
  now: () => Date;
  newId: () => string;
}

export interface PreparedSend {
  row: ApprovalRow;
  /** The payload REBUILT from stored refs and freshly read bytes. */
  payload: ApprovedSendPayload;
  attachments: LoadedAttachment[];
}

/** The send door accepts {approval_id} and nothing else. */
export function readApprovalIdOnly(body: unknown): string {
  const input = (body && typeof body === "object" && !Array.isArray(body))
    ? body as Record<string, unknown>
    : null;
  if (!input) refuse(400, "approval_id_required", "Send {approval_id} only.");
  const extra = Object.keys(input).filter((key) => key !== "approval_id");
  if (extra.length) {
    refuse(400, "approval_send_fields_rejected",
      "An approved send takes only approval_id; everything sent comes from the approval.",
      { rejected_fields: extra.sort() });
  }
  const id = text(input.approval_id).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    refuse(400, "approval_id_required", "approval_id must be the recorded approval's id.");
  }
  return id;
}

/**
 * Everything short of claiming: load, seal, stored-hash, status, expiry, prior
 * claim, then rebuild the payload from what will actually be sent and require
 * its hash to equal the approved hash. Throws ApprovedSendRefusal.
 */
export async function prepareApprovedSend(
  deps: SendDeps,
  approvalId: string,
  channel: ApprovedSendChannel,
): Promise<PreparedSend> {
  const row = await deps.store.loadApproval(approvalId);
  if (!row) refuse(404, "approval_not_found", "No recorded approval has this id.");
  if (row.channel !== channel) {
    refuse(409, "approval_wrong_channel", `This approval is for ${row.channel}, not ${channel}.`);
  }
  const expectedSeal = await sealApproval(deps.sealSecret, {
    id: row.id,
    channel: row.channel,
    schema_version: row.schema_version,
    payload_hash: row.payload_hash,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    approval_words: row.approval_words,
    approval_source: row.approval_source,
    recorded_by_actor: row.recorded_by_actor,
    recorded_via: row.recorded_via,
    expires_at: row.expires_at,
  });
  if (!constantTimeEqual(expectedSeal, String(row.seal || ""))) {
    refuse(409, "approval_seal_invalid",
      "This approval was not recorded through the approval door, or was changed after it was recorded.");
  }
  if (row.approved_by !== APPROVED_SEND_APPROVER) {
    refuse(409, "approval_approver_not_owner", "The recorded approver is not the owner.");
  }
  const storedHash = await payloadHash(row.payload);
  if (storedHash !== row.payload_hash || row.payload?.schema !== row.schema_version) {
    refuse(409, "approval_payload_tampered", "The stored payload no longer matches its approved hash.");
  }
  if (row.status !== "approved") {
    refuse(409, "approval_already_used", "This approval has already been used; a new send needs a new approval.",
      { status: row.status });
  }
  if (Date.parse(row.expires_at) <= deps.now().getTime()) {
    refuse(409, "approval_expired", "This approval has expired; a new send needs a new approval.",
      { expires_at: row.expires_at });
  }
  if (await deps.store.hasClaimAudit(row.id)) {
    refuse(409, "approval_already_used", "The audit already records a send attempt for this approval.");
  }

  let rebuilt: ApprovedSendPayload;
  let attachments: LoadedAttachment[] = [];
  if (row.channel === "sms") {
    const stored = row.payload as SmsPayload;
    rebuilt = buildSmsPayload({
      to_mobile: stored.to_mobile,
      from_line: stored.from_line,
      message: stored.message,
    }, deps.resolveFrom);
  } else {
    const stored = row.payload as EmailPayload;
    attachments = await reloadAttachmentsForSend(stored.attachments || [], deps.readAttachment);
    rebuilt = buildEmailPayload(stored, attachments.map((entry) => entry.approved));
  }
  const rebuiltHash = await payloadHash(rebuilt);
  if (rebuiltHash !== row.payload_hash) {
    const evidence: Record<string, unknown> = { approved_hash: row.payload_hash, send_hash: rebuiltHash };
    if (row.channel === "email") {
      const stored = (row.payload as EmailPayload).attachments || [];
      evidence.changed_attachments = attachments
        .filter((entry, index) => entry.approved.sha256 !== stored[index]?.sha256)
        .map((entry) => entry.approved.name);
    }
    refuse(409, "approval_content_mismatch",
      "What would be sent now differs from what the owner approved (a file or field changed).",
      evidence);
  }
  return { row, payload: rebuilt, attachments };
}

export interface ClaimedSend extends PreparedSend {
  claimToken: string;
}

/** Consume the approval. After this the approval can never be sent again. */
export async function claimApprovedSend(
  deps: SendDeps,
  prepared: PreparedSend,
  caller: { actor: string | null; credentialClass: string | null },
): Promise<ClaimedSend> {
  const claimToken = deps.newId().toLowerCase();
  const nowIso = deps.now().toISOString();
  const won = await deps.store.claim(prepared.row.id, claimToken, nowIso);
  if (!won) {
    refuse(409, "approval_already_used", "Another send claimed this approval first, or it expired.");
  }
  try {
    await deps.store.audit({
      approval_id: prepared.row.id,
      event: "claimed",
      channel: prepared.row.channel,
      actor: caller.actor,
      credential_class: caller.credentialClass,
      payload_hash: prepared.row.payload_hash,
      detail: { claimed_at: nowIso },
    });
  } catch (error) {
    // No audit, no send. The approval is already consumed; close it as failed.
    await deps.store.finish(prepared.row.id, claimToken, {
      status: "failed",
      code: "audit_write_failed",
      provider_message_id: null,
      provider_detail: { error: (error as Error).message },
      at: deps.now().toISOString(),
    });
    refuse(503, "approval_audit_unwritable",
      "The audit could not be written, so nothing was sent. The approval is used; record a new one.");
  }
  return { ...prepared, claimToken };
}

export interface SendOutcome {
  status: "sent" | "failed" | "outcome_unknown";
  code: string | null;
  provider_message_id: string | null;
  detail: Record<string, unknown>;
}

/** Write the outcome to the approval row and the audit. Never throws. */
export async function finishApprovedSend(
  deps: SendDeps,
  claimed: ClaimedSend,
  outcome: SendOutcome,
  caller: { actor: string | null; credentialClass: string | null },
): Promise<{ outcome_recorded: boolean; audit_recorded: boolean }> {
  const at = deps.now().toISOString();
  let outcomeRecorded = false;
  try {
    outcomeRecorded = await deps.store.finish(claimed.row.id, claimed.claimToken, {
      status: outcome.status,
      code: outcome.code,
      provider_message_id: outcome.provider_message_id,
      provider_detail: outcome.detail,
      at,
    });
  } catch (error) {
    console.error("[approved_send] outcome write threw:", (error as Error).message);
  }
  let auditRecorded = true;
  try {
    await deps.store.audit({
      approval_id: claimed.row.id,
      event: outcome.status,
      channel: claimed.row.channel,
      actor: caller.actor,
      credential_class: caller.credentialClass,
      code: outcome.code,
      payload_hash: claimed.row.payload_hash,
      provider_message_id: outcome.provider_message_id,
      detail: { ...outcome.detail, at },
    });
  } catch (error) {
    auditRecorded = false;
    console.error("[approved_send] outcome audit failed:", (error as Error).message);
  }
  return { outcome_recorded: outcomeRecorded, audit_recorded: auditRecorded };
}

/** A readable status for the recorder: the approval without its seal, plus its audit. */
export async function readApprovalStatus(
  store: ApprovedSendStore,
  approvalId: string,
): Promise<Record<string, unknown>> {
  const row = await store.loadApproval(approvalId);
  if (!row) refuse(404, "approval_not_found", "No recorded approval has this id.");
  const { seal: _seal, claim_token: _token, ...visible } = row;
  return { approval: visible, audit: await store.listAudit(approvalId) };
}

// ── Supabase-backed attachment reader ───────────────────────────────────────

function parseStorageUrl(url: string): { bucket: string; path: string } | null {
  const match = String(url || "").trim().match(
    /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+?)(?:\?|$)/i,
  );
  if (!match) return null;
  const bucket = decodeURIComponent(match[1] || "").trim();
  const path = decodeURIComponent(match[2] || "").trim();
  return bucket && path ? { bucket, path } : null;
}

const EMAIL_ATTACHMENT_BUCKET = "makesafe-emails";

/**
 * Reads stored files only: a job_documents row, an email_attachments row, or a
 * named object in this project's storage. Never an arbitrary URL. A money
 * document of a sealed SES card is refused: those leave only through the
 * sealed release graph, and an approval does not reopen that fence.
 */
export function supabaseAttachmentReader(
  client: any,
  isSealedSesJob: (jobId: string) => Promise<boolean>,
): AttachmentReader {
  const download = async (bucket: string, path: string): Promise<{ bytes: Uint8Array; type: string | null }> => {
    const result = await client.storage.from(bucket).download(path);
    if (result.error || !result.data) {
      refuse(409, "approval_attachment_unreadable", "A stored attachment could not be read.",
        { bucket, path });
    }
    return {
      bytes: new Uint8Array(await result.data.arrayBuffer()),
      type: text(result.data.type) || null,
    };
  };
  return async (ref) => {
    if (ref.source === "storage_object") {
      const file = await download(ref.bucket, ref.path);
      return { bytes: file.bytes, content_type: file.type, name: null };
    }
    if (ref.source === "email_attachment") {
      const { data, error } = await client.from("email_attachments")
        .select("id,name,content_type,storage_path,pii_purged_at")
        .eq("id", ref.id).maybeSingle();
      if (error) storeUnreadable("read", error.message);
      if (!data || !text(data.storage_path) || data.pii_purged_at) {
        refuse(409, "approval_attachment_unreadable", "The email attachment is missing or has no stored bytes.",
          { email_attachment_id: ref.id });
      }
      const file = await download(EMAIL_ATTACHMENT_BUCKET, data.storage_path);
      return { bytes: file.bytes, content_type: text(data.content_type) || file.type, name: text(data.name) || null };
    }
    const { data, error } = await client.from("job_documents")
      .select("id,job_id,type,file_name,storage_url,pdf_url")
      .eq("id", ref.id).maybeSingle();
    if (error) storeUnreadable("read", error.message);
    if (!data) {
      refuse(409, "approval_attachment_unreadable", "The job document does not exist.", { job_document_id: ref.id });
    }
    const docType = text(data.type).toLowerCase();
    if (data.job_id && docType.includes("invoice")) {
      let sealed: boolean;
      try {
        sealed = await isSealedSesJob(data.job_id);
      } catch (err) {
        refuse(503, "approval_fence_check_failed", `The SES money fence could not be checked (${(err as Error).message}).`,
          { job_document_id: ref.id });
      }
      if (sealed) {
        refuse(409, "approval_sealed_ses_money_document",
          "This is a sealed SES card's invoice; it leaves only through the SES release path.",
          { job_document_id: ref.id });
      }
    }
    const location = parseStorageUrl(text(data.storage_url) || text(data.pdf_url));
    if (!location) {
      refuse(409, "approval_attachment_unreadable", "The job document has no stored file in this project's storage.",
        { job_document_id: ref.id });
    }
    const file = await download(location.bucket, location.path);
    return { bytes: file.bytes, content_type: file.type, name: text(data.file_name) || null };
  };
}

/** The seal key: the edge runtime's own service key. No new secret. */
export function approvedSendSealSecret(): string {
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}
