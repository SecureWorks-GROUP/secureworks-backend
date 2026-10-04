// deno-lint-ignore-file no-explicit-any no-import-prefix
// Job conversation and dossier party roles (B-6, migration 20261005200000).
//
// Pins:
//   Conversation  a business_events message carries sender_role,
//                 recipient_role, audience and party_label; an internal row
//                 (L1d's crew label, or a crew member texting in) has
//                 direction internal and label "internal: crew" /
//                 "internal: staff", never inbound/outbound customer traffic;
//                 the provider's direction stays on provider_direction.
//   Select        the conversation and dossier selects read the three role
//                 keys out of metadata.
//   Dossier       a message event carries the same role fields; any other
//                 event comes back with exactly its own columns.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  businessEventConversationMessage,
  CONVERSATION_EVENT_SELECT,
  DOSSIER_EVENT_SELECT,
  dossierEventWithPartyRoles,
} from "./job_conversation_party_roles.ts";

const JOB = "5c000000-0000-4000-8000-000000000009";

function row(over: Record<string, unknown> = {}): any {
  return {
    id: "ev-1",
    event_type: "client.sms_out",
    source: "ghl-proxy",
    occurred_at: "2026-10-05T01:00:00.000Z",
    payload: { body: "New job assigned: SWF-1 - Client" },
    correlation_id: null,
    attribution_status: "direct",
    attribution_step: 1,
    placement_rule: null,
    party_roles: null,
    audience: null,
    recipient_role: null,
    ...over,
  };
}

Deno.test("conversation: L1d's crew text is internal: crew, never an outbound customer message", () => {
  const m: any = businessEventConversationMessage(
    row({
      placement_rule: "internal_ref",
      audience: "internal",
      recipient_role: "crew",
      party_roles: {
        sender_role: "staff",
        recipient_role: "crew",
        counterpart_role: "crew",
        basis: "ladder_internal",
        audience: "internal",
      },
    }),
    JOB,
  );
  assertEquals(
    [
      m.direction,
      m.provider_direction,
      m.label,
      m.party_label,
      m.sender_role,
      m.recipient_role,
      m.audience,
      m.internal,
    ],
    [
      "internal",
      "outbound",
      "internal: crew",
      "internal: crew",
      "staff",
      "crew",
      "internal",
      true,
    ],
  );
  assertEquals(m.channel, "sms");
});

Deno.test("conversation: a staff text labelled by L1d with no stamp yet still reads internal: staff", () => {
  const m: any = businessEventConversationMessage(
    row({ audience: "internal", recipient_role: "staff" }),
    JOB,
  );
  assertEquals([m.direction, m.label, m.recipient_role], [
    "internal",
    "internal: staff",
    "staff",
  ]);
});

Deno.test("conversation: a crew member texting in is internal: crew", () => {
  const m: any = businessEventConversationMessage(
    row({
      event_type: "client.reply",
      payload: { body: "On site now" },
      party_roles: {
        sender_role: "crew",
        recipient_role: "staff",
        counterpart_role: "crew",
        basis: "writer_marked_contact",
        audience: "internal",
      },
    }),
    JOB,
  );
  assertEquals([m.direction, m.provider_direction, m.label, m.sender_role], [
    "internal",
    "inbound",
    "internal: crew",
    "crew",
  ]);
});

Deno.test("conversation: a customer reply keeps its direction and says customer to staff", () => {
  const m: any = businessEventConversationMessage(
    row({
      event_type: "client.reply",
      payload: { body: "See you Tuesday" },
      party_roles: {
        sender_role: "customer",
        recipient_role: "staff",
        counterpart_role: "customer",
        basis: "job_customer",
        audience: "customer",
      },
    }),
    JOB,
  );
  assertEquals(
    [
      m.direction,
      m.sender_role,
      m.recipient_role,
      m.audience,
      m.internal,
      m.party_label,
      "label" in m,
    ],
    [
      "inbound",
      "customer",
      "staff",
      "customer",
      false,
      "customer to staff",
      false,
    ],
  );
  assertEquals([m.id, m.body, m.source_system], [
    "bev:ev-1",
    "See you Tuesday",
    "business_events",
  ]);
});

Deno.test("conversation: a row with no roles yet reads unknown, never internal", () => {
  const m: any = businessEventConversationMessage(
    row({ payload: { body: "Hi" } }),
    JOB,
  );
  assertEquals([m.direction, m.sender_role, m.recipient_role, m.internal], [
    "outbound",
    "unknown",
    "unknown",
    false,
  ]);
});

Deno.test("select: conversation and dossier read the role keys out of metadata", () => {
  for (const s of [CONVERSATION_EVENT_SELECT, DOSSIER_EVENT_SELECT]) {
    for (
      const k of [
        "party_roles:metadata->party_roles",
        "audience:metadata->>audience",
        "recipient_role:metadata->>recipient_role",
      ]
    ) {
      assertEquals(s.includes(k), true, `${k} missing from ${s}`);
    }
  }
  assertEquals(
    CONVERSATION_EVENT_SELECT.includes(
      "placement_rule:metadata->>placement_rule",
    ),
    true,
  );
});

Deno.test("dossier: a message event carries the role fields; any other event is unchanged", () => {
  const msg: any = dossierEventWithPartyRoles({
    id: "e1",
    event_type: "client.sms_out",
    source: "ghl-proxy",
    occurred_at: "t",
    payload: {},
    correlation_id: null,
    party_roles: null,
    audience: "internal",
    recipient_role: "crew",
  });
  assertEquals([
    msg.label,
    msg.sender_role,
    msg.recipient_role,
    msg.audience,
    "party_roles" in msg,
  ], ["internal: crew", "staff", "crew", "internal", false]);
  const other = dossierEventWithPartyRoles({
    id: "e2",
    event_type: "quote.sent",
    source: "send-quote",
    occurred_at: "t",
    payload: { x: 1 },
    correlation_id: null,
    party_roles: null,
    audience: null,
    recipient_role: null,
  });
  assertEquals(other, {
    id: "e2",
    event_type: "quote.sent",
    source: "send-quote",
    occurred_at: "t",
    payload: { x: 1 },
    correlation_id: null,
  });
});
