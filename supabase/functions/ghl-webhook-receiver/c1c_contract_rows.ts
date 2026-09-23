// The rows the C1c PostgreSQL contract feeds capture_business_event
// (supabase/tests/migration-contracts/20260924130000_ghl_webhook_receipts/contract.sql),
// built exactly as the receiver builds them from the recorded named-row
// fixtures. receiver_c1c_test.ts fails when the contract's lines drift from
// this; regenerate them with:
//   deno run --allow-read supabase/functions/ghl-webhook-receiver/c1c_contract_rows.ts
// Test support only: nothing in the deployed receiver imports this file.
import {
  buildGhlMessageRow,
  buildGhlRecordRow,
  type GhlMessageBuild,
  type GhlRecordBody,
  type GhlRecordEventType,
} from "../_shared/evidence/ghl_message.ts";
import {
  R1_WEBHOOK,
  R25_NOTE_CREATE,
  R26_NOTE_CREATE,
  R27_NOTE_UPDATE,
  R28_TASK_CREATE,
  R29_TASK_COMPLETE_FIRST,
  R29_TASK_COMPLETE_SECOND,
  R30_APPOINTMENT_UPDATE,
  R31_APPOINTMENT_CREATE,
  R31_APPOINTMENT_DELETE,
  R3_LIST_ITEM,
  R4_WEBHOOK,
  R9_WEBHOOK,
} from "../_shared/evidence/ghl_message_fixtures.ts";
import { messageItemFromWebhook, RECEIVER_SOURCE } from "./capture.ts";

const ctx = { source: RECEIVER_SOURCE, captureMode: "live" as const };

function row(b: GhlMessageBuild): Record<string, unknown> {
  if (b.kind !== "row") throw new Error(`fixture skipped: ${b.reason}`);
  return b.row;
}
function record(body: { type: string }): Record<string, unknown> {
  return row(
    buildGhlRecordRow(
      body.type as GhlRecordEventType,
      body as GhlRecordBody,
      ctx,
    ),
  );
}
function message(body: Record<string, unknown>): Record<string, unknown> {
  return row(buildGhlMessageRow(messageItemFromWebhook(body), ctx));
}

export function c1cContractRows(): Record<string, Record<string, unknown>> {
  return {
    r1: message(R1_WEBHOOK),
    r3: row(buildGhlMessageRow(R3_LIST_ITEM, ctx)),
    r4: message(R4_WEBHOOK),
    r9: message(R9_WEBHOOK),
    r25: record(R25_NOTE_CREATE),
    r26: record(R26_NOTE_CREATE),
    r27: record(R27_NOTE_UPDATE),
    r28: record(R28_TASK_CREATE),
    r29_first: record(R29_TASK_COMPLETE_FIRST),
    r29_second: record(R29_TASK_COMPLETE_SECOND),
    r30: record(R30_APPOINTMENT_UPDATE),
    r31_create: record(R31_APPOINTMENT_CREATE),
    r31_delete: record(R31_APPOINTMENT_DELETE),
  };
}

/** The contract's ROWS block lines, one per row, SQL-quoted. */
export function c1cContractRowLines(): string {
  const entries = Object.entries(c1cContractRows());
  return entries.map(([label, r], i) =>
    ` ('${label}','${JSON.stringify(r).replaceAll("'", "''")}'::jsonb)${
      i === entries.length - 1 ? ";" : ","
    }`
  ).join("\n");
}

if (import.meta.main) console.log(c1cContractRowLines());
