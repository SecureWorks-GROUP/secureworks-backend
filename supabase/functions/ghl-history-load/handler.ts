// HTTP door and wiring for the one-off GHL history load (context slice M4).
// The run itself is history_load.ts; this file checks the caller, reads the
// request, wires the real reads and writes, and keeps the worker alive while
// the run finishes.
//
// Caller: an operator or the L6 validator, by hand. There is no schedule. Only
// the service role is accepted (the exact SUPABASE_SERVICE_ROLE_KEY, or a JWT
// whose role claim is exactly "service_role"), the same rule as the GHL
// reconciler. The x-sw-actor header names who asked (F-ACT, audit only, never
// refused); it is recorded on the run row's cursor and every ledger row.
//
// Body (JSON, every key optional):
//   action               "load" (default): the history load. "link": the link
//                        action (link.ts), which runs first and puts a GHL
//                        contact on live jobs that have none.
//   dry_run              true unless it is exactly false. A dry run writes no
//                        evidence, no ledger row and no link.
//   max_jobs             load: jobs to ask the due list for (1 to 100, default
//                        20; the 100-jobs-a-day limit is enforced in SQL
//                        whatever is asked). link: jobs to judge (default 500).
//   after_job_id         link: start after this job id instead of where the
//                        previous link run stopped.
//   wait                 true runs in the foreground and returns the summary
//                        (counts, contact ids, codes); otherwise 202 and the
//                        run continues in the background.
//
// Logs carry codes, ids and counts only, never message text.

import {
  GhlProviderReadError,
  readGhlProvider,
} from "../ghl-proxy/provider_reads.ts";
import { isServiceRoleJwt } from "../_shared/service_role_jwt.ts";
import { resolveRequestActor } from "../_shared/request_actor.ts";
import { pairLegacyCall } from "../_shared/evidence/ghl_call_pair.ts";
import { sameSecret } from "../ghl-message-reconcile/handler.ts";
import {
  type DueList,
  type HistoryCaptureOutcome,
  type HistoryDeps,
  type HistoryRequest,
  type HistoryResult,
  parseRequest,
  runGhlHistoryLoad,
  type RunRow,
} from "./history_load.ts";
import {
  type LinkCandidate,
  type LinkDeps,
  type LinkResult,
  type LinkWriteOutcome,
  parseLinkRequest,
  runGhlContactLink,
} from "./link.ts";

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

function code(error: unknown): string {
  const e = error as { code?: unknown } | null;
  if (typeof e?.code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(e.code)) {
    return e.code;
  }
  return "error";
}

function refusal(error: { message?: string } | null, fallback: string) {
  return Object.assign(new Error(fallback), {
    code: error?.message?.match(/(capture_run|history_[a-z]+)_[a-z_]+/)?.[0] ??
      fallback,
  });
}

/** The real reads and writes, over one service-role client. */
export function liveHistoryDeps(deps: HandlerDeps): HistoryDeps {
  const supabase = deps.createSupabase();
  const locationId = deps.env("GHL_LOCATION_ID") ?? "";
  const token = deps.env("GHL_API_TOKEN") ?? "";
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
    async itemFlagOn() {
      const { data, error } = await supabase.rpc("context_ghl_item_flag");
      return !error && data?.enabled === true;
    },
    async laneOn(lane) {
      const { data, error } = await supabase.rpc("automation_lane_enabled", {
        lane,
      });
      return !error && data === true;
    },
    async latestRun(source) {
      const { data, error } = await supabase.from("context_capture_runs")
        .select("id,status,updated_at,cursor")
        .eq("source", source)
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) {
        throw Object.assign(new Error("runs_unreadable"), {
          code: "runs_unreadable",
        });
      }
      return ((data ?? [])[0] ?? null) as RunRow | null;
    },
    async recordRun(run) {
      const { data, error } = await supabase.rpc("record_capture_run", {
        p_run: run,
      });
      if (error || typeof data?.run_id !== "string") {
        throw refusal(error, "record_capture_run_failed");
      }
      return data.run_id;
    },
    async due(maxJobs) {
      const { data, error } = await supabase.rpc("context_ghl_history_due", {
        p_max_jobs: maxJobs,
      });
      if (error || !data || typeof data !== "object") {
        throw refusal(error, "history_due_unreadable");
      }
      return data as DueList;
    },
    async reserve(maxJobs, actor) {
      const { data, error } = await supabase.rpc("reserve_ghl_history_run", {
        p_max_jobs: maxJobs,
        p_actor: actor,
      });
      if (
        error || !data || typeof data !== "object" ||
        typeof data.run_id !== "string" ||
        (data.outcome !== "reserved" && data.outcome !== "run_in_progress")
      ) {
        throw refusal(error, "history_reserve_failed");
      }
      return data;
    },
    async recordContact(row) {
      const { error } = await supabase.rpc("record_ghl_history_contact", {
        p_row: row,
      });
      if (error) throw refusal(error, "history_contact_write_failed");
    },
    async listConversations({ contactId, limit, startAfterDate }) {
      const params: Record<string, string> = {
        contact_id: contactId,
        limit: String(limit),
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
        hasMore: result.pagination?.has_more ?? null,
        nextStartAfterDate: typeof next?.start_after_date === "string"
          ? next.start_after_date
          : null,
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
        .select("provider_message_id,event_at")
        .in("provider_message_id", keys);
      if (error) {
        throw Object.assign(new Error("precheck_failed"), {
          code: "precheck_failed",
        });
      }
      return new Map(
        (data ?? []).map((
          r: { provider_message_id: string; event_at: string | null },
        ) => [r.provider_message_id, r.event_at]),
      );
    },
    pairLegacyCall: (row) => pairLegacyCall(supabase, row),
    async capture(row): Promise<HistoryCaptureOutcome> {
      try {
        const { data, error } = await supabase.rpc(
          "capture_ghl_history_event",
          { p_row: row },
        );
        if (error) return { outcome: "error", code: code(error) };
        if (!data || typeof data !== "object") {
          return { outcome: "error", code: "rpc_no_result" };
        }
        return data as HistoryCaptureOutcome;
      } catch {
        return { outcome: "error", code: "rpc_threw" };
      }
    },
  };
}

/** The link action's reads and writes, over one service-role client. */
export function liveLinkDeps(deps: HandlerDeps): LinkDeps {
  const history = liveHistoryDeps(deps);
  const supabase = deps.createSupabase();
  const locationId = deps.env("GHL_LOCATION_ID") ?? "";
  const token = deps.env("GHL_API_TOKEN") ?? "";
  return {
    now: history.now,
    latestRun: history.latestRun,
    recordRun: history.recordRun,
    async candidates(after, limit) {
      const { data, error } = await supabase.rpc(
        "context_ghl_history_link_candidates",
        { p_after: after, p_limit: limit },
      );
      if (error || !Array.isArray(data)) {
        throw refusal(error, "history_link_candidates_unreadable");
      }
      return data as LinkCandidate[];
    },
    async searchContacts(query, limit) {
      const contacts: Record<string, unknown>[] = [];
      const params = new URLSearchParams({ query, limit: String(limit) });
      for (let page = 0; page < 5; page++) {
        const result = await readGhlProvider(
          "list_ghl_contacts",
          params,
          { locationId, token, fetchFn: deps.fetch },
        );
        contacts.push(
          ...((result.data.contacts ?? []) as Record<string, unknown>[]),
        );
        if (result.pagination?.has_more === false) {
          return { contacts, complete: true };
        }
        const cursor = result.pagination?.next_cursor;
        if (!cursor?.start_after || !cursor.start_after_id) break;
        params.set("start_after", String(cursor.start_after));
        params.set("start_after_id", String(cursor.start_after_id));
      }
      return { contacts, complete: false };
    },
    async link(row): Promise<LinkWriteOutcome> {
      try {
        const { data, error } = await supabase.rpc("link_job_ghl_contact", {
          p_row: row,
        });
        if (error) return { outcome: "error", code: code(error) };
        if (!data || typeof data !== "object") {
          return { outcome: "error", code: "rpc_no_result" };
        }
        return data as LinkWriteOutcome;
      } catch {
        return { outcome: "error", code: "rpc_threw" };
      }
    },
  };
}

function logLink(result: LinkResult, actor: string): void {
  if (result.outcome === "ran") {
    const c = result.counts;
    console.log(
      `[ghl-history-load] link run=${result.run_id} dry_run=${result.dry_run} actor=${actor} status=${result.status} error=${
        result.error_code ?? "-"
      } considered=${c.jobs_considered} certain=${c.certain} ambiguous=${c.ambiguous} none=${c.none} failed=${c.failed} linked=${c.linked} already_linked=${c.already_linked} backlog=${c.backlog_jobs}`,
    );
  } else {
    console.log(`[ghl-history-load] link ${result.outcome} actor=${actor}`);
  }
}

function logResult(result: HistoryResult, actor: string): void {
  if (result.outcome === "ran") {
    const c = result.counts;
    console.log(
      `[ghl-history-load] run=${result.run_id} dry_run=${result.dry_run} actor=${actor} status=${result.status} error=${
        result.error_code ?? "-"
      } contacts=${result.contacts.length} jobs_covered=${c.jobs_covered} inserted=${c.inserted} would_insert=${c.would_insert} duplicates=${c.duplicates} placed=${c.placed_on_job} pending_review=${c.pending_review} unplaced=${c.unplaced} bucket=${c.admin_bucket} calls_paired_legacy=${c.calls_paired_legacy} backlog=${c.backlog_contacts}`,
    );
  } else {
    console.log(`[ghl-history-load] ${result.outcome} actor=${actor}`);
  }
}

export async function handleHistoryLoad(
  req: Request,
  deps: HandlerDeps,
  run: (d: HistoryDeps, r: HistoryRequest) => Promise<HistoryResult> =
    runGhlHistoryLoad,
  runLink: typeof runGhlContactLink = runGhlContactLink,
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
    // An empty or non-JSON body is a plain dry run request.
  }
  const actor = resolveRequestActor({
    headers: req.headers,
    trustActorHeader: true,
  }).actor;
  const action = body.action === undefined ? "load" : body.action;
  if (action !== "load" && action !== "link") {
    return json({ error: "unknown_action" }, 400);
  }
  const request = action === "link"
    ? parseLinkRequest(body, actor)
    : parseRequest(body, actor);

  const execute = async (): Promise<
    HistoryResult | LinkResult | { outcome: "error"; code: string }
  > => {
    try {
      if (action === "link") {
        const linked = await runLink(liveLinkDeps(deps), request);
        logLink(linked, actor);
        return linked;
      }
      const result = await run(
        liveHistoryDeps(deps),
        request as HistoryRequest,
      );
      logResult(result, actor);
      return result;
    } catch (error) {
      const c = error instanceof GhlProviderReadError
        ? error.code
        : code(error);
      console.error(
        `[ghl-history-load] ${action} run failed code=${c} actor=${actor}`,
      );
      return { outcome: "error", code: c };
    }
  };

  if (body.wait === true || !deps.waitUntil) {
    const result = await execute();
    return json(
      { action, dry_run: request.dryRun, ...result },
      result.outcome === "error" ? 500 : 200,
    );
  }
  deps.waitUntil(execute());
  return json({ accepted: true, action, dry_run: request.dryRun }, 202);
}
