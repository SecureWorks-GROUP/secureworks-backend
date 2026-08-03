// deno-lint-ignore-file no-import-prefix
//
// Captain's ruling 2026-08-03: the unsatisfiable `makesafe_readiness_current.ready`
// precondition is removed from the invoice-obligation path, (same day, same
// ruling extended) from the APPROVAL path, and (same day again, "Extend #511
// ruling to send path") from the SEND path's release-execution reservation.
//
// These tests read the EFFECTIVE function bodies, not one migration file: every
// migration is scanned in version order and the LAST `CREATE OR REPLACE FUNCTION`
// for a given name wins, which is exactly what the database ends up holding. That
// is what makes this a real regression test -- delete or neuter
// `20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql`,
// `20260803020000_ses_drop_approval_readiness_precondition.sql` or
// `20260803030000_ses_drop_release_execution_readiness_precondition.sql` and the
// effective bodies revert to the 20260728020000 ones, which still carry all four
// RAISE blocks, and the assertions below fail.
//
// The controls must pass on BOTH shapes: they pin the gates this ruling does NOT
// touch -- the money seal, the human APPROVE INVOICE login requirement, the SES
// release allowlist, the mechanically-clean test, the genuine freshness checks,
// the approvals view (`readiness.ready = true`), and the Xero invoice-creation
// execution gate.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);

async function migrationsInVersionOrder(): Promise<
  Array<{ name: string; sql: string }>
> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();
  const out: Array<{ name: string; sql: string }> = [];
  for (const name of names) {
    out.push({
      name,
      sql: await Deno.readTextFile(new URL(name, MIGRATIONS_DIR)),
    });
  }
  return out;
}

const MIGRATIONS = await migrationsInVersionOrder();

/**
 * The body Postgres ends up with for `functionName`: the last
 * `CREATE OR REPLACE FUNCTION public.<name>(` ... `$$;` block across all
 * migrations in version order.
 */
function effectiveFunction(
  functionName: string,
): { migration: string; body: string } {
  let found: { migration: string; body: string } | null = null;
  for (const migration of MIGRATIONS) {
    const marker = `CREATE OR REPLACE FUNCTION public.${functionName}(`;
    let from = migration.sql.indexOf(marker);
    while (from !== -1) {
      const end = migration.sql.indexOf("\n$$;", from);
      assert(
        end !== -1,
        `unterminated body for ${functionName} in ${migration.name}`,
      );
      found = {
        migration: migration.name,
        body: migration.sql.slice(from, end + 4),
      };
      from = migration.sql.indexOf(marker, end);
    }
  }
  assert(found, `no definition found for ${functionName}`);
  return found;
}

const OBLIGATION = effectiveFunction(
  "commit_ses_invoice_obligation_revision_v1",
);
const BOUND_DOCKET = effectiveFunction("commit_ses_invoice_bound_docket_v1");
const APPROVAL = effectiveFunction("record_ses_revision_approval_v1");
const RELEASE_EXECUTE = effectiveFunction("begin_ses_release_execution_v1");

Deno.test("the drop migration owns the effective obligation and bind bodies", () => {
  assertEquals(
    OBLIGATION.migration,
    "20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql",
  );
  assertEquals(
    BOUND_DOCKET.migration,
    "20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql",
  );
});

Deno.test("the obligation commit no longer refuses on an uncertified readiness revision", () => {
  assert(
    !OBLIGATION.body.includes(
      "the job has no current ready evidence revision to bind to this invoice proposal",
    ),
    "the unsatisfiable readiness refusal is still in the effective obligation body",
  );
  assert(
    !/NOT\s+prior_readiness\.current_ready\s+THEN\s+RAISE/.test(
      OBLIGATION.body,
    ),
    "a RAISE is still guarded on prior_readiness.current_ready being false",
  );
});

Deno.test("the invoice-bound docket commit no longer refuses on an uncertified readiness revision", () => {
  assert(
    !BOUND_DOCKET.body.includes(
      "new evidence landed; review the current docket revision again",
    ),
    "the unsatisfiable readiness refusal is still in the effective bind body",
  );
  assert(
    !/NOT\s+prior_readiness\.current_ready\s+THEN\s+RAISE/.test(
      BOUND_DOCKET.body,
    ),
    "a RAISE is still guarded on prior_readiness.current_ready being false",
  );
});

Deno.test("readiness is dropped as a blocker, never asserted", () => {
  for (const fn of [OBLIGATION, BOUND_DOCKET]) {
    // The readiness read still runs and still decides whether readiness may be
    // carried forward: the precondition is dropped, the question is not.
    assertStringIncludes(fn.body, "FROM public.makesafe_readiness_current");
    assertStringIncludes(
      fn.body,
      "readiness_certified := FOUND AND COALESCE(prior_readiness.current_ready, false);",
    );
    // Every readiness commit sits inside the certified branch, so nothing can
    // originate a ready readiness revision.
    const commitAt = fn.body.indexOf("public.commit_makesafe_readiness(");
    assert(commitAt !== -1, "the readiness commit call vanished");
    const branchAt = fn.body.indexOf("IF readiness_certified THEN");
    assert(branchAt !== -1, "the certified branch is missing");
    assert(
      branchAt < commitAt,
      "commit_makesafe_readiness is reachable without a certified prior revision",
    );
    assertEquals(
      (fn.body.match(/public\.commit_makesafe_readiness\(/g) || []).length,
      1,
      "exactly one readiness commit call is expected per function",
    );
  }
  // The obligation path can only ever WEAKEN readiness: `true AND x`.
  assertStringIncludes(
    OBLIGATION.body,
    "next_ready := prior_readiness.current_ready AND",
  );
  assert(
    !/next_ready\s*:=\s*true/i.test(OBLIGATION.body),
    "next_ready must never be assigned a literal true",
  );
});

Deno.test("an uncertified mint is recorded, not silently omitted", () => {
  // No schema change: the append-only invalidation ledger already carries the
  // exact obligation revision id in `dependency_identity`.
  assertStringIncludes(
    OBLIGATION.body,
    "readiness was NOT certified at mint (captain ruling 2026-08-03",
  );
  assertStringIncludes(
    OBLIGATION.body,
    "'makesafe_invoice_obligation_revisions',",
  );
  assertStringIncludes(
    OBLIGATION.body,
    "'readiness_certified', readiness_certified",
  );
  assertStringIncludes(
    BOUND_DOCKET.body,
    "readiness was NOT certified at bind (captain ruling 2026-08-03",
  );
  // The invalidator still runs on every commit, certified or not.
  for (const fn of [OBLIGATION, BOUND_DOCKET]) {
    assertStringIncludes(fn.body, "public.invalidate_makesafe_readiness(");
  }
});

Deno.test("no other precondition on the obligation path was removed", () => {
  for (
    const refusal of [
      "obligation and revision objects are required",
      "at least one attendance cycle is required",
      "job does not exist",
      "invoice obligation revision id resolves to different content",
      "released or Xero-bound work cannot be superseded; create a new obligation after human disposition",
      "new revision must explicitly supersede the current pending revision",
    ]
  ) {
    assertStringIncludes(OBLIGATION.body, refusal);
  }
  for (
    const refusal of [
      "AUTHORISED Xero binding and real invoice PDF artifact are required",
      "invoice-bound docket id resolves to different content",
      "the reviewed pre-Xero docket revision no longer exists",
      "invoice PDF must bind from a pre-Xero docket revision",
      "the AUTHORISED Xero invoice is not confirmed by the exact effect ledger",
      "attach the Xero PDF before recording SEND IT approval",
    ]
  ) {
    assertStringIncludes(BOUND_DOCKET.body, refusal);
  }
});

// ── Controls. These must pass on BOTH the old and the new shape. ──

Deno.test("CONTROL: the human APPROVE INVOICE gate is untouched", async () => {
  const actions = await Deno.readTextFile(
    new URL("./ses_reporting_actions.ts", import.meta.url),
  );
  assertStringIncludes(
    actions,
    '!authority.allowed || operatorAuth.mode !== "jwt" || !auth.user',
  );
  assertStringIncludes(
    actions,
    "This identified operator cannot approve the current invoice revision.",
  );
  // A non-human caller never reaches jwt mode.
  assertStringIncludes(
    actions,
    'if (auth.mode === "api_key" || auth.mode === "routine") {\n    return { mode: auth.mode };',
  );
});

// ── The third gate: record_ses_revision_approval_v1, authorised 2026-08-03 as
// the same ruling extended. See data/ses-readiness-gate-drop-v1/report.md §6. ──

Deno.test("the approval drop migration owns the effective approval body", () => {
  assertEquals(
    APPROVAL.migration,
    "20260803020000_ses_drop_approval_readiness_precondition.sql",
  );
});

Deno.test("the approval commit no longer refuses on an uncertified readiness revision", () => {
  // The INNER JOIN was the whole defect: makesafe_readiness_revisions is empty,
  // so NOT FOUND fired for every job on the board.
  assert(
    !APPROVAL.body.includes("\n  JOIN public.makesafe_readiness_revisions"),
    "the approval read still INNER JOINs the empty readiness revisions table",
  );
  assertStringIncludes(
    APPROVAL.body,
    "LEFT JOIN public.makesafe_readiness_revisions revision",
  );
  // A missing readiness row is still its own refusal, split out of the old
  // combined IF rather than dropped.
  assertStringIncludes(APPROVAL.body, "IF NOT FOUND THEN");
  // `ready` / `revision_ready` may only be tested inside the certified branch.
  const certifiedAt = APPROVAL.body.indexOf(
    "readiness_certified := current_readiness.readiness_revision IS NOT NULL;",
  );
  assert(certifiedAt !== -1, "the certified branch guard is missing");
  for (
    const probe of ["NOT current_readiness.ready", "revision_ready, false"]
  ) {
    const at = APPROVAL.body.indexOf(probe);
    assert(at !== -1, `the certified-branch test "${probe}" vanished`);
    assert(
      at > certifiedAt,
      `"${probe}" is still reachable without a certified readiness revision`,
    );
    assertEquals(
      (APPROVAL.body.match(
        new RegExp(probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      ) || []).length,
      1,
      `"${probe}" must appear exactly once, inside the certified branch`,
    );
  }
});

Deno.test("readiness is never asserted on the approval path", () => {
  // This function has no business originating readiness, and never did.
  assert(
    !APPROVAL.body.includes("commit_makesafe_readiness"),
    "the approval path must never commit a readiness revision",
  );
  assert(
    !/(?:^|[^_])ready\s*(?::)?=\s*true/i.test(APPROVAL.body),
    "the approval path must never assign readiness true",
  );
  // And it must not fabricate a readiness identity to satisfy the column.
  assert(
    !/'sha256:[0-9a-f]/.test(APPROVAL.body),
    "the approval path must never synthesise a readiness revision literal",
  );
  // The column is written from what the caller was shown, nothing else.
  assertStringIncludes(
    APPROVAL.body,
    "p_approval->>'readiness_revision',",
  );
});

Deno.test("an uncertified approval can actually be recorded", () => {
  // Dropping the RAISE alone leaves a 23502 four statements later: the audit
  // column was NOT NULL with a strict sha256 CHECK, and production readiness
  // revisions are NULL on every row.
  const drop = MIGRATIONS.find((m) =>
    m.name === "20260803020000_ses_drop_approval_readiness_precondition.sql"
  );
  assert(drop, "the approval drop migration is missing");
  assertStringIncludes(
    drop.sql,
    "ALTER COLUMN readiness_revision DROP NOT NULL;",
  );
  assertStringIncludes(
    drop.sql,
    "readiness_revision IS NULL\n    OR readiness_revision ~ '^sha256:[0-9a-f]{64}$'",
  );
  // Nothing later puts NOT NULL back.
  const restorers = MIGRATIONS.filter((m) =>
    m.name > "20260803020000_ses_drop_approval_readiness_precondition.sql" &&
    /makesafe_revision_approvals[\s\S]*ALTER COLUMN readiness_revision SET NOT NULL/
      .test(m.sql)
  );
  assertEquals(restorers.map((m) => m.name), []);
  // NULL is the record that readiness was not certified, and it is documented
  // on the column itself rather than left to be rediscovered.
  assertStringIncludes(
    drop.sql,
    "COMMENT ON COLUMN public.makesafe_revision_approvals.readiness_revision IS",
  );
  assertStringIncludes(drop.sql, 'the predicate for "approved without ');
});

Deno.test("the approval drop migration destroys nothing and touches no money row", () => {
  const drop = MIGRATIONS.find((m) =>
    m.name === "20260803020000_ses_drop_approval_readiness_precondition.sql"
  );
  assert(drop, "the approval drop migration is missing");
  const executable = drop.sql.split("\n").filter((line) =>
    !line.trimStart().startsWith("--")
  ).join("\n");
  for (
    const forbidden of [
      "DROP TABLE",
      "DROP FUNCTION",
      "DROP TRIGGER",
      "UPDATE public.makesafe_readiness_current",
      "SET ready = true",
      "ses_money_sealed_at",
      "xero_invoices",
    ]
  ) {
    assert(
      !executable.includes(forbidden),
      `no executable statement in the approval drop migration may contain "${forbidden}"`,
    );
  }
  // Apply time writes zero rows. `DROP CONSTRAINT` is DDL on a zero-row audit
  // table, not a data write, and only the readiness CHECK is in its sights.
  const topLevel = executable.replace(/AS \$\$[\s\S]*?\n\$\$;/g, "AS <body>;");
  for (
    const forbidden of ["INSERT INTO", "DELETE FROM", "UPDATE ", "TRUNCATE"]
  ) {
    assert(
      !topLevel.includes(forbidden),
      `the approval drop migration must write zero rows at apply time, found "${forbidden}"`,
    );
  }
  // The append-only guard on the approvals table is untouched.
  assert(
    !executable.includes("trg_makesafe_revision_approvals_append_only"),
    "the append-only trigger on the approvals table must not be touched",
  );
});

Deno.test("CONTROL: the approval path keeps its genuine freshness check", () => {
  // This is the half of the old IF that the message actually described, and it
  // is satisfiable: dependency_generation is a real, moving, non-null value.
  // Unchanged by the ruling, so this passes on BOTH shapes.
  assertStringIncludes(
    APPROVAL.body,
    "current_readiness.readiness_revision IS DISTINCT FROM",
  );
  assertStringIncludes(
    APPROVAL.body,
    "current_readiness.dependency_generation IS DISTINCT FROM",
  );
  assertStringIncludes(
    APPROVAL.body,
    "new evidence landed; review the current docket revision again",
  );
});

Deno.test("CONTROL: the approval authority tests are untouched", () => {
  // Passes on BOTH shapes. A routine or api-key caller never reaches this RPC
  // (see the human APPROVE INVOICE gate control above); these are the in-database
  // authority tests, and the ruling removes none of them.
  for (
    const refusal of [
      "SES approval action must be invoice or release",
      "operator is not on the SES release allowlist",
      "this docket is not mechanically clean; Captain approval is required",
      "Captain override requires Captain or admin-owner authority",
    ]
  ) {
    assertStringIncludes(APPROVAL.body, refusal);
  }
  // The approval is still recorded against a real operator identity.
  assertStringIncludes(
    APPROVAL.body,
    "target_operator,\n    p_approval->>'decided_by',",
  );
});

// ── The fourth gate: begin_ses_release_execution_v1, authorised 2026-08-03 as
// "Extend #511 ruling to send path". See
// 20260803030000_ses_drop_release_execution_readiness_precondition.sql. ──

Deno.test("the release-execution drop migration owns the effective release execute body", () => {
  assertEquals(
    RELEASE_EXECUTE.migration,
    "20260803030000_ses_drop_release_execution_readiness_precondition.sql",
  );
});

Deno.test("the release execute no longer refuses on an uncertified readiness", () => {
  // A missing readiness row is still its own refusal, split out of the old
  // bundled IF rather than dropped.
  assertStringIncludes(RELEASE_EXECUTE.body, "IF NOT FOUND THEN");
  // `ready` may only be tested inside the certified branch.
  const certifiedAt = RELEASE_EXECUTE.body.indexOf(
    "readiness_certified := current_readiness.readiness_revision IS NOT NULL;",
  );
  assert(certifiedAt !== -1, "the certified branch guard is missing");
  const probe = "NOT current_readiness.ready";
  const at = RELEASE_EXECUTE.body.indexOf(probe);
  assert(at !== -1, "the certified-branch readiness test vanished");
  assert(
    at > certifiedAt,
    "the readiness test is still reachable without a certified readiness revision",
  );
  assertEquals(
    (RELEASE_EXECUTE.body.match(
      new RegExp(probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    ) || []).length,
    1,
    `"${probe}" must appear exactly once, inside the certified branch`,
  );
});

Deno.test("readiness is never asserted on the send path", () => {
  // This function has no business originating readiness, and never did.
  assert(
    !RELEASE_EXECUTE.body.includes("commit_makesafe_readiness"),
    "the send path must never commit a readiness revision",
  );
  assert(
    !/(?:^|[^_])ready\s*(?::)?=\s*true/i.test(RELEASE_EXECUTE.body),
    "the send path must never assign readiness true",
  );
  // And it must not fabricate a readiness identity to satisfy the freshness check.
  assert(
    !/'sha256:[0-9a-f]/.test(RELEASE_EXECUTE.body),
    "the send path must never synthesise a readiness revision literal",
  );
});

Deno.test("CONTROL: the release execute keeps its genuine freshness check", () => {
  // This is the half of the old bundled IF that the message actually described,
  // and it is satisfiable: dependency_generation is a real, moving, non-null
  // value, and a NULL readiness revision in a binding compares equal to a NULL
  // current under IS DISTINCT FROM. Unchanged by the ruling, so this passes on
  // BOTH shapes.
  assertStringIncludes(
    RELEASE_EXECUTE.body,
    "current_readiness.readiness_revision IS DISTINCT FROM",
  );
  assertStringIncludes(
    RELEASE_EXECUTE.body,
    "current_readiness.dependency_generation IS DISTINCT FROM",
  );
  assertStringIncludes(
    RELEASE_EXECUTE.body,
    "new evidence landed; review the current release revision again",
  );
});

Deno.test("CONTROL: the release execute keeps every other gate", () => {
  // Passes on BOTH shapes. Every refusal the ruling did not name survives.
  for (
    const refusal of [
      "the approved release revision no longer exists",
      "the displayed release content no longer matches the stored revision",
      "human SEND IT approval is missing for this release revision",
      "the release member set does not match its readiness bindings",
      "human SEND IT approval is missing for a release member",
      "human SEND IT approval does not cover the exact release member set",
    ]
  ) {
    assertStringIncludes(RELEASE_EXECUTE.body, refusal);
  }
  // The per-member human SEND IT approval visibility check still consults the
  // approvals view, and the only write is still the release's own state move.
  assertStringIncludes(
    RELEASE_EXECUTE.body,
    "FROM public.makesafe_revision_approvals_current_v2",
  );
  assertStringIncludes(RELEASE_EXECUTE.body, "SET state = 'dispatching'");
});

Deno.test("the release-execution drop migration destroys nothing and touches no money row", () => {
  const drop = MIGRATIONS.find((m) =>
    m.name ===
      "20260803030000_ses_drop_release_execution_readiness_precondition.sql"
  );
  assert(drop, "the release-execution drop migration is missing");
  // Strip `--` comment lines: the migration names the seal, the view and the
  // readiness tables in prose precisely to record that they are out of scope.
  // No executable statement may touch them.
  const executable = drop.sql.split("\n").filter((line) =>
    !line.trimStart().startsWith("--")
  ).join("\n");
  for (
    const forbidden of [
      "DROP TABLE",
      "DROP FUNCTION",
      "DROP TRIGGER",
      "UPDATE public.makesafe_readiness_current",
      "SET ready = true",
      "ses_money_sealed_at",
      "xero_invoices",
    ]
  ) {
    assert(
      !executable.includes(forbidden),
      `no executable statement in the release-execution drop migration may contain "${forbidden}"`,
    );
  }
  // Apply time writes zero rows: strip the `AS $$ ... $$;` function body and
  // nothing that mutates data may remain at migration top level.
  const topLevel = executable.replace(/AS \$\$[\s\S]*?\n\$\$;/g, "AS <body>;");
  for (
    const forbidden of ["INSERT INTO", "DELETE FROM", "UPDATE ", "TRUNCATE"]
  ) {
    assert(
      !topLevel.includes(forbidden),
      `the release-execution drop migration must write zero rows at apply time, found "${forbidden}"`,
    );
  }
});

Deno.test("CONTROL: the approvals view and the Xero invoice-creation gate are untouched", () => {
  // The ruling stops at the readiness precondition on the send path. The
  // approvals view still requires `readiness.ready = true`, the release
  // execute still consults it for per-member approval visibility, and the
  // invoice execution function still reads it. Passes on BOTH shapes.
  const u5 = MIGRATIONS.find((m) =>
    m.name === "20260728020000_makesafe_ses_invoice_release_u5_u6.sql"
  );
  assert(u5, "the U5/U6 migration is missing");
  assertStringIncludes(
    u5.sql,
    "CREATE OR REPLACE VIEW public.makesafe_revision_approvals_current_v2",
  );
  assertStringIncludes(u5.sql, "AND readiness.ready = true;");
  assertEquals(
    effectiveFunction("begin_ses_invoice_execution_v1").migration,
    "20260728020000_makesafe_ses_invoice_release_u5_u6.sql",
  );
  // The two #511 drop migrations rewrite neither the view nor an execution
  // function. Comment lines are stripped: both migrations NAME these sites in
  // prose, precisely to record that they are out of scope.
  for (
    const name of [
      "20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql",
      "20260803020000_ses_drop_approval_readiness_precondition.sql",
    ]
  ) {
    const migration = MIGRATIONS.find((m) => m.name === name);
    if (!migration) continue;
    const executable = migration.sql.split("\n").filter((line) =>
      !line.trimStart().startsWith("--")
    ).join("\n");
    assert(
      !executable.includes("makesafe_revision_approvals_current_v2"),
      `${name} must not rewrite the approvals view`,
    );
    assert(
      !executable.includes(
        "CREATE OR REPLACE FUNCTION public.begin_ses_",
      ),
      `${name} must not rewrite an execution function`,
    );
  }
  // The send-path migration's function body still CONSULTS the view (the
  // approval visibility check is preserved verbatim), so the no-mention rule
  // above cannot apply to it; the rule for it is: never rewrite the view.
  const sendDrop = MIGRATIONS.find((m) =>
    m.name ===
      "20260803030000_ses_drop_release_execution_readiness_precondition.sql"
  );
  assert(sendDrop, "the release-execution drop migration is missing");
  const sendExecutable = sendDrop.sql.split("\n").filter((line) =>
    !line.trimStart().startsWith("--")
  ).join("\n");
  for (
    const rewrite of [
      "CREATE OR REPLACE VIEW public.makesafe_revision_approvals_current_v2",
      "CREATE VIEW public.makesafe_revision_approvals_current_v2",
      "ALTER VIEW public.makesafe_revision_approvals_current_v2",
      "DROP VIEW public.makesafe_revision_approvals_current_v2",
    ]
  ) {
    assert(
      !sendExecutable.includes(rewrite),
      `the release-execution drop migration must not rewrite the approvals view ("${rewrite}")`,
    );
  }
});

Deno.test("the drop migration destroys nothing and touches no money row", () => {
  const drop = MIGRATIONS.find((m) =>
    m.name ===
      "20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql"
  );
  assert(drop, "the drop migration is missing");
  // Strip `--` comment lines: the migration names the seal and the readiness
  // tables in prose precisely to record that they are out of scope. No
  // executable statement may touch them.
  const executable = drop.sql.split("\n").filter((line) =>
    !line.trimStart().startsWith("--")
  ).join("\n");
  for (
    const forbidden of [
      "DROP TABLE",
      "DROP FUNCTION",
      "DROP TRIGGER",
      "UPDATE public.makesafe_readiness_current",
      "SET ready = true",
      "ses_money_sealed_at",
      "xero_invoices",
    ]
  ) {
    assert(
      !executable.includes(forbidden),
      `no executable statement in the drop migration may contain "${forbidden}"`,
    );
  }
  // Apply time writes zero rows: strip the `AS $$ ... $$;` function bodies and
  // nothing that mutates data may remain at migration top level.
  const topLevel = executable.replace(/AS \$\$[\s\S]*?\n\$\$;/g, "AS <body>;");
  for (
    const forbidden of ["INSERT INTO", "DELETE FROM", "UPDATE ", "TRUNCATE"]
  ) {
    assert(
      !topLevel.includes(forbidden),
      `the drop migration must write zero rows at apply time, found "${forbidden}"`,
    );
  }
});

// ── Controls. These must pass on BOTH the old and the new shape: none of them
// reads the new migration, so reverting the implementation leaves them green. ──

Deno.test("CONTROL: the readiness table, its invalidator and its recording behaviour survive", () => {
  const u2 = MIGRATIONS.find((m) =>
    m.name === "20260728000001_makesafe_state_authority_u2.sql"
  );
  assert(u2, "the U2 readiness migration is missing");
  assertStringIncludes(
    u2.sql,
    "CREATE TABLE IF NOT EXISTS public.makesafe_readiness_current",
  );
  assertStringIncludes(
    u2.sql,
    "CREATE TABLE IF NOT EXISTS public.makesafe_readiness_revisions",
  );
  assertStringIncludes(
    u2.sql,
    "CREATE OR REPLACE FUNCTION public.invalidate_makesafe_readiness(",
  );
  // The invalidator still creates the row and still writes false.
  assertStringIncludes(
    u2.sql,
    "INSERT INTO public.makesafe_readiness_current (job_id, org_id)",
  );
  assertStringIncludes(u2.sql, "readiness_revision = NULL,");
  // Nothing later drops or rewrites the readiness relations.
  const rewriters = MIGRATIONS.filter((m) =>
    m.name > "20260728000001_makesafe_state_authority_u2.sql" &&
    (m.sql.includes("DROP TABLE IF EXISTS public.makesafe_readiness") ||
      m.sql.includes("DROP TABLE public.makesafe_readiness"))
  );
  assertEquals(rewriters.map((m) => m.name), []);
});

Deno.test("CONTROL: the money seal fence is intact", async () => {
  const fence = await Deno.readTextFile(
    new URL("../_shared/sealed_ses_money_fence.ts", import.meta.url),
  );
  // The sealed verbs still refuse; the one read exemption stays a closed set.
  assertStringIncludes(fence, "SEALED_SES_MONEY_READ_EXEMPT_ACTIONS");
  assertStringIncludes(fence, "get_invoice_pdf");
});

Deno.test("CONTROL: a genuinely blocked docket still cannot produce an executable obligation", async () => {
  const actions = await Deno.readTextFile(
    new URL("./ses_reporting_actions.ts", import.meta.url),
  );
  // Pre-RPC docket preconditions, all untouched by this ruling.
  assertStringIncludes(
    actions,
    "No U4 pre-Xero docket exists for this invoice proposal.",
  );
  assertStringIncludes(
    actions,
    "The current docket is not a pre-Xero proposal that can mint an invoice obligation.",
  );
  assertStringIncludes(actions, '"pricing_evidence_missing"');
  // And a blocked revision still cannot be executed into Xero.
  const execute = effectiveFunction("begin_ses_invoice_execution_v1");
  assertStringIncludes(
    execute.body,
    "jsonb_array_length(target_revision.blockers) > 0",
  );
  assertStringIncludes(
    execute.body,
    "the invoice obligation has no executable priced line set",
  );
});
