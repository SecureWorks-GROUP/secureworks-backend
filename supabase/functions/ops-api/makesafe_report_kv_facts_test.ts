import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  countAssignmentsForCrewLine,
  deriveMakesafeReportArrival,
  deriveMakesafeReportCrewLabel,
  enrichMakesafeReportJobKvFacts,
  makesafeReportAttendanceTime,
  makesafeReportTradeCountLabel,
} from "./makesafe_report_kv_facts.ts";
import { renderMakesafeReportPdf } from "./makesafe_report_render.ts";

Deno.test("trade count label is honest about empty and invalid counts", () => {
  assertEquals(makesafeReportTradeCountLabel(2), "2 trades");
  assertEquals(makesafeReportTradeCountLabel(1), "1 trade");
  assertEquals(makesafeReportTradeCountLabel("2"), "2 trades");
  assertEquals(makesafeReportTradeCountLabel(0), "");
  assertEquals(makesafeReportTradeCountLabel(null), "");
  assertEquals(makesafeReportTradeCountLabel(""), "");
  assertEquals(makesafeReportTradeCountLabel(1.5), "");
  assertEquals(makesafeReportTradeCountLabel(-1), "");
});

Deno.test("assignment count only counts person-bearing non-cancelled rows", () => {
  assertEquals(
    countAssignmentsForCrewLine([
      { status: "complete", crew_name: "Field A", user_id: "u1" },
      { status: "complete", users: { name: "Field B" }, user_id: "u2" },
      { status: "cancelled", crew_name: "Gone", user_id: "u3" },
      { status: "complete" }, // shell with no person
    ]),
    2,
  );
  assertEquals(countAssignmentsForCrewLine([]), 0);
  assertEquals(countAssignmentsForCrewLine(null), 0);
});

Deno.test("crew label prefers valid supplied trade-count form", () => {
  assertEquals(
    deriveMakesafeReportCrewLabel({
      supplied: "2 trades",
      tradeCount: 1,
      assignmentCount: 1,
    }),
    "2 trades",
  );
});

Deno.test("crew label recovers trade_count when supplied crew is blank", () => {
  assertEquals(
    deriveMakesafeReportCrewLabel({
      supplied: "",
      tradeCount: 2,
      assignments: [],
    }),
    "2 trades",
  );
});

Deno.test("crew label recovers assignment count when trade_count is absent", () => {
  assertEquals(
    deriveMakesafeReportCrewLabel({
      supplied: "",
      tradeCount: null,
      assignments: [
        { status: "complete", crew_name: "Field A", user_id: "u1" },
        { status: "complete", users: { name: "Field B" }, user_id: "u2" },
      ],
    }),
    "2 trades",
  );
});

Deno.test("crew label never invents a count or a name when evidence is empty", () => {
  assertEquals(
    deriveMakesafeReportCrewLabel({
      supplied: "",
      tradeCount: null,
      assignments: [],
    }),
    "",
  );
  // A personal name with no countable evidence is returned unchanged so the
  // curated gate can refuse it rather than inventing "1 trade".
  assertEquals(
    deriveMakesafeReportCrewLabel({
      supplied: "Field Person",
      tradeCount: null,
      assignments: [],
    }),
    "Field Person",
  );
});

Deno.test("crew label recovers recorded count even when supplied value is a name", () => {
  // Real SWMS-26845 shape: assignments exist, trade_count is 2, but a producer
  // that preferred crew_name would have put a personal name in the field.
  assertEquals(
    deriveMakesafeReportCrewLabel({
      supplied: "Hugo",
      tradeCount: 2,
      assignments: [
        { status: "complete", crew_name: "Hugo", user_id: "u1" },
        { status: "complete", users: { name: "Anthony" }, user_id: "u2" },
      ],
    }),
    "2 trades",
  );
});

Deno.test("attendance time extracts HH:MM without inventing", () => {
  assertEquals(makesafeReportAttendanceTime("2026-06-30 14:00"), "14:00");
  assertEquals(makesafeReportAttendanceTime("2026-06-30T14:00:00+08:00"), "14:00");
  assertEquals(makesafeReportAttendanceTime("08:30"), "08:30");
  assertEquals(makesafeReportAttendanceTime(""), "");
  assertEquals(makesafeReportAttendanceTime(null), "");
});

Deno.test("arrival derivation falls through checklist then assignment", () => {
  assertEquals(
    deriveMakesafeReportArrival({
      supplied: "",
      checklistArrival: "2026-06-30 14:00",
      assignmentArrivedAt: "09:00",
    }),
    "14:00",
  );
  assertEquals(
    deriveMakesafeReportArrival({
      supplied: "",
      checklistArrival: "",
      assignmentArrivedAt: "2026-07-01T09:15:00Z",
    }),
    "09:15",
  );
  assertEquals(
    deriveMakesafeReportArrival({
      supplied: "",
      checklistArrival: "",
      assignmentArrivedAt: "",
    }),
    "",
  );
});

Deno.test("enrich fills blank crew and arrival from evidence only", () => {
  const enriched = enrichMakesafeReportJobKvFacts(
    {
      ref: "REF-TEST",
      address: "Privacy-safe test property",
      crew: "",
      arrival: "",
      scope: "Scope.",
      findings: "Findings.",
      works: "Works.",
      materials: "Materials.",
    },
    {
      tradeCount: 2,
      checklistArrival: "2026-06-30 14:00",
      assignments: [
        { status: "complete", crew_name: "Field A", user_id: "u1" },
        { status: "complete", users: { name: "Field B" }, user_id: "u2" },
      ],
    },
  );
  assertEquals(enriched.crew, "2 trades");
  assertEquals(enriched.arrival, "14:00");
});

Deno.test("renderer shows derived crew on the CREW line for real-shaped evidence", async () => {
  // Privacy-safe fixture shaped like SWMS-26845 Queens Park: two complete
  // person-bearing assignments and trade_count 2, with blank supplied crew.
  const crew = deriveMakesafeReportCrewLabel({
    supplied: "",
    tradeCount: 2,
    assignments: [
      { status: "complete", role: "lead_installer", crew_name: "Hugo", user_id: "u1" },
      {
        status: "complete",
        role: "lead_installer",
        crew_name: null,
        user_id: "u2",
        users: { name: "Anthony" },
      },
    ],
  });
  assertEquals(crew, "2 trades");
  const arrival = deriveMakesafeReportArrival({
    supplied: "",
    checklistArrival: "2026-06-30 14:00",
  });
  assertEquals(arrival, "14:00");

  const rendered = await renderMakesafeReportPdf({
    ref: "MLB-TEST-REF",
    address: "Privacy-safe test property",
    contact: "Site contact",
    date: "2026-06-30",
    arrival,
    crew,
    scope: "Connect temporary fence panels at the boundary gap.",
    findings: "Storm damage left a gap at the brick wall.",
    works: "Two temporary fence panels erected to close the gap.",
    materials: "Temp fence panels x 2. Star picket x 2. Zip ties x 20.",
    photos: [],
  });
  const pdf = new TextDecoder("latin1").decode(rendered.bytes);
  assertStringIncludes(pdf, "2 trades");
  // Must never put the assignment personal names on the client report.
  assertEquals(pdf.includes("Hugo"), false);
  assertEquals(pdf.includes("Anthony"), false);
  assertStringIncludes(pdf, "14:00");
});
