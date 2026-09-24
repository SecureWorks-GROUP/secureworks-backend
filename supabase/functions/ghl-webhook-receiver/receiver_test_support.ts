// Test support for the receiver suites (slices C1b and C1c): the real handler
// driven through an in-memory database, a real Ed25519 key pair and a fake
// provider fetch. No network, no live GHL, no production credentials.
import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _resetFlagCache } from "../_shared/evidence/feature_flag.ts";
import { handleGhlWebhook, type ReceiverDeps } from "./handler.ts";
import {
  legacyCallClient,
  type StoredEvent,
} from "../_shared/evidence/ghl_call_pair_test_support.ts";
import { TEST_LOCATION_ID, TEST_WEBHOOK_SECRET } from "./named_rows_fixture.ts";

// ── in-memory database ────────────────────────────────────

export type Row = Record<string, unknown>;
export interface Op {
  table: string;
  kind: "select" | "insert" | "update";
  row?: Row;
  filters: Array<[string, unknown]>;
}

export interface DbOptions {
  laneOn?: boolean;
  jobs?: Row[];
  /**
   * A database error. For a direct insert (legacy workflow rows) it is the
   * insert's error; for capture_business_event it becomes the writer's own
   * answer: 23505 is `duplicate`, anything else `error` with that code.
   */
  insertError?: { code: string; message: string } | null;
  /** feature_flags rows by flag_name. Default: ghl_message_capture_v2 on. */
  flags?: Record<string, boolean>;
  /** Overrides capture_business_event's answer for one row. */
  capture?: (row: Row) => { data: unknown; error: unknown };
  /**
   * Existing business_events rows the legacy call pairing reads (slice T1).
   * Reads are answered by ghl_call_pair_test_support's filter; never written.
   */
  events?: StoredEvent[];
}

export interface RpcCall {
  name: string;
  args: Row | undefined;
}

export function fakeDb(opts: DbOptions = {}) {
  const ops: Op[] = [];
  const rpcs: string[] = [];
  const rpcCalls: RpcCall[] = [];
  const flags = opts.flags ?? { ghl_message_capture_v2: true };
  let saved = 0;
  const client = {
    rpc(name: string, args?: Row) {
      rpcs.push(name);
      rpcCalls.push({ name, args });
      if (name === "capture_business_event") {
        const row = args?.p_row as Row;
        // The writer's row is recorded as the business_events insert it becomes.
        ops.push({
          table: "business_events",
          kind: "insert",
          row,
          filters: [],
        });
        if (opts.capture) return Promise.resolve(opts.capture(row));
        if (opts.insertError?.code === "23505") {
          return Promise.resolve({
            data: {
              outcome: "duplicate",
              id: "66666666-6666-4666-8666-666666666666",
              job_id: null,
              attribution_status: "pending_luna",
              upgraded: false,
            },
            error: null,
          });
        }
        if (opts.insertError) {
          return Promise.resolve({
            data: { outcome: "error", code: opts.insertError.code },
            error: null,
          });
        }
        saved++;
        return Promise.resolve({
          data: {
            outcome: "inserted",
            id: `77777777-7777-4777-8777-${String(saved).padStart(12, "0")}`,
            job_id: null,
            attribution_status: "pending_luna",
          },
          error: null,
        });
      }
      if (name === "record_ghl_webhook_receipt") {
        ops.push({
          table: "ghl_webhook_receipts",
          kind: "insert",
          row: args?.p_receipt as Row,
          filters: [],
        });
        return Promise.resolve({
          data: { outcome: "recorded", id: rpcs.length },
          error: null,
        });
      }
      return Promise.resolve({
        data: name === "automation_lane_enabled" ? (opts.laneOn ?? true) : null,
        error: null,
      });
    },
    from(table: string) {
      // A business_events select is the legacy call pairing's read.
      if (table === "business_events") {
        const pairing = legacyCallClient(opts.events ?? []).client.from(table);
        let writing = false;
        const write = {
          insert: (row: Row) => {
            writing = true;
            const op: Op = { table, kind: "insert", row, filters: [] };
            ops.push(op);
            return {
              then: (
                res: (v: unknown) => unknown,
                rej?: (e: unknown) => unknown,
              ) =>
                Promise.resolve({ data: null, error: opts.insertError ?? null })
                  .then(res, rej),
            };
          },
        };
        // deno-lint-ignore no-explicit-any
        const both: any = {
          ...write,
          select: (...a: unknown[]) => (pairing.select(...a), both),
          eq: (k: string, v: unknown) => (
            ops.push({ table, kind: "select", filters: [[k, v]] }),
              pairing.eq(k, v),
              both
          ),
          or: (e: string) => (pairing.or(e), both),
          limit: (n: number) => (pairing.limit(n), both),
          then: (
            res: (v: unknown) => unknown,
            rej?: (e: unknown) => unknown,
          ) => (writing ? Promise.resolve(null) : pairing).then(res, rej),
        };
        return both;
      }
      const op: Op = { table, kind: "select", filters: [] };
      const result = () => {
        if (op.kind === "insert") {
          if (table === "business_events" && opts.insertError) {
            return { data: null, error: opts.insertError };
          }
          return { data: null, error: null };
        }
        if (op.kind === "update") return { data: null, error: null };
        if (table === "jobs") return { data: opts.jobs ?? [], error: null };
        if (table === "feature_flags") {
          const name = op.filters.find(([k]) => k === "flag_name")?.[1];
          return {
            data: [{ enabled: flags[String(name)] === true }],
            error: null,
          };
        }
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
  return { client, ops, rpcs, rpcCalls };
}

// ── keys, env, requests ───────────────────────────────────

export const keyPair = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  [
    "sign",
    "verify",
  ],
) as CryptoKeyPair;
const otherKeyPair = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"],
) as CryptoKeyPair;
const spki = new Uint8Array(
  await crypto.subtle.exportKey("spki", keyPair.publicKey),
);
export const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----\n${
  btoa(String.fromCharCode(...spki))
}\n-----END PUBLIC KEY-----`;

export async function sign(raw: string, pair = keyPair): Promise<string> {
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      pair.privateKey,
      new TextEncoder().encode(raw),
    ),
  );
  return btoa(String.fromCharCode(...sig));
}

export function env(
  mode: "observe" | "enforce",
  extra: Record<string, string> = {},
) {
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

export type Proof = "signature" | "secret" | "wrong_key" | "legacy" | "none";

export async function post(
  body: unknown,
  proof: Proof,
  rawOverride?: string,
): Promise<Request> {
  const raw = rawOverride ?? JSON.stringify(body);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (proof === "signature") headers.set("X-GHL-Signature", await sign(raw));
  if (proof === "wrong_key") {
    headers.set("X-GHL-Signature", await sign(raw, otherKeyPair));
  }
  if (proof === "secret") headers.set("X-Webhook-Secret", TEST_WEBHOOK_SECRET);
  if (proof === "legacy") {
    headers.set("X-WH-Signature", "bGVnYWN5LXJzYS1zaWduYXR1cmU=");
  }
  return new Request(
    "https://project.example.test/functions/v1/ghl-webhook-receiver",
    { method: "POST", headers, body: raw },
  );
}

export interface Run {
  res: Response;
  json: Row;
  ops: Op[];
  rpcs: string[];
  rpcCalls: RpcCall[];
  logs: string;
  fetches: Array<{ url: string; body: string }>;
}

export async function run(
  req: Request,
  mode: "observe" | "enforce",
  db: DbOptions = {},
  envExtra: Record<string, string> = {},
  /** Answers every outbound fetch (the GHL provider read). Default: 200 "{}". */
  provider?: (url: string) => Response | Promise<Response>,
): Promise<Run> {
  _resetFlagCache();
  const { client, ops, rpcs, rpcCalls } = fakeDb(db);
  const fetches: Array<{ url: string; body: string }> = [];
  const pending: Promise<unknown>[] = [];
  const deps: ReceiverDeps = {
    env: env(mode, envExtra),
    createSupabase: () => client,
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      fetches.push({ url: String(input), body: String(init?.body ?? "") });
      if (provider) return Promise.resolve(provider(String(input)));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
    waitUntil: (p) => void pending.push(p),
  };
  const lines: string[] = [];
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  const capture = (...args: unknown[]) =>
    void lines.push(args.map(String).join(" "));
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  try {
    const res = await handleGhlWebhook(req, deps);
    await Promise.all(pending);
    const text = await res.text();
    return {
      res,
      json: text ? JSON.parse(text) : {},
      ops,
      rpcs,
      rpcCalls,
      logs: lines.join("\n"),
      fetches,
    };
  } finally {
    Object.assign(console, original);
  }
}

export const receipts = (r: Run) =>
  r.ops.filter((o) => o.table === "webhook_log" && o.kind === "insert");
export const receipt = (r: Run) => {
  const all = receipts(r);
  assertEquals(all.length, 1, "exactly one webhook_log receipt per delivery");
  return all[0].row as Row & { payload: Row };
};
export const evidenceRows = (r: Run) =>
  r.ops.filter((o) => o.table === "business_events" && o.kind === "insert").map(
    (o) => o.row as Row,
  );

/** A receipt carries identifiers and codes only: never text, phone, email or custom fields. */
export function assertIdsOnly(r: Run, forbidden: string[]) {
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
  for (const s of forbidden) {
    assertFalse(serialised.includes(s), `receipt must not carry ${s}`);
  }
  for (const s of forbidden) {
    assertFalse(r.logs.includes(s), `logs must not carry ${s}`);
  }
}

/** The ghl_webhook_receipts rows a run wrote (slice C1c): exactly one per delivery. */
export const ghlReceipt = (r: Run): Row => {
  const all = r.ops.filter((o) =>
    o.table === "ghl_webhook_receipts" && o.kind === "insert"
  );
  assertEquals(
    all.length,
    1,
    "exactly one ghl_webhook_receipts row per delivery",
  );
  return all[0].row as Row;
};
