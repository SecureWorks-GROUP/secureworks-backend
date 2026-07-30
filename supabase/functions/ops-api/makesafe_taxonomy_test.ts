// deno-lint-ignore-file no-import-prefix
// M-G FIX 2 — negation-aware classifier + top-down taxonomy.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyMakeSafeJobFamily,
  classifyMakeSafeTaxonomy,
  decideMakeSafeJobFamily,
  taxonomyFromFamily,
} from "./makesafe_intake_gate.ts";

Deno.test("classifier: affirmative temp-fence text still classifies as temp_fence", () => {
  assertEquals(
    classifyMakeSafeJobFamily(
      "WO",
      "Please supply temporary fencing and collect on completion",
    ),
    "temp_fence_makesafe",
  );
  assertEquals(
    classifyMakeSafeJobFamily("WO", "temp fence pickup required"),
    "temp_fence_makesafe",
  );
});

Deno.test("classifier: NEGATED temp-fence text does NOT classify as temp_fence (the MLB-25777/25206 miss)", () => {
  // "no temp fencing needed" - an assessment/inspection job wrongly matched the bare token before
  assertEquals(
    classifyMakeSafeJobFamily(
      "MLB-25777 inspection",
      "Attend and assess the damage and provide a quote. No temp fencing needed for this job.",
    ),
    "assessment_report_quote",
  );
  // "temp fence not required" -> falls through, general (no other signal)
  assertEquals(
    classifyMakeSafeJobFamily(
      "WO",
      "Make safe the ceiling. Temp fence not required.",
    ),
    "general_makesafe",
  );
  // "no fencing" -> negated
  assertEquals(
    classifyMakeSafeJobFamily(
      "WO",
      "Roof report needed, no fencing on this one",
    ),
    "roof_report",
  );
});

Deno.test("classifier: explicit temp_fence report_type STILL wins over a negation in text", () => {
  // an explicit typed signal is authoritative; negation only suppresses a TEXT inference
  assertEquals(
    classifyMakeSafeJobFamily(
      "WO",
      "no temp fencing mentioned here",
      "temp_fence",
    ),
    "temp_fence_makesafe",
  );
});

Deno.test("classifier: restoration is first-class without defeating the AJS physical floor", () => {
  // Ruling 15 (sealed 2026-07-30): the restoration recipe is UNSEALED, so the
  // deterministic classifier must never assign restoration from text alone —
  // it parks (null family), and the back-compat wrapper falls to the physical
  // default rather than minting a restoration card. Typed restoration
  // (persisted report_type) still passes through unchanged.
  assertEquals(
    decideMakeSafeJobFamily(
      "Restoration works MLB-MW-26873",
      "Complete water damage restoration works to the dwelling.",
    ),
    { family: null, evidence: "text_restoration_park" },
  );
  assertEquals(
    classifyMakeSafeJobFamily(null, null, "restoration"),
    "restoration",
  );
  assertEquals(
    classifyMakeSafeJobFamily(
      "AJ Building & Restoration work order",
      "Attend and make safe the damaged roof.",
      null,
      { builder: "aj" },
    ),
    "general_makesafe",
  );
});

Deno.test("taxonomy: top-down job_type + subtype derive from the family", () => {
  assertEquals(taxonomyFromFamily("assessment_report_quote"), {
    job_type: "assessment",
    makesafe_subtype: null,
    family: "assessment_report_quote",
  });
  assertEquals(taxonomyFromFamily("roof_report"), {
    job_type: "roof",
    makesafe_subtype: null,
    family: "roof_report",
  });
  assertEquals(taxonomyFromFamily("temp_fence_makesafe"), {
    job_type: "makesafe",
    makesafe_subtype: "temp",
    family: "temp_fence_makesafe",
  });
  assertEquals(taxonomyFromFamily("general_makesafe"), {
    job_type: "makesafe",
    makesafe_subtype: "general",
    family: "general_makesafe",
  });
  assertEquals(taxonomyFromFamily("restoration"), {
    job_type: "restoration",
    makesafe_subtype: null,
    family: "restoration",
  });
});

Deno.test("taxonomy: classifyMakeSafeTaxonomy runs the negation-aware classifier end-to-end", () => {
  const t = classifyMakeSafeTaxonomy(
    "WO",
    "roof report required, no temp fencing needed",
  );
  assertEquals(t.job_type, "roof");
  assertEquals(t.makesafe_subtype, null);
});

Deno.test("classifier (BLOCKER fix): affirmative supply survives an incidental site-state negation", () => {
  const cases = [
    "Property has no fencing to the front boundary following storm damage. Supply and install temporary fencing.",
    "There is no temporary fencing currently on site; supply and install temp fencing.",
    "Temp fencing required. Client does not need permanent fence.",
    "make safe roof, no fencing to be installed but supply temp fencing panels",
  ];
  for (const body of cases) {
    assertEquals(
      classifyMakeSafeJobFamily("WO", body),
      "temp_fence_makesafe",
      `should stay temp_fence: ${body}`,
    );
  }
});
