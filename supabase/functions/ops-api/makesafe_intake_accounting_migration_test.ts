// deno-lint-ignore-file no-import-prefix

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationUrl = new URL(
  "../../migrations/20260727012426_makesafe_intake_accounting_u1.sql",
  import.meta.url,
);
const sql = await Deno.readTextFile(migrationUrl);

Deno.test("U1 migration installs cancellation target and source issue invariants", () => {
  for (
    const fragment of [
      "ADD COLUMN IF NOT EXISTS target_relation text",
      "ADD COLUMN IF NOT EXISTS target_job_id uuid",
      "makesafe_intake_cases_parent_target_relation_check",
      "validate_makesafe_intake_target_job",
      "j.org_id = NEW.org_id",
      "j.type = 'makesafe'",
      "ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL",
      "uq_email_events_raw_intake_issue",
      "GROUP BY org_id, post_id, change_type",
      "HAVING count(*) > 1",
      "ADD COLUMN IF NOT EXISTS deterministic_case_id uuid",
      "makesafe_intake_drafts_deterministic_case_fk",
      "makesafe_intake_drafts_rejected_at_status_check",
      "makesafe_intake_drafts_rejected_status_evidence_check",
    ]
  ) {
    assert(sql.includes(fragment), `missing migration invariant: ${fragment}`);
  }
});

Deno.test("U1 migration has every typed cancellation disposition", () => {
  const reasons = [
    "cancellation",
    "cancellation_target_not_found",
    "cancellation_target_ambiguous",
    "cancellation_live_invoice_review",
    "cancellation_target_terminal_conflict",
    "cancellation_apply_failed",
  ];
  assertEquals(
    reasons.filter((reason) => sql.includes(`'${reason}'`)),
    reasons,
  );
});

Deno.test("U1 migration never mutates operational job state", () => {
  assertEquals(/\bUPDATE\s+public\.jobs\b/i.test(sql), false);
  assertEquals(/\bDELETE\s+FROM\s+public\.jobs\b/i.test(sql), false);
  assertEquals(/\bINSERT\s+INTO\s+public\.jobs\b/i.test(sql), false);
});
