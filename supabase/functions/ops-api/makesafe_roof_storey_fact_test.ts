// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  roofStoreyIntakeMetadata,
  roofStoreyOrderedProductFact,
} from "./makesafe_roof_storey_fact.ts";

function storeys(text: string) {
  const fact = roofStoreyOrderedProductFact(text);
  return fact && "storeys" in fact ? fact.storeys : null;
}

function refusal(text: string) {
  const fact = roofStoreyOrderedProductFact(text);
  return fact && "refused" in fact ? fact.refused : null;
}

// Phrasings taken verbatim from live MLB work-order instruction text on the
// board (2026-08-02), not invented. These are the shapes the builder actually
// uses to name the product being ordered.
Deno.test("reads the storey off the ordered roof product, on real work-order phrasings", () => {
  assertEquals(
    storeys("Please attend and conduct a single storey roof report"),
    "single",
  );
  assertEquals(
    storeys(
      "attend and conduct single storey roof report noting cause of damage",
    ),
    "single",
  );
  assertEquals(
    storeys("Please conduct a single storey roof inspection to identify"),
    "single",
  );
  assertEquals(
    storeys(
      "Please attend and conduct a two storey roof report noting the cause",
    ),
    "double",
  );
  assertEquals(
    storeys("two storey roof report to identify point of water entry"),
    "double",
  );
  assertEquals(storeys("double storey roof report required"), "double");
  assertEquals(storeys("SINGLE STOREY ROOF REPORT"), "single");
  assertEquals(storeys("single-storey roof report"), "single");
  assertEquals(
    storeys("conduct a single storey roof assessment report"),
    "single",
  );
});

// THE CONTROL THAT MATTERS MOST. A card whose instruction does not name a
// storey against the product must stay blocked. `null` here is what keeps
// `pricing_evidence_missing` firing, which is the correct outcome for a genuine
// fact gap - 12 of the 61 roof cards on the record are in exactly this state.
Deno.test("an instruction that does not name a storey records nothing and keeps the card blocking", () => {
  for (
    const text of [
      "Please attend and conduct a roof report noting the cause of damage",
      "Attend site and complete the roof inspection",
      "MAKE SAFE: please attend the property to make the roof water tight",
      "Roof report required. Please submit via the portal.",
      "",
      "   ",
    ]
  ) {
    assertEquals(storeys(text), null, `"${text}" should record no storey`);
    assertEquals(refusal(text), null, `"${text}" should not refuse either`);
    assertEquals(roofStoreyIntakeMetadata(text), null);
  }
});

// The trap this narrow match exists for. A storey can describe the BUILDING
// somewhere else in the prose; that is not the product ordered, and pricing off
// it would be pricing off the wrong sentence. This exact phrasing is live on the
// board.
Deno.test("a storey describing the property rather than the ordered product is not read", () => {
  assertEquals(
    storeys("Request for single storey property. Please attend."),
    null,
  );
  assertEquals(storeys("The dwelling is a single storey brick and tile"), null);
  assertEquals(
    storeys("Access to the two storey rear addition is via the side gate"),
    null,
  );
  assertEquals(storeys("single storey"), null);
  // Present but attached to something that is not a roof report product.
  assertEquals(storeys("single storey fence repair"), null);
  assertEquals(storeys("two storey scaffold required"), null);
});

// Three storey has NO price in the sealed schedule. It must refuse, never round
// down to double. Two live cards (SWMS-26929, SWMS-26930) are in this state and
// need a captain price decision.
Deno.test("three or more storeys refuses rather than rounding to double", () => {
  assertEquals(
    refusal("Please attend and conduct a three storey roof report"),
    "storeys_above_double_have_no_sealed_price",
  );
  assertEquals(
    refusal("triple storey roof inspection required"),
    "storeys_above_double_have_no_sealed_price",
  );
  assertEquals(
    refusal("four storey roof report"),
    "storeys_above_double_have_no_sealed_price",
  );
  // And it must never leak a priceable storey.
  assertEquals(
    storeys("Please attend and conduct a three storey roof report"),
    null,
  );
  assertEquals(roofStoreyIntakeMetadata("three storey roof report"), null);
});

// Two different storeys named against the product is ambiguity, and recorded
// ambiguity is never authority to pick one.
Deno.test("conflicting storey counts refuse rather than choosing", () => {
  assertEquals(
    refusal("single storey roof report ... amended to two storey roof report"),
    "conflicting_storey_counts",
  );
  assertEquals(
    storeys("single storey roof report ... amended to two storey roof report"),
    null,
  );
  assertEquals(
    roofStoreyIntakeMetadata(
      "single storey roof report / three storey roof report",
    ),
    null,
  );
});

// The intake metadata shape is what U4 reads. The key must be `storeys`,
// because that is the alias `structuredSourceFact` already resolves against
// `jobs.metadata`; renaming it silently disconnects the fix.
Deno.test("the intake metadata records only a priceable storey, under the key U4 already reads", () => {
  assertEquals(
    roofStoreyIntakeMetadata(
      "Please attend and conduct a single storey roof report",
    ),
    { storeys: "single" },
  );
  assertEquals(
    roofStoreyIntakeMetadata(
      "Please attend and conduct a two storey roof report",
    ),
    { storeys: "double" },
  );
  assertEquals(roofStoreyIntakeMetadata("roof report required"), null);
  assertEquals(roofStoreyIntakeMetadata(null), null);
  assertEquals(roofStoreyIntakeMetadata(undefined), null);
});

// The whole point of extracting at intake is that pricing never regexes text.
// Whatever is recorded must be a value the roof price function already accepts,
// so the pricing path stays a lookup.
Deno.test("the recorded value is one the sealed roof price rule already accepts", () => {
  for (const text of ["single storey roof report", "two storey roof report"]) {
    const fact = roofStoreyIntakeMetadata(text);
    assertEquals(
      fact !== null && ["single", "double"].includes(fact.storeys),
      true,
      `${text} produced a value outside the sealed schedule`,
    );
  }
});

Deno.test("the intake path includes builder instruction text as a separate source line", async () => {
  const source = await Deno.readTextFile("./index.ts");
  assertEquals(
    source.includes(
      "[description, reviewedMakeSafeType, builder_email_text_for_trade]",
    ),
    true,
  );
  assertEquals(source.includes(".join('\\n')"), true);
  assertEquals(
    roofStoreyIntakeMetadata("Please conduct a single storey roof report"),
    { storeys: "single" },
  );
});
