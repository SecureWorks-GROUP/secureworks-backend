// deno-lint-ignore-file no-explicit-any
import { MAIL_BUCKET, type StoredFile } from "./mail_capture.ts";
import { automationLaneEnabled } from "../_shared/automation_switch.ts";
export interface Classification {
  classification: string;
  priority: string;
  action_needed: string | null;
  job_ref: string | null;
}
type Classify = (
  from: string,
  subject: string,
  preview: string,
) => Promise<Classification>;
const ATTRIBUTED = new Set([
  "direct",
  "thread",
  "single_open",
  "single_line",
  "luna",
]);
/** Stable primary keys make partial and concurrent retries converge, without a new unique index. */
export async function fileId(
  eventId: string,
  file: StoredFile,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${eventId}:${file.hash}:${file.name}`),
    ),
  );
  digest[6] = (digest[6] & 15) | 80;
  digest[8] = (digest[8] & 63) | 128;
  const hex = [...digest.slice(0, 16)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}
export function fileRow(
  event: any,
  file: StoredFile,
  classification: string,
  subject: string,
) {
  if (
    !event.job_id || event.match_status !== "matched" ||
    !ATTRIBUTED.has(event.attribution_status)
  ) return null;
  if (
    !new RegExp(`^${MAIL_BUCKET}://sha256/[a-f0-9]{64}$`).test(file.pointer)
  ) throw new Error("invalid_private_mail_pointer");
  const base = { job_id: event.job_id, storage_url: file.pointer };
  if (
    file.content_type !== "application/json" &&
    (file.content_type.includes("pdf") || file.name.endsWith(".pdf"))
  ) {
    const invoice = classification === "invoice";
    const workOrder = /work.?order|delivery|install|schedule|dispatch/i.test(
      `${subject} ${file.name}`,
    ) || classification === "supplier_response";
    return {
      table: "job_documents",
      row: {
        ...base,
        pdf_url: file.pointer,
        file_name: file.name,
        version: 1,
        type: invoice
          ? "supplier_invoice"
          : workOrder
          ? "supplier_work_order"
          : "supplier_quote",
        visible_to_trades: !invoice,
      },
    };
  }
  if (file.content_type.startsWith("image/")) {
    return {
      table: "job_media",
      row: { ...base, phase: "receipt", type: "photo", label: file.name },
    };
  }
  return null;
}
/** A separate, bounded compatibility consumer. Its failures never rewind canonical Graph capture. */
export async function runMailCompatibility(
  sb: any,
  classify: Classify,
  limit = 10,
) {
  const result = {
    attempted: 0,
    complete: 0,
    awaiting_attribution: 0,
    failed: 0,
    paused: false,
  };
  if (!await automationLaneEnabled(sb, "capture")) {
    return { ...result, paused: true };
  }
  const { data: rows, error } = await sb.from("inbox_events").select("*")
    .eq("metadata->>capture_version", "mail_v2")
    .or(
      "metadata->compatibility->>status.is.null,metadata->compatibility->>status.neq.complete",
    )
    .order("processed_at", { ascending: true }).limit(limit);
  if (error) throw new Error("mail_compatibility_queue_unavailable");
  for (const inbox of rows || []) {
    if (!await automationLaneEnabled(sb, "capture")) {
      result.paused = true;
      break;
    }
    let metadata = inbox.metadata || {};
    const prior = metadata.compatibility || {};
    if (
      prior.status === "processing" &&
      Date.parse(prior.lease_until) > Date.now()
    ) continue;
    const stamp = new Date(
      Math.max(Date.now(), Date.parse(inbox.processed_at) + 1),
    ).toISOString();
    metadata = {
      ...metadata,
      compatibility: {
        ...prior,
        status: "processing",
        lease_until: new Date(Date.now() + 600_000).toISOString(),
      },
    };
    // Compare-and-swap the old timestamp so concurrent ticks cannot spend twice.
    const claim = await sb.from("inbox_events").update({
      processed_at: stamp,
      metadata,
    }).eq("id", inbox.id).eq("processed_at", inbox.processed_at).select("id");
    if (claim.error) {
      result.failed++;
      continue;
    }
    if (!claim.data?.length) continue;
    result.attempted++;
    const save = async (patch: any) => {
      const write = await sb.from("inbox_events").update(patch).eq(
        "id",
        inbox.id,
      ).eq("processed_at", stamp).select("id");
      if (write.error || !write.data?.length) {
        throw new Error("mail_compatibility_checkpoint_failed");
      }
    };
    try {
      let classification = prior.classification as Classification | undefined;
      if (!classification) {
        let legacy = null;
        if (
          metadata.legacy_classifier_eligible === true &&
          metadata.legacy_graph_message_id
        ) {
          const priorInbox = await sb.from("inbox_events").select(
            "classification,priority,action_needed,metadata",
          )
            .eq("graph_message_id", metadata.legacy_graph_message_id)
            .maybeSingle();
          if (priorInbox.error) {
            throw new Error("mail_legacy_classification_lookup_failed");
          }
          legacy = priorInbox.data;
        }
        classification = legacy
          ? {
            classification: legacy.classification,
            priority: legacy.priority,
            action_needed: legacy.action_needed,
            job_ref: legacy.metadata?.job_ref || null,
          }
          : metadata.legacy_classifier_eligible === true
          ? await classify(
            inbox.from_email || "",
            inbox.subject || "",
            metadata.legacy_body_preview || "",
          )
          : {
            classification: inbox.classification || "other",
            priority: inbox.priority || "normal",
            action_needed: null,
            job_ref: null,
          };
        metadata.compatibility.classification = classification;
        // Cache the paid result BEFORE filing so file-write retries do not call the model again.
        await save({ ...classificationFields(classification), metadata });
      }
      const found = await sb.from("business_events").select(
        "id,job_id,contact_id,match_status,attribution_status",
      ).eq("id", metadata.business_event_id).single();
      if (found.error || !found.data) {
        throw new Error("mail_compatibility_evidence_unavailable");
      }
      const event = found.data;
      const bound = event.job_id && event.match_status === "matched" &&
        ATTRIBUTED.has(event.attribution_status);
      const attachments: StoredFile[] = metadata.attachments || [];
      for (const file of attachments) {
        const target = fileRow(
          event,
          file,
          classification.classification,
          inbox.subject || "",
        );
        if (!target) continue;
        const id = await fileId(event.id, file);
        const write = await sb.from(target.table).upsert(
          { id, ...target.row },
          { onConflict: "id", ignoreDuplicates: true },
        );
        if (write.error) throw new Error("mail_compatibility_file_failed");
      }
      // Keep unbound mail eligible for a future B2 attribution. Never create a human queue.
      metadata.compatibility.status = bound
        ? "complete"
        : "awaiting_attribution";
      delete metadata.compatibility.lease_until;
      await save({
        ...classificationFields(classification),
        job_id: bound ? event.job_id : null,
        ghl_contact_id: event.contact_id,
        metadata,
      });
      if (bound) result.complete++;
      else result.awaiting_attribution++;
    } catch {
      result.failed++;
      metadata.compatibility.status = "retry";
      delete metadata.compatibility.lease_until;
      try {
        await save({ metadata });
      } catch { /* The expiring claim remains retryable. */ }
    }
  }
  return result;
}
function classificationFields(c: Classification) {
  return {
    classification: c.classification,
    priority: c.priority,
    action_needed: c.action_needed,
  };
}
