// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  InstructionMintConflictError,
  matchExistingInstructionCards,
  refuseExistingInstructionCard,
} from "./makesafe_instruction_mint_gate.ts";

const terminalCard = {
  job_id: "job-terminal",
  external_ref: null,
  requesting_company_slug: "mlb",
  jobs: {
    job_number: "SWMS-260001",
    status: "archived",
    metadata: {},
  },
};

Deno.test("pre-mint instruction gate refuses an exact terminal-card match", () => {
  const documents = [{
    job_id: "job-terminal",
    type: "work_order",
    file_name: "MLB-RR-26836PO-57514.pdf",
  }];
  const error = assertThrows(
    () =>
      refuseExistingInstructionCard(
        ["MLB-RR-26836PO-57514"],
        [terminalCard],
        documents,
      ),
    InstructionMintConflictError,
  );
  assertEquals(error.matches[0].status, "archived");
});

Deno.test("pre-mint instruction gate ignores own cover sheet as identity", () => {
  const matches = matchExistingInstructionCards(
    ["AJ-70062"],
    [{ ...terminalCard, requesting_company_slug: "aj" }],
    [{
      job_id: "job-terminal",
      type: "work_order",
      file_name: "work-order-SWMS-260001.pdf",
    }],
  );
  assertEquals(matches, []);
});
