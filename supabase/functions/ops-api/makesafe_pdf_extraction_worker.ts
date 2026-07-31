// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  extractPdfText,
  PDF_TEXT_MAX_BYTES,
} from "./makesafe_pdf_text.ts";

const STORAGE_BUCKET = "makesafe-emails";
const RETRY_DELAY_MS = 2 * 60 * 1000;
const DRAIN_RATE_PER_MINUTE = 1;

export interface PdfExtractionWorkerRow {
  id: string;
  email_id: string;
  storage_path: string | null;
  size_bytes: number | null;
  pdf_extraction_status: string;
  pdf_extraction_attempts: number;
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
): Promise<void> {
  const { error } = await client.from("email_attachments")
    .update(patch)
    .eq("id", row.id)
    .eq("pdf_extraction_status", "processing");
  if (error) {
    throw new Error(
      `pdf extraction result write failed for ${row.id}: ${error.message || error}`,
    );
  }
}

async function backlogCount(client: any): Promise<number | null> {
  const { count, error } = await client.from("email_attachments")
    .select("id", { count: "exact", head: true })
    .eq("status", "uploaded")
    .in("pdf_extraction_status", ["pending", "failed"]);
  if (error) {
    throw new Error(`pdf extraction backlog read failed: ${error.message || error}`);
  }
  return typeof count === "number" ? count : null;
}

function resultWithEta(
  result: Omit<PdfExtractionWorkerResult, "remaining_backlog" | "drain_eta_at">,
  remaining: number | null,
  now: Date,
): PdfExtractionWorkerResult {
  return {
    ...result,
    remaining_backlog: remaining,
    drain_eta_at: remaining === null
      ? null
      : isoAfter(now, Math.ceil(remaining / DRAIN_RATE_PER_MINUTE) * 60_000),
  };
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
    }, await backlogCount(client), clock);
  }

  const finish = async (
    outcome: "extracted" | "quarantined" | "failed",
    reason: string | null,
    values: Record<string, unknown> = {},
  ): Promise<PdfExtractionWorkerResult> => {
    const completedAt = now();
    await updateExtraction(client, row, {
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
    let scanError: string | null = null;
    if (deps.onSettled && outcome !== "failed") {
      try {
        await deps.onSettled(row.email_id);
      } catch (error) {
        // Extraction is durably complete even if the exact classifier handoff is
        // temporarily unavailable. The normal standing scan and the returned
        // reason make this visible and retryable; no success is silently assumed.
        scanError = `classifier_handoff_failed:${(error as Error).message || error}`.slice(
          0,
          500,
        );
      }
    }
    return resultWithEta({
      outcome,
      attachment_id: row.id,
      source_post_id: row.email_id,
      reason,
      char_count: Number(values.pdf_extraction_char_count || 0),
      extractor: String(values.pdf_extraction_extractor || "") || null,
      ...(scanError ? { scan_error: scanError } : {}),
    }, await backlogCount(client), completedAt);
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
