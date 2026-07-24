// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalCompanyDedupeKey,
  canonicalExternalObligationRef,
  canonicalObligationPoCore,
} from "../_shared/makesafe_refs.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260720000002_makesafe_deterministic_intake_cutover.sql",
    import.meta.url,
  ),
);
const controlsMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260721000001_makesafe_intake_production_controls.sql",
    import.meta.url,
  ),
);
const fullOpenMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260721000002_makesafe_intake_full_open.sql",
    import.meta.url,
  ),
);
const lineageCorrectionMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260724025815_makesafe_lineage_authority_corrections.sql",
    import.meta.url,
  ),
);
const rollback = await Deno.readTextFile(
  new URL(
    "../../rollbacks/20260720000002_makesafe_deterministic_intake_mode_rollback.sql",
    import.meta.url,
  ),
);
const runtime = await Deno.readTextFile(
  new URL("./makesafe_deterministic_intake_runtime.ts", import.meta.url),
);
const core = await Deno.readTextFile(
  new URL("./makesafe_deterministic_intake.ts", import.meta.url),
);
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const terminalHook = await Deno.readTextFile(
  new URL("../../../docs/makesafe-intake-terminal-hook.md", import.meta.url),
);

Deno.test("cutover migration defaults to legacy and exposes one deterministic switch", () => {
  assertStringIncludes(
    migration,
    "intake_mode text NOT NULL DEFAULT 'legacy'",
  );
  assertStringIncludes(
    migration,
    "CHECK (intake_mode IN ('legacy', 'deterministic'))",
  );
  assertStringIncludes(migration, "makesafe_deterministic_intake_preflight");
  assertStringIncludes(
    rollback,
    "SET intake_mode = 'legacy'",
  );
  assert(!rollback.match(/DROP\s|DELETE\s|TRUNCATE\s/i));
});

Deno.test("case persistence carries story, manifest evidence, recovery and side-effect identity", () => {
  for (
    const column of [
      "story_json",
      "evidence_map",
      "recovery_cursor",
      "source_fingerprint",
      "adapter_version",
      "manifest_version",
      "deterministic_key",
    ]
  ) assertStringIncludes(migration, column);
  assertStringIncludes(migration, "makesafe_intake_artifacts");
  for (
    const kind of [
      "'pdf'",
      "'screenshot'",
      "'draft'",
      "'job'",
      "'invoice'",
      "'outbound_message'",
      "'approval'",
    ]
  ) assertStringIncludes(migration, kind);
});

Deno.test("deterministic runtime projections are narrow, paged and attachment reads are batched", () => {
  assertStringIncludes(runtime, ".range(from, to)");
  assertStringIncludes(runtime, "for (const ids of chunk(postIds))");
  assert(!runtime.includes('.select("*")'));
  assert(!runtime.includes("select('*')"));
  assert(!runtime.includes("scope_json"));
  assert(!runtime.includes("pricing_json"));
  assertStringIncludes(
    runtime,
    '.select("id,email_id,name,content_type,storage_path,status,size_bytes")',
  );
});

Deno.test("deterministic normal path has no model import or silent fallback", () => {
  const forbidden = [
    "Anthropic",
    "@anthropic-ai",
    "claude-",
    "messages.create",
  ];
  for (const token of forbidden) {
    assert(!core.includes(token), `core must not contain ${token}`);
    assert(!runtime.includes(token), `runtime must not contain ${token}`);
  }
  assertStringIncludes(index, "if (rollout.mode === 'deterministic')");
  assertStringIncludes(index, "approveDraft: approveIntakeDraft");
  assertStringIncludes(index, "suppress_manager_notification");
  assertStringIncludes(index, "approvedWorkOrderIdentity");
  assertStringIncludes(index, "existingWorkOrderIdentity");
  assertStringIncludes(runtime, "ai_calls: 0");
});

Deno.test("canonical external-obligation dedupe covers recovery composite refs at both write boundaries", () => {
  assertEquals(
    canonicalExternalObligationRef("MLB-26537"),
    canonicalExternalObligationRef("MLB-26537PO-56922"),
  );
  assertEquals(
    canonicalExternalObligationRef("mlb 26537 po 56866"),
    "MLB-26537",
  );
  assert(
    canonicalExternalObligationRef("MLB-26537PO-56922") !==
      canonicalExternalObligationRef("MLB-26538PO-56922"),
  );
  assertStringIncludes(runtime, "readExistingObligationJobs");
  assertStringIncludes(runtime, "canonicalExternalObligationRef(");
  assertStringIncludes(
    index,
    "canonicalExternalObligationRef(approvedFields.external_ref, prefixes)",
  );
  assertStringIncludes(
    index,
    "canonicalExternalObligationRef(row.external_ref, prefixes)",
  );
});

Deno.test("shared PO-core boundary reads a composite recovery ref only when labelled", () => {
  // Explicit PO fields: labelled and bare both resolve to the same core.
  assertEquals(canonicalObligationPoCore("PO-56922"), "56922");
  assertEquals(canonicalObligationPoCore("56922"), "56922");
  // Composite recovery ref supplies the PO ONLY under requireLabel, so the
  // claim digits (26537) are never mistaken for a PO.
  assertEquals(canonicalObligationPoCore("MLB-26537PO-56922", true), "56922");
  assertEquals(canonicalObligationPoCore("MLB-26537", true), null);
  // Distinct explicit POs stay distinct; a shared claim ref does not collapse them.
  assert(
    canonicalObligationPoCore("MLB-26537PO-56922", true) !==
      canonicalObligationPoCore("MLB-26537PO-56923", true),
  );
});

Deno.test("intake-draft approval mirrors the runtime composite-ref PO fallback", () => {
  // Approval boundary must fall back to the composite external_ref for BOTH the
  // approved side and the existing live job, exactly like readExistingObligationJobs,
  // so a distinct explicit PO is not false-blocked when the PO lives only in the ref.
  assertStringIncludes(
    index,
    "canonicalObligationPoCore(approvedFields.external_ref, true)",
  );
  assertStringIncludes(
    index,
    "canonicalObligationPoCore(row.external_ref, true)",
  );
  assertStringIncludes(
    index,
    "approvedPoCore && existingPoCore && approvedPoCore !== existingPoCore",
  );
  assertStringIncludes(
    runtime,
    "canonicalObligationPoCore(row.external_ref, true)",
  );
});

Deno.test("obligation dedupe collapses the full established builder alias set at one shared boundary", () => {
  // All MLB storage variants (raw slug, "majorloss", "mlbuilder", a company name)
  // collapse to one key so a deterministic MLB obligation matches a pre-existing
  // manual/recovery MLB job and never spawns a duplicate live job.
  assertEquals(canonicalCompanyDedupeKey("mlb"), "mlb");
  assertEquals(canonicalCompanyDedupeKey("Major Loss Builders"), "mlb");
  assertEquals(canonicalCompanyDedupeKey("mlbuilder"), "mlb");
  // AJ cluster and the rapid/prime aliases collapse too.
  assertEquals(canonicalCompanyDedupeKey("AJBR"), "ajsajbr");
  assertEquals(canonicalCompanyDedupeKey("aj building restoration"), "ajsajbr");
  assertEquals(canonicalCompanyDedupeKey("Rapid Response Group"), "rapid");
  assertEquals(canonicalCompanyDedupeKey("Prime Building"), "prime");
  // Distinct builders stay distinct; empty input is "no company proof".
  assert(
    canonicalCompanyDedupeKey("mlb") !== canonicalCompanyDedupeKey("acme"),
  );
  assertEquals(canonicalCompanyDedupeKey(""), "");
  assertEquals(canonicalCompanyDedupeKey(null), "");
  // Both obligation boundaries use the ONE shared helper, not a local strip.
  assertStringIncludes(
    runtime,
    "canonicalCompanyDedupeKey(item.identity.builderSlug)",
  );
  assertStringIncludes(
    index,
    "canonicalCompanyDedupeKey(approvedFields.requesting_company_slug",
  );
  assertStringIncludes(
    index,
    "canonicalCompanyDedupeKey(row.requesting_company_slug",
  );
});

Deno.test("cancelled/void/superseded jobs are excluded from the obligation match so a re-issue creates a live job", () => {
  // The runtime obligation dedupe selects jobs(metadata,status) and must skip dead
  // jobs; otherwise a fresh claim binds to a cancelled job_id and never goes live.
  assertStringIncludes(
    runtime,
    "isDeadObligationJobStatus(existingJob?.status)",
  );
  assertStringIncludes(runtime, '"superseded"');
  assertStringIncludes(runtime, '"cancelled"');
  assertStringIncludes(runtime, '"void"');
  // The approve-path duplicate guard mirrors the same re-issue exclusion.
  assert(
    index.includes(
      "['cancelled','canceled','void','voided','superseded'].includes(String(existingJob?.status",
    ),
  );
});

Deno.test("runtime existing-PO derivation mirrors the approve path's builder_work_order_number fallback", () => {
  // A distinct explicit PO stored only in builder_work_order_number must count on
  // BOTH boundaries so two explicitly-different POs are never over-deduped.
  assertStringIncludes(
    runtime,
    "canonicalObligationPoCore(metadata.builder_work_order_number, true)",
  );
  assertStringIncludes(
    index,
    "canonicalObligationPoCore(existingMetadata.builder_work_order_number, true)",
  );
});

Deno.test("runtime incoming (target) PO derivation mirrors the WO and composite-ref fallbacks", () => {
  // The INCOMING side must fall back to builderWoCanonical and the composite
  // externalRefCanonical exactly like the existing/approve sides, so a distinct
  // PO carried only in the WO or the composite ref still discriminates and a
  // genuinely distinct-PO obligation is not over-deduped into an existing job.
  assertStringIncludes(
    runtime,
    "canonicalObligationPoCore(item.identity.builderWoCanonical, true)",
  );
  assertStringIncludes(
    runtime,
    "canonicalObligationPoCore(item.identity.externalRefCanonical, true)",
  );
  // The shared PO-core helper proves the fallback semantics the target relies on:
  // a WO-labelled or composite value yields its PO core, a bare claim does not.
  assertEquals(canonicalObligationPoCore("PO-56922", true), "56922");
  assertEquals(canonicalObligationPoCore("MLB-26537PO-56922", true), "56922");
  assertEquals(canonicalObligationPoCore("MLB-26537", true), null);
});

Deno.test("canonicalSlug delegates to the one shared canonical company alias set", () => {
  // canonicalSlug (company/profile resolution) must not carry its own copy of the
  // builder alias set; it delegates to canonicalCompanyDedupeKey so a new alias
  // added there can never drift from the make-safe obligation dedupe boundary.
  assertStringIncludes(core, "canonicalCompanyDedupeKey(slug)");
  assertStringIncludes(
    core,
    'import { canonicalCompanyDedupeKey } from "../_shared/makesafe_refs.ts"',
  );
  // The alias set is no longer hand-copied inside canonicalSlug.
  assert(
    !core.includes('["aj", "ajs", "ajbr", "ajbuildingrestoration"].includes'),
  );
});

Deno.test("dry-run replay and exact dark observe take no business-write branch", () => {
  assertStringIncludes(runtime, "if (dryRun) {");
  assertStringIncludes(runtime, "await commitCompletedCursor();");
  assertStringIncludes(runtime, "by_builder_and_outcome");
  assertStringIncludes(runtime, "includeSanitizedCases");
  assertStringIncludes(
    index,
    "case 'makesafe_deterministic_intake_dark_observe'",
  );
  assert(!runtime.match(/console\.(?:log|error|warn)\s*\(/));
});

Deno.test("production controls default to N=1, exact empty allowlists and bounded later caps", () => {
  assertStringIncludes(
    controlsMigration,
    "deterministic_max_cases_per_run smallint NOT NULL DEFAULT 1",
  );
  assertStringIncludes(controlsMigration, "BETWEEN 1 AND 10");
  assertStringIncludes(controlsMigration, "deterministic_source_allowlist");
  assertStringIncludes(
    controlsMigration,
    "deterministic_instruction_allowlist",
  );
  assertStringIncludes(runtime, "loadDeterministicRolloutControls");
  assertStringIncludes(runtime, "requires a non-empty exact DB allowlist");
  assertStringIncludes(index, "requireAllAllowlistMatches: true");
});

Deno.test("scheduled scans detach from pg_net and cursor progress means completion", () => {
  assertStringIncludes(index, "selectionMode: rollout.selectionMode");
  assertStringIncludes(runtime, "const commitCompletedCursor");
  assertStringIncludes(
    runtime,
    "chunk(cases.map((c) => c.instructionKey))",
  );
  assert(!runtime.includes("chunk(cases.map((c) => c.instructionKey), 200)"));
  assertStringIncludes(
    runtime,
    '"scan_page_completed_degraded_retry_next_sweep"',
  );
  const cursorCommit = runtime.lastIndexOf("await commitCompletedCursor();");
  const healthWrite = runtime.lastIndexOf("await writeHealth(");
  assert(
    cursorCommit > healthWrite,
    "live cursor must commit after truthful health",
  );

  const monitor = Deno.readTextFileSync(
    new URL("../monitor-ses-makesafes/index.ts", import.meta.url),
  );
  assertStringIncludes(monitor, "_scheduleIntakeScanContinuation");
  assertStringIncludes(monitor, "edgeRuntime.waitUntil(promise)");
  assertStringIncludes(monitor, "lockHeld = false;");
  assertStringIncludes(monitor, "continuation lock release failed");
  assert(!monitor.includes("const scanResp = await fetch(opsApiUrl"));
});

Deno.test("full-open is explicit, bounded and distinct from exact-empty fail-closed", () => {
  assertStringIncludes(
    fullOpenMigration,
    "deterministic_selection_mode text NOT NULL DEFAULT 'exact'",
  );
  assertStringIncludes(
    fullOpenMigration,
    "deterministic_selection_mode IN ('exact', 'full_open')",
  );
  assertStringIncludes(
    fullOpenMigration,
    "makesafe_cron_settings_full_open_empty_allowlists_check",
  );
  assertStringIncludes(runtime, 'selectionMode === "full_open"');
  assertStringIncludes(
    runtime,
    "deterministic exact mode requires a non-empty exact DB allowlist",
  );
  assertStringIncludes(
    runtime,
    "deterministic full_open mode requires empty exact allowlists",
  );
  assertStringIncludes(index, "selectionMode: rollout.selectionMode");
});

Deno.test("lineage correction is append-only, snapshot-guarded and side-effect-free", () => {
  for (
    const table of [
      "makesafe_intake_case_authority_corrections",
      "makesafe_intake_source_authority_corrections",
    ]
  ) {
    assertStringIncludes(
      lineageCorrectionMigration,
      `CREATE TABLE public.${table}`,
    );
    assertStringIncludes(
      lineageCorrectionMigration,
      `ALTER TABLE public.${table}\n  ENABLE ROW LEVEL SECURITY`,
    );
    assertStringIncludes(
      lineageCorrectionMigration,
      `REVOKE ALL ON public.${table}`,
    );
    assertStringIncludes(
      lineageCorrectionMigration,
      `GRANT SELECT ON public.${table}`,
    );
  }
  assertEquals(
    lineageCorrectionMigration.match(
      /EXECUTE FUNCTION public\.reject_makesafe_intake_append_only_mutation\(\)/g,
    )?.length,
    2,
  );
  for (
    const invariant of [
      "expected 335 cases",
      "expected 600 sources and 46 sourceless cases",
      "expected 294 corrected partitions over 600 sources",
      "correction ledger is not empty",
      "source is already accounted",
      "existing job identity changed",
      "Hugo assignment changed",
      "side-effect row count changed",
      "job or assignment changed",
    ]
  ) {
    assertStringIncludes(lineageCorrectionMigration, invariant);
  }
  for (
    const manifest of [
      "a68ca7336898b806ba09e7343ed0afa0977560e42c737e4def935015da2f686d",
      "7d2697dca8a87df9b06d674a0bafac8086435abf77133085000d2b927a5d7697",
      "07ba10f78e94e98e0b7039c4ca6e487c727d121a3be7708b996d20776a76b808",
      "2b15f65eea187bbcb60d37ab99574d8dac5629408659fa8fe333ab404cfb5926",
    ]
  ) assertStringIncludes(lineageCorrectionMigration, manifest);

  assertStringIncludes(lineageCorrectionMigration, "SWMS-261054");
  assertStringIncludes(
    lineageCorrectionMigration,
    "401b97c8-b5e8-49ff-8202-5be5bb0a1135",
  );
  assertStringIncludes(
    lineageCorrectionMigration,
    "b353f39a-b3cc-495d-a016-50ebf4a8497d",
  );
  assertStringIncludes(
    lineageCorrectionMigration,
    "'existing_job_binding',\n    'wo:AJBR-70062'",
  );
  assertStringIncludes(
    lineageCorrectionMigration,
    "A migration-provisioned database has neither the historical BOX footprint",
  );
  for (
    const forbidden of [
      "UPDATE public.jobs",
      "UPDATE public.job_assignments",
      "UPDATE public.makesafe_intake_drafts",
      "INSERT INTO public.jobs",
      "INSERT INTO public.job_assignments",
      "INSERT INTO public.makesafe_intake_drafts",
      "INSERT INTO public.outbound_message_queue",
      "INSERT INTO public.makesafe_notify_log",
      "DELETE FROM public.",
    ]
  ) {
    assert(
      !lineageCorrectionMigration.includes(forbidden),
      `correction migration contains forbidden operational write: ${forbidden}`,
    );
  }
});

Deno.test("attachment staging uses a content hash and append-only artifact ledger", () => {
  assertStringIncludes(runtime, "contentSha256");
  assertStringIncludes(runtime, '"makesafe_intake_artifacts"');
  assertStringIncludes(runtime, 'artifact_kind: "pdf"');
  assertStringIncludes(runtime, 'status: "completed"');
});

Deno.test("deterministic runtime has no assignment, work-order, invoice or communication writer", () => {
  for (
    const forbidden of [
      'from("job_assignments")',
      'from("work_orders")',
      'from("xero_invoices")',
      'from("outbound_messages")',
      "send_sms",
      "notifyVerticalManagersSms",
    ]
  ) {
    assert(
      !runtime.includes(forbidden),
      `runtime contains forbidden writer ${forbidden}`,
    );
  }
});

Deno.test("ruling 5 terminal skill hook stays deterministic and non-privileged", () => {
  const routineAllowlist = index.slice(
    index.indexOf("const ROUTINE_ALLOWED_ACTIONS"),
    index.indexOf("if (authMode === 'routine'"),
  );
  assertStringIncludes(
    routineAllowlist,
    "'makesafe_deterministic_intake_dark_observe'",
  );
  assertStringIncludes(terminalHook, "Automatic code");
  assertStringIncludes(terminalHook, "Terminal make-safe skill");
  assertStringIncludes(terminalHook, "Manual operator");
  assertStringIncludes(terminalHook, "paid AI extraction API stays off");
  assertStringIncludes(terminalHook, "may not call\n`approve_intake_draft`");
});

Deno.test("health exposes effective mode and fresh authenticated alarm proof", () => {
  assertStringIncludes(controlsMigration, "alarm_auth_verified_at");
  assertStringIncludes(index, "intake_mode: intakeMode");
  assertStringIncludes(
    index,
    "latestAuthenticatedAt: health?.alarm_auth_action === 'makesafe_email_canary'",
  );
  assertStringIncludes(
    index,
    "intakeMode !== 'unknown' && alarmReadiness.ready",
  );
  assertStringIncludes(index, "recordMakesafeAlarmAuthentication");
});
