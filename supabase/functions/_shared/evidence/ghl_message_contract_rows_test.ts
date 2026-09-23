// Slice C1a: the rows the PostgreSQL contract feeds capture_business_event
// (supabase/tests/migration-contracts/20260924100000_context_capture_business_event/contract.sql)
// must be exactly what the TypeScript builder produces today, so the database
// proof and the builder can never drift apart. Regenerate those lines from the
// builder when this fails.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildGhlMessageRow, type GhlCaptureContext, type GhlMessageItem } from "./ghl_message.ts";
import { buildSendSmsEvidenceRow } from "../../ghl-proxy/sms_capture.ts";
import { R13_LIST_ITEM, R2_LIST_ITEM, R32_MMS, R5, R5_WEBHOOK, R7_LIST_ITEMS } from "./ghl_message_fixtures.ts";

const contract = await Deno.readTextFile(new URL(
  "../../../tests/migration-contracts/20260924100000_context_capture_business_event/contract.sql",
  import.meta.url,
));

function contractRows(): Record<string, unknown> {
  const block = contract.slice(contract.indexOf("-- ROWS BEGIN"), contract.indexOf("-- ROWS END"));
  const rows: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const m = /^ \('([a-z0-9_]+)','(.*)'::jsonb\)[,;]$/.exec(line);
    if (m) rows[m[1]] = JSON.parse(m[2].replaceAll("''", "'"));
  }
  return rows;
}

function built(item: GhlMessageItem, ctx: GhlCaptureContext): unknown {
  const b = buildGhlMessageRow(item, ctx);
  if (b.kind !== "row") throw new Error(`skip ${b.reason}`);
  return b.row;
}

Deno.test("the SQL contract's input rows are the builder's current output", () => {
  const receiver: GhlCaptureContext = { source: "ghl-webhook-receiver", captureMode: "live" };
  const tool = buildSendSmsEvidenceRow({
    contactId: R5.contactId, message: R5.body, fromNumber: R5.fromNumber, jobId: R5.jobId,
    job: { ghl_contact_id: R5.contactId }, result: R5.sendResult, bodyHash: "sha256-r5",
  });
  if (tool.kind !== "row") throw new Error("r5 tool skipped");
  assertEquals(contractRows(), {
    r5_tool: tool.row,
    r5_webhook: built(R5_WEBHOOK, receiver),
    r2: built(R2_LIST_ITEM, receiver),
    r13: built(R13_LIST_ITEM, receiver),
    r7: built(R7_LIST_ITEMS[0], receiver),
    r32_mms: built(R32_MMS, receiver),
  });
});
