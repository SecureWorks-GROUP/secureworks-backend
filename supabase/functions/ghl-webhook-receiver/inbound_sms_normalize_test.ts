// ════════════════════════════════════════════════════════════
// GHL WEBHOOK RECEIVER — canonical inbound-SMS normalization (M0.5 U1b)
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Proves:
//   1. Mapping — InboundMessage SMS → `client.sms_in` (exact envelope);
//      email + chat stay on `client.reply`.
//   2. Dedup — a second observation of the same GHL message id (from a
//      re-delivery OR the ops-api backfill sync path) is a no-op; absent an
//      id, never dedup (insert).
//   3. Cross-check — the produced SMS type is a member of the JARVIS
//      extraction-enqueuer allow-list (client.sms_in), so restored texts are
//      actually mined. Old type `client.reply` is NOT in the allow-list.
//
// RUN:
//   ~/.local/bin/deno test --allow-none \
//     supabase/functions/ghl-webhook-receiver/inbound_sms_normalize_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildInboundDedupOr,
  findInboundDuplicate,
  INBOUND_NONSMS_EVENT_TYPE,
  INBOUND_SMS_EVENT_TYPE,
  type InboundDedupClient,
  mapInboundMessage,
} from "./inbound_sms_normalize.ts";

// ── Verbatim mirror of the JARVIS extraction-enqueuer allow-list ─────────────
// secureworks-agent · src/automation/extraction-enqueuer.ts ALLOWED_EVENT_TYPES
// (origin/main, read 2026-07-07). Duplicated here as a fixture ONLY — this test
// makes NO agent-repo change; it proves the receiver emits a type the enqueuer
// already reads. If the agent-repo list changes, this fixture must be re-synced.
const ENQUEUER_ALLOWED_EVENT_TYPES = [
  "client.email_in",
  "client.email_out",
  "supplier.email_in",
  "note.added",
  "conversation.synced",
  "quote.sent",
  "quote.accepted",
  "client.sms_in",
  "client.sms_out",
  "call.transcript_completed",
];

// ── 1. Mapping fixtures ──────────────────────────────────────────────────────

Deno.test("mapping: inbound SMS → client.sms_in with the exact envelope (incl. line attribution)", () => {
  const body = {
    type: "InboundMessage",
    contactId: "CT_123",
    message: "Yes 2pm Thursday works",
    phone: "+61400111222",   // the CLIENT's number (from)
    to: "+61489267772",       // OUR fencing line (destination)
    conversationId: "CV_9",
    messageId: "MSG_abc123",
  };
  const mapped = mapInboundMessage(body);
  assertEquals(mapped.eventType, "client.sms_in");
  assertEquals(mapped.channel, "sms");
  assertEquals(mapped.eventPayload, {
    message_text: "Yes 2pm Thursday works",
    phone: "+61400111222",
    email: null,
    conversation_id: "CV_9",
    channel: "sms",
    line_label: "fencing",
    department: "sales-fencing",
    ghl_message_id: "MSG_abc123",
    source: "ghl_webhook",
  });
});

Deno.test("mapping: inbound EMAIL stays client.reply (channel email)", () => {
  const body = {
    type: "InboundMessage",
    contactId: "CT_1",
    message: "thanks",
    email: "jo@example.com",
  };
  const mapped = mapInboundMessage(body);
  assertEquals(mapped.eventType, INBOUND_NONSMS_EVENT_TYPE); // client.reply
  assertEquals(mapped.channel, "email");
  assertEquals(mapped.eventPayload.channel, "email");
  assertEquals(mapped.eventPayload.phone, null);
  assertEquals(mapped.eventPayload.email, "jo@example.com");
});

Deno.test("mapping: inbound CHAT (no phone/email) stays client.reply", () => {
  const mapped = mapInboundMessage({ type: "InboundMessage", message: "hi" });
  assertEquals(mapped.eventType, INBOUND_NONSMS_EVENT_TYPE); // client.reply
  assertEquals(mapped.channel, "chat");
});

Deno.test("mapping: message id falls back messageId → id → eventId, else null", () => {
  assertEquals(mapInboundMessage({ phone: "1", id: "IDX" }).eventPayload.ghl_message_id, "IDX");
  assertEquals(mapInboundMessage({ phone: "1", eventId: "EVT" }).eventPayload.ghl_message_id, "EVT");
  assertEquals(
    mapInboundMessage({ phone: "1", messageId: "M", id: "IDX" }).eventPayload.ghl_message_id,
    "M",
  );
  // GHL renders missing template vars as the literal "null" — treat as absent.
  assertEquals(mapInboundMessage({ phone: "1", messageId: "null" }).eventPayload.ghl_message_id, null);
  assertEquals(mapInboundMessage({ phone: "1" }).eventPayload.ghl_message_id, null);
});

Deno.test("mapping: message_text truncates to 500 chars", () => {
  const long = "x".repeat(900);
  const out = mapInboundMessage({ phone: "1", message: long }).eventPayload.message_text as string;
  assertEquals(out.length, 500);
});

// ── 1b. Line attribution fixtures (U1b-a) ────────────────────────────────────

function lineOf(body: Record<string, unknown>) {
  const p = mapInboundMessage(body).eventPayload;
  return { line_label: p.line_label, department: p.department };
}

Deno.test("line: destination `to` = fencing number (E.164 and local) → fencing", () => {
  assertEquals(lineOf({ phone: "+61400111222", to: "+61489267772" }),
    { line_label: "fencing", department: "sales-fencing" });
  assertEquals(lineOf({ phone: "0400111222", to: "0489267772" }),
    { line_label: "fencing", department: "sales-fencing" });
});

Deno.test("line: destination `to` = patios number (E.164 and local) → patios", () => {
  assertEquals(lineOf({ phone: "+61400111222", to: "+61489267774" }),
    { line_label: "patios", department: "sales-patios" });
  assertEquals(lineOf({ phone: "0400111222", to: "0489267774" }),
    { line_label: "patios", department: "sales-patios" });
});

Deno.test("line: `toNumber` is accepted as a destination alias", () => {
  assertEquals(lineOf({ phone: "0400111222", toNumber: "0489267774" }),
    { line_label: "patios", department: "sales-patios" });
});

Deno.test("line: static `line` label (per-workflow fallback) → mapped to department", () => {
  assertEquals(lineOf({ phone: "0400111222", line: "fencing" }),
    { line_label: "fencing", department: "sales-fencing" });
  assertEquals(lineOf({ phone: "0400111222", line: "Patios" }), // case-insensitive
    { line_label: "patios", department: "sales-patios" });
});

Deno.test("line: unrecognised static label is not trusted → unknown", () => {
  assertEquals(lineOf({ phone: "0400111222", line: "fence" }),
    { line_label: "unknown", department: "unknown" });
});

Deno.test("line: absent destination → unknown, and NEVER guessed from the contact number", () => {
  // No `to`/`line`; the contact's own phone must not attribute a line even if
  // it happened to be one of our line numbers.
  assertEquals(lineOf({ phone: "+61400111222", message: "hi" }),
    { line_label: "unknown", department: "unknown" });
  assertEquals(lineOf({ phone: "+61489267772", message: "spoofed our line" }),
    { line_label: "unknown", department: "unknown" });
});

// ── 2. Dedup fixtures ────────────────────────────────────────────────────────

// Fake client that captures the .or() filter and returns a scripted row set.
function fakeClient(rows: Array<{ id: string }>) {
  let capturedFilter = "";
  const client: InboundDedupClient = {
    from() {
      return {
        select() {
          return {
            or(filter: string) {
              capturedFilter = filter;
              return { limit() {
                return Promise.resolve({ data: rows, error: undefined });
              } };
            },
          };
        },
      };
    },
  };
  return { client, getFilter: () => capturedFilter };
}

Deno.test("dedup: existing row for this GHL message id ⇒ deduped (skip write)", async () => {
  const { client } = fakeClient([{ id: "existing-be-uuid" }]);
  const res = await findInboundDuplicate(client, "MSG_abc123");
  assertEquals(res.deduped, true);
  assertEquals(res.matchedId, "existing-be-uuid");
});

Deno.test("dedup: no existing row ⇒ not deduped (insert)", async () => {
  const { client } = fakeClient([]);
  const res = await findInboundDuplicate(client, "MSG_abc123");
  assertEquals(res.deduped, false);
});

Deno.test("dedup: absent message id ⇒ never dedup, no query issued", async () => {
  let queried = false;
  const client: InboundDedupClient = {
    from() {
      queried = true;
      return {
        select() {
          return {
            or() {
              return {
                limit() {
                  return Promise.resolve({ data: [], error: undefined });
                },
              };
            },
          };
        },
      };
    },
  };
  const res = await findInboundDuplicate(client, null);
  assertEquals(res.deduped, false);
  assert(!queried, "must not touch the DB when there is no dedup key");
});

Deno.test("dedup: filter matches all three cross-path key locations", () => {
  const filter = buildInboundDedupOr("MSG_abc123");
  assertEquals(
    filter,
    "source_id.eq.MSG_abc123,entity_id.eq.MSG_abc123,payload->>ghl_message_id.eq.MSG_abc123",
  );
});

Deno.test("dedup: unsafe id is refused (returns null filter, no interpolation)", () => {
  assertEquals(buildInboundDedupOr("a,b.eq.x"), null);
  assertEquals(buildInboundDedupOr(""), null);
  assertEquals(buildInboundDedupOr(null), null);
});

// ── 3. Enqueuer allow-list cross-check ───────────────────────────────────────

Deno.test("cross-check: SMS type is read by the JARVIS enqueuer; client.reply is NOT", () => {
  assertEquals(INBOUND_SMS_EVENT_TYPE, "client.sms_in");
  assert(
    ENQUEUER_ALLOWED_EVENT_TYPES.includes(INBOUND_SMS_EVENT_TYPE),
    "client.sms_in must be in the enqueuer allow-list (F1)",
  );
  assert(
    !ENQUEUER_ALLOWED_EVENT_TYPES.includes(INBOUND_NONSMS_EVENT_TYPE),
    "client.reply is NOT read by the enqueuer — the exact F1 defect this unit fixes",
  );
  // The mapping proves an SMS reply now lands on the mined type.
  assert(
    ENQUEUER_ALLOWED_EVENT_TYPES.includes(mapInboundMessage({ phone: "1", message: "hi" }).eventType),
  );
});
