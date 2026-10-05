// The document text reader's HTTP door (gap plan B-5): service role only, a
// background run for the cron, a foreground run on request, a read-only
// preview, and the storage wiring's missing-object rule. No network.

// deno-lint-ignore no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  handleDocumentText,
  type HandlerDeps,
  liveDeps,
  type Runners,
  storageMissing,
} from "./handler.ts";

const KEY = "service-role-key-fixture";

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const SERVICE_JWT = `${b64url('{"alg":"HS256"}')}.${
  b64url('{"role":"service_role"}')
}.sig`;
const ANON_JWT = `${b64url('{"alg":"HS256"}')}.${
  b64url('{"role":"anon"}')
}.sig`;

function deps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    env: (name) =>
      ({
        SUPABASE_SERVICE_ROLE_KEY: KEY,
        SUPABASE_URL: "https://kevgrhcjxspbxgovpmfl.supabase.co",
      })[name],
    createSupabase: () => ({}),
    extract: () => Promise.reject(new Error("not called")),
    ...over,
  };
}

function req(
  body: unknown,
  bearer: string | null = KEY,
  method = "POST",
): Request {
  return new Request("http://local/context-document-text", {
    method,
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function runners(log: string[]): Runners {
  return {
    run: () => {
      log.push("run");
      return Promise.resolve({ outcome: "idle", reason: "flag_off" });
    },
    preview: (_d, limit) => {
      log.push(`preview:${limit}`);
      return Promise.resolve({
        outcome: "preview",
        flag_on: false,
        lane_on: true,
        due: [],
      });
    },
  };
}

Deno.test("door: only the service role, only POST", async () => {
  const log: string[] = [];
  assertEquals(
    (await handleDocumentText(req({}, null), deps(), runners(log))).status,
    401,
  );
  assertEquals(
    (await handleDocumentText(req({}, "wrong"), deps(), runners(log))).status,
    401,
  );
  assertEquals(
    (await handleDocumentText(req({}, ANON_JWT), deps(), runners(log))).status,
    401,
  );
  assertEquals(
    (await handleDocumentText(req({}, KEY, "GET"), deps(), runners(log)))
      .status,
    405,
  );
  assertEquals(log, []);
  // pg_cron's service-role JWT is accepted.
  const ok = await handleDocumentText(
    req({ wait: true }, SERVICE_JWT),
    deps(),
    runners(log),
  );
  assertEquals(ok.status, 200);
  assertEquals(log, ["run"]);
});

Deno.test("door: the cron's call returns 202 and the run continues in the background", async () => {
  const log: string[] = [];
  const kept: Promise<unknown>[] = [];
  const res = await handleDocumentText(
    req({ actor: "cron:context-document-text" }),
    deps({ waitUntil: (p) => kept.push(p) }),
    runners(log),
  );
  assertEquals(res.status, 202);
  await Promise.all(kept);
  assertEquals(log, ["run"]);
});

Deno.test("door: preview is read only and bounded", async () => {
  const log: string[] = [];
  const res = await handleDocumentText(
    req({ mode: "preview", limit: 5 }),
    deps(),
    runners(log),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).mode, "preview");
  assertEquals(log, ["preview:5"]);
  assertEquals(
    (await handleDocumentText(
      req({ mode: "preview", limit: 500 }),
      deps(),
      runners(log),
    )).status,
    400,
  );
  assertEquals(
    (await handleDocumentText(req({ mode: "history" }), deps(), runners(log)))
      .status,
    400,
  );
});

Deno.test("door: a run that throws answers 500 with its code only", async () => {
  const res = await handleDocumentText(req({ wait: true }), deps(), {
    run: () =>
      Promise.reject(
        Object.assign(new Error("secret words"), { code: "policy_unreadable" }),
      ),
    preview: () => Promise.reject(new Error("unused")),
  });
  assertEquals(res.status, 500);
  assertEquals(await res.json(), {
    flag: "context_document_text_v1",
    mode: "run",
    outcome: "error",
    code: "policy_unreadable",
  });
});

Deno.test("storage: a missing object is terminal, any other fault is retried", () => {
  assertEquals(
    storageMissing({ statusCode: "404", message: "Object not found" }),
    true,
  );
  assertEquals(storageMissing({ status: 400, message: "Bad Request" }), true);
  assertEquals(storageMissing({ message: "The resource was not found" }), true);
  assertEquals(storageMissing({ status: 503, message: "upstream" }), false);
  assertEquals(storageMissing(null), false);
});

Deno.test("wiring: download, flag and re-list go through the service client", async () => {
  const calls: unknown[] = [];
  const client = {
    rpc: (name: string, args?: unknown) => {
      calls.push([name, args]);
      if (name === "context_document_text_flag") {
        return Promise.resolve({ data: { enabled: true }, error: null });
      }
      if (name === "context_catchup_list_backfill") {
        return Promise.resolve({ data: { listed_this_call: 3 }, error: null });
      }
      return Promise.resolve({ data: null, error: { message: "no" } });
    },
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => {
          calls.push(["download", bucket, path]);
          if (path === "gone.pdf") {
            return Promise.resolve({
              data: null,
              error: { statusCode: "404", message: "Object not found" },
            });
          }
          return Promise.resolve({
            data: new Blob([new Uint8Array([37, 80, 68, 70])]),
            error: null,
          });
        },
      }),
    },
  };
  const live = liveDeps(deps({ createSupabase: () => client }));
  assertEquals(await live.flagOn(), true);
  const got = await live.download("job-documents", "a/b.pdf");
  assertEquals(got.ok && Array.from(got.bytes), [37, 80, 68, 70]);
  assertEquals(await live.download("job-documents", "gone.pdf"), {
    ok: false,
    code: "missing",
    missing: true,
  });
  assertEquals(
    await live.relistBackfill(
      "context-document-text",
      "2026-10-04T00:00:00.000Z",
      2,
    ),
    { listed: 3 },
  );
  assertEquals(
    calls.find((c) => (c as unknown[])[0] === "context_catchup_list_backfill"),
    [
      "context_catchup_list_backfill",
      {
        p_source: "context-document-text",
        p_since: "2026-10-04T00:00:00.000Z",
        p_dry_run: false,
        p_limit: 500,
        p_priority: 2,
      },
    ],
  );
  // The writer's refusal code comes back as the record error.
  assertEquals(
    await live.record({
      source_kind: "job_document",
      source_id: "x",
      job_id: "y",
      fingerprint: "z",
      file_kind: "pdf",
      result: "no_file",
    }),
    { error: "record_failed" },
  );
});
