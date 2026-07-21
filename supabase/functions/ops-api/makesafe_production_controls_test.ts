// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadDeterministicRolloutControls } from "./makesafe_deterministic_intake_runtime.ts";

function clientFor(
  controls: { data: any; error: any },
  mode: { data: any; error: any } = {
    data: { intake_mode: "legacy" },
    error: null,
  },
) {
  return {
    from() {
      return {
        select(columns: string) {
          const result = columns === "intake_mode" ? mode : controls;
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve(result),
              };
            },
          };
        },
      };
    },
  } as any;
}

Deno.test("DB rollout controls return exact N=1 source authority", async () => {
  const controls = await loadDeterministicRolloutControls(clientFor({
    data: {
      intake_mode: "deterministic",
      deterministic_selection_mode: "exact",
      deterministic_max_cases_per_run: 1,
      deterministic_source_allowlist: ["approved-source"],
      deterministic_instruction_allowlist: [],
    },
    error: null,
  }));
  assertEquals(controls, {
    mode: "deterministic",
    selectionMode: "exact",
    maxCases: 1,
    sourcePostIds: ["approved-source"],
    instructionKeys: [],
  });
});

Deno.test("invalid or duplicate rollout values fail closed", async () => {
  await assertRejects(
    () =>
      loadDeterministicRolloutControls(clientFor({
        data: {
          intake_mode: "deterministic",
          deterministic_selection_mode: "exact",
          deterministic_max_cases_per_run: 25,
          deterministic_source_allowlist: ["approved-source"],
          deterministic_instruction_allowlist: [],
        },
        error: null,
      })),
    Error,
    "between 1 and 10",
  );
  await assertRejects(
    () =>
      loadDeterministicRolloutControls(clientFor({
        data: {
          intake_mode: "deterministic",
          deterministic_selection_mode: "exact",
          deterministic_max_cases_per_run: 1,
          deterministic_source_allowlist: ["same", "same"],
          deterministic_instruction_allowlist: [],
        },
        error: null,
      })),
    Error,
    "duplicate values",
  );
});

Deno.test("full-open authority is explicit and mutually exclusive with exact allowlists", async () => {
  const controls = await loadDeterministicRolloutControls(clientFor({
    data: {
      intake_mode: "deterministic",
      deterministic_selection_mode: "full_open",
      deterministic_max_cases_per_run: 3,
      deterministic_source_allowlist: [],
      deterministic_instruction_allowlist: [],
    },
    error: null,
  }));
  assertEquals(controls, {
    mode: "deterministic",
    selectionMode: "full_open",
    maxCases: 3,
    sourcePostIds: [],
    instructionKeys: [],
  });

  await assertRejects(
    () =>
      loadDeterministicRolloutControls(clientFor({
        data: {
          intake_mode: "deterministic",
          deterministic_selection_mode: "full_open",
          deterministic_max_cases_per_run: 1,
          deterministic_source_allowlist: ["must-not-mix"],
          deterministic_instruction_allowlist: [],
        },
        error: null,
      })),
    Error,
    "full_open mode requires empty exact allowlists",
  );
  await assertRejects(
    () =>
      loadDeterministicRolloutControls(clientFor({
        data: {
          intake_mode: "deterministic",
          deterministic_selection_mode: "exact",
          deterministic_max_cases_per_run: 1,
          deterministic_source_allowlist: [],
          deterministic_instruction_allowlist: [],
        },
        error: null,
      })),
    Error,
    "exact mode requires a non-empty exact allowlist",
  );
});

Deno.test("one-switch rollback on current schema returns authority to legacy", async () => {
  const controls = await loadDeterministicRolloutControls(clientFor({
    data: {
      intake_mode: "legacy",
      deterministic_selection_mode: "exact",
      deterministic_max_cases_per_run: 10,
      deterministic_source_allowlist: ["inert-after-rollback"],
      deterministic_instruction_allowlist: [],
    },
    error: null,
  }));
  assertEquals(controls.mode, "legacy");
});

Deno.test("old schema is legal only while legacy retains authority", async () => {
  const missing = {
    data: null,
    error: {
      code: "42703",
      message: "column deterministic_max_cases_per_run does not exist",
    },
  };
  const legacy = await loadDeterministicRolloutControls(clientFor(missing));
  assertEquals(legacy.mode, "legacy");
  assertEquals(legacy.selectionMode, "exact");
  assertEquals(legacy.maxCases, 1);
  await assertRejects(
    () =>
      loadDeterministicRolloutControls(clientFor(
        missing,
        { data: { intake_mode: "deterministic" }, error: null },
      )),
    Error,
    "rollout controls are unavailable",
  );
});

Deno.test("rollback remains one legal authority reversal with no destructive SQL", async () => {
  const rollback = await Deno.readTextFile(
    new URL(
      "../../rollbacks/20260720000002_makesafe_deterministic_intake_mode_rollback.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(rollback, "SET intake_mode = 'legacy'");
  assertStringIncludes(rollback, "WHERE id = true");
  assertEquals(/DROP\s|DELETE\s|TRUNCATE\s/i.test(rollback), false);
});
