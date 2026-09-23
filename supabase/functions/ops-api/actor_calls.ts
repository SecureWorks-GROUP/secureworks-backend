// F-ACT (INTEGRATION.md X31): ops-api records who asked on every call.
//
// Right after the front door has authenticated the caller, the handler:
//   1. resolves the actor once (_shared/request_actor.ts): the verified JWT
//      user, else the x-sw-actor header on a server-key call, else
//      actor_missing;
//   2. writes it into one log line per request, with its source, so a claimed
//      header is never read as a verified user: opsApiDeniedLogLine when the
//      front door refuses the call (logged before the refusal returns, which
//      is otherwise unchanged), opsApiRequestLogLine when it is served;
//   3. counts server-key calls that carried no usable actor
//      (recordOpsApiActorMissing) into ops_api_actor_calls through
//      record_ops_api_actor_missing(), which the core status reads as
//      actor_missing. Only the count is stored: no action, caller class or
//      actor, so a caller cannot create a row by choosing what to send.
// Nothing is ever refused for a missing actor.
//
// The count is best-effort and off the request path: it is handed to
// EdgeRuntime.waitUntil so the response never waits on it, and a failed count
// logs one line with a code and never affects the request. Where there is no
// EdgeRuntime (tests, local runs) nothing is counted, so a request never makes
// a database call it did not make before. Supabase's edge runtime always has
// EdgeRuntime.

import {
  ACTOR_MISSING,
  type RequestActor,
} from "../_shared/request_actor.ts";

export type OpsApiAuthMode =
  | "api_key"
  | "jwt"
  | "routine"
  | "agent_read"
  | "none";

/** The audit identity to persist in an existing receipt. */
export function receiptActor(
  actor: RequestActor,
  authMode: OpsApiAuthMode,
): string {
  if (!actor.missing) return actor.actor;
  return authMode === "routine" ? "makesafe-reporting-routine" : ACTOR_MISSING;
}

/** Caller classes whose missing actors are counted: the server-key classes.
 * A JWT call always has a verified user, so it is never counted. */
export const COUNTED_CALLER_CLASSES = [
  "api_key",
  "routine",
  "agent_read",
] as const;

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The action as the log lines show it: the name when it fits the action
 * grammar, `none` when absent, `other` otherwise, so a caller-supplied value
 * never reaches a log line raw. */
export function loggedActionName(action: string | null | undefined): string {
  const a = (action ?? "").trim();
  if (!a) return "none";
  return NAME_PATTERN.test(a) ? a : "other";
}

/** The line for a served call: ids and codes only. */
export function opsApiRequestLogLine(
  action: string | null | undefined,
  method: string,
  actor: RequestActor,
): string {
  return `[ops-api] action=${
    loggedActionName(action)
  } method=${method} actor=${actor.actor} actor_source=${actor.source}`;
}

/** The line for a call the front door refused: the same actor, plus the
 * refusal's status and code. Ids and codes only. */
export function opsApiDeniedLogLine(
  action: string | null | undefined,
  method: string,
  actor: RequestActor,
  status: number,
  code: string | null | undefined,
): string {
  const c = typeof code === "string" && NAME_PATTERN.test(code)
    ? code
    : "other";
  return `[ops-api] denied action=${
    loggedActionName(action)
  } method=${method} actor=${actor.actor} actor_source=${actor.source} status=${status} code=${c}`;
}

type RpcClient = {
  rpc: (fn: string) => PromiseLike<{ data: unknown; error: unknown }>;
};

type EdgeRuntimeLike = { waitUntil: (p: Promise<unknown>) => void };

function edgeRuntime(): EdgeRuntimeLike | null {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  return rt && typeof rt.waitUntil === "function" ? rt : null;
}

function errorCode(error: unknown): string {
  const code = error && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)
    ? code
    : "no_code";
}

/**
 * Count one server-key call that carried no usable actor. Returns whether a
 * count was scheduled. Never throws and never delays the caller. The client is
 * built only when a count is scheduled; JWT calls and calls with an actor
 * write nothing.
 */
export function recordOpsApiActorMissing(
  client: () => RpcClient,
  authMode: OpsApiAuthMode,
  actor: RequestActor,
  runtime: EdgeRuntimeLike | null = edgeRuntime(),
): boolean {
  if (!(COUNTED_CALLER_CLASSES as readonly string[]).includes(authMode)) {
    return false;
  }
  if (!actor.missing || !runtime) return false;
  const warn = (error: unknown) =>
    console.warn(JSON.stringify({
      event: "ops_api_actor_count_failed",
      code: errorCode(error),
    }));
  try {
    const counted = Promise.resolve(
      client().rpc("record_ops_api_actor_missing"),
    ).then(({ error }) => {
      if (error) warn(error);
    }, warn);
    runtime.waitUntil(counted);
    return true;
  } catch (error) {
    warn(error);
    return false;
  }
}
