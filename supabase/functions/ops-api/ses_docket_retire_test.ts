// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
//
// Captain ruling R4 (2026-08-03, mission contract
// MISSION-CONTRACT-2026-08-03-BOARD-TRUTH.md): the audited, captain-gated
// `retire_ses_docket_revision` action is the ONLY eviction mechanism for
// polluted Docs Ready dockets (already-reported jobs, wrong-family jobs,
// superseded packs). No direct SQL evictions.
//
// These tests pin three layers, the house way:
//
//   1. The pure state machine (ses_docs_ready.ts): retired is terminal and
//      reachable only from needs_review and signed_off.
//   2. The action (ses_reporting_actions.ts) against a stub client: auth
//      posture, input validation, clean pre-read refusals, and the atomic RPC
//      contract. The already-executed refusal is pinned at the RPC boundary
//      (the stub returns the database's guard message) AND at the SQL layer
//      (the guard text is pinned in the effective function body).
//   3. The migration text itself, read as EFFECTIVE definitions (last
//      CREATE OR REPLACE wins across all migrations in version order, exactly
//      what Postgres ends up holding): the retire function's guard rails, the
//      queue view's retired exclusion, the constraint arms, the zero-row
//      apply, and the rollback twin.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { nextSesDocsReadyState } from "./ses_docs_ready.ts";
import {
  retireSesDocketRevisionAction,
  SES_DOCKET_RETIRE_REASON_CODES,
  SesActionError,
} from "./ses_reporting_actions.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const ACTIONS = await Deno.readTextFile(
  new URL("./ses_reporting_actions.ts", import.meta.url),
);
const MANIFEST = await Deno.readTextFile(
  new URL("../../../scripts/_ops-api-required-actions.txt", import.meta.url),
);

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);
const RETIRE_MIGRATION_NAME = "20260803050000_ses_docket_review_retire.sql";

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
const RETIRE_MIGRATION = MIGRATIONS.find((m) =>
  m.name === RETIRE_MIGRATION_NAME
);
const ROLLBACK = await Deno.readTextFile(
  new URL(
    `../../rollbacks/20260803050000_ses_docket_review_retire_down.sql`,
    import.meta.url,
  ),
);

/** The body Postgres ends up with: the last CREATE OR REPLACE FUNCTION wins. */
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

/** The view Postgres ends up with: the last CREATE OR REPLACE VIEW wins. */
function effectiveView(
  viewName: string,
): { migration: string; body: string } {
  let found: { migration: string; body: string } | null = null;
  for (const migration of MIGRATIONS) {
    const marker = `CREATE OR REPLACE VIEW public.${viewName}`;
    let from = migration.sql.indexOf(marker);
    while (from !== -1) {
      const end = migration.sql.indexOf(";", from);
      assert(end !== -1, `unterminated view ${viewName} in ${migration.name}`);
      found = {
        migration: migration.name,
        body: migration.sql.slice(from, end + 1),
      };
      from = migration.sql.indexOf(marker, end);
    }
  }
  assert(found, `no definition found for ${viewName}`);
  return found;
}

/** Executable statements only: `--` comment lines stripped. */
function executable(sql: string): string {
  return sql.split("\n").filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const RETIRE = effectiveFunction("retire_ses_docket_revision_v1");
const QUEUE_VIEW = effectiveView("ses_docket_review_current");

// ── 1. The pure state machine: retired is terminal. ──

Deno.test("retire is reachable from needs_review and signed_off, and is terminal", async () => {
  assertEquals(nextSesDocsReadyState("needs_review", "retired"), "retired");
  assertEquals(nextSesDocsReadyState("signed_off", "retired"), "retired");
  for (
    const event of [
      "prepared",
      "content_changed",
      "signed_off",
      "revoked",
      "retired",
    ] as const
  ) {
    await assertRejects(
      () =>
        Promise.resolve().then(() => {
          nextSesDocsReadyState("retired", event);
        }),
      TypeError,
      "invalid Docs Ready transition",
    );
  }
  await assertRejects(
    () =>
      Promise.resolve().then(() => {
        nextSesDocsReadyState(null, "retired");
      }),
    TypeError,
    "invalid Docs Ready transition",
  );
});

// ── 2. The action against a stub client. ──

const USER_ID = "00000000-0000-0000-0000-0000000000c1";
const DOCKET_ID = "00000000-0000-0000-0000-0000000000d1";
const JOB_ID = "00000000-0000-0000-0000-0000000000b1";

const ADMIN_JWT = {
  mode: "jwt",
  user: { id: USER_ID, email: "captain@example.com", role: "admin" },
} as any;
const API_KEY = { mode: "api_key", user: null } as any;
const ROUTINE = { mode: "routine", user: null } as any;
const TRADE_JWT = {
  mode: "jwt",
  user: { id: USER_ID, email: "shaun@example.com", role: "trade" },
} as any;

function fluent(response: { data: any; error: any }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => response,
    single: async () => response,
  };
  return builder;
}

function clientFor(options: {
  operatorClass?: string | null;
  docket?: Record<string, unknown> | null;
  current?: boolean;
  latestEvent?: Record<string, unknown> | null;
  rpcResult?: { data: any; error: any };
  onRpc?: (name: string, args: Record<string, unknown>) => void;
}) {
  const docket = options.docket === undefined
    ? { id: DOCKET_ID, job_id: JOB_ID, stage: "pre_xero" }
    : options.docket;
  return {
    from(table: string) {
      if (table === "ses_release_operators") {
        return fluent({
          data: options.operatorClass
            ? { operator_class: options.operatorClass }
            : null,
          error: null,
        });
      }
      if (table === "makesafe_docket_revisions") {
        return fluent({ data: docket, error: null });
      }
      if (table === "makesafe_docket_revisions_current") {
        return fluent({
          data: options.current === false ? null : docket,
          error: null,
        });
      }
      if (table === "ses_docket_review_events") {
        return fluent({
          data: options.latestEvent === undefined
            ? {
              id: "event-0",
              review_state: "needs_review",
              event_kind: "prepared",
            }
            : options.latestEvent,
          error: null,
        });
      }
      return fluent({ data: null, error: null });
    },
    rpc(name: string, args: Record<string, unknown>) {
      options.onRpc?.(name, args);
      return Promise.resolve(
        options.rpcResult ?? {
          data: {
            id: "event-1",
            review_state: "retired",
            event_kind: "retired",
            retire_reason_code: "already_reported",
            retired_from_state: "needs_review",
          },
          error: null,
        },
      );
    },
  } as any;
}

Deno.test("retire from needs_review records the audit event through the atomic RPC", async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await retireSesDocketRevisionAction(
    clientFor({ onRpc: (name, args) => rpcCalls.push({ name, args }) }),
    ADMIN_JWT,
    { docket_revision_id: DOCKET_ID, reason_code: "already_reported" },
  );
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0].name, "retire_ses_docket_revision_v1");
  const event = rpcCalls[0].args.p_event as Record<string, unknown>;
  assertEquals(event.docket_revision_id, DOCKET_ID);
  assertEquals(event.retire_reason_code, "already_reported");
  assertEquals(event.reason, null);
  assertEquals(event.actor_user_id, USER_ID);
  assertEquals(event.actor_identity, "captain@example.com");
  assertEquals(result.review.review_state, "retired");
  assertEquals(result.review.retired_from_state, "needs_review");
});

Deno.test("retire from signed_off works and carries the optional reason text", async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await retireSesDocketRevisionAction(
    clientFor({
      latestEvent: {
        id: "event-9",
        review_state: "signed_off",
        event_kind: "signed_off",
      },
      onRpc: (name, args) => rpcCalls.push({ name, args }),
    }),
    ADMIN_JWT,
    {
      docket_revision_id: DOCKET_ID,
      reason_code: "wrong_family",
      reason_text: "Job 261029 is a repair, not a makesafe.",
    },
  );
  assertEquals(rpcCalls.length, 1);
  const event = rpcCalls[0].args.p_event as Record<string, unknown>;
  assertEquals(event.retire_reason_code, "wrong_family");
  assertEquals(event.reason, "Job 261029 is a repair, not a makesafe.");
  assertEquals(result.review.review_state, "retired");
});

Deno.test("the privileged ops key retires with the key identity, never a fabricated user", async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  await retireSesDocketRevisionAction(
    clientFor({ onRpc: (name, args) => rpcCalls.push({ name, args }) }),
    API_KEY,
    { docket_revision_id: DOCKET_ID, reason_code: "captain_ruling" },
  );
  assertEquals(rpcCalls.length, 1);
  const event = rpcCalls[0].args.p_event as Record<string, unknown>;
  assertEquals(event.actor_user_id, null);
  assertEquals(event.actor_identity, "ops-api-key");
});

Deno.test("retire refuses an already-executed docket with the database guard's fact", async () => {
  const error = await assertRejects(
    () =>
      retireSesDocketRevisionAction(
        clientFor({
          rpcResult: {
            data: null,
            error: {
              message:
                "an invoice execution is already recorded against this exact docket; already-executed dockets can never be retired",
            },
          },
        }),
        API_KEY,
        { docket_revision_id: DOCKET_ID, reason_code: "already_reported" },
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 409);
  assertEquals(error.refusal.state, "refused");
  assertStringIncludes(
    error.refusal.fact,
    "already-executed dockets can never be retired",
  );
});

Deno.test("retire refuses the automation routine key before any read", async () => {
  let rpcCalled = false;
  const error = await assertRejects(
    () =>
      retireSesDocketRevisionAction(
        clientFor({ onRpc: () => rpcCalled = true }),
        ROUTINE,
        { docket_revision_id: DOCKET_ID, reason_code: "already_reported" },
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 403);
  assertEquals(error.refusal.state, "refused");
  assertStringIncludes(error.refusal.fact, "automation routine");
  assertEquals(rpcCalled, false);
});

Deno.test("retire refuses a JWT operator without Captain or admin-owner authority", async () => {
  let rpcCalled = false;
  const error = await assertRejects(
    () =>
      retireSesDocketRevisionAction(
        clientFor({
          operatorClass: "shaun_clean",
          onRpc: () => rpcCalled = true,
        }),
        TRADE_JWT,
        { docket_revision_id: DOCKET_ID, reason_code: "already_reported" },
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 403);
  assertEquals(rpcCalled, false);
});

Deno.test("a captain-class JWT operator passes the retire gate", async () => {
  const rpcCalls: string[] = [];
  await retireSesDocketRevisionAction(
    clientFor({
      operatorClass: "captain",
      onRpc: (name) => rpcCalls.push(name),
    }),
    TRADE_JWT,
    { docket_revision_id: DOCKET_ID, reason_code: "superseded" },
  );
  assertEquals(rpcCalls, ["retire_ses_docket_revision_v1"]);
});

Deno.test("retire refuses a missing or invalid reason_code before any write", async () => {
  for (
    const args of [
      { docket_revision_id: DOCKET_ID },
      { docket_revision_id: DOCKET_ID, reason_code: "" },
      { docket_revision_id: DOCKET_ID, reason_code: "not_a_reason" },
      { reason_code: "already_reported" },
    ]
  ) {
    let rpcCalled = false;
    const error = await assertRejects(
      () =>
        retireSesDocketRevisionAction(
          clientFor({ onRpc: () => rpcCalled = true }),
          API_KEY,
          args as any,
        ),
      SesActionError,
    ) as SesActionError;
    assertEquals(error.status, 400);
    assertEquals(error.refusal.state, "refused");
    assertStringIncludes(error.refusal.fact, "reason_code");
    assertEquals(rpcCalled, false);
  }
});

Deno.test("retire refuses a docket that is not the current exact revision", async () => {
  let rpcCalled = false;
  const error = await assertRejects(
    () =>
      retireSesDocketRevisionAction(
        clientFor({ current: false, onRpc: () => rpcCalled = true }),
        API_KEY,
        { docket_revision_id: DOCKET_ID, reason_code: "superseded" },
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 409);
  assertStringIncludes(
    error.refusal.fact,
    "no longer the current exact revision",
  );
  assertEquals(rpcCalled, false);
});

Deno.test("retire refuses a docket that was never queued for review", async () => {
  let rpcCalled = false;
  const error = await assertRejects(
    () =>
      retireSesDocketRevisionAction(
        clientFor({ latestEvent: null, onRpc: () => rpcCalled = true }),
        API_KEY,
        { docket_revision_id: DOCKET_ID, reason_code: "already_reported" },
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 409);
  assertStringIncludes(
    error.refusal.fact,
    "not waiting in the Docs Ready review queue",
  );
  assertEquals(rpcCalled, false);
});

Deno.test("double retire is a clean refusal and records no duplicate event", async () => {
  let rpcCalled = false;
  const error = await assertRejects(
    () =>
      retireSesDocketRevisionAction(
        clientFor({
          latestEvent: {
            id: "event-7",
            review_state: "retired",
            event_kind: "retired",
          },
          onRpc: () => rpcCalled = true,
        }),
        API_KEY,
        { docket_revision_id: DOCKET_ID, reason_code: "already_reported" },
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 409);
  assertEquals(error.refusal.state, "refused");
  assertStringIncludes(error.refusal.fact, "already retired");
  assertStringIncludes(error.refusal.fact, "no second retire event");
  assertEquals(rpcCalled, false);
});

Deno.test("the retire reason enum is exactly the four R4 codes", () => {
  assertEquals([...SES_DOCKET_RETIRE_REASON_CODES], [
    "already_reported",
    "wrong_family",
    "superseded",
    "captain_ruling",
  ]);
});

// ── 3. The migration text, read as effective definitions. ──

Deno.test("the retire migration owns the effective retire function and queue view", () => {
  assert(RETIRE_MIGRATION, "the retire migration is missing");
  assertEquals(RETIRE.migration, RETIRE_MIGRATION_NAME);
  assertEquals(QUEUE_VIEW.migration, RETIRE_MIGRATION_NAME);
});

Deno.test("the queue view excludes retired dockets with an unchanged column list", () => {
  assertStringIncludes(
    QUEUE_VIEW.body,
    "WHERE event.review_state <> 'retired'",
  );
  // The column list is byte-identical to 20260728210000's: CREATE OR REPLACE
  // VIEW forbids renaming/dropping columns, and every consumer (queue list,
  // reviewable pack, signoff pre-reads, the send wall) reads these names.
  for (
    const column of [
      "docket_revision_id",
      "docket_output_content_hash",
      "review_event_id",
      "review_event_sequence",
      "review_state",
      "event_kind",
      "review_state_changed_at",
      "invalidated_signoff_event_id",
    ]
  ) {
    assertStringIncludes(QUEUE_VIEW.body, column);
  }
});

Deno.test("the retire function serialises on the Docs Ready lock and reuses the freshness check", () => {
  assertStringIncludes(RETIRE.body, "ses-docs-ready:");
  assertStringIncludes(
    RETIRE.body,
    "FROM public.makesafe_docket_revisions_current current_docket",
  );
  assertStringIncludes(
    RETIRE.body,
    "new docket content exists; review the current exact revision",
  );
});

Deno.test("the retire function refuses every already-sent or already-executed docket", () => {
  // The AUTHORISED-invoice-bound stage can never be retired.
  assertStringIncludes(RETIRE.body, "target.stage = 'invoice_bound'");
  // Invoice execution recorded in the exact-once effect ledger, bound to the
  // docket itself or to its obligation revision.
  assertStringIncludes(
    RETIRE.body,
    "effect.effect_kind IN ('invoice_create', 'invoice_authorise')",
  );
  assertStringIncludes(RETIRE.body, "effect.docket_revision_id = target.id");
  assertStringIncludes(
    RETIRE.body,
    "effect.invoice_obligation_revision_id =",
  );
  // Release execution: the release reached dispatching/released, or a route
  // send effect exists for a release containing this docket.
  assertStringIncludes(
    RETIRE.body,
    "FROM public.makesafe_release_revision_members member",
  );
  assertStringIncludes(
    RETIRE.body,
    "release.state IN ('dispatching', 'released')",
  );
  assertStringIncludes(RETIRE.body, "effect.effect_kind = 'route_send'");
  // Failed or compensated effects recorded no real-world outcome and never
  // block eviction.
  assertEquals(
    (RETIRE.body.match(/effect\.state NOT IN \('failed', 'compensated'\)/g) ||
      []).length,
    2,
    "both execution guards must exempt only failed/compensated effects",
  );
  for (
    const refusal of [
      "already-executed dockets can never be retired",
      "already-sent dockets can never be retired",
    ]
  ) {
    assertStringIncludes(RETIRE.body, refusal);
  }
});

Deno.test("the retire function records the prior state and invalidates a ticked signoff", () => {
  assertStringIncludes(RETIRE.body, "current_event.review_state = 'retired'");
  assertStringIncludes(RETIRE.body, "the exact docket is already retired");
  assertStringIncludes(
    RETIRE.body,
    "the exact docket is not waiting in the review queue",
  );
  // The prior queue state is written ON the audit event...
  assertStringIncludes(RETIRE.body, "retired_from_state,");
  assertStringIncludes(RETIRE.body, "current_event.review_state,");
  // ...and retiring a ticked pack voids the signoff through the same column
  // content_changed and revoked use.
  assertStringIncludes(
    RETIRE.body,
    "WHEN current_event.review_state = 'signed_off' THEN current_event.id",
  );
  assertStringIncludes(RETIRE.body, "'retired',");
});

Deno.test("the retire event shape is constrained the house way", () => {
  assert(RETIRE_MIGRATION, "the retire migration is missing");
  const sql = RETIRE_MIGRATION.sql;
  assertStringIncludes(
    sql,
    "review_state IN ('needs_review', 'signed_off', 'retired')",
  );
  assertStringIncludes(
    sql,
    "event_kind IN ('prepared', 'content_changed', 'signed_off', 'revoked', 'retired')",
  );
  // The retired arm requires the structured reason code and the prior state,
  // and never carries a signoff timestamp.
  assertStringIncludes(sql, "event_kind = 'retired'");
  assertStringIncludes(sql, "review_state = 'retired'");
  assertStringIncludes(sql, "retire_reason_code IN (");
  assertStringIncludes(sql, "'already_reported',");
  assertStringIncludes(sql, "'wrong_family',");
  assertStringIncludes(sql, "'superseded',");
  assertStringIncludes(sql, "'captain_ruling'");
  assertStringIncludes(
    sql,
    "retired_from_state IN ('needs_review', 'signed_off')",
  );
  // The pre-existing arms survive byte-identical inside the same constraint.
  assertStringIncludes(
    sql,
    "event_kind IN ('prepared', 'content_changed', 'revoked')\n      AND review_state = 'needs_review'\n      AND signed_off_at IS NULL",
  );
  assertStringIncludes(
    sql,
    "event_kind = 'signed_off'\n      AND review_state = 'signed_off'\n      AND actor_user_id IS NOT NULL\n      AND signed_off_at IS NOT NULL",
  );
});

Deno.test("the retire migration destroys nothing, writes zero rows and touches no money path", () => {
  assert(RETIRE_MIGRATION, "the retire migration is missing");
  const executableSql = executable(RETIRE_MIGRATION.sql);
  for (
    const forbidden of [
      "DROP TABLE",
      "DROP FUNCTION",
      "DROP TRIGGER",
      "ses_money_sealed_at",
      "xero_invoices",
    ]
  ) {
    assert(
      !executableSql.includes(forbidden),
      `no executable statement in the retire migration may contain "${forbidden}"`,
    );
  }
  // Apply time writes zero rows: strip the `AS $$ ... $$;` function body and
  // nothing that mutates data may remain at migration top level.
  const topLevel = executableSql.replace(
    /AS \$\$[\s\S]*?\n\$\$;/g,
    "AS <body>;",
  );
  for (
    const forbidden of ["INSERT INTO", "DELETE FROM", "UPDATE ", "TRUNCATE"]
  ) {
    assert(
      !topLevel.includes(forbidden),
      `the retire migration must write zero rows at apply time, found "${forbidden}"`,
    );
  }
  // The append-only guard on the review ledger is untouched.
  assert(
    !executableSql.includes("trg_ses_docket_review_events_append_only"),
    "the append-only trigger on the review ledger must not be touched",
  );
  // The historical record function and every money-path function keep their
  // prior effective bodies: this migration redefines none of them.
  for (
    const fn of [
      "record_ses_docket_review_state_v1",
      "commit_ses_invoice_obligation_revision_v1",
      "begin_ses_invoice_execution_v1",
      "commit_ses_invoice_bound_docket_v1",
      "commit_ses_release_revision_v1",
      "begin_ses_release_execution_v1",
      "confirm_ses_release_route_v1",
      "commit_ses_release_closeout_v1",
      "record_ses_revision_approval_v1",
    ]
  ) {
    assert(
      !executableSql.includes(`CREATE OR REPLACE FUNCTION public.${fn}`),
      `the retire migration must not redefine ${fn}`,
    );
  }
  // The retire function is service-role only, like its siblings.
  assertStringIncludes(
    executableSql,
    "REVOKE ALL ON FUNCTION public.retire_ses_docket_revision_v1(jsonb)",
  );
  assertStringIncludes(
    executableSql,
    "GRANT EXECUTE ON FUNCTION public.retire_ses_docket_revision_v1(jsonb)\n  TO service_role",
  );
});

Deno.test("the rollback twin restores the pre-retire shape and warns about retired history", () => {
  const rollbackExecutable = executable(ROLLBACK);
  assertStringIncludes(
    rollbackExecutable,
    "DROP FUNCTION IF EXISTS public.retire_ses_docket_revision_v1(jsonb)",
  );
  // The restored view is the pre-retire definition: no retired predicate in
  // any executable statement.
  assertStringIncludes(
    rollbackExecutable,
    "CREATE OR REPLACE VIEW public.ses_docket_review_current",
  );
  assert(
    !rollbackExecutable.includes("review_state <> 'retired'"),
    "the restored queue view must not carry the retired exclusion",
  );
  // The original enums and shape constraint are restored...
  assertStringIncludes(
    rollbackExecutable,
    "review_state IN ('needs_review', 'signed_off')",
  );
  assertStringIncludes(
    rollbackExecutable,
    "event_kind IN ('prepared', 'content_changed', 'signed_off', 'revoked')",
  );
  // ...and the retire columns are dropped.
  assertStringIncludes(
    rollbackExecutable,
    "DROP COLUMN IF EXISTS retire_reason_code",
  );
  assertStringIncludes(rollbackExecutable, "retired_from_state");
  // The header warns that retired audit history makes the rollback
  // inapplicable: the restored constraints reject retired rows and the
  // append-only trigger forbids deleting them.
  assertStringIncludes(ROLLBACK, "ZERO retired review events");
  assertStringIncludes(ROLLBACK, "one-way door");
});

Deno.test("ops-api exposes the retire action and the smoke manifest source-gates it", () => {
  assertStringIncludes(INDEX, "case 'retire_ses_docket_revision'");
  assertStringIncludes(INDEX, "retireSesDocketRevisionAction");
  assertStringIncludes(
    MANIFEST,
    "retire_ses_docket_revision # probe=source-only",
  );
  // The action module keeps the house refusal and auth shapes.
  assertStringIncludes(ACTIONS, "SES_DOCKET_RETIRE_REASON_CODES");
  assertStringIncludes(ACTIONS, 'client.rpc("retire_ses_docket_revision_v1"');
  assertStringIncludes(
    ACTIONS,
    "Retiring a Docs Ready docket is restricted to the Captain, an admin-owner, or the privileged ops key",
  );
});

Deno.test("CONTROL: the historical docs-ready migration keeps its original four-kind ledger", () => {
  // The original migration file is immutable history; the retire migration
  // widens the ledger under it. Passes on BOTH shapes.
  const docsReady = MIGRATIONS.find((m) =>
    m.name === "20260728210000_makesafe_ses_docs_ready_signoff.sql"
  );
  assert(docsReady, "the docs-ready migration is missing");
  assertStringIncludes(
    docsReady.sql,
    "event_kind IN ('prepared', 'content_changed', 'signed_off', 'revoked')",
  );
  assertStringIncludes(
    docsReady.sql,
    "review_state IN ('needs_review', 'signed_off')",
  );
  assert(
    !docsReady.sql.includes("retired"),
    "the historical migration must not be rewritten",
  );
});
