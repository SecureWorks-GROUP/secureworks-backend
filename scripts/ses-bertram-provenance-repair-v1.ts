#!/usr/bin/env -S deno run --allow-env=SUPABASE_ACCESS_TOKEN,SW_SUPABASE_URL,SW_API_KEY,SW_WIKI_REPO --allow-net --allow-read --allow-write --allow-run=git,python3,pdfinfo,pdftotext

import {
  assertRendererBoundary,
  bytesToBase64,
  enumerateRows,
  managementSql,
  opsAction,
  renderProtectedBertramReport,
  sha256,
} from "./ses-curated-docket-sweep-v1.ts";
import {
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
} from "../supabase/functions/ops-api/makesafe_report_render.ts";

const JOB_ID = "208450c0-7161-4b30-9514-66226b054609";
const JOB_NUMBER = "SWMS-261109";
const EXPECTED_PDF_SHA256 =
  "5c0dfc02488907f9e4ac1196a1dee6d390ba61a38afd0fb3b20e37139c6f13f8";
const PROTECTED_REPAIR_AUTHORITY = "bertram-provenance-repair-v1";
const EXPECTED_REPORT_DOCUMENT_SOURCE = "current_cycle_curated_makesafe_report";
const EXPECTED_PAGES = 36;
const EXPECTED_PHOTOS = 35;
const EXPECTED_MATERIALS =
  "20 star pickets installed to prop and secure the existing fence line.";
const EXPECTED_FINDINGS =
  "Storm and wind have cracked the asbestos cement (supersix) boundary fencing to the back, front and side boundaries. The fence is leaning out of plumb and is losing its capping along the top edge. In its damaged state the fence presented a collapse risk to the property and to anyone passing the boundary, so it required immediate temporary support before any permanent repair could be scheduled.";
const COMMERCIAL_TEXT_RE =
  /(?:\$\s*\d|\b(?:aud|gst|invoice|invoiced|billing|billed|dollars?|hours?|hourly|rates?|subtotal|total)\b)/i;

function parseOptions(args: string[]) {
  let apply = false;
  let output = "tmp/pdfs/bertram-protected-current-render.pdf";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--output") output = args[++index] || "";
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!output) throw new Error("--output requires a path");
  return { apply, output };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredUuid(value: unknown, label: string): string {
  const result = String(value || "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      result,
    )
  ) {
    throw new Error(`${label} did not return a UUID`);
  }
  return result;
}

async function commandText(command: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `${command} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

async function verifyRenderedContent(path: string): Promise<{
  pages: number;
  photo_labels: number;
  commercial_tokens: number;
}> {
  const info = await commandText("pdfinfo", [path]);
  const pages = Number(info.match(/^Pages:\s+(\d+)$/m)?.[1] || 0);
  const reportText = await commandText("pdftotext", ["-layout", path, "-"]);
  const photoLabels =
    reportText.match(/Photo evidence \d+ - Site photo \d+/g) || [];
  const commercialTokens =
    reportText.match(new RegExp(COMMERCIAL_TEXT_RE.source, "gi")) || [];
  if (
    pages !== EXPECTED_PAGES || photoLabels.length !== EXPECTED_PHOTOS ||
    !reportText.includes(EXPECTED_MATERIALS) ||
    !reportText.includes(EXPECTED_FINDINGS) || commercialTokens.length !== 0
  ) {
    throw new Error(
      "protected Bertram PDF failed the 36-page, 35-photo, narrative, materials, or zero-commercial-token contract",
    );
  }
  return {
    pages,
    photo_labels: photoLabels.length,
    commercial_tokens: commercialTokens.length,
  };
}

async function fetchSha256(url: unknown, label: string): Promise<string> {
  const value = String(url || "").trim();
  if (!value.startsWith("https://")) {
    throw new Error(`${label} did not expose a served HTTPS URL`);
  }
  const response = await fetch(value, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`${label} served HTTP ${response.status}`);
  }
  return await sha256(new Uint8Array(await response.arrayBuffer()));
}

async function verifyAppliedRepair(
  documentId: unknown,
  revisionId: unknown,
  reportInputHash: string,
): Promise<Record<string, unknown>> {
  const document = requiredUuid(documentId, "document attach");
  const revision = requiredUuid(revisionId, "docket prepare");
  const rows = await managementSql(`
select
  document.id::text as document_id,
  document.version,
  document.file_name,
  document.pdf_url,
  document.storage_url,
  document.attendance_cycle_id::text,
  document.cycle_attribution,
  document.data_snapshot_json,
  review.docket_revision_id::text,
  artifact.content_hash,
  artifact.object_key,
  artifact.metadata
from job_documents document
join ses_docket_review_current review on review.job_id = document.job_id
join makesafe_docket_artifacts artifact
  on artifact.revision_id = review.docket_revision_id
 and artifact.role = 'supporting_report_pdf'
where document.job_id = '${JOB_ID}'::uuid
  and document.id = '${document}'::uuid;
`);
  if (rows.length !== 1) {
    throw new Error(
      "production read-back did not return the attached document and current review artifact",
    );
  }
  const row = object(rows[0]);
  const snapshot = object(row.data_snapshot_json);
  const metadata = object(row.metadata);
  if (
    row.document_id !== document || row.docket_revision_id !== revision ||
    row.attendance_cycle_id !==
      "2a696c19-05b6-4186-9e00-380dc7202962" ||
    row.cycle_attribution !== "bound" ||
    snapshot.report_render_hash !== EXPECTED_PDF_SHA256 ||
    snapshot.report_input_hash !== reportInputHash ||
    snapshot.report_renderer_source_revision !==
      MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION ||
    snapshot.report_renderer_script_sha256 !==
      MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256 ||
    snapshot.evidence_source !== EXPECTED_REPORT_DOCUMENT_SOURCE ||
    snapshot.source_document_id !== document ||
    metadata.report_document_id !== document ||
    metadata.render_hash !== EXPECTED_PDF_SHA256
  ) {
    throw new Error(
      "production provenance read-back did not match the protected repair contract",
    );
  }

  const documentServedSha256 = await fetchSha256(
    row.pdf_url || row.storage_url,
    "job_document",
  );
  const pack = object(
    await opsAction("get_ses_reviewable_pack", {
      docket_revision_id: revision,
    }),
  );
  const artifact = array(pack.artifacts).map(object).find((candidate) =>
    candidate.role === "supporting_report_pdf"
  );
  if (!artifact) {
    throw new Error("review pack did not serve supporting_report_pdf");
  }
  const reviewServedSha256 = await fetchSha256(
    artifact.signed_url,
    "review supporting_report_pdf",
  );
  if (
    documentServedSha256 !== EXPECTED_PDF_SHA256 ||
    reviewServedSha256 !== EXPECTED_PDF_SHA256
  ) {
    throw new Error(
      "served job_document and review artifact bytes do not match the protected render",
    );
  }
  return {
    document_id: document,
    document_version: row.version,
    docket_revision_id: revision,
    artifact_content_hash: row.content_hash,
    job_document_served_sha256: documentServedSha256,
    review_served_sha256: reviewServedSha256,
    production_provenance_verified: true,
  };
}

function assertReadyPricing(result: unknown): void {
  const revision = object(array(object(result).results)[0]);
  const proposal = object(revision.invoice_proposal);
  const lines = array(proposal.line_items).map(object);
  const labour = lines.find((line) =>
    /make-safe attendance/i.test(String(line.description || ""))
  );
  const pickets = lines.find((line) =>
    /star pickets supplied/i.test(String(line.description || ""))
  );
  if (
    revision.state !== "ready" || array(revision.blockers).length !== 0 ||
    !labour || Number(labour.quantity) !== 6 ||
    Number(labour.unit_price_ex_gst) !== 80 ||
    !pickets || Number(pickets.quantity) !== 20 ||
    Number(pickets.unit_price_ex_gst) !== 13.5 ||
    Number(proposal.subtotal_ex_gst) !== 750 ||
    Number(proposal.gst) !== 75 || Number(proposal.total_inc_gst) !== 825 ||
    Object.keys(object(revision.email_drafts)).length !== 3
  ) {
    throw new Error(
      "Bertram pack did not reach the exact READY pricing contract",
    );
  }
}

export async function main(args = Deno.args): Promise<void> {
  const options = parseOptions(args);
  await assertRendererBoundary();
  const row = (await enumerateRows()).find((candidate) =>
    candidate.job_id === JOB_ID && candidate.job_number === JOB_NUMBER
  );
  if (!row) throw new Error("protected Bertram review row is unavailable");

  const rendered = await renderProtectedBertramReport(row);
  const slash = options.output.lastIndexOf("/");
  if (slash >= 0) {
    await Deno.mkdir(options.output.slice(0, slash), {
      recursive: true,
    });
  }
  await Deno.writeFile(options.output, rendered.bytes);
  if (rendered.pdf_sha256 !== EXPECTED_PDF_SHA256) {
    throw new Error(
      `protected Bertram render drift: ${rendered.pdf_sha256}; inspect ${options.output}`,
    );
  }
  const contentProof = await verifyRenderedContent(options.output);

  const summary: Record<string, unknown> = {
    mode: options.apply ? "apply" : "dry_run",
    job_id: row.job_id,
    job_number: row.job_number,
    builder_reference: row.builder_reference,
    source_report_id: row.source.report_id,
    photo_count: (rendered.report_job.photos as unknown[]).length,
    report_input_hash: rendered.report_input_hash,
    pdf_sha256: rendered.pdf_sha256,
    pdf_size_bytes: rendered.bytes.byteLength,
    content_proof: contentProof,
    output: options.output,
    writes: [],
  };

  if (options.apply) {
    const attached = await opsAction("attach_current_wiki_curated_report", {
      job_id: row.job_id,
      renderer_source_revision: MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
      renderer_script_sha256: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
      pdf_base64: bytesToBase64(rendered.bytes),
      pdf_sha256: rendered.pdf_sha256,
      report_input_hash: rendered.report_input_hash,
      report_job: rendered.report_job,
      protected_repair_authority: PROTECTED_REPAIR_AUTHORITY,
      operator: "bertram-provenance-repair-v1",
    }, 120_000);
    if (!attached?.document_id) {
      throw new Error("protected Bertram document attach did not return an id");
    }

    const prepared = await opsAction("prepare_ses_docket_revision", {
      selection: { mode: "job_id", job_id: row.job_id },
      dry_run: false,
      idempotency_key: `bertram-provenance-repair-v1:${rendered.pdf_sha256}`,
    }, 120_000);
    assertReadyPricing(prepared);

    const dryRun = await opsAction("prepare_ses_docket_revision", {
      selection: { mode: "job_id", job_id: row.job_id },
      dry_run: true,
      idempotency_key:
        `bertram-provenance-repair-v1:proof:${crypto.randomUUID()}`,
    }, 120_000);
    assertReadyPricing(dryRun);
    summary.writes = [
      "current curated job_document",
      "content-addressed docket revision",
    ];
    const liveProof = await verifyAppliedRepair(
      attached.document_id,
      prepared.results[0].docket_revision_id,
      rendered.report_input_hash,
    );
    summary.live_proof = liveProof;
    summary.ready_pricing = dryRun.results[0].invoice_proposal;
    summary.email_draft_keys = Object.keys(
      dryRun.results[0].email_drafts || {},
    ).sort();
  }

  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
