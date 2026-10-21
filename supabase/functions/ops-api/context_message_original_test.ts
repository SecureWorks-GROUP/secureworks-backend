// CTX-T23 (design AC-M6): Open the original. Behaviour on the module (id
// check, error mapping, call words never returned, the email's file list with
// a failed read never shown as empty) and on the real ops-api front door
// (staff only, never an agent read, trades refused).
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ATTACHMENT_ROW_CAP,
  CALL_WORDS_NOTE,
  contextMessageOriginal,
  eventIdFrom,
  FILES_NOT_AVAILABLE,
  MessageOriginalError,
  messageKind,
} from "./context_message_original.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

const ID = "c7a00000-0000-4000-8000-000000000001";

type Answer = { data: unknown; error: unknown };

// A fake PostgREST client: one answer per table, every call recorded.
function fakeClient(answers: Record<string, Answer>) {
  const calls: { table: string; ops: unknown[][] }[] = [];
  const client = {
    from(table: string) {
      const ops: unknown[][] = [];
      calls.push({ table, ops });
      const answer = answers[table] ?? { data: null, error: { message: `no fake for ${table}` } };
      const q: any = {
        select: (...a: unknown[]) => (ops.push(["select", ...a]), q),
        eq: (...a: unknown[]) => (ops.push(["eq", ...a]), q),
        order: (...a: unknown[]) => (ops.push(["order", ...a]), q),
        limit: (...a: unknown[]) => (ops.push(["limit", ...a]), q),
        maybeSingle: () => Promise.resolve(answer),
        then: (res: any, rej: any) => Promise.resolve(answer).then(res, rej),
      };
      return q;
    },
  };
  return { client, calls };
}

function params(q: string) {
  return new URLSearchParams(q);
}

Deno.test("event_id must be a uuid", () => {
  for (const q of ["", "event_id=", "event_id=abc", "event_id=1;drop"]) {
    const e = assertThrows(() => eventIdFrom(params(q)), MessageOriginalError);
    assertEquals([e.code, e.status], ["invalid_request", 400], q);
  }
  assertEquals(eventIdFrom(params(`event_id=${ID.toUpperCase()}`)), ID);
});

Deno.test("a missing message is 404 and a failed read is 500, never an empty answer", async () => {
  const none = fakeClient({ business_events: { data: null, error: null } });
  const e1 = await assertRejects(
    () => contextMessageOriginal(none.client, params(`event_id=${ID}`)),
    MessageOriginalError,
  );
  assertEquals([e1.code, e1.status], ["message_not_found", 404]);

  const broken = fakeClient({ business_events: { data: null, error: { message: "boom" } } });
  const e2 = await assertRejects(
    () => contextMessageOriginal(broken.client, params(`event_id=${ID}`)),
    MessageOriginalError,
  );
  assertEquals([e2.code, e2.status], ["message_read_failed", 500]);
});

Deno.test("message kinds", () => {
  assertEquals(messageKind({ channel: "call", event_type: "call.completed" }), "call");
  assertEquals(messageKind({ channel: "sms", event_type: "call.transcript_completed" }), "call");
  assertEquals(messageKind({ channel: "email", event_type: "client.email_received" }), "email");
  assertEquals(messageKind({ channel: "sms", event_type: "client.sms_received" }), "text");
  assertEquals(messageKind({ channel: "status", event_type: "task.created" }), "other");
});

Deno.test("a call returns its facts and never its words", async () => {
  const f = fakeClient({
    business_events: {
      data: {
        id: ID,
        event_type: "call.completed",
        channel: "call",
        direction: "inbound",
        event_at: "2026-10-20T01:00:00Z",
        occurred_at: "2026-10-20T01:05:00Z",
        provider_message_id: "ghl:abc",
        body_preview: "they said the gate is broken",
        payload: { duration_seconds: 184, call_status: "completed", line: "+61489267771", body: "secret words", words: false },
      },
      error: null,
    },
  });
  const out: any = await contextMessageOriginal(f.client, params(`event_id=${ID}`));
  assertEquals(out.kind, "call");
  assertEquals(out.call.duration_seconds, 184);
  assertEquals(out.call.words_shown, false);
  assertEquals(out.call.words_note, CALL_WORDS_NOTE);
  assertEquals(out.at, "2026-10-20T01:00:00Z");
  const text = JSON.stringify(out);
  assertEquals(text.includes("secret words"), false);
  assertEquals(text.includes("gate is broken"), false);
  assertEquals(f.calls.length, 1); // no attachment read for a call
});

Deno.test("a call transcript row is a call: its transcript is never returned", async () => {
  const f = fakeClient({
    business_events: {
      data: {
        id: ID,
        event_type: "call.transcript_completed",
        channel: "call",
        direction: "inbound",
        event_at: null,
        occurred_at: "2026-10-20T01:05:00Z",
        provider_message_id: "ghltx:abc",
        body_preview: "Customer: hello there",
        payload: { transcript: "Customer: hello there, my fence fell over", ghl_call_id: "abc" },
      },
      error: null,
    },
  });
  const out: any = await contextMessageOriginal(f.client, params(`event_id=${ID}`));
  assertEquals(out.kind, "call");
  assertEquals(out.call.is_transcript_row, true);
  assertEquals(out.at_source, "captured");
  assertEquals(JSON.stringify(out).includes("hello there"), false);
});

Deno.test("a text returns the whole text", async () => {
  const long = "x".repeat(900);
  const f = fakeClient({
    business_events: {
      data: {
        id: ID,
        event_type: "client.sms_received",
        channel: "sms",
        direction: "inbound",
        event_at: "2026-10-20T01:00:00Z",
        provider_message_id: "ghl:t1",
        body_preview: long.slice(0, 500),
        payload: { body: long, line: "+61489267771", sent_by_kind: "customer" },
      },
      error: null,
    },
  });
  const out: any = await contextMessageOriginal(f.client, params(`event_id=${ID}`));
  assertEquals(out.text.body, long);
  assertEquals(out.text.body_source, "message");
  assertEquals(out.read_only, true);
});

Deno.test("an older text with only a preview says so", async () => {
  const f = fakeClient({
    business_events: {
      data: { id: ID, event_type: "client.sms_received", channel: "sms", body_preview: "short", payload: {} },
      error: null,
    },
  });
  const out: any = await contextMessageOriginal(f.client, params(`event_id=${ID}`));
  assertEquals([out.text.body, out.text.body_source], ["short", "preview_only"]);
});

const EMAIL_ROW = {
  id: ID,
  event_type: "client.email_received",
  channel: "email",
  direction: "inbound",
  event_at: "2026-10-20T01:00:00Z",
  provider_message_id: "graph:fencing@secureworkswa.com.au:AAMk1",
  body_preview: "Subject: Quote",
  payload: {
    subject: "Quote",
    from: "client@example.com",
    to: ["fencing@secureworkswa.com.au"],
    cc: "office@example.com",
    mailbox: "fencing@secureworkswa.com.au",
    body: "Subject: Quote\n\nPlease see the plans attached.",
    body_truncated: false,
    body_chars_total: 44,
    attachments_total: 3,
  },
};

Deno.test("an email returns its fields and every file with why it was or was not saved", async () => {
  const f = fakeClient({
    business_events: { data: EMAIL_ROW, error: null },
    context_email_attachments: {
      data: [
        { file_name: "plans.pdf", content_type: "application/pdf", size_bytes: 1200, status: "stored" },
        { file_name: "logo.png", content_type: "image/png", size_bytes: 20, status: "skipped_inline" },
        { file_name: "plans.pdf", content_type: "application/pdf", size_bytes: 1200, status: "skipped_duplicate" },
        { file_name: "big.zip", content_type: "application/zip", size_bytes: 1, status: "failed", error_code: "graph_404" },
      ],
      error: null,
    },
  });
  const out: any = await contextMessageOriginal(f.client, params(`event_id=${ID}`));
  assertEquals(out.email.subject, "Quote");
  assertEquals(out.email.to, ["fencing@secureworkswa.com.au"]);
  assertEquals(out.email.cc, ["office@example.com"]);
  assertEquals(out.email.body, "Subject: Quote\n\nPlease see the plans attached.");
  assertEquals(out.attachments.read, "ok");
  assertEquals(out.attachments.copies_not_listed, 1);
  assertEquals(out.attachments.more_not_listed, false);
  assertEquals(out.attachments.on_message, 3);
  assertEquals(out.attachments.items.map((i: any) => [i.file_name, i.saved, i.status_words, i.error_code]), [
    ["plans.pdf", true, "Saved", null],
    ["logo.png", false, "Not saved: a picture in the email itself, such as a signature", null],
    ["big.zip", false, "Not saved: reading it failed", "graph_404"],
  ]);
  assertEquals(out.attachments.files, "not_available");
  assertEquals(out.attachments.files_note, FILES_NOT_AVAILABLE);
  // The ledger is read by the email's own provider id.
  const ledger = f.calls.find((c) => c.table === "context_email_attachments")!;
  assertEquals(ledger.ops.find((o) => o[0] === "eq"), ["eq", "provider_message_id", EMAIL_ROW.provider_message_id]);
});

Deno.test("a file list past the cap says it was cut", async () => {
  const many = Array.from({ length: ATTACHMENT_ROW_CAP + 1 }, (_, i) => ({ file_name: `f${i}.pdf`, status: "stored" }));
  const f = fakeClient({
    business_events: { data: EMAIL_ROW, error: null },
    context_email_attachments: { data: many, error: null },
  });
  const out: any = await contextMessageOriginal(f.client, params(`event_id=${ID}`));
  assertEquals(out.attachments.items.length, ATTACHMENT_ROW_CAP);
  assertEquals(out.attachments.more_not_listed, true);
  const ledger = f.calls.find((c) => c.table === "context_email_attachments")!;
  assertEquals(ledger.ops.find((o) => o[0] === "limit"), ["limit", ATTACHMENT_ROW_CAP + 1]);
});

Deno.test("a failed file list read is 'failed' with no list, never an empty list", async () => {
  const f = fakeClient({
    business_events: { data: EMAIL_ROW, error: null },
    context_email_attachments: { data: null, error: { message: "permission denied" } },
  });
  const out: any = await contextMessageOriginal(f.client, params(`event_id=${ID}`));
  assertEquals(out.attachments.read, "failed");
  assertEquals(out.attachments.items, null);
  assertEquals(out.email.subject, "Quote");
});

Deno.test("an email the reader did not capture has no file list to read", async () => {
  const f = fakeClient({
    business_events: { data: { ...EMAIL_ROW, provider_message_id: "inbox:123" }, error: null },
  });
  const out: any = await contextMessageOriginal(f.client, params(`event_id=${ID}`));
  assertEquals(out.attachments.read, "none");
  assertEquals(f.calls.length, 1);
});

Deno.test("the door is staff-only: not profile-scoped, not agent-read, trades refused", () => {
  const action = "context_message_original";
  const url = new URL(`https://example.invalid/ops-api?action=${action}`);
  assertEquals(_opsApiActionNeedsStaffRole(url), true);
  assertEquals(AGENT_READ_ALLOWED_ACTIONS.has(action), false);
  const decide = (authMode: "api_key" | "jwt", role?: string, managedVerticals?: string[]) => {
    const d = _authorizeOpsApiAction({
      url,
      authMode,
      authUser: role ? { role, managedVerticals } : null,
      serverSecretPresented: authMode === "api_key",
    });
    return d.ok ? 200 : d.status;
  };
  assertEquals(decide("jwt", "admin"), 200);
  assertEquals(decide("jwt", "ops_manager"), 200);
  assertEquals(decide("api_key"), 200);
  assertEquals(decide("jwt", "lead_installer"), 403);
  assertEquals(decide("jwt", "lead_installer", ["fencing"]), 403);
  assertEquals(decide("jwt", "trade"), 403);
});
