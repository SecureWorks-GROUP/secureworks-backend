import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertCaptureEnabled, CaptureDisabledError, insertCapturedEvidence } from "./capture_guard.ts";

Deno.test("legacy capture guard returns skipped without writing on missing/off/error", async () => {
  for (const outcome of [{ data: false, error: null }, { data: null, error: null },
    { data: true, error: { message: "unavailable" } }, new Error("network")]) {
    let evidenceWrites = 0;
    const client = {
      rpc: () => outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
      from: () => ({ insert: () => { evidenceWrites++; return Promise.resolve({ error: null }); } }),
    };
    const result = await insertCapturedEvidence(client, { event_type: "quote.accepted" });
    assertEquals(result.skipped, true);
    assertEquals(result.error, null);
    assertEquals(evidenceWrites, 0);
  }
});

Deno.test("legacy capture guard rereads switch and propagates real insert errors", async () => {
  let enabled = true;
  let writes = 0;
  const client = {
    rpc: () => Promise.resolve({ data: enabled, error: null }),
    from: () => ({ insert: () => { writes++; return Promise.resolve({ error: { message: "write failed" } }); } }),
  };
  assertEquals((await insertCapturedEvidence(client, {})).error.message, "write failed");
  enabled = false;
  assertEquals((await insertCapturedEvidence(client, {})).skipped, true);
  assertEquals(writes, 1);
});

Deno.test("legacy fallback rereads capture after the primary writer is refused", async () => {
  let enabled = true;
  let writes = 0;
  const client = {
    rpc: () => Promise.resolve({ data: enabled, error: null }),
    from: () => ({ insert: () => { writes++; return Promise.resolve({ data: null, error: null }); } }),
  };
  await assertCaptureEnabled(client);
  enabled = false;
  await assertRejects(() => assertCaptureEnabled(client), CaptureDisabledError);
  assertEquals(await insertCapturedEvidence(client, { event_type: "client.email_in" }), {
    data: null, error: null, skipped: true,
  });
  assertEquals(writes, 0);
});

Deno.test("legacy capture returns database attribution when requested", async () => {
  const persisted = { id: "event", job_id: null, attribution_status: "pending_luna" };
  const client = {
    rpc: () => Promise.resolve({ data: true, error: null }),
    from: () => ({ insert: () => ({ select: (columns: string) => {
      assertEquals(columns, "id,job_id,attribution_status");
      return { maybeSingle: () => Promise.resolve({ data: persisted, error: null }) };
    } }) }),
  };
  const result = await insertCapturedEvidence(client, { job_id: "caller-job" }, "id,job_id,attribution_status");
  assertEquals(result.data, persisted);
});
