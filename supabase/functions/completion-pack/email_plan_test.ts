import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  COMPLETION_PACK_CLIENT_EMAIL_FLAG,
  completionPackEmailPlan,
} from "./email_plan.ts";

Deno.test("completion pack email is not sent while the flag is off", () => {
  assertEquals(
    COMPLETION_PACK_CLIENT_EMAIL_FLAG,
    "completion_pack_client_email_v1",
  );
  for (const flagEnabled of [false, null, undefined, "true", 0, 1]) {
    const plan = completionPackEmailPlan({
      sendRequested: true,
      flagEnabled,
      hasContact: true,
    });
    assertEquals(plan.send, false);
    assertEquals(plan.result, "email disabled");
  }
  const ready = completionPackEmailPlan({
    sendRequested: true,
    flagEnabled: true,
    hasContact: true,
  });
  assertEquals(ready, { send: true, result: "send" });
  assertEquals(
    completionPackEmailPlan({
      sendRequested: false,
      flagEnabled: true,
      hasContact: true,
    }).send,
    false,
  );
});
