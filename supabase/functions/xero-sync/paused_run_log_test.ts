// A sync_invoices run that ends in Xero's pause after its paging still logs,
// as 'paused', and throws the same error again. Fake client only.
import { assert, assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert@1";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import { logPausedRun } from "./paused_run_log.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const pause = () =>
  new XeroCooldownError("Xero rate limited; wait until retry_at before another request", 429, "XERO_RATE_LIMITED", {
    retry_at: "2026-11-19T02:00:00.000Z",
    provider_called: true,
  });

function fakeSb(mode: "ok" | "error" | "throw" = "ok") {
  const inserts: Array<{ table: string; row: any }> = [];
  return {
    inserts,
    from(table: string) {
      return {
        insert(row: any) {
          inserts.push({ table, row });
          if (mode === "throw") throw new Error("network");
          return Promise.resolve({ data: null, error: mode === "error" ? { code: "XX000" } : null });
        },
      };
    },
  };
}

Deno.test("paused run: a Xero pause after the matcher writes one 'paused' row with the matcher's counts, then throws the same error (still 429)", async () => {
  const sb = fakeSb();
  let matchRun: Record<string, unknown> = { switch: "off" };
  const err = pause();
  const thrown = await assertRejects(() =>
    logPausedRun(sb, ORG, () => ({ synced: 4, cost_lines_match: matchRun }), async () => {
      matchRun = { run: 3, backlog: 1, skipped: { labour_bill: 1 } }; // the matcher ran
      throw err; // a later step hit the pause
    })
  );
  assertStrictEquals(thrown, err, "the same error, so the action still answers 429");
  assertEquals((thrown as XeroCooldownError).status, 429);
  assertEquals(sb.inserts.length, 1);
  const { table, row } = sb.inserts[0];
  assertEquals(table, "webhook_log");
  assertEquals([row.org_id, row.source, row.event_type, row.status], [ORG, "xero", "sync_invoices", "paused"]);
  assert(row.status !== "processed", "a processed row reads as the run reached its end");
  assertEquals(row.payload.synced, 4);
  assertEquals(row.payload.cost_lines_match, { run: 3, backlog: 1, skipped: { labour_bill: 1 } }, "the counts at the pause");
  assertEquals(row.payload.paused_by_xero, { code: "XERO_RATE_LIMITED", status: 429, retry_at: "2026-11-19T02:00:00.000Z" });
});

Deno.test("paused run: a failed log write never swallows the pause", async () => {
  for (const mode of ["error", "throw"] as const) {
    const sb = fakeSb(mode);
    const err = pause();
    const thrown = await assertRejects(() => logPausedRun(sb, ORG, () => ({}), () => Promise.reject(err)));
    assertStrictEquals(thrown, err, mode);
    assertEquals(sb.inserts.length, 1, mode);
  }
});

Deno.test("paused run: any other error writes nothing and passes through untouched", async () => {
  const sb = fakeSb();
  const err = new Error("boom");
  const thrown = await assertRejects(() => logPausedRun(sb, ORG, () => ({ synced: 1 }), () => Promise.reject(err)));
  assertStrictEquals(thrown, err);
  assertEquals(sb.inserts.length, 0);
});

Deno.test("paused run: a run that reaches its end returns its answer and adds no row", async () => {
  const sb = fakeSb();
  const out = await logPausedRun(sb, ORG, () => ({}), () => Promise.resolve({ success: true, synced: 2 }));
  assertEquals(out, { success: true, synced: 2 });
  assertEquals(sb.inserts.length, 0);
});

Deno.test("paused run: sync_invoices wraps only what follows the incremental marker; the marker, the processed row and the 429 answer stay where they were", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = src.indexOf("async function syncInvoices(");
  const marker = src.indexOf("{ key: 'sync_invoices', cursor_at: runStartedAt", start);
  const wrap = src.indexOf("return await logPausedRun(sb, DEFAULT_ORG_ID,", start);
  const matcher = src.indexOf("matchRun = await syncMatchStep(", start);
  const processed = src.indexOf("status: 'processed'", wrap);
  const end = src.indexOf("\n}\n", wrap);
  assert(start > 0 && marker > start && wrap > marker, "the marker is saved before the wrap");
  assert(matcher > wrap && processed > wrap && processed < end, "the matcher and the processed row are inside it");
  assertEquals(src.slice(start, wrap).includes("logPausedRun"), false, "the paging above is not wrapped");
  assert(src.includes("if (err instanceof XeroCooldownError) {\n      return json({ ok: false, code: err.code, error: err.message, ...err.details }, err.status)"), "the 429 answer is unchanged");
});
