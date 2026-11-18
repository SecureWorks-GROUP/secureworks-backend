// P2-03.7 (Follow-up 66): the Reconcile screen's presses reach the database
// with the verified signed-in person as the actor.
//
//   POST ?action=reconcile_decide
//     { item_id, shown_hash, action, parts?, note?, accepted_suggestion?,
//       job_ids?, cause?, escalate_to? }   (operator_email is ignored)
//     -> one switch on the item's kind: `message` -> RPC reconcile_decide_message
//        (P2-03.5); every other kind -> RPC reconcile_decide (P2-03.3,
//        20261118073318). Places a waiting cost line on a job, splits it across
//        jobs, or files it as not a job cost.
//   POST ?action=reconcile_undo  { decision_id }
//     -> RPC reconcile_undo (P2-03.4).
//
// Behind feature_flags.reconcile_decide_v1 (ships off; missing or unreadable
// is off). The person is reconDecisionUser(caller): only a verified staff
// session has one. A server key, the routine and an agent are refused 403
// before the switch or the body is read. No body field or header names the
// actor. Every message a caller can see is in RECONCILE_DECIDE_WORDS.
// Logs carry codes and ids only, never an amount or a document's words.

import { reconDecisionUser } from "./recon_decisions.ts";

export const RECONCILE_DECIDE_FLAG = "reconcile_decide_v1";

export class ReconcileDecideError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Every refusal the two doors give, its status and its words. */
export const RECONCILE_DECIDE_WORDS: Record<string, [number, string]> = {
  // The door.
  person_session_required: [
    403,
    "A decision is made by a signed-in staff member, not a server key.",
  ],
  operator_access_required: [
    403,
    "Only admin, owner or ops manager can decide a Reconcile item.",
  ],
  reconcile_decide_off: [
    409,
    "Deciding Reconcile items is not switched on yet.",
  ],
  reconcile_switch_unreadable: [
    503,
    "Could not check whether deciding is switched on. Nothing was changed. Try again in a minute.",
  ],
  invalid_request: [400, "That request is not one this door accepts."],
  reconcile_item_unreadable: [
    503,
    "Could not read this item. Nothing was changed. Try again in a minute.",
  ],
  reconcile_function_missing: [
    503,
    "This kind of decision is not available yet. Nothing was changed.",
  ],
  reconcile_failed: [
    500,
    "The decision was not recorded. Nothing was changed. Try again, or ask the office.",
  ],
  // The database (reconcile_decide, reconcile_decide_message, reconcile_undo).
  reconcile_not_staff: [
    403,
    "Only admin, owner or ops manager can decide a Reconcile item.",
  ],
  reconcile_item_unknown: [404, "That item was not found."],
  reconcile_evidence_changed: [
    409,
    "This changed while you were looking. The list has been read again, please choose again.",
  ],
  reconcile_item_closed: [409, "Someone already decided this one."],
  reconcile_parts_do_not_add_up: [409, "The parts do not add up to the line."],
  reconcile_job_not_live: [409, "That job is not live."],
  reconcile_not_latest: [409, "A newer decision exists, undo that one first."],
  reconcile_document_changed: [
    409,
    "The document changed in Xero since that decision.",
  ],
  reconcile_action_unknown: [409, "That is not a decision this list knows."],
  reconcile_action_not_for_item: [409, "That decision does not fit this item."],
  reconcile_not_a_duplicate_hold: [
    409,
    "Not a duplicate only answers an item held as a possible duplicate.",
  ],
  reconcile_note_required: [409, "Add a note to say how this was resolved."],
  reconcile_subject_unknown: [409, "The document behind this item was not found."],
  reconcile_no_counted_lines: [
    409,
    "This document has no lines that count, so there is nothing to place.",
  ],
  reconcile_parts_invalid: [409, "Choose where each part goes, then try again."],
  reconcile_division_unknown: [
    409,
    "Choose a division: patios, fencing or insurance.",
  ],
  reconcile_duplicate_needs_other: [
    409,
    "Name the other document this one duplicates.",
  ],
};

export function reconcileDecideRefusal(code: string): ReconcileDecideError {
  const hit = RECONCILE_DECIDE_WORDS[code] ?? RECONCILE_DECIDE_WORDS.reconcile_failed;
  return new ReconcileDecideError(
    RECONCILE_DECIDE_WORDS[code] ? code : "reconcile_failed",
    hit[0],
    hit[1],
  );
}

type Client = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
  from: (table: string) => any;
};

export type ReconcileCaller = {
  authMode: string;
  userId: string | null | undefined;
  /** Whether the session's role is on the ops staff set. */
  isStaff: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DECIDE_FIELDS = new Set([
  "item_id",
  "shown_hash",
  "action",
  "parts",
  "note",
  "accepted_suggestion",
  "job_ids",
  "cause",
  "escalate_to",
  "operator_email",
]);
const UNDO_FIELDS = new Set(["decision_id", "operator_email"]);

/** The actions the cost and plain cards accept (reconcile_decide). */
export const RECONCILE_DECIDE_ACTIONS = [
  "place",
  "split",
  "overhead",
  "division_stock",
  "duplicate",
  "not_duplicate",
  "leave",
  "resolve",
] as const;

function bad(): never {
  throw reconcileDecideRefusal("invalid_request");
}

/** The person, and only a staff person: checked before anything is read. */
export function reconcileDecideUser(caller: ReconcileCaller): string {
  let userId: string;
  try {
    userId = reconDecisionUser(caller);
  } catch {
    throw reconcileDecideRefusal("person_session_required");
  }
  if (!caller.isStaff) throw reconcileDecideRefusal("operator_access_required");
  return userId;
}

function fields(body: unknown, allowed: Set<string>): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) bad();
  for (const key of Object.keys(body as object)) {
    if (!allowed.has(key)) bad();
  }
  return body as Record<string, unknown>;
}

const optText = (v: unknown) =>
  v === undefined || v === null ? null : typeof v === "string" ? v : bad();

/** Pure. The checked arguments of a decide, before the item is read. */
export function reconcileDecideInput(body: unknown) {
  const b = fields(body, DECIDE_FIELDS);
  const itemId = typeof b.item_id === "string" && UUID.test(b.item_id)
    ? b.item_id
    : bad();
  const shownHash = typeof b.shown_hash === "string" && b.shown_hash.trim()
    ? b.shown_hash
    : bad();
  const action = typeof b.action === "string" && /^[a-z_]{1,40}$/.test(b.action)
    ? b.action
    : bad();
  const parts = b.parts === undefined || b.parts === null
    ? null
    : Array.isArray(b.parts) &&
        b.parts.every((p) => p && typeof p === "object" && !Array.isArray(p))
    ? b.parts
    : bad();
  const note = optText(b.note);
  const accepted = b.accepted_suggestion === undefined || b.accepted_suggestion === null
    ? false
    : typeof b.accepted_suggestion === "boolean"
    ? b.accepted_suggestion
    : bad();
  const jobIds = b.job_ids === undefined || b.job_ids === null
    ? null
    : Array.isArray(b.job_ids) &&
        b.job_ids.every((j) => typeof j === "string" && UUID.test(j))
    ? b.job_ids as string[]
    : bad();
  return {
    itemId,
    shownHash,
    action,
    parts,
    note,
    accepted,
    jobIds,
    cause: optText(b.cause),
    escalateTo: optText(b.escalate_to),
  };
}

/** Pure. The checked decision id of an undo. */
export function reconcileUndoInput(body: unknown): number {
  const b = fields(body, UNDO_FIELDS);
  const raw = b.decision_id;
  const id = typeof raw === "number" ? raw : typeof raw === "string" && /^[0-9]{1,18}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : bad();
}

/** Missing or unreadable is off. */
async function decideSwitchOn(client: Client): Promise<boolean> {
  let read: { data: unknown; error: unknown };
  try {
    // feature_flags_flag_name_key
    read = await client.from("feature_flags").select("enabled")
      .eq("flag_name", RECONCILE_DECIDE_FLAG);
  } catch {
    throw reconcileDecideRefusal("reconcile_switch_unreadable");
  }
  if (read.error || !Array.isArray(read.data)) {
    throw reconcileDecideRefusal("reconcile_switch_unreadable");
  }
  return (read.data as Array<{ enabled?: unknown }>)[0]?.enabled === true;
}

function databaseRefusal(where: string, error: unknown): ReconcileDecideError {
  const e = error as { message?: unknown; code?: unknown };
  const message = String(e?.message ?? "");
  const code = String(e?.code ?? "");
  // A function not installed yet (P2-03.4, P2-03.5): PostgREST PGRST202, or
  // Postgres 42883 undefined_function.
  if (code === "PGRST202" || code === "42883") {
    console.error(`[${where}] function missing`, code);
    return reconcileDecideRefusal("reconcile_function_missing");
  }
  const named = /\b(reconcile_[a-z_]+)\b/.exec(message)?.[1];
  if (named && RECONCILE_DECIDE_WORDS[named]) return reconcileDecideRefusal(named);
  console.error(`[${where}] failed`, code || "no_code");
  return reconcileDecideRefusal("reconcile_failed");
}

/** Keeps the job's stored profit fresh in the same request; never fails it. */
async function refreshMarkedProfit(client: Client): Promise<void> {
  try {
    const { error } = await client.rpc("job_profit_refresh_marked", { p_limit: 50 });
    if (error) console.error("[reconcile] profit refresh skipped", String((error as any)?.code ?? "no_code"));
  } catch {
    console.error("[reconcile] profit refresh skipped", "threw");
  }
}

/** One branch per item kind. Another phase adds a branch here (P3-03.4). */
async function decideByKind(
  client: Client,
  kind: string,
  input: ReturnType<typeof reconcileDecideInput>,
  userId: string,
): Promise<{ data: unknown; error: unknown; fn: string }> {
  switch (kind) {
    case "message": {
      const { data, error } = await client.rpc("reconcile_decide_message", {
        p_item_id: input.itemId,
        p_shown_hash: input.shownHash,
        p_action: input.action,
        p_job_ids: input.jobIds ?? [],
        p_cause: input.cause,
        p_escalate_to: input.escalateTo,
        p_user_id: userId,
      });
      return { data, error, fn: "reconcile_decide_message" };
    }
    default: {
      if (!(RECONCILE_DECIDE_ACTIONS as readonly string[]).includes(input.action)) {
        throw reconcileDecideRefusal("reconcile_action_unknown");
      }
      const { data, error } = await client.rpc("reconcile_decide", {
        p_item_id: input.itemId,
        p_shown_hash: input.shownHash,
        p_action: input.action,
        p_parts: input.parts,
        p_note: input.note,
        p_accepted_suggestion: input.accepted,
        p_user_id: userId,
      });
      return { data, error, fn: "reconcile_decide" };
    }
  }
}

export async function reconcileDecide(
  client: Client,
  body: unknown,
  caller: ReconcileCaller,
): Promise<Record<string, unknown>> {
  const userId = reconcileDecideUser(caller);
  if (!(await decideSwitchOn(client))) throw reconcileDecideRefusal("reconcile_decide_off");
  const input = reconcileDecideInput(body);
  // reconcile_items_pkey. The kind picks the database function; the
  // function itself locks and re-checks the item.
  let item: { data: unknown; error: unknown };
  try {
    item = await client.from("reconcile_items").select("id, kind")
      .eq("id", input.itemId).maybeSingle();
  } catch {
    throw reconcileDecideRefusal("reconcile_item_unreadable");
  }
  if (item.error) throw reconcileDecideRefusal("reconcile_item_unreadable");
  if (!item.data) throw reconcileDecideRefusal("reconcile_item_unknown");
  const kind = String((item.data as { kind?: unknown }).kind ?? "");
  const { data, error, fn } = await decideByKind(client, kind, input, userId);
  if (error) throw databaseRefusal(fn, error);
  await refreshMarkedProfit(client);
  return { ok: true, decided: true, ...(data && typeof data === "object" ? data : {}) };
}

export async function reconcileUndo(
  client: Client,
  body: unknown,
  caller: ReconcileCaller,
): Promise<Record<string, unknown>> {
  const userId = reconcileDecideUser(caller);
  if (!(await decideSwitchOn(client))) throw reconcileDecideRefusal("reconcile_decide_off");
  const decisionId = reconcileUndoInput(body);
  const { data, error } = await client.rpc("reconcile_undo", {
    p_decision_id: decisionId,
    p_user_id: userId,
  });
  if (error) throw databaseRefusal("reconcile_undo", error);
  await refreshMarkedProfit(client);
  return { ok: true, undone: true, ...(data && typeof data === "object" ? data : {}) };
}
