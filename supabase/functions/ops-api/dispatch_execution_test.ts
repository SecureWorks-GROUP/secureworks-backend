// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeDispatchDraft } from "./dispatch_execution.ts";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture(fail = false) {
  const draft = {
    id: id(2),
    content_hash: "content1",
    approval: {
      id: id(3),
      content_hash: "content1",
      source_version: "source1",
    },
    body: "Exact reviewed body",
    to: ["supplier@example.test"],
    attachments: [],
  };
  const job: any = { source_version: "source1", drafts: [draft] };
  let action: any = null;
  let sends = 0;
  const client: any = {
    rpc: (name: string) => {
      if (name === "dispatch_begin_send") {
        return Promise.resolve({ data: { allowed: true } });
      }
      if (action) return Promise.resolve({ data: { claimed: false, action } });
      action = {
        id: id(3),
        status: "claimed",
        snapshot: structuredClone(draft),
      };
      return Promise.resolve({ data: { claimed: true, action } });
    },
    from: () => ({
      update: (patch: any) => {
        Object.assign(action, patch);
        const q: any = {
          eq: () => q,
          then: (resolve: any) =>
            Promise.resolve({ data: [action] }).then(resolve),
        };
        return q;
      },
    }),
  };
  const provider = {
    prepare: (d: any) => {
      assertEquals(d.body, "Exact reviewed body");
      return Promise.resolve({ draft_id: "native1" });
    },
    send: () => {
      sends++;
      if (fail) return Promise.reject(Error("timeout after provider call"));
      return Promise.resolve({ provider_accepted: true, delivered: null });
    },
    readback: () => Promise.resolve({ is_draft: false }),
  };
  return {
    client,
    job,
    provider,
    get sends() {
      return sends;
    },
    get action() {
      return action;
    },
    read: () => Promise.resolve(job),
  };
}
const body = { job_id: id(1), draft_id: id(2), approval_id: id(3) };
Deno.test("release hold makes no datastore/provider call", async () => {
  const f = fixture();
  const r = await executeDispatchDraft(
    f.client,
    id(9),
    body,
    f.provider,
    false,
    f.read,
  );
  assertEquals(r.action.status, "held");
  assertEquals(f.sends, 0);
  assertEquals(f.action, null);
});
Deno.test("changed exact content or source refuses approved execution", async () => {
  const f = fixture();
  f.job.drafts[0].content_hash = "changed";
  await assertRejects(() =>
    executeDispatchDraft(f.client, id(9), body, f.provider, true, f.read)
  );
  assertEquals(f.sends, 0);
});
Deno.test("approved fake execution persists receipt and exact retry never sends twice", async () => {
  const f = fixture();
  const first = await executeDispatchDraft(
    f.client,
    id(9),
    body,
    f.provider,
    true,
    f.read,
  );
  assertEquals(first.action.status, "accepted_not_delivered");
  assertEquals(f.action.receipt.draft_id, "native1");
  await executeDispatchDraft(f.client, id(9), body, f.provider, true, f.read);
  assertEquals(f.sends, 1);
});
Deno.test("uncertain provider result preserves draft and refuses automatic retry", async () => {
  const f = fixture(true);
  const first = await executeDispatchDraft(
    f.client,
    id(9),
    body,
    f.provider,
    true,
    f.read,
  );
  assertEquals(first.action.status, "outcome_unknown");
  assertEquals(f.action.receipt.draft_id, "native1");
  assertEquals(f.job.drafts[0].body, "Exact reviewed body");
  await executeDispatchDraft(f.client, id(9), body, f.provider, true, f.read);
  assertEquals(f.sends, 1);
});
Deno.test("source change during provider preparation prevents send", async () => {
  const f = fixture();
  f.provider.prepare = () => {
    f.job.source_version = "changed";
    return Promise.resolve({ draft_id: "native1" });
  };
  const r = await executeDispatchDraft(
    f.client,
    id(9),
    body,
    f.provider,
    true,
    f.read,
  );
  assertEquals(r.action.status, "not_sent");
  assertEquals(f.sends, 0);
});
Deno.test("approval replacement or release hold during preparation prevents send", async () => {
  for (const mutation of ["approval", "hold"]) {
    const f = fixture();
    let released = true;
    f.provider.prepare = () => {
      if (mutation === "approval") f.job.drafts[0].approval.id = id(8);
      else released = false;
      return Promise.resolve({ draft_id: "native1" });
    };
    const r = await executeDispatchDraft(
      f.client,
      id(9),
      body,
      f.provider,
      true,
      f.read,
      () => released,
    );
    assertEquals(r.action.status, "not_sent");
    assertEquals(f.sends, 0);
  }
});
Deno.test("native Outlook adapter preserves exact reply identity, recipients and body using injected transport", async () => {
  const { outlookDispatchProvider } = await import("./dispatch_execution.ts");
  const calls: string[] = [];
  const draft = {
    sender: "ops@example.test",
    to: ["supplier@example.test"],
    cc: [],
    subject: "Reviewed subject",
    body: "Reviewed body",
    attachments: [],
    content_hash: "exact",
    thread_id: "thread1",
    graph_message_id: "message1",
    graph_change_key: "source-rev",
  };
  const provider = outlookDispatchProvider({}, ["ops@example.test"], {
    guard: () => Promise.resolve(),
    verify: () => Promise.resolve(),
    attachment: () => Promise.reject(Error("none expected")),
    request: (path, options) => {
      calls.push(`${options?.method || "GET"} ${path}`);
      let data: any = {};
      if (path.includes("message1?$select")) {
        data = { conversationId: "thread1", changeKey: "source-rev" };
      } else if (path.endsWith("/createReply")) {
        assertEquals(
          JSON.parse(String(options?.body)).message.body.content,
          draft.body,
        );
        data = {
          id: "reply1",
          changeKey: "r1",
          toRecipients: [{
            emailAddress: { address: "supplier@example.test" },
          }],
          ccRecipients: [],
        };
      } else if (path.includes("/attachments?")) data = { value: [] };
      else if (
        path.endsWith("/reply1") &&
        (!options?.method || options.method === "GET")
      ) {
        data = {
          id: "reply1",
          isDraft: true,
          subject: draft.subject,
          body: { content: draft.body },
          changeKey: "r2",
        };
      }
      return Promise.resolve(
        new Response(JSON.stringify(data), { status: 200 }),
      );
    },
  });
  const receipt = await provider.prepare(draft, id(3), id(1));
  assertEquals(receipt.draft_id, "reply1");
  await provider.send(receipt);
  assertEquals(calls.filter((x) => x.endsWith("/send")).length, 1);
});
