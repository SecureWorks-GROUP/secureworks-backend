// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  InstructionMintConflictError,
  matchExistingInstructionCards,
  refuseExistingInstructionCard,
  reserveInstructionCardMint,
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
        ["MLB:PO-57514"],
        [terminalCard],
        documents,
      ),
    InstructionMintConflictError,
  );
  assertEquals(error.matches[0].status, "archived");
});

Deno.test("pre-mint instruction gate ignores own cover sheet as identity", () => {
  const matches = matchExistingInstructionCards(
    ["AJ:JOB-70062"],
    [{ ...terminalCard, requesting_company_slug: "aj" }],
    [{
      job_id: "job-terminal",
      type: "work_order",
      file_name: "work-order-SWMS-260001.pdf",
    }],
  );
  assertEquals(matches, []);
});

Deno.test("pre-mint instruction gate refuses the same PO across family labels", () => {
  const rows = [{
    ...terminalCard,
    report_type: "assessment_report",
    jobs: {
      ...terminalCard.jobs,
      metadata: { makesafe_job_family: "assessment_report_quote" },
    },
  }];
  const documents = [{
    job_id: "job-terminal",
    type: "work_order",
    file_name: "MLB-25765PO-54176.pdf",
  }];

  assertEquals(
    matchExistingInstructionCards(
      ["MLB:PO-54176"],
      rows,
      documents,
    ).length,
    1,
  );
  assertEquals(
    matchExistingInstructionCards(
      ["MLB:PO-54176"],
      rows,
      documents,
    ).length,
    1,
  );
});

Deno.test("pre-mint instruction gate fails closed on an existing unknown family", () => {
  const matches = matchExistingInstructionCards(
    ["MLB:PO-54176"],
    [terminalCard],
    [{
      job_id: "job-terminal",
      type: "work_order",
      file_name: "MLB-25765PO-54176.pdf",
    }],
  );
  assertEquals(matches.length, 1);
});

Deno.test("atomic reservation owns the canonical instruction across families", async () => {
  let args: unknown = null;
  await reserveInstructionCardMint({
    rpc: (_name: string, input: unknown) => {
      args = input;
      return Promise.resolve({ error: null });
    },
  }, {
    orgId: "org",
    draftId: "draft",
    candidateKeys: ["MLB:PO-54176", "MLB:PO-54176"],
  });
  assertEquals(args, {
    p_org_id: "org",
    p_draft_id: "draft",
    p_instruction_keys: ["MLB:PO-54176"],
  });
});

Deno.test("atomic reservation maps only the unique-key conflict", async () => {
  await assertRejects(
    () =>
      reserveInstructionCardMint({
        rpc: () =>
          Promise.resolve({
            error: {
              code: "P0001",
              message: "instruction key already reserved: MLB:PO-57514",
            },
          }),
      }, {
        orgId: "org",
        draftId: "draft",
        candidateKeys: ["key"],
      }),
    InstructionMintConflictError,
  );
});

Deno.test("atomic reservation preserves infrastructure failures", async () => {
  const error = await assertRejects(
    () =>
      reserveInstructionCardMint({
        rpc: () =>
          Promise.resolve({
            error: { code: "42P01", message: "function does not exist" },
          }),
      }, {
        orgId: "org",
        draftId: "draft",
        candidateKeys: ["key"],
      }),
    Error,
  );
  assertEquals(
    error.message,
    "instruction mint reservation failed: function does not exist",
  );
});
