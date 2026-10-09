// Group mailbox audience (9 Oct 2026): the copies of our own email that the
// PostgreSQL contract hands context_email_audience_resolve
// (supabase/tests/migration-contracts/20261009131000_context_group_mailbox_audience/contract.sql)
// must be exactly what the email row builder produces today, so the database
// proof and the reader can never drift apart. Regenerate those lines from the
// builder when this fails.
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildOutlookMailRow,
  type OutlookCaptureContext,
  type OutlookMailItem,
  type OutlookSource,
  withGroupThread,
} from "./outlook_mail.ts";
import {
  ADMIN,
  E_FORWARD_SENT,
  E_OUR_REPLY_SENT,
  FINANCE,
  P_BUILDER,
  P_OUR_ALONE,
  P_OUR_REPLY,
  SES,
} from "./outlook_mail_fixtures.ts";

const contract = await Deno.readTextFile(
  new URL(
    "../../../tests/migration-contracts/20261009131000_context_group_mailbox_audience/contract.sql",
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

Deno.test("the SQL contract's copies of our own email are the builder's current output", () => {
  const thread = withGroupThread([P_BUILDER, P_OUR_REPLY]);
  assertEquals(contractRows(), {
    r_reply_group: built(thread[1], SES),
    r_alone_group: built(withGroupThread([P_OUR_ALONE])[0], FINANCE),
    r_reply_sent: built(E_OUR_REPLY_SENT, ADMIN),
    r_forward_sent: built(E_FORWARD_SENT, ADMIN),
  });
});
