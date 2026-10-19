// Shared browser key containment (incident 2026-10-19, ops-api key exposure).
//
// SW_API_KEY is a single shared value that has shipped in public browser code
// since 2026-03-22 (patio, fence-designer, secureworks-sale). Server routes that
// send email, message suppliers, build completion packs or run the AI agents
// must not treat it as proof of a trusted caller.
//
// The containment is an env switch so it can be deployed dark and turned on
// only after every legitimate server caller has moved to a service credential:
//
//   SW_SHARED_KEY_CONTAINMENT unset/anything else   shared key accepted (today)
//   SW_SHARED_KEY_CONTAINMENT = 1 | true | on | yes  shared key refused on the
//                                                    routes that call this module
//
// Browser routes the scoping tools still need (ghl-proxy browser actions, the
// send-quote quote send) do not call this module and are unchanged.
//
// Nothing here logs, returns or stores a credential.

import { timingSafeEqualString } from "./service_credential.ts";

export const SHARED_KEY_CONTAINMENT_ENV = "SW_SHARED_KEY_CONTAINMENT";

type EnvGet = (name: string) => string | undefined;

const defaultEnv: EnvGet = (name) => Deno.env.get(name);

/** True when the operator has switched shared-key containment on. */
export function sharedKeyContainmentOn(env: EnvGet = defaultEnv): boolean {
  const raw = (env(SHARED_KEY_CONTAINMENT_ENV) || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** Does `presented` equal the shared key? Always false while containment is on. */
export function sharedKeyAccepted(
  presented: string | null | undefined,
  sharedKey: string | null | undefined,
  env: EnvGet = defaultEnv,
): boolean {
  if (!presented || !sharedKey) return false;
  if (!timingSafeEqualString(presented, sharedKey)) return false;
  return !sharedKeyContainmentOn(env);
}

/** Is `presented` the shared key at all, whatever the switch says (for refusal logs). */
export function isSharedKey(
  presented: string | null | undefined,
  sharedKey: string | null | undefined,
): boolean {
  return !!presented && !!sharedKey && timingSafeEqualString(presented, sharedKey);
}

export type SharedKeyGateResult = "accepted" | "refused" | "absent";

/**
 * The one decision every contained route makes about the shared key:
 *   absent    no presented value is the shared key; fall through to other auth
 *   accepted  shared key presented and containment is off (logged for the census)
 *   refused   shared key presented and containment is on (logged)
 * A refused caller must not be authorised by any later branch on the strength
 * of that same value (for example a Bearer that is the shared key, not a JWT).
 */
export function sharedKeyGate(input: {
  presented: Array<string | null | undefined>;
  sharedKey: string | null | undefined;
  fn: string;
  route?: string | null;
  env?: EnvGet;
}): SharedKeyGateResult {
  const hit = input.presented.some((p) => isSharedKey(p, input.sharedKey));
  if (!hit) return "absent";
  if (sharedKeyContainmentOn(input.env ?? defaultEnv)) {
    logSharedKeyRefused(input.fn, input.route);
    return "refused";
  }
  logSharedKeyAccepted(input.fn, input.route);
  return "accepted";
}

/** One log line per refused shared-key call, so callers still using it can be found. */
export function logSharedKeyRefused(fn: string, route?: string | null): void {
  console.warn(JSON.stringify({
    event: "shared_key_refused",
    function: fn,
    route: route ?? null,
    containment_env: SHARED_KEY_CONTAINMENT_ENV,
  }));
}

/** One log line per accepted shared-key call while containment is off (dependency census). */
export function logSharedKeyAccepted(fn: string, route?: string | null): void {
  console.log(JSON.stringify({
    event: "shared_key_accepted",
    function: fn,
    route: route ?? null,
  }));
}

/**
 * Headers for an edge-to-edge call. Sends the service credential the way the
 * existing server callers do (Authorization Bearer + apikey, see
 * ops-api/job_work_orders.ts sendOutlookVariationEmail), so the callee's
 * verifyServiceCredential accepts it with containment on. Falls back to the
 * shared key only when no service key is configured (local tests).
 */
export function serverCallHeaders(
  serviceKey: string | null | undefined,
  sharedKey: string | null | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (serviceKey) {
    h["Authorization"] = `Bearer ${serviceKey}`;
    h["apikey"] = serviceKey;
  } else if (sharedKey) {
    h["x-api-key"] = sharedKey;
  }
  return { ...h, ...extra };
}
