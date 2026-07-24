// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadDeterministicRolloutControls } from "./makesafe_deterministic_intake_runtime.ts";

function clientFor(
  controls: { data: any; error: any },
) {
  return {
    from() {
      return {
        select(_columns: string) {
          const result = controls;
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

Deno.test("DB standing controls return bounded full-open authority", async () => {
  const controls = await loadDeterministicRolloutControls(clientFor({
    data: {
      intake_mode: "deterministic",
      deterministic_selection_mode: "full_open",
      deterministic_max_cases_per_run: 10,
      deterministic_source_allowlist: [],
      deterministic_instruction_allowlist: [],
    },
    error: null,
  }));
  assertEquals(controls, {
    mode: "deterministic",
    selectionMode: "full_open",
    maxCases: 10,
    sourcePostIds: [],
    instructionKeys: [],
  });
});

Deno.test("invalid or duplicate rollout values fail closed", async () => {
  await assertRejects(
    () =>
      loadDeterministicRolloutControls(clientFor({
        data: {
          intake_mode: "deterministic",
          deterministic_selection_mode: "full_open",
          deterministic_max_cases_per_run: 25,
          deterministic_source_allowlist: [],
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
          deterministic_selection_mode: "full_open",
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

Deno.test("standing authority rejects exact mode and any exact allowlist", async () => {
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
          deterministic_source_allowlist: ["still-narrowed"],
          deterministic_instruction_allowlist: [],
        },
        error: null,
      })),
    Error,
    "standing selection mode must be full_open",
  );
});

Deno.test("pre-migration legacy default resolves to bounded full-open (deploy order safe)", async () => {
  // The known pre-20260724070000 singleton row: intake_mode still 'legacy',
  // selection_mode still holding its 'exact' column default, empty allowlists, the
  // default cap of 1. Standing intake must already be deterministic full-open here
  // rather than throwing, so deploying ops-api before the migration lands is harmless.
  const controls = await loadDeterministicRolloutControls(clientFor({
    data: {
      intake_mode: "legacy",
      deterministic_selection_mode: "exact",
      deterministic_max_cases_per_run: 1,
      deterministic_source_allowlist: [],
      deterministic_instruction_allowlist: [],
    },
    error: null,
  }));
  assertEquals(controls, {
    mode: "deterministic",
    selectionMode: "full_open",
    maxCases: 1,
    sourcePostIds: [],
    instructionKeys: [],
  });
});

Deno.test("legacy compatibility value cannot change standing deterministic authority", async () => {
  const controls = await loadDeterministicRolloutControls(clientFor({
    data: {
      intake_mode: "legacy",
      deterministic_selection_mode: "full_open",
      deterministic_max_cases_per_run: 10,
      deterministic_source_allowlist: [],
      deterministic_instruction_allowlist: [],
    },
    error: null,
  }));
  assertEquals(controls.mode, "deterministic");
});

Deno.test("missing permanent-standing controls resolve to bounded full-open", async () => {
  // A schema without the deterministic control columns is an even earlier
  // pre-migration shape. Standing intake resolves to full-open at the standing
  // default cap rather than failing closed, so deploy order stays harmless.
  const missing = {
    data: null,
    error: {
      code: "42703",
      message: "column deterministic_max_cases_per_run does not exist",
    },
  };
  const controls = await loadDeterministicRolloutControls(clientFor(missing));
  assertEquals(controls, {
    mode: "deterministic",
    selectionMode: "full_open",
    maxCases: 10,
    sourcePostIds: [],
    instructionKeys: [],
  });
});

Deno.test("a genuine controls read failure still fails closed", async () => {
  // Only the known missing-column shape is treated as pre-migration. A network,
  // auth or timeout read error must abort rather than guess at rollout controls.
  await assertRejects(
    () =>
      loadDeterministicRolloutControls(clientFor({
        data: null,
        error: {
          code: "57014",
          message: "canceling statement due to statement timeout",
        },
      })),
    Error,
    "deterministic rollout controls read failed",
  );
});
