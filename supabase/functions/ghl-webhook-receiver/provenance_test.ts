import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleGhlWebhookReceiver } from "./index.ts";
import { ghlWebhookAuthenticated, resolveGhlExplicitJob } from "../_shared/evidence/ghl_provenance.ts";
import { _resetFlagCache } from "../_shared/evidence/feature_flag.ts";

const jobId = "11111111-1111-4111-8111-111111111111";
const victim = "22222222-2222-4222-8222-222222222222";
function mockClient(enabled = true, duplicateNumber = false) {
  const writes: { table: string; row: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
  const client = {
    rpc: () => Promise.resolve({ data: enabled, error: null }),
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const result = () => ({ data: table === "jobs" ? filters.id ? [{ id: filters.id }] : filters.job_number ? duplicateNumber ? [{ id: jobId }, { id: victim }] : [{ id: jobId }] : [{ id: jobId, job_number: "SW-1" }] : table === "feature_flags" ? [{ enabled: false }] : null, error: null });
      const query = {
        select: (_columns: string) => query,
        maybeSingle: () => query,
        eq(key: string, value: unknown) { filters[key] = value; return query; },
        not: (_key: string, _op: string, _value: string) => query,
        order: (_key: string, _options: unknown) => query,
        limit: (_count: number) => query,
        insert(row: Record<string, unknown>) { writes.push({ table, row, filters }); return query; },
        update(row: Record<string, unknown>) { writes.push({ table, row, filters }); return query; },
        then(resolve: (value: ReturnType<typeof result>) => unknown) { return Promise.resolve(result()).then(resolve); },
      };
      return query;
    },
  };
  return { client, writes };
}

Deno.test("GHL authentication fails closed and accepts existing header forms", () => {
  for (const expected of [undefined, ""]) assertEquals(ghlWebhookAuthenticated(new Headers({ authorization: "Bearer secret" }), expected), false);
  assertEquals(ghlWebhookAuthenticated(new Headers(), "secret"), false);
  assertEquals(ghlWebhookAuthenticated(new Headers({ "X-Webhook-Secret": "wrong" }), "secret"), false);
  for (const header of ["X-Webhook-Secret", "authorization"]) {
    for (const value of ["secret", "Bearer secret"]) assertEquals(ghlWebhookAuthenticated(new Headers({ [header]: value }), "secret"), true);
  }
});

Deno.test("explicit GHL aliases resolve verified custody and reject ambiguous references", async () => {
  const { client } = mockClient();
  const lookup = client as unknown as Parameters<typeof resolveGhlExplicitJob>[0];
  for (const alias of ["supabase_job_id", "job_id", "jobId"]) assertEquals(await resolveGhlExplicitJob(lookup, { [alias]: jobId }), { job_id: jobId, match_method: "direct_job_id" });
  for (const alias of ["job_number", "jobNumber", "jobNo"]) assertEquals(await resolveGhlExplicitJob(lookup, { [alias]: "SW-1" }), { job_id: jobId, match_method: "direct_reference" });
  assertEquals((await resolveGhlExplicitJob(lookup, { job_id: jobId, jobId: victim })).job_id, null);
  assertEquals((await resolveGhlExplicitJob(lookup, { job_id: "not-a-uuid" })).job_id, null);
  assertEquals((await resolveGhlExplicitJob(mockClient(true, true).client as unknown as Parameters<typeof resolveGhlExplicitJob>[0], { jobNumber: "SW-1" })).job_id, null);
});

Deno.test("receiver trust gate preserves diagnostic and contact-owned cancellation only", async () => {
  const previous = Deno.env.get("GHL_WEBHOOK_SECRET");
  Deno.env.set("GHL_WEBHOOK_SECRET", "secret");
  try {
    for (const [auth, enabled, configured] of [[null, true, true], ["wrong", true, true], ["secret", true, false], ["secret", false, true], ["secret", true, true]] as const) {
      if (configured) Deno.env.set("GHL_WEBHOOK_SECRET", "secret"); else Deno.env.delete("GHL_WEBHOOK_SECRET");
      const trusted = configured && auth === "secret" && enabled;
      _resetFlagCache();
      const { client, writes } = mockClient(enabled);
      let evidenceWrites = 0;
      const dependencies = {
        createClient: () => client,
        recordEvidence: () => { throw new Error("unexpected T7 call"); },
        insertCapturedEvidence: (_client: unknown, row: Record<string, unknown>) => { evidenceWrites++; writes.push({ table: "business_events", row, filters: {} }); return Promise.resolve({ data: { id: "event", job_id: null, match_method: "none" }, error: null }); },
      } as unknown as NonNullable<Parameters<typeof handleGhlWebhookReceiver>[1]>;
      const response = await handleGhlWebhookReceiver(new Request("http://localhost", { method: "POST", headers: auth ? { "X-Webhook-Secret": auth } : {}, body: JSON.stringify({ type: "InboundMessage", contactId: "contact", job_id: victim, message: "hello" }) }), dependencies);
      const body = await response.json();
      assertEquals(response.status, 200);
      assertEquals(body.event_created, trusted);
      assertEquals(evidenceWrites, trusted ? 1 : 0);
      assertEquals(writes.filter((write) => write.table === "webhook_log").length, 1);
      assertEquals(writes.filter((write) => ["smart_nudges", "ai_proposed_actions"].includes(write.table)).map((write) => write.filters.job_id), [jobId, jobId]);
      if (auth !== "secret" || !configured) assertEquals(body.reason, "evidence_auth_unverified");
      if (!trusted) {
        const originalFetch = globalThis.fetch;
        let downstreamCalls = 0;
        globalThis.fetch = () => { downstreamCalls++; throw new Error("forbidden downstream call"); };
        try {
          const callResponse = await handleGhlWebhookReceiver(new Request("http://localhost", { method: "POST", headers: auth ? { "X-Webhook-Secret": auth } : {}, body: JSON.stringify({ type: "CallCompleted", contactId: "contact", job_id: victim, recordingUrl: "https://example.invalid/call.wav" }) }), dependencies);
          assertEquals((await callResponse.json()).event_created, false);
          assertEquals(downstreamCalls, 0);
          assertEquals(evidenceWrites, 0);
          for (const type of ["ContactCreate", "ContactUpdate"]) {
            const contactResponse = await handleGhlWebhookReceiver(new Request("http://localhost", { method: "POST", headers: auth ? { "X-Webhook-Secret": auth } : {}, body: JSON.stringify({ type, contactId: "contact", gclid: "ad-click" }) }), dependencies);
            assertEquals((await contactResponse.json()).attribution_captured, true);
          }
          assertEquals(writes.filter((write) => write.table === "contact_matches").map((write) => write.row.gclid), ["ad-click", "ad-click"]);
          assertEquals(evidenceWrites, 0);
        } finally { globalThis.fetch = originalFetch; }
      }
    }
  } finally {
    if (previous === undefined) Deno.env.delete("GHL_WEBHOOK_SECRET"); else Deno.env.set("GHL_WEBHOOK_SECRET", previous);
  }
});

Deno.test("receiver retains NoteAdded text beyond preview including late references", async () => {
  _resetFlagCache();
  const previous = Deno.env.get("GHL_WEBHOOK_SECRET");
  Deno.env.set("GHL_WEBHOOK_SECRET", "secret");
  try {
    const { client } = mockClient();
    let retained: Record<string, unknown> = {};
    const dependencies = { createClient: () => client, recordEvidence: () => { throw new Error("unexpected T7"); }, insertCapturedEvidence: (_client: unknown, row: Record<string, unknown>) => { retained = row; return Promise.resolve({ data: { id: "event" }, error: null }); } } as unknown as NonNullable<Parameters<typeof handleGhlWebhookReceiver>[1]>;
    const note = "x".repeat(5000) + " SW-12345";
    const response = await handleGhlWebhookReceiver(new Request("http://localhost", { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ type: "NoteAdded", contactId: "contact", body: note }) }), dependencies);
    assertEquals(response.status, 200);
    assertEquals((retained.payload as Record<string, unknown>).note_text, note);
    assertEquals(String(retained.body_preview).length, 4096);
  } finally {
    if (previous === undefined) Deno.env.delete("GHL_WEBHOOK_SECRET"); else Deno.env.set("GHL_WEBHOOK_SECRET", previous);
  }
});
