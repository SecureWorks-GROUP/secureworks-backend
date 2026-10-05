// Job story v1 (ledger store, 20261006013000): the ops-api door onto
// context_ledger_person_edit, the one way a person corrects a job's ledger.
//
//   POST ?action=ledger_person_edit
//     { job_id, action: close|reopen|dispute|add, item_key?, note, item? }
//     -> RPC context_ledger_person_edit(p_job_id, p_user_id, p_action,
//        p_item_key, p_note, p_item)
//
// A staff user closes, reopens or disputes an item of the job's live ledger,
// or adds one of their own. The item is then locked against the model. The
// person is the verified session user, never a body field: a server key call
// has no person behind it and is refused. Staff only at the front door
// (admin, owner, ops_manager); the SQL writer checks the role again against
// users.role and refuses anyone else.

export class LedgerPersonEditError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const LEDGER_PERSON_EDIT_ACTIONS = [
  "close",
  "reopen",
  "dispute",
  "add",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Refusals the SQL writer returns as {outcome: "refused", code} and the HTTP
// status each maps to. Any other code is an item check refusal (422).
const REFUSALS: Record<string, number> = {
  not_staff: 403,
  note_required: 400,
  no_live_ledger: 409,
  unknown_item: 404,
  duplicate_item: 409,
};

type Rpc = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type LedgerEditCaller = {
  authMode: string;
  userId: string | null | undefined;
};

function bad(message: string): never {
  throw new LedgerPersonEditError("invalid_request", 400, message);
}

// The person behind the call: only a verified user session has one.
export function ledgerPersonEditUser(caller: LedgerEditCaller): string {
  if (
    caller.authMode !== "jwt" || !caller.userId || !UUID.test(caller.userId)
  ) {
    throw new LedgerPersonEditError(
      "person_session_required",
      403,
      "A ledger correction is made by a signed-in staff member, not a server key.",
    );
  }
  return caller.userId;
}

export function ledgerPersonEditArgs(
  body: unknown,
  userId: string,
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    bad("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const allowed = new Set(["job_id", "action", "item_key", "note", "item"]);
  for (const key of Object.keys(b)) {
    if (!allowed.has(key)) bad(`unknown field ${key}`);
  }
  const jobId = String(b.job_id ?? "");
  if (!UUID.test(jobId)) bad("job_id must be a uuid");
  const action = String(b.action ?? "");
  if (!(LEDGER_PERSON_EDIT_ACTIONS as readonly string[]).includes(action)) {
    bad(`action must be one of ${LEDGER_PERSON_EDIT_ACTIONS.join(", ")}`);
  }
  if (typeof b.note !== "string" || b.note.trim().length === 0) {
    bad("note is required: say what you saw or were told");
  }
  const note = b.note.trim();
  if (note.length > 600) bad("note must be at most 600 characters");
  let itemKey: string | null = null;
  let item: Record<string, unknown> | null = null;
  if (action === "add") {
    if (b.item_key !== undefined && b.item_key !== null) {
      bad("item_key is not used when adding an item");
    }
    if (!b.item || typeof b.item !== "object" || Array.isArray(b.item)) {
      bad("item must be a JSON object when adding");
    }
    item = b.item as Record<string, unknown>;
    if (new TextEncoder().encode(JSON.stringify(item)).length > 16384) {
      bad("item must be at most 16384 bytes");
    }
  } else {
    if (b.item !== undefined && b.item !== null) {
      bad("item is only used when adding");
    }
    if (
      typeof b.item_key !== "string" || b.item_key.length < 1 ||
      b.item_key.length > 200
    ) {
      bad("item_key is required");
    }
    itemKey = b.item_key;
  }
  return {
    p_job_id: jobId,
    p_user_id: userId,
    p_action: action,
    p_item_key: itemKey,
    p_note: note,
    p_item: item,
  };
}

export async function ledgerPersonEdit(
  client: Rpc,
  body: unknown,
  caller: LedgerEditCaller,
): Promise<Record<string, unknown>> {
  const userId = ledgerPersonEditUser(caller);
  const args = ledgerPersonEditArgs(body, userId);
  const { data, error } = await client.rpc("context_ledger_person_edit", args);
  if (error) {
    const message = String((error as { message?: unknown }).message ?? "");
    if (message === "context_ledger_person_edit_invalid") {
      throw new LedgerPersonEditError(
        "invalid_request",
        400,
        "the correction is not valid",
      );
    }
    throw new LedgerPersonEditError(
      "ledger_edit_failed",
      503,
      "the correction could not be saved",
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LedgerPersonEditError(
      "ledger_edit_failed",
      503,
      "the correction returned nothing",
    );
  }
  const out = data as Record<string, unknown>;
  if (out.outcome === "refused") {
    const code = String(out.code ?? "refused");
    const detail: Record<string, unknown> = {};
    if (typeof out.detail === "string") detail.detail = out.detail;
    if (typeof out.item_key === "string") detail.item_key = out.item_key;
    throw new LedgerPersonEditError(
      code,
      REFUSALS[code] ?? 422,
      `correction refused: ${code}`,
      detail,
    );
  }
  return out;
}
