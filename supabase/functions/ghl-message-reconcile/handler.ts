// HTTP door and wiring for the GHL message reconciler (context slice C1d).
// The run itself is reconcile.ts; this file checks the caller, wires the real
// reads and writes, and keeps the worker alive while the run finishes.
//
// Caller: pg_cron's trigger_ghl_message_reconcile() posts every 15 minutes with
// the service key (only while feature flag ghl_message_capture_v2 is on, and
// the cron command itself only runs while the capture lane is on). Only the
// service key is accepted here; the platform's JWT check runs first.
//
// The cron's HTTP call gives up after 5 seconds, so by default the run continues
// in the background (EdgeRuntime.waitUntil) and the reply is 202. A manual call
// with {"wait": true} runs in the foreground and returns the run summary
// (counts and codes only), which is what an end-to-end trace reads.
//
// Logs carry codes and ids only, never message text.

import {
  GhlProviderReadError,
  readGhlProvider,
} from "../ghl-proxy/provider_reads.ts";
import {
  type CaptureOutcome,
  ITEM_FLAG,
  type ReconcileDeps,
  type ReconcileResult,
  RUN_SOURCE,
  runGhlMessageReconcile,
  type RunRow,
} from "./reconcile.ts";

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
  const e = error as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(e.code)) {
    return e.code;
  }
  return "error";
}

/** The real reads and writes, over one service-role client. */
export function liveReconcileDeps(deps: HandlerDeps): ReconcileDeps {
  const supabase = deps.createSupabase();
  const locationId = deps.env("GHL_LOCATION_ID") ?? "";
  const token = deps.env("GHL_API_TOKEN") ?? "";
  const read = (
    action: "list_recent_ghl_conversations" | "list_ghl_messages",
    params: Record<string, string>,
  ) =>
    readGhlProvider(action, new URLSearchParams(params), {
      locationId,
      token,
      fetchFn: deps.fetch,
    });
  return {
    now: deps.now ?? (() => Date.now()),
    async itemFlagOn() {
      const { data, error } = await supabase.rpc("context_ghl_item_flag");
      return !error && data?.enabled === true;
    },
    async captureLaneOn() {
      const { data, error } = await supabase.rpc("automation_lane_enabled", {
        lane: "capture",
      });
      return !error && data === true;
    },
    async latestRuns(limit) {
      const { data, error } = await supabase.from("context_capture_runs")
        .select("id,status,started_at,updated_at,watermark,cursor")
        .eq("source", RUN_SOURCE)
        .order("started_at", { ascending: false })
        .limit(limit);
      if (error) {
        throw Object.assign(new Error("runs_unreadable"), {
          code: "runs_unreadable",
        });
      }
      return (data ?? []) as RunRow[];
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
    async listRecentConversations({ limit, startAfterDate }) {
      const params: Record<string, string> = { limit: String(limit) };
      if (startAfterDate) params.start_after_date = startAfterDate;
      const result = await read("list_recent_ghl_conversations", params);
      return {
        conversations: (result.data.conversations ?? []) as Record<
          string,
          unknown
        >[],
        hasMore: result.pagination?.has_more ?? null,
      };
    },
    async listMessages({ contactId, conversationId, limit, lastMessageId }) {
      const params: Record<string, string> = {
        contact_id: contactId,
        conversation_id: conversationId,
        limit: String(limit),
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
        hasMore: result.pagination?.has_more ?? null,
        nextLastMessageId: typeof next?.last_message_id === "string"
          ? next.last_message_id
          : null,
      };
    },
    async existingKeys(keys) {
      const { data, error } = await supabase.from("business_events")
        .select("provider_message_id")
        .in("provider_message_id", keys);
      if (error) {
        throw Object.assign(new Error("precheck_failed"), {
          code: "precheck_failed",
        });
      }
      return new Set(
        (data ?? []).map((r: { provider_message_id: string }) =>
          r.provider_message_id
        ),
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
  };
}

function logResult(result: ReconcileResult): void {
  if (result.outcome === "ran") {
    console.log(
      `[ghl-message-reconcile] run=${result.run_id} status=${result.status} error=${
        result.error_code ?? "-"
      } inserted=${result.counts.inserted} duplicates=${result.counts.duplicates} conversations=${result.counts.conversations_read} backlog=${result.counts.backlog_conversations}`,
    );
  } else {
    console.log(`[ghl-message-reconcile] ${result.outcome}`);
  }
}

export async function handleReconcile(
  req: Request,
  deps: HandlerDeps,
  run: (d: ReconcileDeps) => Promise<ReconcileResult> = runGhlMessageReconcile,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!serviceKey || !bearer || !sameSecret(bearer, serviceKey)) {
    return json({ error: "service_key_required" }, 401);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // An empty or non-JSON body is a plain run request.
  }

  const execute = async (): Promise<
    ReconcileResult | { outcome: "error"; code: string }
  > => {
    try {
      const result = await run(liveReconcileDeps(deps));
      logResult(result);
      return result;
    } catch (error) {
      const c = error instanceof GhlProviderReadError
        ? error.code
        : code(error);
      console.error(`[ghl-message-reconcile] run failed code=${c}`);
      return { outcome: "error", code: c };
    }
  };

  if (body.wait === true) {
    const result = await execute();
    return json(
      { flag: ITEM_FLAG, ...result },
      result.outcome === "error" ? 500 : 200,
    );
  }
  const pending = execute();
  if (deps.waitUntil) {
    deps.waitUntil(pending);
    return json({ accepted: true }, 202);
  }
  const result = await pending;
  return json(
    { flag: ITEM_FLAG, ...result },
    result.outcome === "error" ? 500 : 200,
  );
}
