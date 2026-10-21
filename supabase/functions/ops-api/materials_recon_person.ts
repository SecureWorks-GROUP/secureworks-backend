// JP-12 (20261021173000): who may place, split or mark a supplier bill in
// Bills to place. Only a signed-in session is a recorded person here. An
// x-sw-actor header on a server-key call is a claim by a caller that holds a
// key, never a person, even when it names a real user's id or email (the
// reading approve_work_order gives a header approver, without its flag). A
// routine key and a call with no actor are refused too. The database half
// is public.cfo_recorded_person: allocate_bill_split refuses an actor that
// fails it, and every cost and settlement view reads it.
//
// A refusal writes nothing: the three handlers are never reached.

import type { RequestActor } from "../_shared/request_actor.ts";
import type { OpsApiAuthMode } from "./actor_calls.ts";

export const RECORDED_PERSON_REQUIRED = "recorded_person_required";

/** The actions this gate covers: each writes a person's decision. */
export const BILL_PLACEMENT_ACTIONS = [
  "materials_recon_assign",
  "materials_recon_split",
  "materials_recon_not_job_related",
] as const;

const SESSION_ACTOR =
  /^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in person's `user:<id>`, or null when the request carries no
 * verified session: a header claim, a routine, a missing actor. */
export function billPlacementPerson(
  actor: RequestActor,
  authMode: OpsApiAuthMode,
): string | null {
  if (authMode !== "jwt" || actor.source !== "jwt" || actor.missing) {
    return null;
  }
  return SESSION_ACTOR.test(actor.actor) ? actor.actor : null;
}

/** The body of the 403 a refused write returns. */
export function billPlacementRefusal(action: string): {
  ok: false;
  code: typeof RECORDED_PERSON_REQUIRED;
  error: string;
} {
  return {
    ok: false,
    code: RECORDED_PERSON_REQUIRED,
    error:
      `${action} records a person's decision on an installer or supplier bill, ` +
      "so it needs a signed-in session; a server key or an x-sw-actor header is not a person. Nothing was written.",
  };
}
