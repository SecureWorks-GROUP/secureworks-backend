// Slice EM2: the rows the PostgreSQL contract feeds capture_business_event
// (supabase/tests/migration-contracts/20261002150000_context_email_reader/contract.sql)
// must be exactly what the email row builder produces today, so the database
// proof and the builder can never drift apart. Regenerate those lines from the
// builder when this fails.
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildOutlookMailRow,
  type OutlookCaptureContext,
  type OutlookMailItem,
  type OutlookSource,
} from "./outlook_mail.ts";
import {
  E_DIRECT,
  E_GROUP_POST,
  E_IDENTITY,
  E_SENT,
  NITHIN,
  PATIOS,
} from "./outlook_mail_fixtures.ts";

const contract = await Deno.readTextFile(
  new URL(
    "../../../tests/migration-contracts/20261002150000_context_email_reader/contract.sql",
    import.meta.url,
  ),
);

function contractRows(): Record<string, unknown> {
  const block = contract.slice(
    contract.indexOf("-- ROWS BEGIN"),
    contract.indexOf("-- ROWS END"),
  );
  const rows: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const m = /^ \('([a-z0-9_]+)','(.*)'::jsonb\)[,;]$/.exec(line);
    if (m) rows[m[1]] = JSON.parse(m[2].replaceAll("''", "'"));
  }
  return rows;
}

const CTX: OutlookCaptureContext = {
  source: "outlook-mail-capture",
  captureMode: "live",
};

function built(item: OutlookMailItem, source: OutlookSource): unknown {
  const b = buildOutlookMailRow(item, source, CTX);
  if (b.kind !== "row") throw new Error(`skip ${b.reason}`);
  return b.row;
}

Deno.test("the SQL contract's input rows are the builder's current output", () => {
  assertEquals(contractRows(), {
    e_direct: built(E_DIRECT, NITHIN),
    e_direct_admin_copy: built(
      { ...E_DIRECT, graphId: "AAMkAGEm2DirectAdminCopy01=" },
      {
        ...NITHIN,
        email: "admin@secureworkswa.com.au",
        sourceKey: "admin",
        scopeLabel: "admin",
      },
    ),
    e_identity: built(E_IDENTITY, NITHIN),
    e_sent: built(E_SENT, NITHIN),
    e_group_post: built(E_GROUP_POST, PATIOS),
  });
});
