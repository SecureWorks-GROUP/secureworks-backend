// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE — PORTAL-LINK BACKFILL (dry-run-first, audited)
// Mission: makesafe/intake-resurrect-harden (Auto-Intake v2 Wave 1 M1, D-c)
// ════════════════════════════════════════════════════════════
//
// THE PROBLEM (Maverick's re-reported bug, subsumed here)
// -------------------------------------------------------
// v1 dropped the builder portal link on 31 of 35 roof-report jobs: the classifier
// went silent (dead key) so extraction.portal_links was empty, and links were also
// mis-keyed on the shared builder ref instead of per email. Forward-fix lives in the
// scan (per-email extraction, canonical makesafe_job_details.external_links). This
// module is the BACKFILL: it recovers the missing links for the jobs already on the
// board from their ORIGINAL work-order email bodies — deterministic regex, so it runs
// WITHOUT the Anthropic key.
//
// SAFETY (proven irreversible-cascade risk — request doc)
// -------------------------------------------------------
//   - IN-PLACE METADATA PATCH ONLY. It writes makesafe_job_details.external_links
//     (the canonical field) and the jobs.metadata.external_links alias. It NEVER
//     deletes, NEVER reopens, NEVER touches job status/substatus, NEVER re-drafts.
//   - DRY-RUN FIRST (default). The dry run returns exactly what WOULD be patched,
//     per job, with the evidence email id. A human runs the live patch.
//   - It completes typed report recipes without replacing operator links. A partial
//     assessment triad is merged in place; a complete recipe is left untouched.
//
// The pure summarizer takes already-read rows so it is fully unit-testable; the DB
// action does the reads + (only when dryRun=false) the in-place patch.

import {
  type BuilderEmailLink,
  extractBuilderEmailLinks,
  mergeDeterministicAndClaudeLinks,
  mergeIntoExternalLinks,
  normalizeReportExternalLinks,
} from "./makesafe_email_links.ts";

// Report-family jobs are the ones whose actionable deliverable is a portal link
// (roof report / assessment-quote). general_makesafe / temp_fence carry a WO PDF, not
// a portal link, so they are out of scope for this recovery.
const REPORT_FAMILIES = new Set(["roof_report", "assessment_report_quote"]);
const REPORT_TYPES = new Set(["roof_report", "assessment_report"]);

export interface LinkBackfillJobInput {
  job_id: string;
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  report_type?: string | null;
  /** metadata.makesafe_job_family (may be absent on legacy jobs). */
  job_family?: string | null;
  /** jobs.status — used only to skip archived jobs by default. */
  job_status?: string | null;
  /** current makesafe_job_details.external_links (canonical). */
  current_external_links?: any;
  /** full emails.body_content of the original WO email (null if purged/not found). */
  email_body?: string | null;
  /** deterministic text recovered from the original WO attachment/PDF. */
  email_attachment_text?: string | null;
  /** the linking draft's extraction_json (may already hold portal_links). */
  draft_extraction?: any;
  /** the source email post id (evidence for the audit trail). */
  evidence_email_id?: string | null;
}

export interface LinkBackfillPatch {
  job_id: string;
  external_ref: string | null;
  family: string | null;
  recovered_links: BuilderEmailLink[];
  sources: string[];
  evidence_email_id: string | null;
  waiting_on: string[];
}

export interface LinkBackfillReport {
  ok: true;
  dry_run: boolean;
  limit: number;
  counts: {
    jobs_examined: number;
    report_family_missing_links: number;
    patches_planned: number;
    jobs_no_recoverable_source: number;
    jobs_applied: number;
  };
  patches: LinkBackfillPatch[];
  no_source: Array<{
    job_id: string;
    external_ref: string | null;
    waiting_on: string[];
  }>;
}

function parseObj(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      return p && typeof p === "object" && !Array.isArray(p) ? p : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function currentLinks(current: any): BuilderEmailLink[] {
  return mergeIntoExternalLinks(current, []).links;
}

function requiredKinds(job: LinkBackfillJobInput): string[] {
  return jobFamilyOf(job) === "assessment_report_quote"
    ? ["assessment_report", "photos", "quote"]
    : ["roof_report"];
}

function missingKinds(
  job: LinkBackfillJobInput,
  links: BuilderEmailLink[],
): string[] {
  const found = new Set(links.map((link) => link.kind));
  return requiredKinds(job).filter((kind) => !found.has(kind));
}

function waitingSentence(kind: string): string {
  if (kind === "assessment_report") {
    return "The work order email contains no assessment link - ask the builder to send it.";
  }
  if (kind === "photos") {
    return "The work order email contains no photos link - ask the builder to send it.";
  }
  if (kind === "quote") {
    return "The work order email contains no quote/scope link - ask the builder to send it.";
  }
  return "The work order email contains no roof report link - ask the builder to send it.";
}

function jobFamilyOf(job: LinkBackfillJobInput): string | null {
  const fam = String(job.job_family || "").trim().toLowerCase();
  if (fam) return fam;
  const rt = String(job.report_type || "").trim().toLowerCase();
  if (rt === "roof_report") return "roof_report";
  if (rt === "assessment_report") return "assessment_report_quote";
  return null;
}

function isReportFamily(job: LinkBackfillJobInput): boolean {
  const fam = jobFamilyOf(job);
  if (fam && REPORT_FAMILIES.has(fam)) return true;
  return REPORT_TYPES.has(String(job.report_type || "").trim().toLowerCase());
}

/**
 * Recover the portal links for one job from its original WO email body + linking
 * draft extraction, using the SAME deterministic extractor + canonical normalizer the
 * scan uses. Returns [] when nothing is recoverable.
 */
export function recoverJobLinks(job: LinkBackfillJobInput): {
  links: BuilderEmailLink[];
  sources: string[];
} {
  const sources: string[] = [];
  const bodyLinks = extractBuilderEmailLinks(
    job.email_body || "",
    job.email_attachment_text || "",
  );
  if (bodyLinks.some((link) => link.source === "email_body")) {
    sources.push("email_body");
  }
  if (bodyLinks.some((link) => link.source === "attachment_text")) {
    sources.push("attachment_text");
  }

  // mergeDeterministicAndClaudeLinks unions body-extracted links with any links the
  // draft's extraction already captured (canonical {label,url,kind,source} shape).
  const draftExtraction = parseObj(job.draft_extraction);
  const merged = mergeDeterministicAndClaudeLinks(bodyLinks, draftExtraction);
  const draftOnly = normalizeReportExternalLinks(draftExtraction);
  if (draftOnly.length && merged.length > bodyLinks.length) {
    sources.push("draft_extraction");
  } else if (!bodyLinks.length && draftOnly.length) {
    sources.push("draft_extraction");
  }
  return { links: merged, sources };
}

export function selectLegacyWorkOrderEmail(
  externalRef: string | null | undefined,
  rows: any[],
): any | null {
  const ref = String(externalRef || "").trim().toLowerCase();
  if (!ref) return null;
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactRef = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i");
  const candidates = (rows || []).filter((candidate) => {
    const haystack = `${candidate.subject || ""}\n${
      candidate.body_preview || ""
    }\n${candidate.body_content || ""}`;
    return exactRef.test(haystack);
  });
  candidates.sort((a, b) => {
    const score = (candidate: any) => {
      const body = candidate.body_content || candidate.body_preview || "";
      const links = extractBuilderEmailLinks(body).length;
      const subject = String(candidate.subject || "");
      return links * 100 +
        (/new work order|work order/i.test(subject) ? 20 : 0) +
        (/our ref/i.test(subject) ? 10 : 0);
    };
    return score(b) - score(a) ||
      String(b.received_at || "").localeCompare(String(a.received_at || ""));
  });
  return candidates[0] || null;
}

export function summarizeLinkBackfill(input: {
  jobs: LinkBackfillJobInput[];
  dryRun?: boolean;
  includeArchived?: boolean;
  limit?: number;
}): LinkBackfillReport {
  const dryRun = input.dryRun !== false; // default TRUE
  const includeArchived = input.includeArchived === true;
  const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
  const jobs = input.jobs || [];

  const patches: LinkBackfillPatch[] = [];
  const noSource: LinkBackfillReport["no_source"] = [];
  let reportFamilyMissing = 0;

  for (const job of jobs) {
    if (!isReportFamily(job)) continue;
    // OPEN = not archived (default). A report job that is done but link-less can still
    // be patched by opting into includeArchived.
    if (
      !includeArchived &&
      String(job.job_status || "").toLowerCase() === "archived"
    ) continue;
    const existing = currentLinks(job.current_external_links);
    if (missingKinds(job, existing).length === 0) continue;

    reportFamilyMissing++;
    const recovered = recoverJobLinks(job);
    const merged = mergeIntoExternalLinks(existing, recovered.links);
    const waitingOn = missingKinds(job, merged.links).map(waitingSentence);
    if (!merged.added.length && !merged.upgraded.length) {
      noSource.push({
        job_id: job.job_id,
        external_ref: job.external_ref || null,
        waiting_on: waitingOn,
      });
      continue;
    }
    if (patches.length >= limit) continue;
    patches.push({
      job_id: job.job_id,
      external_ref: job.external_ref || null,
      family: jobFamilyOf(job),
      recovered_links: merged.links,
      sources: recovered.sources,
      evidence_email_id: job.evidence_email_id || null,
      waiting_on: waitingOn,
    });
  }

  return {
    ok: true,
    dry_run: dryRun,
    limit,
    counts: {
      jobs_examined: jobs.length,
      report_family_missing_links: reportFamilyMissing,
      patches_planned: patches.length,
      jobs_no_recoverable_source: noSource.length,
      jobs_applied: 0, // set by the action when a live patch runs
    },
    patches,
    no_source: noSource,
  };
}

/**
 * DB action. Reads report-family jobs missing links, joins each to its linking draft +
 * original email, computes the recovered links, and (only when dryRun=false) writes the
 * in-place canonical patch. Default dryRun=TRUE — nothing is written unless a human/
 * privileged caller explicitly passes dry_run:false.
 */
export async function makesafeIntakeLinkBackfill(
  client: any,
  opts: { dryRun?: boolean; includeArchived?: boolean; limit?: number } = {},
): Promise<LinkBackfillReport> {
  const dryRun = opts.dryRun !== false;

  // Report-family / report-type jobs, with their canonical links + status + metadata.
  const { data: detailRows, error: detailErr } = await client
    .from("makesafe_job_details")
    .select(
      "job_id, external_ref, requesting_company_slug, requesting_company_name, report_type, external_links, jobs(status, metadata)",
    )
    .not("external_ref", "is", null)
    .limit(2000);
  if (detailErr) {
    throw new Error(
      `makesafe_job_details read failed: ${detailErr.message ?? detailErr}`,
    );
  }

  const jobIds = (detailRows || []).map((r: any) => r.job_id).filter(Boolean);

  // Linking drafts (approved_job_id -> the draft that created the job) for extraction +
  // the source email post id.
  const draftByJob = new Map<string, any>();
  if (jobIds.length) {
    const { data: draftRows } = await client
      .from("makesafe_intake_drafts")
      .select(
        "approved_job_id, graph_message_id, extraction_json, body_preview",
      )
      .in("approved_job_id", jobIds);
    for (const d of (draftRows || [])) {
      if (d.approved_job_id && !draftByJob.has(d.approved_job_id)) {
        draftByJob.set(d.approved_job_id, d);
      }
    }
  }

  // Full original email bodies (deterministic link source). Purged rows return null body.
  const postIds = [...draftByJob.values()].map((d) => d.graph_message_id)
    .filter(Boolean);
  const emailByPost = new Map<string, any>();
  if (postIds.length) {
    const { data: emailRows } = await client
      .from("emails")
      .select("post_id, body_content, body_preview, pii_purged_at")
      .in("post_id", postIds);
    for (const e of (emailRows || [])) emailByPost.set(e.post_id, e);
  }

  // Legacy report cards can predate makesafe_intake_drafts. Recover their exact
  // original work-order email by builder reference instead of treating the missing
  // draft join as proof that the email is absent.
  const needsLegacyEmail = (detailRows || []).some((row: any) =>
    row?.job_id && !draftByJob.has(row.job_id)
  );
  const legacyEmailRows: any[] = [];
  if (needsLegacyEmail) {
    const { data: rows, error: legacyEmailErr } = await client
      .from("emails")
      .select(
        "post_id, subject, body_content, body_preview, pii_purged_at, received_at",
      )
      .is("pii_purged_at", null)
      .order("received_at", { ascending: false })
      .limit(5000);
    if (legacyEmailErr) {
      console.warn(
        "[ops-api] link backfill legacy email read failed:",
        legacyEmailErr.message,
      );
    } else {
      legacyEmailRows.push(...(rows || []));
    }
  }

  const jobs: LinkBackfillJobInput[] = (detailRows || []).map((r: any) => {
    const jobsData = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs;
    const meta = parseObj(jobsData?.metadata);
    const draft = draftByJob.get(r.job_id);
    let email = draft?.graph_message_id
      ? emailByPost.get(draft.graph_message_id)
      : null;
    if (!email && r.external_ref) {
      email = selectLegacyWorkOrderEmail(r.external_ref, legacyEmailRows);
    }
    const emailBody = email && !email.pii_purged_at
      ? (email.body_content || email.body_preview || null)
      : null;
    const extraction = parseObj(draft?.extraction_json);
    const attachmentText = [
      extraction.attachment_text,
      extraction.pdf_text,
      extraction.source_text,
    ].filter((value) => typeof value === "string" && value.trim()).join("\n");
    return {
      job_id: r.job_id,
      external_ref: r.external_ref,
      requesting_company_slug: r.requesting_company_slug,
      requesting_company_name: r.requesting_company_name,
      report_type: r.report_type,
      job_family: meta.makesafe_job_family || null,
      job_status: jobsData?.status || null,
      current_external_links: r.external_links,
      email_body: emailBody || draft?.body_preview || null,
      email_attachment_text: attachmentText || null,
      draft_extraction: draft?.extraction_json ?? null,
      evidence_email_id: draft?.graph_message_id || email?.post_id || null,
    };
  });

  const report = summarizeLinkBackfill({
    jobs,
    dryRun,
    includeArchived: opts.includeArchived,
    limit: opts.limit,
  });

  if (dryRun) return report;

  // LIVE in-place patch: canonical makesafe_job_details.external_links + the
  // jobs.metadata.external_links alias. No status / substatus / reopen / delete.
  let applied = 0;
  for (const patch of report.patches) {
    try {
      const { error: detErr } = await client
        .from("makesafe_job_details")
        .update({
          external_links: patch.recovered_links,
          updated_at: new Date().toISOString(),
        })
        .eq("job_id", patch.job_id);
      if (detErr) {
        console.warn(
          "[ops-api] link backfill detail patch failed:",
          patch.job_id,
          detErr.message,
        );
        continue;
      }
      // Mirror into jobs.metadata.external_links (client alias) without disturbing other
      // metadata keys.
      const { data: jobRow } = await client.from("jobs").select("metadata").eq(
        "id",
        patch.job_id,
      ).maybeSingle();
      const meta = parseObj(jobRow?.metadata);
      meta.external_links = patch.recovered_links;
      await client.from("jobs").update({ metadata: meta }).eq(
        "id",
        patch.job_id,
      );
      // Audit trail.
      try {
        await client.from("job_events").insert({
          job_id: patch.job_id,
          event_type: "makesafe_links_backfilled",
          detail_json: {
            external_ref: patch.external_ref,
            recovered_count: patch.recovered_links.length,
            sources: patch.sources,
            evidence_email_id: patch.evidence_email_id,
            source: "auto-intake-link-backfill",
          },
        });
      } catch (_) { /* non-blocking audit */ }
      applied++;
    } catch (e) {
      console.warn(
        "[ops-api] link backfill patch threw:",
        patch.job_id,
        (e as Error).message,
      );
    }
  }
  report.counts.jobs_applied = applied;
  return report;
}
