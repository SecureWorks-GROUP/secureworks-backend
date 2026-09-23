// Slice C1b behaviour tests: the real receiver handler, driven with the named
// rows of sms.md §10 through an in-memory database and a real Ed25519 key
// pair. No network, no live GHL, no production credentials.
import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _resetFlagCache } from "../_shared/evidence/feature_flag.ts";
import { handleGhlWebhook, type ReceiverDeps } from "./handler.ts";
import {
  CALL_COMPLETED,
  CONTACT_CREATE,
  FORGED_JOB_ID,
  R1_INBOUND,
  R1_JOB_A,
  R1_JOB_B,
  R1_TEXT,
  R10_INBOUND,
  R2_OUTBOUND,
  TEST_LOCATION_ID,
  TEST_WEBHOOK_SECRET,
} from "./named_rows_fixture.ts";

// ── in-memory database ────────────────────────────────────

type Row = Record<string, unknown>;
interface Op {
  table: string;
  kind: "select" | "insert" | "update";
  row?: Row;
  filters: Array<[string, unknown]>;
}

interface DbOptions {
  laneOn?: boolean;
  jobs?: Row[];
  insertError?: { code: string; message: string } | null;
}

function fakeDb(opts: DbOptions = {}) {
  const ops: Op[] = [];
  const rpcs: string[] = [];
  const client = {
    rpc(name: string) {
      rpcs.push(name);
      return Promise.resolve({ data: name === "automation_lane_enabled" ? (opts.laneOn ?? true) : null, error: null });
    },
    from(table: string) {
      const op: Op = { table, kind: "select", filters: [] };
      const result = () => {
        if (op.kind === "insert") {
          if (table === "business_events" && opts.insertError) return { data: null, error: opts.insertError };
          return { data: null, error: null };
        }
        if (op.kind === "update") return { data: null, error: null };
        if (table === "jobs") return { data: opts.jobs ?? [], error: null };
        if (table === "feature_flags") return { data: [{ enabled: false }], error: null };
        return { data: null, error: null };
      };
      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select: () => builder,
        eq: (k: string, v: unknown) => (op.filters.push([k, v]), builder),
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        insert: (row: Row) => {
          op.kind = "insert";
          op.row = row;
          ops.push(op);
          return builder;
        },
        update: (row: Row) => {
          op.kind = "update";
          op.row = row;
          ops.push(op);
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          if (op.kind === "select") ops.push(op);
          return Promise.resolve(result()).then(res, rej);
        },
      };
      return builder;
    },
  };
  return { client, ops, rpcs };
}

// ── keys, env, requests ───────────────────────────────────

const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const otherKeyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`;

async function sign(raw: string, pair = keyPair): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(raw)));
  return btoa(String.fromCharCode(...sig));
}

function env(mode: "observe" | "enforce", extra: Record<string, string> = {}) {
  const values: Record<string, string> = {
    GHL_WEBHOOK_PUBLIC_KEY: PUBLIC_KEY_PEM,
    GHL_LOCATION_ID: TEST_LOCATION_ID,
    GHL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    SUPABASE_URL: "https://project.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    ...extra,
  };
  if (mode === "enforce") values.GHL_WEBHOOK_AUTH_MODE = "enforce";
  return (name: string) => values[name];
}

type Proof = "signature" | "secret" | "wrong_key" | "legacy" | "none";

async function post(body: unknown, proof: Proof, rawOverride?: string): Promise<Request> {
  const raw = rawOverride ?? JSON.stringify(body);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (proof === "signature") headers.set("X-GHL-Signature", await sign(raw));
  if (proof === "wrong_key") headers.set("X-GHL-Signature", await sign(raw, otherKeyPair));
  if (proof === "secret") headers.set("X-Webhook-Secret", TEST_WEBHOOK_SECRET);
  if (proof === "legacy") headers.set("X-WH-Signature", "bGVnYWN5LXJzYS1zaWduYXR1cmU=");
  return new Request("https://project.example.test/functions/v1/ghl-webhook-receiver", { method: "POST", headers, body: raw });
}

interface Run {
  res: Response;
  json: Row;
  ops: Op[];
  rpcs: string[];
  logs: string;
  fetches: Array<{ url: string; body: string }>;
}

async function run(req: Request, mode: "observe" | "enforce", db: DbOptions = {}, envExtra: Record<string, string> = {}): Promise<Run> {
  _resetFlagCache();
  const { client, ops, rpcs } = fakeDb(db);
  const fetches: Array<{ url: string; body: string }> = [];
  const pending: Promise<unknown>[] = [];
  const deps: ReceiverDeps = {
    env: env(mode, envExtra),
    createSupabase: () => client,
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      fetches.push({ url: String(input), body: String(init?.body ?? "") });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
    waitUntil: (p) => void pending.push(p),
  };
  const lines: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  const capture = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  try {
    const res = await handleGhlWebhook(req, deps);
    await Promise.all(pending);
    const text = await res.text();
    return { res, json: text ? JSON.parse(text) : {}, ops, rpcs, logs: lines.join("\n"), fetches };
  } finally {
    Object.assign(console, original);
  }
}

const receipts = (r: Run) => r.ops.filter((o) => o.table === "webhook_log" && o.kind === "insert");
const receipt = (r: Run) => {
  const all = receipts(r);
  assertEquals(all.length, 1, "exactly one webhook_log receipt per delivery");
  return all[0].row as Row & { payload: Row };
};
const evidenceRows = (r: Run) => r.ops.filter((o) => o.table === "business_events" && o.kind === "insert").map((o) => o.row as Row);

/** A receipt carries identifiers and codes only: never text, phone, email or custom fields. */
function assertIdsOnly(r: Run, forbidden: string[]) {
  const rec = receipt(r);
  assertEquals(Object.keys(rec.payload).sort(), [
    "auth",
    "auth_detail",
    "auth_mode",
    "contact_id",
    "message_id",
    "outcome",
    "receipt",
    "type",
    "webhook_id",
  ]);
  const serialised = JSON.stringify(rec);
  for (const s of forbidden) assertFalse(serialised.includes(s), `receipt must not carry ${s}`);
  for (const s of forbidden) assertFalse(r.logs.includes(s), `logs must not carry ${s}`);
}

const R1_JOBS = [
  { id: R1_JOB_A, job_number: "SWF-261448", client_name: null, type: "fencing", status: "quoted", site_suburb: null, created_at: "2026-09-21T00:00:00Z" },
  { id: R1_JOB_B, job_number: "SWF-261431", client_name: null, type: "fencing", status: "quoted", site_suburb: null, created_at: "2026-09-17T00:00:00Z" },
];

// ── R1: app-signed inbound text ───────────────────────────

Deno.test("R1 signed by the GHL app is captured and receipted as app_signature, ids only", async () => {
  const r = await run(await post(R1_INBOUND, "signature"), "enforce", { jobs: R1_JOBS });
  assertEquals(r.res.status, 200);
  const rows = evidenceRows(r);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].provider_message_id, "ghl:pffXnIL1v2FTaKnz4DHm");
  assertEquals(rows[0].event_type, "client.reply");
  const rec = receipt(r);
  assertEquals(rec.source, "ghl_webhook");
  assertEquals(rec.status, "processed");
  assertEquals(rec.payload, {
    receipt: "ids_only_v1",
    type: "InboundMessage",
    webhook_id: "wh-r1-0001",
    message_id: "pffXnIL1v2FTaKnz4DHm",
    contact_id: "lYPee0K2DuQHXH2xHL1P",
    outcome: "event_created",
    auth: "app_signature",
    auth_detail: null,
    auth_mode: "enforce",
  });
  assertIdsOnly(r, [R1_TEXT, "+61400000000", "I98nlO8dKPOAaylh7k23"]);
});

Deno.test("R1 unsigned in observe mode is still captured and receipted auth=missing", async () => {
  const r = await run(await post(R1_INBOUND, "none"), "observe", { jobs: R1_JOBS });
  assertEquals(r.res.status, 200);
  assertEquals(evidenceRows(r).length, 1);
  const rec = receipt(r);
  assertEquals(rec.payload.auth, "missing");
  assertEquals(rec.payload.auth_detail, "no_proof");
  assertEquals(rec.payload.auth_mode, "observe");
  assertEquals(rec.payload.outcome, "event_created");
  assertIdsOnly(r, [R1_TEXT, "+61400000000"]);
});

Deno.test("observe is the default: no GHL_WEBHOOK_AUTH_MODE means nothing is refused", async () => {
  const r = await run(await post(R1_INBOUND, "none"), "observe", { jobs: R1_JOBS });
  assertEquals(receipt(r).payload.auth_mode, "observe");
  assertEquals(r.res.status, 200);
});

Deno.test("R1 unsigned in enforce mode gets 401: nothing read, nothing written, one receipt", async () => {
  const r = await run(await post(R1_INBOUND, "none"), "enforce", { jobs: R1_JOBS });
  assertEquals(r.res.status, 401);
  assertEquals(evidenceRows(r).length, 0);
  assertEquals(r.ops.filter((o) => o.table !== "webhook_log").length, 0);
  assertEquals(r.rpcs.length, 0, "no capture lane read before auth");
  const rec = receipt(r);
  assertEquals(rec.status, "rejected");
  assertEquals(rec.payload.outcome, "unauthorized");
  assertEquals(rec.payload.auth_detail, "no_proof");
  assertIdsOnly(r, [R1_TEXT]);
});

Deno.test("R1 with a tampered body or a foreign key fails the signature", async () => {
  const tampered = await post(R1_INBOUND, "signature");
  const signature = tampered.headers.get("X-GHL-Signature")!;
  const forgedBody = JSON.stringify({ ...R1_INBOUND, body: "changed after signing" });
  const req = new Request(tampered.url, { method: "POST", headers: { "X-GHL-Signature": signature }, body: forgedBody });
  const a = await run(req, "enforce", { jobs: R1_JOBS });
  assertEquals(a.res.status, 401);
  assertEquals(receipt(a).payload.auth_detail, "signature_invalid");

  const b = await run(await post(R1_INBOUND, "wrong_key"), "enforce", { jobs: R1_JOBS });
  assertEquals(b.res.status, 401);
  assertEquals(receipt(b).payload.auth_detail, "signature_invalid");
});

Deno.test("R1 validly signed for another location is refused (location check)", async () => {
  const r = await run(await post({ ...R1_INBOUND, locationId: "another-location" }, "signature"), "enforce");
  assertEquals(r.res.status, 401);
  assertEquals(receipt(r).payload.auth_detail, "location_mismatch");
});

Deno.test("app signature with no public key configured is auth=missing (signature_key_unset)", async () => {
  const r = await run(await post(R1_INBOUND, "signature"), "observe", { jobs: R1_JOBS }, { GHL_WEBHOOK_PUBLIC_KEY: "" });
  assertEquals(r.res.status, 200);
  assertEquals(receipt(r).payload.auth, "missing");
  assertEquals(receipt(r).payload.auth_detail, "signature_key_unset");
});

Deno.test("the deprecated X-WH-Signature alone is not a proof", async () => {
  const r = await run(await post(R1_INBOUND, "legacy"), "enforce");
  assertEquals(r.res.status, 401);
  assertEquals(receipt(r).payload.auth_detail, "legacy_signature_unsupported");
});

Deno.test("a message event carrying only the workflow secret is not accepted: messages must come signed from the app", async () => {
  const r = await run(await post(R2_OUTBOUND, "secret"), "enforce");
  assertEquals(r.res.status, 401);
  assertEquals(receipt(r).payload.auth_detail, "proof_not_accepted_for_type");
});

Deno.test("R2 staff reply signed by the app is captured outbound, ids-only receipt", async () => {
  const r = await run(await post(R2_OUTBOUND, "signature"), "enforce", { jobs: R1_JOBS });
  assertEquals(r.res.status, 200);
  const rows = evidenceRows(r);
  assertEquals(rows[0].event_type, "client.sms_out");
  assertEquals(rows[0].direction, "outbound");
  assertEquals(receipt(r).payload.message_id, "unJUR0MY5jwawuYXWYgR");
  assertIdsOnly(r, [R2_OUTBOUND.body, "RgDWTnYL6zL3eJA6nLht"]);
});

// ── body.job_id is never trusted ──────────────────────────

Deno.test("R1 with a forged body.job_id: the row carries no job, the matcher ignores it, no nudge is cancelled", async () => {
  const forged = { ...R1_INBOUND, job_id: R1_JOB_A, supabase_job_id: R1_JOB_A, jobId: R1_JOB_A };
  const r = await run(await post(forged, "signature"), "enforce", { jobs: R1_JOBS });
  assertEquals(r.res.status, 200);
  const row = evidenceRows(r)[0];
  assertEquals(row.job_id, null);
  assertEquals(row.match_method, "none");
  const payload = row.payload as Row;
  assertEquals(payload.suggested_job_id, null, "two open jobs, the forged id picks neither");
  assertEquals((payload.attribution_hint as Row).job_id, null);
  assertEquals(r.ops.filter((o) => o.kind === "update").length, 0, "no smart_nudges or proposal cancelled");
  assertEquals(r.json.job_matched, false);
});

Deno.test("a forged job id nobody owns never reaches the evidence row (observe, unauthenticated)", async () => {
  const r = await run(await post({ ...R10_INBOUND, job_id: FORGED_JOB_ID }, "none"), "observe", { jobs: [] });
  assertEquals(evidenceRows(r)[0].job_id, null);
  assertFalse(JSON.stringify(evidenceRows(r)[0]).includes(FORGED_JOB_ID));
});

// ── workflow posts ─────────────────────────────────────────

Deno.test("CallCompleted workflow post with the shared secret is accepted; forged job id never reaches the row or transcribe-call", async () => {
  const r = await run(await post({ ...CALL_COMPLETED, job_id: R1_JOB_B }, "secret"), "enforce", { jobs: R1_JOBS });
  assertEquals(r.res.status, 200);
  const rec = receipt(r);
  assertEquals(rec.payload.auth, "workflow_secret");
  assertEquals(rec.payload.type, "CallCompleted");
  assertEquals(evidenceRows(r)[0].job_id, null);
  assertEquals(r.fetches.length, 1);
  const transcribe = JSON.parse(r.fetches[0].body);
  assertEquals(transcribe.job_id, null);
  assertEquals(transcribe.job_match_method, "none");
  assertFalse(r.logs.includes(CALL_COMPLETED.recordingUrl));
});

Deno.test("CallCompleted accepts the secret as a Bearer authorization header too", async () => {
  const req = new Request("https://project.example.test/functions/v1/ghl-webhook-receiver", {
    method: "POST",
    headers: { Authorization: `Bearer ${TEST_WEBHOOK_SECRET}` },
    body: JSON.stringify(CALL_COMPLETED),
  });
  const r = await run(req, "enforce");
  assertEquals(r.res.status, 200);
  assertEquals(receipt(r).payload.auth, "workflow_secret");
});

Deno.test("CallCompleted with a wrong secret or only an app signature is refused when enforcing", async () => {
  const wrong = new Request("https://project.example.test/functions/v1/ghl-webhook-receiver", {
    method: "POST",
    headers: { "X-Webhook-Secret": "not-the-secret" },
    body: JSON.stringify(CALL_COMPLETED),
  });
  const a = await run(wrong, "enforce");
  assertEquals(a.res.status, 401);
  assertEquals(receipt(a).payload.auth_detail, "secret_invalid");

  const b = await run(await post(CALL_COMPLETED, "signature"), "enforce");
  assertEquals(b.res.status, 401);
  assertEquals(receipt(b).payload.auth_detail, "proof_not_accepted_for_type");
});

Deno.test("CallCompleted unauthenticated in observe mode keeps working and says auth=missing (the G-AUTH count)", async () => {
  const r = await run(await post(CALL_COMPLETED, "none"), "observe");
  assertEquals(r.res.status, 200);
  assertEquals(evidenceRows(r).length, 1);
  assertEquals(receipt(r).payload.auth, "missing");
});

Deno.test("ContactCreate accepts either proof and its receipt carries no attribution values or contact details", async () => {
  for (const proof of ["secret", "signature"] as const) {
    const r = await run(await post(CONTACT_CREATE, proof), "enforce");
    assertEquals(r.res.status, 200);
    const rec = receipt(r);
    assertEquals(rec.payload.outcome, "attribution_captured");
    assertEquals(rec.payload.auth, proof === "secret" ? "workflow_secret" : "app_signature");
    assertIdsOnly(r, ["gclid-fixture-value", "placeholder@example.test", "+61400000000"]);
  }
});

// ── every outcome leaves one ids-only receipt ─────────────

Deno.test("an unsupported signed app event is skipped with a receipt", async () => {
  const r = await run(await post({ type: "TaskCreate", locationId: TEST_LOCATION_ID, contactId: "c1", title: "Task words" }, "signature"), "enforce");
  assertEquals(r.res.status, 200);
  assertEquals(receipt(r).payload.outcome, "skipped_unsupported");
  assertIdsOnly(r, ["Task words"]);
});

Deno.test("capture lane off: receipt capture_disabled, no evidence row", async () => {
  const r = await run(await post(R1_INBOUND, "signature"), "enforce", { laneOn: false });
  assertEquals(r.res.status, 200);
  assertEquals(evidenceRows(r).length, 0);
  assertEquals(receipt(r).payload.outcome, "capture_disabled");
});

Deno.test("invalid JSON is answered 400 with a receipt and the text is never logged", async () => {
  const raw = "not json but a customer said hello";
  const r = await run(await post(null, "none", raw), "observe");
  assertEquals(r.res.status, 400);
  const rec = receipt(r);
  assertEquals(rec.payload.outcome, "invalid_json");
  assertEquals(rec.payload.type, "unknown");
  assertFalse(r.logs.includes("customer said hello"));
});

Deno.test("an insert failure returns the error code only, never the database message", async () => {
  const r = await run(await post(R1_INBOUND, "signature"), "enforce", {
    jobs: R1_JOBS,
    insertError: { code: "22P02", message: `invalid input syntax: ${R1_TEXT}` },
  });
  assertEquals(r.res.status, 500);
  assertEquals(r.json.error, "22P02");
  const rec = receipt(r);
  assertEquals(rec.status, "failed");
  assertEquals(rec.error_message, "22P02");
  assertIdsOnly(r, [R1_TEXT]);
});

Deno.test("a duplicate delivery of R1 is receipted duplicate", async () => {
  const r = await run(await post(R1_INBOUND, "signature"), "enforce", {
    jobs: R1_JOBS,
    insertError: { code: "23505", message: "duplicate key" },
  });
  assertEquals(r.res.status, 200);
  assertEquals(receipt(r).payload.outcome, "duplicate");
});

Deno.test("receipt ids reject anything that is not id-shaped", async () => {
  const hostile = { ...R10_INBOUND, messageId: "hello there, call me on 0400 000 000", contactId: { nested: true }, webhookId: "x".repeat(200) };
  const r = await run(await post(hostile, "signature"), "enforce");
  const rec = receipt(r);
  assertEquals(rec.payload.message_id, null);
  assertEquals(rec.payload.contact_id, null);
  assertEquals(rec.payload.webhook_id, null);
  assertStringIncludes(JSON.stringify(rec.payload), "InboundMessage");
});

Deno.test("no raw webhook body is written to webhook_log for any type", async () => {
  for (const [body, proof] of [[R1_INBOUND, "signature"], [CALL_COMPLETED, "secret"], [CONTACT_CREATE, "secret"]] as const) {
    const r = await run(await post(body, proof), "observe", { jobs: R1_JOBS });
    const rec = receipt(r);
    assert(rec.payload.receipt === "ids_only_v1");
    assertFalse("body" in rec.payload);
    assertFalse(JSON.stringify(rec).includes("+61400000000"));
  }
});

// ── deploy wiring ─────────────────────────────────────────

Deno.test("index.ts keeps --no-verify-jwt in its first 30 lines (the deploy workflow reads it)", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const head = source.split("\n").slice(0, 30).join("\n");
  assertStringIncludes(head, "--no-verify-jwt");
});

Deno.test("a GHL app ContactCreate (contact named as id) is receipted with that contact id", async () => {
  const appShape = { type: "ContactCreate", locationId: TEST_LOCATION_ID, id: "app-contact-0001", webhookId: "wh-app-contact" };
  const r = await run(await post(appShape, "signature"), "enforce");
  assertEquals(receipt(r).payload.contact_id, "app-contact-0001");
});
