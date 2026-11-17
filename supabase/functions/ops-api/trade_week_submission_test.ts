// P1-16.3: the real send door, with invented identities and money only.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CARD, card, JOB, send } from "./trade_week_submission_test_harness.ts";

const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

test("week send: matching, changed and unclocked hours retain the server suggestion", async () => {
  for (
    const [hours, clocked, changed] of [[7.5, true, false], [9, true, true], [
      9,
      false,
      null,
    ]] as const
  ) {
    const result = await send({
      cards: [card(
        clocked
          ? {}
          : { clocked_on_at: null, clocked_off_at: null, hours_worked: null },
      )],
      body: {
        manual_assignments: [{
          assignment_id: CARD,
          hours,
          suggested: { hours: 99 },
        }],
      },
    });
    assertEquals(result.status, 200, JSON.stringify(result.response));
    assertEquals(result.lines[0].changed_from_suggestion, changed);
    assertEquals(result.lines[0].suggested.hours, clocked ? 7.5 : null);
    assertEquals(result.lines[0].total_hours, hours);
    assertEquals(result.invoices[0].accepted_untouched, changed === false);
    assertEquals(result.invoices[0].confirm_seconds, 1);
    assertEquals(result.marks, [{ p_job_id: JOB, p_source: "trade_invoice" }]);
  }
});

test("week send: booked and added hourly work use the office rate and profile GST", async () => {
  for (const added of [false, true]) {
    const result = await send({
      cards: added
        ? [
          card({
            status: "scheduled",
            hours_worked: null,
            clocked_on_at: null,
            clocked_off_at: null,
          }),
        ]
        : [card()],
      body: added
        ? {
          manual_assignments: [],
          extra_items: [{
            type: "Labour",
            row_type: "labour",
            job_id: JOB,
            job_number: "ZZTEST-163",
            description: "ZZTEST work",
            quantity: 7.5,
            rate: 41,
            date: "2026-11-03",
          }],
        }
        : {
          manual_assignments: [{
            assignment_id: CARD,
            hours: 7.5,
            rate: 41,
            rate_source: "client_entered",
          }],
        },
    });
    assertEquals(result.status, 200, JSON.stringify(result.response));
    assertEquals(result.lines[0].line_total_ex, 300);
    assertEquals(result.lines[0].sent_values.typed_rate, 41);
    assertEquals(
      result.lines[0].office_review_note,
      "Rate is set by the office",
    );
    assertEquals(result.invoices[0].gst, 0);
    if (added) {
      assertEquals(result.lines[0].suggested, { source: "added_by_trade" });
    }
  }
});

test("week send: a rate change takes effect on its work day and leaves one line per card", async () => {
  const result = await send({
    cards: [card(), card({ id: "next", scheduled_date: "2026-11-04" })],
    rates: [{
      hourly_rate: 48,
      effective_from: "2026-11-04",
      effective_to: null,
    }, {
      hourly_rate: 40,
      effective_from: "2026-01-01",
      effective_to: "2026-11-03",
    }],
    body: {
      manual_assignments: [{ assignment_id: CARD, hours: 7.5 }, {
        assignment_id: "next",
        hours: 7.5,
      }],
    },
  });
  assertEquals(result.status, 200, JSON.stringify(result.response));
  assertEquals(result.lines.map((l) => l.line_total_ex), [300, 360]);
  assertEquals(result.marks.length, 1);
});

test("week send: omitted cards, failed reads, office changes and retry do not invent untouched acceptance", async () => {
  const omitted = await send({ cards: [card(), card({ id: "omitted" })] });
  assertEquals(omitted.invoices[0].accepted_untouched, false);
  const missing = await send({ rates: [] });
  assertEquals(missing.status, 422);
  assertEquals(missing.invoices.length, 0);
  const unavailable = await send({ fail: "history" });
  assertEquals(unavailable.status, 200);
  assertEquals(unavailable.invoices[0].accepted_untouched, false);
  const markFailure = await send({ fail: "mark" });
  assertEquals(markFailure.status, 200);
  for (const fail of ["rates", "profile"] as const) {
    const refused = await send({ fail });
    assert(refused.status >= 400);
    assertEquals(refused.invoices.length, 0);
    const retry = await send({
      rates: [{
        hourly_rate: 44,
        effective_from: "2026-01-01",
        effective_to: null,
      }],
      gstRegistered: true,
    });
    assertEquals(retry.status, 200);
    assertEquals(retry.lines[0].line_total_ex, 330);
    assertEquals(retry.invoices[0].gst > 0, true);
  }
});

// Both send doors share GST authority and mark only after durable local storage.
test("work-order send: profile GST and one non-blocking job mark survive a mark fault", async () => {
  for (const on of [false, true]) {
    const result = await send({
      action: "submit_work_order_invoice",
      on,
      xero: true,
      fail: "mark",
      body: { work_order_id: "00000000-0000-4000-8000-000000000036" },
    });
    assertEquals(result.status, 200, JSON.stringify(result.response));
    assertEquals(result.invoices[0].gst, on ? 0 : 30);
    assertEquals(
      result.marks,
      on ? [{ p_job_id: JOB, p_source: "trade_invoice" }] : [],
    );
  }
});
