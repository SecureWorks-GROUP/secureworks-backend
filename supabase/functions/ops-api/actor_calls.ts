// F-ACT (INTEGRATION.md X31): ops-api records who asked on every call.
//
// After the front door has classified and authorised the caller, the handler:
//   1. resolves the actor once (_shared/request_actor.ts): the verified JWT
//      user, else the x-sw-actor header on a server-key call, else
//      actor_missing;
//   2. writes it into its one per-request log line (opsApiRequestLogLine), with
//      its source, so a claimed header is never read as a verified user;
//   3. counts server-key calls by actor state (recordOpsApiActorCall) into
//      ops_api_actor_calls through record_ops_api_actor_call, which the core
//      status reads as actor_missing.
// Nothing is ever refused for a missing actor.
//
// The count is best-effort and off the request path: it is handed to
// EdgeRuntime.waitUntil so the response never waits on it, and a failed count
// logs one line with a code and never affects the request. Where there is no
// EdgeRuntime (tests, local runs) nothing is counted, so a request never makes
// a database call it did not make before. Supabase's edge runtime always has
// EdgeRuntime; the status's server_key_calls_today reading 0 while calls are
// being served is the visible sign that counting has stopped.

import type { RequestActor } from "../_shared/request_actor.ts";

export type OpsApiAuthMode =
  | "api_key"
  | "jwt"
  | "routine"
  | "agent_read"
  | "none";

/** Caller classes whose calls are counted: the server-key classes. A JWT call
 * always has a verified user, so it is never counted. */
export const COUNTED_CALLER_CLASSES = [
  "api_key",
  "routine",
  "agent_read",
] as const;
export type CountedCallerClass = typeof COUNTED_CALLER_CLASSES[number];

export type ActorCallState = "present" | "missing" | "invalid_header";

const ACTION_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function actorCallState(actor: RequestActor): ActorCallState {
  if (actor.source === "header_invalid") return "invalid_header";
  return actor.missing ? "missing" : "present";
}

/** The action as the counter stores it: the name when it fits the action
 * grammar, `none` when absent, `other` otherwise. The same rule the SQL
 * writer applies, so the two can never disagree. */
export function countedActionName(action: string | null | undefined): string {
  const a = (action ?? "").trim();
  if (!a) return "none";
  return ACTION_PATTERN.test(a) ? a : "other";
}

/** The one per-request log line: ids and codes only. The action is shown in
 * its counted form, so a caller-supplied value never reaches the log raw. */
export function opsApiRequestLogLine(
  action: string | null | undefined,
  method: string,
  actor: RequestActor,
): string {
  return `[ops-api] action=${
    countedActionName(action)
  } method=${method} actor=${actor.actor} actor_source=${actor.source}`;
}

type RpcClient = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
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
 * Count one server-key call. Returns whether a count was scheduled. Never
 * throws and never delays the caller. The client is built only when a count
 * is scheduled.
 */
export function recordOpsApiActorCall(
  client: () => RpcClient,
  authMode: OpsApiAuthMode,
  actor: RequestActor,
  action: string | null | undefined,
  runtime: EdgeRuntimeLike | null = edgeRuntime(),
): boolean {
  if (!(COUNTED_CALLER_CLASSES as readonly string[]).includes(authMode)) {
    return false;
  }
  if (!runtime) return false;
  try {
    const counted = Promise.resolve(
      client().rpc("record_ops_api_actor_call", {
        p_caller_class: authMode,
        p_actor_state: actorCallState(actor),
        p_action: countedActionName(action),
      }),
    ).then(({ error }) => {
      if (error) {
        console.warn(JSON.stringify({
          event: "ops_api_actor_count_failed",
          code: errorCode(error),
        }));
      }
    }, (error) => {
      console.warn(JSON.stringify({
        event: "ops_api_actor_count_failed",
        code: errorCode(error),
      }));
    });
    runtime.waitUntil(counted);
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "ops_api_actor_count_failed",
      code: errorCode(error),
    }));
    return false;
  }
}
