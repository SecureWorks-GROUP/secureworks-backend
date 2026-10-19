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
//   SW_SHARED_KEY_CONTAINMENT unset, 0, false, off, no  shared key accepted (today)
//   SW_SHARED_KEY_CONTAINMENT = 1 | true | on | yes     shared key refused on the
//                                                       routes that call this module
//   any other value                                     logged as a typo, treated as on
//
// The server callers move with it: serverCallHeaders sends the service
// credential once containment is on, or earlier when
// SW_SERVER_CALL_SERVICE_CREDENTIAL is on, and today's shared-key header
// otherwise. Both are env reads at call time, so no redeploy is needed.
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
const SWITCH_ON = new Set(["1", "true", "on", "yes"]);
const SWITCH_OFF = new Set(["", "0", "false", "off", "no"]);

/**
 * True when the operator has switched shared-key containment on. Unset or an
 * explicit off value means off. Any other value is a typo: it is logged as a
 * configuration error and fails CLOSED (on), so a mistyped "on" can never
 * quietly reopen shared-key access.
 */
export function sharedKeyContainmentOn(env: EnvGet = defaultEnv): boolean {
  const raw = (env(SHARED_KEY_CONTAINMENT_ENV) || "").trim().toLowerCase();
  if (SWITCH_ON.has(raw)) return true;
  if (SWITCH_OFF.has(raw)) return false;
  console.error(JSON.stringify({
    event: "shared_key_containment_bad_value",
    containment_env: SHARED_KEY_CONTAINMENT_ENV,
    treated_as: "on",
  }));
  return true;
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
  // Request headers, for non-secret caller hints in the census log line.
  headers?: Headers | null;
}): SharedKeyGateResult {
  const hit = input.presented.some((p) => isSharedKey(p, input.sharedKey));
  if (!hit) return "absent";
  if (sharedKeyContainmentOn(input.env ?? defaultEnv)) {
    logSharedKeyRefused(input.fn, input.route, input.headers);
    return "refused";
  }
  logSharedKeyAccepted(input.fn, input.route, input.headers);
  return "accepted";
}

// Origins the census may name. Anything else is logged as "other": header
// text is never copied into a log line, because it can carry email addresses,
// key fragments or the shared key itself.
const CENSUS_ORIGINS = new Set([
  "https://marninms98-dotcom.github.io",
  "https://secureworks-group.github.io",
  "https://kevgrhcjxspbxgovpmfl.supabase.co",
]);

export type CallerClient = "browser" | "deno" | "node" | "curl" | "python" | "pg_net" | "other" | "none";

/**
 * Allowlisted, enumerated caller hints for the census: a known origin or
 * "other"/"none", a client family, and whether an actor header was present.
 * No free text from any header is returned.
 */
export function callerHints(headers?: Headers | null): {
  origin: string;
  client: CallerClient;
  actor_header: boolean;
} {
  const rawOrigin = headers?.get("origin");
  let origin = "none";
  if (rawOrigin) {
    try {
      const o = new URL(rawOrigin).origin;
      origin = CENSUS_ORIGINS.has(o) ? o : "other";
    } catch {
      origin = "other";
    }
  }
  const ua = (headers?.get("user-agent") || "").toLowerCase();
  let client: CallerClient = "none";
  if (ua) {
    if (ua.includes("mozilla/")) client = "browser";
    else if (ua.startsWith("deno/") || ua.includes("supabase-edge-runtime")) client = "deno";
    else if (ua.startsWith("node") || ua.includes("undici") || ua.includes("node-fetch")) client = "node";
    else if (ua.startsWith("curl/")) client = "curl";
    else if (ua.startsWith("python")) client = "python";
    else if (ua.startsWith("pg_net")) client = "pg_net";
    else client = "other";
  }
  return { origin, client, actor_header: !!headers?.get("x-sw-actor") };
}

/** One log line per refused shared-key call, so callers still using it can be found. */
export function logSharedKeyRefused(fn: string, route?: string | null, headers?: Headers | null): void {
  console.warn(JSON.stringify({
    event: "shared_key_refused",
    function: fn,
    route: route ?? null,
    containment_env: SHARED_KEY_CONTAINMENT_ENV,
    ...callerHints(headers),
  }));
}

/** One log line per accepted shared-key call while containment is off (dependency census). */
export function logSharedKeyAccepted(fn: string, route?: string | null, headers?: Headers | null): void {
  console.log(JSON.stringify({
    event: "shared_key_accepted",
    function: fn,
    route: route ?? null,
    ...callerHints(headers),
  }));
}

export const SERVER_CALL_SERVICE_CREDENTIAL_ENV = "SW_SERVER_CALL_SERVICE_CREDENTIAL";

/**
 * Which credential an edge-to-edge call presents. Read at call time, so it
 * moves with an env change and needs no redeploy:
 *
 *   containment on                          service credential (the shared key
 *                                           would be refused)
 *   SW_SERVER_CALL_SERVICE_CREDENTIAL on    service credential, to prove the
 *                                           callers before containment goes on
 *   both off (the default)                  the shared key as x-api-key, which
 *                                           is what these callers send today
 *
 * The credential flag uses the containment switch's on and off words. Any
 * other value is logged and read as off, keeping today's credential: the
 * flag only widens what is sent, and containment on overrides it anyway.
 */
export function serverCallUsesServiceCredential(env: EnvGet = defaultEnv): boolean {
  if (sharedKeyContainmentOn(env)) return true;
  const raw = (env(SERVER_CALL_SERVICE_CREDENTIAL_ENV) || "").trim().toLowerCase();
  if (SWITCH_ON.has(raw)) return true;
  if (SWITCH_OFF.has(raw)) return false;
  console.error(JSON.stringify({
    event: "server_call_credential_bad_value",
    credential_env: SERVER_CALL_SERVICE_CREDENTIAL_ENV,
    treated_as: "off",
  }));
  return false;
}

/**
 * Headers for an edge-to-edge call. With the service credential selected (see
 * serverCallUsesServiceCredential) it is sent the way the existing server
 * callers do (Authorization Bearer + apikey, see ops-api/job_work_orders.ts
 * sendOutlookVariationEmail), so the callee's verifyServiceCredential accepts
 * it with containment on; with no service key configured it falls back to the
 * shared key and warns. Otherwise the headers are exactly today's.
 */
export function serverCallHeaders(
  serviceKey: string | null | undefined,
  sharedKey: string | null | undefined,
  extra: Record<string, string> = {},
  // Fixed operation name for the fallback warning (never request data).
  operation?: string,
  env: EnvGet = defaultEnv,
): Record<string, string> {
  if (!serverCallUsesServiceCredential(env)) {
    return { "Content-Type": "application/json", "x-api-key": sharedKey ?? "", ...extra };
  }
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (serviceKey) {
    h["Authorization"] = `Bearer ${serviceKey}`;
    h["apikey"] = serviceKey;
  } else if (sharedKey) {
    console.warn(JSON.stringify({ event: "server_call_shared_key_fallback", operation: operation ?? null }));
    h["x-api-key"] = sharedKey;
  }
  return { ...h, ...extra };
}
