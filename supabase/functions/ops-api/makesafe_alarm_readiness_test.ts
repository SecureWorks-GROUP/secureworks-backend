// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { alarmReadinessFacts } from "./makesafe_alarm_readiness.ts";

const NOW = "2026-07-20T00:20:00Z";

Deno.test("alarm readiness reports observed 401 as authentication failure", () => {
  const facts = alarmReadinessFacts({
    alarmEnabled: true,
    recipientCount: 1,
    latestHttpStatus: 401,
    latestAuthenticatedAt: "2026-07-20T00:15:00Z",
    nowIso: NOW,
  });
  assertEquals(facts.ready, false);
  assertEquals(facts.authentication.status, "failed");
  assertEquals(facts.authentication.reason, "alarm_invocation_unauthorised");
});

Deno.test("alarm readiness never infers auth success when persisted proof is unavailable", () => {
  const facts = alarmReadinessFacts({
    alarmEnabled: true,
    recipientCount: 2,
    latestHttpStatus: 200,
    nowIso: NOW,
  });
  assertEquals(facts.ready, false);
  assertEquals(facts.authentication.status, "unverified");
  assertEquals(facts.recipients_configured, true);
});

Deno.test("alarm readiness expires authentication after one canary interval", () => {
  const facts = alarmReadinessFacts({
    alarmEnabled: true,
    recipientCount: 1,
    latestAuthenticatedAt: "2026-07-19T23:49:00Z",
    nowIso: NOW,
  });
  assertEquals(facts.ready, false);
  assertEquals(facts.authentication.status, "stale");
});

Deno.test("alarm readiness requires fresh auth, enabled alarm and configured recipients", () => {
  const fresh = {
    latestAuthenticatedAt: "2026-07-20T00:15:00Z",
    nowIso: NOW,
  };
  assertEquals(
    alarmReadinessFacts({
      alarmEnabled: false,
      recipientCount: 1,
      ...fresh,
    }).ready,
    false,
  );
  assertEquals(
    alarmReadinessFacts({
      alarmEnabled: true,
      recipientCount: 0,
      ...fresh,
    }).ready,
    false,
  );
  assertEquals(
    alarmReadinessFacts({
      alarmEnabled: true,
      recipientCount: 1,
      ...fresh,
    }).ready,
    true,
  );
});
