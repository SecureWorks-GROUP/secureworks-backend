/**
 * Approved sends through ops-api: the recording restriction, the send door,
 * and the wiring through the real request handler. No provider is called and
 * no real message leaves: GHL and send-outlook-email are fakes, and the
 * handler runs against a closed local port.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recordApproval } from "../_shared/approved_send.ts";
import type { GhlCall } from "../_shared/approved_send_sms.ts";
import {
  emailApprovalBody,
  makeDeps,
  RECORDER,
  smsApprovalBody,
} from "../_shared/approved_send_test_fakes.ts";
import {
  approvedSendCredentialClass,
  makeForwardEmail,
  recordSendApprovalAction,
  sendApprovalStatusAction,
  sendApprovedAction,
} from "./approved_send_actions.ts";

const KEYS = {
  serviceKey: "svc",
  agentServerKey: "agent",
  sharedKey: "shared",
  routineKey: "routine",
};

Deno.test("credential class: only the two server secrets are server secrets", () => {
  const cls = (authMode: any, key: string | null) =>
    approvedSendCredentialClass({ authMode, xApiKey: key, bearerToken: null, ...KEYS });
  assertEquals(cls("api_key", "svc"), "service_role");
  assertEquals(cls("api_key", "agent"), "ops_agent_server_key");
  assertEquals(cls("api_key", "shared"), "shared_key");
  assertEquals(cls("routine", "routine"), "routine");
  assertEquals(cls("agent_read", "agent"), "agent_read");
  assertEquals(cls("jwt", null), "user_jwt");
  assertEquals(cls("api_key", "nothing"), "none");
  // A server secret that collides with the shared key is never a server secret.
  assertEquals(
    approvedSendCredentialClass({
      authMode: "api_key",
      xApiKey: "same",
      bearerToken: null,
      serviceKey: "same",
      agentServerKey: null,
      sharedKey: "same",
      routineKey: null,
    }),
    "shared_key",
  );
});

Deno.test("record door: desk, crew, app and shared callers are refused and audited", async () => {
  const deps = makeDeps();
  const attempts = [
    { credentialClass: "user_jwt", actor: "user:abc", actorSource: "jwt" },
    { credentialClass: "shared_key", actor: "actor_missing", actorSource: "header_untrusted" },
    { credentialClass: "routine", actor: "actor_missing", actorSource: "header_untrusted" },
    { credentialClass: "ops_agent_server_key", actor: "seat:coo", actorSource: "header" },
    { credentialClass: "service_role", actor: "actor_missing", actorSource: "none" },
  ] as const;
  for (const identity of attempts) {
    const result = await recordSendApprovalAction(deps, identity as any, {
      ...smsApprovalBody(),
      dry_run: false,
    });
    assertEquals(result.status, 403);
    assertEquals(result.body.code, "approval_recorder_required");
  }
  assertEquals(deps.store.rows.size, 0);
  const refusals = deps.store.auditRows.filter((row) => row.event === "record_refused");
  assertEquals(refusals.length, attempts.length);
  // An untrusted claimed name is never copied into the audit.
  assertEquals(refusals[1].actor, null);
  assertEquals(refusals[3].actor, "seat:coo");
});

Deno.test("record door: the recorder seat previews then records", async () => {
  const deps = makeDeps();
  const preview = await recordSendApprovalAction(deps, RECORDER, smsApprovalBody());
  assertEquals(preview.status, 200);
  assertEquals(preview.body.dry_run, true);
  const live = await recordSendApprovalAction(deps, RECORDER, {
    ...smsApprovalBody(),
    dry_run: false,
    expected_payload_hash: preview.body.payload_hash,
  });
  assertEquals(live.status, 201);
  assert(typeof live.body.approval_id === "string");
  const status = await sendApprovalStatusAction(deps, live.body.approval_id, "ops_agent_server_key");
  assertEquals(status.status, 200);
  assertEquals((status.body.approval as any).status, "approved");
  assertEquals("seal" in (status.body.approval as any), false);
  const refusedStatus = await sendApprovalStatusAction(deps, live.body.approval_id, "user_jwt");
  assertEquals(refusedStatus.status, 403);
});

function fakeGhl(): { ghl: GhlCall; sent: any[] } {
  const sent: any[] = [];
  const ghl: GhlCall = (path, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (path === "/contacts/search/duplicate") return Promise.resolve({ contact: { id: "c1", phone: body.phone } });
    if (path.startsWith("/contacts/")) return Promise.resolve({ contact: { id: "c1", phone: "+61412345678" } });
    if (path === "/conversations/messages") {
      sent.push(body);
      return Promise.resolve({ messageId: "m1" });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  };
  return { ghl, sent };
}

async function recordLive(deps: ReturnType<typeof makeDeps>, body: Record<string, unknown>) {
  const preview = await recordApproval(deps, RECORDER, body);
  return (await recordApproval(deps, RECORDER, {
    ...body,
    dry_run: false,
    expected_payload_hash: preview.payload_hash,
  })).approval_id!;
}

Deno.test("send door: SMS is sent here, email is handed to send-outlook-email", async () => {
  const deps = makeDeps();
  deps.files.put({ source: "job_document", id: "11111111-1111-4111-8111-111111111111" }, "%PDF", "Q.pdf");
  const smsId = await recordLive(deps, smsApprovalBody());
  const emailId = await recordLive(deps, emailApprovalBody());
  const provider = fakeGhl();
  const forwarded: string[] = [];
  const sendDeps = {
    ...deps,
    ghl: provider.ghl,
    locationId: "loc",
    forwardEmail: (id: string) => {
      forwarded.push(id);
      return Promise.resolve({ status: 202, body: { state: "sent" } });
    },
  };
  const caller = { actor: "seat:rayleigh", credentialClass: "ops_agent_server_key" };
  const sms = await sendApprovedAction(sendDeps, { approval_id: smsId }, caller);
  assertEquals(sms.status, 200);
  assertEquals(provider.sent.length, 1);
  const email = await sendApprovedAction(sendDeps, { approval_id: emailId }, caller);
  assertEquals(email.status, 202);
  assertEquals(forwarded, [emailId]);

  const again = await sendApprovedAction(sendDeps, { approval_id: smsId }, caller);
  assertEquals(again.status, 409);
  assertEquals(again.body.code, "approval_already_used");
  assertEquals(provider.sent.length, 1);

  const appCaller = await sendApprovedAction(sendDeps, { approval_id: smsId }, {
    actor: "user:x",
    credentialClass: "user_jwt",
  });
  assertEquals(appCaller.status, 403);
});

Deno.test("the email hand-off posts only the approval id and relays the answer", async () => {
  const seen: { url: string; headers: Headers; body: string }[] = [];
  const forward = makeForwardEmail("http://127.0.0.1:9", "svc", (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
    return Promise.resolve(Response.json({ state: "sent" }, { status: 202 }));
  });
  const result = await forward("12345678-1234-4234-8234-123456789012", {
    actor: "seat:rayleigh",
    credentialClass: "ops_agent_server_key",
  });
  assertEquals(result.status, 202);
  assertEquals(seen[0].url, "http://127.0.0.1:9/functions/v1/send-outlook-email");
  assertEquals(JSON.parse(seen[0].body), { approval_id: "12345678-1234-4234-8234-123456789012" });
  assertEquals(seen[0].headers.get("x-sw-actor"), "seat:rayleigh");

  const lost = makeForwardEmail("http://127.0.0.1:9", "svc", () => Promise.reject(new TypeError("reset")));
  const unknown = await lost("12345678-1234-4234-8234-123456789012", { actor: null, credentialClass: null });
  assertEquals(unknown.body.state, "outcome_unknown");
});

// ── Through the real ops-api request handler ────────────────────────────────

const SERVICE_KEY = "test-service-role-key";
const SHARED_KEY = "test-shared-browser-key";
const ROUTINE_KEY = "test-routine-key";
const AGENT_KEY = "test-agent-server-key";
const USER_JWT = "test-signed-in-trade-jwt";
const ENV: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SW_API_KEY: SHARED_KEY,
  MAKESAFE_ROUTINE_KEY: ROUTINE_KEY,
  OPS_AGENT_SERVER_KEY: AGENT_KEY,
};

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(ENV).map((name) => [name, Deno.env.get(name)]));
  for (const [name, value] of Object.entries(ENV)) Deno.env.set(name, value);
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

let handlerPromise: Promise<(req: Request) => Promise<Response>> | null = null;
function handler() {
  handlerPromise ??= withEnv(async () => (await import("./index.ts"))._opsApiRequestHandlerForTest);
  return handlerPromise;
}

async function call(
  action: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: any; fetches: { url: string; method: string; body: any }[] }> {
  const handle = await handler();
  const fetches: { url: string; method: string; body: any }[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = init?.body;
    fetches.push({
      url,
      method: String(init?.method ?? "GET"),
      body: typeof raw === "string" && raw ? JSON.parse(raw) : null,
    });
    if (url.startsWith("http://127.0.0.1:9/auth/v1/user")) {
      return Promise.resolve(Response.json({ id: "7d4f0a52-0000-4000-8000-00000000f4c7", aud: "authenticated" }));
    }
    if (url.startsWith("http://127.0.0.1:9/rest/v1/users?")) {
      return Promise.resolve(Response.json({ org_id: "o", role: "trade", managed_verticals: [] }));
    }
    if (url.startsWith("http://127.0.0.1:9/rest/v1/approved_send_audit")) {
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    if (url.startsWith("http://127.0.0.1:9/rest/v1/rpc/record_ops_api_actor_missing")) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  console.log = () => {};
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    const res = await withEnv(() =>
      handle(new Request(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      }))
    );
    return { status: res.status, body: await res.json(), fetches };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

function providerCalls(fetches: { url: string }[]) {
  return fetches.filter((f) =>
    f.url.includes("leadconnectorhq") || f.url.includes("graph.microsoft") ||
    f.url.includes("/functions/v1/")
  );
}

Deno.test("handler: a signed-in app user cannot record an approval", async () => {
  const result = await call("record_send_approval", { authorization: `Bearer ${USER_JWT}` }, smsApprovalBody());
  assertEquals(result.status, 403);
  assertEquals(result.body.code, "operator_access_required");
});

Deno.test("handler: the shared browser key cannot record or send", async () => {
  for (const action of ["record_send_approval", "send_approved"]) {
    const result = await call(action, { "x-api-key": SHARED_KEY }, {});
    assertEquals(result.status, 401);
  }
});

Deno.test("handler: the routine key cannot record or send", async () => {
  for (const action of ["record_send_approval", "send_approved"]) {
    const result = await call(action, { "x-api-key": ROUTINE_KEY }, {});
    assertEquals(result.status, 403);
  }
});

Deno.test("handler: a server secret without the recorder seat is refused and audited", async () => {
  for (const actor of [null, "seat:coo", "seat:cfo"]) {
    const headers: Record<string, string> = { authorization: `Bearer ${AGENT_KEY}` };
    if (actor) headers["x-sw-actor"] = actor;
    const result = await call("record_send_approval", headers, { ...smsApprovalBody(), dry_run: false });
    assertEquals(result.status, 403);
    assertEquals(result.body.code, "approval_recorder_required");
    const audit = result.fetches.filter((f) => f.url.includes("/rest/v1/approved_send_audit"));
    assertEquals(audit.length, 1);
    assertEquals(audit[0].body.event, "record_refused");
    assertEquals(providerCalls(result.fetches).length, 0);
  }
});

Deno.test("handler: the recorder seat previews an SMS approval without writing", async () => {
  const result = await call(
    "record_send_approval",
    { authorization: `Bearer ${AGENT_KEY}`, "x-sw-actor": "seat:rayleigh" },
    smsApprovalBody(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.dry_run, true);
  assertEquals(result.body.payload.to_mobile, "+61412345678");
  assertEquals(result.fetches.filter((f) => f.url.includes("approved_send")).length, 0);
});

Deno.test("handler: send_approved takes approval_id only and calls no provider otherwise", async () => {
  const result = await call(
    "send_approved",
    { authorization: `Bearer ${SERVICE_KEY}` },
    { approval_id: "12345678-1234-4234-8234-123456789012", to_mobile: "0400000000" },
  );
  assertEquals(result.status, 400);
  assertEquals(result.body.code, "approval_send_fields_rejected");
  assertEquals(providerCalls(result.fetches).length, 0);
});
