// Tests for the make-safe hours-flag baseline resolver + annotation (M4 U1).
// Wiki issue #112; contract profit-trade-invoice-intelligence-2026-07-03.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ALLOWANCE_SOURCE_TRUST,
  appendHoursFlagMarker,
  buildLineQueryNote,
  evaluateHoursFlag,
  FLAG_TYPE_HOURS_OVER_BASELINE,
  hasSwmsPrefix,
  HOURS_FLAG_MARKER,
  isMakeSafeLine,
  resolveAllowance,
  RULE_DEFAULT_MIN_HOURS,
} from "./makesafe_hours_flag.ts";

const NOW = "2026-07-05T00:00:00.000Z";

// ── Resolver precedence ───────────────────────────────────────────────────
Deno.test("resolveAllowance: no candidates -> rule default (2hr)", () => {
  const r = resolveAllowance([]);
  assertEquals(r.allowed_hours, RULE_DEFAULT_MIN_HOURS);
  assertEquals(r.source, "rule_default");
});

Deno.test("resolveAllowance: trusted ops-set present -> uses it, not the rule default", () => {
  const r = resolveAllowance([{ source: "ops_set", hours: 4 }]);
  assertEquals(r.allowed_hours, 4);
  assertEquals(r.source, "ops_set");
});

Deno.test("resolveAllowance: ops-set absent (null) -> falls back to rule default", () => {
  const r = resolveAllowance([{ source: "ops_set", hours: null }]);
  assertEquals(r.allowed_hours, RULE_DEFAULT_MIN_HOURS);
  assertEquals(r.source, "rule_default");
});

Deno.test("resolveAllowance: zero/negative ops-set is treated as absent", () => {
  assertEquals(
    resolveAllowance([{ source: "ops_set", hours: 0 }]).source,
    "rule_default",
  );
  assertEquals(
    resolveAllowance([{ source: "ops_set", hours: -3 }]).source,
    "rule_default",
  );
});

Deno.test("resolveAllowance: report source is NOT trusted by default -> skipped, recorded", () => {
  // Report expectation present (would say 8h) but untrusted -> rule default wins.
  const r = resolveAllowance([{ source: "report", hours: 8 }]);
  assertEquals(r.allowed_hours, RULE_DEFAULT_MIN_HOURS);
  assertEquals(r.source, "rule_default");
  assertEquals(r.skipped_untrusted, ["report"]);
});

Deno.test("resolveAllowance: ops-set beats a (present) report even if report is larger", () => {
  const r = resolveAllowance([
    { source: "report", hours: 12 },
    { source: "ops_set", hours: 3 },
  ]);
  assertEquals(r.allowed_hours, 3);
  assertEquals(r.source, "ops_set");
});

Deno.test("resolveAllowance: trust config is pluggable (CP1 can enable report without a rewrite)", () => {
  const r = resolveAllowance([{ source: "report", hours: 5 }], {
    trust: { ops_set: true, report: true },
  });
  assertEquals(r.allowed_hours, 5);
  assertEquals(r.source, "report");
});

Deno.test("default trust config: ops_set trusted, report untrusted", () => {
  assertEquals(ALLOWANCE_SOURCE_TRUST.ops_set, true);
  assertEquals(ALLOWANCE_SOURCE_TRUST.report, false);
});

// ── Builder/client invoice amounts never raise the allowance ──────────────
Deno.test("builder invoice amount never raises the allowance (it is never a candidate)", () => {
  // The builder is billed 4h. That amount is NOT a resolver source, so a 3.5h
  // charge against a 2h make-safe still flags. We model "builder billed 4h" by
  // the simple fact that no ops_set/report candidate is supplied.
  const out = evaluateHoursFlag(
    {
      chargedHours: 3.5,
      candidates: [],
      justification: "storm callout ran long",
    },
    NOW,
  );
  assertEquals(out.allowed_hours, 2);
  assertEquals(out.allowed_source, "rule_default");
  assertEquals(out.flagged, true);
});

// ── Flag evaluation: fires on both submit-path line shapes ────────────────
Deno.test("clocked/assigned line shape flags when charged > allowed", () => {
  // jobGroups path: per-job summed hours, rule default allowance.
  const out = evaluateHoursFlag(
    {
      chargedHours: 6,
      candidates: [{ source: "ops_set", hours: null }],
      justification: "extra board-up",
    },
    NOW,
  );
  assertEquals(out.flagged, true);
  assertEquals(out.charged_hours, 6);
  assertEquals(out.allowed_hours, 2);
  assertEquals(out.lineFields.flag_type, FLAG_TYPE_HOURS_OVER_BASELINE);
  assertEquals(out.lineFields.baseline_hours, 2);
  assertEquals(out.lineFields.baseline_source, "rule_default");
  assertEquals(out.lineFields.hours_justification, "extra board-up");
  assertEquals(out.lineFields.flagged_at, NOW);
});

Deno.test("searched-in extra line shape flags identically (same function, both paths)", () => {
  // extras path: charged carried in quantity; same evaluator, same result.
  const out = evaluateHoursFlag(
    { chargedHours: 5, candidates: [], justification: null },
    NOW,
  );
  assertEquals(out.flagged, true);
  assertEquals(out.allowed_hours, 2);
  assertEquals(
    out.xeroDescriptionLine,
    "HOURS-FLAG (over allowance): no explanation provided",
  );
});

Deno.test("within allowance -> no flag, but allowance+source still recorded", () => {
  const out = evaluateHoursFlag(
    { chargedHours: 2, candidates: [{ source: "ops_set", hours: 2 }] },
    NOW,
  );
  assertEquals(out.flagged, false);
  assertEquals(out.queryNote, null);
  assertEquals(out.xeroDescriptionLine, null);
  assertEquals(out.lineFields.flag_type, null);
  assertEquals(out.lineFields.flagged_at, null);
  // Allowed + source recorded for EVERY make-safe line (feeds the U5 report).
  assertEquals(out.lineFields.baseline_hours, 2);
  assertEquals(out.lineFields.baseline_source, "ops_set");
});

Deno.test("trusted ops-set raises allowance so an otherwise-over charge does NOT flag", () => {
  const out = evaluateHoursFlag(
    { chargedHours: 3.5, candidates: [{ source: "ops_set", hours: 4 }] },
    NOW,
  );
  assertEquals(out.allowed_hours, 4);
  assertEquals(out.allowed_source, "ops_set");
  assertEquals(out.flagged, false);
});

Deno.test("float noise just over the boundary does not spuriously flag", () => {
  assertEquals(
    evaluateHoursFlag({ chargedHours: 2.0000001, candidates: [] }, NOW).flagged,
    false,
  );
  assertEquals(
    evaluateHoursFlag({ chargedHours: 2.02, candidates: [] }, NOW).flagged,
    true,
  );
});

// ── Activation: structured only; no-SWMS-prefix still activates ───────────
Deno.test("isMakeSafeLine: jobs.type='makesafe' activates", () => {
  assertEquals(isMakeSafeLine({ jobType: "makesafe" }), true);
});

Deno.test("isMakeSafeLine: division / line_type variants activate", () => {
  assertEquals(isMakeSafeLine({ division: "Make Safe" }), true);
  assertEquals(isMakeSafeLine({ division: "make_safe" }), true);
  assertEquals(isMakeSafeLine({ lineType: "make safe" }), true);
});

Deno.test("isMakeSafeLine: non-make-safe types do not activate", () => {
  assertEquals(
    isMakeSafeLine({
      jobType: "fencing",
      division: "Fencing",
      lineType: "labour",
    }),
    false,
  );
  assertEquals(isMakeSafeLine({}), false);
});

Deno.test("no-SWMS-prefix make-safe still flags (finding #6)", () => {
  // Structured selector says make-safe; job number lacks the SWMS- prefix.
  const activated = isMakeSafeLine({ jobType: "makesafe" });
  const prefix = hasSwmsPrefix("MLB-25248"); // corroboration only
  assertEquals(activated, true);
  assertEquals(prefix, false);
  // Activation does not depend on the prefix, so the flag still fires.
  const out = evaluateHoursFlag({ chargedHours: 4, candidates: [] }, NOW);
  assertEquals(out.flagged, true);
});

Deno.test("hasSwmsPrefix is corroboration only and case-insensitive", () => {
  assertEquals(hasSwmsPrefix("SWMS-26878"), true);
  assertEquals(hasSwmsPrefix("swms-1"), true);
  assertEquals(hasSwmsPrefix("PO-123"), false);
  assertEquals(hasSwmsPrefix(null), false);
});

// ── Exact marker + Reference annotation ───────────────────────────────────
Deno.test("HOURS_FLAG_MARKER is the exact contract string", () => {
  assertEquals(HOURS_FLAG_MARKER, "| HOURS-FLAG");
});

Deno.test("appendHoursFlagMarker appends exactly `| HOURS-FLAG` when any line flagged", () => {
  const ref = "SW-INV-JC-260705-001 | SWMS-26878";
  const out = appendHoursFlagMarker(ref, true);
  assertEquals(out, "SW-INV-JC-260705-001 | SWMS-26878 | HOURS-FLAG");
  assertEquals(out.includes("| HOURS-FLAG"), true);
});

Deno.test("appendHoursFlagMarker is a no-op when nothing flagged", () => {
  const ref = "SW-INV-JC-260705-001";
  assertEquals(appendHoursFlagMarker(ref, false), ref);
});

Deno.test("appendHoursFlagMarker never doubles the marker", () => {
  const ref = "SW-INV-JC-260705-001 | HOURS-FLAG";
  assertEquals(appendHoursFlagMarker(ref, true), ref);
});

// ── $/hours/rates are never touched by this module ────────────────────────
Deno.test("evaluateHoursFlag never emits any rate/amount/hourly field", () => {
  const out = evaluateHoursFlag(
    {
      chargedHours: 9,
      candidates: [{ source: "ops_set", hours: 2 }],
      justification: "x",
    },
    NOW,
  );
  const keys = [
    ...Object.keys(out),
    ...Object.keys(out.lineFields),
  ].join(",").toLowerCase();
  assertEquals(/rate|amount|hourly|price|\$/.test(keys), false);
  // Charged is passed through unchanged (only rounded), never recomputed.
  assertEquals(out.charged_hours, 9);
});

// ── Query-note shape (Allowed / Charged / Justification) ──────────────────
Deno.test("buildLineQueryNote is in the Allowed/Charged/Justification shape", () => {
  const note = buildLineQueryNote(
    6,
    2,
    "rule_default",
    "storm damage worse than scoped",
  );
  assertEquals(note.includes("allowed 2h"), true);
  assertEquals(note.includes("charged 6h"), true);
  assertEquals(note.includes("storm damage worse than scoped"), true);
  assertEquals(note.includes("rule default"), true);
});

Deno.test("buildLineQueryNote handles a missing justification", () => {
  const note = buildLineQueryNote(6, 2, "rule_default", null);
  assertEquals(note.includes("no explanation provided"), true);
});
