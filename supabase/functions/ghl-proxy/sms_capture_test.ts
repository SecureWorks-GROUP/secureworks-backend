// Slice C1a: ghl-proxy send_sms saves its text once, through the shared row
// builder and the one SQL writer capture_business_event (sms.md §3 review M9).
// Behaviour runs against a recording fake client. No network, no database.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSendSmsEvidenceRow, type CaptureOutcome, saveSendSmsEvidence, sendSmsJobCustody } from "./sms_capture.ts";
import { R5 } from "../_shared/evidence/ghl_message_fixtures.ts";

// deno-lint-ignore no-explicit-any
function fakeClient(answer: { data?: any; error?: any; throws?: boolean }) {
  // deno-lint-ignore no-explicit-any
  const calls: Array<{ fn: string; args: any }> = [];
  const tableWrites: string[] = [];
  return {
    calls,
    tableWrites,
    // deno-lint-ignore no-explicit-any
    rpc(fn: string, args: any) {
      calls.push({ fn, args });
      if (answer.throws) throw new Error("network down");
      return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null });
    },
    from(table: string) {
      tableWrites.push(table);
      return { insert: () => Promise.resolve({ error: null }) };
    },
  };
}

const R5_INPUT = {
  contactId: R5.contactId,
  message: R5.body,
  fromNumber: R5.fromNumber,
  jobId: R5.jobId,
  job: { ghl_contact_id: R5.contactId },
  result: R5.sendResult,
  bodyHash: "sha256-fixture",
};

Deno.test("job custody: verified only when the job's contact is the texted contact", () => {
  assertEquals(sendSmsJobCustody(R5.jobId, { ghl_contact_id: R5.contactId }, R5.contactId), { verifiedJobId: R5.jobId, unverifiedJobId: null });
  // Contactless job, unreadable job, no job: never a direct link.
  assertEquals(sendSmsJobCustody(R5.jobId, { ghl_contact_id: null }, R5.contactId), { verifiedJobId: null, unverifiedJobId: R5.jobId });
  assertEquals(sendSmsJobCustody(R5.jobId, null, R5.contactId), { verifiedJobId: null, unverifiedJobId: R5.jobId });
  assertEquals(sendSmsJobCustody(null, null, R5.contactId), { verifiedJobId: null, unverifiedJobId: null });
});

Deno.test("R5: the send row is the shared builder's row: ghl:<id>, client.sms_out by our tool, direct job, line 771, live", () => {
  const built = buildSendSmsEvidenceRow(R5_INPUT);
  assert(built.kind === "row");
  // deno-lint-ignore no-explicit-any
  const r = built.row as Record<string, any>;
  assertEquals(r.provider_message_id, "ghl:mDS89hMzWE2R3VCMqxP2");
  assertEquals([r.event_type, r.source, r.channel, r.direction], ["client.sms_out", "ghl-proxy", "sms", "outbound"]);
  assertEquals([r.job_id, r.match_method], [R5.jobId, "direct_job_id"]);
  assertEquals(r.payload.sent_by_kind, "our_tool");
  assertEquals(r.payload.from_line, "771");
  assertEquals(r.payload.body_hash, "sha256-fixture");
  assertEquals(r.metadata, { capture_mode: "live" });
  // GHL's send answer carries no time: event_at stays empty rather than using our clock.
  assertEquals(r.event_at, null);
  assertEquals(r.thread_key, null);
  // The legacy shape is gone.
  assert(r.event_type !== "sms_sent");
});

Deno.test("R5: the row goes only through capture_business_event, never a direct table write", async () => {
  const client = fakeClient({ data: { outcome: "inserted", id: R5.existingEventId, job_id: R5.jobId, attribution_status: "direct" } });
  const outcome = await saveSendSmsEvidence(client, R5_INPUT);
  assertEquals(outcome.outcome, "inserted");
  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].fn, "capture_business_event");
  assertEquals(client.calls[0].args.p_row.provider_message_id, "ghl:mDS89hMzWE2R3VCMqxP2");
  assertEquals(client.tableWrites, []);
});

Deno.test("R5: when the webhook row exists, duplicate is a saved row (upgraded or not) and nothing else is written", async () => {
  for (const upgraded of [true, false]) {
    const client = fakeClient({ data: { outcome: "duplicate", id: R5.existingEventId, job_id: R5.jobId, attribution_status: "direct", upgraded } });
    const outcome = await saveSendSmsEvidence(client, R5_INPUT);
    assertEquals(outcome, { outcome: "duplicate", id: R5.existingEventId, job_id: R5.jobId, attribution_status: "direct", upgraded });
    assertEquals(client.calls.length, 1);
    assertEquals(client.tableWrites, [], "a duplicate never writes a failure or fallback row");
  }
});

Deno.test("writer refusal, rpc error, rpc throw, capture off: reported, never thrown, never a fallback write", async () => {
  const cases: Array<{ answer: Parameters<typeof fakeClient>[0]; expect: CaptureOutcome }> = [
    { answer: { data: { outcome: "error", code: "23514" } }, expect: { outcome: "error", code: "23514" } },
    { answer: { error: { code: "PGRST202", message: "not found" } }, expect: { outcome: "error", code: "PGRST202" } },
    { answer: { throws: true }, expect: { outcome: "error", code: "rpc_threw" } },
    { answer: { data: { outcome: "capture_disabled" } }, expect: { outcome: "capture_disabled" } },
  ];
  for (const c of cases) {
    const client = fakeClient(c.answer);
    assertEquals(await saveSendSmsEvidence(client, R5_INPUT), c.expect);
    assertEquals(client.tableWrites, []);
  }
});

Deno.test("a send answer with no message id writes nothing (no key, no row)", async () => {
  const client = fakeClient({ data: { outcome: "inserted" } });
  const outcome = await saveSendSmsEvidence(client, { ...R5_INPUT, result: { conversationId: "c" } });
  assertEquals(outcome, { outcome: "skipped", reason: "no_id" });
  assertEquals(client.calls.length, 0);
});
