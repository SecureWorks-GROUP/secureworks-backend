// Outbound send claims: the one hold every outbound send takes before it sends.
//
// The table and its six functions are 20261019170000_outbound_send_claims.sql.
// A caller names the items a send may deliver (item keys), claims them under a
// fresh attempt id, sends, then settles the attempt: sent, failed (definitely
// not sent) or outcome_unknown. A key held by a sending or outcome_unknown
// attempt refuses every new claim, so two presses that land together cannot
// both send, and an unknown outcome holds the item until someone checks the
// mailbox (or Xero History) and says so.
//
// Dispatch is single-use. A claim returns a dispatch_token; a door that joins
// its caller's claim (extendSendClaim) gets a fresh one and the caller's stops
// working. A second extension of the same attempt is refused
// (send_claim_dispatch_taken), so two requests carrying one caller attempt
// cannot both dispatch. Whoever holds the current token calls
// confirmSendDispatch immediately before the provider call: it answers ok only
// while the attempt is still sending, the token is current and the lease is
// live, so a worker whose claim was reconciled or lapsed sends nothing. A
// caller settling an attempt its door extended passes { settler: "caller" };
// while the door's dispatch is open that settle is deferred (no state change,
// deferred: true) and the door's own settle records the outcome.
//
// The lease (900 seconds) is expiry-based recovery, not proof a worker
// stopped: release after expiry rests on the edge-function wall-clock limit
// and on the pre-send fence above, and still needs a named checker.
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
  | "send_claim_dispatch_taken"
  | "send_claim_item_mismatch"
  | "send_dispatch_fenced"
  | "send_reconcile_invalid"
  | "send_reconcile_actor_required"
  | "send_reconcile_live_send"
  | "send_reconcile_state_changed"
  | "send_reconcile_attempt_mismatch"

export type SendClaimRefusal = { ok: false; code: SendClaimRefusalCode; held: SendHold[] }
/** dispatch_token: the token confirmSendDispatch checks before the send ("" if the store returned none, which never confirms). */
export type SendClaim = { ok: true; attempt_id: string; keys: string[]; dispatch_token: string }
export type SendClaimResult = SendClaim | SendClaimRefusal

export type SettleState = "sent" | "failed" | "outcome_unknown"
export type SettleCode =
  | "send_settle_failed"
  | "send_claim_not_sending"
  | "send_settle_invalid_state"
  | "send_settle_invalid_settler"
  | "send_settle_not_dispatcher"
/** deferred: a caller settle held back because the door's dispatch is still open; the attempt is still sending. */
export type SettleResult = { ok: true; deferred?: true; state?: "sending" } | { ok: false; code: SettleCode }
/** "dispatcher": whoever made the provider call (default). "caller": a caller whose door may have extended the attempt. */
export type SendSettler = "dispatcher" | "caller"

export type DispatchConfirmResult = { ok: true } | SendClaimRefusal

export const SEND_CLAIM_LEASE_SECONDS = 900

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

function claimFromRow(row: Record<string, unknown>, attemptId: string, keys: string[]): SendClaim {
  return {
    ok: true,
    attempt_id: attemptId,
    keys,
    dispatch_token: typeof row.dispatch_token === "string" ? row.dispatch_token : "",
  }
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
  if (row.ok === true) return claimFromRow(row, input.attemptId, keys)
  const code = row.code
  if (code === "send_claim_held") return refusal("send_claim_held", asHolds(row.held))
  if (code === "send_claim_attempt_exists" || code === "send_claim_invalid") return refusal(code)
  return refusal("send_claim_unavailable")
}

/**
 * A door joins the live claim its caller holds and takes over the dispatch.
 * Once per attempt: a repeat, with the same keys or others, is
 * send_claim_dispatch_taken, never success. callerItemKey, when given, must
 * be one of the attempt's own keys (send_claim_item_mismatch otherwise).
 */
export async function extendSendClaim(
  client: ClaimClient,
  input: {
    attemptId: string
    keys: string[]
    callerItemKey?: string | null
    actor?: string | null
    detail?: Record<string, unknown>
  },
): Promise<SendClaimResult> {
  const keys = cleanKeys(input.keys)
  if (keys.length === 0 || !input.attemptId) return refusal("send_claim_invalid")
  const callerItemKey = String(input.callerItemKey ?? "").trim()
  const { data, failed } = await callRpc(client, "extend_outbound_send_claim", {
    p_attempt_id: input.attemptId,
    p_keys: keys,
    p_caller_item_key: callerItemKey || null,
    p_actor: input.actor ?? null,
    p_detail: input.detail ?? {},
  })
  const row = data as Record<string, unknown> | null
  if (failed || !row || typeof row !== "object") return refusal("send_claim_unavailable")
  if (row.ok === true) return claimFromRow(row, input.attemptId, keys)
  const code = row.code
  if (code === "send_claim_held") return refusal("send_claim_held", asHolds(row.held))
  if (
    code === "send_claim_not_sending" || code === "send_claim_invalid" ||
    code === "send_claim_dispatch_taken" || code === "send_claim_item_mismatch"
  ) return refusal(code)
  return refusal("send_claim_unavailable")
}

/**
 * The pre-send fence: call immediately before the provider call with the
 * current dispatch token. Anything but ok (a reconciled, settled or lapsed
 * attempt, a replaced token, a store that cannot answer) is
 * send_dispatch_fenced, and nothing may be sent.
 */
export async function confirmSendDispatch(
  client: ClaimClient,
  input: { attemptId: string; dispatchToken: string },
): Promise<DispatchConfirmResult> {
  const token = String(input.dispatchToken ?? "").trim()
  if (!input.attemptId || !token) return refusal("send_dispatch_fenced")
  const { data, failed } = await callRpc(client, "confirm_outbound_dispatch", {
    p_attempt_id: input.attemptId,
    p_dispatch_token: token,
  })
  const row = data as Record<string, unknown> | null
  if (!failed && row && typeof row === "object" && row.ok === true) return { ok: true }
  return refusal("send_dispatch_fenced")
}

/**
 * Settle an attempt out of sending, once. A failed write leaves the hold in
 * place. With { settler: "caller" } a settle while the door's extended
 * dispatch is open is deferred: { ok: true, deferred: true, state: "sending" }.
 * Once the current dispatch is confirmed, only the holder of its token
 * (dispatchToken) may settle; anyone else is send_settle_not_dispatcher and the
 * attempt stays sending, so a request whose own dispatch was fenced or taken
 * over can never release an item under another request's provider call.
 */
export async function settleSend(
  client: ClaimClient,
  attemptId: string,
  state: SettleState,
  detail: Record<string, unknown> = {},
  opts: { settler?: SendSettler; dispatchToken?: string | null } = {},
): Promise<SettleResult> {
  const { data, failed } = await callRpc(client, "settle_outbound_send", {
    p_attempt_id: attemptId,
    p_state: state,
    p_detail: detail,
    p_settler: opts.settler ?? "dispatcher",
    p_dispatch_token: opts.dispatchToken ?? null,
  })
  const row = data as Record<string, unknown> | null
  if (failed || !row || typeof row !== "object") return { ok: false, code: "send_settle_failed" }
  if (row.ok === true) return row.deferred === true ? { ok: true, deferred: true, state: "sending" } : { ok: true }
  if (
    row.code === "send_claim_not_sending" || row.code === "send_settle_invalid_state" ||
    row.code === "send_settle_invalid_settler" || row.code === "send_settle_not_dispatcher"
  ) return { ok: false, code: row.code }
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

/**
 * Record the result of a check on every attempt holding keys, without claiming
 * a new send: `sent` when the earlier send was found, `not_sent` when it was
 * not. The same rules as reconcileThenClaim: a named checker, never a live
 * send, compare-and-set on the state each attempt was read in.
 */
export async function reconcileHeld(
  client: ClaimClient,
  input: {
    keys: string[]
    result: "sent" | "not_sent"
    actor: string | null
    checkedAt?: string | null
    evidence?: string | null
    expectedAttemptId?: string | null
  },
): Promise<{ ok: true; reconciled: string[] } | SendClaimRefusal> {
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
      p_result: input.result,
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
  return { ok: true, reconciled: [...attempts.keys()] }
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
export const SEND_FENCED_MESSAGE =
  "This send was stopped before it went out, because its hold was released or ran out. Nothing was sent now."
export const SEND_FENCED_RECOVERY =
  "Check the item's current state before pressing again."
export const SEND_ITEM_MISMATCH_MESSAGE =
  "This send did not match the item it was claimed for, so nothing was sent."
export const SEND_ITEM_MISMATCH_RECOVERY = "Nothing was sent. Start the send again from the item."

/** The one refusal body every door returns when a claim is refused. */
export function sendClaimRefusalBody(result: SendClaimRefusal): Record<string, unknown> {
  const live = result.code === "send_reconcile_live_send" || result.code === "send_claim_dispatch_taken" ||
    (result.code === "send_claim_held" && result.held.some((h) => h.state === "sending" && !h.stale))
  const unavailable = result.code === "send_claim_unavailable" || result.code === "send_claim_unreadable"
  const held = result.held.map((h) => ({
    attempt_id: h.attempt_id,
    item_key: h.item_key,
    state: h.state === "sending" && h.stale ? "outcome_unknown" : h.state,
    claimed_at: h.claimed_at,
  }))
  const [state, error, recovery] = live
    ? ["sending", SEND_IN_PROGRESS_MESSAGE, SEND_IN_PROGRESS_RECOVERY]
    : unavailable
    ? ["not_sent", SEND_CLAIM_UNAVAILABLE_MESSAGE, SEND_CLAIM_UNAVAILABLE_RECOVERY]
    : result.code === "send_dispatch_fenced"
    ? ["not_sent", SEND_FENCED_MESSAGE, SEND_FENCED_RECOVERY]
    : result.code === "send_claim_item_mismatch"
    ? ["not_sent", SEND_ITEM_MISMATCH_MESSAGE, SEND_ITEM_MISMATCH_RECOVERY]
    : ["outcome_unknown", SEND_UNCERTAIN_MESSAGE, SEND_UNCERTAIN_RECOVERY]
  return {
    success: false,
    code: result.code,
    state,
    error,
    recovery_action: recovery,
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

export type EmailContentAttachment = { sha256: string; name?: string | null; contentType?: string | null }

function attachmentList(input: { attachments?: EmailContentAttachment[]; attachmentHashes?: string[] }) {
  const listed = (input.attachments ?? []).map((a) => ({
    sha256: String(a?.sha256 ?? "").trim().toLowerCase(),
    name: a?.name == null ? null : String(a.name).trim(),
    content_type: a?.contentType == null ? null : String(a.contentType).trim().toLowerCase(),
  }))
  // Older callers pass bare hashes: the file's name and type are unknown.
  const bare = (input.attachmentHashes ?? []).map((h) => ({
    sha256: String(h ?? "").trim().toLowerCase(),
    name: null,
    content_type: null,
  }))
  const text = (v: string | null) => v ?? ""
  return [...listed, ...bare].sort((a, b) =>
    a.sha256.localeCompare(b.sha256) || text(a.name).localeCompare(text(b.name)) ||
    text(a.content_type).localeCompare(text(b.content_type))
  )
}

/**
 * The key for one email's content: mailbox, mode, reply target, recipients
 * (to, cc and bcc, each lowercased and sorted), subject, body and attachments
 * (sha256, file name and content type; bare attachmentHashes count as name and
 * type unknown). Two requests that would deliver the same email share the
 * key, whichever door they come through, so both doors must describe
 * attachments the same way: the same bytes with and without a name are two
 * keys.
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
  attachments?: EmailContentAttachment[]
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
    attachments: attachmentList(input),
  })
  return `email_content:${await sha256Hex(canonical)}`
}

export async function bytesSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An id as it goes into a key: trimmed, and lowercased when UUID-shaped (Xero and Postgres ids). */
export function canonicalSendId(id: unknown): string {
  const text = String(id ?? "").trim()
  return UUID_SHAPE.test(text) ? text.toLowerCase() : text
}

/** invoice:<xero invoice id>: one invoice, whichever door emails it. */
export function invoiceSendKey(xeroInvoiceId: string): string {
  return `invoice:${canonicalSendId(xeroInvoiceId)}`
}

/** approved_send:<payload hash or approval id>: one approved message. */
export function approvedSendKey(payloadHashOrApprovalId: string): string {
  return `approved_send:${canonicalSendId(payloadHashOrApprovalId)}`
}

/** makesafe_pack:<job id>:<main|photo>: one pack email of one make-safe job. */
export function makesafePackSendKey(jobId: string, packKind?: string | null): string {
  return `makesafe_pack:${canonicalSendId(jobId)}:${String(packKind ?? "").trim().toLowerCase() || "main"}`
}

/**
 * debt_report:<org>: the org's one debt report, manual and automatic alike.
 * Deliberately broad: an unresolved report holds every report of that org,
 * whoever it goes to, until it is checked.
 */
export function debtReportSendKey(orgId: string): string {
  return `debt_report:${canonicalSendId(orgId)}`
}

/**
 * debt_statement:<org>:<customer>: statements to one customer of one org,
 * across weeks (an unresolved statement last week holds this week's). The
 * older debt_statement:<customer> key, still built inline by the debt
 * workshop, overblocks: it has no org, so two orgs that share a customer id
 * hold each other. New callers use this one.
 */
export function debtStatementSendKey(orgId: string, companyId: string): string {
  return `debt_statement:${canonicalSendId(orgId)}:${canonicalSendId(companyId)}`
}
