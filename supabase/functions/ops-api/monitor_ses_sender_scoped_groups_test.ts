// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// Sender-scoped intake Groups (monitor-ses-makesafes): builder mail addressed to
// a general company Group (swwa@) instead of ses@.
//
// Proved here, with no network:
//   - a builder's post is stored as ses@ intake mail, with its real origin kept;
//   - general mail is never stored and its body is never requested;
//   - only a sender pattern of a company the Group lists admits a post (no
//     subject or floor match, and no other active builder);
//   - the Group keeps its own cursor, starts at its first-read date on its
//     first read, and catches up in bounded slices that always advance and
//     never leave an older builder post behind;
//   - a Group that cannot be read, or is throttled, is reported and never
//     breaks or stalls the ses@ poll.
//
// Every sender, subject and address below is invented in the Ambrose shape.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _collectSenderScopedGroupPosts,
  _ingestSenderScopedGroups,
} from "../monitor-ses-makesafes/index.ts";

const SES = "ses@secureworkswa.com.au";
const SWWA = "swwa@secureworkswa.com.au";
const GROUP = "group-swwa";
const BUILDER = "orders@ambrose.test";
const OTHER_BUILDER = "workorders@otherbuilder.test";
const NOW_MS = Date.parse("2026-10-12T02:00:00.000Z");
const FIRST_READ_FROM = "2026-10-01T00:00:00.000Z";
const LOADED = {
  patterns: [{
    slug: "acg",
    name: "Ambrose Construct Group",
    pattern: "ambrose.test",
  }, {
    slug: "mlb",
    name: "Another Active Builder",
    pattern: "otherbuilder.test",
  }],
  refPrefixes: ["MLB", "AJBR", "MS"],
};

// ── In-memory Supabase double: just the query shapes the monitor uses. ───────
function memorySb(opts: { failTable?: string } = {}) {
  const tables: Record<string, any[]> = {};
  function from(table: string) {
    const filters: Array<(row: any) => boolean> = [];
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: any = null;
    let conflict = "";
    let result: { data: any[]; error: any } | null = null;
    const run = () => {
      if (result) return result;
      if (opts.failTable === table) {
        return (result = { data: [], error: { message: `${table} is down` } });
      }
      const rows = (tables[table] ||= []);
      if (op === "select") {
        result = {
          data: rows.filter((row) => filters.every((f) => f(row))),
          error: null,
        };
      } else if (op === "insert") {
        const row = { id: `${table}-${rows.length + 1}`, ...payload };
        rows.push(row);
        result = { data: [row], error: null };
      } else if (op === "upsert") {
        const keys = conflict.split(",").map((k) => k.trim()).filter(Boolean);
        const existing = rows.find((row) =>
          keys.every((k) => row[k] === payload[k])
        );
        const defined = Object.fromEntries(
          Object.entries(payload).filter(([, v]) => v !== undefined),
        );
        if (existing) Object.assign(existing, defined);
        else rows.push({ id: `${table}-${rows.length + 1}`, ...defined });
        result = { data: [], error: null };
      } else if (op === "update") {
        for (const row of rows.filter((r) => filters.every((f) => f(r)))) {
          Object.assign(row, payload);
        }
        result = { data: [], error: null };
      } else {
        tables[table] = rows.filter((r) => !filters.every((f) => f(r)));
        result = { data: [], error: null };
      }
      return result;
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => (
        filters.push((r) => r[c] === v), b
      ),
      gte: (c: string, v: string) => (
        filters.push((r) => String(r[c] ?? "") >= v), b
      ),
      order: () => b,
      in: (c: string, vs: unknown[]) => (
        filters.push((r) => vs.includes(r[c])), b
      ),
      ilike: (c: string, v: string) => (
        filters.push((r) =>
          String(r[c] ?? "").toLowerCase() === v.toLowerCase()
        ), b
      ),
      limit: () => b,
      maybeSingle: () => {
        const r = run();
        return Promise.resolve({ data: r.data[0] ?? null, error: r.error });
      },
      single: () => {
        const r = run();
        return Promise.resolve({ data: r.data[0] ?? null, error: r.error });
      },
      insert: (row: any) => (op = "insert", payload = row, b),
      upsert: (row: any, o?: { onConflict?: string }) => (
        op = "upsert", payload = row, conflict = o?.onConflict || "", b
      ),
      update: (row: any) => (op = "update", payload = row, b),
      delete: () => (op = "delete", b),
      then: (resolve: (v: any) => any, reject?: (e: any) => any) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return b;
  }
  const sb = {
    from,
    rpc: (name: string) =>
      Promise.resolve({
        data: name === "automation_lane_enabled" ? true : null,
        error: null,
      }),
  };
  return { sb, tables };
}

// ── Graph double for one Group. ──────────────────────────────────────────────
interface FakePost {
  id: string;
  from: string;
  receivedDateTime: string;
  body: string;
  hasAttachments?: boolean;
}
interface FakeConversation {
  id: string;
  lastDeliveredDateTime: string;
  topic: string;
  posts: FakePost[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function graphDouble(
  conversations: FakeConversation[],
  opts: { resolveStatus?: number; throttleRetryAfterSeconds?: number } = {},
) {
  const calls: string[] = [];
  const bodyFetches: string[] = [];
  const newestFirst = () =>
    [...conversations].sort((a, b) =>
      b.lastDeliveredDateTime.localeCompare(a.lastDeliveredDateTime)
    );
  const fetchStub = (input: string) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/groups?$filter=")) {
      if (opts.resolveStatus) {
        return Promise.resolve(
          json({ error: { code: "Authorization_RequestDenied" } }, 403),
        );
      }
      assert(
        url.includes(encodeURIComponent(`mail eq '${SWWA}'`)),
        "the scoped Group is resolved by its own address",
      );
      return Promise.resolve(json({ value: [{ id: GROUP }] }));
    }
    assert(url.includes(`/groups/${GROUP}/`), `wrong group in ${url}`);
    if (url.includes("/conversations?")) {
      if (opts.throttleRetryAfterSeconds) {
        return Promise.resolve(
          new Response("throttled", {
            status: 429,
            headers: { "Retry-After": String(opts.throttleRetryAfterSeconds) },
          }),
        );
      }
      return Promise.resolve(json({
        value: newestFirst().map((c) => ({
          id: c.id,
          lastDeliveredDateTime: c.lastDeliveredDateTime,
        })),
      }));
    }
    const conv = conversations.find((c) =>
      url.includes(`/conversations/${c.id}/threads`)
    );
    if (conv) {
      return Promise.resolve(json({
        value: [{ id: `thread-${conv.id}`, topic: conv.topic }],
      }));
    }
    for (const c of conversations) {
      const base = `/threads/thread-${c.id}/posts`;
      if (url.includes(`${base}?`)) {
        assert(
          !/\$select=[^&]*\bbody\b/.test(url),
          "the post listing must not request any body",
        );
        return Promise.resolve(json({
          value: c.posts.map((p) => ({
            id: p.id,
            receivedDateTime: p.receivedDateTime,
            from: { emailAddress: { address: p.from } },
            hasAttachments: p.hasAttachments || false,
            conversationId: c.id,
            conversationThreadId: `thread-${c.id}`,
          })),
        }));
      }
      const post = c.posts.find((p) => url.includes(`${base}/${p.id}`));
      if (post) {
        if (url.includes("$expand=attachments")) {
          return Promise.resolve(json({
            id: post.id,
            attachments: [{
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: `att-${post.id}`,
              name: "logo.png",
              contentType: "image/png",
              isInline: true,
            }],
          }));
        }
        bodyFetches.push(post.id);
        return Promise.resolve(json({
          id: post.id,
          body: { contentType: "text", content: post.body },
        }));
      }
    }
    throw new Error("unexpected url " + url);
  };
  return { fetchStub, calls, bodyFetches };
}

async function withGraph<T>(
  double: ReturnType<typeof graphDouble>,
  run: () => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = double.fetchStub;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function purchaseOrder(
  id: string,
  receivedDateTime: string,
  po = "20999101-02",
): FakeConversation {
  return {
    id,
    lastDeliveredDateTime: receivedDateTime,
    topic:
      `Ambrose Construct Group Purchase Order Make Safe: ${po} -  12 Example Street Testville WA 6000  is attached`,
    posts: [{
      id: `post-${id}`,
      from: BUILDER,
      receivedDateTime,
      body: `Please see attached PO #${po} regarding Make Safe required.`,
    }],
  };
}

function ingest(sb: any, extra: Record<string, unknown> = {}) {
  const handoff = { sources: [] as any[], pdfCoordinates: [] as any[] };
  return _ingestSenderScopedGroups(sb, "tok", LOADED, handoff, {
    groups: [{
      mail: SWWA,
      firstReadFrom: FIRST_READ_FROM,
      companySlugs: ["acg"],
    }],
    nowMs: NOW_MS,
    ...extra,
  }).then((out) => ({ ...out, handoff }));
}

Deno.test("a builder post in the general Group is stored as ses@ intake mail; general mail is never stored and its body never fetched", async () => {
  const general: FakeConversation = {
    id: "conv-general",
    lastDeliveredDateTime: "2026-10-09T01:00:00Z",
    topic: "Quote request for a new patio",
    posts: [{
      id: "post-general",
      from: "member.of.public@customer.test",
      receivedDateTime: "2026-10-09T01:00:00Z",
      body: "My phone number is 0400 000 000.",
    }],
  };
  const double = graphDouble([
    purchaseOrder("po", "2026-10-08T06:31:00Z"),
    general,
  ]);
  const { sb, tables } = memorySb();
  const out = await withGraph(double, () => ingest(sb));

  assertEquals(out.reports[0].ok, true);
  assertEquals(out.reports[0].included, 1);
  assertEquals(out.reports[0].out_of_scope, 1);

  // Stored exactly as ses@ intake mail, so every downstream reader sees it.
  assertEquals(tables.emails.length, 1);
  assertEquals(tables.emails[0].post_id, "post-po");
  assertEquals(tables.emails[0].mailbox, SES);
  assertEquals(tables.emails[0].from_email, BUILDER);
  assertEquals(tables.emails[0].received_at, "2026-10-08T06:31:00Z");
  assert(tables.emails[0].subject.includes("20999101-02"));
  assert(tables.emails[0].body_content.includes("PO #20999101-02"));
  assertEquals(tables.emails[0].attachments_settled, true);
  // Its real origin stays on the audit row.
  assertEquals(tables.email_events_raw.length, 1);
  assertEquals(tables.email_events_raw[0].mailbox, SES);
  assertEquals(tables.email_events_raw[0].page_meta, {
    source_mailbox: SWWA,
  });
  // Handed to the intake scan like any ses@ source.
  assertEquals(out.handoff.sources.map((s: any) => s.postId), ["post-po"]);

  // The member of the public: no row in any table, and no body request.
  assertEquals(double.bodyFetches, ["post-po"]);
  assertEquals(tables.email_classifier_exclusions, undefined);
  for (const [table, rows] of Object.entries(tables)) {
    assert(
      !JSON.stringify(rows).includes("customer.test") &&
        !JSON.stringify(rows).includes("post-general") &&
        !JSON.stringify(rows).includes("patio"),
      `general mail leaked into ${table}`,
    );
  }
});

Deno.test("only a company sender pattern admits a post: a work-order subject or the Prime floor does not", async () => {
  const lookalike: FakeConversation = {
    id: "conv-subject",
    lastDeliveredDateTime: "2026-10-09T02:00:00Z",
    topic: "NEW WORK ORDER - MLB-26109 make safe required",
    posts: [{
      id: "post-subject",
      from: "someone@notambrose.test",
      receivedDateTime: "2026-10-09T02:00:00Z",
      body: "Work order MLB-26109",
    }, {
      id: "post-floor",
      from: "noreply@notifications.primeeco.tech",
      receivedDateTime: "2026-10-09T02:05:00Z",
      body: "Work order MLB-26109",
    }],
  };
  const double = graphDouble([lookalike]);
  const { sb, tables } = memorySb();
  const out = await withGraph(double, () => ingest(sb));
  assertEquals(out.reports[0].included, 0);
  assertEquals(out.reports[0].out_of_scope, 2);
  assertEquals(double.bodyFetches, []);
  assertEquals(tables.emails, undefined);
  assertEquals(tables.email_events_raw, undefined);
});

Deno.test("another active builder's mail in the general Group is ignored: only the companies the Group lists are admitted", async () => {
  const other: FakeConversation = {
    id: "conv-other-builder",
    lastDeliveredDateTime: "2026-10-09T04:00:00Z",
    topic: "NEW WORK ORDER - MLB-26109 make safe required",
    posts: [{
      id: "post-other-builder",
      from: OTHER_BUILDER,
      receivedDateTime: "2026-10-09T04:00:00Z",
      body: "Work order MLB-26109 attached.",
    }],
  };
  const double = graphDouble([
    purchaseOrder("po", "2026-10-08T06:31:00Z"),
    other,
  ]);
  const { sb, tables } = memorySb();
  const out = await withGraph(double, () => ingest(sb));

  assertEquals(out.reports[0].ok, true);
  assertEquals(out.reports[0].included, 1);
  assertEquals(out.reports[0].out_of_scope, 1);
  assertEquals(double.bodyFetches, ["post-po"]);
  assertEquals(tables.emails.map((e) => e.post_id), ["post-po"]);
  assertEquals(out.handoff.sources.map((s: any) => s.postId), ["post-po"]);
  for (const [table, rows] of Object.entries(tables)) {
    assert(
      !JSON.stringify(rows).includes("otherbuilder.test") &&
        !JSON.stringify(rows).includes("post-other-builder"),
      `another builder's mail leaked into ${table}`,
    );
  }

  // The same builder IS admitted once the Group lists its company.
  const widened = memorySb();
  const wide = await withGraph(double, () =>
    ingest(widened.sb, {
      groups: [{
        mail: SWWA,
        firstReadFrom: FIRST_READ_FROM,
        companySlugs: ["acg", "mlb"],
      }],
    }));
  assertEquals(wide.reports[0].included, 2);
});

Deno.test("the first read starts at the Group's first-read date, so builder mail sent before this lane existed is picked up", async () => {
  const double = graphDouble([
    purchaseOrder("four-days-old", "2026-10-08T06:10:00Z"),
    purchaseOrder("before-first-read", "2026-09-20T00:00:00Z", "20999000-01"),
  ]);
  const { sb, tables } = memorySb();
  // The ses@ cursor already sits past this mail: sharing it would skip the PO.
  tables.mail_sync_cursors = [{
    mailbox: SES,
    last_completed_max: "2026-10-12T01:55:00.000Z",
    overlap_seconds: 900,
  }];
  const out = await withGraph(double, () => ingest(sb));

  assertEquals(out.reports[0].included, 1);
  assertEquals(tables.emails.map((e) => e.post_id), ["post-four-days-old"]);
  // Mail from before the first-read date was never opened.
  assert(
    !double.calls.some((c) => c.includes("/conversations/before-first-read/")),
  );
  // The Group has its own cursor; the ses@ cursor is untouched.
  const cursors = Object.fromEntries(
    tables.mail_sync_cursors.map((c) => [c.mailbox, c.last_completed_max]),
  );
  assertEquals(cursors[SES], "2026-10-12T01:55:00.000Z");
  assertEquals(cursors[SWWA], "2026-10-08T06:10:00.000Z");
  assertEquals(out.reports[0].cursor, "2026-10-08T06:10:00.000Z");
  assertEquals(tables.sync_state[0].mailbox, SWWA);
  assertEquals(tables.sync_state[0].mode, "OK");
});

Deno.test("a first read long after the first-read date reaches back no further than the 60-day scan window", async () => {
  const lateNow = Date.parse("2027-03-01T00:00:00.000Z");
  const double = graphDouble([
    purchaseOrder("inside", "2027-02-01T00:00:00Z"),
    // After the first-read date, but too old for the scan to plan.
    purchaseOrder("outside", "2026-12-01T00:00:00Z", "20999000-01"),
  ]);
  const { sb, tables } = memorySb();
  await withGraph(double, () => ingest(sb, { nowMs: lateNow }));
  assertEquals(tables.emails.map((e) => e.post_id), ["post-inside"]);
  assert(!double.calls.some((c) => c.includes("/conversations/outside/")));
});

Deno.test("catch-up runs in bounded slices, oldest first, and every poll advances until nothing is left", async () => {
  const days = ["03", "04", "05", "06", "07"];
  const double = graphDouble(
    days.map((d, i) =>
      purchaseOrder(`c${d}`, `2026-10-${d}T03:00:00Z`, `2099910${i}-01`)
    ),
  );
  const { sb, tables } = memorySb();
  const run = () =>
    withGraph(double, () => ingest(sb, { maxNewConversations: 2 }));

  const first = await run();
  assertEquals(first.reports[0].catch_up_pending, true);
  assertEquals(first.reports[0].included, 2);
  assertEquals(first.reports[0].cursor, "2026-10-04T03:00:00.000Z");
  assertEquals(tables.emails.map((e) => e.post_id), ["post-c03", "post-c04"]);

  const second = await run();
  assertEquals(second.reports[0].catch_up_pending, true);
  assertEquals(second.reports[0].cursor, "2026-10-06T03:00:00.000Z");

  const third = await run();
  assertEquals(third.reports[0].catch_up_pending, false);
  assertEquals(third.reports[0].cursor, "2026-10-07T03:00:00.000Z");

  // Every purchase order stored once, however many polls re-read its window.
  assertEquals(
    tables.emails.map((e) => e.post_id).sort(),
    days.map((d) => `post-c${d}`),
  );
  assertEquals(tables.email_events_raw.length, 5);

  const settled = await run();
  assertEquals(settled.reports[0].catch_up_pending, false);
  assertEquals(settled.reports[0].cursor, "2026-10-07T03:00:00.000Z");
  assertEquals(tables.emails.length, 5);
  assertEquals(tables.email_events_raw.length, 5);
});

Deno.test("catch-up never drops an older builder post in a conversation that later got another post", async () => {
  // The purchase order arrived 8 Oct; an Acceptance Required email in the same
  // conversation on 10 Oct moves the whole conversation behind later slices.
  const thread: FakeConversation = {
    id: "po-thread",
    lastDeliveredDateTime: "2026-10-10T05:00:00Z",
    topic:
      "Ambrose Construct Group Purchase Order Make Safe: 20999555-01 -  12 Example Street Testville WA 6000  is attached",
    posts: [{
      id: "post-po-old",
      from: BUILDER,
      receivedDateTime: "2026-10-08T06:10:00Z",
      body: "Please see attached PO #20999555-01 regarding Make Safe required.",
    }, {
      id: "post-acceptance",
      from: BUILDER,
      receivedDateTime: "2026-10-10T05:00:00Z",
      body: "Acceptance Required for PO #20999555-01.",
    }],
  };
  const general = (id: string, at: string): FakeConversation => ({
    id,
    lastDeliveredDateTime: at,
    topic: "General enquiry",
    posts: [{
      id: `post-${id}`,
      from: "member.of.public@customer.test",
      receivedDateTime: at,
      body: "Hello",
    }],
  });
  const double = graphDouble([
    general("g1", "2026-10-03T03:00:00Z"),
    general("g2", "2026-10-06T03:00:00Z"),
    // Read in the slice before the PO thread: the cursor is now past 8 Oct.
    general("g3", "2026-10-09T22:00:00Z"),
    thread,
  ]);
  const { sb, tables } = memorySb();
  let polls = 0;
  for (;;) {
    const out = await withGraph(
      double,
      () => ingest(sb, { maxNewConversations: 1 }),
    );
    assertEquals(out.reports[0].error, null);
    polls++;
    if (!out.reports[0].catch_up_pending) break;
    assert(polls < 10, "catch-up did not finish");
  }
  assertEquals(polls, 4);
  assertEquals(
    tables.emails.map((e) => e.post_id).sort(),
    ["post-acceptance", "post-po-old"],
  );
  assertEquals(
    tables.emails.find((e) => e.post_id === "post-po-old").received_at,
    "2026-10-08T06:10:00Z",
  );
});

Deno.test("a slice boundary never skips a conversation that shares the boundary time", async () => {
  // Three conversations delivered in the same second, bound of two per poll.
  const double = graphDouble(
    ["a", "b", "c"].map((id, i) =>
      purchaseOrder(`same-${id}`, "2026-10-05T03:00:00Z", `2099920${i}-01`)
    ),
  );
  const { sb, tables } = memorySb();
  const run = () =>
    withGraph(double, () => ingest(sb, { maxNewConversations: 2 }));
  await run();
  assertEquals(tables.emails.length, 2);
  // The third sits AT the cursor, inside the overlap re-read, so it is taken.
  const second = await run();
  assertEquals(second.reports[0].catch_up_pending, false);
  assertEquals(tables.emails.length, 3);
});

Deno.test("a builder post's attachments are fetched from the Group it arrived at", async () => {
  const withPdf = purchaseOrder("att", "2026-10-08T06:10:00Z");
  withPdf.posts[0].hasAttachments = true;
  const double = graphDouble([withPdf]);
  const { sb, tables } = memorySb();
  const out = await withGraph(double, () => ingest(sb));
  assertEquals(out.reports[0].error, null);
  assert(
    double.calls.some((c) =>
      c.includes(
        `/groups/${GROUP}/threads/thread-att/posts/post-att?$expand=attachments`,
      )
    ),
  );
  assertEquals(tables.email_attachments.length, 1);
  assertEquals(tables.email_attachments[0].email_id, "post-att");
});

Deno.test("a Group that cannot be read is reported once and never throws into the ses@ poll", async () => {
  const double = graphDouble([], { resolveStatus: 403 });
  const { sb, tables } = memorySb();
  const first = await withGraph(double, () => ingest(sb));
  assertEquals(first.reports[0].ok, false);
  assert(first.reports[0].error?.includes("Group resolution failed 403"));
  assertEquals(first.handoff.sources, []);
  assertEquals(tables.mail_sync_cursors ?? [], []);
  assertEquals(tables.sync_state[0].mode, "ERROR");
  assertEquals(tables.business_events.length, 1);
  assertEquals(tables.business_events[0].entity_id, SWWA);

  // Still failing two minutes later: state stays ERROR, no second alarm.
  await withGraph(double, () => ingest(sb));
  assertEquals(tables.business_events.length, 1);
});

Deno.test("an outage alarm that could not be written is raised again on the next poll, then only once", async () => {
  const double = graphDouble([], { resolveStatus: 403 });
  const fault: { failTable?: string } = { failTable: "business_events" };
  const { sb, tables } = memorySb(fault);
  const first = await withGraph(double, () => ingest(sb));
  assertEquals(first.reports[0].ok, false);
  assertEquals(tables.business_events ?? [], []);
  // Not marked as alarmed: the outage is still owed its event.
  assert(!(tables.sync_state ?? []).some((row) => row.mode === "ERROR"));

  fault.failTable = undefined;
  await withGraph(double, () => ingest(sb));
  assertEquals(tables.business_events.length, 1);
  assertEquals(tables.business_events[0].entity_id, SWWA);
  assertEquals(tables.sync_state[0].mode, "ERROR");

  await withGraph(double, () => ingest(sb));
  assertEquals(tables.business_events.length, 1);
});

Deno.test("a throttled Group read fails its slice at once instead of stalling the ses@ poll, cursor unmoved", async () => {
  const double = graphDouble([purchaseOrder("po", "2026-10-08T06:31:00Z")], {
    throttleRetryAfterSeconds: 120,
  });
  const { sb, tables } = memorySb();
  const startedAt = Date.now();
  const out = await withGraph(double, () => ingest(sb));
  assert(Date.now() - startedAt < 2000, "the read waited out the throttle");
  assertEquals(out.reports[0].ok, false);
  assert(out.reports[0].error?.includes("429 wait budget exhausted"));
  assertEquals(tables.mail_sync_cursors ?? [], []);
  assertEquals(tables.emails, undefined);
  assertEquals(out.handoff.sources, []);
  // One listing attempt, no retry.
  assertEquals(
    double.calls.filter((c) => c.includes("/conversations?")).length,
    1,
  );
});

Deno.test("a storage failure leaves the Group cursor unmoved so the same mail is retried", async () => {
  const double = graphDouble([purchaseOrder("po", "2026-10-08T06:31:00Z")]);
  const { sb, tables } = memorySb({ failTable: "emails" });
  const out = await withGraph(double, () => ingest(sb));
  assertEquals(out.reports[0].ok, false);
  assert(out.reports[0].error?.includes("emails upsert failed"));
  assertEquals(tables.mail_sync_cursors, []);
  assertEquals(out.handoff.sources, []);
});

Deno.test("with no scoped Group configured the lane does nothing", async () => {
  const double = graphDouble([purchaseOrder("po", "2026-10-08T06:31:00Z")]);
  const { sb, tables } = memorySb();
  const out = await withGraph(
    double,
    () => ingest(sb, { groups: [] }),
  );
  assertEquals(out.reports, []);
  assertEquals(double.calls, []);
  assertEquals(Object.keys(tables), []);
});

Deno.test("collector: the cursor of a cut-short read is the last conversation read, never a newer post time", async () => {
  const early = purchaseOrder("early", "2026-10-03T03:00:00Z");
  // A reply landed in the early conversation after the later ones were sent.
  const late = purchaseOrder("late", "2026-10-09T03:00:00Z", "20999300-01");
  const mid = purchaseOrder("mid", "2026-10-05T03:00:00Z", "20999400-01");
  const double = graphDouble([early, mid, late]);
  const window = await withGraph(
    double,
    () =>
      _collectSenderScopedGroupPosts("tok", GROUP, {
        sinceIso: "2026-09-01T00:00:00.000Z",
        floorIso: "2026-09-01T00:00:00.000Z",
        cursorIso: null,
        maxNewConversations: 2,
        senderInScope: (from) => from.endsWith("@ambrose.test"),
      }),
  );
  assertEquals(window.catchUpPending, true);
  assertEquals(window.conversationsRead, 2);
  assertEquals(window.posts.map((p) => p.id), ["post-early", "post-mid"]);
  assertEquals(window.nextCursor, "2026-10-05T03:00:00.000Z");
});
