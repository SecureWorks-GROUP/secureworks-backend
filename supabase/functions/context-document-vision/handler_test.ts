// The vision reader's HTTP door (gap plan B-5b): service role only, the three
// modes, and the RPC wiring (names and arguments). No network.

// deno-lint-ignore no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleDocumentVision, type HandlerDeps, type Runners } from "./handler.ts";

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

// deno-lint-ignore no-explicit-any
function deps(supabase: any = {}): HandlerDeps {
  return {
    env: (name) =>
      ({
        SUPABASE_SERVICE_ROLE_KEY: KEY,
        SUPABASE_URL: "https://kevgrhcjxspbxgovpmfl.supabase.co",
      })[name],
    createSupabase: () => supabase,
    pageCount: () => Promise.resolve(null),
  };
}

function req(body: unknown, bearer: string | null = KEY, method = "POST") {
  return new Request("http://local/context-document-vision", {
    method,
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function runners(log: string[]): Runners {
  return {
    next: () => {
      log.push("next");
      return Promise.resolve({ outcome: "nothing_due", recorded: [] });
    },
    submit: (_d, body) => {
      log.push(`submit:${body.reservation_id}`);
      return Promise.resolve(
        body.reservation_id === "lost"
          ? { outcome: "refused", code: "lease_not_found", status: 409 }
          : { outcome: "saved", event_id: "ev-1" },
      );
    },
    preview: (_d, limit) => {
      log.push(`preview:${limit}`);
      return Promise.resolve({
        outcome: "preview",
        flag_on: false,
        lane_on: true,
        admission: { open: false, code: "flag_off" },
        due: [],
      });
    },
  };
}

Deno.test("only the service role gets in", async () => {
  const log: string[] = [];
  assertEquals(
    (await handleDocumentVision(
      req({ mode: "next" }, null),
      deps(),
      runners(log),
    )).status,
    401,
  );
  assertEquals(
    (await handleDocumentVision(
      req({ mode: "next" }, ANON_JWT),
      deps(),
      runners(log),
    ))
      .status,
    401,
  );
  assertEquals(
    (await handleDocumentVision(
      req({ mode: "next" }, "wrong"),
      deps(),
      runners(log),
    ))
      .status,
    401,
  );
  assertEquals(
    (await handleDocumentVision(req({}, KEY, "GET"), deps(), runners(log)))
      .status,
    405,
  );
  assertEquals(log, []);
  const ok = await handleDocumentVision(
    req({ mode: "next" }, SERVICE_JWT),
    deps(),
    runners(log),
  );
  assertEquals(ok.status, 200);
  assertEquals(log, ["next"]);
});

Deno.test("modes route to their runner; anything else is refused", async () => {
  const log: string[] = [];
  const r = runners(log);
  assertEquals(
    (await handleDocumentVision(req({ mode: "preview" }), deps(), r)).status,
    200,
  );
  assertEquals(
    (await handleDocumentVision(req({ mode: "preview", limit: 0 }), deps(), r))
      .status,
    400,
  );
  const saved = await handleDocumentVision(
    req({ mode: "submit", reservation_id: "r1" }),
    deps(),
    r,
  );
  assertEquals(await saved.json(), {
    flag: "context_document_vision_v1",
    mode: "submit",
    outcome: "saved",
    event_id: "ev-1",
  });
  const lost = await handleDocumentVision(
    req({ mode: "submit", reservation_id: "lost" }),
    deps(),
    r,
  );
  assertEquals(lost.status, 409);
  assertEquals((await lost.json()).code, "lease_not_found");
  assertEquals(
    (await handleDocumentVision(req({ mode: "run" }), deps(), r)).status,
    400,
  );
  assertEquals(
    (await handleDocumentVision(req({}), deps(), r)).status,
    400,
  );
  assertEquals(log, ["preview:20", "submit:r1", "submit:lost"]);
});
