// Dispatch sign-off fields (dispatch_signoff.ts). Pure; no client data.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dispatchSignoffFields } from "./dispatch_signoff.ts";
import type { ClientSignoff } from "./trade_client_signoff.ts";

const ev = (over: Partial<ClientSignoff>): ClientSignoff => ({
  job_id: "j",
  applies: true,
  satisfied: true,
  current: {
    id: "s",
    method: "trade_app",
    signed_name: "x",
    happy: true,
    satisfaction_rating: 5,
    created_at: "2026-10-18T03:00:00.000Z",
  },
  missing: null,
  read_failed: false,
  ...over,
});

Deno.test("dispatch sign-off: outside the rule or no answer gives no keys", () => {
  assertEquals(dispatchSignoffFields(undefined, false), {});
  assertEquals(dispatchSignoffFields(ev({ applies: false }), false), {});
});

Deno.test("dispatch sign-off: a low rating is not happy and never ready", () => {
  const f: any = dispatchSignoffFields(
    ev({ satisfied: false, missing: "rating_below_threshold" }),
    false,
  );
  assertEquals([f.client_signoff.state, f.final_invoice_ready], ["not_happy", false]);
});

Deno.test("dispatch sign-off: signed off with an unread invoice list is unknown, not ready", () => {
  const f: any = dispatchSignoffFields(ev({}), null);
  assertEquals([f.client_signoff.state, f.final_invoice_ready], ["signed_off", null]);
});

Deno.test("dispatch sign-off: an unread sign-off is unknown whatever the invoices say", () => {
  const f: any = dispatchSignoffFields(
    ev({ satisfied: false, current: null, missing: "evidence_unavailable", read_failed: true }),
    false,
  );
  assertEquals([f.client_signoff.state, f.final_invoice_ready], ["unknown", null]);
});
