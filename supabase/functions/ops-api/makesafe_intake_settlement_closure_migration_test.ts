// deno-lint-ignore-file no-import-prefix

import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const legacyMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260729010000_makesafe_hugo_notification_sla_v1.sql",
    import.meta.url,
  ),
);
const closureMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260731000002_makesafe_intake_settlement_closure.sql",
    import.meta.url,
  ),
);
const indexSource = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);
const verificationGuide = await Deno.readTextFile(
  new URL(
    "../../../docs/evidence/makesafe-pdf-extraction-belt-2026-07-31.md",
    import.meta.url,
  ),
);

Deno.test("ordered settlement closure upgrades deployed Hugo uniqueness without rewriting history", () => {
  assertStringIncludes(
    legacyMigration,
    "UNIQUE (org_id, case_id, job_id)",
  );
  assertStringIncludes(
    closureMigration,
    "makesafe_intake_hugo_notification_duplicates",
  );
  assertStringIncludes(
    closureMigration,
    "DROP CONSTRAINT IF EXISTS makesafe_intake_hugo_notifications_once",
  );
  assertStringIncludes(closureMigration, "UNIQUE (org_id, job_id)");
});

Deno.test("draft-keyed mint authority is recovered before idempotent job creation", () => {
  const reserve = indexSource.indexOf(
    "primaryMint = authority",
  );
  const recover = indexSource.indexOf(
    "const recoveredPrimaryJob = primaryMint",
    reserve,
  );
  const create = indexSource.indexOf(
    "await createMakesafeJob(client",
    recover,
  );
  const complete = indexSource.indexOf(
    "await completeIntakeMint(client, primaryMint.id, createdJobId)",
    create,
  );
  assert(
    reserve >= 0 && recover > reserve && create > recover && complete > create,
  );
  assertStringIncludes(
    closureMigration,
    "UNIQUE (org_id, draft_id, mint_role)",
  );
  assertStringIncludes(
    closureMigration,
    "UPDATE public.makesafe_intake_drafts",
  );
  assertStringIncludes(indexSource, "intake_mint_id: primaryMint.id");
  assertStringIncludes(
    indexSource,
    ".contains('metadata', { intake_mint_id: mint.id })",
  );
  assertStringIncludes(indexSource, "settleIntakeApproval(");
});

Deno.test("mint reservation rejects source authority outside the canonical case", () => {
  assertStringIncludes(
    closureMigration,
    "FROM unnest(COALESCE(p_source_post_ids, '{}')) AS source(post_id)",
  );
  assertStringIncludes(closureMigration, "s.post_id = source.post_id");
  assertStringIncludes(
    closureMigration,
    "LEFT JOIN public.makesafe_intake_source_authority_corrections c",
  );
  assertStringIncludes(
    closureMigration,
    "LEFT JOIN public.makesafe_intake_source_authority_correction_supersessions x",
  );
  assertStringIncludes(
    closureMigration,
    "COALESCE(\n            x.effective_case_id,\n            c.effective_case_id,\n            s.case_id\n          ) = p_case_id",
  );
  assertStringIncludes(
    closureMigration,
    "source authority does not belong to intake case",
  );
});

Deno.test("non-deterministic approval remains an explicit non-notifying path", () => {
  assertStringIncludes(
    indexSource,
    "if (extraction?.deterministic_intake !== true) return null",
  );
  assertStringIncludes(
    indexSource,
    "const requiredMintRoles = extraction?.deterministic_intake === true",
  );
});

Deno.test("post-deploy verification names every supported intake family", () => {
  for (
    const expected of [
      "`general_makesafe`",
      "`temp_fence_makesafe`",
      "`roof_report`",
      "`assessment_report_quote`",
      "`repair`",
      "`restoration`",
      "`repair_quote_stage`",
    ]
  ) {
    assertStringIncludes(verificationGuide, expected);
  }
  assertStringIncludes(
    verificationGuide,
    "Re-run settlement for every fresh family sample",
  );
});
