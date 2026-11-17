/**
 * P0-14.5: the completion pack check reads in bulk and picks exactly the jobs
 * the old per-job loop picked.
 *
 * The completion-pack function can email the client while
 * feature_flags.completion_pack_client_email_v1 is on, so "who gets a pack" must
 * not move. Three proofs:
 *   1. the pure picker against each old rule;
 *   2. a differential run: the old loop (copied verbatim from daily-digest
 *      before P0-14) and the new trigger, each through a real supabase-js
 *      client against one small PostgREST stand-in holding the same rows, give
 *      identical completion-pack calls and dedupe rows;
 *   3. a counting run: 225 completed jobs and 3,000 paid invoices cost at most
 *      8 reads and no single-job lookup.
 * All job numbers, references and ids are synthetic.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ilikeContains,
  pickCompletionPackJobs,
} from "./completion_pack_pick.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-17T03:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const ORG = "00000000-0000-0000-0000-000000000001";

// ── 1. The picker, rule by rule ───────────────────────────────

Deno.test("picker: one paid invoice 3 days old and no sent event is picked", () => {
  const job = { id: "j1", job_number: "SWF-91001" };
  assertEquals(
    pickCompletionPackJobs(
      [job],
      [{ reference: "SWF-91001 final", fully_paid_on: ago(3) }],
      new Set(),
      NOW,
    ),
    [job],
  );
});

Deno.test("picker: paid 1 day ago is not picked; exactly 2 whole days is", () => {
  const job = { id: "j1", job_number: "SWF-91001" };
  assertEquals(
    pickCompletionPackJobs(
      [job],
      [{ reference: "SWF-91001", fully_paid_on: ago(1) }],
      new Set(),
      NOW,
    ),
    [],
  );
  assertEquals(
    pickCompletionPackJobs(
      [job],
      [{ reference: "SWF-91001", fully_paid_on: ago(1.999) }],
      new Set(),
      NOW,
    ),
    [],
  );
  assertEquals(
    pickCompletionPackJobs(
      [job],
      [{ reference: "SWF-91001", fully_paid_on: ago(2) }],
      new Set(),
      NOW,
    ),
    [job],
  );
});

Deno.test("picker: two matching invoices is not picked (maybeSingle answered nothing)", () => {
  const job = { id: "j1", job_number: "SWF-91001" };
  assertEquals(
    pickCompletionPackJobs(
      [job],
      [
        { reference: "SWF-91001 deposit", fully_paid_on: ago(9) },
        { reference: "SWF-91001 final", fully_paid_on: ago(3) },
      ],
      new Set(),
      NOW,
    ),
    [],
  );
});

Deno.test("picker: already sent is not picked", () => {
  const job = { id: "j1", job_number: "SWF-91001" };
  assertEquals(
    pickCompletionPackJobs(
      [job],
      [{ reference: "SWF-91001", fully_paid_on: ago(3) }],
      new Set(["j1"]),
      NOW,
    ),
    [],
  );
});

Deno.test("picker: a lower-case reference still matches; a longer number contains the job number", () => {
  const lower = { id: "j1", job_number: "SWF-91001" };
  assertEquals(
    pickCompletionPackJobs(
      [lower],
      [{ reference: "swf-91001", fully_paid_on: ago(3) }],
      new Set(),
      NOW,
    ),
    [lower],
  );
  // Contains, not equals: SWF-9100 is inside SWF-91002, as the old ILIKE read it.
  const short = { id: "j2", job_number: "SWF-9100" };
  assertEquals(
    pickCompletionPackJobs(
      [short],
      [{ reference: "SWF-91002", fully_paid_on: ago(3) }],
      new Set(),
      NOW,
    ),
    [short],
  );
});

Deno.test("picker: no paid date or no reference never matches", () => {
  const job = { id: "j1", job_number: "SWF-91001" };
  assertEquals(
    pickCompletionPackJobs(
      [job],
      [{ reference: "SWF-91001", fully_paid_on: null }],
      new Set(),
      NOW,
    ),
    [],
  );
  const blank = { id: "j2", job_number: "" };
  assertEquals(
    pickCompletionPackJobs(
      [blank],
      [{ reference: null, fully_paid_on: ago(3) }],
      new Set(),
      NOW,
    ),
    [],
  );
});

Deno.test("ilikeContains keeps ILIKE's wildcards and nothing else", () => {
  assert(ilikeContains("A_C").test("xxabcxx"));
  assert(ilikeContains("A%C").test("a long c"));
  assert(ilikeContains("A*C").test("a long c"));
  assert(!ilikeContains("A.C").test("abc"));
  assert(ilikeContains("A.C").test("a.c"));
  assert(ilikeContains("(1)+").test("x(1)+y"));
});

// ── A small PostgREST stand-in ────────────────────────────────

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;
type Call = {
  method: string;
  table: string;
  params: URLSearchParams;
  body: any;
  url: string;
};

const URL_BASE = "http://127.0.0.1:9";

function likeRegex(pattern: string, caseless: boolean): RegExp {
  let body = "";
  for (const ch of pattern) {
    if (ch === "%" || ch === "*") body += "[\\s\\S]*";
    else if (ch === "_") body += "[\\s\\S]";
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${body}$`, caseless ? "i" : "");
}

function matches(row: Row, column: string, filter: string): boolean {
  const v = row[column];
  if (filter === "not.is.null") return v != null;
  if (filter === "is.null") return v == null;
  const [op, ...rest] = filter.split(".");
  const arg = rest.join(".");
  switch (op) {
    case "eq":
      return v != null && String(v) === arg;
    case "lt":
      return v != null && Date.parse(v) < Date.parse(arg);
    case "ilike":
      return v != null && likeRegex(arg, true).test(String(v));
    case "in": {
      const list = arg.replace(/^\(|\)$/g, "").split(",").map((x) =>
        x.replace(/^"|"$/g, "")
      );
      return v != null && list.includes(String(v));
    }
    default:
      throw new Error(`stand-in does not know filter ${filter}`);
  }
}

const RESERVED = new Set([
  "select",
  "order",
  "offset",
  "limit",
  "on_conflict",
  "columns",
]);

function withStandIn(
  tables: Tables,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch =
    // deno-lint-ignore require-await
    (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : null;
      const url = new URL(req ? req.url : String(input));
      const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
      let body: any = init?.body ?? null;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch { /* keep raw */ }
      }
      const table = url.pathname.includes("/rest/v1/")
        ? url.pathname.split("/rest/v1/")[1]
        : "";
      calls.push({
        method,
        table,
        params: url.searchParams,
        body,
        url: url.toString(),
      });
      if (!table) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (method === "POST") {
        const rows = Array.isArray(body) ? body : [body];
        (tables[table] ??= []).push(...rows);
        return new Response(null, { status: 201 });
      }
      let rows = [...(tables[table] ?? [])];
      for (const [k, f] of url.searchParams) {
        if (RESERVED.has(k)) continue;
        rows = rows.filter((r) => matches(r, k, f));
      }
      const order = url.searchParams.get("order");
      if (order) {
        const [col, dir] = order.split(".");
        rows.sort((a, b) =>
          (String(a[col]) < String(b[col])
            ? -1
            : String(a[col]) > String(b[col])
            ? 1
            : 0) * (dir === "desc" ? -1 : 1)
        );
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = url.searchParams.has("limit")
        ? Number(url.searchParams.get("limit"))
        : 1000;
      rows = rows.slice(offset, offset + Math.min(limit, 1000));
      const select = (url.searchParams.get("select") ?? "*").split(",");
      const projected = rows.map((r) => {
        if (select[0] === "*") return r;
        const out: Row = {};
        for (const s of select) {
          const [alias, col] = s.includes(":") ? s.split(":") : [s, s];
          out[alias] = r[col];
        }
        return out;
      });
      return new Response(JSON.stringify(projected), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

async function withNow<T>(fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => NOW;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

// ── The old loop, copied verbatim (daily-digest/index.ts before P0-14) ──

const SUPABASE_URL = URL_BASE;
const SUPABASE_SERVICE_KEY = "test-service-role-key";
const DEFAULT_ORG_ID = ORG;

async function oldCompletionPackLoop(sb: any) {
  // Completion pack trigger: completed + paid + 2 days
  try {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    const { data: completedPaid } = await sb.from("jobs")
      .select("id, job_number")
      .eq("status", "complete")
      .eq("org_id", DEFAULT_ORG_ID)
      .lt("completed_at", twoDaysAgo);

    for (const job of (completedPaid || [])) {
      // Check if final invoice is paid
      const { data: paidInvoice } = await sb.from("xero_invoices")
        .select("id, fully_paid_on_date:fully_paid_on")
        .ilike("reference", `%${job.job_number}%`)
        .eq("status", "PAID")
        .not("fully_paid_on", "is", null)
        .maybeSingle();

      if (!paidInvoice) continue;
      const daysSincePaid = Math.floor(
        (Date.now() - new Date(paidInvoice.fully_paid_on_date).getTime()) /
          86400000,
      );
      if (daysSincePaid < 2) continue;

      // Check if completion pack already sent
      const { data: existing } = await sb.from("business_events")
        .select("id")
        .eq("event_type", "job.completion_pack_sent")
        .eq("entity_id", job.id)
        .limit(1);

      if (existing && existing.length > 0) continue;

      // Trigger completion pack
      try {
        await fetch(SUPABASE_URL + "/functions/v1/completion-pack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          },
          body: JSON.stringify({ job_id: job.id }),
        });
        // Log event for dedup
        await sb.from("business_events").insert({
          event_type: "job.completion_pack_sent",
          source: "daily-digest/completion_pack",
          entity_type: "job",
          entity_id: job.id,
          payload: { job_number: job.job_number },
        });
      } catch (e) {
        console.log(
          `[completion-pack] trigger failed for ${job.job_number}:`,
          e,
        );
      }
    }
  } catch (e) {
    console.log("[daily-digest] completion pack trigger error:", e);
  }
}

// ── 2. Differential: old loop and new trigger over the same rows ──

function fixture(): Tables {
  const job = (
    id: string,
    job_number: string | null,
    completedDaysAgo = 10,
    status = "complete",
  ) => ({
    id,
    job_number,
    status,
    org_id: ORG,
    completed_at: ago(completedDaysAgo),
  });
  let n = 0;
  const inv = (
    reference: string | null,
    paidDaysAgo: number | null,
    status = "PAID",
  ) => ({
    id: `inv-${String(++n).padStart(3, "0")}`,
    reference,
    status,
    fully_paid_on: paidDaysAgo == null ? null : ago(paidDaysAgo),
  });
  return {
    jobs: [
      job("job-a", "SWF-92001"), // one paid invoice, 3 days: picked
      job("job-b", "SWF-92002"), // paid 1.99 days ago: not yet
      job("job-c", "SWF-92003"), // paid exactly 2 days ago: picked
      job("job-d", "SWF-92004"), // two paid invoices: skipped
      job("job-e", "SWF-92005"), // already sent: skipped
      job("job-f", "SWF-92006"), // lower-case reference: picked
      job("job-g", "SWF-9207"), // inside the longer SWF-92070: picked, as before
      job("job-h", "SWF-92008"), // only an unpaid invoice: skipped
      job("job-i", "SWF-92009"), // paid invoice with no paid date: skipped
      job("job-j", null), // no job number: matches nothing
      job("job-k", "SWF-92011", 1), // finished yesterday: not in the jobs read
      job("job-l", "SWF-92012", 10, "invoiced"), // not complete
      job("job-m", "SWP_92013"), // underscore stays an ILIKE wildcard
    ],
    xero_invoices: [
      inv("SWF-92001 final", 3),
      inv("SWF-92002", 1.99),
      inv("SWF-92003", 2),
      inv("SWF-92004 deposit", 20),
      inv("SWF-92004 final", 5),
      inv("SWF-92005", 6),
      inv("swf-92006 balance", 4),
      inv("SWF-92070", 8),
      inv("SWF-92008", null, "AUTHORISED"),
      inv("SWF-92009", null),
      inv(null, 3),
      inv("SWF-92011", 5),
      inv("SWF-92012", 5),
      inv("SWPX92013", 5),
    ],
    business_events: [
      {
        id: "ev-1",
        event_type: "job.completion_pack_sent",
        entity_id: "job-e",
      },
      { id: "ev-2", event_type: "job.other", entity_id: "job-a" },
    ],
  };
}

function outcome(calls: Call[]) {
  return {
    packs: calls.filter((c) => c.url.includes("/functions/v1/completion-pack"))
      .map((c) => ({ method: c.method, body: c.body })),
    dedupe: calls.filter((c) =>
      c.method === "POST" && c.table === "business_events"
    ).map((c) => c.body),
  };
}

async function runOld(tables: Tables) {
  let result: ReturnType<typeof outcome> | null = null;
  await withStandIn(tables, async (calls) => {
    await withNow(() =>
      oldCompletionPackLoop(createClient(URL_BASE, SUPABASE_SERVICE_KEY))
    );
    result = outcome(calls);
  });
  return result!;
}

const ENV = {
  SUPABASE_URL: URL_BASE,
  SUPABASE_SERVICE_ROLE_KEY: SUPABASE_SERVICE_KEY,
};
async function newTrigger() {
  const saved = Object.fromEntries(
    Object.keys(ENV).map((k) => [k, Deno.env.get(k)]),
  );
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  try {
    return (await import("./index.ts"))._runCompletionPackTriggerForTest;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
  }
}

async function runNew(tables: Tables) {
  const trigger = await newTrigger();
  let result: ReturnType<typeof outcome> | null = null;
  let reads: Call[] = [];
  await withStandIn(tables, async (calls) => {
    await withNow(() => trigger(createClient(URL_BASE, SUPABASE_SERVICE_KEY)));
    result = outcome(calls);
    reads = calls.filter((c) => c.method === "GET" && c.table);
  });
  return { ...result!, reads };
}

Deno.test("differential: the new trigger calls completion-pack for exactly the jobs the old loop did", async () => {
  const old = await runOld(fixture());
  const now = await runNew(fixture());
  assertEquals(now.packs, old.packs);
  assertEquals(now.dedupe, old.dedupe);
  // The expected set, so an empty-on-both run cannot pass.
  assertEquals(old.packs.map((p) => p.body.job_id), [
    "job-a",
    "job-c",
    "job-f",
    "job-g",
    "job-m",
  ]);
  for (const p of old.packs) assertEquals(p.method, "POST");
});

Deno.test("differential: a second run after the first sends nothing, old and new alike", async () => {
  const tablesOld = fixture();
  await runOld(tablesOld);
  const secondOld = await runOld(tablesOld);
  const tablesNew = fixture();
  await runNew(tablesNew);
  const secondNew = await runNew(tablesNew);
  assertEquals(secondOld.packs, []);
  assertEquals(secondNew.packs, []);
});

Deno.test("a failed read triggers nothing", async () => {
  const trigger = await newTrigger();
  const original = globalThis.fetch;
  const packs: string[] = [];
  globalThis.fetch = ((input: Request | URL | string) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/functions/v1/completion-pack")) packs.push(url);
    if (url.includes("/rest/v1/xero_invoices")) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
      );
    }
    if (url.includes("/rest/v1/jobs")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([{ id: "job-a", job_number: "SWF-92001" }]),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("[]", { status: 200 }));
  }) as typeof fetch;
  try {
    await withNow(() => trigger(createClient(URL_BASE, SUPABASE_SERVICE_KEY)));
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(packs, []);
});

// ── 3. Counting: 225 jobs, 3,000 paid invoices ────────────────

Deno.test("225 completed jobs and 3,000 paid invoices cost at most 8 reads and no single lookup", async () => {
  const jobs = Array.from({ length: 225 }, (_, i) => ({
    id: `job-${i}`,
    job_number: `SWF-7${String(i).padStart(4, "0")}`,
    status: "complete",
    org_id: ORG,
    completed_at: ago(30),
  }));
  const invoices = Array.from({ length: 3000 }, (_, i) => ({
    id: `inv-${String(i).padStart(5, "0")}`,
    // The first 225 belong to the jobs; the rest are other work.
    reference: i < 225
      ? `SWF-7${String(i).padStart(4, "0")} final`
      : `OTHER-${i}`,
    status: "PAID",
    fully_paid_on: ago(10),
  }));
  const tables: Tables = { jobs, xero_invoices: invoices, business_events: [] };
  const result = await runNew(tables);
  assert(result.reads.length <= 8, `${result.reads.length} reads`);
  // No per-job lookup: never an ilike on reference, never an eq on entity_id.
  assertEquals(result.reads.filter((c) => c.params.has("reference")), []);
  assertEquals(
    result.reads.filter((c) =>
      (c.params.get("entity_id") ?? "").startsWith("eq.")
    ),
    [],
  );
  assertEquals(result.packs.length, 225);
});
