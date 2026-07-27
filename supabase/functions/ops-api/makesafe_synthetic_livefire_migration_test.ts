// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20260727080821_makesafe_synthetic_livefire_infrastructure.sql",
  import.meta.url,
);

Deno.test("synthetic live-fire profile is fixed, inert, and routes only to SecureWorks", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  assertStringIncludes(sql, "'synthetic-livefire'");
  assertStringIncludes(sql, "'SYNTHETIC LIVE-FIRE BUILDER - TEST ONLY'");
  assertStringIncludes(sql, "ARRAY[]::text[]");
  assertStringIncludes(sql, "'marnin@secureworkswa.com.au'");
  assertStringIncludes(sql, "'signed_marker_only'");
  assertStringIncludes(sql, "'SWG-SES-LIVEFIRE-TEST-ONLY-'");
  assertStringIncludes(sql, "SYNTHLIVE-");
  assertStringIncludes(sql, "'outbound_disabled', true");
  assertStringIncludes(sql, "'invoicing_disabled', true");
  assertStringIncludes(
    sql,
    "makesafe_companies_synthetic_livefire_fixed",
  );

  const routingAddresses = [
    ...sql.matchAll(/'(?:[a-z0-9._%+-]+)@(?:[a-z0-9.-]+)'/gi),
  ].map((match) => match[0].slice(1, -1).toLowerCase());
  assert(routingAddresses.length > 0);
  assertEquals(
    routingAddresses.filter((address) =>
      !address.endsWith("@secureworkswa.com.au")
    ),
    [],
    "the synthetic profile must contain no external routing address",
  );
});

Deno.test("deterministic case constraint keeps every current adapter and adds only the synthetic adapter", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  for (
    const adapter of [
      "mlb",
      "ajs_ajbr",
      "prime",
      "rapid",
      "builderwest",
      "western",
      "chatter",
      "synthetic_livefire",
    ]
  ) {
    assertStringIncludes(sql, `'${adapter}'`);
  }
  assertStringIncludes(
    sql,
    "makesafe_intake_cases_deterministic_shapes_check",
  );
  assertStringIncludes(sql, "searchedSourcePostIds");
  assertStringIncludes(sql, "sideEffectKeys");
});

Deno.test("terminal accounting is marker-bound, service-role-only, and requires cleanup plus exclusion proof", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  assertStringIncludes(
    sql,
    "CREATE TABLE IF NOT EXISTS public.ses_synthetic_livefire_runs",
  );
  assertStringIncludes(
    sql,
    "marker = 'SWG-SES-LIVEFIRE-TEST-ONLY-' || upper(run_id::text)",
  );
  assertStringIncludes(
    sql,
    "state IN ('active', 'cleanup_complete', 'terminal')",
  );
  assertStringIncludes(sql, "source_post_ids jsonb");
  assertStringIncludes(sql, "case_ids jsonb");
  assertStringIncludes(sql, "job_ids jsonb");
  assertStringIncludes(sql, '"deletable_store_cleanup_verified":true');
  assertStringIncludes(sql, '"projection_exclusion_verified":true');
  assertStringIncludes(sql, "OLD.state = 'cleanup_complete'");
  assertStringIncludes(sql, "run.state = 'terminal'");
  assert(
    !sql.includes("run.state IN ('cleanup_complete', 'terminal')"),
    "fresh-source health must not exclude cleanup_complete runs",
  );
  assertStringIncludes(sql, "run.source_post_ids ? email.post_id");
  assertStringIncludes(sql, "makesafe_synthetic_livefire_source_health");
  assertStringIncludes(sql, "terminalize_synthetic_livefire_run");
  assertStringIncludes(sql, "synthetic live-fire source exclusion proof failed");
  assertStringIncludes(sql, "fresh_source_health_after_terminal");
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "transactionally verified against terminal ledger state");
  assertStringIncludes(sql, "ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(
    sql,
    "FROM PUBLIC, anon, authenticated",
  );
  assertStringIncludes(
    sql,
    "TO service_role, postgres",
  );
  assertStringIncludes(
    sql,
    "ses_synthetic_livefire_runs is terminal accounting; DELETE is not allowed",
  );
  assertStringIncludes(
    sql,
    "DROP POLICY IF EXISTS service_role_all_ses_synthetic_livefire_runs",
  );
  assertStringIncludes(
    sql,
    "DROP TRIGGER IF EXISTS trg_ses_synthetic_livefire_runs_change",
  );
  assertStringIncludes(sql, "OLD.state = 'terminal'");
  assertStringIncludes(sql, "SECURITY INVOKER");
  assertStringIncludes(
    sql,
    "purge_synthetic_livefire_attendance_cycles",
  );
  assertStringIncludes(
    sql,
    "app.synthetic_livefire_purge_marker",
  );
});

Deno.test("pre-existing own-mail chatter is terminally accounted without mutating its source rows", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  assertStringIncludes(sql, "'legacy_own_mail_chatter'");
  assertStringIncludes(sql, "'marnin@secureworkswa.com.au'");
  assertStringIncludes(sql, "'ses@secureworkswa.com.au'");
  assertStringIncludes(sql, "intake_case.state = 'accounted_non_wo'");
  assertStringIncludes(sql, "intake_case.reason_code = 'non_makesafe'");
  assertStringIncludes(sql, "intake_case.adapter_id = 'chatter'");
  assertStringIncludes(sql, "intake_case.job_id IS NULL");
  assertStringIncludes(sql, "'projection_exclusion_verified', true");
});

Deno.test("migration never bypasses or deletes append-only intake evidence", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  assert(
    !/\bDISABLE\s+TRIGGER\b/i.test(sql),
    "migration must never disable an append-only trigger",
  );
  assert(
    !/\bDELETE\s+FROM\s+public\.(?:makesafe_intake|makesafe_docket|ses_)/i.test(
      sql,
    ),
    "migration must never delete intake, docket, or SES evidence",
  );
  assert(
    !/\bDROP\s+TRIGGER\b[\s\S]{0,120}\b(?:makesafe_intake|makesafe_docket|ses_external_effect)/i
      .test(sql),
    "migration must never drop an append-only evidence trigger",
  );
});

Deno.test("verified marker propagates from deterministic draft into job and event metadata", async () => {
  const runtime = await Deno.readTextFile(
    new URL("./makesafe_deterministic_intake_runtime.ts", import.meta.url),
  );
  const index = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );

  assertStringIncludes(
    runtime,
    "synthetic_livefire_marker: plan.identity.syntheticLivefireMarker",
  );
  assertStringIncludes(runtime, 'Deno.env.get("SW_API_KEY")');
  assertStringIncludes(
    index,
    "extraction.synthetic_livefire_marker,",
  );
  assertStringIncludes(
    index,
    "synthetic_livefire_marker: reviewedSyntheticLivefireMarker",
  );
  assertStringIncludes(
    index,
    "const usesSyntheticLivefireProfile = requesting_company_slug === 'synthetic-livefire'",
  );
  assertStringIncludes(
    index,
    "case 'ses_synthetic_livefire_capabilities'",
  );
  assertStringIncludes(index, "terminalSyntheticLivefireJobIds");
  assertStringIncludes(
    index,
    "synthetic_livefire_release_forbidden:",
  );
  for (const action of [
    "create_deposit_invoice",
    "create_unified_invoice",
    "void_invoice",
    "send_quick_quote_email",
    "send_client_update",
  ]) {
    assertStringIncludes(index, `synthetic live-fire safety gate`);
    assertStringIncludes(index, `'${action}'`);
  }
  assertStringIncludes(index, "release_refusal_probe: true");
  assertStringIncludes(
    index,
    "synthetic live-fire profile and UUID-bound marker must be present together",
  );
  assertStringIncludes(
    index,
    "synthetic live-fire job creation requires its exact active run ledger",
  );
  assertStringIncludes(
    index,
    "suppress_manager_notification !== true &&\n    !reviewedSyntheticLivefireMarker",
  );
  assertStringIncludes(index, "outbound_actions: false");
  assertStringIncludes(index, "xero_actions: false");
});
