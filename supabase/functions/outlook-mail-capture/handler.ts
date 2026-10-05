// HTTP door and wiring for the email reader (slice EM2). The run itself is
// capture.ts; this file checks the caller, wires the real reads and writes,
// and keeps the worker alive while the run finishes.
//
// Callers: pg_cron (EM3: trigger_context_email_poll every 5 minutes,
// trigger_context_email_sweep at 02:00 Perth, both idle until flag
// email_reader_schedule_v1 is on) with the service key, or an operator with
// the server key (x-api-key: SW_API_KEY) for a one-mailbox proof run. Nothing
// else is accepted: the service role (the exact SUPABASE_SERVICE_ROLE_KEY or a
// JWT whose role claim is exactly service_role) or the exact server key.
//
// Body: {"mode": "poll" | "sweep" | "history", "source": "<source_key>",
// "from": ISO, "to": ISO (history), "wait": true}. Default mode poll. The
// cron's HTTP call gives up after 5 seconds, so by default the run continues
// in the background (EdgeRuntime.waitUntil) and the reply is 202; {"wait": true}
// returns the run summary (codes and counts only).

import { isServiceRoleJwt } from "../_shared/service_role_jwt.ts";
import {
  ATTACHMENT_POLICY,
  type AttachmentLedgerRow,
  sha256Hex,
  storeEmailAttachments,
} from "./attachments.ts";
import {
  type CaptureDeps,
  type CaptureOutcome,
  type CaptureRequest,
  type CaptureResult,
  type Mode,
  runOutlookCapture,
  type RunRow,
  safeCode,
  type SourceRow,
} from "./capture.ts";
import * as graph from "./graph.ts";

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

function dbError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function textSet(data: unknown): Set<string> {
  return new Set(
    (Array.isArray(data) ? data : []).filter((x): x is string =>
      typeof x === "string" && x !== ""
    )
      .map((x) => x.toLowerCase()),
  );
}

/** The real reads and writes, over one service-role client. */
export function liveCaptureDeps(deps: HandlerDeps): CaptureDeps {
  const supabase = deps.createSupabase();
  const fetchFn = deps.fetch ?? fetch;
  const g: graph.GraphDeps = {
    fetch: fetchFn,
    token: graph.graphTokenSource(deps.env, fetchFn),
  };
  const attachmentDeps = {
    list: (home: graph.AttachmentHome) => graph.listAttachments(g, home),
    bytes: (home: graph.AttachmentHome, id: string, max: number) =>
      graph.attachmentBytes(g, home, id, max),
    async existing(providerMessageId: string) {
      const { data, error } = await supabase.from("context_email_attachments")
        .select("attachment_key").eq("provider_message_id", providerMessageId);
      if (error) throw dbError("attachment_ledger_unreadable");
      return new Set<string>(
        (data ?? []).map((r: { attachment_key: string }) => r.attachment_key),
      );
    },
    async upload(path: string, bytes: Uint8Array, contentType: string) {
      const { error } = await supabase.storage.from(ATTACHMENT_POLICY.bucket)
        .upload(path, bytes, { contentType, upsert: false });
      // An object already at the path is the same attachment stored by an earlier read.
      if (
        error &&
        !/exist|duplicate|409/i.test(
          `${error.statusCode ?? ""} ${error.message ?? ""}`,
        )
      ) {
        throw dbError("attachment_upload_failed");
      }
    },
    async record(row: AttachmentLedgerRow) {
      const { error } = await supabase.from("context_email_attachments")
        .upsert(row, {
          onConflict: "provider_message_id,attachment_key",
          ignoreDuplicates: true,
        });
      if (error) throw dbError("attachment_ledger_write_failed");
    },
  };
  return {
    now: deps.now ?? (() => Date.now()),
    async flags() {
      const { data, error } = await supabase.rpc("context_email_reader_flags");
      if (error || !data) return { reader: false, program: false };
      return { reader: data.reader === true, program: data.program === true };
    },
    async captureLaneOn() {
      const { data, error } = await supabase.rpc("automation_lane_enabled", {
        lane: "capture",
      });
      return !error && data === true;
    },
    async sources() {
      const { data, error } = await supabase.from("monitored_mailboxes")
        .select("email,source_key,kind,scope_label,owner_privacy")
        .eq("enabled", true).eq("status", "active").order("source_key");
      if (error) throw dbError("sources_unreadable");
      return (data ?? []) as SourceRow[];
    },
    async supplierDomains() {
      const { data, error } = await supabase.rpc(
        "context_email_supplier_domains",
      );
      if (error) throw dbError("suppliers_unreadable");
      return textSet(data);
    },
    async jobClientEmails() {
      const { data, error } = await supabase.rpc(
        "context_email_job_client_emails",
      );
      if (error) throw dbError("job_emails_unreadable");
      return textSet(data);
    },
    async historyScope() {
      const { data, error } = await supabase.rpc("context_email_history_scope");
      if (error || !data) throw dbError("history_scope_unreadable");
      return {
        jobNumbers: new Set(
          (Array.isArray(data.job_numbers) ? data.job_numbers : [])
            .filter((x: unknown): x is string => typeof x === "string").map((
              x: string,
            ) => x.toUpperCase()),
        ),
        clientEmails: textSet(data.client_emails),
      };
    },
    async latestRuns(runSource, limit) {
      const { data, error } = await supabase.from("context_capture_runs")
        .select(
          "id,status,started_at,updated_at,window_to,window_end_id,cursor",
        )
        .eq("source", runSource).order("started_at", { ascending: false })
        .limit(limit);
      if (error) throw dbError("runs_unreadable");
      return (data ?? []) as RunRow[];
    },
    async recordRun(run) {
      const { data, error } = await supabase.rpc("record_capture_run", {
        p_run: run,
      });
      if (error || typeof data?.run_id !== "string") {
        throw dbError(
          error?.message?.match(/capture_run_[a-z_]+/)?.[0] ??
            "record_capture_run_failed",
        );
      }
      return data.run_id;
    },
    async capture(row): Promise<CaptureOutcome> {
      try {
        const { data, error } = await supabase.rpc("capture_business_event", {
          p_row: row,
        });
        if (error) return { outcome: "error", code: safeCode(error) };
        if (!data || typeof data !== "object") {
          return { outcome: "error", code: "rpc_no_result" };
        }
        return data as CaptureOutcome;
      } catch {
        return { outcome: "error", code: "rpc_threw" };
      }
    },
    async legacyCopy({ from, receivedAt, subject }) {
      const { data, error } = await supabase.rpc("context_email_legacy_copy", {
        p_from: from,
        p_received_at: receivedAt,
        p_subject: subject,
      });
      if (error) throw dbError("legacy_copy_unreadable");
      return typeof data === "string" && data !== "" ? data : null;
    },
    mail: {
      folderIds: (m) => graph.folderIds(g, m),
      listMessages: (m, a) => graph.listMessages(g, m, a),
      messageDetail: (m, id) => graph.messageDetail(g, m, id),
      resolveGroupId: (m) => graph.resolveGroupId(g, m),
      listGroupConversations: (id, next) =>
        graph.listGroupConversations(g, id, next),
      listGroupThreads: (id, c) => graph.listGroupThreads(g, id, c),
      listGroupPosts: (id, t, topic) => graph.listGroupPosts(g, id, t, topic),
    },
    storeAttachments: (args) => storeEmailAttachments(attachmentDeps, args),
    hash: async (text) => (await sha256Hex(text)).slice(0, 16),
  };
}

function logResult(result: CaptureResult): void {
  if (result.outcome !== "ran") {
    console.log(
      `[outlook-mail-capture] ${result.outcome} ${
        "reason" in result ? result.reason : result.code
      }`,
    );
    return;
  }
  for (const s of result.sources) {
    const c = s.counts ?? {};
    console.log(
      `[outlook-mail-capture] mode=${result.mode} source=${s.source_key} ${s.outcome} run=${
        s.run_id ?? "-"
      } status=${s.status ?? "-"} error=${s.error_code ?? "-"} seen=${
        c.seen ?? 0
      } inserted=${c.inserted ?? 0} duplicates=${
        c.duplicates ?? 0
      } attachments=${c.attachments_stored ?? 0}`,
    );
  }
  if (result.not_reached.length) {
    console.log(
      `[outlook-mail-capture] not_reached=${result.not_reached.length}`,
    );
  }
}

const MODES: Mode[] = ["poll", "sweep", "history"];

export async function handleCapture(
  req: Request,
  deps: HandlerDeps,
  run: (d: CaptureDeps, r: CaptureRequest) => Promise<CaptureResult> =
    runOutlookCapture,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const serverKey = deps.env("SW_API_KEY") ?? "";
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const apiKey = req.headers.get("x-api-key") ?? "";
  const allowed = (!!bearer &&
    ((!!serviceKey && sameSecret(bearer, serviceKey)) ||
      isServiceRoleJwt(bearer))) ||
    (!!apiKey && !!serverKey && sameSecret(apiKey, serverKey));
  if (!allowed) return json({ error: "service_key_required" }, 401);

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // An empty or non-JSON body is a plain poll.
  }
  const mode = (body.mode ?? "poll") as Mode;
  if (!MODES.includes(mode)) return json({ error: "mode_invalid" }, 400);
  const request: CaptureRequest = {
    mode,
    source: typeof body.source === "string" ? body.source : null,
    from: typeof body.from === "string" ? body.from : null,
    to: typeof body.to === "string" ? body.to : null,
  };

  const execute = async (): Promise<
    CaptureResult | { outcome: "error"; code: string }
  > => {
    try {
      const result = await run(liveCaptureDeps(deps), request);
      logResult(result);
      return result;
    } catch (error) {
      const c = safeCode(error);
      console.error(`[outlook-mail-capture] run failed code=${c}`);
      return { outcome: "error", code: c };
    }
  };

  if (body.wait === true || !deps.waitUntil) {
    const result = await execute();
    const status = result.outcome === "error"
      ? 500
      : result.outcome === "refused"
      ? 400
      : 200;
    return json(result, status);
  }
  deps.waitUntil(execute());
  return json({ accepted: true, mode }, 202);
}
