// The vision reader's HTTP door (gap plan B-5b): service role only, the three
// modes, and the RPC wiring (names and arguments). No network.

// deno-lint-ignore no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  handleDocumentVision,
  type HandlerDeps,
  liveDeps,
  type Runners,
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

Deno.test("the wiring calls the database's own functions with their argument names", async () => {
  const calls: [string, unknown][] = [];
  const supabase = {
    rpc: (name: string, args?: unknown) => {
      calls.push([name, args]);
      const data: Record<string, unknown> = {
        context_document_vision_flag: { enabled: true },
        automation_lane_enabled: true,
        context_document_vision_admission: {
          open: false,
          code: "vision_budget",
        },
        claim_context_document_vision: { outcome: "not_due" },
        context_document_vision_leased: [],
        record_context_document_vision: { outcome: "pending" },
      };
      return Promise.resolve({ data: data[name] ?? null, error: null });
    },
  };
  const live = liveDeps(deps(supabase));
  assertEquals(await live.flagOn(), true);
  assertEquals(await live.laneOn(), true);
  assertEquals(await live.admission(), { open: false, code: "vision_budget" });
  assertEquals(await live.leased("r"), null);
  await live.claim({
    source_kind: "job_document",
    source_id: "s",
    job_id: "j",
    fingerprint: "f",
    file_kind: "pdf",
    sha256: "x",
    page_count: 1,
    image_count: 1,
    images_cut: false,
  });
  await live.record({
    source_kind: "job_document",
    source_id: "s",
    job_id: "j",
    fingerprint: "f",
    file_kind: "pdf",
    result: "error",
    code: "x",
  });
  assertEquals(calls.map((c) => c[0]), [
    "context_document_vision_flag",
    "automation_lane_enabled",
    "automation_lane_enabled",
    "context_document_vision_admission",
    "context_document_vision_leased",
    "claim_context_document_vision",
    "record_context_document_vision",
  ]);
  assertEquals(calls[1][1], { lane: "capture" });
  assertEquals(calls[2][1], { lane: "extraction" });
  assertEquals(calls[4][1], { p_reservation_id: "r" });
  assertEquals(Object.keys(calls[5][1] as object), ["p"]);

  // One lane off is off; a database refusal surfaces its own code.
  const off = liveDeps(deps({
    rpc: (name: string, args?: { lane?: string }) =>
      Promise.resolve({
        data: name === "automation_lane_enabled"
          ? args?.lane === "capture"
          : null,
        error: name === "record_context_document_vision"
          ? { message: "document_vision_lease_lost" }
          : null,
      }),
  }));
  assertEquals(await off.laneOn(), false);
  assertEquals(
    await off.record({
      source_kind: "job_document",
      source_id: "s",
      job_id: "j",
      fingerprint: "f",
      file_kind: "pdf",
      result: "no_text",
    }),
    { error: "document_vision_lease_lost" },
  );
});
