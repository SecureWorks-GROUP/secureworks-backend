import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _deriveMakesafeBoardStage,
  _normalizeMakesafeSubstatus,
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

Deno.test("MakeSafe board promotes ready_to_invoice to to_invoice", () => {
  const job = { status: "complete" };
  const detail = {
    substatus: "ready_to_invoice",
    report_received_at: "2026-06-07T01:00:00Z",
    report_sent_at: "2026-06-07T02:00:00Z",
  };

  assertEquals(_deriveMakesafeBoardStage(job, detail), "to_invoice");
});

Deno.test("MakeSafe board uses five business stages from intake through completion", () => {
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
      { status: "invoiced" },
      { substatus: "complete" },
      [],
      null,
      { status: "AUTHORISED" },
    ),
    "completed",
  );
});
