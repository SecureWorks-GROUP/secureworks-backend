// deno-lint-ignore-file no-import-prefix
// reporting-api job_context party roles (B-6, migration 20261005200000).
//
// Pins:
//   Internal    a crew or staff row shows who "internal: crew" /
//               "internal: staff" with its roles, never the customer.
//   Customer    a customer message keeps who (the source) and carries
//               sender_role, recipient_role and audience.
//   Other rows  a non-message event is exactly the old timeline item.
//   Comms       latest_comms_at never counts a crew or staff row.
//   Select      job_context reads the three role keys out of metadata.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  businessEventTimelineItem,
  JOB_CONTEXT_EVENT_SELECT,
  latestCommsAt,
} from "./job_context_timeline.ts";

Deno.test("internal: a crew text shows internal: crew", () => {
  const item: Record<string, unknown> = businessEventTimelineItem({
    event_type: "client.sms_out",
    source: "ghl-proxy",
    occurred_at: "2026-10-05T01:00:00Z",
    payload: { message: "New job assigned: SWF-1" },
    audience: "internal",
    recipient_role: "crew",
    party_roles: null,
  });
  assertEquals(
    [
      item.who,
      item.sender_role,
      item.recipient_role,
      item.audience,
      item.internal,
      item.party_label,
    ],
    ["internal: crew", "staff", "crew", "internal", true, "internal: crew"],
  );
});

Deno.test("customer: a reply keeps who and carries its roles", () => {
  const item: Record<string, unknown> = businessEventTimelineItem({
    event_type: "client.reply",
    source: "ghl-webhook-receiver",
    occurred_at: "2026-10-05T01:00:00Z",
    payload: { body: "Thanks" },
    party_roles: {
      sender_role: "customer",
      recipient_role: "staff",
      counterpart_role: "customer",
      basis: "job_customer",
      audience: "customer",
    },
  });
  assertEquals(
    [
      item.who,
      item.sender_role,
      item.recipient_role,
      item.audience,
      item.internal,
    ],
    ["ghl-webhook-receiver", "customer", "staff", "customer", false],
  );
});

Deno.test("other rows: a non-message event is the old timeline item", () => {
  const e = {
    event_type: "quote.sent",
    source: "send-quote",
    occurred_at: "2026-10-05T01:00:00Z",
    payload: { total: 1 },
    party_roles: null,
    audience: null,
    recipient_role: null,
  };
  assertEquals(businessEventTimelineItem(e), {
    type: "quote.sent",
    who: "send-quote",
    when: "2026-10-05T01:00:00Z",
    detail: JSON.stringify({ total: 1 }),
    source: "business_events",
  });
});

Deno.test("comms: latest_comms_at skips crew and staff rows", () => {
  const events = [
    {
      event_type: "sms_sent",
      occurred_at: "2026-10-05T03:00:00Z",
      audience: "internal",
      recipient_role: "staff",
    },
    {
      event_type: "client.email_in",
      occurred_at: "2026-10-05T02:00:00Z",
      party_roles: {
        sender_role: "crew",
        recipient_role: "staff",
        audience: "internal",
      },
    },
    {
      event_type: "client.email_in",
      occurred_at: "2026-10-05T01:00:00Z",
      party_roles: {
        sender_role: "customer",
        recipient_role: "staff",
        audience: "customer",
      },
    },
  ];
  assertEquals(latestCommsAt(events), "2026-10-05T01:00:00Z");
  assertEquals(latestCommsAt([events[0]]), null);
});

Deno.test("select: job_context reads the role keys out of metadata", () => {
  for (
    const k of [
      "party_roles:metadata->party_roles",
      "audience:metadata->>audience",
      "recipient_role:metadata->>recipient_role",
    ]
  ) {
    assertEquals(JOB_CONTEXT_EVENT_SELECT.includes(k), true, k);
  }
});
