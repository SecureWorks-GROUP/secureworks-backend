// deno-lint-ignore-file no-import-prefix no-explicit-any
// The debt statement and report emails go through the real send-outlook-email door here
// (its handler, with a fake Graph), and both layers share one fake claim store. The door
// joins the debt item's attempt (send_claim), so an unknown outcome holds the item and the
// email content under one attempt, and one checked press by a named person reconciles
// both: exactly one more email, and no content hold left behind. Also: rows still
// 'sending' from before claims existed hold the customer in any week and the report
// however many newer rows sit above them, and are released only once older than the send
// lease. Each test below except the old-key one failed on a9dc676c.
// Synthetic fixture only; nothing reaches Xero, Graph, email or a database.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Placeholders only. None of these is, or is shaped from, a real key.
Deno.env.set("SUPABASE_URL", "https://project-fixture.supabase.co");
Deno.env.set("SW_API_KEY", "public-fixture");
Deno.env.set("OPS_AGENT_SERVER_KEY", "ops-fixture");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-fixture");
Deno.env.set("MICROSOFT_TENANT_ID", "tenant-debt-fixture");
Deno.env.set("MICROSOFT_CLIENT_ID", "client-debt-fixture");
Deno.env.set("MICROSOFT_CLIENT_SECRET", "secret-debt-fixture");

const { handleOutlookRequest, resetGraphTokenCache, setOutlookSendClaimClient } =
  await import("../send-outlook-email/index.ts");
const { _resetDebtWsBankCacheForTest, DEBT_WS_ACTIONS, runDebtWsAction } = await import(
  "./debt_ws_actions.ts"
);
const { fakeDeps, FakeStore, MLB_CONTACT, NOW, SHAUN } = await import(
  "./debt_ws_test_fakes.ts"
);
const { debtReportSendKey, debtStatementSendKey } = await import(
  "../_shared/outbound_send_claim.ts"
);

type Store = InstanceType<typeof FakeStore>;
type Deps = ReturnType<typeof fakeDeps>["deps"];
type Options = NonNullable<Parameters<typeof fakeDeps>[1]>;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function call(
  deps: Deps,
  action: string,
  input: Record<string, unknown> = {},
) {
  const method = DEBT_WS_ACTIONS[action].method;
  _resetDebtWsBankCacheForTest();
  return await runDebtWsAction(
    action,
    method,
    new URLSearchParams(),
    method === "POST" ? input : {},
    SHAUN,
    deps,
  );
}

/** A fake Graph: sendMail answers with whatever answer() returns at the time. */
function graph(answer: () => Response) {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method || "GET"} ${url}`);
    if (url.includes("/oauth2/v2.0/token")) {
      return Promise.resolve(
        Response.json({ access_token: "opaque-token", expires_in: 3600 }),
      );
    }
    if (url.includes("/mailFolders/inbox")) {
      return Promise.resolve(Response.json({ id: "inbox-1" }));
    }
    if (url.endsWith("/sendMail")) return Promise.resolve(answer());
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  return {
    fetchImpl,
    sendMails: () => calls.filter((c) => c.endsWith("/sendMail")).length,
  };
}

/** The ops-api debt adapter (index.ts), calling the real door's handler in process. */
function doorSender(deps: Deps) {
  deps.sendEmail = async (payload) => {
    const resp = await handleOutlookRequest(
      new Request("https://example.invalid/send-outlook-email", {
        method: "POST",
        headers: { "x-api-key": "public-fixture", "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    const text = await resp.text().catch(() => null);
    let reply: unknown = null;
    if (text) {
      try {
        reply = JSON.parse(text);
      } catch { /* not JSON: reads as unknown */ }
    }
    return {
      ok: resp.ok,
      status: resp.status,
      error: resp.ok ? null : (text ?? "").slice(0, 500),
      reply,
    };
  };
}

function setup(options: Options = {}) {
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  const opts: Options = { ...options };
  const { deps } = fakeDeps(store, opts);
  doorSender(deps);
  return { store, deps, opts };
}

/** Runs with the fake Graph and the debt store's claims shared with the door. */
async function withDoor<T>(
  store: Store,
  g: ReturnType<typeof graph>,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = g.fetchImpl;
  setOutlookSendClaimClient(store.claims as any);
  resetGraphTokenCache();
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    setOutlookSendClaimClient(null);
    resetGraphTokenCache();
  }
}

const unresolved = (store: Store) =>
  store.claims.rows.filter((r: any) => r.state === "sending" || r.state === "outcome_unknown");
const contentRows = (store: Store) =>
  store.claims.rows.filter((r: any) => r.item_key.startsWith("email_content:"));

const ACCEPTED = () => new Response(null, { status: 202 });
const UPSTREAM_DOWN = () => new Response("upstream", { status: 503 });

// ── The two layers composed ──

Deno.test("door: an unknown statement, then a checked press by a named person, sends exactly once more and leaves no content hold", async () => {
  const { store, deps, opts } = setup();
  let answer = UPSTREAM_DOWN;
  const g = graph(() => answer());
  await withDoor(store, g, async () => {
    const first = await call(deps, "debt_ws_statement_send", { company_key: MLB_CONTACT });
    assertEquals((first.body as any).code, "send_not_confirmed");
    // One attempt holds both the customer and the email content.
    const held = unresolved(store);
    const attempts = new Set(held.map((r: any) => r.attempt_id));
    assertEquals(attempts.size, 1);
    assert(held.some((r: any) => r.item_key === debtStatementSendKey(store.orgId, MLB_CONTACT)));
    assert(held.some((r: any) => r.item_key.startsWith("email_content:")));
    answer = ACCEPTED;
    opts.now = new Date(NOW.getTime() + 5 * MINUTE);
    const checked = await call(deps, "debt_ws_statement_send", {
      company_key: MLB_CONTACT,
      sent_items_checked: true,
    });
    assertEquals(checked.status, 200);
  });
  assertEquals(g.sendMails(), 2);
  assertEquals(unresolved(store), []);
  // The first attempt's item and content rows were both reconciled by the named checker,
  // so neither is left orphaned.
  const firstAttempt = contentRows(store).find((r: any) => r.state !== "sent") as any;
  assert(firstAttempt);
  for (const row of store.claims.rowsOf(firstAttempt.attempt_id) as any[]) {
    assertEquals(row.state, "reconciled_not_sent");
    assert(String(row.reconciled_by).includes(String(SHAUN.user_id)));
    assert(row.reconcile_checked_at);
  }
  assertEquals(store.claims.rowsOf(firstAttempt.attempt_id).length, 2);
});

Deno.test("door: an unknown report, then a checked press by a named person, sends exactly once more and leaves no content hold", async () => {
  const { store, deps, opts } = setup();
  let answer = UPSTREAM_DOWN;
  const g = graph(() => answer());
  await withDoor(store, g, async () => {
    const first = await call(deps, "debt_ws_report_send");
    assertEquals((first.body as any).code, "send_not_confirmed");
    const held = unresolved(store);
    assertEquals(new Set(held.map((r: any) => r.attempt_id)).size, 1);
    assert(held.some((r: any) => r.item_key === debtReportSendKey(store.orgId)));
    assert(held.some((r: any) => r.item_key.startsWith("email_content:")));
    answer = ACCEPTED;
    opts.now = new Date(NOW.getTime() + 5 * MINUTE);
    const checked = await call(deps, "debt_ws_report_send", { sent_items_checked: true });
    assertEquals(checked.status, 200);
  });
  assertEquals(g.sendMails(), 2);
  assertEquals(unresolved(store), []);
});

Deno.test("door: two checked statement presses together after an unknown send exactly one more email", async () => {
  const { store, deps, opts } = setup();
  let answer = UPSTREAM_DOWN;
  const g = graph(() => answer());
  const results = await withDoor(store, g, async () => {
    await call(deps, "debt_ws_statement_send", { company_key: MLB_CONTACT });
    answer = ACCEPTED;
    opts.now = new Date(NOW.getTime() + 5 * MINUTE);
    return await Promise.all([
      call(deps, "debt_ws_statement_send", { company_key: MLB_CONTACT, sent_items_checked: true }),
      call(deps, "debt_ws_statement_send", { company_key: MLB_CONTACT, sent_items_checked: true }),
    ]);
  });
  assertEquals(g.sendMails(), 2);
  assertEquals(results.map((r) => r.status).sort(), [200, 409]);
  assertEquals(unresolved(store), []);
});

// ── Rows from before claims existed ──

function legacyStatement(store: Store, weekStart: string, createdAt: Date) {
  store.statementRows.push({
    id: "legacy-statement-1",
    company_key: MLB_CONTACT,
    week_start: weekStart,
    xero_invoice_ids: [],
    total: 100,
    to_email: "accounts@builders.example.test",
    status: "sending",
    approved_by: "Shaun",
    sent_at: null,
    error: "not confirmed: the send did not answer",
    created_at: createdAt.toISOString(),
  });
}

Deno.test("legacy: a statement row still sending in an older week holds this week's statement, and only a checked press releases it", async () => {
  const { store, deps } = setup();
  legacyStatement(store, "2026-09-21", new Date(NOW.getTime() - 21 * DAY));
  const g = graph(ACCEPTED);
  await withDoor(store, g, async () => {
    const held = await call(deps, "debt_ws_statement_send", { company_key: MLB_CONTACT });
    assertEquals((held.body as any).code, "send_not_confirmed");
    assertEquals(g.sendMails(), 0);
    const checked = await call(deps, "debt_ws_statement_send", {
      company_key: MLB_CONTACT,
      sent_items_checked: true,
    });
    assertEquals(checked.status, 200);
  });
  assertEquals(g.sendMails(), 1);
  const legacy = store.statementRows.find((s) => s.id === "legacy-statement-1")!;
  assertEquals(legacy.status, "failed");
  // Who checked, and when.
  assert(String(legacy.error).includes(String(SHAUN.user_id)));
  assert(String(legacy.error).includes(NOW.toISOString()));
});

Deno.test("legacy: a statement row still sending and younger than the lease is never released, even by a checked press", async () => {
  const { store, deps } = setup();
  legacyStatement(store, "2026-10-12", new Date(NOW.getTime() - 2 * MINUTE));
  const g = graph(ACCEPTED);
  const checked = await withDoor(store, g, () =>
    call(deps, "debt_ws_statement_send", { company_key: MLB_CONTACT, sent_items_checked: true }));
  assertEquals(checked.status, 409);
  assertEquals((checked.body as any).code, "send_in_progress");
  assertEquals(g.sendMails(), 0);
  assertEquals(store.statementRows.find((s) => s.id === "legacy-statement-1")!.status, "sending");
});

Deno.test("legacy: a report row still sending under 60 newer rows holds the report", async () => {
  const { store, deps } = setup();
  const row = (id: string, status: "sending" | "sent", at: number) => ({
    id,
    kind: "manual" as const,
    week_start: "2026-09-28",
    status,
    to_emails: [],
    cc_emails: [],
    subject: null,
    sent_by_name: null,
    error: null,
    created_at: new Date(at).toISOString(),
    sent_at: null,
  });
  store.reportRows.push(row("legacy-report-1", "sending", NOW.getTime() - 20 * DAY));
  for (let i = 0; i < 60; i++) {
    store.reportRows.push(row(`filler-${i}`, "sent", NOW.getTime() - 10 * DAY + i * MINUTE));
  }
  const g = graph(ACCEPTED);
  await withDoor(store, g, async () => {
    const held = await call(deps, "debt_ws_report_send");
    assertEquals((held.body as any).code, "send_not_confirmed");
    assertEquals(g.sendMails(), 0);
    const checked = await call(deps, "debt_ws_report_send", { sent_items_checked: true });
    assertEquals(checked.status, 200);
  });
  assertEquals(g.sendMails(), 1);
  const legacy = store.reportRows.find((r) => r.id === "legacy-report-1")!;
  assertEquals(legacy.status, "failed");
  assert(String(legacy.error).includes(String(SHAUN.user_id)));
});

// ── The statement key now carries the org ──

Deno.test("old key: a hold left on debt_statement:<company> from before still holds, and a checked press reconciles it", async () => {
  const { store, deps } = setup();
  await store.claims.rpc("claim_outbound_send", {
    p_keys: [`debt_statement:${MLB_CONTACT}`],
    p_attempt_id: "debt_statement_attempt:old-key",
    p_lease_seconds: 900,
  });
  await store.claims.rpc("settle_outbound_send", {
    p_attempt_id: "debt_statement_attempt:old-key",
    p_state: "outcome_unknown",
  });
  const g = graph(ACCEPTED);
  await withDoor(store, g, async () => {
    const held = await call(deps, "debt_ws_statement_send", { company_key: MLB_CONTACT });
    assertEquals((held.body as any).code, "send_not_confirmed");
    assertEquals(g.sendMails(), 0);
    const checked = await call(deps, "debt_ws_statement_send", {
      company_key: MLB_CONTACT,
      sent_items_checked: true,
    });
    assertEquals(checked.status, 200);
  });
  assertEquals(g.sendMails(), 1);
  assertEquals(unresolved(store), []);
});
