// deno-lint-ignore-file require-await no-import-prefix
// Test doubles implement async provider contracts; repo uses existing URL imports.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  automatedMail,
  captureGroup,
  captureUser,
  type Cursor,
  GRAPH,
  GraphFailure,
  initialDelta,
  type Mail,
  mailIdentity,
  previewText,
  storeBytes,
  type Stream,
} from "./mail_capture.ts";
import { persistMail } from "./mail_persistence.ts";
const stream: Stream = {
  key: "sample:inbox",
  mailbox: "sample@example.test",
  kind: "user",
  folder: "inbox",
  captureFrom: "2026-09-11T00:00:00Z",
};
const message = {
  id: "m1",
  internetMessageId: "<message@example.test>",
  body: { content: "Please use blue", contentType: "text" },
  receivedDateTime: "2026-09-11T01:00:00Z",
  from: { emailAddress: { address: "customer@example.test" } },
};
Deno.test("user delta follows nextLink exactly and completes only on deltaLink", async () => {
  const requests: string[] = [],
    writes: string[] = [],
    saved: { state: Cursor; complete: boolean }[] = [];
  const next =
      `${GRAPH}/users/sample/mailFolders/inbox/messages/delta?$skiptoken=opaque`,
    delta =
      `${GRAPH}/users/sample/mailFolders/inbox/messages/delta?$deltatoken=done`;
  const result = await captureUser(stream, {}, {
    get: async (url) => {
      requests.push(url);
      return requests.length === 1
        ? { value: [message], "@odata.nextLink": next }
        : { value: [{ ...message, id: "m2" }], "@odata.deltaLink": delta };
    },
    persist: async (m) => {
      writes.push(m.id);
    },
    checkpoint: async (state, complete) => {
      saved.push({ state, complete });
    },
    now: () => stream.captureFrom,
  });
  assertEquals(requests[1], next);
  assertEquals(writes, ["m1", "m2"]);
  assertEquals(saved.map((s) => s.complete), [false, true]);
  assertEquals(saved[1].state.delta, delta);
  assert(result.complete);
});
Deno.test("storage failure leaves same page for replay; page retry converges", async () => {
  let cursor: Cursor = {}, fail = true;
  const events = new Set<string>();
  const deps = {
    get: async () => ({
      value: [message, { ...message, id: "m2" }],
      "@odata.deltaLink": `${GRAPH}/delta-end`,
    }),
    persist: async (m: Mail) => {
      if (m.id === "m2" && fail) throw new Error("storage");
      events.add(m.id);
    },
    checkpoint: async (s: Cursor) => {
      cursor = s;
    },
    now: () => stream.captureFrom,
  };
  await assertRejects(() => captureUser(stream, cursor, deps));
  assertEquals(cursor, {});
  fail = false;
  await captureUser(stream, cursor, deps);
  assertEquals([...events], ["m1", "m2"]);
  assertEquals(cursor.delta, `${GRAPH}/delta-end`);
});
Deno.test("bounded page pass resumes durable nextLink without overwriting delta", async () => {
  let cursor: Cursor = { delta: `${GRAPH}/old` };
  const next = `${GRAPH}/next`;
  const result = await captureUser(stream, cursor, {
    get: async () => ({ value: [], "@odata.nextLink": next }),
    persist: async () => {},
    checkpoint: async (s) => {
      cursor = s;
    },
    now: () => stream.captureFrom,
  }, 1);
  assertEquals(result.complete, false);
  assertEquals(cursor.next, next);
  assertEquals(cursor.delta, `${GRAPH}/old`);
});
Deno.test("410 clears stale token for replay from original boundary, not current time", async () => {
  let saved: Cursor = {};
  await assertRejects(() =>
    captureUser(stream, { delta: `${GRAPH}/expired` }, {
      get: async () => {
        throw new GraphFailure(410);
      },
      persist: async () => {},
      checkpoint: async (s) => {
        saved = s;
      },
      now: () => stream.captureFrom,
    })
  );
  assertEquals(saved, { resetCount: 1 });
  assert(!initialDelta(stream).includes("%24filter"));
});
Deno.test("missing terminal delta or off-origin nextLink never checkpoints", async () => {
  for (
    const page of [{ value: [] }, {
      value: [],
      "@odata.nextLink": "https://attacker.example/steal",
    }]
  ) {
    let saved = false;
    await assertRejects(() =>
      captureUser(stream, {}, {
        get: async () => page,
        persist: async () => {},
        checkpoint: async () => {
          saved = true;
        },
        now: () => stream.captureFrom,
      })
    );
    assertEquals(saved, false);
  }
});
Deno.test("provider deletions retain evidence and advance collection cursor", async () => {
  let persisted = 0;
  await captureUser(stream, {}, {
    get: async () => ({
      value: [{ id: "gone", "@removed": { reason: "deleted" } }],
      "@odata.deltaLink": `${GRAPH}/done`,
    }),
    persist: async () => {
      persisted++;
    },
    checkpoint: async () => {},
    now: () => stream.captureFrom,
  });
  assertEquals(persisted, 0);
});
Deno.test("group traversal checkpoints posts and remaining thread pages; no folder delta", async () => {
  const group: Stream = { ...stream, kind: "group", folder: "conversations" },
    requests: string[] = [],
    writes: string[] = [];
  let cursor: Cursor = { groupId: "g1" };
  const deps = {
    get: async (url: string) => {
      requests.push(url);
      if (url.includes("/posts")) return { value: [message] };
      return {
        value: [{
          id: "t1",
          topic: "Fence",
          lastDeliveredDateTime: stream.captureFrom,
        }],
        "@odata.nextLink": `${GRAPH}/next-threads`,
      };
    },
    persist: async (m: Mail) => {
      writes.push(m.id);
    },
    checkpoint: async (s: Cursor) => {
      cursor = s;
    },
    now: () => stream.captureFrom,
  };
  const first = await captureGroup(group, cursor, deps, 1);
  assertEquals(first.complete, false);
  assertEquals(cursor.tasks?.[0].kind, "posts");
  await captureGroup(group, cursor, deps, 1);
  assertEquals(writes, ["m1"]);
  assertEquals(cursor.tasks?.[0].url, `${GRAPH}/next-threads`);
  assert(
    requests.every((u) => !u.includes("/users/") && !u.includes("/delta")),
  );
  assertEquals(cursor.highWater, undefined);
});
Deno.test("group failed post page does not advance high-water", async () => {
  const cursor: Cursor = {
    groupId: "g1",
    highWater: "2026-09-10T00:00:00Z",
    tasks: [{ kind: "posts", threadId: "t1", url: `${GRAPH}/posts` }],
  };
  let saved = false;
  await assertRejects(() =>
    captureGroup(
      { ...stream, kind: "group", folder: "conversations" },
      cursor,
      {
        get: async () => ({ value: [message] }),
        persist: async () => {
          throw new Error("storage");
        },
        checkpoint: async () => {
          saved = true;
        },
        now: () => stream.captureFrom,
      },
    )
  );
  assertEquals(saved, false);
});
Deno.test("preview strips quoted trail/signature and limits UTF8 to4KB", () => {
  assertEquals(
    previewText("<div>Keep blue</div><blockquote>Old red</blockquote>", true),
    "Keep blue",
  );
  assertEquals(previewText("Keep blue\nRegards,\nSample Person"), "Keep blue");
  assertEquals(
    previewText("Keep blue\nOn Monday Sample wrote:\nOld red"),
    "Keep blue",
  );
  assert(
    new TextEncoder().encode(previewText("🟦".repeat(5000))).length <= 4096,
  );
});
Deno.test("automated rules distinguish list/OOO from a real customer reply", () => {
  assert(automatedMail({ ...message, subject: "Automatic reply: away" }));
  assert(
    automatedMail({
      ...message,
      internetMessageHeaders: [{ name: "List-Unsubscribe", value: "x" }],
    }),
  );
  assertEquals(automatedMail(message), false);
});
Deno.test("internet message identity dedupes across mailboxes; fallback states transport scope", () => {
  assertEquals(
    mailIdentity(message, stream),
    mailIdentity(message, { ...stream, mailbox: "other@example.test" }),
  );
  assert(
    mailIdentity({ ...message, internetMessageId: undefined }, {
      ...stream,
      kind: "group",
    }).startsWith("graph-group:"),
  );
});
Deno.test("private storage hash covers actual bytes and failed writes throw", async () => {
  const bytes = new TextEncoder().encode("body"), saved: Uint8Array[] = [];
  const file = await storeBytes(
    {
      upload: async (_path, body) => {
        saved.push(body);
      },
    },
    bytes,
    "body",
    "text/plain",
  );
  assertEquals(saved[0], bytes);
  assert(file.pointer.startsWith("context-mail-evidence://sha256/"));
  assertEquals(file.hash.length, 64);
  await assertRejects(() =>
    storeBytes(
      {
        upload: async () => {
          throw new Error("storage");
        },
      },
      bytes,
      "body",
      "text/plain",
    )
  );
});
// Minimal PostgREST-shaped mock with real error return semantics, no live credentials.
function persistenceFake(
  options: {
    duplicate?: boolean;
    storageFail?: boolean;
    bridgeFail?: boolean;
    publicBucket?: boolean;
    captureDisabled?: boolean;
  } = {},
) {
  const rows: Record<string, unknown>[] = [],
    files: Uint8Array[] = [],
    observations: Record<string, unknown>[] = [];
  const event = { id: "event1", job_id: null, contact_id: null };
  const sb = {
    rpc: async () => ({ data: !options.captureDisabled, error: null }),
    storage: {
      getBucket: async () => ({
        data: { public: !!options.publicBucket },
        error: null,
      }),
      from: () => ({
        upload: async (_path: string, bytes: Uint8Array) => {
          files.push(bytes);
          return { error: options.storageFail ? { message: "fail" } : null };
        },
      }),
    },
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        rows.push(row);
        return {
          select: () => ({
            single: async () => ({
              data: options.duplicate ? null : event,
              error: options.duplicate ? { code: "23505" } : null,
            }),
          }),
        };
      },
      select: () => ({
        eq: () => ({ single: async () => ({ data: event, error: null }) }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        observations.push({ table, ...row });
        return {
          error: table === "inbox_events" && options.bridgeFail
            ? { message: "fail" }
            : null,
        };
      },
    }),
  };
  return { sb, rows, files, observations };
}
Deno.test("persistence keeps full private body and all paginated attachments before evidence", async () => {
  const fake = persistenceFake(), requested: string[] = [];
  await persistMail(
    fake.sb,
    async (url) => {
      requested.push(url);
      return requested.length === 1
        ? {
          value: [{ name: "one", contentBytes: btoa("one") }],
          "@odata.nextLink": `${GRAPH}/attachments2`,
        }
        : { value: [{ name: "two", contentBytes: btoa("two") }] };
    },
    { ...message, hasAttachments: true },
    stream,
    `${GRAPH}/message`,
  );
  assertEquals(fake.files.length, 3);
  assertEquals(
    (fake.rows[0].payload as { attachments: unknown[] }).attachments.length,
    2,
  );
  assertEquals(
    fake.rows[0].provider_message_id,
    "email:<message@example.test>",
  );
  assertEquals(requested[1], `${GRAPH}/attachments2`);
});
Deno.test("persistence duplicate still records second mailbox observation/inbox", async () => {
  const fake = persistenceFake({ duplicate: true });
  await persistMail(
    fake.sb,
    async () => ({}),
    message,
    stream,
    `${GRAPH}/message`,
  );
  assertEquals(fake.observations.length, 2);
});
Deno.test("private bucket, storage and inbox failures all stop checkpoint eligibility", async () => {
  for (
    const options of [{ publicBucket: true }, { storageFail: true }, {
      bridgeFail: true,
    }]
  ) {
    const fake = persistenceFake(options);
    await assertRejects(() =>
      persistMail(
        fake.sb,
        async () => ({}),
        message,
        stream,
        `${GRAPH}/message`,
      )
    );
  }
});
Deno.test("sent items are outbound and never inserted into inbound ops inbox", async () => {
  const fake = persistenceFake();
  await persistMail(
    fake.sb,
    async () => ({}),
    { ...message, sentDateTime: message.receivedDateTime },
    { ...stream, folder: "sentitems" },
    `${GRAPH}/message`,
  );
  assertEquals(fake.rows[0].direction, "outbound");
  assertEquals(fake.observations.length, 1);
});

Deno.test("mailbox errors and unavailable accounts remain visible while other streams continue", async () => {
  const { runMailStreams } = await import("./mail_run.ts");
  const captured: string[] = [];
  const sb = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "claim_context_mail_stream") {
        return {
          data: {
            outcome: "claimed",
            stream: {
              lease_token: "lease",
              state: {},
              mailbox: String(args.p_stream_key),
              kind: "user",
              folder: "inbox",
              capture_from: stream.captureFrom,
            },
          },
          error: null,
        };
      }
      if (args.p_error) throw new Error("error receipt transport unavailable");
      return { data: true, error: null };
    },
  };
  const coverage = await runMailStreams(sb, async (url) => {
    if (url.includes("broken")) throw new GraphFailure(403);
    return { value: [message], "@odata.deltaLink": `${GRAPH}/done` };
  }, [
    { stream_key: "broken", enabled: true },
    { stream_key: "healthy", enabled: true },
    {
      stream_key: "khairo",
      enabled: false,
      unavailable_reason: "mailbox_not_provisioned",
    },
  ], async (_mail, source) => {
    captured.push(source.key);
  });
  assertEquals(coverage.map((r) => r.status), [
    "error",
    "complete",
    "unavailable",
  ]);
  assertEquals(captured, ["healthy"]);
  assertEquals(coverage[0].error_recorded, false);
});
Deno.test("group expired continuation restarts prior high-water scan without skipping", async () => {
  let saved: Cursor = {};
  const before: Cursor = {
    groupId: "g1",
    highWater: "2026-09-10T00:00:00Z",
    tasks: [{ kind: "posts", threadId: "t1", url: `${GRAPH}/expired` }],
  };
  await assertRejects(() =>
    captureGroup(
      { ...stream, kind: "group", folder: "conversations" },
      before,
      {
        get: async () => {
          throw new GraphFailure(410);
        },
        persist: async () => {},
        checkpoint: async (state) => {
          saved = state;
        },
        now: () => stream.captureFrom,
      },
    )
  );
  assertEquals(saved.tasks, []);
  assertEquals(saved.highWater, before.highWater);
  assertEquals(saved.resetCount, 1);
});

Deno.test("initial delta scans old metadata without historical evidence backfill or5000 filter cap", async () => {
  const ids: string[] = [];
  await captureUser(stream, {}, {
    get: async () => ({
      value: [{
        ...message,
        id: "old",
        receivedDateTime: "2025-01-01T00:00:00Z",
      }, message],
      "@odata.deltaLink": `${GRAPH}/done`,
    }),
    persist: async (m) => {
      ids.push(m.id);
    },
    checkpoint: async () => {},
    now: () => stream.captureFrom,
  });
  assertEquals(ids, ["m1"]);
  assert(!new URL(initialDelta(stream)).searchParams.has("$filter"));
});

Deno.test("paid eligibility snapshot preserves only unread recent predecessor user mailboxes", async () => {
  const recent = new Date().toISOString();
  const cases = [
    {
      isRead: false,
      mailbox: "marnin@secureworkswa.com.au",
      at: recent,
      expected: true,
    },
    {
      isRead: true,
      mailbox: "marnin@secureworkswa.com.au",
      at: recent,
      expected: false,
    },
    {
      isRead: undefined,
      mailbox: "marnin@secureworkswa.com.au",
      at: recent,
      expected: false,
    },
    {
      isRead: false,
      mailbox: "marnin@secureworkswa.com.au",
      at: "2020-01-01T00:00:00Z",
      expected: false,
    },
    {
      isRead: false,
      mailbox: "orders@secureworkswa.com.au",
      at: recent,
      expected: false,
    },
    {
      isRead: false,
      mailbox: "ses@secureworkswa.com.au",
      at: recent,
      expected: false,
    },
  ];
  for (const c of cases) {
    const fake = persistenceFake();
    await persistMail(
      fake.sb,
      async () => ({}),
      {
        ...message,
        hasAttachments: false,
        isRead: c.isRead,
        receivedDateTime: c.at,
        bodyPreview: "x".repeat(600),
      },
      { ...stream, mailbox: c.mailbox },
      "https://graph.microsoft.com/v1.0/message",
    );
    const inbox = fake.observations.find((r) => r.table === "inbox_events")!;
    const metadata = inbox.metadata as Record<string, unknown>;
    assertEquals(metadata.legacy_classifier_eligible, c.expected);
    assertEquals((metadata.legacy_body_preview as string).length, 500);
    assertEquals(fake.rows.length, 1); // Even read/old/new-mailbox messages keep canonical evidence.
  }
});

Deno.test("disabled capture refuses mailbox persistence before provider or storage work", async () => {
  const fake = persistenceFake({ captureDisabled: true });
  let providerReads = 0;
  await assertRejects(
    () =>
      persistMail(
        fake.sb,
        async () => {
          providerReads++;
          return {};
        },
        message,
        stream,
        "https://graph.microsoft.com/v1.0/message",
      ),
    Error,
    "capture disabled",
  );
  assertEquals(providerReads, 0);
  assertEquals(fake.files.length, 0);
  assertEquals(fake.rows.length, 0);
  assertEquals(fake.observations.length, 0);
});
