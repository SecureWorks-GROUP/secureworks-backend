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
import {
  type CaptureDeps,
  type CaptureOutcome,
  historyWindow,
  POLICY,
  runOutlookCapture,
  type RunRow,
  type SourceRow,
  sweepMissList,
} from "./capture.ts";
import { GraphReadError } from "./graph.ts";

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
  now: number;
  tick: number;
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
    now: NOW,
    tick: 0,
    ...partial,
  };
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
    mail: {
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
      resolveGroupId: async (mail) => w.groups[mail]?.id ?? null,
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
    },
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

Deno.test("idle unless email_reader_v1, email_capture_v2 and the capture lane are on; reads nothing", async () => {
  for (
    const [patch, reason] of [
      [{ flags: { reader: false, program: true } }, "email_reader_v1_off"],
      [{ flags: { reader: true, program: false } }, "email_capture_v2_off"],
      [{ lane: false }, "capture_lane_off"],
    ] as const
  ) {
    const w = world({
      ...patch,
      mailboxes: {
        "nithin@secureworkswa.com.au": [msg(1, "2026-10-02T05:55:00Z")],
      },
    });
    const r = await runOutlookCapture(deps(w), { mode: "poll" });
    assertEquals(r, { outcome: "idle", reason });
    assertEquals(w.listCalls, 0);
    assertEquals(w.runs.length, 0);
  }
});

Deno.test("first poll reads the last 30 minutes, inbound and sent, and records the pair cursor", async () => {
  const box = [
    msg(1, "2026-10-02T05:00:00Z"), // older than 30 minutes: not read
    {
      ...E_IDENTITY,
      receivedAt: "2026-10-02T05:40:00Z",
      parentFolderId: "F-inbox",
    },
    {
      ...E_SENT,
      receivedAt: "2026-10-02T05:45:00Z",
      sentAt: "2026-10-02T05:45:00Z",
      parentFolderId: "F-sent",
    },
    msg(4, "2026-10-02T05:50:00Z", { parentFolderId: "F-junk" }),
    msg(5, "2026-10-02T05:51:00Z", { isDraft: true }),
  ];
  const w = world({ mailboxes: { "nithin@secureworkswa.com.au": box } });
  const r = await runOutlookCapture(deps(w), { mode: "poll" });
  assert(r.outcome === "ran");
  const run = lastRun(w, "outlook_nithin");
  assertEquals(run.status, "succeeded");
  assertEquals(run.counts!.inserted, 2);
  assertEquals(run.counts!.skipped_folder, 2);
  assertEquals(w.captured.map((c) => c.event_type), [
    "client.email_in",
    "client.email_out",
  ]);
  assertEquals(
    (w.captured[1].payload as Record<string, unknown>).folder_kind,
    "sent",
  );
  assertEquals(run.window_to, "2026-10-02T05:51:00.000Z");
  assertEquals(run.window_end_id, "G0005");
  assertEquals(run.cursor, {
    mode: "poll",
    backlog: false,
    ids_at_end: ["h:G0005"],
  });
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

Deno.test("a live run of the same source is busy; an abandoned one is closed", async () => {
  const w = world({ mailboxes: { "nithin@secureworkswa.com.au": [] } });
  w.runs.push({
    id: "old",
    source: "outlook_nithin",
    status: "running",
    started_at: "2026-10-02T05:58:00Z",
    updated_at: "2026-10-02T05:58:00Z",
    window_to: null,
    window_end_id: null,
    cursor: null,
  });
  const r = await runOutlookCapture(deps(w), { mode: "poll" });
  assert(r.outcome === "ran");
  assertEquals(r.sources[0].outcome, "busy");
  w.runs[0].updated_at = "2026-10-02T05:30:00Z";
  await runOutlookCapture(deps(w), { mode: "poll" });
  assertEquals(w.runs[0].status, "failed");
  assertEquals(w.runs[0].error_code, "abandoned");
});

Deno.test("sweep re-reads 48 hours; what the poll missed counts as sweep_misses", async () => {
  const box = [
    msg(1, "2026-10-01T08:00:00Z"),
    msg(2, "2026-10-02T04:00:00Z"),
    msg(3, "2026-09-29T08:00:00Z"),
  ];
  const w = world({ mailboxes: { "nithin@secureworkswa.com.au": box } });
  w.keys.set("email:m2@mail.example.com", "ev-existing");
  const r = await runOutlookCapture(deps(w), {
    mode: "sweep",
    source: "nithin",
  });
  assert(r.outcome === "ran");
  const run = lastRun(w, "outlook_sweep_nithin");
  assertEquals(run.status, "succeeded");
  assertEquals(run.counts!.sweep_misses, 1);
  assertEquals(run.counts!.duplicates, 1);
  assertEquals(run.counts!.seen, 2);
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
const toShared = { to: [SHARED.email] };

Deno.test("a sweep records when each email it had to save was received (cursor.miss_received_at)", async () => {
  const box = [
    msg(1, "2026-10-01T08:00:00Z", toShared),
    msg(2, "2026-10-02T04:00:00Z", toShared),
    msg(4, "2026-10-01T09:30:00.5Z", toShared),
  ];
  const w = world({ sources: [SHARED], mailboxes: { [SHARED.email]: box } });
  w.keys.set("email:m2@mail.example.com", "ev-existing");
  await runOutlookCapture(deps(w), { mode: "sweep", source: "admin" });
  const run = lastRun(w, "outlook_sweep_admin");
  assertEquals(run.counts!.sweep_misses, 2);
  assertEquals(run.cursor!.miss_received_at, [
    "2026-10-01T08:00:00.000Z",
    "2026-10-01T09:30:00.500Z",
  ]);
  // A poll records no such list.
  await runOutlookCapture(deps(w), { mode: "poll" });
  assertEquals(
    "miss_received_at" in lastRun(w, "outlook_admin").cursor!,
    false,
  );
});

// Review round 3: the list kept the oldest 100, so when a busy mailbox is
// switched on, mail past the list (the newer pre-poll mail) still counted as
// missed by the poll. The list keeps the newest instead: every miss past it
// is older than its oldest time, so the status can leave those out whenever
// that oldest time is before the source's first poll.
Deno.test("a sweep with more misses than the list holds keeps the newest; the rest are older than every listed time", async () => {
  const box = Array.from(
    { length: POLICY.sweepMissTimesMax + 3 },
    (_, i) =>
      msg(
        100 + i,
        new Date(Date.parse("2026-10-01T08:00:00Z") + i * 60_000)
          .toISOString(),
        toShared,
      ),
  );
  const w = world({ sources: [SHARED], mailboxes: { [SHARED.email]: box } });
  await runOutlookCapture(deps(w), { mode: "sweep", source: "admin" });
  const run = lastRun(w, "outlook_sweep_admin");
  assertEquals(run.counts!.sweep_misses, POLICY.sweepMissTimesMax + 3);
  const times = run.cursor!.miss_received_at as string[];
  assertEquals(times.length, POLICY.sweepMissTimesMax);
  // The three oldest (08:00, 08:01, 08:02) are past the list.
  assertEquals(times[0], "2026-10-01T08:03:00.000Z");
  assertEquals(times[times.length - 1], "2026-10-01T09:42:00.000Z");
});

Deno.test("the sweep's miss list: an unreadable time is listed as null (it always counts), then the newest times, oldest first", () => {
  const t = (m: number) => Date.parse("2026-10-01T08:00:00Z") + m * 60_000;
  assertEquals(sweepMissList([t(2), null, t(0), t(1)], 3), [
    null,
    "2026-10-01T08:01:00.000Z",
    "2026-10-01T08:02:00.000Z",
  ]);
  // More unreadable times than the list holds: no time is listed, so the
  // status cannot say the rest are older and counts them all.
  assertEquals(sweepMissList([null, t(0), null, null], 2), [null, null]);
  assertEquals(sweepMissList([t(5), t(4)], 3), [
    "2026-10-01T08:04:00.000Z",
    "2026-10-01T08:05:00.000Z",
  ]);
  assertEquals(sweepMissList([], 3), []);
  assertEquals(
    sweepMissList([t(1)]).length,
    1,
    "the default cap is POLICY.sweepMissTimesMax",
  );
});

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

Deno.test("a group the directory cannot find fails with group_not_found", async () => {
  const w = world({
    sources: [{
      email: "finance@secureworkswa.com.au",
      source_key: "finance",
      kind: "group",
      scope_label: "finance",
      owner_privacy: false,
    }],
  });
  await runOutlookCapture(deps(w), { mode: "poll" });
  assertEquals(lastRun(w, "outlook_finance").error_code, "group_not_found");
});

Deno.test("an unknown or unselected source is refused; unknown-kind sources are never read", async () => {
  const w = world({
    sources: [{
      email: "info@secureworkswa.com.au",
      source_key: "info",
      kind: "unknown",
      scope_label: "other",
      owner_privacy: false,
    }],
  });
  assertEquals(
    await runOutlookCapture(deps(w), { mode: "poll", source: "info" }),
    { outcome: "refused", code: "source_not_selected" },
  );
  const r = await runOutlookCapture(deps(w), { mode: "poll" });
  assert(r.outcome === "ran" && r.sources.length === 0);
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

Deno.test("W7: a window whose start the plan moved forward keeps its progress", async () => {
  const w = world({
    sources: [FENCING],
    groups: { "fencing@secureworkswa.com.au": fencingGroup(450) },
  });
  await runOutlookCapture(deps(w), FENCING_HISTORY);
  w.now += 5 * 60_000;
  await runOutlookCapture(deps(w), {
    ...FENCING_HISTORY,
    from: "2026-08-10T00:00:00.000Z",
  });
  const second = historyRuns(w)[1];
  assertEquals(second.status, "succeeded");
  assertEquals(second.counts!.conversations_skipped, 400);
  assertEquals(w.captured.length, 450);
});

Deno.test("W7: a run that fails or is abandoned hands its cursor on; the next run does not start again", async () => {
  const w = world({
    sources: [FENCING],
    groups: { "fencing@secureworkswa.com.au": fencingGroup(450) },
  });
  await runOutlookCapture(deps(w), FENCING_HISTORY);
  const reached = walkOf(historyRuns(w)[0]);

  // A Graph fault on the next run: failed, no progress, the cursor kept.
  w.now += 5 * 60_000;
  w.onConversationList = () => {
    // The running row already carries the cursor it started from.
    assertEquals(walkOf(historyRuns(w).at(-1)!), reached);
    throw new GraphReadError("graph_503", 503);
  };
  await runOutlookCapture(deps(w), FENCING_HISTORY);
  const failed = historyRuns(w)[1];
  assertEquals(failed.status, "failed");
  assertEquals(failed.error_code, "graph_503");
  assertEquals(failed.counts!.progressed, 0);
  assertEquals(walkOf(failed), reached);
  assertEquals(failed.window_to, historyRuns(w)[0].window_to);

  // A worker that stopped mid-run: closed as abandoned, its cursor kept.
  w.onConversationList = undefined;
  w.runs.push({
    id: "run-stuck",
    source: "outlook_history_fencing",
    status: "running",
    started_at: new Date(w.now + 1).toISOString(),
    updated_at: new Date(w.now + 1).toISOString(),
    window_to: failed.window_to,
    window_end_id: null,
    cursor: failed.cursor,
  });
  w.now += 15 * 60_000;
  await runOutlookCapture(deps(w), FENCING_HISTORY);
  assertEquals(
    w.runs.find((r) => r.id === "run-stuck")!.error_code,
    "abandoned",
  );
  const last = historyRuns(w).at(-1)!;
  assertEquals(last.status, "succeeded");
  assertEquals(last.counts!.conversations_read, 50);
  assertEquals(w.captured.length, 450);
});

Deno.test("W7: a long history run saves its cursor on its running row as it goes", async () => {
  const w = world({
    sources: [FENCING],
    groups: { "fencing@secureworkswa.com.au": fencingGroup(300) },
    tick: 1_000,
  });
  const seen: Array<string | null> = [];
  w.onConversationList = () => {
    const r = historyRuns(w).at(-1)!;
    if (r.status === "running") seen.push(r.window_to);
  };
  await runOutlookCapture(deps(w), FENCING_HISTORY);
  assertEquals(historyRuns(w)[0].status, "partial");
  // The second page was listed after checkpoints moved the running row's cursor.
  assert(seen.length >= 2 && seen.at(-1) !== null);
});
