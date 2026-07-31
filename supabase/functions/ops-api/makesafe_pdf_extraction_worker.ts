// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  extractPdfText,
  PDF_TEXT_MAX_BYTES,
} from "./makesafe_pdf_text.ts";

const STORAGE_BUCKET = "makesafe-emails";
const RETRY_DELAY_MS = 2 * 60 * 1000;
const DRAIN_RATE_PER_MINUTE = 1;
const MAX_EXTRACTION_ATTEMPTS = 3;

export interface PdfExtractionWorkerRow {
  id: string;
  email_id: string;
  storage_path: string | null;
  size_bytes: number | null;
  pdf_extraction_status: string;
  pdf_extraction_attempts: number;
  pdf_extraction_claim_token: string;
  pdf_handoff_status: string;
  pdf_handoff_attempts: number;
}

export interface PdfExtractionWorkerResult {
  outcome: "extracted" | "quarantined" | "failed" | "no_work";
  attachment_id: string | null;
  source_post_id: string | null;
  reason: string | null;
  char_count: number;
  extractor: string | null;
  remaining_backlog: number | null;
  drain_eta_at: string | null;
  scan_error?: string | null;
}

interface WorkerDeps {
  now?: () => Date;
  extract?: typeof extractPdfText;
  onSettled?: (sourcePostId: string) => Promise<void>;
}

interface ClaimedCarrier {
  id: string;
  email_id: string;
  pdf_extraction_status?: string;
  pdf_extraction_reason?: string | null;
}

interface BacklogEstimate {
  remaining: number | null;
  minutes: number | null;
}

function isoAfter(now: Date, milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString();
}

async function claimOne(
  client: any,
  attachmentId: string | null,
  freshOnly: boolean,
): Promise<PdfExtractionWorkerRow | null> {
  const { data, error } = await client.rpc("claim_makesafe_pdf_extraction", {
    p_attachment_id: attachmentId,
    p_fresh_only: freshOnly,
  });
  if (error) {
    throw new Error(`pdf extraction claim failed: ${error.message || error}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row?.id ? row as PdfExtractionWorkerRow : null;
}

async function updateExtraction(
  client: any,
  row: PdfExtractionWorkerRow,
  patch: Record<string, unknown>,
): Promise<ClaimedCarrier[]> {
  const { data, error } = await client.rpc(
    "complete_makesafe_pdf_extraction",
    {
      p_attachment_id: row.id,
      p_claim_token: row.pdf_extraction_claim_token,
      p_outcome: patch.pdf_extraction_status,
      p_reason: patch.pdf_extraction_reason,
      p_text: patch.pdf_extraction_text ?? null,
      p_char_count: patch.pdf_extraction_char_count ?? 0,
      p_page_count: patch.pdf_extraction_page_count ?? null,
      p_extractor: patch.pdf_extraction_extractor ?? null,
      p_truncated: patch.pdf_extraction_truncated ?? false,
      p_completed_at: patch.updated_at,
      p_next_attempt_at: patch.pdf_extraction_next_attempt_at ?? null,
    },
  );
  if (error) {
    throw new Error(
      `pdf extraction result write failed for ${row.id}: ${error.message || error}`,
    );
  }
  const carriers = (data || []) as ClaimedCarrier[];
  if (!carriers.some((carrier) => carrier.id === row.id)) {
    throw new Error(`pdf extraction claim fence lost for ${row.id}`);
  }
  return carriers;
}

async function updateHandoff(
  client: any,
  row: Pick<PdfExtractionWorkerRow, "id" | "pdf_extraction_claim_token">,
  expectedStatus: "pending" | "processing",
  patch: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await client.from("email_attachments")
    .update(patch)
    .eq("id", row.id)
    .eq("pdf_extraction_claim_token", row.pdf_extraction_claim_token)
    .eq("pdf_handoff_status", expectedStatus)
    .select("id");
  if (error) {
    throw new Error(
      `pdf handoff state write failed for ${row.id}: ${error.message || error}`,
    );
  }
  if ((data || []).length !== 1) {
    throw new Error(`pdf handoff claim fence lost for ${row.id}`);
  }
}

async function backlogEstimate(client: any): Promise<BacklogEstimate> {
  const { data, error } = await client.rpc(
    "makesafe_pdf_extraction_backlog_estimate",
  );
  if (error) {
    throw new Error(
      `pdf extraction backlog read failed: ${error.message || error}`,
    );
  }
  const estimate = Array.isArray(data) ? data[0] : data;
  return {
    remaining: Number.isFinite(Number(estimate?.remaining_coordinates))
      ? Number(estimate.remaining_coordinates)
      : null,
    minutes: Number.isFinite(Number(estimate?.estimated_minutes))
      ? Number(estimate.estimated_minutes)
      : null,
  };
}

function resultWithEta(
  result: Omit<PdfExtractionWorkerResult, "remaining_backlog" | "drain_eta_at">,
  estimate: BacklogEstimate,
  now: Date,
): PdfExtractionWorkerResult {
  return {
    ...result,
    remaining_backlog: estimate.remaining,
    drain_eta_at: estimate.minutes === null
      ? null
      : isoAfter(
        now,
        Math.ceil(estimate.minutes / DRAIN_RATE_PER_MINUTE) * 60_000,
      ),
  };
}

async function settleHandoff(
  client: any,
  carrier: ClaimedCarrier,
  claimToken: string,
  onSettled: (sourcePostId: string) => Promise<void>,
  now: () => Date,
  alreadyClaimed: boolean,
): Promise<string | null> {
  const claimed = { id: carrier.id, pdf_extraction_claim_token: claimToken };
  if (!alreadyClaimed) {
    const startedAt = now();
    await updateHandoff(client, claimed, "pending", {
      pdf_handoff_status: "processing",
      pdf_handoff_started_at: startedAt.toISOString(),
      pdf_handoff_completed_at: null,
      pdf_handoff_attempts: 1,
      updated_at: startedAt.toISOString(),
    });
  }
  try {
    await onSettled(carrier.email_id);
    const completedAt = now();
    await updateHandoff(client, claimed, "processing", {
      pdf_handoff_status: "completed",
      pdf_handoff_reason: null,
      pdf_handoff_started_at: null,
      pdf_handoff_completed_at: completedAt.toISOString(),
      pdf_handoff_next_attempt_at: null,
      updated_at: completedAt.toISOString(),
    });
    return null;
  } catch (error) {
    const failedAt = now();
    const reason = `classifier_handoff_failed:${
      (error as Error).message || error
    }`.slice(0, 500);
    await updateHandoff(client, claimed, "processing", {
      pdf_handoff_status: "failed",
      pdf_handoff_reason: reason,
      pdf_handoff_started_at: null,
      pdf_handoff_completed_at: failedAt.toISOString(),
      pdf_handoff_next_attempt_at: isoAfter(failedAt, RETRY_DELAY_MS),
      updated_at: failedAt.toISOString(),
    });
    return reason;
  }
}

/**
 * Claim and read exactly one PDF. The same function serves the immediate arrival
 * path (attachment_id supplied) and the historical oldest-first cron drain (no id).
 * It never invokes a model and never reads an email body in place of the PDF.
 */
export async function drainMakesafePdfExtraction(
  client: any,
  input: { attachmentId?: string | null; freshOnly?: boolean } = {},
  deps: WorkerDeps = {},
): Promise<PdfExtractionWorkerResult> {
  const now = deps.now || (() => new Date());
  const clock = now();
  const row = await claimOne(
    client,
    input.attachmentId || null,
    input.freshOnly === true,
  );
  if (!row) {
    return resultWithEta({
      outcome: "no_work",
      attachment_id: null,
      source_post_id: null,
      reason: null,
      char_count: 0,
      extractor: null,
    }, await backlogEstimate(client), clock);
  }

  if (
    ["extracted", "quarantined"].includes(row.pdf_extraction_status) &&
    row.pdf_handoff_status === "processing"
  ) {
    let scanError: string | null = null;
    if (deps.onSettled) {
      scanError = await settleHandoff(
        client,
        { id: row.id, email_id: row.email_id },
        row.pdf_extraction_claim_token,
        deps.onSettled,
        now,
        true,
      );
    }
    return resultWithEta({
      outcome: row.pdf_extraction_status as "extracted" | "quarantined",
      attachment_id: row.id,
      source_post_id: row.email_id,
      reason: null,
      char_count: 0,
      extractor: null,
      ...(scanError ? { scan_error: scanError } : {}),
    }, await backlogEstimate(client), now());
  }

  const finish = async (
    outcome: "extracted" | "quarantined" | "failed",
    reason: string | null,
    values: Record<string, unknown> = {},
  ): Promise<PdfExtractionWorkerResult> => {
    const completedAt = now();
    const carriers = await updateExtraction(client, row, {
      pdf_extraction_status: outcome,
      pdf_extraction_reason: reason,
      pdf_extraction_completed_at: completedAt.toISOString(),
      pdf_extraction_started_at: null,
      pdf_extraction_next_attempt_at: outcome === "failed"
        ? isoAfter(completedAt, RETRY_DELAY_MS)
        : null,
      updated_at: completedAt.toISOString(),
      ...values,
    });
    const settledOutcome = (carriers[0]?.pdf_extraction_status || outcome) as
      | "extracted"
      | "quarantined"
      | "failed";
    const settledReason = carriers[0]?.pdf_extraction_reason ?? reason;
    const scanErrors: string[] = [];
    if (deps.onSettled && settledOutcome !== "failed") {
      const seenSources = new Set<string>();
      for (const carrier of carriers) {
        if (seenSources.has(carrier.email_id)) continue;
        seenSources.add(carrier.email_id);
        const scanError = await settleHandoff(
          client,
          carrier,
          row.pdf_extraction_claim_token,
          deps.onSettled,
          now,
          false,
        );
        if (scanError) scanErrors.push(scanError);
      }
    }
    return resultWithEta({
      outcome: settledOutcome,
      attachment_id: row.id,
      source_post_id: row.email_id,
      reason: settledReason,
      char_count: Number(values.pdf_extraction_char_count || 0),
      extractor: String(values.pdf_extraction_extractor || "") || null,
      ...(scanErrors.length ? { scan_error: scanErrors.join(";").slice(0, 500) } : {}),
    }, await backlogEstimate(client), completedAt);
  };

  if (!row.storage_path) {
    return await finish("failed", "storage_path_missing");
  }
  if (Number(row.size_bytes || 0) > PDF_TEXT_MAX_BYTES) {
    return await finish("quarantined", "pdf_too_large");
  }

  let blob: Blob | null = null;
  try {
    const storage = client?.storage?.from?.(STORAGE_BUCKET);
    const downloaded = storage
      ? await storage.download(row.storage_path)
      : { data: null, error: new Error("storage unavailable") };
    if (downloaded.error || !downloaded.data) {
      return await finish(
        "failed",
        `download_failed:${downloaded.error?.message || "no blob"}`.slice(0, 500),
      );
    }
    blob = downloaded.data;
  } catch (error) {
    return await finish(
      "failed",
      `download_failed:${(error as Error).message || error}`.slice(0, 500),
    );
  }

  try {
    const bytes = new Uint8Array(await blob!.arrayBuffer());
    if (bytes.byteLength > PDF_TEXT_MAX_BYTES) {
      return await finish("quarantined", "pdf_too_large");
    }
    const extracted = await (deps.extract || extractPdfText)(bytes);
    const usable = extracted.mode === "text";
    return await finish(usable ? "extracted" : "quarantined", usable
      ? null
      : extracted.note || "no_usable_text", {
      pdf_extraction_text: usable ? extracted.text : null,
      pdf_extraction_char_count: extracted.charCount,
      pdf_extraction_page_count: extracted.pageCount ?? null,
      pdf_extraction_extractor: extracted.extractor ?? null,
      pdf_extraction_truncated: extracted.truncated === true,
    });
  } catch (error) {
    return await finish(
      "failed",
      `extraction_failed:${(error as Error).message || error}`.slice(0, 500),
    );
  }
}

export const _DRAIN_RATE_PER_MINUTE = DRAIN_RATE_PER_MINUTE;
export const _MAX_EXTRACTION_ATTEMPTS = MAX_EXTRACTION_ATTEMPTS;
