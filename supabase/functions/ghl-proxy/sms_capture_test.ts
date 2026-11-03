// Slice C1a: ghl-proxy send_sms saves its text once, through the shared row
// builder and the one SQL writer capture_business_event (sms.md §3 review M9).
// Behaviour runs against a recording fake client. No network, no database.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CaptureOutcome, parseSendSmsRecipient, saveSendSmsEvidence } from "./sms_capture.ts";
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
      return Promise.resolve({
        data: answer.data ?? null,
        error: answer.error ?? null,
      });
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

Deno.test("R5: when the webhook row exists, duplicate is a saved row (upgraded or not) and nothing else is written", async () => {
  for (const upgraded of [true, false]) {
    const client = fakeClient({
      data: {
        outcome: "duplicate",
        id: R5.existingEventId,
        job_id: R5.jobId,
        attribution_status: "direct",
        upgraded,
      },
    });
    const outcome = await saveSendSmsEvidence(client, R5_INPUT);
    assertEquals(outcome, {
      outcome: "duplicate",
      id: R5.existingEventId,
      job_id: R5.jobId,
      attribution_status: "direct",
      upgraded,
    });
    assertEquals(client.calls.length, 1);
    assertEquals(
      client.tableWrites,
      [],
      "a duplicate never writes a failure or fallback row",
    );
  }
});

Deno.test("writer refusal, rpc error, rpc throw, capture off: reported, never thrown, never a fallback write", async () => {
  const cases: Array<
    { answer: Parameters<typeof fakeClient>[0]; expect: CaptureOutcome }
  > = [
    {
      answer: { data: { outcome: "error", code: "23514" } },
      expect: { outcome: "error", code: "23514" },
    },
    {
      answer: { error: { code: "PGRST202", message: "not found" } },
      expect: { outcome: "error", code: "PGRST202" },
    },
    {
      answer: { throws: true },
      expect: { outcome: "error", code: "rpc_threw" },
    },
    {
      answer: { data: { outcome: "capture_disabled" } },
      expect: { outcome: "capture_disabled" },
    },
  ];
  for (const c of cases) {
    const client = fakeClient(c.answer);
    assertEquals(await saveSendSmsEvidence(client, R5_INPUT), c.expect);
    assertEquals(client.tableWrites, []);
  }
});

Deno.test("a send answer with no message id writes nothing (no key, no row)", async () => {
  const client = fakeClient({ data: { outcome: "inserted" } });
  const outcome = await saveSendSmsEvidence(client, {
    ...R5_INPUT,
    result: { conversationId: "c" },
  });
  assertEquals(outcome, { outcome: "skipped", reason: "no_id" });
  assertEquals(client.calls.length, 0);
});

// Crew and staff texts (ladder L1c, 20261004200000): ops-api's internal texts
// carry the job number in their words; marked here, the ladder keeps them off
// every job so no reader takes them for a message to that job's customer.
const CREW_JOB = "0b5e4f2c-6a1d-4c3e-9f8a-2d7b1e0c9a44";

Deno.test("send_sms recipient: crew or staff only, job as aboutJobId, never beside jobId", () => {
  assertEquals(parseSendSmsRecipient({}), {
    ok: true,
    recipientRole: null,
    aboutJobId: null,
  });
  assertEquals(parseSendSmsRecipient({ jobId: R5.jobId }), {
    ok: true,
    recipientRole: null,
    aboutJobId: null,
  });
  assertEquals(parseSendSmsRecipient({ recipientRole: "staff" }), {
    ok: true,
    recipientRole: "staff",
    aboutJobId: null,
  });
  assertEquals(
    parseSendSmsRecipient({
      recipientRole: "crew",
      aboutJobId: CREW_JOB.toUpperCase(),
    }),
    { ok: true, recipientRole: "crew", aboutJobId: CREW_JOB },
  );
  for (
    const bad of [
      { recipientRole: "customer" },
      { recipientRole: "crew", jobId: R5.jobId },
      { recipientRole: "crew", aboutJobId: "SWF-261469" },
      { aboutJobId: CREW_JOB },
    ]
  ) {
    const parsed = parseSendSmsRecipient(bad);
    assertEquals(parsed.ok, false, JSON.stringify(bad));
  }
});
