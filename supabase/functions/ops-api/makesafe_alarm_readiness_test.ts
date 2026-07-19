import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { alarmReadinessFacts } from "./makesafe_alarm_readiness.ts";

Deno.test("alarm readiness reports observed 401 as authentication failure", () => {
  const facts = alarmReadinessFacts({
    alarmEnabled: true,
    recipientCount: 1,
    latestHttpStatus: 401,
    latestObservedAt: "2026-07-20T00:00:00Z",
  });
  assertEquals(facts.ready, false);
  assertEquals(facts.authentication, {
    status: "failed",
    http_status: 401,
    reason: "alarm_invocation_unauthorised",
  });
});

Deno.test("alarm readiness never infers auth success when gateway status is unavailable", () => {
  const facts = alarmReadinessFacts({ alarmEnabled: true, recipientCount: 2 });
  assertEquals(facts.ready, false);
  assertEquals(facts.authentication.status, "unverified");
  assertEquals(facts.recipients_configured, true);
});

Deno.test("alarm readiness requires enabled alarm and configured recipients", () => {
  assertEquals(
    alarmReadinessFacts({
      alarmEnabled: false,
      recipientCount: 1,
      latestHttpStatus: 200,
    }).ready,
    false,
  );
  assertEquals(
    alarmReadinessFacts({
      alarmEnabled: true,
      recipientCount: 0,
      latestHttpStatus: 200,
    }).ready,
    false,
  );
  assertEquals(
    alarmReadinessFacts({
      alarmEnabled: true,
      recipientCount: 1,
      latestHttpStatus: 200,
    }).ready,
    true,
  );
});
