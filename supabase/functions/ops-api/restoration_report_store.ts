// deno-lint-ignore-file no-explicit-any no-import-prefix
// Restoration report action (docs/restoration-board-v1.md, "Report"):
// `restoration_render_report`. Fills the job facts from the job, takes the
// report's words from the caller, gathers the job's photos, renders the PDF
// (restoration_report_render.ts) and, only when asked, files it on the job.
//
// `dry_run` is the default and writes nothing. A live call uploads the PDF and
// files it as the job's `makesafe_report` document through the one attach path
// (the same file name replaces the same document). It sends nothing, moves no
// stage and touches no invoice.

import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import {
  filterMediaForCurrentCycle,
  isApplicablePackPhoto,
} from "./makesafe_cycle_evidence.ts";
import {
  renderRestorationReportPdf,
  RESTORATION_REPORT_MAX_PHOTOS,
  type RestorationPhotoStage,
  type RestorationReportInput,
  type RestorationReportPhoto,
  type RestorationReportSection,
  restorationReportWordingProblems,
} from "./restoration_report_render.ts";
import { RestorationWorkflowError } from "./restoration_workflow.ts";
import {
  loadRestorationReportJobFacts,
  type RestorationCaller,
} from "./restoration_workflow_store.ts";

/** All the photos of one report may weigh this much before they are embedded. */
export const RESTORATION_REPORT_PHOTO_BYTES_BUDGET = 24 * 1024 * 1024;

export interface RestorationReportDeps {
  /** Photo bytes for a job_media row, or null when they cannot be read. */
  fetchPhoto: (
    media: { id: string; storage_url: string },
  ) => Promise<{ bytes: Uint8Array; mime: string } | null>;
  persistPdf: (args: {
    jobId: string;
    fileName: string;
    bytes: Uint8Array;
  }) => Promise<{ publicUrl: string; storagePath: string }>;
  /** The one make-safe document attach path (attachMakesafeDocument). */
  attachDocument: (body: Record<string, unknown>) => Promise<{
    document_id?: string | null;
    url?: string | null;
  }>;
  render?: typeof renderRestorationReportPdf;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: string, message: string, status = 400): never {
  throw new RestorationWorkflowError(code, message, status);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter(Boolean);
}

function section(value: unknown): RestorationReportSection | null {
  if (typeof value === "string") {
    return value.trim() ? { paragraphs: [value.trim()] } : null;
  }
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const out: RestorationReportSection = {
    paragraphs: textList(raw.paragraphs),
    bullets: textList(raw.bullets),
    closing: textList(raw.closing),
  };
  return out.paragraphs?.length || out.bullets?.length || out.closing?.length
    ? out
    : null;
}

interface PhotoChoice {
  media_id: string;
  caption?: string;
  area?: string;
  stage?: RestorationPhotoStage;
  cover?: boolean;
}

/** The caller's photo list: `photos` (with captions and so on) or bare ids. */
export function restorationReportPhotoChoices(body: any): PhotoChoice[] | null {
  const stageOf = (value: unknown): RestorationPhotoStage | undefined => {
    const stage = text(value).toLowerCase();
    return stage === "before" || stage === "during" || stage === "after"
      ? stage
      : undefined;
  };
  if (Array.isArray(body?.photos) && body.photos.length) {
    return body.photos.map((item: any) => ({
      media_id: text(item?.media_id || item?.id),
      caption: text(item?.caption) || undefined,
      area: text(item?.area) || undefined,
      stage: stageOf(item?.stage),
      cover: item?.cover === true,
    }));
  }
  if (Array.isArray(body?.photo_media_ids) && body.photo_media_ids.length) {
    const cover = text(body?.cover_photo_media_id);
    return body.photo_media_ids.map((id: unknown) => ({
      media_id: text(id),
      cover: !!cover && text(id) === cover,
    }));
  }
  return null;
}

async function loadJobPhotos(
  client: any,
  jobId: string,
): Promise<{ rows: any[]; detail: any | null }> {
  const [detail, media] = await Promise.all([
    client.from("makesafe_job_details")
      .select("cycle_number, reattend_count, attendance_cycle_id")
      .eq("job_id", jobId).maybeSingle(),
    client.from("job_media")
      .select(
        "id, storage_url, label, type, phase, attendance_cycle_id, cycle_attribution, created_at",
      )
      .eq("job_id", jobId).order("created_at", { ascending: true }).limit(500),
  ]);
  if (detail.error || media.error) {
    fail(
      "report_photos_unreadable",
      `The job's photos could not be read (${
        text(detail.error?.message) || text(media.error?.message) ||
        "unknown database error"
      }). Nothing was changed.`,
      503,
    );
  }
  const rows = ((media.data as any[]) || []).filter((row) =>
    row?.storage_url && isApplicablePackPhoto(row) &&
    // Receipts are cost evidence, not site photos.
    String(row?.phase || "").toLowerCase() !== "receipt"
  );
  return { rows, detail: detail.data || null };
}

/**
 * WRITE unless `dry_run` (the default). Render the job's restoration report.
 */
export async function renderRestorationReportAction(
  client: any,
  body: any,
  caller: RestorationCaller,
  deps: RestorationReportDeps,
): Promise<Record<string, unknown>> {
  const dryRun = body?.dry_run !== false;
  const facts = await loadRestorationReportJobFacts(client, {
    job_id: body?.job_id,
    job_number: body?.job_number,
  }, caller);
  const report = body?.report && typeof body.report === "object"
    ? body.report as Record<string, unknown>
    : null;
  if (!report) {
    fail(
      "report_required",
      "Send the report's words in `report` (findings, works_completed and so on).",
    );
  }
  const findings = section(report.findings);
  const works = section(report.works_completed);
  if (!findings || !works) {
    fail(
      "report_sections_required",
      "A restoration report needs what was found (findings) and what was done (works_completed).",
    );
  }

  // Which photos, in which order.
  const { rows: available, detail } = await loadJobPhotos(
    client,
    facts.job_id,
  );
  const choices = restorationReportPhotoChoices(body);
  let chosen: Array<{ row: any; choice: PhotoChoice | null }>;
  if (choices) {
    const bad = choices.filter((c) => !UUID_RE.test(c.media_id));
    if (bad.length) {
      fail("photo_id_invalid", "Every photo must be named by its job photo id.");
    }
    const byId = new Map(available.map((row) => [String(row.id), row]));
    const missing = choices.filter((c) => !byId.has(c.media_id));
    if (missing.length) {
      fail(
        "photo_not_on_job",
        `These photos are not site photos on ${facts.job_number}: ${
          missing.map((c) => c.media_id).join(", ")
        }. Nothing was changed.`,
        409,
      );
    }
    chosen = choices.map((choice) => ({ row: byId.get(choice.media_id), choice }));
  } else {
    // By default: this attendance's photos, in the order they were uploaded.
    const current = detail
      ? filterMediaForCurrentCycle(
        available,
        detail,
        detail.attendance_cycle_id || null,
      )
      : available;
    chosen = current.map((row) => ({ row, choice: null }));
  }
  if (chosen.length > RESTORATION_REPORT_MAX_PHOTOS) {
    fail(
      "too_many_photos",
      `${facts.job_number} has ${chosen.length} photos and a report holds at most ${RESTORATION_REPORT_MAX_PHOTOS}. Name the ones to use in photo_media_ids.`,
      409,
    );
  }

  const photos: RestorationReportPhoto[] = [];
  const unreadable: string[] = [];
  let photoBytes = 0;
  for (const { row, choice } of chosen) {
    const fetched = await deps.fetchPhoto({
      id: String(row.id),
      storage_url: String(row.storage_url),
    });
    if (!fetched?.bytes?.byteLength) {
      unreadable.push(String(row.id));
      continue;
    }
    photoBytes += fetched.bytes.byteLength;
    if (photoBytes > RESTORATION_REPORT_PHOTO_BYTES_BUDGET) {
      fail(
        "photos_too_large",
        `The photos for ${facts.job_number} are too large to put in one report. Name fewer in photo_media_ids. Nothing was changed.`,
        409,
      );
    }
    photos.push({
      bytes: fetched.bytes,
      mime: fetched.mime,
      caption: choice?.caption || text(row.label) || undefined,
      area: choice?.area,
      stage: choice?.stage,
      cover: choice?.cover === true,
    });
  }
  if (unreadable.length) {
    // A report that quietly leaves a photo out reads as a complete record.
    fail(
      "photo_unreadable",
      `These photos could not be read, so the report was not made: ${
        unreadable.join(", ")
      }. Nothing was changed.`,
      503,
    );
  }

  const input: RestorationReportInput = {
    job_number: facts.job_number,
    builder_name: text(report.builder_name) || facts.builder_name,
    builder_reference: facts.builder_reference,
    builder_purchase_order: facts.builder_purchase_order,
    site_address: facts.site_address,
    policyholder: text(report.policyholder) || facts.policyholder,
    attended_on: text(report.attended_on) || null,
    arrived_at: text(report.arrived_at) || null,
    crew_line: text(report.crew_line) || null,
    outcome: text(report.outcome) || null,
    subtitle: text(report.subtitle) || null,
    work_order_instruction: text(report.work_order_instruction) || null,
    approved_quote_note: text(report.approved_quote_note) || null,
    findings,
    works_completed: works,
    materials: section(report.materials),
    photos,
  };
  if (!input.site_address) {
    fail(
      "site_address_missing",
      `${facts.job_number} has no site address, so its report cannot be made.`,
      409,
    );
  }
  const problems = restorationReportWordingProblems(input);
  if (problems.length) {
    fail(
      "report_wording_not_allowed",
      `A restoration report carries no prices and none of our internal words. Reword: ${
        problems.join(", ")
      }.`,
    );
  }

  const rendered = await (deps.render || renderRestorationReportPdf)(input);
  const summary = {
    job: { id: facts.job_id, job_number: facts.job_number },
    file_name: rendered.fileName,
    pages: rendered.pages,
    bytes: rendered.bytes.byteLength,
    photos: rendered.photos_embedded,
    facts: {
      builder_name: input.builder_name,
      builder_reference: input.builder_reference,
      builder_purchase_order: input.builder_purchase_order,
      site_address: input.site_address,
      policyholder: input.policyholder,
    },
  };
  if (dryRun) {
    return {
      success: true,
      dry_run: true,
      ...summary,
      pdf_base64: encodeBase64(rendered.bytes),
    };
  }

  const uploaded = await deps.persistPdf({
    jobId: facts.job_id,
    fileName: rendered.fileName,
    bytes: rendered.bytes,
  });
  const attached = await deps.attachDocument({
    job_id: facts.job_id,
    type: "makesafe_report",
    file_name: rendered.fileName,
    url: uploaded.publicUrl,
    path: uploaded.storagePath,
    uploaded_by: caller.userId || caller.label || null,
    operator_email: caller.label || null,
  });
  return {
    success: true,
    dry_run: false,
    ...summary,
    document_id: attached?.document_id || null,
    url: attached?.url || uploaded.publicUrl,
  };
}
