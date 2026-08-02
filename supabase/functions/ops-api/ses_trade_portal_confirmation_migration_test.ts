// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SES_PORTAL_CAPTURE_PRODUCER,
  SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
  SES_TRADE_PORTAL_CONFIRMATION_ROLE,
} from "./ses_portal_capture_contract.ts";

const MIGRATION_PATH =
  "../../migrations/20260802030000_makesafe_trade_portal_confirmation.sql";
const ROLLBACK_PATH =
  "../../rollbacks/20260802030000_makesafe_trade_portal_confirmation_down.sql";

const migration = await Deno.readTextFile(
  new URL(MIGRATION_PATH, import.meta.url),
);
const rollback = await Deno.readTextFile(
  new URL(ROLLBACK_PATH, import.meta.url),
);
const schemaManifest = await Deno.readTextFile(
  new URL(
    "../../../scripts/edge-function-schema-requirements.txt",
    import.meta.url,
  ),
);

Deno.test("the widened capture shape admits both producers and only one screenshot rule", () => {
  assertStringIncludes(migration, SES_PORTAL_CAPTURE_PRODUCER);
  assertStringIncludes(migration, SES_TRADE_PORTAL_CONFIRMATION_PRODUCER);
  // The attestation branch is confined to the one role and the one result an
  // attestation can honestly make, and carries no screenshot.
  assertStringIncludes(
    migration,
    `capture_producer = '${SES_TRADE_PORTAL_CONFIRMATION_PRODUCER}'\n        AND role = '${SES_TRADE_PORTAL_CONFIRMATION_ROLE}'\n        AND capture_result = 'done'\n        AND screenshot_object_key IS NULL`,
  );
  // The reader keeps its screenshot obligation.
  assertStringIncludes(
    migration,
    "screenshot_object_key LIKE\n              'makesafe-docket-artifacts/portal-captures/%'",
  );
  assertStringIncludes(migration, "uq_makesafe_trade_portal_confirmation");
});

Deno.test("the migration writes no row and touches no card or board state", () => {
  assert(
    !migration.match(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE)\b/i),
    "a widening migration must not write a row",
  );
  assert(
    !migration.match(/\bpublic\.(jobs|makesafe_job_details)\b/i),
    "this migration must not reach card or board state",
  );
});

Deno.test("the rollback narrows back to one producer and refuses to strand evidence", () => {
  assertStringIncludes(
    rollback,
    `capture_producer = '${SES_PORTAL_CAPTURE_PRODUCER}'`,
  );
  assert(
    !rollback.includes(
      `capture_producer IN (\n      '${SES_PORTAL_CAPTURE_PRODUCER}'`,
    ),
    "the rollback must not keep the widened producer list",
  );
  assert(
    !rollback.match(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE)\b/i),
    "the rollback must never remove recorded evidence to make itself apply",
  );
  assertStringIncludes(rollback, "DROP INDEX IF EXISTS");
});

Deno.test("ops-api deploy gate declares the trade confirmation schema", () => {
  for (
    const marker of [
      "20260802030000_makesafe_trade_portal_confirmation.sql|index|uq_makesafe_trade_portal_confirmation",
      "20260802030000_makesafe_trade_portal_confirmation.sql|constraint|makesafe_portal_capture_bridge_shape",
    ]
  ) {
    assertStringIncludes(schemaManifest, marker);
  }
});
