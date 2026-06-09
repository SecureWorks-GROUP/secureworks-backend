import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _deriveMakesafeBoardStage,
  _normalizeMakesafeSubstatus,
  _isMakesafeCompletedThisWeek,
} from "./index.ts";

Deno.test("MakeSafe board normalizes legacy pending_allocation to company_contact_required", () => {
  assertEquals(
    _normalizeMakesafeSubstatus("pending_allocation"),
    "company_contact_required",
  );
});

Deno.test("MakeSafe board keeps admin_to_send_report in report_ready before invoice handoff", () => {
  const job = { status: "complete" };
  const detail = {
    substatus: "admin_to_send_report",
    report_received_at: "2026-06-07T01:00:00Z",
  };
  const report = { status: "submitted" };

  assertEquals(
    _deriveMakesafeBoardStage(job, detail, [], report, null),
    "report_ready",
  );
});

Deno.test("MakeSafe board keeps legacy ready_to_invoice in report_ready until completion", () => {
  const job = { status: "complete" };
  const detail = {
    substatus: "ready_to_invoice",
    report_received_at: "2026-06-07T01:00:00Z",
    report_sent_at: "2026-06-07T02:00:00Z",
  };

  assertEquals(_deriveMakesafeBoardStage(job, detail), "report_ready");
});

Deno.test("MakeSafe board uses New, Allocated, Report Ready, Completed This Week, Archive", () => {
  assertEquals(
    _deriveMakesafeBoardStage({ status: "accepted" }, {
      substatus: "company_contact_required",
    }),
    "new",
  );
  assertEquals(
    _deriveMakesafeBoardStage({ status: "accepted" }, {
      substatus: "company_contact_done",
    }),
    "allocated",
  );
  assertEquals(
    _deriveMakesafeBoardStage({ status: "scheduled" }, {
      substatus: "waiting_on_trade_report",
    }, [{ user_id: "u1" }]),
    "allocated",
  );
  assertEquals(
    _deriveMakesafeBoardStage(
      { status: "invoiced", completed_at: "2026-06-09T02:00:00Z" },
      { substatus: "complete" },
      [],
      null,
      { status: "AUTHORISED", invoice_date: "2026-06-09" },
      "2026-06-09T03:00:00Z",
    ),
    "completed",
  );
  assertEquals(
    _deriveMakesafeBoardStage(
      { status: "invoiced", completed_at: "2026-06-01T02:00:00Z" },
      { substatus: "complete" },
      [],
      null,
      { status: "AUTHORISED", invoice_date: "2026-06-01" },
      "2026-06-09T03:00:00Z",
    ),
    "archive",
  );
});

Deno.test("MakeSafe completed-this-week uses Perth calendar week", () => {
  assertEquals(_isMakesafeCompletedThisWeek("2026-06-08T00:30:00Z", "2026-06-09T03:00:00Z"), true);
  assertEquals(_isMakesafeCompletedThisWeek("2026-06-07T16:00:00Z", "2026-06-09T03:00:00Z"), true); // Monday 8 June in Perth
  assertEquals(_isMakesafeCompletedThisWeek("2026-06-07T14:30:00Z", "2026-06-09T03:00:00Z"), false); // Sunday 7 June in Perth
});
