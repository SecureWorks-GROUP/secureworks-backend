// HTTP door and wiring for the vision reader (gap plan B-5b). The logic is
// vision.ts; this file checks the caller and wires the real reads and writes.
//
// Caller: the Luna context worker (secureworks-jarvis), the one process that
// holds the model login the context reader already uses. Service role only:
// the exact SUPABASE_SERVICE_ROLE_KEY, or a JWT whose role claim is exactly
// "service_role" (JWT verification stays on at the platform). Modes:
//   * {"mode": "preview", "limit": 20}: read only, works with the flag off.
//   * {"mode": "next"}: the next document's pictures, after one call is
//     reserved on the shared daily budget; or why nothing was handed out.
//   * {"mode": "submit", "reservation_id", "model", "answer"} or
//     {"mode": "submit", "reservation_id", "error": "<code>"}: the answer.
// No model is called here. Bytes are read only from this project's own
// storage. Logs carry codes, counts and ids only, never words.

import { isServiceRoleJwt } from "../_shared/service_role_jwt.ts";
import {
  sameSecret,
  storageMissing,
} from "../context-document-text/handler.ts";
import type { DueDocument } from "../context-document-text/read.ts";
import {
  type CaptureOutcome,
  type ClaimOutcome,
  type Download,
  FLAG,
  type LeasedDocument,
  nextDocument,
  previewVision,
  submitReading,
  type VisionDeps,
  type VisionPolicy,
} from "./vision.ts";

export interface HandlerDeps {
  env(name: string): string | undefined;
  // deno-lint-ignore no-explicit-any
  createSupabase(): any;
  /** Page count of a PDF (unpdf, as the text reader uses), or null. */
  pageCount(bytes: Uint8Array): Promise<number | null>;
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
    return e.code.toLowerCase();
  }
  return "error";
}

function raise(c: string): never {
  throw Object.assign(new Error(c), { code: c });
}

/** The real reads and writes, over one service-role client. */
export function liveDeps(deps: HandlerDeps): VisionDeps {
  const supabase = deps.createSupabase();
  return {
    now: deps.now ?? (() => Date.now()),
    supabaseUrl: deps.env("SUPABASE_URL") ?? "",
    async flagOn() {
      const { data, error } = await supabase.rpc(
        "context_document_vision_flag",
      );
      return !error && data?.enabled === true;
    },
    async laneOn() {
      // Capture (it writes evidence) and extraction (it spends a model call).
      const [capture, extraction] = await Promise.all(
        ["capture", "extraction"].map((lane) =>
          supabase.rpc("automation_lane_enabled", { lane })
        ),
      );
      return !capture.error && capture.data === true && !extraction.error &&
        extraction.data === true;
    },
    async policy() {
      const { data, error } = await supabase.rpc(
        "context_document_vision_policy",
      );
      if (error || !data || typeof data !== "object") {
        raise("policy_unreadable");
      }
      return data as VisionPolicy;
    },
    async admission() {
      const { data, error } = await supabase.rpc(
        "context_document_vision_admission",
      );
      if (error || !data || typeof data !== "object") {
        return { open: false, code: "admission_unreadable" };
      }
      return {
        open: data.open === true,
        ...(typeof data.code === "string" ? { code: data.code } : {}),
      };
    },
    async dueDocuments(limit) {
      const { data, error } = await supabase.rpc(
        "context_document_vision_due",
        { p_limit: limit },
      );
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
    pageCount: (bytes) => deps.pageCount(bytes),
    async claim(req): Promise<ClaimOutcome> {
      const { data, error } = await supabase.rpc(
        "claim_context_document_vision",
        { p: req },
      );
      if (error) {
        return {
          outcome: "error",
          code: error.message?.match(/document_vision_[a-z_0-9]+/)?.[0] ??
            "claim_failed",
        };
      }
      return (data ??
        { outcome: "error", code: "claim_no_result" }) as ClaimOutcome;
    },
    async leased(reservationId) {
      const { data, error } = await supabase.rpc(
        "context_document_vision_leased",
        { p_reservation_id: reservationId },
      );
      if (error) raise("lease_unreadable");
      const row = Array.isArray(data) ? data[0] : null;
      return (row ?? null) as LeasedDocument | null;
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
    async record(rec) {
      try {
        const { data, error } = await supabase.rpc(
          "record_context_document_vision",
          { p: rec },
        );
        if (error) {
          return {
            error: error.message?.match(/document_vision_[a-z_0-9]+/)?.[0] ??
              "record_failed",
          };
        }
        return { outcome: String(data?.outcome ?? "unknown") };
      } catch {
        return { error: "record_threw" };
      }
    },
    async relistBackfill(source, since, priority) {
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

export interface Runners {
  next: typeof nextDocument;
  submit: typeof submitReading;
  preview: typeof previewVision;
}

export async function handleDocumentVision(
  req: Request,
  deps: HandlerDeps,
  runners: Runners = {
    next: nextDocument,
    submit: submitReading,
    preview: previewVision,
  },
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
    return json({ error: "body_invalid" }, 400);
  }

  try {
    if (body.mode === "preview") {
      if (
        body.limit !== undefined &&
        !(typeof body.limit === "number" && Number.isInteger(body.limit) &&
          body.limit >= 1 && body.limit <= 100)
      ) return json({ error: "limit_invalid" }, 400);
      const limit = typeof body.limit === "number" ? body.limit : 20;
      const result = await runners.preview(liveDeps(deps), limit);
      console.log(
        `[context-document-vision] preview due=${result.due.length} open=${result.admission.open}`,
      );
      return json({ flag: FLAG, mode: "preview", ...result });
    }
    if (body.mode === "next") {
      const result = await runners.next(liveDeps(deps));
      const recorded = "recorded" in result ? result.recorded.length : 0;
      console.log(
        `[context-document-vision] next outcome=${result.outcome} recorded=${recorded}${
          result.outcome === "claimed"
            ? ` reservation=${result.reservation_id} images=${result.images.length}`
            : ""
        }${"code" in result ? ` code=${result.code}` : ""}`,
      );
      return json({ flag: FLAG, mode: "next", ...result });
    }
    if (body.mode === "submit") {
      const result = await runners.submit(liveDeps(deps), body);
      console.log(
        `[context-document-vision] submit outcome=${result.outcome}${
          "code" in result && result.code ? ` code=${result.code}` : ""
        }`,
      );
      if (result.outcome === "refused") {
        return json(
          { flag: FLAG, mode: "submit", outcome: "refused", code: result.code },
          result.status,
        );
      }
      return json({ flag: FLAG, mode: "submit", ...result });
    }
    return json({ error: "mode_invalid" }, 400);
  } catch (error) {
    const c = code(error);
    console.error(`[context-document-vision] failed code=${c}`);
    return json({ outcome: "error", code: c }, 500);
  }
}
