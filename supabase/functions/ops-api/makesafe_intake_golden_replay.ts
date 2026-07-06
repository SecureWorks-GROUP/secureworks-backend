// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE — GOLDEN-SET REPLAY (dry-run, no writes, no live API)
// Mission: makesafe/intake-resurrect-harden (Auto-Intake v2 Wave 1 M1, D-f)
// ════════════════════════════════════════════════════════════
//
// The proof the Captain asked for before trusting auto-file: replay the recent ses@
// emails through the SAME deterministic classification + gate the scan uses, and lay
// each email's REPLAY verdict next to what ACTUALLY happened (the draft/job the scan
// created). Per email: family, matched builder, gate decision, would-it-auto-file, and
// — where a draft/job exists — the fields that were extracted and the job that was
// created. Any disagreement is surfaced for the joint-testing window.
//
// KEY-LESS BY DESIGN. This harness NEVER calls the Anthropic API. The classifier is
// the only non-deterministic step, so a verdict that depends on the model's confidence
// or field extraction is reported as 'requires_live_extraction' rather than guessed.
// Everything else (the gate, family, would-draft) is fully deterministic, so fixtures
// prove the harness today and the same code reports truthfully the moment the key lands
// (the actual/extracted columns then fill in from the drafts the live scan produces).

import {
  classifyMakeSafeJobFamily,
  classifyReportType,
  isGenuineNewWorkOrder,
  isReportOnlyType,
  subjectIsExcludedNonWorkOrder,
  subjectLooksLikeNewWorkOrder,
  subjectMatchesReportCapture,
} from "./makesafe_intake_gate.ts";
import { normalizeReportExternalLinks } from "./makesafe_email_links.ts";
import { normaliseJobFamily } from "./makesafe_intake_dedup.ts";
// M1.5: the same deterministic template parser + PDF text extractor the live scan uses,
// so the replay is a truthful COST preview (would_call_model / pdf_mode / parser) AND
// proves the template output agrees with the live draft before a builder is flipped.
import {
  compareTemplateToActual,
  parseWithTemplate,
  type TemplateParsingRules,
} from "./makesafe_template_parser.ts";
import { extractPdfText, PDF_TEXT_MIN_CHARS } from "./makesafe_pdf_text.ts";

export interface GoldenSenderPattern {
  slug: string;
  name: string;
  pattern: string;
}

export interface GoldenEmail {
  post_id?: string | null;
  subject?: string | null;
  from_email?: string | null;
  from_name?: string | null;
  body?: string | null;
  has_attachments?: boolean | null;
  received_at?: string | null;
  /** count of servable work-order PDFs the sync captured for this email. */
  wo_pdf_count?: number | null;
  /** M1.5: text-vs-document decision from local PDF extraction. When the DB action
   * downloaded + extracted the WO PDF this is 'text' | 'document' | 'none'; when it
   * didn't (or in fixture tests) it is left undefined and a conservative default is
   * derived from wo_pdf_count. */
  pdf_mode?: "text" | "document" | "none";
  /** M1.5: extracted PDF text layer, fed to the template parser for the cost preview. */
  pdf_text?: string | null;
}

export interface GoldenDraft {
  graph_message_id?: string | null;
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  confidence?: string | null;
  status?: string | null;
  report_type?: string | null;
  missing_fields?: any;
  extraction_json?: any;
  approved_by?: string | null;
  approved_job_id?: string | null;
}

export interface GoldenReplayItem {
  post_id: string | null;
  subject: string | null;
  from_email: string | null;
  received_at: string | null;
  replay: {
    is_own_outbound: boolean;
    is_candidate: boolean;
    gate_ok: boolean;
    gate_reason: string;
    kind: "work_order" | "report" | null;
    report_type: string | null;
    job_family: string | null;
    matched_company: string | null;
    would_draft: boolean;
    would_auto_file: "yes" | "no" | "requires_live_extraction";
    auto_file_blockers: string[];
    // M1.5 cost preview (deterministic, key-less):
    /** true = this candidate would incur a Haiku call; false = template-first skip. */
    would_call_model: boolean;
    /** which PDF path the scan would use for this email. */
    pdf_mode: "text" | "document" | "none";
    /** 'template' only when the builder is template-first AND a full parse succeeds. */
    parser: "template" | "none";
    /** whether this builder is flipped to template-first (default false). */
    template_first: boolean;
    /** whether the template parsed ALL required fields (independent of the toggle). */
    template_full_parse: boolean;
  };
  actual: {
    has_draft: boolean;
    draft_status: string | null;
    draft_confidence: string | null;
    extracted_ref: string | null;
    extracted_client: string | null;
    extracted_address: string | null;
    portal_links_count: number;
    auto_filed: boolean;
    created_job_id: string | null;
  } | null;
  agreement: {
    family_match: boolean | null;
    draft_presence_match: boolean;
    notes: string[];
    // M1.5: template-parser output vs the fields on the ACTUAL historical draft. This
    // is the proof the Captain reads before flipping a builder to template_first — per
    // field true=agree / false=differ / null=nothing to compare, plus an overall
    // `agrees` and the count compared. null when no draft or no template rules.
    template_agreement: {
      per_field: Record<string, boolean | null>;
      agrees: boolean;
      compared: number;
    } | null;
  };
}

export interface GoldenReplayReport {
  ok: true;
  generated_at: string;
  days: number;
  live_extraction_used: false;
  counts: {
    emails_replayed: number;
    would_draft: number;
    would_gate_drop: number;
    would_auto_file_candidates: number;
    pending_live_extraction: number;
    drafts_present: number;
    disagreements: number;
    // M1.5 cost preview counts.
    would_call_model: number;
    would_skip_model: number;
    pdf_text_path: number;
    pdf_document_path: number;
    template_agreements: number;
    template_disagreements: number;
  };
  items: GoldenReplayItem[];
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

// Mirrors the scan's own-domain contamination filter without importing the async DB
// layer. Kept deliberately small; the authoritative isOwnDomain lives in
// makesafe_compact_reads and the reconcile invariant uses it directly.
const OWN_DOMAIN_RE = /secureworksgroup\.app|secureworkswa\.com\.au|secureworks/i;

/**
 * Deterministically replay one email through the scan's classification + gate. NO model
 * call: any verdict that needs the classifier's confidence is 'requires_live_extraction'.
 */
export function replayGoldenEmail(
  email: GoldenEmail,
  senderPatterns: GoldenSenderPattern[],
  matchSender: (fromEmail: string, pattern: string) => boolean,
  rulesBySlug?: Map<string, TemplateParsingRules>,
): GoldenReplayItem["replay"] {
  const subject = email.subject || "";
  const fromEmail = (email.from_email || "").toLowerCase();
  const body = email.body || "";
  const woPdfCount = Number(email.wo_pdf_count || 0);

  const isOwnOutbound = OWN_DOMAIN_RE.test(fromEmail);

  const matched = senderPatterns.find((sp) => matchSender(fromEmail, sp.pattern)) || null;
  const matchedCompany = matched ? matched.slug : null;

  const excluded = subjectIsExcludedNonWorkOrder(subject);
  const woSubject = subjectLooksLikeNewWorkOrder(subject) ||
    subjectMatchesReportCapture(subject) ||
    /work\s*order|make\s*safe|emergency|storm|urgent\s*(attend|repair)/i.test(subject);
  const builderish = fromEmail.includes(".build") || fromEmail.includes("primeeco.tech");
  const isCandidate = !isOwnOutbound && !excluded && (!!matched || (woSubject && builderish));

  const gate = isGenuineNewWorkOrder(subject, fromEmail, woPdfCount);
  const reportType = (gate.reportSubjectPattern || gate.kind === "report")
    ? classifyReportType(subject, body)
    : null;
  const jobFamily = classifyMakeSafeJobFamily(subject, body, reportType);

  const wouldDraft = isCandidate && gate.ok;

  // would_auto_file — deterministic verdict only. 'no' when structurally excluded;
  // 'requires_live_extraction' when the ONLY remaining gate is the model's confidence +
  // extracted fields (which this key-less harness will not guess).
  const blockers: string[] = [];
  let wouldAutoFile: "yes" | "no" | "requires_live_extraction";
  if (!wouldDraft) {
    wouldAutoFile = "no";
    blockers.push(isCandidate ? `gate:${gate.reason}` : "not_a_candidate");
  } else if (gate.kind === "report") {
    wouldAutoFile = "no";
    blockers.push("report_capture_manual_review");
  } else if (isReportOnlyType(reportType) && woPdfCount === 0) {
    wouldAutoFile = "no";
    blockers.push("report_only_no_work_order_pdf");
  } else if (woPdfCount === 0) {
    wouldAutoFile = "no";
    blockers.push("missing_work_order_pdf");
  } else {
    // Structurally auto-fileable; the live gate still needs confidence:high + the
    // required fields (company/ref/client/address), which only the classifier provides.
    wouldAutoFile = "requires_live_extraction";
    blockers.push("needs_confidence_high", "needs_extracted_fields");
  }

  // M1.5 cost preview — deterministic, key-less. A candidate email reaches the
  // extraction step (the model call happens BEFORE the WO gate in the live scan), so
  // `would_call_model` keys off is_candidate. `pdf_mode` is the extraction path; when
  // the DB action didn't extract, derive a conservative default from wo_pdf_count.
  const pdfMode: "text" | "document" | "none" =
    email.pdf_mode ?? (woPdfCount > 0 ? "document" : "none");
  const rules = matchedCompany ? rulesBySlug?.get(matchedCompany) : undefined;
  const template = parseWithTemplate(rules, {
    subject,
    body,
    pdfText: email.pdf_text || "",
  });
  const templateFirst = template?.template_first ?? false;
  const templateFullParse = template?.full_parse ?? false;
  const modelSkipped = template?.model_skipped === true;
  // Only candidates reach extraction; a template-first full parse skips the call.
  const wouldCallModel = isCandidate && !modelSkipped;
  const parser: "template" | "none" = isCandidate && modelSkipped ? "template" : "none";

  return {
    is_own_outbound: isOwnOutbound,
    is_candidate: isCandidate,
    gate_ok: gate.ok,
    gate_reason: gate.reason,
    kind: gate.ok ? gate.kind : null,
    report_type: reportType,
    job_family: jobFamily,
    matched_company: matchedCompany,
    would_draft: wouldDraft,
    would_auto_file: wouldAutoFile,
    auto_file_blockers: blockers,
    would_call_model: wouldCallModel,
    pdf_mode: pdfMode,
    parser,
    template_first: templateFirst,
    template_full_parse: templateFullParse,
  };
}

export function summarizeGoldenReplay(input: {
  emails: GoldenEmail[];
  drafts: GoldenDraft[];
  senderPatterns: GoldenSenderPattern[];
  matchSender: (fromEmail: string, pattern: string) => boolean;
  /** M1.5: per-builder parsing_rules, keyed by slug — drives the cost preview and the
   * template-vs-actual agreement. Omit (fixture tests / no rules) and every builder is
   * treated as model-first with no template agreement. */
  rulesBySlug?: Map<string, TemplateParsingRules>;
  nowIso?: string;
  days?: number;
  limit?: number;
}): GoldenReplayReport {
  const days = input.days ?? 30;
  const limit = Math.max(1, Math.min(input.limit ?? 500, 2000));
  const draftByPost = new Map<string, GoldenDraft>();
  for (const d of input.drafts || []) {
    if (d.graph_message_id && !draftByPost.has(d.graph_message_id)) {
      draftByPost.set(d.graph_message_id, d);
    }
  }

  const items: GoldenReplayItem[] = [];
  let wouldDraftN = 0;
  let wouldGateDrop = 0;
  let wouldAutoFileN = 0;
  let pendingLive = 0;
  let draftsPresent = 0;
  let disagreements = 0;
  let wouldCallModelN = 0;
  let wouldSkipModelN = 0;
  let pdfTextPath = 0;
  let pdfDocumentPath = 0;
  let templateAgreements = 0;
  let templateDisagreements = 0;

  for (const email of input.emails || []) {
    const replay = replayGoldenEmail(email, input.senderPatterns, input.matchSender, input.rulesBySlug);
    if (replay.would_draft) wouldDraftN++;
    else if (replay.is_candidate) wouldGateDrop++;
    if (replay.would_auto_file === "yes") wouldAutoFileN++;
    if (replay.would_auto_file === "requires_live_extraction") pendingLive++;
    // Cost-preview tallies count only candidates (they reach the extraction step).
    if (replay.is_candidate) {
      if (replay.would_call_model) wouldCallModelN++;
      else wouldSkipModelN++;
      if (replay.pdf_mode === "text") pdfTextPath++;
      else if (replay.pdf_mode === "document") pdfDocumentPath++;
    }

    const draft = email.post_id ? draftByPost.get(email.post_id) || null : null;
    let actual: GoldenReplayItem["actual"] = null;
    const notes: string[] = [];
    let familyMatch: boolean | null = null;
    let templateAgreement: GoldenReplayItem["agreement"]["template_agreement"] = null;

    if (draft) {
      draftsPresent++;
      const extraction = parseObj(draft.extraction_json);
      const draftFamily = normaliseJobFamily(
        extraction.makesafe_job_family || extraction.job_family || draft.report_type,
      );
      const replayFamily = normaliseJobFamily(replay.job_family);
      familyMatch = draftFamily && replayFamily ? draftFamily === replayFamily : null;
      if (familyMatch === false) {
        notes.push(`family_mismatch:replay=${replayFamily}|actual=${draftFamily}`);
      }
      actual = {
        has_draft: true,
        draft_status: draft.status || null,
        draft_confidence: draft.confidence || null,
        extracted_ref: draft.external_ref || extraction.external_ref || null,
        extracted_client: extraction.client_name || null,
        extracted_address: extraction.site_address || null,
        portal_links_count: normalizeReportExternalLinks(extraction).length,
        auto_filed: String(draft.approved_by || "") === "auto-intake" ||
          String(draft.approved_by || "") === "auto_intake_clean_gate",
        created_job_id: draft.approved_job_id || null,
      };

      // M1.5 proof: run the SAME template parse against this email and compare its
      // output to the fields on the ACTUAL historical draft. This is what proves a
      // builder is safe to flip template_first before the toggle is ever set.
      const slug = replay.matched_company;
      const rules = slug ? input.rulesBySlug?.get(slug) : undefined;
      const template = parseWithTemplate(rules, {
        subject: email.subject || "",
        body: email.body || "",
        pdfText: email.pdf_text || "",
      });
      if (template && Object.keys(template.fields).length > 0) {
        templateAgreement = compareTemplateToActual(template.fields, {
          external_ref: draft.external_ref || extraction.external_ref,
          client_name: extraction.client_name,
          site_address: extraction.site_address,
          client_phone: extraction.client_phone,
        });
        if (templateAgreement.compared > 0) {
          if (templateAgreement.agrees) templateAgreements++;
          else {
            templateDisagreements++;
            notes.push("template_disagrees_with_draft");
          }
        }
      }
    }

    // Disagreement: the scan WOULD draft this email but no draft exists, OR the reverse.
    const draftPresenceMatch = replay.would_draft === !!draft;
    if (!draftPresenceMatch) {
      disagreements++;
      notes.push(
        replay.would_draft
          ? "replay_would_draft_but_no_draft_exists"
          : "draft_exists_but_replay_would_not_draft",
      );
    }

    items.push({
      post_id: email.post_id || null,
      subject: email.subject || null,
      from_email: email.from_email || null,
      received_at: email.received_at || null,
      replay,
      actual,
      agreement: {
        family_match: familyMatch,
        draft_presence_match: draftPresenceMatch,
        notes,
        template_agreement: templateAgreement,
      },
    });
  }

  return {
    ok: true,
    generated_at: input.nowIso || new Date().toISOString(),
    days,
    live_extraction_used: false,
    counts: {
      emails_replayed: (input.emails || []).length,
      would_draft: wouldDraftN,
      would_gate_drop: wouldGateDrop,
      would_auto_file_candidates: wouldAutoFileN,
      pending_live_extraction: pendingLive,
      drafts_present: draftsPresent,
      disagreements,
      would_call_model: wouldCallModelN,
      would_skip_model: wouldSkipModelN,
      pdf_text_path: pdfTextPath,
      pdf_document_path: pdfDocumentPath,
      template_agreements: templateAgreements,
      template_disagreements: templateDisagreements,
    },
    items: items.slice(0, limit),
  };
}

/**
 * DB action. Reads the last N days of ses@ emails, their servable WO-PDF counts, and the
 * drafts that link to them, then runs the key-less deterministic replay. NO writes, NO
 * Anthropic call. This is the proof artifact source for the joint-testing window.
 */
export async function makesafeIntakeGoldenReplay(
  client: any,
  matchSender: (fromEmail: string, pattern: string) => boolean,
  sesMailbox: string,
  opts: {
    days?: number;
    limit?: number;
    nowIso?: string;
    /** M1.5: optional storage download used to extract each email's WO-PDF text layer
     * so the cost preview (pdf_mode) and template agreement are real, not estimated.
     * Bounded + best-effort; when absent, pdf_mode is derived from wo_pdf_count. */
    downloadPdf?: (storagePath: string) => Promise<Uint8Array | null>;
    /** Cap on WO-PDF downloads per replay (protects the manual action). */
    maxPdfExtractions?: number;
  } = {},
): Promise<GoldenReplayReport> {
  const days = opts.days ?? 30;
  const nowMs = opts.nowIso ? Date.parse(opts.nowIso) : Date.now();
  const sinceIso = new Date(nowMs - days * 86_400_000).toISOString();

  const [emailsRes, companiesRes] = await Promise.all([
    client.from("emails")
      .select("post_id, subject, from_email, from_name, body_content, body_preview, has_attachments, received_at")
      .eq("mailbox", sesMailbox)
      .is("pii_purged_at", null)
      .gte("received_at", sinceIso)
      .order("received_at", { ascending: false })
      .limit(2000),
    // M1.5: parsing_rules drives the cost preview + template-vs-actual agreement.
    client.from("makesafe_companies")
      .select("slug, name, sender_patterns, parsing_rules")
      .eq("active", true),
  ]);
  if (emailsRes.error) throw new Error(`emails read failed: ${emailsRes.error.message ?? emailsRes.error}`);

  const emailRows = emailsRes.data || [];
  const postIds = emailRows.map((e: any) => e.post_id).filter(Boolean);

  // Servable WO-PDF count + the WO PDF's storage path per email (status='uploaded').
  const woCountByPost = new Map<string, number>();
  const woPathByPost = new Map<string, string>();
  const draftByPost = new Map<string, any>();
  if (postIds.length) {
    const [attRes, draftRes] = await Promise.all([
      client.from("email_attachments")
        .select("email_id, content_type, name, status, storage_path")
        .in("email_id", postIds)
        .eq("status", "uploaded"),
      client.from("makesafe_intake_drafts")
        .select("graph_message_id, external_ref, requesting_company_slug, requesting_company_name, confidence, status, report_type, missing_fields, extraction_json, approved_by, approved_job_id")
        .in("graph_message_id", postIds),
    ]);
    for (const a of (attRes.data || [])) {
      const isPdf = (a.content_type || "").includes("pdf") || (a.name || "").toLowerCase().endsWith(".pdf");
      if (!isPdf) continue;
      woCountByPost.set(a.email_id, (woCountByPost.get(a.email_id) || 0) + 1);
      if (a.storage_path && !woPathByPost.has(a.email_id)) woPathByPost.set(a.email_id, a.storage_path);
    }
    for (const d of (draftRes.data || [])) {
      if (d.graph_message_id && !draftByPost.has(d.graph_message_id)) draftByPost.set(d.graph_message_id, d);
    }
  }

  const senderPatterns: GoldenSenderPattern[] = [];
  const rulesBySlug = new Map<string, TemplateParsingRules>();
  for (const co of (companiesRes.data || [])) {
    for (const p of (co.sender_patterns || [])) {
      if (p) senderPatterns.push({ slug: co.slug, name: co.name, pattern: String(p).toLowerCase() });
    }
    if (co.slug && co.parsing_rules && typeof co.parsing_rules === "object") {
      rulesBySlug.set(String(co.slug).toLowerCase(), co.parsing_rules as TemplateParsingRules);
    }
  }

  const emails: GoldenEmail[] = emailRows.map((e: any) => ({
    post_id: e.post_id,
    subject: e.subject,
    from_email: e.from_email,
    from_name: e.from_name,
    body: e.body_content || e.body_preview || "",
    has_attachments: e.has_attachments,
    received_at: e.received_at,
    wo_pdf_count: woCountByPost.get(e.post_id) || 0,
  }));

  // M1.5 cost preview: extract each WO PDF's text layer (bounded, best-effort) so
  // pdf_mode is real and the template parse has the PDF-sourced fields to compare.
  if (opts.downloadPdf) {
    const cap = Math.max(0, Math.min(opts.maxPdfExtractions ?? 150, 500));
    let done = 0;
    for (const e of emails) {
      if (done >= cap) break;
      const path = e.post_id ? woPathByPost.get(e.post_id) : undefined;
      const woCount = Number(e.wo_pdf_count || 0);
      if (!path || woCount === 0) continue;
      try {
        const bytes = await opts.downloadPdf(path);
        if (!bytes) continue;
        done++;
        const r = await extractPdfText(bytes);
        if (r.mode === "text" && r.text) {
          e.pdf_text = r.text;
          // Only claim the cheap text path when this is the SOLE PDF (so we know every
          // captured PDF is text); with multiple PDFs, stay conservative on document.
          e.pdf_mode = (woCount === 1 && r.charCount >= PDF_TEXT_MIN_CHARS) ? "text" : "document";
        } else {
          e.pdf_mode = "document"; // has a WO PDF but no usable text layer (scanned)
        }
      } catch (_) {
        // best-effort: leave pdf_mode undefined → derived from wo_pdf_count in replay
      }
    }
  }

  const drafts: GoldenDraft[] = [...draftByPost.values()];

  return summarizeGoldenReplay({
    emails,
    drafts,
    senderPatterns,
    matchSender,
    rulesBySlug,
    nowIso: opts.nowIso,
    days,
    limit: opts.limit,
  });
}
