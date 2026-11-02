// Synthetic source-time regression; no provider or production access.
// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { contextMessageOriginal, MessageOriginalError } from "./context_message_original.ts";

const id = "c7a00000-0000-4000-8000-000000000001";
const original = "2026-09-17T04:43:15.377Z";
const loaded = "2026-09-24T23:15:01.424Z";
function client(time: unknown, error: unknown = null, payload = { body: "Synthetic original", ghl_message_id: " msg1 " }) {
  const calls: unknown[] = [];
  const row = { id, source: "ghl_sms_cache_backfill", channel: "sms", event_type: "client.reply", event_at: loaded, occurred_at: loaded, contact_id: "contact1", job_id: null, provider_message_id: "ghl:msg1", payload };
  const api = {
    from(table: string) {
      assertEquals(table, "business_events");
      const q = { select: (_columns: string) => q, eq: (_key: string, _value: string) => q, maybeSingle: () => Promise.resolve({ data: row, error: null }) };
      return q;
    },
    rpc(name: string, args: unknown) { calls.push({ name, args }); return Promise.resolve({ data: time, error }); },
  };
  return { api, calls, row };
}
const params = new URLSearchParams({ event_id: id });
Deno.test("original legacy message uses retained provider time, never import time", async () => {
  const f = client(original); const result = await contextMessageOriginal(f.api, params);
  assertEquals(result.at, original); assertEquals(result.at_source, "message");
  assertEquals(f.calls, [{ name: "context_job_record_crm_time", args: { p_source: "ghl_sms_cache_backfill", p_contact_id: "contact1", p_message_id: "msg1", p_job_id: null } }]);
});
Deno.test("missing original time stays unknown", async () => {
  const result = await contextMessageOriginal(client(null).api, params);
  assertEquals(result.at, null); assertEquals(result.at_source, "unknown");
});
Deno.test("failed original-time read is an error, never a plausible import time", async () => {
  const e = await assertRejects(() => contextMessageOriginal(client(null, { message: "unavailable" }).api, params), MessageOriginalError);
  assertEquals(e.code, "message_time_read_failed"); assertEquals(e.status, 500);
});
Deno.test("legacy provider identity fallback matches the Matching resolver", async () => {
  const f = client(original, null, { body: "Synthetic original", ghl_message_id: " " });
  await contextMessageOriginal(f.api, params);
  assertEquals(f.calls, [{ name: "context_job_record_crm_time", args: { p_source: "ghl_sms_cache_backfill", p_contact_id: "contact1", p_message_id: "msg1", p_job_id: null } }]);
});
Deno.test("ordinary event time keeps its existing contract without a CRM lookup", async () => {
  const f = client(original); f.row.source = "ghl_webhook";
  const result = await contextMessageOriginal(f.api, params);
  assertEquals(result.at, loaded); assertEquals(result.at_source, "message"); assertEquals(f.calls, []);
});
