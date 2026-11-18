// P2-03.4 (Follow-up 66): the Reconcile screen's undo press.
//
//   POST ?action=reconcile_undo
//     { decision_id }   (operator_email is ignored)
//     -> RPC reconcile_undo(p_decision_id, p_user_id) (20261118195300).
//        Puts back what the decision changed (the document's lines and the
//        Reconcile item) and records an `undo` decision.
//     <- 200 { ok: true, undone: true, decision_id, restored_item_id }
//        decision_id is the new undo decision; restored_item_id is the item
//        open again (null when the decision closed none).
//
// Only the newest decision on an item can be undone; the decision id is the
// one decide answered with. The same caller rule and switch as decide
// (reconcile_decide.ts): only a verified staff session (admin, owner,
// ops_manager); a server key, the routine and an agent are refused 403 before
// the switch or the body is read. The person is the session user, never a body
// field or header. Behind reconcile_decide_v1 (ships off; a missing row is
// off; an unreadable switch refuses 503 and changes nothing). A database
// refusal maps to its words in RECONCILE_DECIDE_WORDS (409, or 403 for
// reconcile_not_staff). The door does not refresh Job Profit: reconcile_undo
// marks the jobs and the timers do the rest.
// Logs carry codes and ids only.

import {
  type Client,
  type ReconcileCaller,
  databaseRefusal,
  decideSwitchOn,
  reconcileDecideRefusal,
  reconcileDecideUser,
} from "./reconcile_decide.ts";

const UNDO_FIELDS = new Set(["decision_id", "operator_email"]);

/** Pure. The decision id as a decimal string (a bigint), or 400. */
export function reconcileUndoInput(body: unknown): { decisionId: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw reconcileDecideRefusal("invalid_request");
  }
  for (const key of Object.keys(body as object)) {
    if (!UNDO_FIELDS.has(key)) throw reconcileDecideRefusal("invalid_request");
  }
  const raw = (body as Record<string, unknown>).decision_id;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return { decisionId: String(raw) };
  }
  if (typeof raw === "string" && /^[1-9][0-9]{0,17}$/.test(raw)) return { decisionId: raw };
  throw reconcileDecideRefusal("invalid_request");
}

export async function reconcileUndo(
  client: Client,
  body: unknown,
  caller: ReconcileCaller,
): Promise<Record<string, unknown>> {
  const userId = reconcileDecideUser(caller);
  if (!(await decideSwitchOn(client))) throw reconcileDecideRefusal("reconcile_decide_off");
  const { decisionId } = reconcileUndoInput(body);
  let res: { data: unknown; error: unknown };
  try {
    res = await client.rpc("reconcile_undo", { p_decision_id: decisionId, p_user_id: userId });
  } catch {
    console.error("[reconcile_undo] call threw");
    throw reconcileDecideRefusal("reconcile_failed");
  }
  if (res.error) throw databaseRefusal("reconcile_undo", res.error);
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as Record<string, unknown>;
  return {
    ok: true,
    undone: true,
    decision_id: data.decision_id ?? null,
    restored_item_id: data.restored_item_id ?? null,
  };
}
