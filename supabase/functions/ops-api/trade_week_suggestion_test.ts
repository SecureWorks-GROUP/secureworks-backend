import "./trade_app_visibility_rules_test_env.ts";
import { myHours } from "./index.ts";
import { assertEquals } from "jsr:@std/assert@1";
import {
  addWeekSuggestions,
  suggestCardHours,
  usualDay,
  weekSummary,
} from "./trade_week_suggestion.ts";

const today = "2026-12-09";
const card = (extra = {}) => ({
  scheduled_date: "2026-12-07",
  invoice_mode: "hourly",
  ...extra,
});
const clock = card({
  clocked_on_at: "2026-12-06T23:02:00Z",
  clocked_off_at: "2026-12-07T07:31:00Z",
  break_minutes: 30,
  hours_worked: 8,
});
const usual = { length_hours: 8, break_minutes: 30 };

Deno.test("suggestions use confirmed times, clocks, a missed clock off, no clock, or the work order", () => {
  const logged = {
    work_date: "2026-12-08",
    start_time: "06:30",
    finish_time: "14:30",
    break_minutes: 30,
    hours: 7.5,
  };
  assertEquals(
    suggestCardHours({ ...clock, logged_time_entry: logged }, usual, today),
    { ...logged, source: "clock", complete: true },
  );
  assertEquals(suggestCardHours(clock, usual, today), {
    source: "clock",
    work_date: "2026-12-07",
    start_time: "07:00",
    finish_time: "15:30",
    break_minutes: 30,
    hours: 8,
    complete: true,
  });
  assertEquals(
    suggestCardHours(
      card({ clocked_on_at: "2026-12-06T23:00:00Z" }),
      usual,
      today,
    ),
    {
      source: "clock_no_off",
      work_date: "2026-12-07",
      start_time: "07:00",
      finish_time: "15:30",
      break_minutes: 30,
      hours: 8,
      complete: true,
    },
  );
  assertEquals(suggestCardHours(card(), usual, today), {
    source: "none",
    work_date: "2026-12-07",
    start_time: null,
    finish_time: null,
    break_minutes: null,
    hours: null,
    complete: false,
  });
  assertEquals(
    suggestCardHours(
      card({ invoice_mode: "work_order", work_order_agreed_ex: 240 }),
      usual,
      today,
    ),
    { source: "work_order", amount_ex: 240, complete: true },
  );
  assertEquals(
    suggestCardHours(
      card({ invoice_mode: "work_order", work_order_agreed_ex: null }),
      usual,
      today,
    ).complete,
    false,
  );
  assertEquals(
    suggestCardHours(
      card({ scheduled_date: today, clocked_on_at: "2026-12-08T23:00:00Z" }),
      usual,
      today,
    ).complete,
    false,
  );
  assertEquals(
    suggestCardHours(
      card({ clocked_on_at: "2026-12-07T14:00:00Z" }),
      usual,
      today,
    ).finish_time,
    "23:55",
  );
});

Deno.test("usual day uses the last ten complete clocks, defaults before three, and takes median and modal break", () => {
  assertEquals(usualDay([clock, clock]), usual);
  assertEquals(
    usualDay(
      [6, 9, 7, 10, 8].map((hours_worked, i) => ({
        ...clock,
        hours_worked,
        break_minutes: i < 3 ? 20 : 30,
      })),
    ),
    { length_hours: 8, break_minutes: 20 },
  );
});

Deno.test("week acceptance requires complete current cards, known modes and rate; pay date and streak are bounded", () => {
  const cards = [clock, clock, clock].map((c) => ({
    ...c,
    suggestion: suggestCardHours(c, usual, today),
  }));
  const summary = weekSummary(cards, {
    today,
    weekStart: "2026-12-07",
    now: "2026-12-09T00:00:00Z",
    rateResolved: true,
    payRunOn: true,
    streak: 3,
  });
  assertEquals([
    summary.fully_clocked,
    summary.can_accept_in_one_press,
    summary.lines_ready,
    summary.pay_day,
  ], [true, true, 3, "2026-12-18"]);
  const missing = {
    ...card(),
    suggestion: suggestCardHours(card(), usual, today),
  };
  const needs = weekSummary([...cards, missing], {
    today,
    weekStart: "2026-12-07",
    now: "2026-12-14T00:00:00Z",
    rateResolved: true,
    payRunOn: true,
    streak: 0,
  });
  assertEquals([
    needs.can_accept_in_one_press,
    needs.show_clock_tip,
    needs.lines_need_hours,
    needs.pay_day,
  ], [false, true, 1, "2026-12-25"]);
  assertEquals(
    weekSummary(cards, {
      today,
      weekStart: "2026-12-07",
      now: "2026-12-09T00:00:00Z",
      rateResolved: false,
      payRunOn: false,
      streak: 0,
    }).can_accept_in_one_press,
    false,
  );
});

Deno.test("off preserves the response and makes no extra reads; failed reads fall back; office changes and retries are reread", async () => {
  const response = {
    assignments: [clock],
    trade_rate_editable: true,
    rate_resolved: true,
    week_start: "2026-12-07",
    week_ending: "2026-12-13",
  };
  let reads = 0;
  let fail = false;
  const client = {
    from(table: string) {
      reads++;
      const query: any = {
        select: () => query,
        neq: () => query,
        eq: () => query,
        not: () => query,
        lte: () => query,
        gte: () => query,
        gt: () => query,
        in: () => query,
        order: () => query,
        limit: () => query,
        then(resolve: any) {
          return Promise.resolve({
            data: table === "job_assignments"
              ? [clock, clock, clock]
              : table === "group_work_order_time_entries"
              ? [{ group_id: "group", user_id: "trade" }, {
                group_id: "office-group",
                user_id: "trade",
              }]
              : [{ week_start: "2026-11-30", accepted_untouched: true }],
            error: fail ? { code: "test_read_failed" } : null,
          }).then(resolve);
        },
      };
      return query;
    },
  };
  assertEquals(
    await addWeekSuggestions(client, response, {
      enabled: false,
      userId: "trade",
      gstRegistered: false,
      groupAllJobs: false,
      payRunOn: false,
      now: "2026-12-09T00:00:00Z",
      groups: [],
    }),
    response,
  );
  assertEquals(reads, 0);
  const opts = {
    enabled: true,
    userId: "trade",
    gstRegistered: false,
    groupAllJobs: false,
    payRunOn: false,
    now: "2026-12-09T00:00:00Z",
    groups: [],
  };
  fail = true;
  assertEquals(await addWeekSuggestions(client, response, opts), response);
  fail = false;
  const first = await addWeekSuggestions(client, response, opts);
  assertEquals(first.week_summary.can_accept_in_one_press, true);
  assertEquals(first.gst_on, false);
  assertEquals(first.trade_rate_editable, false);
  const grouped = await addWeekSuggestions(client, response, {
    ...opts,
    groups: [
      {
        id: "group",
        status: "open",
        claim_state: "waiting_hours",
        group_work_order_participants: [{ user_id: "trade" }, {
          user_id: "crew",
        }],
      },
      {
        id: "office-group",
        status: "open",
        claim_state: "with_office",
        group_work_order_participants: [{ user_id: "trade" }],
      },
    ],
  });
  assertEquals([
    grouped.week_summary.waiting_on_crew,
    grouped.week_summary.waiting_on_office,
  ], [1, 1]);

  const changed = await addWeekSuggestions(client, {
    ...response,
    assignments: [{ ...clock, hours_worked: 6 }],
  }, opts);
  assertEquals(changed.assignments[0].suggestion.hours, 6);
  assertEquals(
    (await addWeekSuggestions(client, response, opts)).assignments[0].suggestion
      .hours,
    8,
  );
});

function handlerClient(
  enabled: boolean,
  failHistory = false,
  failGroup = false,
  entries: any[] | null = null,
  failEntries = false,
) {
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag_name: "trade_week_autofill_v1", enabled }],
    users: [{
      id: "trade",
      org_id: "org",
      invoice_type: "hourly",
      trade_details: { gstRegistered: false },
    }],
    jobs: [{
      id: "job",
      org_id: "org",
      type: "makesafe",
      metadata: {},
      work_order_id: null,
    }],
    job_assignments: [{
      ...clock,
      id: "card",
      user_id: "trade",
      job_id: "job",
      status: "complete",
      invoiced_in: null,
      jobs: { id: "job", type: "makesafe", job_number: "ZZTEST-1" },
    }],
    group_work_orders: entries === null ? [] : [{
      id: "group",
      job_id: "job",
      status: "open",
      claim_state: "waiting_hours",
      group_work_order_participants: [{ user_id: "trade" }, {
        user_id: "crew",
      }],
    }],
    group_work_order_time_entries: entries || [],
    trade_rates: [{
      user_id: "trade",
      hourly_rate: 40,
      effective_from: "2026-01-01",
      effective_to: null,
    }],
  };
  return {
    from(table: string) {
      let cols = "";
      const filters: Array<(row: any) => boolean> = [];
      let cap = Infinity;
      const result = () => ({
        data: (tables[table] || []).filter((row) =>
          filters.every((f) => f(row))
        ).slice(0, cap),
        error: (failEntries && table === "group_work_order_time_entries") ||
            (failGroup && cols.includes("claim_state")) || failHistory &&
            cols ===
              "clocked_on_at, clocked_off_at, hours_worked, break_minutes"
          ? { code: "read_failed" }
          : null,
      });
      const q: any = {
        select(value: string) {
          cols = value;
          return q;
        },
        neq(key: string, value: any) {
          filters.push((row) => row[key] !== value);
          return q;
        },
        eq(key: string, value: any) {
          filters.push((row) => row[key] === value);
          return q;
        },
        in(key: string, value: any[]) {
          filters.push((row) => value.includes(row[key]));
          return q;
        },
        gte(key: string, value: any) {
          filters.push((row) => row[key] >= value);
          return q;
        },
        lte(key: string, value: any) {
          filters.push((row) => row[key] <= value);
          return q;
        },
        not(key: string, op: string, value: any) {
          filters.push((row) =>
            op === "is"
              ? row[key] != null
              : !String(value).includes(String(row[key]))
          );
          return q;
        },
        gt(key: string, value: any) {
          filters.push((row) => row[key] > value);
          return q;
        },
        order: () => q,
        limit(value: number) {
          cap = value;
          return q;
        },
        or: () => q,
        maybeSingle() {
          const r = result();
          return Promise.resolve({ ...r, data: r.data[0] || null });
        },
        then(resolve: any, reject: any) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return q;
    },
  };
}
Deno.test("my_hours serves suggestions on, preserves the off response, and returns the old view on history failure", async () => {
  const params = new URLSearchParams({ week_ending: "2026-12-13" });
  const off = await myHours(handlerClient(false), "trade", params);
  const on = await myHours(handlerClient(true), "trade", params);
  assertEquals("week_summary" in off, false);
  assertEquals(on.assignments[0].suggestion.hours, 8);
  assertEquals(on.assignments[0].amount, off.assignments[0].amount);
  assertEquals(on.money, off.money);
  assertEquals(on.trade_rate_editable, false);
  assertEquals(await myHours(handlerClient(true, true), "trade", params), off);
  assertEquals(
    await myHours(handlerClient(true, false, true), "trade", params),
    off,
  );
});

Deno.test("my_hours counts only this week's positive crew entries and falls back on unreadable or capped confirmation", async () => {
  const params = new URLSearchParams({ week_ending: "2026-12-13" });
  const own = {
    group_id: "group",
    user_id: "trade",
    work_date: "2026-12-07",
    hours: 8,
  };
  const prior = {
    group_id: "group",
    user_id: "crew",
    work_date: "2026-12-06",
    hours: 8,
  };
  const rows = [own, prior];
  const off = await myHours(
    handlerClient(false, false, false, rows),
    "trade",
    params,
  );
  const waiting = await myHours(
    handlerClient(true, false, false, rows),
    "trade",
    params,
  );
  assertEquals(waiting.week_summary.waiting_on_crew, 1);
  assertEquals("group_work_order_time_entries" in waiting, false);
  assertEquals(
    "group_work_order_time_entries" in waiting.group_route_jobs[0],
    false,
  );
  const read = (entries: any[]) =>
    myHours(handlerClient(true, false, false, entries), "trade", params);
  // Both ends of the week are inclusive; later weeks and zero hours do not confirm.
  assertEquals(
    (await read([own, { ...prior, work_date: "2026-12-13" }])).week_summary
      .waiting_on_crew,
    0,
  );
  assertEquals(
    (await read([own, { ...prior, work_date: "2026-12-14" }])).week_summary
      .waiting_on_crew,
    1,
  );
  assertEquals(
    (await read([own, { ...prior, work_date: "2026-12-08", hours: 0 }]))
      .week_summary.waiting_on_crew,
    1,
  );
  assertEquals(
    (await read([{ ...own, work_date: "2026-12-06" }, prior])).week_summary
      .waiting_on_crew,
    0,
  );
  assertEquals(
    await myHours(
      handlerClient(true, false, false, rows, true),
      "trade",
      params,
    ),
    off,
  );
  assertEquals(await read(Array.from({ length: 1000 }, () => own)), off);
  // Retrying after the fault or an office date correction reads current records.
  assertEquals((await read(rows)).week_summary.waiting_on_crew, 1);
  assertEquals(
    (await read([own, { ...prior, work_date: "2026-12-07" }])).week_summary
      .waiting_on_crew,
    0,
  );
});
