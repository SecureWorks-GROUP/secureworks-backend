#!/usr/bin/env -S deno run --allow-env=SUPABASE_ACCESS_TOKEN,SW_SUPABASE_URL,SW_API_KEY --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any

import {
  canonicalSesJson,
  type SesPhysicalReportProof,
} from "../supabase/functions/ops-api/ses_docket_envelope.ts";
import {
  runGuardedSweep,
  SWEEP_SCHEMA,
  sweepBoundary,
  type SweepEntry,
  type SweepRow,
  validSweepSourceProof,
} from "./ses-curated-docket-sweep-v1-core.ts";

const MANIFEST_DEFAULT = "/tmp/ses-curated-docket-sweep-v1.json";
const READ_TIMEOUT_MS = 20_000;

interface Options {
  mode: "dry_run" | "apply";
  manifest: string;
}

export function parseOptions(args: string[]): Options {
  let mode: Options["mode"] = "dry_run";
  let manifest = MANIFEST_DEFAULT;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") mode = "apply";
    else if (arg === "--dry-run") mode = "dry_run";
    else if (arg === "--manifest") manifest = args[++i] || "";
    else if (arg === "--help") {
      console.log(
        "usage: ses-curated-docket-sweep-v1.ts [--dry-run] [--apply --manifest PATH] [--manifest PATH]",
      );
      Deno.exit(0);
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (!manifest) throw new Error("--manifest requires a path");
  return { mode, manifest };
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function reviewedWikiRepoPath(value: unknown): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path || !path.startsWith("/")) {
    throw new Error(
      "SW_WIKI_REPO must be an explicit absolute current-wiki checkout path",
    );
  }
  return path;
}

function wikiRepoPath(): string {
  return reviewedWikiRepoPath(requiredEnv("SW_WIKI_REPO"));
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
    );
  }
  return btoa(chunks.join(""));
}

export function parseRemoteMainRevision(output: string): string {
  const rows = output.trim().split(/\r?\n/).map((line) => line.trim())
    .filter(Boolean);
  const match = rows.find((line) => line.endsWith("\trefs/heads/main"));
  const revision = match?.split(/\s+/)[0] || "";
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("remote main revision could not be resolved");
  }
  return revision;
}

export function changedDependencyPaths(
  reviewed: Record<string, string>,
  remote: Record<string, string>,
): string[] {
  return Object.keys(reviewed).filter((path) =>
    !remote[path] || remote[path] !== reviewed[path]
  ).sort();
}

export async function commandOutputWithTimeout(
  command: Deno.Command,
  timeoutMs: number,
): Promise<Deno.CommandOutput> {
  const child = command.spawn();
  let timer: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have exited on the same event-loop turn.
      }
      reject(
        new SweepRefusal(
          "renderer_subprocess_timeout",
          "The current-wiki renderer exceeded its per-card time limit.",
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([child.output(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function managementSql(query: string): Promise<any[]> {
  const host = new URL(requiredEnv("SW_SUPABASE_URL")).hostname;
  const projectRef = host.split(".")[0];
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredEnv("SUPABASE_ACCESS_TOKEN")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, read_only: true }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`production read failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("production read returned no rows");
  return data;
}

const ENUMERATION_SQL = `
select
  review.job_id::text,
  jobs.job_number,
  detail.external_ref as builder_reference,
  jobs.site_suburb as suburb,
  review.docket_revision_id::text,
  artifact.content_hash as docket_artifact_hash,
  artifact.object_key as docket_object_key,
  artifact.metadata as artifact_metadata,
  revision.envelope #>> '{v2,classification,family}' as family
from ses_docket_review_current review
join jobs on jobs.id = review.job_id
join makesafe_job_details detail on detail.job_id = review.job_id
join makesafe_docket_revisions revision on revision.id = review.docket_revision_id
left join makesafe_docket_artifacts artifact
  on artifact.revision_id = review.docket_revision_id
 and artifact.role = 'supporting_report_pdf'
where review.review_state = 'needs_review'
order by review.review_state_changed_at, review.job_id;
`;

export async function enumerateRows(): Promise<SweepRow[]> {
  return (await managementSql(ENUMERATION_SQL)).map((row) => ({
    job_id: row.job_id,
    job_number: row.job_number,
    builder_reference: row.builder_reference || null,
    suburb: row.suburb || null,
    docket_revision_id: row.docket_revision_id,
    docket_artifact_hash: row.docket_artifact_hash || null,
    docket_object_key: row.docket_object_key || null,
    artifact_metadata: row.artifact_metadata || null,
    family: row.family || null,
    source: row,
  }));
}

async function recordProtectedServedRawProof(rows: SweepRow[]): Promise<void> {
  for (const row of rows) {
    if (row.job_number !== MUTATION_EXCLUDED_JOB_NUMBER) continue;
    const metadata = { ...(row.artifact_metadata || {}) };
    try {
      const pack = await opsAction("get_ses_reviewable_pack", {
        docket_revision_id: row.docket_revision_id,
      });
      const artifact = (pack.artifacts || []).find((item: any) =>
        item.role === "supporting_report_pdf"
      );
      if (!artifact?.signed_url) {
        throw new Error("served report URL unavailable");
      }
      const response = await fetch(artifact.signed_url, {
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`served report read HTTP ${response.status}`);
      }
      const servedHash = await sha256(
        new Uint8Array(await response.arrayBuffer()),
      );
      Object.assign(metadata, {
        protected_served_raw_sha256: servedHash,
        protected_candidate_raw_sha256: null,
        protected_raw_bytes_equal: null,
        protected_equality_decision:
          "excluded_before_touch_no_identical_candidate_proven",
      });
    } catch (error) {
      Object.assign(metadata, {
        protected_served_raw_sha256: null,
        protected_candidate_raw_sha256: null,
        protected_raw_bytes_equal: null,
        protected_equality_decision:
          "excluded_before_touch_raw_proof_unavailable",
        protected_proof_error: error instanceof Error
          ? error.message
          : String(error),
      });
    }
    row.artifact_metadata = metadata;
  }
}

async function gitBytesAt(
  cwd: string,
  revision: string,
  path: string,
): Promise<Uint8Array> {
  const command = new Deno.Command("git", {
    cwd,
    args: ["show", `${revision}:${path}`],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    throw new Error(`current wiki file unavailable: ${path}`);
  }
  return result.stdout;
}

async function gitBytes(path: string): Promise<Uint8Array> {
  return await gitBytesAt(
    wikiRepoPath(),
    MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
    path,
  );
}

export async function assertRendererBoundary(): Promise<void> {
  const command = new Deno.Command("git", {
    cwd: wikiRepoPath(),
    args: ["ls-remote", "origin", "refs/heads/main"],
    stdout: "piped",
  });
  const result = await command.output();
  const actual = result.success
    ? parseRemoteMainRevision(new TextDecoder().decode(result.stdout))
    : "";
  if (actual !== MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION) {
    const isolated = await Deno.makeTempDir({ prefix: "wiki-remote-main-" });
    try {
      const remoteResult = await new Deno.Command("git", {
        cwd: wikiRepoPath(),
        args: ["remote", "get-url", "origin"],
        stdout: "piped",
      }).output();
      const remoteUrl = new TextDecoder().decode(remoteResult.stdout).trim();
      if (!remoteResult.success || !remoteUrl) {
        throw new SweepRefusal(
          "renderer_source_drift",
          "The current wiki remote URL could not be resolved read-only.",
        );
      }
      const init = await new Deno.Command("git", {
        cwd: isolated,
        args: ["init", "--quiet"],
        stderr: "piped",
      }).output();
      const fetched = init.success
        ? await new Deno.Command("git", {
          cwd: isolated,
          args: [
            "fetch",
            "--quiet",
            "--depth=1",
            remoteUrl,
            "refs/heads/main",
          ],
          stderr: "piped",
        }).output()
        : init;
      if (!fetched.success) {
        throw new SweepRefusal(
          "renderer_source_drift",
          "Remote current-main dependency bytes could not be fetched into the isolated verifier.",
        );
      }
      const reviewed: Record<string, string> = {};
      const remote: Record<string, string> = {};
      for (const relative of RENDERER_DEPENDENCIES) {
        const path = `${SKILL_ROOT}/${relative}`;
        reviewed[relative] = await sha256(await gitBytes(path));
        remote[relative] = await sha256(
          await gitBytesAt(isolated, "FETCH_HEAD", path),
        );
      }
      const changed = changedDependencyPaths(reviewed, remote);
      if (changed.length) {
        throw new SweepRefusal(
          "renderer_source_drift",
          `Current remote main changed reviewed renderer dependencies: ${
            changed.join(", ")
          }.`,
        );
      }
    } finally {
      await Deno.remove(isolated, { recursive: true });
    }
  }
  const renderer = await gitBytes(
    `${SKILL_ROOT}/scripts/render_makesafe_report.py`,
  );
  if (
    await sha256(renderer) !== MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256
  ) {
    throw new SweepRefusal(
      "renderer_source_drift",
      "The reviewed current-wiki renderer raw SHA-256 no longer matches.",
    );
  }
}

async function materializeRenderer(dir: string): Promise<string> {
  for (const relative of RENDERER_DEPENDENCIES) {
    const target = `${dir}/${relative}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeFile(target, await gitBytes(`${SKILL_ROOT}/${relative}`));
  }
  return `${dir}/scripts/render_makesafe_report.py`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function explicitMaterials(checklist: Record<string, unknown>) {
  if (!Object.hasOwn(checklist, "materials_used")) {
    throw new SweepRefusal(
      "materials_evidence_missing",
      "Current-cycle trade evidence does not explicitly account for used materials.",
    );
  }
  if (
    !Array.isArray(checklist.materials_used) ||
    checklist.materials_used.some((item) => !text(item))
  ) {
    throw new SweepRefusal(
      "materials_evidence_ambiguous",
      "Resolve the current-cycle materials_used evidence into explicit selected items.",
    );
  }
  const items = checklist.materials_used.map(text);
  return { state: items.length ? "recorded_used" : "none_recorded", items };
}

function currentMedia(source: any): { applicable: any[]; excluded: any[] } {
  const all = Array.isArray(source.media) ? source.media : [];
  const applicable = all.filter((item: any) => {
    const type = text(item.type).toLowerCase();
    const phase = text(item.phase).toLowerCase();
    return type.includes("photo") || type.includes("image") ||
      phase.includes("completion") || phase.includes("after");
  });
  const applicableIds = new Set(applicable.map((item: any) => text(item.id)));
  const excluded = all.filter((item: any) => !applicableIds.has(text(item.id)))
    .map((item: any) => ({
      evidence_id: text(item.id),
      reason: "current-cycle item is not completion photo evidence",
    }));
  return { applicable, excluded };
}

async function downloadPhoto(item: any, path: string): Promise<void> {
  const url = text(item.storage_url) || text(item.thumbnail_url);
  if (!url) {
    throw new SweepRefusal(
      "photo_bytes_missing",
      "A selected current-cycle photo has no recoverable URL.",
    );
  }
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SweepRefusal(
      error instanceof DOMException && error.name === "TimeoutError"
        ? "photo_bytes_timeout"
        : "photo_bytes_missing",
      "A selected current-cycle photo could not be read within the bounded read window.",
    );
  }
  if (!response.ok) {
    throw new SweepRefusal(
      "photo_bytes_missing",
      `A selected current-cycle photo could not be read (HTTP ${response.status}).`,
    );
  }
  await Deno.writeFile(path, new Uint8Array(await response.arrayBuffer()));
}

export function currentWikiRendererCommand(
  renderer: string,
  inputPath: string,
  outDir: string,
): Deno.Command {
  return new Deno.Command("python3", {
    args: [renderer, inputPath, "--out", outDir],
    env: CURRENT_WIKI_RENDER_ENV,
    stdout: "piped",
    stderr: "piped",
  });
}

const BERTRAM_PROTECTED_REPORT = {
  job_id: "208450c0-7161-4b30-9514-66226b054609",
  job_number: "SWMS-261109",
  builder_reference: "AJBR-70271",
  report_id: "ca2952c5-5777-4d26-ab73-2112fa35d9f9",
  attendance_cycle_id: "2a696c19-05b6-4186-9e00-380dc7202962",
  photo_count: 35,
  crew: "2 trades",
  arrival: "09:19",
  scope:
    "Attend the property to make safe the boundary fences to the back, front and sides, which have cracked and are leaning. The fencing is supersix and is losing its capping. Prop up the fence to prevent it falling.",
  findings:
    "Storm and wind have cracked the asbestos cement (supersix) boundary fencing to the back, front and side boundaries. The fence is leaning out of plumb and is losing its capping along the top edge. In its damaged state the fence presented a collapse risk to the property and to anyone passing the boundary, so it required immediate temporary support before any permanent repair could be scheduled.",
  works:
    "We propped up the asbestos cement (supersix) fence using 20 star pickets, driven in along the damaged runs and fixed to the fence to hold it upright and plumb. The fence is now secure and stable and will remain supported until the fence is replaced. The existing fence sheeting and capping were left undisturbed in place on site pending permanent repair, and the site was left clear and safe on departure.",
  materials:
    "20 star pickets installed to prop and secure the existing fence line.",
} as const;

function assertProtectedBertramSource(row: SweepRow, applicable: any[]): void {
  const source: any = row.source;
  const checklist = source.checklist_json || {};
  const materials = Array.isArray(checklist.materials_used)
    ? checklist.materials_used.map(text)
    : [];
  if (
    row.job_id !== BERTRAM_PROTECTED_REPORT.job_id ||
    row.job_number !== BERTRAM_PROTECTED_REPORT.job_number ||
    row.builder_reference !== BERTRAM_PROTECTED_REPORT.builder_reference ||
    source.report_id !== BERTRAM_PROTECTED_REPORT.report_id ||
    source.attendance_cycle_id !==
      BERTRAM_PROTECTED_REPORT.attendance_cycle_id ||
    applicable.length !== BERTRAM_PROTECTED_REPORT.photo_count ||
    !materials.includes("Star pickets x 20")
  ) {
    throw new SweepRefusal(
      "protected_bertram_source_drift",
      "Bertram current-cycle source facts moved since the reviewed repair plan.",
    );
  }
}

async function renderRow(
  row: SweepRow,
  options: { protectedBertramRepair?: boolean } = {},
): Promise<SweepRender> {
  console.error(JSON.stringify({
    progress: "render_candidate",
    job_number: row.job_number,
    builder_reference: row.builder_reference,
    suburb: row.suburb,
  }));
  const source: any = row.source;
  const searched = [
    "jobs",
    "makesafe_job_details",
    "job_service_reports.current_cycle",
    "job_media.current_cycle",
    "makesafe_report_packs",
    "current_wiki_renderer_input",
  ];
  if (source.report_type != null || row.family !== "physical_makesafe") {
    throw new SweepRefusal(
      "not_eligible_physical_report",
      "The current card does not use the physical make-safe report recipe.",
    );
  }
  if (!source.report_id) {
    throw new SweepRefusal(
      "current_cycle_report_missing",
      "No typed current-cycle trade report can reconstruct the case.",
    );
  }
  const checklist =
    source.checklist_json && typeof source.checklist_json === "object"
      ? source.checklist_json as Record<string, unknown>
      : {};
  const protectedBertram = options.protectedBertramRepair === true;
  const scope = protectedBertram
    ? BERTRAM_PROTECTED_REPORT.scope
    : text(checklist.damage_description);
  const findings = protectedBertram
    ? BERTRAM_PROTECTED_REPORT.findings
    : text(checklist.damage_cause);
  const works = protectedBertram
    ? BERTRAM_PROTECTED_REPORT.works
    : text(checklist.work_done) || text(source.notes);
  if (!scope || !findings || !works) {
    throw new SweepRefusal(
      "curated_story_missing",
      "Current-cycle scope, findings and works are not all explicit.",
    );
  }
  const dir = await Deno.makeTempDir({ prefix: "ses-curated-report-" });
  try {
    const renderer = await materializeRenderer(dir);
    const { applicable, excluded } = currentMedia(source);
    if (protectedBertram) assertProtectedBertramSource(row, applicable);
    const photos = [];
    for (let index = 0; index < applicable.length; index++) {
      const item = applicable[index];
      const absoluteFile = `${dir}/photo-${index + 1}.jpg`;
      await downloadPhoto(item, absoluteFile);
      photos.push({
        evidence_id: text(item.id),
        file: absoluteFile,
        caption: protectedBertram
          ? `Site photo ${index + 1}`
          : text(item.label || item.caption) ||
            `Completion evidence ${index + 1}`,
        content_sha256: await sha256(await Deno.readFile(absoluteFile)),
      });
    }
    const ids = photos.map((photo) => photo.evidence_id);
    const reportJob = {
      ref: row.builder_reference || row.job_number,
      address: text(source.site_address) || text(source.suburb),
      contact: text(source.client_name),
      date: text(source.submitted_at).slice(0, 10),
      arrival: protectedBertram
        ? BERTRAM_PROTECTED_REPORT.arrival
        : text(source.start_time),
      ...(protectedBertram ? { crew: BERTRAM_PROTECTED_REPORT.crew } : {}),
      scope,
      findings,
      works,
      ...(protectedBertram
        ? { materials: BERTRAM_PROTECTED_REPORT.materials }
        : {}),
      materials_evidence: protectedBertram
        ? {
          state: "recorded_used",
          items: [BERTRAM_PROTECTED_REPORT.materials],
        }
        : explicitMaterials(checklist),
      photos,
      photo_evidence: {
        source_revision: `job_service_report:${source.report_id}`,
        completeness_verified: true,
        source_count: applicable.length + excluded.length,
        applicable_count: applicable.length,
        selected_count: applicable.length,
        applicable_ids: ids,
        selected_ids: ids,
        excluded,
        rejected: [],
      },
    };
    const inputHash = `sha256:${await sha256(
      new TextEncoder().encode(canonicalSesJson(
        canonicalCurrentWikiReportHashPayload(reportJob),
      )),
    )}`;
    const inputPath = `${dir}/job.json`;
    const outDir = `${dir}/out`;
    await Deno.writeTextFile(inputPath, JSON.stringify(reportJob));
    const process = await commandOutputWithTimeout(
      currentWikiRendererCommand(renderer, inputPath, outDir),
      60_000,
    );
    if (!process.success) {
      throw new SweepRefusal(
        "current_wiki_render_refused",
        new TextDecoder().decode(process.stderr).trim().slice(0, 500),
      );
    }
    const files = [];
    for await (const file of Deno.readDir(outDir)) {
      if (file.isFile && file.name.endsWith(".pdf")) files.push(file.name);
    }
    if (files.length !== 1) {
      throw new SweepRefusal(
        "current_wiki_render_missing",
        "Current wiki did not produce exactly one PDF.",
      );
    }
    const bytes = await Deno.readFile(`${outDir}/${files[0]}`);
    return {
      bytes,
      pdf_sha256: await sha256(bytes),
      report_input_hash: inputHash,
      report_job: reportJob,
      searched_sources: searched,
      rejected_candidates: [],
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

export async function renderProtectedBertramReport(
  row: SweepRow,
): Promise<SweepRender> {
  return await renderRow(row, { protectedBertramRepair: true });
}

export async function opsAction(
  action: string,
  body: Record<string, unknown>,
  timeoutMs = READ_TIMEOUT_MS,
) {
  const response = await fetch(
    `${requiredEnv("SW_SUPABASE_URL")}/functions/v1/ops-api?action=${action}`,
    {
      method: "POST",
      headers: {
        "x-api-key": requiredEnv("SW_API_KEY"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${action} refused: HTTP ${response.status} ${
        payload.error || payload.refusal?.fact || "unknown"
      }`,
    );
  }
  return payload;
}

function selectedSourceFromResult(
  revision: Record<string, any>,
): SesPhysicalReportProof | null {
  const artifacts = Array.isArray(revision.artifacts) ? revision.artifacts : [];
  const plan = artifacts.find((artifact: any) =>
    artifact.role === "supporting_report_plan"
  );
  const planned = plan?.metadata?.selected_source;
  if (validSweepSourceProof(planned)) return planned;
  const report = artifacts.find((artifact: any) =>
    artifact.role === "supporting_report_pdf"
  );
  const metadata = report?.metadata || {};
  const proof = {
    source_kind: metadata.source_kind,
    source_identity: metadata.source_identity,
    source_document_id: metadata.source_document_id,
    source_revision_id: metadata.source_revision_id,
    source_artifact_id: metadata.source_artifact_id,
    source_artifact_content_hash: metadata.source_artifact_content_hash,
    expected_raw_sha256: metadata.expected_raw_sha256,
    ...(metadata.report_input_hash
      ? { report_input_hash: metadata.report_input_hash }
      : {}),
  };
  return validSweepSourceProof(proof) ? proof : null;
}

export function sweepPrepareOutcome(
  revision: Record<string, any>,
  args: { dry_run: boolean },
) {
  const source = selectedSourceFromResult(revision);
  const blockers = Array.isArray(revision.blockers) ? revision.blockers : [];
  let refusal = blockers.length || revision.state !== "ready"
    ? {
      reason_code: blockers[0]?.reason_code || "docket_not_ready",
      recovery_action: blockers[0]?.recovery_action ||
        blockers[0]?.reason ||
        "Resolve every returned blocker and run a new prepare-only dry-run.",
    }
    : null;
  if (!args.dry_run && revision.persisted !== true && !refusal) {
    refusal = {
      reason_code: "persistent_prepare_refused",
      recovery_action:
        "The source-bound persistent prepare did not commit; inspect its blockers and run a new dry-run.",
    };
  }
  return {
    revision_id: revision.docket_revision_id || null,
    source,
    ...(refusal
      ? {
        refusal: {
          code: refusal.reason_code,
          remedy: refusal.recovery_action,
        },
      }
      : {}),
  };
}

async function prepareRow(
  row: SweepRow,
  args: {
    dry_run: boolean;
    expected_physical_report_proof?: SesPhysicalReportProof;
  },
) {
  const result = await opsAction("prepare_ses_docket_revision", {
    selection: { mode: "job_id", job_id: row.job_id },
    dry_run: args.dry_run,
    force_refresh: true,
    require_ready_for_persistence: true,
    idempotency_key: `curated-source:${row.job_id}:${row.docket_revision_id}`,
    ...(args.expected_physical_report_proof
      ? {
        expected_physical_report_proof: args.expected_physical_report_proof,
      }
      : {}),
  });
  const revision = result.results?.[0] || {};
  return sweepPrepareOutcome(revision, args);
}

function markdown(manifest: any): string {
  const lines = [
    "# SES curated docket sweep v1",
    "",
    `- Mode: ${manifest.mode}`,
    `- Inspected: ${manifest.counts.inspected}`,
    `- Selected: ${manifest.counts.selected}`,
    `- Already current: ${manifest.counts.already_current}`,
    `- Refused/excluded: ${manifest.counts.refused_or_excluded}`,
    "",
    "| Job | Builder reference | Suburb | Classification | Verification | Refusal |",
    "|---|---|---|---|---|---|",
  ];
  for (const entry of manifest.entries) {
    lines.push(
      `| ${entry.job_number} | ${entry.builder_reference || ""} | ${
        entry.suburb || ""
      } | ${entry.classification} | ${entry.verification_state} | ${
        entry.refusal?.code || ""
      } |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function main(args = Deno.args): Promise<void> {
  const options = parseOptions(args);
  const rows = await enumerateRows();
  let reviewed: SweepEntry[] = [];
  if (options.mode === "apply") {
    const prior = JSON.parse(await Deno.readTextFile(options.manifest));
    if (
      prior.schema !== SWEEP_SCHEMA || prior.mode !== "dry_run" ||
      canonicalSesJson(prior.boundary) !== canonicalSesJson(sweepBoundary())
    ) {
      throw new Error(
        "apply requires the reviewed dry-run manifest at the exact renderer boundary",
      );
    }
    reviewed = prior.entries;
  }
  const entries = await runGuardedSweep(
    rows,
    { prepare: prepareRow },
    options.mode,
    reviewed,
  );
  const counts = {
    inspected: entries.length,
    selected: entries.filter((entry) => entry.selection === "selected").length,
    already_current:
      entries.filter((entry) => entry.selection === "already_current").length,
    refused_or_excluded: entries.filter((entry) => entry.refusal).length,
  };
  const manifest = {
    schema: SWEEP_SCHEMA,
    mode: options.mode,
    created_at: new Date().toISOString(),
    boundary: sweepBoundary(),
    safety: {
      sends: 0,
      xero_mutations: 0,
      invoice_authorisations: 0,
      schema_migrations: 0,
      allowed_writes: options.mode === "apply"
        ? ["content-addressed docket revision from the reviewed source proof"]
        : [],
    },
    counts,
    entries,
  };
  const outputPath = options.mode === "dry_run"
    ? options.manifest
    : options.manifest.replace(/\.json$/, ".apply.json");
  await Deno.mkdir(outputPath.slice(0, outputPath.lastIndexOf("/")) || ".", {
    recursive: true,
  });
  await Deno.writeTextFile(
    outputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await Deno.writeTextFile(
    outputPath.replace(/\.json$/, ".md"),
    markdown(manifest),
  );
  console.log([
    "sweep:",
    `  mode: ${options.mode}`,
    `  inspected: ${counts.inspected}`,
    `  selected: ${counts.selected}`,
    `  already_current: ${counts.already_current}`,
    `  refused_or_excluded: ${counts.refused_or_excluded}`,
    `  manifest: ${outputPath}`,
  ].join("\n"));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    Deno.exit(1);
  });
}
