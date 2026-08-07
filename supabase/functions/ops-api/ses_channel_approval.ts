// ════════════════════════════════════════════════════════════════════════════
// SES channel approval — a SECOND way to satisfy the identified-operator gate.
//
// WHAT THIS IS
// ------------
// `canRecordSesApproval` (ses_review_cockpit.ts) refuses every machine caller:
//
//   "Human approval requires an identified SES operator session; API keys and
//    automation keys cannot approve."
//
// That gate is correct and this module does not touch it. It builds a second
// way to genuinely satisfy it, so the Captain can approve from his phone.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT THE IDENTITY BINDING ACTUALLY TRUSTS  (read this before changing anything)
// ════════════════════════════════════════════════════════════════════════════
//
// "A message arrived in this chat" is NOT identity. A phone is a device;
// devices are lent, lost and cloned. So this path never trusts the channel on
// its own. An approval is accepted only when THREE independent things hold:
//
//   1. TRANSPORT  — the relay presents the privileged ops key (`x-api-key`).
//      This authenticates the RELAY, never the operator. Holding the ops key
//      grants NO approval authority: without (2) and (3) every call here
//      refuses, exactly as it does today.
//
//   2. POSSESSION — the message's sender identity fingerprints to an enrolled
//      binding in `SES_CHANNEL_APPROVAL_BINDINGS` (a Supabase Edge Function
//      secret, settable only by a project owner). The raw sender id is hashed
//      immediately and never stored or logged.
//
//   3. KNOWLEDGE  — the message carries a live RFC 6238 TOTP code from the
//      operator's own authenticator app. The seed is NOT stored anywhere: it is
//      derived on demand from `SES_CHANNEL_APPROVAL_ROOT_SECRET` plus the
//      binding, and the ONLY way to obtain it is `ses_channel_enrolment`, which
//      requires the caller's OWN identified Supabase session and a binding that
//      names THAT SAME user id. There is no role check: the binding secret is a
//      project-owner write, and that is what decides who may enrol. An operator
//      can only ever enrol themselves.
//
// (3) is the part that binds the act to HIM rather than to a channel: it can be
// produced only by someone who once held his Supabase session and loaded the
// resulting seed into an authenticator.
//
// ── WHAT SOMEONE HOLDING EACH THING COULD DO ────────────────────────────────
//
//   * The ops key alone .............. nothing new. Still refused at the gate.
//   * His phone / WhatsApp alone ..... nothing, UNLESS his authenticator app is
//                                      on that same phone — which it usually
//                                      IS. See the honest weakening below.
//   * His authenticator seed alone ... nothing; the message must also arrive
//                                      from the enrolled sender.
//   * Ops key + an enrolled sender id .. cannot approve on that alone, but may
//                                      guess codes with no limit and is
//                                      expected to succeed within hours. See
//                                      `SES_CHANNEL_APPROVAL_TOTP_ONLINE_GUESSING`.
//   * Ops key + enrolled sender + a live code ... can APPROVE INVOICE on any
//                                      card that is ALREADY approvable in the
//                                      cockpit. It can never approve a card the
//                                      cockpit would refuse: every downstream
//                                      guard runs unchanged.
//   * The root secret + a project-owner's binding write ... can mint codes for
//                                      any operator. This is the strongest
//                                      single point of failure on the path and
//                                      is equivalent to holding the Supabase
//                                      project itself.
//
// ── THIS IS WEAKER THAN A COCKPIT SESSION. NAMED, NOT HIDDEN. ───────────────
//
//   a. SAME-DEVICE COLLAPSE. If the authenticator app lives on the phone that
//      holds WhatsApp, (2) and (3) are one factor, not two, and an attacker
//      with the unlocked phone can approve. A cockpit press additionally needs
//      the Supabase account credential. Putting the authenticator on a second
//      device restores the separation; that is an operator choice this code
//      cannot enforce or detect.
//   b. RELAY-ASSERTED SENDER. We trust the relay's claim about who sent the
//      message. We do not verify it cryptographically — WhatsApp gives us no
//      way to. A compromised relay holds BOTH the ops key AND a known enrolled
//      sender id, so it cannot approve immediately — but nothing here limits
//      how often it may try a code, so it is expected to guess one within
//      hours. See `SES_CHANNEL_APPROVAL_TOTP_ONLINE_GUESSING`. It can also
//      mislabel which enrolled operator acted. The ops key ALONE is still not
//      enough, because an enrolled sender id is required as well.
//   c. NO SESSION REVOCATION UX. Revocation is removing the binding from the
//      function secret, not clicking "sign out".
//
// These are deliberate, accepted trade-offs, not oversights. If any of them
// stops being acceptable, remove the binding from the secret: the path then
// refuses everything and the cockpit is unaffected.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT THIS PATH CHANGES AND WHAT IT DOES NOT
// ════════════════════════════════════════════════════════════════════════════
//
// It changes WHO may approve. It never changes WHAT may be approved. The
// resolved operator is handed to the SAME `approveSesInvoiceRevisionAction` a
// cockpit press calls, so `evaluateSesMechanicalClean`, `canRecordSesApproval`,
// the cockpit control gate and the `record_ses_revision_approval_v1` allowlist
// all run unchanged. A card that is not approvable in the cockpit is not
// approvable by message.
//
// Everything ambiguous refuses. An unbound sender, a stale message, a missing
// or reused code, a message naming zero or two cards, a message whose command
// word is not exactly one recognised act — all refuse. Silence is safer than a
// wrong approval on real money.
//
// AUDIT + IDEMPOTENCE: the operator act is his message id. It is recorded as an
// `evidence_refs` entry on the approval row itself (`sesChannelOperatorActRef`)
// and re-read before every approval, so the same message can never approve
// twice and a later reader can always answer "who approved this, and by which
// message". See `SES_CHANNEL_APPROVAL_REPLAY_RACE` and
// `SES_CHANNEL_APPROVAL_TOTP_ONLINE_GUESSING` for the two residual gaps.
//
// No migration: the binding lives in a function secret, the seed is derived
// rather than stored, and the act ledger is the existing append-only
// `makesafe_revision_approvals.evidence_refs` column.
// ════════════════════════════════════════════════════════════════════════════

import {
  type SesActionAuth,
  SesActionError,
  type SesSupabaseClient,
} from "./ses_reporting_actions.ts";
import type { SesRefusal } from "./ses_reporting_refusals.ts";

export const SES_CHANNEL_APPROVAL_CONTRACT_VERSION = "ses-channel-approval/v1";

/** Channels a relay may present. Closed: an unknown channel refuses. */
export const SES_CHANNEL_APPROVAL_CHANNELS = ["whatsapp", "sms"] as const;
export type SesChannelApprovalChannel =
  typeof SES_CHANNEL_APPROVAL_CHANNELS[number];

/**
 * A message older (or further in the future) than this refuses. A leaked
 * historic message must not become an approval when it is replayed weeks later,
 * and the TOTP window alone is not a durable answer because the relay supplies
 * the timestamp we compare against.
 */
export const SES_CHANNEL_APPROVAL_MAX_MESSAGE_AGE_MS = 15 * 60_000;

/** RFC 6238 defaults — what every authenticator app assumes. */
export const SES_CHANNEL_TOTP_STEP_SECONDS = 30;
export const SES_CHANNEL_TOTP_DIGITS = 6;
/**
 * Accept the current step plus one either side (~90s of clock skew). Wider
 * windows buy convenience with replay surface; one step is the standard floor.
 */
export const SES_CHANNEL_TOTP_WINDOW_STEPS = 1;

/**
 * Recognised command words. `approve` records the invoice approval; `send`
 * (SEND IT — Harden SES ticket 07) binds the Captain's word to the card's one
 * prepared release revision and drives the existing deterministic release
 * path. Binding and refusal rules for `send` live in ses_channel_send_it.ts.
 */
export const SES_CHANNEL_APPROVAL_ACTS = {
  approve: "approve_invoice",
  send: "send_it",
} as const;
export type SesChannelApprovalAct =
  typeof SES_CHANNEL_APPROVAL_ACTS[keyof typeof SES_CHANNEL_APPROVAL_ACTS];

/** Acts this contract version will actually execute. */
export const SES_CHANNEL_APPROVAL_ENABLED_ACTS:
  readonly SesChannelApprovalAct[] = ["approve_invoice", "send_it"];

/**
 * KNOWN RESIDUAL GAP, stated rather than papered over. The replay guard is a
 * read-then-write over `evidence_refs`, not a database uniqueness constraint,
 * so two byte-identical messages delivered concurrently could both pass it. The
 * blast radius is bounded to a duplicate APPROVAL ROW, never duplicate money:
 * `execute_ses_invoice_revision` and every release send are exact-once through
 * `ses_external_effects`. Closing it properly needs a uniquely-indexed message
 * ledger, which is a migration, which this slice deliberately does not take.
 */
export const SES_CHANNEL_APPROVAL_REPLAY_RACE =
  "read-then-write over evidence_refs; duplicate approval row possible under exact concurrency, duplicate money is not";

/**
 * KNOWN RESIDUAL GAP, stated rather than papered over. TOTP verification here
 * has NO attempt limiting, no lockout and no per-sender failure state, and
 * nothing at all is recorded on a failed verify. The ±1 step window makes 3 of
 * 10^6 codes valid per attempt, so a caller who can keep trying is expected to
 * reach a hit within hours at a sustained request rate. Reaching that surface
 * requires BOTH the ops key AND a sender id that fingerprints to an enrolled
 * binding — which is exactly what a compromised relay holds. The ops key alone
 * is still not enough.
 *
 * NARROWING THE WINDOW FROM ±1 TO ±0 IS NOT THE FIX. It is a 3x reduction on a
 * search a patient attacker completes anyway, and it costs the clock-skew
 * tolerance the ±1 window exists for. The real fix is durable per-binding
 * failed-attempt state (count, lockout, alarm), which is a new table, which is
 * a migration, which this slice deliberately does not take.
 */
export const SES_CHANNEL_APPROVAL_TOTP_ONLINE_GUESSING =
  "no attempt limit, lockout or per-binding failure state on TOTP verify; a holder of the ops key plus an enrolled sender id can guess a live code online within hours";

export interface SesChannelOperatorBinding {
  channel: SesChannelApprovalChannel;
  /** sha256 of the normalised sender id. The raw number never lands anywhere. */
  sender_fingerprint: string;
  operator_user_id: string;
  /** Non-identifying label for audit output, e.g. "captain". Never a name. */
  label: string;
}

export interface SesChannelApprovalMessageIntent {
  act: SesChannelApprovalAct | null;
  /** More than one recognised command word: refuse rather than guess. */
  act_ambiguous: boolean;
  /** Distinct, uppercased card coordinates found in the message. */
  card_references: string[];
  totp_code: string | null;
  /** More than one candidate code: refuse rather than try each. */
  totp_ambiguous: boolean;
}

export interface SesChannelOperatorAct {
  kind: "ses_channel_operator_act";
  contract: string;
  channel: SesChannelApprovalChannel;
  /** The Captain's own message id. This IS the operator act. */
  message_id: string;
  sender_fingerprint: string;
  operator_user_id: string;
  operator_label: string;
  act: SesChannelApprovalAct;
  card_reference: string;
  /** Consumed TOTP step — a second, independent single-use coordinate. */
  totp_time_step: number;
  message_sent_at: string;
}

function refusal(
  code: string,
  fact: string,
  recovery_action: string,
  evidence?: Record<string, unknown>,
): SesRefusal {
  return {
    state: "refused",
    code,
    fact,
    recovery_action,
    ...(evidence ? { evidence } : {}),
  };
}

function refuse(
  status: number,
  code: string,
  fact: string,
  recovery_action: string,
  evidence?: Record<string, unknown>,
): never {
  throw new SesActionError(
    status,
    refusal(code, fact, recovery_action, evidence),
  );
}

// ── sender fingerprinting ───────────────────────────────────────────────────

/**
 * Normalise a sender id before hashing so the same human always fingerprints
 * to one value. Phone-shaped senders normalise the way `ghl-webhook-receiver`
 * already normalises them (digits only, leading 0 -> 61); anything else is
 * lowercased and trimmed. Normalisation is deliberately narrow: two DIFFERENT
 * senders must never normalise together.
 */
export function normaliseSesChannelSenderId(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const digits = value.replace(/[^\d]/g, "");
  // Treat as a phone number only when the input is phone-shaped end to end
  // (optional +, then digits/spaces/dashes/parens). An email or a WhatsApp
  // handle containing digits must not be silently read as a number.
  if (/^\+?[\d\s().-]+$/.test(value) && digits.length >= 8) {
    return digits.replace(/^0/, "61");
  }
  return value.toLowerCase();
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Domain-separated fingerprint of a channel sender. This is the ONLY form of a
 * sender id that is ever compared, stored, returned or logged — no phone number
 * reaches the binding secret, the approval row, or a refusal payload.
 */
export async function sesChannelSenderFingerprint(
  channel: string,
  senderId: unknown,
): Promise<string> {
  const normalised = normaliseSesChannelSenderId(senderId);
  if (!normalised) return "";
  return await sha256Hex(
    `SecureWorks:ses-channel-sender:v1\n${
      String(channel).toLowerCase()
    }\n${normalised}`,
  );
}

// ── binding resolution ──────────────────────────────────────────────────────

function isSupportedChannel(
  value: unknown,
): value is SesChannelApprovalChannel {
  return (SES_CHANNEL_APPROVAL_CHANNELS as readonly string[]).includes(
    String(value ?? "").toLowerCase(),
  );
}

/**
 * Parse `SES_CHANNEL_APPROVAL_BINDINGS`. Malformed JSON, a malformed entry, or
 * an entry naming an unsupported channel yields NO bindings for that entry
 * rather than a partially trusted list — a binding you cannot fully read is a
 * binding you must not honour.
 */
export function parseSesChannelOperatorBindings(
  raw: unknown,
): SesChannelOperatorBinding[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const bindings: SesChannelOperatorBinding[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const channel = String(row.channel ?? "").toLowerCase();
    const fingerprint = String(row.sender_fingerprint ?? "").toLowerCase()
      .trim();
    const userId = String(row.operator_user_id ?? "").trim();
    const label = String(row.label ?? "").trim();
    if (!isSupportedChannel(channel)) continue;
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) continue;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(userId)
    ) continue;
    if (!label) continue;
    bindings.push({
      channel,
      sender_fingerprint: fingerprint,
      operator_user_id: userId,
      label,
    });
  }
  return bindings;
}

/**
 * Exactly one binding must match. Two bindings on one (channel, sender) is a
 * configuration contradiction about who a sender is, so it resolves to nothing.
 */
export function resolveSesChannelOperatorBinding(
  bindings: readonly SesChannelOperatorBinding[],
  channel: string,
  senderFingerprint: string,
): SesChannelOperatorBinding | null {
  const wantChannel = String(channel).toLowerCase();
  const wantFingerprint = String(senderFingerprint).toLowerCase();
  if (!wantFingerprint) return null;
  const matches = bindings.filter((binding) =>
    binding.channel === wantChannel &&
    binding.sender_fingerprint === wantFingerprint
  );
  return matches.length === 1 ? matches[0]! : null;
}

// ── TOTP (RFC 6238 / RFC 4226, HMAC-SHA1, what authenticator apps expect) ────

/**
 * Derive the operator's TOTP seed from the root secret and the binding. Nothing
 * per-operator is stored: rotate the root secret and every seed rotates. The
 * binding is folded in whole, so re-pointing a sender at a different operator
 * invalidates the old seed rather than transferring it.
 */
export async function deriveSesChannelTotpSecret(
  rootSecret: string,
  binding: SesChannelOperatorBinding,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(rootSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(
    `SecureWorks:ses-channel-totp:v1\n${binding.channel}\n${binding.operator_user_id}\n${binding.sender_fingerprint}`,
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  // 20 bytes: the HMAC-SHA1 block key size every authenticator app assumes.
  return mac.slice(0, 20);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Unpadded RFC 4648 base32 — the encoding otpauth:// secrets use. */
export function sesChannelBase32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function sesChannelTotpTimeStep(atMs: number): number {
  return Math.floor(atMs / 1000 / SES_CHANNEL_TOTP_STEP_SECONDS);
}

export async function sesChannelTotpCode(
  secret: Uint8Array,
  timeStep: number,
): Promise<string> {
  const counter = new Uint8Array(8);
  let remaining = timeStep;
  for (let index = 7; index >= 0; index--) {
    counter[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  // Copy into a plain ArrayBuffer: a Uint8Array view may be backed by a
  // SharedArrayBuffer, which Web Crypto's key import does not accept.
  const keyBytes = new ArrayBuffer(secret.byteLength);
  new Uint8Array(keyBytes).set(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** SES_CHANNEL_TOTP_DIGITS).padStart(
    SES_CHANNEL_TOTP_DIGITS,
    "0",
  );
}

/** Constant-time-ish comparison; both sides are fixed-width digit strings. */
function codesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * Verify a submitted code and return the STEP it matched. The step is the
 * single-use coordinate recorded on the approval, so the same code can never be
 * spent twice even inside its own validity window.
 */
export async function verifySesChannelTotp(
  secret: Uint8Array,
  code: string,
  atMs: number,
  windowSteps = SES_CHANNEL_TOTP_WINDOW_STEPS,
): Promise<{ time_step: number } | null> {
  const candidate = String(code ?? "").trim();
  if (!new RegExp(`^\\d{${SES_CHANNEL_TOTP_DIGITS}}$`).test(candidate)) {
    return null;
  }
  const current = sesChannelTotpTimeStep(atMs);
  for (let drift = -windowSteps; drift <= windowSteps; drift++) {
    const step = current + drift;
    if (codesEqual(await sesChannelTotpCode(secret, step), candidate)) {
      return { time_step: step };
    }
  }
  return null;
}

/**
 * `otpauth://` URI for an authenticator app. The label is the binding's
 * non-identifying label, never a name, number or email.
 */
export function sesChannelTotpEnrolmentUri(
  secretBase32: string,
  binding: SesChannelOperatorBinding,
): string {
  const account = `${binding.label}-${binding.channel}`;
  return `otpauth://totp/SecureWorks%20SES:${encodeURIComponent(account)}` +
    `?secret=${secretBase32}&issuer=SecureWorks%20SES` +
    `&algorithm=SHA1&digits=${SES_CHANNEL_TOTP_DIGITS}` +
    `&period=${SES_CHANNEL_TOTP_STEP_SECONDS}`;
}

// ── message parsing ─────────────────────────────────────────────────────────

const CARD_REFERENCE_RE = /\b(SWMS-\d{3,}|INV-\d{2,})\b/gi;
const COMMAND_WORD_RE = /\b(approve|approved|send|sendit)\b/gi;
const CODE_RE = /(?<!\d)\d{6}(?!\d)/g;

/**
 * Read a message into an intent. Deliberately strict and literal:
 *
 *  - a command word must be present as a whole word. Conversational assent
 *    ("cool, they're both approved then") is NOT excluded by the verb — it is
 *    excluded by naming two cards and carrying no code, which is the point:
 *    three independent guards each refuse it.
 *  - card references are matched on their own token boundary and de-duplicated.
 *  - card references are REMOVED before scanning for a code, because
 *    `SWMS-261081` ends in six digits and would otherwise read as one.
 */
export function parseSesChannelApprovalMessage(
  text: unknown,
): SesChannelApprovalMessageIntent {
  const body = String(text ?? "");

  const cards = new Set<string>();
  for (const match of body.matchAll(CARD_REFERENCE_RE)) {
    cards.add(match[1]!.toUpperCase());
  }

  const acts = new Set<SesChannelApprovalAct>();
  for (const match of body.matchAll(COMMAND_WORD_RE)) {
    const word = match[1]!.toLowerCase();
    if (word === "approve" || word === "approved") {
      acts.add(SES_CHANNEL_APPROVAL_ACTS.approve);
    } else {
      acts.add(SES_CHANNEL_APPROVAL_ACTS.send);
    }
  }

  const withoutCards = body.replace(CARD_REFERENCE_RE, " ");
  const codes = new Set<string>();
  for (const match of withoutCards.matchAll(CODE_RE)) codes.add(match[0]);

  const actList = [...acts];
  return {
    act: actList.length === 1 ? actList[0]! : null,
    act_ambiguous: actList.length > 1,
    card_references: [...cards].sort(),
    totp_code: codes.size === 1 ? [...codes][0]! : null,
    totp_ambiguous: codes.size > 1,
  };
}

// ── operator act (audit + idempotence coordinate) ───────────────────────────

/**
 * The durable record of the operator act. Written into the approval row's
 * `evidence_refs` and re-read as the replay guard, so "approved via WhatsApp"
 * is never recorded without the message id that carried it.
 */
export function sesChannelOperatorActRef(
  input: Omit<SesChannelOperatorAct, "kind" | "contract">,
): SesChannelOperatorAct {
  return {
    kind: "ses_channel_operator_act",
    contract: SES_CHANNEL_APPROVAL_CONTRACT_VERSION,
    ...input,
  };
}

/** Minimal containment probe for "has this exact message already acted?". */
export function sesChannelMessageProbe(
  channel: SesChannelApprovalChannel,
  messageId: string,
): Record<string, unknown> {
  return {
    kind: "ses_channel_operator_act",
    contract: SES_CHANNEL_APPROVAL_CONTRACT_VERSION,
    channel,
    message_id: messageId,
  };
}

/** Minimal containment probe for "has this exact code step already been spent?". */
export function sesChannelCodeProbe(
  operatorUserId: string,
  timeStep: number,
): Record<string, unknown> {
  return {
    kind: "ses_channel_operator_act",
    contract: SES_CHANNEL_APPROVAL_CONTRACT_VERSION,
    operator_user_id: operatorUserId,
    totp_time_step: timeStep,
  };
}

// ── the identity assertion boundary ─────────────────────────────────────────

/**
 * THE ONE PLACE a channel message becomes an identified operator.
 *
 * `mode: "jwt"` is not a claim that a Supabase JWT was verified — no JWT
 * exists on this path. It is this module asserting, on the evidence of the
 * enrolled sender plus a live authenticator code, that the human behind
 * `operator_user_id` acted. `identity_provenance` records which of the two
 * proofs was actually presented so an auditor never has to guess. Exactly one
 * refusal reads it — the `ses_channel_enrolment` gate — and it reads it
 * strictly to FAIL CLOSED, so a channel-derived identity can never bootstrap
 * itself a seed. Nothing widens on it: no authorisation decision anywhere is
 * made more permissive by its presence.
 *
 * The user row is loaded from the database, never from the request, so a relay
 * can never supply a role. If the bound user has no row, or is not an
 * admin/owner and not on `ses_release_operators`, the shared gate refuses —
 * this function grants nothing on its own.
 */
export function sesChannelOperatorAuth(
  user: { id: string; email: string; role: string },
): SesActionAuth {
  return {
    mode: "jwt",
    user,
    identity_provenance: "bound_channel_totp",
  };
}

// ── actions ─────────────────────────────────────────────────────────────────

export interface SesChannelApprovalEnv {
  bindings_raw: string | null;
  root_secret: string | null;
}

export function readSesChannelApprovalEnv(): SesChannelApprovalEnv {
  return {
    bindings_raw: Deno.env.get("SES_CHANNEL_APPROVAL_BINDINGS") ?? null,
    root_secret: Deno.env.get("SES_CHANNEL_APPROVAL_ROOT_SECRET") ?? null,
  };
}

async function loadBoundOperatorUser(
  client: SesSupabaseClient,
  binding: SesChannelOperatorBinding,
): Promise<{ id: string; email: string; role: string }> {
  const response = await client.from("users")
    .select("id,email,role")
    .eq("id", binding.operator_user_id)
    .maybeSingle();
  if (response.error) {
    refuse(
      503,
      "channel_operator_unreadable",
      "The bound operator's account could not be read, so the message cannot be attributed to a person.",
      "Retry once the users table is readable; never approve an unattributed message.",
    );
  }
  if (!response.data) {
    refuse(
      403,
      "channel_operator_unresolved",
      "The enrolled binding names an account that does not exist, so no operator identity can be established.",
      "Correct SES_CHANNEL_APPROVAL_BINDINGS to name a live operator account, or remove the binding.",
    );
  }
  return {
    id: String(response.data.id),
    email: String(response.data.email || ""),
    role: String(response.data.role || "unknown"),
  };
}

/**
 * Resolve exactly one card. A job number resolves against `jobs.job_number`; an
 * invoice number resolves against `xero_invoices.invoice_number` and must carry
 * a `job_id`. Zero matches or more than one matching row both refuse: an
 * approval names its card or it approves nothing.
 */
async function resolveSesChannelCard(
  client: SesSupabaseClient,
  reference: string,
): Promise<{ job_id: string; job_number: string }> {
  if (reference.startsWith("SWMS-")) {
    const response = await client.from("jobs")
      .select("id,job_number").eq("job_number", reference).limit(2);
    if (response.error) {
      refuse(
        503,
        "channel_card_unreadable",
        `The card named in the message could not be read (${
          response.error.message || "unknown database error"
        }).`,
        "Retry once the jobs table is readable.",
      );
    }
    const rows = response.data || [];
    if (rows.length !== 1) {
      refuse(
        409,
        "channel_card_not_found",
        rows.length === 0
          ? "The message names a card that does not exist."
          : "The message names a card reference that matches more than one job.",
        "Send the exact job number of one card, for example APPROVE SWMS-260000 123456.",
        { card_reference: reference, matches: rows.length },
      );
    }
    return {
      job_id: String(rows[0].id),
      job_number: String(rows[0].job_number),
    };
  }

  const response = await client.from("xero_invoices")
    .select("invoice_number,job_id").eq("invoice_number", reference).limit(2);
  if (response.error) {
    refuse(
      503,
      "channel_card_unreadable",
      `The invoice named in the message could not be read (${
        response.error.message || "unknown database error"
      }).`,
      "Retry once the invoice mirror is readable.",
    );
  }
  const rows = (response.data || []).filter((row: Record<string, unknown>) =>
    !!row.job_id
  );
  if (rows.length !== 1) {
    refuse(
      409,
      "channel_card_not_found",
      rows.length === 0
        ? "The message names an invoice that does not exist or is not linked to a card."
        : "The message names an invoice number that matches more than one card.",
      "Send the job number instead, for example APPROVE SWMS-260000 123456.",
      { card_reference: reference, matches: rows.length },
    );
  }
  const jobId = String(rows[0].job_id);
  const job = await client.from("jobs").select("job_number").eq("id", jobId)
    .maybeSingle();
  if (job.error) {
    refuse(
      503,
      "channel_card_unreadable",
      `The card behind the invoice named in the message could not be read (${
        job.error.message || "unknown database error"
      }).`,
      "Retry once the jobs table is readable.",
    );
  }
  return { job_id: jobId, job_number: String(job.data?.job_number || "") };
}

async function assertNotAlreadyActed(
  client: SesSupabaseClient,
  probe: Record<string, unknown>,
  code: string,
  fact: string,
  recovery: string,
): Promise<void> {
  const response = await client.from("makesafe_revision_approvals")
    .select("id,job_id,decided_at")
    .contains("evidence_refs", [probe])
    .limit(1);
  if (response.error) {
    refuse(
      503,
      "channel_replay_guard_unreadable",
      `The channel approval history could not be read (${
        response.error.message || "unknown database error"
      }), so a repeat cannot be ruled out.`,
      "Retry once the approval ledger is readable; an unprovable repeat is never approved.",
    );
  }
  if ((response.data || []).length > 0) {
    refuse(409, code, fact, recovery, {
      prior_approval_id: String(response.data[0].id),
      prior_decided_at: String(response.data[0].decided_at || ""),
    });
  }
}

export interface SesChannelApprovalRequest {
  org_id: string;
  channel: unknown;
  sender_id: unknown;
  message_id: unknown;
  message_text: unknown;
  message_sent_at: unknown;
}

export interface SesChannelApprovalDeps {
  env: SesChannelApprovalEnv;
  now: () => number;
  approveInvoice: (
    auth: SesActionAuth,
    args: {
      org_id: string;
      job_id: string;
      includes_authorise: boolean;
      evidence_refs: unknown[];
    },
  ) => Promise<unknown>;
  /**
   * SEND IT (Harden SES ticket 07): bind the word to the card's one prepared
   * release revision and drive the existing deterministic release path
   * (ses_channel_send_it.ts). Same guards as a cockpit press.
   */
  executeSendIt: (
    auth: SesActionAuth,
    args: {
      org_id: string;
      job_id: string;
      actor: string;
      evidence_refs: unknown[];
    },
  ) => Promise<unknown>;
}

/**
 * Accept one inbound approval message. Every step below fails closed; nothing
 * here can make a card approvable that the cockpit would refuse.
 */
export async function submitSesChannelApprovalAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  request: SesChannelApprovalRequest,
  deps: SesChannelApprovalDeps,
) {
  // 1. TRANSPORT. The relay must present the privileged ops key. A user session
  //    belongs in the cockpit, and the automation routine may never approve.
  if (auth.mode !== "api_key") {
    refuse(
      403,
      "channel_transport_not_privileged",
      "Inbound channel approvals are accepted only from the privileged relay key.",
      "Approve in the cockpit with your own session, or route the message through the relay.",
    );
  }

  // 2. CONFIGURATION. Unconfigured means the path is off, not permissive.
  const bindings = parseSesChannelOperatorBindings(deps.env.bindings_raw);
  const rootSecret = String(deps.env.root_secret || "");
  if (bindings.length === 0 || !rootSecret) {
    refuse(
      503,
      "channel_binding_not_configured",
      "No channel operator binding is enrolled, so no message can carry an operator identity.",
      "Enrol the operator binding and root secret as Edge Function secrets, then re-send.",
    );
  }

  const channel = String(request.channel ?? "").toLowerCase();
  if (!isSupportedChannel(channel)) {
    refuse(
      400,
      "channel_unsupported",
      "The message names a channel this path does not accept.",
      `Use one of: ${SES_CHANNEL_APPROVAL_CHANNELS.join(", ")}.`,
    );
  }

  const messageId = String(request.message_id ?? "").trim();
  if (!messageId) {
    refuse(
      400,
      "channel_message_id_missing",
      "The message carries no provider message id, so the operator act could not be recorded or de-duplicated.",
      "Relay the provider's message id with every approval message.",
    );
  }

  // 3. POSSESSION. Fingerprint first: the raw sender id must not survive.
  const senderFingerprint = await sesChannelSenderFingerprint(
    channel,
    request.sender_id,
  );
  const binding = resolveSesChannelOperatorBinding(
    bindings,
    channel,
    senderFingerprint,
  );
  if (!binding) {
    refuse(
      403,
      "channel_sender_not_bound",
      "The message did not come from an enrolled operator identity on this channel.",
      "Enrol this sender before approving from it, or approve in the cockpit.",
    );
  }

  // 4. FRESHNESS. A leaked historic message must not approve later.
  const sentAtMs = Date.parse(String(request.message_sent_at ?? ""));
  const nowMs = deps.now();
  if (!Number.isFinite(sentAtMs)) {
    refuse(
      400,
      "channel_message_timestamp_missing",
      "The message carries no readable send time, so its freshness cannot be proven.",
      "Relay the provider's message timestamp with every approval message.",
    );
  }
  if (Math.abs(nowMs - sentAtMs) > SES_CHANNEL_APPROVAL_MAX_MESSAGE_AGE_MS) {
    refuse(
      409,
      "channel_message_stale",
      "The message is outside the accepted freshness window, so it is not treated as a live instruction.",
      "Send a fresh approval message with a current code.",
      { max_age_ms: SES_CHANNEL_APPROVAL_MAX_MESSAGE_AGE_MS },
    );
  }

  // 5. INTENT + SCOPE. One recognised act, exactly one card.
  const intent = parseSesChannelApprovalMessage(request.message_text);
  if (intent.act_ambiguous) {
    refuse(
      409,
      "channel_act_ambiguous",
      "The message names more than one command, so which act was intended cannot be established.",
      "Send one command per message, for example APPROVE SWMS-260000 123456.",
    );
  }
  if (!intent.act) {
    refuse(
      409,
      "channel_act_not_recognised",
      "The message carries no recognised command word, so it is conversation rather than an instruction.",
      "Send APPROVE, the job number, and your current code.",
    );
  }
  if (!SES_CHANNEL_APPROVAL_ENABLED_ACTS.includes(intent.act)) {
    refuse(
      409,
      "channel_act_not_enabled",
      `The ${intent.act} act is recognised but is not wired on this contract version, so nothing was done.`,
      "Use the cockpit for this act; only APPROVE INVOICE is available by message today.",
      { act: intent.act, enabled: [...SES_CHANNEL_APPROVAL_ENABLED_ACTS] },
    );
  }
  if (intent.card_references.length !== 1) {
    refuse(
      409,
      intent.card_references.length === 0
        ? "channel_card_reference_missing"
        : "channel_card_reference_ambiguous",
      intent.card_references.length === 0
        ? "The message names no card, so there is nothing it could approve."
        : "The message names more than one card, so which one was approved cannot be established.",
      "Send one card per message, for example APPROVE SWMS-260000 123456.",
      { card_references: intent.card_references },
    );
  }

  // 6. KNOWLEDGE. A live code from the operator's own authenticator.
  if (intent.totp_ambiguous) {
    refuse(
      409,
      "channel_code_ambiguous",
      "The message contains more than one six-digit value, so the approval code cannot be identified.",
      "Send exactly one six-digit code in the message.",
    );
  }
  if (!intent.totp_code) {
    refuse(
      403,
      "channel_code_missing",
      "The message carries no approval code, so it proves possession of a phone and nothing about who sent it.",
      "Add your current six-digit code from your authenticator app.",
    );
  }
  const secret = await deriveSesChannelTotpSecret(rootSecret, binding);
  const verified = await verifySesChannelTotp(secret, intent.totp_code, nowMs);
  if (!verified) {
    refuse(
      403,
      "channel_code_invalid",
      "The approval code is not a live code for the enrolled operator, so the message is not proven to be theirs.",
      "Send a current code from your authenticator app.",
    );
  }

  // 7. REPLAY. The message id is the operator act; a spent code step is the
  //    second, independent single-use coordinate.
  await assertNotAlreadyActed(
    client,
    sesChannelMessageProbe(channel, messageId),
    "channel_message_already_recorded",
    "This exact message has already been recorded as an operator act, so it was not approved a second time.",
    "Send a new message if a further approval is genuinely intended.",
  );
  await assertNotAlreadyActed(
    client,
    sesChannelCodeProbe(binding.operator_user_id, verified.time_step),
    "channel_code_already_used",
    "This approval code has already been spent, so it cannot authorise a second act.",
    "Wait for your authenticator to roll to a new code, then re-send.",
  );

  // 8. IDENTITY. Server-owned user row; the relay never supplies a role.
  const operatorUser = await loadBoundOperatorUser(client, binding);
  const operatorAuth = sesChannelOperatorAuth(operatorUser);

  // 9. CARD. Resolved after identity so an unbound sender learns nothing about
  //    which cards exist.
  const card = await resolveSesChannelCard(client, intent.card_references[0]!);

  const operatorAct = sesChannelOperatorActRef({
    channel,
    message_id: messageId,
    sender_fingerprint: senderFingerprint,
    operator_user_id: binding.operator_user_id,
    operator_label: binding.label,
    act: intent.act,
    card_reference: intent.card_references[0]!,
    totp_time_step: verified.time_step,
    message_sent_at: new Date(sentAtMs).toISOString(),
  });

  // 10. THE SAME ACT AS A COCKPIT PRESS. Every downstream guard runs unchanged;
  //     a card the cockpit refuses is refused here too, with the same refusal.
  const outcome = intent.act === SES_CHANNEL_APPROVAL_ACTS.send
    ? {
      release: await deps.executeSendIt(operatorAuth, {
        org_id: request.org_id,
        job_id: card.job_id,
        actor: operatorUser.email || binding.label,
        evidence_refs: [operatorAct],
      }),
    }
    : {
      approval: await deps.approveInvoice(operatorAuth, {
        org_id: request.org_id,
        job_id: card.job_id,
        includes_authorise: false,
        evidence_refs: [operatorAct],
      }),
    };

  return {
    channel_approval: {
      contract: SES_CHANNEL_APPROVAL_CONTRACT_VERSION,
      act: intent.act,
      job_id: card.job_id,
      job_number: card.job_number,
      card_reference: intent.card_references[0]!,
      operator_act: operatorAct,
      identity_provenance: "bound_channel_totp",
    },
    ...outcome,
  };
}

/**
 * Enrolment: return the authenticator seed for the caller's OWN binding.
 *
 * This is the act that makes the binding his rather than the channel's, so it
 * is deliberately narrow: an identified Supabase session, and the caller's own
 * user id must be the one the binding names. An admin cannot read another
 * operator's seed, and the privileged ops key cannot read any seed at all —
 * otherwise the key would become approval authority by the back door.
 */
export function sesChannelEnrolmentAction(
  auth: SesActionAuth,
  env: SesChannelApprovalEnv,
): Promise<{
  enrolment: {
    contract: string;
    channel: SesChannelApprovalChannel;
    label: string;
    otpauth_uri: string;
    digits: number;
    period_seconds: number;
  }[];
}> {
  if (auth.mode !== "jwt" || !auth.user || auth.identity_provenance) {
    refuse(
      403,
      "channel_enrolment_requires_session",
      "Reading a channel approval seed requires your own identified Supabase session; keys, automation and channel-derived identities cannot read it.",
      "Sign in to the cockpit and request enrolment there.",
    );
  }
  const bindings = parseSesChannelOperatorBindings(env.bindings_raw);
  const rootSecret = String(env.root_secret || "");
  if (!rootSecret) {
    refuse(
      503,
      "channel_binding_not_configured",
      "No channel approval root secret is configured, so no seed can be derived.",
      "Set SES_CHANNEL_APPROVAL_ROOT_SECRET, then request enrolment again.",
    );
  }
  const mine = bindings.filter((binding) =>
    binding.operator_user_id === auth.user!.id
  );
  if (mine.length === 0) {
    refuse(
      404,
      "channel_binding_not_enrolled",
      "No channel binding names your account, so there is no seed to issue.",
      "Have a project owner enrol your sender fingerprint first.",
    );
  }
  return Promise.all(mine.map(async (binding) => {
    const secret = await deriveSesChannelTotpSecret(rootSecret, binding);
    return {
      contract: SES_CHANNEL_APPROVAL_CONTRACT_VERSION,
      channel: binding.channel,
      label: binding.label,
      otpauth_uri: sesChannelTotpEnrolmentUri(
        sesChannelBase32Encode(secret),
        binding,
      ),
      digits: SES_CHANNEL_TOTP_DIGITS,
      period_seconds: SES_CHANNEL_TOTP_STEP_SECONDS,
    };
  })).then((enrolment) => ({ enrolment }));
}
