// deno-lint-ignore-file no-import-prefix no-explicit-any
// Reminder texts before a scheduled job's first work day (job_schedule_reminders.ts):
// the rule, the captain's fixed wording, the prior-text scan, who is texted, the holds,
// the claim before the send, the switch and the action door. Nothing here reaches GHL:
// every send is a recording fake.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addCalendarDays,
  bookingChangedOn,
  calendarDaysBetween,
  claimScheduleReminder,
  DAY_BEFORE_REMINDER_TEMPLATE,
  finishScheduleReminder,
  firstWorkDay,
  jobScheduleReminderSweep,
  loadScheduleReminderCandidates,
  perthDayStart,
  priorTextWindowStart,
  readScheduleReminderJobDayEvents,
  readScheduleReminderMode,
  readScheduleReminderPriorTexts,
  type ReminderCandidate,
  reminderDateWords,
  reminderKindForToday,
  reminderMessage,
  runScheduleReminderAction,
  SCHEDULE_REMINDER_COMMS_TRIGGER,
  type ScheduleReminderDeps,
  similarPriorText,
  similarReminderReason,
  WEEKLY_REMINDER_TEMPLATE,
} from "./job_schedule_reminders.ts";

// 04:00 UTC on 13 Nov is 12:00 on 13 Nov in Perth: the cron's own instant.
const NOON = new Date("2026-11-13T04:00:00Z");
const TODAY = "2026-11-13";

// ── The rule ────────────────────────────────────────────────────────────────

/** Every day from `from` up to the job day that sends a text, as "DD:kind". */
function reminderDays(jobDay: string, from: string) {
  const out: string[] = [];
  for (let d = from; d < jobDay; d = addCalendarDays(d, 1)) {
    const kind = reminderKindForToday(d, jobDay);
    if (kind) out.push(`${d.slice(8)}:${kind}`);
  }
  return out;
}

Deno.test("the captain's examples: a weekly text every 7 days out, then the day before", () => {
  // From today (13 Nov) on.
  const fromToday = (jobDay: string) => reminderDays(jobDay, TODAY);
  assertEquals(fromToday("2026-11-27"), [
    "13:weekly",
    "20:weekly",
    "26:day_before",
  ]);
  assertEquals(fromToday("2026-11-23"), ["16:weekly", "22:day_before"]);
  assertEquals(fromToday("2026-11-18"), ["17:day_before"]);
});

Deno.test("the rule: d = 1 day before, d = 7, 14, 21 weekly, nothing else (no three-days text)", () => {
  const job = "2026-12-24";
  const kinds = new Map<number, string | null>();
  for (let d = 0; d <= 30; d++) {
    kinds.set(d, reminderKindForToday(addCalendarDays(job, -d), job));
  }
  assertEquals(kinds.get(0), null);
  assertEquals(kinds.get(1), "day_before");
  assertEquals(kinds.get(2), null);
  assertEquals(kinds.get(3), null);
  assertEquals(kinds.get(6), null);
  assertEquals(kinds.get(7), "weekly");
  assertEquals(kinds.get(14), "weekly");
  assertEquals(kinds.get(21), "weekly");
  assertEquals(kinds.get(28), "weekly");
  assertEquals(
    [...kinds.entries()].filter(([, k]) => k).map(([d]) => d),
    [1, 7, 14, 21, 28],
  );
  // A day already gone is never reminded.
  assertEquals(reminderKindForToday("2026-12-25", job), null);
  assertEquals(reminderKindForToday("2026-12-31", job), null);
});

Deno.test("calendar days cross month and year ends without a clock zone", () => {
  assertEquals(calendarDaysBetween("2026-11-30", "2026-12-07"), 7);
  assertEquals(calendarDaysBetween("2026-12-31", "2027-01-01"), 1);
  assertEquals(addCalendarDays("2026-11-13", -6), "2026-11-07");
});

// ── The wording ─────────────────────────────────────────────────────────────

Deno.test("the captain's wording is fixed, only whitespace normalised", () => {
  assertEquals(
    WEEKLY_REMINDER_TEMPLATE,
    "Hi {first_name},\n\nJust an update that we are still on track for your {work} on {date}. We will be in contact if there's changes or updates.\n\nLet us know if there are any questions or concerns!\n\nCheers,\nShaun",
  );
  assertEquals(
    DAY_BEFORE_REMINDER_TEMPLATE,
    "Hi {first_name},\nJust an update that we will be coming in tomorrow, {date} for your {work}. Our crew will be there between 7-10am, they will be in contact with you before coming.\n\nLet us know if there are any questions or concerns!\n\nCheers,\nShaun",
  );
});

Deno.test("the texts as sent: first name, 'Friday, 27 November', install or repair", () => {
  assertEquals(reminderDateWords("2026-11-27"), "Friday, 27 November");
  assertEquals(reminderDateWords("2026-12-01"), "Tuesday, 1 December");
  assertEquals(
    reminderMessage("weekly", "Jane Citizen", "2026-11-27", false),
    "Hi Jane,\n\nJust an update that we are still on track for your install on Friday, 27 November. We will be in contact if there's changes or updates.\n\nLet us know if there are any questions or concerns!\n\nCheers,\nShaun",
  );
  assertEquals(
    reminderMessage("day_before", "  Bob   Smith ", "2026-11-27", false),
    "Hi Bob,\nJust an update that we will be coming in tomorrow, Friday, 27 November for your install. Our crew will be there between 7-10am, they will be in contact with you before coming.\n\nLet us know if there are any questions or concerns!\n\nCheers,\nShaun",
  );
  const repair = reminderMessage("weekly", null, "2026-11-27", true);
  assertEquals(repair.startsWith("Hi there,\n"), true);
  assertEquals(
    repair.includes("for your repair on Friday, 27 November."),
    true,
  );
  assertEquals(repair.includes("install"), false);
  assertEquals(
    reminderMessage("day_before", "", "2026-11-27", true).includes(
      "tomorrow, Friday, 27 November for your repair.",
    ),
    true,
  );
});

// ── The prior-text scan ─────────────────────────────────────────────────────

Deno.test("a similar text: reminder wording, the work day's weekday, or its date", () => {
  const day = "2026-11-27"; // a Friday
  const cases: Array<[string, string | null]> = [
    [
      "Just a reminder your fence install is booked for next week",
      "wording:reminder",
    ],
    ["Just an update, we're still ON TRACK to be there", "wording:on track"],
    [
      "Hope you're well! Just letting you know we've got your patio install booked in",
      "wording:booked",
    ],
    ["We'll be coming in tomorrow", "wording:coming in"],
    ["See you tomorrow!", "wording:tomorrow"],
    ["The crew will be there Friday", "weekday:friday"],
    ["We'll see you on the 27th", `date:${day}`],
    ["Booked for 27 Nov", "wording:booked"],
    ["All set for 27 November", `date:${day}`],
    ["All set for November 27", `date:${day}`],
    ["All set for 27/11", `date:${day}`],
    ["Thanks for your payment, we've received your deposit", null],
    ["Your invoice INV-1270 is attached", null],
    ["We have 270 metres of sheeting", null],
    ["", null],
  ];
  for (const [msg, want] of cases) {
    assertEquals(similarReminderReason(msg, day), want, msg);
  }
});

Deno.test("the scan window: weekly reads the last 6 days, the day before reads today", () => {
  assertEquals(
    priorTextWindowStart("weekly", TODAY),
    "2026-11-06T16:00:00.000Z", // 00:00 on 7 Nov, Perth
  );
  assertEquals(
    priorTextWindowStart("day_before", TODAY),
    "2026-11-12T16:00:00.000Z", // 00:00 on 13 Nov, Perth
  );
  const texts = [
    { at: "2026-11-06T15:59:00Z", message: "reminder", source: "x" },
    { at: "2026-11-10T01:00:00Z", message: "Invoice attached", source: "y" },
  ];
  assertEquals(
    similarPriorText(
      texts,
      "2026-11-27",
      priorTextWindowStart("weekly", TODAY),
    ),
    null,
  );
  assertEquals(
    similarPriorText(
      [...texts, {
        at: "2026-11-09T01:00:00Z",
        message: "Booked in!",
        source: "z",
      }],
      "2026-11-27",
      priorTextWindowStart("weekly", TODAY),
    )?.reason,
    "wording:booked",
  );
});

// ── Bookings ────────────────────────────────────────────────────────────────

function work(date: string, extra: Record<string, unknown> = {}) {
  return {
    id: `a-${date}-${Math.random()}`,
    role: "lead_installer",
    status: "scheduled",
    assignment_type: "install",
    is_ghost: false,
    scheduled_date: date,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...extra,
  };
}

Deno.test("the first work day: the earliest crew install booking from today on", () => {
  assertEquals(
    firstWorkDay([
      work("2026-11-20", { is_ghost: true, role: "observer" }),
      work("2026-11-18", { status: "cancelled" }),
      work("2026-11-19", { assignment_type: "meeting" }),
      work("2026-11-19", { role: "observer" }),
      work("2026-11-27"),
      work("2026-11-25", { status: null }),
    ], TODAY),
    "2026-11-25",
  );
  // A booking before today on a job still in Scheduled is a stale one, never the day.
  assertEquals(
    firstWorkDay([
      work("2026-11-02", { status: "complete" }),
      work("2026-11-12"),
      work("2026-11-27"),
    ], TODAY),
    "2026-11-27",
  );
  assertEquals(firstWorkDay([work(TODAY), work("2026-11-27")], TODAY), TODAY);
  assertEquals(firstWorkDay([work("2026-11-12")], TODAY), null);
  assertEquals(
    firstWorkDay([work("2026-11-27", { status: "cancelled" })], TODAY),
    null,
  );
});

Deno.test("a booking made or changed today (Perth), cancelled ones too; a ghost row is not one", () => {
  const today = TODAY;
  assertEquals(bookingChangedOn([work("2026-11-27")], today), false);
  // 17:00 UTC on 12 Nov is 01:00 on 13 Nov in Perth.
  assertEquals(
    bookingChangedOn([
      work("2026-11-27", { updated_at: "2026-11-12T17:00:00Z" }),
    ], today),
    true,
  );
  assertEquals(
    bookingChangedOn([
      work("2026-11-27", { updated_at: "2026-11-12T15:00:00Z" }),
    ], today),
    false,
  );
  assertEquals(
    bookingChangedOn([
      work("2026-11-27", {
        created_at: "2026-11-13T03:00:00Z",
        status: "cancelled",
      }),
    ], today),
    true,
  );
  assertEquals(
    bookingChangedOn([
      work("2026-11-27", {
        updated_at: "2026-11-13T03:00:00Z",
        is_ghost: true,
      }),
    ], today),
    false,
  );
});

// ── The sweep ────────────────────────────────────────────────────────────────

function cand(
  id: string,
  bookings: any[],
  extra: Record<string, unknown> = {},
  parties: any[] = [],
  details: any = null,
): ReminderCandidate {
  return {
    job: {
      id,
      job_number: `SWF-${id}`,
      type: "fencing",
      status: "scheduled",
      metadata: {},
      client_name: "Jane Citizen",
      ghl_contact_id: `c-${id}`,
      ...extra,
    },
    details,
    bookings,
    parties,
  };
}

function harness(
  candidates: ReminderCandidate[] | null,
  opts: {
    mode?: "off" | "live";
    dayEvents?: any;
    shared?: boolean | null;
    prior?: Record<string, any[] | null>;
    claim?: "claimed" | "taken" | "failed";
    send?: (args: any) => any;
  } = {},
) {
  const calls: string[] = [];
  const sent: any[] = [];
  const finished: any[] = [];
  const runs: any[] = [];
  const claimed = new Set<string>();
  const deps: ScheduleReminderDeps = {
    now: () => NOON,
    readMode: () => Promise.resolve(opts.mode ?? "live"),
    loadCandidates: () => Promise.resolve(candidates),
    readJobDayEvents: (jobId) => {
      calls.push(`events:${jobId}`);
      return Promise.resolve(
        opts.dayEvents === undefined
          ? { booking_event: false, reschedule_text: false }
          : opts.dayEvents,
      );
    },
    readContactShared: (jobId) => {
      calls.push(`shared:${jobId}`);
      return Promise.resolve(opts.shared === undefined ? false : opts.shared);
    },
    readPriorTexts: (contactId, _jobId, since) => {
      calls.push(`prior:${contactId}:${since}`);
      const p = opts.prior?.[contactId];
      return Promise.resolve(p === undefined ? [] : p);
    },
    claim: (row) => {
      calls.push(`claim:${row.job_id}:${row.recipient_key}`);
      if (opts.claim) return Promise.resolve(opts.claim);
      const key = `${row.job_id}|${row.recipient_key}|${row.send_on}`;
      if (claimed.has(key)) return Promise.resolve("taken" as const);
      claimed.add(key);
      return Promise.resolve("claimed" as const);
    },
    finish: (row, outcome) => {
      calls.push(`finish:${row.recipient_key}:${outcome.status}`);
      finished.push({ row, outcome });
      return Promise.resolve();
    },
    sendSms: (args) => {
      calls.push(`send:${args.contactId}`);
      sent.push(args);
      return Promise.resolve(
        opts.send
          ? opts.send(args)
          : { ok: true, message_id: `m-${args.contactId}` },
      );
    },
    recordRun: (row) => {
      runs.push(row);
      return Promise.resolve();
    },
  };
  return { deps, calls, sent, finished, runs };
}

const LIVE = { dry_run: false };

Deno.test("switched off: a live run sends nothing and reads nothing", async () => {
  const h = harness([cand("1", [work("2026-11-27")])], { mode: "off" });
  const r = await jobScheduleReminderSweep(h.deps, LIVE);
  assertEquals(r.ran, false);
  assertEquals((r as any).reason, "switched_off");
  assertEquals(h.calls, []);
  assertEquals(h.runs, []);
});

Deno.test("a dry run (any call by hand) claims, sends and records nothing, even when switched off", async () => {
  const h = harness([cand("1", [work("2026-11-27")])], { mode: "off" });
  const r: any = await jobScheduleReminderSweep(h.deps, {});
  assertEquals(r.ran, true);
  assertEquals(r.dry_run, true);
  assertEquals(r.results[0].recipients[0].result, "would_send");
  assertEquals(
    r.results[0].recipients[0].message.includes("on Friday, 27 November."),
    true,
  );
  assertEquals(h.sent, []);
  assertEquals(h.finished, []);
  assertEquals(h.runs, []);
  assertEquals(h.calls.some((c) => c.startsWith("claim")), false);
});

Deno.test("live: the weekly text, claimed before the send, recorded after", async () => {
  const h = harness([cand("1", [work("2026-11-27"), work("2026-11-28")])]);
  const r: any = await jobScheduleReminderSweep(h.deps, LIVE);
  assertEquals(r.sent_count, 1);
  assertEquals(h.sent.length, 1);
  assertEquals(h.sent[0].contactId, "c-1");
  assertEquals(h.sent[0].jobId, "1");
  assertEquals(
    h.sent[0].message,
    reminderMessage("weekly", "Jane", "2026-11-27", false),
  );
  const order = h.calls.filter((c) => /^(claim|prior|send|finish)/.test(c));
  assertEquals(order, [
    "claim:1:c-1",
    "prior:c-1:2026-11-06T16:00:00.000Z",
    "send:c-1",
    "finish:c-1:sent",
  ]);
  assertEquals(h.finished[0].row.kind, "weekly");
  assertEquals(h.finished[0].row.work_day, "2026-11-27");
  assertEquals(h.finished[0].row.send_on, TODAY);
  assertEquals(h.finished[0].outcome.ghl_message_id, "m-c-1");
  assertEquals(h.runs.length, 1);
  assertEquals(h.runs[0].run_on, TODAY);
  assertEquals(h.runs[0].outcome, "ok");
  assertEquals(h.runs[0].sent_count, 1);
});

Deno.test("live: the day-before text for tomorrow's job (a Saturday send for a Sunday too)", async () => {
  const h = harness([cand("1", [work("2026-11-14")])]);
  await jobScheduleReminderSweep(h.deps, LIVE);
  assertEquals(
    h.sent[0].message,
    reminderMessage("day_before", "Jane", "2026-11-14", false),
  );
  assertEquals(h.calls.includes("prior:c-1:2026-11-12T16:00:00.000Z"), true);
});

Deno.test("a second run the same day finds the claim taken and sends nothing", async () => {
  const h = harness([cand("1", [work("2026-11-27")])]);
  await jobScheduleReminderSweep(h.deps, LIVE);
  const second: any = await jobScheduleReminderSweep(h.deps, LIVE);
  assertEquals(h.sent.length, 1);
  assertEquals(second.results[0].recipients[0].result, "already_claimed");
});

Deno.test("a failed claim sends nothing", async () => {
  const h = harness([cand("1", [work("2026-11-27")])], { claim: "failed" });
  const r: any = await jobScheduleReminderSweep(h.deps, LIVE);
  assertEquals(h.sent, []);
  assertEquals(r.results[0].recipients[0].result, "claim_failed");
  assertEquals(h.runs[0].outcome, "partial");
});

Deno.test("only jobs in Scheduled, fencing, patio and repairs; never make-safe or restoration", async () => {
  const h = harness([
    cand("fence", [work("2026-11-27")]),
    cand("patio", [work("2026-11-27")], { type: "patio" }),
    cand("materials", [work("2026-11-27")], { status: "order_materials" }),
    cand("progress", [work("2026-11-27")], { status: "in_progress" }),
    cand("makesafe", [work("2026-11-27")], { type: "makesafe" }),
    cand("restoration", [work("2026-11-27")], {
      type: "insurance",
      metadata: { insurance_job_type: "restoration" },
    }),
    cand("misc", [work("2026-11-27")], { type: "miscellaneous" }),
    cand("repair", [work("2026-11-27")], {
      type: "repair",
      status: "processing",
      metadata: { repair_stage: "scheduled" },
    }),
    cand("repair-early", [work("2026-11-27")], {
      type: "repair",
      status: "processing",
      metadata: { repair_stage: "materials" },
    }),
    // A repair-family card typed makesafe (update_makesafe_job_family never retypes).
    cand("repair-family", [work("2026-11-27")], {
      type: "makesafe",
      metadata: { makesafe_job_family: "repair", repair_stage: "scheduled" },
    }),
  ]);
  const r: any = await jobScheduleReminderSweep(h.deps, LIVE);
  const byJob = Object.fromEntries(
    r.results.map((x: any) => [x.job_id, x.action]),
  );
  assertEquals(byJob, {
    fence: "reminded",
    patio: "reminded",
    materials: "not_scheduled",
    progress: "not_scheduled",
    makesafe: "make_safe_board",
    restoration: "make_safe_board",
    misc: "not_reminded_type",
    repair: "reminded",
    "repair-early": "not_scheduled",
    "repair-family": "reminded",
  });
  assertEquals(h.sent.map((s) => s.jobId).sort(), [
    "fence",
    "patio",
    "repair",
    "repair-family",
  ]);
  const repairText = h.sent.find((s) => s.jobId === "repair").message;
  assertEquals(
    repairText.includes("for your repair on Friday, 27 November."),
    true,
  );
  assertEquals(
    h.sent.find((s) => s.jobId === "patio").message.includes("your install"),
    true,
  );
});

Deno.test("a stale past booking never hides the real day; on today, not due or none is not texted", async () => {
  const h = harness([
    cand("stale-complete", [
      work("2026-11-10", { status: "complete" }),
      work("2026-11-27"),
    ]),
    cand("stale-booking", [work("2026-11-12"), work("2026-11-20")]),
    cand("today", [work(TODAY), work("2026-11-14")]),
    cand("not-due", [work("2026-11-25")]),
    cand("only-past", [work("2026-11-12")]),
    cand("none", [work("2026-11-27", { status: "cancelled" })]),
  ]);
  const r: any = await jobScheduleReminderSweep(h.deps, LIVE);
  assertEquals(
    r.results.map((x: any) => [x.action, x.detail?.first_work_day ?? null]),
    [
      ["reminded", "2026-11-27"],
      ["reminded", "2026-11-20"],
      ["not_due", TODAY],
      ["not_due", "2026-11-25"],
      ["no_work_booking", null],
      ["no_work_booking", null],
    ],
  );
  assertEquals(h.sent.map((s) => s.jobId), ["stale-complete", "stale-booking"]);
  assertEquals(
    h.sent[1].message.includes("Friday, 20 November"),
    true,
  );
});

Deno.test("held the day a booking was made or moved, or a reschedule text went", async () => {
  const moved = harness([
    cand("1", [work("2026-11-27", { updated_at: "2026-11-13T01:00:00Z" })]),
  ]);
  const r1: any = await jobScheduleReminderSweep(moved.deps, LIVE);
  assertEquals(r1.results[0].action, "skipped_booking_changed_today");
  assertEquals(moved.sent, []);
  assertEquals(
    moved.finished[0].outcome.status,
    "skipped_booking_changed_today",
  );

  const created = harness([cand("1", [work("2026-11-27")])], {
    dayEvents: { booking_event: true, reschedule_text: false },
  });
  await jobScheduleReminderSweep(created.deps, LIVE);
  assertEquals(
    created.finished[0].outcome.status,
    "skipped_booking_changed_today",
  );

  const resched = harness([cand("1", [work("2026-11-27")])], {
    dayEvents: { booking_event: false, reschedule_text: true },
  });
  await jobScheduleReminderSweep(resched.deps, LIVE);
  assertEquals(
    resched.finished[0].outcome.status,
    "skipped_reschedule_text_today",
  );
  assertEquals(resched.sent, []);

  const unreadable = harness([cand("1", [work("2026-11-27")])], {
    dayEvents: null,
  });
  await jobScheduleReminderSweep(unreadable.deps, LIVE);
  assertEquals(
    unreadable.finished[0].outcome.status,
    "skipped_job_events_unreadable",
  );
  assertEquals(unreadable.sent, []);
});

Deno.test("a similar text already sent holds this one; an unreadable scan holds it too", async () => {
  const similar = harness([cand("1", [work("2026-11-27")])], {
    prior: {
      "c-1": [{
        at: "2026-11-10T02:00:00Z",
        message: "Just a reminder your fence install is booked for Friday",
        source: "business_events:client.sms_out",
      }],
    },
  });
  const r: any = await jobScheduleReminderSweep(similar.deps, LIVE);
  assertEquals(similar.sent, []);
  assertEquals(r.results[0].recipients[0].result, "skipped_similar_prior");
  assertEquals(similar.finished[0].outcome.reason, "wording:reminder");
  assertEquals(
    similar.finished[0].outcome.prior_source,
    "business_events:client.sms_out",
  );

  const unread = harness([cand("1", [work("2026-11-27")])], {
    prior: { "c-1": null },
  });
  await jobScheduleReminderSweep(unread.deps, LIVE);
  assertEquals(unread.sent, []);
  assertEquals(unread.finished[0].outcome.status, "skipped_prior_unreadable");

  const dry = harness([cand("1", [work("2026-11-27")])], {
    prior: {
      "c-1": [{
        at: "2026-11-12T02:00:00Z",
        message: "on track!",
        source: "s",
      }],
    },
  });
  const d: any = await jobScheduleReminderSweep(dry.deps, {});
  assertEquals(
    d.results[0].recipients[0].result,
    "would_skipped_similar_prior",
  );
});

Deno.test("a shared fence texts every paying party with their own contact, once each", async () => {
  const parties = [
    {
      id: "p-a",
      job_id: "1",
      contact_label: "A",
      is_primary: true,
      share_percentage: 50,
      removed_at: null,
      status: "active",
      client_name: "Jane Citizen",
      ghl_contact_id: null,
    },
    {
      id: "p-b",
      job_id: "1",
      contact_label: "B",
      is_primary: false,
      share_percentage: 50,
      removed_at: null,
      status: "active",
      client_name: "Neil Neighbour",
      ghl_contact_id: "c-neil",
    },
    {
      id: "p-c",
      job_id: "1",
      contact_label: "C",
      is_primary: false,
      share_percentage: 0,
      removed_at: null,
      status: "active",
      client_name: "Zero Share",
      ghl_contact_id: "c-zero",
    },
    {
      id: "p-d",
      job_id: "1",
      contact_label: "D",
      is_primary: false,
      share_percentage: 50,
      removed_at: "2026-10-01T00:00:00Z",
      status: "removed",
      client_name: "Gone",
      ghl_contact_id: "c-gone",
    },
    {
      id: "p-e",
      job_id: "1",
      contact_label: "E",
      is_primary: false,
      share_percentage: null,
      removed_at: null,
      status: "active",
      client_name: "No Contact",
      ghl_contact_id: null,
    },
  ];
  const h = harness([cand("1", [work("2026-11-27")], {}, parties)]);
  const r: any = await jobScheduleReminderSweep(h.deps, LIVE);
  assertEquals(h.sent.map((s) => [s.contactId, s.message.split(",")[0]]), [
    ["c-1", "Hi Jane"],
    ["c-neil", "Hi Neil"],
  ]);
  assertEquals(
    r.results[0].recipients.map((x: any) => x.result),
    ["sent", "sent", "no_contact"],
  );
  assertEquals(h.finished[2].row.recipient_key, "party:p-e");
});

Deno.test("no GHL contact: recorded as no_contact, nothing sent", async () => {
  const h = harness([
    cand("1", [work("2026-11-27")], { ghl_contact_id: null }),
  ]);
  await jobScheduleReminderSweep(h.deps, LIVE);
  assertEquals(h.sent, []);
  assertEquals(h.finished[0].outcome.status, "no_contact");
  assertEquals(h.finished[0].row.recipient_key, "owner");
});

Deno.test("a repair whose contact sits on other clients' jobs is held and flagged", async () => {
  const repair = cand("r", [work("2026-11-27")], {
    type: "repair",
    status: "scheduled",
  });
  const shared = harness([repair], { shared: true });
  const r: any = await jobScheduleReminderSweep(shared.deps, LIVE);
  assertEquals(shared.sent, []);
  assertEquals(r.results[0].action, "skipped_contact_shared");
  assertEquals(shared.finished[0].outcome.status, "skipped_contact_shared");

  const unread = harness([repair], { shared: null });
  await jobScheduleReminderSweep(unread.deps, LIVE);
  assertEquals(unread.sent, []);
  assertEquals(unread.finished[0].outcome.status, "skipped_contact_unreadable");

  // Fencing never asks the story read.
  const fence = harness([cand("f", [work("2026-11-27")])], { shared: true });
  await jobScheduleReminderSweep(fence.deps, LIVE);
  assertEquals(fence.calls.some((c) => c.startsWith("shared")), false);
  assertEquals(fence.sent.length, 1);
});

Deno.test("a refusal sent nothing; anything else is unconfirmed; neither is retried", async () => {
  const refused = harness([cand("1", [work("2026-11-27")])], {
    send: () => ({ ok: false, refused: true, error: "contact not on job" }),
  });
  const r: any = await jobScheduleReminderSweep(refused.deps, LIVE);
  assertEquals(r.results[0].recipients[0].result, "refused");
  assertEquals(refused.finished[0].outcome.status, "refused");
  assertEquals(refused.runs[0].outcome, "ok");

  const unsure = harness([cand("1", [work("2026-11-27")])], {
    send: () => ({ ok: false, refused: false, error: "timeout" }),
  });
  await jobScheduleReminderSweep(unsure.deps, LIVE);
  assertEquals(unsure.finished[0].outcome.status, "unconfirmed");
  assertEquals(unsure.runs[0].outcome, "partial");
  await jobScheduleReminderSweep(unsure.deps, LIVE);
  assertEquals(unsure.sent.length, 1);
});

Deno.test("candidates unreadable: a live run records a failed run and sends nothing", async () => {
  const h = harness(null);
  const r: any = await jobScheduleReminderSweep(h.deps, LIVE);
  assertEquals(r.ok, false);
  assertEquals(h.runs[0].outcome, "failed");
  assertEquals(h.sent, []);
});

// ── The action door ─────────────────────────────────────────────────────────

Deno.test("the action is server key only and POST only", async () => {
  const h = harness([cand("1", [work("2026-11-27")])]);
  assertEquals(
    (await runScheduleReminderAction("POST", LIVE, false, h.deps)).status,
    403,
  );
  assertEquals(
    (await runScheduleReminderAction("GET", LIVE, true, h.deps)).status,
    405,
  );
  assertEquals(h.sent, []);
  assertEquals(
    (await runScheduleReminderAction("POST", LIVE, true, h.deps)).status,
    200,
  );
  assertEquals(h.sent.length, 1);
});

// ── Reads and writes against a recording client ─────────────────────────────

function fakeClient(tables: Record<string, any>, log: any[] = []) {
  const builder = (table: string) => {
    const q: any = { table, filters: [] as any[] };
    const chain = new Proxy(q, {
      get(target, prop) {
        if (prop === "then") {
          const result = typeof tables[table] === "function"
            ? tables[table](target)
            : tables[table] ?? { data: [], error: null };
          return (res: any) => res(result);
        }
        return (...args: any[]) => {
          target.filters.push([String(prop), ...args]);
          if (prop === "insert" || prop === "update" || prop === "upsert") {
            log.push({ table, op: String(prop), args });
          }
          return chain;
        };
      },
    });
    return chain;
  };
  return {
    from: builder,
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

Deno.test("the switch reads only 'live' as on; anything else or a failed read is off", async () => {
  const at = (row: any) =>
    fakeClient({ job_closeout_settings: { data: row, error: null } });
  assertEquals(
    await readScheduleReminderMode(at({ schedule_reminder_mode: "live" })),
    "live",
  );
  assertEquals(
    await readScheduleReminderMode(at({ schedule_reminder_mode: "off" })),
    "off",
  );
  assertEquals(
    await readScheduleReminderMode(at({ schedule_reminder_mode: "dry_run" })),
    "off",
  );
  assertEquals(await readScheduleReminderMode(at(null)), "off");
  assertEquals(
    await readScheduleReminderMode(
      fakeClient({
        job_closeout_settings: { data: null, error: { message: "42703" } },
      }),
    ),
    "off",
  );
});

Deno.test("the candidate read never selects scope_json or pricing_json and pages bookings", async () => {
  const selects: string[] = [];
  const client = fakeClient({
    jobs: (q: any) => {
      selects.push(q.filters.find((f: any) => f[0] === "select")[1]);
      return {
        data: [{ id: "j1", type: "fencing", status: "scheduled" }],
        error: null,
      };
    },
    makesafe_job_details: { data: [], error: null },
    job_contacts: { data: [{ id: "p1", job_id: "j1" }], error: null },
    job_assignments: {
      data: [{ id: "a1", job_id: "j1", scheduled_date: "2026-11-27" }],
      error: null,
    },
  });
  const out = await loadScheduleReminderCandidates(client);
  assertEquals(out?.length, 1);
  assertEquals(out?.[0].parties.length, 1);
  assertEquals(out?.[0].bookings.length, 1);
  assertEquals(selects[0].includes("scope_json"), false);
  assertEquals(selects[0].includes("pricing_json"), false);

  const failing = fakeClient({
    jobs: { data: [{ id: "j1" }], error: null },
    job_contacts: { data: null, error: { message: "boom" } },
  });
  assertEquals(await loadScheduleReminderCandidates(failing), null);
});

Deno.test("the prior-text read: the contact's texts by their own time, the job's to that contact", async () => {
  const client = fakeClient({
    business_events: {
      data: [
        {
          event_type: "client.sms_out",
          event_at: "2026-11-10T01:00:00Z",
          occurred_at: "2026-11-13T01:00:00Z",
          body: "Booked!",
          msg: null,
          body_preview: "Booked!",
        },
        {
          event_type: "sms_sent",
          event_at: null,
          occurred_at: "2026-11-11T01:00:00Z",
          body: null,
          msg: "legacy text",
          body_preview: null,
        },
      ],
      error: null,
    },
    job_events: {
      data: [
        {
          created_at: "2026-11-12T01:00:00Z",
          detail_json: { contact_id: "c-1", message: "mine" },
        },
        {
          created_at: "2026-11-12T01:00:00Z",
          detail_json: { contact_id: "c-other", message: "neighbour's" },
        },
      ],
      error: null,
    },
  });
  const texts = await readScheduleReminderPriorTexts(
    client,
    "c-1",
    "j1",
    "2026-11-06T16:00:00.000Z",
  );
  assertEquals(texts?.map((t) => [t.at, t.message]), [
    ["2026-11-10T01:00:00Z", "Booked!"],
    ["2026-11-11T01:00:00Z", "legacy text"],
    ["2026-11-12T01:00:00Z", "mine"],
  ]);
  const broken = fakeClient({
    business_events: { data: null, error: { message: "timeout" } },
    job_events: { data: [], error: null },
  });
  assertEquals(
    await readScheduleReminderPriorTexts(broken, "c-1", "j1", "x"),
    null,
  );
  const remindersBroken = fakeClient({
    job_schedule_reminders: { data: null, error: { message: "timeout" } },
  });
  assertEquals(
    await readScheduleReminderPriorTexts(remindersBroken, "c-1", "j1", "x"),
    null,
  );
});

Deno.test("one contact on two jobs: the sweep's own text for one job never holds the other's", async () => {
  // A shared in-memory store: ghl-proxy writes the evidence row as it sends (even when
  // the sweep's wait for its answer times out), and the sweep records the outcome, the
  // message and the GHL message id on its claim row when it finishes.
  const smsOut: any[] = [];
  const reminderRows: any[] = [];
  const client = fakeClient({
    business_events: () => ({ data: [...smsOut], error: null }),
    job_events: { data: [], error: null },
    job_schedule_reminders: (q: any) => {
      const arg = (op: string, col: string) =>
        q.filters.find((f: any) => f[0] === op && f[1] === col)?.[2];
      return {
        data: reminderRows.filter((r) =>
          r.ghl_contact_id === arg("eq", "ghl_contact_id") &&
          r.job_id !== arg("neq", "job_id") &&
          arg("in", "status").includes(r.status)
        ),
        error: null,
      };
    },
  });
  const run = async (handSent: any[] = [], xTimesOut = false) => {
    smsOut.length = 0;
    reminderRows.length = 0;
    smsOut.push(...handSent);
    const h = harness([
      // x: weekly today (7 days out); y: day before (tomorrow). Same customer.
      cand("x", [work("2026-11-20")], { ghl_contact_id: "c-shared" }),
      cand("y", [work("2026-11-14")], { ghl_contact_id: "c-shared" }),
    ], {
      send: (args) =>
        xTimesOut && args.jobId === "x"
          ? { ok: false, refused: false, error: "timed out" }
          : { ok: true, message_id: `m-${args.jobId}` },
    });
    h.deps.readPriorTexts = (contactId, jobId, since) =>
      readScheduleReminderPriorTexts(client, contactId, jobId, since);
    const send = h.deps.sendSms;
    h.deps.sendSms = async (args) => {
      const res = await send(args);
      smsOut.push({
        event_type: "client.sms_out",
        event_at: NOON.toISOString(),
        occurred_at: NOON.toISOString(),
        provider_message_id: `ghl:${res.ok ? res.message_id : "late"}`,
        body: args.message,
      });
      return res;
    };
    const finish = h.deps.finish;
    h.deps.finish = async (row, outcome) => {
      reminderRows.push({
        ...row,
        status: outcome.status,
        message: outcome.message ?? null,
        ghl_message_id: outcome.ghl_message_id ?? null,
      });
      await finish(row, outcome);
    };
    const r: any = await jobScheduleReminderSweep(h.deps, LIVE);
    return { h, r };
  };

  const both = await run();
  assertEquals(both.h.sent.map((s) => s.jobId), ["x", "y"]);
  assertEquals(
    both.r.results.map((x: any) => x.recipients[0].result),
    ["sent", "sent"],
  );

  // x's text went but its answer timed out (unconfirmed, no GHL message id): its words
  // still mark it as the sweep's own, so y is texted.
  const late = await run([], true);
  assertEquals(late.h.sent.map((s) => s.jobId), ["x", "y"]);
  assertEquals(
    late.r.results.map((x: any) => x.recipients[0].result),
    ["unconfirmed", "sent"],
  );

  // A hand-sent text that is not one of the sweep's reminders still counts.
  const hand = await run([{
    event_type: "client.sms_out",
    event_at: "2026-11-13T01:00:00Z",
    occurred_at: "2026-11-13T01:00:00Z",
    provider_message_id: "ghl:hand-1",
    body: "See you tomorrow for the install!",
  }]);
  assertEquals(hand.h.sent.map((s) => s.jobId), []);
  assertEquals(
    hand.r.results.map((x: any) => x.recipients[0].result),
    ["skipped_similar_prior", "skipped_similar_prior"],
  );
});

Deno.test("today's booking events: a ghost watcher mirror's event is not a booking change", async () => {
  const at = (events: any[], reschedules = 0) =>
    fakeClient({
      job_events: { data: events, error: null },
      email_events: { data: null, count: reschedules, error: null },
    });
  const read = (client: any) =>
    readScheduleReminderJobDayEvents(client, "j1", perthDayStart(TODAY));
  assertEquals(await read(at([])), {
    booking_event: false,
    reschedule_text: false,
  });
  assertEquals(await read(at([{ source: "ghost_auto_mirror" }])), {
    booking_event: false,
    reschedule_text: false,
  });
  assertEquals(
    await read(at([{ source: "ghost_auto_mirror" }, { source: null }])),
    { booking_event: true, reschedule_text: false },
  );
  assertEquals(await read(at([], 1)), {
    booking_event: false,
    reschedule_text: true,
  });
  assertEquals(
    await read(fakeClient({
      job_events: { data: null, error: { message: "timeout" } },
    })),
    null,
  );
});

Deno.test("the claim is an insert that skips a conflict on job, recipient and day", async () => {
  const log: any[] = [];
  const row = {
    job_id: "j1",
    recipient_key: "c-1",
    send_on: TODAY,
    kind: "weekly" as const,
    work_day: "2026-11-27",
    ghl_contact_id: "c-1",
    job_contact_id: null,
  };
  const won = fakeClient({
    job_schedule_reminders: { data: [{ id: "x" }], error: null },
  }, log);
  assertEquals(await claimScheduleReminder(won, row, NOON), "claimed");
  assertEquals(log[0].op, "upsert");
  assertEquals(log[0].args[0].status, "claimed");
  assertEquals(log[0].args[1], {
    onConflict: "job_id,recipient_key,send_on",
    ignoreDuplicates: true,
  });
  const lost = fakeClient({
    job_schedule_reminders: { data: [], error: null },
  });
  assertEquals(await claimScheduleReminder(lost, row, NOON), "taken");
  const broke = fakeClient({
    job_schedule_reminders: { data: null, error: { message: "x" } },
  });
  assertEquals(await claimScheduleReminder(broke, row, NOON), "failed");
});

Deno.test("an outcome writes the claim row, one job event and, for a text, one email_events row", async () => {
  const row = {
    job_id: "j1",
    recipient_key: "c-1",
    send_on: TODAY,
    kind: "day_before" as const,
    work_day: "2026-11-14",
    ghl_contact_id: "c-1",
    job_contact_id: null,
  };
  const log: any[] = [];
  await finishScheduleReminder(
    fakeClient({}, log),
    row,
    { status: "sent", message: "Hi", ghl_message_id: "m1" },
    NOON,
  );
  assertEquals(log.map((l) => `${l.table}:${l.op}`), [
    "job_schedule_reminders:update",
    "job_events:insert",
    "email_events:insert",
  ]);
  assertEquals(log[1].args[0].event_type, "schedule_reminder");
  assertEquals(log[2].args[0].comms_trigger, SCHEDULE_REMINDER_COMMS_TRIGGER);
  assertEquals(log[2].args[0].status, "sent");
  assertEquals(log[2].args[0].comms_channel, "sms");

  const skipLog: any[] = [];
  await finishScheduleReminder(fakeClient({}, skipLog), row, {
    status: "skipped_contact_shared",
  }, NOON);
  assertEquals(skipLog.map((l) => `${l.table}:${l.op}`), [
    "job_schedule_reminders:update",
    "job_events:insert",
  ]);
  assertEquals(skipLog[1].args[0].detail_json.flag, "contact_shared");

  const failLog: any[] = [];
  await finishScheduleReminder(fakeClient({}, failLog), row, {
    status: "unconfirmed",
    reason: "timeout",
  }, NOON);
  assertEquals(failLog[2].args[0].status, "failed");
  assertEquals(failLog[2].args[0].failure_reason, "timeout");
});
