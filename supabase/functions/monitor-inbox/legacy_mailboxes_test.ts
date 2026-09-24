// EM1 (email.md review M14, named row E22): with the monitored_mailboxes table
// seeded and the flag off, the old path polls exactly its own five mailboxes
// and two groups, and never reads the new table.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { legacyPollPlan } from "./legacy_mailboxes.ts";

Deno.test("E22: the old path polls exactly the five old user mailboxes and two groups", () => {
  const plan = legacyPollPlan();
  assertEquals([...plan.users], [
    "marnin@secureworkswa.com.au",
    "jan@secureworkswa.com.au",
    "nithin@secureworkswa.com.au",
    "shaun@secureworkswa.com.au",
    "admin@secureworkswa.com.au",
  ]);
  assertEquals([...plan.groups], [
    "patios@secureworkswa.com.au",
    "fencing@secureworkswa.com.au",
  ]);
  assertEquals(plan.mailbox_source, "hard_coded");
});

Deno.test("E22: seeded sources the old path cannot poll never enter its plan", () => {
  const plan = legacyPollPlan();
  const polled = new Set([...plan.users, ...plan.groups]);
  // New in the EM1 seed: read only by the new poller behind email_capture_v2.
  for (
    const address of [
      "khairo@secureworkswa.com.au",
      "finance@secureworkswa.com.au",
      "approvals@secureworkswa.com.au",
      "ses@secureworkswa.com.au",
      "info@secureworkswa.com.au",
      "sales@secureworkswa.com.au",
      "plans@secureworkswa.com.au",
    ]
  ) assertEquals(polled.has(address), false, address);
  // Groups are never polled as user mailboxes (ErrorInvalidUser).
  for (const group of plan.groups) assertEquals(plan.users.includes(group), false);
});

Deno.test("E22: the plan is frozen, so no caller can widen the old path at run time", () => {
  const plan = legacyPollPlan();
  assertEquals(Object.isFrozen(plan.users), true);
  assertEquals(Object.isFrozen(plan.groups), true);
});

Deno.test("E22: the old handler does not read monitored_mailboxes", async () => {
  // Structural guard: the deployed old path used to switch to the table
  // whenever it had enabled rows. Any read of it from index.ts reopens that.
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assertEquals(/from\(\s*['"]monitored_mailboxes['"]\s*\)/.test(code), false);
  assertEquals(code.includes("monitored_mailboxes"), false);
});
