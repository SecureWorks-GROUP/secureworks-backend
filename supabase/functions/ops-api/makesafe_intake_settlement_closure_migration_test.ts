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

Deno.test("draft-keyed mint authority is reserved before job creation and completed atomically", () => {
  const reserve = indexSource.indexOf("const primaryMint = await reserveIntakeMint");
  const create = indexSource.indexOf("const jobResult = await createMakesafeJob", reserve);
  const complete = indexSource.indexOf(
    "await completeIntakeMint(client, primaryMint.id, createdJobId)",
    create,
  );
  assert(reserve >= 0 && create > reserve && complete > create);
  assertStringIncludes(closureMigration, "UNIQUE (org_id, draft_id, mint_role)");
  assertStringIncludes(
    closureMigration,
    "UPDATE public.makesafe_intake_drafts",
  );
  assertStringIncludes(indexSource, "intake_mint_id: primaryMint.id");
  assertStringIncludes(indexSource, "settleIntakeApproval(");
});
