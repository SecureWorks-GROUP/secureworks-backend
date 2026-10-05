// HTTP door and wiring for the document text reader (gap plan B-5). The run
// itself is read.ts; this file checks the caller, wires the real reads and
// writes, and keeps the worker alive while a run finishes.
//
// Callers (service role only: the exact SUPABASE_SERVICE_ROLE_KEY, or a JWT
// whose role claim is exactly "service_role", as pg_cron's sw_service_key()
// is; JWT verification stays on at the platform):
//   * pg_cron's trigger_context_document_text() every 10 minutes, only while
//     the flag context_document_text_v1 is on. The cron's HTTP call gives up
//     after 5 seconds, so the run continues in the background
//     (EdgeRuntime.waitUntil) and the reply is 202. {"wait": true} runs in the
//     foreground and returns the summary (ids, counts and codes only).
//   * {"mode": "preview", "limit": 20}: read only. The documents a run would
//     take now and how each would be read; no download, no write; works while
//     the flag is off.
//
// Bytes are read only from this project's own storage (service client
// download); no other URL is ever fetched. Logs carry codes, counts and ids
// only, never words.

import { isServiceRoleJwt } from "../_shared/service_role_jwt.ts";
import {
  type CaptureOutcome,
  type Download,
  type DueDocument,
  FLAG,
  type PdfText,
  previewDocumentText,
  type ReaderDeps,
  type ReaderPolicy,
  runDocumentText,
  type RunResult,
} from "./read.ts";

export interface HandlerDeps {
  env(name: string): string | undefined;
  // deno-lint-ignore no-explicit-any
  createSupabase(): any;
  /** The bounded PDF text layer extractor (ops-api/makesafe_pdf_text.ts). */
  extract(bytes: Uint8Array): Promise<PdfText>;
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

function raise(c: string): never {
  throw Object.assign(new Error(c), { code: c });
}

/** A storage error that means the object is not there (never retried). */
export function storageMissing(error: unknown): boolean {
  const e = error as
    | { status?: unknown; statusCode?: unknown; message?: unknown }
    | null;
  const status = Number(e?.statusCode ?? e?.status);
  if (status === 404 || status === 400) return true;
  return /not\s*found|does not exist/i.test(String(e?.message ?? ""));
}

/** The real reads and writes, over one service-role client. */
export function liveDeps(deps: HandlerDeps): ReaderDeps {
  const supabase = deps.createSupabase();
  return {
    now: deps.now ?? (() => Date.now()),
    supabaseUrl: deps.env("SUPABASE_URL") ?? "",
    async flagOn() {
      // The database's own reader of the flag (fails closed: missing,
      // unreadable or an error is off).
      const { data, error } = await supabase.rpc("context_document_text_flag");
      return !error && data?.enabled === true;
    },
    async laneOn() {
      const { data, error } = await supabase.rpc("automation_lane_enabled", {
        lane: "capture",
      });
      return !error && data === true;
    },
    async policy() {
      const { data, error } = await supabase.rpc(
        "context_document_text_policy",
      );
      if (error || !data || typeof data !== "object") {
        raise("policy_unreadable");
      }
      return data as ReaderPolicy;
    },
    async latestRun(source) {
      const { data, error } = await supabase.from("context_capture_runs")
        .select("id,status,started_at")
        .eq("source", source)
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) raise("runs_unreadable");
      return data?.[0] ?? null;
    },
    async recordRun(run) {
      const { data, error } = await supabase.rpc("record_capture_run", {
        p_run: run,
      });
      if (error || typeof data?.run_id !== "string") {
        raise(
          error?.message?.match(/capture_run_[a-z_]+/)?.[0] ??
            "record_capture_run_failed",
        );
      }
      return data.run_id;
    },
    async dueDocuments(limit) {
      const { data, error } = await supabase.rpc("context_document_text_due", {
        p_limit: limit,
      });
      if (error) raise("due_documents_unreadable");
      return (data ?? []) as DueDocument[];
    },
    async download(bucket, path): Promise<Download> {
      try {
        const { data, error } = await supabase.storage.from(bucket).download(
          path,
        );
        if (error) {
          return {
            ok: false,
            code: storageMissing(error) ? "missing" : "storage_error",
            missing: storageMissing(error),
          };
        }
        if (!data) return { ok: false, code: "empty", missing: true };
        return { ok: true, bytes: new Uint8Array(await data.arrayBuffer()) };
      } catch {
        return { ok: false, code: "transport", missing: false };
      }
    },
    extract: (bytes) => deps.extract(bytes),
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
    async record(rec) {
      try {
        const { data, error } = await supabase.rpc(
          "record_context_document_text",
          { p: rec },
        );
        if (error) {
          return {
            error: error.message?.match(/document_text_[a-z_0-9]+/)?.[0] ??
              "record_failed",
          };
        }
        return { outcome: String(data?.outcome ?? "unknown") };
      } catch {
        return { error: "record_threw" };
      }
    },
    async relistBackfill(source, since, priority) {
      // The one history re-list (B-1, context_catchup_list_backfill): lists
      // for reading every job holding this reader's backfill rows.
      try {
        const { data, error } = await supabase.rpc(
          "context_catchup_list_backfill",
          {
            p_source: source,
            p_since: since,
            p_dry_run: false,
            p_limit: 500,
            p_priority: priority,
          },
        );
        if (error) return { error: "relist_failed" };
        return { listed: Number(data?.listed_this_call ?? 0) || 0 };
      } catch {
        return { error: "relist_threw" };
      }
    },
  };
}

function logRun(result: RunResult): void {
  if (result.outcome === "ran") {
    const c = result.counts;
    console.log(
      `[context-document-text] run=${result.run_id} status=${result.status} error=${
        result.error_code ?? "-"
      } selected=${c.selected} saved=${c.saved} duplicate=${c.duplicate} live=${c.live_saved} backfill=${c.backfill_saved} no_text_layer=${c.no_text_layer} image=${c.image} not_supported=${c.not_supported} no_file=${c.no_file} errors=${c.errors} relisted_jobs=${c.relisted_jobs}`,
    );
  } else {
    console.log(`[context-document-text] ${result.outcome}`);
  }
}

export interface Runners {
  run: typeof runDocumentText;
  preview: typeof previewDocumentText;
}

export async function handleDocumentText(
  req: Request,
  deps: HandlerDeps,
  runners: Runners = { run: runDocumentText, preview: previewDocumentText },
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
    // An empty or non-JSON body is a plain run request.
  }

  if (body.mode === "preview") {
    if (
      body.limit !== undefined &&
      !(typeof body.limit === "number" && Number.isInteger(body.limit) &&
        body.limit >= 1 && body.limit <= 100)
    ) return json({ error: "limit_invalid" }, 400);
    const limit = typeof body.limit === "number" ? body.limit : 20;
    try {
      const result = await runners.preview(liveDeps(deps), limit);
      console.log(`[context-document-text] preview due=${result.due.length}`);
      return json({ flag: FLAG, mode: "preview", ...result });
    } catch (error) {
      const c = code(error);
      console.error(`[context-document-text] preview failed code=${c}`);
      return json({ mode: "preview", outcome: "error", code: c }, 500);
    }
  }
  if (body.mode !== undefined && body.mode !== "run") {
    return json({ error: "mode_invalid" }, 400);
  }

  const execute = async (): Promise<
    RunResult | { outcome: "error"; code: string }
  > => {
    try {
      const result = await runners.run(liveDeps(deps));
      logRun(result);
      return result;
    } catch (error) {
      const c = code(error);
      console.error(`[context-document-text] run failed code=${c}`);
      return { outcome: "error", code: c };
    }
  };
  if (body.wait === true || !deps.waitUntil) {
    const result = await execute();
    return json(
      { flag: FLAG, mode: "run", ...result },
      result.outcome === "error" ? 500 : 200,
    );
  }
  deps.waitUntil(execute());
  return json({ accepted: true }, 202);
}
