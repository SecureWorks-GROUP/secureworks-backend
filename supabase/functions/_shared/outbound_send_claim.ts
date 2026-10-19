// Outbound send claims: the one hold every outbound send takes before it sends.
//
// The table and its five functions are 20261019170000_outbound_send_claims.sql.
// A caller names the items a send may deliver (item keys), claims them under a
// fresh attempt id, sends, then settles the attempt: sent, failed (definitely
// not sent) or outcome_unknown. A key held by a sending or outcome_unknown
// attempt refuses every new claim, so two presses that land together cannot
// both send, and an unknown outcome holds the item until someone checks the
// mailbox (or Xero History) and says so.
//
// Every function here fails CLOSED. A claim that cannot be written is a refusal
// (send_claim_unavailable), never a send; a settle that cannot be written leaves
// the claim at sending, which holds the item and reads as stale once its lease
// passes; a holds read that fails refuses (send_claim_unreadable).
//
// A "checked" press goes through reconcileThenClaim: it reconciles each held
// attempt by name, compare-and-set on the state it was read in, records who
// checked and when, and only then claims. A live sending attempt (inside its
// lease) is never released, and two checked presses together cannot both win:
// the second finds the state changed or the first one's live claim.

// deno-lint-ignore no-explicit-any
export type ClaimClient = { rpc: (fn: string, args?: Record<string, unknown>) => any }

export type SendHoldState = "sending" | "outcome_unknown"

export interface SendHold {
  attempt_id: string
  item_key: string
  state: SendHoldState
  stale: boolean
  claimed_at: string | null
  lease_until: string | null
  actor: string | null
}

export type SendClaimRefusalCode =
  | "send_claim_held"
  | "send_claim_unavailable"
  | "send_claim_unreadable"
  | "send_claim_attempt_exists"
  | "send_claim_invalid"
  | "send_claim_not_sending"
  | "send_reconcile_invalid"
  | "send_reconcile_actor_required"
  | "send_reconcile_live_send"
  | "send_reconcile_state_changed"
  | "send_reconcile_attempt_mismatch"

export type SendClaimRefusal = { ok: false; code: SendClaimRefusalCode; held: SendHold[] }
export type SendClaim = { ok: true; attempt_id: string; keys: string[] }
export type SendClaimResult = SendClaim | SendClaimRefusal

export type SettleState = "sent" | "failed" | "outcome_unknown"
export type SettleResult = { ok: true } | { ok: false; code: "send_settle_failed" | "send_claim_not_sending" | "send_settle_invalid_state" }

export const SEND_CLAIM_LEASE_SECONDS = 600

function refusal(code: SendClaimRefusalCode, held: SendHold[] = []): SendClaimRefusal {
  return { ok: false, code, held }
}

function cleanKeys(keys: string[]): string[] {
  return [...new Set(keys.map((k) => String(k || "").trim()).filter(Boolean))].sort()
}

/** A fresh attempt id for one send attempt. */
export function newSendAttemptId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

function asHold(value: unknown): SendHold | null {
  const row = value as Record<string, unknown> | null
  if (!row || typeof row !== "object") return null
  const state = row.state
  if (state !== "sending" && state !== "outcome_unknown") return null
  if (typeof row.attempt_id !== "string" || typeof row.item_key !== "string") return null
  return {
    attempt_id: row.attempt_id,
    item_key: row.item_key,
    state,
    stale: row.stale === true,
    claimed_at: typeof row.claimed_at === "string" ? row.claimed_at : null,
    lease_until: typeof row.lease_until === "string" ? row.lease_until : null,
    actor: typeof row.actor === "string" ? row.actor : null,
  }
}

function asHolds(value: unknown): SendHold[] {
  return Array.isArray(value) ? value.map(asHold).filter((h): h is SendHold => h !== null) : []
}

async function callRpc(client: ClaimClient, fn: string, args: Record<string, unknown>): Promise<{ data: unknown; failed: boolean }> {
  try {
    const { data, error } = await client.rpc(fn, args)
    if (error) return { data: null, failed: true }
    return { data, failed: false }
  } catch {
    return { data: null, failed: true }
  }
}

/** The unresolved holds on any of keys. A failed read is a refusal, never "clear". */
export async function readSendHolds(
  client: ClaimClient,
  keys: string[],
): Promise<{ ok: true; holds: SendHold[] } | SendClaimRefusal> {
  const wanted = cleanKeys(keys)
  if (wanted.length === 0) return refusal("send_claim_invalid")
  const { data, failed } = await callRpc(client, "read_outbound_send_holds", { p_keys: wanted })
  if (failed || !Array.isArray(data)) return refusal("send_claim_unreadable")
  return { ok: true, holds: asHolds(data) }
}

/** Claim keys for one new send attempt. Nothing may be sent unless this returns ok. */
export async function claimSend(
  client: ClaimClient,
  input: { keys: string[]; attemptId: string; actor?: string | null; detail?: Record<string, unknown>; leaseSeconds?: number },
): Promise<SendClaimResult> {
  const keys = cleanKeys(input.keys)
  if (keys.length === 0 || !input.attemptId) return refusal("send_claim_invalid")
  const { data, failed } = await callRpc(client, "claim_outbound_send", {
    p_keys: keys,
    p_attempt_id: input.attemptId,
    p_actor: input.actor ?? null,
    p_detail: input.detail ?? {},
    p_lease_seconds: input.leaseSeconds ?? SEND_CLAIM_LEASE_SECONDS,
  })
  const row = data as Record<string, unknown> | null
  if (failed || !row || typeof row !== "object") return refusal("send_claim_unavailable")
  if (row.ok === true) return { ok: true, attempt_id: input.attemptId, keys }
  const code = row.code
  if (code === "send_claim_held") return refusal("send_claim_held", asHolds(row.held))
  if (code === "send_claim_attempt_exists" || code === "send_claim_invalid") return refusal(code)
  return refusal("send_claim_unavailable")
}

/** Add keys to a live attempt (a door joining a claim its caller already holds). */
export async function extendSendClaim(
  client: ClaimClient,
  input: { attemptId: string; keys: string[]; actor?: string | null; detail?: Record<string, unknown> },
): Promise<SendClaimResult> {
  const keys = cleanKeys(input.keys)
  if (keys.length === 0 || !input.attemptId) return refusal("send_claim_invalid")
  const { data, failed } = await callRpc(client, "extend_outbound_send_claim", {
    p_attempt_id: input.attemptId,
    p_keys: keys,
    p_actor: input.actor ?? null,
    p_detail: input.detail ?? {},
  })
  const row = data as Record<string, unknown> | null
  if (failed || !row || typeof row !== "object") return refusal("send_claim_unavailable")
  if (row.ok === true) return { ok: true, attempt_id: input.attemptId, keys }
  const code = row.code
  if (code === "send_claim_held") return refusal("send_claim_held", asHolds(row.held))
  if (code === "send_claim_not_sending" || code === "send_claim_invalid") return refusal(code)
  return refusal("send_claim_unavailable")
}

/** Settle an attempt out of sending, once. A failed write leaves the hold in place. */
export async function settleSend(
  client: ClaimClient,
  attemptId: string,
  state: SettleState,
  detail: Record<string, unknown> = {},
): Promise<SettleResult> {
  const { data, failed } = await callRpc(client, "settle_outbound_send", {
    p_attempt_id: attemptId,
    p_state: state,
    p_detail: detail,
  })
  const row = data as Record<string, unknown> | null
  if (failed || !row || typeof row !== "object") return { ok: false, code: "send_settle_failed" }
  if (row.ok === true) return { ok: true }
  if (row.code === "send_claim_not_sending" || row.code === "send_settle_invalid_state") return { ok: false, code: row.code }
  return { ok: false, code: "send_settle_failed" }
}

/** A recorded checker: a named person or workflow, never a missing actor. */
export function reconcileActor(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim()
    if (value && value !== "actor_missing" && value !== "unknown") return value.slice(0, 200)
  }
  return null
}

/**
 * A "checked" press: release each attempt holding keys (it was checked and the
 * item was not sent), then claim for the new attempt. Refused, sending nothing,
 * when no real checker is named, when any holder is a live send, when the
 * caller named an attempt that is not the one holding the item, or when any
 * release loses its compare-and-set.
 */
export async function reconcileThenClaim(
  client: ClaimClient,
  input: {
    keys: string[]
    attemptId: string
    actor: string | null
    checkedAt?: string | null
    evidence?: string | null
    expectedAttemptId?: string | null
    detail?: Record<string, unknown>
    leaseSeconds?: number
  },
): Promise<SendClaimResult> {
  const actor = reconcileActor(input.actor)
  if (!actor) return refusal("send_reconcile_actor_required")
  const read = await readSendHolds(client, input.keys)
  if (!read.ok) return read
  const holds = read.holds
  if (holds.some((h) => h.state === "sending" && !h.stale)) return refusal("send_reconcile_live_send", holds)
  const attempts = new Map<string, SendHoldState>()
  for (const hold of holds) attempts.set(hold.attempt_id, hold.state)
  const expected = String(input.expectedAttemptId ?? "").trim()
  if (expected && (attempts.size !== 1 || !attempts.has(expected))) {
    return refusal("send_reconcile_attempt_mismatch", holds)
  }
  const checkedAt = input.checkedAt && !Number.isNaN(Date.parse(input.checkedAt))
    ? new Date(input.checkedAt).toISOString()
    : new Date().toISOString()
  for (const [attemptId, state] of attempts) {
    const { data, failed } = await callRpc(client, "reconcile_outbound_send", {
      p_attempt_id: attemptId,
      p_expected_state: state,
      p_result: "not_sent",
      p_actor: actor,
      p_checked_at: checkedAt,
      p_evidence: input.evidence ?? null,
    })
    const row = data as Record<string, unknown> | null
    if (failed || !row || typeof row !== "object") return refusal("send_claim_unavailable", holds)
    if (row.ok !== true) {
      const code = row.code
      if (
        code === "send_reconcile_invalid" || code === "send_reconcile_actor_required" ||
        code === "send_reconcile_live_send" || code === "send_reconcile_state_changed"
      ) return refusal(code, holds)
      return refusal("send_claim_unavailable", holds)
    }
  }
  return claimSend(client, {
    keys: input.keys,
    attemptId: input.attemptId,
    actor,
    detail: { ...(input.detail ?? {}), reconciled_attempts: [...attempts.keys()], checked_at: checkedAt },
    leaseSeconds: input.leaseSeconds,
  })
}

// ---------------------------------------------------------------------------
// Refusal wording. Fixed text only: no provider or exception text.

export const SEND_UNCERTAIN_MESSAGE =
  "An earlier send of this item is not confirmed, so it may already have reached the recipient. Nothing was sent now."
export const SEND_UNCERTAIN_RECOVERY =
  "Check the mailbox Sent Items (or the invoice History in Xero) for the earlier send. If it is not there, press again marked as checked; if it is there, do not send again."
export const SEND_IN_PROGRESS_MESSAGE =
  "A send of this item is in progress now. Nothing was sent now."
export const SEND_IN_PROGRESS_RECOVERY =
  "Wait for the send in progress to finish, then check the result before pressing again."
export const SEND_CLAIM_UNAVAILABLE_MESSAGE =
  "The send could not be recorded before sending, so nothing was sent."
export const SEND_CLAIM_UNAVAILABLE_RECOVERY = "Nothing was sent. Try again shortly."

/** The one refusal body every door returns when a claim is refused. */
export function sendClaimRefusalBody(result: SendClaimRefusal): Record<string, unknown> {
  const live = result.code === "send_reconcile_live_send" ||
    (result.code === "send_claim_held" && result.held.some((h) => h.state === "sending" && !h.stale))
  const unavailable = result.code === "send_claim_unavailable" || result.code === "send_claim_unreadable"
  const held = result.held.map((h) => ({
    attempt_id: h.attempt_id,
    item_key: h.item_key,
    state: h.state === "sending" && h.stale ? "outcome_unknown" : h.state,
    claimed_at: h.claimed_at,
  }))
  return {
    success: false,
    code: result.code,
    state: live ? "sending" : unavailable ? "not_sent" : "outcome_unknown",
    error: live ? SEND_IN_PROGRESS_MESSAGE : unavailable ? SEND_CLAIM_UNAVAILABLE_MESSAGE : SEND_UNCERTAIN_MESSAGE,
    recovery_action: live ? SEND_IN_PROGRESS_RECOVERY : unavailable ? SEND_CLAIM_UNAVAILABLE_RECOVERY : SEND_UNCERTAIN_RECOVERY,
    retry_safe: false,
    held,
  }
}

/** HTTP status for a refused claim: 503 when nothing could be recorded, else 409. */
export function sendClaimRefusalStatus(result: SendClaimRefusal): number {
  return result.code === "send_claim_unavailable" || result.code === "send_claim_unreadable" ? 503 : 409
}

// ---------------------------------------------------------------------------
// Item keys.

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function addressList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value]
  return list.map((v) => String((v as any)?.emailAddress?.address ?? (v as any)?.address ?? v ?? "").trim().toLowerCase())
    .filter(Boolean).sort()
}

/**
 * The key for one email's content: mailbox, mode, reply target, recipients,
 * subject, body and attachment hashes. Two requests that would deliver the same
 * email share the key, whichever door they come through.
 */
export async function emailContentKey(input: {
  mailbox?: string | null
  mode?: string | null
  replyTo?: string | null
  to?: unknown
  cc?: unknown
  bcc?: unknown
  subject?: string | null
  html?: string | null
  attachmentHashes?: string[]
}): Promise<string> {
  const canonical = JSON.stringify({
    mailbox: String(input.mailbox ?? "").trim().toLowerCase(),
    mode: String(input.mode ?? "new"),
    reply_to: String(input.replyTo ?? ""),
    to: addressList(input.to),
    cc: addressList(input.cc),
    bcc: addressList(input.bcc),
    subject: String(input.subject ?? ""),
    html: String(input.html ?? ""),
    attachments: [...(input.attachmentHashes ?? [])].map(String).sort(),
  })
  return `email_content:${await sha256Hex(canonical)}`
}

export async function bytesSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function invoiceSendKey(xeroInvoiceId: string): string {
  return `invoice:${String(xeroInvoiceId).trim()}`
}
