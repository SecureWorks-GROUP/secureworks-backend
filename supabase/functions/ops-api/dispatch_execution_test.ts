// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  executeDispatchDraft,
  readbackDispatchExecution,
} from "./dispatch_execution.ts";
import { assertOutlookSesDeliveryAllowed } from "../send-outlook-email/index.ts";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function guardClient(rows: Record<string, Record<string, any>>) {
  return {
    from(table: string) {
      const builder: any = {
        value: undefined,
        select: () => builder,
        eq: (_field: string, value: string) => {
          builder.value = value;
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve({ data: rows[table]?.[builder.value] ?? null }),
      };
      return builder;
    },
  };
}
function fixture(fail = false) {
  const draft = {
    id: id(2),
    content_hash: "content1",
    purchase_commitment: false,
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
    rpc: (name: string, args: any) => {
      if (name === "dispatch_claim_execution") {
        if (action) {
          return Promise.resolve({ data: { claimed: false, action } });
        }
        action = {
          id: id(3),
          job_id: id(1),
          draft_id: id(2),
          content_hash: "content1",
          source_version: "source1",
          status: "claimed",
          receipt: null,
          lease_token: "lease1",
          snapshot: structuredClone(job.drafts[0]),
        };
        return Promise.resolve({ data: { claimed: true, action } });
      }
      if (name === "dispatch_record_execution_progress") {
        assertEquals(args.p_expected_status, action.status);
        assertEquals(args.p_expected_receipt, action.receipt ?? null);
        assertEquals(args.p_expected_source, action.source_version);
        assertEquals(args.p_lease_token, action.lease_token ?? null);
        action = {
          ...action,
          status: args.p_status,
          receipt: args.p_receipt,
          last_error: args.p_error,
          lease_token: args.p_status === "provider_draft_ready"
            ? action.lease_token
            : null,
        };
        return Promise.resolve({
          data: {
            recorded: true,
            action,
            readback_required: action.status === "outcome_unknown",
          },
        });
      }
      if (name === "dispatch_begin_send") {
        assertEquals(args.p_lease_token, action.lease_token ?? null);
        if (!["provider_draft_ready", "sending"].includes(action.status)) {
          return Promise.resolve({
            data: { allowed: false, reason: "not_ready", action },
          });
        }
        action = { ...action, status: "sending" };
        return Promise.resolve({ data: { allowed: true, action } });
      }
      throw new Error(`unexpected rpc ${name}`);
    },
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
function decodeBase64Utf8(value: string) {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function decodeMimeHeaderValue(value: string) {
  return value.replace(/(\?=)[ \t]+(?==\?UTF-8\?B\?)/gi, "$1")
    .replace(
      /=\?UTF-8\?B\?([^?]+)\?=/gi,
      (_match, encoded) => decodeBase64Utf8(encoded),
    );
}
function assertMimeReplyRequest(options: any, draft: any) {
  assertEquals((options?.headers as any)?.["Content-Type"], "text/plain");
  const mime = decodeBase64Utf8(String(options?.body || ""));
  const [rawHeaders, ...bodyParts] = mime.replaceAll("\r\n", "\n").split(
    "\n\n",
  );
  const unfoldedHeaders = rawHeaders.replace(/\n[ \t]+/g, " ");
  const headers = new Map(
    unfoldedHeaders.split("\n").map((line) => {
      const index = line.indexOf(":");
      return [
        line.slice(0, index).toLowerCase(),
        line.slice(index + 1).trim(),
      ];
    }),
  );
  const subject = decodeMimeHeaderValue(headers.get("subject") || "");
  if (subject !== draft.subject) {
    throw new Error("MIME reply is missing approved subject");
  }
  if ((headers.get("from") || "") !== draft.sender) {
    throw new Error("MIME reply is missing approved sender");
  }
  if ((headers.get("to") || "") !== draft.to.join(", ")) {
    throw new Error("MIME reply is missing approved To recipients");
  }
  if (draft.cc.length && (headers.get("cc") || "") !== draft.cc.join(", ")) {
    throw new Error("MIME reply is missing approved Cc recipients");
  }
  const encodedBody = bodyParts.join("\n\n").replace(/\s+/g, "");
  if (decodeBase64Utf8(encodedBody).replaceAll("\r\n", "\n") !== draft.body) {
    throw new Error("MIME reply is missing approved body");
  }
  return mime;
}
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
Deno.test("source drift after claim is recorded as not sent before provider preparation", async () => {
  const f = fixture();
  let reads = 0;
  let prepared = 0;
  f.provider.prepare = () => {
    prepared++;
    return Promise.resolve({ draft_id: "native1" });
  };
  const r = await executeDispatchDraft(
    f.client,
    id(9),
    body,
    f.provider,
    true,
    () => {
      reads++;
      if (reads === 2) f.job.source_version = "changed";
      return Promise.resolve(f.job);
    },
  );
  assertEquals(r.action.status, "not_sent");
  assertEquals(f.action.status, "not_sent");
  assertEquals(prepared, 0);
  assertEquals(f.sends, 0);
});

Deno.test("source read failure before preparation remains retryable without provider uncertainty", async () => {
  const f = fixture();
  let reads = 0;
  f.provider.prepare = () =>
    Promise.reject(Error("Provider must not be called"));
  const result = await executeDispatchDraft(
    f.client,
    id(9),
    body,
    f.provider,
    true,
    () => {
      if (++reads === 2) throw Error("Source unavailable");
      return Promise.resolve(f.job);
    },
  );
  assertEquals(result.action.status, "not_sent");
  assertEquals(f.action.status, "not_sent");
  assertEquals(f.action.receipt, null);
  assertEquals(f.sends, 0);
});

Deno.test("tenant communication hold reports live actions disabled", async () => {
  const f = fixture();
  f.client.rpc = () =>
    Promise.resolve({
      data: { claimed: false, action: { id: id(3), status: "held" } },
    });
  const r = await executeDispatchDraft(
    f.client,
    id(9),
    body,
    f.provider,
    true,
    f.read,
  );
  assertEquals(r.action.status, "held");
  assertEquals(r.live_actions_enabled, false);
  assertEquals(f.sends, 0);
});

Deno.test("unreleased mailbox before provider mutation records not sent", async () => {
  const f = fixture();
  f.job.drafts[0].sender = "ops@example.test";
  f.job.drafts[0].cc = [];
  const { outlookDispatchProvider } = await import("./dispatch_execution.ts");
  const provider = outlookDispatchProvider({}, [], {
    guard: () => Promise.resolve(),
    verify: () => Promise.resolve(),
    attachment: () => Promise.reject(Error("none expected")),
    request: () => {
      throw new Error("provider mutation should not start");
    },
  });
  const r = await executeDispatchDraft(
    f.client,
    id(9),
    body,
    provider,
    true,
    f.read,
  );
  assertEquals(r.action.status, "not_sent");
  assertEquals(f.action.receipt, null);
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
  let preparing = true;
  const draft = {
    sender: "ops@example.test",
    to: ["supplier@example.test"],
    cc: [],
    subject: "Reviewed subject – café panel ".repeat(4).trim(),
    body: "Reviewed body\nUnicode café line",
    attachments: [],
    content_hash: "exact",
    purchase_commitment: false,
    thread_id: "thread1",
    graph_message_id: "message1",
    graph_change_key: "source-rev",
  };
  const provider = outlookDispatchProvider({}, ["ops@example.test"], {
    guard: (_client, body) => {
      assertEquals(body.action, "reply");
      assertEquals(body.mailbox, draft.sender);
      assertEquals(body.message_id, draft.graph_message_id);
      assertEquals(body.job_id, id(1));
      assertEquals(body.expected_to, draft.to);
      assertEquals(body.expected_cc, draft.cc);
      return Promise.resolve();
    },
    verify: () => Promise.resolve(),
    attachment: () => Promise.reject(Error("none expected")),
    request: (path, options) => {
      calls.push(`${options?.method || "GET"} ${path}`);
      let data: any = {};
      if (path.includes("message1?$select")) {
        data = { conversationId: "thread1", changeKey: "source-rev" };
      } else if (path.endsWith("/createReply")) {
        assertMimeReplyRequest(options, draft);
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
        (path.endsWith("/reply1") || path.includes("/reply1?$select")) &&
        (!options?.method || options.method === "GET")
      ) {
        if (preparing) {
          assertEquals(
            String((options?.headers as any)?.Prefer || ""),
            'IdType="ImmutableId", outlook.body-content-type="text"',
          );
        }
        data = {
          id: "reply1",
          isDraft: true,
          from: { emailAddress: { address: draft.sender } },
          sender: { emailAddress: { address: draft.sender } },
          toRecipients: [{
            emailAddress: { address: "supplier@example.test" },
          }],
          ccRecipients: [],
          bccRecipients: [],
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
  preparing = false;
  assertEquals(receipt.draft_id, "reply1");
  assertEquals(calls.some((x) => x.startsWith("PATCH ")), false);
  await provider.send(receipt);
  assertEquals(calls.filter((x) => x.endsWith("/send")).length, 1);
});

function dispatchGraphAttachment(name = "approved.pdf", contentBytes = "YXBw") {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name,
    contentType: "application/pdf",
    contentBytes,
  };
}

function finalDispatchMessage(draft: any, overrides: Record<string, any> = {}) {
  return {
    id: overrides.id || "reply1",
    isDraft: true,
    from: { emailAddress: { address: draft.sender } },
    sender: { emailAddress: { address: draft.sender } },
    toRecipients: draft.to.map((address: string) => ({
      emailAddress: { address },
    })),
    ccRecipients: draft.cc.map((address: string) => ({
      emailAddress: { address },
    })),
    bccRecipients: [],
    subject: draft.subject,
    body: { content: draft.body },
    changeKey: "r2",
    ...overrides,
  };
}

Deno.test("native Outlook reply rejects final recipient drift with approved body", async () => {
  const { outlookDispatchProvider } = await import("./dispatch_execution.ts");
  const draft = {
    sender: "ops@example.test",
    to: ["supplier@example.test"],
    cc: [],
    subject: "Reviewed subject",
    body: "Reviewed body",
    attachments: [],
    content_hash: "exact",
    purchase_commitment: false,
    thread_id: "thread1",
    graph_message_id: "message1",
    graph_change_key: "source-rev",
  };
  const provider = outlookDispatchProvider({}, ["ops@example.test"], {
    guard: () => Promise.resolve(),
    verify: () => Promise.resolve(),
    attachment: () => Promise.reject(Error("none expected")),
    request: (path, options) => {
      let data: any = {};
      if (path.includes("message1?$select")) {
        data = { conversationId: "thread1", changeKey: "source-rev" };
      } else if (path.endsWith("/createReply")) {
        assertMimeReplyRequest(options, draft);
        data = {
          id: "reply1",
          changeKey: "r1",
          toRecipients: draft.to.map((address) => ({
            emailAddress: { address },
          })),
          ccRecipients: [],
        };
      } else if (path.includes("/attachments?")) {
        data = { value: [] };
      } else if (
        path.includes("/reply1?$select") &&
        (!options?.method || options.method === "GET")
      ) {
        data = finalDispatchMessage(draft, {
          toRecipients: [{
            emailAddress: { address: "unapproved@example.test" },
          }],
        });
      }
      return Promise.resolve(new Response(JSON.stringify(data)));
    },
  });
  const error = await assertRejects(
    () => provider.prepare(draft, id(3), id(1)),
    Error,
    "Provider draft envelope differs from approved draft",
  ) as any;
  assertEquals(error.receipt.draft_id, "reply1");
});

Deno.test("native Outlook reply rejects final sender and BCC drift", async () => {
  const { outlookDispatchProvider } = await import("./dispatch_execution.ts");
  for (const drift of ["sender", "bcc"]) {
    const draft = {
      sender: "ops@example.test",
      to: ["supplier@example.test"],
      cc: [],
      subject: "Reviewed subject",
      body: "Reviewed body",
      attachments: [],
      content_hash: "exact",
      purchase_commitment: false,
      thread_id: "thread1",
      graph_message_id: "message1",
      graph_change_key: "source-rev",
    };
    const provider = outlookDispatchProvider({}, ["ops@example.test"], {
      guard: () => Promise.resolve(),
      verify: () => Promise.resolve(),
      attachment: () => Promise.reject(Error("none expected")),
      request: (path, options) => {
        let data: any = {};
        if (path.includes("message1?$select")) {
          data = { conversationId: "thread1", changeKey: "source-rev" };
        } else if (path.endsWith("/createReply")) {
          assertMimeReplyRequest(options, draft);
          data = {
            id: "reply1",
            changeKey: "r1",
            toRecipients: draft.to.map((address) => ({
              emailAddress: { address },
            })),
            ccRecipients: [],
          };
        } else if (path.includes("/attachments?")) {
          data = { value: [] };
        } else if (
          path.includes("/reply1?$select") &&
          (!options?.method || options.method === "GET")
        ) {
          data = finalDispatchMessage(
            draft,
            drift === "sender"
              ? {
                from: { emailAddress: { address: "other@example.test" } },
                sender: { emailAddress: { address: "other@example.test" } },
              }
              : {
                bccRecipients: [{
                  emailAddress: { address: "hidden@example.test" },
                }],
              },
          );
        }
        return Promise.resolve(new Response(JSON.stringify(data)));
      },
    });
    await assertRejects(
      () => provider.prepare(draft, id(3), id(1)),
      Error,
      "Provider draft envelope differs from approved draft",
    );
  }
});

Deno.test("native Outlook reply rejects final attachment evidence drift", async () => {
  const { outlookDispatchProvider } = await import("./dispatch_execution.ts");
  for (
    const drift of [
      "addition",
      "removal",
      "replacement",
      "inline",
      "contentId",
      "item",
    ]
  ) {
    const approved = dispatchGraphAttachment();
    const uploaded: any[] = [];
    const draft = {
      sender: "ops@example.test",
      to: ["supplier@example.test"],
      cc: [],
      subject: "Reviewed subject",
      body: "Reviewed body",
      attachments: [{
        source_ref: "https://storage.example.test/approved.pdf",
        name: "approved.pdf",
        revision:
          "sha256:a172cedcae47474b615c54d510a5d84a8dea3032e958587430b413538be3f333",
      }],
      content_hash: "exact",
      purchase_commitment: false,
      thread_id: "thread1",
      graph_message_id: "message1",
      graph_change_key: "source-rev",
    };
    const provider = outlookDispatchProvider({}, ["ops@example.test"], {
      guard: () => Promise.resolve(),
      verify: () => Promise.resolve(),
      attachment: () => Promise.resolve(approved),
      request: (path, options) => {
        let data: any = {};
        if (path.includes("message1?$select")) {
          data = { conversationId: "thread1", changeKey: "source-rev" };
        } else if (path.endsWith("/createReply")) {
          assertMimeReplyRequest(options, draft);
          data = {
            id: "reply1",
            changeKey: "r1",
            toRecipients: draft.to.map((address) => ({
              emailAddress: { address },
            })),
            ccRecipients: [],
          };
        } else if (
          path.endsWith("/attachments") && options?.method === "POST"
        ) {
          const id = `att-${uploaded.length + 1}`;
          uploaded.push({ ...JSON.parse(String(options.body)), id });
          data = { id };
        } else if (path.includes("/attachments/")) {
          if (drift === "addition" && path.endsWith("att-extra")) {
            data = {
              ...dispatchGraphAttachment("extra.pdf", "ZXh0cmE="),
              id: "att-extra",
            };
          } else if (
            ["replacement", "inline", "contentId", "item"].includes(drift) &&
            path.endsWith("att-1")
          ) {
            data = {
              ...(
                drift === "item"
                  ? { "@odata.type": "#microsoft.graph.itemAttachment" }
                  : dispatchGraphAttachment(
                    "approved.pdf",
                    drift === "replacement" ? "cmVwbGFjZWQ=" : "YXBw",
                  )
              ),
              id: "att-1",
              ...(drift === "inline" ? { isInline: true } : {}),
              ...(drift === "contentId" ? { contentId: "cid-1" } : {}),
            };
          } else {
            data = uploaded.find((attachment) =>
              path.endsWith(attachment.id)
            ) ||
              {};
          }
        } else if (path.includes("/attachments?")) {
          const value = uploaded.length === 0 ? [] : drift === "addition"
            ? [
              ...uploaded,
              {
                ...dispatchGraphAttachment("extra.pdf", "ZXh0cmE="),
                id: "att-extra",
              },
            ]
            : drift === "removal"
            ? []
            : [{
              ...dispatchGraphAttachment(
                "approved.pdf",
                drift === "replacement" ? "cmVwbGFjZWQ=" : "YXBw",
              ),
              id: "att-1",
              ...(drift === "inline" ? { isInline: true } : {}),
              ...(drift === "contentId" ? { contentId: "cid-1" } : {}),
              ...(drift === "item"
                ? { "@odata.type": "#microsoft.graph.itemAttachment" }
                : {}),
            }];
          data = { value };
        } else if (
          path.includes("/reply1?$select") &&
          (!options?.method || options.method === "GET")
        ) {
          data = finalDispatchMessage(draft);
        }
        return Promise.resolve(new Response(JSON.stringify(data)));
      },
    });
    await assertRejects(
      () => provider.prepare(draft, id(3), id(1)),
      Error,
      "Provider draft attachments differ from approved draft",
    );
  }
});

Deno.test("native Outlook reply accepts approved attachment evidence", async () => {
  const { outlookDispatchProvider } = await import("./dispatch_execution.ts");
  const approved = dispatchGraphAttachment();
  const uploaded: any[] = [];
  const draft = {
    sender: "ops@example.test",
    to: ["supplier@example.test"],
    cc: [],
    subject: "Reviewed subject",
    body: "Reviewed body",
    attachments: [{
      source_ref: "https://storage.example.test/approved.pdf",
      name: "approved.pdf",
      revision:
        "sha256:a172cedcae47474b615c54d510a5d84a8dea3032e958587430b413538be3f333",
    }],
    content_hash: "exact",
    purchase_commitment: false,
    thread_id: "thread1",
    graph_message_id: "message1",
    graph_change_key: "source-rev",
  };
  const provider = outlookDispatchProvider({}, ["ops@example.test"], {
    guard: () => Promise.resolve(),
    verify: () => Promise.resolve(),
    attachment: () => Promise.resolve(approved),
    request: (path, options) => {
      let data: any = {};
      if (path.includes("message1?$select")) {
        data = { conversationId: "thread1", changeKey: "source-rev" };
      } else if (path.endsWith("/createReply")) {
        assertMimeReplyRequest(options, draft);
        data = {
          id: "reply1",
          changeKey: "r1",
          toRecipients: draft.to.map((address) => ({
            emailAddress: { address },
          })),
          ccRecipients: [],
        };
      } else if (path.endsWith("/attachments") && options?.method === "POST") {
        uploaded.push({ ...JSON.parse(String(options.body)), id: "att-1" });
        data = { id: "att-1" };
      } else if (path.includes("/attachments/")) {
        data = uploaded.find((attachment) => path.endsWith(attachment.id)) ||
          {};
      } else if (path.includes("/attachments?")) {
        data = { value: uploaded.length ? uploaded : [] };
      } else if (
        path.includes("/reply1?$select") &&
        (!options?.method || options.method === "GET")
      ) {
        data = finalDispatchMessage(draft);
      }
      return Promise.resolve(new Response(JSON.stringify(data)));
    },
  });
  const receipt = await provider.prepare(draft, id(3), id(1));
  assertEquals(receipt.draft_id, "reply1");
  assertEquals(receipt.change_key, "r2");
});

Deno.test("execution holds mutated provider draft with receipt and no send", async () => {
  const f = fixture();
  f.job.drafts[0] = {
    ...f.job.drafts[0],
    sender: "ops@example.test",
    cc: [],
    subject: "Reviewed subject",
    body: "Reviewed body",
    attachments: [],
    thread_id: "thread1",
    graph_message_id: "message1",
    graph_change_key: "source-rev",
  };
  let sendCalls = 0;
  const { outlookDispatchProvider } = await import("./dispatch_execution.ts");
  const provider = outlookDispatchProvider({}, ["ops@example.test"], {
    guard: () => Promise.resolve(),
    verify: () => Promise.resolve(),
    attachment: () => Promise.reject(Error("none expected")),
    request: (path, options) => {
      let data: any = {};
      if (path.includes("message1?$select")) {
        data = { conversationId: "thread1", changeKey: "source-rev" };
      } else if (path.endsWith("/createReply")) {
        assertMimeReplyRequest(options, f.job.drafts[0]);
        data = {
          id: "reply1",
          changeKey: "r1",
          toRecipients: [{
            emailAddress: { address: "supplier@example.test" },
          }],
          ccRecipients: [],
        };
      } else if (path.includes("/attachments?")) {
        data = { value: [] };
      } else if (path.includes("/reply1/send")) {
        sendCalls++;
      } else if (
        path.includes("/reply1?$select") &&
        (!options?.method || options.method === "GET")
      ) {
        data = finalDispatchMessage(f.job.drafts[0], {
          toRecipients: [{
            emailAddress: { address: "unapproved@example.test" },
          }],
        });
      }
      return Promise.resolve(new Response(JSON.stringify(data)));
    },
  });
  const result = await executeDispatchDraft(
    f.client,
    id(9),
    body,
    provider,
    true,
    f.read,
  );
  assertEquals(result.action.status, "outcome_unknown");
  assertEquals(f.action.receipt.draft_id, "reply1");
  assertEquals(sendCalls, 0);
});

Deno.test("native Outlook new mail validates final provider revision before accepting", async () => {
  const { outlookDispatchProvider } = await import("./dispatch_execution.ts");
  const draft = {
    sender: "ops@example.test",
    to: ["supplier@example.test"],
    cc: [],
    subject: "Reviewed subject",
    body: "Reviewed body",
    attachments: [],
    content_hash: "exact",
    purchase_commitment: false,
  };
  const provider = outlookDispatchProvider({}, ["ops@example.test"], {
    guard: () => Promise.resolve(),
    verify: () => Promise.resolve(),
    attachment: () => Promise.reject(Error("none expected")),
    request: (path, options) => {
      let data: any = {};
      if (path.endsWith("/messages") && options?.method === "POST") {
        data = { id: "new1", changeKey: "n1" };
      } else if (path.includes("/new1?$select")) {
        data = finalDispatchMessage(draft, {
          id: "new1",
          toRecipients: [{
            emailAddress: { address: "unapproved@example.test" },
          }],
        });
      } else if (path.includes("/attachments?")) {
        data = { value: [] };
      }
      return Promise.resolve(new Response(JSON.stringify(data)));
    },
  });
  const error = await assertRejects(
    () => provider.prepare(draft, id(3), id(1)),
    Error,
    "Provider draft envelope differs from approved draft",
  ) as any;
  assertEquals(error.receipt.draft_id, "new1");
});

Deno.test("native Outlook reply guard blocks foreign source before provider mutation", async () => {
  const { outlookDispatchProvider } = await import("./dispatch_execution.ts");
  let providerMutations = 0;
  const draft = {
    sender: "ops@example.test",
    to: ["supplier@example.test"],
    cc: [],
    subject: "Reviewed subject",
    body: "Reviewed body",
    attachments: [],
    content_hash: "exact",
    purchase_commitment: false,
    thread_id: "thread-a",
    graph_message_id: "message-a",
    graph_change_key: "source-rev",
  };
  const provider = outlookDispatchProvider({}, ["ops@example.test"], {
    guard: (_client, body) => {
      assertEquals(body.action, "reply");
      assertEquals(body.mailbox, "ops@example.test");
      assertEquals(body.message_id, "message-a");
      assertEquals(body.job_id, id(2));
      throw new Error("The reply source message is not linked to this job");
    },
    verify: () => Promise.resolve(),
    attachment: () => Promise.reject(Error("none expected")),
    request: (_path, _options, policy) => {
      if (policy?.mutating) providerMutations++;
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    },
  });
  await assertRejects(
    () => provider.prepare(draft, id(3), id(2)),
    Error,
    "not linked to this job",
  );
  assertEquals(providerMutations, 0);
});

Deno.test("native Outlook reply uses incumbent guard to refuse a foreign stored job", async () => {
  const { outlookDispatchProvider } = await import("./dispatch_execution.ts");
  const sealedJob = id(41);
  const ordinaryJob = id(42);
  const messageId = "sealed-thread-message";
  const client = guardClient({
    inbox_events: {
      [messageId]: {
        job_id: sealedJob,
        mailbox: "ops@example.test",
        from_email: "supplier@example.test",
      },
    },
    jobs: {
      [sealedJob]: {
        id: sealedJob,
        type: "makesafe",
        job_number: "SWMS-41",
        ses_money_sealed_at: "2026-09-01T00:00:00Z",
        ses_money_seal_source: "fixture",
      },
      [ordinaryJob]: {
        id: ordinaryJob,
        type: "patio",
        job_number: "SWP-42",
        ses_money_sealed_at: null,
        ses_money_seal_source: null,
      },
    },
  });
  let providerMutations = 0;
  const provider = outlookDispatchProvider(
    client,
    ["ops@example.test"],
    {
      guard: assertOutlookSesDeliveryAllowed,
      verify: () => Promise.resolve(),
      attachment: () => Promise.reject(Error("none expected")),
      request: (_path, _options, policy) => {
        if (policy?.mutating) providerMutations++;
        return Promise.resolve(
          new Response(JSON.stringify({}), { status: 200 }),
        );
      },
    },
  );
  const error = await assertRejects(
    () =>
      provider.prepare(
        {
          sender: "ops@example.test",
          to: ["supplier@example.test"],
          cc: [],
          subject: "Reviewed subject",
          body: "Reviewed body",
          attachments: [],
          content_hash: "exact",
          purchase_commitment: false,
          thread_id: "thread-a",
          graph_message_id: messageId,
          graph_change_key: "source-rev",
        },
        id(3),
        ordinaryJob,
      ),
  ) as any;
  assertEquals(error.status, 409);
  assertEquals(error.refusal.code, "pdf_provenance_required");
  assertEquals(error.refusal.evidence.stored_job_id, sealedJob);
  assertEquals(error.refusal.evidence.received_job_id, ordinaryJob);
  assertEquals(providerMutations, 0);
});

Deno.test("Outlook readback maps thrown Graph 404 to held evidence", async () => {
  const { outlookDispatchProvider } = await import("./dispatch_execution.ts");
  const { GraphProviderError } = await import("../send-outlook-email/index.ts");
  const provider = outlookDispatchProvider({}, ["ops@example.test"], {
    guard: () => Promise.resolve(),
    verify: () => Promise.resolve(),
    attachment: () => Promise.reject(Error("none expected")),
    request: () => {
      throw new GraphProviderError(404, "Graph request failed: 404", false);
    },
  });
  const evidence = await provider.readback({
    mailbox: "ops@example.test",
    draft_id: "immutable-draft",
  });
  assertEquals(evidence, { verified: false, status: 404 });
});

Deno.test("readback records verified sent immutable id through SQL fence", async () => {
  const action: any = {
    org_id: id(9),
    id: id(3),
    job_id: id(1),
    draft_id: id(2),
    content_hash: "content1",
    source_version: "source1",
    status: "outcome_unknown",
    receipt: { mailbox: "ops@example.test", draft_id: "immutable-draft" },
  };
  let rpcArgs: any = null;
  const client: any = {
    rpc: (name: string, args: any) => {
      if (name === "dispatch_get_execution") {
        assertEquals(args.p_action, action.id);
        return Promise.resolve({ data: structuredClone(action) });
      }
      rpcArgs = { name, args };
      assertEquals(name, "dispatch_record_execution_readback");
      assertEquals(args.p_expected_status, "outcome_unknown");
      assertEquals(args.p_expected_receipt, action.receipt);
      return Promise.resolve({
        data: {
          recorded: true,
          readback_required: false,
          action: {
            ...action,
            status: "accepted_not_delivered",
            receipt: {
              ...action.receipt,
              readback: args.p_readback,
            },
          },
        },
      });
    },
  };
  const provider = {
    prepare: () => Promise.reject(Error("unused")),
    send: () => Promise.reject(Error("unused")),
    readback: () =>
      Promise.resolve({
        verified: true,
        id: "immutable-draft",
        is_draft: false,
        sent_at: "2026-09-13T01:00:00Z",
        delivered: null,
      }),
  };
  const r = await readbackDispatchExecution(client, id(9), id(3), provider);
  assertEquals(r.action.status, "accepted_not_delivered");
  assertEquals(r.readback_required, false);
  assertEquals(r.readback_recorded, true);
  assertEquals(rpcArgs.args.p_expected_source, "source1");
});

Deno.test("stale readback result cannot overwrite concurrent execution status", async () => {
  const action: any = {
    org_id: id(9),
    id: id(3),
    job_id: id(1),
    draft_id: id(2),
    content_hash: "content1",
    source_version: "source1",
    status: "outcome_unknown",
    receipt: { mailbox: "ops@example.test", draft_id: "immutable-draft" },
  };
  const client: any = {
    rpc: (name: string) => {
      if (name === "dispatch_get_execution") {
        return Promise.resolve({ data: structuredClone(action) });
      }
      return Promise.resolve({
        data: {
          recorded: false,
          reason: "stale_action",
          readback_required: false,
          action: { ...action, status: "not_sent" },
        },
      });
    },
  };
  const provider = {
    prepare: () => Promise.reject(Error("unused")),
    send: () => Promise.reject(Error("unused")),
    readback: () =>
      Promise.resolve({
        verified: true,
        id: "immutable-draft",
        is_draft: false,
        sent_at: "2026-09-13T01:00:00Z",
        delivered: null,
      }),
  };
  const r = await readbackDispatchExecution(client, id(9), id(3), provider);
  assertEquals(r.action.status, "not_sent");
  assertEquals(r.readback_recorded, false);
});

Deno.test("late provider success cannot overwrite verified readback recovery", async () => {
  const draft = {
    id: id(2),
    content_hash: "content1",
    purchase_commitment: false,
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
  let action: any = {
    id: id(3),
    job_id: id(1),
    draft_id: id(2),
    content_hash: "content1",
    source_version: "source1",
    status: "claimed",
    receipt: null,
    lease_token: "lease1",
    snapshot: structuredClone(draft),
  };
  const readbackAction = {
    ...action,
    status: "accepted_not_delivered",
    receipt: {
      draft_id: "native1",
      readback: {
        verified: true,
        id: "native1",
        is_draft: false,
        sent_at: "2026-09-13T01:00:00Z",
        delivered: null,
      },
    },
    lease_token: null,
  };
  let finalProgress = 0;
  const client: any = {
    rpc: (name: string, args: any) => {
      if (name === "dispatch_claim_execution") {
        return Promise.resolve({ data: { claimed: true, action } });
      }
      if (name === "dispatch_record_execution_progress") {
        if (args.p_status === "provider_draft_ready") {
          action = {
            ...action,
            status: "provider_draft_ready",
            receipt: args.p_receipt,
          };
          return Promise.resolve({
            data: { recorded: true, action, readback_required: false },
          });
        }
        finalProgress++;
        return Promise.resolve({
          data: {
            recorded: false,
            reason: "stale_action",
            action: readbackAction,
            readback_required: false,
          },
        });
      }
      if (name === "dispatch_begin_send") {
        action = { ...action, status: "sending" };
        return Promise.resolve({ data: { allowed: true, action } });
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  const provider = {
    prepare: () => Promise.resolve({ draft_id: "native1" }),
    send: () => Promise.resolve({ provider_accepted: true, delivered: null }),
    readback: () => Promise.reject(Error("unused")),
  };
  const result = await executeDispatchDraft(
    client,
    id(9),
    body,
    provider,
    true,
    () => Promise.resolve(job),
  );
  assertEquals(finalProgress, 1);
  assertEquals(result.action.status, "accepted_not_delivered");
  assertEquals(result.action.receipt.readback.sent_at, "2026-09-13T01:00:00Z");
});

Deno.test("execution refuses supplier commitment without purchase approval", async () => {
  const f = fixture();
  delete f.job.drafts[0].purchase_commitment;
  f.job.drafts[0].approval.purchase_approved = false;
  await assertRejects(
    () => executeDispatchDraft(f.client, id(9), body, f.provider, true, f.read),
    Error,
    "Communications and supplier commitment approvals are separate",
  );
  assertEquals(f.action, null);
  assertEquals(f.sends, 0);
});

Deno.test("unlinked draft can execute when supplier commitment is explicitly absent", async () => {
  const f = fixture();
  f.job.drafts[0].approval.purchase_approved = false;
  const r = await executeDispatchDraft(
    f.client,
    id(9),
    body,
    f.provider,
    true,
    f.read,
  );
  assertEquals(r.action.status, "accepted_not_delivered");
  assertEquals(f.sends, 1);
});

Deno.test("linked draft always requires purchase approval", async () => {
  const f = fixture();
  f.job.drafts[0].po_id = id(4);
  f.job.drafts[0].purchase_commitment = false;
  f.job.drafts[0].approval.purchase_approved = false;
  await assertRejects(
    () => executeDispatchDraft(f.client, id(9), body, f.provider, true, f.read),
    Error,
    "Communications and supplier commitment approvals are separate",
  );
  assertEquals(f.action, null);
  assertEquals(f.sends, 0);
});
