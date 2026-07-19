// deno-lint-ignore-file no-import-prefix

import {
  assert,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationUrl = new URL(
  "../../migrations/20260720000001_makesafe_intake_cases.sql",
  import.meta.url,
);
const rollbackUrl = new URL(
  "../../rollbacks/20260720000001_makesafe_intake_cases_down.sql",
  import.meta.url,
);
const cloneHarnessUrl = new URL(
  "../../../scripts/test-makesafe-intake-case-migration.sh",
  import.meta.url,
);
const sqlContractUrl = new URL(
  "../../tests/makesafe_intake_cases_contract.sql",
  import.meta.url,
);
const migration = await Deno.readTextFile(migrationUrl);
const rollback = await Deno.readTextFile(rollbackUrl);
const cloneHarness = await Deno.readTextFile(cloneHarnessUrl);
const sqlContract = await Deno.readTextFile(sqlContractUrl);

Deno.test("B1: source junction is N:1 and accounts each post once per org", () => {
  assert(
    migration.includes(
      "CREATE TABLE IF NOT EXISTS public.makesafe_intake_case_sources",
    ),
  );
  assert(migration.includes("UNIQUE (org_id, post_id)"));
  assert(
    migration.includes("REFERENCES public.emails(post_id) ON DELETE RESTRICT"),
  );
  for (
    const role of [
      "original",
      "twin",
      "resend",
      "revision_notice",
      "cancellation_notice",
      "late_pdf",
    ]
  ) {
    assert(migration.includes(`'${role}'`), `missing source role ${role}`);
  }
});

Deno.test("B2: lineage is one typed immutable parent forest", () => {
  for (
    const proof of [
      "lineage_id uuid NOT NULL",
      "parent_case_id uuid",
      "parent_relation text",
      "makesafe_intake_cases_lineage_shape_check",
      "makesafe_intake_cases_no_self_parent_check",
      "lineage parent must already exist in the same org",
      "case instruction and lineage identity are immutable",
      "duplicate_of must point directly to a non-duplicate lineage root",
    ]
  ) {
    assert(migration.includes(proof), `missing lineage proof: ${proof}`);
  }
  assert(
    !migration.includes(
      "CREATE TABLE IF NOT EXISTS public.makesafe_intake_case_lineage",
    ),
  );
});

Deno.test("B3: authority phases, divergence and sunset declaration are explicit", () => {
  for (
    const proof of [
      "Observe mode",
      "Cutover, in a later gated unit",
      "SUNSETS AFTER CUTOVER",
      "makesafe_intake_case_divergence",
      "draft_authoritative_case_shadow",
      "makesafe_intake_email_accounting",
    ]
  ) {
    assert(migration.includes(proof), `missing authority proof: ${proof}`);
  }
});

Deno.test("B4: live identity uses builder WO/PO plus case-defined cycle", () => {
  assertMatch(
    migration,
    /ON public\.makesafe_intake_cases \(\s*org_id, company_key, wo_po_identity_key, cycle\s*\)/,
  );
  assert(
    migration.includes(
      "WHEN NEW.parent_relation = 'reopen_of' THEN parent_case.cycle + 1",
    ),
  );
  assert(!/UNIQUE\s*\([^)]*external_ref_canonical/.test(migration));
  assert(!/UNIQUE\s*\([^)]*external_ref_raw/.test(migration));
});

Deno.test("B4a: wo_po_identity_key is derived from the canonical columns", () => {
  assert(
    migration.includes("makesafe_intake_cases_wo_po_identity_key_check"),
  );
  assert(
    migration.includes(
      "THEN 'wo:' || builder_wo_canonical || '/po:' || builder_po_canonical",
    ),
  );
  assert(migration.includes("THEN 'po:' || builder_po_canonical"));
  assert(migration.includes("THEN 'wo:' || builder_wo_canonical"));
  // Every fixture key must be reachable from its canonical columns.
  assert(!sqlContract.includes("'wo:CLAIM-1/po:"));
});

Deno.test("B4b: claim-ref-only live cases still cannot duplicate", () => {
  assertMatch(
    migration,
    /uq_makesafe_intake_cases_live_claim_identity/,
  );
  assertMatch(
    migration,
    /external_ref_canonical,\s*COALESCE\(deliverable_ref_canonical, ''\),\s*cycle/,
  );
  assert(migration.includes("AND wo_po_identity_key IS NULL"));
});

Deno.test("M7a: a null-org company cannot be linked from any org", () => {
  assert(
    migration.includes("company_org_id IS DISTINCT FROM NEW.org_id"),
  );
  assert(!migration.includes("company_org_id IS NOT NULL AND company_org_id"));
});

Deno.test("accounting view carries org from the source, not a pinned literal", () => {
  assert(
    !/LEFT JOIN public\.makesafe_intake_case_sources source\s*\n\s*ON source\.org_id =/
      .test(migration),
  );
  assertMatch(
    migration,
    /COALESCE\(\s*source\.org_id,\s*'00000000-0000-0000-0000-000000000001'::uuid\s*\) AS org_id/,
  );
});

Deno.test("B5: rollback is staged and prod-schema clone harness blocks production", () => {
  assert(rollback.includes("refusing post-cutover DROP"));
  assert(rollback.includes("WHERE is_authoritative"));
  assert(
    migration.includes(
      "After cutover, rollback is the later G5/G6 DB flag flip",
    ),
  );
  assert(cloneHarness.includes("MAKESAFE_PROD_SCHEMA_CLONE_URL"));
  assert(cloneHarness.includes("kevgrhcjxspbxgovpmfl"));
  assert(cloneHarness.includes("refusing production"));
});

Deno.test("M1: impossible state-field combinations are DB checks", () => {
  for (
    const proof of [
      "makesafe_intake_cases_live_identity_floor_check",
      "makesafe_intake_cases_confirmed_shape_check",
      "makesafe_intake_cases_blocked_shape_check",
      "makesafe_intake_cases_exception_shape_check",
      "makesafe_intake_cases_non_wo_shape_check",
      "makesafe_intake_cases_cancellation_no_job_check",
    ]
  ) {
    assert(migration.includes(proof), `missing state proof: ${proof}`);
  }
});

Deno.test("M2: case events are trigger-fed and append-only", () => {
  assert(
    migration.includes(
      "CREATE TABLE IF NOT EXISTS public.makesafe_intake_case_events",
    ),
  );
  assert(
    migration.includes(
      "AFTER INSERT OR UPDATE ON public.makesafe_intake_cases",
    ),
  );
  assert(migration.includes("trg_makesafe_intake_case_events_append_only"));
  assert(migration.includes("is append-only; % is not allowed"));
});

Deno.test("M3: one direct case-job link is unique and same-org make-safe only", () => {
  assert(migration.includes("uq_makesafe_intake_cases_job"));
  assert(
    migration.includes("job_id must reference a make-safe job in the same org"),
  );
  assert(!migration.includes("INSERT INTO public.jobs"));
  assert(migration.includes("No case identity is copied into jobs.metadata"));
});

Deno.test("M4: raw/canonical fields have one versioned normaliser", () => {
  for (
    const column of [
      "company_slug_raw",
      "company_key",
      "external_ref_raw",
      "external_ref_canonical",
      "builder_wo_raw",
      "builder_wo_canonical",
      "builder_po_raw",
      "builder_po_canonical",
      "normaliser_version",
    ]
  ) {
    assert(migration.includes(column), `missing identity column ${column}`);
  }
  assert(
    migration.includes("raw identity values cannot be replaced or cleared"),
  );
  assert(migration.includes("field provenance is append-only"));
});

Deno.test("M5: Maverick/backfill provenance and suppression are structural", () => {
  assert(migration.includes("'maverick', 'backfill'"));
  assert(
    migration.includes("makesafe_intake_cases_backfill_suppression_check"),
  );
  assert(migration.includes("side_effects_suppressed"));
  assert(sqlContract.includes("backfill_second_run_writes"));
});

Deno.test("M6: cancellation/revision wiring stays out of inert DB triggers", () => {
  assert(migration.includes("'cancellation_of'"));
  assert(migration.includes("'revision_of'"));
  assert(!migration.includes("UPDATE public.jobs"));
  assert(!migration.includes("UPDATE public.makesafe_job_details"));
  assert(!migration.includes("send_sms"));
});

Deno.test("M7: org FK and org-scoped keys exist on all three tables", () => {
  assertEqualsCount(
    migration,
    "REFERENCES public.organisations(id) ON DELETE RESTRICT",
    3,
  );
  assert(migration.includes("FOREIGN KEY (org_id, case_id)"));
  assert(migration.includes("UNIQUE (org_id, instruction_key)"));
  assert(migration.includes("UNIQUE (org_id, post_id)"));
});

Deno.test("minor findings: exception queue, timestamps and private attachment refs", () => {
  assert(migration.includes("idx_makesafe_intake_cases_exception_queue"));
  assert(migration.includes("received_at timestamptz NOT NULL"));
  assert(migration.includes("observed_at timestamptz NOT NULL"));
  assert(migration.includes("attachment_refs uuid[]"));
  assert(migration.includes("attachment_refs must belong to the source post"));
  assert(migration.includes("No bytes, public URLs or signed URLs"));
});

Deno.test("migration is re-apply safe and alters no existing runtime table", () => {
  for (
    const table of [
      "makesafe_intake_cases",
      "makesafe_intake_case_sources",
      "makesafe_intake_case_events",
    ]
  ) {
    assert(migration.includes(`CREATE TABLE IF NOT EXISTS public.${table}`));
  }
  assert(
    !/ALTER TABLE public\.(jobs|makesafe_intake_drafts|emails|email_attachments)/
      .test(migration),
  );
  assert(migration.includes("DROP TRIGGER IF EXISTS"));
  assert(migration.includes("DROP POLICY IF EXISTS"));
});

Deno.test("RLS is service-role only for tables and views", () => {
  assert(migration.includes("ENABLE ROW LEVEL SECURITY"));
  assert(
    migration.includes("REVOKE ALL ON public.%I FROM anon, authenticated"),
  );
  assert(migration.includes("FOR ALL TO service_role"));
  assert(
    migration.includes(
      "GRANT SELECT ON public.makesafe_intake_case_divergence TO service_role",
    ),
  );
  assert(
    migration.includes(
      "GRANT SELECT ON public.makesafe_intake_email_accounting TO service_role",
    ),
  );
});

Deno.test("rollback touches only the isolated seam", () => {
  for (
    const object of [
      "makesafe_intake_case_events",
      "makesafe_intake_case_sources",
      "makesafe_intake_cases",
    ]
  ) {
    assert(rollback.includes(`DROP TABLE IF EXISTS public.${object}`));
  }
  assert(!rollback.includes("DROP TABLE IF EXISTS public.jobs"));
  assert(
    !rollback.includes("DROP TABLE IF EXISTS public.makesafe_intake_drafts"),
  );
  assert(!rollback.includes("DROP TABLE IF EXISTS public.emails"));
});

function assertEqualsCount(
  haystack: string,
  needle: string,
  expected: number,
): void {
  const count = haystack.split(needle).length - 1;
  assert(
    count === expected,
    `expected ${expected} occurrences of ${needle}, got ${count}`,
  );
}
