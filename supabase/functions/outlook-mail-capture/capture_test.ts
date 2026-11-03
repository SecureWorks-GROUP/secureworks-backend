// Slice EM2: the reader's run logic over fake Graph reads and a fake ledger.
// Cursor handling, duplicates, the 130-message burst (email.md review M5), a
// mailbox that refuses access, history scope, flags, groups.
// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { OutlookMailItem } from "../_shared/evidence/outlook_mail.ts";
import {
  E_DIRECT,
  E_IDENTITY,
  E_SENT,
} from "../_shared/evidence/outlook_mail_fixtures.ts";
import type { AttachmentResult } from "./attachments.ts";
import { type AudienceResolveOutcome, type CaptureDeps, type CaptureOutcome, type CaptureResult, type DeepGate, type DeepScope, historyWindow, POLICY, runOutlookCapture, type RunRow, type SourceRow } from "./capture.ts";
import { GraphReadError } from "./graph.ts";
import { handleCapture } from "./handler.ts";

const NOW = Date.parse("2026-10-02T06:00:00Z");
const FOLDERS = {
  junk: "F-junk",
  drafts: "F-drafts",
  outbox: "F-outbox",
  sent: "F-sent",
  deleted: "F-deleted",
};

type Msg = OutlookMailItem & { parentFolderId?: string; isDraft?: boolean };

interface World {
  flags: { reader: boolean; program: boolean };
  lane: boolean;
  sources: SourceRow[];
  mailboxes: Record<string, Msg[] | "refuse">;
  groups: Record<
    string,
    {
      id: string;
      posts: Array<{ conv: string; thread: string; post: OutlookMailItem }>;
    }
  >;
  runs: Array<
    RunRow & {
      source: string;
      counts?: Record<string, number>;
      error_code?: string | null;
    }
  >;
  keys: Map<string, string>;
  captured: Record<string, unknown>[];
  attachmentCalls: string[];
  captureFails?: string;
  /** Old monitor-inbox rows: sender and Graph received time. */
  legacy: Array<{ id: string; from: string; receivedAt: string }>;
  legacyFails?: boolean;
  legacyCalls: Array<{ from: string; receivedAt: string; subject: string }>;
  /** Called before each conversation list page; may throw. */
  onConversationList?: () => void;
  attachmentEvents: Array<string | null>;
  /** The recheck flag each storeAttachments call carried. */
  attachmentRecheck: boolean[];
  listCalls: number;
  conversationPages: number;
  postReads: string[];
  rosterReads: string[];
  now: number;
  tick: number;
  /** The deep load's gate (context_email_deep_enabled). */
  deep: DeepGate;
  /** The deep load's scope (context_email_deep_scope). */
  deepScope: DeepScope;
  /** The make-safe prefix set; null reads as unreadable. */
  prefixes: string[] | null;
  /** Every copy handed to context_email_audience_resolve, and what it answers. */
  resolveCalls: Record<string, unknown>[];
  resolveAnswer?: AudienceResolveOutcome;
}

function world(partial: Partial<World> = {}): World {
  return {
    flags: { reader: true, program: true },
    lane: true,
    sources: [{
      email: "nithin@secureworkswa.com.au",
      source_key: "nithin",
      kind: "user",
      scope_label: "sales",
      owner_privacy: false,
    }],
    mailboxes: {},
    groups: {},
    runs: [],
    keys: new Map(),
    captured: [],
    attachmentCalls: [],
    legacy: [],
    legacyCalls: [],
    attachmentEvents: [],
    attachmentRecheck: [],
    listCalls: 0,
    conversationPages: 0,
    postReads: [],
    rosterReads: [],
    now: NOW,
    tick: 0,
    deep: {
      enabled: true,
      hardFloorMs: Date.parse("2024-12-31T16:00:00Z"),
      userWindowMaxDays: 32,
    },
    deepScope: {
      version: "email-deep-v1",
      jobs: 0,
      jobNumbers: new Map(),
      clientEmails: new Map(),
      builderRefs: new Map(),
    },
    prefixes: ["MLB", "AJBR", "MS"],
    resolveCalls: [],
    ...partial,
  };
}

function groupMail(w: World): CaptureDeps["mail"] {
  const mail: CaptureDeps["mail"] = {
    folderIds: async (mailbox) => {
      if (w.mailboxes[mailbox] === "refuse") {
        throw new GraphReadError("graph_403", 403);
      }
      return FOLDERS;
    },
    listMessages: async (mailbox, args) => {
      w.listCalls++;
      const box = w.mailboxes[mailbox];
      if (box === "refuse" || !box) {
        throw new GraphReadError("graph_403", 403);
      }
      const from = Date.parse(args.fromIso);
      const to = args.toIso ? Date.parse(args.toIso) : Infinity;
      const all = box.filter((m) => {
        const t = Date.parse(m.receivedAt!);
        return t >= from && t < to;
      }).sort((a, b) =>
        Date.parse(a.receivedAt!) - Date.parse(b.receivedAt!) ||
        (a.graphId < b.graphId ? -1 : 1)
      );
      const offset = args.next ? Number(args.next.split("#")[1]) : 0;
      const page = all.slice(offset, offset + args.top);
      const next = offset + args.top < all.length
        ? `https://graph.microsoft.com/v1.0/next#${offset + args.top}`
        : null;
      return { items: page.map((m) => ({ ...m, detailRead: true })), next };
    },
    messageDetail: async () => ({
      text: "detail",
      isHtml: false,
      headers: {},
    }),
    resolveGroupId: async (address) => w.groups[address]?.id ?? null,
    // Graph's order (lastDeliveredDateTime desc), 25 a page, the next
    // link an offset into the list as it stands when the page is read.
    listGroupConversations: async (groupId, next) => {
      w.conversationPages++;
      w.onConversationList?.();
      const g = Object.values(w.groups).find((x) => x.id === groupId)!;
      const convs = [...new Set(g.posts.map((p) => p.conv))].map((id) => ({
        id,
        lastDeliveredDateTime: g.posts.filter((p) => p.conv === id).map((p) =>
          p.post.receivedAt!
        ).sort().at(-1)!,
      })).sort((a, b) =>
        b.lastDeliveredDateTime.localeCompare(a.lastDeliveredDateTime) ||
        (a.id < b.id ? -1 : 1)
      );
      const offset = next ? Number(next.split("#")[1]) : 0;
      return {
        items: convs.slice(offset, offset + 25),
        next: offset + 25 < convs.length
          ? `https://graph.microsoft.com/v1.0/conversations#${offset + 25}`
          : null,
      };
    },
    listGroupThreads: async (groupId, conv) => {
      const g = Object.values(w.groups).find((x) => x.id === groupId)!;
      return [
        ...new Set(
          g.posts.filter((p) => p.conv === conv).map((p) => p.thread),
        ),
      ].map((id) => ({ id, topic: "Topic" }));
    },
    listGroupPosts: async (groupId, thread) => {
      w.postReads.push(thread);
      const g = Object.values(w.groups).find((x) => x.id === groupId)!;
      return g.posts.filter((p) => p.thread === thread).map((p) => p.post);
    },
    // One page. A next token is a later page the default fixtures never have,
    // so a test that paginates overrides these. They call the bulk methods at
    // call time, so a test that wraps those still applies.
    listGroupThreadPage: async (groupId, conv, next) => {
      if (next) return { items: [], next: null };
      return { items: await mail.listGroupThreads(groupId, conv), next: null };
    },
    listGroupPostPage: async (groupId, thread, topic, next, rosterOnly) => {
      if (next) return { items: [], next: null };
      if (rosterOnly) {
        w.rosterReads.push(thread);
        const g = Object.values(w.groups).find((x) => x.id === groupId)!;
        return {
          items: g.posts.filter((p) => p.thread === thread).map(({ post }) => ({
            graphId: post.graphId,
            from: post.from,
            receivedAt: post.receivedAt,
            folderKind: "group" as const,
          })),
          next: null,
        };
      }
      return {
        items: await mail.listGroupPosts(groupId, thread, topic),
        next: null,
      };
    },
  };
  return mail;
}

function deps(w: World): CaptureDeps {
  let runSeq = 0;
  return {
    now: () => (w.now += w.tick),
    flags: async () => w.flags,
    captureLaneOn: async () => w.lane,
    sources: async () => w.sources,
    supplierDomains: async () => new Set(["steelsupply.example"]),
    jobClientEmails: async () => new Set(["sam.sample@example.net"]),
    historyScope: async () => ({
      jobNumbers: new Set(["SWP-990001"]),
      clientEmails: new Set(["sam.sample@example.net"]),
    }),
    deepGate: async () => w.deep,
    deepScope: async () => w.deepScope,
    builderRefPrefixes: async () => w.prefixes,
    latestRuns: async (source, limit) =>
      w.runs.filter((r) => r.source === source).sort((a, b) =>
        b.started_at.localeCompare(a.started_at)
      ).slice(0, limit),
    recordRun: async (run) => {
      if (typeof run.run_id === "string") {
        const r = w.runs.find((x) => x.id === run.run_id)!;
        if (r.status !== "running") {
          throw Object.assign(new Error("capture_run_finished"), {
            code: "capture_run_finished",
          });
        }
        Object.assign(r, {
          status: run.status ?? r.status,
          window_to: "window_to" in run ? run.window_to : r.window_to,
          window_end_id: "window_end_id" in run
            ? run.window_end_id
            : ("window_to" in run ? null : r.window_end_id),
          cursor: "cursor" in run ? run.cursor : r.cursor,
          counts: run.counts ?? r.counts,
          error_code: run.error_code ?? null,
          updated_at: new Date(w.now).toISOString(),
        });
        return r.id;
      }
      const id = `run-${++runSeq}-${w.runs.length}`;
      w.runs.push({
        id,
        source: String(run.source),
        status: "running",
        started_at: new Date(w.now + w.runs.length).toISOString(),
        updated_at: new Date(w.now).toISOString(),
        window_to: typeof run.window_to === "string" ? run.window_to : null,
        window_end_id: null,
        cursor: (run.cursor as Record<string, unknown> | undefined) ?? null,
      });
      return id;
    },
    capture: async (row): Promise<CaptureOutcome> => {
      if (w.captureFails && row.provider_message_id === w.captureFails) {
        return { outcome: "error", code: "23514" };
      }
      const key = String(row.provider_message_id);
      w.captured.push(row);
      if (w.keys.has(key)) {
        return { outcome: "duplicate", id: w.keys.get(key), upgraded: false };
      }
      const id = `ev-${w.keys.size + 1}`;
      w.keys.set(key, id);
      return { outcome: "inserted", id };
    },
    resolveAudience: async (row) => {
      w.resolveCalls.push(row);
      return w.resolveAnswer ?? "unchanged";
    },
    legacyCopy: async (args) => {
      w.legacyCalls.push(args);
      if (w.legacyFails) {
        throw Object.assign(new Error("legacy_copy_unreadable"), {
          code: "legacy_copy_unreadable",
        });
      }
      return w.legacy.find((l) =>
        l.from === args.from &&
        Date.parse(l.receivedAt) === Date.parse(args.receivedAt)
      )?.id ?? null;
    },
    mail: groupMail(w),
    storeAttachments: async (args): Promise<AttachmentResult> => {
      w.attachmentCalls.push(args.providerMessageId);
      w.attachmentEvents.push(args.businessEventId);
      w.attachmentRecheck.push(args.recheck === true);
      return { stored: 1, skipped: 1, already: 0, errors: 0, error_code: null };
    },
    hash: async (t) => `h:${t}`,
  };
}

function msg(n: number, at: string, extra: Partial<Msg> = {}): Msg {
  return {
    graphId: `G${String(n).padStart(4, "0")}`,
    internetMessageId: `<m${n}@mail.example.com>`,
    subject: `Message ${n}`,
    from: "pat.example@example.com",
    to: ["nithin@secureworkswa.com.au"],
    receivedAt: at,
    sentAt: at,
    bodyText: `Body ${n}`,
    folderKind: "other",
    parentFolderId: "F-inbox",
    ...extra,
  };
}

function lastRun(w: World, source: string) {
  return w.runs.filter((r) => r.source === source).at(-1)!;
}

Deno.test("HTTP queue drives all four real capture modes to terminal receipts with one canonical email", async () => {
  const w = world({
    mailboxes: {
      "nithin@secureworkswa.com.au": [msg(901, "2026-10-02T05:50:00Z", {
        from: "sam.sample@example.net",
        subject: "SWP-990001 source evidence",
      })],
    },
    deepScope: deepScope({
      clientEmails: { "sam.sample@example.net": "2026-10-01T00:00:00Z" },
    }),
  });
  const background: Promise<unknown>[] = [];
  const handlerDeps = {
    env: (name: string) => name === "SW_API_KEY" ? "fixture-only" : undefined,
    createSupabase: () => ({}),
    waitUntil: (p: Promise<unknown>) => background.push(p),
  };
  const responses = await Promise.all(
    ["poll", "history", "sweep", "deep"].map((mode) =>
      handleCapture(
        new Request("https://fixture.invalid/capture", {
          method: "POST",
          headers: {
            "x-api-key": "fixture-only",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode,
            source: "nithin",
            from: "2026-10-01T06:00:00Z",
            to: "2026-10-02T06:00:00Z",
          }),
        }),
        handlerDeps,
        (_live, request) => runOutlookCapture(deps(w), request),
      )
    ),
  );
  assertEquals(responses.map((r) => r.status), [202, 202, 202, 202]);
  const outcomes = await Promise.all(background);
  assertEquals(
    outcomes.map((r) => (r as CaptureResult).outcome),
    Array(4).fill("ran"),
  );
  assertEquals(w.runs.map((r) => r.source), [
    "outlook_nithin",
    "outlook_history_nithin",
    "outlook_sweep_nithin",
    "outlook_deep_history_nithin",
  ]);
  assertEquals(w.runs.map((r) => r.status), Array(4).fill("succeeded"));
  assertEquals(w.keys.size, 1, "all modes share the canonical source identity");
  assertEquals(new Set(w.captured.map((r) => r.provider_message_id)).size, 1);
  assertEquals(w.captured.length, 4, "no accepted mode is skipped by queueing");
});

Deno.test("a caught-up poll overlaps 10 minutes; re-read mail is a duplicate, never a second row", async () => {
  const box = [msg(1, "2026-10-02T05:39:00Z"), msg(2, "2026-10-02T05:50:00Z")];
  const w = world({ mailboxes: { "nithin@secureworkswa.com.au": box } });
  await runOutlookCapture(deps(w), { mode: "poll" });
  box.push(msg(3, "2026-10-02T05:58:00Z"));
  w.now += 5 * 60_000;
  await runOutlookCapture(deps(w), { mode: "poll" });
  const run = lastRun(w, "outlook_nithin");
  assertEquals(run.counts!.inserted, 1);
  assertEquals(run.counts!.duplicates, 1); // message 2 inside the overlap
  assertEquals(w.keys.size, 3);
});

Deno.test("130 messages in one minute are all captured within 2 runs; the second inserts the last 30 (review M5)", async () => {
  const box: Msg[] = [];
  for (let i = 0; i < 130; i++) {
    box.push(
      msg(i, `2026-10-02T05:50:${String(Math.floor(i / 3)).padStart(2, "0")}Z`),
    );
  }
  const w = world({ mailboxes: { "nithin@secureworkswa.com.au": box } });
  await runOutlookCapture(deps(w), { mode: "poll" });
  const first = lastRun(w, "outlook_nithin");
  assertEquals(
    first.counts!.inserted,
    POLICY.pollPageSize * POLICY.pollMaxPages,
  );
  assertEquals((first.cursor as Record<string, unknown>).backlog, true);
  assertEquals(first.status, "succeeded");
  w.now += 5 * 60_000;
  await runOutlookCapture(deps(w), { mode: "poll" });
  const second = lastRun(w, "outlook_nithin");
  assertEquals(second.counts!.inserted, 30);
  assertEquals(second.counts!.duplicates, 0);
  assertEquals((second.cursor as Record<string, unknown>).backlog, false);
  assertEquals(w.keys.size, 130);
});

Deno.test("backlog resume skips only what was processed at the cursor's exact time", async () => {
  // 100 read in run 1; message 100 shares the last processed time.
  const box: Msg[] = [];
  for (let i = 0; i < 99; i++) box.push(msg(i, "2026-10-02T05:50:00Z"));
  box.push(
    msg(99, "2026-10-02T05:51:00Z"),
    msg(100, "2026-10-02T05:51:00Z"),
    msg(101, "2026-10-02T05:52:00Z"),
  );
  const w = world({ mailboxes: { "nithin@secureworkswa.com.au": box } });
  await runOutlookCapture(deps(w), { mode: "poll" });
  const first = lastRun(w, "outlook_nithin");
  assertEquals(first.window_to, "2026-10-02T05:51:00.000Z");
  assertEquals((first.cursor as Record<string, unknown>).ids_at_end, [
    "h:G0099",
  ]);
  await runOutlookCapture(deps(w), { mode: "poll" });
  const second = lastRun(w, "outlook_nithin");
  assertEquals(second.counts!.inserted, 2);
  assertEquals(second.counts!.skipped_before_cursor, 1);
  assertEquals(w.keys.size, 102);
});

Deno.test("a mailbox that refuses access fails its own run with the code; the other sources still run", async () => {
  const w = world({
    sources: [
      {
        email: "khairo@secureworkswa.com.au",
        source_key: "khairo",
        kind: "user",
        scope_label: "sales",
        owner_privacy: false,
      },
      {
        email: "nithin@secureworkswa.com.au",
        source_key: "nithin",
        kind: "user",
        scope_label: "sales",
        owner_privacy: false,
      },
    ],
    mailboxes: {
      "khairo@secureworkswa.com.au": "refuse",
      "nithin@secureworkswa.com.au": [msg(1, "2026-10-02T05:50:00Z")],
    },
  });
  const r = await runOutlookCapture(deps(w), { mode: "poll" });
  assert(r.outcome === "ran");
  const k = lastRun(w, "outlook_khairo");
  assertEquals(k.status, "failed");
  assertEquals(k.error_code, "graph_403");
  assertEquals(k.window_to, null);
  assertEquals(lastRun(w, "outlook_nithin").status, "succeeded");
  assertEquals(w.keys.size, 1);
});

Deno.test("a failed save stops the source and holds the cursor before that email", async () => {
  const box = [
    msg(1, "2026-10-02T05:41:00Z"),
    msg(2, "2026-10-02T05:42:00Z"),
    msg(3, "2026-10-02T05:43:00Z"),
  ];
  const w = world({
    mailboxes: { "nithin@secureworkswa.com.au": box },
    captureFails: "email:m2@mail.example.com",
  });
  await runOutlookCapture(deps(w), { mode: "poll" });
  const run = lastRun(w, "outlook_nithin");
  assertEquals(run.status, "failed");
  assertEquals(run.error_code, "capture_23514");
  assertEquals(run.window_to, "2026-10-02T05:41:00.000Z");
  assertEquals(w.keys.size, 1);
  // Fixed: the next poll retries message 2 and goes on.
  w.captureFails = undefined;
  await runOutlookCapture(deps(w), { mode: "poll" });
  assertEquals(w.keys.size, 3);
});

Deno.test("capture lane switched off mid-run: partial, cursor not past the unsaved email", async () => {
  const box = [msg(1, "2026-10-02T05:41:00Z"), msg(2, "2026-10-02T05:42:00Z")];
  const w = world({ mailboxes: { "nithin@secureworkswa.com.au": box } });
  const d = deps(w);
  let n = 0;
  const real = d.capture;
  d.capture = async (
    row,
  ) => (++n === 2 ? { outcome: "capture_disabled" } : real(row));
  await runOutlookCapture(d, { mode: "poll" });
  const run = lastRun(w, "outlook_nithin");
  assertEquals(run.status, "partial");
  assertEquals(run.error_code, "capture_disabled");
  assertEquals(run.window_to, "2026-10-02T05:41:00.000Z");
});

// Lanes health (6 Oct 2026): the first nightly sweep after the reader was
// switched on re-read 48 hours that began before the reader's first poll, and
// the status counted that older mail as "missed by the poll". The sweep now
// records when each email it had to save was received, so the status
// (context_email_capture_status_at, 20261006050000) can leave out mail older
// than the source's first successful poll. Times only, never mail text.
// These tests read a shared mailbox source.
const SHARED: SourceRow = {
  email: "admin@secureworkswa.com.au",
  source_key: "admin",
  kind: "user",
  scope_label: "admin",
  owner_privacy: false,
};

Deno.test("attachments: a poll handles an email's files once; the sweep and history runs recheck them", async () => {
  const box = [{
    ...E_DIRECT,
    to: [SHARED.email],
    receivedAt: "2026-10-02T05:50:00Z",
    parentFolderId: "F-inbox",
  }];
  const w = world({ sources: [SHARED], mailboxes: { [SHARED.email]: box } });
  await runOutlookCapture(deps(w), { mode: "poll" });
  await runOutlookCapture(deps(w), { mode: "sweep", source: "admin" });
  assertEquals(w.attachmentRecheck, [false, true]);
});

Deno.test("history: bounded window, backfill rows, live jobs only (captain ruling 24 Sep)", async () => {
  assertEquals(
    historyWindow({
      mode: "history",
      from: "2026-07-01T00:00:00Z",
      to: "2026-10-01T00:00:00Z",
    }, NOW),
    null,
  );
  assertEquals(
    historyWindow({
      mode: "history",
      from: "2026-09-10T00:00:00Z",
      to: "2026-10-09T00:00:00Z",
    }, NOW),
    null,
  );
  assertEquals(
    historyWindow({
      mode: "history",
      from: "2026-09-20T00:00:00Z",
      to: "2026-09-10T00:00:00Z",
    }, NOW),
    null,
  );
  const box = [
    {
      ...E_DIRECT,
      receivedAt: "2026-09-20T02:00:00Z",
      parentFolderId: "F-inbox",
    }, // names SWP-990001: live
    {
      ...E_IDENTITY,
      receivedAt: "2026-09-21T02:00:00Z",
      parentFolderId: "F-inbox",
    }, // a live job's client: live
    msg(9, "2026-09-22T02:00:00Z"), // nothing to do with a live job
  ];
  const w = world({ mailboxes: { "nithin@secureworkswa.com.au": box } });
  const refused = await runOutlookCapture(deps(w), {
    mode: "history",
    from: "2026-09-15T00:00:00Z",
    to: "2026-10-01T00:00:00Z",
  });
  assertEquals(refused, { outcome: "refused", code: "history_needs_source" });
  await runOutlookCapture(deps(w), {
    mode: "history",
    source: "nithin",
    from: "2026-09-15T00:00:00Z",
    to: "2026-10-01T00:00:00Z",
  });
  const run = lastRun(w, "outlook_history_nithin");
  assertEquals(run.counts!.inserted, 2);
  assertEquals(run.counts!.skipped_out_of_scope, 1);
  assert(
    w.captured.every((c) =>
      (c.metadata as Record<string, unknown>).capture_mode === "backfill"
    ),
  );
  assertEquals(
    (run.cursor as Record<string, unknown>).history_from,
    "2026-09-15T00:00:00.000Z",
  );
});

Deno.test("history cut by the time budget resumes where it stopped", async () => {
  const box: Msg[] = [];
  for (let i = 0; i < 6; i++) {
    box.push(
      msg(i, `2026-09-2${i}T02:00:00Z`, { subject: `SWP-990001 update ${i}` }),
    );
  }
  const w = world({
    mailboxes: { "nithin@secureworkswa.com.au": box },
    tick: 30_000,
  });
  const req = {
    mode: "history" as const,
    source: "nithin",
    from: "2026-09-15T00:00:00Z",
    to: "2026-10-01T00:00:00Z",
  };
  await runOutlookCapture(deps(w), req);
  const first = lastRun(w, "outlook_history_nithin");
  assertEquals(first.status, "partial");
  assert(first.counts!.inserted < 6);
  for (let i = 0; i < 6 && w.keys.size < 6; i++) {
    await runOutlookCapture(deps(w), req);
  }
  assertEquals(w.keys.size, 6);
  assertEquals(lastRun(w, "outlook_history_nithin").status, "succeeded");
  assertEquals(w.captured.length, 6); // no message was read twice
});

Deno.test("attachments are stored for inserted and duplicate rows that have them", async () => {
  const box = [{
    ...E_DIRECT,
    receivedAt: "2026-10-02T05:50:00Z",
    parentFolderId: "F-inbox",
  }];
  const w = world({ mailboxes: { "nithin@secureworkswa.com.au": box } });
  await runOutlookCapture(deps(w), { mode: "poll" });
  await runOutlookCapture(deps(w), { mode: "poll" });
  assertEquals(w.attachmentCalls, [
    "email:em2-direct-0001@mail.example.com",
    "email:em2-direct-0001@mail.example.com",
  ]);
  assertEquals(lastRun(w, "outlook_nithin").counts!.attachments_stored, 1);
});

Deno.test("groups: posts read through conversations, oldest first, one row per post", async () => {
  const post = (n: number, at: string): OutlookMailItem => ({
    graphId: `P${n}`,
    internetMessageId: `<post${n}@mail.example.org>`,
    conversationId: "C1",
    subject: "Topic",
    from: "client@example.com",
    to: [],
    receivedAt: at,
    bodyText: `Post ${n}`,
    folderKind: "group",
  });
  const w = world({
    sources: [{
      email: "patios@secureworkswa.com.au",
      source_key: "patios",
      kind: "group",
      scope_label: "patios",
      owner_privacy: false,
    }],
    groups: {
      "patios@secureworkswa.com.au": {
        id: "GRP",
        posts: [
          { conv: "C1", thread: "T1", post: post(2, "2026-10-02T05:55:00Z") },
          { conv: "C1", thread: "T1", post: post(1, "2026-10-02T05:45:00Z") },
          { conv: "C2", thread: "T2", post: post(3, "2026-10-01T05:45:00Z") }, // before the window
        ],
      },
    },
  });
  await runOutlookCapture(deps(w), { mode: "poll" });
  const run = lastRun(w, "outlook_patios");
  assertEquals(run.status, "succeeded");
  assertEquals(w.captured.map((c) => c.provider_message_id), [
    "email:post1@mail.example.org",
    "email:post2@mail.example.org",
  ]);
  assertEquals(
    (w.captured[0].payload as Record<string, unknown>).line,
    "patio",
  );
  assertEquals(run.window_to, "2026-10-02T05:55:00.000Z");
});

Deno.test("an inbound email the old path already saved is skipped, not saved twice (gap plan B-1)", async () => {
  const box: Msg[] = [
    // The old path saved this one: same sender, same received time.
    msg(1, "2026-10-02T05:50:00Z", {
      from: "Pat Example <Pat.Example@Example.com>",
    }),
    // Same sender, another time: a new email.
    msg(2, "2026-10-02T05:52:00Z"),
    // Our reply at the old row's time: outbound, never checked.
    {
      ...E_SENT,
      receivedAt: "2026-10-02T05:50:00Z",
      sentAt: "2026-10-02T05:50:00Z",
      parentFolderId: "F-sent",
    },
  ];
  const w = world({
    mailboxes: { "nithin@secureworkswa.com.au": box },
    legacy: [{
      id: "old-1",
      from: "pat.example@example.com",
      receivedAt: "2026-10-02T05:50:00Z",
    }],
  });
  await runOutlookCapture(deps(w), { mode: "poll" });
  const run = lastRun(w, "outlook_nithin");
  assertEquals(run.status, "succeeded");
  assertEquals(run.counts!.skipped_legacy_copy, 1);
  assertEquals(run.counts!.inserted, 2);
  assertEquals(
    w.captured.map((c) => c.provider_message_id),
    ["email:sy4pr01mb0003@secureworkswa.com.au", "email:m2@mail.example.com"],
  );
  // Only the two inbound emails were looked up, by their bare lower-case sender and Graph time.
  assertEquals(w.legacyCalls, [
    {
      from: "pat.example@example.com",
      receivedAt: "2026-10-02T05:50:00Z",
      subject: "Message 1",
    },
    {
      from: "pat.example@example.com",
      receivedAt: "2026-10-02T05:52:00Z",
      subject: "Message 2",
    },
  ]);
  // The skipped email still moves the cursor.
  assertEquals(run.window_end_id, "G0002");
});

Deno.test("a skipped old-path copy's attachments go to the private store, pointed at the old row", async () => {
  const box = [{
    ...E_DIRECT,
    receivedAt: "2026-10-02T05:50:00Z",
    parentFolderId: "F-inbox",
  }];
  const w = world({
    mailboxes: { "nithin@secureworkswa.com.au": box },
    legacy: [{
      id: "old-7",
      from: "pat.example@example.com",
      receivedAt: "2026-10-02T05:50:00Z",
    }],
  });
  await runOutlookCapture(deps(w), { mode: "poll" });
  const run = lastRun(w, "outlook_nithin");
  assertEquals(run.counts!.skipped_legacy_copy, 1);
  assertEquals(w.captured.length, 0);
  assertEquals(w.attachmentCalls, ["email:em2-direct-0001@mail.example.com"]);
  assertEquals(w.attachmentEvents, ["old-7"]);
  assertEquals(run.counts!.attachments_stored, 1);
});

Deno.test("an unreadable old-path lookup fails the source and holds the cursor; nothing is saved past it", async () => {
  const box = [msg(1, "2026-10-02T05:50:00Z"), msg(2, "2026-10-02T05:52:00Z")];
  const w = world({
    mailboxes: { "nithin@secureworkswa.com.au": box },
    legacyFails: true,
  });
  await runOutlookCapture(deps(w), { mode: "poll" });
  const run = lastRun(w, "outlook_nithin");
  assertEquals(run.status, "failed");
  assertEquals(run.error_code, "legacy_copy_unreadable");
  assertEquals(w.captured.length, 0);
  assertEquals(run.window_to, null);
});

Deno.test("history skips old-path copies too, so a 60-day load adds no duplicate", async () => {
  const box = [
    {
      ...E_IDENTITY,
      receivedAt: "2026-09-21T02:00:00Z",
      parentFolderId: "F-inbox",
    },
    {
      ...E_DIRECT,
      receivedAt: "2026-09-20T02:00:00Z",
      parentFolderId: "F-inbox",
    },
  ];
  const w = world({
    mailboxes: { "nithin@secureworkswa.com.au": box },
    legacy: [{
      id: "old-2",
      from: "sam.sample@example.net",
      receivedAt: "2026-09-21T02:00:00.000Z",
    }],
  });
  await runOutlookCapture(deps(w), {
    mode: "history",
    source: "nithin",
    from: "2026-09-15T00:00:00Z",
    to: "2026-10-01T00:00:00Z",
  });
  const run = lastRun(w, "outlook_history_nithin");
  assertEquals(run.status, "succeeded");
  assertEquals(run.counts!.skipped_legacy_copy, 1);
  assertEquals(run.counts!.inserted, 1);
  assertEquals(w.captured.map((c) => c.provider_message_id), [
    "email:em2-direct-0001@mail.example.com",
  ]);
});

// W7 (6 Oct 2026): the fencing group's history load re-read the same newest
// 400 conversations every 5 minutes for a day. A group is listed newest
// conversation first, the run stopped at 400 conversations (or the time
// budget), saved no cursor (window_to null) and the next run started the
// window again. These tests hold the walk that replaced it.

const FENCING: SourceRow = {
  email: "fencing@secureworkswa.com.au",
  source_key: "fencing",
  kind: "group",
  scope_label: "fencing",
  owner_privacy: false,
};
const FENCING_HISTORY = {
  mode: "history" as const,
  source: "fencing",
  from: "2026-08-07T01:32:00.000Z",
  to: "2026-10-01T00:00:00.000Z",
};

/** A group of `n` conversations, each with `perConv` posts from a live job's client, conversation i ending 2 hours before i-1. */
function fencingGroup(n: number, perConv = 1) {
  const posts: Array<{ conv: string; thread: string; post: OutlookMailItem }> =
    [];
  const top = Date.parse("2026-09-30T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const conv = `C${String(i).padStart(3, "0")}`;
    for (let k = 0; k < perConv; k++) {
      const at = new Date(top - i * 7_200_000 - (perConv - 1 - k) * 60_000)
        .toISOString();
      posts.push({
        conv,
        thread: `T-${conv}`,
        post: {
          graphId: `P-${conv}-${k}`,
          internetMessageId: `<${conv}-${k}@mail.example.org>`,
          conversationId: conv,
          subject: "Fence quote",
          from: "sam.sample@example.net",
          to: [],
          receivedAt: at,
          bodyText: `Post ${conv} ${k}`,
          folderKind: "group",
        },
      });
    }
  }
  return { id: "GRP-FENCING", posts };
}

function historyRuns(w: World) {
  return w.runs.filter((r) => r.source === "outlook_history_fencing");
}

function walkOf(run: RunRow) {
  return (run.cursor as Record<string, unknown>).group as Record<
    string,
    unknown
  >;
}

const FIXED_SWEEP = {
  mode: "sweep" as const,
  source: "fencing",
  from: "2026-09-30T06:00:00.000Z",
  to: "2026-10-02T06:00:00.000Z",
};

Deno.test("fixed sweep: a staff reply keeps the external recipient from another post page", async () => {
  const own = gpost(
    "OWN",
    "2026-10-02T05:50:00Z",
    "admin@secureworkswa.com.au",
    "Enquiry",
    "We will reply Friday.",
  );
  const external = gpost(
    "CLIENT",
    "2026-10-02T05:40:00Z",
    "new.enquiry@example.net",
    "Enquiry",
    "Please confirm.",
  );
  const w = world({
    sources: [FENCING],
    groups: {
      [FENCING.email]: {
        id: "GRP-FENCING",
        posts: [own, external].map((post) => ({
          conv: "C",
          thread: "T",
          post,
        })),
      },
    },
  });
  const d = deps(w);
  d.mail.listGroupPostPage = async (_g, _t, _topic, next) => ({
    items: next ? [external] : [own],
    next: next ? null : "https://graph.microsoft.com/v1.0/next-post",
  });
  await runOutlookCapture(d, FIXED_SWEEP);
  assertEquals(lastRun(w, "outlook_sweep_fencing").status, "succeeded");
  const reply = w.captured.find((c) =>
    c.provider_message_id === "email:own@mail.example.org"
  )!;
  assertEquals(reply.event_type, "client.email_out");
  assertEquals(
    (reply.payload as Record<string, unknown>).email,
    "new.enquiry@example.net",
  );
  assertEquals(
    (reply.payload as Record<string, unknown>).audience_basis,
    "group_thread",
  );
});

function sweepGroup(n: number) {
  const group = fencingGroup(n);
  group.posts.forEach(({ post }, i) => {
    post.receivedAt = new Date(NOW - (i + 1) * 60_000).toISOString();
    // This sender has no live job: sweeps must not inherit history admission.
    post.from = "new.enquiry@example.net";
    post.hasAttachments = true;
  });
  return group;
}

Deno.test("fixed sweep: page walk resumes all 450 live emails across 200-conversation slices", async () => {
  const w = world({
    sources: [FENCING],
    groups: { [FENCING.email]: sweepGroup(450) },
  });
  const runs: typeof w.runs = [];
  for (let i = 0; i < 3; i++) {
    await runOutlookCapture(deps(w), FIXED_SWEEP);
    runs.push(lastRun(w, "outlook_sweep_fencing"));
    w.now += 5 * 60_000;
  }
  assertEquals(w.keys.size, 450);
  assertEquals(w.captured.length, 450);
  for (const [i, run] of runs.entries()) {
    assertEquals(run.status, i < 2 ? "partial" : "succeeded");
    assertEquals(run.counts!.conversations_read, i < 2 ? 200 : 50);
    assertEquals(run.counts!.sweep_misses, i < 2 ? 200 : 50);
    assertEquals(run.cursor!.history_from, FIXED_SWEEP.from);
    assertEquals(run.cursor!.history_to, FIXED_SWEEP.to);
  }
  assertEquals(w.postReads.length, 450);
  assertEquals(w.rosterReads.length, 450);
  assert(
    w.captured.every((c) =>
      (c.metadata as Record<string, unknown>).capture_mode === "live"
    ),
  );
  assertEquals(w.attachmentCalls.length, 450);
  assert(w.attachmentRecheck.every(Boolean));
});

Deno.test("fixed sweep: budget-cut group capture makes progress until every live message is saved once", async () => {
  const w = world({
    sources: [FENCING],
    groups: { [FENCING.email]: sweepGroup(55) },
    tick: 1_000,
  });
  let calls = 0;
  do {
    await runOutlookCapture(deps(w), FIXED_SWEEP);
    calls++;
    const run = lastRun(w, "outlook_sweep_fencing");
    assert(run.counts!.progressed > 0);
    if (run.status === "succeeded") break;
    assertEquals(run.status, "partial");
    w.now += 5 * 60_000;
  } while (calls < 40);
  assert(calls > 1 && calls < 40);
  assertEquals(lastRun(w, "outlook_sweep_fencing").status, "succeeded");
  assertEquals(w.keys.size, 55);
  assertEquals(w.captured.length, 55);
});

Deno.test("fixed sweep: unreadable or cyclic audience evidence cannot complete or skip the thread", async () => {
  for (const cycle of [false, true]) {
    const w = world({
      sources: [FENCING],
      groups: { [FENCING.email]: sweepGroup(2) },
    });
    const d = deps(w);
    const read = d.mail.listGroupPostPage;
    d.mail.listGroupPostPage = async (g, t, topic, next, rosterOnly) => {
      if (rosterOnly) {
        if (!cycle) throw new GraphReadError("graph_503", 503);
        return {
          items: [],
          next: "https://graph.microsoft.com/v1.0/same-page",
        };
      }
      return read(g, t, topic, next, rosterOnly);
    };
    await runOutlookCapture(d, FIXED_SWEEP);
    const failed = lastRun(w, "outlook_sweep_fencing");
    assertEquals(failed.status, "failed");
    assertEquals(failed.error_code, cycle ? "graph_page_cycle" : "graph_503");
    assertEquals(w.captured.length, 0);
    assertEquals(walkOf(failed).before, null);
    w.now += 5 * 60_000;
    await runOutlookCapture(deps(w), FIXED_SWEEP);
    assertEquals(lastRun(w, "outlook_sweep_fencing").status, "succeeded");
    assertEquals(w.keys.size, 2);
  }
});

Deno.test("fixed sweep: personal mailbox resumes after a budget stop without history filtering", async () => {
  const box = Array.from(
    { length: 6 },
    (_, i) => msg(i, new Date(NOW - (10 - i) * 60_000).toISOString()),
  );
  const w = world({
    mailboxes: { "nithin@secureworkswa.com.au": box },
    tick: 30_000,
  });
  const req = { ...FIXED_SWEEP, source: "nithin" };
  await runOutlookCapture(deps(w), req);
  assertEquals(lastRun(w, "outlook_sweep_nithin").status, "partial");
  for (
    let i = 0;
    i < 10 && lastRun(w, "outlook_sweep_nithin").status !== "succeeded";
    i++
  ) {
    await runOutlookCapture(deps(w), req);
  }
  assertEquals(lastRun(w, "outlook_sweep_nithin").status, "succeeded");
  assertEquals(w.keys.size, 6);
  assertEquals(w.captured.length, 6);
});

Deno.test("W7: a group history larger than one run resumes where the last run stopped; nothing is read twice", async () => {
  const w = world({
    sources: [FENCING],
    groups: { "fencing@secureworkswa.com.au": fencingGroup(450) },
  });
  await runOutlookCapture(deps(w), FENCING_HISTORY);
  const first = historyRuns(w)[0];
  assertEquals(first.status, "partial");
  assertEquals(first.counts!.conversations_read, 400);
  assertEquals(first.counts!.progressed, 800); // 400 posts and 400 conversations
  // The cursor is saved: the run names where it stopped.
  assert(first.window_to !== null);
  assertEquals(walkOf(first).before, first.window_to);
  assertEquals(walkOf(first).before_ids, ["h:C399"]);

  w.now += 5 * 60_000;
  await runOutlookCapture(deps(w), FENCING_HISTORY);
  const second = historyRuns(w)[1];
  assertEquals(second.status, "succeeded");
  assertEquals(second.counts!.conversations_skipped, 400);
  assertEquals(second.counts!.conversations_read, 50);
  // Every post of the window saved once; the second run read only what was left.
  assertEquals(w.keys.size, 450);
  assertEquals(w.captured.length, 450);
  assertEquals(new Set(w.postReads).size, 450);
  assertEquals(w.postReads.length, 450);
});

Deno.test("W7: the old restart loop cannot recur: runs cut by the time budget each move on until the window is done", async () => {
  const w = world({
    sources: [FENCING],
    groups: { "fencing@secureworkswa.com.au": fencingGroup(60, 3) },
    tick: 1_000,
  });
  let runs = 0;
  while (runs < 40) {
    runs++;
    await runOutlookCapture(deps(w), FENCING_HISTORY);
    const run = historyRuns(w).at(-1)!;
    assert(run.counts!.progressed > 0, `run ${runs} made no progress`);
    if (run.status === "succeeded") break;
    assertEquals(run.status, "partial");
    assert(run.window_to !== null, `run ${runs} saved no cursor`);
    w.now += 5 * 60_000;
  }
  assert(runs > 2, "the budget should cut the load into several runs");
  assertEquals(historyRuns(w).at(-1)!.status, "succeeded");
  assertEquals(w.keys.size, 180);
  assertEquals(w.captured.length, 180); // no post saved twice
});

Deno.test("W7: a conversation cut part way resumes after its last saved post", async () => {
  const w = world({
    sources: [FENCING],
    groups: { "fencing@secureworkswa.com.au": fencingGroup(1, 40) },
    tick: 5_000,
  });
  await runOutlookCapture(deps(w), FENCING_HISTORY);
  const first = historyRuns(w)[0];
  assertEquals(first.status, "partial");
  const saved = first.counts!.inserted;
  assert(saved > 0 && saved < 40);
  assertEquals(walkOf(first).conv, "h:C000");
  assertEquals(walkOf(first).before, null);
  for (
    let i = 0;
    i < 20 && historyRuns(w).at(-1)!.status !== "succeeded";
    i++
  ) {
    w.now += 5 * 60_000;
    await runOutlookCapture(deps(w), FENCING_HISTORY);
    assert(historyRuns(w).at(-1)!.counts!.progressed > 0);
  }
  assertEquals(historyRuns(w).at(-1)!.status, "succeeded");
  assertEquals(w.keys.size, 40);
  assertEquals(w.captured.length, 40);
});

Deno.test("W7: a conversation that gets new mail during the load is still read (top-up pass)", async () => {
  const group = fencingGroup(450);
  const w = world({
    sources: [FENCING],
    groups: { "fencing@secureworkswa.com.au": group },
  });
  await runOutlookCapture(deps(w), FENCING_HISTORY);
  // C430 is below the cursor, not read yet; a reply now moves it to the top.
  group.posts.push({
    conv: "C430",
    thread: "T-C430",
    post: {
      ...group.posts.find((p) => p.conv === "C430")!.post,
      graphId: "P-C430-reply",
      internetMessageId: "<C430-reply@mail.example.org>",
      receivedAt: new Date(w.now + 60_000).toISOString(),
    },
  });
  w.now += 5 * 60_000;
  await runOutlookCapture(deps(w), FENCING_HISTORY);
  const second = historyRuns(w)[1];
  assertEquals(second.status, "succeeded");
  assertEquals(walkOf(second).passes, 1);
  // Its post inside the window is saved; the reply after the window is the poll's.
  assert(w.keys.has("email:c430-0@mail.example.org"));
  assert(!w.keys.has("email:c430-reply@mail.example.org"));
  assertEquals(w.keys.size, 450);
});

// History depth PR B (7 Oct 2026): mode deep. One slice of a mailbox older
// than the 60-day limit, kept only where it touches a monitored live job from
// that job's lead-in on, every row marked history_tier deep; the counts-only
// probe; builder references on every row.

const DEEP_WINDOW = {
  mode: "deep" as const,
  source: "nithin",
  from: "2026-05-01T00:00:00.000Z",
  to: "2026-06-01T00:00:00.000Z",
};

function deepScope(p: {
  jobNumbers?: Record<string, string>;
  clientEmails?: Record<string, string>;
  builderRefs?: Record<string, string>;
}): DeepScope {
  const m = (o?: Record<string, string>) =>
    new Map(Object.entries(o ?? {}).map(([k, v]) => [k, Date.parse(v)]));
  return {
    version: "email-deep-v1",
    jobs: 1,
    jobNumbers: m(p.jobNumbers),
    clientEmails: m(p.clientEmails),
    builderRefs: m(p.builderRefs),
  };
}

Deno.test("deep: keeps mail touching a monitored job from that job's lead-in on, by job number, builder reference and client email; older matches are skipped_before_job; rows are backfill and history_tier deep", async () => {
  const box = [
    msg(1, "2026-05-10T02:00:00Z", { subject: "Re: Patio quote SWP-990001" }),
    msg(2, "2026-05-02T02:00:00Z", { subject: "SWP-990001 early" }), // before its job's lead-in
    msg(3, "2026-05-20T02:00:00Z", { from: "sam.sample@example.net" }),
    msg(4, "2026-05-10T03:00:00Z", { from: "sam.sample@example.net" }), // before the client's job's lead-in
    msg(5, "2026-05-03T02:00:00Z", {
      from: "claims@builder.example",
      subject: "Claim MLB-26537 make safe",
    }),
    msg(6, "2026-05-04T02:00:00Z", {
      from: "claims@builder.example",
      subject: "Make Safe 67005",
    }),
    msg(7, "2026-05-05T02:00:00Z", {
      from: "claims@builder.example",
      bodyText: "Ref 67005 in the words only",
    }), // a bare number in the words never counts
    msg(8, "2026-05-06T02:00:00Z"), // nothing to do with a monitored job
  ];
  const w = world({
    mailboxes: { "nithin@secureworkswa.com.au": box },
    deepScope: deepScope({
      jobNumbers: { "SWP-990001": "2026-05-05T00:00:00Z" },
      clientEmails: { "sam.sample@example.net": "2026-05-15T00:00:00Z" },
      builderRefs: {
        "MLB-26537": "2026-05-01T00:00:00Z",
        "67005": "2026-05-01T00:00:00Z",
      },
    }),
  });
  const r = await runOutlookCapture(deps(w), DEEP_WINDOW);
  assert(r.outcome === "ran");
  const run = lastRun(w, "outlook_deep_history_nithin");
  assertEquals(run.status, "succeeded");
  assertEquals(run.counts!.inserted, 4);
  assertEquals(run.counts!.kept_by_job_number, 1);
  assertEquals(run.counts!.kept_by_client_email, 1);
  assertEquals(run.counts!.kept_by_builder_ref, 2);
  assertEquals(run.counts!.skipped_before_job, 2);
  assertEquals(run.counts!.skipped_out_of_scope, 2);
  assertEquals(w.captured.map((c) => c.provider_message_id), [
    "email:m5@mail.example.com",
    "email:m6@mail.example.com",
    "email:m1@mail.example.com",
    "email:m3@mail.example.com",
  ]);
  for (const c of w.captured) {
    assertEquals(c.metadata, {
      capture_mode: "backfill",
      capture_path: "outlook_mail_v1",
      history_tier: "deep",
    });
  }
  assertEquals(
    (w.captured[0].payload as Record<string, unknown>).builder_refs,
    ["MLB-26537"],
  );
  assert(!("builder_refs" in (w.captured[1].payload as object)));
  assertEquals(run.cursor, {
    mode: "deep",
    backlog: false,
    ids_at_end: ["h:G0003"],
    history_from: "2026-05-01T00:00:00.000Z",
    history_to: "2026-06-01T00:00:00.000Z",
    history_tier: "deep",
  });
  assertEquals(run.window_to, "2026-05-20T02:00:00.000Z");
});

Deno.test("every mode writes the builder references an email names; the prefix floor is used (and counted) when the company prefixes cannot be read", async () => {
  const box = [
    msg(1, "2026-10-02T05:50:00Z", {
      subject: "MLB-26537PO-56922 make safe",
      bodyText: "Please attend AJBR 67134 too.",
    }),
  ];
  const w = world({ mailboxes: { "nithin@secureworkswa.com.au": box } });
  await runOutlookCapture(deps(w), { mode: "poll" });
  assertEquals(
    (w.captured[0].payload as Record<string, unknown>).builder_refs,
    ["MLB-26537", "PO-56922", "AJBR-67134"],
  );
  assert(!("history_tier" in (w.captured[0].metadata as object)));
  assertEquals(
    lastRun(w, "outlook_nithin").counts!.builder_ref_prefixes_floor_only,
    undefined,
  );
  const unreadable = world({
    mailboxes: { "nithin@secureworkswa.com.au": box },
    prefixes: null,
  });
  await runOutlookCapture(deps(unreadable), { mode: "poll" });
  assertEquals(
    (unreadable.captured[0].payload as Record<string, unknown>).builder_refs,
    ["MLB-26537", "PO-56922", "AJBR-67134"],
  );
  assertEquals(
    lastRun(unreadable, "outlook_nithin").counts!
      .builder_ref_prefixes_floor_only,
    1,
  );
});

// Group mailbox audience (9 Oct 2026): a group post lists no recipients, so
// who our own post went to is read from its thread, and a copy that meets
// the row another copy saved goes to the resolver when it may know better.
function groupSource(email: string, key: string): SourceRow {
  return {
    email,
    source_key: key,
    kind: "group",
    scope_label: key,
    owner_privacy: false,
  };
}

function gpost(
  id: string,
  at: string,
  from: string,
  subject: string,
  words: string,
  internetMessageId?: string,
): OutlookMailItem {
  return {
    graphId: id,
    internetMessageId: internetMessageId ??
      `<${id.toLowerCase()}@mail.example.org>`,
    subject,
    from,
    to: [],
    cc: [],
    receivedAt: at,
    sentAt: at,
    bodyText: words,
    folderKind: "group",
  };
}

Deno.test("group mailbox audience: our reply in a builder's thread is saved outbound to the builder, read from the whole thread; our post alone in its thread is unknown, never internal", async () => {
  const w = world({
    sources: [groupSource("ses@secureworkswa.com.au", "ses")],
    groups: {
      "ses@secureworkswa.com.au": {
        id: "GRP-SES",
        posts: [
          // The builder's request is older than the poll's window: it still names the thread's party.
          {
            conv: "C1",
            thread: "T1",
            post: gpost(
              "PB",
              "2026-10-02T05:00:00Z",
              "Jo Coordinator <coordinator@builder.example>",
              "Our Ref: BLD-99001",
              "Can you confirm the date?",
            ),
          },
          {
            conv: "C1",
            thread: "T1",
            post: gpost(
              "PR",
              "2026-10-02T05:50:00Z",
              "admin@secureworkswa.com.au",
              "Our Ref: BLD-99001",
              "Booked in for Friday.",
            ),
          },
          {
            conv: "C2",
            thread: "T2",
            post: gpost(
              "PA",
              "2026-10-02T05:52:00Z",
              "admin@secureworkswa.com.au",
              "BLD-99001 - Xero invoice INV-99001",
              "Invoice attached.",
            ),
          },
        ],
      },
    },
  });
  await runOutlookCapture(deps(w), { mode: "poll" });
  const run = lastRun(w, "outlook_ses");
  assertEquals(run.status, "succeeded");
  const byKey = Object.fromEntries(
    w.captured.map((r) => [String(r.provider_message_id), r]),
  );
  assertEquals(Object.keys(byKey).sort(), [
    "email:pa@mail.example.org",
    "email:pr@mail.example.org",
  ]);
  const reply = byKey["email:pr@mail.example.org"];
  const replyPayload = reply.payload as Record<string, unknown>;
  assertEquals(reply.event_type, "client.email_out");
  assertEquals(reply.direction, "outbound");
  assertEquals(replyPayload.email, "coordinator@builder.example");
  assertEquals(replyPayload.audience_basis, "group_thread");
  assertEquals(replyPayload.to, []);
  const alone = byKey["email:pa@mail.example.org"];
  const alonePayload = alone.payload as Record<string, unknown>;
  assertEquals(alone.event_type, "staff.email_unknown_audience");
  assertEquals(alone.direction, "outbound");
  assertEquals(alonePayload.email, null);
  assertEquals(alonePayload.audience_basis, "unknown");
  assertEquals(run.counts!.audience_from_thread, 1);
  assertEquals(run.counts!.audience_unknown, 1);
  assertEquals(run.counts!.inserted, 2);
  // Nothing met a saved row: the resolver was never asked.
  assertEquals(w.resolveCalls, []);
});

Deno.test("group mailbox audience: a mailbox copy of our own email that went to a group and meets the row its group post saved goes to the resolver; a duplicate sent to no group does not", async () => {
  const x = "<GMA-X-0001@secureworkswa.com.au>";
  const w = world({
    resolveAnswer: "relabelled",
    sources: [
      groupSource("ses@secureworkswa.com.au", "ses"),
      {
        email: "admin@secureworkswa.com.au",
        source_key: "admin",
        kind: "user",
        scope_label: "admin",
        owner_privacy: false,
      },
    ],
    groups: {
      "ses@secureworkswa.com.au": {
        id: "GRP-SES",
        posts: [{
          conv: "C1",
          thread: "T1",
          post: gpost(
            "PX",
            "2026-10-02T05:50:00Z",
            "admin@secureworkswa.com.au",
            "Our Ref: BLD-99001",
            "Booked in for Friday.",
            x,
          ),
        }],
      },
    },
    mailboxes: {
      "admin@secureworkswa.com.au": [
        msg(1, "2026-10-02T05:50:00Z", {
          internetMessageId: x,
          subject: "RE: Our Ref: BLD-99001",
          from: "admin@secureworkswa.com.au",
          to: ["coordinator@builder.example"],
          cc: ["SES <ses@secureworkswa.com.au>"],
          parentFolderId: "F-sent",
        }),
        // Our email to a customer, saved before through another copy: it went to no group.
        msg(2, "2026-10-02T05:51:00Z", {
          internetMessageId: "<gma-y-0002@secureworkswa.com.au>",
          from: "admin@secureworkswa.com.au",
          to: ["pat.example@example.com"],
          parentFolderId: "F-sent",
        }),
      ],
    },
  });
  w.keys.set("email:gma-y-0002@secureworkswa.com.au", "ev-earlier");
  await runOutlookCapture(deps(w), { mode: "poll" });
  // The group copy was saved first: no outside party in its thread, unknown.
  assertEquals(lastRun(w, "outlook_ses").counts!.audience_unknown, 1);
  // The Sent Items copy met it and was handed over whole; the other duplicate was not.
  assertEquals(w.resolveCalls.length, 1);
  const copy = w.resolveCalls[0];
  const copyPayload = copy.payload as Record<string, unknown>;
  assertEquals(
    copy.provider_message_id,
    "email:gma-x-0001@secureworkswa.com.au",
  );
  assertEquals(copy.event_type, "client.email_out");
  assertEquals(copyPayload.folder_kind, "sent");
  assertEquals(copyPayload.email, "coordinator@builder.example");
  assertEquals(copyPayload.cc, ["ses@secureworkswa.com.au"]);
  const admin = lastRun(w, "outlook_admin");
  assertEquals(admin.counts!.duplicates, 2);
  assertEquals(admin.counts!.audience_relabelled, 1);
  assertEquals(admin.counts!.audience_resolve_errors, 0);
});

Deno.test("group mailbox audience: our group post read again (a sweep) goes to the resolver, someone else's never; a failed call is counted and the run goes on", async () => {
  const w = world({
    resolveAnswer: "error",
    sources: [groupSource("ses@secureworkswa.com.au", "ses")],
    groups: {
      "ses@secureworkswa.com.au": {
        id: "GRP-SES",
        posts: [
          {
            conv: "C1",
            thread: "T1",
            post: gpost(
              "PB",
              "2026-10-02T05:40:00Z",
              "coordinator@builder.example",
              "Our Ref: BLD-99001",
              "Can you confirm?",
            ),
          },
          {
            conv: "C1",
            thread: "T1",
            post: gpost(
              "PR",
              "2026-10-02T05:50:00Z",
              "admin@secureworkswa.com.au",
              "Our Ref: BLD-99001",
              "Booked in.",
            ),
          },
        ],
      },
    },
  });
  // Both were saved by an earlier reading of the group.
  w.keys.set("email:pb@mail.example.org", "ev-b");
  w.keys.set("email:pr@mail.example.org", "ev-r");
  await runOutlookCapture(deps(w), { mode: "sweep" });
  const run = lastRun(w, "outlook_sweep_ses");
  assertEquals(run.status, "succeeded");
  assertEquals(run.counts!.duplicates, 2);
  assertEquals(w.resolveCalls.map((r) => r.provider_message_id), [
    "email:pr@mail.example.org",
  ]);
  assertEquals(
    (w.resolveCalls[0].payload as Record<string, unknown>).audience_basis,
    "group_thread",
  );
  assertEquals(run.counts!.audience_resolve_errors, 1);
  assertEquals(run.counts!.audience_relabelled, 0);
});
