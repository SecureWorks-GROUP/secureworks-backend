// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveExistingFencePicketDecision } from "./makesafe_existing_fence_pickets.ts";

Deno.test("existing-fence support plus one trade quantity makes star pickets billable", () => {
  assertEquals(
    deriveExistingFencePicketDecision({
      support_narratives: [
        "Star pickets were used to brace an existing Hardie boundary fence.",
      ],
      materials_used: [
        "Star pickets x 20",
        "Bases / feet",
        "Tarps / roof materials",
        "Fixings / consumables",
      ],
    }),
    {
      state: "billable",
      quantity: 20,
      material_evidence: "Star pickets x 20",
      support_evidence:
        "Star pickets were used to brace an existing Hardie boundary fence.",
    },
  );
});

Deno.test("replacement wording without explicit existing-fence scope still holds", () => {
  const decision = deriveExistingFencePicketDecision({
    support_narratives: [
      "Propped up hardy fence using 20 star pickets to secure upright until fence replaced.",
    ],
    materials_used: ["Star pickets x 20"],
  });
  assertEquals(decision, {
    state: "refused",
    reason: "existing_fence_scope_missing",
  });
});

Deno.test("separate fragments and bare pickets do not manufacture scope evidence", () => {
  assertEquals(
    deriveExistingFencePicketDecision({
      support_narratives: ["Support completed.", "Existing fence."],
      materials_used: ["Star pickets x 4"],
    }),
    { state: "refused", reason: "existing_fence_scope_missing" },
  );
});

Deno.test("conflicting or missing trade quantities refuse rather than inventing money", () => {
  for (
    const materials_used of [
      ["Star pickets"],
      ["Star pickets x 4", "6 star pickets"],
    ]
  ) {
    assertEquals(
      deriveExistingFencePicketDecision({
        support_narratives: [
          "Star pickets brace an existing boundary fence.",
        ],
        materials_used,
      }),
      {
        state: "refused",
        reason: "star_picket_quantity_missing_or_ambiguous",
      },
    );
  }
});

Deno.test("every genuine temporary-fence signal defeats the carve-out", () => {
  for (
    const signal of [
      "Panels supplied",
      "Blocks supplied",
      "Bases supplied",
      "Cable ties supplied",
      "Fence clips supplied",
      "Panel hire",
      "Retrieval materials supplied",
      "Temporary fencing scope",
    ]
  ) {
    assertEquals(
      deriveExistingFencePicketDecision({
        support_narratives: [
          "Star pickets support an existing boundary fence.",
          signal,
        ],
        materials_used: ["Star pickets x 20"],
      }),
      { state: "refused", reason: "genuine_temporary_fence_signal" },
      signal,
    );
  }
  assertEquals(
    deriveExistingFencePicketDecision({
      support_narratives: [
        "Star pickets support an existing boundary fence.",
      ],
      materials_used: ["Star pickets x 20"],
      declared_temporary_fence: true,
    }),
    { state: "refused", reason: "genuine_temporary_fence_signal" },
  );
});

Deno.test("separate fixings and consumables do not erase a valid picket line", () => {
  assertEquals(
    deriveExistingFencePicketDecision({
      support_narratives: [
        "Star pickets support an existing boundary fence.",
      ],
      materials_used: [
        "Star pickets x 20",
        "Fixings x 4",
        "Small consumables x 1",
      ],
    }).state,
    "billable",
  );
  assertEquals(
    deriveExistingFencePicketDecision({
      support_narratives: [
        "Star pickets support an existing boundary fence.",
      ],
      materials_used: ["Star pickets and consumables x 20"],
    }),
    { state: "refused", reason: "genuine_temporary_fence_signal" },
  );
});
