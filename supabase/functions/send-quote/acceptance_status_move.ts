// deno-lint-ignore-file no-explicit-any
// The board move a customer's acceptance makes: the job goes from quoted to accepted (sold) or partially accepted,
// and the move is recorded as job.status_changed, the same canonical event the send (draft to quoted) and the
// decline (quoted to lost) record. The job row is written as before (status, and the accepted date when fully
// accepted). The move is recorded once, only by the call whose own compare-and-set moved the status from what it
// read; a call that finds the status already changed, or could not read it, writes the job as before and records
// nothing. A failed event write never fails the acceptance.

// The per-run acceptance can leave the job quoted while a neighbour has still to accept (quote_party_view.ts).
export type AcceptanceStatus = "accepted" | "partially_accepted" | "quoted";

export function acceptanceStatusChangedEvent(o: {
  jobId: string;
  jobName: string;
  from: string | null | undefined;
  to: AcceptanceStatus;
  documentId: string;
  amount?: number | null;
  handler: string;
  nowIso: string;
}): Record<string, unknown> | null {
  if (!o.jobId || !o.from || o.from === o.to) return null;
  return {
    event_type: "job.status_changed",
    source: "send-quote",
    occurred_at: o.nowIso,
    recorded_at: o.nowIso,
    entity_type: "job",
    entity_id: o.jobId,
    correlation_id: o.jobId,
    job_id: o.jobId,
    payload: {
      entity: { id: o.jobId, name: o.jobName },
      changes: { status: { from: o.from, to: o.to } },
      ...(o.amount ? { financial: { amount: o.amount } } : {}),
      related_entities: [{ type: "job_document", id: o.documentId }],
    },
    metadata: { reason: "quote_accepted", handler: o.handler },
    schema_version: "1.0",
  };
}

export async function moveJobStatusOnAcceptance(
  sb: any,
  o: {
    jobId: string;
    jobName: string;
    priorStatus: string | null | undefined;
    newStatus: AcceptanceStatus;
    /** Stamped with the move to accepted, as before. */
    acceptedAtIso?: string;
    documentId: string;
    amount?: number | null;
    handler: string;
    nowIso: string;
  },
  record: (event: Record<string, unknown>) => Promise<void>,
): Promise<{ moved: boolean; recorded: boolean }> {
  const patch: Record<string, unknown> = {
    status: o.newStatus,
    ...(o.newStatus === "accepted" ? { accepted_at: o.acceptedAtIso ?? o.nowIso } : {}),
  };
  let moved = false;
  if (o.priorStatus) {
    const { data } = await sb.from("jobs").update(patch).eq("id", o.jobId).eq("status", o.priorStatus).select("id");
    moved = Array.isArray(data) && data.length > 0;
  }
  if (!moved) {
    await sb.from("jobs").update(patch).eq("id", o.jobId);
    return { moved: false, recorded: false };
  }
  const event = acceptanceStatusChangedEvent({
    jobId: o.jobId,
    jobName: o.jobName,
    from: o.priorStatus,
    to: o.newStatus,
    documentId: o.documentId,
    amount: o.amount,
    handler: o.handler,
    nowIso: o.nowIso,
  });
  if (!event) return { moved: false, recorded: false };
  try {
    await record(event);
    return { moved: true, recorded: true };
  } catch (e) {
    console.error("[accept] board move not recorded (non-blocking):", (e as Error)?.message);
    return { moved: true, recorded: false };
  }
}
