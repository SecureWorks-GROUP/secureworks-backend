// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SALES_BOOKING_SENDER_LINES,
  salesBookingSenderFor,
} from "./sales_booking_sender.ts";
import { SMS_ALLOWED_FROM_NUMBERS } from "../_shared/sms_from_number.ts";
import { SALES_BOOKING_RESOURCES } from "./sales_booking_read.ts";

Deno.test("each person's line is the one on their wiki profile", () => {
  assertEquals(
    Object.fromEntries(
      Object.values(SALES_BOOKING_SENDER_LINES).map((p) => [p.person, p.line]),
    ),
    {
      marnin: "+61489267776",
      nithin: "+61489267774",
      khairo: "+61489267772",
    },
  );
  const lines = Object.values(SALES_BOOKING_SENDER_LINES).map((p) => p.line);
  // One owner per number, and every line is one GHL will accept.
  assertEquals(new Set(lines).size, lines.length);
  for (const line of lines) {
    assertEquals(
      (SMS_ALLOWED_FROM_NUMBERS as readonly string[]).includes(line),
      true,
    );
  }
});

Deno.test("booking resources agree with the sender table on person and line", () => {
  for (const [id, resource] of Object.entries(SALES_BOOKING_RESOURCES)) {
    const person = SALES_BOOKING_SENDER_LINES[id];
    assertEquals(person.scoper_user_id, resource.scoper_user_id);
    assertEquals(person.line, `+61489267${resource.sender_line}`);
  }
});

Deno.test("resolution keys on the visit person and names every refusal", () => {
  const marnin = SALES_BOOKING_SENDER_LINES.marnin;
  const nithin = SALES_BOOKING_SENDER_LINES.nithin;
  const khairo = SALES_BOOKING_SENDER_LINES.khairo;
  for (const p of [marnin, nithin, khairo]) {
    const r = salesBookingSenderFor({
      scoper_user_id: p.scoper_user_id,
      resource: p.person,
      profile: p.profile,
    });
    assertEquals(r.ok && r.sender.line, p.line);
  }
  // Resource and profile are optional; the person alone is enough.
  const bare = salesBookingSenderFor({ scoper_user_id: khairo.scoper_user_id });
  assertEquals(bare.ok && bare.sender.person, "khairo");
  const reason = (s: Record<string, unknown>) => {
    const r = salesBookingSenderFor(s);
    return r.ok ? r.sender.person : r.reason;
  };
  assertEquals(reason({}), "booking_scoper_unassigned");
  assertEquals(reason({ resource: "marnin" }), "booking_scoper_unassigned");
  assertEquals(reason({ scoper_user_id: "  " }), "booking_scoper_unassigned");
  assertEquals(
    reason({ scoper_user_id: "not-a-known-person" }),
    "booking_scoper_line_unknown",
  );
  assertEquals(
    reason({ scoper_user_id: nithin.scoper_user_id, resource: "marnin" }),
    "booking_scoper_ambiguous",
  );
  assertEquals(
    reason({
      scoper_user_id: marnin.scoper_user_id,
      profile: "fencing-khairo",
    }),
    "booking_scoper_ambiguous",
  );
  // An unknown resource or profile label does not pick anyone.
  assertEquals(
    reason({ scoper_user_id: marnin.scoper_user_id, resource: "other" }),
    "marnin",
  );
});
