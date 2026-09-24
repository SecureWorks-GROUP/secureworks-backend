// HTTP door and wiring for the GHL call transcript fetcher (context slice T2).
// The run itself is fetch.ts; this file checks the caller, wires the real
// reads and writes, and keeps the worker alive while a live run finishes.
//
// Callers (service role only: the exact SUPABASE_SERVICE_ROLE_KEY, or a JWT
// whose role claim is exactly "service_role", as pg_cron's sw_service_key()
// is; JWT verification stays on at the platform):
//   * pg_cron's trigger_ghl_call_transcript_fetch() every 5 minutes, only
//     while the fetch flag is on: a live run. The cron's HTTP call gives up
//     after 5 seconds, so the run continues in the background
//     (EdgeRuntime.waitUntil) and the reply is 202. {"wait": true} runs in the
//     foreground and returns the summary (ids, counts and codes only).
//   * the history load, by hand: {"mode": "backfill", "dry_run": true|false,
//     "after": "<contact id>", "max_contacts": 10}. Always foreground.
//     dry_run defaults to true: only an explicit false writes.
//
// GHL reads: the call item (API version 2021-07-28) and its transcription
// (v3), each bound to our configured location; a provider error body is never
// read or echoed. Contact and conversation listing for the history load reuse
// ghl-proxy/provider_reads.ts, as the reconciler does.
//
// Logs carry codes, counts and ids only, never words.

import {
  GhlProviderReadError,
  readGhlProvider,
} from "../ghl-proxy/provider_reads.ts";
import { isServiceRoleJwt } from "../_shared/service_role_jwt.ts";
import { isFlagOn } from "../_shared/evidence/feature_flag.ts";
import { pairLegacyCall } from "../_shared/evidence/ghl_call_pair.ts";
import {
  type BackfillDeps,
  type BackfillResult,
  type CaptureOutcome,
  type DueCall,
  FETCH_FLAG,
  type FetchPolicy,
  type LiveResult,
  type ProviderRead,
  runBackfill,
  runLiveFetch,
} from "./fetch.ts";

export interface HandlerDeps {
  env(name: string): string | undefined;
  // deno-lint-ignore no-explicit-any
  createSupabase(): any;
  fetch?: typeof fetch;
  waitUntil?(p: Promise<unknown>): void;
  now?(): number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time comparison of two secrets. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function code(error: unknown): string {
  const e = error as { code?: unknown } | null;
  if (typeof e?.code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(e.code)) {
    return e.code.toLowerCase();
  }
  return "error";
}

const GHL_ID = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * One GET to GHL. Never follows a redirect, never reads an error body, never
 * throws: a failure is a status and a code.
 */
export async function ghlGet(
  path: string,
  version: string,
  opts: { token: string; fetchFn?: typeof fetch },
): Promise<ProviderRead> {
  let response: Response;
  try {
    response = await (opts.fetchFn ?? fetch)(
      `https://services.leadconnectorhq.com${path}`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Version: version,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    return { ok: false, status: null, code: "transport" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return {
      ok: false,
      status: response.status,
      code: `http_${response.status}`,
    };
  }
  try {
    const raw = await response.text();
    return { ok: true, body: raw.trim() ? JSON.parse(raw) : null };
  } catch {
    return { ok: false, status: null, code: "provider_not_json" };
  }
}

/** The real reads and writes, over one service-role client. */
export function liveDeps(deps: HandlerDeps): BackfillDeps {
  const supabase = deps.createSupabase();
  const locationId = deps.env("GHL_LOCATION_ID") ?? "";
  const token = deps.env("GHL_API_TOKEN") ?? "";
  const configured = GHL_ID.test(locationId) && !!token;
  const notConfigured: ProviderRead = {
    ok: false,
    status: null,
    code: "provider_not_configured",
  };
  const read = (
    action: "list_ghl_conversations" | "list_ghl_messages",
    params: Record<string, string>,
  ) =>
    readGhlProvider(action, new URLSearchParams(params), {
      locationId,
      token,
      fetchFn: deps.fetch,
    });
  return {
    now: deps.now ?? (() => Date.now()),
    locationId,
    flagOn: () => isFlagOn(supabase, FETCH_FLAG),
    async laneOn() {
      const { data, error } = await supabase.rpc("automation_lane_enabled", {
        lane: "capture",
      });
      return !error && data === true;
    },
    async policy() {
      const { data, error } = await supabase.rpc(
        "context_transcript_capture_policy",
      );
      if (error || !data || typeof data !== "object") {
        throw Object.assign(new Error("policy_unreadable"), {
          code: "policy_unreadable",
        });
      }
      return data as FetchPolicy;
    },
    async latestRun(source) {
      const { data, error } = await supabase.from("context_capture_runs")
        .select("id,status,started_at")
        .eq("source", source)
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) {
        throw Object.assign(new Error("runs_unreadable"), {
          code: "runs_unreadable",
        });
      }
      return data?.[0] ?? null;
    },
    async recordRun(run) {
      const { data, error } = await supabase.rpc("record_capture_run", {
        p_run: run,
      });
      if (error || typeof data?.run_id !== "string") {
        throw Object.assign(new Error("record_capture_run_failed"), {
          code: error?.message?.match(/capture_run_[a-z_]+/)?.[0] ??
            "record_capture_run_failed",
        });
      }
      return data.run_id;
    },
    async dueCalls(limit) {
      const { data, error } = await supabase.rpc(
        "context_transcript_due_calls",
        { p_limit: limit },
      );
      if (error) {
        throw Object.assign(new Error("due_calls_unreadable"), {
          code: "due_calls_unreadable",
        });
      }
      return (data ?? []) as DueCall[];
    },
    readCallMessage(messageId) {
      if (!configured) return Promise.resolve(notConfigured);
      return ghlGet(
        `/conversations/messages/${encodeURIComponent(messageId)}`,
        "2021-07-28",
        { token, fetchFn: deps.fetch },
      );
    },
    readTranscription(messageId) {
      if (!configured) return Promise.resolve(notConfigured);
      return ghlGet(
        `/conversations/locations/${encodeURIComponent(locationId)}/messages/${
          encodeURIComponent(messageId)
        }/transcription`,
        "v3",
        { token, fetchFn: deps.fetch },
      );
    },
    async capture(row): Promise<CaptureOutcome> {
      try {
        const { data, error } = await supabase.rpc("capture_business_event", {
          p_row: row,
        });
        if (error) return { outcome: "error", code: code(error) };
        if (!data || typeof data !== "object") {
          return { outcome: "error", code: "rpc_no_result" };
        }
        return data as CaptureOutcome;
      } catch {
        return { outcome: "error", code: "rpc_threw" };
      }
    },
    async recordFetch(record) {
      try {
        const { data, error } = await supabase.rpc(
          "record_call_transcript_fetch",
          { p: record },
        );
        if (error) {
          return {
            error: error.message?.match(/transcript_fetch_[a-z_]+/)?.[0] ??
              "record_fetch_failed",
          };
        }
        return { outcome: String(data?.outcome ?? "unknown") };
      } catch {
        return { error: "record_fetch_threw" };
      }
    },
    async backfillContacts(after, limit) {
      const { data, error } = await supabase.rpc(
        "context_transcript_backfill_contacts",
        { p_after: after, p_limit: limit },
      );
      if (error) {
        throw Object.assign(new Error("backfill_contacts_unreadable"), {
          code: "backfill_contacts_unreadable",
        });
      }
      return data ?? [];
    },
    async listConversations(contactId, startAfterDate) {
      const params: Record<string, string> = {
        contact_id: contactId,
        limit: "50",
      };
      if (startAfterDate) params.start_after_date = startAfterDate;
      const result = await read("list_ghl_conversations", params);
      const next = result.pagination?.next_cursor as
        | Record<string, unknown>
        | null
        | undefined;
      return {
        conversations: (result.data.conversations ?? []) as Record<
          string,
          unknown
        >[],
        next: result.pagination?.has_more === false
          ? null
          : typeof next?.start_after_date === "string" ||
              typeof next?.start_after_date === "number"
          ? String(next.start_after_date)
          : null,
      };
    },
    async listMessages(contactId, conversationId, lastMessageId) {
      const params: Record<string, string> = {
        contact_id: contactId,
        conversation_id: conversationId,
        limit: "100",
      };
      if (lastMessageId) params.last_message_id = lastMessageId;
      const result = await read("list_ghl_messages", params);
      const container = (result.data.messages ?? {}) as Record<string, unknown>;
      const next = result.pagination?.next_cursor as
        | Record<string, unknown>
        | null
        | undefined;
      return {
        messages: (container.messages ?? []) as Record<string, unknown>[],
        next: result.pagination?.has_more === false
          ? null
          : typeof next?.last_message_id === "string"
          ? next.last_message_id
          : null,
      };
    },
    async existingRows(keys) {
      const found = new Map<string, string>();
      for (let i = 0; i < keys.length; i += 100) {
        const { data, error } = await supabase.from("business_events")
          .select("id,provider_message_id")
          .in("provider_message_id", keys.slice(i, i + 100));
        if (error) {
          throw Object.assign(new Error("precheck_failed"), {
            code: "precheck_failed",
          });
        }
        for (const r of data ?? []) found.set(r.provider_message_id, r.id);
      }
      return found;
    },
    async fetchOutcomes(ids) {
      const found = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await supabase.from("call_transcript_fetches")
          .select("call_message_id,outcome")
          .in("call_message_id", ids.slice(i, i + 100));
        if (error) {
          throw Object.assign(new Error("fetch_records_unreadable"), {
            code: "fetch_records_unreadable",
          });
        }
        for (const r of data ?? []) found.set(r.call_message_id, r.outcome);
      }
      return found;
    },
    pairLegacyCall: (row) => pairLegacyCall(supabase, row),
  };
}

function logLive(result: LiveResult): void {
  if (result.outcome === "ran") {
    const c = result.counts;
    console.log(
      `[ghl-call-transcript-fetch] live run=${result.run_id} status=${result.status} error=${
        result.error_code ?? "-"
      } selected=${c.selected} saved=${c.saved} not_ready=${c.not_ready} awaiting=${c.awaiting_agreement} not_expected=${c.not_expected} errors=${c.errors}`,
    );
  } else {
    console.log(`[ghl-call-transcript-fetch] live ${result.outcome}`);
  }
}

function logBackfill(result: BackfillResult): void {
  if (result.outcome === "ran") {
    const c = result.counts;
    console.log(
      `[ghl-call-transcript-fetch] backfill dry_run=${result.dry_run} run=${
        result.run_id ?? "-"
      } status=${result.status} error=${
        result.error_code ?? "-"
      } contacts=${c.contacts} calls=${c.call_items} saved=${c.saved} would_save=${
        c.would_save ?? 0
      } next_after=${result.next_after ?? "-"}`,
    );
  } else {
    console.log(
      `[ghl-call-transcript-fetch] backfill refused ${result.reason}`,
    );
  }
}

export interface Runners {
  live: typeof runLiveFetch;
  backfill: typeof runBackfill;
}

export async function handleFetch(
  req: Request,
  deps: HandlerDeps,
  runners: Runners = { live: runLiveFetch, backfill: runBackfill },
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const serviceRole = !!bearer &&
    ((!!serviceKey && sameSecret(bearer, serviceKey)) ||
      isServiceRoleJwt(bearer));
  if (!serviceRole) return json({ error: "service_key_required" }, 401);

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // An empty or non-JSON body is a plain live run request.
  }

  if (body.mode === "backfill") {
    const after = typeof body.after === "string" && GHL_ID.test(body.after)
      ? body.after
      : null;
    if (body.after !== undefined && body.after !== null && !after) {
      return json({ error: "after_invalid" }, 400);
    }
    // Only an explicit false writes.
    const dryRun = body.dry_run !== false;
    const maxContacts = typeof body.max_contacts === "number"
      ? body.max_contacts
      : 10;
    try {
      const result = await runners.backfill(
        { dryRun, after, maxContacts },
        liveDeps(deps),
      );
      logBackfill(result);
      return json(
        { flag: FETCH_FLAG, mode: "backfill", ...result },
        result.outcome === "refused" ? 409 : 200,
      );
    } catch (error) {
      const c = error instanceof GhlProviderReadError
        ? error.code
        : code(error);
      console.error(`[ghl-call-transcript-fetch] backfill failed code=${c}`);
      return json({ mode: "backfill", outcome: "error", code: c }, 500);
    }
  }
  if (body.mode !== undefined && body.mode !== "live") {
    return json({ error: "mode_invalid" }, 400);
  }

  const execute = async (): Promise<
    LiveResult | { outcome: "error"; code: string }
  > => {
    try {
      const result = await runners.live(liveDeps(deps));
      logLive(result);
      return result;
    } catch (error) {
      const c = error instanceof GhlProviderReadError
        ? error.code
        : code(error);
      console.error(`[ghl-call-transcript-fetch] live run failed code=${c}`);
      return { outcome: "error", code: c };
    }
  };
  if (body.wait === true || !deps.waitUntil) {
    const result = await execute();
    return json(
      { flag: FETCH_FLAG, mode: "live", ...result },
      result.outcome === "error" ? 500 : 200,
    );
  }
  deps.waitUntil(execute());
  return json({ accepted: true }, 202);
}
