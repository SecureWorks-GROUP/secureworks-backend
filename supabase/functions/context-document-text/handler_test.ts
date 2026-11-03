// The document text reader's HTTP door (gap plan B-5): service role only, a
// background run for the cron, a foreground run on request, a read-only
// preview, and the storage wiring's missing-object rule. No network.

// deno-lint-ignore no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleDocumentText, type HandlerDeps, type Runners } from "./handler.ts";

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
