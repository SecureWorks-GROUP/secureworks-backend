// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dispatchOutlookSearch } from "./dispatch_outlook.ts";
Deno.test("Outlook refuses unconfigured mailbox without a provider request", async () => {
  let called = false;
  const r = await dispatchOutlookSearch(
    new URLSearchParams({ mailbox: "other@example.com", search: "Job" }),
    ["ops@example.com"],
    () => {
      called = true;
      return Promise.resolve(new Response("{}"));
    },
  );
  assertEquals(called, false);
  assertEquals(r.coverage.available, false);
});
Deno.test("Outlook preserves message custody and provider continuation", async () => {
  const next =
    "https://graph.microsoft.com/v1.0/users/ops%40example.com/messages?$skip=25";
  const r = await dispatchOutlookSearch(
    new URLSearchParams({ mailbox: "ops@example.com", search: "Job 123" }),
    ["ops@example.com"],
    (url, options) => {
      assertEquals(options?.method, "GET");
      assertEquals(new URL(url).searchParams.get("$search"), '"Job 123"');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            value: [{
              id: "m1",
              internetMessageId: "internet1",
              conversationId: "thread1",
            }],
            "@odata.nextLink": next,
          }),
        ),
      );
    },
  );
  assertEquals(r.next_cursor, next);
  assertEquals(r.coverage.complete, false);
  assertEquals(r.records[0].source_ref.graph_message_id, "m1");
  assertEquals(r.records[0].job_id, null);
});
Deno.test("Outlook rejects cross-mailbox or attacker continuation before obtaining credentials", async () => {
  for (
    const cursor of [
      "https://attacker.example/messages",
      "https://graph.microsoft.com/v1.0/users/other%40example.com/messages",
    ]
  ) {
    await assertRejects(
      () =>
        dispatchOutlookSearch(
          new URLSearchParams({
            mailbox: "ops@example.com",
            search: "Job",
            cursor,
          }),
          ["ops@example.com"],
          () => {
            throw new Error("must not call");
          },
        ),
      Error,
      "Invalid Outlook continuation",
    );
  }
});
